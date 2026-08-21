# DSH Desktop

DeepSeek Harness（DSH）的 macOS 桌面壳：双击即自动启动 dsh 后端，无需终端。窗口加载的就是本机 dsh 服务的页面，因此**功能、插件、会话与浏览器版 100% 一致**，插件开发（dev:web HMR）与插拔（`dsh plugin add/remove`）工作流原样保留。

## 行为约定

| 操作 | 行为 |
|---|---|
| 打开 App | 自动定位 dsh（**启动方式**设置 → 默认 `auto`，见下）→ 自动端口 → 启动后端 → 打开窗口 |
| 关闭窗口 | 弹窗三选：结束所有进程并退出 / 保持后端后台运行（驻留托盘）/ 取消（可在设置中改为固定行为） |
| Dock 退出 / Cmd+Q | 默认结束所有进程（不弹窗） |
| Dock 强制退出（Force Quit / kill） | 无法拦截，但 `watchdog.js` 会在父进程消失后自动回收后端，**绝不遗留孤儿进程** |
| 最小化 | 后端不受影响（独立子进程）；可选"最小化到托盘" |
| 审批 / 提问 | 壳直连后端 `/api/events.mux` 事件流，`approval/requested` / `question/requested` 到达时发系统通知，点击回到窗口；默认仅窗口不可见时通知（设置可调：总是 / 关闭） |
| 后端崩溃 | 内置错误页：最近日志 + 重启后端 |
| 更新 | 启动时 + 每 24h 自动检查；一键更新 = 升级本机 dsh + web profile 插件 + 重启后端（桌面端零重新打包） |

## 后端启动方式

打开 App 时，桌面壳按下面的顺序发现 dsh（设置 → 后端 → 启动方式，可强制覆盖）：

| 方式 | 探测路径 | 触发命令 |
|---|---|---|
| `auto`（默认） | 直接路径（config.dshPath → `~/Library/pnpm/dsh` → `~/Library/pnpm/bin/dsh` → 登录 shell `command -v dsh`）→ pnpm dlx 探测 → 旧 npx 探测 | 直接命中时：`dshPath web --port 0`；都没命中时：`pnpm dlx @deepseek-ai/dsh web --port 0`，再回退 `npx -y @deepseek-ai/dsh web --port 0` |
| `direct` | 仅上述直接路径；都失败则报"未找到 dsh" | `dshPath web --port 0` |
| `pnpm`   | 直接跳过；只走 pnpm 探测（`pnpm dlx @deepseek-ai/dsh --version` 在 30s 内有版本输出即视为可用） | `pnpm dlx @deepseek-ai/dsh web --port 0` |
| `npx`    | 兼容旧配置；只走 npx 探测 | `npx -y @deepseek-ai/dsh web --port 0` |

**pnpm 模式适合已经把 dsh 改成 `pnpm dlx @deepseek-ai/dsh` 启动的用户**：无需本机安装 dsh，pnpm 自动解析并下载对应版本；后端更新也由"重启 App"触发（pnpm 会在下次启动时拉到最新版），原"持久安装步骤"自动跳过，profile 插件更新照常运行。旧 `npx` 模式仍保留作为兼容。

后端由 `watchdog.js` 拉起，子进程以 `detached: true` 创建**新进程组**，全部信号通过 `process.kill(-pid, sig)` 作用到整个组——pnpm/npx 模式下能确保 `pnpm/npx → node dsh` 整个子孙链一并被回收，无孤儿子进程。

## 开发

```sh
pnpm install --store-dir .store          # 依赖（本地 store）
pnpm start                               # 开发运行
DSH_HOME=<隔离目录> DSH_DESKTOP_SMOKE=1 pnpm start   # 无窗口冒烟测试
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron test/test-notifier.cjs       # 通知模块单元测试
bash test/watchdog-group-kill.sh                                                            # watchdog 组杀测试（验证 pnpm/npx 链式派生的无孤儿保证）
pnpm dist                                # 打包 dmg/zip（electron-builder）
```

