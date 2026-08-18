// updater.js — syncs the desktop app with the local dsh (web UI) installation.
// The Electron window loads the page served by the local dsh host, so updating
// the web UI == updating the local dsh install + profile plugins + backend
// restart. Zero repackaging.
const { spawn } = require('node:child_process')
const { dialog } = require('electron')
const { appInfo } = require('./logs')

const HOUR = 3600 * 1000

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?/.exec(String(v ?? '').trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null }
}

// >0 a newer, <0 a older, 0 equal/unknown
function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre > pb.pre ? 1 : -1
}

class Updater {
  constructor({ getConfig, backend, getWindow, openSettings, onBackendRestart, onDone }) {
    this.getConfig = getConfig
    this.backend = backend
    this.getWindow = getWindow
    this.openSettings = openSettings
    this.onBackendRestart = onBackendRestart
    this.onDone = onDone || (() => {})
    this._loginEnv = null
    this._checking = false
    this._applying = false
    this._scheduleTimer = null
    this._logSink = (line) => {}
    this.latestVersion = null
  }

  _runLoginShell(cmd, { timeoutMs = 15 * 60 * 1000, onLine } = {}) {
    return new Promise((resolve) => {
      const child = spawn('/bin/zsh', ['-lic', cmd], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      const onData = (d) => {
        const s = String(d)
        out += s
        for (const line of s.split('\n')) {
          if (line.trim()) {
            try {
              onLine && onLine(line)
            } catch {}
          }
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve({ ok: false, code: -1, out })
      }, timeoutMs)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, code, out })
      })
    })
  }

  setLogSink(fn) {
    this._logSink = fn || (() => {})
  }

  _log(line) {
    appInfo(`update: ${line}`)
    this._logSink(line)
  }

  async _getLoginEnv() {
    if (this._loginEnv) return this._loginEnv
    this._loginEnv = this._runLoginShell('print -r -- "$PATH"', { timeoutMs: 10000 }).then((r) => {
      const p = r.out.trim()
      if (!p) return process.env.PATH || ''
      // prepend pnpm global bin so pnpm/npm resolve reliably
      const os = require('node:os')
      const path = require('node:path')
      return `${path.join(os.homedir(), 'Library', 'pnpm')}:${p}`
    })
    return this._loginEnv
  }

  async _spawnEnv() {
    const loginPath = await this._getLoginEnv()
    return { ...process.env, PATH: loginPath }
  }

  async _getCurrentVersion() {
    return this.backend.getVersion()
  }

  async _getLatestVersion() {
    const env = await this._spawnEnv()
    return new Promise((resolve) => {
      const child = spawn('npm', ['view', '@deepseek-ai/dsh', 'version'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve(null)
      }, 30000)
      child.stdout.on('data', (d) => (out += String(d)))
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const v = out.trim().split('\n')[0]
        resolve(code === 0 && v ? v : null)
      })
    })
  }

  async check({ interactive = false } = {}) {
    if (this._checking) return null
    this._checking = true
    try {
      this.getConfig().patch({ lastUpdateCheckAt: Date.now() })
      const cur = await this._getCurrentVersion()
      const latest = await this._getLatestVersion()
      this.latestVersion = latest
      if (!latest || !cur) {
        if (interactive) {
          dialog.showMessageBox(this.getWindow(), {
            type: 'info',
            title: '检查更新',
            message: '无法获取版本信息',
            detail: !cur ? '无法确定当前 dsh 版本（dsh 未安装或不可用）。' : '网络不可用或 npm 查询失败，请稍后重试。',
            buttons: ['好的'],
          })
        }
        return null
      }
      const cmp = compareVersions(latest, cur)
      appInfo(`update: current=${cur} latest=${latest}`)
      if (cmp <= 0) {
        if (interactive) {
          dialog.showMessageBox(this.getWindow(), {
            type: 'info',
            title: '检查更新',
            message: `已是最新版本（${cur}）`,
            detail: '桌面端加载的就是本机 dsh 服务的页面，本机 dsh 已是当前最新版。',
            buttons: ['好的'],
          })
        }
        return { current: cur, latest, hasUpdate: false }
      }
      const config = this.getConfig()
      if (!interactive && config.lastNotifiedVersion === latest) {
        return { current: cur, latest, hasUpdate: true }
      }
      config.patch({ lastNotifiedVersion: latest })
      const win = this.getWindow()
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: '发现新版本',
        message: `DSH ${cur} → ${latest}`,
        detail: '更新会升级本机 dsh 与 profile 插件并重启后端（会话与设置均保留）。正在进行的任务会中断。',
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) await this.apply({ interactive: true })
      return { current: cur, latest, hasUpdate: true }
    } finally {
      this._checking = false
    }
  }

  async apply({ interactive = false } = {}) {
    if (this._applying) return
    this._applying = true
    const finish = (ok, message) => {
      this._applying = false
      try {
        this.onDone({ ok, message })
      } catch {}
    }
    try {
      const inv = this.backend.dshInvocation || (await this.backend.findDshInvocation())
      if (!inv) {
        dialog.showMessageBox(this.getWindow(), {
          type: 'error',
          title: '更新失败',
          message: '未找到 dsh',
          detail:
            '请先在设置中配置 dsh 路径，或直接调用：`npx -y @deepseek-ai/dsh`。',
          buttons: ['好的'],
        })
        finish(false, '未找到 dsh')
        return
      }
      if (interactive) this.openSettings()
      this._log('开始更新…')

      // 1. upgrade the global dsh install (skipped in npx mode — npx has no
      //    persistent install; the next `npx -y @deepseek-ai/dsh …`
      //    invocation resolves to the latest cached or freshly fetched
      //    version automatically).
      if (inv.mode === 'direct') {
        this._log('步骤 1/3：pnpm add -g @deepseek-ai/dsh@latest …')
        const r1 = await this._runLoginShell('pnpm add -g @deepseek-ai/dsh@latest', {
          onLine: (l) => this._log(`[pnpm] ${l}`),
        })
        if (!r1.ok) {
          this._log('pnpm add -g 失败，尝试 npm install -g …')
          const r1b = await this._runLoginShell('npm install -g @deepseek-ai/dsh@latest', {
            onLine: (l) => this._log(`[npm] ${l}`),
          })
          if (!r1b.ok) {
            this._log('步骤 1 失败，请查看上方日志（可能是网络或权限问题）')
            if (interactive) {
              dialog.showMessageBox(this.getWindow(), {
                type: 'error',
                title: '更新失败',
                message: '升级 dsh 失败',
                detail: 'pnpm 和 npm 均升级失败，请打开日志查看原因。',
                buttons: ['好的'],
              })
            }
            finish(false, '持久安装升级失败')
            return
          }
        }
        this._log('步骤 1/3 完成')
      } else {
        this._log(
          '步骤 1/3：DSH 通过 npx 运行——跳过持久安装；步骤 3 重启后端时 npx 会拉取最新版本。'
        )
      }

      // 2. update web profile plugins (web-ui-all etc.; file: local packages
      //    untouched). Works in both modes — just compose the right command.
      let pluginCmd
      if (inv.mode === 'direct') {
        pluginCmd = `"${inv.path.replace(/"/g, '\\"')}"`
      } else {
        pluginCmd = `"npx" "-y" "@deepseek-ai/dsh"`
      }
      this._log('步骤 2/3：更新 web profile 插件（plugin --profile web update）…')
      const r2 = await this._runLoginShell(`${pluginCmd} plugin --profile web update`, {
        onLine: (l) => this._log(`[plugin] ${l}`),
      })
      if (!r2.ok) this._log('步骤 2/3 未完全成功（不影响主要更新，请检查日志）')
      else this._log('步骤 2/3 完成')

      // 3. restart the backend on the same lifecycle path
      this._log('步骤 3/3：重启后端…')
      await this.onBackendRestart()
      this._log('更新完成 ✓')
      if (interactive) {
        dialog.showMessageBox(this.getWindow(), {
          type: 'info',
          title: '更新完成',
          message: 'DSH Desktop 已更新并重启后端',
          buttons: ['好的'],
        })
      }
      finish(true, '')
    } catch (err) {
      this._log(`更新异常：${err.message}`)
      finish(false, err.message)
    }
  }

  schedule() {
    if (this._scheduleTimer) return
    const run = () => {
      if (this.getConfig().autoUpdateCheck && !this._checking && !this._applying) {
        this.check({ interactive: false }).catch(() => {})
      }
    }
    const t1 = setTimeout(run, 5000)
    const t2 = setInterval(run, 24 * HOUR)
    this._scheduleTimer = { t1, t2 }
  }

  dispose() {
    if (this._scheduleTimer) {
      clearTimeout(this._scheduleTimer.t1)
      clearInterval(this._scheduleTimer.t2)
      this._scheduleTimer = null
    }
  }
}

module.exports = { Updater, compareVersions }
