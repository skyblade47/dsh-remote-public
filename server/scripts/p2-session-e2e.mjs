// P2 端到端测试：会话归属与多用户 L1 隔离。
// 自动启动 mock 上游 DSH（实现信封协议的 session.* 方法）与网关子进程，
// 覆盖：创建归属、列表隔离、操作类 403、fork 归属、admin 绕过、遗留迁移路由、审计。
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = path.resolve(__dirname, '../gateway/src/index.js')
const PORT = 8192
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0, failed = 0
function check(name, condition, info = '') {
  if (condition) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name} ${info}`); failed++ }
}

async function req(method, urlPath, body, headers = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let data
  try { data = JSON.parse(buf.toString('utf8')) } catch { data = buf }
  return { status: res.status, data, headers: res.headers, buf }
}

let rpcSeq = 0
async function rpc(user, method, payload) {
  return req(
    'POST',
    `/api/${method}`,
    { type: 'client-request', rpcId: `rpc-${++rpcSeq}`, method, payload },
    user ? { cookie: user.cookie } : {},
  )
}

// Mock 上游 DSH：内存实现信封协议下的全部 session.* 方法，
// 不做任何归属判断（归属是网关层职责），只忠实返回业务结果。
function createMockUpstream() {
  const sessions = new Map()

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let envelope
    try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { envelope = {} }
    const payload = envelope.payload ?? {}

    function send(value, statusCode = 200) {
      const out = { type: 'server-response', rpcId: envelope.rpcId ?? null, result: { value } }
      res.writeHead(statusCode, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    }
    function fail(code, statusCode = 200) {
      const out = {
        type: 'server-response',
        rpcId: envelope.rpcId ?? null,
        result: { error: { code, message: code } },
      }
      res.writeHead(statusCode, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    }

    const pathOnly = req.url.split('?')[0]
    switch (pathOnly) {
      case '/api/session.create': {
        const id = payload.sessionId || `session-${crypto.randomUUID()}`
        sessions.set(id, { sessionId: id, title: payload.title || '' })
        send({ sessionId: id })
        break
      }
      case '/api/session.fork': {
        if (!sessions.has(payload.sessionId)) { fail('SESSION_NOT_FOUND'); break }
        const id = `session-${crypto.randomUUID()}`
        sessions.set(id, { sessionId: id, title: '' })
        send({ sessionId: id })
        break
      }
      case '/api/session.list':
        send({ items: [...sessions.values()] })
        break
      case '/api/session.search':
        send({ items: [...sessions.values()], hasMore: false })
        break
      case '/api/session.history':
        if (!sessions.has(payload.sessionId)) { fail('SESSION_NOT_FOUND'); break }
        send({ events: [] })
        break
      case '/api/session.rename':
        if (!sessions.has(payload.sessionId)) { fail('SESSION_NOT_FOUND'); break }
        send({ sessionId: payload.sessionId })
        break
      case '/api/session.models':
        send({ models: [] })
        break
      case '/api/session.prompt':
        if (!sessions.has(payload.sessionId)) { fail('SESSION_NOT_FOUND'); break }
        send({ accepted: true })
        break
      default:
        fail('NOT_FOUND', 404)
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-e2e-'))
const dshHome = path.join(tmpRoot, 'dsh-data')

console.log('P2 会话归属端到端测试')
console.log('='.repeat(50))
console.log('临时目录:', tmpRoot)

const mock = await createMockUpstream()
console.log('mock 上游端口:', mock.port)

const child = spawn('node', [GATEWAY_SRC], {
  env: {
    ...process.env,
    DSH_GATEWAY_PORT: String(PORT),
    DSH_GATEWAY_UPSTREAM: `http://127.0.0.1:${mock.port}`,
    DSH_GATEWAY_DATA_DIR: dshHome,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (c) => process.stdout.write(`[gw] ${c}`))
child.stderr.on('data', (c) => process.stderr.write(`[gw-err] ${c}`))

