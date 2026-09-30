// T-1.b 阶段①：WS upgrade 的会话归属判定与鉴权接线。
// 判据编号对应设计文档 docs/superpowers/specs/2026-09-27-ws-ownership-check-design.md §6（V1–V10）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWsUpgrade, createUpgradeAuthenticator, forbiddenResponse, WS_AUDIT } from '../src/ws-ownership.js'

// ---- 夹具 ----

const ADMIN = { id: 'u_admin', role: 'admin' }
const ALICE = { id: 'u_alice', role: 'user' }
const BOB = { id: 'u_bob', role: 'user' }

/** 极简 ownerStore 替身：只实现判定用到的 getOwner */
function storeOf(map) {
  return { getOwner: (id) => (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null) }
}

/** 记录 socket 收到了什么、有没有被关 */
function fakeSocket() {
  return {
    written: '',
    ended: false,
    destroyed: false,
    write(s) { this.written += s },
    end(s) { if (s) this.written += s; this.ended = true },
    destroy() { this.destroyed = true },
  }
}

// 真实会出现的三条 sidebar 路径（第三方 dsh-better-sidebar 注册）+ 账户级 mux
const P_AGENT_OPENS = '/sidebar/ws/agent-opens'
const P_AGENT_TERMINALS = '/sidebar/ws/agent-terminals'
const P_TERMINAL = '/sidebar/ws/terminal'
const P_MUX = '/api/remote.mux'

// ============================================================================
// 一、纯判定 decideWsUpgrade
// ============================================================================

test('V1 本人会话 ⇒ 放行（三条 sidebar 路径逐条）', () => {
  const store = storeOf({ 's-1': ALICE.id })
  for (const p of [P_AGENT_OPENS, P_AGENT_TERMINALS, P_TERMINAL]) {
    const d = decideWsUpgrade({ url: `${p}?sessionId=s-1`, user: ALICE, ownerStore: store })
    assert.equal(d.allow, true, p)
    assert.equal(d.reason, 'OWNER_MATCH', p)
    assert.equal(d.sessionId, 's-1', p)
    assert.equal(d.action, undefined, `${p} 放行不该留痕`)
  }
})

test('V2 他人会话 ⇒ 403 + session.access_denied（三条 sidebar 路径逐条）', () => {
  const store = storeOf({ 's-1': ALICE.id })
  for (const p of [P_AGENT_OPENS, P_AGENT_TERMINALS, P_TERMINAL]) {
    const d = decideWsUpgrade({ url: `${p}?sessionId=s-1`, user: BOB, ownerStore: store })
    assert.equal(d.allow, false, p)
    assert.equal(d.status, 403, p)
    assert.equal(d.reason, 'OWNER_MISMATCH', p)
    assert.equal(d.action, WS_AUDIT.ACCESS_DENIED, p)
  }
})

test('V3 admin 豁免：他人会话也放行，且不留痕', () => {
  const store = storeOf({ 's-1': ALICE.id })
  const d = decideWsUpgrade({ url: `${P_AGENT_OPENS}?sessionId=s-1`, user: ADMIN, ownerStore: store })
  assert.equal(d.allow, true)
  assert.equal(d.reason, 'ADMIN_BYPASS')
  assert.equal(d.action, undefined)
})

test('V4 阶段①：owner 缺失（null）⇒ 放行 + session.ws_owner_missing', () => {
  const store = storeOf({}) // 会话存在但无归属 —— 正是生产现状（398/398 无归属）
  for (const p of [P_AGENT_OPENS, P_AGENT_TERMINALS, P_TERMINAL]) {
    const d = decideWsUpgrade({ url: `${p}?sessionId=s-nobody`, user: ALICE, ownerStore: store })
    assert.equal(d.allow, true, `${p}：阶段① 必须放行，否则会掐断现存 sidebar WS`)
    assert.equal(d.reason, 'OWNER_MISSING_ALLOWED', p)
    assert.equal(d.action, WS_AUDIT.OWNER_MISSING, `${p}：放行但必须留痕`)
  }
})

