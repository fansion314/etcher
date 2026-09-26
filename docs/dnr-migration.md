# Electron → dnr：Etcher 实验记录

以 Etcher 2.1.7 为基础，新增独立 Linux x86_64 `dnr/` 构建目标，保留原
Electron 构建。前端使用 Node、pnpm、稳定版 Vite+ 0.3.3，运行时使用系统
dnr 和共享图形库。构建与安装命令见 [dnr/README.md](../dnr/README.md)。

| 原有职责 | dnr 适配 |
| --- | --- |
| Electron 主进程与窗口 | Deno 后端及 `Deno.BrowserWindow` |
| Node-enabled renderer、remote、IPC | 普通网页与明确的异步 bindings；只适配应用实际需要的接口 |
| 文件、设置、进程操作 | 移至 Deno 后端，设置原子写入独立配置目录 |
| 原生文件选择 | 系统 Zenity 对话框 |
| Electron File.path | 选择文件返回真实路径；拖入的浏览器 File 流式写入临时文件 |
| 窗口进度、通知 | 标题、dnr dock badge、系统通知 |
| 内嵌 Node 的 pkg 辅助程序 | 系统 dnr 的独立 worker，私有 stdin/stdout 协议 |
| 提权与刷写 | pkexec 参数数组启动 worker，保留 SDK 解压、写入和校验 |
| NAN mountutils | 小型 C ABI 动态库，Deno FFI 非阻塞调用 |
| direct-io | 使用 Deno 指针创建对齐切片，保留 Linux O_DIRECT |
| Node-API 模块 | 保留 drivelist、usb、lzma-native、xxhash-addon，声明原生组 |
| Electron webview/session | 远程推广内容改为系统浏览器链接 |
| 自动更新 | pacman 管理 |
| 应用图标 | v4 元数据嵌入 128×128 RGBA 图标，另装桌面图标 |

这不是通用 Electron 兼容层。核心工作是分离浏览器和本机能力，把同步或
隐式调用改为异步协议，并处理不同的窗口生命周期和原生 ABI。

新的卸载实现通过设备号和 sysfs 精确识别分区，用 libmount 解析挂载关系。
它拒绝系统文件系统、活动映射设备及 EBUSY，不再退化为 lazy/force 卸载。
eject 真正调用 UDisks2 的 Eject 或 PowerOff，并拒绝会波及读卡器其他磁盘
的断电。刷写同步、校验、关闭文件后才执行弹出；弹出失败会单独提示。

包名为 `etcher-dnr`。自包含 AUR 配方使用固定上游提交、带校验和的适配
源码归档和独立锁文件，不依赖 `../dnr`。`dnr>=0.4.0` 可由六种 dnr 包
满足。配方依赖共享 CEF/GTK3，启动器支持 auto 和显式 WebView；WebView-only
运行时还会带入自己的系统库，此时 CEF 不参与运行。

v4 `.dnp` 约 23 MB，不携带 Electron、Node、Deno、CEF 运行时。首次安装的
总占用还包括共享库和原生组，不能把该数字当作总磁盘占用。图标元数据已经
确认：formatVersion=4，128×128 RGBA，65536 字节。

ZIP VFS 不是 OS 挂载：worker 必须重新启动同一个 `.dnp` 并切换入口。
AUR 预安装原生组，并禁止 makepkg 后处理修改已经写入校验摘要的内容。

已执行验证：

- 实际对齐缓冲区、O_DIRECT 普通文件写入、fsync 和读取。
- raw、gzip、xz、ZIP、bzip2 双目标临时文件写入和回读校验。
- HTTP Range 镜像写入、校验，以及故意破坏回读数据后的失败检测。
- FFI 加载和错误传播，真实设备只读枚举。
- 从真实 v4 包运行 SDK/FFI 自测，并检查嵌入图标与原生组元数据。
- CEF 和 WebView 的真实窗口、bindings、worker 启动。
- 两个后端经 KDE compositor 原生关闭窗口后，GUI 和 worker 全部退出。
- 自包含 AUR 配方实际 makepkg 构建。

C 测试还以受控系统调用／D-Bus 替身验证嵌套挂载、转义路径、EBUSY、系统
卷拒绝、弹出／断电选择、共享读卡器保护及错误传播；这些不代替实盘测试。

尚未指定可清空的物理测试盘，因此真实 USB 写入、polkit 刷写认证、热拔插
和硬件弹出／断电仍需最终验收。Etcher Pro LED/USB boot 硬件未验收；
Windows/macOS 不在本实现范围内。自动 GUI 检查也不代表所有交互均已人工验收。

dnr 原生关窗事件不可取消：写入时关窗会保留后台 worker 并在完成时通知。
普通取消按钮仍能终止写入。窗口进度、远程页面隔离、对话框与生命周期的
这些差异必须在其他 Electron 应用的移植中逐项判断。
