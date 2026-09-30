// 网关入口：读取配置 → 初始化认证 → 起 HTTP 服务 → 路由分发。
// 路由策略：
//   /auth/* 和 /api/auth/* → 认证路由（自身处理）
//   /api/plugins/*         → 插件路由（自身处理）
//   /api/workspaces/*      → 工作区路由（自身处理）
//   /app、/app/*、/auth/login → 新 Web 客户端静态文件（client/web/）
//   /                      → 302 到 SPA 入口 /app#/（`/` 不是控制台入口，见 static-routes.js）
//   其它路径 → 认证中间件 → 反向代理到上游
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { loadConfig } from './config.js'
import { createProxyHandler } from './proxy.js'
import { createUpgradeHandler } from './upgrade.js'
import { createStore, resolveDataDir } from './store.js'
import { createAuditLog } from './audit.js'
import { createRateLimiter } from './ratelimit.js'
import { createAuthService } from './auth-service.js'
import { createAuthMiddleware, getTokenFromRequest } from './auth-middleware.js'
import { createAuthRoutes } from './auth-routes.js'
import { createPluginRoutes } from './plugin-routes.js'
import { createWorkspaceRoutes } from './workspace-routes.js'
import { createStaticRoutes } from './static-routes.js'
import { createDshAuth } from './dsh-auth.js'
import { createSessionOwnerStore, scanSessionIds } from './session-owners.js'
import { createUpgradeAuthenticator } from './ws-ownership.js'
import { createSettingsStore } from './settings-store.js'
import { loadOrCreateTlsCert } from './tls-cert.js'
import { attachMtlsEnforcement, buildMtlsTlsOptions, getRequestClientFingerprint, isRequestClientAllowed, needsClientCert } from './client-certs.js'

const log = (msg) => process.stdout.write(`[gateway] ${new Date().toISOString()} ${msg}\n`)

let config
try {
  config = loadConfig()
} catch (err) {
  log(`配置错误，启动中止: ${err.message}`)
  process.exit(1)
}

// 初始化认证子系统
const dataDir = resolveDataDir()
const store = createStore(dataDir)
const settingsStore = createSettingsStore(dataDir)
const logDir = path.join(path.dirname(dataDir), 'logs')
const audit = createAuditLog(logDir)
const rateLimiter = createRateLimiter()
const authService = createAuthService({ store, audit })
const authMiddleware = createAuthMiddleware({ authService })
const authRoutes = createAuthRoutes({
  authService,
  rateLimiter,
  audit,
  settingsStore,
  // 🔴 旧口径是 `config.tls`（全局）⇒ 一开 TLS，会话 cookie 恒带 `Secure`，于是
  //   "经 tailnet 明文访问（http://…:8080）"这条兜底线路的登录**保持不住**（浏览器拒收 http 页面上的 Secure cookie）。
  //   改成**按请求**判定：只有真正 TLS 的连接（28443 那一口）才带 `Secure`；明文口（8080）
  //   外部那一段本身已是 TLS（Funnel ①）或 WireGuard（tailnet ③），故不加也安全（W-4 复核，2026-09-28）。
  secureCookies: (req) => !!(req && req.socket && req.socket.encrypted),
})
const pluginRoutes = createPluginRoutes({ authService, audit })
const workspaceRoutes = createWorkspaceRoutes({ audit })
// 4. 静态路由：服务 Web 客户端（客户端已拆分为独立仓库 dsh-remote-client，
//    经 DSH_GATEWAY_WEB_DIR 指向其 web/ 目录；public 页面免认证，其余需认证）
const staticRoutes = createStaticRoutes(config.webDir ? { webRoot: config.webDir } : {})

