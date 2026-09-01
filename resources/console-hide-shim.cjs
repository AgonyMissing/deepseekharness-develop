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
  const _fs = require('node:fs')
  const _os = require('node:os')
  const _dbgLog = path.join(_os.homedir(), 'dsh-spawn-debug.log')
  const _log = (msg) => { try { _fs.appendFileSync(_dbgLog, new Date().toISOString() + ' [' + process.pid + '] ' + msg + '\n') } catch {} }
  const LAUNCHER = process.env.DSH_HIDE_LAUNCHER || path.join(__dirname, 'hidden-console-launcher.exe')
  // Single argv token: NODE_OPTIONS cannot carry a path with spaces (the
  // installer directory is "...\DeepSeek Harness\..."), but argv tokens are
  // never split, so this form works everywhere.
  const SHIM_ARG = '--require=' + __filename

  const isOptions = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)

  /** Node/Electron-as-node children: inject the shim into their argv. */
  const isNodeChild = (cmd) => {
    const base = String(cmd).toLowerCase().split(/[\\/]/).pop() || ''
    return base === 'node' || base === 'node.exe' ||
      base === 'electron' || base === 'electron.exe'
  }

  const alreadyShimmed = (args) =>
    Array.isArray(args) && args.some((arg) => String(arg).indexOf('console-hide-shim') !== -1)

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

  /** Rewrite args so the target runs inside the hidden-console launcher. */
  const routeThroughLauncher = (args) => {
    const fileArg = args[0]
    const fileArgs = Array.isArray(args[1]) ? args[1] : []
    args[0] = LAUNCHER
    args[1] = [fileArg, ...fileArgs]
  }

  const patchChildProcess = (name) => {
    const original = cp[name]
    cp[name] = function (...args) {
      let command = String(args[0])
      const cmdBase = String(command).toLowerCase().split(/[\\/]/).pop() || ''
      _log(`[${name}] command=${command} args=${JSON.stringify(args[1]).slice(0,300)}`)
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
          _log(`  → LAUNCHER routing (spawn): ${command}`)
          args[0] = LAUNCHER
          args[1] = [command, ...(Array.isArray(args[1]) ? args[1] : [])]
          command = LAUNCHER
        }
      }
      // spawnSync / execFile / execFileSync call libuv directly, bypassing
      // child_process.spawn — so the spawn launcher routing never fires.
      // Route console shells through the hidden-console launcher here too.
      if ((name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') && isConsoleShell(command)) {
        _log(`  → LAUNCHER routing (${name}): ${command}`)
        routeThroughLauncher(args)
        command = LAUNCHER
      }
      if (name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync') {
        const argv = Array.isArray(args[1]) ? args[1] : null
        if (argv !== null && isNodeChild(command) && !alreadyShimmed(argv)) {
          args[1] = [SHIM_ARG, ...argv]
        }
      }
      for (let index = args.length - 1; index >= 0; index--) {
        if (isOptions(args[index])) {
          const opts = args[index]
          opts.windowsHide = true
          if (name === 'fork') {
            const execArgv = Array.isArray(opts.execArgv) ? opts.execArgv.slice() : (process.execArgv || []).slice()
            if (!alreadyShimmed(execArgv)) execArgv.push(SHIM_ARG)
            opts.execArgv = execArgv
          }
          return original.apply(this, args)
        }
      }
      const last = args[args.length - 1]
      const opts = { windowsHide: true }
      if (name === 'fork') {
        const execArgv = (process.execArgv || []).slice()
        if (!alreadyShimmed(execArgv)) execArgv.push(SHIM_ARG)
        opts.execArgv = execArgv
      }
      if (typeof last === 'function') args.splice(args.length - 1, 0, opts)
      else args.push(opts)
      return original.apply(this, args)
    }
  }

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    patchChildProcess(name)
  }

  // Hook koffi so the sandbox's CreateProcessAsUserW calls set
  // STARTF_USESHOWWINDOW (0x1) + SW_HIDE on the STARTUPINFOW.  The sandbox
  // intentionally omits CREATE_NO_WINDOW (it causes STATUS_DLL_INIT_FAILED
  // under the restricted token), but SW_HIDE on the startup info is safe:
  // the console is still allocated (DLLs init fine) and the child inherits
  // the parent's hidden console — the flag just ensures the window stays
  // invisible even when a new console is allocated.  NOTE: dsh-win32-process
  // now sets these fields itself (lib/index.js); this hook is the fallback
  // for any other koffi consumer.
  try {
    const _Module = require('module')
    const _origLoad = _Module._load
    _Module._load = function (request, parent, isMain) {
      const result = _origLoad.apply(this, arguments)
      if (request !== 'koffi' || result == null || typeof result.bind !== 'function') return result
      const koffi = result
      const origBind = koffi.bind
      let _shadowSI = null
      const PVOID = koffi.pointer('void')
      function getShadowSI () {
        if (_shadowSI !== null) return _shadowSI
        _shadowSI = koffi.struct('_DSH_SHADOW_SI', {
          cb: 'uint32', lpReserved: 'str16', lpDesktop: 'str16',
          lpTitle: 'str16', dwX: 'uint32', dwY: 'uint32',
          dwXSize: 'uint32', dwYSize: 'uint32',
          dwXCountChars: 'uint32', dwYCountChars: 'uint32',
          dwFillAttribute: 'uint32', dwFlags: 'uint32',
          wShowWindow: 'uint16', cbReserved2: 'uint16',
          lpReserved2: koffi.pointer('uint8'),
          hStdInput: PVOID, hStdOutput: PVOID, hStdError: PVOID
        })
        return _shadowSI
      }
      koffi.bind = function (library, name, returnType, argTypes, options) {
        const bound = origBind.call(this, library, name, returnType, argTypes, options)
        if (name !== 'CreateProcessAsUserW' || typeof bound !== 'function') return bound
        return function CreateProcessAsUserW_Hidden (...args) {
          // lpStartupInfo is argument index 9 (0-based)
          const siPtr = args[9]
          if (siPtr != null) {
            try {
              const si = koffi.decode(siPtr, getShadowSI())
              if (!(si.dwFlags & 0x1)) { // STARTF_USESHOWWINDOW not yet set
                si.dwFlags |= 0x1        // add STARTF_USESHOWWINDOW
                si.wShowWindow = 0       // SW_HIDE
                koffi.encode(siPtr, getShadowSI(), si)
              }
            } catch (_) { /* best-effort: original call still proceeds */ }
          }
          return bound(...args)
        }
      }
      return result
    }
  } catch (_) {}

  // node-pty creates console processes via ConPTY/Win32 APIs, bypassing
  // child_process entirely. Patch its spawn so terminal shells (pwsh, cmd)
  // inherit a hidden console and don't flash a black window.
  try {
    const nodePty = require('node-pty')
    if (nodePty && typeof nodePty.spawn === 'function') {
      const origPtySpawn = nodePty.spawn.bind(nodePty)
      nodePty.spawn = function (file, args, options) {
        _log(`[node-pty.spawn] file=${file} args=${JSON.stringify(args).slice(0,200)}`)
        const opts = Object.assign({}, options || {})
        opts.env = Object.assign({}, process.env, opts.env || {})
        // Force a hidden console on the ConPTY child: the parent allocates
        // a visible console by default when spawned from a GUI/console app.
        opts.env.CREATE_NO_WINDOW = '1'
        return origPtySpawn(file, args, opts)
      }
    }
  } catch {}

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
