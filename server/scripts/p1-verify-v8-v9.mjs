// P1 遗留项 V8（mTLS 真机登录）+ V9（审批回程）的端到端验证
//
// 为什么单独写一个脚本，而不复用 p1-e2e.mjs：
//   1) p1-e2e.mjs 跑在固定的 :8080、依赖既有数据与写死的密码，结论依赖外部前置条件；
//   2) 它有多处「跳过」分支会**静默算通过**，正是本项目反复栽过的假绿灯形态。
// 本脚本**自包含**：临时数据目录 + 临时端口 + 真起一个网关进程，跑完断言再拆掉。
//
// 用法：node server/scripts/p1-verify-v8-v9.mjs
// 退出码：0 = 全过；1 = 有失败
//
// ⚠️ 两点必须一起成立的判据（否则"通过"没有意义）：
//   · V8：**带**已授权证书能进，**不带**证书进不去 —— 两个都要测，只测一个证明不了 mTLS。
//   · V9：审批**前**必须 403，审批**后**必须能进 —— 同上，只测一头不算。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { issueClientCert, revokeClientCert } from '../gateway/src/client-certs.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const GATEWAY_ENTRY = path.join(REPO, 'server', 'gateway', 'src', 'index.js')

let pass = 0
let fail = 0
const failures = []