const upstream = config.upstream
const authority = `${upstream.hostname}:${upstream.port}`
const credentialsPath = path.join(path.dirname(dataDir), '.credentials.yaml')
let dshAuth
try {
  dshAuth = createDshAuth({ credentialsPath, authority })
  log(`dsh-auth cookie 生成器就绪 (authority=${authority})`)
} catch (e) {
  log(`警告: 无法初始化 dsh-auth: ${e.message}`)
}
const sessionOwnerStore = createSessionOwnerStore(dataDir)
const sessionsRoot = path.join(path.dirname(dataDir), 'sessions')
const proxyHandler = createProxyHandler(upstream, log, dshAuth, sessionOwnerStore, audit)
const upgradeHandler = createUpgradeHandler(upstream, log, dshAuth)

// 统一安全响应头：由 res.setHeader 预置，writeHead 时自动合并。
// 只加不会影响 SPA 与内嵌内核 UI 的项（frame-ancestors 不限制本站自身内嵌）。
function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('content-security-policy', "frame-ancestors 'self'")
  if (config.tls) {
    res.setHeader('strict-transport-security', 'max-age=31536000')
  }
}

// 路由分发：所有同步异常（含路径/解码类）在此收口，避免冒泡终止进程。
function routeRequest(req, res) {
  applySecurityHeaders(res)

  // mTLS 每请求复核：连接可能被 keep-alive 复用，吊销必须立即生效。
  // ⚠️ 这条路径**也必须写审计**：握手阶段的拒绝（client-certs.js 的 secureConnection）写了，
  //    而 keep-alive 复用连接时不会重新握手 ⇒ 只走这里。漏掉它，"被吊销的设备还在重试"
  //    这件事就没有任何痕迹（V8 真机验证时抓到的缺口）。
  // 🔴 判定交给 `needsClientCert`：`PLAIN_KEEP=1` 时的**明文**请求是"另一种正式入口"
  //    （Funnel --https 走它，身份由网关登录负责），不能对它强制客户端证书。
  if (needsClientCert(config, req) && !isRequestClientAllowed(dataDir, req)) {
    log('拒绝请求：客户端证书不在白名单内')
    audit.log('auth.client_cert_denied', {
      phase: 'request',
      path: req.url,
      fingerprint: getRequestClientFingerprint(req),
    })
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'CLIENT_CERT_DENIED', message: '客户端证书未授权' } }))
    return
  }

  // 1. 认证路由：自身处理，不经代理
  if (authRoutes.isAuthRoute(req.url)) {
    const matched = authRoutes.match(req)
    if (!matched) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '认证接口不存在' } }))
      return
    }
    // 需认证的路由先走中间件
    if (matched.auth) {
      authMiddleware(req, res, () => {
        if (matched.admin && req.user.role !== 'admin') {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: '需要管理员权限' } }))
          return
        }
        req.params = matched.params
        Promise.resolve(matched.handler(req, res)).catch((e) => {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
        })
      })
    } else {
      req.params = matched.params
      Promise.resolve(matched.handler(req, res)).catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
      })
    }
    return
  }

  // 2. 插件路由：自身处理，不经代理（均需认证）
  if (pluginRoutes.isPluginRoute(req.url)) {
    const matched = pluginRoutes.match(req)
    if (!matched) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '插件接口不存在' } }))
      return
    }
    authMiddleware(req, res, () => {
      req.params = matched.params
      Promise.resolve(matched.handler(req, res)).catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
      })
    })
    return
  }

  // 3. 工作区路由：自身处理，不经代理（均需认证）
  if (workspaceRoutes.isWorkspaceRoute(req.url)) {
    const matched = workspaceRoutes.match(req)
    if (!matched) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '工作区接口不存在' } }))
      return
    }
    authMiddleware(req, res, () => {
      req.params = matched.params
      Promise.resolve(matched.handler(req, res)).catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
      })
    })
    return
  }

  // 4. 静态路由：服务新 Web 客户端 client/web/（public 页面免认证，其余需认证）
  if (staticRoutes.isStaticRoute(req.url)) {
    const matched = staticRoutes.match(req)
    if (!matched) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: '静态资源不存在' } }))
      return
    }
    if (matched.public) {
      req.params = matched.params
      Promise.resolve(matched.handler(req, res)).catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
      })
    } else {
      authMiddleware(req, res, () => {
        req.params = matched.params
        Promise.resolve(matched.handler(req, res)).catch((e) => {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
        })
      })
    }
    return
  }

  // 5. 业务路由：先认证，再代理
  authMiddleware(req, res, () => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/sessions/migrate-legacy') {
      if (req.user.role !== 'admin') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: '需要管理员权限' } }))
        return
      }
      try {
        const allSessionIds = scanSessionIds(sessionsRoot)
        const result = sessionOwnerStore.migrateLegacy(req.user.id, allSessionIds)
        audit.log('session.legacy_migrated', {
          adminId: req.user.id,
          total: allSessionIds.length,
          migrated: result.migrated.length,
          skipped: result.skipped,
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, total: allSessionIds.length, ...result }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
      }
      return
    }
    proxyHandler(req, res)
  })
}

