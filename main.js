/**
 * DeepSeek Harness desktop shell.
 *
 * Starts the bundled dsh web server on an OS-assigned port using Electron's
 * own Node runtime (ELECTRON_RUN_AS_NODE), then hosts the exact same web UI
 * in a desktop window. The bootstrap forces hidden consoles for every child
 * process, and a lightweight stylesheet keeps the original white UI while
 * showing the DeepSeek background artwork without hurting text readability.
 */
'use strict'

const { app, BrowserWindow, dialog, Menu, shell, Tray, session } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { createServer } = require('node:http')
const os = require('node:os')
const path = require('node:path')

/** Desktop bootstrap inside the bundled runtime (forces hidden consoles). */
const SERVER_ENTRY = path.join(
  __dirname,
  'resources', 'desktop-bootstrap.cjs',
)
/** Fixed loopback port keeps the web origin stable so plugin settings that
 * live in browser storage (Aqua wallpaper, slider cache) survive restarts. */
const WEBUI_PORT = 17890

/** Run a headless self-check and print JSON diagnostics instead of a window. */
const SMOKE = process.argv.includes('--smoke')

let mainWindow = null
let server = null
let serverUrl = null
let quitting = false
let dialogServer = null
let dialogPort = 0
let tray = null
let consoleWatchdog = null
let terminalDelegationBackup = null

/** Per-user dsh home inside the app's own data directory (not ~/.dsh). */
const DSH_HOME = path.join(app.getPath('userData'), 'dsh-home')
const TERMINAL_DELEGATION_BACKUP = path.join(DSH_HOME, 'terminal-delegation-backup.json')
/** AppUserModelID GUIDs that select the classic Windows Console Host as the
 *  console/terminal delegation target (empty strings do NOT disable the
 *  Windows Terminal takeover on Windows 11). */
const CONHOST_DELEGATION_CONSOLE = '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}'
const CONHOST_DELEGATION_TERMINAL = '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}'
/** Tray-only start: boot with no visible window (--tray flag or desktop.json
 * startHidden=true). The local server and remote tunnel keep running, and the
 * tray icon remains the way back into the window. */
// NOTE: the console-hide-shim is deliberately NOT injected via NODE_OPTIONS.
// NODE_OPTIONS splits on spaces, and the installed path may contain spaces
// ("...\DeepSeek Harness\..."), which truncates --require and crashes every
// child at startup. The shim travels as a single argv token instead: the dsh
// server is spawned with `--require <shim>` below, and the shim injects the
// same token into every descendant Node/Electron child it spawns.

const HIDDEN_START = process.argv.includes('--tray') || (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'desktop.json'), 'utf8'))
    return cfg.startHidden === true
  } catch {
    return false
  }
})()
/** Managed MCP server store + the home-level patch layer they merge into. */
const MCP_STORE = path.join(DSH_HOME, 'mcp-servers.json')
const MCP_PATCH = path.join(DSH_HOME, 'cordis.patch.yml')
const MCP_MARKER_START = '# >>> dsh-desktop managed MCP servers >>>'
const MCP_MARKER_END = '# <<< dsh-desktop managed MCP servers <<<'
/** Bundled Aqua glass theme plugin (replaces the web-ui skin center). */
const AQUA_PLUGIN_SRC = path.join(__dirname, 'resources', 'aqua-ui')
const AQUA_PLUGIN_DST = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-aqua')
const AQUA_PATCH = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
const AQUA_MARKER_START = '# >>> dsh-desktop managed aqua theme >>>'
const AQUA_MARKER_END = '# <<< dsh-desktop managed aqua theme <<<'
/** dsh-web-ui family: bundled plugin rows + profile install root. */
const WEBUI_MARKER_START = '# >>> dsh-desktop managed web-ui family >>>'
const WEBUI_MARKER_END = '# <<< dsh-desktop managed web-ui family <<<'
const WEBUI_PROFILE_NM = path.join(DSH_HOME, 'profiles', 'node_modules')
const WEBUI_BUNDLED_ROOT = path.join(__dirname, 'resources', 'dsh-web-ui')

/** Chibi runner sprite for the effort-slider knob, served by the web UI. */
const CHIBI_SPRITE_SRC = path.join(__dirname, 'resources', 'chibi-runner-strip.png')
const WALLPAPER_SRC = path.join(__dirname, 'resources', 'wallpapers')
const FRONTEND_DIST = path.join(
  __dirname,
  'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist',
)

/**
 * Make the chibi sprite available at /chibi-runner-strip.png next to the
 * stock background artwork so the injected slider CSS can reference it.
 * Non-fatal: the knob falls back to the plain circle if the copy fails.
 */
function seedChibiSprite() {
  try {
    fs.mkdirSync(FRONTEND_DIST, { recursive: true })
    fs.copyFileSync(CHIBI_SPRITE_SRC, path.join(FRONTEND_DIST, 'chibi-runner-strip.png'))
  } catch {
    // The plain circular knob remains a valid fallback.
  }
}

/** Make the built-in wallpapers available under /wallpapers/ in the web UI. */
function seedWallpapers() {
  try {
    const target = path.join(FRONTEND_DIST, 'wallpapers')
    fs.mkdirSync(target, { recursive: true })
    for (const name of fs.readdirSync(WALLPAPER_SRC)) {
      const source = path.join(WALLPAPER_SRC, name)
      if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(target, name))
    }
  } catch {
    // Wallpapers are optional; the app still runs without them.
  }
}

/** Load the managed MCP server list (an array of plain server objects). */
function readMcpServers() {
  try {
    const data = JSON.parse(fs.readFileSync(MCP_STORE, 'utf8'))
    return Array.isArray(data)
      ? data.filter(s => s !== null && typeof s === 'object' && typeof s.name === 'string')
      : []
  } catch {
    return []
  }
}

/** Render one YAML scalar: JSON strings are valid YAML and stay unambiguous. */
function yamlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return 'null'
}

/**
 * Render the managed MCP rows: one @deepseek-ai/dsh-mcp-client plugin row per
 * server. The rows merge into the home-level cordis.patch.yml layer, which
 * dsh applies to every profile.
 */
