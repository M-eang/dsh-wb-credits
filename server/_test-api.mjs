// api-mode self-test: fake read-only snapshot endpoint.
//
//   node server/_test-api.mjs
//
// Covers: happy path, missing/rotated token (401), endpoint not published (404),
// and the config-inferred provider (only api.baseUrl + api.token given).
import http from 'node:http'

const TOKEN = 'tok-readonly-test'
const pad = (n) => String(n).padStart(2, '0')
const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 03:00:00`
}

// Same flat row shape deploy/wb-credits-api.py emits.
const ROWS = [
  {
    uid: 'u1',
    nickname: '甲',
    enabled: true,
    remain: 400.5,
    used: 99.5,
    size: 500,
    packages: [
      { remain: 200.5, expire_time: day(3), cycle_end_time: day(3) },
      { remain: 200, expire_time: day(20), cycle_end_time: day(20) },
    ],
  },
  {
    uid: 'u2',
    nickname: '乙',
    enabled: true,
    remain: 100,
    used: 0,
    size: 100,
    packages: [{ remain: 100, expire_time: day(5), cycle_end_time: day(5) }],
  },
]

let mode = 'ok'
const seenTokens = []
const api = http.createServer((req, res) => {
  const send = (status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (mode === 'timeout') return // accept, never answer: drives the abort path
  if (mode === 'missing') return send(404, { ok: false, error: 'not found' })
  if (req.url.split('?')[0] !== '/wb-credits/summary') return send(404, { ok: false, error: 'not found' })
  const token = req.headers['x-wb-token']
  seenTokens.push(token)
  if (mode === 'broken' && token === TOKEN) {
    // 200 + unparsable body: the classic "Nginx served an index.html" case.
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>502 Bad Gateway</html>')
  }
  if (mode === 'boom') return send(500, { error: { message: 'upstream dump failed' } })
  if (mode === 'notready') return send(200, { ok: false, error: { message: 'snapshot not ready' } })
  if (mode === 'empty' && token === TOKEN) return send(200, { ok: true, accounts: [], dump_at: '2026-10-17 12:00:00' })
  if (token !== TOKEN) return send(401, { ok: false, error: 'token required' })
  send(200, { ok: true, accounts: ROWS, dump_at: '2026-10-17 12:00:00' })
})

await new Promise((r) => api.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${api.address().port}`

const plugin = await import('file:///D:/Desktop/DSH插件/dsh-wb-credits/lib/index.js')

const handlers = []
const ctx = {
  get: (n) => (n === 'webServer' ? { register: (o) => (handlers.push(o), () => {}) } : undefined),
  effect: (fn) => fn(),
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const serve = async (config) => {
  plugin.apply(ctx, config)
  const handler = handlers[handlers.length - 1]
  const web = http.createServer((req, res) => handler.handler(req, res))
  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${web.address().port}/wb-credits/summary?refresh=1`
  const body = await fetch(url).then((r) => r.json())
  web.close()
  return body
}

// Provider inferred from the credentials alone (no `provider:` key).
const good = await serve({ api: { baseUrl, token: TOKEN } })
check('provider 自动推断', good.provider, 'api')
check('ok', good.ok, true)
check('accounts', good.accounts, 2)
check('total_remain', good.total_remain, 500.5)
check('expiring_7d 只算窗口内', good.expiring_7d, 300.5)
check('beyond_7d', good.beyond_7d, 200)
check('明细按剩余降序', good.accounts_detail.map((a) => a.nickname), ['甲', '乙'])
check('令牌走了自定义头', seenTokens[0], TOKEN)

const wrong = await serve({ provider: 'api', api: { baseUrl, token: 'rotated' } })
check('令牌错 ok', wrong.ok, false)
check('令牌错给出轮换提示', /令牌/.test(wrong.error), true)

mode = 'missing'
const absent = await serve({ provider: 'api', api: { baseUrl, token: TOKEN } })
check('接口没发布 ok', absent.ok, false)
check('接口没发布提示 Nginx', /Nginx/.test(absent.error), true)

const noToken = await serve({ provider: 'api', api: { baseUrl } })
check('缺令牌 ok', noToken.ok, false)
check('缺令牌说清怎么配', /WB_CREDITS_API_TOKEN/.test(noToken.error), true)

// An empty pool is NOT a failure: a freshly deployed gateway truthfully holds
// 0 credits, and the card must say 0. Every failure below must be `ok: false`
// for the opposite reason — rendering 0 when the read failed looks like "the
// credits are spent", which is the one wrong answer nobody investigates.
mode = 'empty'
const empty = await serve({ provider: 'api', api: { baseUrl, token: TOKEN } })
check('空池 ok', empty.ok, true)
check('空池 accounts', empty.accounts, 0)
check('空池 total_remain', empty.total_remain, 0)
check('空池 expiring_7d', empty.expiring_7d, 0)
check('空池 buckets', empty.buckets, [])
check('空池 accounts_detail', empty.accounts_detail, [])

mode = 'boom'
const boom = await serve({ provider: 'api', api: { baseUrl, token: TOKEN } })
check('HTTP 500 ok', boom.ok, false)
check('HTTP 500 带状态码', /HTTP 500/.test(boom.error), true)
check('HTTP 500 带上游原文', /upstream dump failed/.test(boom.error), true)

// 200 + HTML: what an Nginx error page or a proxy fallback looks like.
mode = 'broken'
const broken = await serve({ provider: 'api', api: { baseUrl, token: TOKEN } })
check('坏 JSON ok', broken.ok, false)
check('坏 JSON 指向账号数组', /账号数组/.test(broken.error), true)
check('坏 JSON 带被截断的原文', /502 Bad Gateway/.test(broken.error), true)

// 200 + `{ ok: false }`: the service answered, but has no snapshot for us.
mode = 'notready'
const notready = await serve({ provider: 'api', api: { baseUrl, token: TOKEN } })
check('ok:false 快照 ok', notready.ok, false)
check('ok:false 带上游原因', /snapshot not ready/.test(notready.error), true)

// Closed port: connect refused, not a timeout.
const dead = http.createServer(() => {})
await new Promise((r) => dead.listen(0, '127.0.0.1', r))
const deadPort = dead.address().port
await new Promise((r) => dead.close(r))
const refused = await serve({ provider: 'api', api: { baseUrl: `http://127.0.0.1:${deadPort}`, token: TOKEN } })
check('连不上 ok', refused.ok, false)
check('连不上说清地址', /连不上/.test(refused.error), true)

// Slowest last: a server that accepts and never answers must abort at
// PANEL_TIMEOUT_MS (15s) instead of hanging the sidebar forever.
mode = 'timeout'
const startedAt = Date.now()
const hung = await serve({ provider: 'api', api: { baseUrl, token: TOKEN } })
check('超时 ok', hung.ok, false)
check('超时说清秒数', /请求超时（15s）/.test(hung.error), true)
check('超时确实等到上限', Date.now() - startedAt >= 14_000, true)

api.close()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
