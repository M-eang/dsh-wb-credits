// 只验证「客户端模块能被 loader 装上并注册到 sidebar.footer.action」，
// 不渲染、不模拟 DOM —— 用于替换被删掉的那个 mini renderer。
import fs from 'node:fs'

const source = fs.readFileSync('D:/Desktop/DSH插件/dsh-wb-credits/lib/client.js', 'utf8')
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}
// eslint-disable-next-line no-new-func
new Function(source)()
if (!captured || captured.id !== 'dsh-wb-credits') throw new Error('module did not register')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: 'Fragment',
  useState: () => [null, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

const module = captured.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error('unexpected require: ' + specifier)
})

const registrations = []
const ctx = {
  inject(deps, callback) {
    if (!deps.includes('slots')) throw new Error('expected slots dependency')
    return callback({
      slots: {
        inject(name, register) {
          if (name !== 'sidebar.footer.action') throw new Error('wrong slot: ' + name)
          return register()
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    })
  },
}

module.apply(ctx)

if (registrations.length !== 1) throw new Error('expected one registration, got ' + registrations.length)
const [entry] = registrations
if (entry.options.name !== 'sidebar.footer.action') throw new Error('wrong slot name')
if (entry.options.id !== 'wb-credits') throw new Error('wrong id')
if (typeof entry.component !== 'function') throw new Error('component missing')

// wide=false 走竖起按钮分支，wide=true 走卡片分支 —— 两个都必须能调通（返回元素树不渲染）。
const wide = entry.component({ wide: true })
const rail = entry.component({ wide: false })
if (!wide || !rail) throw new Error('component returned nothing')

console.log('注册位:', entry.options.name, '| id:', entry.options.id, '| order:', entry.options.order)
console.log('wide=true 返回节点:', wide && wide.props ? wide.props.className : '(fragment)')
console.log('wide=false 返回节点:', rail && rail.props ? rail.props.className : '(fragment)')
console.log('客户端 loader 自检通过')