function generateMcpPatch(servers) {
  const lines = []
  if (servers.length === 0) return lines.join('\n') + '\n'
  // dsh patch semantics: a top-level row is an id-targeted override, so NEW
  // plugin rows must be wrapped in an `insert` patch or the loader silently
  // ignores them as overrides for rows that do not exist.
  lines.push('- insert:')
  for (const s of servers) {
    lines.push(`  - id: ${yamlValue('mcp-' + s.name)}`)
    lines.push(`    name: ${yamlValue('@deepseek-ai/dsh-mcp-client')}`)
    lines.push('    config:')
    lines.push(`      serverName: ${yamlValue(s.name)}`)
    lines.push(`      transport: ${yamlValue(s.transport)}`)
    if (s.transport === 'stdio') {
      lines.push(`      command: ${yamlValue(s.command)}`)
      const args = Array.isArray(s.args) ? s.args.filter(a => typeof a === 'string' && a !== '') : []
      if (args.length > 0) {
        lines.push('      args:')
        for (const arg of args) lines.push(`        - ${yamlValue(arg)}`)
      }
      if (typeof s.cwd === 'string' && s.cwd !== '') {
        lines.push(`      cwd: ${yamlValue(s.cwd)}`)
      }
      const env = s.env && typeof s.env === 'object' ? s.env : {}
      const envKeys = Object.keys(env).filter(k => typeof env[k] === 'string' && env[k] !== '')
      if (envKeys.length > 0) {
        lines.push('      env:')
        for (const key of envKeys) lines.push(`        ${yamlValue(key)}: ${yamlValue(env[key])}`)
      }
    } else {
      lines.push(`      url: ${yamlValue(s.url)}`)
      const headers = s.headers && typeof s.headers === 'object' ? s.headers : {}
      const headerKeys = Object.keys(headers).filter(k => typeof headers[k] === 'string' && headers[k] !== '')
      if (headerKeys.length > 0) {
        lines.push('      headers:')
        for (const key of headerKeys) lines.push(`        ${yamlValue(key)}: ${yamlValue(headers[key])}`)
      }
    }
    if (typeof s.toolCallTimeoutMs === 'number' && s.toolCallTimeoutMs > 0) {
      lines.push(`      toolCallTimeoutMs: ${yamlValue(s.toolCallTimeoutMs)}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** Persist the managed list and regenerate the patch overlay. */
function writeMcpServers(servers) {
  fs.mkdirSync(DSH_HOME, { recursive: true })
  fs.writeFileSync(MCP_STORE, JSON.stringify(servers, null, 2), 'utf8')
  let existing = ''
  try {
    existing = fs.readFileSync(MCP_PATCH, 'utf8')
  } catch {
    existing = ''
  }
  const before = existing.split(MCP_MARKER_START)[0]
  const after = existing.includes(MCP_MARKER_END) ? existing.split(MCP_MARKER_END)[1] : ''
  const rows = generateMcpPatch(servers)
  const managed = MCP_MARKER_START + '\n'
    + (rows.trim() === '' ? '[]\n' : rows)
    + MCP_MARKER_END
  const next = [before.trimEnd(), managed, after.trimStart()].filter(part => part !== '').join('\n') + '\n'
  fs.writeFileSync(MCP_PATCH, next, 'utf8')
}

/** Ensure the store/patch exist on first launch, then start with them. */
function ensureMcpFiles() {
  writeMcpServers(readMcpServers())
}

/**
 * Sync the one requested skill — glm-vision from ~/.codex/skills — into the
 * app's own dsh-home/skills root, where the dsh model catalog discovers it.
 */
function ensureGlmSkill() {
  const source = path.join(os.homedir(), '.codex', 'skills', 'glm-vision')
  const destination = path.join(DSH_HOME, 'skills', 'glm-vision')
  try {
    const sourceEntries = fs.readdirSync(source, { recursive: true })
    for (const relative of sourceEntries) {
      const sourcePath = path.join(source, relative)
      const targetPath = path.join(destination, relative)
      if (fs.statSync(sourcePath).isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      const sourceMtime = fs.statSync(sourcePath).mtimeMs
      let targetMtime = -1
      try {
        targetMtime = fs.statSync(targetPath).mtimeMs
      } catch {
        targetMtime = -1
      }
      if (targetMtime < 0 || sourceMtime > targetMtime) {
        fs.copyFileSync(sourcePath, targetPath)
      }
    }
  } catch {
    // The glm-vision skill is a nice-to-have; the app still runs without it.
  }
}

/** Recursive directory copy (mirrors the runtime's own asset sync). */
function copyDirSync(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const relative of fs.readdirSync(from, { recursive: true })) {
    const source = path.join(from, relative)
    const target = path.join(to, relative)
    if (fs.statSync(source).isDirectory()) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
}

/**
 * dsh-web-ui family rows (the aggregate's patch, namespaced web-ui-*).
 * Registered idempotently in the home patch layer. Packages are expected in
 * the profile node_modules (installed by this shell or bundled resources).
 */
const WEBUI_FAMILY_ROWS = [
  // Desktop-harness settings sections: MCP servers / skills / subagents /
  // commands / hooks / git / index.
  ['harness-extras', '@deepseek-ai/dsh-client-ui-harness-extras'],
]

/**
 * Harness-extras client plugin (MCP servers / skills / subagents settings
 * sections). Bundled under the kernel's node_modules; synced into the
 * profile module root so the cordis loader resolves it on every machine —
 * the package sits outside the kernel's own dependency graph, so the
 * module-fallback heal cannot discover it on its own.
 */
const HARNESS_EXTRAS_NAME = '@deepseek-ai/dsh-client-ui-harness-extras'
const HARNESS_EXTRAS_SRC = path.join(__dirname, 'resources', 'dsh', 'node_modules', HARNESS_EXTRAS_NAME)
const HARNESS_EXTRAS_DST = path.join(DSH_HOME, 'profiles', 'node_modules', HARNESS_EXTRAS_NAME)

/** Sync the bundled harness-extras package into the profile (version-aware). */
function ensureHarnessExtras() {
  if (!fs.existsSync(HARNESS_EXTRAS_SRC)) return
  let bundledVersion = ''
  try {
    bundledVersion = JSON.parse(fs.readFileSync(path.join(HARNESS_EXTRAS_SRC, 'package.json'), 'utf8')).version ?? ''
  } catch { /* treated as empty — always refresh */ }
  let installedVersion = ''
  try {
    installedVersion = JSON.parse(fs.readFileSync(path.join(HARNESS_EXTRAS_DST, 'package.json'), 'utf8')).version ?? ''
  } catch { /* missing install — copy below */ }
  if (bundledVersion !== '' && bundledVersion === installedVersion) return
  fs.rmSync(HARNESS_EXTRAS_DST, { recursive: true, force: true })
  copyDirSync(HARNESS_EXTRAS_SRC, HARNESS_EXTRAS_DST)
}

/**
 * Legacy-upgrade cleanup: machines that ran an older desktop build may still
 * carry the removed third-party web-ui plugins (their packages in the
 * profile node_modules and their rows in the profile patch). Loading those
 * rows against the 0.1.2 kernel fails the boot, so every launch removes the
 * known-legacy packages and rewrites the managed patch layers before the
 * server starts. User data — sessions, skills, mcp-servers.json, settings,
 * custom subagents — is never touched.
 */
const LEGACY_SCOPES = ['@linxin666', '@mlgbnb']
const LEGACY_NAMES = new Set([
  'dsh-better-sidebar',
  '@deepseek-ai/dsh-client-ui-aqua',
  '@deepseek-ai/dsh-host-apiproxy',
  'dsh-history-tree',
])

/** Whether a package name belongs to a removed third-party plugin family. */
function isLegacyPackage(name) {
  if (LEGACY_NAMES.has(name)) return true
  if (name.startsWith('@')) {
    return LEGACY_SCOPES.includes(name.split('/')[0])
  }
  return false
}

/** Remove legacy plugin packages from one node_modules root. */
function removeLegacyPackages(nodeModulesRoot) {
  if (!fs.existsSync(nodeModulesRoot)) return
  for (const entry of fs.readdirSync(nodeModulesRoot)) {
    const entryPath = path.join(nodeModulesRoot, entry)
    let stat
    try {
      stat = fs.statSync(entryPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (entry.startsWith('@')) {
      for (const inner of fs.readdirSync(entryPath)) {
        if (isLegacyPackage(entry + '/' + inner)) {
          fs.rmSync(path.join(entryPath, inner), { recursive: true, force: true })
        }
      }
    } else if (isLegacyPackage(entry)) {
      fs.rmSync(entryPath, { recursive: true, force: true })
    }
  }
}

/**
 * Strip legacy plugin rows from one cordis patch layer: drop the desktop
 * shell's old managed marker blocks wholesale, then remove any remaining
 * id/name row pair that references a legacy package. Empty `- insert:`
 * headers left behind are dropped too.
 */
function stripLegacyPatchRows(patchPath) {
  if (!fs.existsSync(patchPath)) return
  const lines = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/)
  const kept = []
  let inMarkerBlock = false
  for (const line of lines) {
    if (/^# >>> dsh-desktop managed/.test(line)) { inMarkerBlock = true; continue }
    if (/^# <<< dsh-desktop managed/.test(line)) { inMarkerBlock = false; continue }
    if (inMarkerBlock) continue
    kept.push(line)
  }
  // Remove id lines whose following name line references a legacy package.
  const result = []
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]
    const nameMatch = /^\s*name:\s*["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (nameMatch !== null && isLegacyPackage(nameMatch[1])) {
      const previous = result.length > 0 ? result[result.length - 1] : ''
      if (/^\s*-\s+id:/.test(previous)) result.pop()
      continue
    }
    result.push(line)
  }
  // Drop `- insert:` headers whose block no longer carries any item.
  const final = []
  for (let i = 0; i < result.length; i++) {
    const line = result[i]
    if (/^\s*-\s+insert:\s*$/.test(line)) {
      let next = ''
      for (let j = i + 1; j < result.length; j++) {
        if (result[j].trim() === '') continue
        next = result[j]
        break
      }
      if (!/^\s*-\s+id:/.test(next)) continue
    }
    final.push(line)
  }
  const next = final.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  if (next !== lines.join('\n')) {
    fs.writeFileSync(patchPath, next, 'utf8')
  }
}

/** Drop legacy bundle references from one profile package.json. */
function stripLegacyProfileBundles(profilePackagePath) {
  if (!fs.existsSync(profilePackagePath)) return
  try {
    const manifest = JSON.parse(fs.readFileSync(profilePackagePath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      const filtered = bundles.filter(bundle => !isLegacyPackage(bundle))
      if (filtered.length !== bundles.length) manifest.dsh.profile.bundles = filtered
    }
    if (manifest.dependencies !== undefined && typeof manifest.dependencies === 'object') {
      for (const name of Object.keys(manifest.dependencies)) {
        if (isLegacyPackage(name)) delete manifest.dependencies[name]
      }
    }
    fs.writeFileSync(profilePackagePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  } catch { /* a malformed manifest is the boot's own error to report */ }
}

/** Run the full legacy cleanup across the profile tree. */
function cleanupLegacyPlugins() {
  const profilesRoot = path.join(DSH_HOME, 'profiles')
  removeLegacyPackages(path.join(profilesRoot, 'node_modules'))
  removeLegacyPackages(path.join(profilesRoot, 'web', 'node_modules'))
  stripLegacyPatchRows(path.join(profilesRoot, 'web', 'cordis.patch.yml'))
  stripLegacyProfileBundles(path.join(profilesRoot, 'web', 'package.json'))
}

/**
 * Copy the bundled dsh-web-ui family modules into the profile module
 * fallback root. Only missing packages are copied, so existing installs are
 * never overwritten; on a fresh machine this is a one-time bootstrap.
 */
function syncBundledWebUiModules() {
  const bundledRoot = path.join(WEBUI_BUNDLED_ROOT, 'node_modules')
  const kernelRoot = path.join(__dirname, 'resources', 'dsh', 'node_modules')
  if (!fs.existsSync(bundledRoot)) return
  fs.mkdirSync(WEBUI_PROFILE_NM, { recursive: true })
  for (const scope of fs.readdirSync(bundledRoot)) {
    const scopePath = path.join(bundledRoot, scope)
    let stat
    try {
      stat = fs.statSync(scopePath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const entries = scope.startsWith('@')
      ? fs.readdirSync(scopePath).map(child => scope + '/' + child)
      : [scope]
    for (const relative of entries) {
      const source = path.join(bundledRoot, ...relative.split('/'))
      if (!fs.existsSync(path.join(source, 'package.json'))) continue
      // Skip packages the dsh kernel ships in its own module tree: dsh heals
      // those as junction links in the profile fallback, and a real directory
      // here would crash boot on a fresh install ("exists and is not a
      // symlink"). Only web-ui-family packages missing from the kernel are
      // copied as real directories.
      if (fs.existsSync(path.join(kernelRoot, ...relative.split('/')))) continue
      const target = path.join(WEBUI_PROFILE_NM, ...relative.split('/'))
      // Refresh the profile copy when the bundled version differs, so family
      // upgrades propagate on the next start (fresh machines copy everything).
      let bundledVersion = null
      let bundledPatch = 0
      try {
        const sourceMeta = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
        bundledVersion = sourceMeta.version
        bundledPatch = Number(sourceMeta.dshDesktopPatch) || 0
      } catch {}
      if (bundledVersion !== null) {
        let installedVersion = null
        let installedPatch = 0
        try {
          const targetMeta = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
          installedVersion = targetMeta.version
          installedPatch = Number(targetMeta.dshDesktopPatch) || 0
        } catch {}
        // Same npm version is normally a no-op, but a higher dshDesktopPatch
        // in the bundle forces a refresh (desktop-side patches to a published
        // package, e.g. the market background extraction).
        if (installedVersion === bundledVersion && installedPatch >= bundledPatch) continue
      } else {
        if (fs.existsSync(path.join(target, 'package.json'))) continue
      }
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      copyDirSync(source, target)
    }
  }
}

/**
 * Install the bundled Aqua glass theme into the per-user web profile: copy
 * the plugin package into the profile's node_modules and register its row in
 * the web profile patch (idempotent, user content preserved).
 */
function ensureAquaPlugin() {
  try {
    const bundledVersion = JSON.parse(
      fs.readFileSync(path.join(AQUA_PLUGIN_SRC, 'package.json'), 'utf8'),
    ).version
    let installedVersion = null
    try {
      installedVersion = JSON.parse(
        fs.readFileSync(path.join(AQUA_PLUGIN_DST, 'package.json'), 'utf8'),
      ).version
    } catch {
      installedVersion = null
    }
    if (installedVersion !== bundledVersion) {
      fs.rmSync(AQUA_PLUGIN_DST, { recursive: true, force: true })
      copyDirSync(AQUA_PLUGIN_SRC, AQUA_PLUGIN_DST)
    }
    let existing = ''
    try {
      existing = fs.readFileSync(AQUA_PATCH, 'utf8')
    } catch {
      existing = ''
    }
    let base = existing
      .replace(/^\[\]\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
    if (!existing.includes(AQUA_MARKER_START)) {
      const block = AQUA_MARKER_START + '\n'
        + '- insert:\n'
        + '    - id: ui-aqua\n'
        + '      name: "@deepseek-ai/dsh-client-ui-aqua"\n'
        + AQUA_MARKER_END
      const next = (base === '' ? '' : base + '\n\n') + block + '\n'
      fs.mkdirSync(path.dirname(AQUA_PATCH), { recursive: true })
      fs.writeFileSync(AQUA_PATCH, next, 'utf8')
    } else if (base !== existing.trimEnd()) {
      fs.mkdirSync(path.dirname(AQUA_PATCH), { recursive: true })
      fs.writeFileSync(AQUA_PATCH, base + '\n', 'utf8')
    }
  } catch {
    // Aqua is optional; the app still runs without it.
  }
}

function ensureWebUiFamily() {
  // The web-ui family rows are rewritten on every start so already-initialized
  // profiles pick up added rows (e.g. the 0.2.4 plugin-manager / chat-recovery
  // / desktop-launcher / skin-center rows) without manual patching.
  // Electron's node:zlib zstd decoder crashes natively after ~20k frames
  // (a single large session can carry 30k+ frames), so the desktop shell
  // forces plaintext session artifacts. Kept outside the managed markers so
  // the family rewrite never drops it.
  try {
    const webDir = path.join(DSH_HOME, 'profiles', 'web')
    const webPatch = path.join(webDir, 'cordis.patch.yml')
    let existing = ''
    try {
      existing = fs.readFileSync(webPatch, 'utf8')
    } catch { /* first boot */ }
    const plaintextRow = '- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath(\'sessions\')\n    compression: none'
    if (!/compression:\s*none/.test(existing)) {
      const block = '# Desktop harness: Electron zstd crashes on large multi-frame\n' +
        '# session logs; sessions are stored as plaintext .jsonl.\n' +
        plaintextRow + '\n\n'
      const next = (existing.trim() === '' ? '' : existing + '\n') + block
      fs.mkdirSync(webDir, { recursive: true })
      fs.writeFileSync(webPatch, next, 'utf8')
    }
  } catch { /* optional */ }
  // pnpm treats the web profile as a workspace root (packages: [.]), so
  // `dsh plugin add` (forwarded to pnpm verbatim) needs the root-add check
  // relaxed; without it 创意工坊 plugin installs fail with
  // ERR_PNPM_ADDING_TO_ROOT. Written idempotently so fresh installs get it too.
  try {
    const webDir = path.join(DSH_HOME, 'profiles', 'web')
    const npmrcPath = path.join(webDir, '.npmrc')
    let npmrc = ''
    try {
      npmrc = fs.readFileSync(npmrcPath, 'utf8')
    } catch { /* first boot */ }
    if (!/ignore-workspace-root-check\s*=\s*true/.test(npmrc)) {
      fs.mkdirSync(webDir, { recursive: true })
      const line = 'ignore-workspace-root-check=true'
      const next = npmrc.trim() === '' ? line + '\n' : npmrc.replace(/\n?$/, '\n') + line + '\n'
      fs.writeFileSync(npmrcPath, next, 'utf8')
    }
  } catch { /* optional */ }
  try {
    const webPatch = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
    let existing = ''
    try {
      existing = fs.readFileSync(webPatch, 'utf8')
    } catch {
      existing = ''
    }
    const lines = [WEBUI_MARKER_START, '- insert:']
    for (const [rowId, moduleName] of WEBUI_FAMILY_ROWS) {
      lines.push(`    - id: ${rowId}`)
      lines.push(`      name: ${yamlValue(moduleName)}`)
    }
    lines.push(WEBUI_MARKER_END)
    const head = existing.includes(WEBUI_MARKER_START)
      ? existing.split(WEBUI_MARKER_START)[0]
      : existing
    const tail = existing.includes(WEBUI_MARKER_END)
      ? existing.split(WEBUI_MARKER_END)[1]
      : ''
    const base = head
      .replace(/^\[\]\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
    const next = (base === '' ? '' : base + '\n\n') + lines.join('\n') + '\n' + tail
    if (next === existing) return
    fs.mkdirSync(path.dirname(webPatch), { recursive: true })
    fs.writeFileSync(webPatch, next, 'utf8')
  } catch { /* patch layer is optional */ }
  try {
    syncBundledWebUiModules()
  } catch {
    // Optional family; the app runs without it.
  }
}

/** Minimal SKILL.md frontmatter reader for the skills settings list. */
function parseSkillFrontmatter(raw) {
  const meta = {}
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (match === null) return meta
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key === 'name') meta.name = value
    else if (key === 'description') meta.description = value
    else if (key === 'whenToUse') meta.whenToUse = value
    else if (key === 'disable-model-invocation') meta.modelInvocable = !/^(true|yes|on|1)$/i.test(value)
    else if (key === 'modelInvocable') meta.modelInvocable = /^(true|yes|on|1)$/i.test(value)
  }
  return meta
}

/**
 * List the skills installed in the app's own dsh-home/skills root — the only
 * skills this desktop shell manages (currently just glm-vision).
 */
function scanSkills() {
  const root = path.join(DSH_HOME, 'skills')
  const skills = []
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return skills
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    let skillPath = null
    if (entry.isDirectory()) skillPath = path.join(root, entry.name, 'SKILL.md')
    else if (entry.isFile() && entry.name.endsWith('.md')) skillPath = path.join(root, entry.name)
    if (skillPath === null || !fs.existsSync(skillPath)) continue
    let raw = ''
    try {
      raw = fs.readFileSync(skillPath, 'utf8')
    } catch {
      continue
    }
    const meta = parseSkillFrontmatter(raw)
    const fallback = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, '')
    const name = meta.name || fallback
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue
    skills.push({
      name,
      description: meta.description || '',
      ...(meta.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }),
      modelInvocable: meta.modelInvocable !== false,
    })
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/**
 * Candidate skills available for install: one level deep from Codex's and
 * the shared agents skill roots, excluding already-installed names.
 */
function scanSkillCandidates() {
  const roots = [
    { path: path.join(os.homedir(), '.codex', 'skills'), source: 'codex' },
    { path: path.join(os.homedir(), '.agents', 'skills'), source: 'agents' },
  ]
  const installed = new Set(scanSkills().map(skill => skill.name))
  const candidates = []
  const seen = new Set()
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue
      const skillPath = path.join(root.path, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillPath)) continue
      let meta = {}
      try {
        meta = parseSkillFrontmatter(fs.readFileSync(skillPath, 'utf8'))
      } catch {
        continue
      }
      const name = meta.name || entry.name
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || seen.has(name)) continue
      seen.add(name)
      candidates.push({
        name,
        description: meta.description || '',
        source: root.source,
        path: path.join(root.path, entry.name),
        installed: installed.has(name),
      })
    }
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name))
  return candidates
}

/** Copy one local skill directory into the app-managed dsh-home/skills root. */
function installSkill(sourcePath) {
  if (typeof sourcePath !== 'string' || sourcePath === '') return { error: '缺少技能路径' }
  const resolved = path.resolve(sourcePath)
  const skillFile = path.join(resolved, 'SKILL.md')
  if (!fs.existsSync(skillFile)) return { error: '该目录下没有 SKILL.md' }
  let meta = {}
  try {
    meta = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'))
  } catch { /* name falls back to the directory name */ }
  const name = meta.name || path.basename(resolved)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return { error: '技能名称不合法' }
  const root = path.resolve(path.join(DSH_HOME, 'skills'))
  const target = path.join(root, name)
  if (target !== root && !target.startsWith(root + path.sep)) return { error: '路径越界' }
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.cpSync(resolved, target, { recursive: true })
  return { ok: true, name }
}

/** Remove one managed skill from dsh-home/skills (path-scoped on purpose). */
function removeSkill(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return { error: '名称不合法' }
  const root = path.resolve(path.join(DSH_HOME, 'skills'))
  const target = path.resolve(path.join(root, name))
  if (target === root || !target.startsWith(root + path.sep)) return { error: '路径越界' }
  if (!fs.existsSync(target)) return { error: '未找到该技能' }
  fs.rmSync(target, { recursive: true, force: true })
  return { ok: true }
}

/** Validate + persist one server (add or replace by name). */
function upsertMcpServer(input) {
  if (input === null || typeof input !== 'object' || typeof input.name !== 'string') {
    return { error: '缺少服务器名称' }
  }
  const name = input.name.trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    return { error: '名称需为 1-32 位字母、数字、下划线或连字符' }
  }
  const transport = input.transport === 'streamable-http' ? 'streamable-http'
    : input.transport === 'stdio' ? 'stdio' : null
  if (transport === null) return { error: '传输类型需为 stdio 或 streamable-http' }
  const server = { name, transport, enabled: input.enabled !== false }
  if (transport === 'stdio') {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return { error: 'stdio 类型需要填写启动命令' }
    }
    server.command = input.command.trim()
    server.args = Array.isArray(input.args) ? input.args.map(arg => String(arg)) : []
    server.env = input.env && typeof input.env === 'object' ? input.env : {}
    if (typeof input.cwd === 'string' && input.cwd.trim() !== '') {
      server.cwd = input.cwd.trim()
    }
  } else {
    if (typeof input.url !== 'string' || !/^https?:\/\//i.test(input.url.trim())) {
      return { error: '需要填写 http(s):// 开头的服务器地址' }
    }
    server.url = input.url.trim()
    server.headers = input.headers && typeof input.headers === 'object' ? input.headers : {}
  }
  if (Number.isFinite(input.toolCallTimeoutMs) && input.toolCallTimeoutMs > 0) {
    server.toolCallTimeoutMs = Math.round(input.toolCallTimeoutMs)
  }
  const servers = readMcpServers().filter(existing => existing.name !== name)
  servers.push(server)
  writeMcpServers(servers)
  return { ok: true }
}

/** Remove one server by name. */
function removeMcpServer(name) {
  if (typeof name !== 'string' || name === '') return { error: '缺少服务器名称' }
  const before = readMcpServers()
  const after = before.filter(existing => existing.name !== name)
  if (after.length === before.length) return { error: '未找到该服务器' }
  writeMcpServers(after)
  return { ok: true }
}

/**
 * User-level preset root: the roster's last-resort roots entry. A custom
 * subagent here is a directory with agent.cordis.yml, discovered by the dsh
 * preset roster on its own.
 */
function userPresetsDir() {
  return path.join(DSH_HOME, '.agent-presets')
}

/**
 * List the subagent delegation rows across the shipped presets plus the
 * user-level .agent-presets root. Each row carries which preset declared it
 * and whether it is disabled (the roster's tool-rows setting).
 */
function scanSubagents() {
  const presetsDir = path.join(
    __dirname, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets',
  )
  const rows = []
  const roots = [presetsDir, userPresetsDir()]
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const presetFile = path.join(root, entry.name, 'agent.cordis.yml')
      let raw = ''
      try {
        raw = fs.readFileSync(presetFile, 'utf8')
      } catch {
        continue
      }
      // Pull the delegation tool rows: id / provider / toolName / disabled per row.
      const rowRe = /- id:\s*(tool-subagent-[\w-]+)([\s\S]*?)(?=- id:|\n\S|$)/g
      let match
      while ((match = rowRe.exec(raw)) !== null) {
        const body = match[2]
        const provider = /provider:\s*(\S+)/.exec(body)?.[1] ?? ''
        const toolName = /toolName:\s*(\S+)/.exec(body)?.[1] ?? ''
        const disabled = /disabled:\s*true/.test(body)
        rows.push({
          id: match[1],
          preset: entry.name,
          root: root === presetsDir ? 'shipped' : 'user',
          provider,
          toolName,
          enabled: !disabled,
        })
      }
    }
  }
  return rows
}

/** Escape one YAML string scalar (JSON strings are valid YAML). */
function yamlStr(value) {
  return JSON.stringify(value)
}

/**
 * Create (or overwrite) a user-level subagent preset: a directory under
 * ~/.dsh/.agent-presets/<name>/agent.cordis.yml declaring one enabled
 * tool-subagent row plus a persona, so the roster discovers it on restart.
 */
function writeSubagentPreset(input, force) {
  if (input === null || typeof input !== 'object') return { error: '缺少参数' }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
    return { error: '名称需为以字母数字开头，最多 32 位字母、数字、下划线或连字符' }
  }
  const root = path.resolve(userPresetsDir())
  const dir = path.resolve(path.join(root, name))
  if (!dir.startsWith(root + path.sep)) return { error: '路径越界' }
  if (fs.existsSync(dir) && !force) return { error: '该子智能体已存在' }
  const provider = input.provider === 'codex' || input.provider === 'claude-code' ? input.provider : 'codex'
  const toolName = input.toolName && /^[A-Za-z0-9_-]+$/.test(input.toolName)
    ? input.toolName : 'subagent_' + name
  const persona = typeof input.persona === 'string' && input.persona.trim() !== ''
    ? input.persona.trim() : 'You are a focused subagent.'
  const id = 'tool-subagent-' + name
  const lines = [
    '# User subagent preset — managed by the DeepSeek Harness desktop shell.',
    '- id: persona',
    '  name: \'@deepseek-ai/dsh-persona\'',
    '  config:',
    '    text: >-',
    '      ' + persona,
    '',
    '- id: ' + id,
    '  name: \'@deepseek-ai/dsh-tool-subagent\'',
    '  config:',
    '    provider: ' + provider,
    '    toolName: ' + toolName,
    '    backgroundMode: one-shot',
    '    maxDepth: provider-managed',
    '',
  ]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), lines.join('\n'), 'utf8')
  return { ok: true }
}

/** Toggle `disabled:` on one user preset's tool-subagent row; restart to apply. */
function setSubagentEnabled(id, enabled) {
  if (typeof id !== 'string' || id === '') return { error: '缺少标识' }
  const root = path.resolve(userPresetsDir())
  const name = id.replace(/^tool-subagent-/, '')
  const dir = path.resolve(path.join(root, name))
  if (!dir.startsWith(root + path.sep)) return { error: '路径越界' }
  const presetFile = path.join(dir, 'agent.cordis.yml')
  if (!fs.existsSync(presetFile)) return { error: '未找到该子智能体' }
  let raw = fs.readFileSync(presetFile, 'utf8')
  const rowRe = /(- id:\s*tool-subagent-[\w-]+[\s\S]*?)(?=- id:|\n\S|$)/g
  let match
  let changed = false
  const next = raw.replace(rowRe, (whole, head) => {
    if (!head.includes(id)) return whole
    changed = true
    return head.replace(/\r?\n\s*disabled:\s*true/, '')
      .replace(/\r?\n\s*config:/, '\n      ' + (enabled ? '' : 'disabled: true\n') + '      config:')
  })
  if (!changed) return { error: '未找到匹配的行' }
  fs.writeFileSync(presetFile, next, 'utf8')
  return { ok: true }
}

/** Delete one user-level subagent preset directory. */
function removeSubagentPreset(id) {
  if (typeof id !== 'string' || id === '') return { error: '缺少标识' }
  const root = path.resolve(userPresetsDir())
  const name = id.replace(/^tool-subagent-/, '')
  const dir = path.resolve(path.join(root, name))
  if (!dir.startsWith(root + path.sep)) return { error: '路径越界' }
  if (!fs.existsSync(dir)) return { error: '未找到该子智能体' }
  fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}

// ── Commands (slash prompt templates riding the skill pipeline) ─────────────

/** Built-in kernel commands surfaced read-only in the Commands page. */
const BUILTIN_COMMANDS = [
  { name: 'compact', description: '压缩当前会话上下文', source: '内置' },
  { name: 'goal', description: '设定或查看当前会话目标', source: '内置' },
  { name: 'review', description: '复查最近的改动', source: '内置' },
]

/** User commands live in the skill root — a command IS a skill in this harness. */
function skillsRootDir() {
  return path.join(DSH_HOME, 'skills')
}

/** Create one command (a prompt-template skill) from name + template body. */
function createCommand(input) {
  if (input === null || typeof input !== 'object') return { error: '缺少参数' }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) {
    return { error: '名称需为小写字母/数字开头，最多 48 位小写字母、数字、下划线或连字符' }
  }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const template = typeof input.template === 'string' ? input.template : ''
  if (template.trim() === '') return { error: '命令模板不能为空' }
  const dir = path.join(skillsRootDir(), name)
  if (fs.existsSync(dir)) return { error: '该命令已存在' }
  fs.mkdirSync(dir, { recursive: true })
  const frontmatter = ['---', `name: ${name}`, description !== '' ? `description: ${description}` : null, '---', '', template.trim(), '']
    .filter(line => line !== null)
    .join('\n')
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter, 'utf8')
  return { ok: true, name }
}

/** Delete one user command (a skill directory; path-scoped). */
function removeCommand(name) {
  return removeSkill(name)
}

// ── Hooks (ZCode-compatible hooks.json driven by dsh-hooks-claude-code) ─────

const HOOKS_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop']

function hooksFilePath() {
  return path.join(DSH_HOME, 'hooks.json')
}

function readHooksFile() {
  try {
    const data = JSON.parse(fs.readFileSync(hooksFilePath(), 'utf8'))
    return data && typeof data === 'object' && data.hooks && typeof data.hooks === 'object' ? data : { hooks: {} }
  } catch {
    return { hooks: {} }
  }
}

/** Flatten the nested hooks.json into row form for the settings page. */
function scanHooks() {
  const data = readHooksFile()
  const rows = []
  for (const event of Object.keys(data.hooks)) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : []
    groups.forEach((group, groupIndex) => {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : []
      hooks.forEach((hook, hookIndex) => {
        rows.push({
          id: `${event}#${groupIndex}#${hookIndex}`,
          event,
          matcher: typeof group.matcher === 'string' ? group.matcher : '',
          command: typeof hook.command === 'string' ? hook.command : '',
          timeout: typeof hook.timeout === 'number' ? hook.timeout : undefined,
          disabled: hook.disabled === true,
        })
      })
    })
  }
  return rows
}

/** Append one hook entry (event/matcher/command/timeout). */
function addHook(input) {
  if (input === null || typeof input !== 'object') return { error: '缺少参数' }
  const event = typeof input.event === 'string' ? input.event : ''
  if (!HOOKS_EVENTS.includes(event)) return { error: '事件需为：' + HOOKS_EVENTS.join(', ') }
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (command === '') return { error: '命令不能为空' }
  const data = readHooksFile()
  if (!Array.isArray(data.hooks[event])) data.hooks[event] = []
  const entry = { matcher: typeof input.matcher === 'string' ? input.matcher : '', hooks: [{ type: 'command', command }] }
  if (Number.isFinite(input.timeout) && input.timeout > 0) entry.hooks[0].timeout = Math.round(input.timeout)
  data.hooks[event].push(entry)
  fs.writeFileSync(hooksFilePath(), JSON.stringify(data, null, 2), 'utf8')
  syncHooksPatch()
  return { ok: true }
}

