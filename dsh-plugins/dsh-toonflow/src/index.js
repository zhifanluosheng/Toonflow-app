// dsh-toonflow —— host 侧（Harness 服务端）入口。
//
// 职责（工作台开发规范 §3.4）：
//   1. GET  /api/toonflow/status → 探测 Toonflow 自带 HTTP 服务（127.0.0.1:3000）是否就绪
//   2. POST /api/toonflow/launch → 用户点「启动 Toonflow」时 spawn `bun build/server/index.js`
//
// 同一原则：用户不点就不 spawn；/launch 做 20 秒去抖，避免重复拉起进程。
import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-toonflow'
export const inject = ['webServer']

export const TOONFLOW_PORT = 3000
export const LAUNCH_DEBOUNCE_MS = 20_000

const STATUS_URL = `http://127.0.0.1:${TOONFLOW_PORT}/`
const PROBE_TIMEOUT_MS = 1500
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']

// 插件位于 <repo>/dsh-plugins/dsh-toonflow/src，向上三级即 Toonflow 仓库根。
export function resolveRepoRoot(env = process.env) {
  if (env.TOONFLOW_ROOT) return env.TOONFLOW_ROOT
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../..')
}

export function resolveLogDir(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'logs')
}

// bun 解析：优先环境变量，其次 npm 全局安装与官方安装位置，最后交给 PATH。
export function resolveBunPath(env = process.env, fileExists = existsSync) {
  if (env.TOONFLOW_BUN) return env.TOONFLOW_BUN
  const candidates = [
    env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe') : '',
    env.USERPROFILE ? join(env.USERPROFILE, '.bun', 'bin', 'bun.exe') : '',
  ]
  for (const candidate of candidates) {
    if (candidate && fileExists(candidate)) return candidate
  }
  return 'bun'
}

// 探活：1.5 秒超时，任何失败都折叠成 { ok:false, reason }，不抛。
export async function probeToonflow(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(STATUS_URL, {
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.status >= 200 && response.status < 400) return { ok: true, status: response.status }
    return { ok: false, reason: `HTTP ${response.status}` }
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '探测超时' : String(error?.message ?? error)
    return { ok: false, reason: message }
  }
}

// spawn 封装：日志写到 <DSH_HOME>/logs/toonflow-launch-*.log，进程与宿主脱钩。
export function spawnToonflow({ root, bunPath, logDir, spawnImpl = nodeSpawn, now = () => new Date() } = {}) {
  const entry = join(root, 'build', 'server', 'index.js')
  if (!existsSync(entry)) {
    return { ok: false, error: `未找到构建产物：${entry}（先在仓库根运行 bun apps/server/scripts/buildStandalone.ts）` }
  }
  try {
    mkdirSync(logDir, { recursive: true })
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const logPath = join(logDir, `toonflow-launch-${stamp}.log`)
    const fd = openSync(logPath, 'a')
    const env = { ...process.env, NODE_ENV: 'production' }
    for (const key of PROXY_ENV_KEYS) delete env[key]
    try {
      const child = spawnImpl(bunPath, [entry], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env,
      })
      child.unref()
      return { ok: true, pid: child.pid, logPath }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

function defaultLaunch() {
  return spawnToonflow({
    root: resolveRepoRoot(),
    bunPath: resolveBunPath(),
    logDir: resolveLogDir(),
  })
}

// 在线检测的纯函数版本，便于测试时注入 probe/launch。
export function createHandlers({ probe = probeToonflow, launch = defaultLaunch, now = () => Date.now() } = {}) {
  let lastLaunchAt = Number.NEGATIVE_INFINITY

  async function status() {
    const result = await probe()
    return {
      ready: result.ok === true,
      port: TOONFLOW_PORT,
      reason: result.ok ? null : (result.reason ?? '未就绪'),
    }
  }

  async function launchRequest() {
    const current = await probe()
    if (current.ok) return { ready: true, launched: false }
    if (now() - lastLaunchAt < LAUNCH_DEBOUNCE_MS) return { ready: false, launched: false, pending: true }
    lastLaunchAt = now()
    const spawned = launch()
    if (!spawned?.ok) return { ready: false, launched: false, error: spawned?.error ?? '启动失败' }
    return { ready: false, launched: true, pid: spawned.pid, logPath: spawned.logPath }
  }

  return { status, launchRequest }
}

function sendJson(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function apply(ctx, overrides = {}) {
  const handlers = overrides.handlers ?? createHandlers()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/toonflow/status',
    handler: (req, res) => {
      if (req.method && req.method !== 'GET') return sendJson(res, { error: 'method not allowed' }, 405)
      handlers.status()
        .then((payload) => sendJson(res, payload))
        .catch((error) => sendJson(res, { error: String(error?.message ?? error) }, 500))
    },
  }), 'dsh-toonflow: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/toonflow/launch',
    handler: (req, res) => {
      if (req.method && req.method !== 'POST') return sendJson(res, { error: 'method not allowed' }, 405)
      handlers.launchRequest()
        .then((payload) => sendJson(res, payload))
        .catch((error) => sendJson(res, { error: String(error?.message ?? error) }, 500))
    },
  }), 'dsh-toonflow: launch route')
}
