/**
 * git-ui.js — injected into the dsh web page by the desktop shell.
 *
 * Restores the alpha.2-style git experience on the alpha.3 kernel:
 *  - a hero branch chip (⎇ branch) next to the workspace selector;
 *  - a wide animated "Git 图谱" modal with branch switching, create-and-
 *    checkout, and a lane-graph table instead of the small plain panel.
 * Uses the desktop bridge API (window.__DSH_MCP_API__) for /git endpoints.
 */
(() => {
  if (globalThis.__dshGitUi) return
  globalThis.__dshGitUi = true

  const apiBase = () => (globalThis.__DSH_MCP_API__ || '')
  const api = (path, options) => fetch(apiBase() + path, options).then((r) => r.json())
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const GIT_UI_CSS = [
    '.dshx-gm-mask { position:fixed; inset:0; z-index:2147483100; background:rgba(15,18,28,.45);',
    '  display:flex; align-items:center; justify-content:center; animation:dshxGmFade .16s ease; }',
    '@keyframes dshxGmFade { from { opacity:0 } to { opacity:1 } }',
    '.dshx-gm { width:min(920px,96vw); max-height:86vh; display:flex; flex-direction:column;',
    '  background:var(--dsw-alias-bg-layer-2,#fff); border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.28));',
    '  border-radius:16px; box-shadow:0 24px 80px rgba(18,24,42,.35); overflow:hidden;',
    '  animation:dshxGmPop .18s cubic-bezier(.2,.9,.3,1.2); }',
    '@keyframes dshxGmPop { from { transform:scale(.94) translateY(8px); opacity:0 } to { transform:none; opacity:1 } }',
    '.dshx-gm-head { display:flex; align-items:center; gap:10px; padding:14px 18px 10px; }',
    '.dshx-gm-title { font:600 15px/1.2 system-ui; color:var(--dsw-alias-label-primary,#1a1d26); flex:1; }',
    '.dshx-gm-close { width:28px; height:28px; border:none; border-radius:8px; cursor:pointer;',
    '  background:transparent; color:var(--dsw-alias-label-secondary,#686c75); font-size:16px; }',
    '.dshx-gm-close:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
    '.dshx-gm-body { padding:0 18px 18px; overflow:auto; min-height:0; }',
    '.dshx-gm-cur { font-size:12.5px; color:var(--dsw-alias-label-tertiary,#9296a0); margin:0 0 10px; }',
    '.dshx-gm-branches { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }',
    '.dshx-gm-branch { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; font-size:12px;',
    '  border-radius:999px; cursor:pointer; border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));',
    '  color:var(--dsw-alias-label-secondary,#686c75); background:transparent; }',
    '.dshx-gm-branch:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
    '.dshx-gm-branch[data-cur="true"] { font-weight:600; color:var(--dsw-alias-label-primary,#1a1d26);',
    '  border-color:var(--dsw-alias-border-l2,rgba(121,126,145,.55)); }',
    '.dshx-gm-create { display:flex; gap:8px; margin-bottom:12px; }',
    '.dshx-gm-create input { flex:1; height:32px; padding:0 10px; font-size:13px; border-radius:8px;',
    '  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); background:transparent; color:inherit; outline:none; }',
    '.dshx-gm-create button { padding:0 14px; border-radius:8px; cursor:pointer; font-size:12.5px;',
    '  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.35)); background:transparent; color:inherit; }',
    '.dshx-gm-create button:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
    '.dshx-graph { max-height:58vh; overflow:auto; border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));',
    '  border-radius:10px; background:var(--dsw-alias-bg-layer-1,#fff); }',
    '.dshx-graph table { border-collapse:collapse; width:100%; font:12px/1.5 ui-monospace,Consolas,monospace; }',
    '.dshx-graph th { position:sticky; top:0; z-index:1; text-align:left; font-weight:500; padding:8px 10px;',
    '  background:var(--dsw-alias-bg-layer-2,#f6f7f9); border-bottom:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));',
    '  color:var(--dsw-alias-label-secondary,#686c75); white-space:nowrap; }',
    '.dshx-graph td { padding:6px 10px; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.12));',
    '  vertical-align:top; white-space:nowrap; }',
    '.dshx-graph td.dshx-g-lane { font-family:ui-monospace,Consolas,monospace; white-space:pre; color:var(--dsw-alias-label-tertiary,#9296a0); }',
    '.dshx-graph td.dshx-g-subject { white-space:normal; min-width:180px; color:var(--dsw-alias-label-primary,#1a1d26); }',
    '.dshx-graph .dshx-pill { display:inline-flex; align-items:center; padding:0 6px; margin-right:5px; font-size:10.5px;',
    '  border-radius:999px; background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); color:var(--dsw-alias-label-secondary,#686c75); }',
    '.dshx-graph .dshx-pill[data-kind="head"] { background:rgba(26,127,55,.12); color:#1a7f37; }',
    '.dshx-gm-err { color:#c83e4d; font-size:12.5px; padding:8px 0; }',
  ].join('\n')

  let modalEl = null
  let activeWsPath = ''

  function splitRefs(refs) {
    if (typeof refs !== 'string' || refs === '') return []
    const out = []
    for (const raw of refs.split(',')) {
      const s = raw.trim()
      if (s === '') continue
      const arrow = s.indexOf('->')
      if (arrow !== -1) {
        const head = s.slice(0, arrow).trim()
        const rest = s.slice(arrow + 2).trim()
        if (head !== '') out.push({ label: head, kind: 'head' })
        for (const part of rest.split(' ')) {
          if (part !== '') out.push({ label: part, kind: /^origin\//.test(part) ? 'remote' : 'branch' })
        }
        continue
      }
      let label = s
      let kind = 'remote'
      if (/^tag:/.test(s)) { kind = 'tag'; label = s.slice(4) }
      else if (!/^origin\//.test(s)) kind = 'branch'
      out.push({ label, kind })
    }
    return out
  }

  function pillsHtml(refs) {
    return splitRefs(refs).map((p) => '<span class="dshx-pill" data-kind="' + p.kind + '">' + esc(p.label) + '</span>').join('')
  }

  function graphTableHtml(commits, graphLines) {
    if (!Array.isArray(commits) || commits.length === 0) return '<div class="dshx-gm-err">（无数据）</div>'
    let html = '<table><thead><tr><th>图谱</th><th>描述</th><th>日期</th><th>作者</th><th>提交</th></tr></thead><tbody>'
    commits.forEach((c, i) => {
      const lane = graphLines[i] !== undefined ? esc(graphLines[i]) : ''
      html += '<tr>'
      html += '<td class="dshx-g-lane">' + lane + '</td>'
      html += '<td class="dshx-g-subject">' + pillsHtml(c.refs) + esc(c.subject || c.short || '') + '</td>'
      html += '<td>' + esc(c.date || '') + '</td>'
      html += '<td>' + esc(c.author || '') + '</td>'
      html += '<td>' + esc(c.short || (c.hash || '').slice(0, 7)) + '</td>'
      html += '</tr>'
    })
    html += '</tbody></table>'
    return html
  }

  function injectCss() {
    if (document.getElementById('dshx-git-ui-style') !== null) return
    const tag = document.createElement('style')
    tag.id = 'dshx-git-ui-style'
    tag.textContent = GIT_UI_CSS
    document.head.appendChild(tag)
  }

  function closeModal() {
    if (modalEl !== null) { modalEl.remove(); modalEl = null }
  }

  function switchBranch(path, branch, create) {
    return api('/git/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, branch, create: create === true }),
    })
  }

  function renderModal(wsPath, git) {
    injectCss()
    const mask = document.createElement('div')
    mask.className = 'dshx-gm-mask'
    const panel = document.createElement('div')
    panel.className = 'dshx-gm'
    let branches = ''
    ;(git.branches || []).forEach((b) => {
      branches += '<button type="button" class="dshx-gm-branch" data-branch="' + esc(b) + '" data-cur="' + (b === git.branch) + '">⎇ ' + esc(b) + '</button>'
    })
    panel.innerHTML =
      '<div class="dshx-gm-head"><span class="dshx-gm-title">Git 图谱</span>'
      + '<button type="button" class="dshx-gm-close" aria-label="关闭">✕</button></div>'
      + '<div class="dshx-gm-body">'
      + '<p class="dshx-gm-cur">当前分支：' + esc(git.branch || '') + '</p>'
      + '<div class="dshx-gm-branches">' + branches + '</div>'
      + '<div class="dshx-gm-create"><input placeholder="新分支名，创建并检出…" spellcheck="false">'
      + '<button type="button">创建并检出</button></div>'
      + '<div class="dshx-graph"><div class="dshx-gm-err">图谱加载中…</div></div>'
      + '</div>'
    mask.appendChild(panel)
    document.body.appendChild(mask)
    modalEl = mask

    mask.addEventListener('click', (ev) => { if (ev.target === mask) closeModal() })
    panel.querySelector('.dshx-gm-close').addEventListener('click', closeModal)
    panel.querySelectorAll('.dshx-gm-branch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-branch')
        if (target === git.branch || target === '') return
        switchBranch(wsPath, target, false).then((res) => {
          if (res.error) { alert(res.error); return }
          closeModal()
          setTimeout(() => location.reload(), 300)
        })
      })
    })
    panel.querySelector('.dshx-gm-create button').addEventListener('click', () => {
      const name = panel.querySelector('.dshx-gm-create input').value.trim()
      if (name === '') return
      switchBranch(wsPath, name, true).then((res) => {
        if (res.error) { alert(res.error); return }
        closeModal()
        setTimeout(() => location.reload(), 300)
      })
    })
    api('/git/graph?path=' + encodeURIComponent(wsPath)).then((g) => {
      const box = panel.querySelector('.dshx-graph')
      if (g.error) { box.innerHTML = '<div class="dshx-gm-err">' + esc(g.error) + '</div>'; return }
      const lines = typeof g.graph === 'string' ? g.graph.split('\n').filter((l) => l.trim() !== '') : []
      box.innerHTML = graphTableHtml(g.commits, lines)
    }).catch((err) => {
      const box = panel.querySelector('.dshx-graph')
      if (box) box.innerHTML = '<div class="dshx-gm-err">' + esc(String(err)) + '</div>'
    })
  }

  function openModal() {
    if (modalEl !== null) { closeModal(); return }
    const chip = document.querySelector('[class*="projectText"]')
    const name = chip !== null ? chip.textContent.trim().replace(/⎇.*$/, '').trim() : ''
    api('/workspaces').then((data) => {
      const row = (data.workspaces || []).find((w) => w.name === name)
      const wsPath = row ? row.path : ''
      if (wsPath === '') { alert('未找到工作区'); return }
      activeWsPath = wsPath
      return api('/git?path=' + encodeURIComponent(wsPath)).then((git) => {
        if (git.error) { alert(git.error); return }
        renderModal(wsPath, git)
      })
    }).catch((err) => alert(String(err)))
  }

  function ensureHeroChip() {
    const row = document.querySelector('[class*="heroWorkspaceRow"]')
    if (row === null || row.querySelector('.dshx-hero-chip') !== null) return
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'dshx-hero-chip'
    chip.setAttribute('aria-haspopup', 'menu')
    chip.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="M9.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6.5 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8.75 5.17l-3.5 2 .5.86 3.5-2-.5-.86zM5.25 8.97l3.5 2 .5-.86-3.5-2-.5.86z" fill="currentColor"/></svg><span>master</span><svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex:none"><path d="M3.5 5l3.5 3.5L10.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    chip.addEventListener('click', (ev) => { ev.stopPropagation(); openModal() })
    row.appendChild(chip)
  }

  function refreshHeroLabel() {
    const chip = document.querySelector('.dshx-hero-chip')
    if (chip === null) return
    const name = (() => { const c = document.querySelector('[class*="projectText"]'); return c ? c.textContent.trim().replace(/⎇.*$/, '').trim() : '' })()
    api('/workspaces').then((data) => {
      const row = (data.workspaces || []).find((w) => w.name === name)
      if (!row) return
      return api('/git?path=' + encodeURIComponent(row.path)).then((git) => {
        const span = chip.querySelector('span')
        if (span && git.branch) span.textContent = git.branch
      })
    }).catch(() => {})
  }

  // Intercept sidebar badge clicks (capture phase runs before the small-panel handler).
  document.addEventListener('click', (ev) => {
    const badge = ev.target.closest('.dshx-branch-badge, .dshx-hero-chip')
    if (badge === null) return
    ev.stopPropagation()
    ev.preventDefault()
    openModal()
  }, true)

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modalEl !== null) closeModal()
  })

  setInterval(ensureHeroChip, 800)
  setInterval(refreshHeroLabel, 5000)
  setTimeout(() => { injectCss(); ensureHeroChip(); refreshHeroLabel() }, 1500)
})()
