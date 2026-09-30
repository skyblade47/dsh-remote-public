import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createStore } from '../src/store.js'
import { createAuthService } from '../src/auth-service.js'
import { createSettingsStore } from '../src/settings-store.js'
import { createRateLimiter } from '../src/ratelimit.js'
import { createAuthRoutes } from '../src/auth-routes.js'

function makeCtx({ registration = false, secureCookies = false, auditEvents = null, limiterOptions = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-routes-'))
  const store = createStore(dataDir)
  // auditEvents 传入数组时收集事件，便于断言"API 不说、审计留痕"这类要求
  const audit = auditEvents ? { log: (event, data) => auditEvents.push({ event, ...data }) } : { log() {} }
  const authService = createAuthService({ store, audit })
  const settingsStore = createSettingsStore(dataDir)
  if (registration) settingsStore.update({ allowPublicRegistration: true })
  const authRoutes = createAuthRoutes({
    authService,
    rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000, ...limiterOptions }),
    audit,
    settingsStore,
    secureCookies,
  })
  // 第一个注册用户自动成为 admin
  const admin = authService.registerUser({ name: 'alice', password: 'Password123' })
  return { dataDir, authService, authRoutes, settingsStore, admin }
}

function mockReq({ method = 'GET', url = '/', user = null, encrypted = false } = {}) {
  const r = new EventEmitter()
  r.method = method
  r.url = url
  r.user = user
  r.headers = {}
  // `encrypted` = 这条连接是否真 TLS（W-4：`Secure` cookie 改为按请求判定，测试要能造两种连接）
  r.socket = { remoteAddress: '127.0.0.1', encrypted: encrypted }
  r.resume = () => {}
  return r
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v },
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers) },
    end(body) { this.body = body },
  }
}

async function callRoute(authRoutes, req, body) {
  const matched = authRoutes.match(req)
  assert.ok(matched, `路由未匹配: ${req.method} ${req.url}`)
  req.params = matched.params
  const res = mockRes()
  const pending = Promise.resolve(matched.handler(req, res))
  if (body !== undefined) {
    req.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
  }
  req.emit('end')
  await pending
  return { res, matched }
}

// ---- 公开注册开关 ----

test('全新环境（无任何账号）即使开关关闭也允许注册首个管理员', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-bootstrap-'))
  const store = createStore(dataDir)
  const authService = createAuthService({ store, audit: { log() {} } })
  const settingsStore = createSettingsStore(dataDir)
  assert.equal(settingsStore.isPublicRegistrationAllowed(), false, '默认开关关闭')

  const authRoutes = createAuthRoutes({
    authService,
    rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
    audit: { log() {} },
    settingsStore,
  })

  const status = await callRoute(authRoutes, mockReq({ url: '/api/auth/registration-status' }))
  assert.equal(JSON.parse(status.res.body).allowPublicRegistration, true, '无账号时应提示可注册')

  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'firstadmin', password: 'Password123' },
  )
  assert.equal(res.statusCode, 201)
  assert.equal(JSON.parse(res.body).user.role, 'admin', '首个账号应为管理员')
})

test('已有账号且开关关闭时 registration-status 为 false（前端隐藏注册入口）', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(authRoutes, mockReq({ url: '/api/auth/registration-status' }))
  assert.equal(JSON.parse(res.body).allowPublicRegistration, false)
})

test('registration-status 默认关闭', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(authRoutes, mockReq({ url: '/api/auth/registration-status' }))
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).allowPublicRegistration, false)
})

test('关闭注册时 POST /api/auth/register 返回 403 REGISTRATION_DISABLED', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'bob', password: 'Password123' },
  )
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).error.code, 'REGISTRATION_DISABLED')
})

test('开放注册时 POST /api/auth/register 返回 201 且新账号为 pending', async () => {
  const { authRoutes } = makeCtx({ registration: true })
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'bob', password: 'Password123' },
  )
  assert.equal(res.statusCode, 201)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.user.role, 'pending')
})

