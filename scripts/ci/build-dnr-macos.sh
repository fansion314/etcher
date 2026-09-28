#!/usr/bin/env bash
set -euo pipefail
tag=${RELEASE_TAG:?missing release tag}
revision=${PACKAGE_REVISION:-1}
[[ -f "docs/releases/$tag.md" ]]
[[ $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-dnr\.([0-9]+)$ ]]
version=${BASH_REMATCH[1]}
release=${BASH_REMATCH[2]}
[[ $revision =~ ^[1-9][0-9]*$ ]]
test "$(uname -sm)" = 'Darwin arm64'
# Raw disk flushing requires the Darwin fsync fix in the shared runtime.
python3 - <<'PY_VERSION'
import re, subprocess
version = subprocess.check_output(["dnr", "--version"], text=True)
match = re.match(r"dnr (\d+)\.(\d+)\.(\d+) ", version)
if not match or tuple(map(int, match.groups())) < (0, 4, 3):
    raise SystemExit("Etcher requires dnr >= 0.4.3 for macOS raw disk flushing")
PY_VERSION
test "$version" = "$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')"
out="$PWD/dist/macos-release"
mkdir -p "$out"
pnpm --dir dnr install --frozen-lockfile
node dnr/build.mjs
node dnr/tests/run.mjs
node dnr/tests/package.mjs
app=out/bundle/balenaEtcher.app
test "$(plutil -extract DNRRuntimePath raw -o - "$app/Contents/Info.plist")" = dnr
test "$(plutil -extract DNRLaunchMode raw -o - "$app/Contents/Info.plist")" = supervised
codesign --verify --deep --strict "$app"
archive="etcher-dnr-$version-$release-macos-arm64-r$revision.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$out/$archive" -C out/bundle balenaEtcher.app
(cd "$out" && shasum -a 256 "$archive" > "$archive.sha256")
python3 - "$out/$archive.build.json" <<'PY'
import json, os, subprocess, sys
json.dump({"commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
           "tag": os.environ["RELEASE_TAG"], "dnr": subprocess.check_output(["dnr", "--version"], text=True).strip()},
          open(sys.argv[1], "w"), indent=2)
PY