冒烟测试约定：`DSH_DESKTOP_SMOKE=1` 时窗口隐藏，页面加载成功并探测到 `__DSH_BOOT__`（含插件条目）后打印 `SMOKE OK` 并以 0 退出；失败打印 `SMOKE FAIL` 并退出非 0。`DSH_DESKTOP_USERDATA=<目录>` 可将配置/日志/单实例锁隔离到指定目录，便于与运行中的实例并行测试。

## 结构

```
src/main.js        Electron 主进程：窗口/托盘/菜单/关窗弹窗/最小化/IPC
src/backend.js     后端进程管理：findDshInvocation（direct/pnpm/npx）、登录 shell PATH 修复、spawn、就绪探测、重启
src/watchdog.js    防孤儿守护：子进程以 detached 进程组形式拉起，process.kill(-pid) 信号整个组；父进程失联即回收后端
src/notifier.js    审批/提问系统通知：直连 /api/events.mux 事件流、去重、断线重连
src/updater.js     更新：pnpm/npm 版本比对、dsh 持久安装升级（dlx 模式跳过）、profile 插件更新、后端重启
src/status.html    启动中/崩溃/未安装 状态页（内置，loadFile 加载）
src/settings.html  设置页：窗口行为/通知/后端/更新/日志
test/test-notifier.cjs           通知模块端到端测试（依赖零的伪 WS 服务器）
test/watchdog-group-kill.sh      watchdog 进程组杀测试（验证父进程失联后整个子孙链被回收）
scripts/                          图标渲染与像素校验（Chromium 光栅化，无外部依赖）
build/                            鲸鱼 SVG、icon.icns、图标构建资源
```

## 实现要点

- **dsh 启动方式（direct / pnpm / npx）**：`findDshInvocation()` 先按 `config.dshPath → ~/Library/pnpm/dsh → ~/Library/pnpm/bin/dsh → 登录 shell command -v dsh` 尝试直接路径；都没命中时通过 `pnpm dlx @deepseek-ai/dsh --version` 探测 pnpm 可用性（再兼容旧 npx），按可用模式加载后端。settings 里可强制 `direct` / `pnpm` / `npx` / `auto`。
- **更新同步**：窗口 `loadURL(http://127.0.0.1:<port>)`，升级本机 dsh 即完成桌面端同步，壳零重打包。pnpm/npx 模式下跳过持久安装步骤，重启 App 时对应 dlx 命令拉取最新版本；profile 插件更新照常运行。
- **无孤儿保证**：后端由 watchdog 子进程持有，且后端 PID 经 stdout 上报给主进程；Electron 退出时**双通道 SIGTERM**（直接信号后端 + 经 watchdog 转发）。watchdog 使用 `detached: true` 创建新进程组，**所有信号通过 `process.kill(-pid, sig)` 作用于整个组**——pnpm/npx 模式下 `pnpm/npx → node dsh` 整个子孙链一并被回收，无孤儿子进程。被强杀时 watchdog 以 2s 轮询检测父进程失联并在宽限后 SIGKILL 整个组。
- **通知通道**：主进程用自己的 WebSocket 直连后端 mux 事件流（与页面同一传输），按 `approval/requested`/`question/requested` 帧发系统通知；pending 集合去重（重连重放不重复提醒），resolved 后允许再次提醒，断线指数退避重连。
- **GUI PATH 修复**：Finder 启动的 GUI 进程无 shell PATH，启动时经 `zsh -lic` 获取用户登录 PATH 注入 spawn 环境（pnpm bin 前置）。
- **就绪契约**：解析 stdout 的 `dsh web: http://…` 行 + 轮询 `GET /`（对上游依赖极薄，抗版本漂移）。
- **安全**：`webSecurity` 保持默认；主窗口无 preload、contextIsolation 开启；外链一律交给系统浏览器；内置页面使用白名单 IPC。
- **隔离测试**：开发期用临时 `DSH_HOME`（复制 web profile 的 package.json/cordis.patch.yml + 软链 node_modules）跑全链路，不影响正在运行的实例。
