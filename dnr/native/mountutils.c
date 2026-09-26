/* SPDX-License-Identifier: Apache-2.0
 * Linux C ABI for dnr. No Node/V8 ABI, no shell commands, no lazy unmount.
 * Each invocation owns its errors, including when called on a FFI worker.
 */
#define _GNU_SOURCE
#include <gio/gio.h>
#include <libmount/libmount.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define API __attribute__((visibility("default")))
#define UDISKS "org.freedesktop.UDisks2"

static int failure(int code, const char *message, char *error, size_t capacity) {
  if (error && capacity) snprintf(error, capacity, "%s", message);
  return code ? code : EIO;
}

/* A separator boundary prevents sda/sdaa and nvme0n1/nvme0n10 collisions. */
static int descendant(const char *parent, const char *path) {
  size_t n = strlen(parent);
  return !strncmp(parent, path, n) && (path[n] == '\0' || path[n] == '/');
}

static int sys_path(dev_t device, char out[PATH_MAX]) {
  char link[128];
  snprintf(link, sizeof(link), "/sys/dev/block/%u:%u", major(device), minor(device));
  return realpath(link, out) ? 0 : errno;
}

static int validate(const char *device, char sys[PATH_MAX], char *error, size_t cap) {
  struct stat st;
  if (!device || device[0] != '/') return failure(EINVAL, "An absolute block device path is required", error, cap);
  if (stat(device, &st)) return failure(errno, strerror(errno), error, cap);
  if (!S_ISBLK(st.st_mode)) return failure(ENOTBLK, "Not a block device", error, cap);
  int rc = sys_path(st.st_rdev, sys);
  if (rc) return failure(rc, "Cannot resolve block device in sysfs", error, cap);
  return 0;
}

/* Reject active dm-crypt/LVM/RAID users instead of missing their mountpoints. */
static int check_holders(const char *sys, char *error, size_t cap) {
  g_autofree char *path = g_build_filename(sys, "holders", NULL);
  DIR *dir = opendir(path);
  if (!dir) return failure(errno, "Cannot inspect device holders", error, cap);
  struct dirent *entry;
  int busy = 0;
  while ((entry = readdir(dir))) if (entry->d_name[0] != '.') busy = 1;
  closedir(dir);
  return busy ? failure(EBUSY, "Device has active mapped/RAID holders", error, cap) : 0;
}

static int longest_first(const void *a, const void *b) {
  size_t x = strlen(*(char *const *)a), y = strlen(*(char *const *)b);
  return (y > x) - (y < x);
}

API int etcher_unmount_disk(const char *device, char *error, size_t cap) {
  char sys[PATH_MAX];
  int rc = validate(device, sys, error, cap);
  if (rc) return rc;
  if ((rc = check_holders(sys, error, cap))) return rc;
  /* Check holders of each direct partition too. */
  DIR *dir = opendir(sys);
  if (!dir) return failure(errno, "Cannot inspect disk partitions", error, cap);
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (entry->d_name[0] == '.') continue;
    g_autofree char *part = g_build_filename(sys, entry->d_name, NULL);
    g_autofree char *marker = g_build_filename(part, "partition", NULL);
    if (!access(marker, F_OK) && (rc = check_holders(part, error, cap))) break;
  }
  closedir(dir);
  if (rc) return rc;

  struct libmnt_table *table = mnt_new_table_from_file("/proc/self/mountinfo");
  if (!table) return failure(EIO, "Cannot read mountinfo", error, cap);
  struct libmnt_iter *iter = mnt_new_iter(MNT_ITER_FORWARD);
  struct libmnt_fs *fs;
  GPtrArray *mounts = g_ptr_array_new_with_free_func(g_free);
  while (!mnt_table_next_fs(table, iter, &fs)) {
    char mounted_sys[PATH_MAX];
    if (sys_path(mnt_fs_get_devno(fs), mounted_sys) || !descendant(sys, mounted_sys)) continue;
    const char *target = mnt_fs_get_target(fs);
    if (!target || !strcmp(target, "/") || !strcmp(target, "/usr") || !strcmp(target, "/boot")) {
      rc = failure(EBUSY, "Refusing to unmount a system filesystem", error, cap);
      break;
    }
    g_ptr_array_add(mounts, g_strdup(target));
  }
  mnt_free_iter(iter);
  mnt_free_table(table);
  g_ptr_array_sort(mounts, longest_first);
  for (guint i = 0; !rc && i < mounts->len; i++) {
    const char *target = g_ptr_array_index(mounts, i);
    if (umount2(target, 0)) {
      int saved = errno;
      g_autofree char *message = g_strdup_printf("Cannot unmount %s: %s", target, strerror(saved));
      rc = failure(saved, message, error, cap);
    }
  }
  g_ptr_array_free(mounts, TRUE);
  return rc;
}

