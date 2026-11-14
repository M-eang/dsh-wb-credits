import http from 'node:http'
import * as plugin from 'file:///D:/Desktop/DSH插件/dsh-wb-credits/lib/index.js'

const handlers = []
const fakeWebServer = {
  register(options) {
    handlers.push(options)
    return () => {}
  },
}
const fakeCtx = {
  get(name) {
    return name === 'webServer' ? fakeWebServer : undefined
  },
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
}

plugin.apply(fakeCtx)
console.log('路由已注册:', handlers.map((h) => `${h.kind}:${h.path}`).join(', '))

const server = http.createServer((req, res) => {
  const route = handlers.find((h) => req.url.startsWith(h.path))
  if (!route) {
    res.writeHead(404).end('no route')
    return
  }
  route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const started = Date.now()
const response = await fetch(`http://127.0.0.1:${port}/wb-credits/summary`)
const body = await response.json()
console.log('HTTP', response.status, '耗时', Date.now() - started, 'ms')
console.log('ok:', body.ok, '| accounts:', body.accounts, '| total:', body.total_remain, '| expiring7d:', body.expiring_7d)
if (body.error) console.log('error:', body.error)
console.log('前三个账号:', (body.accounts_detail || []).slice(0, 3).map((a) => `${a.nickname}=${a.remain}`).join(', '))

// 第二次应当命中缓存（明显更快）
const again = Date.now()
await fetch(`http://127.0.0.1:${port}/wb-credits/summary`).then((r) => r.json())
console.log('缓存命中耗时:', Date.now() - again, 'ms')

server.close()
