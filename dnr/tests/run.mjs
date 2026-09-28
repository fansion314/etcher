import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const closeTests = spawnSync(process.execPath, ['--test', resolve(import.meta.dirname, 'file-close.test.cjs')], {stdio: 'inherit'});
if (closeTests.status !== 0) process.exit(closeTests.status ?? 1);
const result = spawnSync(process.env.DNR_BIN || 'dnr', ['--no-code-cache', '--no-transpile-cache',
  resolve(import.meta.dirname, 'runtime.cjs'), resolve(root, 'out/dnr')], {cwd: root, stdio: 'inherit'});
process.exit(result.status ?? 1);
