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

const { app, BrowserWindow, dialog, Menu, shell, Tray } = require('electron')
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
  ['web-ui-compat', '@linxin666/dsh-web-ui-all'],
  ['web-ui-settings', '@linxin666/dsh-client-ui-web-ui-settings'],
  ['web-ui-plugin-manager', '@linxin666/dsh-client-ui-plugin-manager'],
  ['web-ui-community-plugins', '@linxin666/dsh-client-ui-community-plugins'],
  ['web-ui-dsh-aionui-panel', '@linxin666/dsh-client-ui-aionui-panel'],
  ['web-ui-task-board', '@linxin666/dsh-client-ui-task-board'],
  ['web-ui-git-graph', '@linxin666/dsh-client-ui-git-graph'],
  ['web-ui-pet', '@linxin666/dsh-pet'],
  ['web-ui-remote-web-ui', '@linxin666/dsh-remote-web-ui'],
  ['web-ui-ssh', '@linxin666/dsh-ssh'],
  ['web-ui-describe-image', '@linxin666/dsh-tool-describe-image'],
  ['web-ui-chat-recovery', '@linxin666/dsh-chat-recovery'],
  ['web-ui-liangshen', '@linxin666/dsh-liangshen'],
  ['web-ui-skill-explorer', '@linxin666/dsh-client-ui-skill-explorer'],
  ['web-ui-better-sidebar', 'dsh-better-sidebar'],
]

/**
 * Copy the bundled dsh-web-ui family modules into the profile module
 * fallback root. Only missing packages are copied, so existing installs are
 * never overwritten; on a fresh machine this is a one-time bootstrap.
 */
function syncBundledWebUiModules() {
  const bundledRoot = path.join(WEBUI_BUNDLED_ROOT, 'node_modules')
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
      const target = path.join(WEBUI_PROFILE_NM, ...relative.split('/'))
      if (fs.existsSync(path.join(target, 'package.json'))) continue
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
  } catch {
    meta = {}
  }
  const name = meta.name || path.basename(resolved)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return { error: '技能名称不合法' }
  const target = path.join(DSH_HOME, 'skills', name)
  try {
    fs.mkdirSync(target, { recursive: true })
    for (const relative of fs.readdirSync(resolved, { recursive: true })) {
      const from = path.join(resolved, relative)
      const to = path.join(target, relative)
      if (fs.statSync(from).isDirectory()) {
        fs.mkdirSync(to, { recursive: true })
        continue
      }
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
  } catch (error) {
    return { error: '复制失败：' + (error instanceof Error ? error.message : String(error)) }
  }
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
 * Seed the per-user settings on first launch: pin the light theme and select
 * the built-in DeepSeek agent (deepseek-official / deepseek-v4-flash) as the
 * default model, so a fresh install only needs its own DeepSeek API key.
 * Existing user settings are never overwritten.
 */
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
/* Chat font controls: the injected 会话字体/字号 box writes these variables,
   and the markdown body token picks them up (code blocks keep their own
   monospace tokens). Must override on body: the stock skin redefines the
   markdown token there, so a root-level override would be shadowed. */
body {
  --dsw-font-markdown-base: var(--dse-chat-font-size, 16px)/1.6 var(--dse-chat-font-family, var(--dsw-font-family)) !important;
  --dsw-font-markdown-h1: 700 calc(var(--dse-chat-font-size, 16px) * 1.5)/1.35 var(--dse-chat-font-family, var(--dsw-font-family)) !important;
  --dsw-font-markdown-h2: 700 calc(var(--dse-chat-font-size, 16px) * 1.375)/1.4 var(--dse-chat-font-family, var(--dsw-font-family)) !important;
  --dsw-font-markdown-h3: 600 calc(var(--dse-chat-font-size, 16px) * 1.25)/1.45 var(--dse-chat-font-family, var(--dsw-font-family)) !important;
}
.dse-chat-font-box {
  width: 100%;
  margin: 2px 0 8px;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.5));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dse-chat-font-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #15171b);
}
/* Mobile remote control card inside 设置: shows the local port for
   intranet tunnelling and reopens the plugin's QR/tunnel panel. */
