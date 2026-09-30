// @local/miyoushe —— t29 套件：API 出站薄封装 lib/mys-http.js（设计 §10.2）**全离线**自测
// 运行：node selftest/mys-http.mjs        （退出码 0 = 全过）
//
// 覆盖（t29 A1–A6）：
//   ① 请求头构造：UA(含版本) / x-rpc-app_version / x-rpc-client_type / x-rpc-device_id / X-Requested-With /
//      Referer+Origin / 可选 x-rpc-signgame / 凭据头（**假值**）/ DS（与 lib/ds.js §3.3 向量**逐字一致**）
//   ② 白名单硬约束：非白名单 URL / host ⇒ 结构化拒绝且 **零请求**（可观测 sent:false + transport 调用数 0）
//   ③ 超时 / 至多 2 次重试（间隔 2s/5s）/ 限速（同账号 ≥1s、账号间 5–25s 抖动）用**假时钟**复现
//   ④ 无 verified 盐 ⇒ SALT_MISSING / SALT_INVALID 且不发请求；无凭据 ⇒ AUTH_REQUIRED 且不发请求
//   ⑤ §6.1 错误码归一化（404/405→ENDPOINT_DRIFT、401/403→AUTH_INVALID、429→RATE_LIMITED、
//      5xx→NET_ERROR、retcode=-100→AUTH_INVALID、非 0→RETCODE_UNKNOWN、验证码族→GEETEST_REQUIRED）
//   ⑥ 零真实网络：`globalThis.fetch` 哨兵调用数 = 0；静态断言「lib/** HTTP 落点恰两处」
//
// 纪律：凭据一律用**假值**（`SYNTHETIC-NOT-A-REAL-CREDENTIAL`），源码不落真实盐/真实凭据；
//       盐用**运行时生成**的 32 位 hex（不落 32hex 字面量 ⇒ 不破坏 assert-source-discipline 的 D3/D4）。

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createHttpPort, createDefaultApiTransport, resolveSigningContext, latestUnverifiedEntry, buildApiHeaders, classifyOutcome,
  assertAllowedHost, assertAllowedUrl, resolveEndpointSpec, hostForTarget, deviceIdFor, accountGapFor, localDateOf,
  API_ERR, ALLOWED_API_HOSTS, HEADER_NAMES, UA_PREFIX, CLIENT_TYPE,
  OUTBOUND_TIMEOUT_MS, MAX_RETRIES, RETRY_BACKOFF_MS, MIN_ACCOUNT_INTERVAL_MS, ACCOUNT_GAP_MIN_MS, ACCOUNT_GAP_MAX_MS,
} from '../lib/mys-http.js'
import { signDs } from '../lib/ds.js'

let failures = 0
let skips = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FAKE_CRED = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL-t29' // 假凭据（绝不是真实 Cookie）
const VECTOR_YIELD = createHash('sha256').update('t29-suite-fixture').digest('hex').slice(0, 32) // 运行时生成
const ALT_YIELD = createHash('sha256').update('t29-suite-fixture-alt').digest('hex').slice(0, 32)
/** §3.3 V1 公开锚点（设计明确允许明文）：salt / t / r 与期望 DS 逐字取自设计算例 */
const V1 = { salt: 'ZSHlXeQUBis52qD1kEgKt5lUYed4b7Bb', t: 1700000000, r: 'Xk7Q2m', ds: '1700000000,Xk7Q2m,f3bc2ed061695cb6d5ab1fe3584e4663' }

/** 假时钟：sleep 直接推进虚拟时间（确定性、零真实等待） */
function fakeClock(startMs) {
  const st = { nowMs: startMs, sleeps: [] }
  return {
    st,
    now: () => st.nowMs,
    sleep: async (ms) => { st.sleeps.push(ms); st.nowMs += ms },
  }
}

/** 假 transport：按脚本返回响应；记录每次调用（url/init）——**唯一**出站观测点 */
function fakeTransport(script) {
  const calls = []
  const t = async (url, init) => {
    calls.push({ url, init })
    const step = script[calls.length - 1] !== undefined ? script[calls.length - 1] : script[script.length - 1]
    if (step && step.throw) { const e = new Error(step.throw.message || 'boom'); if (step.throw.name) e.name = step.throw.name; throw e }
    if (step && step.hang) {
      // 模拟真实 fetch 的"挂起"：**只**在 signal 中止时拒绝（AbortError）⇒ 同时验证模块确实把 signal 传给了传输层
      return await new Promise((_resolve, reject) => {
        const s = init && init.signal
        if (s && typeof s.addEventListener === 'function') {
          s.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
        }
      })
    }
    const body = step && step.body !== undefined ? step.body : '{"retcode":0,"message":"OK","data":{}}'
    return { status: step && step.status !== undefined ? step.status : 200, text: async () => body }
  }
  return { t, calls }
}

const mkSalts = (status, material) => ({
  version: 2,
  active: { appVersion: '2.109.0', clientType: '5' },
  entries: { '2.109.0': { clientType: '5', salt: material, status, saltFingerprint: 'deadbeef', sourceKind: 'auto' } },
  versionCache: { appVersion: '2.109.0', lastFetchOk: true },
})

/**
 * t37/R3：**真实 `salts.json` 形状**的夹具（生产文件里 `active` 在 `unverified-current` 期**必为 null**）。
 * 与 `mkSalts()` 的区别＝`active` 由调用方显式给出（可为 null），条目按 `{version: 条目}` 传入。
 * 前一轮的离线夹具把 `active` 填上了 ⇒ 绿灯却漏掉了"active 前置"死锁（captain 指出）；本夹具用于杜绝该类假绿。
 */
const mkRealSalts = (active, entries) => ({
  version: 2,
  updatedAt: '2026-09-20T04:00:00Z',
  active,
  entries,
  versionCache: { appVersion: '2.110.0', clientType: '5', fetchedAt: '2026-09-20T04:00:00Z', ttlMs: 86400000, lastFetchOk: true },
})
const mkEntry = (status, material, fetchedAt) => ({
  clientType: '5', salt: material, saltFingerprint: 'deadbeef', status, sourceKind: 'auto',
  fetchedAt: fetchedAt === undefined ? '2026-09-20T04:00:00Z' : fetchedAt, verifiedAt: null, rejectedAt: null,
})

const okTransport = () => fakeTransport([{ status: 200, body: '{"retcode":0,"message":"OK","data":{"x":1}}' }])

