// test-notifier.cjs — end-to-end test of the Notifier against a fake
// WebSocket mux stream. Run: electron --no-sandbox test/test-notifier.cjs
const { app } = require('electron')
const { Notifier } = require('../src/notifier')
const { startFakeServer, envelope } = require('./fake-ws-server.cjs')

app.disableHardwareAcceleration()

const SESSION = 'session-test-1'

async function main() {
  const presented = []
  const notifier = new Notifier({
    getConfig: () => ({ notifyMode: 'always' }),
    getWindow: () => null,
    present: (title, body) => presented.push({ title, body }),
    onActivate: () => {},
  })

  const server = await startFakeServer([
    { delayMs: 0, frame: envelope('r1', { type: 'session/subscribed', sessionId: SESSION, lastSeq: 1 }) },
    // 1. first approval -> notify
    { delayMs: 100, frame: envelope('r2', { type: 'approval/requested', sessionId: SESSION, approvalId: 'a1', toolName: 'bash', reason: '运行 rm -rf /tmp/x' }) },
    // 2. first question -> notify
    { delayMs: 100, frame: envelope('r3', { type: 'question/requested', sessionId: SESSION, questions: [{ header: '选择部署目标', detail: '生产还是预发？', options: [{ label: '生产' }, { label: '预发' }] }] }) },
    // 3. replay of the same pending approval (reconnect replay) -> NO notify
    { delayMs: 100, frame: envelope('r4', { type: 'approval/requested', sessionId: SESSION, approvalId: 'a1', toolName: 'bash', reason: '运行 rm -rf /tmp/x' }) },
    // 4. resolved then a NEW request with the same id -> notify again
    { delayMs: 100, frame: envelope('r5', { type: 'approval/resolved', sessionId: SESSION, approvalId: 'a1', outcome: 'allowed-once' }) },
    { delayMs: 100, frame: envelope('r6', { type: 'approval/requested', sessionId: SESSION, approvalId: 'a1', toolName: 'bash', reason: '再次请求' }) },
    // 5. unrelated frame -> no notify
    { delayMs: 100, frame: envelope('r7', { type: 'session/jobs', sessionId: SESSION, items: [] }) },
  ])

  notifier.connect(`http://127.0.0.1:${server.port}`)

  // wait long enough for the whole script (50 + ~700ms) plus margin
  await new Promise((r) => setTimeout(r, 2200))
  notifier.disconnect()
  await server.close()

  const expected = [
    { title: '审批请求：bash', body: '运行 rm -rf /tmp/x' },
    { title: '选择部署目标', body: '生产还是预发？' },
    { title: '审批请求：bash', body: '再次请求' },
  ]
  let pass = presented.length === expected.length
  for (let i = 0; i < expected.length && pass; i++) {
    pass = presented[i] && presented[i].title === expected[i].title && presented[i].body === expected[i].body
  }
  console.log(`NOTIFY TEST ${pass ? 'PASS' : 'FAIL'} got=${JSON.stringify(presented)}`)
  app.exit(pass ? 0 : 1)
}

app.whenReady().then(main).catch((err) => {
  console.error('NOTIFY TEST ERROR', err)
  app.exit(1)
})
