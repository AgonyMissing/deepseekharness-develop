/**
 * Harness-extras panels: the commands / hooks / git settings sections and
 * the file + terminal shell overlays, all over the desktop shell's local
 * bridge API. Sections ride the `settings.section` slot (kernel chrome);
 * overlays ride `shell.overlay` (additive floating layer).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** Module-level workspace service binding (set once by the plugin's apply). */
let workspaceService: IWorkspaces | null = null

/** Bind the kernel workspace service for the Git and Archive panels. */
export function bindWorkspaces(service: IWorkspaces): void {
  workspaceService = service
}

/** Read the bound service; a missing binding is a page-level error, not a crash. */
function workspace(): IWorkspaces | null {
  return workspaceService
}

/** Module-level session list binding (displayTitle source, same as sidebar). */
let sessionsService: { list: { getSnapshot: () => { byId: Record<string, { displayTitle?: string }> } } } | null = null
export function bindSessions(service: { list: { getSnapshot: () => { byId: Record<string, { displayTitle?: string }> } } }): void {
  sessionsService = service
}
function sessions(): { list: { getSnapshot: () => { byId: Record<string, { displayTitle?: string }> } } } | null {
  return sessionsService
}

/** Local bridge base URL (injected per page by the desktop shell). */
const apiBase = (): string => (globalThis as { __DSH_MCP_API__?: string }).__DSH_MCP_API__ ?? ''

/** One JSON round trip against the local bridge. */
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiBase() + path, options)
  return await response.json() as T
}

async function postJson(path: string, body: unknown): Promise<{ ok?: boolean; error?: string }> {
  return await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── shared styling ───────────────────────────────────────────────────────────

const STYLE_ID = 'dshx-panels-style'
const STYLE = `
.dshx-panel { position:fixed; z-index:2147482000; background:var(--dsw-alias-bg-base,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.25)); display:flex; flex-direction:column; }
.dshx-fab { position:fixed; z-index:2147481900; width:38px; height:38px; border-radius:50%;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));
  background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#1a1d26);
  box-shadow:0 4px 16px rgba(18,24,42,.18); cursor:pointer; font-size:15px;
  display:flex; align-items:center; justify-content:center; }
.dshx-fab:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }
.dshx-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 14px;
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2)); font-size:13px; font-weight:600; }
.dshx-term-out { flex:1; overflow:auto; padding:10px 12px; font:12px/1.55 ui-monospace,Consolas,monospace;
  white-space:pre-wrap; word-break:break-all; color:var(--dsw-alias-label-primary,#1a1d26); }
.dshx-term-in { display:flex; gap:6px; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2)); }
.dshx-term-in input { flex:1; height:30px; padding:0 10px; font:12.5px ui-monospace,Consolas,monospace;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); border-radius:6px;
  background:transparent; color:inherit; outline:none; }
.dshx-file-row { display:flex; align-items:center; gap:8px; padding:5px 14px; font-size:13px;
  cursor:pointer; color:var(--dsw-alias-label-primary,#1a1d26); white-space:nowrap; }
.dshx-file-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)); }
.dshx-file-size { margin-left:auto; font-size:11px; color:var(--dsw-alias-label-tertiary,#9296a0); }
.dshx-pre { max-height:50vh; overflow:auto; font:12px/1.5 ui-monospace,Consolas,monospace;
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04)); padding:10px; border-radius:8px;
  white-space:pre-wrap; word-break:break-all; }
.dshx-git-item { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:12.5px;
  border-bottom:1px dashed var(--dsw-alias-border-l2,rgba(121,126,145,.15)); }
.dshx-code { font:11.5px ui-monospace,Consolas,monospace; background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));
  padding:1px 6px; border-radius:4px; }
.dshx-input { height:32px; padding:0 10px; font-size:13px;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); border-radius:8px;
  background:transparent; color:inherit; outline:none; }
.dshx-field { display:flex; flex-direction:column; gap:5px; }
.dshx-field > label { font-size:12px; color:var(--dsw-alias-label-secondary,#686c75); }
.dshx-field input, .dshx-field select {
  height:32px; padding:0 10px; font-size:13px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));
  background:var(--dsw-alias-bg-layer-1,#fff); color:inherit; outline:none; }
.dshx-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.dshx-grid .dshx-full { grid-column:1 / -1; }
.dshx-wrap { display:flex; flex-direction:column; gap:10px; padding: 4px 2px 24px; }
.dshx-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.dshx-toolbar .dshx-actions, .dshx-toolbar button, .dshx-toolbar select { white-space:nowrap; }
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
.dshx-actions { display:flex; gap:6px; flex:none; align-items:center; }
.dshx-actions button { white-space:nowrap; }
.dshx-msg { font-size:12.5px; color:var(--dsw-alias-label-tertiary,#9296a0); padding:18px 0; }
.dshx-msg[data-kind="error"] { color:var(--dsw-alias-state-error-primary,#c83e4d); }
`

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = STYLE
  document.head.appendChild(tag)
}

ensureStyle()

function Msg({ children, kind }: { children: ReactNode; kind?: 'error' }): ReactNode {
  return <div className="dshx-msg" data-kind={kind}>{children}</div>
}

