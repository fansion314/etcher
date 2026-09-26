export function emit(type: string, payload: any) {
  const line = JSON.stringify({type, payload}) + '\n';
  Deno.stdout.writeSync(new TextEncoder().encode(line));
}
export const emitLog = (payload: any) => emit('log', payload);
export const emitState = (payload: any) => emit('state', payload);
export const emitFail = (payload: any) => emit('fail', payload);
export const emitDrives = (payload: any) => emit('drives', JSON.stringify(Object.values(payload)));
