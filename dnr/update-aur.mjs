// Regenerate the self-contained AUR source overlay after changing the port.
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const repo = resolve(import.meta.dirname, '..');
const aur = resolve(repo, 'packaging/aur/etcher-dnr');
const binAur = resolve(repo, 'packaging/aur/etcher-dnr-bin');
const overlay = resolve(aur, 'etcher-dnr-port.tar.gz');
const result = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
  '--exclude=node_modules', '--exclude=.build', '--exclude=*.so', '--exclude=test-native',
  '-czf', overlay, 'dnr'], {cwd: repo, stdio: 'inherit'});
if (result.status) throw new Error('Cannot create AUR overlay');
const digest = async name => createHash('sha256').update(await fs.readFile(resolve(aur, name))).digest('hex');
let recipe = await fs.readFile(resolve(aur, 'PKGBUILD'), 'utf8');
recipe = recipe.replace(/sha256sums=\([\s\S]*?\)/, `sha256sums=('ca4983d81dbe4cdd5f04b93b806fe177a32395bd85a9c4b12f44ef7a26167f35'\n            '${await digest('etcher-dnr-port.tar.gz')}'\n            '${await digest('etcher-dnr')}'\n            '${await digest('etcher-dnr.desktop')}')`);
await fs.writeFile(resolve(aur, 'PKGBUILD'), recipe);
const isRoot = process.getuid?.() === 0;
for (const directory of [aur, binAur]) {
  const info = spawnSync(isRoot ? 'runuser' : 'makepkg', isRoot
    ? ['-u', 'nobody', '--', 'makepkg', '--printsrcinfo'] : ['--printsrcinfo'],
    {cwd: directory, encoding: 'utf8', env: {...process.env, ...(isRoot ? {
      BUILDDIR: '/tmp', PKGDEST: '/tmp', SRCDEST: '/tmp', SRCPKGDEST: '/tmp', LOGDEST: '/tmp',
    } : {})}});
  if (info.status) throw new Error(info.stderr);
  await fs.writeFile(resolve(directory, '.SRCINFO'), info.stdout);
}
console.log('Updated source overlay, SHA-256 checksums and both .SRCINFO files');
