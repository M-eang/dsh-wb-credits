/**
 * Host half of dsh-wb-credits.
 *
 * One same-origin route, GET /wb-credits/summary, that the browser half polls.
 * Where the numbers come from is a *provider*, chosen by config:
 *
 *   panel  — log in to the gateway's web panel (POST /panel/login), then read
 *            GET /accounts with the X-Panel-Token header. Portable: any hub
 *            deployment works, nothing but the panel password is needed.
 *            This is the mode to ship to other people.
 *   ssh    — run server/credits.py on the hub host over SSH and read the
 *            account JSON files the scheduler writes. Needs a key on that
 *            host, so it only makes sense for the machine that owns the hub;
 *            in exchange it reads the richer on-disk snapshot and never
 *            touches the panel credentials.
 *
 * Both providers are normalised to the same row shape and aggregated by the
 * single implementation below, so the two modes cannot drift apart.
 *
 * Deliberately NOT used: GET /accounts/credits. That route calls
 * Account.fetch_credits() for every account, i.e. one upstream billing POST per
 * account (through the proxy) on every call — far too heavy for a widget that
 * refreshes while you type. GET /accounts serves the cached views instead.
 *
 * @module dsh-wb-credits
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'wb-credits'
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/wb-credits'
/** How long one snapshot is reused before the next poll re-runs the provider. */
const CACHE_MS = 55_000
/** Timeout for one panel HTTP call. */
const PANEL_TIMEOUT_MS = 15_000
/** Timeout for one SSH round trip (the remote python is quick, the link may not be). */
const SSH_TIMEOUT_MS = 30_000
/** Re-login before the token gets old, even without a 401 (server TTL is 7 days). */
const PANEL_TOKEN_MAX_AGE_MS = 6 * 24 * 3600_000

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(here, '..', 'server', 'credits.py')

/** Last successful snapshot plus its timestamp. */
let cache = { at: 0, payload: undefined }
/** Single-flight guard so concurrent polls share one round trip. */
let inflight
/** Panel session: one token per host process, shared by every poll. */
let panelSession = { key: '', token: '', at: 0 }

/**
 * Trim a value to a non-empty string.
 * @param value - anything.
 * @returns the trimmed string, or ''.
 */
function text(value) {
  return value == null ? '' : String(value).trim()
}

/**
 * Coerce to a finite number.
 * @param value - anything numeric-ish.
 * @returns the number, or 0.
 */
function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Resolve the effective settings from plugin config, then environment.
 *
 * Config wins over env so a profile can override a machine-wide default; the
 * provider is inferred when it is not stated, most-specific credential first:
 * a read-only API token (api) beats a panel password, which beats SSH, which
 * needs no secret at all but only works on the box that owns the key.
 *
 * @param config - the plugin's `config:` block from cordis.patch.yml.
 * @returns normalised settings.
 */
export function readSettings(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const panel = cfg.panel && typeof cfg.panel === 'object' ? cfg.panel : {}
  const api = cfg.api && typeof cfg.api === 'object' ? cfg.api : {}

  const apiBaseUrl = text(api.baseUrl || cfg.apiBaseUrl || process.env.WB_CREDITS_API_BASE_URL)
  const apiToken = text(api.token || cfg.apiToken || process.env.WB_CREDITS_API_TOKEN)
  const panelBaseUrl = text(panel.baseUrl || cfg.baseUrl || process.env.WB_CREDITS_BASE_URL)
  const panelPassword = text(
    panel.password || cfg.panelPassword || process.env.WB_CREDITS_PANEL_PASSWORD,
  )
  const requested = text(cfg.provider).toLowerCase()
  const provider = ['api', 'panel', 'ssh'].includes(requested)
    ? requested
    : apiBaseUrl && apiToken
      ? 'api'
      : panelBaseUrl && panelPassword
        ? 'panel'
        : 'ssh'

  return {
    provider,
    apiBaseUrl,
    apiToken,
    panelBaseUrl,
    panelPassword,
    sshHost: text(cfg.sshHost || process.env.WB_CREDITS_SSH_HOST) || 'root@124.220.151.13',
    accountsDir:
      text(cfg.accountsDir || process.env.WB_CREDITS_ACCOUNTS_DIR) || '/opt/wb-proxy/accounts',
    pollSeconds: Math.max(15, num(cfg.pollSeconds) || 60),
  }
}

