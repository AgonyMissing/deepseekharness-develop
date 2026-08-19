/**
 * Desktop bootstrap for the bundled dsh server.
 *
 * Runs before the real dsh CLI loads and forces `windowsHide: true` on every
 * child-process call from the server, so no tool or helper (cmd, pwsh, rg,
 * git, pnpm, MCP servers, …) can ever flash a black console window on the
 * user's desktop. Then it hands over to the real dsh entry.
 */
'use strict'

const cp = require('node:child_process')
const path = require('node:path')

const isOptions = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)

const patchChildProcess = (name) => {
  const original = cp[name]
  cp[name] = function (...args) {
    // Patch the first options-like argument when present.
    for (let index = args.length - 1; index >= 0; index--) {
      if (isOptions(args[index])) {
        if (args[index].windowsHide === undefined) args[index].windowsHide = true
        return original.apply(this, args)
      }
    }
    // No options object: insert one before a trailing callback, or append it.
    const last = args[args.length - 1]
    if (typeof last === 'function') args.splice(args.length - 1, 0, { windowsHide: true })
    else args.push({ windowsHide: true })
    return original.apply(this, args)
  }
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  patchChildProcess(name)
}

const dshEntry = path.join(__dirname, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
import('file://' + dshEntry.replace(/\\/g, '/')).catch((error) => {
  console.error(error)
  process.exit(1)
})
