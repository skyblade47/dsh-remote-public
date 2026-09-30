// HTTP 反向代理。设计要点：
// 1) Host 改写为上游回环地址，以通过内核的 Host 围栏（见 docs/spikes Z1）
// 2) 剥离 Origin，避免"Origin 与 Host 不等"被拒（同上）
// 3) 注入 dsh-auth cookie，让内核认可以网关身份转发的请求
// 4) 不在本模块读配置，upstream 由调用方注入，便于单测
import http from 'node:http'
import { handleSessionRequest } from './session-interceptor.js'

export function rewriteHeaders(headers, upstream) {
  const out = { ...headers }
  out.host = `${upstream.hostname}:${upstream.port}`
  delete out.origin
  return out
}

function injectDshAuth(headers, dshAuthCookie) {
  if (!dshAuthCookie) return headers
  const out = { ...headers }
  const existing = out.cookie ? out.cookie + '; ' : ''
  out.cookie = existing + dshAuthCookie
  return out
}

// 会话拦截器必须以明文 JSON 解析上游响应；若放行 accept-encoding，
// 内核会返回 gzip/br 压缩体，导致解析失败后 fail-open（隔离被绕过）。
function stripAcceptEncoding(headers) {
  const out = { ...headers }
  delete out['accept-encoding']
  return out
}

// 会话 RPC 走 typert slash endpoint：/api/session/<method>。
// 兼容历史点分形态 /api/session.<method>。
// 先归一化路径（解码百分号编码 + 折叠重复斜杠），否则 /api/%73ession/list
// 或 /api//session/list 这类写法会绕过拦截器，使归属校验被跳过。
// ⚠️ 已导出：WS 侧的归属判定（`ws-ownership.js`）**复用同一套归一化**，
//    避免两套口径分叉（同类教训见 §8 U-33 的 `safeResolve` 反斜杠问题）。
export function normalizedPath(url) {
  const raw = url.split('?')[0]
  try {
    return decodeURIComponent(raw).replace(/\/{2,}/g, '/')
  } catch {
    return null
  }
}

export function isSessionRpc(url, method) {
  if (typeof url !== 'string' || method !== 'POST') return false
  const pathOnly = normalizedPath(url)
  // 无法解码时保守按会话 RPC 处理，交给拦截器按 fail-closed 判定
  if (pathOnly === null) return true
  if (pathOnly.startsWith('/api/session/') && pathOnly.length > '/api/session/'.length) return true
  return pathOnly.startsWith('/api/session.') && pathOnly.length > '/api/session.'.length
}

// 从 URL 提取点分方法名（session.list），供 classifyMethod 使用。
export function sessionMethodFromUrl(url) {
  const pathOnly = normalizedPath(url)
  if (pathOnly === null) return ''
  if (pathOnly.startsWith('/api/session/')) {
    return 'session.' + pathOnly.slice('/api/session/'.length)
  }
  return pathOnly.slice('/api/'.length)
}

// 会话 RPC 请求体上限：正常 prompt/附件远小于此值，避免超大 body 打满内存。
const MAX_REQUEST_BYTES = 16 * 1024 * 1024

function bufferRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_REQUEST_BYTES) {
        const e = new Error('请求体过大')
        e.code = 'PAYLOAD_TOO_LARGE'
        req.resume()
        reject(e)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendUpstream({ upstream, log, dshAuth, req, body }) {
  const dshAuthCookie = dshAuth ? dshAuth.generate() : null
  const headers = stripAcceptEncoding(
    injectDshAuth(rewriteHeaders(req.headers, upstream), dshAuthCookie),
  )
  if (body) headers['content-length'] = String(body.length)
  return new Promise((resolve) => {
    const proxied = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (up) => {
        const chunks = []
        up.on('data', (c) => chunks.push(c))
        up.on('end', () =>
          resolve({ statusCode: up.statusCode ?? 502, headers: up.headers, body: Buffer.concat(chunks) }),
        )
        up.on('error', (err) => {
          log(`upstream read error: ${err.message}`)
          resolve({ statusCode: 502, headers: {}, body: Buffer.alloc(0) })
        })
      },
    )
    proxied.on('error', (err) => {
      log(`upstream error: ${err.message}`)
      resolve({
        statusCode: 502,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: err.message } }),
        ),
      })
    })
    proxied.end(body)
  })
}

function writeUpstreamResponse(res, result) {
  const headers = { ...result.headers }
  delete headers['transfer-encoding']
  headers['content-length'] = String(result.body.length)
  res.writeHead(result.statusCode, headers)
  res.end(result.body)
}

export function createProxyHandler(
  upstream,
  log = () => {},
  dshAuth = null,
  sessionOwnerStore = null,
  audit = null,
) {
  return async function handle(req, res) {
    if (sessionOwnerStore && isSessionRpc(req.url, req.method)) {
      let requestBuffer
      try {
        requestBuffer = await bufferRequest(req)
      } catch (err) {
        log(`request read error: ${err.message}`)
        if (!res.headersSent) {
          const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: err.code || 'BAD_REQUEST', message: err.message } }))
        }
        return
      }

      const rpcMethod = sessionMethodFromUrl(req.url)
      const result = await handleSessionRequest({
        method: rpcMethod,
        requestBuffer,
        user: req.user,
        ownerStore: sessionOwnerStore,
        upstream: (body) => sendUpstream({ upstream, log, dshAuth, req, body }),
        audit: audit ? (action, data) => audit.log(action, data) : null,
      })
      writeUpstreamResponse(res, result)
      return
    }

    const dshAuthCookie = dshAuth ? dshAuth.generate() : null
    const proxied = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: injectDshAuth(rewriteHeaders(req.headers, upstream), dshAuthCookie),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )

    proxied.on('error', (err) => {
      log(`upstream error: ${err.message}`)
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'UPSTREAM_UNAVAILABLE', message: err.message },
        }),
      )
    })

    req.pipe(proxied)
  }
}