test('V4b ownerStore 整个不可用（null）⇒ 同样按"无归属"放行 + 留痕，不崩', () => {
  const d = decideWsUpgrade({ url: `${P_AGENT_OPENS}?sessionId=s-1`, user: ALICE, ownerStore: null })
  assert.equal(d.allow, true)
  assert.equal(d.reason, 'OWNER_MISSING_ALLOWED')
  assert.equal(d.action, WS_AUDIT.OWNER_MISSING)
})

test('V5 缺 / 空 sessionId ⇒ 403 + session.operation_no_session_id（非 admin）', () => {
  for (const url of [P_AGENT_TERMINALS, `${P_AGENT_TERMINALS}?sessionId=`, `${P_AGENT_TERMINALS}?sessionId=%20`]) {
    const d = decideWsUpgrade({ url, user: ALICE, ownerStore: storeOf({}) })
    assert.equal(d.allow, false, url)
    assert.equal(d.status, 403, url)
    assert.equal(d.reason, 'SESSION_ID_REQUIRED', url)
    assert.equal(d.action, WS_AUDIT.NO_SESSION_ID, url)
  }
})

test('V6 白名单回归红线：/api/remote.mux 即使带他人 sessionId 也必须放行、且不留痕', () => {
  const store = storeOf({ 's-1': ALICE.id })
  const d = decideWsUpgrade({ url: `${P_MUX}?sessionId=s-1`, user: BOB, ownerStore: store })
  assert.equal(d.allow, true)
  assert.equal(d.reason, 'ACCOUNT_LEVEL_WHITELIST')
  assert.equal(d.action, undefined, '白名单不该产生审计噪声')
})

test('V7 线上三条路径的兼容性：本人 / 白名单逐条放行（不打断现有调用）', () => {
  const store = storeOf({ 's-1': ALICE.id })
  const cases = [
    `${P_MUX}`,
    `${P_AGENT_OPENS}?sessionId=s-1`,
    `${P_AGENT_TERMINALS}?sessionId=s-1`,
  ]
  for (const url of cases) {
    const d = decideWsUpgrade({ url, user: ALICE, ownerStore: store })
    assert.equal(d.allow, true, url)
  }
})

test('D2 未知路径 ⇒ 放行 + session.ws_unknown_path（防内核升级静默打断用户）', () => {
  const d = decideWsUpgrade({ url: '/some/future/ws?sessionId=s-1', user: BOB, ownerStore: storeOf({ 's-1': ALICE.id }) })
  assert.equal(d.allow, true)
  assert.equal(d.reason, 'UNKNOWN_PATH_ALLOWED')
  assert.equal(d.action, WS_AUDIT.UNKNOWN_PATH)
})

test('归一化：重复斜杠 / 百分号编码**不能**绕过判定', () => {
  const store = storeOf({ 's-1': ALICE.id })
  // 与内核 upgrades 的 exact-key 口径一致：查询串不进 pathname
  const bypasses = [
    '/sidebar//ws/agent-opens?sessionId=s-1', // 折叠斜杠后仍是已知路径
    '/sidebar/ws/%61gent-opens?sessionId=s-1', // %61 = 'a'
  ]
  for (const url of bypasses) {
    const d = decideWsUpgrade({ url, user: BOB, ownerStore: store })
    assert.equal(d.allow, false, `${url} 必须仍被判为"已知路径 + 他人会话"`)
    assert.equal(d.reason, 'OWNER_MISMATCH', url)
  }
})

test('归一化失败（坏百分号编码）⇒ fail-closed 403', () => {
  const d = decideWsUpgrade({ url: '/sidebar/ws/%zz', user: ALICE, ownerStore: storeOf({}) })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'BAD_PATH_ENCODING')
  assert.equal(d.status, 403)
})

