import { defineConfig } from 'vite-plus';
import svgr from 'vite-plugin-svgr';
import { resolve, dirname } from 'node:path';
const here = import.meta.dirname;
const adapters: Record<string, string> = {
  '/models/settings': 'settings.ts', '/modules/api': 'api.ts', '/os/notification': 'notification.ts',
  '/components/safe-webview/safe-webview': 'safe-webview.tsx', '/models/leds': 'leds.ts',
};
export default defineConfig({
  root: here,
  base: './',
  plugins: [{name: 'etcher-host-boundary', enforce: 'pre', resolveId(source, importer) {
    const full = (source.startsWith('.') && importer ? resolve(dirname(importer), source) : source).replace(/\.(tsx?|jsx?)$/, '');
    for (const [suffix, file] of Object.entries(adapters)) if (full.endsWith(suffix)) return resolve(here, 'renderer', file);
    if (source === './models/leds') return resolve(here, 'renderer/leds.ts');
  }}, svgr({include: '**/*.svg', svgrOptions: {exportType: 'default'}})],
  resolve: {alias: {
    electron: resolve(here, 'renderer/electron.ts'),
    '@electron/remote': resolve(here, 'renderer/remote.ts'),
    '@sentry/electron/renderer': '@sentry/browser',
    path: 'path-browserify',
    outdent: resolve(here, 'node_modules/outdent/lib/index.js'),
  }},
  define: {'process.env.NODE_ENV': '"production"'},
  build: {target: 'es2022', outDir: '../out/dnr/web', emptyOutDir: true},
});
