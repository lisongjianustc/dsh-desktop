// verify-icon.cjs — pixel-level sanity check for the rendered app icon.
// Samples corners (must be transparent) and the center region (must be the
// DeepSeek whale blue #4D6BFE), plus coverage stats.
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 1100, show: false })
  await win.loadFile(path.join(__dirname, '..', 'build', 'icon.png'))
  const stats = await win.webContents.executeJavaScript(`(() => {
    const c = document.createElement('canvas')
    c.width = 1024; c.height = 1024
    const ctx = c.getContext('2d')
    const img = document.querySelector('img')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, 1024, 1024).data
    const px = (x, y) => {
      const i = (y * 1024 + x) * 4
      return [d[i], d[i+1], d[i+2], d[i+3]]
    }
    let opaque = 0, blue = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] > 128) {
        opaque++
        if (d[i] < 110 && d[i+1] > 70 && d[i+1] < 140 && d[i+2] > 220) blue++
      }
    }
    return {
      cornerTL: px(2, 2), cornerTR: px(1021, 2), cornerBL: px(2, 1021), cornerBR: px(1021, 1021),
      center: px(512, 512), bodyLeft: px(180, 512), tail: px(880, 512),
      opaqueRatio: (opaque / (1024*1024)).toFixed(3),
      blueRatio: (blue / Math.max(opaque, 1)).toFixed(3),
    }
  })()`)
  console.log('ICON CHECK', JSON.stringify(stats))
  win.destroy()
  const pass =
    stats.cornerTL[3] < 10 && stats.cornerTR[3] < 10 && stats.cornerBL[3] < 10 && stats.cornerBR[3] < 10 &&
    stats.center[3] > 200 &&
    stats.opaqueRatio > 0.1 && stats.opaqueRatio < 0.65 &&
    Number(stats.blueRatio) > 0.8
  console.log(pass ? 'ICON VERIFY PASS' : 'ICON VERIFY FAIL')
  app.exit(pass ? 0 : 1)
})