test('注册接口不返回密码哈希', async () => {
  const { authRoutes } = makeCtx({ registration: true })
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'bob', password: 'Password123' },
  )
  assert.ok(!res.body.includes('passwordHash'))
})

// ---- S2：用户名枚举防护 ----
//
// 判据不是"报个笼统错误"，而是**两条路径的响应逐字段不可区分**：
//   · 名字可用 → 201 + {name, displayName, role:'pending'}
//   · 名字已存在 → 同样的形状（只是不建账号）
// 少一个字段、多一个字段、状态码不同，都能被拿来枚举。

test('S2：已存在的用户名注册 → 与成功的响应形状完全一致', async () => {
  const { authRoutes } = makeCtx({ registration: true }) // makeCtx 里已注册 alice
  const fresh = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'brand-new', password: 'Password123' },
  )
  const dup = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'alice', password: 'Password123' },
  )

  assert.equal(dup.res.statusCode, fresh.res.statusCode, '状态码必须一致')
  const freshBody = JSON.parse(fresh.res.body)
  const dupBody = JSON.parse(dup.res.body)
  assert.equal(dupBody.ok, true, '对已存在也报成功，不暴露存在性')
  assert.deepEqual(Object.keys(dupBody).sort(), Object.keys(freshBody).sort(), '顶层字段必须一致')
  assert.deepEqual(Object.keys(dupBody.user).sort(), Object.keys(freshBody.user).sort(), 'user 字段必须一致')
  assert.deepEqual(Object.keys(dupBody.user).sort(), ['displayName', 'name', 'role'],
    '注册响应刻意只含这三个字段（多一个就多一个可枚举信号）')
  assert.equal(dupBody.user.role, freshBody.user.role, 'role 也必须相同')
  assert.equal(dupBody.user.name, 'alice', '仍如实回显请求的名字，否则客户端会错乱')
})

test('S2：用弱密码探测已存在的用户名 → 仍是 400 WEAK_PASSWORD（不泄漏）', async () => {
  const { authRoutes } = makeCtx({ registration: true })
  const dupWeak = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'alice', password: '123' },
  )
  const freeWeak = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'nobody-here', password: '123' },
  )
  assert.equal(dupWeak.res.statusCode, 400)
  assert.equal(JSON.parse(dupWeak.res.body).error.code, 'WEAK_PASSWORD',
    '弱密码 + 已存在，不能走 USER_EXISTS 分支（否则弱密码就成了枚举探针）')
  assert.equal(dupWeak.res.statusCode, freeWeak.res.statusCode)
  assert.equal(JSON.parse(dupWeak.res.body).error.code, JSON.parse(freeWeak.res.body).error.code,
    '与"名字可用但密码弱"必须完全一致')
})

test('S2：已存在时不新建账号，且审计里留痕（API 不说、审计留痕）', async () => {
  const events = []
  const { authRoutes, authService } = makeCtx({ registration: true, auditEvents: events })
  const before = authService.listUsers().length

  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/register' }),
    { name: 'alice', password: 'Password123' },
  )
  assert.equal(res.statusCode, 201, '对外仍报成功')
  assert.equal(authService.listUsers().length, before, '不得新建账号')
  assert.ok(events.some((e) => e.event === 'auth.register.duplicate'),
    `审计应记 auth.register.duplicate，实际: ${JSON.stringify(events)}`)
  assert.ok(!events.some((e) => e.event === 'auth.register'),
    '不应记成正常注册，否则审计也看不出这是重复尝试')
})

// ---- S3：GitHub 明文 token 不得从接口漏出 ----
//
// 修复前实测：`GET /api/auth/me` 的 `user.github.token` 就是明文凭据
// （该接口另有一个已脱敏的 `github` 字段，所以很容易以为"已经处理过了"）。
// admin 的 `GET /api/auth/users` 更严重 —— 会把**每个**用户的 token 全列出来。

