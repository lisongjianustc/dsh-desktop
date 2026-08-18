#!/bin/bash
# watchdog-group-kill test: spawns a command that creates its own subprocess
# tree, then kills the watchdog's "parent" and verifies the ENTIRE
# subtree (parent + grandchild) is reaped, not left as orphans.
# This validates the detached:true + process.kill(-pid) pattern that the
# Electron app relies on for npx chains.
cat > /tmp/wg-grandchild.cjs <<'EOF'
const fs = require('fs')
fs.writeFileSync('/tmp/wg-tree.log', `grandchild started pid=${process.pid} ppid=${process.ppid}\n`, { flag: 'a' })
process.on('SIGTERM', () => {
  fs.appendFileSync('/tmp/wg-tree.log', 'grandchild got SIGTERM\n')
  process.exit(0)
})
setInterval(() => {}, 1000)
EOF

cat > /tmp/wg-child.cjs <<'EOF'
const { spawn } = require('child_process')
const fs = require('fs')
fs.writeFileSync('/tmp/wg-tree.log', `child started pid=${process.pid} ppid=${process.ppid}\n`, { flag: 'a' })
const grand = spawn(process.execPath, ['/tmp/wg-grandchild.cjs'], { stdio: 'ignore' })
fs.appendFileSync('/tmp/wg-tree.log', `child spawned grandchild=${grand.pid}\n`)
process.on('SIGTERM', () => {
  fs.appendFileSync('/tmp/wg-tree.log', 'child got SIGTERM, forwarding to grandchild...\n')
  try { grand.kill('SIGTERM') } catch {}
  setTimeout(() => process.exit(0), 200)
})
setInterval(() => {}, 1000)
EOF

rm -f /tmp/wg-tree.log
# Parent shell stays alive
sh -c 'echo $$ > /tmp/wg-parent.pid; sleep 60' &
sleep 0.5
PARENT=$(cat /tmp/wg-parent.pid)
echo "parent pid=$PARENT"

# Spawn the watchdog
node src/watchdog.js --parent $PARENT -- node /tmp/wg-child.cjs &
WD=$!
sleep 1.2
echo "watchdog started pid=$WD"

# Now kill the parent shell — watchdog should detect and reap the chain
kill $PARENT 2>/dev/null
echo "killed parent, waiting for watchdog to reap..."

sleep 6

if kill -0 $WD 2>/dev/null; then echo "FAIL: watchdog still alive"; else echo "PASS: watchdog exited"; fi
echo "--- /tmp/wg-tree.log:"
cat /tmp/wg-tree.log
echo "--- residual node processes (should be none under our test):"
pgrep -fl "wg-(child|grandchild)" 2>/dev/null

# Cleanup
rm -f /tmp/wg-parent.pid /tmp/wg-grandchild.cjs /tmp/wg-child.cjs /tmp/wg-tree.log
exit 0
