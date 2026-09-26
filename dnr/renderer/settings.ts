import { host } from './bridge';
export const DEFAULT_WIDTH = 800;
export const DEFAULT_HEIGHT = 480;
let settings: Record<string, any> = { errorReporting: false, updatesEnabled: false,
  desktopNotifications: true, autoBlockmapping: true, decompressFirst: true, ejectOnSuccess: true };
const loaded = host('settings.get').then(value => { settings = { ...settings, ...value, updatesEnabled: false }; });
export async function get(key: string) { await loaded; return getSync(key); }
export function getSync(key: string) { return structuredClone(settings[key]); }
export async function getAll() { await loaded; return structuredClone(settings); }
export async function readAll() { return getAll(); }
export async function set(key: string, value: unknown) {
  await loaded;
  await host('settings.set', key, value);
  settings[key] = value;
}
