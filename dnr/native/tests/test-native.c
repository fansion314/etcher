/* SPDX-License-Identifier: Apache-2.0
 * Exercise the real mount planner against synthetic kernel mountinfo. Only the
 * OS boundary is substituted: no test can unmount a real filesystem.
 */
#define _GNU_SOURCE
#include <gio/gio.h>
#include <libmount/libmount.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

static const char *mountinfo;
static const char *busy;
static char calls[8][256];
static int count;
static gboolean ejectable, poweroff, shared_reader, operation_failure;
static char disk_operation[32];
static GDBusConnection *fake_bus(GBusType type, GCancellable *cancel, GError **err) {
  (void)type; (void)cancel; (void)err;
  return g_object_new(G_TYPE_DBUS_CONNECTION, NULL);
}
static GVariant *fake_call(GDBusConnection *bus, const char *name, const char *path,
    const char *interface, const char *method, GVariant *args, const GVariantType *reply_type,
    GDBusCallFlags flags, int timeout, GCancellable *cancel, GError **err) {
  (void)bus; (void)name; (void)path; (void)interface; (void)reply_type;
  (void)flags; (void)timeout; (void)cancel;
  if (args) { g_variant_ref_sink(args); g_variant_unref(args); }
  if (!strcmp(method, "GetManagedObjects")) {
    g_autofree char *text = g_strdup_printf("({'/block': {'org.freedesktop.UDisks2.Block': {'DeviceNumber': <uint64 2048>, 'Drive': <objectpath '/drive'>}}, '/drive': {'org.freedesktop.UDisks2.Drive': {'Ejectable': <%s>, 'CanPowerOff': <%s>, 'SiblingId': <'reader'>}}, '/other': {'org.freedesktop.UDisks2.Drive': {'SiblingId': <'%s'>}}},)",
      ejectable ? "true" : "false", poweroff ? "true" : "false", shared_reader ? "reader" : "different");
    GVariant *result = g_variant_parse(G_VARIANT_TYPE("(a{oa{sa{sv}}})"), text, NULL, NULL, err);
    assert(result); return result;
  }
  snprintf(disk_operation, sizeof(disk_operation), "%s", method);
  if (operation_failure) { g_set_error_literal(err, G_IO_ERROR, G_IO_ERROR_BUSY, "Device is still busy"); return NULL; }
  return g_variant_ref_sink(g_variant_new("()"));
}
static int fake_stat(const char *path, struct stat *st) {
  if (strcmp(path, "/dev/test")) { errno = ENOENT; return -1; }
  memset(st, 0, sizeof(*st)); st->st_mode = S_IFBLK; st->st_rdev = makedev(8, 0); return 0;
}
static char *fake_realpath(const char *path, char *out) {
  if (!strcmp(path, "/sys/dev/block/8:0")) return strcpy(out, "/sys/disk");
  if (!strcmp(path, "/sys/dev/block/8:1")) return strcpy(out, "/sys/disk/part1");
  if (!strcmp(path, "/sys/dev/block/8:16")) return strcpy(out, "/sys/disk-other");
  errno = ENOENT; return NULL;
}
static DIR *fake_opendir(const char *path) { (void)path; return opendir("/proc/self/fdinfo"); }
static int fake_access(const char *path, int mode) { (void)path; (void)mode; errno = ENOENT; return -1; }
static int fake_unmount(const char *path, int flags) {
  assert(flags == 0); assert(count < 8); snprintf(calls[count++], 256, "%s", path);
  if (busy && !strcmp(path, busy)) { errno = EBUSY; return -1; } return 0;
}
static struct libmnt_table *fake_table(const char *path) {
  assert(!strcmp(path, "/proc/self/mountinfo"));
  FILE *stream = fmemopen((void *)mountinfo, strlen(mountinfo), "r");
  struct libmnt_table *table = mnt_new_table();
  assert(mnt_table_parse_stream(table, stream, "/proc/self/mountinfo") == 0);
  fclose(stream); return table;
}
/* Empty holders/partition directories, while using genuine libc directory APIs. */
static struct dirent *fake_readdir(DIR *dir) { (void)dir; return NULL; }
#define stat(...) fake_stat(__VA_ARGS__)
#define realpath(...) fake_realpath(__VA_ARGS__)
#define opendir(...) fake_opendir(__VA_ARGS__)
#define readdir(...) fake_readdir(__VA_ARGS__)
#define access(...) fake_access(__VA_ARGS__)
#define umount2(...) fake_unmount(__VA_ARGS__)
#define mnt_new_table_from_file(...) fake_table(__VA_ARGS__)
#define g_bus_get_sync(...) fake_bus(__VA_ARGS__)
#define g_dbus_connection_call_sync(...) fake_call(__VA_ARGS__)
#include "../mountutils.c"

int main(void) {
  char error[256];
  mountinfo = "31 1 8:1 / /media/USB\\040stick rw - vfat /dev/test1 rw\n"
              "32 31 8:1 /sub /media/USB\\040stick/sub rw - vfat /dev/test1 rw\n"
              "33 1 8:16 / /media/other rw - ext4 /dev/test-other rw\n";
  assert(etcher_unmount_disk("/dev/test", error, sizeof(error)) == 0);
  assert(count == 2);
  assert(!strcmp(calls[0], "/media/USB stick/sub"));
  assert(!strcmp(calls[1], "/media/USB stick"));
  count = 0; busy = "/media/USB stick/sub";
  assert(etcher_unmount_disk("/dev/test", error, sizeof(error)) == EBUSY);
  assert(count == 1); /* Never continue after failure or fall back to MNT_DETACH. */
  busy = NULL; count = 0;
  mountinfo = "31 1 8:1 / / rw - ext4 /dev/test1 rw\n";
  assert(etcher_unmount_disk("/dev/test", error, sizeof(error)) == EBUSY);
  assert(count == 0);
  assert(!descendant("/sys/nvme0n1", "/sys/nvme0n10"));
  assert(descendant("/sys/nvme0n1", "/sys/nvme0n1/nvme0n1p2"));
  puts("PASS native mount planning: exact devices, escaped names, nested mounts, busy and root refusal");
  mountinfo = ""; count = 0; poweroff = TRUE;
  assert(etcher_eject_disk("/dev/test", error, sizeof(error)) == 0);
  assert(!strcmp(disk_operation, "PowerOff"));
  ejectable = TRUE;
  assert(etcher_eject_disk("/dev/test", error, sizeof(error)) == 0);
  assert(!strcmp(disk_operation, "Eject"));
  disk_operation[0] = 0; ejectable = FALSE; shared_reader = TRUE;
  assert(etcher_eject_disk("/dev/test", error, sizeof(error)) == EBUSY);
  assert(!disk_operation[0]);
  shared_reader = FALSE; poweroff = FALSE;
  assert(etcher_eject_disk("/dev/test", error, sizeof(error)) == ENOTSUP);
  assert(!disk_operation[0]);
  poweroff = TRUE; operation_failure = TRUE;
  assert(etcher_eject_disk("/dev/test", error, sizeof(error)) == EIO);
  assert(strstr(error, "still busy"));
  puts("PASS eject/power-off selection, shared-reader refusal, unsupported and D-Bus errors");
}
