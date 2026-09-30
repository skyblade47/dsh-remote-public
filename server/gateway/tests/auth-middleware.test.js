import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTokenFromRequest, createAuthMiddleware } from '../src/auth-middleware.js'

function mockReq({ headers = {} } = {}) {
  return { headers, url: '/api/auth/me', method: 'GET' }
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

test('Bearer Token 优先于 Cookie', () => {
  const req = mockReq({ headers: { authorization: 'Bearer abc123', cookie: 'dsh_session=xyz' } })
  assert.equal(getTokenFromRequest(req), 'abc123')
})

test('从 Cookie 读取 dsh_session', () => {
  const req = mockReq({ headers: { cookie: 'other=1; dsh_session=xyz; last=2' } })
  assert.equal(getTokenFromRequest(req), 'xyz')
})

test('畸形百分号编码的 Cookie 不抛异常，按无凭证处理', () => {
  const req = mockReq({ headers: { cookie: 'dsh_session=%' } })
  assert.doesNotThrow(() => getTokenFromRequest(req))
  assert.equal(getTokenFromRequest(req), null)
})

test('单个畸形 Cookie 不影响同一请求里的其它 Cookie', () => {
  const req = mockReq({ headers: { cookie: 'broken=%ZZ; dsh_session=ok-token' } })
  assert.equal(getTokenFromRequest(req), 'ok-token')
})

test('无 Cookie 且无 Authorization 时返回 null', () => {
  assert.equal(getTokenFromRequest(mockReq()), null)
})

test('中间件：pending 账号返回 403 ACCOUNT_PENDING', () => {
  const authService = {
    authenticateToken: () => ({ user: { id: 'u1', role: 'pending' }, tokenId: 't1' }),
  }
  const mw = createAuthMiddleware({ authService })
  const req = mockReq({ headers: { cookie: 'dsh_session=t' } })
  const res = mockRes()
  let nexted = false
  mw(req, res, () => { nexted = true })
  assert.equal(nexted, false)
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).error.code, 'ACCOUNT_PENDING')
})

test('中间件：无效 Token 的 API 请求返回 401', () => {
  const authService = { authenticateToken: () => null }
  const mw = createAuthMiddleware({ authService })
  const res = mockRes()
  mw(mockReq({ headers: { cookie: 'dsh_session=bad' } }), res, () => {})
  assert.equal(res.statusCode, 401)
})

test('中间件：无效 Token 的页面请求 302 跳登录页', () => {
  const authService = { authenticateToken: () => null }
  const mw = createAuthMiddleware({ authService })
  const req = mockReq()
  req.url = '/app'
  const res = mockRes()
  mw(req, res, () => {})
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/auth/login')
})

test('中间件：正常账号注入 req.user 并放行', () => {
  const authService = {
    authenticateToken: () => ({ user: { id: 'u1', role: 'user' }, tokenId: 't1' }),
  }
  const mw = createAuthMiddleware({ authService })
  const req = mockReq({ headers: { cookie: 'dsh_session=t' } })
  const res = mockRes()
  let nexted = false
  mw(req, res, () => { nexted = true })
  assert.equal(nexted, true)
  assert.equal(req.user.id, 'u1')
  assert.equal(req.tokenId, 't1')
})
