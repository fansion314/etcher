const assert = require('node:assert/strict');
const {test} = require('node:test');
const {installFlushBeforeClose} = require('../runtime/file-close.cjs');

test('flush writable files before closing and retain flush failures', async () => {
  for (const failure of [undefined, Object.assign(new Error('flush failed'), {code: 'EIO'})]) {
    const events = [];
    class File {
      oWrite = true;
      fileHandle = {sync: async () => {events.push('sync'); if (failure) throw failure;}};
      async _close() {events.push('close');}
    }
    installFlushBeforeClose(File);
    const closing = new File()._close();
    if (failure) await assert.rejects(closing, error => error === failure);
    else await closing;
    assert.deepEqual(events, ['sync', 'close']);
  }
});

test('read-only handles are closed without a write flush', async () => {
  const events = [];
  class File {
    oWrite = false;
    fileHandle = {sync: async () => {throw new Error('read-only flush');}};
    async _close() {events.push('close');}
  }
  installFlushBeforeClose(File);
  await new File()._close();
  assert.deepEqual(events, ['close']);
});
