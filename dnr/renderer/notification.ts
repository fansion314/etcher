import { host } from './bridge';
import { get } from './settings';
export async function send(title: string, body: string, _icon: string) {
  if (await get('desktopNotifications')) await host('notify', title, body);
}