/**
 * Parse a gateway timestamp ('2026-10-18 01:00:50', ISO, or epoch seconds).
 * @param value - raw timestamp from the gateway.
 * @returns a Date, or null when unparsable.
 */
function parseWhen(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(text(value))) {
    const seconds = Number(value)
    // The gateway writes `updated_at` as epoch seconds; anything smaller is junk.
    if (seconds > 1e9 && seconds < 4e9) return new Date(seconds * 1000)
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text(value))
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour || 0),
    Number(minute || 0),
    Number(second || 0),
  )
}

/**
 * Normalise one account from either provider into the shared row shape.
 *
 * The on-disk snapshot (SSH mode) has packages with `expire_time`; the public
 * view (panel mode) has the same `credits` dict but its packages may have been
 * rewritten by a credits refresh and only carry name/remain/used/size. Both
 * shapes are accepted, and a package without a usable expiry is counted in
 * `remain` but never in an expiry bucket.
 *
 * @param raw - one account from the gateway.
 * @returns the normalised row, or null when it is not an account.
 */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null
  // Two shapes arrive here: the panel view wraps everything under `credits`,
  // while credits.py already dumps a flat row (remain/used/size/packages at
  // the top level). Treat the flat row as its own credits block.
  const credits = raw.credits && typeof raw.credits === 'object' ? raw.credits : raw
  const packages = Array.isArray(credits.packages) ? credits.packages : []
  const uid = text(raw.uid)
  return {
    uid,
    nickname: text(raw.nickname) || uid.slice(0, 8) || '?',
    enabled: raw.enabled !== false,
    remain: num(credits.remain),
    used: num(credits.used),
    size: num(credits.size),
    packages: packages
      .filter((pack) => pack && typeof pack === 'object')
      .map((pack) => ({
        remain: num(pack.remain),
        when: parseWhen(pack.expire_time || pack.cycle_end_time || pack.cycle_end || ''),
      })),
  }
}

/**
 * Turn one day-key ('2026-10-18') for a Date.
 * @param date - day to render.
 * @returns YYYY-MM-DD in local time.
 */
function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Aggregate normalised rows into the payload the browser half renders.
 *
 * The 7-day figure is a *date window* (now … now+7d), not "the first seven
 * buckets": a day without any expiry must not silently stretch the window.
 *
 * @param rows - normalised account rows.
 * @param meta - provider/source labels to echo back.
 * @returns the summary payload.
 */