// 主请求处理（HTTP 明文与 HTTPS 复用同一个处理器）
const appHandler = (req, res) => {
  try {
    routeRequest(req, res)
  } catch (e) {
    log(`请求处理异常 ${req.method} ${req.url}: ${e.message}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }))
    } else {
      res.destroy()
    }
  }
}

// 升级处理器：WebSocket 也必须认证，且（T-1.b 阶段①）必须过**会话归属**判定。
// 判定与接线的实现搬到了 `ws-ownership.js` —— 因为本文件被 import 时就会 loadConfig()+listen，
// 不可在单测里直接 import（原地把这段内联在这里，等于不可测）。
// 🎚 阶段②（收紧为 403）由 `settings.json` 的 `wsOwnerStrict` 控制：**每次 upgrade 现取** ⇒ 改设置即生效、无需重启。
const upgradeAuthenticator = createUpgradeAuthenticator({
  authService,
  getToken: getTokenFromRequest,
  ownerStore: sessionOwnerStore,
  isStrictOwnerRequired: () => settingsStore.isWsOwnerStrict(),
  audit,
  upgradeHandler,
  log,
})

const servers = []

if (config.tls) {
  const tlsCred = loadOrCreateTlsCert({ dataDir, log, san: config.tlsSan })
  let tlsOptions = { cert: tlsCred.cert, key: tlsCred.key }

  // mTLS 客户端白名单：握手阶段要求合法客户端证书，握手后按指纹白名单授权。
  if (config.mtls) {
    try {
      tlsOptions = buildMtlsTlsOptions(dataDir, tlsOptions)
    } catch (e) {
      log(e.message)
      log('请先执行: node server/scripts/client-cert.mjs init --data-dir <数据目录>')
      process.exit(1)
    }
  }

  const httpsServer = https.createServer(tlsOptions, appHandler)
  if (config.mtls) attachMtlsEnforcement(httpsServer, { dataDir, log, audit })
  httpsServer.on('upgrade', upgradeAuthenticator)
  httpsServer.on('error', (err) => {
    log(`HTTPS 监听失败: ${err.message}`)
    process.exit(1)
  })
  httpsServer.listen(config.httpsPort, config.host, () => {
    log(`HTTPS listening on https://${config.host}:${config.httpsPort} -> ${upstream.hostname}:${upstream.port}`)
    if (config.mtls) log('mTLS 已启用：仅接受白名单内的客户端证书')
    log(`数据目录: ${dataDir}`)
  })
  servers.push(httpsServer)

  if (config.plainKeep) {
    // 明文口**保留**（DSH_GATEWAY_PLAIN_KEEP=1）：继续提供完整服务，不跳转。
    // 用途：Funnel 的 `--https` 是"tailscaled 终止 TLS、后端收明文"，所以链路里必须有明文口；
    // 而 `--tcp` + mTLS 又要求网关自己终止 TLS ⇒ 两种入口得能同时存在。
    const plainServer = http.createServer(appHandler)
    plainServer.on('upgrade', upgradeAuthenticator)
    plainServer.on('error', (err) => {
      log(`明文口监听失败: ${err.message}`)
      process.exit(1)
    })
    plainServer.listen(config.port, config.host, () => {
      log(`明文口保留（供 Funnel --https 反代）on http://${config.host}:${config.port} -> ${upstream.hostname}:${upstream.port}`)
    })
    servers.push(plainServer)
  } else {
    // 默认：HTTP 端口只负责 301 跳转到 HTTPS
    const redirector = http.createServer((req, res) => {
      // 目标主机只取本机监听地址，不信任 Host 头（防主机头注入 / 开放重定向）
      const portPart = config.httpsPort === 443 ? '' : `:${config.httpsPort}`
      res.writeHead(301, { Location: `https://${config.host}${portPart}${req.url}` })
      res.end()
    })
    redirector.on('upgrade', (req, socket) => {
      socket.destroy()
    })
    redirector.on('error', (err) => {
      log(`HTTP 跳转监听失败: ${err.message}`)
      process.exit(1)
    })
    redirector.listen(config.port, config.host, () => {
      log(`HTTP redirect on http://${config.host}:${config.port} -> https port ${config.httpsPort}`)
    })
    servers.push(redirector)
  }
} else {
  const httpServer = http.createServer(appHandler)
  httpServer.on('upgrade', upgradeAuthenticator)
  httpServer.on('error', (err) => {
    log(`监听失败: ${err.message}`)
    process.exit(1)
  })
  httpServer.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${config.port} -> ${upstream.hostname}:${upstream.port}`)
    log(`数据目录: ${dataDir}`)
  })
  servers.push(httpServer)
}

// 优雅退出：**先停止接受新连接，再快速掐断存量连接**。
// 为什么必须掐存量：`server.close()` 只关掉 listen socket，会**一直等已建立的连接自然结束**；
//   本网关有 keep-alive 与 WebSocket（/api/remote.mux），它们可以长期挂着
//   ⇒ 线上实测：收到 SIGTERM 后 90 秒才被 systemd SIGKILL（TimeoutStopUSec=1min 30s，
//     journal: `State 'stop-sigterm' timed out. Killing.`），而这段时间 close() **已不再接受
//     新连接** ⇒ 整整 90 秒服务不可用（重启窗口被拉长）。
// 做法（三步）：close()（拒新连接，存量不受影响）→ 3 秒宽限（让正在进行的请求写完）
//   → closeAllConnections()（Node 18.2+，掐断 keep-alive/WebSocket 存量连接）
//   ⇒ close() 的回调随即完成 ⇒ 立刻 exit(0)，不再等满 90s。
// 宽限期可用 DSH_GATEWAY_SHUTDOWN_GRACE_MS 覆盖（默认 3000ms，够一次正常请求写完）。
const SHUTDOWN_GRACE_MS = Number(process.env.DSH_GATEWAY_SHUTDOWN_GRACE_MS || 3000)
let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return // 重复信号不重跑（第二次 close() 不会再有回调）
    shuttingDown = true
    log(`收到 ${signal}，正在退出（停止接受新连接；${SHUTDOWN_GRACE_MS}ms 后掐断存量连接）`)
    const closed = servers.map((s) => new Promise((resolve) => s.close(() => resolve())))
    setTimeout(() => {
      log('宽限期到，掐断存量连接（keep-alive / WebSocket）')
      for (const s of servers) s.closeAllConnections()
    }, SHUTDOWN_GRACE_MS)
    Promise.all(closed).then(() => process.exit(0))
  })
}

// 兜底：单个请求/异步链路的异常不应让整个网关退出（否则任意畸形请求即可拒绝服务）。
process.on('uncaughtException', (e) => {
  log(`未捕获异常（已忽略，服务继续）: ${e && e.stack ? e.stack : e}`)
})
process.on('unhandledRejection', (e) => {
  log(`未处理的 Promise 拒绝（已忽略，服务继续）: ${e && e.stack ? e.stack : e}`)
})
