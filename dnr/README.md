# Etcher on dnr — Linux x86_64 experiment

This target keeps Etcher 2.1.7's React UI and etcher-sdk image writer, and replaces
Electron with the shared dnr runtime. It does not bundle Electron, Node, Deno or
CEF. Build-time Node/pnpm are separate from the runtime dependency on dnr.

## Build and run

Install `nodejs` (22.13 or newer), `pnpm` (11 or newer), `dnc>=0.4.0`,
`dnr>=0.4.0`, `base-devel`, `pkgconf`, `python`, `glib2`, `util-linux-libs`, and `xz`.
The desktop additionally uses `zenity`, `udisks2`, `polkit`, `xdg-utils`,
`libnotify`, and `systemd-inhibit`. A polkit authentication agent must be running
in the graphical session to authorize writing. Install shared CEF + GTK3 or
the WebKitGTK backend supported by your chosen dnr package.

```sh
cd dnr
pnpm install --frozen-lockfile
pnpm exec node build.mjs
node tests/run.mjs
node tests/package.mjs
cd ..
dnr out/bundle/etcher.dnp
# Or select a backend explicitly, before the application path:
dnr --backend webview out/bundle/etcher.dnp
dnr --backend system-cef out/bundle/etcher.dnp /absolute/path/image.img
```

The parent repository's `.nvmrc` pins Node 20 for Electron. Use the system Node
for this target if your version manager inherits that pin. Vite+ is pinned to
stable 0.3.3; its `latest` tag pointed to a release candidate during this port.
Upstream React/rendition/SDK major versions are retained to isolate runtime
compatibility from an unrelated UI/SDK upgrade. The new target has its own lockfile.

Output `out/bundle/etcher.dnp` is **format v4**, appId
`io.balena.etcher.dnr`, with the Etcher PNG embedded as a 128×128 RGBA window
icon. A single reviewed native group keeps backend dependencies and their
relative symlinks together. Other-platform prebuilds, Electron prebuilds and
compiler intermediates are removed. Raspberry Pi boot firmware is retained;
the dnc native detector classifies its ELF files as executable resources, but
the SDK transfers these files to devices rather than executing them on the host.

## AUR recipe

`packaging/aur/etcher-dnr/` is self-contained: a pinned upstream archive plus a
checksummed source overlay, launcher, desktop file, `PKGBUILD` and `.SRCINFO`.
It does not require the adjacent development checkout of dnr.

```sh
cd packaging/aur/etcher-dnr
makepkg -si
etcher-dnr
# Optional runtime override:
ETCHER_DNR_BACKEND=webview etcher-dnr
```

The dependency `dnr>=0.4.0` accepts `dnr`, `dnr-bin`, `dnr-cef`, `dnr-cef-bin`,
`dnr-webview`, and `dnr-webview-bin` via their versioned provides. Similarly,
`dnc-bin` can satisfy the build dependency on dnc. The recipe explicitly requires
shared `cef` and `gtk3`, making the default dual runtime usable on a clean
installation. A WebView-only runtime brings its own mandatory WebKitGTK stack;
in that combination CEF remains installed but is not used. Pacman cannot express
a dependency on “CEF plus GTK, or WebKitGTK” without a common provider package.

The pacman payload includes the `.dnp` and its preinstalled native group. This
avoids first-run native extraction and lets the privileged worker use root-owned
installed files. `!strip` is intentional: modifying a native file after dnc has
hashed it would invalidate the v4 integrity metadata. Upgrades are handled by
pacman, not electron-updater. This recipe has not been submitted to the AUR.

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
  pipes replace the original fixed-port WebSocket servers. `pkexec` starts the
  writer with argument arrays, without interpolating a shell command. The host
  does not forward its entire environment to root.
- The package re-enters its own bootstrap with `--worker`. Executing a ZIP-only
  `worker.cjs` filesystem path would fail, because dnr's VFS is not an OS mount.
- Settings are stored in `$XDG_CONFIG_HOME/etcher-dnr/config.json` (or the usual
  `~/.config` fallback). Existing Electron settings are not overwritten.
- File selection uses the shared Zenity native dialog. Browser file drops cannot
  expose arbitrary local paths, so dropped files are streamed to an app-owned
  temporary file and removed on exit. Selecting a file through the dialog avoids
  this extra copy. Local images, HTTP images and drive cloning retain the SDK path.
- Sleep/idle inhibition is held while flashing. Window progress is represented
  by the title and dnr dock badge; an Electron-style Linux taskbar progress API is
  not available through this dnr interface.
- dnr's native close event is not cancellable. Closing a window during a write
  therefore keeps the writer running in the background and sends a completion
  notification. The ordinary cancel button still aborts the operation. The host
  cleans up the scanner and workers on normal exit.
- Remote success-banner content is offered as an external browser link. It is
  not embedded into a page with disk-operation bindings; dnr has no isolated
  Electron `<webview>`/session equivalent. Electron Sentry is replaced with its
  browser SDK; reporting defaults off and no upstream reporting token is embedded.
- The Linux LED mapping adapter moves sysfs I/O to the host. Etcher Pro hardware,
  Windows/macOS-specific behavior are outside
  this Linux x86_64 experiment's validated hardware/platform scope.

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
with a Deno pointer-based aligned slice. Linux `O_DIRECT` remains enabled. This
adapter is Linux-only; it does not pretend to implement macOS `F_NOCACHE`.

## Verification boundaries

`tests/runtime.cjs` runs real SDK operations under dnr, with raw/gzip/xz/ZIP/bzip2 and HTTP sources,
two temporary regular-file destinations, verification, actual `O_DIRECT` file
I/O, aligned buffers, FFI errors, and read-only enumeration of real devices.
`native/tests/test-native.c` exercises the native implementation with substituted
kernel/D-Bus boundaries, including busy devices, escaped paths, nested mounts,
system-volume refusal, eject versus power-off, shared readers and error propagation.
`tests/package.mjs` checks format v4, the embedded icon and native declarations,
then runs the SDK/FFI tests from the archive with an isolated cache.
`tests/gui-close.py` checks compositor-initiated close and process cleanup on KDE.

`--smoke` opens a real window and checks renderer readiness, binding calls and
worker startup, then exits. Run separately for `system-cef` and `webview`.
These checks do not substitute for authorizing a disposable physical USB drive
and exercising a real polkit elevation, write, unplug and power-off cycle.
