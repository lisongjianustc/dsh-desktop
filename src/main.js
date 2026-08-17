// main.js — DSH Desktop: Electron launcher shell for the DeepSeek Harness
// web UI. The shell only orchestrates processes and OS integration; every
// feature and plugin is served by the local dsh host (same page as the
// browser UI, zero plugin integration work).
//
// Lifecycle contract (the five user requirements):
//   1. Launching the app auto-starts the backend (no terminal).
//   2. Closing the window asks: quit everything / keep backend running (tray).
//   3. Dock Quit (Cmd+Q) kills everything by default; a real Force Quit is
//      covered by watchdog.js — the backend never outlives this process.
//   4. Minimizing never touches the backend (independent child process).
//   5. Plugins, extension and dev workflow are identical to the web UI.
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, nativeImage, Notification } = require('electron')
const path = require('node:path')

const configModule = require('./config')
const { appInfo, backendLog, getLogsDir } = require('./logs')
const { BackendManager } = require('./backend')
const { Updater } = require('./updater')
const { Notifier } = require('./notifier')

const SMOKE = process.env.DSH_DESKTOP_SMOKE === '1'
const SMOKE_TIMEOUT_MS = 150 * 1000

app.setName('DSH Desktop')

// isolate config/logs/singleton-lock for tests (absent in normal launches)
if (process.env.DSH_DESKTOP_USERDATA) {
  app.setPath('userData', process.env.DSH_DESKTOP_USERDATA)
}

if (!app.requestSingleInstanceLock()) {
  // Another instance is already running — hand off and exit.
  app.quit()
} else {
  boot()
}

