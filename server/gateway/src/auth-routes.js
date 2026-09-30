// 认证 API 路由处理器。
// 路径：
//   GET  /auth/login              → 登录页 HTML（公开）
//   POST /api/auth/register       → 注册（公开，限速）
//   POST /api/auth/login          → 登录（公开，限速）
//   POST /api/auth/logout         → 登出（需认证）
//   GET  /api/auth/me             → 当前用户（需认证）
//   GET  /api/auth/me/github      → GitHub 绑定信息（需认证）
//   PUT  /api/auth/me/github      → 保存 GitHub Token（需认证，先验证）
//   DELETE /api/auth/me/github    → 解绑 GitHub（需认证）
//   POST /api/auth/tokens         → 创建设备 Token（需认证）
//   DELETE /api/auth/tokens/:id   → 吊销 Token（需认证）
//   GET  /api/auth/users          → 列出账号（admin）
//   POST /api/auth/users          → 创建账号（admin）
//   POST /api/auth/users/:id/approve → 审批（admin）
//   PATCH /api/auth/users/:id     → 修改账号（admin）
//   GET  /admin/users             → 用户管理页 HTML（admin；T-2 —— 网关自有静态页）

import { getTokenFromRequest } from './auth-middleware.js'
import { TOKEN_TTL_MS } from './auth-service.js'
import { createRateLimiter } from './ratelimit.js'
import { getUserInfo } from './github.js'

