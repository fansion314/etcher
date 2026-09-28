#!/usr/bin/env bash
set -euo pipefail

tag=${1:?usage: build-dnr-arch.sh tag commit}
commit=${2:?missing commit}
[[ $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-dnr\.([0-9]+)$ ]]
version=${BASH_REMATCH[1]}
release=${BASH_REMATCH[2]}
[[ $commit =~ ^[0-9a-f]{40}$ ]]
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -f "$root/docs/releases/$tag.md" ]]
recipe="$root/packaging/aur/etcher-dnr/PKGBUILD"
output="$root/dist/release"

if (( EUID == 0 )); then
    source "$recipe"
    packages=(base-devel curl ca-certificates git)
    for dependency in "${depends[@]}" "${makedepends[@]}" "${checkdepends[@]}"; do
        [[ $dependency == dnr\>* || $dependency == dnc\>* ]] || packages+=("$dependency")
    done
    pacman -Syu --noconfirm --needed "${packages[@]}"

    tools=/tmp/etcher-dnr-tools
    mkdir -p "$tools"
    for name in dnr dnc; do
        archive="$name-0.4.3-1-x86_64.pkg.tar.zst"
        url="https://github.com/fansion314/dnr/releases/download/v0.4.3/$archive"
        curl --fail --location --retry 3 "$url" -o "$tools/$archive"
        curl --fail --location --retry 3 "$url.sha256" -o "$tools/$archive.sha256"
        read -r digest filename extra < "$tools/$archive.sha256"
        [[ $digest =~ ^[0-9a-f]{64}$ && $filename == "$archive" && -z ${extra:-} ]]
        (cd "$tools" && sha256sum --check "$archive.sha256")
    done
    pacman -U --noconfirm "$tools"/*.pkg.tar.zst
    dnr --version
    dnc --version

    useradd --create-home --uid "${ETCHER_BUILD_UID:?missing build uid}" builder
    mkdir -p "$output"
    chown -R builder:builder "$root/packaging/aur/etcher-dnr" "$output"
    exec runuser -u builder -- env HOME=/home/builder bash "$0" "$tag" "$commit"
fi

cd "$root"
[[ $(git rev-parse HEAD) == "$commit" ]]
source "$recipe"
[[ $pkgver == "$version" && $pkgrel == "$release" ]]
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct "$commit")

cd "$root/packaging/aur/etcher-dnr"
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
makepkg --force --noconfirm
archive="etcher-dnr-$version-$release-x86_64.pkg.tar.zst"
[[ -f $archive ]]
cp "$archive" "$output/"
(cd "$output" && sha256sum "$archive" > "$archive.sha256")

stage="$root/dist/ci-etcher-dnr"
mkdir -p "$stage/source" "$stage/bin"
bsdtar -xf "$archive" -C "$stage/source"
[[ -x "$stage/source/usr/bin/etcher" ]]
[[ -f "$stage/source/usr/lib/etcher-dnr/etcher.dnp" ]]
[[ -f "$stage/source/usr/share/applications/etcher.desktop" ]]
[[ ! -e "$stage/source/usr/bin/etcher-dnr" ]]
grep -qx 'Name=balenaEtcher' "$stage/source/usr/share/applications/etcher.desktop"
grep -qx 'Exec=etcher %u' "$stage/source/usr/share/applications/etcher.desktop"

# The -bin recipe cannot download this release until publication. Test it against
# the exact source-built archive and digest that will be uploaded.
source "$root/packaging/aur/etcher-dnr-bin/PKGBUILD"
[[ $pkgver == "$version" && $pkgrel == "$release" ]]
srcdir="$stage/bin/src"
pkgdir="$stage/bin/pkg"
mkdir -p "$srcdir" "$pkgdir"
cp "$output/$archive" "$output/$archive.sha256" "$srcdir/"
prepare
package
[[ -x "$pkgdir/usr/bin/etcher" ]]
[[ -f "$pkgdir/usr/lib/etcher-dnr/etcher.dnp" ]]
[[ -f "$pkgdir/usr/share/applications/etcher.desktop" ]]
[[ ! -e "$pkgdir/usr/bin/etcher-dnr" ]]
cmp "$stage/source/usr/lib/etcher-dnr/etcher.dnp" "$pkgdir/usr/lib/etcher-dnr/etcher.dnp"

{
    printf 'tag=%s\ncommit=%s\n' "$tag" "$commit"
    cat /etc/os-release
    node --version
    pnpm --version
    dnr --version
    dnc --version
    pacman -Q
} > "$output/build-environment.txt"
