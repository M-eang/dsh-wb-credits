// Covers the inject fallback: ctx.get('webServer') returns undefined at apply
// time, so the plugin must wait for the service instead of going silent.
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
  get() {
    return undefined
  },
  inject(deps, callback) {
    console.log('apply 走了 inject 等待路径，依赖:', deps.join(', '))
    callback({ webServer: fakeWebServer, get: () => fakeWebServer, effect: (fn) => fn() })
  },
}

plugin.apply(fakeCtx)
console.log('路由已注册:', handlers.map((h) => `${h.kind}:${h.path}`).join(', ') || '(无)')

const server = http.createServer((req, res) => {
  const route = handlers.find((h) => req.url.startsWith(h.path))
  if (!route) return void res.writeHead(404).end('no route')
  route.handler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const body = await fetch(`http://127.0.0.1:${server.address().port}/wb-credits/summary`).then((r) => r.json())
console.log('ok:', body.ok, '| accounts:', body.accounts, '| total:', body.total_remain)
server.close()
