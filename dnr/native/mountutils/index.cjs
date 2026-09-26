// SPDX-License-Identifier: Apache-2.0
const path = require('node:path');
let library;
function load() {
  return library ??= Deno.dlopen(path.join(__dirname, 'libetcher-mountutils.so'), {
    etcher_unmount_disk: { parameters: ['buffer', 'buffer', 'usize'], result: 'i32', nonblocking: true },
    etcher_eject_disk: { parameters: ['buffer', 'buffer', 'usize'], result: 'i32', nonblocking: true },
  });
}
async function invoke(symbol, device) {
  if (typeof device !== 'string' || !device.startsWith('/') || device.includes('\0')) {
    throw new TypeError('An absolute device path without NUL is required');
  }
  const error = new Uint8Array(4096);
  const rc = await load().symbols[symbol](new TextEncoder().encode(device + '\0'), error, error.length);
  if (rc) {
    const message = new TextDecoder().decode(error.subarray(0, error.indexOf(0)));
    throw Object.assign(new Error(message || `Disk operation failed (${rc})`), { errno: rc, code: ({16: 'EBUSY', 95: 'ENOTSUP', 1: 'EPERM', 13: 'EACCES'})[rc] || 'EIO' });
  }
}
function callbackAPI(symbol, device, callback) {
  if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
  invoke(symbol, device).then(() => callback(null), callback);
}
exports.unmountDisk = (device, callback) => callbackAPI('etcher_unmount_disk', device, callback);
exports.eject = (device, callback) => callbackAPI('etcher_eject_disk', device, callback);
