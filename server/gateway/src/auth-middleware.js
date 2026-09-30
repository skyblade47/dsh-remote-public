// 认证中间件：从 Cookie 或 Authorization Bearer 解析凭证。
// Cookie 名：dsh_session（值为设备 token 明文）
// Header：Authorization: Bearer <token>
// 解析成功 → req.user, req.tokenId
// 解析失败 → 返回 401（页面路由则 302 跳 /auth/login）

function readCookies(req) {
  const header = req.headers.cookie
  if (!header) return {}
  const out = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const raw = part.slice(eq + 1).trim()
    // 畸形百分号编码（如 "%"）不能让整个请求抛异常，按无效 Cookie 处理。
    let v = raw
    try {
      v = decodeURIComponent(raw)
    } catch {
      continue
    }
    out[k] = v
  }
  return out
}

export function getTokenFromRequest(req) {
  // 1. Authorization: Bearer
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7)
  }
  // 2. Cookie: dsh_session
  const cookies = readCookies(req)
  if (cookies.dsh_session) return cookies.dsh_session
  return null
}

export function createAuthMiddleware({ authService }) {
  return function authMiddleware(req, res, next) {
    const token = getTokenFromRequest(req)
    if (!token) {
      return reject(req, res, 'NO_TOKEN')
    }
    const result = authService.authenticateToken(token)
    if (!result) {
      return reject(req, res, 'INVALID_TOKEN')
    }
    // pending 账号不允许访问业务接口
    if (result.user.role === 'pending') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'ACCOUNT_PENDING', message: '账号待审批' } }))
      return
    }
    req.user = result.user
    req.tokenId = result.tokenId
    next()
  }
}

function reject(req, res, code) {
  // 页面路由（非 /api/*）跳登录页
  const url = req.url || '/'
  const isApi = url.startsWith('/api/')
  const isWebSocket = req.headers.upgrade
  if (!isApi && !isWebSocket) {
    res.writeHead(302, { location: '/auth/login' })
    res.end()
    return
  }
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: code } }))
}