test('无 user / 无 url 等畸形输入不抛异常', () => {
  assert.doesNotThrow(() => decideWsUpgrade())
  assert.doesNotThrow(() => decideWsUpgrade({ url: undefined, user: undefined, ownerStore: undefined }))
  const d = decideWsUpgrade({ url: `${P_AGENT_OPENS}?sessionId=s-1`, user: null, ownerStore: storeOf({ 's-1': 'u_x' }) })
  assert.equal(d.allow, false, 'user 为 null 且会话有他人归属 ⇒ 必须拒')
  assert.equal(d.reason, 'OWNER_MISMATCH')
})

// ============================================================================
// 二、接线 createUpgradeAuthenticator（含 V8/V9：审计条数与上游零泄漏）
// ============================================================================

/** 造一个可观测的接线：记录 audit / upgradeHandler 调用 */
function makeWiring({ users = {}, owners = {}, isStrictOwnerRequired = null } = {}) {
  const audits = []
  const forwarded = []
  const authService = {
    authenticateToken: (token) => (users[token] ? { user: users[token] } : null),
  }
  const authenticator = createUpgradeAuthenticator({
    authService,
    getToken: (req) => req.headers?.['x-token'] ?? null,
    ownerStore: storeOf(owners),
    isStrictOwnerRequired,
    audit: { log: (event, data) => audits.push({ event, ...data }) },
    upgradeHandler: (req, socket, head) => forwarded.push({ url: req.url, socket, head }),
    log: () => {},
  })
  return { authenticator, audits, forwarded }
}

test('V9 无 token ⇒ 401（既有语义不回归，且不是 403）', () => {
  const { authenticator, forwarded, audits } = makeWiring()
  const s = fakeSocket()
  authenticator({ url: P_MUX, headers: {} }, s, null)
  assert.match(s.written, /^HTTP\/1\.1 401 /)
  assert.equal(s.destroyed, true)
  assert.equal(forwarded.length, 0)
  assert.equal(audits.length, 0)
})

test('V9b role=pending ⇒ 401（既有语义不回归）', () => {
  const { authenticator, forwarded } = makeWiring({ users: { t: { id: 'u_p', role: 'pending' } } })
  const s = fakeSocket()
  authenticator({ url: P_MUX, headers: { 'x-token': 't' } }, s, null)
  assert.match(s.written, /^HTTP\/1\.1 401 /)
  assert.equal(forwarded.length, 0)
})

test('V2b 他人会话 ⇒ 裸 403 响应，且 🔴 upgradeHandler **零调用**（拒绝在 net.connect 之前）', () => {
  const { authenticator, forwarded, audits } = makeWiring({ users: { t: ALICE }, owners: { 's-1': BOB.id } })
  const s = fakeSocket()
  authenticator({ url: `${P_AGENT_OPENS}?sessionId=s-1`, headers: { 'x-token': 't' } }, s, null)
  assert.match(s.written, /^HTTP\/1\.1 403 /)
  assert.equal(s.ended, true, '403 用 end() 送出（避免 write+destroy 截断响应）')
  assert.equal(s.destroyed, false, 'end() 已负责关闭，不该再 destroy')
  assert.equal(forwarded.length, 0, '不得转交 upgradeHandler')
  // V8：恰好 1 条审计，字段齐全且 channel=ws
  assert.equal(audits.length, 1)
  assert.equal(audits[0].event, WS_AUDIT.ACCESS_DENIED)
  assert.equal(audits[0].channel, 'ws')
  assert.equal(audits[0].sessionId, 's-1')
  assert.equal(audits[0].userId, ALICE.id)
  assert.equal(audits[0].path, P_AGENT_OPENS)
})

