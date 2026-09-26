import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

const root = dirname(fileURLToPath(import.meta.url));
// A v4 ZIP is not an OS mount. Relaunch the actual .dnp, then import the worker
// inside that process's VFS. A bare virtual worker.cjs path cannot be executed.
let application = join(root, 'etcher.dnp');
try { await Deno.stat(application); } catch { application = join(root, 'bootstrap.mjs'); }
const encoder = new TextEncoder();
const configDir = join(Deno.env.get('XDG_CONFIG_HOME') || join(Deno.env.get('HOME')!, '.config'), 'etcher-dnr');
await Deno.mkdir(configDir, {recursive: true, mode: 0o700});
const configPath = join(configDir, 'config.json');
let settings: Record<string, any> = {};
try { settings = JSON.parse(await Deno.readTextFile(configPath)); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) console.error(e); }
const initialArgument = Deno.args.find(arg => !arg.startsWith('--'));
const initialSource = initialArgument?.replace(/^etcher:\/\//, '');
const workers = new Map<string, any>();
const uploads = new Map<string, string>();
const metadataRequests = new Map<string, {resolve: (value: any) => void; reject: (reason: any) => void; timer: number}>();
const uploadRoot = await Deno.makeTempDir({prefix: 'etcher-dnr-'});
let window: Deno.BrowserWindow | undefined;
let quitting = false;
let inhibitor: Deno.ChildProcess | undefined;
let configWrite = Promise.resolve();
const rendererErrors: string[] = [];
let ledController: any;
const ledDevices = new Map<string, any>();
let ledColors: Record<string, number[]> = {};

async function command(program: string, args: string[]) {
  return new Deno.Command(program, {args, stdin: 'null', stdout: 'piped', stderr: 'piped'}).output();
}
function activeWrite() { return [...workers.values()].some(worker => worker.privileged && !worker.finished); }
async function inhibit(on: boolean) {
  if (!on) { if (inhibitor) { try { await inhibitor.stdin.close(); } catch {} inhibitor = undefined; } return; }
  if (!inhibitor) {
    inhibitor = new Deno.Command('/usr/bin/systemd-inhibit', {
      args: ['--what=sleep:idle', '--mode=block', '--why=Etcher is writing a disk', '/usr/bin/cat'],
      stdin: 'piped', stdout: 'null', stderr: 'inherit',
    }).spawn();
    inhibitor.status.then(status => { if (!status.success) console.error('Sleep inhibition failed'); });
  }
}
async function notify(title: string, body: string) {
  if (settings.desktopNotifications !== false) await command('/usr/bin/notify-send', ['--app-name=Etcher DNR', title, body]);
}
async function quit(force = false) {
  if (quitting) return;
  if (activeWrite() && !force) {
    const result = await command('/usr/bin/zenity', ['--question', '--title=Etcher DNR', '--text=A disk is being written. Cancel the operation and exit?', '--default-cancel']);
    if (!result.success) return;
  }
  quitting = true;
  ledController?.stop();
  await Promise.all([...ledDevices.values()].map(led => led.close().catch(console.error)));
  for (const worker of workers.values()) {
    try { await worker.input.write(encoder.encode(JSON.stringify({type: 'terminate'}) + '\n')); } catch {}
  }
  await Promise.all([...workers.values()].map(async worker => {
    await Promise.race([worker.child.status, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (!worker.exited) try { worker.child.kill('SIGTERM'); } catch {}
  }));
  await inhibit(false);
  await Deno.remove(uploadRoot, {recursive: true}).catch(() => {});
  window?.close();
  await server.shutdown();
  Deno.exit(0);
}

async function openWorker(privileged: boolean) {
  if (privileged && activeWrite()) throw new Error('A writer is already running');
  // stdin/stdout pipes form a private channel. There is no public root WebSocket
  // server, shell interpolation, inherited application environment or auth token.
  const runtime = Deno.execPath();
  const args = [runtime, application, '--worker'];
  const child = new Deno.Command(privileged ? '/usr/bin/pkexec' : args.shift()!, {
    args: privileged ? ['--disable-internal-agent', ...args] : args,
    stdin: 'piped', stdout: 'piped', stderr: 'inherit',
  }).spawn();
  const id = crypto.randomUUID();
  let readyResolve: () => void;
  let readyReject: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const worker = {child, input: child.stdin.getWriter(), events: [] as any[], privileged,
    finished: false, exited: false, ready: false, readyPromise: ready};
  workers.set(id, worker);
  const lines = createInterface({input: Readable.fromWeb(child.stdout as any)});
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'ready') { worker.ready = true; readyResolve(); return; }
      if (event.type === 'metadata') {
        const request = metadataRequests.get(event.payload.id);
        if (request) {
          clearTimeout(request.timer); metadataRequests.delete(event.payload.id);
          if (event.payload.error) request.reject(new Error(event.payload.error.message));
          else request.resolve(event.payload.value);
        }
        return;
      }
      if (event.type === 'drives' || event.type === 'state') {
        worker.events = worker.events.filter(e => e.type !== event.type);
      }
      if (event.type === 'error') worker.events.push({type: 'fail', payload: {device: {}, error: event.payload}});
      else worker.events.push(event);
      if (['done', 'abort', 'skip'].includes(event.type)) {
        worker.finished = true;
        if (privileged) inhibit(false).catch(console.error);
        if (event.payload?.ejectErrors?.length) {
          const details = event.payload.ejectErrors.map((e: any) => `${e.device}: ${e.message}`).join('\n');
          command('/usr/bin/zenity', ['--warning', '--title=Etcher: eject incomplete', '--text=Image verification finished, but safe removal did not complete:\n' + details]).catch(console.error);
        }
        if (!window || window.isClosed()) {
          notify('Etcher DNR', event.type === 'done' ? 'Disk operation completed. See results in the application log.' : 'Disk operation stopped.').finally(() => quit(true));
        }
      }
    } catch (error) { console.error('Invalid worker output', error); }
  });
  child.status.then(status => {
    worker.exited = true;
    if (!worker.ready) readyReject(new Error(`Worker could not start (exit ${status.code}); authorization may have been cancelled`));
    if (!worker.finished) {
      worker.finished = true;
      const error = {message: `Worker exited unexpectedly (${status.code})`};
      worker.events.push(privileged
        ? {type: 'done', payload: {results: {bytesWritten: 0, devices: {failed: 1, successful: 0}, errors: [error]}}}
        : {type: 'fail', payload: {device: {}, error}});
      if (privileged) inhibit(false).catch(console.error);
    }
    if ((!window || window.isClosed()) && !quitting) void quit(true);
  });
  const timeout = setTimeout(() => readyReject(new Error('Worker startup timed out')), 120000);
  try { await ready; } catch (error) { try { child.kill('SIGTERM'); } catch {} workers.delete(id); throw error; }
  finally { clearTimeout(timeout); }
  return id;
}

