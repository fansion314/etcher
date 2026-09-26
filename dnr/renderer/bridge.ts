// The only renderer-to-host entry point. All host operations are asynchronous.
export async function host(method: string, ...args: unknown[]) {
  const result = await (window as any).bindings.etcher(method, args);
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
  return result.value;
}