// ── commands section ─────────────────────────────────────────────────────────

interface BuiltinCommand { name: string; description: string; source: string }
interface CommandDraft { name: string; description: string; template: string }

export function CommandsSection(): ReactNode {
  const [builtin, setBuiltin] = useState<BuiltinCommand[]>([])
  const [commands, setCommands] = useState<{ name: string; description: string }[] | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<CommandDraft | null>(null)
  const [busy, setBusy] = useState('')
  const [formError, setFormError] = useState('')

  const reload = useCallback((): void => {
    api<{ builtin?: BuiltinCommand[]; commands?: { name: string; description: string }[]; error?: string }>('/commands')
      .then((data) => {
        if (data.error !== undefined) throw new Error(data.error)
        setBuiltin(data.builtin ?? [])
        setCommands(data.commands ?? [])
        setError('')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => { reload() }, [reload])

  const submit = (): void => {
    if (draft === null) return
    setBusy('__create__')
    setFormError('')
    postJson('/commands', draft)
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        setDraft(null)
        reload()
      })
      .catch((err: Error) => { setFormError(err.message) })
      .finally(() => { setBusy('') })
  }

  const remove = (name: string): void => {
    setBusy(name)
    fetch(`${apiBase()}/commands?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => { reload() })
      .catch(() => {})
      .finally(() => { setBusy('') })
  }

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <span className="dshx-count">{commands === null ? '' : `内置 ${builtin.length} · 自定义 ${commands.length} · 会话内 /名称 触发`}</span>
        <Button onClick={() => { setFormError(''); setDraft({ name: '', description: '', template: '' }) }}>新建命令</Button>
      </div>
      {error !== '' && <Msg kind="error">{`加载失败：${error}`}</Msg>}
      <div className="dshx-toolbar" style={{ marginTop: '8px' }}><span className="dshx-count">内置命令</span></div>
      <div className="dshx-rows">
        {builtin.map(cmd => (
          <div className="dshx-row" key={cmd.name}>
            <div className="dshx-row-main">
              <div className="dshx-row-title">/{cmd.name}</div>
              <div className="dshx-row-desc">{cmd.description}</div>
            </div>
            <div className="dshx-actions"><span className="dshx-badge">内置</span></div>
          </div>
        ))}
      </div>
      <div className="dshx-toolbar" style={{ marginTop: '10px' }}><span className="dshx-count">自定义命令</span></div>
      <div className="dshx-rows">
        {(commands ?? []).map(cmd => (
          <div className="dshx-row" key={cmd.name}>
            <div className="dshx-row-main">
              <div className="dshx-row-title">/{cmd.name}</div>
              <div className="dshx-row-desc">{cmd.description}</div>
            </div>
            <div className="dshx-actions">
              <Button variant="outline" disabled={busy === cmd.name} onClick={() => { remove(cmd.name) }}>
                {busy === cmd.name ? '删除中…' : '删除'}
              </Button>
            </div>
          </div>
        ))}
        {commands !== null && commands.length === 0 && <Msg>暂无自定义命令。</Msg>}
      </div>
      <Modal
        open={draft !== null}
        onClose={() => { if (busy === '') setDraft(null) }}
        title="新建命令"
        closeLabel="关闭"
        description="命令是一个 prompt 模板，保存后会话内输入 /名称 触发。"
        footer={(
          <>
            <Button variant="outline" disabled={busy !== ''} onClick={() => { setDraft(null) }}>取消</Button>
            <Button disabled={busy !== '' || draft === null || draft.name.trim() === '' || draft.template.trim() === ''}
              onClick={() => { submit() }}>
              {busy === '__create__' ? '创建中…' : '创建'}
            </Button>
          </>
        )}
      >
        {draft !== null && (
          <div className="dshx-grid">
            <div className="dshx-field">
              <label>名称（/名称 触发）</label>
              <input value={draft.name} spellCheck={false} placeholder="daily-report"
                onChange={event => { setDraft({ ...draft, name: event.target.value }) }} />
            </div>
            <div className="dshx-field">
              <label>描述</label>
              <input value={draft.description} placeholder="生成每日报告"
                onChange={event => { setDraft({ ...draft, description: event.target.value }) }} />
            </div>
            <div className="dshx-field dshx-full">
              <label>命令模板（prompt 正文）</label>
              <textarea className="dshx-pre" style={{ maxHeight: '160px', background: 'transparent', color: 'inherit' }}
                value={draft.template} spellCheck={false}
                placeholder="总结当前目录下今天的改动并生成日报…"
                onChange={event => { setDraft({ ...draft, template: event.target.value }) }} />
            </div>
            {formError !== '' && <Msg kind="error">{formError}</Msg>}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── hooks section ────────────────────────────────────────────────────────────

interface HookRow {
  id: string
  event: string
  matcher: string
  command: string
  timeout?: number
  disabled: boolean
}

export function HooksSection(): ReactNode {
  const [hooks, setHooks] = useState<HookRow[] | null>(null)
  const [events, setEvents] = useState<string[]>([])
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<{ event: string; matcher: string; command: string; timeout: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [formError, setFormError] = useState('')

  const reload = useCallback((): void => {
    api<{ hooks?: HookRow[]; events?: string[]; error?: string }>('/hooks')
      .then((data) => {
        if (data.error !== undefined) throw new Error(data.error)
        setHooks(data.hooks ?? [])
        setEvents(data.events ?? [])
        setError('')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => { reload() }, [reload])

  const apply = (promise: Promise<{ ok?: boolean; error?: string }>, after?: () => void): void => {
    promise
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        if (after !== undefined) after()
        reload()
      })
      .catch((err: Error) => { setError(err.message) })
      .finally(() => { setBusy('') })
  }

  const submit = (): void => {
    if (draft === null) return
    setBusy('__create__')
    setFormError('')
    const body = {
      event: draft.event,
      matcher: draft.matcher,
      command: draft.command,
      timeout: draft.timeout.trim() === '' ? undefined : Number(draft.timeout),
    }
    apply(postJson('/hooks', body), () => { setDraft(null) })
  }

  const grouped = new Map<string, HookRow[]>()
  for (const hook of hooks ?? []) {
    const list = grouped.get(hook.event) ?? []
    list.push(hook)
    grouped.set(hook.event, list)
  }

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <span className="dshx-count">{hooks === null ? '' : `${hooks.length} 个钩子 · 写入 ~/.dsh/hooks.json`}</span>
        <Button onClick={() => { setFormError(''); setDraft({ event: events[0] ?? 'PreToolUse', matcher: '', command: '', timeout: '' }) }}>新建钩子</Button>
      </div>
      {error !== '' && <Msg kind="error">{`加载失败：${error}`}</Msg>}
      {hooks !== null && hooks.length === 0 && <Msg>暂无钩子。钩子在会话生命周期的对应事件点执行 shell 命令。</Msg>}
      {[...grouped.entries()].map(([event, rows]) => (
        <div key={event}>
          <div className="dshx-toolbar" style={{ marginTop: '8px' }}>
            <span className="dshx-count">{event} <span style={{ opacity: 0.7 }}>{rows.length}</span></span>
          </div>
          <div className="dshx-rows">
            {rows.map(hook => (
              <div className="dshx-row" key={hook.id}>
                <div className="dshx-row-main">
                  <div className="dshx-row-title">
                    {hook.matcher !== '' ? hook.matcher : '全部工具'}
                    <span className="dshx-badge" data-on={String(!hook.disabled)}>{hook.disabled ? '停用' : '启用'}</span>
                  </div>
                  <div className="dshx-row-desc" style={{ whiteSpace: 'normal' }}>{hook.command}</div>
                </div>
                <div className="dshx-actions">
                  <Button variant="outline" disabled={busy === hook.id}
                    onClick={() => { setBusy(hook.id); apply(postJson('/hooks/set-enabled', { id: hook.id, enabled: hook.disabled })) }}>
                    {busy === hook.id ? '…' : hook.disabled ? '启用' : '停用'}
                  </Button>
                  <Button variant="outline" disabled={busy === hook.id}
                    onClick={() => {
                      setBusy(hook.id)
                      apply(fetch(`${apiBase()}/hooks?id=${encodeURIComponent(hook.id)}`, { method: 'DELETE' }).then(r => r.json()))
                    }}>
                    {busy === hook.id ? '…' : '删除'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <Modal
        open={draft !== null}
        onClose={() => { if (busy === '') setDraft(null) }}
        title="新建钩子"
        closeLabel="关闭"
        description="在会话生命周期的对应事件点执行 shell 命令。"
        footer={(
          <>
            <Button variant="outline" disabled={busy !== ''} onClick={() => { setDraft(null) }}>取消</Button>
            <Button disabled={busy !== '' || draft === null || draft.command.trim() === ''} onClick={() => { submit() }}>
              {busy === '__create__' ? '创建中…' : '创建'}
            </Button>
          </>
        )}
      >
        {draft !== null && (
          <div className="dshx-grid">
            <div className="dshx-field">
              <label>生命周期事件</label>
              <select value={draft.event} onChange={event => { setDraft({ ...draft, event: event.target.value }) }}>
                {events.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
            <div className="dshx-field">
              <label>匹配器（选填，如 Bash）</label>
              <input value={draft.matcher} spellCheck={false} placeholder="留空匹配全部"
                onChange={event => { setDraft({ ...draft, matcher: event.target.value }) }} />
            </div>
            <div className="dshx-field dshx-full">
              <label>要执行的命令</label>
              <input value={draft.command} spellCheck={false} placeholder="node C:/hooks/notify.js"
                onChange={event => { setDraft({ ...draft, command: event.target.value }) }} />
            </div>
            <div className="dshx-field">
              <label>超时（毫秒，选填）</label>
              <input value={draft.timeout} spellCheck={false} placeholder="60000"
                onChange={event => { setDraft({ ...draft, timeout: event.target.value.replace(/\D/g, '') }) }} />
            </div>
            {formError !== '' && <Msg kind="error">{formError}</Msg>}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── git section ────────────────────────────────────────

interface GitInfo {
  path?: string
  branch?: string
  changes?: { code: string; file: string; staged: boolean }[]
  log?: string[]
  branches?: string[]
  error?: string
}

interface WorkspaceLite { workspaceId: string; path: string; title: string }

export function GitSection(): ReactNode {
  const workspaces = workspace()
  const [items, setItems] = useState<WorkspaceLite[]>([])
  const [selected, setSelected] = useState('')
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState('')
  const [notice, setNotice] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')

  const loadInfo = useCallback((target: string): void => {
    if (target === '') { setInfo(null); return }
    setLoading(true)
    api<GitInfo>(`/git?path=${encodeURIComponent(target)}`)
      .then((result) => {
        setInfo(result)
        setChecked(new Set())
        setNotice('')
      })
      .catch((err: Error) => { setInfo({ error: err.message }) })
      .finally(() => { setLoading(false) })
  }, [])

  useEffect(() => {
    if (workspaces === null) return
    const read = (): void => {
      const snapshot = workspaces.list.getSnapshot()
      const rows = snapshot.items.map(row => ({
        workspaceId: row.workspaceId, path: row.path, title: row.title,
      }))
      setItems(rows)
      setSelected(previous => previous !== '' ? previous : (rows[0]?.path ?? ''))
    }
    read()
    const off = workspaces.list.subscribe(read)
    return off
  }, [workspaces])

  useEffect(() => { loadInfo(selected) }, [selected, loadInfo])

  const runAction = (kind: 'pull' | 'push' | 'checkout' | 'commit', extra?: Record<string, unknown>): void => {
    if (selected === '' || action !== '') return
    setAction(kind)
    setNotice('')
    const url = kind === 'commit' ? '/git/commit' : `/git/${kind}`
    postJson(url, { path: selected, ...extra })
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        const output = (result as { output?: string }).output
        setNotice(output !== undefined && output !== '' ? output : '完成')
        if (kind === 'commit') { setMessage(''); setChecked(new Set()) }
        loadInfo(selected)
      })
      .catch((err: Error) => { setNotice(`失败：${err.message}`) })
      .finally(() => { setAction('') })
  }

  const toggle = (file: string): void => {
    setChecked(previous => {
      const next = new Set(previous)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const changes = info?.changes ?? []
  const allChecked = changes.length > 0 && changes.every(change => checked.has(change.file))

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <select className="dshx-input" style={{ flex: 1 }} value={selected}
          onChange={event => { setSelected(event.target.value) }}>
          {items.length === 0 && <option value="">（尚未注册工作区）</option>}
          {items.map(row => (
            <option key={row.workspaceId} value={row.path}>{row.title}</option>
          ))}
        </select>
        <Button disabled={loading || selected === ''} onClick={() => { loadInfo(selected) }}>{loading ? '刷新中…' : '刷新'}</Button>
      </div>

      {info !== null && info.error !== undefined && info.error !== '' && <Msg kind="error">{info.error}</Msg>}
      {info !== null && info.branch !== undefined && info.branch !== '' && (
        <>
          <div className="dshx-toolbar" style={{ marginTop: '4px', alignItems: 'center' }}>
            <span className="dshx-row-title" style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>
              当前分支 <span className="dshx-code">{info.branch}</span>
            </span>
            <span className="dshx-actions">
              <select className="dshx-input" style={{ height: '28px', fontSize: '12px' }} value=""
                onChange={event => { if (event.target.value !== '') runAction('checkout', { branch: event.target.value }) }}>
                <option value="">切换分支…</option>
                {(info.branches ?? []).filter(branch => branch !== info.branch).map(branch => (
                  <option key={branch} value={branch}>{branch}</option>
                ))}
              </select>
              <Button variant="outline" disabled={action !== ''} onClick={() => { runAction('pull') }}>
                {action === 'pull' ? '更新中…' : '更新项目'}
              </Button>
              <Button variant="outline" disabled={action !== ''} onClick={() => { runAction('push') }}>
                {action === 'push' ? '推送中…' : '推送项目'}
              </Button>
            </span>
          </div>
          {notice !== '' && <Msg>{notice}</Msg>}
          <div className="dshx-toolbar" style={{ marginTop: '8px' }}>
            <span className="dshx-count">
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={allChecked}
                  onChange={event => {
                    setChecked(event.target.checked ? new Set(changes.map(change => change.file)) : new Set())
                  }} />
                工作区改动 {changes.length} 个
              </label>
            </span>
          </div>
          <div>
            {changes.map(change => (
              <div className="dshx-git-item" key={change.file}>
                <input type="checkbox" checked={checked.has(change.file)}
                  onChange={() => { toggle(change.file) }} />
                <span className="dshx-code">{change.code || 'M'}</span>
                <span>{change.file}</span>
              </div>
            ))}
            {changes.length === 0 && <Msg>工作区干净。</Msg>}
          </div>
          <div className="dshx-toolbar" style={{ marginTop: '8px' }}>
            <input className="dshx-input" style={{ flex: 1 }} value={message} spellCheck={false}
              placeholder="提交信息（先勾选要提交的文件）"
              onChange={event => { setMessage(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter' && checked.size > 0 && message.trim() !== '') runAction('commit', { files: [...checked], message }) }} />
            <Button disabled={action !== '' || checked.size === 0 || message.trim() === ''}
              onClick={() => { runAction('commit', { files: [...checked], message }) }}>
              {action === 'commit' ? '提交中…' : `提交选中 (${checked.size})`}
            </Button>
          </div>
          <div className="dshx-toolbar" style={{ marginTop: '10px' }}><span className="dshx-count">最近提交</span></div>
          <div>
            {(info.log ?? []).map(line => (
              <div className="dshx-git-item" key={line}><span className="dshx-code">{line.slice(0, 7)}</span><span>{line.slice(8)}</span></div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── file panel overlay (sidebar file explorer) ───────────────────────────────

interface FileEntry { name: string; dir: boolean; size: number }

export function FilesOverlay(): ReactNode {
  // Tree state: each expanded directory's children cached by path. The root
  // selector lists every registered workspace; the preview renders inside
  // the panel (never a modal over the app).
  const [open, setOpen] = useState(false)
  const [tree, setTree] = useState<Map<string, FileEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const workspaces = workspace()
  const [workspacesList, setWorkspacesList] = useState<{ path: string; title: string }[]>([])
  const [root, setRoot] = useState('')

  useEffect(() => {
    const read = (): void => {
      if (workspaces !== null) {
        const snap = workspaces.list.getSnapshot()
        const items = snap.items.map(row => ({ path: row.path, title: row.title }))
        if (items.length > 0) { setWorkspacesList(items); return }
      }
      // Desktop harness: no WebSocket follow — fall back to dialog API
      api<{ workspaces?: { path: string; title: string }[] }>('/workspaces')
        .then((data) => { setWorkspacesList(data.workspaces ?? []) })
        .catch(() => {})
    }
    read()
    if (workspaces !== null) {
      const off = workspaces.list.subscribe(read)
      return off
    }
  }, [workspaces])

  useEffect(() => {
    if (root === '' && workspacesList.length > 0) setRoot(workspacesList[0]?.path ?? '')
  }, [root, workspacesList])

  const loadDir = useCallback((target: string): void => {
    api<{ path?: string; entries?: FileEntry[]; error?: string }>(`/files?path=${encodeURIComponent(target)}`)
      .then((result) => {
        if (result.error !== undefined) { setError(result.error); return }
        const resolved = result.path ?? target
        setTree(previous => {
          const next = new Map(previous)
          next.set(resolved, result.entries ?? [])
          return next
        })
        setExpanded(previous => new Set(previous).add(resolved))
        setError('')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => {
    if (open && root !== '' && !tree.has(root)) loadDir(root)
  }, [open, root, tree, loadDir])

  const toggleDir = (full: string): void => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(full)) next.delete(full)
      else {
        next.add(full)
        if (!tree.has(full)) loadDir(full)
      }
      return next
    })
  }

  const openFile = (full: string): void => {
    api<{ path?: string; content?: string; error?: string }>(`/file-content?path=${encodeURIComponent(full)}`)
      .then((result) => {
        if (result.error !== undefined || result.content === undefined) { setError(result.error ?? '无法读取'); return }
        setPreview({ path: result.path ?? full, content: result.content })
      })
      .catch((err: Error) => { setError(err.message) })
  }

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const entries = tree.get(dir)
    if (entries === undefined) return null
    return entries.map(entry => {
      const full = dir.replace(/[\\/]+$/, '') + '\\' + entry.name
      const isExpanded = expanded.has(full)
      return (
        <div key={full}>
          <div className="dshx-file-row" style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => { if (entry.dir) toggleDir(full); else openFile(full) }}>
            <span style={{ width: 12, flexShrink: 0, fontSize: '10px', color: 'var(--dsw-alias-label-tertiary,#9296a0)' }}>
              {entry.dir ? (isExpanded ? '▾' : '▸') : ''}
            </span>
            <span>{entry.dir ? '📁' : '📄'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
            {!entry.dir && entry.size > 0 && <span className="dshx-file-size">{entry.size > 1024 ? `${Math.round(entry.size / 1024)}K` : `${entry.size}B`}</span>}
          </div>
          {entry.dir && isExpanded && renderLevel(full, depth + 1)}
        </div>
      )
    })
  }

  return (
    <>
      <button type="button" className="dshx-fab" style={{ right: '16px', top: '96px' }}
        title="文件面板" onClick={() => { setOpen(!open) }}>📁</button>
      {open && (
        <div className="dshx-panel" style={{ top: '0', right: '0', bottom: '0', width: '360px', borderRight: 'none' }}>
          {preview !== null ? (
            <>
              <div className="dshx-head">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={preview.path}>
                  {preview.path.split('\\').pop()}
                </span>
                <button type="button" className="dshx-fab" style={{ position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }}
                  title="返回" onClick={() => { setPreview(null) }}>←</button>
              </div>
              <div style={{ padding: '8px 10px', fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary,#9296a0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {preview.path}
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <pre className="dshx-pre" style={{ margin: '0 10px 12px' }}>{preview.content}</pre>
              </div>
            </>
          ) : (
            <>
              <div className="dshx-head">
                <span>文件</span>
                <span style={{ display: 'flex', gap: '6px' }}>
                  <button type="button" className="dshx-fab" style={{ position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }}
                    title="刷新" onClick={() => { setTree(new Map()); if (root !== '') loadDir(root) }}>⟳</button>
                  <button type="button" className="dshx-fab" style={{ position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }}
                    title="关闭" onClick={() => { setOpen(false) }}>✕</button>
                </span>
              </div>
              <div style={{ padding: '6px 10px' }}>
                <select className="dshx-input" style={{ width: '100%', fontSize: '12px', height: '28px' }}
                  value={root} onChange={event => { setRoot(event.target.value) }}>
                  {workspacesList.map(row => (
                    <option key={row.path} value={row.path}>{row.title}</option>
                  ))}
                  {workspacesList.length === 0 && <option value="">（未注册工作区）</option>}
                </select>
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                {error !== '' && <Msg kind="error">{error}</Msg>}
                {root !== '' && renderLevel(root, 0)}
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

// ── terminal overlay (real PTY over SSE) ─────────────────────────────────────

/** Strip the ANSI sequences a full TTY emits; the panel renders plain text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

export function TerminalOverlay(): ReactNode {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyAt, setHistoryAt] = useState(-1)
  const [connected, setConnected] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  // One EventSource per open panel; the backlog replays on connect so the
  // previous session's output is preserved across open/close cycles.
  useEffect(() => {
    if (!open) {
      sourceRef.current?.close()
      sourceRef.current = null
      setConnected(false)
      return
    }
    if (sourceRef.current !== null) return
    const source = new EventSource(`${apiBase()}/term-stream?panel=main`)
    source.onopen = () => { setConnected(true) }
    source.onmessage = (event) => {
      const chunk = JSON.parse(event.data) as string
      if (chunk === '[EXITED]') { setConnected(false); return }
      setLines(previous => {
        const merged = [...previous]
        const clean = stripAnsi(chunk)
        const lastLine = merged.length > 0 ? (merged[merged.length - 1] ?? '') : ''
        const combined = (merged.length > 0 ? lastLine : '') + clean
        const parts = combined.split('\n')
        if (merged.length === 0) return parts.slice(-800)
        merged.splice(merged.length - 1, 1, ...parts)
        return merged.slice(-800)
      })
    }
    source.onerror = () => { setConnected(false) }
    sourceRef.current = source
  }, [open])

  useEffect(() => {
    const node = scroller.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [lines, scroller])

  const send = (text: string): void => {
    void fetch(`${apiBase()}/term-input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ panel: 'main', data: text + '\r' }),
    })
    if (text.trim() !== '') {
      setHistory(previous => [...previous, text])
      setHistoryAt(-1)
    }
  }

  const submit = (): void => {
    if (input.trim() === '') return
    send(input)
    setInput('')
  }

  const recall = (direction: -1 | 1): void => {
    if (history.length === 0) return
    let at = historyAt + direction
    if (at < 0) at = 0
    if (at >= history.length) at = history.length
    setHistoryAt(at)
    setInput(at === history.length ? '' : (history[at] ?? ''))
  }

  return (
    <>
      <button type="button" className="dshx-fab" style={{ right: '16px', bottom: '16px' }}
        title="终端" onClick={() => { setOpen(!open) }}>⌨</button>
      {open && (
        <div className="dshx-panel" style={{ left: '0', right: '0', bottom: '0', height: '320px', borderBottom: 'none' }}>
          <div className="dshx-head">
            <span>终端 <span className="dshx-badge" data-on={String(connected)}>{connected ? '已连接' : '连接中…'}</span></span>
            <span style={{ display: 'flex', gap: '6px' }}>
              <button type="button" className="dshx-fab" style={{ position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }}
                title="清屏" onClick={() => { setLines([]) }}>🗑</button>
              <button type="button" className="dshx-fab" style={{ position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }}
                title="关闭" onClick={() => { setOpen(false) }}>✕</button>
            </span>
          </div>
          <div className="dshx-term-out" ref={scroller}>
            {lines.map((line, index) => (
              <div key={index} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.2em' }}>{line}</div>
            ))}
          </div>
          <div className="dshx-term-in">
            <span style={{ font: '12.5px ui-monospace,monospace', alignSelf: 'center' }}>PS&gt;</span>
            <input value={input} spellCheck={false} autoFocus
              onChange={event => { setInput(event.target.value) }}
              onKeyDown={event => {
                if (event.key === 'Enter') { send(input); setInput('') }
                else if (event.key === 'ArrowUp') { event.preventDefault(); recall(-1) }
                else if (event.key === 'ArrowDown') { event.preventDefault(); recall(1) }
              }} />
            <Button disabled={input.trim() === ''} onClick={() => { submit() }}>发送</Button>
          </div>
        </div>
      )}
    </>
  )
}