async function waitForReady(timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/workspaces`)
      if (r.status === 401) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('网关未在超时内启动')
}

async function registerLogin(name, password) {
  await req('POST', '/api/auth/register', { name, password })
  const r = await req('POST', '/api/auth/login', { name, password })
  if (r.status !== 200) throw new Error(`${name} 登录失败: ${r.status}`)
  const token = r.headers.get('set-cookie')?.match(/dsh_session=([^;]+)/)?.[1]
  if (!token) throw new Error(`${name} 未取得 cookie`)
  return { cookie: `dsh_session=${token}`, userId: r.data?.user?.id }
}

async function adminCreateLogin(admin, name, password) {
  const cr = await req('POST', '/api/auth/users', { name, password, role: 'user' }, { cookie: admin.cookie })
  if (cr.status !== 201) throw new Error(`${name} 创建失败: ${cr.status} ${JSON.stringify(cr.data)}`)
  const r = await req('POST', '/api/auth/login', { name, password })
  if (r.status !== 200) throw new Error(`${name} 登录失败: ${r.status}`)
  const token = r.headers.get('set-cookie')?.match(/dsh_session=([^;]+)/)?.[1]
  if (!token) throw new Error(`${name} 未取得 cookie`)
  return { cookie: `dsh_session=${token}`, userId: r.data?.user?.id }
}

function readOwners() {
  const file = path.join(dshHome, 'users', 'session-owners.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')).owners
}

try {
  await waitForReady()
  console.log('\n[0] 网关启动')

  const admin = await registerLogin('admin_p2', 'admin123456')
  const alice = await adminCreateLogin(admin, 'alice_p2', 'alice123456')
  const bob = await adminCreateLogin(admin, 'bob_p2', 'bob123456')
  check('admin/alice/bob 三用户登录', !!admin.userId && !!alice.userId && !!bob.userId)

  console.log('\n[1] 未登录访问')
  let r = await rpc(null, 'session.create', { title: 'x' })
  check('未登录 session.create 401', r.status === 401, `status=${r.status}`)
  r = await rpc(null, 'session.list', {})
  check('未登录 session.list 401', r.status === 401, `status=${r.status}`)

  console.log('\n[2] 创建会话并写入归属')
  r = await rpc(alice, 'session.create', { title: 'alice-1' })
  const idA1 = r.data?.result?.value?.sessionId
  check('alice 创建 200 信封并返回 sessionId',
    r.status === 200 && typeof idA1 === 'string', `status=${r.status} data=${JSON.stringify(r.data)}`)

  r = await rpc(alice, 'session.create', { sessionId: 'session-alice-fixed', title: 'alice-2' })
  const idA2 = r.data?.result?.value?.sessionId
  check('alice 指定 id 创建 200', r.status === 200 && idA2 === 'session-alice-fixed')

  r = await rpc(bob, 'session.create', { title: 'bob-1' })
  const idB1 = r.data?.result?.value?.sessionId
  check('bob 创建 200 并返回 sessionId', r.status === 200 && typeof idB1 === 'string')

  const owners = readOwners()
  check('session-owners.json 记录 alice 两个会话',
    owners[idA1] === alice.userId && owners[idA2] === alice.userId, JSON.stringify(owners))
  check('session-owners.json 记录 bob 的会话', owners[idB1] === bob.userId)
  check('归属不串用户', owners[idA1] !== bob.userId && owners[idB1] !== alice.userId)

  console.log('\n[3] 列表隔离')
  r = await rpc(alice, 'session.list', {})
  let ids = (r.data?.result?.value?.items || []).map((i) => i.sessionId)
  check('alice 列表只含自己的 2 个会话',
    r.status === 200 && ids.length === 2 && ids.includes(idA1) && ids.includes(idA2) && !ids.includes(idB1),
    `ids=${JSON.stringify(ids)}`)

  r = await rpc(bob, 'session.list', {})
  ids = (r.data?.result?.value?.items || []).map((i) => i.sessionId)
  check('bob 列表只含自己的 1 个会话', ids.length === 1 && ids[0] === idB1, `ids=${JSON.stringify(ids)}`)

  r = await rpc(alice, 'session.search', { query: 'x' })
  ids = (r.data?.result?.value?.items || []).map((i) => i.sessionId)
  check('search 同样按归属过滤且保留 hasMore',
    ids.length === 2 && r.data?.result?.value?.hasMore === false && !ids.includes(idB1))

  r = await rpc(admin, 'session.list', {})
  ids = (r.data?.result?.value?.items || []).map((i) => i.sessionId)
  check('admin 列表看到全部 3 个会话',
    ids.length === 3 && ids.includes(idA1) && ids.includes(idA2) && ids.includes(idB1),
    `ids=${JSON.stringify(ids)}`)

  console.log('\n[4] 操作类访问控制')
  r = await rpc(bob, 'session.history', { sessionId: idA1 })
  check('bob 读 alice 会话 history → 403 SESSION_ACCESS_DENIED',
    r.status === 403 && r.data?.result?.error?.code === 'SESSION_ACCESS_DENIED',
    `status=${r.status} data=${JSON.stringify(r.data)}`)
  check('403 信封为 server-response 且带回 rpcId',
    r.data?.type === 'server-response' && typeof r.data?.rpcId === 'string')

  r = await rpc(bob, 'session.rename', { sessionId: idA1, title: 'hacked' })
  check('bob rename alice 会话 → 403', r.status === 403, `status=${r.status}`)
  r = await rpc(bob, 'session.prompt', { sessionId: idA1, text: 'hi' })
  check('bob prompt alice 会话 → 403', r.status === 403, `status=${r.status}`)

  r = await rpc(alice, 'session.history', { sessionId: idA1 })
  check('alice 读自己的 history → 200 到达上游',
    r.status === 200 && Array.isArray(r.data?.result?.value?.events),
    `status=${r.status} data=${JSON.stringify(r.data)}`)
  r = await rpc(alice, 'session.rename', { sessionId: idA1, title: 'renamed' })
  check('alice rename 自己的会话 → 200', r.status === 200, `status=${r.status}`)

  console.log('\n[5] fork 归属')
  r = await rpc(bob, 'session.fork', { sessionId: idA1 })
  check('bob fork alice 的会话 → 403', r.status === 403, `status=${r.status}`)

  r = await rpc(alice, 'session.fork', { sessionId: idA1 })
  const idForkA = r.data?.result?.value?.sessionId
  check('alice fork 自己的会话 → 200 返回新 id',
    r.status === 200 && typeof idForkA === 'string' && idForkA !== idA1,
    `status=${r.status} data=${JSON.stringify(r.data)}`)
  check('fork 新会话归属 alice', readOwners()[idForkA] === alice.userId)

  r = await rpc(bob, 'session.list', {})
  check('bob 列表仍看不到 alice 的 fork',
    !(r.data?.result?.value?.items || []).some((i) => i.sessionId === idForkA))

  console.log('\n[6] admin 绕过')
  r = await rpc(admin, 'session.history', { sessionId: idA1 })
  check('admin 读任意会话 history → 200', r.status === 200, `status=${r.status}`)
  r = await rpc(admin, 'session.fork', { sessionId: idB1 })
  const idForkB = r.data?.result?.value?.sessionId
  check('admin fork bob 的会话 → 200', r.status === 200 && typeof idForkB === 'string')
  check('admin fork 的新会话归属 admin', readOwners()[idForkB] === admin.userId)

  r = await rpc(admin, 'session.list', {})
  ids = (r.data?.result?.value?.items || []).map((i) => i.sessionId)
  check('admin 列表看到全部 5 个会话', ids.length === 5, `ids=${JSON.stringify(ids)}`)

  console.log('\n[7] 遗留会话迁移路由')
  const orphanLeaf = path.join(dshHome, 'sessions', '--orphan-cwd--', 'session-orphan')
  fs.mkdirSync(orphanLeaf, { recursive: true })
  fs.writeFileSync(path.join(orphanLeaf, 'session.jsonl.zstd'), 'mock')

  r = await req('POST', '/api/sessions/migrate-legacy', {}, { cookie: bob.cookie })
  check('非 admin 调用迁移路由 → 403', r.status === 403, `status=${r.status}`)

  r = await req('POST', '/api/sessions/migrate-legacy', {}, { cookie: admin.cookie })
  check('admin 迁移 → 200 且无主会话入清单',
    r.status === 200 && Array.isArray(r.data?.migrated) && r.data.migrated.includes('session-orphan'),
    `data=${JSON.stringify(r.data)}`)
  check('迁移后 orphan 归属 admin', readOwners()['session-orphan'] === admin.userId)

  r = await req('POST', '/api/sessions/migrate-legacy', {}, { cookie: admin.cookie })
  check('再次迁移幂等：无新增、全部跳过',
    r.status === 200 && Array.isArray(r.data.migrated) && r.data.migrated.length === 0 && r.data.skipped >= 1,
    `data=${JSON.stringify(r.data)}`)

  console.log('\n[8] 审计记录')
  const auditFile = path.join(dshHome, 'logs', 'auth-audit.jsonl')
  const auditLines = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  check('审计含 ownership_created',
    auditLines.some((l) => l.event === 'session.ownership_created' && l.sessionId === idA1))
  check('审计含 access_denied（bob 越权）',
    auditLines.some((l) => l.event === 'session.access_denied' && l.userId === bob.userId))
  check('审计含 list_filtered',
    auditLines.some((l) => l.event === 'session.list_filtered' && l.userId === alice.userId))
  const legacyEv = auditLines.find((l) => l.event === 'session.legacy_migrated')
  check('审计含 legacy_migrated 且记录迁移数量',
    !!legacyEv && typeof legacyEv.migrated === 'number' && legacyEv.migrated >= 1
      && typeof legacyEv.total === 'number' && legacyEv.adminId === admin.userId,
    JSON.stringify(legacyEv))
} catch (e) {
  console.error('E2E 执行错误:', e)
  failed++
} finally {
  child.kill()
  mock.server.close()
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
}

console.log('\n' + '='.repeat(50))
console.log(`结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