static GVariant *call(GDBusConnection *bus, const char *path, const char *interface,
                      const char *method, GVariant *args, GError **err) {
  return g_dbus_connection_call_sync(bus, UDISKS, path, interface, method, args,
      NULL, G_DBUS_CALL_FLAGS_NONE, 30000, NULL, err);
}

API int etcher_eject_disk(const char *device, char *error, size_t cap) {
  char sys[PATH_MAX];
  int rc = validate(device, sys, error, cap);
  if (rc) return rc;
  g_autofree char *partition = g_build_filename(sys, "partition", NULL);
  if (!access(partition, F_OK)) return failure(EINVAL, "Eject requires a whole disk, not a partition", error, cap);
  g_autoptr(GError) err = NULL;
  g_autoptr(GDBusConnection) bus = g_bus_get_sync(G_BUS_TYPE_SYSTEM, NULL, &err);
  if (!bus) return failure(EIO, err->message, error, cap);
  g_autoptr(GVariant) reply = call(bus, "/org/freedesktop/UDisks2", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", NULL, &err);
  if (!reply) return failure(EIO, err->message, error, cap);
  g_autoptr(GVariant) objects = g_variant_get_child_value(reply, 0);
  GVariantIter iter;
  const char *path;
  GVariant *interfaces;
  g_autofree char *drive_path = NULL;
  struct stat wanted;
  if (stat(device, &wanted)) return failure(errno, strerror(errno), error, cap);
  g_variant_iter_init(&iter, objects);
  while (g_variant_iter_next(&iter, "{&o@a{sa{sv}}}", &path, &interfaces)) {
    g_autoptr(GVariant) owned = interfaces;
    g_autoptr(GVariant) block = g_variant_lookup_value(interfaces, UDISKS ".Block", G_VARIANT_TYPE_VARDICT);
    guint64 number = 0;
    const char *drive;
    if (block && g_variant_lookup(block, "DeviceNumber", "t", &number) && number == (guint64)wanted.st_rdev &&
        g_variant_lookup(block, "Drive", "&o", &drive)) drive_path = g_strdup(drive);
  }
  if (!drive_path || !strcmp(drive_path, "/")) return failure(ENOTSUP, "UDisks2 has no ejectable drive for this device", error, cap);
  g_autoptr(GVariant) drive_interfaces = g_variant_lookup_value(objects, drive_path, NULL);
  g_autoptr(GVariant) drive = drive_interfaces ? g_variant_lookup_value(drive_interfaces, UDISKS ".Drive", G_VARIANT_TYPE_VARDICT) : NULL;
  gboolean ejectable = FALSE, poweroff = FALSE;
  const char *sibling = "";
  if (drive) {
    g_variant_lookup(drive, "Ejectable", "b", &ejectable);
    g_variant_lookup(drive, "CanPowerOff", "b", &poweroff);
    g_variant_lookup(drive, "SiblingId", "&s", &sibling);
  }
  if (!ejectable && !poweroff) return failure(ENOTSUP, "Device supports neither media eject nor power off", error, cap);
  /* Powering off a multi-slot reader can disconnect another application's disk. */
  if (!ejectable && sibling[0]) {
    g_variant_iter_init(&iter, objects);
    while (g_variant_iter_next(&iter, "{&o@a{sa{sv}}}", &path, &interfaces)) {
      g_autoptr(GVariant) owned = interfaces;
      g_autoptr(GVariant) other = g_variant_lookup_value(interfaces, UDISKS ".Drive", G_VARIANT_TYPE_VARDICT);
      const char *other_sibling = "";
      if (other && strcmp(path, drive_path) && g_variant_lookup(other, "SiblingId", "&s", &other_sibling) && !strcmp(sibling, other_sibling))
        return failure(EBUSY, "Power off would affect another drive in the same reader", error, cap);
    }
  }
  if ((rc = etcher_unmount_disk(device, error, cap))) return rc;
  GVariantBuilder options;
  g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&options, "{sv}", "auth.no_user_interaction", g_variant_new_boolean(TRUE));
  g_autoptr(GVariant) result = call(bus, drive_path, UDISKS ".Drive", ejectable ? "Eject" : "PowerOff",
      g_variant_new("(a{sv})", &options), &err);
  return result ? 0 : failure(EIO, err->message, error, cap);
}
