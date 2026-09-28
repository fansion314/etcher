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
gh release upload "$tag" "release-assets/$archive" "release-assets/$archive.sha256" \
    --repo "$GITHUB_REPOSITORY" --clobber
gh release edit "$tag" --repo "$GITHUB_REPOSITORY" --draft=false --latest
