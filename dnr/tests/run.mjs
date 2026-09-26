import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const result = spawnSync(process.env.DNR_BIN || 'dnr', ['--no-code-cache', '--no-transpile-cache',
  resolve(import.meta.dirname, 'runtime.cjs'), resolve(root, 'out/dnr')], {cwd: root, stdio: 'inherit'});
process.exit(result.status ?? 1);
