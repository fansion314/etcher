import { host } from './bridge';
import { get } from './settings';
import { observe, store } from '../.build/src/lib/gui/app/models/store';
export async function init() {
  const mapping = await get('ledsMapping');
  if (!mapping || !Object.keys(mapping).length) return;
  await host('leds.init', mapping, await get('ledColors'));
  observe(() => { host('leds.state', store.getState().toJS()).catch(console.error); });
}
