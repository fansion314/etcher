import { host } from './bridge';
window.addEventListener('error', event => { host('renderer.error', event.message).catch(console.error); });
window.addEventListener('unhandledrejection', event => { host('renderer.error', String(event.reason?.stack || event.reason)).catch(console.error); });
// Expose only the explicit host-provided configuration, never the host environment.
(globalThis as any).process = { platform: 'linux', env: {}, versions: { dnr: '0.4' } };
(window as any).etcher = {
  async importDroppedFile(file: File) {
    const {url, token} = await host('upload.authorize', file.name);
    const response = await fetch(url, {method: 'POST', headers: {'X-Etcher-Upload': token}, body: file});
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).path;
  },
};
await import('../.build/src/lib/gui/app/renderer');