test('V1b 本人会话 ⇒ 转交 upgradeHandler，且不写任何裸响应', () => {
  const { authenticator, forwarded, audits } = makeWiring({ users: { t: ALICE }, owners: { 's-1': ALICE.id } })
  const s = fakeSocket()
  authenticator({ url: `${P_AGENT_OPENS}?sessionId=s-1`, headers: { 'x-token': 't' } }, s, null)
  assert.equal(s.written, '')
  assert.equal(forwarded.length, 1)
  assert.equal(forwarded[0].url, `${P_AGENT_OPENS}?sessionId=s-1`)
  assert.equal(audits.length, 0)
})

test('V6b 白名单 /api/remote.mux ⇒ 转交，且**零审计**', () => {
  const { authenticator, forwarded, audits } = makeWiring({ users: { t: BOB }, owners: { 's-1': ALICE.id } })
  const s = fakeSocket()
  authenticator({ url: `${P_MUX}?sessionId=s-1`, headers: { 'x-token': 't' } }, s, null)
  assert.equal(forwarded.length, 1)
  assert.equal(audits.length, 0, '账户级通道不该产生每条连接的审计噪声')
})

test('V8b 阶段①的"放行但留痕"：owner 缺失 / 未知路径各恰好 1 条审计，且仍转交', () => {
  {
    const { authenticator, forwarded, audits } = makeWiring({ users: { t: ALICE }, owners: {} })
    const s = fakeSocket()
    authenticator({ url: `${P_TERMINAL}?sessionId=s-nobody`, headers: { 'x-token': 't' } }, s, null)
    assert.equal(forwarded.length, 1)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].event, WS_AUDIT.OWNER_MISSING)
  }
  {
    const { authenticator, forwarded, audits } = makeWiring({ users: { t: ALICE }, owners: {} })
    const s = fakeSocket()
    authenticator({ url: '/future/ws?x=1', headers: { 'x-token': 't' } }, s, null)
    assert.equal(forwarded.length, 1)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].event, WS_AUDIT.UNKNOWN_PATH)
  }
})

test('审计实现抛异常时不得影响鉴权结论', () => {
  const forwarded = []
  const authenticator = createUpgradeAuthenticator({
    authService: { authenticateToken: () => ({ user: BOB }) },
    getToken: () => 't',
    ownerStore: storeOf({ 's-1': ALICE.id }),
    audit: { log: () => { throw new Error('disk full') } },
    upgradeHandler: () => forwarded.push(1),
    log: () => {},
  })
  const s = fakeSocket()
  assert.doesNotThrow(() => authenticator({ url: `${P_AGENT_OPENS}?sessionId=s-1` }, s, null))
  assert.match(s.written, /^HTTP\/1\.1 403 /)
  assert.equal(forwarded.length, 0)
})

test('forbiddenResponse 是合法的裸 403 + JSON 体', () => {
  const r = forbiddenResponse()
  const [head, body] = r.split('\r\n\r\n')
  assert.match(head, /^HTTP\/1\.1 403 Forbidden/)
  assert.match(head, /Connection: close/)
  assert.deepEqual(JSON.parse(body), {
    ok: false,
    error: { code: 'SESSION_ACCESS_DENIED', message: '无权访问该会话' },
  })
})

// ============================================================================
// 三、阶段② 开关 `strictOwnerRequired`（2026-09-27：做成运行时可翻转，免"第二次重启"）
// ============================================================================

test('V11 阶段②（strict=true）：无归属 ⇒ 403 + session.access_denied（三条路径逐条）', () => {
  const store = storeOf({ 's-1': ALICE.id })
  for (const p of [P_AGENT_OPENS, P_AGENT_TERMINALS, P_TERMINAL]) {
    const d = decideWsUpgrade({ url: `${p}?sessionId=s-legacy`, user: ALICE, ownerStore: store, strictOwnerRequired: true })
    assert.equal(d.allow, false, p)
    assert.equal(d.status, 403, p)
    assert.equal(d.reason, 'OWNER_MISSING_DENIED', p)
    assert.equal(d.action, WS_AUDIT.ACCESS_DENIED, p)
  }
})

