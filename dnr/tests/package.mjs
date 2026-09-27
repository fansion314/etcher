import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dirname, '../..');
const bundle = resolve(root, 'out/bundle/etcher.dnp');
const inspected = spawnSync('dnc', ['inspect', bundle, '--json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
assert.equal(inspected.status, 0, inspected.stderr);
const metadata = JSON.parse(inspected.stdout);
assert.equal(metadata.manifest.formatVersion, 4);
assert.equal(metadata.manifest.appId, 'io.balena.etcher.dnr');
assert.equal(metadata.manifest.desktop.windowIcon.width, 128);
assert.equal(metadata.manifest.desktop.windowIcon.height, 128);
assert.equal(metadata.manifest.desktop.windowIcon.bytes, 65536);
if (process.platform === 'linux') assert.ok(metadata.records.some(record => record.native === 'library' && record.path.endsWith('libetcher-mountutils.so')));
assert.ok(!metadata.records.some(record => record.path.endsWith('libetcher-exclusive-open.so')));
assert.ok(metadata.records.some(record => record.native === 'addon'));
console.log('PASS v4 metadata, embedded 128x128 icon and native declarations');
const cache = mkdtempSync(resolve(tmpdir(), 'etcher-dnr-cache-'));
try {
  const test = spawnSync(process.env.DNR_BIN || 'dnr', [bundle, '--self-test'], {
    stdio: 'inherit', env: {...process.env, DNR_CACHE_DIR: cache},
  });
  assert.equal(test.status, 0, 'Packaged SDK/FFI self-test failed');
} finally { rmSync(cache, {recursive: true, force: true}); }