export function aggregate(rows, meta) {
  const now = new Date()
  const weekEnd = new Date(now.getTime() + 7 * 864e5)
  const accounts = rows.filter(Boolean)

  let totalRemain = 0
  let totalUsed = 0
  const buckets = new Map()
  const detail = []

  for (const account of accounts) {
    totalRemain += account.remain
    totalUsed += account.used

    let soonestAt = null
    let soonestAmount = 0
    for (const pack of account.packages) {
      if (pack.remain <= 0) continue
      if (!pack.when || pack.when <= now) continue
      const key = dayKey(pack.when)
      buckets.set(key, (buckets.get(key) || 0) + pack.remain)
      if (!soonestAt || pack.when < soonestAt) {
        soonestAt = pack.when
        soonestAmount = pack.remain
      }
    }

    detail.push({
      nickname: account.nickname,
      remain: Math.round(account.remain * 100) / 100,
      soonest_at: soonestAt
        ? `${dayKey(soonestAt)} ${String(soonestAt.getHours()).padStart(2, '0')}:${String(soonestAt.getMinutes()).padStart(2, '0')}`
        : '',
      soonest_amount: Math.round(soonestAmount * 100) / 100,
      hours_left: soonestAt
        ? Math.round(((soonestAt.getTime() - now.getTime()) / 3600_000) * 10) / 10
        : null,
    })
  }

  const ordered = [...buckets.entries()]
    .map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const weekEndKey = dayKey(weekEnd)
  let weekTotal = 0
  let beyondTotal = 0
  for (const bucket of ordered) {
    if (bucket.date <= weekEndKey) {
      weekTotal += bucket.amount
    } else {
      // Everything past the window. Without this, a caller cannot tell
      // "no more credits" from "credits that expire later than the chart".
      beyondTotal += bucket.amount
    }
  }

  detail.sort((a, b) => b.remain - a.remain)

  return {
    ok: true,
    generated_at: `${dayKey(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    provider: meta.provider,
    source: meta.source,
    accounts: accounts.length,
    enabled: accounts.filter((account) => account.enabled).length,
    total_remain: Math.round(totalRemain * 100) / 100,
    total_used: Math.round(totalUsed * 100) / 100,
    expiring_7d: Math.round(weekTotal * 100) / 100,
    beyond_7d: Math.round(beyondTotal * 100) / 100,
    // The browser half schedules its next poll from this, so the cost of a
    // snapshot (one SSH round trip in ssh mode) is tunable from config.
    poll_seconds: Math.max(15, num(meta.pollSeconds) || 60),
    buckets: ordered.slice(0, 30),
    accounts_detail: detail,
  }
}

/**
 * Join a base URL and an absolute API path without doubling slashes.
 * @param baseUrl - configured gateway root.
 * @param path - '/accounts' and friends.
 * @returns the full URL.
 */
function joinUrl(baseUrl, path) {
  return baseUrl.replace(/\/+$/, '') + path
}

/**
 * One JSON HTTP call, shared by the panel and the read-only API provider.
 * @param url - absolute URL.
 * @param init - fetch init plus any auth header.
 * @returns { status, body }.
 */
async function panelCall(url, init) {
  const headers = { accept: 'application/json', ...(init && init.headers) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PANEL_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal })
    const raw = await response.text()
    let body
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = { error: { message: raw.slice(0, 200) } }
    }
    return { status: response.status, body }
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? `请求超时（${PANEL_TIMEOUT_MS / 1000}s）：${url}`
      : `连不上 ${url}：${(error && error.message) || error}`
    throw new Error(message)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET the read-only snapshot API with its token header.
 * @param url - full /wb-credits/summary URL.
 * @param token - the read-only token.
 * @returns { status, body }.
 */
async function apiCall(url, token) {
  return panelCall(url, { method: 'GET', headers: { 'X-WB-Token': token } })
}

/**
 * Extract the gateway's error message from a failed panel response.
 * @param body - parsed response body.
 * @returns a short message.
 */function panelError(body) {
  if (!body) return '未知错误'
  if (typeof body.error === 'string') return body.error
  if (body.error && typeof body.error === 'object') {
    return text(body.error.message) || text(body.error.code) || '未知错误'
  }
  return text(body.message) || '未知错误'
}

/**
 * Identify one panel session by endpoint + password, without keeping the
 * password itself around: a config edit (new URL or rotated password) must
 * invalidate the cached token, otherwise a stale token would keep serving data
 * the configured credentials no longer justify.
 *
 * @param settings - resolved settings.
 * @returns a short opaque fingerprint.
 */
function sessionKey(settings) {
  return createHash('sha256')
    .update(`${settings.panelBaseUrl}\n${settings.panelPassword}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Log in to the panel and remember the token.
 * @param settings - resolved settings.
 * @returns the bearer token.
 */
async function panelLogin(settings) {
  if (!settings.panelBaseUrl) throw new Error('panel 模式缺少 panel.baseUrl')
  if (!settings.panelPassword) {
    throw new Error('panel 模式缺少面板密码（配置 panel.password 或环境变量 WB_CREDITS_PANEL_PASSWORD）')
  }
  const { status, body } = await panelCall(joinUrl(settings.panelBaseUrl, '/panel/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: settings.panelPassword }),
  })
  if (status !== 200 || !body || !body.token) {
    throw new Error(`面板登录失败（HTTP ${status}）：${panelError(body)}`)
  }
  panelSession = { key: sessionKey(settings), token: body.token, at: Date.now() }
  return body.token
}

/**
 * Serve a token, logging in (or re-logging after an expiry) as needed.
 * @param settings - resolved settings.
 * @param force - ignore the cached token.
 * @returns the token.
 */
async function panelToken(settings, force) {
  const stale = Date.now() - panelSession.at > PANEL_TOKEN_MAX_AGE_MS
  const usable = !force
    && panelSession.token
    && panelSession.key === sessionKey(settings)
    && !stale
  return usable ? panelSession.token : panelLogin(settings)
}

/**
 * Fetch and normalise every account through the panel API.
 * @param settings - resolved settings.
 * @returns normalised rows.
 */
async function panelRows(settings) {
  const load = async (token) => panelCall(joinUrl(settings.panelBaseUrl, '/accounts'), {
    method: 'GET',
    headers: { 'X-Panel-Token': token },
  })

  let { status, body } = await load(await panelToken(settings))
  if (status === 401) {
    // The gateway keeps panel sessions in memory: a container restart, a
    // password rotation, or the 7-day TTL all land here. One silent re-login.
    panelSession = { key: '', token: '', at: 0 }
    ;({ status, body } = await load(await panelToken(settings, true)))
  }
  if (status !== 200) {
    throw new Error(`读取 /accounts 失败（HTTP ${status}）：${panelError(body)}`)
  }
  const list = (body && (body.accounts || body.data)) || []
  if (!Array.isArray(list)) throw new Error('/accounts 返回的不是账号数组')
  return list.map(normalizeAccount).filter(Boolean)
}

/**
 * Fetch and normalise every account from the read-only snapshot API
 * (deploy/wb-credits-api.py on the hub, published as /wb-credits/summary).
 *
 * This is the mode that ships to other people: the only secret involved is a
 * revocable token that can do exactly one thing — read these numbers.
 *
 * @param settings - resolved settings.
 * @returns normalised rows.
 */
async function apiRows(settings) {
  if (!settings.apiBaseUrl) throw new Error('api 模式缺少 api.baseUrl')
  if (!settings.apiToken) {
    throw new Error('api 模式缺少令牌（配置 api.token 或环境变量 WB_CREDITS_API_TOKEN）')
  }
  const { status, body } = await apiCall(
    joinUrl(settings.apiBaseUrl, '/wb-credits/summary'),
    settings.apiToken,
  )
  if (status === 401 || status === 403) {
    throw new Error('只读接口拒绝了这个令牌（401）——令牌可能已轮换，去服务器的 /opt/wb-credits-api/token 取新的')
  }
  if (status === 404) {
    throw new Error('只读接口不存在（404）——服务器上 Nginx 还没配 /wb-credits/summary')
  }
  if (status !== 200) {
    throw new Error(`只读接口返回 HTTP ${status}：${panelError(body)}`)
  }
  const list = body && (body.accounts || body.data)
  if (!Array.isArray(list)) {
    // Carry the upstream's own words when it sent any: a truncated HTML error
    // page and a real `{ ok: false, error: {...} }` snapshot both land here,
    // and the operator can only tell them apart if the message survives.
    const why = body ? panelError(body) : ''
    throw new Error(`只读接口返回的不是账号数组${why && why !== '未知错误' ? `：${why}` : ''}`)
  }
  return list.map(normalizeAccount).filter(Boolean)
}

/**
 * Run credits.py on the hub host and normalise what it dumps.
 * @param settings - resolved settings.
 * @returns normalised rows.
 */
function sshRows(settings) {
  const source = readFileSync(SCRIPT_PATH, 'utf8')
  // base64 keeps the payload free of shell metacharacters: the remote command
  // is a fixed pipeline over an [A-Za-z0-9+/=] blob.
  const blob = Buffer.from(source, 'utf8').toString('base64')
  const remote = `WB_ACCOUNTS_DIR=${settings.accountsDir} python3 -c "import base64,sys;exec(base64.b64decode('${blob}'))"`

  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        settings.sshHost,
        remote,
      ],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim().slice(0, 300)
          reject(new Error(detail || 'ssh failed'))
          return
        }
        try {
          const parsed = JSON.parse(stdout)
          const list = parsed && Array.isArray(parsed.accounts) ? parsed.accounts : []
          resolve(list.map(normalizeAccount).filter(Boolean))
        } catch {
          reject(new Error('无法解析服务器返回: ' + String(stdout).slice(0, 160)))
        }
      },
    )
  })
}

