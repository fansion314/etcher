// Narrow adapter for the Electron calls used by the upstream renderer.
// This is not a general Electron emulation layer.
import { host } from './bridge';
const listeners = new Map<string, Set<(...args: any[]) => void>>();
export const ipcRenderer = {
  on(name: string, fn: (...args: any[]) => void) { (listeners.get(name) ?? (listeners.set(name, new Set()), listeners.get(name)!)).add(fn); },
  removeListener(name: string, fn: (...args: any[]) => void) { listeners.get(name)?.delete(fn); },
  send(name: string, ...args: any[]) {
    if (name === 'source-selector-ready') host('initialSource').then(source => {
      if (source) for (const fn of listeners.get('select-image') ?? []) fn({}, source);
    }).catch(console.error);
    else if (name === 'change-lng') host('language', ...args).catch(console.error);
    else if (name === 'disable-screensaver' || name === 'enable-screensaver') host('inhibit', name === 'disable-screensaver').catch(console.error);
    else throw new Error(`Unadapted IPC: ${name}`);
  },
  invoke(name: string, ...args: any[]) { return host(name, ...args); },
};
export const shell = { openExternal: (url: string) => host('openExternal', url) };
// dnr owns user page zoom. Ignore Electron's viewport-based scaling heuristic;
// the renderer entry sets a fixed platform design baseline independently.
export const webFrame = { setZoomFactor: (_factor: number) => {} };
