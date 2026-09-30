import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createStaticRoutes } from '../src/static-routes.js'

function makeWebRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-root-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>')
  fs.mkdirSync(path.join(root, 'css'), { recursive: true })
  fs.writeFileSync(path.join(root, 'css', 'main.css'), 'body{}')
  fs.mkdirSync(path.join(root, 'js'), { recursive: true })
  fs.writeFileSync(path.join(root, 'js', 'app.js'), 'const x = 1')
  fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg></svg>')
  fs.mkdirSync(path.join(root, 'auth'), { recursive: true })
  fs.writeFileSync(path.join(root, 'auth', 'login.html'), '<title>login</title>')
  return root
}

function mockReq({ method = 'GET', url = '/', user = null } = {}) {
  const r = new EventEmitter()
  r.method = method
  r.url = url
  r.user = user
  return r
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers) },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.ended = true },
  }
}

async function call(staticRoutes, req) {
  const matched = staticRoutes.match(req)
  assert.ok(matched, `路由未匹配: ${req.method} ${req.url}`)
  req.params = matched.params
  const res = mockRes()
  await Promise.resolve(matched.handler(req, res))
  return res
}

const user = { id: 'u1', role: 'user' }

test('GET /app → index.html', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app', user }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.ok(Buffer.concat(res.chunks).toString('utf8').includes('app'))
})

test('GET /app/ → index.html', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/', user }))
  assert.equal(res.statusCode, 200)
})

// `/` 曾经没有任何路由 ⇒ 掉进「认证后反代」兜底，已登录时返回的是**内核自有前端**而不是
// 控制台 SPA（登录页成功跳转就指向 `/`）⇒ 表现为「登录后进不去控制台」。
test('GET / → 302 到 SPA 入口 /app#/（不再落进反代兜底）', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/', user }))
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/app#/')
  assert.equal(Buffer.concat(res.chunks).length, 0)
})

test('`/` 属于静态路由且**需要认证**（未登录仍走 302 /auth/login）', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  assert.equal(routes.isStaticRoute('/'), true)
  assert.equal(routes.match(mockReq({ url: '/' })).public, false)
})

test('GET /app/css/main.css → css 文件 + 正确 content-type', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/css/main.css', user }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/css/)
})

test('GET /app/js/app.js → application/javascript', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/js/app.js', user }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /application\/javascript/)
})

test('GET /app/favicon.svg → image/svg+xml', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/favicon.svg', user }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /image\/svg\+xml/)
})

test('静态资源 public 标志：非 HTML 公开，HTML 入口保护', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  assert.equal(routes.match(mockReq({ url: '/app/js/app.js' })).public, true)
  assert.equal(routes.match(mockReq({ url: '/app/css/main.css' })).public, true)
  assert.equal(routes.match(mockReq({ url: '/app/favicon.svg' })).public, true)
  assert.equal(routes.match(mockReq({ url: '/app' })).public, false)
  assert.equal(routes.match(mockReq({ url: '/auth/login' })).public, true)
})

test('GET /app 未知深层路径回退 index.html（SPA 路由）', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/workspace/ws_abcd1234', user }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.ok(Buffer.concat(res.chunks).toString('utf8').includes('app'))
})

test('GET /auth/login → auth/login.html', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/auth/login' }))
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.ok(Buffer.concat(res.chunks).toString('utf8').includes('login'))
})

test('目录遍历请求被拒绝（400）', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/../../index.js', user }))
  assert.equal(res.statusCode, 400)
})

test('请求真实存在但越界的 ../ 路径返回 400', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'secret')
  const res = await call(routes, mockReq({ url: '/app/../secret.txt', user }))
  assert.equal(res.statusCode, 400)
})

test('非 GET 方法不匹配', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  assert.equal(routes.match(mockReq({ method: 'POST', url: '/app', user })), null)
})

test('isStaticRoute 判断', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  assert.equal(routes.isStaticRoute('/app'), true)
  assert.equal(routes.isStaticRoute('/app/css/main.css'), true)
  assert.equal(routes.isStaticRoute('/auth/login'), true)
  assert.equal(routes.isStaticRoute('/api/auth/me'), false)
  assert.equal(routes.isStaticRoute('/workspaces/x'), false)
})

test('symbolic link 目标拒绝（不跟随）', async () => {
  const root = makeWebRoot()
  const outside = path.join(path.dirname(root), 'outside-' + process.pid)
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'x.js'), 'x')
  try {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction')
  } catch {
    fs.symlinkSync(outside, path.join(root, 'link'), 'dir')
  }
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/link/x.js', user }))
  assert.equal(res.statusCode, 400)
})

test('静态资源返回 no-cache，避免升级后浏览器仍用旧前端逻辑', async () => {
  const root = makeWebRoot()
  const routes = createStaticRoutes({ webRoot: root })
  const res = await call(routes, mockReq({ url: '/app/js/app.js', user }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-cache')
})
