# Etcher on dnr — Linux x86_64 and macOS arm64

This target keeps Etcher 2.1.7's React UI and etcher-sdk image writer, and replaces
Electron with the shared dnr runtime. It does not bundle Electron, Node, Deno or
CEF. Build-time Node/pnpm are separate from the runtime dependency on dnr.

## Build and run

Install Node 24.15 or newer, pnpm 11 or newer, `dnc>=0.4.1`, `dnr>=0.4.1`,
Python, and xz. Linux builds also need `base-devel`, `pkgconf`, `glib2`, and
`util-linux-libs`. The Linux desktop uses `zenity`, `udisks2`, `polkit`,
`xdg-utils`, `libnotify`, and `systemd-inhibit`; a polkit authentication agent
must be running to authorize writing. macOS builds need Xcode Command Line
Tools; `node-gyp` builds drivelist if no arm64 prebuilt binary is available.

```sh
cd dnr
pnpm install --frozen-lockfile
node build.mjs
node tests/run.mjs
node tests/package.mjs
cd ..
dnr out/bundle/etcher.dnp
# Or select a backend explicitly, before the application path:
dnr --backend webview out/bundle/etcher.dnp
dnr --backend system-cef out/bundle/etcher.dnp /absolute/path/image.img
```

On macOS arm64, the build also writes `out/bundle/balenaEtcher.app`. Its thin
launcher discovers `dnr` at launch time, including Homebrew locations with Finder’s minimal PATH; set
`DNR_RUNTIME_PATH=/absolute/path/to/dnr` to select a different installed shared
runtime. The bundle is signed locally with an ad-hoc signature. It does not
embed dnr or provide Developer ID signing or notarization.

The parent repository's `.nvmrc` pins Node 20 for Electron. Select Node 24 or
newer before installing this target's dependencies. Vite+ is pinned to stable
0.3.3 in this target's lockfile.
Upstream React/rendition/SDK major versions are retained to isolate runtime
compatibility from an unrelated UI/SDK upgrade. The new target has its own lockfile.

Output `out/bundle/etcher.dnp` is **format v4**, appId
`io.balena.etcher.dnr`, with the Etcher PNG embedded as a 128×128 RGBA window
icon. A single reviewed native group keeps backend dependencies and their
relative symlinks together. Other-platform prebuilds, Electron prebuilds and
compiler intermediates are removed. Linux retains Raspberry Pi boot firmware;
the dnc native detector classifies its ELF files as executable resources, but
the SDK transfers these files to devices rather than executing them on the host.
The macOS arm64 package omits this firmware payload.

## AUR recipe

`packaging/aur/etcher-dnr/` is self-contained: a pinned upstream archive plus a
checksummed source overlay, launcher, desktop file, `PKGBUILD` and `.SRCINFO`.
`packaging/aur/etcher-dnr-bin/` installs the matching GitHub Release package
after verifying its published SHA-256. Neither recipe needs the adjacent dnr
development checkout.

```sh
cd packaging/aur/etcher-dnr
makepkg -si
etcher
# Optional runtime override:
ETCHER_DNR_BACKEND=webview etcher
```

The dependency `dnr>=0.4.1` accepts `dnr`, `dnr-bin`, `dnr-cef`, `dnr-cef-bin`,
`dnr-webview`, and `dnr-webview-bin` via their versioned provides. Similarly,
`dnc-bin` can satisfy the source build dependency on dnc. Both recipes require
WebKitGTK and GTK3, so the shared dual runtime can use its WebView fallback on a
clean installation. CEF remains an optional backend when installed separately.

The pacman payload includes the `.dnp` and its preinstalled native group. This
avoids first-run native extraction and lets the privileged worker use root-owned
installed files. `!strip` is intentional: modifying a native file after dnc has
hashed it would invalidate the v4 integrity metadata. Upgrades are handled by
pacman, not electron-updater. These recipes have not been submitted to the AUR.

After editing the port, refresh the distributable overlay and checksums:

```sh
node dnr/update-aur.mjs
```

## Runtime design and behavior

- The renderer is an ordinary browser bundle. Narrow adapters move settings,
  dialogs, external links, notifications, progress and process management across
  a `BrowserWindow.bind()` boundary. The host serves only bundled assets over an
  unguessable loopback path; it does not expose a general HTTP RPC endpoint.
- The scanner and writer run in separate dnr processes. Private stdin/stdout
  pipes replace the original fixed-port WebSocket servers. Linux uses `pkexec`;
  macOS uses `sudo -A` with a temporary AppleScript password prompt. Both start
  the writer with argument arrays and do not interpolate a shell command.
- The package re-enters its own bootstrap with `--worker`. Executing a ZIP-only
  `worker.cjs` filesystem path would fail, because dnr's VFS is not an OS mount.
- Settings are stored in `$XDG_CONFIG_HOME/etcher-dnr/config.json` (or the usual
  `~/.config` fallback). Existing Electron settings are not overwritten.
