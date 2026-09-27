// SPDX-License-Identifier: Apache-2.0
const { execFile } = require('node:child_process');

function operation(verb, device, callback) {
  if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
  if (typeof device !== 'string' || !/^\/dev\/(?:r)?disk\d+(?:s\d+)?$/.test(device)) {
    queueMicrotask(() => callback(new TypeError('A macOS disk device path is required')));
    return;
  }
  execFile('/usr/sbin/diskutil', [verb, device], {timeout: 120000}, error => callback(error || null));
}
exports.unmountDisk = (device, callback) => operation('unmountDisk', device, callback);
exports.eject = (device, callback) => operation('eject', device, callback);
