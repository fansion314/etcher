# Etcher → dnr 兼容性评估

> 本文保留首次评估时的结论。后续已实现 Linux x86_64 dnr 移植、FFI
> 原生适配及 AUR 配方；当前实现见 [迁移总结](dnr-migration.md)。

评估日期：2026-09-26。Etcher 2.1.7，提交 `bfcfafd3`；本地 dnr
提交 `3c57cad`；实际加载测试使用 `/usr/bin/dnr` 0.4.0
（Deno 2.9.7、Laufey 0.7.0、format 4、dual backend）。

## 结论

**当前版本不能通过替换打包器或增加 AUR PKGBUILD，直接变成可运行的
`etcher-dnr`。** 需要先移植应用的 Electron 接入层，并解决刷写后端的原生
模块 ABI 问题。dnr 本身具备承载这类应用的基础能力，但当前 Etcher 并未适配。

因此本次不提供声称可用的 `etcher-dnr/PKGBUILD` 或 `.SRCINFO`。
把现有源码塞进 `.dnp` 不会使 Electron API 或旧 Node 原生扩展变得兼容。
迁移后的体积收益尚未测量，不能给出可靠的缩小比例。

另一个概念区别：dnr 静态包含定制 Deno runtime，应用共享安装的 `dnr`
可执行文件；并非再调用 Arch 的独立 `deno` 包。CEF 才是外部系统库。

## 已确认的障碍

| 层次 | 当前 Etcher 的实现 | 对 dnr 的影响 |
| --- | --- | --- |
| 窗口和页面 | `lib/gui/etcher.ts` 启用 `nodeIntegration: true`、关闭 context isolation、启用 Electron `webviewTag` 和 preload | dnr 的 `Deno.BrowserWindow` 与网页绑定不是 Electron 兼容层，不能直接执行该入口 |
| 页面中的系统调用 | `lib/gui/app/modules/api.ts` 直接引入 `child_process`、`os`、Node 版 `ws`，负责提权及启动辅助程序 | 需要将系统能力移至 Deno 后端，通过 `window.bindings` 等明确接口提供给普通网页 |
| Electron API | `@electron/remote`、`ipcRenderer`、文件选择、窗口进度、会话、菜单、外链和更新器 | 需要逐项适配；`safe-webview.tsx` 的 Electron 会话和 webview 也不能原样复用 |
| 刷写辅助程序 | `forge.sidecar.ts` 使用 `pkg --target node20-…` 构建 `etcher-util` | 保留原辅助程序仍会携带 Node runtime，不满足完全共享运行时的目标 |
| 原生扩展 | 锁文件中的 `etcher-sdk@10.0.0` 依赖 `mountutils@2.0.1`；后者使用 NAN 和 `NODE_MODULE` | 当前 dnr 明确拒绝加载该 ABI，见下面的实际测试 |
| 资源及提权 | 当前辅助程序通过 `process.resourcesPath` 定位，Linux 提权流程位于 `lib/shared/sudo/linux.ts` | 必须重新确定 dnr 下的入口、参数、原生资源落盘位置及 root 进程生命周期 |

并非所有原生模块都不兼容。锁文件中的 drivelist、lzma-native、usb 使用
`node-addon-api`，有继续验证的基础；但这不能代替它们在 dnr 上的实际功能测试。
`@ronomon/direct-io`、xxhash-addon 和 SDK 的其余依赖也仍需逐项核验。

## 原生加载测试

从 npm 下载锁定的 `mountutils-2.0.1.tgz`，校验 SHA-512 与
`npm-shrinkwrap.json` 的 integrity 完全一致；未运行安装脚本。

源码包含：

- `src/mountutils.hpp`：`#include <nan.h>`。
- `src/mountutils.cpp`：`NODE_MODULE(MountUtils, MountUtilsInit)`。
- 随包的 `prebuilds/linux-x64/mountutils.node` 引用了 `node_module_register`。

在临时目录使用 CJS 入口直接 `require()` 该原生文件，执行：

```sh
/usr/bin/dnr --no-code-cache --no-transpile-cache /tmp/etcher-dnr-compat/probe.cjs
```

Node `createRequire` 和 `Deno.BrowserWindow` 均存在，但原生加载失败，退出码 1：

```text
it was built against the legacy Node.js native addon API (NODE_MODULE / nan),
which Deno does not support. Only Node-API (N-API) addons are supported.
```

直接加载用于隔离原生 ABI 障碍，不是完整的 mountutils 或 Etcher 功能测试。
本次没有执行真实设备写入、卸载、提权或 GUI 验收。
这也与本地 dnr 所用 Deno 的 `ext/napi/lib.rs` 以及
[Deno 的 Node-API 支持说明](https://docs.deno.com/runtime/fundamentals/node/)
一致。重新打包或仅针对另一个 Node 版本重编译 NAN 扩展不能解决此问题。

## 可实施的迁移路线

1. 保留 Etcher 的 React 界面，将浏览器代码与文件系统、设置、子进程和
   提权逻辑分离；提供 Deno 后端及明确的绑定接口。
2. 适配窗口、对话框、导航、进度和生命周期；软件更新交给 pacman。
   对原有 webview 内容明确是否保留及如何替代，不能静默删掉功能后宣称等价。
3. 将 mountutils 等不兼容依赖移植到 Node-API，或实现经验证的 Linux 替代层。
   验证设备枚举、镜像解析、压缩镜像、写入、校验、取消和弹出。
4. 让辅助程序也由系统 dnr 执行，替换 `pkg` 内嵌 Node 的构建路径；明确
   root 辅助程序的资源位置和通信身份。`.dnp` 中的原生组件需要按 dnr 的
   native groups 声明；外部进程不能直接读取 ZIP 内存 VFS。
5. 完成功能验证后再生成薄应用和 AUR 元数据，测量应用包大小及首次安装
   所需的运行时总大小，分别报告。

一个可降低移植量的折中是让 dnr 承载界面、系统 Node 承载刷写后端。
它可以避免每个应用携带 Node，但仍需移植界面，并新增运行时 `nodejs`
依赖；它与仅依赖 dnr 的目标不同，本次未实现。

## 后续 AUR 依赖设计

迁移完成后，包名可以使用 `etcher-dnr`，运行时依赖可使用 `dnr>=0.4.0`。
本地六种 runtime recipe 中的五种替代包均提供 `dnr=0.4.0`，因此无需枚举
`dnr-bin`、`dnr-cef`、`dnr-cef-bin`、`dnr-webview`、`dnr-webview-bin`，
也不应将这些互斥包全部列为 depends。独立打包器 `dnc` 可作为构建依赖，
`dnc-bin` 已提供对应虚拟包。

“任意一种 dnr”同时包含 WebView-only 变体，因此启动器应使用 auto 或允许
选择后端，而不能强制 `--backend system-cef`。默认 dual 包的 GUI 库是可选
依赖，最终应用的依赖设计还必须确保至少一个 GUI 后端可用；单写 `dnr`
不能保证在干净系统上打开窗口。若最终实现依赖 CEF 专属行为，就不能再
声称兼容所有 dnr 变体。
