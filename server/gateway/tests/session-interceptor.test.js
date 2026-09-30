import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEnvelope,
  extractRequest,
  classifyMethod,
  extractSessionId,
  filterItems,
  buildDeniedEnvelope,
  isAdmin,
  handleSessionRequest,
} from '../src/session-interceptor.js'

function makeOwnerStore(initial = {}) {
  const map = { ...initial }
  const calls = { setOwner: [] }
  return {
    calls,
    getOwner: (id) => (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null),
    setOwner(id, userId) {
      calls.setOwner.push({ id, userId })
      map[id] = userId
    },
  }
}

function makeUpstream(responseBody, response = {}) {
  const calls = []
  const upstream = async (buf) => {
    calls.push(buf)
    return {
      statusCode: response.statusCode ?? 200,
      headers: response.headers ?? {},
      body: Buffer.isBuffer(responseBody)
        ? responseBody
        : Buffer.from(JSON.stringify(responseBody)),
    }
  }
  return { upstream, calls }
}

function makeAudit() {
  const events = []
  return {
    events,
    audit(action, details) {
      events.push({ action, details })
    },
  }
}

function requestBuffer(method, payload = {}, rpcId = 'rpc-1') {
  return Buffer.from(JSON.stringify({ type: 'client-request', rpcId, method, payload }))
}

function serverEnvelope(value, rpcId = 'rpc-1') {
  return { type: 'server-response', rpcId, result: { value } }
}

function errorEnvelope(error, rpcId = 'rpc-1') {
  return { type: 'server-response', rpcId, result: { error } }
}

test('parseEnvelope: 合法 Buffer 返回 ok 与 envelope/payload', () => {
  const buf = requestBuffer('session.history', { sessionId: 's_1' })
  const r = parseEnvelope(buf)
  assert.equal(r.ok, true)
  assert.equal(r.envelope.method, 'session.history')
  assert.deepEqual(r.payload, { sessionId: 's_1' })
})

test('parseEnvelope: 支持字符串输入', () => {
  const r = parseEnvelope(JSON.stringify({ type: 'client-request', method: 'session.list' }))
  assert.equal(r.ok, true)
  assert.equal(r.envelope.method, 'session.list')
  assert.deepEqual(r.payload, {})
})

test('parseEnvelope: payload 缺失时归一化为 {}', () => {
  const r = parseEnvelope(Buffer.from(JSON.stringify({ type: 'client-request', method: 'session.list' })))
  assert.equal(r.ok, true)
  assert.deepEqual(r.payload, {})
})

test('parseEnvelope: 非法 JSON 返回 { ok:false }', () => {
  assert.deepEqual(parseEnvelope(Buffer.from('{坏')), { ok: false })
  assert.deepEqual(parseEnvelope('not json'), { ok: false })
})

test('classifyMethod: create/fork 归为 create', () => {
  assert.equal(classifyMethod('session.create'), 'create')
  assert.equal(classifyMethod('session.fork'), 'create')
})

test('classifyMethod: list/search 归为 list', () => {
  assert.equal(classifyMethod('session.list'), 'list')
  assert.equal(classifyMethod('session.search'), 'list')
})

test('classifyMethod: 其余 session 方法归为 operation', () => {
  for (const m of [
    'session.history',
    'session.models',
    'session.selectModel',
    'session.rename',
    'session.prompt',
    'session.attachment',
    'session.updateQueue',
    'session.cancel',
  ]) {
    assert.equal(classifyMethod(m), 'operation')
  }
})

test('classifyMethod: 非 session 方法返回 null', () => {
  assert.equal(classifyMethod('workspace.read'), null)
  assert.equal(classifyMethod(undefined), null)
})

test('extractSessionId: 返回非空字符串 sessionId', () => {
  assert.equal(extractSessionId({ sessionId: 's_1' }), 's_1')
})

