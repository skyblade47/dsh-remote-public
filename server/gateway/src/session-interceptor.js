function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseEnvelope(buf) {
  try {
    const text = typeof buf === 'string' ? buf : buf.toString('utf8')
    const envelope = JSON.parse(text)
    return { ok: true, envelope, payload: envelope.payload ?? {} }
  } catch {
    return { ok: false }
  }
}

// typert 协议把业务参数放在 payload.args.<形参名> 下（值为对象）。
// 历史协议直接平铺在 payload 上。这里统一取出“请求对象”。
export function extractRequest(payload) {
  if (!payload || typeof payload !== 'object') return null
  const args = payload.args
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of Object.keys(args)) {
      const value = args[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    }
    return null
  }
  return payload
}

export function classifyMethod(method) {
  if (method === 'session.create' || method === 'session.fork') return 'create'
  if (method === 'session.list' || method === 'session.search') return 'list'
  if (
    method === 'session.page' ||
    method === 'session.follow' ||
    method === 'session.history' ||
    method === 'session.models' ||
    method === 'session.modelCatalog' ||
    method === 'session.selectModel' ||
    method === 'session.rename' ||
    method === 'session.prompt' ||
    method === 'session.attachment' ||
    method === 'session.updateQueue' ||
    method === 'session.cancel'
  ) {
    return 'operation'
  }
  return null
}

// ---- 会话归属校验的「按方法分组」（留档，依据内核 typert.host.js 的参数 schema）----
//
// 依据来源：`@deepseek-ai/dsh-api-session-controller/lib/typert.host.js` 里
// `sessionController` 的 `@Remote` 方法注册表与各 `..._parameter_0$schema`。
// 三种分组决定"提不提得到会话 id"，也就决定归属校验是否覆盖该 RPC：
//
// (A) 顶层带 `sessionId` —— 现有校验已覆盖（`extractRequest` → `request.sessionId`）：
//     `session.fork`（源会话）/ `session.rename` / `session.prompt` / `session.attachment`
//     / `session.updateQueue` / `session.cancel` / `session.selectModel`
//     依据：这些方法的 parameter schema 顶层都是 `{ sessionId, ... }`。
//
// (B) 会话标识在 `request.address` 里 —— **本轮新增覆盖**：
//     `session.page` / `session.follow`
//     依据：两者的 parameter schema 只有 `address`（SessionAddress 联合）：
//       { kind:'session',  sessionId }                                        ← 普通会话
//       { kind:'subagent', parentSessionId, childSessionId, mode }            ← 子代理
//     ⇒ 取 `address.sessionId`；子代理地址退到 `address.parentSessionId`
//       （子代理归属随父会话，其自身通常没有独立归属记录）。
//
// (C) 本来就不带会话标识 —— **明确豁免**（仍放行，但写审计；见 handleOperation）：
//     `session.modelCatalog`（无参数，目录类）/ `session.control`（无参数，host 级流）
//     / `session.canOpenWorkspacePath`（无参数）/ `session.openWorkspacePath`（参数只有 `path`）
//     依据：这四者不携带任何会话标识，"按会话做归属校验"既不可能也不需要。
//     ⚠️ 后三个未登记在 classifyMethod 里，会走"未登记方法"分支直接放行，不会进本函数。
//
// ⚠️ 另：`session.list` / `session.search` 本就不按某个会话操作，走 `filterItems` 过滤（非 403）。
const ADDRESS_SESSION_METHODS = new Set(['session.page', 'session.follow'])

// 提取请求所属的会话 id。
// 顶层 `sessionId` 优先（(A) 类，行为不变）；仅对 (B) 类方法再解析 `request.address`。
// 第二个参数 method 可选：不传时退化为"只读顶层 sessionId"（与改动前完全一致）。
export function extractSessionId(payload, method) {
  const request = extractRequest(payload)
  if (!request || typeof request !== 'object') return null
  if (isNonEmptyString(request.sessionId)) return request.sessionId
  if (typeof method === 'string' && ADDRESS_SESSION_METHODS.has(method)) {
    const address = request.address
    if (address && typeof address === 'object') {
      if (isNonEmptyString(address.sessionId)) return address.sessionId
      if (isNonEmptyString(address.parentSessionId)) return address.parentSessionId
    }
  }
  return null
}

export function filterItems(envelope, userId, ownerStore) {
  const items = envelope?.result?.value?.items
  if (!Array.isArray(items)) return []
  return items.filter((item) => item && ownerStore.getOwner(item.sessionId) === userId)
}

export function buildDeniedEnvelope(rpcId) {
  return {
    type: 'server-response',
    rpcId,
    result: {
      error: { code: 'SESSION_ACCESS_DENIED', message: '无权访问该会话' },
    },
  }
}

export function isAdmin(user) {
  return Boolean(user) && user.role === 'admin'
}

function safeAudit(audit, action, details) {
  if (typeof audit !== 'function') return
  try {
    audit(action, details)
  } catch {}
}

function parseResponseBuffer(body) {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

function deniedResponse(rpcId) {
  return {
    statusCode: 403,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(buildDeniedEnvelope(rpcId))),
  }
}

