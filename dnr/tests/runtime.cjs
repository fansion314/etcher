// Real dnr + SDK tests. All write targets are new regular files in a temp dir.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');
const { gzipSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const root = path.resolve(globalThis.etcherTestRoot || process.argv[2] || 'out/dnr');
const appRequire = createRequire(path.join(root, 'worker.cjs'));
const sdk = appRequire('etcher-sdk');
const mount = appRequire('mountutils');
const sdkRequire = createRequire(appRequire.resolve('etcher-sdk'));
const direct = sdkRequire('@ronomon/direct-io');
async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'etcher-dnr-test-'));
  try {
    for (const alignment of [512, 4096, 65536]) {
      const buffer = direct.getAlignedBuffer(8192, alignment);
      assert.equal(Deno.UnsafePointer.value(Deno.UnsafePointer.of(buffer)) % BigInt(alignment), 0n);
      buffer.fill(0x5a);
      assert.equal(buffer[8191], 0x5a);
    }
    console.log('PASS aligned buffers');
    const directPath = path.join(temporary, 'direct-io.img');
    await fs.writeFile(directPath, Buffer.alloc(8192));
    const handle = await fs.open(directPath, require('node:fs').constants.O_DIRECT | require('node:fs').constants.O_RDWR);
    const directBuffer = direct.getAlignedBuffer(8192, 4096);
    directBuffer.fill(0x37);
    await handle.write(directBuffer, 0, directBuffer.length, 0);
    await handle.sync();
    directBuffer.fill(0);
    await handle.read(directBuffer, 0, directBuffer.length, 0);
    await handle.close();
    assert.ok(directBuffer.every(byte => byte === 0x37));
    console.log('PASS actual O_DIRECT file write, fsync and read');
    const constants = require('node:fs').constants;
    const exclusivePath = path.join(temporary, 'exclusive.img');
    await fs.writeFile(exclusivePath, Buffer.alloc(8192));
    async function descriptorsFor(file) {
      const links = await Promise.all((await fs.readdir('/proc/self/fd')).map(async fd => {
        try { return await fs.readlink(`/proc/self/fd/${fd}`); } catch { return ''; }
      }));
      return links.filter(link => link === file).length;
    }
    const flags = constants.O_RDWR | constants.O_DIRECT | constants.O_EXCL;
    const exclusive = await direct.open(exclusivePath, flags);
    assert.equal(await descriptorsFor(exclusivePath), 2, 'native claim and managed handle remain open together');
    directBuffer.fill(0x62);
    await exclusive.write(directBuffer, 0, directBuffer.length, 0);
    await exclusive.sync();
    directBuffer.fill(0);
    await exclusive.read(directBuffer, 0, directBuffer.length, 0);
    assert.ok(directBuffer.every(byte => byte === 0x62));
    // Numeric fd consumers must also see a genuine Deno-managed descriptor.
    const stream = require('node:fs').createWriteStream(null, {fd: exclusive.fd, autoClose: false});
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.end(directBuffer, resolve); });
    assert.equal(await descriptorsFor(exclusivePath), 2);
    await Promise.all([exclusive.close(), exclusive.close()]);
    assert.equal(await descriptorsFor(exclusivePath), 0, 'close releases both descriptors exactly once');
    await assert.rejects(direct.open(exclusivePath, flags | constants.O_CREAT), {code: 'EEXIST'});
    await assert.rejects(direct.open(exclusivePath, flags | constants.O_TRUNC), {code: 'EINVAL'});
    await assert.rejects(direct.open(exclusivePath + '.absent', flags), {code: 'ENOENT'});
    await assert.rejects(direct.open(exclusivePath + '\0suffix', flags), /NUL/);
    const originalOpen = fs.open;
    fs.open = async () => { throw new Error('simulated managed open failure'); };
    try { await assert.rejects(direct.open(exclusivePath, flags), /simulated managed open failure/); }
    finally { fs.open = originalOpen; }
    assert.equal(await descriptorsFor(exclusivePath), 0, 'failed managed open releases native claim');
    console.log('PASS O_EXCL lifetime, direct read/write/sync, WriteStream, close and failure cleanup');
    await assert.rejects(promisify(mount.unmountDisk)(path.join(temporary, 'absent')), /No such file/);
    await assert.rejects(promisify(mount.eject)('/dev/null'), /Not a block device/);
    await assert.rejects(promisify(mount.unmountDisk)('/dev/a\0b'), /NUL/);
    console.log('PASS FFI loading and non-destructive error paths');
    const payload = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + (i >> 12)) % 251;
    const raw = path.join(temporary, 'source.img');
    await fs.writeFile(raw, payload);
    // Exercise the SDK's real BlockDevice flags and streams on a temporary file.
    // Substitute only unmount: no real device is opened or modified by this test.
    const blockPath = path.join(temporary, 'block-destination.img');
    await fs.writeFile(blockPath, Buffer.alloc(payload.length));
    const originalUnmount = mount.unmountDisk;
    mount.unmountDisk = (device, callback) => { assert.equal(device, blockPath); callback(null); };
    let blockReads = 0;
    class TestBlockDevice extends sdk.sourceDestination.BlockDevice {
      async read(...args) {
        assert.equal(await descriptorsFor(blockPath), 2, 'exclusive descriptor retained during verification');
        blockReads++;
        return super.read(...args);
      }
    }
    try {
      const block = new TestBlockDevice({drive: {raw: blockPath, device: blockPath,
        size: payload.length, blockSize: 512, isReadOnly: false}, write: true, keepOriginal: true});
      assert.equal(block.getOpenFlags(), flags);
      const result = await sdk.multiWrite.decompressThenFlash({
        source: new sdk.sourceDestination.File({path: raw}), destinations: [block],
        verify: true, trim: false, decompressFirst: false, numBuffers: 2,
        onProgress() {}, onFail() {},
      });
      assert.equal(result.failures.size, 0);
      assert.ok(blockReads > 0);
      assert.equal(await descriptorsFor(blockPath), 0);
      assert.deepEqual(await fs.readFile(blockPath), payload);
    } finally { mount.unmountDisk = originalUnmount; }
    console.log('PASS SDK BlockDevice O_RDWR | O_DIRECT | O_EXCL write and verification on temporary file');
    await fs.writeFile(raw + '.gz', gzipSync(payload));
    const xz = spawnSync('xz', ['-c', raw]);
    assert.equal(xz.status, 0, xz.stderr.toString());
    await fs.writeFile(raw + '.xz', xz.stdout);
    const archives = spawnSync('python3', ['-c', 'import sys,zipfile,bz2; p=sys.argv[1]; z=zipfile.ZipFile(p+".zip","w",zipfile.ZIP_DEFLATED); z.write(p,"image.img"); z.close(); open(p+".bz2","wb").write(bz2.compress(open(p,"rb").read()))', raw]);
    assert.equal(archives.status, 0, archives.stderr.toString());
    for (const extension of ['', '.gz', '.xz', '.zip', '.bz2']) {
      const paths = [path.join(temporary, 'destination-a.img'), path.join(temporary, 'destination-b.img')];
      for (const file of paths) await fs.writeFile(file, Buffer.alloc(payload.length));
      const progress = [];
      const failures = [];
      const result = await sdk.multiWrite.decompressThenFlash({
        source: new sdk.sourceDestination.File({path: raw + extension}),
        destinations: paths.map(file => new sdk.sourceDestination.File({path: file, write: true})),
        verify: true, trim: false, decompressFirst: false, numBuffers: 2,
        onProgress: p => progress.push(p.type), onFail: (_destination, error) => failures.push(error),
      });
      assert.equal(result.failures.size, 0);
      assert.deepEqual(failures, []);
      assert.equal(result.bytesWritten, payload.length);
      for (const file of paths) assert.deepEqual(await fs.readFile(file), payload);
      console.log(`PASS SDK write + verify, two destinations, ${extension || 'raw'}`);
    }
    class CorruptedDestination extends sdk.sourceDestination.File {
      async read(buffer, offset, length, position) {
        const result = await super.read(buffer, offset, length, position);
        if (result.bytesRead) buffer[offset] ^= 0xff;
        return result;
      }
    }
    const corruptPath = path.join(temporary, 'corrupt.img');
    await fs.writeFile(corruptPath, Buffer.alloc(payload.length));
    const verification = await sdk.multiWrite.decompressThenFlash({
      source: new sdk.sourceDestination.File({path: raw}),
      destinations: [new CorruptedDestination({path: corruptPath, write: true})],
      verify: true, trim: false, decompressFirst: false, numBuffers: 2,
      onProgress() {}, onFail() {},
    });
    assert.equal(verification.failures.size, 1);
    console.log('PASS verification rejects corrupted destination reads');
    const server = Deno.serve({hostname: '127.0.0.1', port: 0, onListen() {}}, request => {
      const headers = {'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(payload.length)};
      if (request.method === 'HEAD') return new Response(null, {headers});
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') || '');
      if (!range) return new Response(payload, {headers});
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
      if (start > end) return new Response(null, {status: 416});
      return new Response(payload.subarray(start, end + 1), {status: 206, headers: {...headers,
        'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${payload.length}`}});
    });
    try {
      const destinationPath = path.join(temporary, 'http.img');
      await fs.writeFile(destinationPath, Buffer.alloc(payload.length));
      const result = await sdk.multiWrite.decompressThenFlash({
        source: new sdk.sourceDestination.Http({url: `http://127.0.0.1:${server.addr.port}/image.img`}),
        destinations: [new sdk.sourceDestination.File({path: destinationPath, write: true})],
        verify: true, trim: false, decompressFirst: false, numBuffers: 2,
        onProgress() {}, onFail() {},
      });
      assert.equal(result.failures.size, 0);
      assert.deepEqual(await fs.readFile(destinationPath), payload);
      console.log('PASS HTTP range source write and verification');
    } finally { await server.shutdown(); }
    const drives = await sdkRequire('drivelist').list();
    assert.ok(Array.isArray(drives));
    console.log(`PASS real device enumeration (${drives.length} devices, read only)`);
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
