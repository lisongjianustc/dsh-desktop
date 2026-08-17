// Renders build/whale.svg → PNG app icon + tray icons using Electron's Chromium
// (deterministic rasterization, transparent background, no extra deps).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// build-time tool: software rendering is fine and avoids GPU flakiness
app.disableHardwareAcceleration()

const root = path.join(__dirname, '..')
const svgPath = path.join(root, 'build', 'whale.svg')
const assetsDir = path.join(root, 'src', 'assets')

async function render(size, outPath) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { backgroundThrottling: false },
  })
  const svg = fs.readFileSync(svgPath, 'utf8')
  await win.loadURL('data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'))
  // let the compositor paint a frame
  await new Promise((r) => setTimeout(r, 1200))
  const img = await win.webContents.capturePage()
  const buf = img.toPNG()
  fs.writeFileSync(outPath, buf)
  win.destroy()
  return buf.length
}

app.whenReady().then(async () => {
  fs.mkdirSync(assetsDir, { recursive: true })
  const n = await render(1024, path.join(root, 'build', 'icon-raw.png'))
  console.log(`ICONS OK raw=${n} (retina capture, derived sizes via sips)`)
  app.exit(0)
}).catch((err) => {
  console.error('render-icon failed:', err)
  app.exit(1)
})