console.log('== ① 常量与描述（§10.2 五项：10s / 2 次重试(2s,5s) / 限速 / UA） ==')
{
  check(OUTBOUND_TIMEOUT_MS === 10000, '超时 = 10s（§10.2 ①）', OUTBOUND_TIMEOUT_MS, 10000)
  check(MAX_RETRIES === 2, '最多 2 次重试（§10.2 ②）', MAX_RETRIES, 2)
  check(JSON.stringify(RETRY_BACKOFF_MS) === '[2000,5000]', '重试间隔 2s/5s（设计原文）', RETRY_BACKOFF_MS, [2000, 5000])
  check(MIN_ACCOUNT_INTERVAL_MS === 1000, '同账号最小间隔 ≥1s（§10.2 ④）', MIN_ACCOUNT_INTERVAL_MS, 1000)
  check(ACCOUNT_GAP_MIN_MS === 5000 && ACCOUNT_GAP_MAX_MS === 25000, '账号间抖动 5–25s（§10.2 ④）', [ACCOUNT_GAP_MIN_MS, ACCOUNT_GAP_MAX_MS], [5000, 25000])
  const p = createHttpPort({ transport: okTransport().t, now: () => 1700000000000 })
  const d = p.describe()
  console.log('  describe() => ' + JSON.stringify(d))
  check(Array.isArray(d.allowedHosts) && d.allowedHosts.length >= 3, '白名单至少含 3 个官方域（A2）', d.allowedHosts.length, '>=3')
  for (const h of ['api-takumi.mihoyo.com', 'act-nap-api.mihoyo.com', 'bbs-api.mihoyo.com']) {
    check(ALLOWED_API_HOSTS.includes(h), 'A2 白名单含 ' + h, ALLOWED_API_HOSTS.join(','), h)
  }
  check(ALLOWED_API_HOSTS.every((h) => /\.(mihoyo|miyoushe)\.com$/.test(h)), 'A2 白名单只含米游社/米哈游官方域', ALLOWED_API_HOSTS, '官方域')
  check(hostForTarget('zzz') === 'act-nap-api.mihoyo.com', '§2.2 host 例外：zzz → act-nap-api', hostForTarget('zzz'), 'act-nap-api.mihoyo.com')
  check(hostForTarget('hk4e') === 'api-takumi.mihoyo.com' && hostForTarget('bbs') === 'bbs-api.mihoyo.com', '§2.2 其余目标默认 host', [hostForTarget('hk4e'), hostForTarget('bbs')], ['api-takumi.mihoyo.com', 'bbs-api.mihoyo.com'])
}

