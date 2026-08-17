// notifier.js — approval / question system notifications.
//
// The desktop shell opens its own downstream connection to the backend's
// mux event stream (/api/events.mux over WebSocket, the same transport the
// page uses) and turns `approval/requested` / `question/requested` frames
// into macOS notifications. When the window is hidden (tray mode), clicking
// the notification brings it back. Dedupe keeps reconnect replays from
// re-notifying the same pending request.
const { appInfo } = require('./logs')

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const NOTIFY_TTL_MS = 60 * 1000

class Notifier {
  constructor(opts = {}) {
    this.getConfig = opts.getConfig || (() => ({}))
    // injectable present(title, body) — the app wires the real Notification;
    // tests inject a recorder
    this.present = opts.present || (() => {})
    this.onActivate = opts.onActivate || (() => {})
    this.url = null
    this.ws = null
    this.backoff = RECONNECT_BASE_MS
    this._pending = new Map() // key -> last-notified timestamp
    this._closedByUs = false
    this._reconnectTimer = null
  }

  // mode: 'hidden' (default) | 'always' | 'off'
  _shouldNotify() {
    const mode = this.getConfig().notifyMode ?? 'hidden'
    if (mode === 'off') return false
    if (mode === 'always') return true
    // 'hidden': notify when the main window is not visible or not focused
    const win = this.getWindow ? this.getWindow() : null
    if (!win || win.isDestroyed()) return true
    return !win.isVisible() || !win.isFocused()
  }

  connect(url) {
    if (!url) return
    this.disconnect()
    this.url = url
    this._open()
  }

  disconnect() {
    this.url = null
    this._closedByUs = true
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
  }

  _open() {
    if (!this.url) return
    this._closedByUs = false
    const wsUrl = this.url.replace(/^http/, 'ws') + '/api/events.mux'
    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      appInfo(`notifier: WebSocket unavailable (${err.message})`)
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.backoff = RECONNECT_BASE_MS
      appInfo(`notifier: connected ${wsUrl}`)
    })
    ws.addEventListener('message', (event) => {
      this._onMessage(String(event.data))
    })
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      if (this._closedByUs || !this.url) return
      appInfo(`notifier: stream closed, reconnecting in ${this.backoff}ms`)
      this._reconnectTimer = setTimeout(() => this._open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS)
    })
    ws.addEventListener('error', () => {
      // the close handler owns the reconnect path
    })
  }

  _onMessage(raw) {
    let envelope
    try {
      envelope = JSON.parse(raw)
    } catch {
      return
    }
    const payload = envelope && envelope.payload
    if (!payload || typeof payload.type !== 'string') return
    switch (payload.type) {
      case 'approval/requested': {
        const key = `a:${payload.sessionId}:${payload.approvalId}`
        if (this._isFresh(key)) return
        const title = `审批请求：${payload.toolName || '工具'}`
        const body = (payload.reason || `工具 ${payload.toolName || ''} 请求批准执行`).slice(0, 140)
        this._emit(key, title, body)
        break
      }
      case 'question/requested': {
        const questions = Array.isArray(payload.questions) ? payload.questions : []
        const first = questions[0] || {}
        const key = `q:${payload.sessionId}:${first.header || ''}:${first.detail || ''}`
        if (this._isFresh(key)) return
        const title = first.header || 'DSH 向你提问'
        const body = (first.detail || (questions.length > 1 ? `${questions.length} 个问题待回答` : '点击打开 DSH Desktop 查看并回答')).slice(0, 140)
        this._emit(key, title, body)
        break
      }
      case 'approval/resolved': {
        const key = `a:${payload.sessionId}:${payload.approvalId}`
        this._pending.delete(key)
        break
      }
      default:
        break
    }
  }

  _isFresh(key) {
    const at = this._pending.get(key)
    if (at === undefined) return false
    if (Date.now() - at > NOTIFY_TTL_MS) {
      this._pending.delete(key)
      return false
    }
    return true
  }

  _emit(key, title, body) {
    this._pending.set(key, Date.now())
    if (!this._shouldNotify()) return
    try {
      this.present(title, body)
    } catch (err) {
      appInfo(`notifier: notification failed: ${err.message}`)
    }
  }
}

module.exports = { Notifier }
