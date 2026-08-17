// fake-ws-server.cjs — dependency-free WebSocket server for tests: performs
// the RFC6455 handshake and pushes pre-scripted unmasked text frames.
const http = require('node:http')
const crypto = require('node:crypto')

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * @param {Array<{delayMs: number, frame: object}>} script — frames to push after the connection opens
 * @returns {Promise<{port: number, sockets: Set, close: () => Promise<void>}>}
 */
function startFakeServer(script) {
  const sockets = new Set()
  const server = http.createServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    let t = 50
    for (const step of script) {
      t += step.delayMs
      const payload = step.frame
      setTimeout(() => {
        if (!socket.destroyed) socket.write(encodeTextFrame(JSON.stringify(payload)))
      }, t)
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}

function envelope(rpcId, payload) {
  return { type: 'server-request', rpcId, payload }
}

module.exports = { startFakeServer, envelope }
