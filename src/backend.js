// backend.js — owns the dsh host process: locate the launcher (direct
// shim, `pnpm dlx @deepseek-ai/dsh`, or legacy `npx -y @deepseek-ai/dsh`),
// repair PATH (Finder-launched GUI processes lack the shell PATH), spawn
// through the watchdog (which runs the child in its own process group, so
// pnpm/npx → node dsh descendants are reaped together), wait for readiness,
// shut down / restart on demand.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { appInfo, backendLine } = require('./logs')

const READY_URL_RE = /dsh web:\s+(https?:\/\/[^\s)]+)/
const STARTUP_TIMEOUT_MS = 90 * 1000
const POLL_INTERVAL_MS = 400
const PROBE_TIMEOUT_MS = 30000
const DSH_PACKAGE = '@deepseek-ai/dsh'

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
    // Invocation shape: { mode: 'direct'|'pnpm'|'npx', path?: string }
    // mode 'direct' — invoke an existing dsh binary at `path`
    // mode 'pnpm'   — invoke `pnpm dlx @deepseek-ai/dsh …` (no local install)
    // mode 'npx'    — invoke `npx -y @deepseek-ai/dsh …` (legacy no-local-install)
    this.dshInvocation = null
    // Backwards-compatible string pointer (undefined in pnpm/npx mode):
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

  // Spawn a probe for `pnpm dlx @deepseek-ai/dsh --version`. Returns the
  // resolved pnpm binary path when pnpm actually resolved and launched the
  // package; this both validates availability AND warms pnpm's store so the
  // next real backend launch is instant.
  async _probePnpm() {
    const where = await this._runLoginShell('command -v pnpm', 5000)
    if (!where.ok || !where.out.trim()) {
      appInfo('backend: pnpm not found in login PATH')
      return null
    }
    const pnpmPath = where.out.trim().split('\n')[0]
    const env = await this._buildEnv()
    return new Promise((resolve) => {
      let out = ''
      const child = spawn(pnpmPath, ['dlx', DSH_PACKAGE, '--version'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        appInfo('backend: pnpm probe timed out')
        resolve(null)
      }, PROBE_TIMEOUT_MS)
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', () => {})
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const v = out.trim().split('\n').pop() || ''
        const ok = code === 0 && /\d+\.\d+/.test(v)
        if (ok) appInfo(`backend: pnpm probe ok (resolved ${DSH_PACKAGE} → ${v})`)
        else appInfo(`backend: pnpm probe failed (exit=${code}, stderr suppressed)`)
        resolve(ok ? pnpmPath : null)
      })
    })
  }

  // Legacy npx probe (kept so existing `npx` mode and auto-fallback still
  // work after switching to pnpm-first). Returns the npx binary path or null.
  async _probeNpx() {
    const where = await this._runLoginShell('command -v npx', 5000)
    if (!where.ok || !where.out.trim()) {
      appInfo('backend: npx not found in login PATH')
      return null
    }
    const npxPath = where.out.trim().split('\n')[0]
    const env = await this._buildEnv()
    return new Promise((resolve) => {
      let out = ''
      const child = spawn(npxPath, ['-y', DSH_PACKAGE, '--version'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        appInfo('backend: npx probe timed out')
        resolve(null)
      }, PROBE_TIMEOUT_MS)
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', () => {})
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const v = out.trim().split('\n').pop() || ''
        const ok = code === 0 && /\d+\.\d+/.test(v)
        if (ok) appInfo(`backend: npx probe ok (resolved ${DSH_PACKAGE} → ${v})`)
        else appInfo(`backend: npx probe failed (exit=${code}, stderr suppressed)`)
        resolve(ok ? npxPath : null)
      })
    })
  }

  // The user may force direct, pnpm, or legacy npx mode via config (default
  // 'auto'). auto: direct first, then pnpm dlx, then legacy npx.
  async findDshInvocation() {
    const config = this.getConfig()
    const mode = config.dshInvocationMode || 'auto'

    const tryDirect = async () => {
      if (config.dshPath) {
        const p = config.dshPath.replace(/^~/, os.homedir())
        if (fs.existsSync(p)) return p
        appInfo(`backend: configured dshPath missing: ${p}, falling back to auto-detect`)
      }
      const pnpmShim = path.join(os.homedir(), 'Library', 'pnpm', 'dsh')
      if (fs.existsSync(pnpmShim)) return pnpmShim
      const pnpmBinShim = path.join(os.homedir(), 'Library', 'pnpm', 'bin', 'dsh')
      if (fs.existsSync(pnpmBinShim)) return pnpmBinShim
      const r = await this._runLoginShell('command -v dsh', 10000)
      const found = r.ok ? r.out.trim().split('\n')[0] : ''
      return found || null
    }

    if (mode === 'direct' || mode === 'auto') {
      const direct = await tryDirect()
      if (direct) {
        this.dshInvocation = { mode: 'direct', path: direct }
        this.dshPath = direct
        return this.dshInvocation
      }
      if (mode === 'direct') {
        this.dshInvocation = null
        this.dshPath = null
        return null
      }
    }

    if (mode === 'pnpm' || mode === 'auto') {
      const pnpmPath = await this._probePnpm()
      if (pnpmPath) {
        this.dshInvocation = { mode: 'pnpm', path: pnpmPath }
        this.dshPath = null
        return this.dshInvocation
      }
      if (mode === 'pnpm') {
        this.dshInvocation = null
        this.dshPath = null
        return null
      }
    }

    if (mode === 'npx' || mode === 'auto') {
      const npxPath = await this._probeNpx()
      if (npxPath) {
        this.dshInvocation = { mode: 'npx', path: npxPath }
        this.dshPath = null
        return this.dshInvocation
      }
    }

    this.dshInvocation = null
    this.dshPath = null
    return null
  }

  // Backwards-compatible path-only discovery used by older callers.
  async findDsh() {
    const inv = await this.findDshInvocation()
    return inv && inv.mode === 'direct' ? inv.path : null
  }

  // shared spawn environment: login PATH + pnpm bin prepended so the shim's
  // `exec node` resolves even when launched from Finder/Dock; watchdog runs
  // the same Electron binary in plain-Node mode (ELECTRON_RUN_AS_NODE)
  async _buildEnv() {
    const loginPath = await this._getLoginEnv()
    const pnpmRoot = path.join(os.homedir(), 'Library', 'pnpm')
    const pnpmBin = path.join(pnpmRoot, 'bin')
    const env = { ...process.env, PATH: `${pnpmBin}:${pnpmRoot}:${loginPath}`, ELECTRON_RUN_AS_NODE: '1' }
    if (this.getConfig().dshHome) {
      env.DSH_HOME = this.getConfig().dshHome
    }
    return env
  }

  // Run an arbitrary invocation once (used for `--version` and similar dry
  // probes). Returns stdout (trimmed) or null on failure.
  async _runInvocation(extraArgs, { timeoutMs = 30000 } = {}) {
    if (!this.dshInvocation) await this.findDshInvocation()
    if (!this.dshInvocation) return null
    let cmd, args
    if (this.dshInvocation.mode === 'direct') {
      cmd = this.dshInvocation.path
      args = extraArgs
    } else if (this.dshInvocation.mode === 'pnpm') {
      cmd = this.dshInvocation.path || 'pnpm'
      args = ['dlx', DSH_PACKAGE, ...extraArgs]
    } else {
      cmd = this.dshInvocation.path || 'npx'
      args = ['-y', DSH_PACKAGE, ...extraArgs]
    }
    const env = await this._buildEnv()
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        resolve(null)
      }, timeoutMs)
      child.stdout.on('data', (d) => (out += String(d)))
      child.on('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const v = out.trim().split('\n').pop() || ''
        resolve(code === 0 && v ? v : null)
      })
    })
  }

  async getVersion() {
    return this._runInvocation(['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
  }

  // ---------- lifecycle ----------

  async start() {
    if (this.child && this.state !== 'stopped') return { ok: true, url: this.url }
    this._setState('starting')
    this.intentionalStop = false
    this._exitHandled = false

    const inv = await this.findDshInvocation()
    if (!inv) {
      this._setState('not-installed')
      appInfo('backend: dsh launcher not found')
      return { ok: false, reason: 'not-installed' }
    }
    if (inv.mode === 'pnpm') {
      appInfo(`backend: using dsh via pnpm dlx ${DSH_PACKAGE}`)
    } else if (inv.mode === 'npx') {
      appInfo(`backend: using dsh via npx -y ${DSH_PACKAGE}`)
    } else {
      appInfo(`backend: using dsh at ${inv.path}`)
    }

    const env = await this._buildEnv()

    const watchdog = path.join(__dirname, 'watchdog.js')
    let spawnArgs
    if (inv.mode === 'direct') {
      spawnArgs = [watchdog, '--parent', String(process.pid), '--', inv.path, 'web', '--port', '0']
    } else if (inv.mode === 'pnpm') {
      spawnArgs = [
        watchdog,
        '--parent',
        String(process.pid),
        '--',
        inv.path || 'pnpm',
        'dlx',
        DSH_PACKAGE,
        'web',
        '--port',
        '0',
      ]
    } else {
      spawnArgs = [
        watchdog,
        '--parent',
        String(process.pid),
        '--',
        inv.path || 'npx',
        '-y',
        DSH_PACKAGE,
        'web',
        '--port',
        '0',
      ]
    }
    appInfo(`backend: spawning dsh web --port 0 (mode=${inv.mode})`)
    this.child = spawn(process.execPath, spawnArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this._wireStdio(this.child)

    this.child.on('exit', (code, signal) => {
      appInfo(
        `backend: watchdog exited (code=${code ?? 'null'} signal=${signal ?? 'none'}) intentional=${this.intentionalStop}`
      )
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
    appInfo(`backend: stopping (SIGTERM to watchdog${childPid ? ` + child pid ${childPid}` : ''})`)
    // First path: signal the watchdog directly — it kills the entire
    // process group (works for direct + pnpm/npx chains).
    if (child) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
    // Second path: best-effort direct signal to the immediate child. In
    // pnpm/npx mode this is the package-manager wrapper; signal won't
    // propagate to the dsh host there, but the group kill from the watchdog
    // above covers that case independently.
    if (childPid) {
      try {
        process.kill(childPid, 'SIGTERM')
      } catch {}
    }
    if (!child) {
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