/** Toggle one hook entry's disabled flag. */
function setHookEnabled(id, enabled) {
  const match = /^(.+)#(\d+)#(\d+)$/.exec(typeof id === 'string' ? id : '')
  if (match === null) return { error: '标识不合法' }
  const data = readHooksFile()
  const group = (data.hooks[match[1]] ?? [])[Number(match[2])]
  const hook = group?.hooks?.[Number(match[3])]
  if (hook === undefined) return { error: '未找到该钩子' }
  if (enabled) delete hook.disabled
  else hook.disabled = true
  fs.writeFileSync(hooksFilePath(), JSON.stringify(data, null, 2), 'utf8')
  return { ok: true }
}

/** Remove one hook entry by id. */
function removeHook(id) {
  const match = /^(.+)#(\d+)#(\d+)$/.exec(typeof id === 'string' ? id : '')
  if (match === null) return { error: '标识不合法' }
  const data = readHooksFile()
  const groups = data.hooks[match[1]]
  const group = groups?.[Number(match[2])]
  const hooks = group?.hooks
  if (!Array.isArray(hooks) || hooks[Number(match[3])] === undefined) return { error: '未找到该钩子' }
  hooks.splice(Number(match[3]), 1)
  if (hooks.length === 0) groups.splice(Number(match[2]), 1)
  if (groups.length === 0) delete data.hooks[match[1]]
  fs.writeFileSync(hooksFilePath(), JSON.stringify(data, null, 2), 'utf8')
  syncHooksPatch()
  return { ok: true }
}

/**
 * Keep the profile patch row for dsh-hooks-claude-code in step with the
 * hooks file: the row exists only while hooks.json does, so the kernel's
 * hook bridge loads exactly when the user has hooks configured.
 */
function syncHooksPatch() {
  const webPatch = path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  try {
    fs.mkdirSync(path.dirname(webPatch), { recursive: true })
    let existing = ''
    try { existing = fs.readFileSync(webPatch, 'utf8') } catch { /* first write */ }
    const rowBlock = [
      '- id: hooks-claude-code',
      '  name: \'@deepseek-ai/dsh-hooks-claude-code\'',
      '  config:',
      `    configPath: ${yamlValue(hooksFilePath())}`,
    ].join('\n')
    const marker = '# desktop-shell hooks bridge (managed)'
    const without = existing
      .replace(new RegExp(marker + '\\n[\\s\\S]*?(?=\\n[^ \\t#-]|\\n$|$)'), '')
      .replace(marker + '\n', '')
      .trimEnd()
    const hasHooks = fs.existsSync(hooksFilePath())
    const next = hasHooks ? (without === '' ? rowBlock : without + '\n\n' + rowBlock) : without
    if (next !== existing) fs.writeFileSync(webPatch, next.endsWith('\n') || next === '' ? next : next + '\n', 'utf8')
  } catch { /* patch layer is optional */ }
}

// ── Git panel (read-only projection over one working tree) ──────────────────

const { execFile, execFileSync } = require('node:child_process')

/** Run one git command in dir; resolves { stdout } or rejects with stderr. */
function gitRun(dir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(String(stderr || error.message).trim()))
        return
      }
      resolve({ stdout })
    })
  })
}

/** Project one working tree's branch, short status, and recent log. */
async function scanGit(dir) {
  const resolved = path.resolve(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : DSH_HOME)
  if (!fs.existsSync(resolved)) return { error: '目录不存在' }
  try {
    const [branch, status, log, branches] = await Promise.all([
      gitRun(resolved, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' })),
      gitRun(resolved, ['status', '--porcelain']).catch(() => ({ stdout: '' })),
      gitRun(resolved, ['log', '--oneline', '-10']).catch(() => ({ stdout: '' })),
      gitRun(resolved, ['branch', '--list']).catch(() => ({ stdout: '' })),
    ])
    if (branch.stdout.trim() === '') return { error: '该目录不是 git 仓库' }
    const statusLines = status.stdout.split('\n').filter(line => line.trim() !== '')
    return {
      path: resolved,
      branch: branch.stdout.trim(),
      changes: statusLines.map(line => ({
        code: line.slice(0, 2).trim(),
        file: line.slice(3).trim(),
        staged: line[0] !== ' ' && line[0] !== '?',
      })),
      log: log.stdout.split('\n').filter(line => line.trim() !== ''),
      branches: branches.stdout.split('\n').map(line => line.trim().replace(/^\* /, '')).filter(line => line !== ''),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Workspaces known to the harness: one entry per distinct session cwd,
 * parsed from each session log's header line. This backs the Git page's
 * workspace selector — no path typing required.
 */
function scanWorkspaces() {
  const sessionsRoot = path.join(DSH_HOME, 'sessions')
  const byPath = new Map()
  let entries = []
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let subs = []
    try {
      subs = fs.readdirSync(path.join(sessionsRoot, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const logFile = path.join(sessionsRoot, entry.name, sub.name, 'session.jsonl')
      let first = ''
      try {
        const fd = fs.openSync(logFile, 'r')
        const buffer = Buffer.alloc(4096)
        const read = fs.readSync(fd, buffer, 0, 4096, 0)
        fs.closeSync(fd)
        first = buffer.toString('utf8', 0, read).split('\n')[0]
      } catch {
        continue
      }
      let header
      try {
        header = JSON.parse(first)
      } catch {
        continue
      }
      if (typeof header.cwd !== 'string' || header.cwd === '') continue
      const existing = byPath.get(header.cwd)
      const createdAt = typeof header.createdAt === 'string' ? header.createdAt : ''
      if (existing === undefined) {
        byPath.set(header.cwd, { path: header.cwd, name: path.basename(header.cwd) || header.cwd, sessions: 1, lastActive: createdAt })
      } else {
        existing.sessions += 1
        if (createdAt > existing.lastActive) existing.lastActive = createdAt
      }
    }
  }
  // Active workspaces only: archived/idle session roots stay out of the Git
  // page's selector (they are managed on the Archive page instead).
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
  return [...byPath.values()]
    .filter(row => row.lastActive === '' || Date.parse(row.lastActive) > cutoff)
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
    .slice(0, 20)
}

// ── Session archive (move idle session logs out of the live root) ──────

/**
 * Session display titles from the kernel's projection cache: one map entry
 * per titled session. Untitled sessions resolve to a short id on the page.
 */
function scanSessionTitles() {
  const cacheFile = path.join(DSH_HOME, 'storages', 'session_projcache.json')
  const titles = {}
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    const sessions = data?.tables?.sessions
    if (sessions !== null && typeof sessions === 'object') {
      for (const [sessionId, row] of Object.entries(sessions)) {
        const value = row?.rows?.title?.val
        if (typeof value === 'string' && value !== '') titles[sessionId] = value
      }
    }
  } catch { /* no cache */ }
  // Untitled sessions display like the sidebar does: the workspace's current
  // git branch. Cache per cwd to avoid a git call per session.
  const branchCache = new Map()
  const sessionsRoot = path.join(DSH_HOME, 'sessions')
  let groups = []
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return titles
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(sessionsRoot, group.name)
    let subs = []
    try {
      subs = fs.readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory() || titles[sub.name] !== undefined) continue
      const logFile = path.join(groupDir, sub.name, 'session.jsonl')
      let cwd = ''
      try {
        const fd = fs.openSync(logFile, 'r')
        const buffer = Buffer.alloc(4096)
        const read = fs.readSync(fd, buffer, 0, 4096, 0)
        fs.closeSync(fd)
        cwd = JSON.parse(buffer.toString('utf8', 0, read).split(String.fromCharCode(10))[0]).cwd ?? ''
      } catch {
        continue
      }
      if (cwd === '') continue
      let branch = branchCache.get(cwd)
      if (branch === undefined) {
        branch = ''
        try {
          branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd, timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
          }).toString().trim()
        } catch { /* not a repo */ }
        branchCache.set(cwd, branch)
      }
      if (branch !== '') titles[sub.name] = branch
    }
  }
  return titles
}

const ARCHIVE_ROOT = path.join(DSH_HOME, 'sessions-archive')

/** List every session under the live and archive roots for the Archive page. */
function scanArchive() {
  // Truth = the registry: which sessions belong to a registered workspace and
  // which are archived. The filesystem holds every historical session dir,
  // including orphans the registry no longer accounts — those are surfaced
  // separately as "unclassified" so the management page stays in sync with
  // the sidebar (registered workspaces only), while orphans stay cleanable.
  let archivedSet = new Set()
  const workspaceBySession = new Map()
  const registeredSessionIds = new Set()
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'))
    const list = registry?.global?.archivedSessionIds
    if (Array.isArray(list)) archivedSet = new Set(list)
    const workspaces = registry?.tables?.workspaces ?? {}
    for (const workspace of Object.values(workspaces)) {
      const title = typeof workspace?.title === 'string' ? workspace.title : ''
      for (const sessionId of workspace?.sessionIds ?? []) {
        registeredSessionIds.add(sessionId)
        if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, title)
      }
    }
  } catch { /* no registry yet */ }
  const rows = []
  const unclassified = []
  const sessionsRoot = path.join(DSH_HOME, 'sessions')
  let groups = []
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return { sessions: rows, unclassified }
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = path.join(sessionsRoot, group.name)
    let subs = []
    try {
      subs = fs.readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const subDir = path.join(groupDir, sub.name)
      let size = 0
      let mtime = 0
      try {
        for (const file of fs.readdirSync(subDir)) {
          try { size += fs.statSync(path.join(subDir, file)).size } catch { /* skip */ }
        }
        mtime = fs.statSync(subDir).mtimeMs
      } catch { /* skip */ }
      console.log('[scanArchive-debug2]', JSON.stringify({ sub: sub.name.slice(0, 12), arch: archivedSet.has(sub.name), setSize: archivedSet.size, setSample: [...archivedSet].slice(0, 2).map(x => x.slice(0, 12)) }))
      const row = {
        group: group.name,
        workspaceTitle: workspaceBySession.get(sub.name) ?? group.name,
        sessionId: sub.name,
        size,
        mtime,
        archived: archivedSet.has(sub.name),
      }
      if (registeredSessionIds.has(sub.name)) {
        rows.push(row)
      } else {
        unclassified.push(row)
      }
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  unclassified.sort((a, b) => b.mtime - a.mtime)
  return { sessions: rows, unclassified }
}

