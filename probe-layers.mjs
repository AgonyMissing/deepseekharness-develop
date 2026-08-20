const wsUrl = process.argv[2]
const expression = process.argv[3] || '1'
const ws = new WebSocket(wsUrl)
const timer = setTimeout(() => { console.error('timeout'); process.exit(2) }, 10000)
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== 1) return
  clearTimeout(timer)
  console.log(JSON.stringify(m.result && m.result.result ? m.result.result : m.result, null, 2))
  process.exit(0)
}