function check(name, cond, info = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ❌ ${name}${info ? `  [${info}]` : ''}`)
  }
}

function say(title) {
  console.log(`\n===== ${title} =====`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// 单次 HTTPS 请求；TLS 层失败（含服务端拒绝客户端证书）也 resolve 成 { ok:false }，
// 因为"被拒"正是我们要断言的正常结果之一。
function request({ port, ca, cert, key, agent, method = 'GET', pathname = '/', body, cookie }) {
  return new Promise((resolve) => {
    const headers = { 'content-type': 'application/json' }
    if (cookie) headers.cookie = cookie
    const payload = body ? JSON.stringify(body) : null
    if (payload) headers['content-length'] = Buffer.byteLength(payload)

    const req = https.request(
      // 不设 servername：目标是 IP，带 SNI 的 IP 不合法，Node 会自己跳过
      { host: '127.0.0.1', port, path: pathname, method, headers, ca, cert, key, agent },
      (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => {
          let data = text
          try { data = JSON.parse(text) } catch { /* 非 JSON 就保留原文 */ }
          resolve({ ok: true, status: res.statusCode, data, headers: res.headers })
        })
      },
    )
    req.on('error', (e) => resolve({ ok: false, error: e }))
    if (payload) req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------- 准备

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-p1-verify-'))
const dataDir = path.join(tmp, 'users') // 与 resolveDataDir() 的口径一致
fs.mkdirSync(dataDir, { recursive: true })
const httpPort = await freePort()
const httpsPort = await freePort()

console.log('P1 遗留项验证：V8（mTLS 真机登录）+ V9（审批回程）')
console.log(`临时数据目录: ${tmp}`)
console.log(`临时端口    : https=${httpsPort} http(跳转)=${httpPort}（mTLS 必须跑在 TLS 上）`)

// 先签一张设备证书（网关启动时会读白名单）
const issued = issueClientCert({ dataDir, name: 'verify-device' })
const serverCertPath = path.join(dataDir, 'tls', 'cert.pem') // 网关启动时生成的自签服务端证书

const child = spawn(process.execPath, [GATEWAY_ENTRY], {
  env: {
    ...process.env,
    DSH_GATEWAY_DATA_DIR: tmp,
    DSH_GATEWAY_HOST: '127.0.0.1',
    DSH_GATEWAY_PORT: String(httpPort),
    DSH_GATEWAY_TLS: '1',
    DSH_GATEWAY_HTTPS_PORT: String(httpsPort),
    DSH_GATEWAY_MTLS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gwLog = ''
child.stdout.on('data', (c) => { gwLog += c })
child.stderr.on('data', (c) => { gwLog += c })
child.on('exit', (code) => {
  if (code !== 0 && code !== null) console.log(`[gw] 子进程退出 code=${code}`)
})

function shutdown() {
  try { child.kill('SIGTERM') } catch { /* 已退出 */ }
}

process.on('exit', shutdown)

// 等就绪：用已授权证书去探（不带证书会被 TLS 拒，探不出"服务是否起来"）
say('0) 等待网关就绪')

// 先等自签服务端证书落盘（网关在 listen 之前生成它）
for (let i = 0; i < 50 && !fs.existsSync(serverCertPath); i++) {
  await new Promise((res) => setTimeout(res, 100))
}
// ⚠️ 必须读成 PEM **内容**再传给 `ca`：现代 Node 把 tls 选项里的 `ca` 字符串当作 PEM 本体，
// 传文件路径不会被当路径读，结果是 CA 列表为空 ⇒ 一律 DEPTH_ZERO_SELF_SIGNED_CERT。
// （这个坑第一版就踩了，且现象很像"产品证书有缺陷"，故在此写明。）
const serverCa = fs.existsSync(serverCertPath) ? fs.readFileSync(serverCertPath, 'utf8') : ''
check('网关已生成自签服务端证书', serverCa.length > 0, serverCertPath)

let ready = false
for (let i = 0; i < 60; i++) {
  const r = await request({
    port: httpsPort, ca: serverCa,
    cert: issued.certPem, key: fs.readFileSync(issued.keyFile, 'utf8'),
    pathname: '/api/auth/registration-status',
  })
  if (r.ok) { ready = true; break }
  await new Promise((res) => setTimeout(res, 200))
}
check('网关在临时端口上起来了（HTTPS + mTLS）', ready)
if (!ready) {
  console.log('\n--- 网关输出 ---\n' + gwLog)
  console.log('未就绪，后续断言无意义，直接退出。')
  process.exit(1)
}

const clientKey = fs.readFileSync(issued.keyFile, 'utf8')
const allowed = { port: httpsPort, ca: serverCa, cert: issued.certPem, key: clientKey }

// ---------------------------------------------------------------- V8

say('V8) mTLS 客户端证书登录')

// V8-1：不带客户端证书 —— 必须进不去
let r = await request({ port: httpsPort, ca: serverCa, pathname: '/api/auth/registration-status' })
check('不带客户端证书 → 被拒（TLS 层）', r.ok === false, r.ok ? `status=${r.status}` : '')

// V8-2：带上已授权证书 —— 必须能到应用层（此处未登录，401 属预期，关键是"握手通过"）
r = await request({ ...allowed, pathname: '/api/auth/me' })
check('带已授权证书 → 握手通过到达应用层（未登录故 401）', r.ok && r.status === 401,
  r.ok ? `status=${r.status}` : `error=${r.error && r.error.code}`)

// V8-3：keep-alive 复用同一连接，验证"每请求复核"确实存在
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, ca: serverCa })
r = await request({ ...allowed, agent, pathname: '/api/auth/me' })
check('V8 keep-alive 连接建立成功', r.ok && r.status === 401, r.ok ? `status=${r.status}` : '')

// V8-4：吊销后原证书立即失效（不重启网关）
const revoked = revokeClientCert({ dataDir, name: 'verify-device' })
check('吊销接口返回成功', revoked === true)

const afterRevoke = await request({ ...allowed, agent, pathname: '/api/auth/me' })
const blockedAfterRevoke = afterRevoke.ok === false || afterRevoke.status === 403
check('吊销后 → 立即被拒（无需重启网关）', blockedAfterRevoke,
  afterRevoke.ok ? `status=${afterRevoke.status}` : `error=${afterRevoke.error && afterRevoke.error.code}`)

// V8-5：新连接同样被拒（走握手阶段的 secureConnection 白名单校验）
// ⚠️ 必须显式 `agent: false`：Node 的**全局 agent 自 v19 起默认 keep-alive**，
//    不关掉它这条"新连接"会静默复用池中连接 ⇒ 走的是每请求复核（request），
//    握手路径根本没被走到 —— 第一版就是这样，审计分布里只有 request、没有 handshake。
const fresh = await request({ ...allowed, agent: false, pathname: '/api/auth/me' })
check('吊销后新连接 → 也被拒', fresh.ok === false || fresh.status === 403,
  fresh.ok ? `status=${fresh.status}` : '')

// V8-6：审计留痕
// 等一小会儿：拒绝是在 socket 销毁路径上记的，可能比客户端的报错稍晚。
await new Promise((res) => setTimeout(res, 400))
const auditFile = path.join(tmp, 'logs', 'auth-audit.jsonl')
let auditLines = []
try {
  auditLines = fs.readFileSync(auditFile, 'utf8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
} catch { /* 没有审计文件就是缺口，下面的 info 会照实报出来 */ }
const denials = auditLines.filter((e) => e.event === 'auth.client_cert_denied')
const phases = [...new Set(denials.map((e) => e.phase))]
// 把分布直接打出来：check() 只在失败时显示 info，而"到底记了哪几类"本身就是证据
{
  const tally = new Map()
  for (const d of denials) {
    const k = `${d.phase || '(无 phase)'}${d.code ? ' / ' + d.code : ''}`
    tally.set(k, (tally.get(k) || 0) + 1)
  }
  console.log(`     审计文件: ${auditFile}`)
  console.log(`     拒绝记录 ${denials.length} 条：`)
  for (const [k, v] of tally) console.log(`       ${String(v).padStart(3)} × ${k}`)
}
check('审计里留下 auth.client_cert_denied 记录', denials.length > 0,
  `文件存在=${fs.existsSync(auditFile)} 行数=${auditLines.length} 拒绝次数=${denials.length} 阶段=${phases.join(',') || '(空)'}`)
// 三条拒绝路径都应留痕：handshake（链合法但未授权）/ handshake-invalid（链校验不过）/
// request（keep-alive 复用连接时的每请求复核）。
const KNOWN_PHASES = ['handshake', 'handshake-invalid', 'request']
check('审计能区分拒绝发生在哪条路径（phase）',
  phases.length > 0 && phases.every((p) => KNOWN_PHASES.includes(p)),
  `阶段=${phases.join(',') || '(空)'}（已知: ${KNOWN_PHASES.join(' / ')}）`)
check('「链校验不过」这类也留了痕（Q1 修复点）', phases.includes('handshake-invalid'),
  `阶段=${phases.join(',') || '(空)'}`)
// 三条路径要**逐个**验到，而不是"至少有一种"：
//   handshake-invalid ← V8-1 不带证书
//   request           ← V8-4 复用已建立的连接（吊销后复核）
//   handshake         ← V8-5 吊销后新建连接（需要 agent:false 才走得到）
const missingPhases = KNOWN_PHASES.filter((p) => !phases.includes(p))
check('三条拒绝路径都被实际走到并留痕', missingPhases.length === 0,
  `缺少: ${missingPhases.join(',') || '(无)'}；实际=${phases.join(',') || '(空)'}`)

// 重新签发一张，供 V9 用（V9 的请求也要过 mTLS）
const issued2 = issueClientCert({ dataDir, name: 'verify-device-2' })
const allowed2 = {
  port: httpsPort, ca: serverCa,
  cert: issued2.certPem, key: fs.readFileSync(issued2.keyFile, 'utf8'),
}
say('V8 附带：重新签发后可再次通过（证明吊销只针对那一张证书）')
r = await request({ ...allowed2, pathname: '/api/auth/me' })
check('新签发证书 → 可以进（401 未登录，属预期）', r.ok && r.status === 401,
  r.ok ? `status=${r.status}` : `error=${r.error && r.error.code}`)

// ---------------------------------------------------------------- V9

say('V9) 审批回程（pending → 审批 → 可进）')

const PASSWORD = 'verify123456'

function cookieOf(res) {
  const sc = res.ok && res.headers['set-cookie'] && res.headers['set-cookie'][0]
  const m = sc ? sc.match(/dsh_session=([^;]+)/) : null
  return m ? m[1] : null
}

// V9-1：全新环境下首个注册必须放行（否则永远建不出第一个管理员）
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/register', body: { name: 'v9-admin', password: PASSWORD } })
check('全新环境下首个注册成功', r.ok && r.status === 201, r.ok ? `status=${r.status}` : '')
check('首个账号为 admin', !!(r.data && r.data.user && r.data.user.role === 'admin'),
  JSON.stringify(r.data && r.data.user && r.data.user.role))

// V9-2：默认**关闭**自助注册 —— 先把这个 fail-closed 的姿态坐实，再谈审批
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/register', body: { name: 'v9-probe', password: PASSWORD } })
check('默认关闭自助注册：第二人直接注册被拒 403', r.ok && r.status === 403, r.ok ? `status=${r.status}` : '')
check('错误码为 REGISTRATION_DISABLED', !!(r.data && r.data.error && r.data.error.code === 'REGISTRATION_DISABLED'),
  JSON.stringify(r.data && r.data.error))

// V9-3：admin 登录
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/login', body: { name: 'v9-admin', password: PASSWORD } })
check('admin 登录成功', r.ok && r.status === 200, r.ok ? `status=${r.status}` : '')
const adminCookie = cookieOf(r)
check('admin 拿到会话 Cookie', !!adminCookie)

// V9-4：admin 打开自助注册（模拟真实流程：先开放，才有 pending 待审批）
if (adminCookie) {
  r = await request({ ...allowed2, method: 'PATCH', pathname: '/api/auth/settings', body: { allowPublicRegistration: true }, cookie: `dsh_session=${adminCookie}` })
  check('admin 打开自助注册', r.ok && r.status === 200 && r.data.settings.allowPublicRegistration === true,
    r.ok ? `status=${r.status}` : '')
} else {
  check('admin 打开自助注册', false, '上一步没拿到 Cookie')
}

// V9-5：第二个账号注册 → pending
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/register', body: { name: 'v9-user', password: PASSWORD } })
check('第二个注册账号为 pending', !!(r.data && r.data.user && r.data.user.role === 'pending'),
  r.ok ? `status=${r.status} role=${r.data && r.data.user && r.data.user.role}` : `status=${r.status}`)
const freshRegisterBody = r.data

// S2：重复注册一个**已存在**的名字，响应必须与"新注册"形状一致，否则可枚举账号
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/register', body: { name: 'v9-user', password: PASSWORD } })
const dupRegisterBody = r.data
check('【S2】重复注册返回 201（不暴露存在性）', r.ok && r.status === 201, r.ok ? `status=${r.status}` : '')
{
  const sameShape = !!freshRegisterBody && !!dupRegisterBody
    && JSON.stringify(Object.keys(dupRegisterBody).sort()) === JSON.stringify(Object.keys(freshRegisterBody).sort())
    && JSON.stringify(Object.keys(dupRegisterBody.user).sort()) === JSON.stringify(Object.keys(freshRegisterBody.user).sort())
    && dupRegisterBody.user.role === freshRegisterBody.user.role
  check('【S2】重复注册与首次注册的响应形状一致', sameShape,
    `首次=${JSON.stringify(freshRegisterBody)} 重复=${JSON.stringify(dupRegisterBody)}`)
}

// 注册响应刻意**不含 id**（S2 要求字段数不可区分），要拿 id 得走管理员接口
r = await request({ ...allowed2, method: 'GET', pathname: '/api/auth/users', cookie: `dsh_session=${adminCookie}` })
const userId = r.ok && Array.isArray(r.data.users)
  ? (r.data.users.find((u) => u.name === 'v9-user') || {}).id
  : undefined
check('可从管理员接口取到待审批账号的 id', !!userId,
  r.ok ? `users=${r.data.users && r.data.users.length}` : `status=${r.status}`)

// V10 端到端：登录签发的 Token 落盘时真的带 expiresAt
let tokensFile = null
try { tokensFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8')) } catch { /* 缺口 */ }
const created = tokensFile && tokensFile.tokens && tokensFile.tokens.find((t) => t.label === 'web-session')
check('【V10 端到端】登录签发的 Token 落盘时带 expiresAt', !!(created && created.expiresAt),
  created ? `字段: ${Object.keys(created).join(',')}` : '没读到 tokens.json')

// V9-6：【审批前】pending 账号登录必须被拒
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/login', body: { name: 'v9-user', password: PASSWORD } })
check('【审批前】pending 账号登录被拒 403', r.ok && r.status === 403, r.ok ? `status=${r.status}` : '')
check('错误码为 ACCOUNT_PENDING', !!(r.data && r.data.error && r.data.error.code === 'ACCOUNT_PENDING'),
  JSON.stringify(r.data && r.data.error))

// V9-7：admin 审批
r = await request({ ...allowed2, method: 'POST', pathname: `/api/auth/users/${userId}/approve`, cookie: `dsh_session=${adminCookie}` })
check('admin 审批成功，角色变为 user', r.ok && r.status === 200 && r.data.user.role === 'user',
  r.ok ? `status=${r.status} role=${r.data && r.data.user && r.data.user.role}` : '')

// V9-8：【审批后】同一账号必须能登录
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/login', body: { name: 'v9-user', password: PASSWORD } })
check('【审批后】同一账号登录成功 200', r.ok && r.status === 200, r.ok ? `status=${r.status}` : '')
const userCookie = cookieOf(r)
check('审批后拿到会话 Cookie', !!userCookie)

// V9-9a：审批后能过网关认证。
// 用 /api/auth/me —— 它由**网关自己**处理、不涉及上游内核，判据最干净。
if (userCookie) {
  r = await request({ ...allowed2, method: 'GET', pathname: '/api/auth/me', cookie: `dsh_session=${userCookie}` })
  check('审批后 /api/auth/me 返回该账号（网关自己处理，判据干净）',
    r.ok && r.status === 200 && r.data.user && r.data.user.name === 'v9-user',
    r.ok ? `status=${r.status} name=${r.data && r.data.user && r.data.user.name}` : '')
} else {
  check('审批后 /api/auth/me 返回该账号（网关自己处理，判据干净）', false, '上一步没拿到 Cookie')
}

// V9-9b：再打一个**会走代理**的业务接口。
// ⚠️ 这里的判据只能是"**网关没有用它自己的鉴权把它拦下**"，因为上游内核没随本脚本启动：
//    - 网关自己的拒绝形状固定为 { ok:false, error:{ code:'UNAUTHORIZED'|'ACCOUNT_PENDING'|'FORBIDDEN' } }
//    - 上游内核的 401（本机 3080 上可能另有一个实例）恰恰说明请求**已经过了网关**，对本项是"通过"
//   把响应体打出来，避免含糊。
if (userCookie) {
  r = await request({ ...allowed2, method: 'POST', pathname: '/api/session.list', body: {}, cookie: `dsh_session=${userCookie}` })
  const code = r.data && r.data.error && r.data.error.code
  const gatewayRejected = !r.ok || code === 'UNAUTHORIZED' || code === 'ACCOUNT_PENDING' || code === 'FORBIDDEN'
  check('审批后访问业务接口 → 未被网关鉴权拦下', !gatewayRejected,
    r.ok ? `status=${r.status} code=${code || '-'}` : `error=${r.error && r.error.code}`)
} else {
  check('审批后访问业务接口 → 未被网关鉴权拦下', false, '上一步没拿到 Cookie')
}

// V9-10：反向对照 —— 第三个未审批账号仍然进不来
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/register', body: { name: 'v9-user2', password: PASSWORD } })
const secondPending = !!(r.data && r.data.user && r.data.user.role === 'pending')
r = await request({ ...allowed2, method: 'POST', pathname: '/api/auth/login', body: { name: 'v9-user2', password: PASSWORD } })
check('【反向对照】另一个未审批账号仍被拒 403', secondPending && r.ok && r.status === 403,
  r.ok ? `status=${r.status} 注册时是 pending=${secondPending}` : '')

// ---------------------------------------------------------------- 收尾

console.log('\n' + '='.repeat(60))
console.log(`V8/V9 验证结果：pass=${pass} fail=${fail}`)
if (fail > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '))
}
console.log(`临时目录（已保留供排查）: ${tmp}`)
shutdown()
process.exit(fail > 0 ? 1 : 0)