/** Flip one session's archive flag in the registry file (no restart). */
function toggleArchivedFlag(sessionId) {
  const registryFile = path.join(DSH_HOME, 'storages', 'workspace.json')
  try {
    const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    const list = data?.global?.archivedSessionIds
    if (!Array.isArray(list)) return { error: '归档注册表不可读' }
    const index = list.indexOf(sessionId)
    if (index === -1) list.push(sessionId)
    else list.splice(index, 1)
    fs.writeFileSync(registryFile, JSON.stringify(data, null, 1), 'utf8')
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function modifyArchivedSessions(sessionId, remove) {
  const registryFile = path.join(DSH_HOME, 'storages', 'workspace.json')
  try {
    const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    const list = data?.global?.archivedSessionIds
    if (!Array.isArray(list)) return { error: '归档注册表不可读' }
    const index = list.indexOf(sessionId)
    if (remove === true) {
      if (index !== -1) list.splice(index, 1)
    } else if (index === -1) {
      list.push(sessionId)
    }
    fs.writeFileSync(registryFile, JSON.stringify(data, null, 1), 'utf8')
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}



/** Archive/restore one session by flipping its id in the registry's archive
 *  set on disk. No restart: the desktop page drives archive state through the
 *  kernel RPC (instant, broadcast); these file-level helpers are only a
 *  fallback for the raw dialog endpoints and take effect on next boot. */
/** Call one dsh Gateway Remote endpoint through the server's token URL. */
async function dshRemote(endpoint, payload) {
  if (serverUrl === null) throw new Error('dsh 服务器未就绪')
  const url = new URL(serverUrl)
  const token = url.searchParams.get('token')
  const target = new URL(url.origin + '/remotes/' + endpoint)
  if (token !== null) target.searchParams.set('token', token)
  const message = {
    type: 'client-request',
    rpcId: 'desktop-' + Date.now().toString(36),
    method: endpoint,
    payload,
  }
  const response = await fetch(target.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
  const text = await response.text()
  console.log(`[dsh-rpc] ${endpoint} -> ${response.status} ${text.slice(0, 160)}`)
  if (!response.ok) {
    throw new Error(`remote ${endpoint} failed: HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Archive/restore one session through the kernel's own toggle RPC. */
async function dshArchiveSession(sessionId) {
  if (typeof sessionId !== 'string' || !/^(session-)?[\w-]+$/.test(sessionId)) return { error: '标识不合法' }
  try {
    const result = await dshRemote('workspace/archiveSession', { sessionId })
    if (result === null) return { ok: true }
    const error = result?.error
    if (error !== undefined && error !== null) {
      return { error: typeof error === 'string' ? error : JSON.stringify(error) }
    }
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function dshArchiveSessionFile(sessionId, wantArchived) {
  if (typeof sessionId !== 'string' || !/^(session-)?[\w-]+$/.test(sessionId)) return { error: '标识不合法' }
  const result = modifyArchivedSessions(sessionId, !wantArchived)
  if (result.error !== undefined) return result
  return { ok: true }
}

/** Restore one archived session via the file-level fallback. */
function restoreArchivedSession(sessionId) {
  return dshArchiveSessionFile(sessionId, false)
}

/** Archive one session via the file-level fallback. */
function archiveSessionFlag(sessionId) {
  return dshArchiveSessionFile(sessionId, true)
}

/** Remove one session id from every workspace's sessionIds in the registry file. */
function removeSessionFromRegistry(sessionId) {
  const registryFile = path.join(DSH_HOME, 'storages', 'workspace.json')
  try {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    const workspaces = registry?.tables?.workspaces ?? {}
    let changed = false
    for (const workspace of Object.values(workspaces)) {
      const ids = workspace?.sessionIds
      if (Array.isArray(ids) && ids.includes(sessionId)) {
        workspace.sessionIds = ids.filter(id => id !== sessionId)
        changed = true
      }
    }
    if (changed) fs.writeFileSync(registryFile, JSON.stringify(registry, null, 1), 'utf8')
  } catch { /* best-effort */ }
}

/** Permanently delete one session: remove its log dirs, clear its archive
 *  flag, AND unlist it from every workspace's sessionIds so the ghost cannot
 *  reappear. */
function deleteArchiveSession(group, sessionId) {
  if (typeof sessionId !== 'string' || !/^(session-)?[\w-]+$/.test(sessionId)) return { error: '标识不合法' }
  deleteSessionDirectories(sessionId)
  modifyArchivedSessions(sessionId, true)
  removeSessionFromRegistry(sessionId)
  // Bounce so the running kernel re-reads the registry and the sidebar
  // (which lists sessions from the registry) hides the deleted session.
  scheduleServerRestart()
  return { ok: true }
}

/** Rendered git graph (ASCII commit graph across all branches). */
async function scanGitGraph(dir) {
  const resolved = path.resolve(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : DSH_HOME)
  if (!fs.existsSync(resolved)) return { error: '目录不存在' }
  try {
    const [text, nodes] = await Promise.all([
      gitRun(resolved, [
        'log', '--graph', '--oneline', '--all', '--decorate', '-40',
      ]).catch(() => ({ stdout: '' })),
      gitRun(resolved, [
        'log', '--all', '-40',
        '--pretty=format:%H%x1f%P%x1f%h%x1f%s%x1f%D%x1f%ad%x1f%an',
        '--date=format:%m/%d %H:%M',
      ]).catch(() => ({ stdout: '' })),
    ])
    const commits = nodes.stdout.split('\n').filter(line => line.trim() !== '').map(line => {
      const [hash, parents, short, subject, refs, date, author] = line.split('\x1f')
      return {
        hash,
        parents: typeof parents === 'string' && parents !== '' ? parents.split(' ') : [],
        short: short ?? '',
        subject: subject ?? '',
        refs: refs ?? '',
        date: date ?? '',
        author: author ?? '',
      }
    })
    return { path: resolved, graph: text.stdout, commits }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Create-and-checkout (or plain checkout) one branch. */
async function gitCheckoutBranch(dir, branch, create) {
  const resolved = path.resolve(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : DSH_HOME)
  if (!fs.existsSync(resolved)) return { error: '目录不存在' }
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._\/-]{1,80}$/.test(branch)) return { error: '分支名不合法' }
  try {
    const args = create === true ? ['checkout', '-b', branch] : ['checkout', branch]
    const { stdout } = await gitRun(resolved, args)
    return { ok: true, output: stdout.trim() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Switch one working tree to another branch (creating it when asked). */
async function gitCheckout(dir, branch, create) {
  const resolved = path.resolve(typeof dir === 'string' ? dir : '')
  if (!fs.existsSync(resolved)) return { error: '目录不存在' }
  if (typeof branch !== 'string' || !/^[\w./-]+$/.test(branch)) return { error: '分支名不合法' }
  try {
    const args = create === true ? ['checkout', '-b', branch] : ['checkout', branch]
    await gitRun(resolved, args)
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Pull the current branch (update project). */
async function gitPull(dir) {
  const resolved = path.resolve(typeof dir === 'string' ? dir : '')
  try {
    const { stdout } = await gitRun(resolved, ['pull', '--no-edit'])
    return { ok: true, output: stdout.trim() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Push the current branch (publish project). */
async function gitPush(dir) {
  const resolved = path.resolve(typeof dir === 'string' ? dir : '')
  try {
    const head = await gitRun(resolved, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = head.stdout.trim()
    const { stdout } = await gitRun(resolved, ['push', '-u', 'origin', branch])
    return { ok: true, output: stdout.trim() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Stage the named files and commit with the given message. */
async function gitCommit(dir, files, message) {
  const resolved = path.resolve(typeof dir === 'string' ? dir : '')
  if (!Array.isArray(files) || files.length === 0) return { error: '未选择要提交的文件' }
  if (typeof message !== 'string' || message.trim() === '') return { error: '提交信息不能为空' }
  if (message.includes('\n')) return { error: '提交信息需为单行' }
  try {
    await gitRun(resolved, ['add', '--', ...files])
    const { stdout } = await gitRun(resolved, ['commit', '-m', message.trim()])
    return { ok: true, output: stdout.trim() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ── File browser (sidebar file panel) ────────────────────────────────────────

/** List one directory's entries with type and size. */
function scanFiles(dir) {
  const resolved = path.resolve(typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : os.homedir())
  if (!fs.existsSync(resolved)) return { error: '目录不存在' }
  let stat
  try { stat = fs.statSync(resolved) } catch { return { error: '无法读取该路径' } }
  if (!stat.isDirectory()) return { error: '不是目录' }
  let entries = []
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const rows = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(resolved, entry.name)
    let size = 0
    try { size = entry.isDirectory() ? 0 : fs.statSync(full).size } catch { /* unreadable — size 0 */ }
    rows.push({ name: entry.name, dir: entry.isDirectory(), size })
  }
  rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return { path: resolved, entries: rows.slice(0, 500) }
}

/** Read one text file's head for preview (bounded). */
function readTextFileHead(filePath) {
  const resolved = path.resolve(typeof filePath === 'string' ? filePath : '')
  if (resolved === '' || !fs.existsSync(resolved)) return { error: '文件不存在' }
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) return { error: '是目录' }
  if (stat.size > 512 * 1024) return { error: '文件过大，无法预览' }
  try {
    return { path: resolved, content: fs.readFileSync(resolved, 'utf8').slice(0, 200000) }
  } catch {
    return { error: '无法以文本读取' }
  }
}

// ── Terminal (HTTP command panel; per-panel cwd kept server-side) ────────────

// ── Terminal (real PTY via node-pty; SSE output, POST input) ────────────────

let ptyLib = null

/** Lazily resolve the bundled node-pty (native module ships with the kernel). */
function getPty() {
  if (ptyLib === null) {
    ptyLib = require(path.join(__dirname, 'resources', 'dsh', 'node_modules', 'node-pty'))
  }
  return ptyLib
}

const ptySessions = new Map()
let terminalSeq = 0

/** Spawn (or reuse) the persistent shell behind one terminal panel. */
function ensurePty(panelId) {
  let session = ptySessions.get(panelId)
  if (session !== undefined) return session
  const isWin = process.platform === 'win32'
  const file = isWin ? 'powershell.exe' : 'bash'
  const pty = getPty().spawn(file, isWin ? ['-NoProfile', '-NoLogo'] : [], {
    name: 'xterm-256color',
    cols: 110,
    rows: 30,
    cwd: DSH_HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
    experimentalWin32Process: true,
    useConpty: true,
  })
  session = { pty, backlog: '', clients: new Set(), exited: false }
  pty.onData((data) => {
    session.backlog += data
    if (session.backlog.length > 400000) session.backlog = session.backlog.slice(-200000)
    for (const res of session.clients) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch { /* client gone */ }
    }
  })
  pty.onExit(() => {
    session.exited = true
    for (const res of session.clients) {
      try { res.write('data: [EXITED]\n\n'); res.end() } catch { /* already gone */ }
    }
    ptySessions.delete(panelId)
  })
  ptySessions.set(panelId, session)
  return session
}

/** Strip the ambient child-process spawn inside the app so hidden consoles
 *  stay hidden even from the PTY's grandchildren. */
function teardownPtySessions() {
  for (const [, session] of ptySessions) {
    try { session.pty.kill() } catch { /* already gone */ }
  }
  ptySessions.clear()
}

/**
 * Seed the per-user settings on first launch: pin the light theme and select
 * the built-in DeepSeek agent (deepseek-official / deepseek-v4-flash) as the
 * default model, so a fresh install only needs its own DeepSeek API key.
 * Existing user settings are never overwritten.
 */
/** Purge ghost session ids: every registry reference whose log directory
 *  no longer exists on disk is unlisted from its workspace and the archive
 *  set. Runs at boot so lists stay in sync with reality. */
function purgeGhostSessions() {
  const registryFile = path.join(DSH_HOME, 'storages', 'workspace.json')
  if (!fs.existsSync(registryFile)) return
  const sessionsRoot = path.join(DSH_HOME, 'sessions')
  const onDisk = new Set()
  try {
    for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      for (const sub of fs.readdirSync(path.join(sessionsRoot, group.name))) {
        onDisk.add(sub)
      }
    }
  } catch {
    return
  }
  let changed = false
  try {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    const workspaces = registry?.tables?.workspaces ?? {}
    for (const workspace of Object.values(workspaces)) {
      const ids = workspace?.sessionIds
      if (Array.isArray(ids)) {
        const kept = ids.filter(id => onDisk.has(id))
        if (kept.length !== ids.length) {
          workspace.sessionIds = kept
          changed = true
        }
      }
    }
    const archived = registry?.global?.archivedSessionIds
    if (Array.isArray(archived)) {
      const kept = archived.filter(id => onDisk.has(id))
      if (kept.length !== archived.length) {
        registry.global.archivedSessionIds = kept
        changed = true
      }
    }
    if (changed) fs.writeFileSync(registryFile, JSON.stringify(registry, null, 1), 'utf8')
  } catch { /* best-effort */ }
}

function seedDshHome() {
  fs.mkdirSync(DSH_HOME, { recursive: true })
  const settingsFile = path.join(DSH_HOME, 'settings.yaml')
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, [
      'ui-theme:',
      '  preference: light',
      'agent-default-model:',
      '  provider: deepseek-official',
      '  model: deepseek-v4-flash',
      '  reasoningEffort: high',
      '',
    ].join('\n'), 'utf8')
  }
}

/**
 * Background-only artwork, injected once the real UI is up (so the loading
 * page stays clean). The image lives on the root canvas behind a white veil;
 * the stock white panels keep only a slight translucency, and blur softens
 * the artwork behind them so text stays crisp.
 */
const BACKGROUND_CSS = `
/* 记忆系统侧边栏图标与其他面板（任务看板/SSH/技能中心）统一：
   图标 18px、图标容器 24px、内边距 10px、图标与文字间距 8px，
   让四个入口的文字首字对齐。 */
button[data-dsh-ssh-entry] {
  gap: 8px !important;
}
/* 侧边栏收起时：统一所有图标按钮的高度和间距，防止图标列错位 */
body[data-dsh-sidebar-collapsed] [class*="nArs4W_panel"] button {
  height: 36px !important;
  min-height: 36px !important;
  max-height: 36px !important;
  width: 36px !important;
  padding: 0 !important;
  margin: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  border-radius: 50% !important;
}
body[data-dsh-sidebar-collapsed] [class*="nArs4W_panel"] button svg,
body[data-dsh-sidebar-collapsed] [class*="nArs4W_panel"] button [class*="icon"] svg {
  width: 18px !important;
  height: 18px !important;
  flex: none !important;
}
html:not([data-dsh-skin]) {
  background-color: #ffffff;
}
html:not([data-dsh-skin]) body:not([data-ds-dark-theme]) {
  background: transparent !important;
}
/* Light palette: only applied when the app is in light mode. */
html:not([data-dsh-skin]) body:not([data-ds-dark-theme]) {
  --dsw-alias-bg-base: rgba(255, 255, 255, 0.42) !important;
  --dsw-alias-bg-layer-1: #ffffff !important;
  --dsw-alias-bg-layer-2: #ffffff !important;
  --dsw-alias-bg-layer-3: #ffffff !important;
  --dsw-alias-bg-overlay: #ffffff !important;
  --dsw-alias-bg-module-platform: #ffffff !important;
  --dsw-alias-bg-multi-select: #ffffff !important;
  --dsw-specific-sidebar-fill: rgba(255, 255, 255, 0.45) !important;
  --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.64) !important;
  --dsw-specific-input-major: #ffffff !important;
  --dsw-specific-login-input: #ffffff !important;
  --dsw-specific-menu: #ffffff !important;
  --dsw-specific-selector: #ffffff !important;
  --dsw-alias-markdown-code-block: #ffffff !important;
  --dsw-alias-markdown-code-block-banner: #ffffff !important;
  --dsw-alias-markdown-inline-code: #ffffff !important;
  --dsw-alias-markdown-placeholder: #ffffff !important;
  --dsw-alias-markdown-tag: #ffffff !important;
  --dsw-alias-markdown-citation: #ffffff !important;
}
/* Dark mode: the app's dark palette owns the surfaces. */
body[data-ds-dark-theme] {
  background-color: #0b0e14 !important;
}
html:has(body[data-ds-dark-theme]) {
  background-color: #0b0e14;
}
/* Sidebar and bottom panel share the main chat area's glass base, so the
   background art reads through all three consistently. */
#root div[style*="grid-template-columns"] > div:first-child {
  background: var(--dsw-alias-bg-base) !important;
}
/* Modal surfaces stay opaque: stack the skin's overlay color a few times so
   translucent skin tokens can never make settings/other dialogs see-through,
   while dark skins still get their own dark surface. */
[role="dialog"] {
  background-image:
    linear-gradient(var(--dsw-alias-bg-overlay, #ffffff), var(--dsw-alias-bg-overlay, #ffffff)),
    linear-gradient(var(--dsw-alias-bg-overlay, #ffffff), var(--dsw-alias-bg-overlay, #ffffff)) !important;
  background-color: var(--dsw-alias-bg-overlay, #ffffff) !important;
  backdrop-filter: none !important;
}
/* Bottom panel: translucent so the background art shows through. */
[class*="nArs4W_bottomPanel"] {
  background: var(--dsw-alias-bg-base) !important;
  min-height: 120px !important;
}
[class*="nArs4W_bottomPanel"] .xterm-viewport,
[class*="nArs4W_bottomPanel"] .xterm-screen {
  background: transparent !important;
}
/* The expanded right/bottom workbenches follow the glass theme too: the
   outer panel carries the translucent fill, inner panes/tab bars stay
   transparent so the wallpaper is not dimmed twice. */
html[data-dsh-aqua] [class~="nArs4W_panel"],
html[data-dsh-aqua] [class*="nArs4W_bottomPanel"] {
  background: var(--dsw-alias-bg-base, rgba(255, 255, 255, 0.42)) !important;
}
html[data-dsh-aqua] [class~="nArs4W_pane"],
html[data-dsh-aqua] [class*="nArs4W_tabBar"],
html[data-dsh-aqua] [class*="nArs4W_terminalWrap"] {
  background: transparent !important;
}
/* Tooltips keep their own solid ink: the shared [class*='bubble'] glass rule
   would otherwise paint them white-on-white. */
html[data-dsh-aqua] [role='tooltip'] {
  background: var(--dsw-alias-tooltip-bg, #13243E) !important;
  border: none !important;
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
  border-radius: 8px !important;
}
/* 桌宠对话气泡：恢复插件自带的深色/蓝色背景和浅色文字，避免被玻璃皮肤的
   [class*=bubble] 规则改成半透明白（浅色模式下文字会看不见）。 */
html[data-dsh-aqua] [class*="kz2Bea_bubble"] {
  color: #f4f7ff !important;
}
html[data-dsh-aqua] [class*="kz2Bea_bubbleStatus"] {
  background: linear-gradient(160deg, #131c36e6, #070b1af0) !important;
}
html[data-dsh-aqua] [class*="kz2Bea_bubblePet"] {
  background: #4d6bfef2 !important;
}
html[data-dsh-aqua] [class*="kz2Bea_bubbleFeed"] {
  background: #0369a1f2 !important;
}
/* 兼容模式与云母模式保持一致的顶部对齐：去掉 better-sidebar 为标题栏预留的
   40px 内边距，侧边栏内容（展开侧边栏 / sessionlog）不再整体下移。 */
body[data-dsh-title-bar-compat] [class*="nArs4W_panel"] {
  padding-top: 0 !important;
}
body[data-dsh-title-bar-compat] .nArs4W_toggleCluster {
  top: calc(var(--dsh-title-bar-strip, 40px) + 3px) !important;
}
/* 云母模式：展开侧边栏/展开底部两个按钮略微下移（避免贴顶）。 */
html[data-dsh-float] .nArs4W_toggleCluster {
  top: 52px !important;
}
/* 设置弹窗在侧边栏栈内渲染：云母模式下侧边栏上下文 z-index 只有 9，
   把弹窗的 z-index 1000 封死在里面，导致设置显示在 SSH/任务看板
   （z-index 60）下方。把侧边栏上下文提到 70，设置弹窗就能盖住它们。 */
html[data-dsh-float] [class*="sidebarCol"] {
  z-index: 70 !important;
}
/* 兼容模式：侧边栏与底部面板保持毛玻璃（外层 + 内层表面都强制半透明），
   并确保壁纸层在最底层可见，避免出现纯白背景板。 */
html[data-dsh-compat] [class*="nArs4W_panel"],
html[data-dsh-compat] [class*="nArs4W_bottomPanel"],
html[data-dsh-compat] [class*="nArs4W_panelBody"],
html[data-dsh-compat] [class*="nArs4W_tabBar"],
html[data-dsh-compat] [class*="nArs4W_pane"] {
  background: var(--dsw-alias-bg-base, rgba(255, 255, 255, 0.42)) !important;
  -webkit-backdrop-filter: blur(12px) !important;
  backdrop-filter: blur(12px) !important;
}
html[data-dsh-compat] [data-dsh-aqua-wallpaper-layer] {
  display: block !important;
  z-index: -1 !important;
}
/* While any sidebar/bottom-panel drag is active, layout changes snap instead
   of animating, so panels never lag or overlap mid-drag. */
body[data-dsh-sidebar-dragging] #root div[style*="grid-template-columns"],
body[data-dsh-sidebar-dragging] #root div[style*="grid-template-columns"] > div:nth-child(2) {
  transition: none !important;
}
/* Softer, rounder corners for the file-name/path inputs and terminal tabs. */
[class~="nArs4W_editorPathInput"],
[class~="nArs4W_editorSearchInput"],
[class~="nArs4W_browserInput"] {
  border-radius: 10px !important;
}
[class~="nArs4W_tab"] {
  border-radius: 8px !important;
}
/* Aqua float layout: keep the top-right panel toggles inside the glass
   header and drop the header's title row below the drag strip. */
[class~="nArs4W_toggleCluster"] {
  right: var(--dse-cluster-right, 30px) !important;
  top: calc(var(--dsh-title-bar-strip, 40px) + 11px) !important;
  /* Same layer as the session header/log, so settings dialogs (rendered in
     the sidebar stack above it) are never blocked by these two buttons. */
  z-index: 8 !important;
}
/* Hide the bottom-left quick actions; the mobile remote control entry now
   lives inside 设置 (see .dse-remote-card), so no stray buttons remain. */
button[aria-label="检查更新"],
button[aria-label="移动端远程控制"],
button[aria-label="远程访问"] {
  display: none !important;
}
/* 0.2.4 pet settings card: the header row is width:100% + padding without
   border-box, so the unsaved badge gets pushed outside the card edge. */
[class*="kKk9aW_headerStatic"],
[class*="kKk9aW_header"] {
  box-sizing: border-box !important;
}
/* Keep the header's right-aligned utilities (Session log) clear of the two
   toggle buttons whether the panel is open or collapsed. */
[data-slot="conversation.session.header"] > header {
  padding-right: 78px !important;
}
[class~="wSkVaW_headerUtilities"] {
  margin-right: 8px !important;
  margin-top: 26px !important;
}
[class~="wSkVaW_titleRow"] {
  margin-top: 26px !important;
}
/* Skill center: glassmorphism matching the Aqua theme. */
[class*="cBrkua_card"] {
  background: rgba(255, 255, 255, 0.72) !important;
  -webkit-backdrop-filter: blur(24px) saturate(150%) !important;
  backdrop-filter: blur(24px) saturate(150%) !important;
  border: 1px solid rgba(255, 255, 255, 0.6) !important;
  border-radius: 20px !important;
  box-shadow: 0 18px 60px rgba(18, 24, 42, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.85) !important;
}
[class*="cBrkua_overlay"] {
  background: rgba(10, 16, 30, 0.42) !important;
  -webkit-backdrop-filter: blur(4px) !important;
  backdrop-filter: blur(4px) !important;
}
[class~="cBrkua_head"] {
  background: rgba(255, 255, 255, 0.32) !important;
  border-bottom: 1px solid rgba(255, 255, 255, 0.35) !important;
}
[class~="cBrkua_tabs"] {
  background: rgba(255, 255, 255, 0.22) !important;
}
[class~="cBrkua_tab"] {
  border-radius: 10px 10px 0 0 !important;
}
[class~="cBrkua_tabActive"] {
  background: rgba(255, 255, 255, 0.55) !important;
  -webkit-backdrop-filter: blur(10px) !important;
  backdrop-filter: blur(10px) !important;
}
[class~="cBrkua_skill"] {
  background: rgba(255, 255, 255, 0.38) !important;
  border: 1px solid rgba(255, 255, 255, 0.35) !important;
  border-radius: 12px !important;
}
[class~="cBrkua_headButton"],
[class~="cBrkua_formButton"] {
  border-radius: 10px !important;
  background: rgba(255, 255, 255, 0.5) !important;
}
[class~="cBrkua_formInput"],
[class~="cBrkua_formTextarea"] {
  border-radius: 10px !important;
  background: rgba(255, 255, 255, 0.45) !important;
}
[class~="cBrkua_badge"] {
  border-radius: 999px !important;
}
/* 技能中心“可调用：模型/用户”徽章：内核主题把成功色 token 设成
   绿底绿字，文字看不见。恢复插件本意的浅绿底 + 深绿字。 */
[class~="cBrkua_badgeInvokable"] {
  background: #ecfdf5 !important;
  color: #0f7a50 !important;
  border-color: #c9f0dd !important;
}
/* 技能中心弹窗：去掉一闪而过的生硬弹出，换成优雅的淡入 + 轻微上浮。 */
[class*="cBrkua_overlay"] {
  animation: dseSkillFade 0.18s ease-out !important;
}
[class*="cBrkua_card"] {
  animation: dseSkillPop 0.26s cubic-bezier(0.22, 1, 0.36, 1) !important;
}
@keyframes dseSkillFade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dseSkillPop {
  from { opacity: 0; transform: translateY(12px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
/* Dark-mode adjustments for injected glass surfaces. */
body[data-ds-dark-theme] [data-dse-slider] {
  --dse-ink: #e7edf6;
  --dse-muted: #9aa7b8;
  --dse-faint: #6f7c8f;
  --dse-glass: rgba(20, 24, 34, 0.92);
  --dse-glass-soft: rgba(24, 28, 40, 0.72);
}
body[data-ds-dark-theme] [data-dse-panel] {
  border-color: rgba(255, 255, 255, 0.14);
}
body[data-ds-dark-theme] [class*="cBrkua_card"] {
  background: rgba(24, 28, 40, 0.78) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
}
body[data-ds-dark-theme] [class~="cBrkua_head"],
body[data-ds-dark-theme] [class~="cBrkua_tabs"] {
  background: rgba(255, 255, 255, 0.05) !important;
}
body[data-ds-dark-theme] [class~="cBrkua_tabActive"] {
  background: rgba(255, 255, 255, 0.1) !important;
}
body[data-ds-dark-theme] [class~="cBrkua_skill"],
body[data-ds-dark-theme] [class~="cBrkua_headButton"],
body[data-ds-dark-theme] [class~="cBrkua_formButton"],
body[data-ds-dark-theme] [class~="cBrkua_formInput"],
body[data-ds-dark-theme] [class~="cBrkua_formTextarea"] {
  background: rgba(255, 255, 255, 0.07) !important;
  border-color: rgba(255, 255, 255, 0.12) !important;
}
`

/** Pin the document to the light scheme and strip the dark-theme marker. */
const THEME_GUARD = `(() => {})()`

/**
 * Thinking-effort slider shell: a frosted-glass pill next to the model picker
 * that opens a discrete slider panel. The pill mirrors the effort shown on
 * the stock model trigger ("Model · Effort"); the panel's stops are the real
 * effort names discovered from the app's own effort menu (fallback: a generic
 * five-level set). Selecting a stop drives the stock menu, so the choice is a
 * true session selection, not a cosmetic overlay.
 */
const EFFORT_SLIDER_CSS = `
[data-dse-slider] {
  --dse-blue: #4d6bfe;
  --dse-violet: #8b5cf6;
  --dse-cyan: #22d3ee;
  --dse-ink: #111827;
  --dse-muted: #667085;
  --dse-faint: #98a2b3;
  --dse-line: rgba(16, 24, 40, 0.09);
  --dse-glass: rgba(255, 255, 255, 0.88);
  --dse-glass-soft: rgba(255, 255, 255, 0.66);
  --dse-shadow: 0 24px 56px -14px rgba(15, 23, 42, 0.28), 0 4px 14px -4px rgba(15, 23, 42, 0.1);
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  max-width: none;
  overflow: visible;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
[data-dse-slider], [data-dse-slider] * {
  box-sizing: border-box;
}
/* The effort label on the stock model trigger ("Model · high") is now owned
   by the slider pill, so keep the trigger to just the model name. */
[data-composer-card] button[aria-haspopup="menu"] span[class*="triggerEffort"] {
  display: none !important;
}
[data-dse-slider] .dse-pill {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  height: 30px;
  min-width: max-content;
  padding: 0 8px;
  border-radius: 999px !important;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dse-ink);
  font: 500 12px/1.3 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  cursor: pointer;
  box-shadow: none;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease, background 0.18s ease, opacity 0.18s ease;
}
[data-dse-slider] .dse-pill:hover {
  background: rgba(255, 255, 255, 0.42);
  border-color: rgba(77, 107, 254, 0.28);
  box-shadow: 0 2px 8px -2px rgba(77, 107, 254, 0.18);
}
[data-dse-slider] .dse-pill:focus-visible {
  border-color: var(--dse-blue);
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.16);
}
[data-dse-slider] .dse-pill[aria-expanded='true'] {
  border-color: rgba(77, 107, 254, 0.38);
  background: rgba(255, 255, 255, 0.5);
  box-shadow: 0 2px 10px -2px rgba(77, 107, 254, 0.22);
}
[data-dse-slider] .dse-pill.dse-disabled {
  opacity: 0.55;
  cursor: not-allowed;
  filter: saturate(0.7);
}
[data-dse-slider] .dse-pill.dse-busy {
  opacity: 0.7;
  pointer-events: none;
}
[data-dse-slider] .dse-pill.dse-shake {
  animation: dseShake 0.4s ease;
}
@keyframes dseShake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  50% { transform: translateX(3px); }
  75% { transform: translateX(-2px); }
}
[data-dse-slider] .dse-ico {
  width: 14px;
  height: 14px;
  color: var(--dse-blue);
  flex: none;
}
[data-dse-slider] .dse-pill-word {
  color: var(--dse-muted);
  font-weight: 500;
}
[data-dse-slider] .dse-pill-value {
  max-width: none;
  overflow: visible;
  text-overflow: clip;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 1.5;
  font-weight: 600;
  color: var(--dse-ink);
}
[data-dse-slider] .dse-pill-value,
[data-dse-slider] .dse-title-val {
  position: relative;
}
[data-dse-slider] .dse-pill-value.dse-latin {
  top: 1px;
}
[data-dse-slider] .dse-title-val.dse-latin {
  top: 1.5px;
}
[data-dse-slider] .dse-chev {
  width: 12px;
  height: 12px;
  color: var(--dse-faint);
  transition: transform 0.2s ease;
}
[data-dse-slider] .dse-pill[aria-expanded='true'] .dse-chev {
  transform: rotate(180deg);
  color: var(--dse-blue);
}
[data-dse-slider] .dse-panel {
  position: fixed;
  z-index: 2147483000;
  width: 320px;
  border-radius: 20px;
  background: var(--dse-glass);
  -webkit-backdrop-filter: blur(26px) saturate(1.4);
  backdrop-filter: blur(26px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, 0.72);
  box-shadow: var(--dse-shadow);
  padding: 12px 12px 10px;
  transform-origin: top right;
  animation: dsePop 0.26s cubic-bezier(0.18, 1.25, 0.3, 1);
}
[data-dse-slider] .dse-panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: 18px;
  right: 18px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--dse-blue), var(--dse-violet), var(--dse-cyan));
  opacity: 0.85;
}
@keyframes dsePop {
  from { opacity: 0; transform: translateY(10px) scale(0.94); }
  to { opacity: 1; transform: none; }
}
[data-dse-slider] .dse-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
[data-dse-slider] .dse-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dse-ink);
}
[data-dse-slider] .dse-title .dse-ico {
  width: 15px;
  height: 15px;
}
[data-dse-slider] .dse-title-val {
  margin-left: 2px;
  font-size: 12px;
  line-height: 1.35;
  font-weight: 700;
  color: var(--dse-ink);
}
[data-dse-slider] .dse-title-val.dse-title-max,
[data-dse-slider] .dse-pill-value.dse-pill-max {
  color: transparent;
  background: linear-gradient(90deg, #4d6bfe, #8b5cf6, #ec4899, #f59e0b, #22d3ee, #4d6bfe);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  animation: dseMaxFlow 2.4s linear infinite, dseMaxBreath 2.4s ease-in-out infinite;
}
@keyframes dseMaxFlow {
  from { background-position: 0% 50%; }
  to { background-position: 300% 50%; }
}
@keyframes dseMaxBreath {
  0%, 100% { filter: drop-shadow(0 0 5px rgba(139, 92, 246, 0.35)) drop-shadow(0 0 12px rgba(34, 211, 238, 0.18)); }
  50% { filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.75)) drop-shadow(0 0 22px rgba(34, 211, 238, 0.5)); }
}
[data-dse-slider] .dse-title-val.dse-title-anim,
[data-dse-slider] .dse-pill-value.dse-pill-anim {
  animation: dseBlurIn 0.3s ease;
}
[data-dse-slider] .dse-title-val.dse-title-max.dse-title-anim,
[data-dse-slider] .dse-pill-value.dse-pill-max.dse-pill-anim {
  animation: dseBlurInMax 0.3s ease, dseMaxFlow 2.4s linear infinite, dseMaxBreath 2.4s ease-in-out infinite;
}
@keyframes dseBlurInMax {
  from { opacity: 0.2; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
@keyframes dseBlurIn {
  from { opacity: 0.2; filter: blur(5px); transform: translateY(2px); }
  to { opacity: 1; filter: blur(0); transform: none; }
}
[data-dse-slider] .dse-close {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--dse-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
[data-dse-slider] .dse-close:hover {
  background: rgba(77, 107, 254, 0.08);
  color: var(--dse-blue);
}
[data-dse-slider] .dse-track-wrap {
  position: relative;
  padding: 18px 4px 4px;
}
[data-dse-slider] .dse-track {
  position: relative;
  height: 30px;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
[data-dse-slider] .dse-track:focus-visible {
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.18);
}
[data-dse-slider] .dse-rail {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: #e5f0ff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    inset 0 0 0 1px rgba(80, 133, 194, 0.14),
    0 3px 10px rgba(48, 101, 165, 0.13);
}
[data-dse-slider] .dse-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #ffffff, #e2f0ff 20%, #a8d0fb 57%, #438fdf 100%);
  box-shadow: 0 0 12px rgba(67, 143, 223, 0.35);
  transform: scaleX(var(--dse-progress, 0));
  transform-origin: left center;
  transition: transform 190ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}
[data-dse-slider] .dse-track.dse-top .dse-fill {
  background: linear-gradient(90deg, #ffffff, #d7eaff 18%, #75afea 54%, #0751ad 100%);
  box-shadow: 0 0 18px rgba(31, 105, 201, 0.45);
}
[data-dse-slider] .dse-track.dse-top {
  animation: dseBreathe 1.9s ease-in-out infinite;
}
@keyframes dseBreathe {
  0%, 100% {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.9),
      inset 0 0 0 1px rgba(67, 124, 193, 0.16),
      0 3px 10px rgba(48, 101, 165, 0.13);
  }
  50% {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.96),
      inset 0 0 0 1px rgba(31, 102, 190, 0.22),
      0 0 19px rgba(31, 105, 201, 0.24);
  }
}
[data-dse-slider] .dse-dot {
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  margin-left: -3.5px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(16, 24, 40, 0.12);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.18);
  transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.4s cubic-bezier(0.25, 1, 0.4, 1);
  pointer-events: none;
  z-index: 2;
}
[data-dse-slider] .dse-dot.is-filled {
  border-color: rgba(139, 92, 246, 0.55);
}
[data-dse-slider] .dse-dot.is-active {
  border-color: var(--dse-blue);
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.22), 0 1px 3px rgba(77, 107, 254, 0.4);
  transform: translateY(-50%) scale(1.3);
}
[data-dse-slider] .dse-thumb {
  position: absolute;
  top: 1px;
  left: 0;
  width: 28px;
  height: 28px;
  margin-left: -14px;
  border-radius: 50%;
  background: #ffffff;
  border: 1px solid rgba(126, 160, 197, 0.32);
  box-shadow:
    0 0 0 2px rgba(58, 124, 207, 0.09),
    0 0 13px rgba(48, 118, 207, 0.3),
    0 3px 8px rgba(39, 77, 119, 0.18);
  translate: var(--dse-thumb-x, 0px) 0;
  transition: translate 190ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: translate;
  pointer-events: none;
}
[data-dse-slider] .dse-thumb.dse-pop {
  animation: dseThumbPop 0.4s cubic-bezier(0.25, 1, 0.35, 1);
}
@keyframes dseThumbPop {
  0% { transform: scale(1); }
  40% { transform: scale(1.14); }
  100% { transform: scale(1); }
}
[data-dse-slider] .dse-track.dse-dragging .dse-thumb {
  transform: scale(1.07);
  transition: none;
  box-shadow:
    0 0 0 3px rgba(36, 105, 192, 0.15),
    0 0 20px rgba(25, 100, 201, 0.45),
    0 3px 8px rgba(39, 77, 119, 0.18);
}
[data-dse-slider] .dse-track.dse-dragging .dse-fill {
  transition: none;
}
[data-dse-slider] .dse-track.dse-top .dse-thumb {
  box-shadow:
    0 0 0 3px rgba(36, 105, 192, 0.15),
    0 0 20px rgba(25, 100, 201, 0.45),
    0 3px 8px rgba(39, 77, 119, 0.18);
}
[data-dse-slider] .dse-flare {
  position: absolute;
  z-index: 3;
  top: 50%;
  left: 0;
  width: 78px;
  height: 46px;
  border-radius: 50%;
  background: radial-gradient(ellipse at 100% 50%, rgba(255, 255, 255, 0.95) 0 5%, rgba(204, 231, 255, 0.85) 13%, rgba(91, 162, 241, 0.42) 31%, rgba(37, 111, 207, 0.12) 53%, transparent 75%);
  filter: blur(1.5px);
  mix-blend-mode: screen;
  transform: translate(-100%, -50%);
  translate: var(--dse-flare-x, 0px) 0;
  transition: translate 70ms linear;
  will-change: translate;
  pointer-events: none;
}
[data-dse-slider] .dse-flare::before {
  content: '';
  position: absolute;
  inset: 50% auto auto 100%;
  width: 52px;
  height: 1px;
  border-radius: 999px;
  transform: translate(-50%, -50%);
  background: linear-gradient(90deg, transparent, rgba(116, 177, 244, 0.34), #ffffff, rgba(66, 139, 225, 0.58), transparent);
  box-shadow: 0 0 7px rgba(58, 133, 222, 0.5);
}
[data-dse-slider] .dse-flare::after {
  content: '';
  position: absolute;
  inset: 50% auto auto 100%;
  width: 1px;
  height: 20px;
  transform: translate(-50%, -50%);
  background: linear-gradient(180deg, transparent, rgba(255, 255, 255, 0.94), transparent);
  box-shadow: 0 0 7px rgba(64, 137, 224, 0.44);
}
[data-dse-slider].dse-chibi .dse-thumb {
  top: 50%;
  width: 40px;
  height: 55px;
  margin-left: -20px;
  margin-top: -27.5px;
  border: 0;
  border-radius: 8px;
  background-color: transparent;
  background-image: url('/chibi-runner-strip.png');
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: 800% 100%;
  box-shadow: none !important;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.28)) drop-shadow(0 0 5px rgba(92, 105, 255, 0.34));
  animation: dseChibiRun 720ms step-end infinite;
  transform-origin: 50% 68%;
}
[data-dse-slider].dse-chibi .dse-track.dse-dragging .dse-thumb {
  animation-duration: 420ms;
  transform: none;
  filter: drop-shadow(0 2px 1px rgba(0, 0, 0, 0.28)) drop-shadow(0 0 8px rgba(87, 137, 255, 0.68));
}
[data-dse-slider].dse-chibi .dse-thumb.dse-pop {
  animation: dseChibiRun 720ms step-end infinite;
}
@keyframes dseChibiRun {
  0% { background-position: 14.285714% 0; }
  14.285714% { background-position: 28.571429% 0; }
  28.571429% { background-position: 42.857143% 0; }
  42.857143% { background-position: 57.142857% 0; }
  57.142857% { background-position: 71.428571% 0; }
  71.428571% { background-position: 85.714286% 0; }
  85.714286%, 100% { background-position: 100% 0; }
}
@media (prefers-color-scheme: dark) {
  [data-dse-slider] {
    --dse-ink: #f3f5f9;
    --dse-muted: #a5adbd;
    --dse-faint: #7b8496;
    --dse-line: rgba(255, 255, 255, 0.1);
    --dse-glass: rgba(24, 28, 40, 0.92);
    --dse-glass-soft: rgba(30, 35, 50, 0.72);
  }
}
`

/**
 * Injected slider logic: mounts the pill into the composer's trailing row,
 * syncs with the stock model trigger, and drives the app's own effort menu so
 * the slider selection is a real session-level reasoning effort.
 * Deliberately written without template literals so it stays embeddable.
 */
const EFFORT_SLIDER_JS = `(() => {
  'use strict'
  if (window.__dseSlider) return
  var KEY = 'dsh.effort.slider.v1'
  var GEN = [
    { label: '低', desc: '快速响应，适合简单任务' },
    { label: '中', desc: '平衡速度与质量' },
    { label: '高', desc: '深入推理，适合复杂任务' },
    { label: '更高', desc: '更强规划与自查' },
    { label: '最高', desc: '极限推理，长任务专用' },
  ]
  var state = {
    labels: GEN.map(function (g) { return g.label }),
    descs: GEN.map(function (g) { return g.desc }),
    generic: true,
    current: null,
    currentIdx: -1,
    model: null,
    modelReady: false,
    open: false,
    discovering: false,
    busy: false,
    noEffort: false,
    discoveredModel: null,
    defaultIdx: -1,
  }
  var els = {}
  var dots = []
  var dragging = false
  var suppressOutside = false
  var menuObserverActive = false
  var lastTitleVal = ''
  var lastPillText = ''

  function qs(sel, root) { return (root || document).querySelector(sel) }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  function norm(s) { return (s || '').replace(/\\s+/g, ' ').trim() }
  function waitFor(fn, timeout) {
    return new Promise(function (resolve) {
      var started = Date.now()
      ;(function tick() {
        var value = fn()
        if (value) { resolve(value); return }
        if (Date.now() - started > (timeout || 900)) { resolve(null); return }
        setTimeout(tick, 40)
      })()
    })
  }

  var SPARK = '<svg class="dse-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 4.6 13.4h6l-1.6 8.6L19.4 10.6h-6L13 2Z" fill="currentColor"/></svg>'
  var CHEVRON = '<svg class="dse-chev" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4 5.4 7 8.4l3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  var PILL_HTML =
    '<button type="button" class="dse-pill" data-dse-pill aria-haspopup="dialog" aria-expanded="false" title="思考强度">' + SPARK +
    '<span class="dse-pill-word">思考</span><span class="dse-pill-value" data-dse-value>…</span>' + CHEVRON + '</button>'
  var PANEL_HTML =
    '<div class="dse-panel" data-dse-panel role="dialog" aria-label="思考强度" hidden>' +
    '<div class="dse-head"><div class="dse-title">' + SPARK + '<span>思考强度</span>' +
    '<span class="dse-title-val" data-dse-title-val>—</span></div>' +
    '<button type="button" class="dse-close" data-dse-close aria-label="关闭">×</button></div>' +
    '<div class="dse-track-wrap">' +
    '<div class="dse-track" data-dse-track role="slider" tabindex="0" aria-label="推理强度" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0">' +
    '<div class="dse-rail"></div><div class="dse-fill" data-dse-fill></div>' +
    '<span class="dse-flare" data-dse-flare></span>' +
    '<span class="dse-thumb" data-dse-thumb></span>' +
    '</div></div></div>'

  function findTrigger() {
    var card = qs('[data-composer-card]')
    if (!card) return null
    var found = null
    qsa('button', card).forEach(function (b) {
      if (found !== null) return
      if (b.getAttribute('aria-haspopup') !== 'menu') return
      var t = norm(b.title) || norm(b.getAttribute('aria-label')) || norm(b.textContent)
      if (t.indexOf('·') !== -1 || /选择模型|Select model/.test(t)) found = b
    })
    return found
  }

  function readTrigger() {
    var t = findTrigger()
    if (!t) return null
    var title = norm(t.title) || norm(t.getAttribute('aria-label'))
    if (!title || /^(选择模型|Select model)$/.test(title)) return { ready: false, model: null, effort: null }
    var parts = title.split('·').map(function (s) { return norm(s) })
    if (parts.length >= 2) return { ready: true, model: parts[0], effort: parts[1] }
    return { ready: true, model: title, effort: null }
  }

  function restoreCache() {
    try {
      var raw = localStorage.getItem(KEY)
      if (!raw) return
      var data = JSON.parse(raw)
      var r = readTrigger()
      if (r && r.ready && data.model === r.model && Array.isArray(data.labels) && data.labels.length > 0) {
        state.labels = data.labels
        state.descs = Array.isArray(data.descs) && data.descs.length === data.labels.length ? data.descs : data.labels.map(function () { return '' })
        state.generic = false
        state.discoveredModel = data.model
        state.defaultIdx = data.labels.indexOf('Default')
      }
    } catch (e) { /* keep generic labels */ }
  }

  function mount() {
    if (qs('[data-dse-slider]')) return
    var card = qs('[data-composer-card]')
    var t = findTrigger()
    if (!card || !t) return
    var anchor = t.closest('[data-slot="conversation.input.model"]') || card
    var host = document.createElement('span')
    host.setAttribute('data-dse-slider', '')
    host.classList.add('dse-chibi')
    host.innerHTML = PILL_HTML + PANEL_HTML
    anchor.insertAdjacentElement('afterend', host)
    els.host = host
    els.pill = qs('.dse-pill', host)
    els.panel = qs('.dse-panel', host)
    els.value = qs('[data-dse-value]', host)
    els.titleVal = qs('[data-dse-title-val]', host)
    els.track = qs('.dse-track', host)
    els.fill = qs('[data-dse-fill]', host)
    els.thumb = qs('[data-dse-thumb]', host)
    els.close = qs('[data-dse-close]', host)
    dots = []
    state.prevIdx = -1
    els.pill.addEventListener('click', toggle)
    els.close.addEventListener('click', closePanel)
    els.track.addEventListener('pointerdown', function (ev) {
      if (!state.modelReady || state.busy) return
      ev.preventDefault()
      try { els.track.setPointerCapture(ev.pointerId) } catch (e) {}
      dragging = true
      els.track.classList.add('dse-dragging')
      applyIndex(indexFromEvent(ev), false)
    })
    els.track.addEventListener('pointermove', function (ev) {
      if (!dragging) return
      applyIndex(indexFromEvent(ev), false)
    })
    var endDrag = function (ev) {
      if (!dragging) return
      dragging = false
      els.track.classList.remove('dse-dragging')
      applyIndex(state.currentIdx, true)
    }
    els.track.addEventListener('pointerup', endDrag)
    els.track.addEventListener('pointercancel', endDrag)
    els.track.addEventListener('keydown', function (ev) {
      if (!state.modelReady || state.busy) return
      var n = state.labels.length
      if (n < 1) return
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { ev.preventDefault(); applyIndex(Math.min(n - 1, Math.max(0, state.currentIdx) + 1), true) }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { ev.preventDefault(); applyIndex(Math.max(0, Math.max(0, state.currentIdx) - 1), true) }
      else if (ev.key === 'Home') { ev.preventDefault(); applyIndex(0, true) }
      else if (ev.key === 'End') { ev.preventDefault(); applyIndex(n - 1, true) }
    })
    document.addEventListener('mousedown', function (ev) {
      if (!state.open) return
      if (suppressOutside) return
      var h = qs('[data-dse-slider]')
      if (h && !h.contains(ev.target)) closePanel()
    })
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.open) { ev.stopPropagation(); closePanel() }
    })
    window.addEventListener('resize', function () {
      if (els.track) renderPanel()
      if (state.open) positionPanel()
    })
    if (!menuObserverActive) {
      menuObserverActive = true
      new MutationObserver(function () {
        qsa('[role="menu"]').forEach(hideEffortRow)
      }).observe(document.body, { childList: true, subtree: true })
    }
    var trigger = findTrigger()
    if (trigger) {
      new MutationObserver(function () { sync() }).observe(trigger, {
        attributes: true,
        attributeFilter: ['title', 'aria-label'],
      })
    }
    restoreCache()
    // A re-mounted host must always render once: the sync signature may be
    // unchanged from the previous host, which would otherwise leave the pill
    // stuck on its initial "…" until the effort changes.
    lastSig = ''
    sync()
  }

  function indexFromEvent(ev) {
    var rect = els.track.getBoundingClientRect()
    var n = state.labels.length
    if (n <= 1) return 0
    var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)))
    return Math.round(frac * (n - 1))
  }

  function setValueText(text) {
    var isMax = state.currentIdx === state.labels.length - 1 && state.labels.length > 0
    var isLatin = /^[A-Za-z0-9][A-Za-z0-9\\s._-]*$/.test(text || '')
    if (els.value) {
      els.value.textContent = text
      els.value.classList.toggle('dse-pill-max', isMax)
      els.value.classList.toggle('dse-latin', isLatin)
      if (text !== lastPillText) {
        lastPillText = text
        els.value.classList.remove('dse-pill-anim')
        void els.value.offsetWidth
        els.value.classList.add('dse-pill-anim')
      }
    }
    if (els.titleVal) {
      els.titleVal.textContent = text
      els.titleVal.classList.toggle('dse-title-max', isMax)
      els.titleVal.classList.toggle('dse-latin', isLatin)
      if (text !== lastTitleVal) {
        lastTitleVal = text
        els.titleVal.classList.remove('dse-title-anim')
        void els.titleVal.offsetWidth
        els.titleVal.classList.add('dse-title-anim')
      }
    }
  }

  var lastSig = ''
  function sync() {
    var r = readTrigger()
    state.modelReady = !!(r && r.ready)
    state.model = r ? r.model : null
    state.current = r ? r.effort : null
    var sig = (state.modelReady ? '1' : '0') + '|' + (state.model || '') + '|' + (state.current || '') + '|' + state.labels.join(',')
    if (sig === lastSig && els.pill) return
    lastSig = sig
    if (!state.modelReady) {
      state.currentIdx = -1
      state.noEffort = false
      els.pill.classList.add('dse-disabled')
      els.pill.title = '请先选择模型'
      setValueText('未选择')
      renderPanel()
      return
    }
    els.pill.classList.remove('dse-disabled')
    els.pill.title = '思考强度'
    if (!state.current) {
      state.currentIdx = state.defaultIdx >= 0 ? state.defaultIdx : 0
      setValueText('默认')
    } else {
      var i = state.labels.indexOf(state.current)
      if (i === -1) {
        // Unknown effort name: keep the current position instead of snapping
        // to the first level, and try to fetch the model's real level names.
        i = state.currentIdx >= 0 ? state.currentIdx : 0
        if (state.generic) discover()
      }
      state.currentIdx = i
      setValueText(state.current)
    }
    renderPanel()
  }

  function renderPanel() {
    if (!els.track) return
    var n = state.labels.length
    var idx = Math.max(0, Math.min(n - 1, state.currentIdx))
    els.track.setAttribute('aria-valuemax', String(Math.max(0, n - 1)))
    els.track.setAttribute('aria-valuenow', String(Math.max(0, idx)))
    els.track.setAttribute('aria-valuetext', state.labels[idx] || '')
    els.track.style.cursor = state.noEffort ? 'default' : 'pointer'
    var pct = n <= 1 ? 50 : (idx / (n - 1)) * 100
    var frac = pct / 100
    els.track.style.setProperty('--dse-progress', String(frac))
    var trackW = els.track.clientWidth || 0
    els.track.style.setProperty('--dse-thumb-x', (frac * trackW) + 'px')
    els.track.style.setProperty('--dse-flare-x', (frac * trackW) + 'px')
    els.track.classList.toggle('dse-top', idx === n - 1)
    while (dots.length < n) {
      var dot = document.createElement('span')
      dot.className = 'dse-dot'
      dot.style.transitionDelay = (dots.length * 14) + 'ms'
      els.track.appendChild(dot)
      dots.push(dot)
    }
    while (dots.length > n) {
      dots.pop().remove()
    }
    state.labels.forEach(function (_, i) {
      var dot = dots[i]
      dot.className = 'dse-dot' + (i < idx || (i === idx && idx > 0) ? ' is-filled' : '') + (i === idx ? ' is-active' : '')
      dot.style.left = (n <= 1 ? 50 : (i / (n - 1)) * 100) + '%'
    })
    if (state.prevIdx !== idx && els.thumb && !dragging) {
      els.thumb.classList.remove('dse-pop')
      void els.thumb.offsetWidth
      els.thumb.classList.add('dse-pop')
    }
    state.prevIdx = idx
  }

  function applyIndex(i, immediate) {
    if (!state.modelReady || state.busy || state.noEffort) return
    var n = state.labels.length
    if (n < 1) return
    i = Math.max(0, Math.min(n - 1, i))
    state.currentIdx = i
    renderPanel()
    setValueText(state.labels[i])
    if (!immediate) return
    var label = state.labels[i]
    state.busy = true
    els.pill.classList.add('dse-busy')
    applyByLabel(label).then(function (ok) {
      state.busy = false
      els.pill.classList.remove('dse-busy')
      if (!ok) sync()
    })
  }

  function closeMenu(menu) {
    suppressOutside = true
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    setTimeout(function () { suppressOutside = false }, 0)
  }

  function effortRowOf(menu) {
    var found = null
    qsa('[role="menuitem"]', menu).forEach(function (b) {
      if (found !== null) return
      var span = qs('span', b)
      var txt = span ? norm(span.textContent) : ''
      if (txt === '推理等级' || txt === 'Effort') found = b
    })
    return found
  }

  function hideEffortRow(menu) {
    var row = effortRowOf(menu)
    if (row) row.style.display = 'none'
  }

  function openEffortPane() {
    return new Promise(function (resolve) {
      var existing = qs('[role="menu"]')
      var t = findTrigger()
      if (!t) { resolve(null); return }
      var openIt = function () {
        var menu = qs('[role="menu"]')
        if (!menu) { resolve(null); return }
        var row = effortRowOf(menu)
        if (!row) { closeMenu(menu); resolve(null); return }
        row.click()
        waitFor(function () { return qsa('[role="menuitemradio"]', menu).length > 0 }, 900).then(function () {
          var radios = qsa('[role="menuitemradio"]', menu)
          var labels = []
          var descs = []
          radios.forEach(function (r) {
            var nameSpan = r.querySelector('span span')
            var allSpans = r.querySelectorAll('span span')
            var label = nameSpan ? norm(nameSpan.textContent) : norm(r.textContent)
            var desc = allSpans.length > 1 ? norm(allSpans[1].textContent) : ''
            labels.push(label)
            descs.push(desc)
          })
          closeMenu(menu)
          resolve({ labels: labels, descs: descs })
        })
      }
      if (existing) { openIt(); return }
      t.click()
      waitFor(function () { return qs('[role="menu"]') }, 900).then(function (menu) {
        if (!menu) { resolve(null); return }
        openIt()
      })
    })
  }

  function discover() {
    if (!state.modelReady || state.model === null) return Promise.resolve()
    if (state.discoveredModel === state.model && !state.generic) return Promise.resolve()
    if (state.discovering) return state.discoverPromise || Promise.resolve()
    state.discovering = true
    state.discoverPromise = openEffortPane().then(function (info) {
      state.discovering = false
      if (!info) { state.noEffort = true; sync(); return }
      if (info.labels.length > 0) {
        state.labels = info.labels
        state.descs = info.descs
        state.generic = false
        state.discoveredModel = state.model
        state.defaultIdx = info.labels.indexOf('Default')
        state.noEffort = false
        try {
          localStorage.setItem(KEY, JSON.stringify({ model: state.model, labels: info.labels, descs: info.descs }))
        } catch (e) {}
      }
      sync()
    })
    return state.discoverPromise
  }

  function applyByLabel(label) {
    return new Promise(function (resolve) {
      var t = findTrigger()
      if (!t) { resolve(false); return }
      var clickThrough = function () {
        var menu = qs('[role="menu"]')
        if (!menu) { resolve(false); return }
        var row = effortRowOf(menu)
        if (!row) { closeMenu(menu); resolve(false); return }
        row.click()
        waitFor(function () { return qsa('[role="menuitemradio"]', menu).length > 0 }, 900).then(function () {
          var radios = qsa('[role="menuitemradio"]', menu)
          var target = null
          if (!state.generic && radios.length === state.labels.length) {
            target = radios.find(function (r, i) {
              return state.labels[i] === label && norm(r.textContent).indexOf(norm(label)) !== -1
            }) || null
          }
          if (!target) {
            var idx = state.labels.indexOf(label)
            var ti = idx <= 0 ? 0 : Math.round((idx / (state.labels.length - 1)) * (radios.length - 1))
            target = radios[Math.max(0, Math.min(radios.length - 1, ti))] || null
          }
          if (!target) { closeMenu(menu); resolve(false); return }
          target.click()
          setTimeout(function () { resolve(true) }, 150)
        })
      }
      var existing = qs('[role="menu"]')
      if (existing) { clickThrough(); return }
      t.click()
      waitFor(function () { return qs('[role="menu"]') }, 900).then(function (menu) {
        if (!menu) { resolve(false); return }
        clickThrough()
      })
    })
  }

  function positionPanel() {
    var pr = els.pill.getBoundingClientRect()
    var pw = els.panel.offsetWidth || 320
    var ph = els.panel.offsetHeight || 240
    var left = Math.min(Math.max(8, pr.right - pw), Math.max(8, window.innerWidth - pw - 8))
    var top = pr.bottom + 10
    if (top + ph > window.innerHeight - 8) top = Math.max(8, pr.top - ph - 10)
    // A glass theme (Aqua) may apply transform/filter to a layout ancestor,
    // which turns position:fixed into a containing-block-relative placement.
    // offsetParent of a fixed element is exactly that containing block, so
    // subtract its viewport offset to put the panel where the pill is.
    var containingBlock = els.panel.offsetParent
    if (containingBlock !== null && containingBlock !== document.body) {
      var cbRect = containingBlock.getBoundingClientRect()
      left -= cbRect.left
      top -= cbRect.top
    }
    els.panel.style.left = left + 'px'
    els.panel.style.top = top + 'px'
  }

  function openPanel() {
    if (!state.modelReady) {
      els.pill.classList.remove('dse-shake')
      void els.pill.offsetWidth
      els.pill.classList.add('dse-shake')
      return
    }
    els.panel.hidden = false
    state.open = true
    els.pill.setAttribute('aria-expanded', 'true')
    positionPanel()
    renderPanel()
  }

  function closePanel() {
    if (!state.open && els.panel && els.panel.hidden) return
    state.open = false
    els.panel.hidden = true
    els.pill.setAttribute('aria-expanded', 'false')
  }

  function toggle() {
    if (state.open) closePanel()
    else if (state.discovering) return
    else {
      var p = Promise.resolve()
      if (state.modelReady && (state.discoveredModel !== state.model || state.generic)) {
        p = discover().catch(function () {})
      }
      p.then(function () { openPanel() })
    }
  }

  restoreCache()
  mount()
  setInterval(function () {
    if (!qs('[data-dse-slider]')) mount()
    else sync()
  }, 1500)
  // Read-only smoke/debug hook: lets the shell verify sync + panel rendering.
  window.__dseSlider = { sync: sync, openPanel: openPanel, closePanel: closePanel, applyIndex: applyIndex }
})()`

/**
 * MCP manager shell: a settings entry + standalone management modal for the
 * desktop's own MCP server list. It talks to the loopback API the main
 * process exposes, which persists mcp-servers.json, regenerates the patch
 * overlay and restarts the dsh server with it.
 */
const TOOLTIP_FIX_JS = `(() => {
  if (window.__dseTooltipFix) return
  window.__dseTooltipFix = true
  // Hide the React-owned originals via a stylesheet rule (!important beats
  // React's inline style rewrites, so they never flash at the broken spot).
  const style = document.createElement('style')
  style.textContent = '[class*="bubble_owhem"]:not([data-dse-tip-clone]) { display: none !important; }'
  document.head.appendChild(style)
  const clones = new Map()
  const position = (tip, clone) => {
    const anchor = tip.parentElement
    if (!anchor) return
    // The stock tooltip's host wrapper is an empty zero-size node, so its own
    // rect is useless and querySelector(':hover') would hand back the widest
    // container (whole chat/composer) whose left edge flips the tooltip off
    // screen. Walk the :hover chain (document order = ancestor to descendant)
    // and keep the LAST element with a real box -- the innermost hovered
    // span/button the tooltip belongs to. That box is stable, unlike the
    // smallest-area pick which can bounce between sibling segments.
    let anchorEl = anchor.querySelector('button:focus') || anchor
    for (const el of anchor.querySelectorAll(':hover')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) anchorEl = el
    }
    const ar = anchorEl.getBoundingClientRect()
    const h = clone.offsetHeight || 26
    const w = clone.offsetWidth || 40
    const top = ar.top + h > window.innerHeight - 8 ? window.innerHeight - h - 8 : ar.top
    clone.style.position = 'fixed'
    // Centre the tooltip horizontally on the hovered element, then keep it
    // inside the viewport so a wide tooltip near the right edge never slips
    // off-screen. This is the placement that was broken in compat/mica.
    let left = ar.left + (ar.width - w) / 2
    const minLeft = 8
    const maxLeft = Math.max(minLeft, window.innerWidth - w - 8)
    left = Math.max(minLeft, Math.min(left, maxLeft))
    clone.style.left = Math.round(left) + 'px'
    clone.style.top = Math.round(top) + 'px'
    clone.style.zIndex = '1000'
    clone.style.transform = 'none'
    clone.style.margin = '0'
    clone.style.pointerEvents = 'none'
  }
  const sync = (tip) => {
    if (tip.parentElement === document.body) return
    let clone = clones.get(tip)
    if (!clone || !clone.isConnected) {
      clone = tip.cloneNode(true)
      clone.setAttribute('data-dse-tip-clone', '')
      clones.set(tip, clone)
      document.body.appendChild(clone)
    }
    // keep the visible text in sync (e.g. 复制 -> 复制成功)
    if (clone.innerHTML !== tip.innerHTML) {
      clone.innerHTML = tip.innerHTML
    }
    position(tip, clone)
  }
  const scan = () => {
    document.querySelectorAll('[role="tooltip"], [class*="bubble_owhem"]').forEach(sync)
    for (const [tip, clone] of clones) {
      if (!tip.isConnected) {
        clone.remove()
        clones.delete(tip)
      }
    }
  }
  scan()
  // Interval (not a MutationObserver): observer-driven style writes would
  // feed back into the observer and freeze the page during big re-renders.
  setInterval(scan, 150)
  const reposition = () => { for (const [tip, clone] of clones) position(tip, clone) }
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
})()`

/**
 * Hide duplicate tooltip/toast bubbles (duplicate-UI patch): when the kernel
 * mounts the same tooltip/toast text more than once, keep only the first and
 * suppress the rest so the UI stops showing stacked duplicate popups.
 */
function injectDedupTooltips(win) {
  return win.webContents.executeJavaScript(`(() => {
    function dedupBubbles() {
      var seen = {}
      document.querySelectorAll('[role="tooltip"], [class*="toast"]').forEach(function(el) {
        var t = (el.textContent || '').trim()
        if (!t) return
        if (seen[t]) el.style.display = 'none'
        else seen[t] = true
      })
    }
    new MutationObserver(dedupBubbles).observe(document.body, { childList: true, subtree: true })
    dedupBubbles()
  })()`).catch(() => {})
}

/** Inject the harness git UI (hero branch chip + wide Git 图谱 modal). */
function injectGitUi(win) {
  return win.webContents.executeJavaScript(
    fs.readFileSync(path.join(__dirname, 'resources', 'git-ui.js'), 'utf8'),
  ).catch(() => {})
}

async function injectEffortSlider(win, wait = false) {
  try {
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const check = () => {
        if (document.querySelector('[data-composer-card]') !== null) resolve(true)
        else setTimeout(check, 150)
      }
      check()
    })`)
    await win.webContents.insertCSS(EFFORT_SLIDER_CSS)
    // Local list APIs (MCP servers / skills / subagents) for the built-in
    // harness-extras settings sections.
    await win.webContents.executeJavaScript(
      `window.__DSH_MCP_API__ = ${JSON.stringify('http://127.0.0.1:' + dialogPort)}; true`,
    ).catch(() => {})
    await win.webContents.executeJavaScript(EFFORT_SLIDER_JS)
    await win.webContents.executeJavaScript(TOOLTIP_FIX_JS).catch(() => {})
    if (wait) {
      await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const check = () => {
          if (document.querySelector('[data-dse-slider]') !== null) resolve(true)
          else setTimeout(check, 150)
        }
        check()
      })`)
    }
  } catch {
    // The stock composer still works without the slider.
  }
}

/**
 * Loopback bridge for the directory picker: the dsh server child asks this
 * endpoint and the Electron main process shows its own native folder dialog
 * (drive sidebar + folder contents, no in-app translucency).
 */
function startDialogServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      }
      const sendJson = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cors })
        res.end(JSON.stringify(payload))
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/pick' && req.method === 'GET') {
        try {
          const options = {
            title: '选择工作区目录',
            buttonLabel: '选择此文件夹',
            properties: ['openDirectory', 'createDirectory'],
          }
          const result = mainWindow !== null
            ? await dialog.showOpenDialog(mainWindow, options)
            : await dialog.showOpenDialog(options)
          const value = result.canceled ? null : (result.filePaths[0] ?? null)
          sendJson(200, { path: value })
        } catch (error) {
          sendJson(500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/mcp') {
        if (req.method === 'GET') {
          sendJson(200, { servers: readMcpServers() })
          return
        }
        if (req.method === 'POST') {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = upsertMcpServer(body)
            if (result.error !== undefined) {
              sendJson(400, { error: result.error })
              return
            }
            scheduleServerRestart()
            sendJson(200, { ok: true, servers: readMcpServers() })
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method === 'DELETE') {
          const result = removeMcpServer(url.searchParams.get('name'))
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          scheduleServerRestart()
          sendJson(200, { ok: true, servers: readMcpServers() })
          return
        }
        sendJson(405, { error: 'method not allowed' })
        return
      }
      if (url.pathname === '/skills' && req.method === 'GET') {
        sendJson(200, { skills: scanSkills() })
        return
      }
      if (url.pathname === '/skill-candidates' && req.method === 'GET') {
        sendJson(200, { skills: scanSkillCandidates() })
        return
      }
      if (url.pathname === '/skills' && req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const result = installSkill(body.sourcePath)
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          sendJson(200, { ok: true, skills: scanSkills() })
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/skills' && req.method === 'DELETE') {
        const result = removeSkill(url.searchParams.get('name'))
        if (result.error !== undefined) {
          sendJson(400, { error: result.error })
          return
        }
        sendJson(200, { ok: true, skills: scanSkills() })
        return
      }
      if (url.pathname === '/subagents' && req.method === 'GET') {
        sendJson(200, { subagents: scanSubagents() })
        return
      }
      if (url.pathname === '/subagents' && req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const result = writeSubagentPreset(body, body.force === true)
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          scheduleServerRestart()
          sendJson(200, { ok: true, subagents: scanSubagents() })
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/subagents/set-enabled' && req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const result = setSubagentEnabled(body.id, body.enabled !== false)
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          scheduleServerRestart()
          sendJson(200, { ok: true, subagents: scanSubagents() })
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/subagents' && req.method === 'DELETE') {
        const result = removeSubagentPreset(url.searchParams.get('id'))
        if (result.error !== undefined) {
          sendJson(400, { error: result.error })
          return
        }
        scheduleServerRestart()
        sendJson(200, { ok: true, subagents: scanSubagents() })
        return
      }
      if (url.pathname === '/commands' && req.method === 'GET') {
        sendJson(200, { builtin: BUILTIN_COMMANDS, commands: scanSkills() })
        return
      }
      if (url.pathname === '/commands' && req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const result = createCommand(body)
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          sendJson(200, { ok: true })
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/commands' && req.method === 'DELETE') {
        const result = removeCommand(url.searchParams.get('name'))
        if (result.error !== undefined) {
          sendJson(400, { error: result.error })
          return
        }
        sendJson(200, { ok: true })
        return
      }
      if (url.pathname === '/hooks' && req.method === 'GET') {
        sendJson(200, { hooks: scanHooks(), events: HOOKS_EVENTS })
        return
      }
      if (url.pathname === '/hooks' && req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const result = addHook(body)
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          scheduleServerRestart()
          sendJson(200, { ok: true, hooks: scanHooks() })
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/hooks/set-enabled' && req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const result = setHookEnabled(body.id, body.enabled !== false)
          if (result.error !== undefined) {
            sendJson(400, { error: result.error })
            return
          }
          scheduleServerRestart()
          sendJson(200, { ok: true, hooks: scanHooks() })
        } catch (error) {
          sendJson(400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (url.pathname === '/hooks' && req.method === 'DELETE') {
        const result = removeHook(url.searchParams.get('id'))
        if (result.error !== undefined) {
          sendJson(400, { error: result.error })
          return
        }
        scheduleServerRestart()
        sendJson(200, { ok: true, hooks: scanHooks() })
        return
      }
      if (url.pathname === '/git' && req.method === 'GET') {
        scanGit(url.searchParams.get('path')).then(result => sendJson(200, result)).catch(() => sendJson(500, { error: 'git 执行失败' }))
        return
      }
      if (url.pathname === '/workspaces' && req.method === 'GET') {
        sendJson(200, { workspaces: scanWorkspaces() })
        return
      }
      if (url.pathname === '/git/checkout' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = await gitCheckout(body.path, body.branch, body.create === true)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/git/pull' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = await gitPull(body.path)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/git/push' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = await gitPush(body.path)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/git/graph' && req.method === 'GET') {
        scanGitGraph(url.searchParams.get('path')).then(result => sendJson(200, result)).catch(() => sendJson(500, { error: 'git graph 失败' }))
        return
      }
      if (url.pathname === '/git/checkout' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = await gitCheckoutBranch(body.path, body.branch, body.create === true)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/git/commit' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = await gitCommit(body.path, body.files, body.message)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/files' && req.method === 'GET') {
        sendJson(200, scanFiles(url.searchParams.get('path')))
        return
      }
      if (url.pathname === '/file-content' && req.method === 'GET') {
        sendJson(200, readTextFileHead(url.searchParams.get('path')))
        return
      }
      if (url.pathname === '/archive' && req.method === 'GET') {
        const _res = scanArchive()
        console.log('[scanArchive-debug]', JSON.stringify(_res?.sessions?.map(x => ({ id: x.sessionId.slice(0, 12), arch: x.archived }))))
        sendJson(200, _res)
        return
      }
      if (url.pathname === '/term-stream' && req.method === 'GET') {
        const panel = url.searchParams.get('panel') ?? 'main'
        const session = ensurePty(panel)
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        res.write(`data: ${JSON.stringify(session.backlog)}