// 认证接口请求体都很小（账号密码、Token），64KB 上限足够，避免超大 body 打满内存。
const MAX_BODY_BYTES = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        const e = new Error('请求体过大')
        e.code = 'PAYLOAD_TOO_LARGE'
        req.resume()
        reject(e)
        return
      }
      body += c
    })
    req.on('end', () => {
      if (aborted) return
      try { resolve(body ? JSON.parse(body) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function err(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

// 注册成功后对外暴露的字段 —— **刻意只有这三个**（S2）。
// 不含 id / createdAt / disabled：多一个字段就多一个可用于区分"新建"与"已存在"的信号。
// 要拿新账号 id 请走后端的管理员接口（`GET /api/auth/users`），别把它放进注册响应里。
function registrationResult(user) {
  return { name: user.name, displayName: user.displayName || user.name, role: user.role }
}

function matchPath(pattern, url) {
  // 简单路径匹配，支持 :param
  const urlPath = url.split('?')[0]
  const patternParts = pattern.split('/')
  const urlParts = urlPath.split('/')
  if (patternParts.length !== urlParts.length) return null
  const params = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      // 解码失败（如 %ZZ）视为不匹配，避免未捕获 URIError 打断进程。
      try {
        params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i])
      } catch {
        return null
      }
    } else if (patternParts[i] !== urlParts[i]) {
      return null
    }
  }
  return params
}

export function createAuthRoutes({ authService, rateLimiter, audit, settingsStore, secureCookies = false }) {
  // 注册和登录使用独立的限速器，避免注册触发登录限速
  const loginLimiter = rateLimiter
  // 🔴 为什么"是否带 `Secure`"要按**请求**判定，而不是按全局配置：
  //   带 `Secure` 的 cookie 在 **http 页面**上会被浏览器**直接拒收** ⇒ 若全局恒加
  //   （`index.js` 曾传 `secureCookies: config.tls`，一开 TLS 就恒真），那么"经 tailnet 明文访问
  //   （`http://…:8080`）"这条**兜底线路**连登录都保持不住（2026-09-28 W-4 复核发现）。
  //   而 Funnel `--https` 入口到网关**也是明文**（tailscaled 已终止 TLS）⇒ 网关无法区分这两者，
  //   只能按"**本连接是否真 TLS**"判定：
  //     · TLS 口（28443，mTLS 线路）⇒ 带 `Secure` ✓
  //     · 明文口（8080，Funnel ① 与 tailnet ③）⇒ 不带；**外部那一段本身已是 TLS 或 WireGuard** ✓
  //   兼容旧口径：仍接受布尔值（固定 true/false）。
  const cookieSuffixOf = (req) =>
    `HttpOnly; SameSite=Lax${
      (typeof secureCookies === 'function' ? !!secureCookies(req) : !!secureCookies) ? '; Secure' : ''
    }`
  // Cookie 有效期与设备 Token 有效期同源（见 auth-service.js 的 TOKEN_TTL_MS）
  const cookieMaxAgeSec = Math.floor(TOKEN_TTL_MS / 1000)
  const registerLimiter = createRateLimiter({ maxAttempts: 10, windowMs: 60_000 })
  const routes = []

  // 公开路由
  function publicRoute(method, pattern, handler) {
    routes.push({ method, pattern, handler, auth: false })
  }

  // 需认证路由
  function authRoute(method, pattern, handler, { admin = false } = {}) {
    routes.push({ method, pattern, handler, auth: true, admin })
  }

  // ---- 公开路由 ----

  // 是否允许自助注册。除管理员开关外，全新环境（尚无任何账号）必须放行，
  // 否则第一个管理员无法创建，后台将永远进不去。
  function registrationAllowed() {
    if (settingsStore && settingsStore.isPublicRegistrationAllowed()) return true
    return !settingsStore || authService.listUsers().length === 0
  }

  publicRoute('GET', '/auth/login', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(LOGIN_HTML)
  })

  publicRoute('GET', '/api/auth/registration-status', (req, res) => {
    json(res, 200, { ok: true, allowPublicRegistration: registrationAllowed() })
  })

  publicRoute('POST', '/api/auth/register', async (req, res) => {
    const ip = req.socket.remoteAddress
    if (!registrationAllowed()) {
      audit.log('auth.register.blocked', { ip })
      return err(res, 403, 'REGISTRATION_DISABLED', '当前未开放注册')
    }
    const rl = registerLimiter.check(ip)
    if (!rl.allowed) return err(res, 429, 'RATE_LIMITED', `请 ${Math.ceil(rl.retryAfter / 1000)} 秒后重试`)
    // name 必须在 try 之外声明：catch 里的"重复注册"分支要用它，
    // 而 try 内 `const` 出来的绑定在 catch 里**不可见**（会抛 ReferenceError ⇒ 500）。
    let name
    let password
    try {
      const body = await readBody(req)
      name = body.name
      password = body.password
      if (!name || !password) return err(res, 400, 'BAD_REQUEST', '缺少 name 或 password')
      const user = authService.registerUser({ name, password })
      audit.log('auth.register', { userId: user.id, name, ip })
      return json(res, 201, { ok: true, user: registrationResult(user) })
    } catch (e) {
      // S2（用户名枚举）：不能让"已存在"与"其他校验失败"可区分。
      // 做法：对 USER_EXISTS 返回**与成功完全相同**的响应（201 + role=pending），只是不建账号。
      // 真实情况写进审计（auth.register.duplicate）—— **API 不说，审计留痕**。
      // 代价：已注册的人再注册一次会看到"成功"，但他用原密码照常能登录，不损可用性。
      if (e.code === 'USER_EXISTS') {
        audit.log('auth.register.duplicate', { name, ip })
        return json(res, 201, { ok: true, user: registrationResult({ name, role: 'pending' }) })
      }
      return err(res, 400, e.code || 'BAD_REQUEST', e.message)
    }
  })

  publicRoute('POST', '/api/auth/login', async (req, res) => {
    const ip = req.socket.remoteAddress
    const rl = loginLimiter.check(ip)
    if (!rl.allowed) {
      // 封禁与窗口限流对外用**同一个响应**：区分了也只是让攻击者知道何时再来
      return err(res, 429, 'RATE_LIMITED', `请 ${Math.ceil(rl.retryAfter / 1000)} 秒后重试`)
    }
    try {
      const { name, password } = await readBody(req)
      if (!name || !password) return err(res, 400, 'BAD_REQUEST', '缺少 name 或 password')
      const user = authService.verifyUser(name, password)
      if (!user) {
        // S1：失败必须**累计**。只靠滑动窗口的话，窗口一过计数就清零，
        // "5 次/分钟"的低速撞库永远不会被挡住。
        const strike = loginLimiter.recordFailure(ip)
        audit.log('auth.login.failed', { name, ip, failures: strike.failures ?? null })
        if (strike.banned) {
          // 只在"封禁生效"这一刻写审计，不是每个被拒请求都写 ——
          // 否则攻击者靠刷请求就能刷爆审计（与 mTLS 那条同理）。
          audit.log('auth.login.ban_applied', { ip, banMs: strike.banMs, bans: strike.bans })
        }
        return err(res, 401, 'INVALID_CREDENTIALS', '用户名或密码错误')
      }
      if (user.role === 'pending') {
        audit.log('auth.login.pending', { userId: user.id, ip })
        return err(res, 403, 'ACCOUNT_PENDING', '账号待审批')
      }
      // 登录成功：清零该来源的失败累计（正常人打错几次自己也能复位）
      loginLimiter.recordSuccess(ip)
      // 登录成功：创建一个 session token 并设为 Cookie
      const { id, token } = authService.createDeviceToken({ userId: user.id, label: 'web-session' })
      res.setHeader('set-cookie', `dsh_session=${token}; Path=/; ${cookieSuffixOf(req)}; Max-Age=${cookieMaxAgeSec}`)
      audit.log('auth.login.success', { userId: user.id, ip })
      json(res, 200, { ok: true, user: authService.toPublicUser(user), tokenId: id })
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        return err(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大')
      }
      err(res, 500, 'INTERNAL_ERROR', e.message)
    }
  })

  // ---- 需认证路由 ----

  authRoute('POST', '/api/auth/logout', (req, res) => {
    // 吊销当前 token，清 Cookie
    if (req.tokenId) {
      try { authService.revokeToken(req.tokenId, req.user.id) } catch {}
    }
    res.setHeader('set-cookie', `dsh_session=; Path=/; ${cookieSuffixOf(req)}; Max-Age=0`)
    json(res, 200, { ok: true })
  })

  authRoute('GET', '/api/auth/me', (req, res) => {
    const tokens = authService.listUserTokens(req.user.id)
    const github = authService.toPublicGithub(authService.getGithubBinding(req.user.id))
    json(res, 200, { ok: true, user: authService.toPublicUser(req.user), tokens, github })
  })

  // ---- GitHub 绑定管理 ----

  authRoute('GET', '/api/auth/me/github', (req, res) => {
    const github = authService.toPublicGithub(authService.getGithubBinding(req.user.id))
    json(res, 200, { ok: true, github })
  })

  authRoute('PUT', '/api/auth/me/github', async (req, res) => {
    try {
      const { token } = await readBody(req)
      if (!token || typeof token !== 'string') {
        return err(res, 400, 'BAD_REQUEST', '缺少 GitHub Token')
      }
      // 用 token 调用 GitHub API 验证有效性
      const githubUser = await getUserInfo(token)
      authService.saveGithubBinding(req.user.id, { token, githubUser })
      json(res, 200, { ok: true, github: authService.toPublicGithub(authService.getGithubBinding(req.user.id)) })
    } catch (e) {
      err(res, e.status === 401 ? 401 : 400, e.code || 'BAD_REQUEST', e.message)
    }
  })

  authRoute('DELETE', '/api/auth/me/github', (req, res) => {
    const removed = authService.clearGithubBinding(req.user.id)
    json(res, removed ? 200 : 404, removed
      ? { ok: true }
      : { ok: false, error: { code: 'NOT_FOUND', message: '未绑定 GitHub' } })
  })

  authRoute('POST', '/api/auth/tokens', async (req, res) => {
    try {
      const { label } = await readBody(req)
      const { id, token } = authService.createDeviceToken({ userId: req.user.id, label })
      json(res, 201, { ok: true, id, token }) // 明文仅此一次
    } catch (e) {
      err(res, 400, e.code || 'BAD_REQUEST', e.message)
    }
  })

  authRoute('DELETE', '/api/auth/tokens/:id', (req, res) => {
    try {
      authService.revokeToken(req.params.id, req.user.id)
      json(res, 200, { ok: true })
    } catch (e) {
      err(res, e.code === 'NOT_FOUND' ? 404 : 403, e.code || 'BAD_REQUEST', e.message)
    }
  })

  // ---- Admin 路由 ----

  // T-2 用户管理页：网关**自有**静态页（不依赖 client/web 克隆）。
  // 放在这里而不是 client/web，是因为 `client/web` 是主仓 `.gitignore` 忽略的本地克隆
  // （`.gitignore:32 /client/`）⇒ 放那边的改动进不了主仓、会被重新克隆覆盖。
  // ⚠️ 2026-09-26 更正：原注释写"且无独立 git 仓"，**该说法不成立** —— `client/` 自 2026-09-21 起
  //   本身就是独立仓 `skyblade47/dsh-remote-client`（实测 `client/.git` 存在且有 origin）。
  //   因此"改动该放哪"的正确口径是：放 client/ 就必须提交到那个独立仓，而不是"无处可提交"。
  // 走 authRoute({admin:true})：复用 index.js 已有的"需认证 + 非 admin 403"门禁。
  authRoute('GET', '/admin/users', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(USERS_HTML)
  }, { admin: true })

  authRoute('GET', '/api/auth/users', (req, res) => {
    const users = authService.listUsers().map(authService.toPublicUser)
    json(res, 200, { ok: true, users })
  }, { admin: true })

  authRoute('POST', '/api/auth/users', async (req, res) => {
    try {
      const { name, password, role } = await readBody(req)
      if (!name || !password) return err(res, 400, 'BAD_REQUEST', '缺少 name 或 password')
      const user = authService.createUser({ name, password, role: role || 'user' })
      json(res, 201, { ok: true, user: authService.toPublicUser(user) })
    } catch (e) {
      err(res, 400, e.code || 'BAD_REQUEST', e.message)
    }
  }, { admin: true })

  authRoute('POST', '/api/auth/users/:id/approve', (req, res) => {
    try {
      const user = authService.approveUser(req.params.id, req.user.id)
      json(res, 200, { ok: true, user: authService.toPublicUser(user) })
    } catch (e) {
      err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code || 'BAD_REQUEST', e.message)
    }
  }, { admin: true })

  authRoute('PATCH', '/api/auth/users/:id', async (req, res) => {
    try {
      const updates = await readBody(req)
      const user = authService.updateUser(req.params.id, updates)
      json(res, 200, { ok: true, user: authService.toPublicUser(user) })
    } catch (e) {
      err(res, e.code === 'NOT_FOUND' ? 404 : 400, e.code || 'BAD_REQUEST', e.message)
    }
  }, { admin: true })

  authRoute('GET', '/api/auth/settings', (req, res) => {
    json(res, 200, { ok: true, settings: settingsStore.getAll() })
  }, { admin: true })

  authRoute('PATCH', '/api/auth/settings', async (req, res) => {
    try {
      const patch = await readBody(req)
      const allowed = {}
      if (typeof patch.allowPublicRegistration === 'boolean') {
        allowed.allowPublicRegistration = patch.allowPublicRegistration
      }
      // T-1.b 阶段② 开关：允许管理员经 API 翻转（也可直接编辑 settings.json —— 两条路都即时生效，无需重启）
      if (typeof patch.wsOwnerStrict === 'boolean') {
        allowed.wsOwnerStrict = patch.wsOwnerStrict
      }
      const settings = settingsStore.update(allowed)
      audit.log('auth.settings.updated', {
        adminId: req.user.id,
        changes: allowed,
      })
      json(res, 200, { ok: true, settings })
    } catch (e) {
      err(res, 400, e.code || 'BAD_REQUEST', e.message)
    }
  }, { admin: true })

  // ---- 路由匹配 ----

  function match(req) {
    const method = req.method
    const url = req.url
    for (const r of routes) {
      if (r.method !== method) continue
      const params = matchPath(r.pattern, url)
      if (params) return { ...r, params }
    }
    return null
  }

  return {
    match,
    isAuthRoute(url) {
      // 判断是否是认证相关路径（不需要代理到上游）
      return url.startsWith('/auth/') || url.startsWith('/api/auth/')
        || url === '/admin/users' || url.startsWith('/admin/users?')
    },
  }
}

