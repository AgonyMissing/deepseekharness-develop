window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-harness-extras",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region lib/types/client/HarnessSection.js
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
		/** Local bridge base URL (injected per page by the desktop shell). */
		const apiBase$1 = () => globalThis.__DSH_MCP_API__ ?? "";
		/** One JSON round trip against the local bridge; failures surface as Error. */
		async function api$1(path, options) {
			return await (await fetch(apiBase$1() + path, options)).json();
		}
		function postJson$1(path, body) {
			return api$1(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
		}
		const STYLE_ID$1 = "dshx-section-style";
		const STYLE$1 = `
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
.dshx-switch { position:relative; display:inline-flex; align-items:center; flex:none; cursor:pointer; }
.dshx-switch input { position:absolute; inset:0; opacity:0; margin:0; cursor:pointer; }
.dshx-switch-track { width:34px; height:20px; border-radius:999px; position:relative; flex:none;
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.18)); transition:background .15s; }
.dshx-switch-track::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px;
  border-radius:50%; background:#fff; transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.3); }
.dshx-switch input:checked + .dshx-switch-track { background:#1a7f37; }
.dshx-switch input:checked + .dshx-switch-track::after { transform:translateX(14px); }
.dshx-switch input:disabled + .dshx-switch-track { opacity:.45; }
.dshx-restarting { font-size:11.5px; color:var(--dsw-alias-label-tertiary,#9296a0); white-space:nowrap; }
.dshx-hero-git { display:inline-flex; }
.dshx-hero-chip { display:inline-flex; align-items:center; gap:4px; height:28px; padding:0 10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); border-radius:16px;
  background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1a1d26);
  font-size:13px; font-weight:500; line-height:1; cursor:pointer; white-space:nowrap; }
.dshx-hero-chip > span { display:inline-flex; align-items:center; line-height:1;
  transform:translateY(-1px); }
.dshx-hero-chip svg { display:block; }
.dshx-hero-chip:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }
.dshx-hero-chip:disabled { opacity:.55; cursor:default; }
.dshx-hero-chip-icon { color:var(--dsw-alias-label-secondary,#686c75); flex:none; }
.dshx-hero-notice { font-size:12px; color:var(--dsw-alias-label-tertiary,#9296a0); }
.dshx-hero-graph { max-height:60vh; overflow:auto; margin:0; padding:10px 12px;
  font:12px/1.5 ui-monospace,Consolas,monospace; white-space:pre; word-break:break-all;
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04)); border-radius:8px;
  color:var(--dsw-alias-label-primary,#1a1d26); }
.dshx-graph-modal { width: min(920px, 96vw) !important; }
.dshx-graph { max-height:64vh; overflow:auto; border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));
  border-radius:10px; background:var(--dsw-alias-bg-layer-1,#fff); min-width:0; }
.dshx-graph-head { display:flex; align-items:center; gap:8px; padding:9px 14px;
  background:var(--dsw-alias-bg-layer-2,#f6f7f9); border-bottom:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));
  font-size:12px; color:var(--dsw-alias-label-secondary,#686c75); position:sticky; top:0; z-index:1; }
.dshx-graph-head-cols { display:grid; grid-template-columns:minmax(0,1fr) 112px 70px 80px; gap:8px; flex:1; min-width:0; }
.dshx-graph-th { font-weight:500; white-space:nowrap; }
.dshx-graph-th-desc { padding-left:4px; }
.dshx-graph-th-date, .dshx-graph-th-hash { text-align:left; }
.dshx-graph-th-author { text-align:center; }
.dshx-graph-body { display:flex; padding:0 14px; }
.dshx-graph-lanes { display:block; flex:none; }
.dshx-graph-rows { flex:1; display:flex; flex-direction:column; min-width:0; }
.dshx-graph-row { display:grid; grid-template-columns:minmax(0,1fr) 112px 70px 80px; align-items:center;
  gap:8px; font-size:12.5px; min-width:0; height:26px; overflow:hidden; }
.dshx-graph-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)); }
.dshx-graph-subject { color:var(--dsw-alias-label-primary,#1a1d26); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.dshx-graph-pill { flex:none; max-width:150px; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; font-size:10.5px; padding:0 7px; height:18px; line-height:18px;
  border-radius:999px; border:1px solid transparent; }
.dshx-graph-pill[data-kind="head"] { border-color:rgba(207,102,0,.4); background:rgba(207,102,0,.1); color:#cf6600; }
.dshx-graph-pill[data-kind="branch"] { border-color:rgba(77,107,254,.35); background:rgba(77,107,254,.1); color:#4d6bfe; }
.dshx-graph-pill[data-kind="tag"] { border-color:rgba(130,80,223,.3); background:rgba(130,80,223,.1); color:#8250df; }
.dshx-graph-pill[data-kind="remote"] { border-color:var(--dsw-alias-border-l2,rgba(121,126,145,.3));
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)); color:var(--dsw-alias-label-secondary,#686c75); }
.dshx-graph-date { text-align:left; font-size:11.5px; color:var(--dsw-alias-label-tertiary,#9296a0); }
.dshx-graph-author { text-align:center; font-size:11.5px; color:var(--dsw-alias-label-secondary,#686c75); }
.dshx-graph-hash { text-align:left; font:11.5px ui-monospace,Consolas,monospace;
  color:var(--dsw-alias-label-tertiary,#9296a0); }
`;
		function ensureStyle$1() {
			if (document.getElementById(STYLE_ID$1) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID$1;
			tag.textContent = STYLE$1;
			document.head.appendChild(tag);
		}
		ensureStyle$1();
		function Msg$1({ children, kind }) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: "dshx-msg",
				"data-kind": kind,
				children
			});
		}
		function RowActions({ children }) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: "dshx-actions",
				children
			});
		}
		function emptyDraft() {
			return {
				name: "",
				transport: "stdio",
				command: "",
				args: "",
				url: "",
				enabled: true
			};
		}
		function draftOf(server) {
			return {
				name: server.name,
				transport: server.transport,
				command: server.command ?? "",
				args: (server.args ?? []).join(", "),
				url: server.url ?? "",
				enabled: server.enabled
			};
		}
		function McpSection() {
			const [servers, setServers] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [restarting, setRestarting] = (0, react.useState)({});
			const [formError, setFormError] = (0, react.useState)("");
			const reload = (0, react.useCallback)(() => {
				api$1("/mcp").then((data) => {
					if (data.error !== void 0) throw new Error(data.error);
					setServers(data.servers ?? []);
					setError("");
				}).catch((err) => {
					setError(err.message);
				});
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const openEdit = (server) => {
				setFormError("");
				setDraft(draftOf(server));
			};
			const submit = () => {
				if (draft === null) return;
				setSaving(true);
				setFormError("");
				const body = {
					name: draft.name,
					transport: draft.transport,
					enabled: draft.enabled
				};
				if (draft.transport === "stdio") {
					body.command = draft.command;
					body.args = draft.args.split(",").map((arg) => arg.trim()).filter((arg) => arg !== "");
				} else body.url = draft.url;
				postJson$1("/mcp", body).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					setDraft(null);
					reload();
					noteRestarting(body.name, body.enabled);
				}).catch((err) => {
					setFormError(err.message);
				}).finally(() => {
					setSaving(false);
				});
			};
			const remove = (name) => {
				fetch(`${apiBase$1()}/mcp?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(() => {
					reload();
				}).catch(() => {});
			};
			const noteRestarting = (name, targetEnabled) => {
				setRestarting((prev) => ({ ...prev, [name]: targetEnabled }));
				// The desktop shell debounces the host restart (~0.9s) and the
				// server takes ~1-2s to come back; clear the hint and resync
				// once the restart has settled.
				setTimeout(() => {
					setRestarting((prev) => {
						if (!(name in prev)) return prev;
						const next = { ...prev };
						delete next[name];
						return next;
					});
					reload();
				}, 3200);
			};
			const toggleEnabled = (server) => {
				const body = {
					name: server.name,
					transport: server.transport,
					enabled: !server.enabled
				};
				if (server.transport === "stdio") {
					body.command = server.command;
					body.args = server.args ?? [];
					body.env = server.env ?? {};
				} else {
					body.url = server.url;
					body.headers = server.headers ?? {};
				}
				noteRestarting(server.name, !server.enabled);
				setServers((list) => (list ?? []).map((s) => s.name === server.name ? { ...s, enabled: !s.enabled } : s));
				postJson$1("/mcp", body).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
				}).catch((err) => {
					setRestarting((prev) => {
						if (!(server.name in prev)) return prev;
						const next = { ...prev };
						delete next[server.name];
						return next;
					});
					setServers((list) => (list ?? []).map((s) => s.name === server.name ? { ...s, enabled: server.enabled } : s));
					setError(err.message);
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-toolbar",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: servers === null ? "" : `${servers.length} 个服务器 · 保存或切换开关后自动重启`
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => {
								setFormError("");
								setDraft(emptyDraft());
							},
							children: "添加服务器"
						})]
					}),
					error !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
						kind: "error",
						children: `加载失败：${error}`
					}),
					servers !== null && servers.length === 0 && (0, react_jsx_runtime.jsx)(Msg$1, { children: "暂无 MCP 服务器。点击右上角「添加服务器」配置一个。" }),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-rows",
						children: (servers ?? []).map((server) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: [
										server.name,
										(0, react_jsx_runtime.jsx)("span", {
											className: "dshx-badge",
											children: server.transport
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "dshx-badge",
											"data-on": String(server.enabled),
											children: server.enabled ? "启用" : "停用"
										})
									]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									children: server.transport === "stdio" ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}` : server.url ?? ""
								})]
						}), (0, react_jsx_runtime.jsxs)(RowActions, { children: [(0, react_jsx_runtime.jsx)("label", {
							className: "dshx-switch",
							title: server.enabled ? "点击停用" : "点击启用",
							children: [(0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: server.enabled,
								disabled: server.name in restarting,
								onChange: () => {
									toggleEnabled(server);
								}
							}), (0, react_jsx_runtime.jsx)("span", {
								className: "dshx-switch-track"
							})]
						}), server.name in restarting && (0, react_jsx_runtime.jsx)("span", {
							className: "dshx-restarting",
							children: restarting[server.name] ? "启动中…" : "关闭中…"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							onClick: () => {
								openEdit(server);
							},
							children: "编辑"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							onClick: () => {
								remove(server.name);
							},
							children: "删除"
						})] })]
						}, server.name))
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: draft !== null,
						onClose: () => {
							if (!saving) setDraft(null);
						},
						title: draft !== null && (servers ?? []).some((s) => s.name === draft.name) ? "编辑 MCP 服务器" : "添加 MCP 服务器",
						closeLabel: "关闭",
						description: "保存后会写入 mcp-servers.json 并自动重启宿主进程使其生效。",
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: saving,
							onClick: () => {
								setDraft(null);
							},
							children: "取消"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: saving,
							onClick: () => {
								submit();
							},
							children: saving ? "保存中…" : "保存"
						})] }),
						children: draft !== null && (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-grid",
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "名称" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.name,
										spellCheck: false,
										placeholder: "my-server",
										onChange: (event) => {
											setDraft({
												...draft,
												name: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "传输类型" }), (0, react_jsx_runtime.jsxs)("select", {
										value: draft.transport,
										onChange: (event) => {
											setDraft({
												...draft,
												transport: event.target.value === "streamable-http" ? "streamable-http" : "stdio"
											});
										},
										children: [(0, react_jsx_runtime.jsx)("option", {
											value: "stdio",
											children: "stdio"
										}), (0, react_jsx_runtime.jsx)("option", {
											value: "streamable-http",
											children: "streamable-http"
										})]
									})]
								}),
								draft.transport === "stdio" ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "启动命令" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.command,
										spellCheck: false,
										placeholder: "npx -y @some/mcp-server",
										onChange: (event) => {
											setDraft({
												...draft,
												command: event.target.value
											});
										}
									})]
								}), (0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "参数（逗号分隔）" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.args,
										spellCheck: false,
										placeholder: "--port, 3000",
										onChange: (event) => {
											setDraft({
												...draft,
												args: event.target.value
											});
										}
									})]
								})] }) : (0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "服务器地址" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.url,
										spellCheck: false,
										placeholder: "https://example.com/mcp",
										onChange: (event) => {
											setDraft({
												...draft,
												url: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									className: "dshx-check dshx-full",
									children: [(0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: draft.enabled,
										onChange: (event) => {
											setDraft({
												...draft,
												enabled: event.target.checked
											});
										}
									}), "启用该服务器"]
								}),
								formError !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
									kind: "error",
									children: formError
								})
							]
						})
					})
				]
			});
		}
		function SkillsSection() {
			const [skills, setSkills] = (0, react.useState)(null);
			const [candidates, setCandidates] = (0, react.useState)([]);
			const [error, setError] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)("");
			const [importPath, setImportPath] = (0, react.useState)("");
			const [importOpen, setImportOpen] = (0, react.useState)(false);
			const [importError, setImportError] = (0, react.useState)("");
			const reload = (0, react.useCallback)(() => {
				Promise.all([api$1("/skills"), api$1("/skill-candidates").catch(() => ({ skills: [] }))]).then(([list, cands]) => {
					if (list.error !== void 0) throw new Error(list.error);
					setSkills(list.skills ?? []);
					setCandidates((cands.skills ?? []).filter((candidate) => !candidate.installed));
					setError("");
				}).catch((err) => {
					setError(err.message);
				});
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const installByPath = (sourcePath, tag) => {
				setBusy(tag);
				postJson$1("/skills", { sourcePath }).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					setImportOpen(false);
					setImportError("");
					reload();
				}).catch((err) => {
					setImportError(err.message);
				}).finally(() => {
					setBusy("");
				});
			};
			const remove = (name) => {
				setBusy(name);
				fetch(`${apiBase$1()}/skills?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(() => {
					reload();
				}).catch(() => {}).finally(() => {
					setBusy("");
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-toolbar",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: skills === null ? "" : `${skills.length} 个技能`
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => {
								setImportError("");
								setImportOpen(true);
							},
							children: "从本地导入"
						})]
					}),
					error !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
						kind: "error",
						children: `加载失败：${error}`
					}),
					skills !== null && skills.length === 0 && (0, react_jsx_runtime.jsx)(Msg$1, { children: "暂无技能。可将含 SKILL.md 的目录导入到 dsh-home/skills。" }),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-rows",
						children: (skills ?? []).map((skill) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: [skill.name, (0, react_jsx_runtime.jsx)("span", {
										className: "dshx-badge",
										"data-on": "true",
										children: skill.modelInvocable ? "模型可调用" : "仅用户"
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									children: skill.description
								})]
							}), (0, react_jsx_runtime.jsx)(RowActions, { children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								disabled: busy === skill.name,
								onClick: () => {
									remove(skill.name);
								},
								children: busy === skill.name ? "删除中…" : "删除"
							}) })]
						}, skill.name))
					}),
					candidates.length > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-toolbar",
						style: { marginTop: "10px" },
						children: (0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: "可安装的候选技能"
						})
					}), (0, react_jsx_runtime.jsx)("div", {
						className: "dshx-rows",
						children: candidates.map((candidate) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: [candidate.name, (0, react_jsx_runtime.jsx)("span", {
										className: "dshx-badge",
										children: candidate.source
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									children: candidate.description || candidate.path
								})]
							}), (0, react_jsx_runtime.jsx)(RowActions, { children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: busy === candidate.name,
								onClick: () => {
									installByPath(candidate.path, candidate.name);
								},
								children: busy === candidate.name ? "安装中…" : "安装"
							}) })]
						}, candidate.name))
					})] }),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: importOpen,
						onClose: () => {
							if (busy === "") setImportOpen(false);
						},
						title: "从本地目录导入技能",
						closeLabel: "关闭",
						description: "填写包含 SKILL.md 的目录的绝对路径。",
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy !== "",
							onClick: () => {
								setImportOpen(false);
							},
							children: "取消"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy !== "" || importPath.trim() === "",
							onClick: () => {
								installByPath(importPath.trim(), "__import__");
							},
							children: busy === "__import__" ? "导入中…" : "导入"
						})] }),
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-field",
							children: [
								(0, react_jsx_runtime.jsx)("label", { children: "技能目录路径" }),
								(0, react_jsx_runtime.jsx)("input", {
									value: importPath,
									spellCheck: false,
									placeholder: "C:\\\\skills\\\\my-skill",
									onChange: (event) => {
										setImportPath(event.target.value);
									}
								}),
								importError !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
									kind: "error",
									children: importError
								})
							]
						})
					})
				]
			});
		}
		function emptySubagentDraft() {
			return {
				name: "",
				provider: "codex",
				toolName: "",
				persona: ""
			};
		}
		function SubagentsSection() {
			const [rows, setRows] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)("");
			const [formError, setFormError] = (0, react.useState)("");
			const reload = (0, react.useCallback)(() => {
				api$1("/subagents").then((data) => {
					if (data.error !== void 0) throw new Error(data.error);
					setRows(data.subagents ?? []);
					setError("");
				}).catch((err) => {
					setError(err.message);
				});
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const submit = () => {
				if (draft === null) return;
				setBusy("__create__");
				setFormError("");
				postJson$1("/subagents", draft).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					setDraft(null);
					reload();
				}).catch((err) => {
					setFormError(err.message);
				}).finally(() => {
					setBusy("");
				});
			};
			const setEnabled = (row, enabled) => {
				setBusy(row.id);
				postJson$1("/subagents/set-enabled", {
					id: row.id,
					enabled
				}).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					reload();
				}).catch((err) => {
					setError(err.message);
				}).finally(() => {
					setBusy("");
				});
			};
			const remove = (row) => {
				setBusy(row.id);
				fetch(`${apiBase$1()}/subagents?id=${encodeURIComponent(row.id)}`, { method: "DELETE" }).then(() => {
					reload();
				}).catch(() => {}).finally(() => {
					setBusy("");
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-toolbar",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: rows === null ? "" : `${rows.length} 个委派行`
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => {
								setFormError("");
								setDraft(emptySubagentDraft());
							},
							children: "新建子智能体"
						})]
					}),
					error !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
						kind: "error",
						children: `加载失败：${error}`
					}),
					rows !== null && rows.length === 0 && (0, react_jsx_runtime.jsx)(Msg$1, { children: "暂无子智能体。点击右上角「新建子智能体」添加一个。" }),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-rows",
						children: (rows ?? []).map((row) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: [
										row.toolName !== "" ? row.toolName : row.id,
										(0, react_jsx_runtime.jsx)("span", {
											className: "dshx-badge",
											children: row.provider
										}),
										row.root === "user" && (0, react_jsx_runtime.jsx)("span", {
											className: "dshx-badge",
											children: "自定义"
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: "dshx-badge",
											"data-on": String(row.enabled),
											children: row.enabled ? "启用" : "停用"
										})
									]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									children: `预设：${row.preset} · ${row.id}`
								})]
							}), (0, react_jsx_runtime.jsx)(RowActions, { children: row.root === "user" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								disabled: busy === row.id,
								onClick: () => {
									setEnabled(row, !row.enabled);
								},
								children: busy === row.id ? "…" : row.enabled ? "停用" : "启用"
							}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								disabled: busy === row.id,
								onClick: () => {
									remove(row);
								},
								children: busy === row.id ? "…" : "删除"
							})] }) })]
						}, `${row.preset}/${row.id}`))
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: draft !== null,
						onClose: () => {
							if (busy === "") setDraft(null);
						},
						title: "新建子智能体",
						closeLabel: "关闭",
						description: "创建后写入 ~/.dsh/.agent-presets，宿主重启后由内核预设清单自动发现。",
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy !== "",
							onClick: () => {
								setDraft(null);
							},
							children: "取消"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy !== "" || draft === null || draft.name.trim() === "",
							onClick: () => {
								submit();
							},
							children: busy === "__create__" ? "创建中…" : "创建"
						})] }),
						children: draft !== null && (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-grid",
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "名称" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.name,
										spellCheck: false,
										placeholder: "research-helper",
										onChange: (event) => {
											setDraft({
												...draft,
												name: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "提供方" }), (0, react_jsx_runtime.jsxs)("select", {
										value: draft.provider,
										onChange: (event) => {
											setDraft({
												...draft,
												provider: event.target.value === "claude-code" ? "claude-code" : "codex"
											});
										},
										children: [(0, react_jsx_runtime.jsx)("option", {
											value: "codex",
											children: "Codex"
										}), (0, react_jsx_runtime.jsx)("option", {
											value: "claude-code",
											children: "Claude Code"
										})]
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "工具名（选填，默认 subagent_<名称>）" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.toolName,
										spellCheck: false,
										placeholder: "subagent_research",
										onChange: (event) => {
											setDraft({
												...draft,
												toolName: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "人设说明" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.persona,
										spellCheck: false,
										placeholder: "You are a focused research helper.",
										onChange: (event) => {
											setDraft({
												...draft,
												persona: event.target.value
											});
										}
									})]
								}),
								formError !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
									kind: "error",
									children: formError
								})
							]
						})
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/Panels.js
		/**
		* Harness-extras panels: the commands / hooks / git settings sections and
		* the file + terminal shell overlays, all over the desktop shell's local
		* bridge API. Sections ride the `settings.section` slot (kernel chrome);
		* overlays ride `shell.overlay` (additive floating layer).
		*/
		/** Module-level workspace service binding (set once by the plugin's apply). */
		let workspaceService = null;
		/** Bind the kernel workspace service for the Git and Archive panels. */
		function bindWorkspaces(service) {
			workspaceService = service;
		}
		/** Read the bound service; a missing binding is a page-level error, not a crash. */
		function workspace() {
			return workspaceService;
		}
		/** Local bridge base URL (injected per page by the desktop shell). */
		const apiBase = () => globalThis.__DSH_MCP_API__ ?? "";
		/** One JSON round trip against the local bridge. */
		async function api(path, options) {
			return await (await fetch(apiBase() + path, options)).json();
		}
		async function postJson(path, body) {
			return await api(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
		}
		const STYLE_ID = "dshx-panels-style";
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
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.textContent = STYLE;
			document.head.appendChild(tag);
		}
		ensureStyle();
		function Msg({ children, kind }) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: "dshx-msg",
				"data-kind": kind,
				children
			});
		}
		function CommandsSection() {
			const [builtin, setBuiltin] = (0, react.useState)([]);
			const [commands, setCommands] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)("");
			const [formError, setFormError] = (0, react.useState)("");
			const reload = (0, react.useCallback)(() => {
				api("/commands").then((data) => {
					if (data.error !== void 0) throw new Error(data.error);
					setBuiltin(data.builtin ?? []);
					setCommands(data.commands ?? []);
					setError("");
				}).catch((err) => {
					setError(err.message);
				});
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const submit = () => {
				if (draft === null) return;
				setBusy("__create__");
				setFormError("");
				postJson("/commands", draft).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					setDraft(null);
					reload();
				}).catch((err) => {
					setFormError(err.message);
				}).finally(() => {
					setBusy("");
				});
			};
			const remove = (name) => {
				setBusy(name);
				fetch(`${apiBase()}/commands?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(() => {
					reload();
				}).catch(() => {}).finally(() => {
					setBusy("");
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-toolbar",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: commands === null ? "" : `内置 ${builtin.length} · 自定义 ${commands.length} · 会话内 /名称 触发`
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => {
								setFormError("");
								setDraft({
									name: "",
									description: "",
									template: ""
								});
							},
							children: "新建命令"
						})]
					}),
					error !== "" && (0, react_jsx_runtime.jsx)(Msg, {
						kind: "error",
						children: `加载失败：${error}`
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-toolbar",
						style: { marginTop: "8px" },
						children: (0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: "内置命令"
						})
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-rows",
						children: builtin.map((cmd) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: ["/", cmd.name]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									children: cmd.description
								})]
							}), (0, react_jsx_runtime.jsx)("div", {
								className: "dshx-actions",
								children: (0, react_jsx_runtime.jsx)("span", {
									className: "dshx-badge",
									children: "内置"
								})
							})]
						}, cmd.name))
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-toolbar",
						style: { marginTop: "10px" },
						children: (0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: "自定义命令"
						})
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-rows",
						children: [(commands ?? []).map((cmd) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: ["/", cmd.name]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									children: cmd.description
								})]
							}), (0, react_jsx_runtime.jsx)("div", {
								className: "dshx-actions",
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: busy === cmd.name,
									onClick: () => {
										remove(cmd.name);
									},
									children: busy === cmd.name ? "删除中…" : "删除"
								})
							})]
						}, cmd.name)), commands !== null && commands.length === 0 && (0, react_jsx_runtime.jsx)(Msg, { children: "暂无自定义命令。" })]
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: draft !== null,
						onClose: () => {
							if (busy === "") setDraft(null);
						},
						title: "新建命令",
						closeLabel: "关闭",
						description: "命令是一个 prompt 模板，保存后会话内输入 /名称 触发。",
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy !== "",
							onClick: () => {
								setDraft(null);
							},
							children: "取消"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy !== "" || draft === null || draft.name.trim() === "" || draft.template.trim() === "",
							onClick: () => {
								submit();
							},
							children: busy === "__create__" ? "创建中…" : "创建"
						})] }),
						children: draft !== null && (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-grid",
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "名称（/名称 触发）" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.name,
										spellCheck: false,
										placeholder: "daily-report",
										onChange: (event) => {
											setDraft({
												...draft,
												name: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "描述" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.description,
										placeholder: "生成每日报告",
										onChange: (event) => {
											setDraft({
												...draft,
												description: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "命令模板（prompt 正文）" }), (0, react_jsx_runtime.jsx)("textarea", {
										className: "dshx-pre",
										style: {
											maxHeight: "160px",
											background: "transparent",
											color: "inherit"
										},
										value: draft.template,
										spellCheck: false,
										placeholder: "总结当前目录下今天的改动并生成日报…",
										onChange: (event) => {
											setDraft({
												...draft,
												template: event.target.value
											});
										}
									})]
								}),
								formError !== "" && (0, react_jsx_runtime.jsx)(Msg, {
									kind: "error",
									children: formError
								})
							]
						})
					})
				]
			});
		}
		function HooksSection() {
			const [hooks, setHooks] = (0, react.useState)(null);
			const [events, setEvents] = (0, react.useState)([]);
			const [error, setError] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)("");
			const [formError, setFormError] = (0, react.useState)("");
			const reload = (0, react.useCallback)(() => {
				api("/hooks").then((data) => {
					if (data.error !== void 0) throw new Error(data.error);
					setHooks(data.hooks ?? []);
					setEvents(data.events ?? []);
					setError("");
				}).catch((err) => {
					setError(err.message);
				});
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const apply = (promise, after) => {
				promise.then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					if (after !== void 0) after();
					reload();
				}).catch((err) => {
					setError(err.message);
				}).finally(() => {
					setBusy("");
				});
			};
			const submit = () => {
				if (draft === null) return;
				setBusy("__create__");
				setFormError("");
				apply(postJson("/hooks", {
					event: draft.event,
					matcher: draft.matcher,
					command: draft.command,
					timeout: draft.timeout.trim() === "" ? void 0 : Number(draft.timeout)
				}), () => {
					setDraft(null);
				});
			};
			const grouped = /* @__PURE__ */ new Map();
			for (const hook of hooks ?? []) {
				const list = grouped.get(hook.event) ?? [];
				list.push(hook);
				grouped.set(hook.event, list);
			}
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-toolbar",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: hooks === null ? "" : `${hooks.length} 个钩子 · 写入 ~/.dsh/hooks.json`
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							onClick: () => {
								setFormError("");
								setDraft({
									event: events[0] ?? "PreToolUse",
									matcher: "",
									command: "",
									timeout: ""
								});
							},
							children: "新建钩子"
						})]
					}),
					error !== "" && (0, react_jsx_runtime.jsx)(Msg, {
						kind: "error",
						children: `加载失败：${error}`
					}),
					hooks !== null && hooks.length === 0 && (0, react_jsx_runtime.jsx)(Msg, { children: "暂无钩子。钩子在会话生命周期的对应事件点执行 shell 命令。" }),
					[...grouped.entries()].map(([event, rows]) => (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-toolbar",
						style: { marginTop: "8px" },
						children: (0, react_jsx_runtime.jsxs)("span", {
							className: "dshx-count",
							children: [
								event,
								" ",
								(0, react_jsx_runtime.jsx)("span", {
									style: { opacity: .7 },
									children: rows.length
								})
							]
						})
					}), (0, react_jsx_runtime.jsx)("div", {
						className: "dshx-rows",
						children: rows.map((hook) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-row",
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row-main",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-title",
									children: [hook.matcher !== "" ? hook.matcher : "全部工具", (0, react_jsx_runtime.jsx)("span", {
										className: "dshx-badge",
										"data-on": String(!hook.disabled),
										children: hook.disabled ? "停用" : "启用"
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-row-desc",
									style: { whiteSpace: "normal" },
									children: hook.command
								})]
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-actions",
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: busy === hook.id,
									onClick: () => {
										setBusy(hook.id);
										apply(postJson("/hooks/set-enabled", {
											id: hook.id,
											enabled: hook.disabled
										}));
									},
									children: busy === hook.id ? "…" : hook.disabled ? "启用" : "停用"
								}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: busy === hook.id,
									onClick: () => {
										setBusy(hook.id);
										apply(fetch(`${apiBase()}/hooks?id=${encodeURIComponent(hook.id)}`, { method: "DELETE" }).then((r) => r.json()));
									},
									children: busy === hook.id ? "…" : "删除"
								})]
							})]
						}, hook.id))
					})] }, event)),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: draft !== null,
						onClose: () => {
							if (busy === "") setDraft(null);
						},
						title: "新建钩子",
						closeLabel: "关闭",
						description: "在会话生命周期的对应事件点执行 shell 命令。",
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy !== "",
							onClick: () => {
								setDraft(null);
							},
							children: "取消"
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy !== "" || draft === null || draft.command.trim() === "",
							onClick: () => {
								submit();
							},
							children: busy === "__create__" ? "创建中…" : "创建"
						})] }),
						children: draft !== null && (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-grid",
							children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "生命周期事件" }), (0, react_jsx_runtime.jsx)("select", {
										value: draft.event,
										onChange: (event) => {
											setDraft({
												...draft,
												event: event.target.value
											});
										},
										children: events.map((name) => (0, react_jsx_runtime.jsx)("option", {
											value: name,
											children: name
										}, name))
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "匹配器（选填，如 Bash）" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.matcher,
										spellCheck: false,
										placeholder: "留空匹配全部",
										onChange: (event) => {
											setDraft({
												...draft,
												matcher: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field dshx-full",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "要执行的命令" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.command,
										spellCheck: false,
										placeholder: "node C:/hooks/notify.js",
										onChange: (event) => {
											setDraft({
												...draft,
												command: event.target.value
											});
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-field",
									children: [(0, react_jsx_runtime.jsx)("label", { children: "超时（毫秒，选填）" }), (0, react_jsx_runtime.jsx)("input", {
										value: draft.timeout,
										spellCheck: false,
										placeholder: "60000",
										onChange: (event) => {
											setDraft({
												...draft,
												timeout: event.target.value.replace(/\D/g, "")
											});
										}
									})]
								}),
								formError !== "" && (0, react_jsx_runtime.jsx)(Msg, {
									kind: "error",
									children: formError
								})
							]
						})
					})
				]
			});
		}
		function GitSection() {
			const workspaces = workspace();
			const [items, setItems] = (0, react.useState)([]);
			const [selected, setSelected] = (0, react.useState)("");
			const [info, setInfo] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [action, setAction] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const [checked, setChecked] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [message, setMessage] = (0, react.useState)("");
			const loadInfo = (0, react.useCallback)((target) => {
				if (target === "") {
					setInfo(null);
					return;
				}
				setLoading(true);
				api(`/git?path=${encodeURIComponent(target)}`).then((result) => {
					setInfo(result);
					setChecked(/* @__PURE__ */ new Set());
					setNotice("");
				}).catch((err) => {
					setInfo({ error: err.message });
				}).finally(() => {
					setLoading(false);
				});
			}, []);
			(0, react.useEffect)(() => {
				if (workspaces === null) return;
				const read = () => {
					const rows = workspaces.list.getSnapshot().items.map((row) => ({
						workspaceId: row.workspaceId,
						path: row.path,
						title: row.title
					}));
					setItems(rows);
					setSelected((previous) => previous !== "" ? previous : rows[0]?.path ?? "");
				};
				read();
				return workspaces.list.subscribe(read);
			}, [workspaces]);
			(0, react.useEffect)(() => {
				loadInfo(selected);
			}, [selected, loadInfo]);
			const runAction = (kind, extra) => {
				if (selected === "" || action !== "") return;
				setAction(kind);
				setNotice("");
				postJson(kind === "commit" ? "/git/commit" : `/git/${kind}`, {
					path: selected,
					...extra
				}).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					const output = result.output;
					setNotice(output !== void 0 && output !== "" ? output : "完成");
					if (kind === "commit") {
						setMessage("");
						setChecked(/* @__PURE__ */ new Set());
					}
					loadInfo(selected);
				}).catch((err) => {
					setNotice(`失败：${err.message}`);
				}).finally(() => {
					setAction("");
				});
			};
			const toggle = (file) => {
				setChecked((previous) => {
					const next = new Set(previous);
					if (next.has(file)) next.delete(file);
					else next.add(file);
					return next;
				});
			};
			const changes = info?.changes ?? [];
			const allChecked = changes.length > 0 && changes.every((change) => checked.has(change.file));
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-toolbar",
						children: [(0, react_jsx_runtime.jsxs)("select", {
							className: "dshx-input",
							style: { flex: 1 },
							value: selected,
							onChange: (event) => {
								setSelected(event.target.value);
							},
							children: [items.length === 0 && (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "（尚未注册工作区）"
							}), items.map((row) => (0, react_jsx_runtime.jsx)("option", {
								value: row.path,
								children: row.title
							}, row.workspaceId))]
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: loading || selected === "",
							onClick: () => {
								loadInfo(selected);
							},
							children: loading ? "刷新中…" : "刷新"
						})]
					}),
					info !== null && info.error !== void 0 && info.error !== "" && (0, react_jsx_runtime.jsx)(Msg, {
						kind: "error",
						children: info.error
					}),
					info !== null && info.branch !== void 0 && info.branch !== "" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-toolbar",
							style: {
								marginTop: "4px",
								alignItems: "center"
							},
							children: [(0, react_jsx_runtime.jsxs)("span", {
								className: "dshx-row-title",
								style: {
									fontSize: "13px",
									whiteSpace: "nowrap"
								},
								children: ["当前分支 ", (0, react_jsx_runtime.jsx)("span", {
									className: "dshx-code",
									children: info.branch
								})]
							}), (0, react_jsx_runtime.jsxs)("span", {
								className: "dshx-actions",
								children: [
									(0, react_jsx_runtime.jsxs)("select", {
										className: "dshx-input",
										style: {
											height: "28px",
											fontSize: "12px"
										},
										value: "",
										onChange: (event) => {
											if (event.target.value !== "") runAction("checkout", { branch: event.target.value });
										},
										children: [(0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "切换分支…"
										}), (info.branches ?? []).filter((branch) => branch !== info.branch).map((branch) => (0, react_jsx_runtime.jsx)("option", {
											value: branch,
											children: branch
										}, branch))]
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										disabled: action !== "",
										onClick: () => {
											runAction("pull");
										},
										children: action === "pull" ? "更新中…" : "更新项目"
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										disabled: action !== "",
										onClick: () => {
											runAction("push");
										},
										children: action === "push" ? "推送中…" : "推送项目"
									})
								]
							})]
						}),
						notice !== "" && (0, react_jsx_runtime.jsx)(Msg, { children: notice }),
						(0, react_jsx_runtime.jsx)("div", {
							className: "dshx-toolbar",
							style: { marginTop: "8px" },
							children: (0, react_jsx_runtime.jsx)("span", {
								className: "dshx-count",
								children: (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: "6px",
										cursor: "pointer"
									},
									children: [
										(0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: allChecked,
											onChange: (event) => {
												setChecked(event.target.checked ? new Set(changes.map((change) => change.file)) : /* @__PURE__ */ new Set());
											}
										}),
										"工作区改动 ",
										changes.length,
										" 个"
									]
								})
							})
						}),
						(0, react_jsx_runtime.jsxs)("div", { children: [changes.map((change) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-git-item",
							children: [
								(0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: checked.has(change.file),
									onChange: () => {
										toggle(change.file);
									}
								}),
								(0, react_jsx_runtime.jsx)("span", {
									className: "dshx-code",
									children: change.code || "M"
								}),
								(0, react_jsx_runtime.jsx)("span", { children: change.file })
							]
						}, change.file)), changes.length === 0 && (0, react_jsx_runtime.jsx)(Msg, { children: "工作区干净。" })] }),
						(0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-toolbar",
							style: { marginTop: "8px" },
							children: [(0, react_jsx_runtime.jsx)("input", {
								className: "dshx-input",
								style: { flex: 1 },
								value: message,
								spellCheck: false,
								placeholder: "提交信息（先勾选要提交的文件）",
								onChange: (event) => {
									setMessage(event.target.value);
								},
								onKeyDown: (event) => {
									if (event.key === "Enter" && checked.size > 0 && message.trim() !== "") runAction("commit", {
										files: [...checked],
										message
									});
								}
							}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: action !== "" || checked.size === 0 || message.trim() === "",
								onClick: () => {
									runAction("commit", {
										files: [...checked],
										message
									});
								},
								children: action === "commit" ? "提交中…" : `提交选中 (${checked.size})`
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: "dshx-toolbar",
							style: { marginTop: "10px" },
							children: (0, react_jsx_runtime.jsx)("span", {
								className: "dshx-count",
								children: "最近提交"
							})
						}),
						(0, react_jsx_runtime.jsx)("div", { children: (info.log ?? []).map((line) => (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-git-item",
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: "dshx-code",
								children: line.slice(0, 7)
							}), (0, react_jsx_runtime.jsx)("span", { children: line.slice(8) })]
						}, line)) })
					] })
				]
			});
		}
		/**
		* Code-index settings: the codegraph MCP server carries the repository
		* index. The master switch toggles the server itself (restart to apply);
		* the two granular toggles ride its env contract.
		*/
		function IndexSection() {
			const [server, setServer] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const reload = (0, react.useCallback)(() => {
				api("/mcp").then((data) => {
					if (data.error !== void 0) throw new Error(data.error);
					const found = (data.servers ?? []).find((entry) => entry.name === "codegraph") ?? null;
					setServer(found);
					setError(found === null ? "未检测到 codegraph MCP 服务器（在 MCP 服务器页添加后可用）" : "");
				}).catch((err) => {
					setError(err.message);
				});
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			const patch = (mutate) => {
				if (server === null || busy) return;
				setBusy(true);
				const next = {
					...server,
					env: { ...server.env ?? {} }
				};
				mutate(next);
				api("/mcp").then((data) => {
					const original = (data.servers ?? []).find((entry) => entry.name === "codegraph");
					if (original === void 0) throw new Error("codegraph 服务器不存在");
					return postJson("/mcp", {
						name: original.name,
						transport: "stdio",
						enabled: next.enabled,
						command: original.command,
						args: original.args ?? [],
						env: next.env
					});
				}).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					reload();
				}).catch((err) => {
					setError(err.message);
				}).finally(() => {
					setBusy(false);
				});
			};
			const envOn = (key) => server?.env?.[key] === "1";
			if (server === null && error === "") return (0, react_jsx_runtime.jsx)("div", {
				className: "dshx-wrap",
				children: (0, react_jsx_runtime.jsx)(Msg, { children: "加载中…" })
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-wrap",
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-toolbar",
						children: (0, react_jsx_runtime.jsx)("span", {
							className: "dshx-count",
							children: "代码库索引（codegraph）"
						})
					}),
					error !== "" && (0, react_jsx_runtime.jsx)(Msg, {
						kind: "error",
						children: error
					}),
					server !== null && (0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-rows",
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-main",
									children: [(0, react_jsx_runtime.jsx)("div", {
										className: "dshx-row-title",
										children: "启用 codegraph 索引服务"
									}), (0, react_jsx_runtime.jsx)("div", {
										className: "dshx-row-desc",
										children: "关闭后模型不再获得代码库索引工具。保存后自动重启生效。"
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-actions",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										disabled: busy,
										onClick: () => {
											patch((entry) => {
												entry.enabled = !entry.enabled;
											});
										},
										children: server.enabled ? "停用" : "启用"
									})
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-main",
									children: [(0, react_jsx_runtime.jsx)("div", {
										className: "dshx-row-title",
										children: "自动索引新文件夹"
									}), (0, react_jsx_runtime.jsx)("div", {
										className: "dshx-row-desc",
										children: "自动索引文件数少于 50,000 的新文件夹。"
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-actions",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										disabled: busy,
										onClick: () => {
											patch((entry) => {
												entry.env = {
													...entry.env ?? {},
													CODEGRAPH_AUTO_INDEX: envOn("CODEGRAPH_AUTO_INDEX") ? "0" : "1"
												};
											});
										},
										children: envOn("CODEGRAPH_AUTO_INDEX") ? "关闭" : "开启"
									})
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "dshx-row",
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: "dshx-row-main",
									children: [(0, react_jsx_runtime.jsx)("div", {
										className: "dshx-row-title",
										children: "索引存储库以实现即时搜索（测试版）"
									}), (0, react_jsx_runtime.jsx)("div", {
										className: "dshx-row-desc",
										children: "自动对仓库进行索引，以加快 Grep 搜索速度。所有数据均存储在本地。"
									})]
								}), (0, react_jsx_runtime.jsx)("div", {
									className: "dshx-actions",
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										disabled: busy,
										onClick: () => {
											patch((entry) => {
												entry.env = {
													...entry.env ?? {},
													CODEGRAPH_INDEX_REPOS: envOn("CODEGRAPH_INDEX_REPOS") ? "0" : "1"
												};
											});
										},
										children: envOn("CODEGRAPH_INDEX_REPOS") ? "关闭" : "开启"
									})
								})]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/**
		* Harness-extras surface plugin, browser half: registers the desktop-shell
		* settings sections (MCP servers / skills / subagents / commands / hooks /
		* git) that render management lists over the local bridge API, plus the
		* file-explorer and terminal overlays. Sections ride the standard
		* `settings.section` slot — the kernel's settings shell owns the nav rows,
		* the selection animation, and the content chrome — and the overlays ride
		* `shell.overlay`, so this package contributes bodies only, never chrome.
		*/
		/** Required services: slots for registration, workspaces for Git/Archive pages. */
		const inject = [
			"slots",
			"workspaces",
			"sessions"
		];
		/** Nav order: after the kernel's own sections (general 0 / models 10 / presets 20). */
		const ORDER_MCP = 30;
		const ORDER_SKILLS = 40;
		const ORDER_SUBAGENTS = 50;
		const ORDER_COMMANDS = 60;
		const ORDER_HOOKS = 70;
		const ORDER_GIT = 80;
		const ORDER_INDEX = 90;
		/**
		* Client plugin body: register the management sections and the two overlays
		* once per slot generation.
		* @param ctx - client root context.
		*/
		/**
		* New-session hero branch seat: a compact git chip rendered beside the
		* agent-preset seat. Operates on the harness's primary workspace (the
		* first registry row) over the desktop bridge API — switch branch,
		* create-and-checkout, and the git graph.
		*/
		/**
		* Compute a gitk-style lane layout over commits (newest first, as git
		* log returns them). Each commit occupies one lane; vertical bars show
		* where other branches run past a row, and ┘ marks where a branch
		* merges into the row's commit.
		*/
		function layoutGraph(commits) {
			const colors = ["#e5a13a", "#2da44e", "#0969da", "#8250df", "#bf8700", "#1b7c83", "#e16f24", "#8957e5"];
			const rowOf = new Map(commits.map((c, i) => [c.hash, i]));
			const lanes = [];
			const segs = [];
			const rows = commits.map(() => ({ dot: { col: -1, color: "" }, bars: [], merges: [] }));
			for (let r = 0; r < commits.length; r++) {
				const c = commits[r];
				let idx = lanes.findIndex((l) => l.tip === c.hash);
				if (idx === -1) {
					idx = lanes.length;
					lanes.push({ tip: c.hash, color: colors[lanes.length % colors.length] });
					segs.push([]);
				}
				rows[r].dot = { col: idx, color: lanes[idx].color };
				// Other lanes whose current segment spans this row pass through.
				for (let j = 0; j < lanes.length; j++) {
					if (j === idx) continue;
					if (lanes[j].tip === c.hash) {
						rows[r].merges.push({ col: j, color: lanes[j].color });
						continue;
					}
					const s = segs[j][segs[j].length - 1];
					if (s !== void 0 && s.start < r && s.end > r) rows[r].bars.push({ col: j, color: lanes[j].color });
				}
				if (c.parents.length > 0) {
					const cur = segs[idx][segs[idx].length - 1];
					if (cur !== void 0) cur.end = r;
					lanes[idx].tip = c.parents[0];
					segs[idx].push({ start: r, end: rowOf.get(c.parents[0]) ?? r + 1 });
					for (const p of c.parents.slice(1)) {
						const j = lanes.length;
						lanes.push({ tip: p, color: colors[j % colors.length] });
						segs.push([{ start: r, end: rowOf.get(p) ?? r + 1 }]);
						rows[r].merges.push({ col: j, color: colors[j % colors.length] });
					}
				}
			}
			return { rows, segs };
		}
		/**
		* Split a `--decorate` refs string into [label, kind] pills.
		* kind drives the pill color: head (current), branch (local), remote,
		* tag.
		*/
		function splitRefs(refs) {
			if (typeof refs !== "string" || refs === "") return [];
			const out = [];
			for (const raw of refs.split(",")) {
				const s = raw.trim();
				if (s === "") continue;
				// `HEAD -> master` splits into a HEAD pill + a master pill.
				const arrow = s.indexOf("->");
				if (arrow !== -1) {
					const head = s.slice(0, arrow).trim();
					const rest = s.slice(arrow + 2).trim();
					if (head !== "") out.push({ label: head, kind: "head" });
					for (const part of rest.split(" ")) {
						if (part === "") continue;
						out.push({ label: part, kind: /^origin\//.test(part) ? "remote" : "branch" });
					}
					continue;
				}
				let label = s;
				let kind = "remote";
				if (/^tag:/.test(s)) {
					kind = "tag";
					label = s.slice(4);
				} else if (!/^origin\//.test(s)) kind = "branch";
				out.push({ label, kind });
			}
			return out;
		}
		/**
		* Git 图谱: table layout matching the reference design — a 图 (lane
		* graph) column, a 描述 column (ref pills + subject), then 日期 / 作者 /
		* 提交 columns. Lanes are drawn as continuous colored bars with merge
		* joins, computed over the structured /git/graph payload.
		*/
		function GitGraph({ commits }) {
			const { rows, segs } = layoutGraph(commits);
			let maxCol = 0;
			for (const row of rows) {
				if (row.dot.col > maxCol) maxCol = row.dot.col;
				for (const b of row.bars) if (b.col > maxCol) maxCol = b.col;
				for (const m of row.merges) if (m.col > maxCol) maxCol = m.col;
			}
			const colors = ["#e5a13a", "#2da44e", "#0969da", "#8250df", "#bf8700", "#1b7c83", "#e16f24", "#8957e5"];
			const cols = Math.max(1, Math.min(maxCol + 1, 12));
			const COL_W = 12;
			const ROW_H = 26;
			const xc = (c) => c * COL_W + COL_W / 2;
			const rightCols = "minmax(0,1fr) 112px 70px 80px";
			const chainW = cols * COL_W;
			const chainH = rows.length * ROW_H;
			const middleY = (r) => r * ROW_H + ROW_H / 2;
			// Build one continuous SVG: each lane is a full-height vertical line
			// spanning its active rows (adjacent segments join seamlessly), the
			// commits are small node dots on the line, and merges sweep smoothly
			// from a side lane into the target lane. Rendering the whole graph in
			// a single <svg> keeps the lines genuinely continuous, unlike the
			// per-row segments that showed visible seams.
			const elems = [];
			const TRUNK_X = xc(0);
			const BRANCH_X = TRUNK_X + 12;
			const BRANCH_COLOR = "#0969da";
			// Main trunk: one continuous vertical orange line across every active
			// row.
			for (const seg of segs[0]) {
				const y1 = seg.start * ROW_H;
				const y2 = Math.min(seg.end, rows.length) * ROW_H;
				if (y2 <= y1) continue;
				elems.push((0, react_jsx_runtime.jsx)("line", {
					x1: TRUNK_X, y1, x2: TRUNK_X, y2, stroke: colors[0], strokeWidth: 1.5
				}, "trunk" + seg.start));
			}
			// Branch merges: a single smooth blue Bézier arc from the upstream
			// trunk node down to the downstream trunk node (VSCode Git Graph
			// style) — not a parallel vertical lane.
			for (let j = 1; j < segs.length; j++) {
				for (const seg of segs[j]) {
					const yTop = seg.start * ROW_H + ROW_H / 2;
					const yBot = Math.min(seg.end, rows.length) * ROW_H + ROW_H / 2;
					if (yBot <= yTop) continue;
					elems.push((0, react_jsx_runtime.jsx)("path", {
						d: `M ${TRUNK_X} ${yTop} C ${BRANCH_X} ${yTop}, ${BRANCH_X} ${yBot}, ${TRUNK_X} ${yBot}`,
						fill: "none", stroke: BRANCH_COLOR, strokeWidth: 1.5
					}, "arc" + j + "-" + seg.start));
				}
			}
			// Node dots: trunk commits on the orange line, branch commits on the
			// blue arc.
			for (let r = 0; r < rows.length; r++) {
				const y = middleY(r);
				const onTrunk = rows[r].dot.col === 0;
				elems.push((0, react_jsx_runtime.jsx)("circle", {
					cx: onTrunk ? TRUNK_X : BRANCH_X, cy: y, r: 2.5,
					fill: onTrunk ? colors[0] : BRANCH_COLOR
				}, "dot" + r));
			}
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "dshx-graph",
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-graph-head",
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: "dshx-graph-th dshx-graph-th-graph",
							style: { width: chainW },
							children: "图"
						}), (0, react_jsx_runtime.jsxs)("span", {
							className: "dshx-graph-head-cols",
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: "dshx-graph-th dshx-graph-th-desc",
								children: "描述"
							}), (0, react_jsx_runtime.jsx)("span", {
								className: "dshx-graph-th dshx-graph-th-date",
								children: "日期"
							}), (0, react_jsx_runtime.jsx)("span", {
								className: "dshx-graph-th dshx-graph-th-author",
								children: "作者"
							}), (0, react_jsx_runtime.jsx)("span", {
								className: "dshx-graph-th dshx-graph-th-hash",
								children: "提交"
							})]
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "dshx-graph-body",
						children: [
							(0, react_jsx_runtime.jsx)("svg", {
								className: "dshx-graph-lanes",
								width: chainW,
								height: chainH,
								children: elems
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: "dshx-graph-rows",
								children: commits.map((c, i) => {
									const pills = splitRefs(c.refs);
									return (0, react_jsx_runtime.jsxs)("div", {
										className: "dshx-graph-row",
										children: [
											(0, react_jsx_runtime.jsxs)("span", {
												className: "dshx-graph-desc",
												children: [
													pills.map((p) => (0, react_jsx_runtime.jsx)("span", {
														className: "dshx-graph-pill",
														"data-kind": p.kind,
														children: p.label
													}, p.label + p.kind)),
													(0, react_jsx_runtime.jsx)("span", {
														className: "dshx-graph-subject",
														children: c.subject
													})
												]
											}),
											(0, react_jsx_runtime.jsx)("span", {
												className: "dshx-graph-date",
												children: c.date
											}),
											(0, react_jsx_runtime.jsx)("span", {
												className: "dshx-graph-author",
												children: c.author
											}),
											(0, react_jsx_runtime.jsx)("span", {
												className: "dshx-graph-hash",
												children: c.short
											})
										]
									}, c.hash);
								})
							})
						]
					})
				]
			});
		}
		function GitBranchSeat() {
			const workspaces = workspace();
			const [info, setInfo] = (0, react.useState)(null);
			const [open, setOpen] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)("");
			const [creating, setCreating] = (0, react.useState)(false);
			const [newName, setNewName] = (0, react.useState)("");
			const [creatingError, setCreatingError] = (0, react.useState)("");
			const [graphOpen, setGraphOpen] = (0, react.useState)(false);
			const [graphData, setGraphData] = (0, react.useState)(null);
			const [graphError, setGraphError] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)("");
			const path = (() => {
				const items = workspaces?.list?.getSnapshot()?.items ?? [];
				return items[0]?.path ?? "";
			})();
			(0, react.useEffect)(() => {
				if (path === "") {
					setInfo(null);
					return;
				}
				let dead = false;
				api(`/git?path=${encodeURIComponent(path)}`).then((result) => {
					if (!dead) {
						setInfo(result);
						setNotice("");
					}
				}).catch(() => {
					if (!dead) setInfo({ error: "git 读取失败" });
				});
				return () => {
					dead = true;
				};
			}, [path]);
			(0, react.useEffect)(() => {
				if (notice === "") return;
				const timer = setTimeout(() => setNotice(""), 3000);
				return () => clearTimeout(timer);
			}, [notice]);
			const refreshInfo = () => {
				api(`/git?path=${encodeURIComponent(path)}`).then(setInfo).catch(() => {});
			};
			const checkout = (branch, create) => {
				setBusy(create ? "create" : "checkout");
				postJson("/git/checkout", { path, branch, create: create === true }).then((result) => {
					if (result.error !== void 0 && result.error !== "") throw new Error(result.error);
					setOpen(false);
					setCreating(false);
					setNewName("");
					setCreatingError("");
					refreshInfo();
					setNotice(`已切换到 ${branch}`);
				}).catch((err) => {
					if (create) setCreatingError(err.message);
					else setNotice(`失败：${err.message}`);
				}).finally(() => {
					setBusy("");
				});
			};
			const openGraph = () => {
				setGraphOpen(true);
				setGraphData(null);
				setGraphError("");
				api(`/git/graph?path=${encodeURIComponent(path)}`).then((result) => {
					if (result?.error !== void 0 && result.error !== "") setGraphError(result.error);
					else setGraphData(result);
				}).catch(() => setGraphError("图谱读取失败"));
			};
			const submitCreate = () => {
				const name = newName.trim();
				if (name === "") {
					setCreatingError("请输入分支名");
					return;
				}
				checkout(name, true);
			};
			if (path === "" || info === null || info.error !== void 0) return null;
			const branches = (info.branches ?? []).filter((branch) => branch !== info.branch);
			const items = [
				...branches.map((branch) => ({ id: "b:" + branch, label: branch })),
				{ id: "__create", label: "创建并检出新分支…" },
				{ id: "__graph", label: "Git 图谱" }
			];
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: "dshx-hero-git",
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
							open,
							onClose: () => setOpen(false),
							items,
							onSelect: (id) => {
								if (id === "__create") {
									setCreating(true);
									setOpen(false);
									return;
								}
								if (id === "__graph") {
									openGraph();
									setOpen(false);
									return;
								}
								if (id.startsWith("b:")) checkout(id.slice(2), false);
							},
							align: "end",
							portal: true,
							anchor: (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dshx-hero-chip",
								"aria-haspopup": "menu",
								"aria-expanded": open,
								disabled: busy !== "",
								title: path,
								onClick: () => setOpen(!open),
									children: [
										(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {
											className: "dshx-hero-chip-icon"
										}),
										(0, react_jsx_runtime.jsx)("span", {
											children: info.branch
										}),
										(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
									]
							})
						})
					}),
					notice !== "" && (0, react_jsx_runtime.jsx)("span", {
						className: "dshx-hero-notice",
						children: notice
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: creating,
						onClose: () => {
							if (busy !== "create") setCreating(false);
						},
						title: "创建并检出新分支",
						closeLabel: "关闭",
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								disabled: busy !== "",
								onClick: () => setCreating(false),
								children: "取消"
							}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								disabled: busy !== "",
								onClick: submitCreate,
								children: busy === "create" ? "创建中…" : "创建并检出"
							})]
						}),
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: "dshx-field",
							children: [(0, react_jsx_runtime.jsx)("input", {
								value: newName,
								spellCheck: false,
								placeholder: "feature/my-branch",
								autoFocus: true,
								onChange: (event) => setNewName(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter") submitCreate();
								}
							}), creatingError !== "" && (0, react_jsx_runtime.jsx)(Msg$1, {
								kind: "error",
								children: creatingError
							})]
						})
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: graphOpen,
						onClose: () => setGraphOpen(false),
						title: "Git 图谱",
						closeLabel: "关闭",
						className: "dshx-graph-modal",
						children: graphError !== "" ? (0, react_jsx_runtime.jsx)(Msg$1, {
							kind: "error",
							children: graphError
						}) : graphData === null ? (0, react_jsx_runtime.jsx)(Msg$1, {
							children: "加载中…"
						}) : graphData.commits !== void 0 && graphData.commits.length > 0 ? (0, react_jsx_runtime.jsx)(GitGraph, {
							commits: graphData.commits
						}) : (0, react_jsx_runtime.jsx)("pre", {
							className: "dshx-hero-graph",
							children: graphData.graph ?? "（无数据）"
						})
					})
				]
			});
		}
		function apply(ctx) {
			bindWorkspaces(ctx.workspaces);
			ctx.sessions;
			ctx.slots.inject("conversation.hero.gitBranch", () => ctx.slots.register({
				name: "conversation.hero.gitBranch",
				id: "harness-git-branch",
				inject: () => ({})
			}, GitBranchSeat));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "harness-git-branch",
				order: 0,
				inject: () => ({})
			}, GitBranchSeat));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mcp-servers",
				order: ORDER_MCP,
				label: () => "MCP 服务器"
			}, McpSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skills",
				order: ORDER_SKILLS,
				label: () => "技能"
			}, SkillsSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "subagents",
				order: ORDER_SUBAGENTS,
				label: () => "子智能体"
			}, SubagentsSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "commands",
				order: ORDER_COMMANDS,
				label: () => "命令"
			}, CommandsSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "hooks",
				order: ORDER_HOOKS,
				label: () => "钩子"
			}, HooksSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "git",
				order: ORDER_GIT,
				label: () => "Git"
			}, GitSection));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "index",
				order: ORDER_INDEX,
				label: () => "索引库"
			}, IndexSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map