.dse-remote-card {
  width: 100%;
  margin: 2px 0 8px;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.5));
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dse-remote-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #15171b);
}
.dse-remote-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.dse-remote-label {
  color: var(--dsw-alias-label-secondary, #5b6472);
  flex: none;
}
.dse-remote-code {
  font-family: var(--dsw-font-mono, ui-monospace, Consolas, monospace);
  font-size: 12px;
  color: var(--dsw-alias-brand-primary, #2f54eb);
  background: var(--dsw-alias-bg-layer-1, rgba(120, 130, 160, 0.12));
  border-radius: 6px;
  padding: 2px 6px;
}
.dse-remote-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8a93a2);
}
.dse-remote-open {
  align-self: flex-start;
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.25));
  background: var(--dsw-alias-button-elevated-fill, rgba(120, 130, 160, 0.12));
  color: var(--dsw-alias-label-primary, #15171b);
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.dse-remote-open:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(120, 130, 160, 0.2));
}
.dse-chat-font-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dse-chat-font-label {
  flex: none;
  width: 34px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #686c75);
}
.dse-chat-font-row input[type="range"] {
  flex: 1;
  min-width: 0;
  accent-color: var(--dsw-alias-brand-primary, #4d70ff);
}
.dse-chat-font-value {
  flex: none;
  width: 40px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #15171b);
  text-align: right;
}
.dse-chat-font-row select {
  flex: 1;
  min-width: 0;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.24));
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #15171b);
  font-size: 12px;
  padding: 0 6px;
}
body[data-ds-dark-theme] .dse-chat-font-box {
  background: rgba(24, 28, 40, 0.78);
}
body[data-ds-dark-theme] .dse-chat-font-row select {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.14);
  color: #e7edf6;
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
button[aria-label="移动端远程控制"] {
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
body[data-ds-dark-theme] .dse-mcp-card {
  background: rgba(24, 28, 40, 0.92) !important;
  border-color: rgba(255, 255, 255, 0.12) !important;
}
body[data-ds-dark-theme] .dse-mcp-card input,
body[data-ds-dark-theme] .dse-mcp-card textarea,
body[data-ds-dark-theme] .dse-mcp-card select {
  background: rgba(255, 255, 255, 0.08) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
  color: #e7edf6 !important;
}
/* Built-in wallpaper gallery in the Aqua settings row. */
.dse-wallpaper-box {
  width: 100%;
  margin: 2px 0 8px;
  padding: 10px;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.5));
  box-sizing: border-box;
}
.dse-wallpaper-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.dse-wallpaper-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(120, 125, 140, 0.12));
}
.dse-wallpaper-tabs button {
  border: 0;
  border-radius: 7px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #686c75);
  background: transparent;
  cursor: pointer;
}
.dse-wallpaper-tabs button.is-active {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #15171b);
  font-weight: 600;
}
.dse-wallpaper-delete {
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.24));
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary, #c83e4d);
  background: transparent;
  cursor: pointer;
}
.dse-wallpaper-delete:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(120, 125, 140, 0.12));
}
.dse-wallpaper-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dse-wallpaper-item {
  position: relative;
  width: 88px;
  height: 56px;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid transparent;
  cursor: pointer;
  flex: none;
}
.dse-wallpaper-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.dse-wallpaper-item small {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 0;
  font-size: 10px;
  line-height: 1.2;
  text-align: center;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.42);
  border-radius: 0 0 8px 8px;
  pointer-events: none;
}
.dse-wallpaper-user video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.dse-wallpaper-item:hover {
  border-color: var(--dsw-alias-brand-primary, #4d70ff);
}
.dse-wallpaper-item.is-active {
  border-color: #22c55e;
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
}
.dse-wallpaper-item.is-active::after {
  content: '✓';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #22c55e;
  color: #ffffff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
.dse-wallpaper-upload {
  width: 88px;
  height: 56px;
  border-radius: 10px;
  border: 1.5px dashed var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.4));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--dsw-alias-label-secondary, #686c75);
  cursor: pointer;
  flex: none;
  background: transparent;
}
.dse-wallpaper-upload:hover {
  border-color: var(--dsw-alias-brand-primary, #4d70ff);
  color: var(--dsw-alias-brand-primary, #4d70ff);
}
.dse-wallpaper-upload span {
  font-size: 18px;
  line-height: 1;
}
.dse-wallpaper-upload small {
  font-size: 11px;
}
.dse-wallpaper-video {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dse-wallpaper-note {
  margin: 0;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #9296a0);
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
const MCP_MANAGER_CSS = `
.dse-mcp-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: auto;
  padding: 9px 16px 9px 12px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #15171b);
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  text-align: left;
  transition: background 140ms ease;
}
.dse-mcp-nav:hover { background: rgba(120, 125, 140, 0.09); }
.dse-mcp-nav.is-active,
.dse-mcp-nav.VOzbGW_active {
  background: var(--dsw-specific-sidebar-nav-item-active, #dee9f8);
  color: var(--dsw-alias-label-primary, #15171b);
  font-weight: 600;
}
.dse-mcp-nav svg { width: 16px; height: 16px; flex: none; }
.dse-skill-search input {
  max-width: 320px;
}
/* Inline mode: MCP/skills render inside the settings content area instead of
   a full-screen popup. */
.dse-mcp-options-host {
  position: relative;
}
.dse-mcp-options-host > .dse-mcp-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: transparent;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  padding: 0;
}
.dse-mcp-options-host > .dse-mcp-overlay > .dse-mcp-card {
  width: 100%;
  max-width: none;
  max-height: none;
  height: 100%;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  padding: 0;
  animation: none;
}
.dse-mcp-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  background: rgba(15, 23, 42, 0.38);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.dse-mcp-card {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.2));
  border-radius: 18px;
  box-shadow: 0 24px 64px rgba(18, 24, 42, 0.25);
  overflow: hidden;
  animation: dseMcpIn 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes dseMcpIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.dse-mcp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(121, 126, 145, 0.14));
}
.dse-mcp-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #15171b);
}
.dse-mcp-title svg { width: 16px; height: 16px; color: #4d70ff; }
.dse-mcp-close {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #686c75);
  font-size: 15px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.dse-mcp-close:hover { background: rgba(77, 112, 255, 0.08); color: #4d70ff; }
.dse-mcp-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dse-mcp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.16));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fafbfd);
}
.dse-mcp-row-info { flex: 1; min-width: 0; }
.dse-mcp-row-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #15171b);
}
.dse-mcp-badge {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(77, 112, 255, 0.1);
  color: #4d70ff;
  font-weight: 600;
}
.dse-mcp-row-desc {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #686c75);
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Consolas, monospace;
}
.dse-mcp-btn {
  border: 0;
  border-radius: 9px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, rgba(120, 125, 140, 0.1));
  color: var(--dsw-alias-label-primary, #15171b);
  transition: background 140ms ease;
}
.dse-mcp-btn:hover { background: rgba(120, 125, 140, 0.18); }
.dse-mcp-btn-primary { background: #4d70ff; color: #ffffff; }
.dse-mcp-btn-primary:hover { background: #3d62ee; }
.dse-mcp-btn-danger { color: var(--dsw-alias-state-error-primary, #c83e4d); }
.dse-mcp-empty {
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #9296a0);
  font-size: 12px;
  padding: 28px 0 20px;
}
.dse-mcp-field { display: flex; flex-direction: column; gap: 5px; }
.dse-mcp-field label { font-size: 12px; color: var(--dsw-alias-label-secondary, #686c75); }
.dse-mcp-field input,
.dse-mcp-field select,
.dse-mcp-field textarea {
  border: 1px solid var(--dsw-alias-border-l2, rgba(121, 126, 145, 0.24));
  border-radius: 9px;
  padding: 7px 9px;
  font: 12px/1.5 ui-monospace, Consolas, 'PingFang SC', 'Microsoft YaHei', monospace;
  color: var(--dsw-alias-label-primary, #15171b);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  outline: none;
}
.dse-mcp-field input:focus,
.dse-mcp-field select:focus,
.dse-mcp-field textarea:focus {
  border-color: #4d70ff;
  box-shadow: 0 0 0 3px rgba(77, 112, 255, 0.12);
}
.dse-mcp-field textarea { resize: vertical; min-height: 54px; }
.dse-mcp-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dse-mcp-form-grid .dse-mcp-full { grid-column: 1 / -1; }
.dse-mcp-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #15171b);
  cursor: pointer;
}
.dse-mcp-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 4px;
}
.dse-mcp-msg {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #686c75);
  text-align: center;
  padding: 10px;
}
.dse-mcp-msg.error { color: var(--dsw-alias-state-error-primary, #c83e4d); }
.dse-mcp-msg.ok { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dse-skill-desc {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #686c75);
  margin-top: 3px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dse-skill-card {
  width: 640px;
  min-height: 440px;
}
.dse-skill-count { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9296a0); }
.dse-skill-search input { width: 100%; }
`

const MCP_MANAGER_JS = `(() => {
  'use strict'
  var API = window.__DSH_MCP_API__ || null
  var ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12M6.5 2v12" stroke="currentColor" stroke-width="1.5"/></svg>'
  var SKILL_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.8 9.6 6l4.4.3-3.4 2.8 1.1 4.3L8 10.9 4.3 13.4l1.1-4.3L2 6.3 6.4 6 8 1.8Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  var overlay = null
  var inlineHost = null
  var hiddenSection = null
  var servers = []
  var skills = []

  function qs(sel, root) { return (root || document).querySelector(sel) }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)) }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function findSettingsNavList() {
    var dialogs = qsa('[role="dialog"][aria-modal="true"]')
    for (var i = 0; i < dialogs.length; i++) {
      if (dialogs[i].getAttribute('data-dse-mcp') !== null) continue
      var nav = qs('nav', dialogs[i])
      if (nav && /设置/.test(nav.textContent || '')) {
        var list = qs('nav [class*="navList"]', dialogs[i])
        if (list) return list
      }
    }
    return null
  }

  function findSettingsOptions() {
    var dialogs = qsa('[role="dialog"][aria-modal="true"]')
    for (var i = 0; i < dialogs.length; i++) {
      if (dialogs[i].getAttribute('data-dse-mcp') !== null) continue
      var options = qs('[class*="VOzbGW_options"]', dialogs[i])
      if (options) return options
    }
    return null
  }

  function mountOverlay() {
    var options = findSettingsOptions()
    if (options !== null) {
      inlineHost = options
      options.classList.add('dse-mcp-options-host')
      hiddenSection = qs('[class*="_section"]', options) || null
      if (hiddenSection) hiddenSection.style.display = 'none'
      options.appendChild(overlay)
    } else {
      document.body.appendChild(overlay)
    }
  }

  function mountNav() {
    var navList = findSettingsNavList()
    if (!navList) return
    if (!navList.__dseNavBound) {
      navList.__dseNavBound = true
      navList.addEventListener('click', function (ev) {
        var cell = ev.target && ev.target.closest ? ev.target.closest('button') : null
        if (cell !== null && cell.className.indexOf('dse-mcp-nav') === -1) {
          qsa('.dse-mcp-nav', navList).forEach(function (b) {
            b.classList.remove('is-active')
            b.classList.remove('VOzbGW_active')
          })
          if (overlay !== null) closeOverlay()
        }
      }, true)
    }
    if (!qs('[data-dse-mcp-nav]', navList)) {
      var mcpCell = document.createElement('button')
      mcpCell.type = 'button'
      mcpCell.setAttribute('data-dse-mcp-nav', '')
      mcpCell.className = 'dse-mcp-nav'
      mcpCell.innerHTML = ICON + '<span>MCP 服务器</span>'
      navList.appendChild(mcpCell)
    }
    var mcpCell = qs('[data-dse-mcp-nav]', navList)
    if (mcpCell !== null && !mcpCell.__dseBound) {
      mcpCell.__dseBound = true
      mcpCell.addEventListener('click', function () {
        qsa('.dse-mcp-nav', navList).forEach(function (b) {
          b.classList.remove('is-active')
          b.classList.remove('VOzbGW_active')
        })
        qsa('[class*="VOzbGW_navCell"]', navList).forEach(function (c) { c.classList.remove('VOzbGW_active') })
        mcpCell.classList.add('is-active')
        mcpCell.classList.add('VOzbGW_active')
        openOverlay()
      })
    }
    if (!qs('[data-dse-skill-nav]', navList)) {
      var skillCell = document.createElement('button')
      skillCell.type = 'button'
      skillCell.setAttribute('data-dse-skill-nav', '')
      skillCell.className = 'dse-mcp-nav'
      skillCell.innerHTML = SKILL_ICON + '<span>技能</span>'
      navList.appendChild(skillCell)
    }
    var skillCell = qs('[data-dse-skill-nav]', navList)
    if (skillCell !== null && !skillCell.__dseBound) {
      skillCell.__dseBound = true
      skillCell.addEventListener('click', function () {
        qsa('.dse-mcp-nav', navList).forEach(function (b) {
          b.classList.remove('is-active')
          b.classList.remove('VOzbGW_active')
        })
        qsa('[class*="VOzbGW_navCell"]', navList).forEach(function (c) { c.classList.remove('VOzbGW_active') })
        skillCell.classList.add('is-active')
        skillCell.classList.add('VOzbGW_active')
        openSkillsOverlay()
      })
    }
  }

  function openSkillsOverlay() {
    if (overlay !== null) closeOverlay()
    overlay = document.createElement('div')
    overlay.className = 'dse-mcp-overlay'
    overlay.setAttribute('data-dse-mcp', '')
    overlay.innerHTML =
      '<div class="dse-mcp-card dse-skill-card">' +
      '<div class="dse-mcp-head"><div class="dse-mcp-title">' + SKILL_ICON + '<span>技能</span></div></div>' +
      '<div class="dse-mcp-body" data-dse-mcp-body>' +
      '<div class="dse-mcp-field dse-skill-search"><input data-dse-skill-search placeholder="搜索技能…" spellcheck="false"></div>' +
      '<div class="dse-skill-count" data-dse-skill-count></div>' +
      '<div data-dse-skill-list></div>' +
      '<div class="dse-mcp-actions">' +
      '<button type="button" class="dse-mcp-btn" data-dse-skill-local>从本地导入</button>' +
      '<button type="button" class="dse-mcp-btn" data-dse-skill-folder>从文件夹导入</button>' +
      '</div>' +
      '</div></div>'
    mountOverlay()
    overlay.addEventListener('mousedown', function (ev) {
      if (ev.target === overlay) closeOverlay()
    })
    document.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Escape' && overlay !== null) {
        closeOverlay()
        document.removeEventListener('keydown', onKey)
      }
    })
    var body = qs('[data-dse-mcp-body]', overlay)
    var initialList = qs('[data-dse-skill-list]', body)
    if (initialList) initialList.innerHTML = '<div class="dse-mcp-msg">加载中…</div>'
    api('/skills').then(function (data) {
      skills = (data && data.skills) || []
      renderSkills('')
    }).catch(function (error) {
      qs('[data-dse-skill-list]', overlay).innerHTML =
        '<div class="dse-mcp-msg error">加载失败：' + esc(error.message) + '</div>'
    })
    qs('[data-dse-skill-search]', overlay).addEventListener('input', function (ev) {
      renderSkills(ev.target.value)
    })
    qs('[data-dse-skill-local]', overlay).addEventListener('click', showCandidates)
    qs('[data-dse-skill-folder]', overlay).addEventListener('click', installFromFolder)
  }

  function renderSkills(query) {
    var listEl = qs('[data-dse-skill-list]', overlay)
    var countEl = qs('[data-dse-skill-count]', overlay)
    var q = String(query || '').trim().toLowerCase()
    var rows = skills.filter(function (s) {
      if (q === '') return true
      return s.name.toLowerCase().indexOf(q) !== -1
        || String(s.description || '').toLowerCase().indexOf(q) !== -1
    })
    countEl.textContent = '共 ' + skills.length + ' 个技能'
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="dse-mcp-empty">没有匹配的技能</div>'
      return
    }
    listEl.innerHTML = rows.map(function (s) {
      var badges = s.modelInvocable === false ? '<span class="dse-mcp-badge">仅用户调用</span>' : ''
      var extra = s.whenToUse
        ? '<div class="dse-skill-desc">' + esc(s.whenToUse) + '</div>'
        : ''
      return '<div class="dse-mcp-row">' +
        '<div class="dse-mcp-row-info">' +
        '<div class="dse-mcp-row-name"><span>' + esc(s.name) + '</span>' + badges + '</div>' +
        '<div class="dse-skill-desc">' + esc(s.description) + '</div>' +
        extra +
        '</div>' +
        '<button type="button" class="dse-mcp-btn dse-mcp-btn-danger" data-dse-skill-del="' + esc(s.name) + '">删除</button>' +
        '</div>'
    }).join('')
    qsa('[data-dse-skill-del]', listEl).forEach(function (button) {
      button.addEventListener('click', function () {
        var name = button.getAttribute('data-dse-skill-del')
        if (!window.confirm('确定删除技能 "' + name + '"？')) return
        api('/skills?name=' + encodeURIComponent(name), { method: 'DELETE' }).then(function (data) {
          if (data && data.error) {
            qs('[data-dse-skill-count]', overlay).textContent = data.error
            return
          }
          skills = (data && data.skills) || []
          renderSkills(qs('[data-dse-skill-search]', overlay).value)
        }).catch(function (error) {
          qs('[data-dse-skill-count]', overlay).textContent = '删除失败：' + error.message
        })
      })
    })
  }

  function showCandidates() {
    var body = qs('[data-dse-mcp-body]', overlay)
    body.innerHTML = '<div class="dse-mcp-msg">加载中…</div>'
    api('/skill-candidates').then(function (data) {
      var candidates = (data && data.skills) || []
      if (candidates.length === 0) {
        body.innerHTML = '<div class="dse-mcp-empty">没有可导入的本地技能</div>'
        body.innerHTML += '<div class="dse-mcp-actions"><button type="button" class="dse-mcp-btn" data-dse-skill-back>返回</button></div>'
        qs('[data-dse-skill-back]', body).addEventListener('click', function () {
          body.innerHTML = ''
          api('/skills').then(function (d) {
            skills = (d && d.skills) || []
            openSkillsBody()
          })
        })
        return
      }
      body.innerHTML = '<div class="dse-skill-count">从本地技能库选择（Codex / Agents）</div>' +
        candidates.map(function (c) {
          return '<div class="dse-mcp-row">' +
            '<div class="dse-mcp-row-info">' +
            '<div class="dse-mcp-row-name"><span>' + esc(c.name) + '</span>' +
            '<span class="dse-mcp-badge">' + esc(c.source) + '</span>' +
            (c.installed ? '<span class="dse-mcp-badge">已安装</span>' : '') +
            '</div>' +
            '<div class="dse-skill-desc">' + esc(c.description) + '</div>' +
            '</div>' +
            (c.installed
              ? ''
              : '<button type="button" class="dse-mcp-btn dse-mcp-btn-primary" data-dse-skill-install="' + esc(c.path) + '">安装</button>') +
            '</div>'
        }).join('') +
        '<div class="dse-mcp-actions"><button type="button" class="dse-mcp-btn" data-dse-skill-back>返回</button></div>'
      qsa('[data-dse-skill-install]', body).forEach(function (button) {
        button.addEventListener('click', function () {
          api('/skills', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sourcePath: button.getAttribute('data-dse-skill-install') }),
          }).then(function (res) {
            if (res && res.error) { body.innerHTML = '<div class="dse-mcp-msg error">' + esc(res.error) + '</div>'; return }
            skills = (res && res.skills) || []
            openSkillsBody()
          }).catch(function (error) {
            body.innerHTML = '<div class="dse-mcp-msg error">安装失败：' + esc(error.message) + '</div>'
          })
        })
      })
      var back = qs('[data-dse-skill-back]', body)
      if (back) back.addEventListener('click', function () { openSkillsBody() })
    }).catch(function (error) {
      body.innerHTML = '<div class="dse-mcp-msg error">加载失败：' + esc(error.message) + '</div>'
    })
  }

  function installFromFolder() {
    api('/pick').then(function (data) {
      if (!data || !data.path) return
      var body = qs('[data-dse-mcp-body]', overlay)
      body.innerHTML = '<div class="dse-mcp-msg">正在导入…</div>'
      api('/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourcePath: data.path }),
      }).then(function (res) {
        if (res && res.error) { body.innerHTML = '<div class="dse-mcp-msg error">' + esc(res.error) + '</div>'; return }
        skills = (res && res.skills) || []
        openSkillsBody()
      }).catch(function (error) {
        body.innerHTML = '<div class="dse-mcp-msg error">导入失败：' + esc(error.message) + '</div>'
      })
    }).catch(function (error) {
      qs('[data-dse-mcp-body]', overlay).innerHTML = '<div class="dse-mcp-msg error">选择失败：' + esc(error.message) + '</div>'
    })
  }

  function openSkillsBody() {
    var body = qs('[data-dse-mcp-body]', overlay)
    body.innerHTML =
      '<div class="dse-mcp-field dse-skill-search"><input data-dse-skill-search placeholder="搜索技能…" spellcheck="false"></div>' +
      '<div class="dse-skill-count" data-dse-skill-count></div>' +
      '<div data-dse-skill-list></div>' +
      '<div class="dse-mcp-actions">' +
      '<button type="button" class="dse-mcp-btn" data-dse-skill-local>从本地导入</button>' +
      '<button type="button" class="dse-mcp-btn" data-dse-skill-folder>从文件夹导入</button>' +
      '</div>'
    qs('[data-dse-skill-search]', body).addEventListener('input', function (ev) {
      renderSkills(ev.target.value)
    })
    qs('[data-dse-skill-local]', body).addEventListener('click', showCandidates)
    qs('[data-dse-skill-folder]', body).addEventListener('click', installFromFolder)
    renderSkills('')
  }

  function openOverlay() {
    if (overlay !== null && !overlay.isConnected) {
      overlay = null
      inlineHost = null
      hiddenSection = null
    }
    if (overlay !== null) closeOverlay()
    overlay = document.createElement('div')
    overlay.className = 'dse-mcp-overlay'
    overlay.setAttribute('data-dse-mcp', '')
    overlay.innerHTML =
      '<div class="dse-mcp-card">' +
      '<div class="dse-mcp-head"><div class="dse-mcp-title">' + ICON + '<span>MCP 服务器</span></div></div>' +
      '<div class="dse-mcp-body" data-dse-mcp-body></div>' +
      '</div>'
    mountOverlay()
    overlay.addEventListener('mousedown', function (ev) {
      if (ev.target === overlay) closeOverlay()
    })
    document.addEventListener('keydown', function onKey(ev) {
      if (ev.key === 'Escape' && overlay !== null) {
        closeOverlay()
        document.removeEventListener('keydown', onKey)
      }
    })
    loadList()
  }

  function closeOverlay() {
    if (overlay !== null) {
      overlay.remove()
      overlay = null
    }
    if (inlineHost !== null) {
      if (hiddenSection !== null) hiddenSection.style.display = ''
      inlineHost.classList.remove('dse-mcp-options-host')
      inlineHost = null
      hiddenSection = null
    }
  }

  function api(path, options) {
    if (!API) return Promise.reject(new Error('本地 API 不可用'))
    return fetch(API + path, options).then(function (response) { return response.json() })
  }

  function loadList() {
    var body = qs('[data-dse-mcp-body]', overlay)
    body.innerHTML = '<div class="dse-mcp-msg">加载中…</div>'
    api('/mcp').then(function (data) {
      servers = (data && data.servers) || []
      renderList()
    }).catch(function (error) {
      body.innerHTML = '<div class="dse-mcp-msg error">加载失败：' + esc(error.message) + '</div>'
    })
  }

  function renderList() {
    var body = qs('[data-dse-mcp-body]', overlay)
    if (servers.length === 0) {
      body.innerHTML =
        '<div class="dse-mcp-empty">还没有配置 MCP 服务器</div>' +
        '<div class="dse-mcp-actions"><button type="button" class="dse-mcp-btn dse-mcp-btn-primary" data-dse-mcp-add>添加服务器</button></div>'
    } else {
      body.innerHTML = servers.map(function (s) {
        var desc = s.transport === 'stdio' ? esc(s.command) : esc(s.url)
        var badges = '<span class="dse-mcp-badge">' + (s.transport === 'stdio' ? 'stdio' : 'HTTP') + '</span>'
        if (s.enabled === false) badges += '<span class="dse-mcp-badge">已停用</span>'
        return '<div class="dse-mcp-row">' +
          '<div class="dse-mcp-row-info">' +
          '<div class="dse-mcp-row-name"><span>' + esc(s.name) + '</span>' + badges + '</div>' +
          '<div class="dse-mcp-row-desc">' + desc + '</div>' +
          '</div>' +
          '<button type="button" class="dse-mcp-btn" data-dse-mcp-edit="' + esc(s.name) + '">编辑</button>' +
          '<button type="button" class="dse-mcp-btn dse-mcp-btn-danger" data-dse-mcp-del="' + esc(s.name) + '">删除</button>' +
          '</div>'
      }).join('') +
        '<div class="dse-mcp-actions"><button type="button" class="dse-mcp-btn dse-mcp-btn-primary" data-dse-mcp-add>添加服务器</button></div>'
    }
    qsa('[data-dse-mcp-add]', body).forEach(function (button) {
      button.addEventListener('click', function () { editForm(null) })
    })
    qsa('[data-dse-mcp-edit]', body).forEach(function (button) {
      button.addEventListener('click', function () {
        var found = servers.find(function (s) { return s.name === button.getAttribute('data-dse-mcp-edit') })
        if (found) editForm(found)
      })
    })
    qsa('[data-dse-mcp-del]', body).forEach(function (button) {
      button.addEventListener('click', function () {
        var name = button.getAttribute('data-dse-mcp-del')
        if (!window.confirm('确定删除 MCP 服务器 "' + name + '"？')) return
        api('/mcp?name=' + encodeURIComponent(name), { method: 'DELETE' }).then(function (data) {
          if (data && data.error) { showMsg(data.error, true); return }
          showSaved()
        }).catch(function (error) { showMsg(error.message, true) })
      })
    })
  }

  function parseKV(text) {
    var out = {}
    String(text).split('\\n').forEach(function (line) {
      var idx = line.indexOf('=')
      if (idx <= 0) return
      var key = line.slice(0, idx).trim()
      if (key !== '') out[key] = line.slice(idx + 1).trim()
    })
    return out
  }

  function editForm(server) {
    var body = qs('[data-dse-mcp-body]', overlay)
    var s = server || { name: '', transport: 'stdio', command: '', args: [], env: {}, cwd: '', url: '', headers: {}, enabled: true }
    var argsText = (s.args || []).join('\\n')
    var envText = Object.keys(s.env || {}).map(function (k) { return k + '=' + s.env[k] }).join('\\n')
    var headerText = Object.keys(s.headers || {}).map(function (k) { return k + '=' + s.headers[k] }).join('\\n')
    body.innerHTML =
      '<div class="dse-mcp-form-grid">' +
      '<div class="dse-mcp-field"><label>名称</label><input data-dse-f="name" value="' + esc(s.name) + '" placeholder="例如 github" spellcheck="false"></div>' +
      '<div class="dse-mcp-field"><label>传输类型</label><select data-dse-f="transport">' +
      '<option value="stdio"' + (s.transport !== 'streamable-http' ? ' selected' : '') + '>stdio（本地命令）</option>' +
      '<option value="streamable-http"' + (s.transport === 'streamable-http' ? ' selected' : '') + '>streamable-http（远程 URL）</option>' +
      '</select></div>' +
      '<div class="dse-mcp-field dse-mcp-stdio-only"><label>启动命令</label><input data-dse-f="command" value="' + esc(s.command) + '" placeholder="例如 npx" spellcheck="false"></div>' +
      '<div class="dse-mcp-field dse-mcp-stdio-only"><label>参数（每行一个）</label><textarea data-dse-f="args" placeholder="-y&#10;@modelcontextprotocol/server-github" spellcheck="false">' + esc(argsText) + '</textarea></div>' +
      '<div class="dse-mcp-field dse-mcp-stdio-only dse-mcp-full"><label>环境变量（KEY=VALUE，每行一个）</label><textarea data-dse-f="env" spellcheck="false">' + esc(envText) + '</textarea></div>' +
      '<div class="dse-mcp-field dse-mcp-stdio-only dse-mcp-full"><label>工作目录（可选）</label><input data-dse-f="cwd" value="' + esc(s.cwd || '') + '" placeholder="例如 C:/work" spellcheck="false"></div>' +
      '<div class="dse-mcp-field dse-mcp-http-only dse-mcp-full"><label>服务器 URL</label><input data-dse-f="url" value="' + esc(s.url) + '" placeholder="https://example.com/mcp" spellcheck="false"></div>' +
      '<div class="dse-mcp-field dse-mcp-http-only dse-mcp-full"><label>请求头（KEY=VALUE，每行一个）</label><textarea data-dse-f="headers" spellcheck="false">' + esc(headerText) + '</textarea></div>' +
      '<div class="dse-mcp-field dse-mcp-full"><label>工具调用超时（秒，可选）</label><input data-dse-f="timeout" type="number" min="1" value="' + esc(s.toolCallTimeoutMs ? String(Math.round(s.toolCallTimeoutMs / 1000)) : '') + '" placeholder="默认 60" spellcheck="false"></div>' +
      '</div>' +
      '<label class="dse-mcp-check"><input type="checkbox" data-dse-f="enabled"' + (s.enabled !== false ? ' checked' : '') + '>启用该服务器</label>' +
      '<div class="dse-mcp-actions">' +
      '<button type="button" class="dse-mcp-btn" data-dse-mcp-cancel>取消</button>' +
      '<button type="button" class="dse-mcp-btn dse-mcp-btn-primary" data-dse-mcp-save>' + (server !== null ? '保存' : '添加') + '</button>' +
      '</div>'
    var transportSel = qs('[data-dse-f="transport"]', body)
    var toggleFields = function () {
      var http = transportSel.value === 'streamable-http'
      qsa('.dse-mcp-stdio-only', body).forEach(function (el) { el.style.display = http ? 'none' : '' })
      qsa('.dse-mcp-http-only', body).forEach(function (el) { el.style.display = http ? '' : 'none' })
    }
    transportSel.addEventListener('change', toggleFields)
    toggleFields()
    qs('[data-dse-mcp-cancel]', body).addEventListener('click', renderList)
    qs('[data-dse-mcp-save]', body).addEventListener('click', function () {
      var payload = {
        name: qs('[data-dse-f="name"]', body).value,
        transport: transportSel.value,
        enabled: qs('[data-dse-f="enabled"]', body).checked,
        command: qs('[data-dse-f="command"]', body).value,
        args: qs('[data-dse-f="args"]', body).value.split('\\n').map(function (x) { return x.trim() }).filter(Boolean),
        env: parseKV(qs('[data-dse-f="env"]', body).value),
        cwd: qs('[data-dse-f="cwd"]', body).value,
        url: qs('[data-dse-f="url"]', body).value,
        headers: parseKV(qs('[data-dse-f="headers"]', body).value),
        toolCallTimeoutMs: (function () {
          var raw = Number(qs('[data-dse-f="timeout"]', body).value)
          return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) : undefined
        })(),
      }
      api('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (data) {
        if (data && data.error) { showMsg(data.error, true); return }
        showSaved()
      }).catch(function (error) { showMsg(error.message, true) })
    })
  }

  function showMsg(text, isError) {
    var body = qs('[data-dse-mcp-body]', overlay)
    body.innerHTML = '<div class="dse-mcp-msg' + (isError ? ' error' : '') + '">' + esc(text) + '</div>'
  }

  function showSaved() {
    var body = qs('[data-dse-mcp-body]', overlay)
    body.innerHTML = '<div class="dse-mcp-msg ok">已保存，正在重启服务…</div>'
  }

  // Mount the settings entry the same frame the modal appears, so it never
  // pops in late; the interval only guards against React re-renders.
  var mountTimer = null
  function scheduleMount() {
    if (mountTimer !== null) return
    mountTimer = setTimeout(function () {
      mountTimer = null
      mountNav()
    }, 0)
  }
  new MutationObserver(scheduleMount).observe(document.body, { childList: true, subtree: true })
  mountNav()
  setInterval(mountNav, 2000)
})()`

/**
 * Mount the thinking slider once the composer is on screen. The CSS/JS ride
 * the same injection seam as the background artwork, so the stock UI stays
 * untouched and the slider survives app updates that re-render the page.
 */
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
    await win.webContents.executeJavaScript(
      `window.__DSH_MCP_API__ = ${JSON.stringify('http://127.0.0.1:' + dialogPort)}; true`,
    ).catch(() => {})
    await win.webContents.executeJavaScript(EFFORT_SLIDER_JS)
    await win.webContents.insertCSS(MCP_MANAGER_CSS)
    await win.webContents.executeJavaScript(MCP_MANAGER_JS)
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
      sendJson(404, { error: 'not found' })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      dialogPort = server.address().port
      dialogServer = server
      resolve()
    })
  })
}

