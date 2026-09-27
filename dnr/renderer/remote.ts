import { host } from './bridge';
export const process = { exit: () => host('quit') };
export const app = { quit: () => host('quit') };
export const getCurrentWindow = () => ({
  // The upstream progress title changes on every progress event. Native title
  // updates visibly flicker in dnr, so the dock badge carries progress instead.
  setTitle: (_title: string) => {},
  setProgressBar: (value: number) => host('progress', value).catch(console.error),
});
export const dialog = {
  async showOpenDialog(_window: any, options: any) { return {filePaths: await host('dialog.open', options)}; },
  async showMessageBox(_window: any, options: any) { return {response: await host('dialog.message', options)}; },
  showErrorBox: (title: string, message: string) => host('dialog.error', title, message),
};
