import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  rewriteHeaders,
  createProxyHandler,
  isSessionRpc,
  sessionMethodFromUrl,
} from '../src/proxy.js'

const UPSTREAM = { hostname: '127.0.0.1', port: 3080 }

test('Host 被改写为上游回环地址', () => {
  const h = rewriteHeaders({ host: 'dsh.example:8080' }, UPSTREAM)
  assert.equal(h.host, '127.0.0.1:3080')
})

test('Origin 被剥离', () => {
  const h = rewriteHeaders({ host: 'x', origin: 'http://x:8080' }, UPSTREAM)
  assert.equal(h.origin, undefined)
})

test('其它头部原样保留', () => {
  const h = rewriteHeaders({ host: 'x', 'content-type': 'application/json', 'x-custom': 'v' }, UPSTREAM)
  assert.equal(h['content-type'], 'application/json')
  assert.equal(h['x-custom'], 'v')
})

test('代理转发请求体并把响应回传', async () => {
  const upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ host: req.headers.host, body }))
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upPort = upstream.address().port

  const gateway = http.createServer(
    createProxyHandler({ hostname: '127.0.0.1', port: upPort }),
  )
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
  const gwPort = gateway.address().port

  const res = await fetch(`http://127.0.0.1:${gwPort}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })
  const payload = await res.json()

  assert.equal(res.status, 200)
  assert.equal(payload.host, `127.0.0.1:${upPort}`)
  assert.equal(payload.body, '{"hello":"world"}')

  gateway.close()
  upstream.close()
})

test('isSessionRpc: 识别 typert slash endpoint', () => {
  assert.equal(isSessionRpc('/api/session/list', 'POST'), true)
  assert.equal(isSessionRpc('/api/session/create', 'POST'), true)
  assert.equal(isSessionRpc('/api/session/list?x=1', 'POST'), true)
})

test('isSessionRpc: 兼容历史点分形态', () => {
  assert.equal(isSessionRpc('/api/session.list', 'POST'), true)
})

test('isSessionRpc: 非会话路径或非 POST 返回 false', () => {
  assert.equal(isSessionRpc('/api/session/', 'POST'), false)
  assert.equal(isSessionRpc('/api/session/list', 'GET'), false)
  assert.equal(isSessionRpc('/api/plugins', 'POST'), false)
})

test('sessionMethodFromUrl: slash endpoint 归一化为点分方法名', () => {
  assert.equal(sessionMethodFromUrl('/api/session/list'), 'session.list')
  assert.equal(sessionMethodFromUrl('/api/session/create?y=2'), 'session.create')
})

test('sessionMethodFromUrl: 点分形态原样提取', () => {
  assert.equal(sessionMethodFromUrl('/api/session.list'), 'session.list')
})

test('会话 RPC 转发时剥离 accept-encoding 且按归属过滤', async () => {
  let seenAcceptEncoding = 'untouched'
  const upstream = http.createServer((req, res) => {
    seenAcceptEncoding = req.headers['accept-encoding']
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const rpcId = JSON.parse(raw).rpcId
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'server-response',
        rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'session-other' },
              { sessionId: 'session-own' },
            ],
          },
        },
      }))
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upPort = upstream.address().port

  const ownerStore = {
    getOwner: (id) => (id === 'session-own' ? 'user-1' : null),
    setOwner: () => {},
  }
  const gateway = http.createServer(
    createProxyHandler(
      { hostname: '127.0.0.1', port: upPort },
      () => {},
      null,
      ownerStore,
    ),
  )
  gateway.on('request', (req) => {
    req.user = { id: 'user-1', role: 'user' }
  })
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
  const gwPort = gateway.address().port

  const res = await fetch(`http://127.0.0.1:${gwPort}/api/session/list`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept-encoding': 'gzip, br',
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session/list',
      payload: { args: { _request: {} } },
    }),
  })
  const env = await res.json()

  assert.equal(seenAcceptEncoding, undefined)
  assert.deepEqual(
    env.result.value.items.map((i) => i.sessionId),
    ['session-own'],
  )

  gateway.close()
  upstream.close()
})

test('上游不可用时返回 502 与统一错误结构', async () => {
  const gateway = http.createServer(
    createProxyHandler({ hostname: '127.0.0.1', port: 1 }),
  )
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
  const gwPort = gateway.address().port

  const res = await fetch(`http://127.0.0.1:${gwPort}/api/echo`, { method: 'POST' })
  assert.equal(res.status, 502)
  const payload = await res.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'UPSTREAM_UNAVAILABLE')

  gateway.close()
})

// ---- 会话 RPC 识别必须防路径变形（否则归属校验会被绕过）----

test('isSessionRpc: 识别标准 slash 形态', () => {
  assert.equal(isSessionRpc('/api/session/list', 'POST'), true)
  assert.equal(isSessionRpc('/api/session/history?x=1', 'POST'), true)
  assert.equal(isSessionRpc('/api/session.list', 'POST'), true)
})

test('isSessionRpc: 拒绝非 POST 与非会话路径', () => {
  assert.equal(isSessionRpc('/api/session/list', 'GET'), false)
  assert.equal(isSessionRpc('/api/workspaces', 'POST'), false)
  assert.equal(isSessionRpc('/api/session/', 'POST'), false)
})

test('isSessionRpc: 折叠重复斜杠绕过被识别', () => {
  assert.equal(isSessionRpc('/api//session/list', 'POST'), true)
  assert.equal(isSessionRpc('/api/session//list', 'POST'), true)
})

test('isSessionRpc: 百分号编码绕过被识别', () => {
  assert.equal(isSessionRpc('/api/%73ession/list', 'POST'), true)
  assert.equal(isSessionRpc('/api/session%2Flist', 'POST'), true)
})

test('isSessionRpc: 无法解码时保守视为会话 RPC', () => {
  assert.equal(isSessionRpc('/api/session/%ZZ', 'POST'), true)
})

test('sessionMethodFromUrl: 归一化后返回点分方法名', () => {
  assert.equal(sessionMethodFromUrl('/api/session/list'), 'session.list')
  assert.equal(sessionMethodFromUrl('/api/session/history?a=1'), 'session.history')
  assert.equal(sessionMethodFromUrl('/api//session/list'), 'session.list')
  assert.equal(sessionMethodFromUrl('/api/%73ession/rename'), 'session.rename')
})
