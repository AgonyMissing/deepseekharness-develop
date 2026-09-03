/**
 * git-ui.js — injected into the dsh web page by the desktop shell.
 *
 * Faithful port of the harness git experience: a hero branch chip that opens
 * a dropdown menu (switch branch / create-and-checkout / git graph), a create
 * modal, and the Git 图谱 modal with the trunk + Bézier merge-arc lane graph.
 */
(() => {
  if (globalThis.__dshGitUi) return
  globalThis.__dshGitUi = true

  const apiBase = () => (globalThis.__DSH_MCP_API__ || '')
  const api = (path, options) => fetch(apiBase() + path, options).then((r) => r.json())
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const CSS = [
    '.dshx-hero-git { position:relative; display:inline-flex; }',
    '.dshx-hero-chip { display:inline-flex; align-items:center; gap:4px; height:28px; padding:0 10px;',
    '  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); border-radius:16px;',
    '  background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1a1d26);',
    '  font:500 13px/1 system-ui; cursor:pointer; white-space:nowrap; margin-left:8px; }',
    '.dshx-hero-chip:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
    '.dshx-hero-chip:disabled { opacity:.55; cursor:default; }',
    '.dshx-hero-chip > span { display:inline-flex; align-items:center; line-height:1; transform:translateY(-1px); }',
    '.dshx-hero-chip svg { display:block; }',
    '.dshx-hero-chip-icon { color:var(--dsw-alias-label-secondary,#686c75); flex:none; }',
    '.dshx-hero-notice { font-size:12px; color:var(--dsw-alias-label-tertiary,#9296a0); }',
    '.dshx-hero-menu { position:fixed; z-index:2147483050; min-width:220px; max-height:340px; overflow:auto;',
    '  padding:6px; background:var(--dsw-alias-bg-base,#fff); border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.28));',
    '  border-radius:10px; box-shadow:0 12px 40px rgba(18,24,42,.22); font:13px/1.5 system-ui;',
    '  color:var(--dsw-alias-label-primary,#1a1d26); animation:dshxMenuIn .12s ease; }',
    '@keyframes dshxMenuIn { from { opacity:0; transform:translateY(-3px) } to { opacity:1 } }',
    '.dshx-hero-menu .dshx-mi { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:7px;',
    '  cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
    '.dshx-hero-menu .dshx-mi:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
    '.dshx-hero-menu .dshx-msep { height:1px; margin:5px 8px; background:var(--dsw-alias-border-l2,rgba(121,126,145,.16)); }',
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
    '.dshx-gm-field { display:flex; flex-direction:column; gap:5px; margin:4px 0 14px; }',
    '.dshx-gm-field > label { font-size:12px; color:var(--dsw-alias-label-secondary,#686c75); }',
    '.dshx-gm-field input { height:34px; padding:0 10px; font-size:13px; border-radius:8px;',
    '  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3)); background:transparent; color:inherit; outline:none; }',
    '.dshx-gm-actions { display:flex; gap:8px; justify-content:flex-end; }',
    '.dshx-gm-btn { padding:6px 16px; border-radius:8px; cursor:pointer; font-size:12.5px;',
    '  border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.35)); background:transparent; color:inherit; }',
    '.dshx-gm-btn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }',
    '.dshx-msg { font-size:12.5px; color:var(--dsw-alias-label-tertiary,#9296a0); padding:14px 0; }',
    '.dshx-msg[data-kind="error"] { color:#c83e4d; }',
    '.dshx-graph { max-height:64vh; overflow:auto; border:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));',
    '  border-radius:10px; background:var(--dsw-alias-bg-layer-1,#fff); min-width:0; }',
    '.dshx-graph-head { display:flex; align-items:center; gap:8px; padding:9px 14px;',
    '  background:var(--dsw-alias-bg-layer-2,#f6f7f9); border-bottom:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.2));',
    '  font-size:12px; color:var(--dsw-alias-label-secondary,#686c75); position:sticky; top:0; z-index:1; }',
    '.dshx-graph-head-cols { display:grid; grid-template-columns:minmax(0,1fr) 112px 70px 80px; gap:8px; flex:1; min-width:0; }',
    '.dshx-graph-th { font-weight:500; white-space:nowrap; }',
    '.dshx-graph-th-desc { padding-left:4px; }',
    '.dshx-graph-th-author { text-align:center; }',
    '.dshx-graph-body { display:flex; padding:0 14px; }',
    '.dshx-graph-lanes { display:block; flex:none; }',
    '.dshx-graph-rows { flex:1; display:flex; flex-direction:column; min-width:0; }',
    '.dshx-graph-row { display:grid; grid-template-columns:minmax(0,1fr) 112px 70px 80px; align-items:center;',
    '  gap:8px; font-size:12.5px; min-width:0; height:26px; overflow:hidden; }',
    '.dshx-graph-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)); }',
    '.dshx-graph-desc { display:inline-flex; align-items:center; min-width:0; }',
    '.dshx-graph-subject { color:var(--dsw-alias-label-primary,#1a1d26); overflow:hidden;',
    '  text-overflow:ellipsis; white-space:nowrap; }',
    '.dshx-graph-pill { flex:none; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;',
    '  font-size:10.5px; padding:0 7px; height:18px; line-height:18px; border-radius:999px; border:1px solid transparent; margin-right:5px; }',
    '.dshx-graph-pill[data-kind="head"] { border-color:rgba(207,102,0,.4); background:rgba(207,102,0,.1); color:#cf6600; }',
    '.dshx-graph-pill[data-kind="branch"] { border-color:rgba(77,107,254,.35); background:rgba(77,107,254,.1); color:#4d6bfe; }',
    '.dshx-graph-pill[data-kind="tag"] { border-color:rgba(130,80,223,.3); background:rgba(130,80,223,.1); color:#8250df; }',
    '.dshx-graph-pill[data-kind="remote"] { border-color:var(--dsw-alias-border-l2,rgba(121,126,145,.3));',
    '  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05)); color:var(--dsw-alias-label-secondary,#686c75); }',
    '.dshx-graph-date { text-align:left; font-size:11.5px; color:var(--dsw-alias-label-tertiary,#9296a0); }',
    '.dshx-graph-author { text-align:center; font-size:11.5px; color:var(--dsw-alias-label-secondary,#686c75); }',
    '.dshx-graph-hash { text-align:left; font:11.5px ui-monospace,Consolas,monospace; color:var(--dsw-alias-label-tertiary,#9296a0); }',
  ].join('\n')

  let menuEl = null
  let modalEl = null
  let graphData = null

  function injectCss() {
    if (document.getElementById('dshx-git-ui-style') !== null) return
    const tag = document.createElement('style')
    tag.id = 'dshx-git-ui-style'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

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

  function layoutGraph(commits) {
    const colors = ['#e5a13a', '#2da44e', '#0969da', '#8250df', '#bf8700', '#1b7c83', '#e16f24', '#8957e5']
    const rowOf = new Map(commits.map((c, i) => [c.hash, i]))
    const lanes = []
    const segs = []
    const rows = commits.map(() => ({ dot: { col: -1, color: '' }, bars: [], merges: [] }))
    for (let r = 0; r < commits.length; r++) {
      const c = commits[r]
      let idx = lanes.findIndex((l) => l.tip === c.hash)
      if (idx === -1) {
        idx = lanes.length
        lanes.push({ tip: c.hash, color: colors[lanes.length % colors.length] })
        segs.push([])
      }
      rows[r].dot = { col: idx, color: lanes[idx].color }
      for (let j = 0; j < lanes.length; j++) {
        if (j === idx) continue
        if (lanes[j].tip === c.hash) {
          rows[r].merges.push({ col: j, color: lanes[j].color })
          continue
        }
        const s = segs[j][segs[j].length - 1]
        if (s !== undefined && s.start < r && s.end > r) rows[r].bars.push({ col: j, color: lanes[j].color })
      }
      if (c.parents.length > 0) {
        const cur = segs[idx][segs[idx].length - 1]
        if (cur !== undefined) cur.end = r
        lanes[idx].tip = c.parents[0]
        segs[idx].push({ start: r, end: rowOf.get(c.parents[0]) ?? r + 1 })
        for (const p of c.parents.slice(1)) {
          const j = lanes.length
          lanes.push({ tip: p, color: colors[j % colors.length] })
          segs.push([{ start: r, end: rowOf.get(p) ?? r + 1 }])
          rows[r].merges.push({ col: j, color: colors[j % colors.length] })
        }
      }
    }
    return { rows, segs }
  }

  function graphHtml(commits) {
    const { rows, segs } = layoutGraph(commits)
    let maxCol = 0
    for (const row of rows) {
      if (row.dot.col > maxCol) maxCol = row.dot.col
      for (const b of row.bars) if (b.col > maxCol) maxCol = b.col
      for (const m of row.merges) if (m.col > maxCol) maxCol = m.col
    }
    const colors = ['#e5a13a', '#2da44e', '#0969da', '#8250df', '#bf8700', '#1b7c83', '#e16f24', '#8957e5']
    const cols = Math.max(1, Math.min(maxCol + 1, 12))
    const COL_W = 12
    const ROW_H = 26
    const xc = (c) => c * COL_W + COL_W / 2
    const chainW = cols * COL_W
    const chainH = rows.length * ROW_H
    const middleY = (r) => r * ROW_H + ROW_H / 2
    const TRUNK_X = xc(0)
    const BRANCH_X = TRUNK_X + 12
    const BRANCH_COLOR = '#0969da'
    let svg = ''
    for (const seg of segs[0]) {
      const y1 = seg.start * ROW_H
      const y2 = Math.min(seg.end, rows.length) * ROW_H
      if (y2 <= y1) continue
      svg += '<line x1="' + TRUNK_X + '" y1="' + y1 + '" x2="' + TRUNK_X + '" y2="' + y2 + '" stroke="' + colors[0] + '" stroke-width="1.5"/>'
    }
    for (let j = 1; j < segs.length; j++) {
      for (const seg of segs[j]) {
        const yTop = seg.start * ROW_H + ROW_H / 2
        const yBot = Math.min(seg.end, rows.length) * ROW_H + ROW_H / 2
        if (yBot <= yTop) continue
        svg += '<path d="M ' + TRUNK_X + ' ' + yTop + ' C ' + BRANCH_X + ' ' + yTop + ', ' + BRANCH_X + ' ' + yBot + ', ' + TRUNK_X + ' ' + yBot + '" fill="none" stroke="' + BRANCH_COLOR + '" stroke-width="1.5"/>'
      }
    }
    for (let r = 0; r < rows.length; r++) {
      const y = middleY(r)
      const onTrunk = rows[r].dot.col === 0
      svg += '<circle cx="' + (onTrunk ? TRUNK_X : BRANCH_X) + '" cy="' + y + '" r="2.5" fill="' + (onTrunk ? colors[0] : BRANCH_COLOR) + '"/>'
    }
    let rowsHtml = ''
    commits.forEach((c) => {
      const pills = splitRefs(c.refs).map((p) => '<span class="dshx-graph-pill" data-kind="' + p.kind + '">' + esc(p.label) + '</span>').join('')
      rowsHtml += '<div class="dshx-graph-row">'
        + '<span class="dshx-graph-desc">' + pills + '<span class="dshx-graph-subject">' + esc(c.subject || '') + '</span></span>'
        + '<span class="dshx-graph-date">' + esc(c.date || '') + '</span>'
        + '<span class="dshx-graph-author">' + esc(c.author || '') + '</span>'
        + '<span class="dshx-graph-hash">' + esc(c.short || '') + '</span>'
        + '</div>'
    })
    const head = '<div class="dshx-graph-head"><span class="dshx-graph-th" style="width:' + chainW + 'px;flex:none">图</span>'
      + '<span class="dshx-graph-head-cols"><span class="dshx-graph-th dshx-graph-th-desc">描述</span>'
      + '<span class="dshx-graph-th dshx-graph-th-date">日期</span><span class="dshx-graph-th dshx-graph-th-author">作者</span>'
      + '<span class="dshx-graph-th dshx-graph-th-hash">提交</span></span></div>'
    const body = '<div class="dshx-graph-body"><svg class="dshx-graph-lanes" width="' + chainW + '" height="' + chainH + '">' + svg + '</svg>'
      + '<div class="dshx-graph-rows">' + rowsHtml + '</div></div>'
    return '<div class="dshx-graph">' + head + body + '</div>'
  }

  function currentWorkspacePath() {
    const chip = document.querySelector('[class*="projectText"]')
    const name = chip !== null ? chip.textContent.trim().replace(/⎇.*$/, '').trim() : ''
    return api('/workspaces').then((data) => {
      const row = (data.workspaces || []).find((w) => w.name === name)
      return row ? row.path : ''
    })
  }

  function closeMenu() {
    if (menuEl !== null) { menuEl.remove(); menuEl = null }
  }

  function closeModal() {
    if (modalEl !== null) { modalEl.remove(); modalEl = null }
  }

  function showNotice(chip, text) {
    const old = document.querySelector('.dshx-hero-notice')
    if (old) old.remove()
    if (!chip) return
    const n = document.createElement('span')
    n.className = 'dshx-hero-notice'
    n.textContent = text
    chip.parentElement.insertBefore(n, chip.nextSibling)
    setTimeout(() => { if (n.isConnected) n.remove() }, 3000)
  }

  function checkout(wsPath, branch, create, chip) {
    api('/git/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: wsPath, branch, create: create === true }),
    }).then((result) => {
      if (result.error !== undefined && result.error !== '') throw new Error(result.error)
      closeMenu()
      closeModal()
      refreshBranchLabel(chip)
      showNotice(chip, '已切换到 ' + branch)
    }).catch((err) => {
      if (create && modalEl) {
        const msg = modalEl.querySelector('.dshx-create-err')
        if (msg) msg.textContent = String(err.message || err)
      } else {
        showNotice(chip, '失败：' + String(err.message || err))
      }
    })
  }

  function openCreateModal(wsPath, chip) {
    closeMenu()
    const mask = document.createElement('div')
    mask.className = 'dshx-gm-mask'
    const panel = document.createElement('div')
    panel.className = 'dshx-gm'
    panel.style.width = 'min(420px,92vw)'
    panel.innerHTML = '<div class="dshx-gm-head"><span class="dshx-gm-title">创建并检出新分支</span>'
      + '<button type="button" class="dshx-gm-close" aria-label="关闭">✕</button></div>'
      + '<div class="dshx-gm-body"><div class="dshx-gm-field"><label>分支名</label>'
      + '<input placeholder="feature/my-branch" spellcheck="false" autofocus></div>'
      + '<div class="dshx-msg dshx-create-err" data-kind="error"></div>'
      + '<div class="dshx-gm-actions"><button type="button" class="dshx-gm-btn" data-act="cancel">取消</button>'
      + '<button type="button" class="dshx-gm-btn" data-act="ok">创建并检出</button></div></div>'
    mask.appendChild(panel)
    document.body.appendChild(mask)
    modalEl = mask
    const input = panel.querySelector('input')
    input.focus()
    const submit = () => {
      const name = input.value.trim()
      if (name === '') { panel.querySelector('.dshx-create-err').textContent = '请输入分支名'; return }
      checkout(wsPath, name, true, chip)
    }
    mask.addEventListener('click', (ev) => { if (ev.target === mask) closeModal() })
    panel.querySelector('.dshx-gm-close').addEventListener('click', closeModal)
    panel.querySelector('[data-act="cancel"]').addEventListener('click', closeModal)
    panel.querySelector('[data-act="ok"]').addEventListener('click', submit)
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit() })
  }

  function openGraphModal(wsPath) {
    closeMenu()
    const mask = document.createElement('div')
    mask.className = 'dshx-gm-mask'
    const panel = document.createElement('div')
    panel.className = 'dshx-gm'
    panel.innerHTML = '<div class="dshx-gm-head"><span class="dshx-gm-title">Git 图谱</span>'
      + '<button type="button" class="dshx-gm-close" aria-label="关闭">✕</button></div>'
      + '<div class="dshx-gm-body"><div class="dshx-msg">加载中…</div></div>'
    mask.appendChild(panel)
    document.body.appendChild(mask)
    modalEl = mask
    mask.addEventListener('click', (ev) => { if (ev.target === mask) closeModal() })
    panel.querySelector('.dshx-gm-close').addEventListener('click', closeModal)
    const body = panel.querySelector('.dshx-gm-body')
    api('/git/graph?path=' + encodeURIComponent(wsPath)).then((result) => {
      if (result && result.error !== undefined && result.error !== '') {
        body.innerHTML = '<div class="dshx-msg" data-kind="error">' + esc(result.error) + '</div>'
        return
      }
      if (!result || !Array.isArray(result.commits) || result.commits.length === 0) {
        body.innerHTML = '<div class="dshx-msg">' + (result && result.graph ? '<pre>' + esc(result.graph) + '</pre>' : '（无数据）') + '</div>'
        return
      }
      body.innerHTML = graphHtml(result.commits)
    }).catch(() => { body.innerHTML = '<div class="dshx-msg" data-kind="error">图谱读取失败</div>' })
  }

  function openMenu(chip) {
    closeMenu()
    currentWorkspacePath().then((wsPath) => {
      if (wsPath === '') return
      api('/git?path=' + encodeURIComponent(wsPath)).then((info) => {
        if (!info || info.error !== undefined || info.branch === undefined) return
        const rect = chip.getBoundingClientRect()
        const menu = document.createElement('div')
        menu.className = 'dshx-hero-menu'
        let html = ''
        ;(info.branches || []).filter((b) => b !== info.branch).forEach((b) => {
          html += '<div class="dshx-mi" data-act="b:' + esc(b) + '">⎇ ' + esc(b) + '</div>'
        })
        html += '<div class="dshx-msep"></div>'
        html += '<div class="dshx-mi" data-act="__create">创建并检出新分支…</div>'
        html += '<div class="dshx-mi" data-act="__graph">Git 图谱</div>'
        menu.innerHTML = html
        menu.style.top = Math.min(rect.bottom + 6, window.innerHeight - 320) + 'px'
        menu.style.left = Math.max(8, Math.min(rect.right - 220, window.innerWidth - 230)) + 'px'
        document.body.appendChild(menu)
        menuEl = menu
        menu.querySelectorAll('.dshx-mi').forEach((mi) => {
          mi.addEventListener('click', () => {
            const act = mi.getAttribute('data-act')
            if (act === '__create') { openCreateModal(wsPath, chip); return }
            if (act === '__graph') { openGraphModal(wsPath); return }
            if (act.indexOf('b:') === 0) checkout(wsPath, act.slice(2), false, chip)
          })
        })
      })
    }).catch(() => {})
  }

  function refreshBranchLabel(chip) {
    currentWorkspacePath().then((wsPath) => {
      if (wsPath === '') return
      api('/git?path=' + encodeURIComponent(wsPath)).then((git) => {
        const span = chip.querySelector('span')
        if (span && git.branch) span.textContent = git.branch
      })
    }).catch(() => {})
  }

  function ensureHeroChip() {
    const row = document.querySelector('[class*="heroWorkspaceRow"]')
    if (row === null || row.querySelector('.dshx-hero-chip') !== null) return
    const wrap = document.createElement('span')
    wrap.className = 'dshx-hero-git'
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'dshx-hero-chip'
    chip.setAttribute('aria-haspopup', 'menu')
    chip.innerHTML = '<svg class="dshx-hero-chip-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6.5 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8.75 5.17l-3.5 2 .5.86 3.5-2-.5-.86zM5.25 8.97l3.5 2 .5-.86-3.5-2-.5.86z" fill="currentColor"/></svg><span>master</span><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 5l3.5 3.5L10.5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (menuEl !== null) { closeMenu(); return }
      openMenu(chip)
    })
    wrap.appendChild(chip)
    row.appendChild(wrap)
    refreshBranchLabel(chip)
  }

  document.addEventListener('click', (ev) => {
    if (menuEl !== null && !menuEl.contains(ev.target) && !ev.target.closest('.dshx-hero-chip')) closeMenu()
    if (modalEl !== null && ev.target === modalEl) closeModal()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeMenu(); closeModal() }
  })

  setInterval(ensureHeroChip, 800)
  setTimeout(() => { injectCss(); ensureHeroChip() }, 1200)
})()
