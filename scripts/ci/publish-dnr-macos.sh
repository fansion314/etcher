#!/usr/bin/env bash
set -euo pipefail
tag=${RELEASE_TAG:?missing release tag}
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+-dnr\.[0-9]+$ ]]
repository=${GITHUB_REPOSITORY:?missing repository}
if ! gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
  gh release create "$tag" --repo "$repository" --verify-tag --title "DNR $tag" --notes 'macOS ARM64 package for the shared Homebrew dnr runtime.'
fi
test "$(gh release view "$tag" --repo "$repository" --json isDraft,isPrerelease --jq '(.isDraft or .isPrerelease) | not')" = true
(cd release-assets && sha256sum --check -- *.tar.gz.sha256)
existing=$(mktemp -d)
trap 'rm -rf "$existing"' EXIT
for asset in release-assets/*.tar.gz*; do
  name=${asset##*/}
  present=$(gh release view "$tag" --repo "$repository" --json assets --jq ".assets[] | select(.name == \"$name\") | .name")
  if [[ -n $present ]]; then
    gh release download "$tag" --repo "$repository" --pattern "$name" --dir "$existing"
    cmp "$asset" "$existing/$name" || { echo "Refusing to overwrite published $name; increment package_revision" >&2; exit 1; }
  else
    gh release upload "$tag" "$asset" --repo "$repository"
  fi
done