async function handleCreate({ method, requestBuffer, user, ownerStore, upstream, audit }) {
  const { envelope, payload } = parseEnvelope(requestBuffer)
  const rpcId = envelope.rpcId

  if (!isAdmin(user) && method === 'session.fork') {
    const sourceId = extractSessionId(payload, method)
    const owner = sourceId === null ? null : ownerStore.getOwner(sourceId)
    if (owner === null || owner !== user.id) {
      safeAudit(audit, 'session.access_denied', {
        method,
        sessionId: sourceId,
        userId: user.id,
      })
      return deniedResponse(rpcId)
    }
  }

  const response = await upstream(requestBuffer)
  const respEnvelope = parseResponseBuffer(response.body)

  if (
    response.statusCode >= 400 ||
    !respEnvelope ||
    !respEnvelope.result ||
    respEnvelope.result.error
  ) {
    if (!isAdmin(user) && (!respEnvelope || !respEnvelope.result) && response.statusCode < 400) {
      safeAudit(audit, 'session.list_blocked_unparseable', {
        statusCode: response.statusCode,
        userId: user.id,
      })
      const fallback = {
        type: 'server-response',
        rpcId: undefined,
        result: { ok: true, value: { items: [] } },
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(fallback)),
      }
    }
    return response
  }

  const newId = respEnvelope.result.value ? respEnvelope.result.value.sessionId : null
  if (isNonEmptyString(newId)) {
    ownerStore.setOwner(newId, user.id)
    safeAudit(audit, 'session.ownership_created', {
      method,
      sessionId: newId,
      owner: user.id,
    })
  }

  return response
}

async function handleList({ method, requestBuffer, user, ownerStore, upstream, audit }) {
  const { envelope: reqEnvelope } = parseEnvelope(requestBuffer)
  const response = await upstream(requestBuffer)
  const respEnvelope = parseResponseBuffer(response.body)

  if (
    response.statusCode >= 400 ||
    !respEnvelope ||
    !respEnvelope.result ||
    respEnvelope.result.error
  ) {
    if (!isAdmin(user) && (!respEnvelope || !respEnvelope.result) && response.statusCode < 400) {
      safeAudit(audit, 'session.list_blocked_unparseable', {
        statusCode: response.statusCode,
        userId: user.id,
      })
      const fallback = {
        type: 'server-response',
        rpcId: reqEnvelope?.rpcId,
        result: { ok: true, value: { items: [] } },
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(fallback)),
      }
    }
    return response
  }

  if (isAdmin(user)) return response

  const before = Array.isArray(respEnvelope.result.value?.items)
    ? respEnvelope.result.value.items.length
    : 0
  const filtered = filterItems(respEnvelope, user.id, ownerStore)

  const rewritten = JSON.parse(JSON.stringify(respEnvelope))
  rewritten.result.value.items = filtered

  safeAudit(audit, 'session.list_filtered', {
    before,
    after: filtered.length,
    userId: user.id,
  })

  return {
    statusCode: 200,
    headers: { ...response.headers, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(rewritten)),
  }
}

async function handleOperation({ method, requestBuffer, user, ownerStore, upstream, audit }) {
  const { envelope, payload } = parseEnvelope(requestBuffer)
  const rpcId = envelope.rpcId
  const sessionId = extractSessionId(payload, method)

  if (!isAdmin(user)) {
    if (sessionId === null) {
      // 提不到会话 id ⇒ 不改判、仍放行（这是历史的 fail-open 语义，本轮**不收紧**），
      // 但**必须留痕**：原来这里是"静默放行、无审计"，正是 T-1 缺口的一半。
      // 命中这里的两类：
      //   (C) 类 —— 本就不带会话标识（如 session.modelCatalog），豁免属预期；
      //   其它 —— 形如 session.page 但 address 里既无 sessionId 也无 parentSessionId，
      //           或 (A) 类方法缺失 sessionId（畸形请求），将来据此排查。
      safeAudit(audit, 'session.operation_no_session_id', {
        method,
        userId: user.id,
        reason: 'no-session-identifier',
      })
      return upstream(requestBuffer)
    }
    const owner = ownerStore.getOwner(sessionId)
    if (owner === null || owner !== user.id) {
      safeAudit(audit, 'session.access_denied', {
        method,
        sessionId,
        userId: user.id,
      })
      return deniedResponse(rpcId)
    }
  }

  return upstream(requestBuffer)
}

export async function handleSessionRequest({
  method,
  requestBuffer,
  user,
  ownerStore,
  upstream,
  audit,
}) {
  const parsed = parseEnvelope(requestBuffer)
  if (!parsed.ok) return upstream(requestBuffer)

  const kind = classifyMethod(method)
  const ctx = { method, requestBuffer, user, ownerStore, upstream, audit }

  if (kind === null) {
    // 未登记的方法：只要带 sessionId 就必须按会话操作校验归属，
    // 否则上游新增/改名的方法（或点分别名）会成为绕过隔离的缺口。
    if (typeof method === 'string' && method.startsWith('session.')
      && extractSessionId(parsed.payload) !== null) {
      return handleOperation(ctx)
    }
    return upstream(requestBuffer)
  }

  if (kind === 'create') return handleCreate(ctx)
  if (kind === 'list') return handleList(ctx)
  return handleOperation(ctx)
}
