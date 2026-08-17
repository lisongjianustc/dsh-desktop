// logs.js — in-memory ring buffers + rotating log files under userData/logs.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MAX_LINES = 500
const MAX_BYTES = 4 * 1024 * 1024

class LogBuffer {
  constructor(name) {
    this.name = name
    this.lines = []
  }
  push(line) {
    this.lines.push(line)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this._appendFile(line)
  }
  tail(n = 300) {
    return this.lines.slice(-n)
  }
  clear() {
    this.lines.length = 0
  }
  filePath() {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, this.name)
  }
  _appendFile(line) {
    try {
      const file = this.filePath()
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        try {
          fs.rmSync(file + '.1', { force: true })
          fs.renameSync(file, file + '.1')
        } catch {}
      }
      fs.appendFileSync(file, line + '\n')
    } catch {}
  }
}

const appLog = new LogBuffer('app.log')
const backendLog = new LogBuffer('backend.log')

function appInfo(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  console.log(line)
  appLog.push(line)
}

function backendLine(raw) {
  const line = String(raw).replace(/\r?\n$/, '')
  if (line) backendLog.push(line)
}

function getLogsDir() {
  return path.join(app.getPath('userData'), 'logs')
}

module.exports = { appLog, backendLog, appInfo, backendLine, getLogsDir }
