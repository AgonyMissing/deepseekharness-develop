import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Harness-extras panels: the commands / hooks / git settings sections and
 * the file + terminal shell overlays, all over the desktop shell's local
 * bridge API. Sections ride the `settings.section` slot (kernel chrome);
 * overlays ride `shell.overlay` (additive floating layer).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
/** Module-level workspace service binding (set once by the plugin's apply). */
let workspaceService = null;
/** Bind the kernel workspace service for the Git and Archive panels. */
export function bindWorkspaces(service) {
    workspaceService = service;
}
/** Read the bound service; a missing binding is a page-level error, not a crash. */
function workspace() {
    return workspaceService;
}
/** Module-level session list binding (displayTitle source, same as sidebar). */
let sessionsService = null;
export function bindSessions(service) {
    sessionsService = service;
}
function sessions() {
    return sessionsService;
}
/** Local bridge base URL (injected per page by the desktop shell). */
const apiBase = () => globalThis.__DSH_MCP_API__ ?? '';
/** One JSON round trip against the local bridge. */
async function api(path, options) {
    const response = await fetch(apiBase() + path, options);
    return await response.json();
}
async function postJson(path, body) {
    return await api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}
// ── shared styling ───────────────────────────────────────────────────────────
const STYLE_ID = 'dshx-panels-style';
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
`;
function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null)
        return;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = STYLE;
    document.head.appendChild(tag);
}
ensureStyle();
function Msg({ children, kind }) {
    return _jsx("div", { className: "dshx-msg", "data-kind": kind, children: children });
}
export function CommandsSection() {
    const [builtin, setBuiltin] = useState([]);
    const [commands, setCommands] = useState(null);
    const [error, setError] = useState('');
    const [draft, setDraft] = useState(null);
    const [busy, setBusy] = useState('');
    const [formError, setFormError] = useState('');
    const reload = useCallback(() => {
        api('/commands')
            .then((data) => {
            if (data.error !== undefined)
                throw new Error(data.error);
            setBuiltin(data.builtin ?? []);
            setCommands(data.commands ?? []);
            setError('');
        })
            .catch((err) => { setError(err.message); });
    }, []);
    useEffect(() => { reload(); }, [reload]);
    const submit = () => {
        if (draft === null)
            return;
        setBusy('__create__');
        setFormError('');
        postJson('/commands', draft)
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            setDraft(null);
            reload();
        })
            .catch((err) => { setFormError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const remove = (name) => {
        setBusy(name);
        fetch(`${apiBase()}/commands?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
            .then(() => { reload(); })
            .catch(() => { })
            .finally(() => { setBusy(''); });
    };
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsxs("div", { className: "dshx-toolbar", children: [_jsx("span", { className: "dshx-count", children: commands === null ? '' : `内置 ${builtin.length} · 自定义 ${commands.length} · 会话内 /名称 触发` }), _jsx(Button, { onClick: () => { setFormError(''); setDraft({ name: '', description: '', template: '' }); }, children: "\u65B0\u5EFA\u547D\u4EE4" })] }), error !== '' && _jsx(Msg, { kind: "error", children: `加载失败：${error}` }), _jsx("div", { className: "dshx-toolbar", style: { marginTop: '8px' }, children: _jsx("span", { className: "dshx-count", children: "\u5185\u7F6E\u547D\u4EE4" }) }), _jsx("div", { className: "dshx-rows", children: builtin.map(cmd => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: ["/", cmd.name] }), _jsx("div", { className: "dshx-row-desc", children: cmd.description })] }), _jsx("div", { className: "dshx-actions", children: _jsx("span", { className: "dshx-badge", children: "\u5185\u7F6E" }) })] }, cmd.name))) }), _jsx("div", { className: "dshx-toolbar", style: { marginTop: '10px' }, children: _jsx("span", { className: "dshx-count", children: "\u81EA\u5B9A\u4E49\u547D\u4EE4" }) }), _jsxs("div", { className: "dshx-rows", children: [(commands ?? []).map(cmd => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: ["/", cmd.name] }), _jsx("div", { className: "dshx-row-desc", children: cmd.description })] }), _jsx("div", { className: "dshx-actions", children: _jsx(Button, { variant: "outline", disabled: busy === cmd.name, onClick: () => { remove(cmd.name); }, children: busy === cmd.name ? '删除中…' : '删除' }) })] }, cmd.name))), commands !== null && commands.length === 0 && _jsx(Msg, { children: "\u6682\u65E0\u81EA\u5B9A\u4E49\u547D\u4EE4\u3002" })] }), _jsx(Modal, { open: draft !== null, onClose: () => { if (busy === '')
                    setDraft(null); }, title: "\u65B0\u5EFA\u547D\u4EE4", closeLabel: "\u5173\u95ED", description: "\u547D\u4EE4\u662F\u4E00\u4E2A prompt \u6A21\u677F\uFF0C\u4FDD\u5B58\u540E\u4F1A\u8BDD\u5185\u8F93\u5165 /\u540D\u79F0 \u89E6\u53D1\u3002", footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", disabled: busy !== '', onClick: () => { setDraft(null); }, children: "\u53D6\u6D88" }), _jsx(Button, { disabled: busy !== '' || draft === null || draft.name.trim() === '' || draft.template.trim() === '', onClick: () => { submit(); }, children: busy === '__create__' ? '创建中…' : '创建' })] })), children: draft !== null && (_jsxs("div", { className: "dshx-grid", children: [_jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u540D\u79F0\uFF08/\u540D\u79F0 \u89E6\u53D1\uFF09" }), _jsx("input", { value: draft.name, spellCheck: false, placeholder: "daily-report", onChange: event => { setDraft({ ...draft, name: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u63CF\u8FF0" }), _jsx("input", { value: draft.description, placeholder: "\u751F\u6210\u6BCF\u65E5\u62A5\u544A", onChange: event => { setDraft({ ...draft, description: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u547D\u4EE4\u6A21\u677F\uFF08prompt \u6B63\u6587\uFF09" }), _jsx("textarea", { className: "dshx-pre", style: { maxHeight: '160px', background: 'transparent', color: 'inherit' }, value: draft.template, spellCheck: false, placeholder: "\u603B\u7ED3\u5F53\u524D\u76EE\u5F55\u4E0B\u4ECA\u5929\u7684\u6539\u52A8\u5E76\u751F\u6210\u65E5\u62A5\u2026", onChange: event => { setDraft({ ...draft, template: event.target.value }); } })] }), formError !== '' && _jsx(Msg, { kind: "error", children: formError })] })) })] }));
}
export function HooksSection() {
    const [hooks, setHooks] = useState(null);
    const [events, setEvents] = useState([]);
    const [error, setError] = useState('');
    const [draft, setDraft] = useState(null);
    const [busy, setBusy] = useState('');
    const [formError, setFormError] = useState('');
    const reload = useCallback(() => {
        api('/hooks')
            .then((data) => {
            if (data.error !== undefined)
                throw new Error(data.error);
            setHooks(data.hooks ?? []);
            setEvents(data.events ?? []);
            setError('');
        })
            .catch((err) => { setError(err.message); });
    }, []);
    useEffect(() => { reload(); }, [reload]);
    const apply = (promise, after) => {
        promise
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            if (after !== undefined)
                after();
            reload();
        })
            .catch((err) => { setError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const submit = () => {
        if (draft === null)
            return;
        setBusy('__create__');
        setFormError('');
        const body = {
            event: draft.event,
            matcher: draft.matcher,
            command: draft.command,
            timeout: draft.timeout.trim() === '' ? undefined : Number(draft.timeout),
        };
        apply(postJson('/hooks', body), () => { setDraft(null); });
    };
    const grouped = new Map();
    for (const hook of hooks ?? []) {
        const list = grouped.get(hook.event) ?? [];
        list.push(hook);
        grouped.set(hook.event, list);
    }
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsxs("div", { className: "dshx-toolbar", children: [_jsx("span", { className: "dshx-count", children: hooks === null ? '' : `${hooks.length} 个钩子 · 写入 ~/.dsh/hooks.json` }), _jsx(Button, { onClick: () => { setFormError(''); setDraft({ event: events[0] ?? 'PreToolUse', matcher: '', command: '', timeout: '' }); }, children: "\u65B0\u5EFA\u94A9\u5B50" })] }), error !== '' && _jsx(Msg, { kind: "error", children: `加载失败：${error}` }), hooks !== null && hooks.length === 0 && _jsx(Msg, { children: "\u6682\u65E0\u94A9\u5B50\u3002\u94A9\u5B50\u5728\u4F1A\u8BDD\u751F\u547D\u5468\u671F\u7684\u5BF9\u5E94\u4E8B\u4EF6\u70B9\u6267\u884C shell \u547D\u4EE4\u3002" }), [...grouped.entries()].map(([event, rows]) => (_jsxs("div", { children: [_jsx("div", { className: "dshx-toolbar", style: { marginTop: '8px' }, children: _jsxs("span", { className: "dshx-count", children: [event, " ", _jsx("span", { style: { opacity: 0.7 }, children: rows.length })] }) }), _jsx("div", { className: "dshx-rows", children: rows.map(hook => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: [hook.matcher !== '' ? hook.matcher : '全部工具', _jsx("span", { className: "dshx-badge", "data-on": String(!hook.disabled), children: hook.disabled ? '停用' : '启用' })] }), _jsx("div", { className: "dshx-row-desc", style: { whiteSpace: 'normal' }, children: hook.command })] }), _jsxs("div", { className: "dshx-actions", children: [_jsx(Button, { variant: "outline", disabled: busy === hook.id, onClick: () => { setBusy(hook.id); apply(postJson('/hooks/set-enabled', { id: hook.id, enabled: hook.disabled })); }, children: busy === hook.id ? '…' : hook.disabled ? '启用' : '停用' }), _jsx(Button, { variant: "outline", disabled: busy === hook.id, onClick: () => {
                                                setBusy(hook.id);
                                                apply(fetch(`${apiBase()}/hooks?id=${encodeURIComponent(hook.id)}`, { method: 'DELETE' }).then(r => r.json()));
                                            }, children: busy === hook.id ? '…' : '删除' })] })] }, hook.id))) })] }, event))), _jsx(Modal, { open: draft !== null, onClose: () => { if (busy === '')
                    setDraft(null); }, title: "\u65B0\u5EFA\u94A9\u5B50", closeLabel: "\u5173\u95ED", description: "\u5728\u4F1A\u8BDD\u751F\u547D\u5468\u671F\u7684\u5BF9\u5E94\u4E8B\u4EF6\u70B9\u6267\u884C shell \u547D\u4EE4\u3002", footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", disabled: busy !== '', onClick: () => { setDraft(null); }, children: "\u53D6\u6D88" }), _jsx(Button, { disabled: busy !== '' || draft === null || draft.command.trim() === '', onClick: () => { submit(); }, children: busy === '__create__' ? '创建中…' : '创建' })] })), children: draft !== null && (_jsxs("div", { className: "dshx-grid", children: [_jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u751F\u547D\u5468\u671F\u4E8B\u4EF6" }), _jsx("select", { value: draft.event, onChange: event => { setDraft({ ...draft, event: event.target.value }); }, children: events.map(name => _jsx("option", { value: name, children: name }, name)) })] }), _jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u5339\u914D\u5668\uFF08\u9009\u586B\uFF0C\u5982 Bash\uFF09" }), _jsx("input", { value: draft.matcher, spellCheck: false, placeholder: "\u7559\u7A7A\u5339\u914D\u5168\u90E8", onChange: event => { setDraft({ ...draft, matcher: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u8981\u6267\u884C\u7684\u547D\u4EE4" }), _jsx("input", { value: draft.command, spellCheck: false, placeholder: "node C:/hooks/notify.js", onChange: event => { setDraft({ ...draft, command: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF0C\u9009\u586B\uFF09" }), _jsx("input", { value: draft.timeout, spellCheck: false, placeholder: "60000", onChange: event => { setDraft({ ...draft, timeout: event.target.value.replace(/\D/g, '') }); } })] }), formError !== '' && _jsx(Msg, { kind: "error", children: formError })] })) })] }));
}
export function GitSection() {
    const workspaces = workspace();
    const [items, setItems] = useState([]);
    const [selected, setSelected] = useState('');
    const [info, setInfo] = useState(null);
    const [loading, setLoading] = useState(false);
    const [action, setAction] = useState('');
    const [notice, setNotice] = useState('');
    const [checked, setChecked] = useState(new Set());
    const [message, setMessage] = useState('');
    const loadInfo = useCallback((target) => {
        if (target === '') {
            setInfo(null);
            return;
        }
        setLoading(true);
        api(`/git?path=${encodeURIComponent(target)}`)
            .then((result) => {
            setInfo(result);
            setChecked(new Set());
            setNotice('');
        })
            .catch((err) => { setInfo({ error: err.message }); })
            .finally(() => { setLoading(false); });
    }, []);
    useEffect(() => {
        if (workspaces === null)
            return;
        const read = () => {
            const snapshot = workspaces.list.getSnapshot();
            const rows = snapshot.items.map(row => ({
                workspaceId: row.workspaceId, path: row.path, title: row.title,
            }));
            setItems(rows);
            setSelected(previous => previous !== '' ? previous : (rows[0]?.path ?? ''));
        };
        read();
        const off = workspaces.list.subscribe(read);
        return off;
    }, [workspaces]);
    useEffect(() => { loadInfo(selected); }, [selected, loadInfo]);
    const runAction = (kind, extra) => {
        if (selected === '' || action !== '')
            return;
        setAction(kind);
        setNotice('');
        const url = kind === 'commit' ? '/git/commit' : `/git/${kind}`;
        postJson(url, { path: selected, ...extra })
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            const output = result.output;
            setNotice(output !== undefined && output !== '' ? output : '完成');
            if (kind === 'commit') {
                setMessage('');
                setChecked(new Set());
            }
            loadInfo(selected);
        })
            .catch((err) => { setNotice(`失败：${err.message}`); })
            .finally(() => { setAction(''); });
    };
    const toggle = (file) => {
        setChecked(previous => {
            const next = new Set(previous);
            if (next.has(file))
                next.delete(file);
            else
                next.add(file);
            return next;
        });
    };
    const changes = info?.changes ?? [];
    const allChecked = changes.length > 0 && changes.every(change => checked.has(change.file));
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsxs("div", { className: "dshx-toolbar", children: [_jsxs("select", { className: "dshx-input", style: { flex: 1 }, value: selected, onChange: event => { setSelected(event.target.value); }, children: [items.length === 0 && _jsx("option", { value: "", children: "\uFF08\u5C1A\u672A\u6CE8\u518C\u5DE5\u4F5C\u533A\uFF09" }), items.map(row => (_jsx("option", { value: row.path, children: row.title }, row.workspaceId)))] }), _jsx(Button, { disabled: loading || selected === '', onClick: () => { loadInfo(selected); }, children: loading ? '刷新中…' : '刷新' })] }), info !== null && info.error !== undefined && info.error !== '' && _jsx(Msg, { kind: "error", children: info.error }), info !== null && info.branch !== undefined && info.branch !== '' && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "dshx-toolbar", style: { marginTop: '4px', alignItems: 'center' }, children: [_jsxs("span", { className: "dshx-row-title", style: { fontSize: '13px', whiteSpace: 'nowrap' }, children: ["\u5F53\u524D\u5206\u652F ", _jsx("span", { className: "dshx-code", children: info.branch })] }), _jsxs("span", { className: "dshx-actions", children: [_jsxs("select", { className: "dshx-input", style: { height: '28px', fontSize: '12px' }, value: "", onChange: event => { if (event.target.value !== '')
                                            runAction('checkout', { branch: event.target.value }); }, children: [_jsx("option", { value: "", children: "\u5207\u6362\u5206\u652F\u2026" }), (info.branches ?? []).filter(branch => branch !== info.branch).map(branch => (_jsx("option", { value: branch, children: branch }, branch)))] }), _jsx(Button, { variant: "outline", disabled: action !== '', onClick: () => { runAction('pull'); }, children: action === 'pull' ? '更新中…' : '更新项目' }), _jsx(Button, { variant: "outline", disabled: action !== '', onClick: () => { runAction('push'); }, children: action === 'push' ? '推送中…' : '推送项目' })] })] }), notice !== '' && _jsx(Msg, { children: notice }), _jsx("div", { className: "dshx-toolbar", style: { marginTop: '8px' }, children: _jsx("span", { className: "dshx-count", children: _jsxs("label", { style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }, children: [_jsx("input", { type: "checkbox", checked: allChecked, onChange: event => {
                                            setChecked(event.target.checked ? new Set(changes.map(change => change.file)) : new Set());
                                        } }), "\u5DE5\u4F5C\u533A\u6539\u52A8 ", changes.length, " \u4E2A"] }) }) }), _jsxs("div", { children: [changes.map(change => (_jsxs("div", { className: "dshx-git-item", children: [_jsx("input", { type: "checkbox", checked: checked.has(change.file), onChange: () => { toggle(change.file); } }), _jsx("span", { className: "dshx-code", children: change.code || 'M' }), _jsx("span", { children: change.file })] }, change.file))), changes.length === 0 && _jsx(Msg, { children: "\u5DE5\u4F5C\u533A\u5E72\u51C0\u3002" })] }), _jsxs("div", { className: "dshx-toolbar", style: { marginTop: '8px' }, children: [_jsx("input", { className: "dshx-input", style: { flex: 1 }, value: message, spellCheck: false, placeholder: "\u63D0\u4EA4\u4FE1\u606F\uFF08\u5148\u52FE\u9009\u8981\u63D0\u4EA4\u7684\u6587\u4EF6\uFF09", onChange: event => { setMessage(event.target.value); }, onKeyDown: event => { if (event.key === 'Enter' && checked.size > 0 && message.trim() !== '')
                                    runAction('commit', { files: [...checked], message }); } }), _jsx(Button, { disabled: action !== '' || checked.size === 0 || message.trim() === '', onClick: () => { runAction('commit', { files: [...checked], message }); }, children: action === 'commit' ? '提交中…' : `提交选中 (${checked.size})` })] }), _jsx("div", { className: "dshx-toolbar", style: { marginTop: '10px' }, children: _jsx("span", { className: "dshx-count", children: "\u6700\u8FD1\u63D0\u4EA4" }) }), _jsx("div", { children: (info.log ?? []).map(line => (_jsxs("div", { className: "dshx-git-item", children: [_jsx("span", { className: "dshx-code", children: line.slice(0, 7) }), _jsx("span", { children: line.slice(8) })] }, line))) })] }))] }));
}
export function FilesOverlay() {
    // Tree state: each expanded directory's children cached by path. The root
    // selector lists every registered workspace; the preview renders inside
    // the panel (never a modal over the app).
    const [open, setOpen] = useState(false);
    const [tree, setTree] = useState(new Map());
    const [expanded, setExpanded] = useState(new Set());
    const [error, setError] = useState('');
    const [preview, setPreview] = useState(null);
    const workspaces = workspace();
    const [workspacesList, setWorkspacesList] = useState([]);
    const [root, setRoot] = useState('');
    useEffect(() => {
        const read = () => {
            if (workspaces !== null) {
                const snap = workspaces.list.getSnapshot();
                const items = snap.items.map(row => ({ path: row.path, title: row.title }));
                if (items.length > 0) {
                    setWorkspacesList(items);
                    return;
                }
            }
            // Desktop harness: no WebSocket follow — fall back to dialog API
            api('/workspaces')
                .then((data) => { setWorkspacesList(data.workspaces ?? []); })
                .catch(() => { });
        };
        read();
        if (workspaces !== null) {
            const off = workspaces.list.subscribe(read);
            return off;
        }
    }, [workspaces]);
    useEffect(() => {
        if (root === '' && workspacesList.length > 0)
            setRoot(workspacesList[0]?.path ?? '');
    }, [root, workspacesList]);
    const loadDir = useCallback((target) => {
        api(`/files?path=${encodeURIComponent(target)}`)
            .then((result) => {
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            const resolved = result.path ?? target;
            setTree(previous => {
                const next = new Map(previous);
                next.set(resolved, result.entries ?? []);
                return next;
            });
            setExpanded(previous => new Set(previous).add(resolved));
            setError('');
        })
            .catch((err) => { setError(err.message); });
    }, []);
    useEffect(() => {
        if (open && root !== '' && !tree.has(root))
            loadDir(root);
    }, [open, root, tree, loadDir]);
    const toggleDir = (full) => {
        setExpanded(previous => {
            const next = new Set(previous);
            if (next.has(full))
                next.delete(full);
            else {
                next.add(full);
                if (!tree.has(full))
                    loadDir(full);
            }
            return next;
        });
    };
    const openFile = (full) => {
        api(`/file-content?path=${encodeURIComponent(full)}`)
            .then((result) => {
            if (result.error !== undefined || result.content === undefined) {
                setError(result.error ?? '无法读取');
                return;
            }
            setPreview({ path: result.path ?? full, content: result.content });
        })
            .catch((err) => { setError(err.message); });
    };
    const renderLevel = (dir, depth) => {
        const entries = tree.get(dir);
        if (entries === undefined)
            return null;
        return entries.map(entry => {
            const full = dir.replace(/[\\/]+$/, '') + '\\' + entry.name;
            const isExpanded = expanded.has(full);
            return (_jsxs("div", { children: [_jsxs("div", { className: "dshx-file-row", style: { paddingLeft: 12 + depth * 14 }, onClick: () => { if (entry.dir)
                            toggleDir(full);
                        else
                            openFile(full); }, children: [_jsx("span", { style: { width: 12, flexShrink: 0, fontSize: '10px', color: 'var(--dsw-alias-label-tertiary,#9296a0)' }, children: entry.dir ? (isExpanded ? '▾' : '▸') : '' }), _jsx("span", { children: entry.dir ? '📁' : '📄' }), _jsx("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis' }, children: entry.name }), !entry.dir && entry.size > 0 && _jsx("span", { className: "dshx-file-size", children: entry.size > 1024 ? `${Math.round(entry.size / 1024)}K` : `${entry.size}B` })] }), entry.dir && isExpanded && renderLevel(full, depth + 1)] }, full));
        });
    };
    return (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "dshx-fab", style: { right: '16px', top: '96px' }, title: "\u6587\u4EF6\u9762\u677F", onClick: () => { setOpen(!open); }, children: "\uD83D\uDCC1" }), open && (_jsx("div", { className: "dshx-panel", style: { top: '0', right: '0', bottom: '0', width: '360px', borderRight: 'none' }, children: preview !== null ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "dshx-head", children: [_jsx("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }, title: preview.path, children: preview.path.split('\\').pop() }), _jsx("button", { type: "button", className: "dshx-fab", style: { position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }, title: "\u8FD4\u56DE", onClick: () => { setPreview(null); }, children: "\u2190" })] }), _jsx("div", { style: { padding: '8px 10px', fontSize: '10.5px', color: 'var(--dsw-alias-label-tertiary,#9296a0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: preview.path }), _jsx("div", { style: { flex: 1, overflow: 'auto' }, children: _jsx("pre", { className: "dshx-pre", style: { margin: '0 10px 12px' }, children: preview.content }) })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "dshx-head", children: [_jsx("span", { children: "\u6587\u4EF6" }), _jsxs("span", { style: { display: 'flex', gap: '6px' }, children: [_jsx("button", { type: "button", className: "dshx-fab", style: { position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }, title: "\u5237\u65B0", onClick: () => { setTree(new Map()); if (root !== '')
                                                loadDir(root); }, children: "\u27F3" }), _jsx("button", { type: "button", className: "dshx-fab", style: { position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }, title: "\u5173\u95ED", onClick: () => { setOpen(false); }, children: "\u2715" })] })] }), _jsx("div", { style: { padding: '6px 10px' }, children: _jsxs("select", { className: "dshx-input", style: { width: '100%', fontSize: '12px', height: '28px' }, value: root, onChange: event => { setRoot(event.target.value); }, children: [workspacesList.map(row => (_jsx("option", { value: row.path, children: row.title }, row.path))), workspacesList.length === 0 && _jsx("option", { value: "", children: "\uFF08\u672A\u6CE8\u518C\u5DE5\u4F5C\u533A\uFF09" })] }) }), _jsxs("div", { style: { flex: 1, overflow: 'auto' }, children: [error !== '' && _jsx(Msg, { kind: "error", children: error }), root !== '' && renderLevel(root, 0)] })] })) }))] }));
}
// ── terminal overlay (real PTY over SSE) ─────────────────────────────────────
/** Strip the ANSI sequences a full TTY emits; the panel renders plain text. */
function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
export function TerminalOverlay() {
    const [open, setOpen] = useState(false);
    const [lines, setLines] = useState([]);
    const [input, setInput] = useState('');
    const [history, setHistory] = useState([]);
    const [historyAt, setHistoryAt] = useState(-1);
    const [connected, setConnected] = useState(false);
    const scroller = useRef(null);
    const sourceRef = useRef(null);
    // One EventSource per open panel; the backlog replays on connect so the
    // previous session's output is preserved across open/close cycles.
    useEffect(() => {
        if (!open) {
            sourceRef.current?.close();
            sourceRef.current = null;
            setConnected(false);
            return;
        }
        if (sourceRef.current !== null)
            return;
        const source = new EventSource(`${apiBase()}/term-stream?panel=main`);
        source.onopen = () => { setConnected(true); };
        source.onmessage = (event) => {
            const chunk = JSON.parse(event.data);
            if (chunk === '[EXITED]') {
                setConnected(false);
                return;
            }
            setLines(previous => {
                const merged = [...previous];
                const clean = stripAnsi(chunk);
                const lastLine = merged.length > 0 ? (merged[merged.length - 1] ?? '') : '';
                const combined = (merged.length > 0 ? lastLine : '') + clean;
                const parts = combined.split('\n');
                if (merged.length === 0)
                    return parts.slice(-800);
                merged.splice(merged.length - 1, 1, ...parts);
                return merged.slice(-800);
            });
        };
        source.onerror = () => { setConnected(false); };
        sourceRef.current = source;
    }, [open]);
    useEffect(() => {
        const node = scroller.current;
        if (node !== null)
            node.scrollTop = node.scrollHeight;
    }, [lines, scroller]);
    const send = (text) => {
        void fetch(`${apiBase()}/term-input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ panel: 'main', data: text + '\r' }),
        });
        if (text.trim() !== '') {
            setHistory(previous => [...previous, text]);
            setHistoryAt(-1);
        }
    };
    const submit = () => {
        if (input.trim() === '')
            return;
        send(input);
        setInput('');
    };
    const recall = (direction) => {
        if (history.length === 0)
            return;
        let at = historyAt + direction;
        if (at < 0)
            at = 0;
        if (at >= history.length)
            at = history.length;
        setHistoryAt(at);
        setInput(at === history.length ? '' : (history[at] ?? ''));
    };
    return (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "dshx-fab", style: { right: '16px', bottom: '16px' }, title: "\u7EC8\u7AEF", onClick: () => { setOpen(!open); }, children: "\u2328" }), open && (_jsxs("div", { className: "dshx-panel", style: { left: '0', right: '0', bottom: '0', height: '320px', borderBottom: 'none' }, children: [_jsxs("div", { className: "dshx-head", children: [_jsxs("span", { children: ["\u7EC8\u7AEF ", _jsx("span", { className: "dshx-badge", "data-on": String(connected), children: connected ? '已连接' : '连接中…' })] }), _jsxs("span", { style: { display: 'flex', gap: '6px' }, children: [_jsx("button", { type: "button", className: "dshx-fab", style: { position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }, title: "\u6E05\u5C4F", onClick: () => { setLines([]); }, children: "\uD83D\uDDD1" }), _jsx("button", { type: "button", className: "dshx-fab", style: { position: 'static', width: '26px', height: '26px', fontSize: '12px', boxShadow: 'none' }, title: "\u5173\u95ED", onClick: () => { setOpen(false); }, children: "\u2715" })] })] }), _jsx("div", { className: "dshx-term-out", ref: scroller, children: lines.map((line, index) => (_jsx("div", { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.2em' }, children: line }, index))) }), _jsxs("div", { className: "dshx-term-in", children: [_jsx("span", { style: { font: '12.5px ui-monospace,monospace', alignSelf: 'center' }, children: "PS>" }), _jsx("input", { value: input, spellCheck: false, autoFocus: true, onChange: event => { setInput(event.target.value); }, onKeyDown: event => {
                                    if (event.key === 'Enter') {
                                        send(input);
                                        setInput('');
                                    }
                                    else if (event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        recall(-1);
                                    }
                                    else if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        recall(1);
                                    }
                                } }), _jsx(Button, { disabled: input.trim() === '', onClick: () => { submit(); }, children: "\u53D1\u9001" })] })] }))] }));
}
/**
 * Code-index settings: the codegraph MCP server carries the repository
 * index. The master switch toggles the server itself (restart to apply);
 * the two granular toggles ride its env contract.
 */
export function IndexSection() {
    const [server, setServer] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const reload = useCallback(() => {
        api('/mcp')
            .then((data) => {
            if (data.error !== undefined)
                throw new Error(data.error);
            const found = (data.servers ?? []).find(entry => entry.name === 'codegraph') ?? null;
            setServer(found);
            setError(found === null ? '未检测到 codegraph MCP 服务器（在 MCP 服务器页添加后可用）' : '');
        })
            .catch((err) => { setError(err.message); });
    }, []);
    useEffect(() => { reload(); }, [reload]);
    const patch = (mutate) => {
        if (server === null || busy)
            return;
        setBusy(true);
        const next = { ...server, env: { ...(server.env ?? {}) } };
        mutate(next);
        api('/mcp')
            .then((data) => {
            const original = (data.servers ?? []).find(entry => entry.name === 'codegraph');
            if (original === undefined)
                throw new Error('codegraph 服务器不存在');
            return postJson('/mcp', {
                name: original.name,
                transport: 'stdio',
                enabled: next.enabled,
                command: original.command,
                args: original.args ?? [],
                env: next.env,
            });
        })
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            reload();
        })
            .catch((err) => { setError(err.message); })
            .finally(() => { setBusy(false); });
    };
    const envOn = (key) => server?.env?.[key] === '1';
    if (server === null && error === '')
        return _jsx("div", { className: "dshx-wrap", children: _jsx(Msg, { children: "\u52A0\u8F7D\u4E2D\u2026" }) });
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsx("div", { className: "dshx-toolbar", children: _jsx("span", { className: "dshx-count", children: "\u4EE3\u7801\u5E93\u7D22\u5F15\uFF08codegraph\uFF09" }) }), error !== '' && _jsx(Msg, { kind: "error", children: error }), server !== null && (_jsxs("div", { className: "dshx-rows", children: [_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsx("div", { className: "dshx-row-title", children: "\u542F\u7528 codegraph \u7D22\u5F15\u670D\u52A1" }), _jsx("div", { className: "dshx-row-desc", children: "\u5173\u95ED\u540E\u6A21\u578B\u4E0D\u518D\u83B7\u5F97\u4EE3\u7801\u5E93\u7D22\u5F15\u5DE5\u5177\u3002\u4FDD\u5B58\u540E\u81EA\u52A8\u91CD\u542F\u751F\u6548\u3002" })] }), _jsx("div", { className: "dshx-actions", children: _jsx(Button, { variant: "outline", disabled: busy, onClick: () => { patch(entry => { entry.enabled = !entry.enabled; }); }, children: server.enabled ? '停用' : '启用' }) })] }), _jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsx("div", { className: "dshx-row-title", children: "\u81EA\u52A8\u7D22\u5F15\u65B0\u6587\u4EF6\u5939" }), _jsx("div", { className: "dshx-row-desc", children: "\u81EA\u52A8\u7D22\u5F15\u6587\u4EF6\u6570\u5C11\u4E8E 50,000 \u7684\u65B0\u6587\u4EF6\u5939\u3002" })] }), _jsx("div", { className: "dshx-actions", children: _jsx(Button, { variant: "outline", disabled: busy, onClick: () => { patch(entry => { entry.env = { ...(entry.env ?? {}), CODEGRAPH_AUTO_INDEX: envOn('CODEGRAPH_AUTO_INDEX') ? '0' : '1' }; }); }, children: envOn('CODEGRAPH_AUTO_INDEX') ? '关闭' : '开启' }) })] }), _jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsx("div", { className: "dshx-row-title", children: "\u7D22\u5F15\u5B58\u50A8\u5E93\u4EE5\u5B9E\u73B0\u5373\u65F6\u641C\u7D22\uFF08\u6D4B\u8BD5\u7248\uFF09" }), _jsx("div", { className: "dshx-row-desc", children: "\u81EA\u52A8\u5BF9\u4ED3\u5E93\u8FDB\u884C\u7D22\u5F15\uFF0C\u4EE5\u52A0\u5FEB Grep \u641C\u7D22\u901F\u5EA6\u3002\u6240\u6709\u6570\u636E\u5747\u5B58\u50A8\u5728\u672C\u5730\u3002" })] }), _jsx("div", { className: "dshx-actions", children: _jsx(Button, { variant: "outline", disabled: busy, onClick: () => { patch(entry => { entry.env = { ...(entry.env ?? {}), CODEGRAPH_INDEX_REPOS: envOn('CODEGRAPH_INDEX_REPOS') ? '0' : '1' }; }); }, children: envOn('CODEGRAPH_INDEX_REPOS') ? '关闭' : '开启' }) })] })] }))] }));
}
// ── archive section ──────────────────────────────────────
/**
 * Archive management over the kernel's workspace registry: archiving toggles
 * the registry's own archived set (the same state the sidebar filters on),
 * so sidebar and this page always agree. Deletion removes the session's log
 * directory through the local bridge.
 */
function shortId(sessionId) {
    return sessionId.replace('session-', '').slice(0, 8);
}
export function ArchiveSection() {
    const workspaces = workspace();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [confirming, setConfirming] = useState(null);
    const [titles, setTitles] = useState(null);
    const [snapshot, setSnapshot] = useState(null);
    const reload = useCallback(() => {
        if (workspaces === null)
            return;
        const snap = workspaces.list.getSnapshot();
        setSnapshot({ items: snap.items, archived: snap.archivedSessionIds });
        setError('');
    }, [workspaces]);
    useEffect(() => {
        if (workspaces === null)
            return;
        reload();
        const off = workspaces.list.subscribe(reload);
        return off;
    }, [reload, workspaces]);
    useEffect(() => {
        api('/session-titles')
            .then((data) => { setTitles(data.titles ?? {}); })
            .catch(() => { setTitles({}); });
    }, []);
    // Kernel toggle: flips the in-memory archive flag. The follow stream may
    // not be connected in the desktop harness, so we poll the snapshot until
    // the target state matches (max 3 seconds).
    const toggle = (sessionId, targetArchived) => {
        if (workspaces === null || busy !== '')
            return;
        setBusy(sessionId);
        workspaces.archiveSession(sessionId)
            .then(() => {
            setError('');
            // Poll snapshot until archived state matches (desktop harness may lack follow stream)
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                const snap = workspaces.list.getSnapshot();
                const isArchived = snap.archivedSessionIds.includes(sessionId);
                if (isArchived === targetArchived || attempts > 30) {
                    clearInterval(poll);
                    reload();
                }
            }, 100);
        })
            .catch((err) => { setError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const remove = (sessionId) => {
        if (busy !== '')
            return;
        setBusy(sessionId);
        fetch(`${apiBase()}/session-delete?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
            .then((response) => response.json())
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            setConfirming(null);
            reload();
        })
            .catch((err) => { setError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const displayName = (sessionId) => {
        // Same source the sidebar uses: the session list's displayTitle. Fall
        // back to the projcache title, then a short id.
        const byId = sessions()?.list.getSnapshot().byId;
        const display = byId?.[sessionId]?.displayTitle;
        if (display !== undefined && display !== '')
            return display;
        return titles?.[sessionId] ?? shortId(sessionId);
    };
    const archivedSet = new Set(snapshot?.archived ?? []);
    const activeRows = [];
    for (const workspace of snapshot?.items ?? []) {
        for (const sessionId of workspace.sessionIds) {
            if (!archivedSet.has(sessionId)) {
                activeRows.push({ sessionId, workspaceTitle: workspace.title });
            }
        }
    }
    const archivedRows = [...archivedSet]
        .filter(sessionId => !activeRows.some(row => row.sessionId === sessionId))
        .map(sessionId => ({ sessionId, workspaceTitle: '' }));
    const renderRow = (row, isArchived) => (_jsxs("div", { className: "dshx-row", children: [_jsx("div", { className: "dshx-row-main", children: _jsxs("div", { className: "dshx-row-title", children: [_jsx("span", { style: { fontWeight: 500 }, children: displayName(row.sessionId) }), row.workspaceTitle !== '' && _jsx("span", { className: "dshx-badge", children: row.workspaceTitle }), isArchived && _jsx("span", { className: "dshx-badge", children: "\u5DF2\u5F52\u6863" })] }) }), _jsxs("div", { className: "dshx-actions", children: [_jsx(Button, { variant: "outline", disabled: busy === row.sessionId, onClick: () => { toggle(row.sessionId, !isArchived); }, children: busy === row.sessionId ? '…' : isArchived ? '恢复' : '归档' }), _jsx(Button, { variant: "outline", disabled: busy === row.sessionId, onClick: () => { setConfirming({ sessionId: row.sessionId, title: displayName(row.sessionId) }); }, children: "\u5220\u9664" })] })] }, row.sessionId));
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsx("div", { className: "dshx-toolbar", children: _jsx("span", { className: "dshx-count", children: snapshot === null ? '' : `活跃 ${activeRows.length} · 已归档 ${archivedRows.length}` }) }), error !== '' && _jsx(Msg, { kind: "error", children: error }), workspaces === null && _jsx(Msg, { kind: "error", children: "\u5DE5\u4F5C\u533A\u670D\u52A1\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5173\u95ED\u8BBE\u7F6E\u540E\u91CD\u8BD5\u3002" }), titles === null && _jsx(Msg, { children: "\u52A0\u8F7D\u4E2D\u2026" }), titles !== null && (_jsxs(_Fragment, { children: [_jsx("div", { className: "dshx-toolbar", style: { marginTop: '8px' }, children: _jsx("span", { className: "dshx-count", children: "\u6D3B\u8DC3\u4F1A\u8BDD" }) }), activeRows.length === 0 ? _jsx(Msg, { children: "\u6682\u65E0\u6D3B\u8DC3\u4F1A\u8BDD\u3002" }) : _jsx("div", { className: "dshx-rows", children: activeRows.map(row => renderRow(row, false)) }), _jsx("div", { className: "dshx-toolbar", style: { marginTop: '12px' }, children: _jsx("span", { className: "dshx-count", children: "\u5DF2\u5F52\u6863\u4F1A\u8BDD" }) }), archivedRows.length === 0 ? _jsx(Msg, { children: "\u6682\u65E0\u5F52\u6863\u4F1A\u8BDD\u3002" }) : _jsx("div", { className: "dshx-rows", children: archivedRows.map(row => renderRow(row, true)) }), _jsx(Modal, { open: confirming !== null, onClose: () => { setConfirming(null); }, title: "\u5220\u9664\u4F1A\u8BDD", closeLabel: "\u5173\u95ED", description: "\u5C06\u6C38\u4E45\u5220\u9664\u8BE5\u4F1A\u8BDD\u7684\u5168\u90E8\u8BB0\u5F55\uFF0C\u4E0D\u53EF\u6062\u590D\u3002", footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", onClick: () => { setConfirming(null); }, children: "\u53D6\u6D88" }), _jsx(Button, { onClick: () => { if (confirming !== null)
                                        remove(confirming.sessionId); }, children: "\u6C38\u4E45\u5220\u9664" })] })), children: _jsx(Msg, { kind: "error", children: `确定要删除会话「${confirming?.title ?? ''}」吗？` }) })] }))] }));
}
