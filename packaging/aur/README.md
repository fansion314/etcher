# Etcher dnr packages for Arch Linux

The source recipe is `etcher-dnr/`. It downloads the pinned upstream Etcher
archive and the checksummed port overlay, builds with Node/pnpm/Vite+, and uses
`dnc` to install the v4 `.dnp` with its native group. The package installs
`/usr/bin/etcher` and replaces the usual Etcher desktop entry.

The `etcher-dnr-bin/` recipe downloads the matching package and SHA-256 file
from the [GitHub Release](https://github.com/fansion314/etcher/releases). Its
`prepare()` verifies the digest before copying the release payload into an AUR
package. Both recipes depend on dnr 0.4.1 or newer and WebKitGTK; CEF is
optional. They conflict with each other and with the conventional Etcher
packages. Neither recipe has been submitted to the AUR yet.

For the current source release, use tag `v2.1.7-dnr.3`. The tag matches
`pkgver=2.1.7` and `pkgrel=3` in both recipes. `dnr/update-aur.mjs` refreshes
the source overlay, checksums, and both `.SRCINFO` files in an Arch environment.
The tagged GitHub Actions workflow builds the source recipe and validates the
`-bin` recipe before publishing a release asset for it to download.
