import { promises as fs, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const here = import.meta.dirname;
const repo = dirname(here);
const output = join(repo, 'out/dnr');
function run(program, args, options = {}) {
  const result = spawnSync(program, args, {cwd: here, stdio: 'inherit', ...options});
  if (result.status !== 0) throw new Error(`${program} failed (${result.status}): ${result.error || ''}`);
}
await fs.mkdir(output, {recursive: true});
const pkgFlags = spawnSync('pkg-config', ['--cflags', '--libs', 'mount', 'gio-2.0'], {encoding: 'utf8'});
if (pkgFlags.status) throw new Error(pkgFlags.stderr);
run('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-fvisibility=hidden', '-shared',
  'native/mountutils.c', '-o', 'native/mountutils/libetcher-mountutils.so', ...pkgFlags.stdout.trim().split(/\s+/)]);

const source = join(here, '.build/src');
await fs.mkdir(source, {recursive: true});
await fs.cp(join(repo, 'lib'), join(source, 'lib'), {recursive: true});
const upstreamPackage = JSON.parse(await fs.readFile(join(repo, 'package.json')));
await fs.writeFile(join(source, 'package.json'), JSON.stringify({...upstreamPackage, packageType: 'dnr'}));
// Changes below are specific to the dnr target; upstream Electron remains buildable.
async function patch(file, from, to) {
  const path = join(source, file);
  const text = await fs.readFile(path, 'utf8');
  if (!text.includes(from)) throw new Error(`Source changed; review dnr adaptation: ${file}`);
  await fs.writeFile(path, text.replace(from, to));
}
await patch('lib/gui/app/app.ts', "const { init: ledsInit } = require('./models/leds');", "const { init: ledsInit } = await import('./models/leds');");
await patch('lib/gui/app/components/source-selector/source-selector.tsx', "await this.selectSource(file.path, 'File').promise;", "await this.selectSource(file.path || await (window as any).etcher.importDroppedFile(file), 'File').promise;");
// A request failure must settle the metadata promise instead of waiting forever.
await patch('lib/shared/drive-constraints.ts', "import * as pathIsInside from 'path-is-inside';", "import pathIsInside from 'path-is-inside';");
await patch('lib/gui/app/app.ts', "import { spawnChildAndConnect } from './modules/api';", "import { spawnChildAndConnect, requestMetadata as getMetadata } from './modules/api';");
const appPath = join(source, 'lib/gui/app/app.ts');
const appCode = await fs.readFile(appPath, 'utf8');
const metadataBlock = /requestMetadata = async \(params: any\): Promise<SourceMetadata> => \{[\s\S]*?\n\t\t\};/;
if (!metadataBlock.test(appCode)) throw new Error('Review upstream metadata adapter');
await fs.writeFile(appPath, appCode.replace(metadataBlock, '').replace('export let requestMetadata: any;', 'export const requestMetadata = getMetadata;'));
await patch('lib/util/source-metadata.ts', 'return {};', 'throw error;');
// Per-destination failures must not finish a multi-target write before its final
// done event. Otherwise the UI can show completion while other drives are busy.
await patch('lib/gui/app/modules/image-writer.ts', '\n\t\t\tfinish();\n\t\t};', '\n\t\t};');
run(join(here, 'node_modules/.bin/vp'), ['build']);

await build({entryPoints: [join(here, 'runtime/host.ts')], outfile: join(output, 'main.mjs'), bundle: true,
  platform: 'node', format: 'esm', target: 'es2022', packages: 'external'});
await build({entryPoints: [join(here, 'runtime/worker.ts')], outfile: join(output, 'worker.cjs'), bundle: true,
  platform: 'node', format: 'cjs', target: 'es2022', packages: 'external', plugins: [{name: 'private-worker-protocol', setup(build) {
    build.onResolve({filter: /^\.\/api$/}, args => args.importer.includes('/lib/util/') ? {path: join(here, 'runtime/events.ts')} : undefined);
  }}]});