test('extractSessionId: 缺失或非字符串时返回 null', () => {
  assert.equal(extractSessionId({}), null)
  assert.equal(extractSessionId({ sessionId: '' }), null)
  assert.equal(extractSessionId({ sessionId: '   ' }), null)
  assert.equal(extractSessionId({ sessionId: 42 }), null)
  assert.equal(extractSessionId(null), null)
})

test('extractRequest: 从 typert args 中取出业务请求对象', () => {
  const payload = { args: { request: { sessionId: 's_1', title: 't' } } }
  assert.deepEqual(extractRequest(payload), { sessionId: 's_1', title: 't' })
})

test('extractRequest: 支持 list 形参名 _request', () => {
  const payload = { args: { _request: {} } }
  assert.deepEqual(extractRequest(payload), {})
})

test('extractRequest: 无 args 时回退到平铺 payload（兼容旧协议）', () => {
  assert.deepEqual(extractRequest({ sessionId: 's_1' }), { sessionId: 's_1' })
})

test('extractSessionId: 从 typert 嵌套 args 提取 sessionId', () => {
  const payload = { args: { request: { sessionId: 's_deep' } } }
  assert.equal(extractSessionId(payload), 's_deep')
})

// ---- T-1：(B) 类方法（会话标识在 request.address 里）----

test('extractSessionId: (B) 类 session.page/follow 从 address.sessionId 取值', () => {
  for (const method of ['session.page', 'session.follow']) {
    assert.equal(
      extractSessionId({ args: { request: { address: { kind: 'session', sessionId: 's_addr' } } } }, method),
      's_addr',
      method,
    )
  }
})

test('extractSessionId: (B) 类子代理地址退到 address.parentSessionId', () => {
  const payload = {
    args: {
      request: {
        address: { kind: 'subagent', parentSessionId: 's_par', childSessionId: 's_child', mode: 'one-shot' },
      },
    },
  }
  assert.equal(extractSessionId(payload, 'session.page'), 's_par')
  assert.equal(extractSessionId(payload, 'session.follow'), 's_par')
})

test('extractSessionId: (B) 类 address 里无会话标识时返回 null', () => {
  const payload = { args: { request: { address: { kind: 'session' } } } }
  assert.equal(extractSessionId(payload, 'session.page'), null)
  assert.equal(extractSessionId(payload, 'session.follow'), null)
})

test('extractSessionId: 顶层 sessionId 优先于 address.sessionId（(A) 行为不变）', () => {
  const payload = { args: { request: { sessionId: 's_top', address: { sessionId: 's_addr' } } } }
  assert.equal(extractSessionId(payload, 'session.page'), 's_top')
})

test('extractSessionId: 未传 method 时不解析 address（旧调用点行为不变）', () => {
  const payload = { args: { request: { address: { kind: 'session', sessionId: 's_addr' } } } }
  assert.equal(extractSessionId(payload), null)
})

test('extractSessionId: 非 (B) 类方法不解析 address', () => {
  const payload = { args: { request: { address: { kind: 'session', sessionId: 's_addr' } } } }
  assert.equal(extractSessionId(payload, 'session.rename'), null)
  assert.equal(extractSessionId(payload, 'session.modelCatalog'), null)
})

test('buildDeniedEnvelope: 形状与中文错误消息正确', () => {
  const env = buildDeniedEnvelope('rpc-9')
  assert.deepEqual(env, {
    type: 'server-response',
    rpcId: 'rpc-9',
    result: {
      error: { code: 'SESSION_ACCESS_DENIED', message: '无权访问该会话' },
    },
  })
})

test('isAdmin: role 为 admin 时为 true，其余 false', () => {
  assert.equal(isAdmin({ id: 'u_admin', role: 'admin' }), true)
  assert.equal(isAdmin({ id: 'u_1', role: 'user' }), false)
  assert.equal(isAdmin({ id: 'u_1' }), false)
})

test('filterItems: 非 admin 只保留本人拥有的会话', () => {
  const store = makeOwnerStore({ s_a: 'u_1', s_b: 'u_2', s_c: 'u_1' })
  const envelope = serverEnvelope({
    items: [{ sessionId: 's_a' }, { sessionId: 's_b' }, { sessionId: 's_c' }],
  })
  const filtered = filterItems(envelope, 'u_1', store)
  assert.deepEqual(filtered.map((i) => i.sessionId), ['s_a', 's_c'])
})