- File selection uses Zenity on Linux and AppleScript on macOS. Browser file drops cannot
  expose arbitrary local paths, so dropped files are streamed to an app-owned
  temporary file and removed on exit. Selecting a file through the dialog avoids
  this extra copy. Local images, HTTP images and drive cloning retain the SDK path.
- Sleep/idle inhibition is held while flashing. The dnr dock badge represents
  progress; the title stays fixed to avoid native title flicker.
- dnr's native close event is not cancellable. Closing a window during a write
  therefore keeps the writer running in the background and sends a completion
  notification. The ordinary cancel button still aborts the operation. The host
  cleans up the scanner and workers on normal exit.
- Remote success-banner content is offered as an external browser link. It is
  not embedded into a page with disk-operation bindings; dnr has no isolated
  Electron `<webview>`/session equivalent. Electron Sentry is replaced with its
  browser SDK; reporting defaults off and no upstream reporting token is embedded.
- The Linux LED mapping adapter moves sysfs I/O to the host. Etcher Pro hardware
  and physical USB flashing on macOS have not been validated.

## Native adapters

`native/mountutils.c` exports two C ABI functions, called with Deno FFI on
background threads. Each call returns its own error buffer and errno value;
the JS thread never tries to read a worker thread's `errno`.

`unmountDisk` resolves actual block device numbers and sysfs ancestry, parses
kernel mountinfo with libmount, and unmounts nested paths first. It rejects system
mounts and active device-mapper/RAID holders. An `EBUSY` is an error: there is no
lazy/force fallback that could leave filesystem I/O alive during raw writing.

`eject` requires a whole disk. It uses UDisks2's `Eject` for ejectable media or
`PowerOff` where supported, after unmounting. It refuses a power-off that could
disconnect sibling drives in the same reader. Unsupported devices and D-Bus
failures are reported; they are never represented as successful ejection.
The writer invokes this only after write/verification and SDK descriptor closure.
Ejection failures are displayed separately from image verification results.
Set `ejectOnSuccess` to false in the configuration to retain the device.

`native/direct-io/index.cjs` replaces the SDK's old native aligned-buffer helper
with a Deno pointer-based aligned slice. Linux `O_DIRECT` and macOS `O_EXLOCK`
remain enabled. dnr 0.4.1 fixes numeric `O_EXCL` handling, so the SDK now uses
`fs.promises.open` directly with one managed descriptor. The macOS adapter
currently leaves `F_NOCACHE` disabled; write completion still uses `fsync`.
`native/mountutils/darwin.cjs` delegates unmount and eject to `diskutil`.

## Verification boundaries

`tests/runtime.cjs` runs real SDK operations under dnr, with raw/gzip/xz/ZIP/bzip2 and HTTP sources,
two temporary regular-file destinations, verification, aligned buffers, and
read-only enumeration of real devices. On Linux it also exercises `O_DIRECT`
and SDK `BlockDevice` writing against a temporary file with its real
`O_RDWR | O_DIRECT | O_EXCL` flags. On macOS it checks `O_EXLOCK` and the disk
adapter's path validation.
`native/tests/test-native.c` exercises the native implementation with substituted
kernel/D-Bus boundaries, including busy devices, escaped paths, nested mounts,
system-volume refusal, eject versus power-off, shared readers and error propagation.
`tests/package.mjs` checks format v4, the embedded icon and native declarations,
then runs the SDK/FFI tests from the archive with an isolated cache.
`tests/gui-close.py` checks compositor-initiated close and process cleanup on KDE.

`--smoke` opens a real window and checks renderer readiness, binding calls and
worker startup, then exits. Run separately for `system-cef` and `webview`.
These checks do not substitute for authorizing a disposable physical USB drive
and exercising a real privileged write, unplug and safe-eject cycle.

## Homebrew macOS releases

Apple Silicon, macOS 15+: `brew install --cask fansion314/dnr/etcher-dnr`.
The shared tap is [fansion314/homebrew-dnr](https://github.com/fansion314/homebrew-dnr).
It installs dnr as a dependency and installs `balenaEtcher.app` in Applications.
The personal cask verifies the ad-hoc signature and removes quarantine only from
this app. It does not provide Apple notarization or disable Gatekeeper.

Use dnc from Homebrew `dnr 0.4.2_1` or later to build portable macOS launchers.
`release-dnr-macos.yml` builds/tests on `macos-15` for DNR tags. To add a new
macOS revision without moving an existing tag:

```sh
gh workflow run release-dnr-macos.yml --ref main -f release_tag=v2.1.7-dnr.4 -f package_revision=1
```

The job publishes a tar.gz, SHA-256 and build provenance; it refuses to replace
existing assets. The central tap verifies and install-tests new releases before
updating, normally on its twice-hourly schedule. Linux packaging is unchanged.
