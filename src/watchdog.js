// watchdog.js — anti-orphan guardian for the dsh backend.
//
// Usage: node watchdog.js --parent <electronPid> -- <dsh-path> <args...>
//
// Responsibilities:
//  1. Spawn the backend as its own child with stdio inherited.
//  2. Poll the Electron parent PID; when the parent disappears (normal exit,
//     crash, or Force Quit / SIGKILL — none of which can be intercepted), the
//     watchdog gracefully terminates the backend (SIGTERM, then SIGKILL after
//     a grace period) and exits. A backend never outlives the desktop app.
//  3. Forward SIGTERM/SIGINT/SIGHUP to the backend and escalate to SIGKILL if
//     it does not exit within the grace period, then exit with its status.
const { spawn } = require('node:child_process')

const argv = process.argv.slice(2)
const sep = argv.indexOf('--parent')
if (sep === -1) {
  console.error('watchdog: missing --parent <pid>')
  process.exit(64)
}
const parentPid = Number(argv[sep + 1])
const cmdArgs = argv.slice(sep + 2)
const dash = cmdArgs.indexOf('--')
const [cmd, ...args] = dash === -1 ? cmdArgs : cmdArgs.slice(dash + 1)
if (!cmd) {
  console.error('watchdog: no command to run')
  process.exit(64)
}

if (!Number.isInteger(parentPid) || parentPid <= 0) {
  console.error(`watchdog: bad parent pid ${argv[sep + 1]}`)
  process.exit(64)
}

let stopping = false
let child

try {
  child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env })
} catch (err) {
  console.error(`watchdog: failed to spawn ${cmd}: ${err.message}`)
  process.exit(127)
}

child.on('error', (err) => {
  console.error(`watchdog: child error: ${err.message}`)
  process.exit(127)
})

// Report the backend PID to the parent so the desktop shell can signal the
// backend directly as a second path (belt & braces on graceful shutdown).
if (child.pid) console.log(`watchdog: child pid ${child.pid}`)

const escalateAfter = (ms) => {
  setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    process.exit(0)
  }, ms).unref()
}

const forward = (sig) => {
  if (stopping) return
  stopping = true
  try {
    child.kill(sig)
  } catch {}
  escalateAfter(12000)
}

process.on('SIGTERM', () => forward('SIGTERM'))
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGHUP', () => forward('SIGHUP'))

// Parent-watch: covers every path where Electron dies without signaling us
// (Force Quit, kill -9, crash). Grace is shorter here because the backend
// itself is healthy; we only need to give it a chance to save state.
const timer = setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    clearInterval(timer)
    if (!stopping) {
      stopping = true
      try {
        child.kill('SIGTERM')
      } catch {}
      escalateAfter(8000)
    }
  }
}, 2000)
timer.unref()

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
