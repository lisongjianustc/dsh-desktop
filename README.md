# DSH Desktop

DeepSeek Harness（DSH）的 macOS 桌面壳：双击即自动启动 dsh 后端，无需终端。窗口加载的就是本机 dsh 服务的页面，因此**功能、插件、会话与浏览器版 100% 一致**，插件开发（dev:web HMR）与插拔（`dsh plugin add/remove`）工作流原样保留。

## 行为约定

| 操作 | 行为 |
|---|---|
| 打开 App | 自动定位 dsh（config → `~/Library/pnpm/dsh` → 登录 shell）→ 自动端口 → 启动后端 → 打开窗口 |
| 关闭窗口 | 弹窗三选：结束所有进程并退出 / 保持后端后台运行（驻留托盘）/ 取消（可在设置中改为固定行为） |
| Dock 退出 / Cmd+Q | 默认结束所有进程（不弹窗） |
| Dock 强制退出（Force Quit / kill） | 无法拦截，但 `watchdog.js` 会在父进程消失后自动回收后端，**绝不遗留孤儿进程** |
| 最小化 | 后端不受影响（独立子进程）；可选"最小化到托盘" |
| 审批 / 提问 | 壳直连后端 `/api/events.mux` 事件流，`approval/requested` / `question/requested` 到达时发系统通知，点击回到窗口；默认仅窗口不可见时通知（设置可调：总是 / 关闭） |
| 后端崩溃 | 内置错误页：最近日志 + 重启后端 |
| 更新 | 启动时 + 每 24h 自动检查；一键更新 = 升级本机 dsh + web profile 插件 + 重启后端（桌面端零重新打包） |

## 开发

```sh
pnpm install --store-dir .store          # 依赖（本地 store）
pnpm start                               # 开发运行
DSH_HOME=<隔离目录> DSH_DESKTOP_SMOKE=1 pnpm start   # 无窗口冒烟测试
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/test-notifier.cjs  # 通知模块测试
pnpm dist                                # 打包 dmg/zip（electron-builder）
```

冒烟测试约定：`DSH_DESKTOP_SMOKE=1` 时窗口隐藏，页面加载成功并探测到 `__DSH_BOOT__`（含插件条目）后打印 `SMOKE OK` 并以 0 退出；失败打印 `SMOKE FAIL` 并退出非 0。`DSH_DESKTOP_USERDATA=<目录>` 可将配置/日志/单实例锁隔离到指定目录，便于与运行中的实例并行测试。

## 结构

```
src/main.js        Electron 主进程：窗口/托盘/菜单/关窗弹窗/最小化/IPC
src/backend.js     后端进程管理：dsh 定位、登录 shell PATH 修复、spawn、就绪探测、重启
src/watchdog.js    防孤儿守护（子进程）：父进程失联即回收后端；转发信号并超时升级 SIGKILL
src/notifier.js    审批/提问系统通知：直连 /api/events.mux 事件流、去重、断线重连
src/updater.js     更新：npm 版本比对、pnpm 全局升级、profile 插件更新、后端重启
src/status.html    启动中/崩溃/未安装 状态页（内置，loadFile 加载）
src/settings.html  设置页：窗口行为/通知/后端/更新/日志
test/              通知模块端到端测试（依赖零的伪 WS 服务器）
scripts/           图标渲染与像素校验（Chromium 光栅化，无外部依赖）
build/             鲸鱼 SVG、icon.icns、图标构建资源
```

## 实现要点

- **更新同步**：窗口 `loadURL(http://127.0.0.1:<port>)`，升级本机 dsh 即完成桌面端同步，壳零重打包。
- **无孤儿保证**：后端由 watchdog 子进程持有，且后端 PID 经 stdout 上报给主进程；Electron 退出时**双通道 SIGTERM**（直接信号后端 + 经 watchdog 转发），被强杀时 watchdog 以 2s 轮询检测父进程失联并在宽限后 SIGKILL 后端。
- **通知通道**：主进程用自己的 WebSocket 直连后端 mux 事件流（与页面同一传输），按 `approval/requested`/`question/requested` 帧发系统通知；pending 集合去重（重连重放不重复提醒），resolved 后允许再次提醒，断线指数退避重连。
- **GUI PATH 修复**：Finder 启动的 GUI 进程无 shell PATH，启动时经 `zsh -lic` 获取用户登录 PATH 注入 spawn 环境（pnpm bin 前置）。
- **就绪契约**：解析 stdout 的 `dsh web: http://…` 行 + 轮询 `GET /`（对上游依赖极薄，抗版本漂移）。
- **安全**：`webSecurity` 保持默认；主窗口无 preload、contextIsolation 开启；外链一律交给系统浏览器；内置页面使用白名单 IPC。
- **隔离测试**：开发期用临时 `DSH_HOME`（复制 web profile 的 package.json/cordis.patch.yml + 软链 node_modules）跑全链路，不影响正在运行的实例。
