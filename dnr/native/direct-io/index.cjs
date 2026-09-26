// SPDX-License-Identifier: Apache-2.0
// Deno's Buffer backing store is external/non-moving. Keep the original allocation
// alive through the returned slice; no malloc/finalizer ownership crosses the FFI.
const { Buffer } = require('node:buffer');
exports.getAlignedBuffer = (size, alignment = 4096) => {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(alignment) ||
      alignment < 1 || alignment > 4 * 1024 * 1024 || (alignment & (alignment - 1))) {
    throw new RangeError('Invalid aligned buffer size/alignment');
  }
  const backing = Buffer.alloc(size + alignment);
  const address = Deno.UnsafePointer.value(Deno.UnsafePointer.of(backing));
  const offset = Number((BigInt(alignment) - address % BigInt(alignment)) % BigInt(alignment));
  return backing.subarray(offset, offset + size);
};
exports.O_EXLOCK = 0; // Linux uses O_EXCL in Etcher SDK.
exports.setF_NOCACHE = (_fd, _value, callback) => callback(new Error('macOS is not supported by etcher-dnr'));

const fs = require('node:fs');
const { getSystemErrorName } = require('node:util');
let exclusiveLibrary;
function exclusiveSymbols() {
  return (exclusiveLibrary ??= Deno.dlopen(require('node:path').join(__dirname, 'libetcher-exclusive-open.so'), {
    etcher_open_exclusive: { parameters: ['buffer', 'i32'], result: 'i32', nonblocking: true },
    etcher_close_exclusive: { parameters: ['i32'], result: 'i32' },
  })).symbols;
}
function nativeError(result, syscall, path) {
  const code = getSystemErrorName(result);
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), {code, errno: result, syscall, path});
}

// Deno 2.9.7 interprets numeric O_EXCL as createNew, including without O_CREAT.
// Keep a native Linux exclusive claim open for the ENTIRE FileHandle lifetime.
// Opening its procfs link gives Deno a real managed FileHandle without releasing
// the claim or resolving the destination pathname again. No native fd is passed
// to node:fs: Deno's descriptor table is not the OS descriptor table.
exports.open = async (path, flags) => {
  if (typeof flags !== 'number' || !(flags & fs.constants.O_EXCL) || (flags & fs.constants.O_CREAT)) {
    return fs.promises.open(path, flags);
  }
  if (typeof path !== 'string' || path.includes('\0')) throw new TypeError('A path without NUL is required');
  const symbols = exclusiveSymbols();
  const fd = await symbols.etcher_open_exclusive(new TextEncoder().encode(path + '\0'), flags);
  if (fd < 0) throw nativeError(fd, 'open', path);
  let handle;
  try {
    handle = await fs.promises.open(`/proc/self/fd/${fd}`, flags & ~fs.constants.O_EXCL);
  } catch (error) {
    symbols.etcher_close_exclusive(fd);
    throw error;
  }
  const close = handle.close.bind(handle);
  let closing;
  handle.close = () => closing ??= (async () => {
    try { await close(); }
    finally {
      const rc = symbols.etcher_close_exclusive(fd);
      if (rc < 0) throw nativeError(rc, 'close', path);
    }
  })();
  return handle;
};