// 登录页 HTML（内联，无需静态文件）
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 — DSH Remote</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 12px; padding: 32px; width: 360px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin-bottom: 24px; text-align: center; color: #1d1d1f; }
  label { display: block; font-size: 13px; color: #6e6e73; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #0071e3; }
  button { width: 100%; padding: 11px; background: #0071e3; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  button:hover { background: #0077ed; }
  .tabs { display: flex; margin-bottom: 20px; border-bottom: 1px solid #e8e8ed; }
  .tab { flex: 1; padding: 10px; text-align: center; cursor: pointer; font-size: 14px; color: #6e6e73; border-bottom: 2px solid transparent; }
  .tab.active { color: #0071e3; border-bottom-color: #0071e3; }
  .msg { margin-top: 12px; font-size: 13px; text-align: center; min-height: 18px; }
  .msg.error { color: #ff3b30; }
  .msg.success { color: #34c759; }
</style>
</head>
<body>
<div class="card">
  <h1>DSH Remote</h1>
  <div class="tabs">
    <div class="tab active" data-tab="login">登录</div>
    <div class="tab" data-tab="register">注册</div>
  </div>
  <form id="form">
    <label>用户名</label>
    <input name="name" required>
    <label>密码</label>
    <input name="password" type="password" required>
    <button type="submit" id="submit">登录</button>
  </form>
  <div class="msg" id="msg"></div>
</div>
<script>
const tabsWrap = document.querySelector('.tabs');
const tabs = document.querySelectorAll('.tab');
const form = document.getElementById('form');
const submitBtn = document.getElementById('submit');
const msg = document.getElementById('msg');
let mode = 'login';

fetch('/api/auth/registration-status')
  .then((r) => r.json())
  .then((d) => {
    if (!d.ok || !d.allowPublicRegistration) tabsWrap.remove();
  })
  .catch(() => {});

tabs.forEach(t => t.addEventListener('click', () => {
  tabs.forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  mode = t.dataset.tab;
  submitBtn.textContent = mode === 'login' ? '登录' : '注册';
  msg.textContent = '';
}));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'msg';
  msg.textContent = '';
  const fd = new FormData(form);
  const url = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(fd)) });
    const data = await res.json();
    if (data.ok) {
      if (mode === 'login') {
        msg.className = 'msg success'; msg.textContent = '登录成功，正在跳转...';
        // ⚠️ 落点必须是 SPA 入口 /app ：斜杠开头的根路径不是控制台入口（它会掉进反代兜底，
        //    已登录时返回内核自有前端）。这里直接跳 /app#/ ，不再依赖根路径的跳转规则。
        setTimeout(() => location.href = '/app#/', 500);
      } else {
        msg.className = 'msg success'; msg.textContent = data.user.role === 'admin' ? '注册成功，已成为管理员，请登录' : '注册成功，等待管理员审批';
      }
    } else {
      msg.className = 'msg error'; msg.textContent = data.error.message;
    }
  } catch (e) {
    msg.className = 'msg error'; msg.textContent = '网络错误';
  }
});
</script>
</body>
</html>`

// 用户管理页（T-2）。
// 样式来源：直接复用 Web 客户端**同一份**样式表 `/app/css/main.css`（同源静态资源、无需认证），
// 因此观感与该客户端一致；页面特有的少量样式内联，且只使用同一套 CSS 变量（--bg/--text/--accent…），
// 不引入任何新框架或构建步骤。
// 数据来源：`GET /api/auth/users`、`POST /api/auth/users`、`POST .../:id/approve`、`PATCH .../:id`
// —— 全部是同源相对路径，自动带 dsh_session Cookie。
// ⚠️ 只展示 name/displayName/role/disabled/createdAt（`toPublicUser` 的允许列表里已无密码哈希）。
// ⚠️ 后端没有"删除账号"端点 ⇒ 本页**不提供删除**。
const USERS_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>用户管理 — DSH Remote</title>
<link rel="stylesheet" href="/app/css/main.css">
<style>
  .utable { width: 100%; border-collapse: collapse; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .utable th, .utable td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13.5px; vertical-align: middle; }
  .utable th { background: var(--bg-elev2); color: var(--text-dim); font-weight: 600; font-size: 12.5px; }
  .utable tr:last-child td { border-bottom: none; }
  .utable td.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .select { background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); color: var(--text); font-family: inherit; font-size: 13px; padding: 5px 8px; }
  .select:disabled { opacity: 0.5; }
  .create-form { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
  .create-form .field { margin-bottom: 0; min-width: 170px; }
  .hint { color: var(--text-faint); font-size: 12.5px; margin: 12px 0 0; }
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-brand"><span class="logo-dot"></span><span class="topbar-title">DSH 控制台</span></div>
  <nav class="topbar-nav">
    <a href="/app#/dashboard">仪表盘</a>
    <a href="/app#/chat">AI 对话</a>
    <a href="/app#/admin">管理员设置</a>
    <a href="/admin/users" class="active">用户管理</a>
  </nav>
</header>
<main class="view">
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">用户管理</h1>
        <p class="page-sub">列出账号 · 审批 pending · 创建 · 改角色 · 禁用/启用</p>
        <p class="page-sub" style="color:var(--warning)">L1 下账号不是安全隔离：同一进程内的用户可互读彼此的工作区文件，仅适用于彼此信任的小圈子。</p>
      </div>
      <button type="button" class="btn" id="reloadBtn">刷新</button>
    </div>

    <section class="section">
      <div class="section-head"><h2 class="section-title">新建账号</h2></div>
      <div class="card">
        <form class="create-form" id="createForm">
          <div class="field">
            <label for="newName">用户名</label>
            <input class="input" id="newName" autocomplete="off" required>
          </div>
          <div class="field">
            <label for="newPassword">密码（至少 8 位）</label>
            <input class="input" id="newPassword" type="password" autocomplete="new-password" required>
          </div>
          <div class="field">
            <label for="newRole">角色</label>
            <select class="select" id="newRole">
              <option value="user">user</option>
              <option value="admin">admin</option>
              <option value="pending">pending</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary" id="createBtn">创建</button>
        </form>
        <p class="hint">后端没有删除账号的接口，所以本页不提供删除。审批用「审批」，改角色用下拉框，停用/恢复用最右侧按钮。</p>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="section-title">账号列表</h2></div>
      <div class="card" id="listCard"><div class="state-box">加载中…</div></div>
    </section>
  </div>
</main>
<div id="toastHost" class="toast-host"></div>
<script>
(function () {
  var me = null;
  var host = document.getElementById('toastHost');
  var listCard = document.getElementById('listCard');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function toast(msg, type) {
    var t = el('div', 'toast ' + (type || 'info'), msg);
    host.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 200);
    }, 3200);
  }

  function setList(node) {
    listCard.textContent = '';
    listCard.appendChild(node);
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.ok === false) {
          var why = (data && data.error && data.error.message) || ('请求失败（' + res.status + '）');
          throw new Error(why);
        }
        return data;
      });
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function roleBadge(role) {
    var cls = role === 'admin' ? 'badge accent' : (role === 'pending' ? 'badge green' : 'badge gray');
    return el('span', cls, role);
  }

  function load() {
    return api('/api/auth/users').then(function (d) {
      render(d.users || []);
    }).catch(function (e) {
      setList(el('div', 'state-box', '加载失败：' + e.message));
    });
  }

  function patchUser(id, body, label) {
    return api('/api/auth/users/' + encodeURIComponent(id), { method: 'PATCH', body: body })
      .then(function () { toast(label + '成功', 'success'); return load(); })
      .catch(function (e) { toast(label + '失败：' + e.message, 'error'); });
  }

  function render(users) {
    if (!users.length) { setList(el('div', 'state-box', '暂无账号')); return; }
    var table = el('table', 'utable');
    var thead = el('thead');
    var hr = el('tr');
    ['用户名', '显示名', '角色', '状态', '创建时间', '操作'].forEach(function (t) {
      hr.appendChild(el('th', null, t));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    users.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (u) {
      var isSelf = me && u.id === me.id;
      var tr = el('tr');
      tr.appendChild(el('td', null, u.name));
      tr.appendChild(el('td', null, u.displayName || u.name));
      // ⚠️ 角色是**节点**（badge span），必须 appendChild —— 走 el() 的 text 参数会被 String() 成 "[object Object]"。
      var roleTd = el('td');
      roleTd.appendChild(roleBadge(u.role));
      tr.appendChild(roleTd);
      tr.appendChild(el('td', null, u.disabled ? '已禁用' : '正常'));
      tr.appendChild(el('td', 'mono', fmtTime(u.createdAt)));

      var actions = el('td', 'actions');
      if (u.role === 'pending') {
        var approveBtn = el('button', 'btn btn-sm btn-primary', '审批');
        approveBtn.addEventListener('click', function () {
          api('/api/auth/users/' + encodeURIComponent(u.id) + '/approve', { method: 'POST' })
            .then(function () { toast('已审批', 'success'); return load(); })
            .catch(function (e) { toast('审批失败：' + e.message, 'error'); });
        });
        actions.appendChild(approveBtn);
      }

      var sel = el('select', 'select');
      ['user', 'admin', 'pending'].forEach(function (r) {
        var o = document.createElement('option');
        o.value = r;
        o.textContent = r;
        if (u.role === r) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { patchUser(u.id, { role: sel.value }, '改角色'); });
      actions.appendChild(sel);

      var toggle = el('button', 'btn btn-sm', u.disabled ? '启用' : '禁用');
      toggle.addEventListener('click', function () {
        patchUser(u.id, { disabled: !u.disabled }, u.disabled ? '启用' : '禁用');
      });
      actions.appendChild(toggle);

      // 唯一管理员把自己停用/降权就会把自己锁在外面 —— 本页对自己这一行禁用这两个动作。
      // （后端本身不做这个限制，这是页面侧的防误操作，不影响 API 语义。）
      if (isSelf) {
        sel.disabled = true;
        toggle.disabled = true;
        toggle.title = '不能对当前登录账号执行该操作';
      }

      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    setList(table);
  }

  document.getElementById('reloadBtn').addEventListener('click', function () { load(); });

  document.getElementById('createForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = document.getElementById('newName').value.trim();
    var password = document.getElementById('newPassword').value;
    if (!name || !password) return;
    var btn = document.getElementById('createBtn');
    btn.disabled = true;
    api('/api/auth/users', {
      method: 'POST',
      body: { name: name, password: password, role: document.getElementById('newRole').value },
    }).then(function () {
      toast('已创建账号', 'success');
      document.getElementById('newName').value = '';
      document.getElementById('newPassword').value = '';
      return load();
    }).catch(function (e) {
      toast('创建失败：' + e.message, 'error');
    }).then(function () { btn.disabled = false; });
  });

  // 服务端已对非 admin 返回 403；这里再确认一次，让页面给出可读提示而不是空白。
  api('/api/auth/me').then(function (d) {
    me = d.user;
    if (!me || me.role !== 'admin') {
      setList(el('div', 'state-box', '需要管理员权限'));
      return;
    }
    load();
  }).catch(function (e) {
    setList(el('div', 'state-box', '无法确认登录状态：' + e.message));
  });
})();
</script>
</body>
</html>`
