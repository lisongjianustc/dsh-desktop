// config.js — DSH Desktop settings persisted under the app's userData dir.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  // 后端 dsh 可执行文件路径；留空 = 自动探测（~/Library/pnpm/dsh → 登录 shell command -v dsh）
  dshPath: '',
  // DSH_HOME 覆盖；留空 = 默认（~/.dsh）
  dshHome: '',
  // 关闭窗口行为：'ask' 每次询问（默认） | 'background' 保持后端后台运行 | 'quit' 结束所有进程
  closeBehavior: 'ask',
  // 最小化时是否隐藏到托盘（后端无论如何都会保持运行）
  minimizeToTray: false,
  // 自动检查更新：启动时 + 每 24 小时
  autoUpdateCheck: true,
  // 审批/提问系统通知：'hidden' 仅窗口不可见时（默认）| 'always' 总是 | 'off' 关闭
  notifyMode: 'hidden',
  lastUpdateCheckAt: 0,
  lastNotifiedVersion: '',
  noticeBackgroundShown: false,
}

let file = null
let data = null

function load() {
  file = path.join(app.getPath('userData'), 'config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    data = { ...DEFAULTS, ...raw }
  } catch {
    data = { ...DEFAULTS }
  }
  return data
}

function get() {
  return data
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('config: save failed:', err.message)
  }
}

function patch(updates) {
  Object.assign(data, updates)
  save()
  return data
}

module.exports = { load, get, patch, save, DEFAULTS }