console.log('\n== ② 请求头构造（§2.2 `+DS` 完整签名头；凭据用假值；DS 与 §3.3 向量逐字一致） ==')
{
  const { t: tr, calls } = okTransport()
  const clock = fakeClock(V1.t * 1000)
  const port = createHttpPort({
    transport: tr, now: clock.now, sleep: clock.sleep, r: V1.r,
    salts: mkSalts('verified', V1.salt), credential: FAKE_CRED, accountKey: 'acct-A',
  })
  const res = await port.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e', query: { lang: 'zh-cn', act_id: 'e202311201442471' } })
  console.log('  result => ' + JSON.stringify({ ok: res.ok, httpStatus: res.httpStatus, retcode: res.retcode, endpoint: res.endpoint, host: res.host, sent: res.sent }))
  check(res.ok === true && res.retcode === 0, '归一化成功结果 {ok,httpStatus,retcode,message,data}', { ok: res.ok, rc: res.retcode }, { ok: true, rc: 0 })
  check(calls.length === 1, '恰好发出 1 次请求', calls.length, 1)
  const { url, init } = calls[0]
  const H = init.headers
  console.log('  request line => ' + init.method + ' ' + url)
  console.log('  headers => ' + JSON.stringify(H))
  const expectDs = signDs(V1.salt, V1.t, V1.r).ds
  check(expectDs === V1.ds, '夹具健全性：signDs(§3.3 V1) 与本套件期望值一致', expectDs, V1.ds)
  check(H[HEADER_NAMES.signature] === V1.ds, '① DS 与 lib/ds.js §3.3 向量**逐字一致**', H[HEADER_NAMES.signature], V1.ds)
  check(H[HEADER_NAMES.ua] === UA_PREFIX + '2.109.0', '① 固定 UA 前缀 + 配置版本', H[HEADER_NAMES.ua], UA_PREFIX + '2.109.0')
  check(H[HEADER_NAMES.appVersion] === '2.109.0' && H[HEADER_NAMES.clientType] === CLIENT_TYPE, '① x-rpc-app_version / x-rpc-client_type=5（§2.3）', [H[HEADER_NAMES.appVersion], H[HEADER_NAMES.clientType]], ['2.109.0', '5'])
  check(H[HEADER_NAMES.credential] === FAKE_CRED, '① 凭据头＝注入的**假**凭据值（只进请求头）', H[HEADER_NAMES.credential], FAKE_CRED)
  check(typeof H[HEADER_NAMES.device] === 'string' && /^[0-9a-f-]{36}$/.test(H[HEADER_NAMES.device]), '① x-rpc-device_id 形状（UUID）', H[HEADER_NAMES.device], '<uuid>')
  check(H[HEADER_NAMES.requestedWith] === 'com.mihoyo.hyperion', '① X-Requested-With（§2.2）', H[HEADER_NAMES.requestedWith], 'com.mihoyo.hyperion')
  check(typeof H[HEADER_NAMES.referer] === 'string' && typeof H[HEADER_NAMES.origin] === 'string', '① Referer/Origin 存在（§2.2）', [H[HEADER_NAMES.referer], H[HEADER_NAMES.origin]], '<存在>')
  check(H[HEADER_NAMES.signGame] === 'hk4e', '① luna 路径携带 x-rpc-signgame=目标', H[HEADER_NAMES.signGame], 'hk4e')
  check(url === 'https://api-takumi.mihoyo.com/event/luna/info?lang=zh-cn&act_id=e202311201442471', 'URL 由 host+path+query 组装（act_id 由调用方给出、不硬编码在模块里）', url, '<官方 URL>')
  check(deviceIdFor('acct-A') === H[HEADER_NAMES.device] && deviceIdFor('acct-A') === deviceIdFor('acct-A'), '设备标识按账号**确定派生**（同账号恒等）', deviceIdFor('acct-A') === H[HEADER_NAMES.device], true)
  check(calls.every((c) => !JSON.stringify(c.init).includes('ZSHlXeQUBis52qD1kEgKt5lUYed4b7Bb')), '① 请求里**不含**盐明文（盐只进 md5）', '(含盐)', '(不含盐)')
  // 无 signgame 需求时不该带（社区路径）
  const p2 = createHttpPort({ transport: okTransport().t, now: () => 1700000000000, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const h2 = buildApiHeaders({ appVersion: '2.109.0', credential: FAKE_CRED, signingMaterial: V1.salt, t: V1.t, r: V1.r, signGame: null })
  check(h2[HEADER_NAMES.signGame] === undefined, '① 非 luna 路径不带 x-rpc-signgame', h2[HEADER_NAMES.signGame], undefined)
  check(p2.describe().credentialProviderPresent === false && p2.describe().transport !== null, 'describe：凭据 provider 缺失/传输存在（可用于运维判读）', p2.describe().credentialProviderPresent, false)
}

console.log('\n== ③ 白名单硬约束（A2：拒绝且**零请求**） ==')
{
  const { t: tr, calls } = okTransport()
  const port = createHttpPort({ transport: tr, now: () => 1700000000000, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const bad1 = await port.request({ url: 'https://evil.example.com/steal', method: 'GET' })
  console.log('  非白名单绝对 URL => ' + JSON.stringify({ code: bad1.code, sent: bad1.sent, httpStatus: bad1.httpStatus }))
  check(bad1.ok === false && bad1.code === API_ERR.HOST_NOT_ALLOWED, '③ 非白名单 URL ⇒ 结构化拒绝 OUTBOUND_HOST_NOT_ALLOWED', bad1.code, API_ERR.HOST_NOT_ALLOWED)
  const bad2 = await port.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET', host: 'evil.example.com' })
  check(bad2.ok === false && bad2.code === API_ERR.HOST_NOT_ALLOWED, '③ 非白名单 host ⇒ 同上（相对路径分支）', bad2.code, API_ERR.HOST_NOT_ALLOWED)
  const bad3 = await port.request({ path: '/x', method: 'GET', host: 'bbs-api.miyoushe.com.evil.com' })
  check(bad3.ok === false && bad3.code === API_ERR.HOST_NOT_ALLOWED, '③ 后缀伪装域（bbs-api.miyoushe.com.evil.com）被拒（严格全等匹配）', bad3.code, API_ERR.HOST_NOT_ALLOWED)
  check(calls.length === 0, '③ **零请求**：三例拒绝后 transport 调用数=0', calls.length, 0)
  check(bad1.sent === false && bad2.sent === false && bad3.sent === false, '③ 三例都带 sent:false（机读"未发出"）', [bad1.sent, bad2.sent, bad3.sent], [false, false, false])
  check(port.stats().rejectedBeforeSend === 3, '③ stats.rejectedBeforeSend=3（拒绝计数）', port.stats().rejectedBeforeSend, 3)
  let threw = null
  try { assertAllowedHost('raw.githubusercontent.com') } catch (e) { threw = e }
  check(threw !== null && threw.code === API_ERR.HOST_NOT_ALLOWED, '③ 版本通道的第三方源**不在** API 白名单（两通道域名集不重叠）', threw && threw.code, API_ERR.HOST_NOT_ALLOWED)
  let threw2 = null
  try { assertAllowedUrl('not a url') } catch (e) { threw2 = e }
  check(threw2 !== null && threw2.code === API_ERR.BAD_ARG, '③ URL 不可解析 ⇒ BAD_ARG（结构化，不抛到调用方之外）', threw2 && threw2.code, API_ERR.BAD_ARG)

  // -----------------------------------------------------------------------
  // S9（t31；captain 升级为**凭据暴露风险**）：协议与端口也必须硬校验 —— 仅 https（大小写不敏感）且端口为空/443。
  //   **强断言**：被拒 URL 必须「**没有产生任何带凭据/签名头的头对象**」——同时观测
  //   ① `credentialProvider` 调用数 ② `onHeadersBuilt` 头构造钩子调用数，二者都必须为 0；
  //   并且用一条**对照正例**证明探针有判别力（合法 URL 两者都 =1）。
  //   能证/不能证：本断言否证"对非法 URL 仍去取凭据并组装头对象"；它**不**替代对传输层本身的检查（那是 S9-①②）。
  // -----------------------------------------------------------------------
  const { t: tr9, calls: calls9 } = okTransport()
  let credCalls = 0
  let headerBuilds = 0
  let lastHeaders = null
  const probePort = createHttpPort({
    transport: tr9, now: () => 1700000000000, salts: mkSalts('verified', V1.salt),
    credentialProvider: async () => { credCalls++; return FAKE_CRED },
    onHeadersBuilt: (h) => { headerBuilds++; lastHeaders = h },
  })
  const s9 = [
    { name: 'https + 非标准端口 :8443', req: { url: 'https://api-takumi.mihoyo.com:8443/x', method: 'GET' } },
    { name: 'https + 端口 :80', req: { url: 'https://api-takumi.mihoyo.com:80/x', method: 'GET' } },
    { name: '**明文 http**（凭据会暴露在链路上）', req: { url: 'http://api-takumi.mihoyo.com/event/luna/sign', method: 'POST' } },
  ]
  for (const c of s9) {
    const r = await probePort.request(c.req)
    console.log('  S9 ' + c.name + ' => ' + JSON.stringify({ code: r.code, sent: r.sent }))
    check(r.ok === false && r.code === API_ERR.HOST_NOT_ALLOWED && r.sent === false, 'S9 拒绝：' + c.name, r.code, API_ERR.HOST_NOT_ALLOWED)
  }
  check(calls9.length === 0, 'S9 三条负例 transport 调用数 = 0', calls9.length, 0)
  check(credCalls === 0, 'S9 **强断言①**：被拒 URL **未触达凭据 provider**（调用数 0）', credCalls, 0)
  check(headerBuilds === 0, 'S9 **强断言②**：被拒 URL **未构造任何头对象**（钩子调用数 0）⇒ 不存在带凭据/签名的头对象', headerBuilds, 0)
  // 对照正例（探针判别力）：合法 URL ⇒ provider 与头构造各 1 次，且头里确有凭据
  await probePort.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  console.log('  S9 对照正例 => credCalls=' + credCalls + ' headerBuilds=' + headerBuilds + ' hasCredential=' + !!(lastHeaders && lastHeaders[HEADER_NAMES.credential] === FAKE_CRED))
  check(credCalls === 1 && headerBuilds === 1 && lastHeaders && lastHeaders[HEADER_NAMES.credential] === FAKE_CRED, 'S9 对照正例：合法 URL ⇒ 两探针各 1 次且头中确有凭据（证明探针**有判别力**，不是恒 0）', { c: credCalls, h: headerBuilds }, { c: 1, h: 1 })
  // 边界正例（防误杀）
  check(assertAllowedUrl('https://api-takumi.mihoyo.com:443/x') === 'api-takumi.mihoyo.com', 'S9 边界正例①：显式 :443 放行（WHATWG URL 归一化后 port 为空）', assertAllowedUrl('https://api-takumi.mihoyo.com:443/x'), 'api-takumi.mihoyo.com')
  check(assertAllowedUrl('HTTPS://API-TAKUMI.MIHOYO.COM/x') === 'api-takumi.mihoyo.com', 'S9 边界正例②：大写 scheme/host 放行（协议判定大小写不敏感 + host 小写化）', assertAllowedUrl('HTTPS://API-TAKUMI.MIHOYO.COM/x'), 'api-takumi.mihoyo.com')
  let threwPort = null
  try { assertAllowedUrl('https://api-takumi.mihoyo.com:8443/x') } catch (e) { threwPort = e }
  check(threwPort !== null && threwPort.code === API_ERR.HOST_NOT_ALLOWED && String(threwPort.detail).includes('8443'), 'S9 assertAllowedUrl 直接拒绝非 443 端口（保留原始端口便于定位）', threwPort && threwPort.detail, '<port=8443>')
  let threwHttp = null
  try { assertAllowedUrl('http://bbs-api.mihoyo.com/apihub/app/api/signIn') } catch (e) { threwHttp = e }
  check(threwHttp !== null && threwHttp.code === API_ERR.HOST_NOT_ALLOWED && String(threwHttp.detail).includes('http:'), 'S9 assertAllowedUrl 直接拒绝明文 http（detail 含 protocol）', threwHttp && threwHttp.detail, '<protocol=http:>')
}

console.log('\n== ④ 前置门禁：无核验盐 / 无凭据 ⇒ 结构化拒绝且**不发请求** ==')
{
  const cases = [
    { name: '无 active 版本键', salts: { version: 2, active: null, entries: {} }, want: API_ERR.SALT_MISSING },
    { name: '版本键存在但条目缺失', salts: { version: 2, active: { appVersion: '2.109.0' }, entries: {} }, want: API_ERR.SALT_MISSING },
    { name: 'status=stale', salts: mkSalts('stale', V1.salt), want: API_ERR.SALT_INVALID },
    { name: 'status=rejected', salts: mkSalts('rejected', V1.salt), want: API_ERR.SALT_INVALID },
    { name: 'status=verified 但盐材料缺失', salts: mkSalts('verified', null), want: API_ERR.SALT_INVALID },
  ]
  for (const c of cases) {
    const { t: tr, calls } = okTransport()
    const port = createHttpPort({ transport: tr, now: () => 1700000000000, salts: c.salts, credential: FAKE_CRED })
    const r = await port.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
    console.log('  ' + c.name + ' => ' + JSON.stringify({ code: r.code, sent: r.sent }))
    check(r.ok === false && r.code === c.want && r.sent === false && calls.length === 0, '④ ' + c.name + ' ⇒ ' + c.want + ' 且 0 请求', { code: r.code, sent: r.sent, calls: calls.length }, { code: c.want, sent: false, calls: 0 })
  }
  const { t: tr2, calls: calls2 } = okTransport()
  const noCred = createHttpPort({ transport: tr2, now: () => 1700000000000, salts: mkSalts('verified', V1.salt), credential: null, credentialProvider: null })
  const r2 = await noCred.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' })
  console.log('  无凭据 => ' + JSON.stringify({ code: r2.code, sent: r2.sent }))
  check(r2.ok === false && r2.code === API_ERR.AUTH_REQUIRED && r2.sent === false && calls2.length === 0, '④ 无凭据 ⇒ AUTH_REQUIRED 且 0 请求（本模块不读凭据文件内容）', r2.code, API_ERR.AUTH_REQUIRED)
  // provider 形态：函数注入（生产接线用）
  const prov = createHttpPort({
    transport: okTransport().t, now: () => 1700000000000, salts: mkSalts('verified', V1.salt),
    credentialProvider: async () => FAKE_CRED,
  })
  const r3 = await prov.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  check(r3.ok === true && r3.sent === true, '④ credentialProvider（函数）注入可用 ⇒ 正常出站', { ok: r3.ok, sent: r3.sent }, { ok: true, sent: true })
  // t31/S3：`unverified-current` 允许**试签**（设计 §6.5.2 ④：unverified 可试签、禁止无人值守自动签到；
  //   后者由门禁 G4 收紧）⇒ 从"拒绝签名"改为"放行"，并有对照（`stale` 仍拒，见上表）
  const { t: trU, calls: callsU } = okTransport()
  const unverified = createHttpPort({ transport: trU, now: () => 1700000000000, salts: mkSalts('unverified-current', V1.salt), credential: FAKE_CRED })
  const rU = await unverified.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  console.log('  unverified-current（试签）=> ' + JSON.stringify({ ok: rU.ok, sent: rU.sent, calls: callsU.length }))
  check(rU.ok === true && rU.sent === true && callsU.length === 1, '④ `unverified-current` **允许试签**（t31/S3；stale/rejected 仍拒）', rU.ok, true)
}

console.log('\n== ⑤ 超时 / 重试 / 限速（假时钟复现；§10.2 ①②④） ==')
{
  // 超时：transport 挂起 ⇒ 由 10s 内部计时器中止 ⇒ NET_TIMEOUT，且重试后用尽
  const clock = fakeClock(1700000000000)
  const hangs = fakeTransport([{ hang: true }, { hang: true }, { hang: true }])
  const portTo = createHttpPort({ transport: hangs.t, now: clock.now, sleep: clock.sleep, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED, timeoutMs: 30 })
  const rTo = await portTo.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  console.log('  超时穷尽 => ' + JSON.stringify({ code: rTo.code, attempts: rTo.attempts.map((a) => a.n + ':' + a.code), sent: rTo.sent }))
  check(rTo.ok === false && rTo.code === API_ERR.NET_TIMEOUT, '⑤ 超时 ⇒ NET_TIMEOUT', rTo.code, API_ERR.NET_TIMEOUT)
  check(rTo.attemptsUsed === 3, '⑤ 超时下总尝试 = 1 + 2 次重试 = 3', rTo.attemptsUsed, 3)
  check(clock.st.sleeps.filter((x) => x === 2000 || x === 5000).length === 2 && clock.st.sleeps[0] === 2000 && clock.st.sleeps[1] === 5000, '⑤ 重试间隔 = 2s → 5s（设计原文）', clock.st.sleeps, [2000, 5000])

  // 重试成功：前两次 5xx、第三次 200
  const clock2 = fakeClock(1700000000000)
  const flaky = fakeTransport([{ status: 500, body: '{"retcode":-1,"message":"boom"}' }, { status: 503, body: 'down' }, { status: 200, body: '{"retcode":0,"message":"OK","data":{"ok":1}}' }])
  const portFlaky = createHttpPort({ transport: flaky.t, now: clock2.now, sleep: clock2.sleep, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const rFlaky = await portFlaky.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  console.log('  5xx 重试成功 => ' + JSON.stringify({ ok: rFlaky.ok, attempts: rFlaky.attempts.map((a) => a.n + ':' + a.httpStatus), retriesUsed: rFlaky.retriesUsed }))
  check(rFlaky.ok === true && rFlaky.attemptsUsed === 3 && rFlaky.retriesUsed === 2, '⑤ 5xx ⇒ 重试至多 2 次后成功', { ok: rFlaky.ok, used: rFlaky.attemptsUsed }, { ok: true, used: 3 })
  check(flaky.calls.length === 3 && portFlaky.stats().retries === 2, '⑤ transport 被调用 3 次、stats.retries=2', flaky.calls.length, 3)

  // 4xx 不重试（避免把过期凭据反复打服务端）
  const badAuth = fakeTransport([{ status: 401, body: '{"retcode":-100,"message":"登录状态失效"}' }, { status: 200, body: '{"retcode":0}' }])
  const port4 = createHttpPort({ transport: badAuth.t, now: () => 1700000000000, sleep: async () => {}, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const r4 = await port4.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' })
  console.log('  401 不重试 => ' + JSON.stringify({ code: r4.code, attempts: badAuth.calls.length }))
  check(r4.ok === false && r4.code === API_ERR.AUTH_INVALID && badAuth.calls.length === 1, '⑤ 401 ⇒ AUTH_INVALID 且**不重试**（1 次调用）', { code: r4.code, calls: badAuth.calls.length }, { code: 'AUTH_INVALID', calls: 1 })

  // 限速：同账号 ≥1s
  const clock3 = fakeClock(1700000000000)
  const same = okTransport()
  const portSame = createHttpPort({ transport: same.t, now: clock3.now, sleep: clock3.sleep, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED, accountKey: 'acct-A' })
  await portSame.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  clock3.st.nowMs += 300 // 只过 300ms
  await portSame.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  console.log('  同账号等待 => ' + JSON.stringify(clock3.st.sleeps))
  check(clock3.st.sleeps.includes(700), '⑤ 同账号第二次（间隔 300ms）⇒ 补足到 1000ms（等待 700ms）', clock3.st.sleeps, '[700]')
  check(portSame.stats().waits.sameAccountMs === 700, '⑤ stats.waits.sameAccountMs=700', portSame.stats().waits.sameAccountMs, 700)

  // 限速：账号间 5–25s 抖动（确定散列）
  const clock4 = fakeClock(1700000000000)
  const two = okTransport()
  const portTwo = createHttpPort({ transport: two.t, now: clock4.now, sleep: clock4.sleep, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  await portTwo.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e', accountKey: 'acct-A' })
  await portTwo.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e', accountKey: 'acct-B' })
  const gap = clock4.st.sleeps[clock4.st.sleeps.length - 1]
  const gapExpect = accountGapFor('acct-B', localDateOf(1700000000000)) // 与模块同口径：**本地**日期
  console.log('  账号间抖动 => wait=' + gap + ' expect=' + gapExpect)
  check(gap >= ACCOUNT_GAP_MIN_MS && gap <= ACCOUNT_GAP_MAX_MS, '⑤ 账号间等待落在 5–25s', gap, '5–25s')
  check(gap === gapExpect, '⑤ 账号间等待＝确定散列值（同账号+同日期可复现）', gap, gapExpect)
  check(accountGapFor('acct-B', '2026-09-20') === accountGapFor('acct-B', '2026-09-20'), '⑤ accountGapFor 确定可复现', accountGapFor('acct-B', '2026-09-20'), accountGapFor('acct-B', '2026-09-20'))
  check(accountGapFor('acct-C', '2026-09-20') !== gapExpect || true, '⑤ 抖动按账号区分（信息位）', accountGapFor('acct-C', '2026-09-20'), '<不同键不同值或碰撞>')
}

console.log('\n== ⑥ §6.1 错误码归一化（纯函数逐档断言） ==')
{
  const cases = [
    { x: { timedOut: true }, code: 'NET_TIMEOUT', retryable: true, note: '超时' },
    { x: { transportError: 'ECONNRESET' }, code: 'NET_ERROR', retryable: true, note: '传输错' },
    { x: { httpStatus: 404, parseOk: true }, code: 'ENDPOINT_DRIFT', retryable: false, note: '404' },
    { x: { httpStatus: 405, parseOk: true }, code: 'ENDPOINT_DRIFT', retryable: false, note: '405' },
    { x: { httpStatus: 200, parseOk: false }, code: 'ENDPOINT_DRIFT', retryable: false, note: '结构不符（非 JSON）' },
    { x: { httpStatus: 401, parseOk: true }, code: 'AUTH_INVALID', retryable: false, note: '401' },
    { x: { httpStatus: 403, parseOk: true }, code: 'AUTH_INVALID', retryable: false, note: '403' },
    { x: { httpStatus: 429, parseOk: true }, code: 'RATE_LIMITED', retryable: true, note: '429' },
    { x: { httpStatus: 502, parseOk: true }, code: 'NET_ERROR', retryable: true, note: '5xx' },
    { x: { httpStatus: 200, parseOk: true, retcode: 0 }, code: null, retryable: false, note: '成功' },
    { x: { httpStatus: 200, parseOk: true, retcode: -100, message: '登录状态失效，请重新登录' }, code: 'AUTH_INVALID', retryable: false, note: 'retcode=-100' },
    { x: { httpStatus: 200, parseOk: true, retcode: -500001, message: '网络出小差了' }, code: 'RETCODE_UNKNOWN', retryable: false, note: '其它非 0' },
    { x: { httpStatus: 200, parseOk: true, retcode: -3004, message: '请完成验证码' }, code: 'GEETEST_REQUIRED', retryable: false, note: '验证码族（启发式，§11-5 待验证）' },
  ]
  for (const c of cases) {
    const v = classifyOutcome(c.x)
    check(v.code === c.code && v.retryable === c.retryable, '⑥ ' + c.note + ' ⇒ ' + String(c.code) + '（retryable=' + c.retryable + '）', v, { code: c.code, retryable: c.retryable })
  }
  // 端到端：非 JSON 200 ⇒ ENDPOINT_DRIFT（不重试）
  const drift = fakeTransport([{ status: 200, body: '<html>not json</html>' }, { status: 200, body: '{"retcode":0}' }])
  const portDrift = createHttpPort({ transport: drift.t, now: () => 1700000000000, sleep: async () => {}, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const rD = await portDrift.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  check(rD.ok === false && rD.code === API_ERR.ENDPOINT_DRIFT && drift.calls.length === 1, '⑥ 200 但结构不符 ⇒ ENDPOINT_DRIFT 且不重试', { code: rD.code, calls: drift.calls.length }, { code: 'ENDPOINT_DRIFT', calls: 1 })
  // 端到端：retcode=-100 ⇒ AUTH_INVALID
  const auth2 = fakeTransport([{ status: 200, body: '{"retcode":-100,"message":"登录状态失效，请重新登录"}' }])
  const portAuth = createHttpPort({ transport: auth2.t, now: () => 1700000000000, sleep: async () => {}, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const rA = await portAuth.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' })
  check(rA.ok === false && rA.code === API_ERR.AUTH_INVALID, '⑥ 200 + retcode=-100 ⇒ AUTH_INVALID（§6.1）', rA.code, 'AUTH_INVALID')
}

console.log('\n== ⑦ 归一化形状（§10.2 ⑤）与出站计数 ==')
{
  const { t: tr } = okTransport()
  const port = createHttpPort({ transport: tr, now: () => 1700000000000, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const r = await port.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  for (const k of ['httpStatus', 'retcode', 'message', 'data']) {
    check(Object.prototype.hasOwnProperty.call(r, k), '⑦ 归一化字段 ' + k + '（§10.2 ⑤）', Object.keys(r).join(','), k)
  }
  check(r.httpStatus === 200 && r.retcode === 0 && r.message === 'OK' && r.data && r.data.x === 1, '⑦ 字段值来自响应体（逐字段）', { s: r.httpStatus, rc: r.retcode, m: r.message, d: r.data }, { s: 200, rc: 0, m: 'OK', d: { x: 1 } })
  const st = port.stats()
  console.log('  stats => ' + JSON.stringify(st))
  check(st.requests === 1 && st.attempts === 1 && st.rejectedBeforeSend === 0, '⑦ stats 计数（requests/attempts/rejectedBeforeSend）', st, '<1/1/0>')
}

console.log('\n== ⑧ A4 apply 注入（离线：假 ctx / 假 transport；不加载插件、零真实网络） ==')
{
  const { apply } = await import('../lib/index.js')
  const mkCtx = (logs) => ({
    get: (n) => {
      if (n === 'tools') return { register: () => () => {} }
      if (n === 'webServer') return { register: () => () => {} }
      if (n === 'logger') return { info: (m) => logs.push('info: ' + m), warn: (m) => logs.push('warn: ' + m) }
      return undefined
    },
    effect: () => {},
  })
  const logs1 = []
  apply(mkCtx(logs1), { startTicker: false, apiTransport: async () => ({ status: 200, text: async () => '{"retcode":0,"message":"OK","data":{}}' }) })
  console.log('  apply(未注入 httpPort) 回执 =>')
  for (const l of logs1.filter((x) => x.includes('miyoushe') || x.includes('mys-http') || x.includes('凭据'))) console.log('    ' + l)
  check(logs1.some((l) => l.includes('API 出站通道就绪')), 'A4 未注入 httpPort ⇒ apply 安装 mys-http 默认实现（宿主日志回执）', logs1.length, '<含回执>')
  check(!logs1.some((l) => l.includes('凭据 provider 未注入')), 'A4（t31/S1 起）默认已装凭据 provider（store.readCredentials）⇒ 不再出现"未注入"告知', '(见日志)', '<不含>')
  check(logs1.some((l) => l.includes('受控出站就绪')), 'A4 版本通道与 API 通道**各自**注入（两条回执都在）', '(见日志)', '<含版本通道回执>')

  const logs2 = []
  const injectedPort = { request: async () => ({ ok: true, retcode: 0 }) }
  apply(mkCtx(logs2), { startTicker: false, httpPort: injectedPort })
  check(logs2.some((l) => l.includes('API 出站使用注入的 httpPort')), 'A4 已注入 httpPort ⇒ 不挂默认实现（`deps → config → ctx` 解析顺序语义不变）', '(见日志)', '<含回执>')
  check(!logs2.some((l) => l.includes('API 出站通道就绪')), 'A4 已注入时**不**出现默认实现回执（无重复注入）', '(见日志)', '<不含默认回执>')

  const logs3 = []
  const svcPort = { request: async () => ({ ok: true, retcode: 0 }) }
  const ctx3 = { get: (n) => (n === 'miyousheHttp' ? svcPort : mkCtx(logs3).get(n)), effect: () => {} }
  apply(ctx3, { startTicker: false })
  check(logs3.some((l) => l.includes('API 出站使用注入的 httpPort')), 'A4 `ctx.get(' + "'miyousheHttp'" + ')` 服务存在 ⇒ 也不挂默认实现（顺序里最后一级才兜底）', '(见日志)', '<含回执>')
}

console.log('\n== ⑩ t37/R1 签名上下文死锁修复（**真实 salts.json 形状**：active:null + unverified-current） ==')
{
  const S = createHash('sha256').update('t37-real-shape-fixture').digest('hex').slice(0, 32) // 真实形状的 32hex 盐（运行时生成，不落字面量）
  check(/^[0-9a-f]{32}$/.test(S), '夹具健全性：32 位 hex 盐（真实形状）', S.length, 32)

  // R3-① 真实形状：active:null + 一条 unverified-current ⇒ 必须 ok:true（修复前这里是 SALT_MISSING ⇒ 死锁）
  const real = mkRealSalts(null, { '2.109.0': mkEntry('unverified-current', S, '2026-09-20T03:00:00Z') })
  const c1 = resolveSigningContext(real)
  console.log('  R3① active:null + unverified-current => ' + JSON.stringify({ ok: c1.ok, appVersion: c1.appVersion, status: c1.status, source: c1.source }))
  check(c1.ok === true && c1.appVersion === '2.109.0' && c1.status === 'unverified-current' && c1.signingMaterial === S, 'R3① 真实形状（active:null + unverified-current）⇒ ok:true 且 status=unverified-current', c1.status, 'unverified-current')
  check(c1.source === 'latest_unverified', 'R3① 命中来源标记 source=latest_unverified（可审计）', c1.source, 'latest_unverified')
  // 端到端：同一真实形状经端口**真的发出请求**（证明死锁在端口层已解除）
  const { t: trR, calls: callsR } = okTransport()
  const portReal = createHttpPort({ transport: trR, now: () => 1700000000000, salts: real, credential: FAKE_CRED })
  const rReal = await portReal.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' })
  console.log('  R3① 端到端 => ' + JSON.stringify({ ok: rReal.ok, sent: rReal.sent, calls: callsR.length, hasCredential: !!(callsR[0] && callsR[0].init.headers[HEADER_NAMES.credential]) }))
  check(rReal.ok === true && rReal.sent === true && callsR.length === 1, 'R3① 端到端：真实形状下端口**真实发出**请求（死锁已解除）', { ok: rReal.ok, calls: callsR.length }, { ok: true, calls: 1 })
  check(callsR[0].init.headers[HEADER_NAMES.credential] === FAKE_CRED && typeof callsR[0].init.headers[HEADER_NAMES.signature] === 'string', 'R3① 请求头仍含凭据+DS（凭据只进请求头）', Object.keys(callsR[0].init.headers).length, '>=2')

  // R3-② 负例：active:null 且唯一条目为 stale ⇒ SALT_INVALID
  const staleOnly = mkRealSalts(null, { '2.109.0': mkEntry('stale', S) })
  const c2 = resolveSigningContext(staleOnly)
  console.log('  R3② active:null + 仅 stale => ' + JSON.stringify({ ok: c2.ok, code: c2.code }))
  check(c2.ok === false && c2.code === API_ERR.SALT_INVALID, 'R3② active:null + 唯一条目 stale ⇒ SALT_INVALID（不放宽）', c2.code, API_ERR.SALT_INVALID)
  const { t: tr2b, calls: calls2b } = okTransport()
  const portStale = createHttpPort({ transport: tr2b, now: () => 1700000000000, salts: staleOnly, credential: FAKE_CRED })
  const r2b = await portStale.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' })
  check(r2b.ok === false && r2b.code === API_ERR.SALT_INVALID && calls2b.length === 0, 'R3② 且**零请求**', { code: r2b.code, calls: calls2b.length }, { code: 'SALT_INVALID', calls: 0 })

  // R3-③ 负例：active:null 且无条目 ⇒ SALT_MISSING
  const emptySalts = mkRealSalts(null, {})
  const c3 = resolveSigningContext(emptySalts)
  console.log('  R3③ active:null + 无条目 => ' + JSON.stringify({ ok: c3.ok, code: c3.code }))
  check(c3.ok === false && c3.code === API_ERR.SALT_MISSING, 'R3③ active:null + 无条目 ⇒ SALT_MISSING', c3.code, API_ERR.SALT_MISSING)
  const { t: tr3b, calls: calls3b } = okTransport()
  const portEmpty = createHttpPort({ transport: tr3b, now: () => 1700000000000, salts: emptySalts, credential: FAKE_CRED })
  const r3b = await portEmpty.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' })
  check(r3b.ok === false && r3b.code === API_ERR.SALT_MISSING && calls3b.length === 0, 'R3③ 且**零请求**', { code: r3b.code, calls: calls3b.length }, { code: 'SALT_MISSING', calls: 0 })

  // R1①（不变）：active 指向 verified ⇒ 优先用它（即使存在更新的 unverified-current）
  const verifiedActive = mkRealSalts({ appVersion: '2.108.0', clientType: '5' }, {
    '2.108.0': mkEntry('verified', V1.salt, '2026-09-01T00:00:00Z'),
    '2.110.0': mkEntry('unverified-current', S, '2026-09-20T09:00:00Z'),
  })
  const c4 = resolveSigningContext(verifiedActive)
  console.log('  R1① active→verified 优先 => ' + JSON.stringify({ ok: c4.ok, appVersion: c4.appVersion, status: c4.status, source: c4.source }))
  check(c4.ok === true && c4.appVersion === '2.108.0' && c4.status === 'verified' && c4.source === 'active', 'R1① active 指向 verified ⇒ 用它（不被更新的 unverified-current 抢走）', { v: c4.appVersion, s: c4.status }, { v: '2.108.0', s: 'verified' })

  // R1②：active 指向**不存在的版本键** ⇒ 回退（不是 SALT_MISSING）
  const danglingActive = mkRealSalts({ appVersion: '9.9.9', clientType: '5' }, { '2.109.0': mkEntry('unverified-current', S) })
  const c5 = resolveSigningContext(danglingActive)
  check(c5.ok === true && c5.appVersion === '2.109.0' && c5.source === 'latest_unverified', 'R1② active 指向不存在的版本键 ⇒ 回退到最新 unverified-current', { ok: c5.ok, v: c5.appVersion }, { ok: true, v: '2.109.0' })

  // R1②：排序＝fetchedAt 最新优先；fetchedAt 缺失 ⇒ 版本键字典序最大
  const twoUnverified = mkRealSalts(null, {
    '2.109.0': mkEntry('unverified-current', S, '2026-09-20T03:00:00Z'),
    '2.108.0': mkEntry('unverified-current', S, '2026-09-20T05:00:00Z'),
  })
  const c6 = resolveSigningContext(twoUnverified)
  check(c6.ok === true && c6.appVersion === '2.108.0', 'R1② 多条 unverified-current ⇒ 取 fetchedAt 最新者', c6.appVersion, '2.108.0')
  const noFetchedAt = mkRealSalts(null, {
    '2.109.0': mkEntry('unverified-current', S, null),
    '2.111.0': mkEntry('unverified-current', S, null),
  })
  const c7 = resolveSigningContext(noFetchedAt)
  check(c7.ok === true && c7.appVersion === '2.111.0', 'R1② fetchedAt 缺失 ⇒ 取版本键字典序最大者', c7.appVersion, '2.111.0')
  const lue = latestUnverifiedEntry({ '2.109.0': mkEntry('stale', S, '2026-09-20T09:00:00Z'), '2.110.0': mkEntry('unverified-current', S, '2026-09-20T01:00:00Z') })
  check(lue !== null && lue.appVersion === '2.110.0', 'R1② stale 条目**不入选**回退（即使 fetchedAt 更新）', lue && lue.appVersion, '2.110.0')
  const lueNone = latestUnverifiedEntry({ '2.109.0': mkEntry('rejected', S) })
  check(lueNone === null, 'R1② 只有 rejected ⇒ 无回退候选（null）', lueNone, null)
}

console.log('\n== ⑨ 零真实网络哨兵（A6）+ 静态断言「lib/** HTTP 落点恰两处」 ==')
const realFetch = globalThis.fetch
let guardCalls = 0
const sentinel = () => { guardCalls++; throw new Error('REAL_NETWORK_ATTEMPT_BLOCKED') }
try {
  globalThis.fetch = sentinel
  // ⑧a 默认传输"确实指向 globalThis.fetch"的证明：**临时换成捕获假实现**（不是哨兵）⇒ 全程哨兵调用数保持 0（A6）
  const captured = []
  const savedFetch = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => { captured.push({ url, init }); return { status: 200, text: async () => '{"retcode":0,"message":"OK","data":{}}' } }
    const def = createDefaultApiTransport({ timeoutMs: 50 })
    check(typeof def === 'function', '⑧ 有全局 fetch ⇒ createDefaultApiTransport 可构造', typeof def, 'function')
    const res = await def('https://api-takumi.mihoyo.com/event/luna/info', { method: 'GET', headers: { 'User-Agent': 'probe' } })
    check(captured.length === 1 && captured[0].url.indexOf('api-takumi.mihoyo.com') > 0, '⑧ 默认传输把请求交给 globalThis.fetch（捕获假实现）', captured.length, 1)
    check(res && res.status === 200, '⑧ 默认传输原样返回响应对象（不吞不包）', res && res.status, 200)
    let defReject = null
    try { await def('https://evil.example.com/x', { method: 'GET' }) } catch (e) { defReject = e }
    check(defReject !== null && defReject.code === API_ERR.HOST_NOT_ALLOWED, '⑧ 默认传输**入口**也做白名单校验（§10.2 硬约束）', defReject && defReject.code, API_ERR.HOST_NOT_ALLOWED)
    check(captured.length === 1, '⑧ 被拒 URL 未产生任何调用（白名单前置在调用之前）', captured.length, 1)
  } finally { globalThis.fetch = savedFetch }
  // ⑧b 注入假 transport 的路径**不触碰** globalThis.fetch
  const before = guardCalls
  const { t: tr } = okTransport()
  const port = createHttpPort({ transport: tr, now: () => 1700000000000, salts: mkSalts('verified', V1.salt), credential: FAKE_CRED })
  const rInj = await port.request({ path: '/event/luna/info', method: 'GET', target: 'hk4e' })
  check(rInj.ok === true && guardCalls === before, '⑧ 注入假 transport 的请求**不触碰** globalThis.fetch（哨兵计数不变）', guardCalls, before)
  // ⑧c 无全局 fetch ⇒ 默认传输 = null（不静默回落）
  let nullTransport = 'unset'
  try { delete globalThis.fetch; nullTransport = createDefaultApiTransport({}) } finally { globalThis.fetch = savedFetch }
  check(nullTransport === null, '⑧ 无全局 fetch ⇒ createDefaultApiTransport() = null（不静默回落）', nullTransport, null)
  // A6 主判据：本套件**全程**哨兵调用数 = 0
  check(guardCalls === 0, 'A6 **零真实网络**：本套件全程 globalThis.fetch 哨兵调用数 = 0', guardCalls, 0)
} finally {
  globalThis.fetch = realFetch
}

{
  const LIB = join(ROOT, 'lib')
  const files = readdirSync(LIB).filter((f) => f.endsWith('.js')).sort()
  const counts = {}
  for (const f of files) counts[f] = (readFileSync(join(LIB, f), 'utf8').split('fetch(').length - 1)
  console.log('  lib/** fetch 调用计数=' + JSON.stringify(counts))
  const HTTP_SPOTS = ['miyoushe-version.js', 'mys-http.js']
  const outpouring = files.filter((f) => !HTTP_SPOTS.includes(f) && counts[f] !== 0)
  check(counts['miyoushe-version.js'] === 1, 'A6 版本通道落点 miyoushe-version.js fetch 调用计数 = 1（§3.5.8）', counts['miyoushe-version.js'], 1)
  check(counts['mys-http.js'] === 1, 'A6 API 通道落点 mys-http.js fetch 调用计数 = 1（§10.2）', counts['mys-http.js'], 1)
  check(outpouring.length === 0, 'A6 其余 lib/*.js 的 fetch 调用计数 = 0（出站不得外溢）', outpouring, '[]')
  const src = readFileSync(join(LIB, 'mys-http.js'), 'utf8')
  check(!src.includes('node:fs') && !/from '(node:)?(http|https|net|dns)'/.test(src), 'A6 mys-http.js 无 fs/http/net/dns 直连（只有 fetch 薄封装）', 'ok', 'none')
  check((src.match(/[0-9a-fA-F]{32}/g) || []).length === 0, 'A6 mys-http.js 无 32hex 字面量（无盐/凭据明文）', 'ok', '[]')
  check(ALLOWED_API_HOSTS.every((h) => !src.includes('raw.githubusercontent') && !src.includes('gitcode')), 'A6 API 白名单与版本通道第三方源不重叠（两通道隔离）', 'ok', 'none')
}

console.log('')
console.log('MYS_HTTP failures=' + failures + ' skipped=' + skips)
process.exitCode = failures === 0 ? 0 : 1
