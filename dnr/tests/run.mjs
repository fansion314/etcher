import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const nativeTest = resolve(root, 'dnr/.build/test-exclusive-open');
for (const [command, args] of [
  ['cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', resolve(root, 'dnr/native/tests/test-exclusive-open.c'), '-o', nativeTest]],
  [nativeTest, []],
]) {
  const check = spawnSync(command, args, {cwd: root, stdio: 'inherit'});
  if (check.status !== 0) process.exit(check.status ?? 1);
}
const result = spawnSync(process.env.DNR_BIN || 'dnr', ['--no-code-cache', '--no-transpile-cache',
  resolve(import.meta.dirname, 'runtime.cjs'), resolve(root, 'out/dnr')], {cwd: root, stdio: 'inherit'});
process.exit(result.status ?? 1);
