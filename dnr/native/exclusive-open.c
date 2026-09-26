/* SPDX-License-Identifier: Apache-2.0 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#define API __attribute__((visibility("default")))

/* Return errno with the result, never read another FFI thread's errno. */
API int etcher_open_exclusive(const char *path, int flags) {
  /* This helper must never create or truncate a destination. */
  if (!(flags & O_EXCL) || (flags & (O_CREAT | O_TRUNC))) return -EINVAL;
  int fd;
  do { fd = open(path, flags | O_CLOEXEC); } while (fd < 0 && errno == EINTR);
  return fd < 0 ? -errno : fd;
}

API int etcher_close_exclusive(int fd) {
  /* On Linux close releases the fd even on error; retry could close a reused fd. */
  return close(fd) < 0 ? -errno : 0;
}
