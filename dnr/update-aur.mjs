// Regenerate the self-contained AUR source overlay after changing the port.
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const repo = resolve(import.meta.dirname, '..');
const aur = resolve(repo, 'packaging/aur/etcher-dnr');
const binAur = resolve(repo, 'packaging/aur/etcher-dnr-bin');
const overlay = resolve(aur, 'etcher-dnr-port.tar.gz');
// Use the same deterministic archive on macOS and GNU/Linux; no native build.
const result = spawnSync('python3', ['-c', `
import gzip, pathlib, tarfile, sys
root = pathlib.Path(sys.argv[1])
with open(sys.argv[2], 'wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for path in [root / 'dnr', *sorted((root / 'dnr').rglob('*'))]:
            relative = path.relative_to(root)
            if any(part in ('node_modules', '.build', '__pycache__') for part in relative.parts) or path.suffix in ('.so', '.pyc') or path.name == 'test-native':
                continue
            info = archive.gettarinfo(str(path), arcname=str(relative))
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            if info.isfile():
                with path.open('rb') as stream:
                    archive.addfile(info, stream)
            else:
                archive.addfile(info)
`, repo, overlay], {cwd: repo, stdio: 'inherit'});
if (result.status) throw new Error('Cannot create AUR overlay');
const digest = async name => createHash('sha256').update(await fs.readFile(resolve(aur, name))).digest('hex');
let recipe = await fs.readFile(resolve(aur, 'PKGBUILD'), 'utf8');
recipe = recipe.replace(/sha256sums=\([\s\S]*?\)/, `sha256sums=('d55b872336c1f59de6ecda48512c91ec388fd564508b4e5fbc48d94674157b2c'\n            '${await digest('etcher-dnr-port.tar.gz')}'\n            '${await digest('etcher-dnr')}'\n            '${await digest('etcher-dnr.desktop')}')`);
await fs.writeFile(resolve(aur, 'PKGBUILD'), recipe);
// --overlay-only is for build-free source preparation; CI regenerates metadata.
const overlayOnly = process.argv.includes('--overlay-only');
const isRoot = process.getuid?.() === 0;
for (const directory of overlayOnly ? [] : [aur, binAur]) {
  const info = spawnSync(isRoot ? 'runuser' : 'makepkg', isRoot
    ? ['-u', 'nobody', '--', 'makepkg', '--printsrcinfo'] : ['--printsrcinfo'],
    {cwd: directory, encoding: 'utf8', env: {...process.env, ...(isRoot ? {
      BUILDDIR: '/tmp', PKGDEST: '/tmp', SRCDEST: '/tmp', SRCPKGDEST: '/tmp', LOGDEST: '/tmp',
    } : {})}});
  if (info.status) throw new Error(info.stderr);
  await fs.writeFile(resolve(directory, '.SRCINFO'), info.stdout);
}
console.log(overlayOnly ? 'Updated source overlay and SHA-256 checksums (metadata deferred to CI)' : 'Updated source overlay, SHA-256 checksums and both .SRCINFO files');
