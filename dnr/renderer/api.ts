import { host } from './bridge';
export const requestMetadata = (params: any) => host('metadata', params);
export async function spawnChildAndConnect({ withPrivileges }: {withPrivileges: boolean}) {
  const id = await host('worker.open', withPrivileges);
  const handlers = new Map<string, (payload: any) => void>();
  const pending: any[] = [];
  let closed = false;
  const dispatch = (event: any) => {
    const handler = handlers.get(event.type);
    if (handler) handler(event.payload);
    else if (event.type === 'log') console.log(event.payload);
    else if (event.type === 'fail') {
      closed = true;
      host('dialog.error', 'Etcher worker failed', event.payload.error.message).catch(console.error);
    }
    else pending.push(event);
    if (['done', 'abort', 'skip'].includes(event.type)) closed = true;
  };
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      for (const event of await host('worker.poll', id)) dispatch(event);
      if (closed) clearInterval(timer);
    } catch (error: any) {
      clearInterval(timer);
      dispatch({ type: 'fail', payload: {device: {}, error: {message: error.message}} });
    } finally { polling = false; }
  }, 150);
  return {
    failed: false,
    emit(type: string, payload: any) {
      host('worker.send', id, type, payload).catch(error => dispatch({type: 'fail', payload: {device: {}, error: {message: error.message}}}));
    },
    registerHandler(type: string, handler: (payload: any) => void) {
      handlers.set(type, handler);
      for (let i = 0; i < pending.length;) {
        if (pending[i].type === type) handler(pending.splice(i, 1)[0].payload);
        else i++;
      }
    },
  };
}
