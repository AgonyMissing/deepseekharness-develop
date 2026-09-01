import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useCallback, useEffect, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
/** Local bridge base URL (injected per page by the desktop shell). */
const apiBase = () => globalThis.__DSH_MCP_API__ ?? '';
/** One JSON round trip against the local bridge; failures surface as Error. */
async function api(path, options) {
    const response = await fetch(apiBase() + path, options);
    return await response.json();
}
function postJson(path, body) {
    return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}
// ── shared styling (scoped class names, one injected stylesheet) ────────────
const STYLE_ID = 'dshx-section-style';
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
`;
function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null)
        return;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = STYLE;
    document.head.appendChild(tag);
}
// The stylesheet is plugin-owned chrome: inject it once at module
// materialization so every section render finds its classes already present.
ensureStyle();
// ── small view helpers ───────────────────────────────────────────────────────
function Msg({ children, kind }) {
    return _jsx("div", { className: "dshx-msg", "data-kind": kind, children: children });
}
function RowActions({ children }) {
    return _jsx("div", { className: "dshx-actions", children: children });
}
function emptyDraft() {
    return { name: '', transport: 'stdio', command: '', args: '', url: '', enabled: true };
}
function draftOf(server) {
    return {
        name: server.name,
        transport: server.transport,
        command: server.command ?? '',
        args: (server.args ?? []).join(', '),
        url: server.url ?? '',
        enabled: server.enabled,
    };
}
export function McpSection() {
    const [servers, setServers] = useState(null);
    const [error, setError] = useState('');
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState('');
    const reload = useCallback(() => {
        api('/mcp')
            .then((data) => {
            if (data.error !== undefined)
                throw new Error(data.error);
            setServers(data.servers ?? []);
            setError('');
        })
            .catch((err) => { setError(err.message); });
    }, []);
    useEffect(() => { reload(); }, [reload]);
    const openEdit = (server) => {
        setFormError('');
        setDraft(draftOf(server));
    };
    const submit = () => {
        if (draft === null)
            return;
        setSaving(true);
        setFormError('');
        const body = {
            name: draft.name,
            transport: draft.transport,
            enabled: draft.enabled,
        };
        if (draft.transport === 'stdio') {
            body.command = draft.command;
            body.args = draft.args.split(',').map(arg => arg.trim()).filter(arg => arg !== '');
        }
        else {
            body.url = draft.url;
        }
        postJson('/mcp', body)
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            setDraft(null);
            reload();
        })
            .catch((err) => { setFormError(err.message); })
            .finally(() => { setSaving(false); });
    };
    const remove = (name) => {
        fetch(`${apiBase()}/mcp?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
            .then(() => { reload(); })
            .catch(() => { });
    };
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsxs("div", { className: "dshx-toolbar", children: [_jsx("span", { className: "dshx-count", children: servers === null ? '' : `${servers.length} 个服务器 · 保存后自动重启生效` }), _jsx(Button, { onClick: () => { setFormError(''); setDraft(emptyDraft()); }, children: "\u6DFB\u52A0\u670D\u52A1\u5668" })] }), error !== '' && _jsx(Msg, { kind: "error", children: `加载失败：${error}` }), servers !== null && servers.length === 0 && _jsx(Msg, { children: "\u6682\u65E0 MCP \u670D\u52A1\u5668\u3002\u70B9\u51FB\u53F3\u4E0A\u89D2\u300C\u6DFB\u52A0\u670D\u52A1\u5668\u300D\u914D\u7F6E\u4E00\u4E2A\u3002" }), _jsx("div", { className: "dshx-rows", children: (servers ?? []).map(server => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: [server.name, _jsx("span", { className: "dshx-badge", children: server.transport }), _jsx("span", { className: "dshx-badge", "data-on": String(server.enabled), children: server.enabled ? '启用' : '停用' })] }), _jsx("div", { className: "dshx-row-desc", children: server.transport === 'stdio'
                                        ? `${server.command ?? ''} ${(server.args ?? []).join(' ')}`
                                        : server.url ?? '' })] }), _jsxs(RowActions, { children: [_jsx(Button, { variant: "outline", onClick: () => { openEdit(server); }, children: "\u7F16\u8F91" }), _jsx(Button, { variant: "outline", onClick: () => { remove(server.name); }, children: "\u5220\u9664" })] })] }, server.name))) }), _jsx(Modal, { open: draft !== null, onClose: () => { if (!saving)
                    setDraft(null); }, title: draft !== null && (servers ?? []).some(s => s.name === draft.name) ? '编辑 MCP 服务器' : '添加 MCP 服务器', closeLabel: "\u5173\u95ED", description: "\u4FDD\u5B58\u540E\u4F1A\u5199\u5165 mcp-servers.json \u5E76\u81EA\u52A8\u91CD\u542F\u5BBF\u4E3B\u8FDB\u7A0B\u4F7F\u5176\u751F\u6548\u3002", footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", disabled: saving, onClick: () => { setDraft(null); }, children: "\u53D6\u6D88" }), _jsx(Button, { disabled: saving, onClick: () => { submit(); }, children: saving ? '保存中…' : '保存' })] })), children: draft !== null && (_jsxs("div", { className: "dshx-grid", children: [_jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u540D\u79F0" }), _jsx("input", { value: draft.name, spellCheck: false, placeholder: "my-server", onChange: event => { setDraft({ ...draft, name: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u4F20\u8F93\u7C7B\u578B" }), _jsxs("select", { value: draft.transport, onChange: event => { setDraft({ ...draft, transport: event.target.value === 'streamable-http' ? 'streamable-http' : 'stdio' }); }, children: [_jsx("option", { value: "stdio", children: "stdio" }), _jsx("option", { value: "streamable-http", children: "streamable-http" })] })] }), draft.transport === 'stdio' ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u542F\u52A8\u547D\u4EE4" }), _jsx("input", { value: draft.command, spellCheck: false, placeholder: "npx -y @some/mcp-server", onChange: event => { setDraft({ ...draft, command: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u53C2\u6570\uFF08\u9017\u53F7\u5206\u9694\uFF09" }), _jsx("input", { value: draft.args, spellCheck: false, placeholder: "--port, 3000", onChange: event => { setDraft({ ...draft, args: event.target.value }); } })] })] })) : (_jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u670D\u52A1\u5668\u5730\u5740" }), _jsx("input", { value: draft.url, spellCheck: false, placeholder: "https://example.com/mcp", onChange: event => { setDraft({ ...draft, url: event.target.value }); } })] })), _jsxs("label", { className: "dshx-check dshx-full", children: [_jsx("input", { type: "checkbox", checked: draft.enabled, onChange: event => { setDraft({ ...draft, enabled: event.target.checked }); } }), "\u542F\u7528\u8BE5\u670D\u52A1\u5668"] }), formError !== '' && _jsx(Msg, { kind: "error", children: formError })] })) })] }));
}
// ── skills section ───────────────────────────────────────────────────────────
export function SkillsSection() {
    const [skills, setSkills] = useState(null);
    const [candidates, setCandidates] = useState([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [importPath, setImportPath] = useState('');
    const [importOpen, setImportOpen] = useState(false);
    const [importError, setImportError] = useState('');
    const reload = useCallback(() => {
        Promise.all([
            api('/skills'),
            api('/skill-candidates').catch(() => ({ skills: [] })),
        ])
            .then(([list, cands]) => {
            if (list.error !== undefined)
                throw new Error(list.error);
            setSkills(list.skills ?? []);
            setCandidates((cands.skills ?? []).filter(candidate => !candidate.installed));
            setError('');
        })
            .catch((err) => { setError(err.message); });
    }, []);
    useEffect(() => { reload(); }, [reload]);
    const installByPath = (sourcePath, tag) => {
        setBusy(tag);
        postJson('/skills', { sourcePath })
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            setImportOpen(false);
            setImportError('');
            reload();
        })
            .catch((err) => { setImportError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const remove = (name) => {
        setBusy(name);
        fetch(`${apiBase()}/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
            .then(() => { reload(); })
            .catch(() => { })
            .finally(() => { setBusy(''); });
    };
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsxs("div", { className: "dshx-toolbar", children: [_jsx("span", { className: "dshx-count", children: skills === null ? '' : `${skills.length} 个技能` }), _jsx(Button, { onClick: () => { setImportError(''); setImportOpen(true); }, children: "\u4ECE\u672C\u5730\u5BFC\u5165" })] }), error !== '' && _jsx(Msg, { kind: "error", children: `加载失败：${error}` }), skills !== null && skills.length === 0 && _jsx(Msg, { children: "\u6682\u65E0\u6280\u80FD\u3002\u53EF\u5C06\u542B SKILL.md \u7684\u76EE\u5F55\u5BFC\u5165\u5230 dsh-home/skills\u3002" }), _jsx("div", { className: "dshx-rows", children: (skills ?? []).map(skill => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: [skill.name, _jsx("span", { className: "dshx-badge", "data-on": "true", children: skill.modelInvocable ? '模型可调用' : '仅用户' })] }), _jsx("div", { className: "dshx-row-desc", children: skill.description })] }), _jsx(RowActions, { children: _jsx(Button, { variant: "outline", disabled: busy === skill.name, onClick: () => { remove(skill.name); }, children: busy === skill.name ? '删除中…' : '删除' }) })] }, skill.name))) }), candidates.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "dshx-toolbar", style: { marginTop: '10px' }, children: _jsx("span", { className: "dshx-count", children: "\u53EF\u5B89\u88C5\u7684\u5019\u9009\u6280\u80FD" }) }), _jsx("div", { className: "dshx-rows", children: candidates.map(candidate => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: [candidate.name, _jsx("span", { className: "dshx-badge", children: candidate.source })] }), _jsx("div", { className: "dshx-row-desc", children: candidate.description || candidate.path })] }), _jsx(RowActions, { children: _jsx(Button, { disabled: busy === candidate.name, onClick: () => { installByPath(candidate.path, candidate.name); }, children: busy === candidate.name ? '安装中…' : '安装' }) })] }, candidate.name))) })] })), _jsx(Modal, { open: importOpen, onClose: () => { if (busy === '')
                    setImportOpen(false); }, title: "\u4ECE\u672C\u5730\u76EE\u5F55\u5BFC\u5165\u6280\u80FD", closeLabel: "\u5173\u95ED", description: "\u586B\u5199\u5305\u542B SKILL.md \u7684\u76EE\u5F55\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002", footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", disabled: busy !== '', onClick: () => { setImportOpen(false); }, children: "\u53D6\u6D88" }), _jsx(Button, { disabled: busy !== '' || importPath.trim() === '', onClick: () => { installByPath(importPath.trim(), '__import__'); }, children: busy === '__import__' ? '导入中…' : '导入' })] })), children: _jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84" }), _jsx("input", { value: importPath, spellCheck: false, placeholder: "C:\\\\skills\\\\my-skill", onChange: event => { setImportPath(event.target.value); } }), importError !== '' && _jsx(Msg, { kind: "error", children: importError })] }) })] }));
}
function emptySubagentDraft() {
    return { name: '', provider: 'codex', toolName: '', persona: '' };
}
export function SubagentsSection() {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState('');
    const [draft, setDraft] = useState(null);
    const [busy, setBusy] = useState('');
    const [formError, setFormError] = useState('');
    const reload = useCallback(() => {
        api('/subagents')
            .then((data) => {
            if (data.error !== undefined)
                throw new Error(data.error);
            setRows(data.subagents ?? []);
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
        postJson('/subagents', draft)
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            setDraft(null);
            reload();
        })
            .catch((err) => { setFormError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const setEnabled = (row, enabled) => {
        setBusy(row.id);
        postJson('/subagents/set-enabled', { id: row.id, enabled })
            .then((result) => {
            if (result.error !== undefined && result.error !== '')
                throw new Error(result.error);
            reload();
        })
            .catch((err) => { setError(err.message); })
            .finally(() => { setBusy(''); });
    };
    const remove = (row) => {
        setBusy(row.id);
        fetch(`${apiBase()}/subagents?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' })
            .then(() => { reload(); })
            .catch(() => { })
            .finally(() => { setBusy(''); });
    };
    return (_jsxs("div", { className: "dshx-wrap", children: [_jsxs("div", { className: "dshx-toolbar", children: [_jsx("span", { className: "dshx-count", children: rows === null ? '' : `${rows.length} 个委派行` }), _jsx(Button, { onClick: () => { setFormError(''); setDraft(emptySubagentDraft()); }, children: "\u65B0\u5EFA\u5B50\u667A\u80FD\u4F53" })] }), error !== '' && _jsx(Msg, { kind: "error", children: `加载失败：${error}` }), rows !== null && rows.length === 0 && _jsx(Msg, { children: "\u6682\u65E0\u5B50\u667A\u80FD\u4F53\u3002\u70B9\u51FB\u53F3\u4E0A\u89D2\u300C\u65B0\u5EFA\u5B50\u667A\u80FD\u4F53\u300D\u6DFB\u52A0\u4E00\u4E2A\u3002" }), _jsx("div", { className: "dshx-rows", children: (rows ?? []).map(row => (_jsxs("div", { className: "dshx-row", children: [_jsxs("div", { className: "dshx-row-main", children: [_jsxs("div", { className: "dshx-row-title", children: [row.toolName !== '' ? row.toolName : row.id, _jsx("span", { className: "dshx-badge", children: row.provider }), row.root === 'user' && _jsx("span", { className: "dshx-badge", children: "\u81EA\u5B9A\u4E49" }), _jsx("span", { className: "dshx-badge", "data-on": String(row.enabled), children: row.enabled ? '启用' : '停用' })] }), _jsx("div", { className: "dshx-row-desc", children: `预设：${row.preset} · ${row.id}` })] }), _jsx(RowActions, { children: row.root === 'user' && (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", disabled: busy === row.id, onClick: () => { setEnabled(row, !row.enabled); }, children: busy === row.id ? '…' : row.enabled ? '停用' : '启用' }), _jsx(Button, { variant: "outline", disabled: busy === row.id, onClick: () => { remove(row); }, children: busy === row.id ? '…' : '删除' })] })) })] }, `${row.preset}/${row.id}`))) }), _jsx(Modal, { open: draft !== null, onClose: () => { if (busy === '')
                    setDraft(null); }, title: "\u65B0\u5EFA\u5B50\u667A\u80FD\u4F53", closeLabel: "\u5173\u95ED", description: "\u521B\u5EFA\u540E\u5199\u5165 ~/.dsh/.agent-presets\uFF0C\u5BBF\u4E3B\u91CD\u542F\u540E\u7531\u5185\u6838\u9884\u8BBE\u6E05\u5355\u81EA\u52A8\u53D1\u73B0\u3002", footer: (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "outline", disabled: busy !== '', onClick: () => { setDraft(null); }, children: "\u53D6\u6D88" }), _jsx(Button, { disabled: busy !== '' || draft === null || draft.name.trim() === '', onClick: () => { submit(); }, children: busy === '__create__' ? '创建中…' : '创建' })] })), children: draft !== null && (_jsxs("div", { className: "dshx-grid", children: [_jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u540D\u79F0" }), _jsx("input", { value: draft.name, spellCheck: false, placeholder: "research-helper", onChange: event => { setDraft({ ...draft, name: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field", children: [_jsx("label", { children: "\u63D0\u4F9B\u65B9" }), _jsxs("select", { value: draft.provider, onChange: event => { setDraft({ ...draft, provider: event.target.value === 'claude-code' ? 'claude-code' : 'codex' }); }, children: [_jsx("option", { value: "codex", children: "Codex" }), _jsx("option", { value: "claude-code", children: "Claude Code" })] })] }), _jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u5DE5\u5177\u540D\uFF08\u9009\u586B\uFF0C\u9ED8\u8BA4 subagent_<\u540D\u79F0>\uFF09" }), _jsx("input", { value: draft.toolName, spellCheck: false, placeholder: "subagent_research", onChange: event => { setDraft({ ...draft, toolName: event.target.value }); } })] }), _jsxs("div", { className: "dshx-field dshx-full", children: [_jsx("label", { children: "\u4EBA\u8BBE\u8BF4\u660E" }), _jsx("input", { value: draft.persona, spellCheck: false, placeholder: "You are a focused research helper.", onChange: event => { setDraft({ ...draft, persona: event.target.value }); } })] }), formError !== '' && _jsx(Msg, { kind: "error", children: formError })] })) })] }));
}
