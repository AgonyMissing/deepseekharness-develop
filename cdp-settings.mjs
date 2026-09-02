const base = 'http://127.0.0.1:9222'
const targets = await fetch(base + '/json/list').then((r) => r.json())
const page = targets.find((t) => t.type === 'page' && t.url.includes('17890')) || targets.find((t) => t.type === 'page')
if (!page) { console.log('NO_PAGE'); process.exit(0) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
const expr = `(async () => {
  const out = {}
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '设置')
  if (!btn) { out.error = 'no settings button'; return JSON.stringify(out) }
  btn.click()
  await new Promise(r => setTimeout(r, 1800))
  const cells = [...document.querySelectorAll('[class*="navCell"]')]
  out.navTexts = cells.map(b => b.textContent.trim())
  out.navCount = cells.length
  out.duplicates = {}
  cells.forEach(b => { const t = b.textContent.trim(); out.duplicates[t] = (out.duplicates[t] || 0) + 1 })
  out.navOverlap = cells.map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 12), top: Math.round(r.top), h: Math.round(r.height) } })
  return JSON.stringify(out, null, 1)
})()`
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
if (r.exceptionDetails) console.log('EXCEPTION', r.exceptionDetails.exception?.description)
else console.log(r.result.value)
process.exit(0)