function boot() {
  let quitting = false
  let mainWindow = null
  let settingsWindow = null
  let tray = null
  let backend = null
  let updater = null
  let notifier = null
  let config = null

  const statusPage = (mode) => path.join(__dirname, 'status.html')
  const loadStatus = (win, mode) => win.loadFile(statusPage(mode), { query: { mode } })

  // ---------- window management ----------

  function createMainWindow() {
    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 600,
      title: 'DSH Desktop',
      show: !SMOKE,
      backgroundColor: '#0b0f1a',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.loadFile(statusPage('starting'), { query: { mode: 'starting' } })

    win.on('close', (e) => {
      if (quitting) return
      // window already hidden to the tray — a trailing close must not reopen it
      if (!win.isVisible()) {
        e.preventDefault()
        return
      }
      // macOS: a synchronous dialog inside the close event deadlocks the
      // window-close tracking session (dialog shows, but selecting a button
      // never lets the window close/quit). Use an async dialog exactly once.
      if (win._closePromptOpen) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      win._closePromptOpen = true
      const applyIntent = (intent) => {
        win._closePromptOpen = false
        if (intent === 'quit') {
          quitting = true
          app.quit()
        } else if (intent === 'background') {
          hideToTray(win)
        }
        // 'cancel' (Esc / 取消) just leaves the window open
      }
      if (config.closeBehavior === 'background') {
        applyIntent('background')
        return
      }
      if (config.closeBehavior === 'quit') {
        applyIntent('quit')
        return
      }
      dialog
        .showMessageBox(win, {
          type: 'question',
          title: 'DSH Desktop',
          message: '关闭窗口后要做什么？',
          detail:
            '· 结束所有进程并退出：关闭后端与所有正在执行的任务。\n' +
            '· 保持后端后台运行：窗口关闭，后端与任务继续，可从菜单栏鲸鱼图标重新打开。\n' +
            '（Dock 退出 / Cmd+Q 始终会结束所有进程）',
          buttons: ['结束所有进程并退出', '保持后端后台运行', '取消'],
          defaultId: 1,
          cancelId: 2,
          noLink: true,
        })
        .then(({ response }) => {
          if (response === 0) applyIntent('quit')
          else if (response === 1) applyIntent('background')
          else applyIntent('cancel')
        })
        .catch(() => applyIntent('cancel'))
    })

    win.on('minimize', () => {
      if (config.minimizeToTray) {
        win.hide()
        if (app.dock) app.dock.hide()
      }
    })

    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null
    })

    // external links open in the system browser; navigation is pinned to the
    // backend origin (loopback trust fence must stay intact)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      const allowed = backend && backend.url && new URL(url).origin === new URL(backend.url).origin
      if (!allowed) {
        e.preventDefault()
        if (/^https?:/i.test(url)) shell.openExternal(url)
      }
    })

    mainWindow = win
    return win
  }

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow()
      if (backend && backend.state === 'running' && backend.url) {
        mainWindow.loadURL(backend.url)
      }
    }
    if (app.dock) app.dock.show()
    mainWindow.show()
    mainWindow.focus()
  }

  function hideToTray(win) {
    win.hide()
    if (app.dock) app.dock.hide()
    if (!config.noticeBackgroundShown) {
      configModule.patch({ noticeBackgroundShown: true })
      try {
        new Notification({
          title: 'DSH Desktop 仍在后台运行',
          body: '后端与正在执行的任务保持运行。点击菜单栏的鲸鱼图标可重新打开窗口。',
        }).show()
      } catch {}
    }
  }

  function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show()
      settingsWindow.focus()
      return settingsWindow
    }
    const win = new BrowserWindow({
      width: 640,
      height: 720,
      title: 'DSH Desktop 设置',
      resizable: true,
      backgroundColor: '#0b0f1a',
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.loadFile(path.join(__dirname, 'settings.html'))
    win.on('closed', () => {
      if (settingsWindow === win) settingsWindow = null
    })
    settingsWindow = win
    return win
  }

  // ---------- tray ----------

  function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'trayTemplate.png')
    let icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate@2x.png'))
    }
    icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('DSH Desktop')
    const menu = Menu.buildFromTemplate([
      { label: '打开 DSH Desktop', click: () => showMainWindow() },
      { label: '设置…', click: () => createSettingsWindow() },
      { label: '检查 Web 更新…', click: () => updater.check({ interactive: true }) },
      { type: 'separator' },
      { label: '打开日志目录', click: () => shell.openPath(getLogsDir()) },
      { type: 'separator' },
      {
        label: '退出（结束所有进程）',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ])
    tray.setContextMenu(menu)
    tray.on('click', () => showMainWindow())
  }

  function createAppMenu() {
    const template = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: '设置…',
            accelerator: 'Cmd+,',
            click: () => createSettingsWindow(),
          },
          { label: '检查 Web 更新…', click: () => updater.check({ interactive: true }) },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: '退出 DSH Desktop（结束所有进程）', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit() } },
        ],
      },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
      {
        label: '帮助',
        submenu: [
          { label: '打开日志目录', click: () => shell.openPath(getLogsDir()) },
          { label: 'DeepSeek Harness（GitHub）', click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
        ],
      },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  // ---------- backend flow ----------

  async function startBackend() {
    const res = await backend.start()
    if (res.ok) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(res.url)
      } else {
        showMainWindow()
      }
      app.setAboutPanelOptions({
        applicationName: 'DSH Desktop',
        applicationVersion: app.getVersion(),
        version: `后端 dsh ${backend.dshVersion || '未知'}`,
        copyright: 'DeepSeek Harness 桌面壳 · 仅本机使用',
      })
      return
    }
    const mode = res.reason === 'not-installed' ? 'notinstalled' : 'crashed'
    if (mainWindow && !mainWindow.isDestroyed()) {
      loadStatus(mainWindow, mode)
    } else {
      showMainWindow()
      loadStatus(mainWindow, mode)
    }
  }

  async function restartBackendFlow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      loadStatus(mainWindow, 'starting')
    }
    await startBackend()
  }

  function onBackendExit() {
    if (quitting) return
    appInfo('backend exited unexpectedly')
    if (mainWindow && !mainWindow.isDestroyed()) {
      loadStatus(mainWindow, 'crashed')
      if (!mainWindow.isVisible()) showMainWindow()
    } else {
      showMainWindow()
      loadStatus(mainWindow, 'crashed')
    }
  }

  // ---------- smoke test harness ----------

  function armSmoke() {
    if (!SMOKE) return
    let done = false
    const finish = async (ok, detail) => {
      if (done) return
      done = true
      console.log(`${ok ? 'SMOKE OK' : 'SMOKE FAIL'} ${detail}`)
      // smoke exits through the same graceful path as a real quit: stop the
      // backend explicitly, then leave (also verifies no orphans in smoke)
      try {
        await backend.stop()
      } catch {}
      setTimeout(() => app.exit(ok ? 0 : 1), 300)
    }
    const hard = setTimeout(() => finish(false, 'hard-timeout'), SMOKE_TIMEOUT_MS)
    hard.unref()
    const prevStateChange = backend.onStateChange
    backend.onStateChange = (state) => {
      try {
        prevStateChange(state)
      } catch {}
      if (state === 'error' || state === 'not-installed') finish(false, `backend-state=${state}`)
    }

    const checkLoaded = () => {
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      if (!backend || backend.state !== 'running' || !backend.url) return
      win.webContents
        .executeJavaScript(
          `(typeof window.__DSH_BOOT__ !== 'undefined') ? { boot: true, entries: (window.__DSH_BOOT__.entries||[]).map(e => e.id) } : { boot: false }`,
          true
        )
        .then((r) => {
          if (r && r.boot) {
            const hasPlugins = r.entries.some((id) => String(id).includes('linxin666'))
            const hasViz = r.entries.some((id) => String(id).includes('dsh-viz') || String(id).includes('viz'))
            finish(true, `url=${backend.url} boot=yes entries=${r.entries.length} webui=${hasPlugins} viz=${hasViz}`)
          } else {
            finish(false, 'boot-manifest-missing')
          }
        })
        .catch(() => {})
    }

    const iv = setInterval(checkLoaded, 2000)
    iv.unref()
  }

  // ---------- IPC ----------

  function isOurSender(event) {
    const s = event.sender
    return (
      (mainWindow && !mainWindow.isDestroyed() && s === mainWindow.webContents) ||
      (settingsWindow && !settingsWindow.isDestroyed() && s === settingsWindow.webContents)
    )
  }

  function registerIpc() {
    ipcMain.handle('config:get', (e) => (isOurSender(e) ? config : null))
    ipcMain.handle('config:patch', (e, patch) => {
      if (!isOurSender(e) || typeof patch !== 'object' || !patch) return null
      return configModule.patch(patch)
    })
    ipcMain.handle('backend:info', (e) =>
      isOurSender(e)
        ? { state: backend.state, url: backend.url, version: backend.dshVersion, path: backend.dshPath }
        : null
    )
    ipcMain.handle('backend:restart', async (e) => {
      if (!isOurSender(e)) return null
      await restartBackendFlow()
      return { ok: backend.state === 'running' }
    })
    ipcMain.handle('logs:tail', (e, which) => {
      if (!isOurSender(e)) return []
      return which === 'app' ? require('./logs').appLog.tail(300) : backendLog.tail(300)
    })
    ipcMain.handle('logs:open', (e) => {
      if (!isOurSender(e)) return
      shell.openPath(getLogsDir())
    })
    ipcMain.handle('settings:open', (e) => {
      if (!isOurSender(e)) return
      createSettingsWindow()
    })
    ipcMain.handle('app:quit', (e) => {
      if (!isOurSender(e)) return
      quitting = true
      app.quit()
    })
    ipcMain.handle('update:check', async (e) => {
      if (!isOurSender(e)) return null
      return updater.check({ interactive: false })
    })
    ipcMain.handle('update:apply', async (e) => {
      if (!isOurSender(e)) return
      updater.apply({ interactive: false })
    })
  }

  // ---------- existing instance detection ----------

  function probeHost(port) {
    return new Promise((resolve) => {
      const req = require('node:http').get(
        { host: '127.0.0.1', port, path: '/', timeout: 2500 },
        (res) => {
          let body = ''
          res.on('data', (d) => {
            body += String(d)
            if (body.length > 8192) {
              req.destroy()
              resolve(body.includes('__DSH_BOOT__'))
            }
          })
          res.on('end', () => resolve(res.statusCode === 200 && body.includes('__DSH_BOOT__')))
        }
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  async function warnIfExistingHost() {
    if (SMOKE) return true
    const found = await probeHost(3080)
    if (!found) return true
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '检测到另一个 DSH 实例',
      message: '检测到已有 DSH 正在运行（http://127.0.0.1:3080）。',
      detail:
        '桌面端将启动独立实例（随机端口），但两个实例共享 ~/.dsh 的会话与设置，同时运行可能互相覆盖配置。\n' +
        '建议先在终端里关闭已有的 dsh（Ctrl+C），再继续。',
      buttons: ['继续启动桌面实例', '取消并退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 1) {
      app.quit()
      return false
    }
    return true
  }

  // ---------- app lifecycle ----------

  app.on('second-instance', () => {
    showMainWindow()
  })

  app.on('activate', () => {
    showMainWindow()
  })

  app.on('window-all-closed', () => {
    // stay resident in the menu bar (macOS convention); quitting is driven
    // by the tray / Cmd+Q paths only
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    // Graceful SIGTERM to the backend. Even if this process is killed hard
    // (Force Quit), watchdog.js reaps the backend — no orphans, ever.
    if (notifier) notifier.disconnect()
    if (backend) backend.stop().catch(() => {})
    if (updater) updater.dispose()
  })

  app.whenReady().then(async () => {
    config = configModule.load()
    backend = new BackendManager({
      getConfig: () => config,
      onStateChange: (state) => {
        if (!notifier) return
        if (state === 'running' && backend.url) notifier.connect(backend.url)
        else if (state !== 'starting') notifier.disconnect()
      },
      onExit: onBackendExit,
    })
    notifier = new Notifier({
      getConfig: () => config,
      getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      onActivate: () => showMainWindow(),
      present: (title, body) => {
        try {
          const n = new Notification({ title, body, silent: false })
          n.on('click', () => showMainWindow())
          n.show()
        } catch (err) {
          appInfo(`notifier: Notification failed: ${err.message}`)
        }
      },
    })
    updater = new Updater({
      getConfig: () => config,
      backend,
      getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
      openSettings: () => createSettingsWindow(),
      onBackendRestart: () => restartBackendFlow(),
      onDone: (r) => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send('update:done', r)
        }
      },
    })
    updater.setLogSink((line) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('update:log', line)
      }
    })

    createTray()
    createAppMenu()
    registerIpc()
    createMainWindow()
    armSmoke()

    appInfo(`starting DSH Desktop v${app.getVersion()}`)

    if (!(await warnIfExistingHost())) return
    await startBackend()

    if (!SMOKE) {
      updater.schedule()
    }
  })
}