test('S3：GET /api/auth/me 不返回明文 token，但保留绑定展示字段', async () => {
  const { authRoutes, authService } = makeCtx()
  const alice = authService.store.findUserByName('alice')
  authService.saveGithubBinding(alice.id, {
    token: 'ghp_secret_value',
    githubUser: { login: 'octocat', avatarUrl: 'https://x/a.png' },
  })

  const { res } = await callRoute(authRoutes, mockReq({ url: '/api/auth/me', user: alice }))
  assert.ok(!res.body.includes('ghp_secret_value'), `响应体里出现了明文 token: ${res.body}`)

  const parsed = JSON.parse(res.body)
  assert.equal(parsed.user.github.token, undefined, 'user.github 里的 token 必须被剥掉')
  assert.equal(parsed.user.github.login, 'octocat', '展示字段要保留，否则绑定状态 UI 会变空')
  assert.equal(parsed.github.token, undefined, '单独的 github 字段本来就已脱敏')
})

test('S3：admin 的 GET /api/auth/users 不列出任何用户的明文 token', async () => {
  const { authRoutes, authService } = makeCtx()
  const alice = authService.store.findUserByName('alice')
  authService.saveGithubBinding(alice.id, {
    token: 'ghp_secret_value',
    githubUser: { login: 'octocat' },
  })

  const { res } = await callRoute(
    authRoutes,
    mockReq({ url: '/api/auth/users', user: { id: 'u-admin', role: 'admin' } }),
  )
  assert.ok(!res.body.includes('ghp_secret_value'), `列表接口泄漏了 token: ${res.body}`)
  const parsed = JSON.parse(res.body)
  assert.ok(parsed.users.every((u) => !u.github || u.github.token === undefined))
})

// ---- 管理员专用设置接口 ----

test('设置接口被标记为需管理员权限', () => {
  const { authRoutes } = makeCtx()
  for (const [method, url] of [['GET', '/api/auth/settings'], ['PATCH', '/api/auth/settings']]) {
    const matched = authRoutes.match(mockReq({ method, url }))
    assert.ok(matched, `${method} ${url} 应匹配`)
    assert.equal(matched.auth, true)
    assert.equal(matched.admin, true)
  }
})

test('PATCH /api/auth/settings 可切换注册开关并持久化', async () => {
  const { authRoutes, settingsStore } = makeCtx()
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'PATCH', url: '/api/auth/settings', user: { id: 'u1', role: 'admin' } }),
    { allowPublicRegistration: true },
  )
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).settings.allowPublicRegistration, true)
  assert.equal(settingsStore.isPublicRegistrationAllowed(), true)
})

test('PATCH /api/auth/settings 忽略未知字段', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'PATCH', url: '/api/auth/settings', user: { id: 'u1', role: 'admin' } }),
    { allowPublicRegistration: true, evil: 'x' },
  )
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.settings.evil, undefined)
})

test('PATCH /api/auth/settings 可翻转 wsOwnerStrict（T-1.b 阶段② 开关）', async () => {
  const { authRoutes, settingsStore } = makeCtx()
  assert.equal(settingsStore.isWsOwnerStrict(), false, '默认 = 阶段① 姿态')
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'PATCH', url: '/api/auth/settings', user: { id: 'u1', role: 'admin' } }),
    { wsOwnerStrict: true },
  )
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).settings.wsOwnerStrict, true)
  assert.equal(settingsStore.isWsOwnerStrict(), true)

  // 非布尔一律忽略（不静默写成真值 —— 收紧只能是显式选择）
  await callRoute(
    authRoutes,
    mockReq({ method: 'PATCH', url: '/api/auth/settings', user: { id: 'u1', role: 'admin' } }),
    { wsOwnerStrict: 'yes' },
  )
  assert.equal(settingsStore.isWsOwnerStrict(), true, '非布尔被忽略 ⇒ 保持原值 true')
})

// ---- 健壮性 ----

test('畸形百分号编码的路径参数不抛异常且不匹配', () => {
  const { authRoutes } = makeCtx()
  assert.doesNotThrow(() => authRoutes.match(mockReq({ method: 'DELETE', url: '/api/auth/tokens/%ZZ' })))
  assert.equal(authRoutes.match(mockReq({ method: 'DELETE', url: '/api/auth/tokens/%ZZ' })), null)
})