async function dispatch(method: string, args: any[]) {
  switch (method) {
    case 'metadata': {
      const worker = [...workers.values()].find(w => !w.privileged && !w.finished);
      if (!worker) throw new Error('Image scanner is not ready');
      await worker.readyPromise;
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { metadataRequests.delete(id); reject(new Error('Image metadata request timed out')); }, 60000);
        metadataRequests.set(id, {resolve, reject, timer});
        worker.input.write(encoder.encode(JSON.stringify({type: 'metadata', payload: {id, params: args[0]}}) + '\n')).catch(reject);
      });
    }
    case 'leds.init': {
      if (ledController) return null;
      const {Animator, RGBLed} = await import('sys-class-rgb-led');
      for (const [path, names] of Object.entries(args[0])) {
        if (!Array.isArray(names) || names.length !== 3 || names.some(n => typeof n !== 'string' || n.includes('/') || n.includes('..'))) throw new Error('Invalid LED mapping');
        ledDevices.set('/dev/disk/by-path/' + path, new RGBLed(names));
      }
      ledColors = {green: [0,1,0], purple: [1,0,1], red: [1,0,0], blue: [0,0,1], white: [1,1,1], black: [0,0,0], ...args[1]};
      ledController = new Animator([], 10);
      return null;
    }
    case 'leds.state': {
      if (!ledController) return null;
      const state = args[0];
      const selected = new Set(state.isFlashing ? state.devicePaths : state.availableDrives.filter((d: any) => state.selection.devices.includes(d.device)).map((d: any) => d.devicePath));
      const failed = new Set(state.failedDeviceErrors.map((entry: any) => entry[1].devicePath));
      ledController.mapping = [...ledDevices].map(([path, led]) => {
        const color = failed.has(path) ? 'red' : selected.has(path) ? (state.isFlashing ? (state.flashState.type === 'verifying' ? 'green' : 'purple') : state.lastAverageFlashingSpeed == null ? 'white' : 'green') : 'black';
        return {rgbLeds: [led], animation: (t: number) => ledColors[color].map(v => v * (state.isFlashing && selected.has(path) && !failed.has(path) ? Math.floor(t) % 2 : 1))};
      });
      return null;
    }
    case 'renderer.error': rendererErrors.push(String(args[0])); console.error('Renderer:', args[0]); return null;
    case 'settings.get': return settings;
    case 'settings.set': {
      const [key, value] = args;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid setting');
      configWrite = configWrite.catch(() => {}).then(async () => {
        const next = {...settings, [key]: value};
        await Deno.writeTextFile(configPath + '.tmp', JSON.stringify(next, null, 2), {mode: 0o600});
        await Deno.rename(configPath + '.tmp', configPath);
        settings = next;
      });
      await configWrite; return null;
    }
    case 'worker.open': return openWorker(args[0] === true);
    case 'worker.poll': {
      const worker = workers.get(args[0]);
      if (!worker) throw new Error('Unknown worker');
      return worker.events.splice(0);
    }
    case 'worker.send': {
      const [id, type, payload] = args;
      const worker = workers.get(id);
      if (!worker || worker.finished) throw new Error('Worker is no longer available');
      if (!['scan', 'sourceMetadata', 'write', 'cancel', 'terminate'].includes(type)) throw new Error('Unknown worker operation');
      if (type === 'write' && !worker.privileged) throw new Error('Writing requires an authorized worker');
      if (type === 'write') payload.ejectOnSuccess = settings.ejectOnSuccess !== false;
      await worker.input.write(encoder.encode(JSON.stringify({type, payload}) + '\n'));
      return null;
    }
    case 'dialog.open': {
      const options = args[0] ?? {};
      const cmd = ['--file-selection', '--title=Select an image'];
      for (const filter of options.filters ?? []) cmd.push(`--file-filter=${filter.name} | ${filter.extensions.map((e: string) => e === '*' ? '*' : '*.' + e).join(' ')}`);
      const result = await command('/usr/bin/zenity', cmd);
      if (result.code === 1) return [];
      if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
      return [new TextDecoder().decode(result.stdout).trimEnd()];
    }
    case 'dialog.message': {
      const options = args[0];
      const result = await command('/usr/bin/zenity', ['--question', '--default-cancel', '--title=' + options.title,
        '--text=' + options.message + '\n' + (options.detail || ''), '--ok-label=' + options.buttons[0], '--cancel-label=' + options.buttons[1]]);
      return result.success ? 0 : 1;
    }
    case 'dialog.error': await command('/usr/bin/zenity', ['--error', '--title=' + args[0], '--text=' + args[1]]); return null;
    case 'openExternal': {
      const url = new URL(args[0]);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Unsupported external URL');
      await command('/usr/bin/xdg-open', [url.href]); return null;
    }
    case 'title': window?.setTitle(String(args[0])); return null;
    case 'progress': Deno.dock.setBadge(args[0] < 0 ? null : `${Math.round(args[0] * 100)}%`); return null;
    case 'notify': await notify(args[0], args[1]); return null;
    case 'inhibit': await inhibit(Boolean(args[0])); return null;
    case 'quit': void quit(); return null;
    case 'language': return null;
    case 'initialSource': return initialSource || null;
    case 'mount-drive': {
      const path = await Deno.realPath(args[0]);
      if (!path.startsWith('/dev/')) throw new Error('Not a device path');
      const result = await command('/usr/bin/udisksctl', ['mount', '--block-device', path]);
      if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
      return null;
    }
    case 'upload.authorize': {
      const token = crypto.randomUUID();
      uploads.set(token, basename(args[0]));
      return {url: `${origin}/${secret}/upload`, token};
    }
    default: throw new Error(`Unknown host operation: ${method}`);
  }
}