/**
 * Build one snapshot with the configured provider.
 * @param settings - resolved settings.
 * @returns the summary payload.
 */
async function collect(settings) {
  if (settings.provider === 'api') {
    const rows = await apiRows(settings)
    return aggregate(rows, {
      provider: 'api',
      source: settings.apiBaseUrl.replace(/\/+$/, ''),
      pollSeconds: settings.pollSeconds,
    })
  }
  if (settings.provider === 'panel') {
    const rows = await panelRows(settings)
    return aggregate(rows, {
      provider: 'panel',
      source: settings.panelBaseUrl.replace(/\/+$/, ''),
      pollSeconds: settings.pollSeconds,
    })
  }
  const rows = await sshRows(settings)
  return aggregate(rows, {
    provider: 'ssh',
    source: settings.sshHost,
    pollSeconds: settings.pollSeconds,
  })
}

/**
 * Cached snapshot, refreshed at most once per CACHE_MS.
 * @param settings - resolved settings.
 * @param force - bypass the cache (the widget's refresh button).
 * @returns the payload.
 */
async function snapshot(settings, force) {
  const fresh = cache.payload && Date.now() - cache.at < CACHE_MS
  if (fresh && !force) return cache.payload
  if (inflight) return inflight
  inflight = collect(settings)
    .then((payload) => {
      cache = { at: Date.now(), payload }
      return payload
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

/**
 * Write one JSON response. Never cached: the numbers are per-poll.
 * @param res - response to write.
 * @param status - HTTP status.
 * @param body - JSON-serialisable payload.
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/**
 * Serve one /wb-credits request.
 * @param req - incoming request.
 * @param res - outgoing response.
 * @param settings - resolved settings for this mount.
 */
async function handle(req, res, settings) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname !== `${ROUTE_PREFIX}/summary`) {
    writeJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  try {
    const payload = await snapshot(settings, url.searchParams.get('refresh') === '1')
    writeJson(res, 200, payload)
  } catch (error) {
    writeJson(res, 200, {
      ok: false,
      provider: settings.provider,
      error: String(error && error.message ? error.message : error).slice(0, 400),
      source:
        settings.provider === 'api'
          ? settings.apiBaseUrl
          : settings.provider === 'panel'
            ? settings.panelBaseUrl
            : settings.sshHost,
      generated_at: new Date().toISOString(),
    })
  }
}

/**
 * Mount the route on one webserver instance and tie it to that fiber.
 * @param ctx - registrant context.
 * @param webserver - the shared webServer service.
 * @param settings - resolved settings.
 */
function mount(ctx, webserver, settings) {
  if (webserver === undefined || typeof webserver.register !== 'function') return
  const register = () => webserver.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handle(req, res, settings),
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = register()
      return () => dispose()
    })
  } else {
    register()
  }
}

/**
 * Plugin entry point.
 * @param ctx - registrant context.
 * @param config - the plugin's `config:` block, if the profile set one.
 */
export function apply(ctx, config) {
  const settings = readSettings(config)
  const ready = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (ready !== undefined) {
    mount(ctx, ready, settings)
    return
  }
  // The service was not there yet: wait for it rather than going silent.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (inner) => {
      mount(inner, inner.webServer ?? inner.get('webServer'), settings)
    })
  }
}
