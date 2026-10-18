// dsh-toonflow —— client 侧：向 Desktop 注册工作台业务面板（整页 iframe）。
//
// 契约（工作台开发规范 §3.5）：
//   - 单文件模块经 window.__ModuleLoader__.load({ id }) 载入，id 必须等于 npm 包名；
//   - register() 提供 title、业务组件与规范的 GitHub repository URL；
//   - Cordis 服务在 factory 返回对象的 inject 上声明（desktopWorkbenches）。
//
// 面板结构：customFrame 整页 iframe → http://127.0.0.1:3000/（Toonflow 自带 HTTP 服务）。
// 未就绪时显示占位卡片：探测走宿主路由 /api/toonflow/status，
// 「启动 Toonflow」按钮 POST /api/toonflow/launch（host 侧 spawn，20s 去抖）。
window.__ModuleLoader__.load({
  id: 'dsh-toonflow',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const BRIDGE_URL = 'http://127.0.0.1:3000/'
    const STATUS_ROUTE = '/api/toonflow/status'
    const LAUNCH_ROUTE = '/api/toonflow/launch'
    const POLL_READY_MS = 5000
    const POLL_OFFLINE_MS = 3000
    const POLL_HIDDEN_MS = 15000
    const LAUNCH_STALL_MS = 180000

    const CSS = `
.tfw-shell{position:relative;display:flex;flex-direction:column;flex:1;height:100%;min-height:0;min-width:0;box-sizing:border-box;background:var(--dsw-alias-bg-base,#1b1b1c);color:var(--dsw-alias-label-primary,#e8e8ec);font-family:inherit;font-size:13px;line-height:20px}
.tfw-frame-wrap{position:relative;flex:1;min-height:0;min-width:0;display:flex;background:var(--dsw-alias-bg-base,#1b1b1c)}
.tfw-frame{flex:1;width:100%;height:100%;min-height:0;border:0;display:block;background:transparent}
/* 与宿主接缝：上/左 1px 亮边 + 内侧灰色投影（与 Nuomi Terminal 面板保持一致） */
.tfw-frame-wrap::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:2;border-top:1px solid var(--dsw-alias-border-l2,rgba(232,232,236,.16));border-left:1px solid var(--dsw-alias-border-l2,rgba(232,232,236,.16));box-shadow:inset 22px 0 28px -22px rgba(0,0,0,.55),inset 0 22px 28px -22px rgba(0,0,0,.42)}
.tfw-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;min-height:0}
.tfw-card{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:560px;padding:28px 32px;border:1px solid var(--dsw-alias-border-l2,#3a3a40);border-radius:12px;background:var(--dsw-alias-bg-module-platform,#202023);text-align:center}
.tfw-card h2{margin:0;font-size:16px;line-height:24px;font-weight:600}
.tfw-muted{margin:0;color:var(--dsw-alias-label-secondary,#a0a0aa);font-size:13px;line-height:20px}
.tfw-note{margin:0;color:var(--dsw-alias-label-tertiary,#7d7d86);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.tfw-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;justify-content:center}
.tfw-actions button,.tfw-overlay button{border:1px solid var(--dsw-alias-border-l2,#3a3a40);background:var(--dsw-alias-bg-layer-1,#26262a);color:inherit;border-radius:6px;padding:6px 14px;font:inherit;font-size:13px;line-height:18px;cursor:pointer}
.tfw-actions button:hover:not(:disabled),.tfw-overlay button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#2f2f35)}
.tfw-actions button:focus-visible,.tfw-overlay button:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#e8e8ec);outline-offset:2px}
.tfw-actions button:disabled{cursor:default;color:var(--dsw-alias-label-secondary,#a0a0aa)}
.tfw-actions .tfw-primary{background:var(--dsw-alias-button-primary-fill,#3a67f7);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}
.tfw-actions .tfw-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,#3a67f7))}
.tfw-hint{margin:0;color:var(--dsw-alias-label-tertiary,#7d7d86);font-size:12px;line-height:18px;max-width:560px;text-align:center}
.tfw-overlay{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3a40);border-radius:10px;background:var(--dsw-alias-bg-module-platform,#202023);box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:12px;line-height:18px;white-space:nowrap;z-index:3}
@media (prefers-reduced-motion: reduce){.tfw-card,.tfw-overlay{transition:none}}
`

    function shortReason(value) {
      return typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value
    }

    function ToonflowPanel({ active = true }) {
      const [phase, setPhase] = React.useState('probing') // probing | offline | launching | ready
      const [note, setNote] = React.useState('')
      const [mounted, setMounted] = React.useState(false)
      const [frameKey, setFrameKey] = React.useState(0)
      const stateRef = React.useRef({ phase: 'probing', mounted: false, launchAt: 0 })
      const activeRef = React.useRef(active)
      activeRef.current = active

      const probe = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (data?.ready) {
            const wasReady = stateRef.current.phase === 'ready'
            const wasMounted = stateRef.current.mounted
            stateRef.current.phase = 'ready'
            stateRef.current.mounted = true
            setMounted(true)
            setPhase('ready')
            setNote('')
            // 只在「断线后恢复」时重挂 iframe；每次探活都换 key 会把用户正在看的页面刷掉。
            if (wasMounted && !wasReady) setFrameKey((key) => key + 1)
            return
          }
          if (stateRef.current.mounted) {
            stateRef.current.phase = 'offline'
            setPhase('offline')
            setNote(`与 Toonflow 的连接已断开：${shortReason(String(data?.reason ?? '未就绪'))}`)
            return
          }
          stateRef.current.phase = 'offline'
          setPhase('offline')
          setNote('Toonflow 服务尚未运行。')
        } catch (error) {
          stateRef.current.phase = 'offline'
          setPhase('offline')
          setNote(`探测失败：${shortReason(String(error?.message ?? error))}`)
        }
      }, [])

      const launch = React.useCallback(async () => {
        stateRef.current.phase = 'launching'
        stateRef.current.launchAt = Date.now()
        setPhase('launching')
        setNote('正在启动 Toonflow…')
        try {
          const response = await fetch(LAUNCH_ROUTE, { method: 'POST', credentials: 'same-origin' })
          const data = await response.json().catch(() => null)
          if (!response.ok) {
            stateRef.current.phase = 'offline'
            setPhase('offline')
            setNote(`启动请求失败：${shortReason(String(data?.error ?? response.status))}`)
            return
          }
          if (data?.error) {
            stateRef.current.phase = 'offline'
            setPhase('offline')
            setNote(`启动失败：${shortReason(String(data.error))}`)
            return
          }
          if (data?.ready) {
            stateRef.current.phase = 'ready'
            stateRef.current.mounted = true
            setMounted(true)
            setPhase('ready')
            return
          }
          if (data?.pending) { setNote('Toonflow 已在启动中，请稍候…'); return }
          if (data?.launched) { setNote(`已拉起 Toonflow 进程（PID ${data.pid ?? '?'}），等待就绪…`); return }
          setNote('启动请求已发送，等待就绪…')
        } catch (error) {
          stateRef.current.phase = 'offline'
          setPhase('offline')
          setNote(`启动请求失败：${shortReason(String(error?.message ?? error))}`)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          await probe()
          if (!alive) return
          const current = stateRef.current
          let delay = activeRef.current ? POLL_OFFLINE_MS : POLL_HIDDEN_MS
          if (current.phase === 'ready') delay = activeRef.current ? POLL_READY_MS : POLL_HIDDEN_MS
          if (current.phase === 'launching') {
            delay = 2000
            if (Date.now() - current.launchAt > LAUNCH_STALL_MS) {
              current.phase = 'offline'
              setPhase('offline')
              setNote('启动超时（3 分钟未就绪）。可在启动日志中排查后重试。')
            }
          }
          timer = setTimeout(tick, delay)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [probe])

      const launching = phase === 'launching'
      return h('div', { className: 'tfw-shell' },
        mounted ? h('div', { className: 'tfw-frame-wrap' },
          h('iframe', {
            key: frameKey,
            className: 'tfw-frame',
            src: BRIDGE_URL,
            title: 'Toonflow',
            allow: 'microphone; autoplay; fullscreen; clipboard-read; clipboard-write',
            allowFullScreen: true,
          })) : null,
        !mounted ? h('div', { className: 'tfw-center' },
          h('div', { className: 'tfw-card' },
            h('h2', null, 'Toonflow'),
            h('p', { className: 'tfw-muted' }, launching
              ? 'Toonflow 正在启动，通常需要十几秒。'
              : 'Toonflow 服务尚未运行。'),
            note ? h('p', { className: 'tfw-note' }, note) : null,
            h('div', { className: 'tfw-actions' },
              h('button', { type: 'button', className: 'tfw-primary', disabled: launching, onClick: launch }, launching ? '正在启动…' : '启动 Toonflow'),
              h('button', { type: 'button', onClick: () => { void probe() } }, '重新检测'))),
          h('p', { className: 'tfw-hint' }, 'Toonflow 前端经本机 127.0.0.1:3000 访问自带服务；数据与模型调用都在本机完成。')) : null,
        mounted && phase !== 'ready' ? h('div', { className: 'tfw-overlay', role: 'status' },
          h('span', null, launching ? '等待 Toonflow 就绪…' : '与 Toonflow 的连接已断开'),
          !launching ? h('button', { type: 'button', onClick: launch }, '启动 Toonflow') : null,
          !launching ? h('button', { type: 'button', onClick: () => setFrameKey((key) => key + 1) }, '重新加载面板') : null,
          h('button', { type: 'button', onClick: () => { void probe() } }, '重新检测')) : null)
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-plugin', 'dsh-toonflow')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'toonflow: panel styles')

      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: 'Toonflow',
        panelTitle: 'Toonflow',
        repository: 'https://github.com/HBAI-Ltd/Toonflow-app',
        description: 'AI 短视频工作台：小说 → 剧本 → 分镜 → 图片/视频生成。整页 iframe 嵌入 DSH，前端经 127.0.0.1:3000 访问 Toonflow 服务。',
        customFrame: true,
      }, ToonflowPanel), 'toonflow: register workbench')
    }

    return { apply, inject: ['desktopWorkbenches'] }
  },
})
