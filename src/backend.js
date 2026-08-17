// backend.js — owns the dsh host process: locate the launcher, repair PATH
// (Finder-launched GUI processes lack the shell PATH), spawn through the
// watchdog, wait for readiness, and shut down / restart on demand.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { appInfo, backendLine } = require('./logs')

const READY_URL_RE = /dsh web:\s+(https?:\/\/[^\s)]+)/
const STARTUP_TIMEOUT_MS = 90 * 1000
const POLL_INTERVAL_MS = 400

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

class BackendManager {
  constructor(opts = {}) {
    this.onReady = opts.onReady || (() => {})
    this.onExit = opts.onExit || (() => {})
    this.onStateChange = opts.onStateChange || (() => {})
    this.getConfig = opts.getConfig || (() => ({}))
    this.child = null
    this.childPid = null
    this.url = null
    this.port = null
    this.dshPath = null
    this.dshVersion = null
    this.state = 'stopped' // stopped | starting | running | not-installed | error
    this.intentionalStop = false
    this._loginEnv = null
    this._exitHandled = false
    this._setState = (s) => {
      this.state = s
      try {
        this.onStateChange(s)
      } catch {}
    }
  }

  // ---------- environment discovery ----------

  _runLoginShell(cmd, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const child = spawn('/bin/zsh', ['-lic', cmd], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve({ ok: false, out, err: err + '\n(timeout)' })
      }, timeoutMs)
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', (d) => (err += String(d)))
      child.on('exit', () => {
        clearTimeout(timer)
        resolve({ ok: true, out, err })
      })
    })
  }

  async _getLoginEnv() {
    if (this._loginEnv) return this._loginEnv
    this._loginEnv = this._runLoginShell('print -r -- "$PATH"', 10000).then((r) => {
      if (!r.ok) {
        appInfo('backend: login-shell PATH lookup failed, falling back to process PATH')
        return process.env.PATH || ''
      }
      const p = r.out.trim()
      if (!p) return process.env.PATH || ''
      appInfo('backend: login-shell PATH resolved')
      return p
    })
    return this._loginEnv
  }

  async findDsh() {
    const config = this.getConfig()
    if (config.dshPath) {
      const p = config.dshPath.replace(/^~/, os.homedir())
      if (fs.existsSync(p)) {
        this.dshPath = p
        return p
      }
      appInfo(`backend: configured dshPath missing: ${p}, falling back to auto-detect`)
    }
    // 1. the standard pnpm global shim location
    const pnpmShim = path.join(os.homedir(), 'Library', 'pnpm', 'dsh')
    if (fs.existsSync(pnpmShim)) {
      this.dshPath = pnpmShim
      return pnpmShim
    }
    // 2. login-shell lookup (covers homebrew / nvm / custom installs)
    const r = await this._runLoginShell('command -v dsh', 10000)
    const found = r.ok ? r.out.trim().split('\n')[0] : ''
    if (found) {
      this.dshPath = found
      return found
    }
    this.dshPath = null
    return null
  }

  // shared spawn environment: login PATH + pnpm bin prepended so the shim's
  // `exec node` resolves even when launched from Finder/Dock; watchdog runs
  // the same Electron binary in plain-Node mode (ELECTRON_RUN_AS_NODE)
  async _buildEnv() {
    const loginPath = await this._getLoginEnv()
    const pnpmBin = path.join(os.homedir(), 'Library', 'pnpm')
    const env = { ...process.env, PATH: `${pnpmBin}:${loginPath}`, ELECTRON_RUN_AS_NODE: '1' }
    if (this.getConfig().dshHome) {
      env.DSH_HOME = this.getConfig().dshHome
    }
    return env
  }

  async getVersion() {
    if (!this.dshPath) await this.findDsh()
    if (!this.dshPath) return null
    const env = await this._buildEnv()
    return new Promise((resolve) => {
      const child = spawn(this.dshPath, ['--version'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve(null)
      }, 15000)
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

  // ---------- lifecycle ----------

  async start() {
    if (this.child && this.state !== 'stopped') return { ok: true, url: this.url }
    this._setState('starting')
    this.intentionalStop = false
    this._exitHandled = false

    const dshPath = await this.findDsh()
    if (!dshPath) {
      this._setState('not-installed')
      appInfo('backend: dsh launcher not found')
      return { ok: false, reason: 'not-installed' }
    }
    appInfo(`backend: using dsh at ${dshPath}`)

    const env = await this._buildEnv()

    const watchdog = path.join(__dirname, 'watchdog.js')
    const args = [watchdog, '--parent', String(process.pid), '--', dshPath, 'web', '--port', '0']
    appInfo(`backend: spawning ${dshPath} web --port 0`)
    this.child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this._wireStdio(this.child)

    this.child.on('exit', (code, signal) => {
      appInfo(`backend: watchdog exited (code=${code ?? 'null'} signal=${signal ?? 'none'}) intentional=${this.intentionalStop}`)
      this.child = null
      this.childPid = null
      this.url = null
      this.port = null
      if (this._exitHandled || this.intentionalStop) return
      this._exitHandled = true
      this._setState('error')
      try {
        this.onExit({ code, signal })
      } catch {}
    })

    this.dshVersion = await this.getVersion()

    const url = await this._waitForReady(this.child)
    if (!url) {
      if (this.child) {
        this.intentionalStop = true
        try {
          this.child.kill('SIGTERM')
        } catch {}
      }
      this._setState('error')
      return { ok: false, reason: 'timeout' }
    }
    this.url = url
    this.port = Number(new URL(url).port)
    this._setState('running')
    appInfo(`backend: ready at ${url}`)
    return { ok: true, url }
  }

  _wireStdio(child) {
    let buf = ''
    const onChunk = (chunk) => {
      buf += String(chunk)
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const m = /^watchdog: child pid (\d+)$/.exec(line)
        if (m) this.childPid = Number(m[1])
        backendLine(line)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.stdout.on('end', () => {
      if (buf) backendLine(buf)
      buf = ''
    })
    child.stderr.on('end', () => {
      if (buf) backendLine(buf)
      buf = ''
    })
  }

  async _waitForReady(child) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let url = null
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return null
      // scan the log ring for the printed URL
      if (!url) {
        for (const line of require('./logs').backendLog.tail(60)) {
          const m = READY_URL_RE.exec(line)
          if (m) {
            url = m[1]
            break
          }
        }
      }
      if (url && (await httpGet(url))) return url
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    return null
  }

  async stop() {
    if (!this.child && !this.childPid) return
    this.intentionalStop = true
    const child = this.child
    const childPid = this.childPid
    appInfo(`backend: stopping (SIGTERM to watchdog${childPid ? ` + backend pid ${childPid}` : ''})`)
    // Signal the backend directly as well as through the watchdog: whichever
    // channel survives, the backend receives a graceful SIGTERM.
    if (childPid) {
      try {
        process.kill(childPid, 'SIGTERM')
      } catch {}
    }
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
    if (!child) {
      // watchdog already gone (rare): give the directly-signaled backend a
      // short grace, then reap it hard — no orphan may survive a quit
      await new Promise((r) => setTimeout(r, 3000))
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {}
      }
      this.child = null
      this.childPid = null
      this.url = null
      this.port = null
      this._setState('stopped')
      appInfo('backend: stopped')
      return
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {}
        }
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve()
      }, 15000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
    this.childPid = null
    this.url = null
    this.port = null
    this._setState('stopped')
    appInfo('backend: stopped')
  }

  async restart() {
    await this.stop()
    return this.start()
  }
}

module.exports = { BackendManager }