`)
        session.clients.add(res)
        req.on('close', () => { session.clients.delete(res) })
        return
      }
      if (url.pathname === '/term-input' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const session = ensurePty(typeof body.panel === 'string' && body.panel !== '' ? body.panel : 'main')
            if (session.exited !== true && typeof body.data === 'string') session.pty.write(body.data)
            sendJson(200, { ok: true })
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/term-resize' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const session = ptySessions.get(typeof body.panel === 'string' ? body.panel : 'main')
            if (session !== undefined && Number.isFinite(body.cols) && Number.isFinite(body.rows)) {
              session.pty.resize(Math.round(body.cols), Math.round(body.rows))
            }
            sendJson(200, { ok: true })
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/session-titles' && req.method === 'GET') {
        sendJson(200, { titles: scanSessionTitles() })
        return
      }
      if (url.pathname === '/archive/move' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            // Session archive lives in the registry flag (moveArchiveSession
            // moved DIRECTORY trees in the old build; the registry owns state now).
            const result = body.archive === true
              ? await archiveSessionFlag(body.sessionId)
              : await restoreArchivedSession(body.sessionId)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/session-restore' && req.method === 'POST') {
        void (async () => {
          try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const result = await restoreArchivedSession(body.sessionId)
            sendJson(result.error !== undefined ? 400 : 200, result)
          } catch (error) {
            sendJson(400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (url.pathname === '/session-toggle' && req.method === 'POST') {
        // Toggle the registry archive flag on disk, then bounce the host so
        // the running server reloads the file. Memory/file stay in step and
        // the sidebar (which filters archived ids) hides the session — one
        // brief restart is the kernel's own contract for archive state.
        const sessionId = url.searchParams.get('sessionId')
        if (typeof sessionId !== 'string' || !/^(session-)?[\w-]+$/.test(sessionId)) {
          sendJson(400, { error: '标识不合法' })
          return
        }
        const result = toggleArchivedFlag(sessionId)
        if (result.error !== undefined) { sendJson(400, result); return }
        scheduleServerRestart()
        sendJson(200, { ok: true })
        return
      }
      if (url.pathname === '/session-delete' && req.method === 'DELETE') {
        const result = deleteArchiveSession(null, url.searchParams.get('sessionId'))
        sendJson(result.error !== undefined ? 400 : 200, result)
        return
      }
      if (url.pathname === '/archive' && req.method === 'DELETE') {
        const result = deleteArchiveSession(url.searchParams.get('group'), url.searchParams.get('sessionId'))
        sendJson(result.error !== undefined ? 400 : 200, result)
        return
      }
      sendJson(404, { error: 'not found' })
    })
    server.on('error', reject)
    // Fixed loopback port so the page's injected __DSH_MCP_API__ stays valid
    // across in-app server restarts (a random port would orphan the old value).
    server.listen(17891, '127.0.0.1', () => {
      dialogPort = 17891
      dialogServer = server
      resolve()
    })
  })
}

/**
 * Terminate the server process tree (Windows cannot deliver POSIX signals).
 * Resolves once the child has exited (or ~4s have passed), so a same-port
 * relaunch does not race the old listener.
 */
function stopServer() {
  if (server === null || server.killed) return Promise.resolve()
  const child = server
  const pid = child.pid
  child.kill()
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(resolve, 4000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

let restartTimer = null

/**
 * Debounced config-change restart: save requests respond immediately, then
 * the dsh server restarts with the regenerated patch. When the server keeps
 * the same origin the page stays put and the kernel's connection layer
 * reconnects+resyncs in place; only a port change forces a full reload.
 */
function scheduleServerRestart() {
  if (SMOKE) return
  if (restartTimer !== null) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restartServerAndReload()
  }, 900)
}

/** Restart the dsh server on the same window and re-inject the shell UI. */
/**
 * Session operations deferred to the restart window: the dsh server holds
 * the registry state and the session log handles, so workspace.json edits
 * and directory deletes only land safely once it has stopped.
 */
const pendingSessionOps = []

/** Apply the deferred session ops between server stop and start. */
function applyPendingSessionOps() {
  for (const op of pendingSessionOps.splice(0)) {
    try {
      if (op.type === 'restore') {
        modifyArchivedSessions(op.sessionId, true)
      } else if (op.type === 'archive') {
        modifyArchivedSessions(op.sessionId, false)
      } else if (op.type === 'delete') {
        const result = deleteSessionDirectories(op.sessionId)
        if (result.error !== undefined) console.error(`[session-op] delete ${op.sessionId}: ${result.error}`)
      }
    } catch (error) {
      console.error('[session-op] failed:', error)
    }
  }
}

/** Remove every log directory of one session, root-level or grouped. */
function deleteSessionDirectories(sessionId) {
  // Guard: only well-formed session ids may be removed; a bare root must
  // never match, so the whole sessions tree can't be swept by a bad arg.
  if (typeof sessionId !== 'string' || !/^(session-)?[\w-]+$/.test(sessionId) || sessionId.length < 8) {
    return { error: '标识不合法' }
  }
  const roots = [path.join(DSH_HOME, 'sessions'), path.join(DSH_HOME, 'sessions-archive')]
  let deleted = false
  for (const root of roots) {
    const direct = path.join(root, sessionId)
    if (fs.existsSync(direct)) {
      const st = fs.statSync(direct)
      if (!st.isDirectory()) { fs.rmSync(direct, { force: true }); deleted = true }
      else if (direct !== root) { fs.rmSync(direct, { recursive: true, force: true }); deleted = true }
    }
    let groups = []
    try {
      groups = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of groups) {
      if (!entry.isDirectory() || entry.name.startsWith('session-')) continue
      const target = path.join(root, entry.name, sessionId)
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true })
        deleted = true
      }
    }
  }
  return deleted ? { ok: true } : { error: '未找到该会话' }
}

let sessionRestartInFlight = false

async function restartServerAndReload() {
  if (quitting || mainWindow === null || mainWindow.isDestroyed()) return
  if (sessionRestartInFlight) return
  sessionRestartInFlight = true
  try {
    await stopServer()
    applyPendingSessionOps()
    const url = await startServer()
    serverUrl = url
    // Same-origin restart: the browser cookie (minted on first load, signed
    // with the persistent secret) still authenticates, so keep the SPA alive
    // and let the kernel connection layer reconnect+resync in place instead
    // of re-booting the whole page (which flashes a boot screen and drops
    // the user out of the settings page). No overlay: the MCP/skills
    // sections show their own lightweight "重启中…" row hints.
    let sameOrigin = false
    try {
      const prev = new URL(mainWindow.webContents.getURL())
      const next = new URL(url)
      sameOrigin = prev.origin === next.origin && next.origin !== 'null'
    } catch {}
    if (!sameOrigin) {
      await mainWindow.loadURL(url)
      await injectThemeGuard(mainWindow)
      void injectBackgroundWhenReady(mainWindow)
      void injectDedupTooltips(mainWindow)
      void injectGitUi(mainWindow)
      void injectEffortSlider(mainWindow)
    }
  } catch (error) {
    console.error('[session-restart] failed:', error)
  } finally {
    sessionRestartInFlight = false
  }
}

/**
 * Spawn the dsh server and wait for its printed URL (port 0 lets the OS pick
 * a free port, so concurrent instances and other local servers never clash).
 * @returns the server's canonical loopback URL.
 */
function startServer() {
  const launch = (port) => new Promise((resolve, reject) => {
    const shimPath = path.join(__dirname, 'resources', 'console-hide-shim.cjs')
    const launcherPath = path.join(__dirname, 'resources', 'hidden-console-launcher.exe')
    const child = spawn(process.execPath, [
      // Loaded as separate argv tokens (not NODE_OPTIONS): the install path
      // may contain spaces ("...\DeepSeek Harness\..."), and NODE_OPTIONS
      // splits on spaces, which truncated --require and crashed the server.
      '--require', shimPath,
      '--expose-internals',
      SERVER_ENTRY,
      'web',
      '--port', String(port),
      // The dsh web command opens the default browser unless told otherwise;
      // the desktop shell has its own window, so never hand off to a browser.
      '--no-open',
    ], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME,
        DSH_DESKTOP_DIALOG_PORT: String(dialogPort),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_CLIENT_TITLE: 'DeepSeek Harness',
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'workspace-write',
        // Every descendant Node process (background workers, subagents, MCP
        // servers, npx) loads the console-hiding shim; console shells are
        // routed through the hidden-console launcher so no black window can
        // flash even from nested spawns.
        DSH_HIDE_LAUNCHER: launcherPath,
        // Let the web-ui plugin-manager find the bundled dsh CLI and pnpm so
        // 创意工坊 (market) plugin installs work inside the desktop shell.
        PATH: [
          process.env.PATH || '',
          path.join(__dirname, 'resources', 'dsh', 'node_modules', '.bin'),
          path.join(__dirname, 'resources', 'dsh-web-ui', 'node_modules', '.bin'),
        ].filter(Boolean).join(path.delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    server = child

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      reject(new Error(`dsh server did not report a URL within 60s${stderr ? `:\n${stderr.slice(-2000)}` : ''}`))
    }, 60000)
    const finish = (url) => {
      clearTimeout(timeout)
      serverUrl = url
      resolve(url)
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\S*/)
      if (match !== null) finish(match[0])
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 20000) stderr = stderr.slice(-20000)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      if (serverUrl !== null) {
        try { console.error(`[dsh-server] exited post-ready code=${code} signal=${signal}`) } catch {}
        return
      }
      clearTimeout(timeout)
      const error = new Error(
        `dsh server exited before ready (code ${code}, signal ${signal})${stderr ? `:\n${stderr.slice(-2000)}` : ''}`,
      )
      if (port !== 0 && /EADDRINUSE|address already in use/i.test(stderr)) {
        reject(Object.assign(error, { portBusy: true }))
      } else {
        reject(error)
      }
    })
  })
  return launch(WEBUI_PORT).catch((error) => {
    if (error && error.portBusy) return launch(0)
    throw error
  })
}

/** Collect UI diagnostics for --smoke mode, plus a rendered screenshot. */
async function runSmoke(win) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const frame = document.querySelector('#root div[style*="grid-template-columns"]')
    const sidebar = frame === null ? null : frame.firstElementChild
    return {
      title: document.title,
      url: location.href,
      themeMarker: document.body.dataset.dsTheme || null,
      colorScheme: document.documentElement.style.colorScheme || null,
      htmlBackground: getComputedStyle(document.documentElement).backgroundImage.slice(0, 100),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      frameBackground: frame === null ? null : getComputedStyle(frame).backgroundColor,
      frameBlur: frame === null ? null : getComputedStyle(frame).backdropFilter,
      hasSidebar: sidebar !== null,
      sidebarBackground: sidebar === null ? null : getComputedStyle(sidebar).backgroundColor,
      hasComposer: document.querySelector('[data-composer-seat]') !== null,
      hasEffortSlider: document.querySelector('[data-dse-slider]') !== null,
      effortPill: (() => {
        const value = document.querySelector('[data-dse-slider] [data-dse-value]')
        return value === null ? null : value.textContent.trim()
      })(),
      imageStatus: await fetch('/background.jpg').then(r => r.status).catch(() => 'ERR'),
    }
  })()`)
  console.log(`DSH_SMOKE ${JSON.stringify(result)}`)
  console.log(`DSH_WINTITLE ${win.getTitle()}`)
  const sliderProbe = await win.webContents.executeJavaScript(`(async () => {
    const effortSpan = document.querySelector('[data-composer-card] button[aria-haspopup="menu"] span[class*="triggerEffort"]')
    const effortHidden = effortSpan === null ? 'absent' : getComputedStyle(effortSpan).display
    const trigger = [...document.querySelectorAll('[data-composer-card] button')].find(b => b.getAttribute('aria-haspopup') === 'menu')
    if (trigger !== undefined && trigger !== null) trigger.title = 'GPT-5.6 · Extra High'
    if (window.__dseSlider) window.__dseSlider.sync()
    const pill = document.querySelector('[data-dse-slider] [data-dse-value]')
    let panel = null
    let panelW = null
    let titleVal = null
    let dots = 0
    let trackTop = false
    let hasFlare = false
    let pillMax = false
    let titleMax = false
    let pillAnim = false
    let titleAnim = false
    let titleColor = null
    let valueLatin = false
    let titleLatin = false
    let pillGeo = null
    let trailingGeo = null
    if (window.__dseSlider) window.__dseSlider.openPanel()
    const panelEl = document.querySelector('[data-dse-panel]')
    if (panelEl !== null) {
      panel = panelEl.hidden ? 'hidden' : 'visible'
      panelW = panelEl.offsetWidth
      const tv = panelEl.querySelector('[data-dse-title-val]')
      titleVal = tv === null ? null : tv.textContent.trim()
      titleMax = tv !== null && tv.classList.contains('dse-title-max')
      titleAnim = tv !== null && tv.classList.contains('dse-title-anim')
      titleColor = tv === null ? null : getComputedStyle(tv).color
      titleLatin = tv !== null && tv.classList.contains('dse-latin')
      dots = panelEl.querySelectorAll('.dse-dot').length
      const pv = document.querySelector('[data-dse-slider] [data-dse-value]')
      pillMax = pv !== null && pv.classList.contains('dse-pill-max')
      pillAnim = pv !== null && pv.classList.contains('dse-pill-anim')
      valueLatin = pv !== null && pv.classList.contains('dse-latin')
    }
    if (window.__dseSlider) window.__dseSlider.applyIndex(4, false)
    if (trigger !== undefined && trigger !== null) trigger.title = 'GPT-5.6 · 最高'
    if (window.__dseSlider) window.__dseSlider.sync()
    const trackEl = document.querySelector('[data-dse-track]')
    trackTop = trackEl !== null && trackEl.classList.contains('dse-top')
    hasFlare = trackEl !== null && trackEl.querySelector('[data-dse-flare]') !== null
    const sliderHost = document.querySelector('[data-dse-slider]')
    const chibi = sliderHost !== null && sliderHost.classList.contains('dse-chibi')
    const chibiStatus = await fetch('/chibi-runner-strip.png').then(r => r.status).catch(() => 'ERR')
    const maxPill = document.querySelector('[data-dse-slider] [data-dse-value]')
    const maxTitle = document.querySelector('[data-dse-title-val]')
    let maxFx = null
    if (maxPill !== null && maxTitle !== null) {
      const ps = getComputedStyle(maxPill)
      const ts = getComputedStyle(maxTitle)
      maxFx = {
        pillColor: ps.color,
        pillGrad: ps.backgroundImage.indexOf('linear-gradient') !== -1,
        pillFlow: ps.animationName.split(',').map(s => s.trim()).indexOf('dseMaxFlow') !== -1,
        pillClip: ps.webkitBackgroundClip,
        pillBgSize: ps.backgroundSize,
        pillShadow: ps.textShadow,
        pillFilter: ps.filter,
        pillAnimList: ps.animationName,
        pillClasses: maxPill.className,
        titleColor: ts.color,
        titleGrad: ts.backgroundImage.indexOf('linear-gradient') !== -1,
        titleFlow: ts.animationName.split(',').map(s => s.trim()).indexOf('dseMaxFlow') !== -1,
        titleClip: ts.webkitBackgroundClip,
        titleBgSize: ts.backgroundSize,
        titleShadow: ts.textShadow,
        titleFilter: ts.filter,
        titleAnimList: ts.animationName,
        titleClasses: maxTitle.className,
      }
    }
    const rectOf = el => {
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const sliderGeo = {
      track: rectOf(document.querySelector('[data-dse-track]')),
      rail: rectOf(document.querySelector('[data-dse-track] .dse-rail')),
      fill: rectOf(document.querySelector('[data-dse-fill]')),
      thumb: rectOf(document.querySelector('[data-dse-thumb]')),
      flare: rectOf(document.querySelector('[data-dse-flare]')),
      dots: [...document.querySelectorAll('[data-dse-track] .dse-dot')].map(rectOf),
    }
    const hostEl = document.querySelector('[data-dse-slider]')
    let reMountText = null
    if (hostEl !== null) {
      hostEl.remove()
      await new Promise(resolve => setTimeout(resolve, 1800))
      const newPill = document.querySelector('[data-dse-slider] [data-dse-value]')
      reMountText = newPill === null ? null : newPill.textContent.trim()
    }
    const pillEl = document.querySelector('[data-dse-slider] .dse-pill')
    const valueEl = document.querySelector('[data-dse-slider] [data-dse-value]')
    if (pillEl !== null && valueEl !== null) {
      const pr = pillEl.getBoundingClientRect()
      const vr = valueEl.getBoundingClientRect()
      const pcs = getComputedStyle(pillEl)
      pillGeo = {
        pillW: Math.round(pr.width),
        valueW: Math.round(vr.width),
        valueRightGap: Math.round(pr.right - vr.right),
        pillOverflow: pcs.overflowX,
        pillFlex: pcs.flexShrink,
      }
    }
    const trailing = document.querySelector('[data-composer-card] [class*="_trailing"]')
    if (trailing !== null) {
      trailingGeo = {
        clientW: trailing.clientWidth,
        scrollW: trailing.scrollWidth,
        display: getComputedStyle(trailing).display,
      }
    }
    return { pill: pill === null ? null : pill.textContent.trim(), panel, panelW, titleVal, dots, trackTop, hasFlare, chibi, chibiStatus, pillMax, titleMax, pillAnim, titleAnim, titleColor, maxFx, valueLatin, titleLatin, pillGeo, trailingGeo, sliderGeo, reMountText, effortHidden }
  })()`)
  console.log(`DSH_SLIDER ${JSON.stringify(sliderProbe)}`)
  fs.writeFileSync(path.join(__dirname, 'smoke-result.json'), JSON.stringify(result, null, 2))
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  })`)
  await new Promise(resolve => setTimeout(resolve, 800))
  const settled = await win.webContents.executeJavaScript(`(() => {
    const fill = document.querySelector('[data-dse-fill]')
    const thumb = document.querySelector('[data-dse-thumb]')
    const title = document.querySelector('[data-dse-title-val]')
    return {
      fillW: fill === null ? null : fill.style.width,
      thumbLeft: thumb === null ? null : thumb.style.left,
      title: title === null ? null : title.textContent.trim(),
      trackTop: document.querySelector('[data-dse-track]')?.classList.contains('dse-top'),
    }
  })()`)
  console.log(`DSH_SETTLED ${JSON.stringify(settled)}`)
  const shot = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, 'smoke-shot.png'), shot.toPNG())
  console.log('DSH_SMOKE_SHOT saved')
  await new Promise(resolve => process.stdout.write('', () => resolve()))
  stopServer()
  app.exit(0)
}

/** Wait for the real UI, then bring the background artwork in. */
async function injectBackgroundWhenReady(win) {
  // 纯净版：不注入自定义背景/品牌/git UI，仅保留原生界面与滑块功能。
  return
  try {
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const check = () => {
        if (document.querySelector('#root div[style*="grid-template-columns"]') !== null) resolve(true)
        else setTimeout(check, 150)
      }
      check()
    })`)
    await Promise.all([
      win.webContents.insertCSS(BACKGROUND_CSS),
      win.webContents.executeJavaScript(THEME_GUARD).catch(() => {}),
      // ── alpha.2-style git UI: hero branch chip + wide Git 图谱 modal ──
      win.webContents.executeJavaScript(
        fs.readFileSync(path.join(__dirname, 'resources', 'git-ui.js'), 'utf8'),
      ).catch(() => {}),
      // ── 0.1.2-alpha.1 duplicate UI fix ──
      // Instant MutationObserver: hide duplicate tooltips on DOM change
      win.webContents.executeJavaScript(`(() => {
        function dedupTooltips() {
          var tips = document.querySelectorAll('[role="tooltip"]')
          var seen = {}
          tips.forEach(function(el) {
            var t = el.textContent.trim()
            if (!t) return
            if (seen[t]) el.style.display = 'none'
            else seen[t] = true
          })
        }
        new MutationObserver(dedupTooltips).observe(document.body, { childList: true, subtree: true })
        dedupTooltips()
      })()`).catch(() => {}),
      // ── Brand title + Session-log reposition + workspace branch switcher ──
      win.webContents.executeJavaScript(`(() => {
        function DSH_API() { return window.__DSH_MCP_API__ || '' }
        var branchCache = {}
        var panelEl = null

        function fixBrandAndLog() {
          document.querySelectorAll('*').forEach(function(el) {
            if (el.children.length === 0 && el.textContent) {
              var t = el.textContent.trim()
              if (t === 'DSH 本地构建' || t === 'DSH Local Build' || t === '本地构建') {
                el.textContent = 'DeepSeek Harness'
              }
            }
          })
          document.querySelectorAll('button').forEach(function(btn) {
            var t = btn.textContent.trim()
            if (t === 'Session 日志' || t === '会话日志' || /Session\\s*日志/.test(t)) {
              btn.style.marginTop = '26px'
              btn.parentElement && (btn.parentElement.style.alignItems = 'flex-end')
            }
          })
        }

        function fetchJson(url, options) {
          return fetch(DSH_API() + url, options).then(function (r) { return r.json() })
        }
        function esc(t) {
          return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        }

        function findWorkspaceChip() {
          var buttons = document.querySelectorAll('button')
          for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i]
            var rect = b.getBoundingClientRect()
            if (rect.width === 0 || rect.top > 260 || rect.top < 0) continue
            var text = b.textContent.trim()
            if (text === '' || text.length > 60) continue
            if (/^(对话|轨迹|新会话|设置|标准模式|跟随系统|Workspace)/.test(text)) continue
            if (b.querySelector('svg') === null) continue
            return b
          }
          // 0.1.2-alpha.3 sidebar: the workspace project chip is a span
          // (not a button); attach the branch badge to its title span.
          var proj = document.querySelector('[class*="projectText"]')
          if (proj !== null) {
            var title = proj.querySelector('[class*="title"]') || proj
            var pr = title.getBoundingClientRect()
            if (pr.width > 0 && pr.top >= 0 && pr.top <= 320) return title
          }
          return null
        }

        function showBadge(anchor, text) {
          if (anchor === null || anchor.parentElement === null) return
          var parent = anchor.parentElement
          // 0.1.2-alpha.3 sidebar: the workspace chip is a column-flex span;
          // lay the title + badge out inline so it never wraps below the name.
          if (getComputedStyle(parent).flexDirection === 'column') {
            parent.style.flexDirection = 'row'
            parent.style.alignItems = 'center'
            parent.style.gap = '6px'
            anchor.style.minWidth = '0'
            anchor.style.overflow = 'hidden'
            anchor.style.textOverflow = 'ellipsis'
            anchor.style.flex = '0 1 auto'
          }
          var badge = parent.querySelector('.dshx-branch-badge')
          if (text === '') {
            if (badge !== null) badge.remove()
            return
          }
          if (badge === null) {
            badge = document.createElement('button')
            badge.type = 'button'
            badge.className = 'dshx-branch-badge'
            badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex:none;white-space:nowrap;'
              + 'margin-left:2px;padding:1px 8px;'
              + 'font-size:11px;border-radius:999px;cursor:pointer;'
              + 'border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));'
              + 'color:var(--dsw-alias-label-secondary,#686c75);background:transparent;'
            parent.insertBefore(badge, anchor.nextSibling)
            badge.addEventListener('click', function (ev) {
              ev.stopPropagation()
              togglePanel(badge)
            })
          }
          badge.textContent = '⎇ ' + text
        }

        function resolveWorkspacePath(name) {
          return fetchJson('/workspaces').then(function (data) {
            var row = (data.workspaces || []).find(function (w) { return w.name === name })
            return row === undefined ? '' : row.path
          })
        }

        function refreshBranchBadge() {
          if (DSH_API() === '') return
          var chip = findWorkspaceChip()
          if (chip === null) return
          var name = chip.textContent.trim()
          var cached = branchCache[name]
          if (cached !== undefined) { showBadge(chip, cached); return }
          resolveWorkspacePath(name).then(function (wsPath) {
            if (wsPath === '') { branchCache[name] = ''; showBadge(chip, ''); return }
            return fetchJson('/git?path=' + encodeURIComponent(wsPath)).then(function (git) {
              var branch = git && git.branch ? git.branch : ''
              branchCache[name] = branch
              showBadge(chip, branch)
            })
          }).catch(function () {})
        }

        function closePanel() {
          if (panelEl !== null) { panelEl.remove(); panelEl = null }
        }
        document.addEventListener('click', function (ev) {
          if (panelEl !== null && !panelEl.contains(ev.target)) closePanel()
        })

        function styles() {
          if (document.getElementById('dshx-branch-style') !== null) return
          var tag = document.createElement('style')
          tag.id = 'dshx-branch-style'
          tag.textContent = [
            '.dshx-bp { position:fixed; z-index:2147483000; width:300px; max-height:420px;',
            '  overflow:auto; background:var(--dsw-alias-bg-base,#fff);',
            '  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); border-radius:12px;',
            '  box-shadow:0 12px 40px rgba(18,24,42,.22); padding:10px; font:13px system-ui;',
            '  color:var(--dsw-alias-label-primary,#1a1d26); }',
            '.dshx-bp h4 { margin:4px 0 8px; font-size:12px; color:var(--dsw-alias-label-tertiary,#9296a0); }',
            '.dshx-bp .bi { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px;',
            '  cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
            '.dshx-bp .bi:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
            '.dshx-bp .bi[data-cur="true"] { font-weight:600; color:var(--dsw-alias-label-primary,#1a1d26); }',
            '.dshx-bp input { width:100%; box-sizing:border-box; height:30px; padding:0 8px; margin:4px 0;',
            '  font-size:12.5px; border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));',
            '  border-radius:8px; background:transparent; color:inherit; outline:none; }',
            '.dshx-bp .btn { display:inline-block; padding:5px 12px; margin:2px 4px 6px 0; font-size:12px;',
            '  border-radius:8px; cursor:pointer; border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.35));',
            '  background:transparent; color:inherit; }',
            '.dshx-bp .btn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
            '.dshx-bp pre { font:11px/1.5 ui-monospace,Consolas,monospace; white-space:pre; overflow:auto;',
            '  max-height:300px; margin:4px 0; padding:8px; border-radius:8px;',
            '  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04)); }',
            '.dshx-bp .err { color:#c83e4d; font-size:12px; }',
          ].join('\\n')
          document.head.appendChild(tag)
        }

        function togglePanel(anchor) {
          if (panelEl !== null) { closePanel(); return }
          styles()
          var rect = anchor.getBoundingClientRect()
          panelEl = document.createElement('div')
          panelEl.className = 'dshx-bp'
          panelEl.style.top = Math.min(rect.bottom + 6, window.innerHeight - 430) + 'px'
          panelEl.style.left = Math.max(8, Math.min(rect.left - 40, window.innerWidth - 312)) + 'px'
          panelEl.innerHTML = '<h4>加载中…</h4>'
          document.body.appendChild(panelEl)
          var chip = findWorkspaceChip()
          var wsName = chip !== null ? chip.textContent.trim() : ''
          resolveWorkspacePath(wsName).then(function (wsPath) {
            if (wsPath === '') { panelEl.innerHTML = '<h4 class="err">未找到工作区</h4>'; return }
            return fetchJson('/git?path=' + encodeURIComponent(wsPath)).then(function (git) {
              if (git.error !== undefined) { panelEl.innerHTML = '<h4 class="err">' + esc(git.error) + '</h4>'; return }
              renderPanel(wsPath, git)
            })
          }).catch(function (err) { panelEl.innerHTML = '<h4 class="err">' + esc(String(err)) + '</h4>' })
        }

        function renderPanel(wsPath, git) {
          var current = git.branch
          var html = '<h4>当前分支：' + esc(current) + '</h4>'
          html += '<input placeholder="新分支名，创建并检出…" id="dshx-newbranch">'
          html += '<button class="btn" id="dshx-create">创建并检出</button>'
          html += '<div style="margin-top:6px">'
          ;(git.branches || []).forEach(function (b) {
            if (b === current) return
            html += '<div class="bi" data-branch="' + esc(b) + '">⎇ ' + esc(b) + '</div>'
          })
          html += '</div>'
          html += '<button class="btn" id="dshx-graph">查看 Git 图谱</button>'
          html += '<div id="dshx-graph-out"></div>'
          panelEl.innerHTML = html
          panelEl.querySelectorAll('.bi').forEach(function (row) {
            row.addEventListener('click', function () {
              switchBranch(wsPath, row.getAttribute('data-branch'), false)
            })
          })
          panelEl.querySelector('#dshx-create').addEventListener('click', function () {
            var name = panelEl.querySelector('#dshx-newbranch').value.trim()
            if (name === '') return
            switchBranch(wsPath, name, true)
          })
          panelEl.querySelector('#dshx-graph').addEventListener('click', function () {
            var out = panelEl.querySelector('#dshx-graph-out')
            out.innerHTML = '<h4>加载中…</h4>'
            fetchJson('/git/graph?path=' + encodeURIComponent(wsPath)).then(function (g) {
              if (g.error !== undefined) { out.innerHTML = '<div class="err">' + esc(g.error) + '</div>'; return }
              out.innerHTML = '<pre>' + esc(g.graph) + '</pre>'
            }).catch(function (err) { out.innerHTML = '<div class="err">' + esc(String(err)) + '</div>' })
          })
        }

        function switchBranch(wsPath, branch, create) {
          fetchJson('/git/checkout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: wsPath, branch: branch, create: create === true }),
          }).then(function (result) {
            if (result.error !== undefined && result.error !== '') {
              panelEl.innerHTML = '<h4 class="err">' + esc(result.error) + '</h4>'
              setTimeout(closePanel, 2500)
              return
            }
            Object.keys(branchCache).forEach(function (k) { delete branchCache[k] })
            closePanel()
            refreshBranchBadge()
          }).catch(function (err) { panelEl.innerHTML = '<h4 class="err">' + esc(String(err)) + '</h4>' })
        }

        var branchTimer = null
        new MutationObserver(function () {
          fixBrandAndLog()
          if (branchTimer === null) {
            branchTimer = setTimeout(function () { branchTimer = null; refreshBranchBadge() }, 600)
          }
        }).observe(document.body, { childList: true, subtree: true })
        fixBrandAndLog()
        // Debug: list workspaces service methods
        if (window.__DSH_WORKSPACES_DEBUG__ !== true) {
          window.__DSH_WORKSPACES_DEBUG__ = true
          // This runs in the browser context; ctx is not directly accessible
          // but the module system exposes it. Quick test: the archive page
          // component calls workspaces.removeSession; if it's undefined the
          // button silently fails. Log the error for diagnostics.
        }
        refreshBranchBadge()
      })()`).catch(() => {}),
    ])
  } catch {
    // The app shell failed to settle; the stock clean UI still renders.
  }
}