const secret = crypto.randomUUID();
let origin = '';
const mime: Record<string, string> = {html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2'};
const server = Deno.serve({hostname: '127.0.0.1', port: 0, onListen() {}}, async request => {
  const url = new URL(request.url);
  if (url.origin !== origin || !url.pathname.startsWith(`/${secret}/`)) return new Response('Not found', {status: 404});
  const relative = decodeURIComponent(url.pathname.slice(secret.length + 2));
  if (relative === 'upload' && request.method === 'POST') {
    const token = request.headers.get('X-Etcher-Upload') || '';
    const name = uploads.get(token);
    uploads.delete(token);
    if (!name || request.headers.get('Origin') !== origin || !request.body) return new Response('Unauthorized', {status: 403});
    const path = join(uploadRoot, crypto.randomUUID() + '-' + name);
    try {
      const file = await Deno.open(path, {createNew: true, write: true, mode: 0o600});
      await request.body.pipeTo(file.writable);
      return Response.json({path});
    } catch (error) { await Deno.remove(path).catch(() => {}); return new Response(String(error), {status: 500}); }
  }
  if (request.method !== 'GET' || relative.split('/').some(part => part === '..')) return new Response('Not found', {status: 404});
  try {
    const file = relative || 'index.html';
    return new Response(await Deno.readFile(join(root, 'web', file)), {headers: {
      'Content-Type': mime[file.split('.').pop()!] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:; frame-src 'none'; object-src 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    }});
  } catch { return new Response('Not found', {status: 404}); }
});
origin = `http://127.0.0.1:${server.addr.port}`;
window = new Deno.BrowserWindow({title: 'balenaEtcher — dnr', width: 820, height: 560});
window.setApplicationMenu([
  {submenu: {label: 'Etcher', items: [{item: {id: 'quit', label: 'Quit', accelerator: 'Ctrl+Q', enabled: true}}]}},
  {submenu: {label: 'View', items: [{item: {id: 'devtools', label: 'Developer tools', accelerator: 'Ctrl+Shift+I', enabled: true}}]}},
  {submenu: {label: 'Help', items: [
    {item: {id: 'website', label: 'Etcher website', enabled: true}},
    {item: {id: 'issues', label: 'Report an issue', enabled: true}},
  ]}},
]);
window.addEventListener('menuclick', event => {
  if (event.detail.id === 'quit') void quit();
  if (event.detail.id === 'devtools') window?.openDevtools();
  if (event.detail.id === 'website') void dispatch('openExternal', ['https://etcher.balena.io/']);
  if (event.detail.id === 'issues') void dispatch('openExternal', ['https://github.com/balena-io/etcher/issues']);
});
window.bind('etcher', async (method: string, args: any[]) => {
  try { return {ok: true, value: await dispatch(method, args)}; }
  catch (error: any) { console.error(error); return {ok: false, error: {message: error.message, code: error.code}}; }
});
window.addEventListener('close', () => {
  if (quitting) return;
  // Native close is not cancellable in dnr. Keep an active writer alive instead
  // of interrupting the disk; the user can cancel from the visible application.
  if (activeWrite()) void notify('Etcher DNR', 'The disk operation continues in the background. You will be notified when it finishes.');
  else void quit(true);
});
window.navigate(`${origin}/${secret}/`);
Deno.addSignalListener('SIGTERM', () => { void quit(true); });
Deno.addSignalListener('SIGINT', () => { void quit(true); });
if (Deno.args.includes('--devtools')) window.openDevtools();
if (Deno.args.includes('--smoke') || Deno.args.includes('--smoke-hold')) {
  void (async () => {
    try {
      for (let i = 0; i < 100; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (rendererErrors.length) throw new Error(rendererErrors.join('\n'));
        const result = await window!.executeJs("({text: document.body.innerText, buttons: document.querySelectorAll('button').length})");
        if (result.ok && result.value?.buttons >= 3 && [...workers.values()].some(w => w.ready) &&
            (!initialSource || result.value.text.includes(basename(initialSource)))) {
          console.log('DNR_ETCHER_GUI_OK', JSON.stringify(result.value));
          if (!Deno.args.includes('--smoke-hold')) await quit(true);
          return;
        }
      }
      throw new Error('Etcher GUI did not become ready');
    } catch (error) { console.error(error); Deno.exit(1); }
  })();
}
