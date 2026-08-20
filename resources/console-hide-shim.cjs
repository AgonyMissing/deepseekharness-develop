/**
 * console-hide-shim.cjs
 *
 * Loaded via NODE_OPTIONS in every Node process the desktop shell spawns
 * (the dsh server, background job workers, subagents, MCP servers, npx
 * children, ...). It forces `windowsHide: true` on every child-process call
 * and routes console shells / the ACL sandbox runner through
 * hidden-console-launcher.exe so their children inherit a hidden console.
 * Without this, a nested process (e.g. a background pwsh or an MCP server)
 * spawns cmd/pwsh/java with a visible console and the desktop flashes black
 * windows. Idempotent: safe when desktop-bootstrap.cjs also requires it.
 */
'use strict'

if (!globalThis.__dshConsoleHideShim) {
  globalThis.__dshConsoleHideShim = true

  const cp = require('node:child_process')
  const path = require('node:path')
  const LAUNCHER = process.env.DSH_HIDE_LAUNCHER || path.join(__dirname, 'hidden-console-launcher.exe')

  const isOptions = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)

  /** The ACL sandbox runner must share a hidden host console. */
  const isSandboxRunnerSpawn = (cmd, args) => {
    const joined = String(cmd) + ' ' + (Array.isArray(args) ? args.join(' ') : '')
    return joined.indexOf('dsh-sandbox-windows-acl') !== -1 && joined.indexOf('runner.js') !== -1
  }

  /** Console shells whose own children would otherwise create new windows. */
  const isConsoleShell = (cmd) => {
    const base = String(cmd).toLowerCase().split(/[\\/]/).pop() || ''
    return base === 'cmd' || base === 'cmd.exe' ||
      base === 'powershell' || base === 'powershell.exe' ||
      base === 'pwsh' || base === 'pwsh.exe' ||
      base.endsWith('.cmd') || base.endsWith('.bat')
  }

  const patchChildProcess = (name) => {
    const original = cp[name]
    cp[name] = function (...args) {
      let command = String(args[0])
      if (name === 'spawn') {
        let opts = null
        for (let index = args.length - 1; index >= 0; index--) {
          if (isOptions(args[index])) { opts = args[index]; break }
        }
        if (opts !== null && opts.shell === true && !Array.isArray(args[1]) && !isSandboxRunnerSpawn(command, args[1])) {
          // shell:true wraps the command in cmd.exe internally; route it
          // through the launcher so the inner shell inherits a hidden console.
          args[0] = LAUNCHER
          args[1] = ['cmd.exe', '/d', '/s', '/c', command]
          opts.shell = false
          command = LAUNCHER
        } else if (isSandboxRunnerSpawn(command, args[1]) || isConsoleShell(command)) {
          args[0] = LAUNCHER
          args[1] = [command, ...(Array.isArray(args[1]) ? args[1] : [])]
          command = LAUNCHER
        }
      }
      for (let index = args.length - 1; index >= 0; index--) {
        if (isOptions(args[index])) {
          args[index].windowsHide = true
          return original.apply(this, args)
        }
      }
      const last = args[args.length - 1]
      if (typeof last === 'function') args.splice(args.length - 1, 0, { windowsHide: true })
      else args.push({ windowsHide: true })
      return original.apply(this, args)
    }
  }

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    patchChildProcess(name)
  }

  // worker_threads create a fresh module registry, so the child_process patch
  // does NOT carry over; inject the shim into every Worker via execArgv.
  try {
    const wt = require('node:worker_threads')
    const OriginalWorker = wt.Worker
    const shimSelf = __filename.replace(/\\/g, '/')
    wt.Worker = class extends OriginalWorker {
      constructor(filename, options) {
        const opts = options || {}
        const execArgv = Array.isArray(opts.execArgv) ? opts.execArgv.slice() : (process.execArgv || []).slice()
        if (!execArgv.some((arg) => arg.indexOf('console-hide-shim') !== -1)) {
          execArgv.push('--require=' + shimSelf)
        }
        super(filename, Object.assign({}, opts, { execArgv }))
      }
    }
  } catch {}
}