/** Pin the light theme as soon as the document is live. */
function injectThemeGuard(win) {
  return win.webContents.executeJavaScript(THEME_GUARD).catch(() => {})
}

/** Bring the hidden/minimized main window back to the foreground. */
function showMainWindow() {
  if (mainWindow === null) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

/**
 * System-tray residence: clicking the window's close button hides it instead
 * of quitting, and the tray menu is the only way to fully exit. The tray
 * icon reuses the app icon already shipped in build/.
 */
function createTray() {
  const icon = path.join(__dirname, 'build', 'icon.png')
  try {
    tray = new Tray(icon)
  } catch {
    // Tray creation can fail on headless/CI setups; the app still runs.
    return
  }
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: showMainWindow,
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ]))
  // Single-click must stay silent in tray-only mode: a stray click used to
  // pop the (web-content) main window, which reads as "a webpage opened".
  // Double-click is the deliberate gesture to open the main window.
  tray.on('double-click', showMainWindow)
}

/** Hide any stray console window created anywhere inside the app process tree. */
function startConsoleWatchdog() {
  if (process.platform !== 'win32' || consoleWatchdog !== null) return
  const exe = path.join(__dirname, 'resources', 'console-watchdog.exe')
  if (!fs.existsSync(exe)) return
  try {
    consoleWatchdog = spawn(exe, [String(process.pid), __dirname], {
      stdio: 'ignore',
      windowsHide: true,
    })
    consoleWatchdog.on('exit', () => {
      consoleWatchdog = null
    })
  } catch {
    consoleWatchdog = null
  }
}

