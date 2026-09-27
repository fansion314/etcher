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
exports.O_EXLOCK = process.platform === 'darwin' ? 0x20 : 0;
exports.setF_NOCACHE = (_fd, _value, callback) => callback(null);