test('filterItems: 返回纯数组且不修改原信封', () => {
  const store = makeOwnerStore({ s_a: 'u_1', s_b: 'u_2' })
  const envelope = serverEnvelope({ items: [{ sessionId: 's_a' }, { sessionId: 's_b' }] })
  const filtered = filterItems(envelope, 'u_1', store)
  filtered.push({ sessionId: 'hacked' })
  assert.equal(envelope.result.value.items.length, 2)
  assert.deepEqual(envelope.result.value.items.map((i) => i.sessionId), ['s_a', 's_b'])
})

test('handle: create 成功后登记归属并审计、原样返回上游字节', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ sessionId: 's_new' })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.create',
    requestBuffer: requestBuffer('session.create', { name: 'n' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(store.getOwner('s_new'), 'u_1')
  assert.deepEqual(store.calls.setOwner, [{ id: 's_new', userId: 'u_1' }])
  assert.equal(events[0].action, 'session.ownership_created')
  assert.deepEqual(events[0].details, { method: 'session.create', sessionId: 's_new', owner: 'u_1' })
  assert.equal(res.body, responseBuf)
  assert.equal(res.statusCode, 200)
})

test('handle: create 上游返回 result.error 时不登记', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const errBody = Buffer.from(JSON.stringify(errorEnvelope({ code: 'BOOM', message: '炸了' })))
  const { upstream, calls } = makeUpstream(errBody)

  const res = await handleSessionRequest({
    method: 'session.create',
    requestBuffer: requestBuffer('session.create', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(store.calls.setOwner, [])
  assert.equal(events.length, 0)
  assert.equal(res.body, errBody)
})

test('handle: create 上游 statusCode>=400 时不登记', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const body = Buffer.from(JSON.stringify(serverEnvelope({ sessionId: 's_x' })))
  const { upstream } = makeUpstream(body, { statusCode: 500 })

  const res = await handleSessionRequest({
    method: 'session.create',
    requestBuffer: requestBuffer('session.create', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.deepEqual(store.calls.setOwner, [])
  assert.equal(events.length, 0)
  assert.equal(res.statusCode, 500)
})

test('handle: fork 源会话属于他人时返回 403 且不调 upstream', async () => {
  const store = makeOwnerStore({ s_src: 'u_2' })
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ sessionId: 's_child' }))

  const res = await handleSessionRequest({
    method: 'session.fork',
    requestBuffer: requestBuffer('session.fork', { sessionId: 's_src', atSeq: 3 }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.ok(Buffer.isBuffer(res.body))
  assert.deepEqual(JSON.parse(res.body.toString()), buildDeniedEnvelope('rpc-1'))
  assert.deepEqual(store.calls.setOwner, [])
  assert.equal(events[0].action, 'session.access_denied')
  assert.equal(events[0].details.method, 'session.fork')
  assert.equal(events[0].details.sessionId, 's_src')
})

test('handle: fork 源会话无主（owner 为 null）也返回 403', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ sessionId: 's_child' }))

  const res = await handleSessionRequest({
    method: 'session.fork',
    requestBuffer: requestBuffer('session.fork', { sessionId: 's_orphan' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body.toString()), buildDeniedEnvelope('rpc-1'))
  assert.equal(events[0].action, 'session.access_denied')
})

test('handle: fork 源会话属于本人时成功并登记子会话', async () => {
  const store = makeOwnerStore({ s_src: 'u_1' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ sessionId: 's_child' })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.fork',
    requestBuffer: requestBuffer('session.fork', { sessionId: 's_src' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(store.getOwner('s_child'), 'u_1')
  assert.deepEqual(store.calls.setOwner, [{ id: 's_child', userId: 'u_1' }])
  assert.equal(events[0].action, 'session.ownership_created')
  assert.equal(events[0].details.method, 'session.fork')
  assert.equal(res.body, responseBuf)
})

test('handle: admin fork 绕过源校验但仍登记子会话', async () => {
  const store = makeOwnerStore({ s_src: 'u_2' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ sessionId: 's_child' })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.fork',
    requestBuffer: requestBuffer('session.fork', { sessionId: 's_src' }),
    user: { id: 'u_admin', role: 'admin' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(store.getOwner('s_child'), 'u_admin')
  assert.equal(events[0].action, 'session.ownership_created')
  assert.equal(res.body, responseBuf)
})

test('handle: list 非 admin 过滤掉他人会话并审计 before/after', async () => {
  const store = makeOwnerStore({ s_a: 'u_1', s_b: 'u_2' })
  const { events, audit } = makeAudit()
  const upstreamBody = Buffer.from(
    JSON.stringify(serverEnvelope({ items: [{ sessionId: 's_a' }, { sessionId: 's_b' }] })),
  )
  const { upstream, calls } = makeUpstream(upstreamBody)

  const res = await handleSessionRequest({
    method: 'session.list',
    requestBuffer: requestBuffer('session.list', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.ok(Buffer.isBuffer(res.body))
  const parsed = JSON.parse(res.body.toString())
  assert.deepEqual(parsed.result.value.items.map((i) => i.sessionId), ['s_a'])
  assert.equal(events[0].action, 'session.list_filtered')
  assert.deepEqual(events[0].details, { before: 2, after: 1, userId: 'u_1' })
  const original = JSON.parse(upstreamBody.toString())
  assert.equal(original.result.value.items.length, 2)
})

test('handle: list admin 不过滤、原样返回', async () => {
  const store = makeOwnerStore({ s_a: 'u_1', s_b: 'u_2' })
  const { events, audit } = makeAudit()
  const upstreamBody = Buffer.from(
    JSON.stringify(serverEnvelope({ items: [{ sessionId: 's_a' }, { sessionId: 's_b' }] })),
  )
  const { upstream } = makeUpstream(upstreamBody)

  const res = await handleSessionRequest({
    method: 'session.list',
    requestBuffer: requestBuffer('session.list', {}),
    user: { id: 'u_admin', role: 'admin' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(res.body, upstreamBody)
  assert.equal(events.length, 0)
})

test('handle: search 非 admin 过滤并保留 hasMore', async () => {
  const store = makeOwnerStore({ s_a: 'u_1', s_b: 'u_2' })
  const { events, audit } = makeAudit()
  const upstreamBody = Buffer.from(
    JSON.stringify(
      serverEnvelope({
        items: [{ sessionId: 's_a', snippet: 'a' }, { sessionId: 's_b', snippet: 'b' }],
        hasMore: true,
      }),
    ),
  )
  const { upstream } = makeUpstream(upstreamBody)

  const res = await handleSessionRequest({
    method: 'session.search',
    requestBuffer: requestBuffer('session.search', { q: 'x' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  const parsed = JSON.parse(res.body.toString())
  assert.deepEqual(parsed.result.value.items.map((i) => i.sessionId), ['s_a'])
  assert.equal(parsed.result.value.hasMore, true)
  assert.equal(events[0].action, 'session.list_filtered')
})

test('handle: list 上游 result.error 时原样返回不过滤', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const errBody = Buffer.from(JSON.stringify(errorEnvelope({ code: 'X', message: '错' })))
  const { upstream } = makeUpstream(errBody)

  const res = await handleSessionRequest({
    method: 'session.list',
    requestBuffer: requestBuffer('session.list', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(res.body, errBody)
  assert.equal(events.length, 0)
})

test('handle: operation 他人会话返回 403 且不转发', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ ok: true }))

  const res = await handleSessionRequest({
    method: 'session.history',
    requestBuffer: requestBuffer('session.history', { sessionId: 's_1' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body.toString()), buildDeniedEnvelope('rpc-1'))
  assert.equal(events[0].action, 'session.access_denied')
  assert.equal(events[0].details.sessionId, 's_1')
  assert.equal(events[0].details.method, 'session.history')
})

test('handle: operation owner 为 null 也返回 403', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ ok: true }))

  const res = await handleSessionRequest({
    method: 'session.cancel',
    requestBuffer: requestBuffer('session.cancel', { sessionId: 's_orphan' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.equal(events[0].action, 'session.access_denied')
})

test('handle: operation 本人会话放行并原样转发返回', async () => {
  const store = makeOwnerStore({ s_1: 'u_1' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ events: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.history',
    requestBuffer: requestBuffer('session.history', { sessionId: 's_1' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: operation 无法解析 sessionId 时 fail-open 转发，但留审计', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ ok: true })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.rename',
    requestBuffer: requestBuffer('session.rename', { name: 'x' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  // T-1：原来这条分支"静默放行、无审计"，现在必须留痕（含 method + 判定理由）
  assert.equal(events.length, 1)
  assert.equal(events[0].action, 'session.operation_no_session_id')
  assert.deepEqual(events[0].details, {
    method: 'session.rename',
    userId: 'u_1',
    reason: 'no-session-identifier',
  })
})

// ---- T-1：(B) 类读路径（session.page / session.follow）现在纳入归属校验 ----

test('handle: (B) 类 session.page 读他人会话返回 403 且不转发', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ records: [] }))

  const res = await handleSessionRequest({
    method: 'session.page',
    requestBuffer: requestBuffer('session.page', {
      args: { request: { address: { kind: 'session', sessionId: 's_1' }, throughSeq: 12 } },
    }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body.toString()), buildDeniedEnvelope('rpc-1'))
  assert.equal(events[0].action, 'session.access_denied')
  assert.equal(events[0].details.method, 'session.page')
  assert.equal(events[0].details.sessionId, 's_1')
})

test('handle: (B) 类 session.follow 读无主会话也返回 403', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({}))

  const res = await handleSessionRequest({
    method: 'session.follow',
    requestBuffer: requestBuffer('session.follow', {
      args: { request: { address: { kind: 'session', sessionId: 's_orphan' } } },
    }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.equal(events[0].action, 'session.access_denied')
})

test('handle: (B) 类 session.page 子代理地址按父会话归属判定（本人放行）', async () => {
  const store = makeOwnerStore({ s_par: 'u_1' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ records: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.page',
    requestBuffer: requestBuffer('session.page', {
      args: {
        request: {
          address: { kind: 'subagent', parentSessionId: 's_par', childSessionId: 's_child', mode: 'one-shot' },
        },
      },
    }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: (B) 类 session.follow 本人会话放行并原样转发', async () => {
  const store = makeOwnerStore({ s_1: 'u_1' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ records: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.follow',
    requestBuffer: requestBuffer('session.follow', {
      args: { request: { address: { kind: 'session', sessionId: 's_1' } } },
    }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: (B) 类 admin 仍绕过归属校验（他人会话也放行）', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ records: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.page',
    requestBuffer: requestBuffer('session.page', {
      args: { request: { address: { kind: 'session', sessionId: 's_1' } } },
    }),
    user: { id: 'u_admin', role: 'admin' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

// ---- T-1.e：session.page / session.follow 的越权用例补全（"3 条断言 × 2 接口"矩阵）----
// 其中若干格早在 afca0a2（T-1 修法）已随代码入库：
//   session.page 他人=403 / session.page 子代理地址=本人放行 / session.page admin 豁免 /
//   session.follow 无主=403 / session.follow 本人=200。
// 这里补齐矩阵**尚缺**的 3 格：page 本人（kind:session）· follow 他人会话 · follow admin 豁免。

test('handle: (B) 类 session.page 本人会话（kind:session）放行并原样转发', async () => {
  const store = makeOwnerStore({ s_1: 'u_1' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ records: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.page',
    requestBuffer: requestBuffer('session.page', {
      args: { request: { address: { kind: 'session', sessionId: 's_1' } } },
    }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: (B) 类 session.follow 读他人会话返回 403 且不转发', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ records: [] }))

  const res = await handleSessionRequest({
    method: 'session.follow',
    requestBuffer: requestBuffer('session.follow', {
      args: { request: { address: { kind: 'session', sessionId: 's_1' } } },
    }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body.toString()), buildDeniedEnvelope('rpc-1'))
  assert.equal(events[0].action, 'session.access_denied')
  assert.equal(events[0].details.method, 'session.follow')
  assert.equal(events[0].details.sessionId, 's_1')
})

test('handle: (B) 类 session.follow admin 仍绕过归属校验（他人会话也放行）', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ records: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.follow',
    requestBuffer: requestBuffer('session.follow', {
      args: { request: { address: { kind: 'session', sessionId: 's_1' } } },
    }),
    user: { id: 'u_admin', role: 'admin' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

// ---- T-1：(C) 类方法仍然放行，但留审计 ----

test('handle: (C) 类 session.modelCatalog 非 admin 放行并留审计', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ providers: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.modelCatalog',
    requestBuffer: requestBuffer('session.modelCatalog', { args: {} }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, responseBuf)
  assert.equal(events[0].action, 'session.operation_no_session_id')
  assert.equal(events[0].details.method, 'session.modelCatalog')
})

test('handle: (C) 类 session.modelCatalog admin 不过审计（行为不变）', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ providers: [] })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.modelCatalog',
    requestBuffer: requestBuffer('session.modelCatalog', {}),
    user: { id: 'u_admin', role: 'admin' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: admin operation 绕过归属校验直接转发', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ ok: true })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.prompt',
    requestBuffer: requestBuffer('session.prompt', { sessionId: 's_1' }),
    user: { id: 'u_admin', role: 'admin' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: 请求解析失败时 fail-open 原样转发', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ ok: true })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.history',
    requestBuffer: Buffer.from('{坏json'),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: classifyMethod 为 null 的方法原样转发', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ ok: true })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'workspace.read',
    requestBuffer: requestBuffer('workspace.read', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: 未登记 session 方法带 sessionId 时仍校验归属（他人会话 403）', async () => {
  const store = makeOwnerStore({ s_1: 'u_2' })
  const { events, audit } = makeAudit()
  const { upstream, calls } = makeUpstream(serverEnvelope({ ok: true }))

  const res = await handleSessionRequest({
    method: 'session.delete',
    requestBuffer: requestBuffer('session.delete', { sessionId: 's_1' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 0)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body.toString()), buildDeniedEnvelope('rpc-1'))
  assert.equal(events[0].action, 'session.access_denied')
})

test('handle: 未登记 session 方法带本人 sessionId 时放行', async () => {
  const store = makeOwnerStore({ s_1: 'u_1' })
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ ok: true })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.export',
    requestBuffer: requestBuffer('session.export', { sessionId: 's_1' }),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: 未登记 session 方法且无 sessionId 时原样转发', async () => {
  const store = makeOwnerStore()
  const { events, audit } = makeAudit()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ ok: true })))
  const { upstream, calls } = makeUpstream(responseBuf)

  const res = await handleSessionRequest({
    method: 'session.stats',
    requestBuffer: requestBuffer('session.stats', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit,
  })

  assert.equal(calls.length, 1)
  assert.equal(res.body, responseBuf)
  assert.equal(events.length, 0)
})

test('handle: audit 抛错不影响主流程', async () => {
  const store = makeOwnerStore()
  const responseBuf = Buffer.from(JSON.stringify(serverEnvelope({ sessionId: 's_new' })))
  const { upstream } = makeUpstream(responseBuf)
  const badAudit = () => {
    throw new Error('审计器炸了')
  }

  const res = await handleSessionRequest({
    method: 'session.create',
    requestBuffer: requestBuffer('session.create', {}),
    user: { id: 'u_1' },
    ownerStore: store,
    upstream,
    audit: badAudit,
  })

  assert.equal(res.statusCode, 200)
  assert.equal(store.getOwner('s_new'), 'u_1')
  assert.equal(res.body, responseBuf)
})
