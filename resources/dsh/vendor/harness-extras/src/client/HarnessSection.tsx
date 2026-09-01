/**
 * Harness-extras settings sections: three management lists over the desktop
 * shell's local bridge API (`window.__DSH_MCP_API__`, injected by the
 * Electron main process). Each section renders inside the stock settings
 * panel through the `settings.section` slot, so nav identity, selection
 * animation, and content chrome are the kernel's own.
 *
 * - MCP servers: full CRUD over mcp-servers.json (a save restarts the host
 *   server so the regenerated patch rows load).
 * - Skills: list/install/remove over the app-managed dsh-home/skills root.
 * - Subagents: read-only projection of the delegation tool rows declared
 *   across the agent presets.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/** Local bridge base URL (injected per page by the desktop shell). */
const apiBase = (): string => (globalThis as { __DSH_MCP_API__?: string }).__DSH_MCP_API__ ?? ''

/** One JSON round trip against the local bridge; failures surface as Error. */
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiBase() + path, options)
  return await response.json() as T
}

function postJson(path: string, body: unknown): Promise<{ ok?: boolean; error?: string }> {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── shared styling (scoped class names, one injected stylesheet) ────────────

const STYLE_ID = 'dshx-section-style'
const STYLE = `
.dshx-wrap { display:flex; flex-direction:column; gap:10px; padding: 4px 2px 24px; }
.dshx-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.dshx-count { font-size:12px; color:var(--dsw-alias-label-tertiary,#9296a0); }
.dshx-rows { display:flex; flex-direction:column; gap:8px; }
.dshx-row { display:flex; align-items:center; gap:12px; padding:12px 14px;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));
  border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); }
.dshx-row-main { flex:1; min-width:0; }
.dshx-row-title { display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600;
  color:var(--dsw-alias-label-primary,#1a1d26); }
.dshx-badge { font-size:10.5px; padding:1px 7px; border-radius:999px; font-weight:500;
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-secondary,#686c75); }
.dshx-badge[data-on="true"] { background:rgba(26,127,55,.12); color:#1a7f37; }
.dshx-badge[data-on="false"] { background:rgba(200,62,77,.1); color:#c83e4d; }
.dshx-row-desc { margin-top:3px; font-size:12px; color:var(--dsw-alias-label-tertiary,#9296a0);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshx-actions { display:flex; gap:6px; flex:none; }
.dshx-msg { font-size:12.5px; color:var(--dsw-alias-label-tertiary,#9296a0); padding:18px 0; }
.dshx-msg[data-kind="error"] { color:var(--dsw-alias-state-error-primary,#c83e4d); }
.dshx-field { display:flex; flex-direction:column; gap:5px; }
.dshx-field > label { font-size:12px; color:var(--dsw-alias-label-secondary,#686c75); }
.dshx-field input, .dshx-field select {
  height:32px; padding:0 10px; font-size:13px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));
  background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; outline:none; }
.dshx-field input:focus, .dshx-field select:focus {
  border-color:var(--dsw-alias-border-focus,#4d6bfe); }
.dshx-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.dshx-grid .dshx-full { grid-column:1 / -1; }
.dshx-check { display:flex; align-items:center; gap:7px; font-size:13px; }
`

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = STYLE
  document.head.appendChild(tag)
}

// The stylesheet is plugin-owned chrome: inject it once at module
// materialization so every section render finds its classes already present.
ensureStyle()

// ── data models ──────────────────────────────────────────────────────────────

interface McpServer {
  name: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
}

interface SkillEntry {
  name: string
  description: string
  source?: string
  path?: string
  modelInvocable: boolean
}

interface SkillCandidate {
  name: string
  description: string
  source: string
  path: string
  installed: boolean
}

interface SubagentRow {
  id: string
  preset: string
  root: 'shipped' | 'user'
  provider: string
  toolName: string
  enabled: boolean
}

// ── small view helpers ───────────────────────────────────────────────────────

function Msg({ children, kind }: { children: ReactNode; kind?: 'error' }): ReactNode {
  return <div className="dshx-msg" data-kind={kind}>{children}</div>
}

function RowActions({ children }: { children: ReactNode }): ReactNode {
  return <div className="dshx-actions">{children}</div>
}

// ── MCP servers section ──────────────────────────────────────────────────────

interface McpDraft {
  name: string
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string
  url: string
  enabled: boolean
}

function emptyDraft(): McpDraft {
  return { name: '', transport: 'stdio', command: '', args: '', url: '', enabled: true }
}

function draftOf(server: McpServer): McpDraft {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).join(', '),
    url: server.url ?? '',
    enabled: server.enabled,
  }
}