// Copy the installed production dependency graph, keeping distinct versions and
// package-local resolution. Do not copy renderer/tooling dependencies or runtimes.
const copied = new Map();
const modules = join(output, 'node_modules');
await fs.rm(modules, {recursive: true, force: true});
await fs.mkdir(join(modules, '.store'), {recursive: true});
function locate(name, start) {
  for (let path = start;; path = dirname(path)) {
    const candidate = join(path, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (path === dirname(path)) throw new Error(`Missing dependency ${name} from ${start}`);
  }
}
async function copyPackage(name, from) {
  const original = locate(name, from);
  if (copied.has(original)) return copied.get(original);
  const target = join(modules, '.store', String(copied.size), name);
  copied.set(original, target);
  await fs.mkdir(dirname(target), {recursive: true});
  await fs.cp(original, target, {recursive: true, filter: p => !['node_modules', '.git'].includes(relative(original, p).split('/')[0])});
  const metadata = JSON.parse(await fs.readFile(join(original, 'package.json')));
  for (const dependency of new Set([...Object.keys(metadata.dependencies || {}), ...Object.keys(metadata.optionalDependencies || {}), ...Object.keys(metadata.peerDependencies || {})])) {
    let dep;
    try { dep = await copyPackage(dependency, original); }
    catch (error) {
      if (metadata.optionalDependencies?.[dependency] || metadata.peerDependencies?.[dependency]) continue;
      throw error;
    }
    const link = join(target, 'node_modules', dependency);
    await fs.mkdir(dirname(link), {recursive: true});
    await fs.symlink(relative(dirname(link), dep), link);
  }
  return target;
}
for (const name of ['etcher-sdk', 'axios', 'lodash', 'outdent', 'mountutils', 'sys-class-rgb-led', 'tslib', 'combined-stream']) {
  const target = await copyPackage(name, here);
  const link = join(modules, name);
  await fs.mkdir(dirname(link), {recursive: true});
  await fs.symlink(relative(dirname(link), target), link);
}
// Always use the reviewed adapter sources, independently of pnpm's local cache.
for (const [name, sourceName] of [['mountutils', 'mountutils'], ['@ronomon/direct-io', 'direct-io']]) {
  for (const [original, target] of copied) {
    const metadata = JSON.parse(await fs.readFile(join(target, 'package.json')));
    if (metadata.name !== name) continue;
    await fs.copyFile(join(here, 'native', sourceName, 'index.cjs'), join(target, 'index.cjs'));
    if (name === 'mountutils') await fs.copyFile(join(here, 'native/mountutils/libetcher-mountutils.so'), join(target, 'libetcher-mountutils.so'));
  }
}
await fs.writeFile(join(output, 'package.json'), JSON.stringify({name: 'etcher-dnr', version: upstreamPackage.version, type: 'module', license: 'Apache-2.0'}));
await fs.copyFile(join(repo, 'LICENSE'), join(output, 'LICENSE'));
await fs.copyFile(join(here, 'runtime/bootstrap.mjs'), join(output, 'bootstrap.mjs'));
await fs.copyFile(join(here, 'tests/runtime.cjs'), join(output, 'runtime-tests.cjs'));
// Remove other OS/CPU prebuilds and compiler intermediates from this x86_64 build.
async function prune(directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    const rel = relative(output, path).replaceAll('\\', '/');
    if (/\/prebuilds\/[^/]+$/.test(rel) && entry.name !== 'linux-x64' ||
        /\/(obj\.target|\.deps)$/.test(rel) || /\.(map|o|gcda|gcno|dll|dylib)$/.test(entry.name) || /\.d\.(ts|mts|cts)$/.test(entry.name) ||
        /\.musl\.node$|^electron\..*\.node$/.test(entry.name)) {
      await fs.rm(path, {recursive: true, force: true}); continue;
    }
    if (entry.isDirectory()) await prune(path);
  }
}
await prune(modules);
const addons = [], libraries = [], executables = [];
async function nativeFiles(directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await nativeFiles(path); continue; }
    const rel = relative(output, path).replaceAll('\\', '/');
    if (entry.name.endsWith('.node')) addons.push({path: rel, napi: 8});
    else if (/\.so(?:\.|$)/.test(entry.name)) libraries.push(rel);
    else {
      const handle = await fs.open(path); const bytes = Buffer.alloc(4);
      await handle.read(bytes, 0, 4, 0); await handle.close();
      const script = /\.(js|ts|mjs|cjs|jsx|tsx)$/.test(entry.name);
      if (bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || (!script &&
          (bytes.subarray(0, 2).toString() === '#!' || ((await fs.stat(path)).mode & 0o111)))) executables.push(rel);
    }
  }
}
await nativeFiles(modules);
const packageConfig = {
  schemaVersion: 1, targets: {linux_x64_glibc: {os: 'linux', arch: 'x64', libc: 'glibc'}},
  groups: [{id: 'backend', files: ['node_modules/**', 'worker.cjs'], native: {addons, libraries, executables}}],
};
await fs.writeFile(join(here, '.build/native.json'), JSON.stringify(packageConfig, null, 2));
const bundle = join(repo, 'out/bundle');
await fs.mkdir(bundle, {recursive: true});
run('dnc', [output, '--entry', 'bootstrap.mjs', '--app-id', 'io.balena.etcher.dnr',
  '--window-icon', join(repo, 'assets/icon.png'), '--package-config', join(here, '.build/native.json'),
  '-o', join(bundle, 'etcher.dnp'), '--force']);
console.log(`Prepared ${output} (${copied.size} backend packages; no Electron or Node executable)`);