// ── index (codegraph) section ────────────────────────────────────────

interface McpServerLite {
  name: string
  enabled: boolean
  env?: Record<string, string>
  command?: string
}

/**
 * Code-index settings: the codegraph MCP server carries the repository
 * index. The master switch toggles the server itself (restart to apply);
 * the two granular toggles ride its env contract.
 */
export function IndexSection(): ReactNode {
  const [server, setServer] = useState<McpServerLite | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback((): void => {
    api<{ servers?: McpServerLite[]; error?: string }>('/mcp')
      .then((data) => {
        if (data.error !== undefined) throw new Error(data.error)
        const found = (data.servers ?? []).find(entry => entry.name === 'codegraph') ?? null
        setServer(found)
        setError(found === null ? '未检测到 codegraph MCP 服务器（在 MCP 服务器页添加后可用）' : '')
      })
      .catch((err: Error) => { setError(err.message) })
  }, [])

  useEffect(() => { reload() }, [reload])

  const patch = (mutate: (entry: McpServerLite) => void): void => {
    if (server === null || busy) return
    setBusy(true)
    const next = { ...server, env: { ...(server.env ?? {}) } }
    mutate(next)
    api<{ servers?: McpServerLite[] }>('/mcp')
      .then((data) => {
        const original = (data.servers ?? []).find(entry => entry.name === 'codegraph')
        if (original === undefined) throw new Error('codegraph 服务器不存在')
        return postJson('/mcp', {
          name: original.name,
          transport: 'stdio',
          enabled: next.enabled,
          command: original.command,
          args: (original as unknown as { args?: string[] }).args ?? [],
          env: next.env,
        })
      })
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        reload()
      })
      .catch((err: Error) => { setError(err.message) })
      .finally(() => { setBusy(false) })
  }

  const envOn = (key: string): boolean => server?.env?.[key] === '1'

  if (server === null && error === '') return <div className="dshx-wrap"><Msg>加载中…</Msg></div>

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar"><span className="dshx-count">代码库索引（codegraph）</span></div>
      {error !== '' && <Msg kind="error">{error}</Msg>}
      {server !== null && (
        <div className="dshx-rows">
          <div className="dshx-row">
            <div className="dshx-row-main">
              <div className="dshx-row-title">
                启用 codegraph 索引服务
              </div>
              <div className="dshx-row-desc">关闭后模型不再获得代码库索引工具。保存后自动重启生效。</div>
            </div>
            <div className="dshx-actions">
              <Button variant="outline" disabled={busy}
                onClick={() => { patch(entry => { entry.enabled = !entry.enabled }) }}>
                {server.enabled ? '停用' : '启用'}
              </Button>
            </div>
          </div>
          <div className="dshx-row">
            <div className="dshx-row-main">
              <div className="dshx-row-title">自动索引新文件夹</div>
              <div className="dshx-row-desc">自动索引文件数少于 50,000 的新文件夹。</div>
            </div>
            <div className="dshx-actions">
              <Button variant="outline" disabled={busy}
                onClick={() => { patch(entry => { entry.env = { ...(entry.env ?? {}), CODEGRAPH_AUTO_INDEX: envOn('CODEGRAPH_AUTO_INDEX') ? '0' : '1' } }) }}>
                {envOn('CODEGRAPH_AUTO_INDEX') ? '关闭' : '开启'}
              </Button>
            </div>
          </div>
          <div className="dshx-row">
            <div className="dshx-row-main">
              <div className="dshx-row-title">索引存储库以实现即时搜索（测试版）</div>
              <div className="dshx-row-desc">自动对仓库进行索引，以加快 Grep 搜索速度。所有数据均存储在本地。</div>
            </div>
            <div className="dshx-actions">
              <Button variant="outline" disabled={busy}
                onClick={() => { patch(entry => { entry.env = { ...(entry.env ?? {}), CODEGRAPH_INDEX_REPOS: envOn('CODEGRAPH_INDEX_REPOS') ? '0' : '1' } }) }}>
                {envOn('CODEGRAPH_INDEX_REPOS') ? '关闭' : '开启'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
// ── archive section ──────────────────────────────────────


/**
 * Archive management over the kernel's workspace registry: archiving toggles
 * the registry's own archived set (the same state the sidebar filters on),
 * so sidebar and this page always agree. Deletion removes the session's log
 * directory through the local bridge.
 */
function shortId(sessionId: string): string {
  return sessionId.replace('session-', '').slice(0, 8)
}

export function ArchiveSection(): ReactNode {
  const workspaces = workspace()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState<{ sessionId: string; title: string } | null>(null)
  const [titles, setTitles] = useState<Record<string, string> | null>(null)
  const [snapshot, setSnapshot] = useState<{ items: readonly { title: string; sessionIds: readonly string[] }[]; archived: readonly string[] } | null>(null)

  const reload = useCallback((): void => {
    if (workspaces === null) return
    const snap = workspaces.list.getSnapshot()
    setSnapshot({ items: snap.items, archived: snap.archivedSessionIds })
    setError('')
  }, [workspaces])

  useEffect(() => {
    if (workspaces === null) return
    reload()
    const off = workspaces.list.subscribe(reload)
    return off
  }, [reload, workspaces])

  useEffect(() => {
    api<{ titles?: Record<string, string> }>('/session-titles')
      .then((data) => { setTitles(data.titles ?? {}) })
      .catch(() => { setTitles({}) })
  }, [])

  // Kernel toggle: flips the in-memory archive flag. The follow stream may
  // not be connected in the desktop harness, so we poll the snapshot until
  // the target state matches (max 3 seconds).
  const toggle = (sessionId: string, targetArchived: boolean): void => {
    if (workspaces === null || busy !== '') return
    setBusy(sessionId)
    workspaces.archiveSession(sessionId as Parameters<IWorkspaces['archiveSession']>[0])
      .then(() => {
        setError('')
        // Poll snapshot until archived state matches (desktop harness may lack follow stream)
        let attempts = 0
        const poll = setInterval(() => {
          attempts++
          const snap = workspaces.list.getSnapshot()
          const isArchived = (snap.archivedSessionIds as readonly string[]).includes(sessionId)
          if (isArchived === targetArchived || attempts > 30) {
            clearInterval(poll)
            reload()
          }
        }, 100)
      })
      .catch((err: Error) => { setError(err.message) })
      .finally(() => { setBusy('') })
  }

  const remove = (sessionId: string): void => {
    if (busy !== '') return
    setBusy(sessionId)
    fetch(`${apiBase()}/session-delete?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      .then((response) => response.json() as Promise<{ error?: string }>)
      .then((result) => {
        if (result.error !== undefined && result.error !== '') throw new Error(result.error)
        setConfirming(null)
        reload()
      })
      .catch((err: Error) => { setError(err.message) })
      .finally(() => { setBusy('') })
  }

  const displayName = (sessionId: string): string => {
    // Same source the sidebar uses: the session list's displayTitle. Fall
    // back to the projcache title, then a short id.
    const byId = sessions()?.list.getSnapshot().byId
    const display = byId?.[sessionId]?.displayTitle
    if (display !== undefined && display !== '') return display
    return titles?.[sessionId] ?? shortId(sessionId)
  }

  const archivedSet = new Set(snapshot?.archived ?? [])
  const activeRows: { sessionId: string; workspaceTitle: string }[] = []
  for (const workspace of snapshot?.items ?? []) {
    for (const sessionId of workspace.sessionIds) {
      if (!archivedSet.has(sessionId)) {
        activeRows.push({ sessionId, workspaceTitle: workspace.title })
      }
    }
  }
  const archivedRows = [...archivedSet]
    .filter(sessionId => !activeRows.some(row => row.sessionId === sessionId))
    .map(sessionId => ({ sessionId, workspaceTitle: '' }))

  const renderRow = (row: { sessionId: string; workspaceTitle: string }, isArchived: boolean): ReactNode => (
    <div className="dshx-row" key={row.sessionId}>
      <div className="dshx-row-main">
        <div className="dshx-row-title">
          <span style={{ fontWeight: 500 }}>{displayName(row.sessionId)}</span>
          {row.workspaceTitle !== '' && <span className="dshx-badge">{row.workspaceTitle}</span>}
          {isArchived && <span className="dshx-badge">已归档</span>}
        </div>
      </div>
      <div className="dshx-actions">
        <Button variant="outline" disabled={busy === row.sessionId}
          onClick={() => { toggle(row.sessionId, !isArchived) }}>
          {busy === row.sessionId ? '…' : isArchived ? '恢复' : '归档'}
        </Button>
        <Button variant="outline" disabled={busy === row.sessionId}
          onClick={() => { setConfirming({ sessionId: row.sessionId, title: displayName(row.sessionId) }) }}>
          删除
        </Button>
      </div>
    </div>
  )

  return (
    <div className="dshx-wrap">
      <div className="dshx-toolbar">
        <span className="dshx-count">{snapshot === null ? '' : `活跃 ${activeRows.length} · 已归档 ${archivedRows.length}`}</span>
      </div>
      {error !== '' && <Msg kind="error">{error}</Msg>}
      {workspaces === null && <Msg kind="error">工作区服务未就绪，请关闭设置后重试。</Msg>}
      {titles === null && <Msg>加载中…</Msg>}
      {titles !== null && (
        <>
          <div className="dshx-toolbar" style={{ marginTop: '8px' }}><span className="dshx-count">活跃会话</span></div>
          {activeRows.length === 0 ? <Msg>暂无活跃会话。</Msg> : <div className="dshx-rows">{activeRows.map(row => renderRow(row, false))}</div>}
          <div className="dshx-toolbar" style={{ marginTop: '12px' }}><span className="dshx-count">已归档会话</span></div>
          {archivedRows.length === 0 ? <Msg>暂无归档会话。</Msg> : <div className="dshx-rows">{archivedRows.map(row => renderRow(row, true))}</div>}
          <Modal
            open={confirming !== null}
            onClose={() => { setConfirming(null) }}
            title="删除会话"
            closeLabel="关闭"
            description="将永久删除该会话的全部记录，不可恢复。"
            footer={(
              <>
                <Button variant="outline" onClick={() => { setConfirming(null) }}>取消</Button>
                <Button onClick={() => { if (confirming !== null) remove(confirming.sessionId) }}>永久删除</Button>
              </>
            )}
          >
            <Msg kind="error">{`确定要删除会话「${confirming?.title ?? ''}」吗？`}</Msg>
          </Modal>
        </>
      )}
    </div>
  )
}