export function McpSection(): ReactNode {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<McpDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const reload = useCallback((): void => {
    api<{ servers?: McpServer[]; error?: string }>('/mcp')
      .then((data) => {
        if (data.error !== undefined) throw new Error(data.error)
        setServers(data.servers ?? [])
        setError('')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => { reload() }, [reload])

  const openEdit = (server: McpServer): void => {
    setFormError('')
    setDraft(draftOf(server))
  }

  const submit = (): void => {
    if (draft === null) return
    setSaving(true)
    setFormError('')
    const body: Record<string, unknown> = {
      name: draft.name,
      transport: draft.transport,
      enabled: draft.enabled,
    }
    if (draft.transport === 'stdio') {
      body.command = draft.command
      body.args = draft.args.split(',').map(arg => arg.trim()).filter(arg => arg !== '')
    } else {
      body.url = draft.url
    }
    postJson('/mcp', body)
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        setDraft(null)
        reload()
      })
      .catch((err: Error) => { setFormError(err.message) })
      .finally(() => { setSaving(false) })
  }

  const remove = (name: string): void => {
    fetch(`${apiBase()}/mcp?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => { reload() })
      .catch(() => {})
  }

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <span className="dshx-count">{servers === null ? '' : `${servers.length} 个服务器 · 保存后自动重启生效`}</span>
        <Button onClick={() => { setFormError(''); setDraft(emptyDraft()) }}>添加服务器</Button>
      </div>
      {error !== '' && <Msg kind="error">{`加载失败：${error}`}</Msg>}
      {servers !== null && servers.length === 0 && <Msg>暂无 MCP 服务器。点击右上角「添加服务器」配置一个。</Msg>}
      <div className="dshx-rows">
        {(servers ?? []).map(server => (
          <div className="dshx-row" key={server.name}>
            <div className="dshx-row-main">
              <div className="dshx-row-title">
                {server.name}
                <span className="dshx-badge">{server.transport}</span>
                <span className="dshx-badge" data-on={String(server.enabled)}>{server.enabled ? '启用' : '停用'}</span>
              </div>
              <div className="dshx-row-desc">
                {server.transport === 'stdio'
                  ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`
                  : server.url ?? ''}
              </div>
            </div>
            <RowActions>
              <Button variant="outline" onClick={() => { openEdit(server) }}>编辑</Button>
              <Button variant="outline" onClick={() => { remove(server.name) }}>删除</Button>
            </RowActions>
          </div>
        ))}
      </div>
      <Modal
        open={draft !== null}
        onClose={() => { if (!saving) setDraft(null) }}
        title={draft !== null && (servers ?? []).some(s => s.name === draft.name) ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        closeLabel="关闭"
        description="保存后会写入 mcp-servers.json 并自动重启宿主进程使其生效。"
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={() => { setDraft(null) }}>取消</Button>
            <Button disabled={saving} onClick={() => { submit() }}>{saving ? '保存中…' : '保存'}</Button>
          </>
        )}
      >
        {draft !== null && (
          <div className="dshx-grid">
            <div className="dshx-field">
              <label>名称</label>
              <input value={draft.name} spellCheck={false} placeholder="my-server"
                onChange={event => { setDraft({ ...draft, name: event.target.value }) }} />
            </div>
            <div className="dshx-field">
              <label>传输类型</label>
              <select value={draft.transport}
                onChange={event => { setDraft({ ...draft, transport: event.target.value === 'streamable-http' ? 'streamable-http' : 'stdio' }) }}>
                <option value="stdio">stdio</option>
                <option value="streamable-http">streamable-http</option>
              </select>
            </div>
            {draft.transport === 'stdio' ? (
              <>
                <div className="dshx-field dshx-full">
                  <label>启动命令</label>
                  <input value={draft.command} spellCheck={false} placeholder="npx -y @some/mcp-server"
                    onChange={event => { setDraft({ ...draft, command: event.target.value }) }} />
                </div>
                <div className="dshx-field dshx-full">
                  <label>参数（逗号分隔）</label>
                  <input value={draft.args} spellCheck={false} placeholder="--port, 3000"
                    onChange={event => { setDraft({ ...draft, args: event.target.value }) }} />
                </div>
              </>
            ) : (
              <div className="dshx-field dshx-full">
                <label>服务器地址</label>
                <input value={draft.url} spellCheck={false} placeholder="https://example.com/mcp"
                  onChange={event => { setDraft({ ...draft, url: event.target.value }) }} />
              </div>
            )}
            <label className="dshx-check dshx-full">
              <input type="checkbox" checked={draft.enabled}
                onChange={event => { setDraft({ ...draft, enabled: event.target.checked }) }} />
              启用该服务器
            </label>
            {formError !== '' && <Msg kind="error">{formError}</Msg>}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── skills section ───────────────────────────────────────────────────────────

export function SkillsSection(): ReactNode {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [candidates, setCandidates] = useState<SkillCandidate[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [importPath, setImportPath] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importError, setImportError] = useState('')

  const reload = useCallback((): void => {
    Promise.all([
      api<{ skills?: SkillEntry[]; error?: string }>('/skills'),
      api<{ skills?: SkillCandidate[] }>('/skill-candidates').catch(() => ({ skills: [] as SkillCandidate[] })),
    ])
      .then(([list, cands]) => {
        if (list.error !== undefined) throw new Error(list.error)
        setSkills(list.skills ?? [])
        setCandidates((cands.skills ?? []).filter(candidate => !candidate.installed))
        setError('')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => { reload() }, [reload])

  const installByPath = (sourcePath: string, tag: string): void => {
    setBusy(tag)
    postJson('/skills', { sourcePath })
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        setImportOpen(false)
        setImportError('')
        reload()
      })
      .catch((err: Error) => { setImportError(err.message) })
      .finally(() => { setBusy('') })
  }

  const remove = (name: string): void => {
    setBusy(name)
    fetch(`${apiBase()}/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => { reload() })
      .catch(() => {})
      .finally(() => { setBusy('') })
  }

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <span className="dshx-count">{skills === null ? '' : `${skills.length} 个技能`}</span>
        <Button onClick={() => { setImportError(''); setImportOpen(true) }}>从本地导入</Button>
      </div>
      {error !== '' && <Msg kind="error">{`加载失败：${error}`}</Msg>}
      {skills !== null && skills.length === 0 && <Msg>暂无技能。可将含 SKILL.md 的目录导入到 dsh-home/skills。</Msg>}
      <div className="dshx-rows">
        {(skills ?? []).map(skill => (
          <div className="dshx-row" key={skill.name}>
            <div className="dshx-row-main">
              <div className="dshx-row-title">
                {skill.name}
                <span className="dshx-badge" data-on="true">{skill.modelInvocable ? '模型可调用' : '仅用户'}</span>
              </div>
              <div className="dshx-row-desc">{skill.description}</div>
            </div>
            <RowActions>
              <Button variant="outline" disabled={busy === skill.name} onClick={() => { remove(skill.name) }}>
                {busy === skill.name ? '删除中…' : '删除'}
              </Button>
            </RowActions>
          </div>
        ))}
      </div>
      {candidates.length > 0 && (
        <>
          <div className="dshx-toolbar" style={{ marginTop: '10px' }}>
            <span className="dshx-count">可安装的候选技能</span>
          </div>
          <div className="dshx-rows">
            {candidates.map(candidate => (
              <div className="dshx-row" key={candidate.name}>
                <div className="dshx-row-main">
                  <div className="dshx-row-title">
                    {candidate.name}
                    <span className="dshx-badge">{candidate.source}</span>
                  </div>
                  <div className="dshx-row-desc">{candidate.description || candidate.path}</div>
                </div>
                <RowActions>
                  <Button disabled={busy === candidate.name} onClick={() => { installByPath(candidate.path, candidate.name) }}>
                    {busy === candidate.name ? '安装中…' : '安装'}
                  </Button>
                </RowActions>
              </div>
            ))}
          </div>
        </>
      )}
      <Modal
        open={importOpen}
        onClose={() => { if (busy === '') setImportOpen(false) }}
        title="从本地目录导入技能"
        closeLabel="关闭"
        description="填写包含 SKILL.md 的目录的绝对路径。"
        footer={(
          <>
            <Button variant="outline" disabled={busy !== ''} onClick={() => { setImportOpen(false) }}>取消</Button>
            <Button disabled={busy !== '' || importPath.trim() === ''}
              onClick={() => { installByPath(importPath.trim(), '__import__') }}>
              {busy === '__import__' ? '导入中…' : '导入'}
            </Button>
          </>
        )}
      >
        <div className="dshx-field">
          <label>技能目录路径</label>
          <input value={importPath} spellCheck={false} placeholder="C:\\skills\\my-skill"
            onChange={event => { setImportPath(event.target.value) }} />
          {importError !== '' && <Msg kind="error">{importError}</Msg>}
        </div>
      </Modal>
    </div>
  )
}

// ── subagents section ────────────────────────────────────────────────────────

interface SubagentDraft {
  name: string
  provider: 'codex' | 'claude-code'
  toolName: string
  persona: string
}

function emptySubagentDraft(): SubagentDraft {
  return { name: '', provider: 'codex', toolName: '', persona: '' }
}

export function SubagentsSection(): ReactNode {
  const [rows, setRows] = useState<SubagentRow[] | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<SubagentDraft | null>(null)
  const [busy, setBusy] = useState('')
  const [formError, setFormError] = useState('')

  const reload = useCallback((): void => {
    api<{ subagents?: SubagentRow[]; error?: string }>('/subagents')
      .then((data) => {
        if (data.error !== undefined) throw new Error(data.error)
        setRows(data.subagents ?? [])
        setError('')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => { reload() }, [reload])

  const submit = (): void => {
    if (draft === null) return
    setBusy('__create__')
    setFormError('')
    postJson('/subagents', draft)
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        setDraft(null)
        reload()
      })
      .catch((err: Error) => { setFormError(err.message) })
      .finally(() => { setBusy('') })
  }

  const setEnabled = (row: SubagentRow, enabled: boolean): void => {
    setBusy(row.id)
    postJson('/subagents/set-enabled', { id: row.id, enabled })
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        reload()
      })
      .catch((err: Error) => { setError(err.message) })
      .finally(() => { setBusy('') })
  }

  const remove = (row: SubagentRow): void => {
    setBusy(row.id)
    fetch(`${apiBase()}/subagents?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      .then(() => { reload() })
      .catch(() => {})
      .finally(() => { setBusy('') })
  }

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <span className="dshx-count">{rows === null ? '' : `${rows.length} 个委派行`}</span>
        <Button onClick={() => { setFormError(''); setDraft(emptySubagentDraft()) }}>新建子智能体</Button>
      </div>
      {error !== '' && <Msg kind="error">{`加载失败：${error}`}</Msg>}
      {rows !== null && rows.length === 0 && <Msg>暂无子智能体。点击右上角「新建子智能体」添加一个。</Msg>}
      <div className="dshx-rows">
        {(rows ?? []).map(row => (
          <div className="dshx-row" key={`${row.preset}/${row.id}`}>
            <div className="dshx-row-main">
              <div className="dshx-row-title">
                {row.toolName !== '' ? row.toolName : row.id}
                <span className="dshx-badge">{row.provider}</span>
                {row.root === 'user' && <span className="dshx-badge">自定义</span>}
                <span className="dshx-badge" data-on={String(row.enabled)}>{row.enabled ? '启用' : '停用'}</span>
              </div>
              <div className="dshx-row-desc">{`预设：${row.preset} · ${row.id}`}</div>
            </div>
            <RowActions>
              {row.root === 'user' && (
                <>
                  <Button variant="outline" disabled={busy === row.id}
                    onClick={() => { setEnabled(row, !row.enabled) }}>
                    {busy === row.id ? '…' : row.enabled ? '停用' : '启用'}
                  </Button>
                  <Button variant="outline" disabled={busy === row.id}
                    onClick={() => { remove(row) }}>
                    {busy === row.id ? '…' : '删除'}
                  </Button>
                </>
              )}
            </RowActions>
          </div>
        ))}
      </div>
      <Modal
        open={draft !== null}
        onClose={() => { if (busy === '') setDraft(null) }}
        title="新建子智能体"
        closeLabel="关闭"
        description="创建后写入 ~/.dsh/.agent-presets，宿主重启后由内核预设清单自动发现。"
        footer={(
          <>
            <Button variant="outline" disabled={busy !== ''} onClick={() => { setDraft(null) }}>取消</Button>
            <Button disabled={busy !== '' || draft === null || draft.name.trim() === ''}
              onClick={() => { submit() }}>
              {busy === '__create__' ? '创建中…' : '创建'}
            </Button>
          </>
        )}
      >
        {draft !== null && (
          <div className="dshx-grid">
            <div className="dshx-field">
              <label>名称</label>
              <input value={draft.name} spellCheck={false} placeholder="research-helper"
                onChange={event => { setDraft({ ...draft, name: event.target.value }) }} />
            </div>
            <div className="dshx-field">
              <label>提供方</label>
              <select value={draft.provider}
                onChange={event => { setDraft({ ...draft, provider: event.target.value === 'claude-code' ? 'claude-code' : 'codex' }) }}>
                <option value="codex">Codex</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </div>
            <div className="dshx-field dshx-full">
              <label>工具名（选填，默认 subagent_&lt;名称&gt;）</label>
              <input value={draft.toolName} spellCheck={false} placeholder="subagent_research"
                onChange={event => { setDraft({ ...draft, toolName: event.target.value }) }} />
            </div>
            <div className="dshx-field dshx-full">
              <label>人设说明</label>
              <input value={draft.persona} spellCheck={false} placeholder="You are a focused research helper."
                onChange={event => { setDraft({ ...draft, persona: event.target.value }) }} />
            </div>
            {formError !== '' && <Msg kind="error">{formError}</Msg>}
          </div>
        )}
      </Modal>
    </div>
  )
}