test('V11b 阶段② 下 ownerStore 整个不可用（null）⇒ 同样拒绝（不能因"存储缺失"而放开）', () => {
  const d = decideWsUpgrade({ url: `${P_TERMINAL}?sessionId=s-1`, user: ALICE, ownerStore: null, strictOwnerRequired: true })
  assert.equal(d.allow, false)
  assert.equal(d.reason, 'OWNER_MISSING_DENIED')
})

test('V11c 阶段② 不影响其它分支：本人会话仍放行、他人会话仍 403、admin 仍豁免', () => {
  const store = storeOf({ 's-1': ALICE.id })
  const mine = decideWsUpgrade({ url: `${P_TERMINAL}?sessionId=s-1`, user: ALICE, ownerStore: store, strictOwnerRequired: true })
  assert.equal(mine.reason, 'OWNER_MATCH')
  const others = decideWsUpgrade({ url: `${P_TERMINAL}?sessionId=s-1`, user: BOB, ownerStore: store, strictOwnerRequired: true })
  assert.equal(others.reason, 'OWNER_MISMATCH')
  const adm = decideWsUpgrade({ url: `${P_TERMINAL}?sessionId=s-legacy`, user: ADMIN, ownerStore: store, strictOwnerRequired: true })
  assert.equal(adm.reason, 'ADMIN_BYPASS')
})

test('V11d 默认（不传 strictOwnerRequired）= 阶段① 姿态，语义不变', () => {
  const store = storeOf({ 's-1': ALICE.id })
  const d = decideWsUpgrade({ url: `${P_TERMINAL}?sessionId=s-legacy`, user: ALICE, ownerStore: store })
  assert.equal(d.allow, true)
  assert.equal(d.reason, 'OWNER_MISSING_ALLOWED')
  assert.equal(d.action, WS_AUDIT.OWNER_MISSING)
})

test('V12 🎚 provider 每次现取 ⇒ 同一接线**运行时可翻转**（false→放行，true→403）', () => {
  let strict = false
  const { authenticator, forwarded, audits } = makeWiring({
    users: { t: ALICE }, owners: { 's-1': ALICE.id }, isStrictOwnerRequired: () => strict,
  })

  const s1 = fakeSocket()
  authenticator({ url: `${P_TERMINAL}?sessionId=s-legacy`, headers: { 'x-token': 't' } }, s1, null)
  assert.equal(forwarded.length, 1, '开关 false 时放行')
  assert.equal(audits.at(-1).event, WS_AUDIT.OWNER_MISSING)

  strict = true // ← 只改"设置"，不重启
  const s2 = fakeSocket()
  authenticator({ url: `${P_TERMINAL}?sessionId=s-legacy`, headers: { 'x-token': 't' } }, s2, null)
  assert.match(s2.written, /^HTTP\/1\.1 403 /)
  assert.equal(forwarded.length, 1, '🔴 收紧时 upgradeHandler 零调用')
  assert.equal(audits.at(-1).event, WS_AUDIT.ACCESS_DENIED)
  assert.equal(audits.at(-1).reason, 'OWNER_MISSING_DENIED')
})

test('V12b provider 抛错/未接线 ⇒ 按 false（阶段①）—— 收紧只能是显式选择，不能因异常而变严', () => {
  const boom = makeWiring({ users: { t: ALICE }, isStrictOwnerRequired: () => { throw new Error('settings 不可读') } })
  const s1 = fakeSocket()
  boom.authenticator({ url: `${P_TERMINAL}?sessionId=s-legacy`, headers: { 'x-token': 't' } }, s1, null)
  assert.equal(boom.forwarded.length, 1)

  const none = makeWiring({ users: { t: ALICE } })
  const s2 = fakeSocket()
  none.authenticator({ url: `${P_TERMINAL}?sessionId=s-legacy`, headers: { 'x-token': 't' } }, s2, null)
  assert.equal(none.forwarded.length, 1)
})