test('登录请求体超过 64KB 返回 413', async () => {
  const { authRoutes } = makeCtx()
  const req = mockReq({ method: 'POST', url: '/api/auth/login' })
  const matched = authRoutes.match(req)
  req.params = matched.params
  const res = mockRes()
  const pending = Promise.resolve(matched.handler(req, res))
  req.emit('data', Buffer.alloc(64 * 1024 + 1, 0x20))
  await pending
  assert.equal(res.statusCode, 413)
})

test('登录成功时 Cookie 在 TLS 模式下带 Secure', async () => {
  const { authRoutes, authService } = makeCtx({ secureCookies: true })
  authService.createUser({ name: 'carol', password: 'Password123', role: 'user' })
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login' }),
    { name: 'carol', password: 'Password123' },
  )
  assert.equal(res.statusCode, 200)
  const cookie = res.headers['set-cookie']
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Secure/)
})

test('非 TLS 模式下 Cookie 不带 Secure', async () => {
  const { authRoutes, authService } = makeCtx()
  authService.createUser({ name: 'carol', password: 'Password123', role: 'user' })
  const { res } = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login' }),
    { name: 'carol', password: 'Password123' },
  )
  assert.ok(!res.headers['set-cookie'].includes('Secure'))
})

test('🔴 Secure 按**请求**判定（函数形态）：明文口不带 / TLS 口带 —— 兜底线路不能被 Secure 打死', async () => {
  // 背景（2026-09-28 W-4）：旧口径 `secureCookies: config.tls` 是全局的 ⇒ 一开 TLS，
  // tailnet 明文访问（http://…:8080，兜底线路③）拿到的 cookie 带 Secure ⇒ 浏览器拒收 ⇒ 登不上。
  const { authRoutes, authService } = makeCtx({
    secureCookies: (req) => !!(req.socket && req.socket.encrypted),
  })
  authService.createUser({ name: 'carol', password: 'Password123', role: 'user' })

  const plain = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login', encrypted: false }),
    { name: 'carol', password: 'Password123' },
  )
  assert.equal(plain.res.statusCode, 200)
  assert.ok(
    !plain.res.headers['set-cookie'].includes('Secure'),
    '明文请求不得带 Secure（否则 http 页面拒收 cookie，兜底线路登不上）',
  )

  const tls = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login', encrypted: true }),
    { name: 'carol', password: 'Password123' },
  )
  assert.equal(tls.res.statusCode, 200)
  assert.match(tls.res.headers['set-cookie'], /Secure/, 'TLS 请求应带 Secure')
})

test('登录失败统一返回 INVALID_CREDENTIALS（不区分账号是否存在）', async () => {
  const { authRoutes } = makeCtx()
  const missing = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login' }),
    { name: 'nobody', password: 'Password123' },
  )
  assert.equal(missing.res.statusCode, 401)
  assert.equal(JSON.parse(missing.res.body).error.code, 'INVALID_CREDENTIALS')

  const wrongPass = await callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login' }),
    { name: 'alice', password: 'WrongPassword1' },
  )
  assert.equal(wrongPass.res.statusCode, 401)
  assert.equal(JSON.parse(wrongPass.res.body).error.code, 'INVALID_CREDENTIALS')
})

// ---- S1：登录失败累计 → 封禁（路由层接线）----
//
// 单测 ratelimit.js 只证明计数器对；这里证明**路由真的在调它** ——
// 之前那条链路是"验密失败只记一条审计，从不累计"，所以窗口一过就清零。

test('S1：连续登录失败累计到阈值 → 封禁生效并写审计，此后一律 429', async () => {
  const events = []
  const { authRoutes } = makeCtx({
    auditEvents: events,
    limiterOptions: { banAfterFailures: 3, baseBanMs: 60_000 },
  })
  const login = (password) => callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login' }),
    { name: 'alice', password },
  )

  for (let i = 0; i < 3; i++) {
    const { res } = await login('WrongPassword1')
    assert.equal(res.statusCode, 401, `第 ${i + 1} 次仍是凭据错误`)
  }
  assert.ok(events.some((e) => e.event === 'auth.login.ban_applied'),
    `封禁生效时应写审计，实际事件: ${JSON.stringify(events.map((e) => e.event))}`)

  // 封禁后即使密码正确也被拒：准入判定在验密之前
  const blocked = await login('Password123')
  assert.equal(blocked.res.statusCode, 429, '封禁期间一律 429，不进入验密')
  assert.equal(JSON.parse(blocked.res.body).error.code, 'RATE_LIMITED')
})

