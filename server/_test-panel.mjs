// Panel-mode self-test: a fake hub that speaks /panel/login + /accounts, plus
// a forced 401 halfway through to prove the silent re-login works.
//
//   node server/_test-panel.mjs
//
// No network, no DSH: pure provider + aggregation assertions.
import http from 'node:http'

const PASSWORD = 'pw-for-test'
const pad = (n) => String(n).padStart(2, '0')
const day = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 12:00:00`
}

const ACCOUNTS = [
  {
    uid: 'uid-a',
    nickname: 'alpha',
    enabled: true,
    machineId: 'decoy-machine',
    credits: {
      remain: 100,
      used: 10,
      size: 110,
      packages: [{ name: 'p1', remain: 100, expire_time: day(2) }],
    },
  },
  {
    uid: 'uid-b',
    nickname: 'bravo',
    enabled: false,
    credits: {
      remain: 50,
      used: 5,
      size: 55,
      packages: [
        { name: 'p1', remain: 20, expire_time: day(1) },
        // Beyond the 7-day window: must land in beyond_7d, not expiring_7d.
        { name: 'p2', remain: 30, cycle_end_time: day(40) },
      ],
    },
  },
]

let tokenSeq = 0
const liveTokens = new Set()
const calls = { login: 0, accounts: 0, rejected: 0 }
let expireNext = false

const hub = http.createServer((req, res) => {
  const send = (status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

  if (req.method === 'POST' && req.url === '/panel/login') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      calls.login += 1
      if (JSON.parse(raw || '{}').password !== PASSWORD) {
        return send(401, { error: { message: 'invalid panel password', code: 401 } })
      }
      const token = `tok-${++tokenSeq}`
      liveTokens.add(token)
      send(200, { ok: true, token })
    })
    return
  }

  if (req.method === 'GET' && req.url === '/accounts') {
    calls.accounts += 1
    const token = req.headers['x-panel-token']
    if (expireNext) {
      // Simulate a container restart / TTL expiry: every live token dies.
      expireNext = false
      liveTokens.clear()
    }
    if (!token || !liveTokens.has(token)) {
      calls.rejected += 1
      return send(401, { error: { message: 'panel password required' } })
    }
    return send(200, { accounts: ACCOUNTS, storage: '/app/accounts', usable: 1 })
  }

  send(404, { error: { message: 'not found' } })
})

await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${hub.address().port}`

// Imported after the hub is listening: module scope is harmless, but keeping
// the import here makes the dependency obvious.
const plugin = await import('file:///D:/Desktop/DSH插件/dsh-wb-credits/lib/index.js')

const handlers = []
const fakeCtx = {
  get: (name) => (name === 'webServer' ? { register: (o) => (handlers.push(o), () => {}) } : undefined),
  effect: (fn) => fn(),
}
plugin.apply(fakeCtx, { provider: 'panel', panel: { baseUrl, password: PASSWORD } })

const web = http.createServer((req, res) => {
  const route = handlers.find((h) => req.url.startsWith(h.path))
  if (!route) return void res.writeHead(404).end('no route')
  route.handler(req, res)
})
await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve))
const summaryUrl = `http://127.0.0.1:${web.address().port}/wb-credits/summary`

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const first = await fetch(`${summaryUrl}?refresh=1`).then((r) => r.json())
check('ok', first.ok, true)
check('provider', first.provider, 'panel')
check('source', first.source, baseUrl)
check('accounts', first.accounts, 2)
check('enabled', first.enabled, 1)
check('total_remain', first.total_remain, 150)
check('total_used', first.total_used, 15)
check('expiring_7d（只算窗口内）', first.expiring_7d, 120)
check('beyond_7d（窗口外归并）', first.beyond_7d, 30)
check('buckets 条数', first.buckets.length, 3)
check('明细按剩余降序', first.accounts_detail.map((a) => a.nickname), ['alpha', 'bravo'])
check('disabled 账号仍计入总额', first.accounts_detail[1].remain, 50)

// The day-with-no-expiry trap: window is a date range, so a gap cannot stretch it.
const gapRow = {
  uid: 'uid-c',
  nickname: 'charlie',
  enabled: true,
  credits: { remain: 999, used: 0, size: 999, packages: [{ remain: 999, expire_time: day(9) }] },
}
ACCOUNTS.push(gapRow)
const second = await fetch(`${summaryUrl}?refresh=1`).then((r) => r.json())
check('第 8 天不会混进 7 天口径', second.expiring_7d, 120)
check('第 8 天进 beyond', second.beyond_7d, 1029)

// Forced 401 -> silent re-login -> same numbers, one extra login.
const loginsBefore = calls.login
expireNext = true
const third = await fetch(`${summaryUrl}?refresh=1`).then((r) => r.json())
check('401 后仍然拿到数据', third.ok, true)
check('401 触发了一次重新登录', calls.login, loginsBefore + 1)
check('401 被计到 rejected', calls.rejected >= 1, true)
check('重新登录后数字一致', third.total_remain, 1149)

// A wrong password must surface as ok:false with a readable message.
plugin.apply(fakeCtx, { provider: 'panel', panel: { baseUrl, password: 'wrong' } })
const badHandler = handlers[handlers.length - 1]
const badWeb = http.createServer((req, res) => badHandler.handler(req, res))
await new Promise((resolve) => badWeb.listen(0, '127.0.0.1', resolve))
const bad = await fetch(`http://127.0.0.1:${badWeb.address().port}/wb-credits/summary?refresh=1`).then((r) => r.json())
check('错密码 ok', bad.ok, false)
check('错密码有中文提示', /面板登录失败/.test(bad.error), true)

badWeb.close()
web.close()
hub.close()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
