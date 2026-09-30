// 静态文件路由：服务新 Web 客户端 client/web/。
// 路由：
//   GET /             → 302 到 SPA 入口 /app#/（`/` 不是控制台入口，见下面 routes[0] 注释）
//   GET /app          → SPA 入口 index.html
//   GET /app/*        → 静态资源；不存在的路径回退 index.html（SPA history 路由）
//   GET /auth/login   → 登录页 auth/login.html（未认证 302 的落点，无需认证）
//
// 安全：
//   1) 手工切分 pathname，路径段含 .. 即 400（不被 WHATWG URL 提前折叠）
//   2) resolve 后必须仍在 webRoot 内
//   3) 从 root 起逐段 lstat 扫描中间组件，任一为符号链接/junction 即 400；
//      最终节点同样 lstat 不跟随（防止父路径上的 junction 把请求带出 webRoot）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function defaultWebRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../..', 'client', 'web')
}

function badRequest(res) {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: '非法路径' } }))
}

function notFound(res, message) {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message } }))
}

function sendFile(res, absFile, statusCode = 200) {
  const ext = path.extname(absFile).toLowerCase()
  const data = fs.readFileSync(absFile)
  // 前端资源文件名不带内容哈希，必须每次回源校验，否则升级后浏览器仍执行旧逻辑。
  res.writeHead(statusCode, {
    'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'content-length': String(data.length),
    'cache-control': 'no-cache',
  })
  res.end(data)
}

export function createStaticRoutes({ webRoot = defaultWebRoot() } = {}) {
  const root = path.resolve(webRoot)

  // 基于相对 root 的段序列解析物理路径；含 ..、越界或途经符号链接 → 抛错。
  function resolveUnder(segments) {
    for (const seg of segments) {
      if (seg === '..') {
        throw Object.assign(new Error('path traversal segment'), { code: 'PATH_TRAVERSAL_DETECTED' })
      }
    }
    const target = segments.length === 0
      ? root
      : path.resolve(root, ...segments)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw Object.assign(new Error('resolved outside root'), { code: 'PATH_TRAVERSAL_DETECTED' })
    }
    // 逐段 lstat 扫描中间组件：OS 解析会穿过父路径上的 junction/symlink，
    // 只检查最终节点无法发现经由中间链接带出 webRoot 的情况。
    let cursor = root
    for (let i = 0; i < segments.length; i += 1) {
      cursor = path.join(cursor, segments[i])
      let stat
      try {
        stat = fs.lstatSync(cursor)
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw Object.assign(new Error('missing path component'), { code: 'PATH_COMPONENT_MISSING' })
        }
        throw e
      }
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error('symlink component'), { code: 'PATH_TRAVERSAL_DETECTED' })
      }
    }
    return target
  }

  // 提供静态文件。
  // 返回：'served' 已响应；'missing' 不存在；'rejected' 命中符号链接/非普通文件（已直接 404，不回退 SPA）。
  function serveExisting(res, absFile) {
    let stat
    try {
      stat = fs.lstatSync(absFile)
    } catch {
      return 'missing'
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      notFound(res, '资源不存在')
      return 'rejected'
    }
    sendFile(res, absFile)
    return 'served'
  }

  function serveIndex(res) {
    const indexFile = path.join(root, 'index.html')
    const outcome = serveExisting(res, indexFile)
    if (outcome === 'missing') {
      notFound(res, '客户端入口缺失')
    }
  }

  const routes = [
    {
      method: 'GET',
      // 根路径 `/`：**不是**控制台入口（控制台入口是 `/app`）。
      // 以前 `/` 没有任何路由 ⇒ 掉进 index.js 的兜底「认证后反代」，已登录时把人送到
      // **内核自有前端**而不是控制台 SPA —— 登录页的成功跳转（LOGIN_HTML 的 location.href）
      // 与写作客户端 iframe 都指向过 `/`，表现就是「登录后进不去控制台」。
      // 这里只做一次跳转：已登录 ⇒ 落到 SPA；未登录 ⇒ 由 index.js 的认证中间件先 302 /auth/login
      // （故**不加** public：HTML 入口一律要求认证，不引入新的免认证面）。
      // ⚠️ `#` 之后是**前端** hash 路由，服务端只认 `/app`：把 `#/` 一并写进 Location 只是
      //    让浏览器地址栏落在用户期望的 `/app#/`（app.js 的 parseHash 会把它归一为 dashboard）。
      test: (parts) => parts.length === 1 && parts[0] === '',
      handle(req, res) {
        res.writeHead(302, { location: '/app#/' })
        res.end()
      },
    },
    {
      method: 'GET',
      test: (parts) => parts.length === 1 && parts[0] === 'app',
      handle(req, res) {
        serveIndex(res)
      },
    },
    {
      method: 'GET',
      test: (parts) => parts.length >= 2 && parts[0] === 'app',
      // 非 HTML 资源（js/css/svg/字体等）公开：未认证落点 /auth/login 自身也要
      // 加载这些文件，否则会 302 回自身形成重定向环。HTML 入口仍需认证。
      public: (parts) => parts.slice(1).every((p) => !/\.html?$/i.test(p)),
      handle(req, res, parts) {
        const sub = parts.slice(1).map(decodeSegment).filter((seg) => seg.length > 0)
        if (sub.length === 0) {
          serveIndex(res)
          return
        }
        let absFile
        try {
          absFile = resolveUnder(sub)
        } catch (e) {
          if (e.code === 'PATH_COMPONENT_MISSING') {
            // 物理资源不存在：回退 SPA 入口，由前端 hash 路由处理。
            serveIndex(res)
            return
          }
          throw e
        }
        const outcome = serveExisting(res, absFile)
        if (outcome === 'served' || outcome === 'rejected') return
        serveIndex(res)
      },
    },
    {
      method: 'GET',
      test: (parts) => parts.length === 2 && parts[0] === 'auth' && parts[1] === 'login',
      public: true,
      handle(req, res) {
        let loginFile
        try {
          loginFile = resolveUnder(['auth', 'login.html'])
        } catch (e) {
          if (e.code === 'PATH_COMPONENT_MISSING') {
            notFound(res, '登录页缺失')
            return
          }
          throw e
        }
        const outcome = serveExisting(res, loginFile)
        if (outcome === 'missing') {
          notFound(res, '登录页缺失')
        }
      },
    },
  ]

  function decodeSegment(seg) {
    try {
      return decodeURIComponent(seg)
    } catch {
      throw Object.assign(new Error('bad percent encoding'), { code: 'BAD_REQUEST' })
    }
  }

  function parseParts(url) {
    const qIndex = url.indexOf('?')
    const pathname = qIndex === -1 ? url : url.slice(0, qIndex)
    return pathname.split('/').slice(1)
  }

  function match(req) {
    if (req.method !== 'GET') return null
    let parts
    try {
      parts = parseParts(req.url)
    } catch {
      return null
    }
    for (const r of routes) {
      if (r.test(parts)) {
        return {
          handler: (req2, res) => {
            try {
              r.handle(req2, res, parts)
            } catch (e) {
              if (e.code === 'PATH_TRAVERSAL_DETECTED' || e.code === 'BAD_REQUEST') {
                return badRequest(res)
              }
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } }))
            }
          },
          public: typeof r.public === 'function' ? r.public(parts) : !!r.public,
          params: {},
        }
      }
    }
    return null
  }

  return {
    match,
    isStaticRoute(url) {
      const pathname = url.split('?')[0]
      return pathname === '/' || pathname === '/app' || pathname.startsWith('/app/')
        || pathname === '/auth/login'
    },
  }
}