test('S1：登录成功清零失败累计（不因历史失败被误封）', async () => {
  const events = []
  const { authRoutes, authService } = makeCtx({
    auditEvents: events,
    limiterOptions: { banAfterFailures: 3 },
  })
  authService.createUser({ name: 'carol', password: 'Password123', role: 'user' })
  const login = (password) => callRoute(
    authRoutes,
    mockReq({ method: 'POST', url: '/api/auth/login' }),
    { name: 'carol', password },
  )

  await login('WrongPassword1')
  await login('WrongPassword1') // 失败 2 次（阈值是 3）
  const ok = await login('Password123')
  assert.equal(ok.res.statusCode, 200, '第 3 次用对密码应能进')

  await login('WrongPassword1')
  await login('WrongPassword1') // 清零后再失败 2 次，仍不该封
  assert.ok(!events.some((e) => e.event === 'auth.login.ban_applied'),
    '成功登录后应清零，不该被封禁')
})

// ---- T-2：用户管理页（GET /admin/users）----

test('T-2：/admin/users 归入认证路由且要求 admin', () => {
  const { authRoutes } = makeCtx()
  assert.equal(authRoutes.isAuthRoute('/admin/users'), true)
  assert.equal(authRoutes.isAuthRoute('/admin/users?x=1'), true)
  // 不能把 /admin 下的其它路径一并吞掉（那些应继续走代理）
  assert.equal(authRoutes.isAuthRoute('/admin/other'), false)
  assert.equal(authRoutes.isAuthRoute('/admin/users/1'), false)

  const matched = authRoutes.match(mockReq({ url: '/admin/users' }))
  assert.ok(matched, '应能匹配到路由')
  assert.equal(matched.auth, true)
  assert.equal(matched.admin, true, '必须标成 admin —— index.js 据此对非 admin 返回 403')
})

test('T-2：/admin/users 返回 HTML 页面', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(authRoutes, mockReq({ url: '/admin/users', user: { role: 'admin' } }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /用户管理/)
})

test('T-2：页面不含密码哈希，且调用的是已存在的后端接口', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(authRoutes, mockReq({ url: '/admin/users', user: { role: 'admin' } }))
  assert.ok(!res.body.includes('passwordHash'), '不应出现密码哈希字段名')
  for (const p of ['/api/auth/me', '/api/auth/users', '/approve']) {
    assert.ok(res.body.includes(p), `页面应调用 ${p}`)
  }
  // 后端没有删除端点 ⇒ 页面不该出现 DELETE
  assert.ok(!/method:\s*'DELETE'/.test(res.body), '不应调用 DELETE（后端无删除端点）')
  // 样式复用现有客户端样式表，不引入新框架/构建步骤
  assert.ok(res.body.includes('/app/css/main.css'), '应复用现有样式表以保持观感一致')
})

// ---- 登录成功后的落点 ----
// 原先跳 `/`，而 `/` 不是控制台入口（掉进反代兜底 ⇒ 已登录时返回内核自有前端）
// ⇒ 表现为「从登录页跳转进不去控制台」。落点必须是 SPA 入口。
test('登录页成功后跳 SPA 入口 /app#/（不再跳 `/`）', async () => {
  const { authRoutes } = makeCtx()
  const { res } = await callRoute(authRoutes, mockReq({ url: '/auth/login' }))
  assert.equal(res.statusCode, 200)
  assert.ok(res.body.includes("location.href = '/app#/'"), '登录成功后应跳 /app#/')
  assert.equal(/location\.href = '\/'/.test(res.body), false, '不应再跳 `/`')
})