/** Terminate the server process tree (Windows cannot deliver POSIX signals). */
function stopServer() {
  if (server === null || server.killed) return
  const pid = server.pid
  server.kill()
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  }
}

let restartTimer = null

/**
 * Debounced MCP-change restart: save requests respond immediately, then the
 * dsh server restarts with the regenerated patch and the window reloads.
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
async function restartServerAndReload() {
  if (quitting || mainWindow === null || mainWindow.isDestroyed()) return
  try {
    stopServer()
    const url = await startServer()
    serverUrl = url
    await mainWindow.loadURL(url)
    await injectThemeGuard(mainWindow)
    void injectBackgroundWhenReady(mainWindow)
    void injectEffortSlider(mainWindow)
  } catch {
    // The old page stays visible if the restart fails.
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
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'workspace-write',
        // Every descendant Node process (background workers, subagents, MCP
        // servers, npx) loads the console-hiding shim; console shells are
        // routed through the hidden-console launcher so no black window can
        // flash even from nested spawns.
        DSH_HIDE_LAUNCHER: launcherPath,
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
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)
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
      if (serverUrl !== null) return
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
  const mcpNavProbe = await win.webContents.executeJavaScript(`(async () => {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find(b =>
      b.querySelector('[data-slot="settings.trigger"]') !== null)
    if (trigger === undefined) return { found: false }
    trigger.click()
    await new Promise(resolve => setTimeout(resolve, 300))
    const skillsApi = window.__DSH_MCP_API__
      ? await fetch(window.__DSH_MCP_API__ + '/skills').then(r => r.json()).catch(e => ({ error: String(e) }))
      : null
    let candidatesCount = null
    let installOk = null
    if (window.__DSH_MCP_API__) {
      const candidates = await fetch(window.__DSH_MCP_API__ + '/skill-candidates')
        .then(r => r.json()).catch(e => ({ error: String(e) }))
      candidatesCount = candidates.skills ? candidates.skills.length : 'ERR'
      const glm = (candidates.skills || []).find(s => s.name === 'glm-vision')
      if (glm) {
        const installed = await fetch(window.__DSH_MCP_API__ + '/skills', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourcePath: glm.path }),
        }).then(r => r.json()).catch(e => ({ error: String(e) }))
        installOk = !!(installed && installed.ok)
      }
    }
    return {
      found: true,
      navMounted: document.querySelector('[data-dse-mcp-nav]') !== null,
      skillNavMounted: document.querySelector('[data-dse-skill-nav]') !== null,
      skillsCount: skillsApi === null ? null
        : skillsApi.skills ? skillsApi.skills.length : 'ERR',
      candidatesCount,
      installOk,
    }
  })()`)
  console.log(`DSH_MCPNAV ${JSON.stringify(mcpNavProbe)}`)
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
    const mcpApi = window.__DSH_MCP_API__
      ? await fetch(window.__DSH_MCP_API__ + '/mcp').then(r => r.json()).catch(e => ({ error: String(e) }))
      : null
    const mcpWrite = window.__DSH_MCP_API__
      ? await (async () => {
        const api = window.__DSH_MCP_API__
        const post = await fetch(api + '/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'smoke-test', transport: 'stdio', command: 'echo', args: ['hi'], enabled: true }),
        }).then(r => r.json()).catch(e => ({ error: String(e) }))
        const afterAdd = await fetch(api + '/mcp').then(r => r.json()).catch(e => ({ error: String(e) }))
        const del = await fetch(api + '/mcp?name=smoke-test', { method: 'DELETE' })
          .then(r => r.json()).catch(e => ({ error: String(e) }))
        const afterDel = await fetch(api + '/mcp').then(r => r.json()).catch(e => ({ error: String(e) }))
        return {
          postOk: !!(post && post.ok),
          countAfterAdd: (afterAdd.servers || []).length,
          delOk: !!(del && del.ok),
          countAfterDel: (afterDel.servers || []).length,
        }
      })()
      : null
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
    return { pill: pill === null ? null : pill.textContent.trim(), panel, panelW, titleVal, dots, trackTop, hasFlare, chibi, chibiStatus, mcpApi, mcpWrite, pillMax, titleMax, pillAnim, titleAnim, titleColor, maxFx, valueLatin, titleLatin, pillGeo, trailingGeo, sliderGeo, reMountText, effortHidden }
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
      win.webContents.executeJavaScript(`(() => {
        var WALLPAPERS = ['whale', 'blue-fantasy', 'harbor', 'dragon', 'miku', 'summer', 'whale-mom', 'maid']
        function builtInFingerprint(dataUrl) {
          return dataUrl.length + ':' + dataUrl.slice(0, 40)
        }
        function openWallpaperDb() {
          return new Promise(function (resolve, reject) {
            var req = indexedDB.open('dsh-aqua-media', 1)
            req.onupgradeneeded = function () {
              var db = req.result
              if (!db.objectStoreNames.contains('wallpaper')) db.createObjectStore('wallpaper')
            }
            req.onsuccess = function () { resolve(req.result) }
            req.onerror = function () { reject(req.error || new Error('idb open failed')) }
          })
        }
        function idbGet(key) {
          return openWallpaperDb().then(function (db) {
            return new Promise(function (resolve, reject) {
              var r = db.transaction('wallpaper', 'readonly').objectStore('wallpaper').get(key)
              r.onsuccess = function () { var v = r.result || null; db.close(); resolve(v) }
              r.onerror = function () { db.close(); reject(r.error) }
            })
          }).catch(function () { return null })
        }
        function idbDel(key) {
          return openWallpaperDb().then(function (db) {
            return new Promise(function (resolve) {
              var tx = db.transaction('wallpaper', 'readwrite')
              tx.objectStore('wallpaper').delete(key)
              tx.oncomplete = function () { db.close(); resolve() }
              tx.onerror = function () { db.close(); resolve() }
              tx.onabort = function () { db.close(); resolve() }
            })
          }).catch(function () {})
        }
        function loadUserMedia(marker) {
          if (marker.indexOf('idb:') === 0) return idbGet(marker.slice(4))
          if (marker.indexOf('fsa:') === 0) return idbGet('videoHandle').then(function (h) { return h && h.getFile ? h.getFile() : null })
          return Promise.resolve(null)
        }
        function setAquaStorage(key, value) {
          try {
            if (value === null) localStorage.removeItem(key)
            else localStorage.setItem(key, value)
            window.dispatchEvent(new StorageEvent('storage', { key: key, newValue: value }))
          } catch (e) {}
        }
        function applyWallpaperLive(dataUrl, name, fingerprint) {
          setAquaStorage('dsh.ui-aqua.wallpaper', dataUrl)
          setAquaStorage('dsh.ui-aqua.background', 'wallpaper')
          try {
            localStorage.setItem('dsh.ui-aqua.wallpaperSource', name)
            localStorage.setItem('dsh.ui-aqua.wallpaperBuiltInFp', fingerprint)
          } catch (e) {}
          var b = document.querySelector('.dse-wallpaper-box')
          if (b) syncUserWallpaper(b)
        }
        function applyUserMedia(marker) {
          if (!marker) return
          setAquaStorage('dsh.ui-aqua.wallpaper', marker)
          setAquaStorage('dsh.ui-aqua.background', 'wallpaper')
          try {
            localStorage.removeItem('dsh.ui-aqua.wallpaperSource')
            localStorage.removeItem('dsh.ui-aqua.wallpaperBuiltInFp')
          } catch (e) {}
          var b = document.querySelector('.dse-wallpaper-box')
          if (b) syncUserWallpaper(b)
        }
        function applyBuiltIn(name) {
          fetch('/wallpapers/' + name + '.jpg').then(function (res) { return res.blob() }).then(function (blob) {
            return new Promise(function (resolve, reject) {
              var reader = new FileReader()
              var file = new File([blob], name + '.jpg', { type: 'image/jpeg' })
              reader.onload = function () { resolve(reader.result) }
              reader.onerror = reject
              reader.readAsDataURL(file)
            })
          }).then(function (dataUrl) {
            applyWallpaperLive(dataUrl, name, builtInFingerprint(dataUrl))
          }).catch(function () {})
        }
        var FONT_OPTIONS = [
          { value: '', label: '跟随系统' },
          { value: '"Microsoft YaHei", "微软雅黑", sans-serif', label: '微软雅黑' },
          { value: '"PingFang SC", "Microsoft YaHei", sans-serif', label: '苹方' },
          { value: '"Noto Sans SC", "Microsoft YaHei", sans-serif', label: '思源黑体' },
          { value: '"SimSun", "宋体", serif', label: '宋体' },
          { value: '"DengXian", "等线", sans-serif', label: '等线' },
          { value: 'ui-monospace, "Cascadia Code", Consolas, monospace', label: '等宽字体' },
        ]
        function applyChatFont() {
          var size = localStorage.getItem('dsh.desktop.chatFontSize') || '16'
          var fam = localStorage.getItem('dsh.desktop.chatFontFamily') || ''
          var root = document.documentElement
          root.style.setProperty('--dse-chat-font-size', size + 'px')
          root.style.setProperty('--dse-chat-font-family', fam || 'var(--dsw-font-family)')
          var box = document.querySelector('.dse-chat-font-box')
          if (box) {
            var slider = box.querySelector('.dse-chat-font-size')
            var val = box.querySelector('.dse-chat-font-value')
            var sel = box.querySelector('.dse-chat-font-family')
            if (slider) slider.value = size
            if (val) val.textContent = size + 'px'
            if (sel) sel.value = fam
          }
        }
        function mountChatFontBox() {
          var dialog = document.querySelector('[class*="VOzbGW_panel"]')
          if (!dialog || dialog.querySelector('.dse-chat-font-box')) return
          var anchor = dialog.querySelector('[class*="_8HJdBW_group"]')
          if (!anchor) return
          var box = document.createElement('div')
          box.className = 'dse-chat-font-box'
          box.innerHTML =
            '<div class="dse-chat-font-title">会话字体</div>' +
            '<div class="dse-chat-font-row"><span class="dse-chat-font-label">字号</span><input type="range" class="dse-chat-font-size" min="12" max="24" step="1"><span class="dse-chat-font-value">16px</span></div>' +
            '<div class="dse-chat-font-row"><span class="dse-chat-font-label">字体</span><select class="dse-chat-font-family">' +
            FONT_OPTIONS.map(function (o) { return '<option value="' + o.value.replace(/"/g, '&quot;') + '">' + o.label + '</option>' }).join('') +
            '</select></div>'
          anchor.insertAdjacentElement('afterend', box)
          var slider = box.querySelector('.dse-chat-font-size')
          var sel = box.querySelector('.dse-chat-font-family')
          var val = box.querySelector('.dse-chat-font-value')
          if (slider) slider.addEventListener('input', function () {
            try { localStorage.setItem('dsh.desktop.chatFontSize', slider.value) } catch (e) {}
            if (val) val.textContent = slider.value + 'px'
            applyChatFont()
          })
          if (sel) sel.addEventListener('change', function () {
            try { localStorage.setItem('dsh.desktop.chatFontFamily', sel.value) } catch (e) {}
            applyChatFont()
          })
          applyChatFont()
        }
        function mountRemoteCard() {
          var dialog = document.querySelector('[class*="VOzbGW_panel"]')
          if (!dialog || dialog.querySelector('.dse-remote-card')) return
          var anchor = dialog.querySelector('[class*="_8HJdBW_group"]')
          if (!anchor) return
          var card = document.createElement('div')
          card.className = 'dse-remote-card'
          card.innerHTML =
            '<div class="dse-remote-title">移动端远程控制</div>' +
            '<div class="dse-remote-row"><span class="dse-remote-label">本机服务地址</span><code class="dse-remote-code">http://127.0.0.1:17890</code></div>' +
            '<div class="dse-remote-hint">内网穿透请映射 127.0.0.1:17890</div>' +
            '<button type="button" class="dse-remote-open">打开远程控制面板</button>'
          var ref = dialog.querySelector('.dse-chat-font-box') || anchor
          ref.insertAdjacentElement('afterend', card)
          card.querySelector('.dse-remote-open').addEventListener('click', function () {
            var trigger = document.querySelector('button[aria-label="移动端远程控制"]')
            if (trigger) trigger.click()
          })
        }
        var clusterObservedPanel = null
        var clusterObservedHeader = null
        function syncToggleCluster() {
          var cluster = document.querySelector('.nArs4W_toggleCluster')
          if (!cluster) return
          var header = document.querySelector('[data-phase] header') || document.querySelector('header')
          if (!header) return
          var hr = header.getBoundingClientRect()
          var right = Math.max(8, Math.round(window.innerWidth - hr.right + 12))
          cluster.style.setProperty('--dse-cluster-right', right + 'px')
        }
        function ensureClusterObserver() {
          if (!window.__dseClusterRO) {
            try { window.__dseClusterRO = new ResizeObserver(syncToggleCluster) } catch (e) { return }
          }
          var panel = document.querySelector('.nArs4W_panel')
          var header = document.querySelector('[data-phase] header') || document.querySelector('header')
          if (panel && panel !== clusterObservedPanel) {
            window.__dseClusterRO.observe(panel)
            clusterObservedPanel = panel
          }
          if (header && header !== clusterObservedHeader) {
            window.__dseClusterRO.observe(header)
            clusterObservedHeader = header
          }
          syncToggleCluster()
        }
        function findWallpaperRow() {
          var dialog = document.querySelector('[class*="VOzbGW_panel"]')
          if (!dialog) return null
          return [...dialog.querySelectorAll('*')].find(function (el) {
            if (el.children.length === 0) return false
            var text = (el.textContent || '').trim()
            return text.indexOf('壁纸') === 0 && text.indexOf('选择') !== -1 && el.querySelectorAll('input[type="file"]').length > 0
          }) || null
        }
        function revokeUserMedia(tile) {
          if (tile && tile._mediaUrl) {
            try { URL.revokeObjectURL(tile._mediaUrl) } catch (e) {}
            tile._mediaUrl = ''
          }
        }
        function syncUserWallpaper(box) {
          var wp = localStorage.getItem('dsh.ui-aqua.wallpaper') || ''
          var fp = wp.length + ':' + wp.slice(0, 40)
          var builtInFp = localStorage.getItem('dsh.ui-aqua.wallpaperBuiltInFp') || ''
          var source = localStorage.getItem('dsh.ui-aqua.wallpaperSource') || ''
          var isBuiltIn = builtInFp !== '' && builtInFp === fp
          var isImage = wp.indexOf('data:image') === 0
          var isVideo = wp.indexOf('data:video') === 0 || wp.indexOf('idb:') === 0 || wp.indexOf('fsa:') === 0
          try {
            if (isImage && !isBuiltIn && localStorage.getItem('dsh.ui-aqua.lastUserImage') !== wp) {
              localStorage.setItem('dsh.ui-aqua.lastUserImage', wp)
            }
            if (isVideo && localStorage.getItem('dsh.ui-aqua.lastUserVideo') !== wp) {
              localStorage.setItem('dsh.ui-aqua.lastUserVideo', wp)
            }
          } catch (e) {}
          var lastImage = localStorage.getItem('dsh.ui-aqua.lastUserImage') || ''
          var lastVideo = localStorage.getItem('dsh.ui-aqua.lastUserVideo') || ''
          var imgTile = box.querySelector('[data-user="image"]')
          var vidTile = box.querySelector('[data-user="video"]')
          if (imgTile) {
            imgTile.hidden = lastImage === ''
            if (lastImage !== '') {
              var im = imgTile.querySelector('img')
              if (im && im.getAttribute('src') !== lastImage) im.src = lastImage
              imgTile.classList.toggle('is-active', isImage && !isBuiltIn && wp === lastImage)
            } else {
              imgTile.classList.remove('is-active')
            }
          }
          if (vidTile) {
            vidTile.hidden = lastVideo === ''
            if (lastVideo !== '') {
              vidTile.classList.toggle('is-active', isVideo && wp === lastVideo)
              if (vidTile.dataset.marker !== lastVideo) {
                vidTile.dataset.marker = lastVideo
                revokeUserMedia(vidTile)
                var v = vidTile.querySelector('video')
                var lab = vidTile.querySelector('small')
                if (v) v.removeAttribute('src')
                if (lab) lab.textContent = '加载中…'
                loadUserMedia(lastVideo).then(function (blob) {
                  if (!blob || vidTile.dataset.marker !== lastVideo) return
                  var url = URL.createObjectURL(blob)
                  revokeUserMedia(vidTile)
                  vidTile._mediaUrl = url
                  if (v) v.src = url
                  if (lab) lab.textContent = '我的视频'
                  if (v) { var p = v.play(); if (p && p.catch) p.catch(function () {}) }
                })
              }
            } else {
              vidTile.classList.remove('is-active')
              vidTile.dataset.marker = ''
              revokeUserMedia(vidTile)
              var v2 = vidTile.querySelector('video')
              if (v2) v2.removeAttribute('src')
            }
          }
          box.querySelectorAll('.dse-wallpaper-item').forEach(function (item) {
            if (item.hasAttribute('data-user')) return
            var url = item.getAttribute('data-wallpaper')
            var name = url.split('/').pop().replace('.jpg', '')
            item.classList.toggle('is-active', isBuiltIn && source === name)
          })
        }
        function mountWallpaperBox() {
          var dialog = document.querySelector('[class*="VOzbGW_panel"]')
          if (!dialog || dialog.querySelector('.dse-wallpaper-box')) return
          var row = findWallpaperRow()
          if (!row) return
          var inputs = row.querySelectorAll('input[type="file"]')
          var imageInput = inputs[0] || null
          var videoInput = inputs[1] || null
          var box = document.createElement('div')
          box.className = 'dse-wallpaper-box'
          var grid = WALLPAPERS.map(function (name) {
            return '<div class="dse-wallpaper-item" data-wallpaper="/wallpapers/' + name + '.jpg"><img src="/wallpapers/' + name + '.jpg" alt=""></div>'
          }).join('')
          box.innerHTML =
            '<div class="dse-wallpaper-head">' +
              '<div class="dse-wallpaper-tabs">' +
                '<button type="button" data-tab="image" class="is-active">图片</button>' +
                '<button type="button" data-tab="video">视频</button>' +
              '</div>' +
              '<button type="button" class="dse-wallpaper-delete">删除</button>' +
            '</div>' +
            '<div class="dse-wallpaper-pane" data-pane="image">' +
              '<div class="dse-wallpaper-grid">' +
                '<div class="dse-wallpaper-item dse-wallpaper-user" data-user="image" hidden><img src="" alt="我的上传"><small>我的上传</small></div>' +
                grid +
                '<div class="dse-wallpaper-upload" data-upload="image"><span>＋</span><small>上传图片</small></div>' +
              '</div>' +
            '</div>' +
            '<div class="dse-wallpaper-pane" data-pane="video" hidden>' +
              '<div class="dse-wallpaper-video">' +
                '<div class="dse-wallpaper-item dse-wallpaper-user" data-user="video" hidden><video muted loop playsinline preload="metadata"></video><small>我的视频</small></div>' +
                '<div class="dse-wallpaper-upload" data-upload="video"><span>＋</span><small>上传视频</small></div>' +
                '<p class="dse-wallpaper-note">视频仅支持本地上传，选择后会自动保存</p>' +
              '</div>' +
            '</div>'
          row.style.display = 'none'
          row.insertAdjacentElement('afterend', box)
          box.querySelectorAll('[data-tab]').forEach(function (tab) {
            tab.addEventListener('click', function () {
              box.querySelectorAll('[data-tab]').forEach(function (t) { t.classList.remove('is-active') })
              tab.classList.add('is-active')
              box.querySelector('[data-pane="image"]').hidden = tab.getAttribute('data-tab') !== 'image'
              box.querySelector('[data-pane="video"]').hidden = tab.getAttribute('data-tab') !== 'video'
            })
          })
          box.querySelectorAll('.dse-wallpaper-item').forEach(function (item) {
            if (item.hasAttribute('data-user')) return
            item.addEventListener('click', function () {
              var url = item.getAttribute('data-wallpaper')
              applyBuiltIn(url.split('/').pop().replace('.jpg', ''))
            })
          })
          var userImage = box.querySelector('[data-user="image"]')
          var userVideo = box.querySelector('[data-user="video"]')
          if (userImage) userImage.addEventListener('click', function () {
            applyUserMedia(localStorage.getItem('dsh.ui-aqua.lastUserImage') || '')
          })
          if (userVideo) userVideo.addEventListener('click', function () {
            applyUserMedia(localStorage.getItem('dsh.ui-aqua.lastUserVideo') || '')
          })
          var uploadImage = box.querySelector('[data-upload="image"]')
          var uploadVideo = box.querySelector('[data-upload="video"]')
          if (uploadImage) uploadImage.addEventListener('click', function () {
            var fresh = findWallpaperRow()
            var input = fresh ? fresh.querySelectorAll('input[type="file"]')[0] : imageInput
            if (input) input.click()
          })
          if (uploadVideo) uploadVideo.addEventListener('click', function () {
            var fresh = findWallpaperRow()
            var input = fresh ? fresh.querySelectorAll('input[type="file"]')[1] : videoInput
            if (input) input.click()
          })
          var del = box.querySelector('.dse-wallpaper-delete')
          if (del) del.addEventListener('click', function () {
            try {
              var cur = localStorage.getItem('dsh.ui-aqua.wallpaper') || ''
              if (cur === localStorage.getItem('dsh.ui-aqua.lastUserVideo')) {
                localStorage.removeItem('dsh.ui-aqua.lastUserVideo')
                if (cur.indexOf('idb:') === 0) idbDel(cur.slice(4))
                if (cur.indexOf('fsa:') === 0) idbDel('videoHandle')
              }
              if (cur === localStorage.getItem('dsh.ui-aqua.lastUserImage')) {
                localStorage.removeItem('dsh.ui-aqua.lastUserImage')
              }
            } catch (e) {}
            applyBuiltIn('whale')
          })
          syncUserWallpaper(box)
          if (!window.__dseWallpaperWatcher) {
            window.__dseWallpaperWatcher = true
            setInterval(function () {
              var b = document.querySelector('.dse-wallpaper-box')
              if (b) syncUserWallpaper(b)
            }, 800)
          }
        }
        mountWallpaperBox()
        mountChatFontBox()
        mountRemoteCard()
        applyChatFont()
        ensureClusterObserver()
        if (!window.__dseClusterResize) {
          window.__dseClusterResize = true
          window.addEventListener('resize', syncToggleCluster)
        }
        new MutationObserver(function () {
          mountWallpaperBox()
          mountChatFontBox()
          mountRemoteCard()
          ensureClusterObserver()
        }).observe(document.body, { childList: true, subtree: true })
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
    void injectEffortSlider(mainWindow)
  })

  await mainWindow.loadURL(serverUrl)
  if (SMOKE || !HIDDEN_START) mainWindow.show()
  await injectThemeGuard(mainWindow)
  if (SMOKE) {
    await injectBackgroundWhenReady(mainWindow)
    await injectEffortSlider(mainWindow, true)
    await runSmoke(mainWindow)
  } else {
    void injectBackgroundWhenReady(mainWindow)
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
      seedChibiSprite()
      seedWallpapers()
      ensureMcpFiles()
      ensureGlmSkill()
      ensureAquaPlugin()
      ensureWebUiFamily()
      await startDialogServer()
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
