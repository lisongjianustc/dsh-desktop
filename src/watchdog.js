// watchdog.js — anti-orphan guardian for the dsh backend.
//
// Usage: node watchdog.js --parent <electronPid> -- <cmd> <args...>
//
// Spawns the backend inside its own process group (detached:true) so a
// single signal to the whole group reaps npx's transitive children as well
// as the dsh host itself — the desktop shell may launch dsh either as a
// direct shim (~/Library/pnpm/dsh or any PATH-resolved binary) or via
// `npx -y @deepseek-ai/dsh`, the latter creates an extra process wrapper.
//
// Responsibilities:
//  1. Spawn the backend with stdio inherited so the parent's `dsh web:`
//     readiness line is forwarded verbatim.
//  2. Report the immediate child PID so the parent can also signal it.
//  3. Forward SIGTERM/SIGINT/SIGHUP to the whole child process group and
//     escalate to SIGKILL after a grace period.
//  4. Poll the Electron parent PID; when the parent disappears (normal exit,
//     crash, or Force Quit / SIGKILL — none of which can be intercepted), the
//     watchdog gracefully terminates the entire child group and exits.
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
  // detached:true creates a new process group with pgid = child.pid, so
  // `process.kill(-child.pid, sig)` reaches every descendant (npx → node dsh).
  child = spawn(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
    detached: true,
  })
} catch (err) {
  console.error(`watchdog: failed to spawn ${cmd}: ${err.message}`)
  process.exit(127)
}

child.on('error', (err) => {
  console.error(`watchdog: child error: ${err.message}`)
  process.exit(127)
})

// Report the immediate child PID to the parent. Even with group signaling,
// the parent uses this as a first-line backup.
if (child.pid) console.log(`watchdog: child pid ${child.pid}`)

const escalateAfter = (ms) => {
  setTimeout(() => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    process.exit(0)
  }, ms).unref()
}

const signalGroup = (sig) => {
  if (stopping) return
  stopping = true
  try {
    process.kill(-child.pid, sig)
  } catch {}
  escalateAfter(12000)
}

process.on('SIGTERM', () => signalGroup('SIGTERM'))
process.on('SIGINT', () => signalGroup('SIGINT'))
process.on('SIGHUP', () => signalGroup('SIGHUP'))

// Parent-watch: covers every path where Electron dies without signaling us
// (Force Quit, kill -9, crash). The whole subtree dies with the group.
const timer = setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    clearInterval(timer)
    if (!stopping) {
      stopping = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
      escalateAfter(8000)
    }
  }
}, 2000)
timer.unref()

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
