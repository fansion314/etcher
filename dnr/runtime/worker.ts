import { createInterface } from 'node:readline';
import { stdin } from 'node:process';
import { promisify } from 'node:util';
import { emit } from './events';
import { write, cleanup } from '../.build/src/lib/util/child-writer';
import { getSourceMetadata } from '../.build/src/lib/util/source-metadata';
import { startScanning, stopScanning } from '../.build/src/lib/util/scanner';
import { toJSON } from '../.build/src/lib/shared/errors';
import mountutils from 'mountutils';
import { promises as fs } from 'node:fs';
import { sourceDestination } from 'etcher-sdk';
import { installFlushBeforeClose } from './file-close.cjs';

// Flush write handles before the SDK closes them and before UDisks ejects media.
installFlushBeforeClose(sourceDestination.File);

console.log = console.error; // stdout is exclusively the private parent protocol.
let writing = false;
let scanning = false;
let terminal = false;
async function stop(type = 'abort') {
  if (terminal) return;
  terminal = true;
  stopScanning();
  await cleanup(Date.now()).catch(console.error);
  emit(type, {});
  Deno.exit(0);
}
createInterface({input: stdin}).on('line', async line => {
  let message: any;
  try {
    message = JSON.parse(line);
    const {type, payload} = message;
    if (type === 'scan' && !scanning) { scanning = true; startScanning(); }
    else if (type === 'sourceMetadata') {
      const { selected, SourceType, auth } = JSON.parse(payload);
      emit('sourceMetadata', JSON.stringify(await getSourceMetadata(selected, SourceType, auth)));
    } else if (type === 'metadata') {
      try {
        const {selected, SourceType, auth} = payload.params;
        emit('metadata', {id: payload.id, value: await getSourceMetadata(selected, SourceType, auth)});
      } catch (error: any) { emit('metadata', {id: payload.id, error: {message: error.message}}); }
    } else if (type === 'write') {
      if (writing) throw new Error('A write is already active');
      writing = true;
      if (!Array.isArray(payload.destinations) || !payload.destinations.length) throw new Error('No destinations selected');
      const seen = new Set<string>();
      for (const drive of payload.destinations) {
        const device = await fs.realpath(drive.device);
        const raw = await fs.realpath(drive.raw);
        const valid = Deno.build.os === 'darwin'
          ? /^\/dev\/disk\d+$/.test(device) && raw === device.replace('/dev/disk', '/dev/rdisk') && (await fs.stat(raw)).isCharacterDevice()
          : device === raw && (await fs.stat(raw)).isBlockDevice();
        if (!valid) throw new Error('Destination must identify one real disk device');
        if (seen.has(raw)) throw new Error('Duplicate destination');
        if (payload.image.drive && await fs.realpath(payload.image.drive.raw || payload.image.drive.device) === raw) throw new Error('Source and destination must differ');
        seen.add(raw);
      }
      const results = await write(payload);
      // The SDK has closed its file descriptors and completed verification here.
      // Eject errors remain separate from successful data verification.
      const ejectErrors: {device: string; message: string}[] = [];
      if (payload.ejectOnSuccess !== false && results.devices) {
        const failed = new Set(results.errors.map((error: any) => error.device));
        for (const drive of payload.destinations) {
          if (failed.has(drive.device)) continue;
          try { await promisify(mountutils.eject)(drive.device); }
          catch (error: any) { ejectErrors.push({device: drive.device, message: error.message}); }
        }
      }
      emit('done', {results: {...results, errors: results.errors.map(toJSON)}, ejectErrors});
      terminal = true;
      Deno.exit(0);
    } else if (type === 'cancel' || type === 'terminate') await stop(payload === 'skip' ? 'skip' : 'abort');
  } catch (error) {
    if (writing) {
      emit('done', {results: {bytesWritten: 0, devices: {failed: message?.payload?.destinations?.length || 1, successful: 0}, errors: [toJSON(error as Error)]}});
      Deno.exit(1);
    }
    emit('error', toJSON(error as Error));
    if (!scanning) emit('sourceMetadata', '{}');
  }
}).on('close', () => stop());
Deno.addSignalListener('SIGTERM', () => { stop(); });
emit('ready', {});
