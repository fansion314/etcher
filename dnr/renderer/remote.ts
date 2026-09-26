import { host } from './bridge';
export const process = { exit: () => host('quit') };
export const app = { quit: () => host('quit') };
export const getCurrentWindow = () => ({
  setTitle: (title: string) => { document.title = title; host('title', title).catch(console.error); },
  setProgressBar: (value: number) => host('progress', value).catch(console.error),
});
export const dialog = {
  async showOpenDialog(_window: any, options: any) { return {filePaths: await host('dialog.open', options)}; },
  async showMessageBox(_window: any, options: any) { return {response: await host('dialog.message', options)}; },
  showErrorBox: (title: string, message: string) => host('dialog.error', title, message),
};
