/**
 * Desktop bootstrap for the bundled dsh server.
 *
 * Runs before the real dsh CLI loads and forces `windowsHide: true` on every
 * child-process call from the server, so no tool or helper (cmd, pwsh, rg,
 * git, pnpm, MCP servers, …) can ever flash a black console window on the
 * user's desktop. Then it hands over to the real dsh entry.
 */
'use strict'

const path = require('node:path')

// Install the shared console-hiding patch (also loaded via NODE_OPTIONS in
// every descendant Node process; require cache dedupes the double load).
require('./console-hide-shim.cjs')

const dshEntry = path.join(__dirname, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
import('file://' + dshEntry.replace(/\\/g, '/')).catch((error) => {
  console.error(error)
  process.exit(1)
})
