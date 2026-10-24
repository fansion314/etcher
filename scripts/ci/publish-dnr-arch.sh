#!/usr/bin/env bash
set -euo pipefail

tag=${GITHUB_REF_NAME:?missing tag}
[[ $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-dnr\.([0-9]+)$ ]]
version=${BASH_REMATCH[1]}
release=${BASH_REMATCH[2]}
notes="docs/releases/$tag.md"
[[ -f $notes ]]

remote_commit=$(git ls-remote origin "refs/tags/$tag^{}" | cut -f1)
if [[ -z $remote_commit ]]; then
    remote_commit=$(git ls-remote origin "refs/tags/$tag" | cut -f1)
fi
[[ $remote_commit == "$GITHUB_SHA" ]]

for variant in etcher-dnr etcher-dnr-bin; do
    source "packaging/aur/$variant/PKGBUILD"
    [[ $pkgver == "$version" && $pkgrel == "$release" ]]
done
archive="etcher-dnr-$version-$release-x86_64.pkg.tar.zst"
[[ -f release-assets/$archive ]]
(cd release-assets && sha256sum --check "$archive.sha256")
(cd release-assets && sha256sum "$archive" > SHA256SUMS)

if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    gh release edit "$tag" --repo "$GITHUB_REPOSITORY" \
        --title "Etcher dnr $tag" --notes-file "$notes"
else
    gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --draft \
        --title "Etcher dnr $tag" --notes-file "$notes"
fi
# Existing public bytes are immutable. New signatures are append-only.
existing=$(mktemp -d)
trap 'rm -rf "$existing"' EXIT
gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name' > "$existing/names"
for asset in release-assets/*; do
    [[ -f $asset ]] || continue
    name=${asset##*/}
    if grep -Fxq "$name" "$existing/names"; then
        gh release download "$tag" --repo "$GITHUB_REPOSITORY" --pattern "$name" --dir "$existing"
        cmp "$asset" "$existing/$name" || { echo "Refusing to overwrite $name; publish a new packaging revision" >&2; exit 1; }
    else
        gh release upload "$tag" "$asset" --repo "$GITHUB_REPOSITORY"
    fi
done
gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false --latest
