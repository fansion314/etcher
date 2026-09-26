if (Deno.args[0] === '--self-test') {
  globalThis.etcherTestRoot = new URL('.', import.meta.url).pathname;
  await import('./runtime-tests.cjs');
} else if (Deno.args[0] === '--worker') {
  await import('./worker.cjs');
} else {
  await import('./main.mjs');
}