/** Read one console-delegation registry value; null when absent. */
function readDelegationValue(name) {
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Console\\%%Startup', '/v', name], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) return null
    const match = /REG_SZ\s+(.*)$/m.exec(result.stdout || '')
    return match ? match[1].trim() : ''
  } catch {
    return null
  }
}

function writeDelegationValue(name, value) {
  try {
    spawnSync('reg', ['add', 'HKCU\\Console\\%%Startup', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {}
}

function deleteDelegationValue(name) {
  try {
    spawnSync('reg', ['delete', 'HKCU\\Console\\%%Startup', '/v', name, '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {}
}

/**
 * While the desktop app runs, point console delegation at the classic conhost
 * (empty Delegation* values) instead of Windows Terminal. Windows Terminal
 * ignores SW_HIDE and pops a window for every sandboxed command console;
 * conhost honors the hidden STARTUPINFO window. The original values are backed
 * up (also on disk for crash recovery) and restored on quit.
 */
function applyConhostDelegation() {
  if (process.platform !== 'win32') return
  try {
    if (fs.existsSync(TERMINAL_DELEGATION_BACKUP)) {
      // Previous run exited uncleanly: restore its backup before continuing.
      const previous = JSON.parse(fs.readFileSync(TERMINAL_DELEGATION_BACKUP, 'utf8'))
      if (previous.hadConsole) writeDelegationValue('DelegationConsole', previous.console)
      else deleteDelegationValue('DelegationConsole')
      if (previous.hadTerminal) writeDelegationValue('DelegationTerminal', previous.terminal)
      else deleteDelegationValue('DelegationTerminal')
      fs.unlinkSync(TERMINAL_DELEGATION_BACKUP)
    }
    const consoleValue = readDelegationValue('DelegationConsole')
    const terminalValue = readDelegationValue('DelegationTerminal')
    if (consoleValue === CONHOST_DELEGATION_CONSOLE && terminalValue === CONHOST_DELEGATION_TERMINAL) return
    terminalDelegationBackup = {
      console: consoleValue,
      terminal: terminalValue,
      hadConsole: consoleValue !== null,
      hadTerminal: terminalValue !== null,
    }
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.writeFileSync(TERMINAL_DELEGATION_BACKUP, JSON.stringify(terminalDelegationBackup))
    writeDelegationValue('DelegationConsole', CONHOST_DELEGATION_CONSOLE)
    writeDelegationValue('DelegationTerminal', CONHOST_DELEGATION_TERMINAL)
  } catch {}
}

function restoreConhostDelegation() {
  if (process.platform !== 'win32') return
  try {
    if (terminalDelegationBackup !== null) {
      if (terminalDelegationBackup.hadConsole) writeDelegationValue('DelegationConsole', terminalDelegationBackup.console)
      else deleteDelegationValue('DelegationConsole')
      if (terminalDelegationBackup.hadTerminal) writeDelegationValue('DelegationTerminal', terminalDelegationBackup.terminal)
      else deleteDelegationValue('DelegationTerminal')
      terminalDelegationBackup = null
    }
    if (fs.existsSync(TERMINAL_DELEGATION_BACKUP)) fs.unlinkSync(TERMINAL_DELEGATION_BACKUP)
  } catch {}
}

/** Open the main window against the running server. */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'deepseekharness',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#ffffff',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  // Keep navigation inside the local server; external links open in the
  // system browser instead of hijacking the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (serverUrl !== null && url.startsWith(serverUrl)) return { action: 'allow' }
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverUrl !== null && url.startsWith(serverUrl)) return
    if (/^https?:/i.test(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keep the window title fixed: the web app may prepend session names, so
  // pin "deepseekharness" on every title update.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle('deepseekharness')
  })

  // Close button hides to the tray; full exit goes through the tray menu.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    void injectThemeGuard(mainWindow)
    void injectBackgroundWhenReady(mainWindow)
    void injectDedupTooltips(mainWindow)
    void injectGitUi(mainWindow)
    void injectEffortSlider(mainWindow)
  })

  await mainWindow.loadURL(serverUrl)
  if (SMOKE || !HIDDEN_START) {
    // Force the window to the foreground: plain show() can leave the window
    // pinned to the taskbar when the process inherited a hidden startup flag.
    mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.moveTop()
  }
  await injectThemeGuard(mainWindow)
  if (SMOKE) {
    await injectBackgroundWhenReady(mainWindow)
    await injectEffortSlider(mainWindow, true)
    await runSmoke(mainWindow)
  } else {
    void injectBackgroundWhenReady(mainWindow)
    void injectDedupTooltips(mainWindow)
    void injectGitUi(mainWindow)
    void injectEffortSlider(mainWindow)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // In tray-only mode a second launch must stay silent too; the tray icon
    // is the only way back into the window.
    if (!HIDDEN_START) showMainWindow()
  })

  app.whenReady().then(async () => {
    try {
      applyConhostDelegation()
      seedDshHome()
      seedChibiSprite()  // chibi thumb for the reasoning-effort slider
      cleanupLegacyPlugins()
      ensureHarnessExtras()
      // seedWallpapers()  // removed: wallpaper management disabled
      ensureMcpFiles()
      ensureWebUiFamily()
      // ensureAquaPlugin()   // removed: incompatible with 0.1.2-alpha.1
      await startDialogServer()
      // Client-plugin bundles are served with immutable cache headers; clear
      // the Chromium disk cache every launch so edited plugin code always
      // reaches the page instead of a stale cached copy.
      await session.defaultSession.clearCache()
      const url = await startServer()
      await createWindow()
      createTray()
      startConsoleWatchdog()
      if (HIDDEN_START && tray !== null) {
        tray.displayBalloon({
          iconType: 'info',
          title: 'DeepSeek Harness',
          content: `已隐藏启动：服务运行在 http://127.0.0.1:${WEBUI_PORT}，双击托盘图标打开主界面。`,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('DSH_START_ERROR', error)
      dialog.showErrorBox('DeepSeek Harness', `Failed to start the local server.\n\n${message}`)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    if (quitting) return
    quitting = true
    teardownPtySessions()
    if (consoleWatchdog !== null) {
      consoleWatchdog.kill()
      consoleWatchdog = null
    }
    restoreConhostDelegation()
    if (tray !== null) {
      tray.destroy()
      tray = null
    }
    if (dialogServer !== null) dialogServer.close()
    stopServer()
  })
}
