/**
 * Patch dsh-host-directory-picker-native to use Electron's dialog server
 * instead of spawning a Win32 worker that fails in the packaged runtime.
 *
 * Run after `npm install`:  node scripts/patch-directory-picker.cjs
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const TARGET = path.join(
  __dirname, '..', 'resources', 'dsh', 'node_modules',
  '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js',
)

const NEEDLE = 'async function pickNativeDirectory(signal, internals = {}) {'

const PATCH = `
	// Desktop shell delegation: when DSH_DESKTOP_DIALOG_PORT is set, the
	// Electron main process exposes a loopback /pick endpoint that shows
	// its own native folder dialog — bypassing the Win32 worker spawn that
	// fails inside the packaged Electron runtime.
	const desktopDialogPort = process.env.DSH_DESKTOP_DIALOG_PORT;
	if (desktopDialogPort && platform === "win32") {
		try {
			const url = \`http://127.0.0.1:\${desktopDialogPort}/pick\`;
			const resp = await globalThis.fetch(url, { signal });
			const body = await resp.json();
			if (body.error) throw new Error(body.error);
			return body.path ?? null;
		} catch (fetchError) {
			if (fetchError.code === 'ECONNREFUSED' || fetchError.cause?.code === 'ECONNREFUSED') {
				throw new Error("desktop dialog server is not running; cannot open folder picker");
			}
			throw fetchError;
		}
	}
`

const BODY_START = `\tconst platform = internals.platform ?? process.platform;\n\tconst run = internals.run ?? runNativeCommand;`

if (!fs.existsSync(TARGET)) {
  console.error(`[patch-directory-picker] target not found: ${TARGET}`)
  process.exit(1)
}

let code = fs.readFileSync(TARGET, 'utf8')

if (code.includes('Desktop shell delegation')) {
  console.log('[patch-directory-picker] already patched, skipping')
  process.exit(0)
}

const marker = code.indexOf(NEEDLE)
if (marker < 0) {
  console.error('[patch-directory-picker] cannot locate pickNativeDirectory — has the module layout changed?')
  process.exit(1)
}

const insertAt = code.indexOf(BODY_START, marker)
if (insertAt < 0) {
  console.error('[patch-directory-picker] cannot locate insertion point')
  process.exit(1)
}

code = code.slice(0, insertAt) + PATCH + code.slice(insertAt)
fs.writeFileSync(TARGET, code, 'utf8')
console.log('[patch-directory-picker] patched successfully')
