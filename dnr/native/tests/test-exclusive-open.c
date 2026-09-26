/* SPDX-License-Identifier: Apache-2.0
 * Substitute only open/close: assert the exact kernel flags and errno contract.
 * Runtime tests separately exercise real libc against disposable regular files.
 */
#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static int busy, opens, closes;
static int fake_open(const char *path, int flags) {
  opens++;
  assert(!strcmp(path, "/dev/test"));
  assert(flags == (O_RDWR | O_DIRECT | O_EXCL | O_CLOEXEC));
  if (busy) { errno = EBUSY; return -1; }
  return 42;
}
static int fake_close(int fd) { assert(fd == 42); closes++; return 0; }
#define open(...) fake_open(__VA_ARGS__)
#define close(...) fake_close(__VA_ARGS__)
#include "../exclusive-open.c"
int main(void) {
  int flags = O_RDWR | O_DIRECT | O_EXCL;
  assert(etcher_open_exclusive("/dev/test", flags) == 42);
  assert(opens == 1 && closes == 0); /* Claim is not a transient probe. */
  assert(etcher_close_exclusive(42) == 0 && closes == 1);
  busy = 1;
  assert(etcher_open_exclusive("/dev/test", flags) == -EBUSY);
  assert(opens == 2); /* Never retry busy without O_EXCL. */
  assert(etcher_open_exclusive("/dev/test", flags | O_CREAT) == -EINVAL);
  assert(etcher_open_exclusive("/dev/test", flags | O_TRUNC) == -EINVAL);
  assert(etcher_open_exclusive("/dev/test", flags & ~O_EXCL) == -EINVAL);
  assert(opens == 2);
  puts("PASS exclusive open flags, claim lifetime, busy propagation and unsafe flag refusal");
}
