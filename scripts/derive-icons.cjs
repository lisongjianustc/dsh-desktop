// Derives the app icon (icns source) and the menu-bar tray template icons
// from build/icon-raw.png via macOS `sips`. Run after `pnpm render-icon`
// or after re-generating icon-raw.png by hand.
//
// Tray template sizes follow macOS HIG for the menu bar: 22pt × 22pt @1x
// and 44pt × 44pt @2x. Anything larger visibly grows the status-bar icon
// and looks out of place next to other apps.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const raw = path.join(root, 'build', 'icon-raw.png')
const buildDir = path.join(root, 'build')
const assetsDir = path.join(root, 'src', 'assets')
const iconsetDir = path.join(buildDir, 'icon.iconset')

function sips(size, outPath) {
  execFileSync('sips', ['-z', String(size), String(size), raw, '--out', outPath])
  return fs.statSync(outPath).size
}

function main() {
  if (!fs.existsSync(raw)) {
    console.error(`Missing ${raw} — run \`pnpm render-icon\` (or \`electron scripts/render-icon.cjs\`) first.`)
    process.exit(1)
  }
  fs.mkdirSync(assetsDir, { recursive: true })
  fs.mkdirSync(iconsetDir, { recursive: true })

  const derives = [
    // app icon (icns sources) — every size macOS might want
    { size: 16, out: path.join(iconsetDir, 'icon_16x16.png') },
    { size: 32, out: path.join(iconsetDir, 'icon_16x16@2x.png') },
    { size: 32, out: path.join(iconsetDir, 'icon_32x32.png') },
    { size: 64, out: path.join(iconsetDir, 'icon_32x32@2x.png') },
    { size: 128, out: path.join(iconsetDir, 'icon_128x128.png') },
    { size: 256, out: path.join(iconsetDir, 'icon_128x128@2x.png') },
    { size: 256, out: path.join(iconsetDir, 'icon_256x256.png') },
    { size: 512, out: path.join(iconsetDir, 'icon_256x256@2x.png') },
    { size: 512, out: path.join(iconsetDir, 'icon_512x512.png') },
    { size: 1024, out: path.join(iconsetDir, 'icon_512x512@2x.png') },
    // menu-bar tray icons — 22pt @1x / 44pt @2x (macOS HIG)
    { size: 22, out: path.join(assetsDir, 'trayTemplate.png') },
    { size: 44, out: path.join(assetsDir, 'trayTemplate@2x.png') },
  ]

  for (const { size, out } of derives) {
    const bytes = sips(size, out)
    console.log(`${size}px → ${path.relative(root, out)} (${bytes}B)`)
  }

  // rebuild the final icns from the iconset (run by electron-builder too, but
  // keep this in sync so the icons on disk are always usable)
  const icns = path.join(buildDir, 'icon.icns')
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icns])
  console.log(`icns → ${path.relative(root, icns)} (${fs.statSync(icns).size}B)`)
}

main()
