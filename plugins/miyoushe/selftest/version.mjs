// @local/miyoushe —— 版本↔盐模块单测（设计 §3.5；node 直调，**零网络 / 零写盘 / 不加载插件**）
// 运行：node selftest/version.mjs      （退出码 0 = 全过）
//
// 覆盖（t13/A3 的 ⑥⑦ + §3.5 其余可判定面）：
//   ⑥ fingerprint() 三条算例（56ab196e / 40ede0b0 / b86c533d）＋ 独立 sha256 交叉验算 ＋ FP_BAD_SALT
//   ⑦ 缓存 TTL 边界（23h/24h/25h、ttl=0、lastFetchOk=false、无 fetchedAt）
//   解析 / 候选条目映射 / matchVersion / 覆盖纪律 / 陈旧度 / 白名单 / UA 无凭据 / 注入式 fetch（S1→S2、超时、全失败）
//   **零真实网络**：测试期间把 `globalThis.fetch` 换成"一调用就抛"的哨兵，并断言哨兵调用数=0
//
// 纪律：盐值一律**运行时生成**或用**文档公开摘录**（不落 32hex 字面量 ⇒ 不破坏 assert-source-discipline 的 D4）。

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  fingerprint, fingerprintOrNull, isSaltShape, parseSettingPy, buildCandidateEntry,
  cacheState, shouldFetch, matchVersion, mergeCandidate, evaluateVersionStaleness,
  assertAllowedSource, buildVersionRequest, fetchVersionCandidates, decideVersionOutcome,
  createDefaultVersionFetch, pickAllowedOutboundHeaders,
  CACHE_TTL_MS, FETCH_TIMEOUT_MS, MAX_ATTEMPTS, VERSION_SOURCES, ALLOWED_SOURCE_HOSTS, VERSION_ERR, VersionError,
} from '../lib/miyoushe-version.js'
import { SENSITIVE_TOKENS } from '../lib/mask.js'

let failures = 0
let skips = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
const show = (label, obj) => console.log('  ' + label + ' => ' + JSON.stringify(obj))
const hexSalt = (seed) => createHash('sha256').update(seed).digest('hex').slice(0, 32)
const indepFp = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const NOW = Date.parse('2026-09-20T02:00:00Z')
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString()
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

// ---- 夹具：盐运行时生成（无 32hex 字面量）----
const APP_SALT = hexSalt('s1-app-salt')
const WEB_SALT = hexSalt('s1-web-salt')
const S1_TEXT = [
  '# 米游社的Salt',
  '# java提取，会跟随版本更新',
  'mihoyobbs_salt = "' + APP_SALT + '"',
  'mihoyobbs_salt_web = "' + WEB_SALT + '"',
  'mihoyobbs_version = "2.109.0"  # Salt和Version相互对应',
].join('\n')

console.log('== ⑥ fingerprint() 三条算例（设计 §3.5.4/§3.5.7 口径：sha256 前 8 位小写）==')
{
  // 算例输入**不写进源码**：公开摘录从设计文档读取；历史锚点用 §3.3 V1 的公开锚点盐
  const DOC = join(HERE, '..', '..', '..', '米游社签到插件_设计方案.md')
  const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : ''
  const docAppSalt = (doc.match(/mihoyobbs_salt\s*=\s*"([0-9a-f]{32})"/) || [])[1] || null
  const docWebSalt = (doc.match(/mihoyobbs_salt_web\s*=\s*"([0-9a-f]{32})"/) || [])[1] || null
  const HISTORICAL = 'ZSHlXeQUBis52qD1kEgKt5lUYed4b7Bb' // §3.2/§3.3 公开历史锚点（设计明确允许明文）
  const CASES = [
    { name: 'S1 mihoyobbs_salt（app 盐，文档 §3.5.3 公开摘录）', salt: docAppSalt, expect: '40ede0b0', from: 'doc' },
    { name: 'S1 mihoyobbs_salt_web（active 条目用的 web 盐，文档 §3.5.3/§3.5.4）', salt: docWebSalt, expect: '56ab196e', from: 'doc' },
    { name: '§3.2 历史锚点 2.35.2 的盐（公开锚点）', salt: HISTORICAL, expect: 'b86c533d', from: 'repo' },
  ]
  for (const c of CASES) {
    if (typeof c.salt !== 'string' || !c.salt.length) {
      skips++
      console.log('SKIP ' + c.name + '（文档公开摘录不可得 ⇒ 不静默通过：本用例未被验证）')
      continue
    }
    const got = fingerprint(c.salt)
    show(c.name, { source: c.from, saltLen: c.salt.length, fingerprint: got, expect: c.expect, independent: indepFp(c.salt) })
    check(got === c.expect, c.name + ' ⇒ ' + c.expect, got, c.expect)
    check(got === indepFp(c.salt), c.name + ' 与独立 sha256 交叉验算一致', got, indepFp(c.salt))
  }
  // FP_BAD_SALT：非法输入必须抛（不返回 null、不静默）
  for (const bad of [null, undefined, '', 12345, {}]) {
    let code = null
    try { fingerprint(bad) } catch (e) { code = e && e.code }
    check(code === 'FP_BAD_SALT', 'FP_BAD_SALT：非法输入 ' + JSON.stringify(bad === undefined ? 'undefined' : bad), code, 'FP_BAD_SALT')
  }
  check(fingerprintOrNull(null) === null && fingerprintOrNull('x') === indepFp('x'), 'fingerprintOrNull 不抛（供门禁侧判"无盐"）', 'ok', 'null/8hex')
  check(isSaltShape('a'.repeat(32)) === true && isSaltShape('a'.repeat(31)) === false && isSaltShape('z'.repeat(32)) === false, 'isSaltShape 严格 32 位 hex', 'ok', 'true/false/false')
  check(fingerprint(WEB_SALT) === indepFp(WEB_SALT), '运行时生成盐的指纹自洽', fingerprint(WEB_SALT), indepFp(WEB_SALT))
}

console.log('\n== ⑦ 缓存 TTL 边界（§3.5.4：默认 24h；ttl=0＝禁用缓存）==')
{
  const vc = (ageMs, extra) => Object.assign({ appVersion: '2.109.0', clientType: '5', fetchedAt: ISO(ageMs), ttlMs: CACHE_TTL_MS, lastFetchOk: true, lastFetchError: null }, extra || {})
  const fresh = cacheState(vc(23 * HOUR), NOW)
  const exact = cacheState(vc(24 * HOUR), NOW)
  const expired = cacheState(vc(25 * HOUR), NOW)
  show('cacheState', { fresh: fresh.reason, exact24h: exact.reason, expired25h: expired.reason })
  check(fresh.fresh === true && fresh.reason === 'fresh' && fresh.ageMs === 23 * HOUR, '23h ⇒ fresh', fresh, { fresh: true, ageMs: 23 * HOUR })
  check(exact.fresh === false && exact.reason === 'expired', '恰好 24h ⇒ expired（边界取 >=）', exact.reason, 'expired')
  check(expired.fresh === false && expired.reason === 'expired', '25h ⇒ expired', expired.reason, 'expired')
  check(cacheState(vc(1 * HOUR), NOW, { ttlMs: 0 }).reason === 'ttl_disabled', 'ttlMs=0 ⇒ 禁用缓存（每次取）', cacheState(vc(1 * HOUR), NOW, { ttlMs: 0 }).reason, 'ttl_disabled')
  check(cacheState(vc(1 * HOUR, { lastFetchOk: false }), NOW).reason === 'last_fetch_failed', 'lastFetchOk=false ⇒ 不新鲜', cacheState(vc(1 * HOUR, { lastFetchOk: false }), NOW).reason, 'last_fetch_failed')
  check(cacheState({ lastFetchOk: true }, NOW).reason === 'no_cache', '无 fetchedAt ⇒ no_cache', cacheState({ lastFetchOk: true }, NOW).reason, 'no_cache')
  check(shouldFetch(vc(23 * HOUR), NOW) === false && shouldFetch(vc(23 * HOUR), NOW, { refresh: true }) === true, 'shouldFetch：新鲜不取；refresh:true 强制取', 'ok', 'false/true')
  const stale31 = evaluateVersionStaleness({ versionCache: vc(3.1 * DAY) }, NOW)
  const stale2 = evaluateVersionStaleness({ versionCache: vc(2 * DAY) }, NOW)
  show('staleness', { d3_1: stale31.stale, d2: stale2.stale })
  check(stale31.stale === true && stale31.code === 'VERSION_STALE', '3.1 天 ⇒ stale（> ttl×3）', stale31, '<VERSION_STALE>')
  check(stale2.stale === false && stale2.code === null, '2 天 ⇒ 不 stale', stale2.stale, false)
  check(evaluateVersionStaleness({ versionCache: { lastFetchOk: false, fetchedAt: ISO(HOUR) } }, NOW).code === 'VERSION_STALE', 'lastFetchOk=false ⇒ VERSION_STALE', 'ok', 'VERSION_STALE')
}

console.log('\n== 解析 / 候选条目映射（§3.5.3 + §3.5.4 注①：client_type=5 取 _web 盐）==')
{
  const parsed = parseSettingPy(S1_TEXT)
  show('parseSettingPy', { appVersion: parsed.appVersion, hasApp: parsed.appSalt !== null, hasWeb: parsed.webSalt !== null, shapeOk: parsed.saltShapeOk, webFp: parsed.webSaltFingerprint })
  check(parsed.appVersion === '2.109.0', '解析 mihoyobbs_version', parsed.appVersion, '2.109.0')
  check(parsed.appSalt === APP_SALT && parsed.webSalt === WEB_SALT, '解析两个盐（形状 32hex）', parsed.saltShapeOk, { app: true, web: true })
  check(parsed.webSaltFingerprint === indepFp(WEB_SALT), '解析结果自带指纹（只出指纹口径）', parsed.webSaltFingerprint, indepFp(WEB_SALT))
  check(parseSettingPy('nothing here').parsed === false, '无字段 ⇒ parsed=false（不静默造值）', 'ok', 'false')

  const cand = buildCandidateEntry(parsed, { sourceUrl: VERSION_SOURCES[0].url, fetchedAt: ISO(0) })
  show('buildCandidateEntry(web)', { appVersion: cand.appVersion, saltIsWeb: cand.entry.salt === WEB_SALT, status: cand.entry.status, sourceKind: cand.entry.sourceKind, fp: cand.entry.saltFingerprint })
  check(cand.appVersion === '2.109.0' && cand.entry.salt === WEB_SALT, 'clientType=5 ⇒ 取 _web 盐', cand.entry.salt === WEB_SALT, true)
  check(cand.entry.status === 'unverified-current' && cand.entry.sourceKind === 'auto', '新条目 status=unverified-current / sourceKind=auto（§3.5.4）', { s: cand.entry.status, k: cand.entry.sourceKind }, { s: 'unverified-current', k: 'auto' })
  check(cand.entry.saltFingerprint === indepFp(WEB_SALT) && cand.entry.verifiedAt === null && cand.entry.rejectedAt === null, '指纹正确且 verified/rejected 时间戳为 null', 'ok', 'null/null')
  const cand2 = buildCandidateEntry(parsed, { clientType: '2' })
  check(cand2.entry.salt === APP_SALT && cand2.entry.clientType === '2', 'clientType=2 ⇒ 取 app 盐', cand2.entry.clientType, '2')
  for (const badCase of [
    { p: { appVersion: '1.0.0', webSalt: 'short' }, why: '盐长度不符' },
    { p: { appVersion: null, webSalt: WEB_SALT }, why: '缺版本键' },
    { p: { appVersion: '1.0.0', webSalt: null }, why: '缺盐' },
  ]) {
    let code = null
    try { buildCandidateEntry(badCase.p, {}) } catch (e) { code = e && e.code }
    check(code === 'SALT_SHAPE_INVALID', '形状不符 ⇒ SALT_SHAPE_INVALID（取回即拒、不落盘）：' + badCase.why, code, 'SALT_SHAPE_INVALID')
  }
}

console.log('\n== matchVersion / 覆盖纪律（§3.5.4）/ 降级判定（§3.5.6）==')
{
  const mkSalts = (entry, activeVersion) => ({
    version: 2, updatedAt: ISO(0), active: { appVersion: activeVersion || '2.109.0', clientType: '5' },
    entries: entry === null ? {} : { '2.109.0': entry },
    versionCache: { appVersion: '2.109.0', clientType: '5', fetchedAt: ISO(HOUR), ttlMs: CACHE_TTL_MS, lastFetchOk: true },
  })
  check(matchVersion(mkSalts(null), '2.109.0') === 'missing', '无该版本键 ⇒ missing', 'missing', 'missing')
  check(matchVersion(mkSalts({ status: 'verified', salt: WEB_SALT }), '2.109.0') === 'hit', 'verified ⇒ hit', 'hit', 'hit')
  check(matchVersion(mkSalts({ status: 'rejected', salt: WEB_SALT }), '2.109.0') === 'rejected', 'rejected ⇒ rejected', 'rejected', 'rejected')
  check(matchVersion(mkSalts({ status: 'verified', salt: WEB_SALT }), '2.109.0', { fetchedSalt: APP_SALT }) === 'conflict', '同版本盐不同 ⇒ conflict', 'conflict', 'conflict')

  const base = mkSalts({ status: 'unverified-current', salt: WEB_SALT, sourceKind: 'auto' })
  const cand = (salt) => ({ appVersion: '2.109.0', entry: { clientType: '5', salt, saltFingerprint: fingerprint(salt), status: 'unverified-current', sourceKind: 'auto', sourceUrl: VERSION_SOURCES[0].url, fetchedAt: ISO(0), verifiedAt: null, rejectedAt: null } })
  const ins = mergeCandidate({ version: 2, entries: {}, active: null, versionCache: null }, { appVersion: '2.110.0', entry: cand(APP_SALT).entry }, { now: NOW })
  show('merge(insert)', { action: ins.action, event: ins.audit.event, fp: ins.audit.saltFingerprint })
  check(ins.action === 'inserted' && ins.salts.entries['2.110.0'].salt === APP_SALT, '新版本 ⇒ inserted', ins.action, 'inserted')
  check(ins.audit.event === 'version.change' && ins.audit.saltFingerprint === fingerprint(APP_SALT), '审计字段（§3.5.7：只落指纹）', ins.audit.saltFingerprint, fingerprint(APP_SALT))

  const upd = mergeCandidate(base, cand(APP_SALT), { now: NOW })
  check(upd.action === 'updated' && upd.salts.entries['2.109.0'].salt === APP_SALT && upd.salts.entries['2.109.0'].status === 'unverified-current', 'unverified-current ⇒ 原位更新（status 重置）', upd.action, 'updated')
  check(base.entries['2.109.0'].salt === WEB_SALT, '纯函数：入参未被改动', base.entries['2.109.0'].salt === WEB_SALT, true)

  const verified = mkSalts({ status: 'verified', salt: WEB_SALT, sourceKind: 'manual' })
  const con = mergeCandidate(verified, cand(APP_SALT), { now: NOW })
  show('merge(verified conflict)', { action: con.action, event: con.audit.event, keptSalt: con.salts.entries['2.109.0'].salt === WEB_SALT })
  check(con.action === 'conflict' && con.salts.entries['2.109.0'].salt === WEB_SALT, '**verified 条目绝不被自动覆盖**（只记审计）', con.action, 'conflict')
  check(con.audit.event === 'version.auto_conflict' && con.audit.matchResult === 'conflict', '冲突记 version.auto_conflict', con.audit.event, 'version.auto_conflict')
  const same = mergeCandidate(verified, cand(WEB_SALT), { now: NOW })
  check(same.action === 'unchanged', 'verified 且同盐 ⇒ unchanged（无变化）', same.action, 'unchanged')
  const manual = mkSalts({ status: 'unverified-current', salt: WEB_SALT, sourceKind: 'manual' })
  const kept = mergeCandidate(manual, cand(APP_SALT), { now: NOW })
  check(kept.action === 'kept-manual' && kept.salts.entries['2.109.0'].salt === WEB_SALT, 'sourceKind=manual ⇒ 永不被自动覆盖', kept.action, 'kept-manual')

  // §3.5.6 判定树
  const miss = decideVersionOutcome({ salts: mkSalts(null), fetchResult: { ok: true, appVersion: '2.111.0', candidate: cand(APP_SALT) }, now: NOW })
  show('decide(missing)', { code: miss.code, mode: miss.mode, activeUnchanged: miss.activeUnchanged })
  check(miss.code === 'SALT_MISSING' && miss.mode === 'readonly' && miss.activeUnchanged === true, '版本无匹配盐 ⇒ SALT_MISSING + 只读（active 不变）', { c: miss.code, m: miss.mode }, { c: 'SALT_MISSING', m: 'readonly' })
  const hit = decideVersionOutcome({ salts: mkSalts({ status: 'unverified-current', salt: WEB_SALT }), fetchResult: { ok: true, appVersion: '2.109.0', candidate: cand(WEB_SALT) }, now: NOW })
  check(hit.code === null && hit.mode === 'normal', '命中 unverified-current ⇒ 正常（允许试签、禁止无人值守）', { c: hit.code, m: hit.mode }, { c: null, m: 'normal' })
  const rej = decideVersionOutcome({ salts: mkSalts({ status: 'rejected', salt: WEB_SALT }), fetchResult: { ok: true, appVersion: '2.109.0', candidate: cand(WEB_SALT) }, now: NOW })
  check(rej.code === 'SALT_INVALID' && rej.mode === 'readonly', 'rejected ⇒ SALT_INVALID + 只读', rej.code, 'SALT_INVALID')
  const fail2 = decideVersionOutcome({ salts: mkSalts({ status: 'verified', salt: WEB_SALT }), fetchResult: { ok: false, code: 'VERSION_FETCH_FAILED', attempts: [{}, {}], detail: 'both down' }, now: NOW })
  const fail1 = decideVersionOutcome({ salts: mkSalts({ status: 'verified', salt: WEB_SALT }), fetchResult: { ok: false, code: 'VERSION_FETCH_FAILED', attempts: [{}], detail: 'single' }, now: NOW })
  const shape = decideVersionOutcome({ salts: mkSalts({ status: 'verified', salt: WEB_SALT }), fetchResult: { ok: false, code: 'SALT_SHAPE_INVALID', attempts: [{}, {}], detail: 'bad shape' }, now: NOW })
  show('decide(fetch fail)', { two: fail2.code, one: fail1.code, shape: shape.code })
  check(fail2.code === 'VERSION_FETCH_FAILED' && fail2.mode === 'readonly', 'S1+S2 全失败 ⇒ VERSION_FETCH_FAILED + 只读', fail2.code, 'VERSION_FETCH_FAILED')
  check(fail1.code === 'VERSION_STALE' && fail1.mode === 'readonly', '未被穷尽（单源失败）⇒ VERSION_STALE + 只读', fail1.code, 'VERSION_STALE')
  check(shape.code === 'SALT_INVALID' && shape.mode === 'readonly', '取回的盐形状非法 ⇒ SALT_INVALID + 只读', shape.code, 'SALT_INVALID')
}

console.log('\n== 出站纪律：白名单 / 固定 UA / **不携带任何凭据**（§3.5.8）==')
{
  for (const host of ALLOWED_SOURCE_HOSTS) {
    let ok = true
    try { assertAllowedSource('https://' + host + '/x') } catch (e) { ok = false }
    check(ok, '白名单放行：' + host, ok, true)
  }
  for (const bad of ['https://evil.example/x', 'http://raw.githubusercontent.com.evil.example/x', 'not-a-url']) {
    let code = null
    try { assertAllowedSource(bad) } catch (e) { code = e && e.code }
    check(code === 'VERSION_SOURCE_NOT_ALLOWED', '非白名单拒绝：' + bad, code, 'VERSION_SOURCE_NOT_ALLOWED')
  }
  const req = buildVersionRequest(VERSION_SOURCES[0].url, { appVersion: '2.109.0' })
  show('buildVersionRequest', { url: req.url, headers: req.init.headers })
  check(req.init.headers['User-Agent'].includes('miHoYoBBS/2.109.0'), 'UA 固定为 miHoYoBBS/<配置版本>', req.init.headers['User-Agent'], '<含 miHoYoBBS/2.109.0>')
  check(Object.keys(req.init.headers).sort().join(',') === 'Accept,User-Agent', '**只有** UA/Accept 两个头（无凭据头）', Object.keys(req.init.headers), ['User-Agent', 'Accept'])
  const blob = JSON.stringify(req.init).toLowerCase()
  const leaked = SENSITIVE_TOKENS.filter((t) => blob.includes(t))
  check(leaked.length === 0, '请求 init 中不含任何敏感 token（跨用 mask.js 的词表）', leaked, '[]')
  check(MAX_ATTEMPTS === 2 && FETCH_TIMEOUT_MS === 8000, 'S1→S2 最多 1 次重试 / 超时 8s（§3.5.8）', { a: MAX_ATTEMPTS, t: FETCH_TIMEOUT_MS }, { a: 2, t: 8000 })
}

console.log('\n== 注入式 fetch（S1→S2 重试 / 超时 / 全失败 / 未注入）＋ **零真实网络** ==')
const realFetch = globalThis.fetch
let guardCalls = 0
const sentinelFetch = () => { guardCalls++; throw new Error('REAL_NETWORK_ATTEMPT_BLOCKED') }
try {
  globalThis.fetch = sentinelFetch
  const mkFetch = (behave) => async (url, init) => {
    const r = behave(url, init)
    if (r && r.abort) { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    return { status: r.status, text: async () => r.body }
  }
  const S1 = VERSION_SOURCES[0].url
  const S2 = VERSION_SOURCES[1].url

  const noImpl = await fetchVersionCandidates({ now: NOW })
  show('no fetchImpl', { ok: noImpl.ok, code: noImpl.code, attempts: noImpl.attempts.length })
  check(noImpl.ok === false && noImpl.code === 'VERSION_FETCH_FAILED' && noImpl.attempts.length === 0, '未注入 fetchImpl ⇒ 显式失败（不回落直连）', noImpl.code, 'VERSION_FETCH_FAILED')

  let seenHeaders = null
  const okFetch = mkFetch((url, init) => { seenHeaders = init.headers; return { status: 200, body: S1_TEXT } })
  const one = await fetchVersionCandidates({ fetchImpl: okFetch, now: NOW, appVersion: '2.109.0' })
  show('S1 ok', { ok: one.ok, attempts: one.attempts.map((a) => a.sourceId + ':' + a.httpStatus), appVersion: one.appVersion, fp: one.candidate.entry.saltFingerprint, sourceUrl: one.sourceUrl })
  check(one.ok === true && one.attempts.length === 1 && one.attempts[0].sourceId === 'S1', 'S1 成功 ⇒ 只打一次', one.attempts.length, 1)
  check(one.candidate.entry.salt === WEB_SALT && one.appVersion === '2.109.0', '候选条目＝web 盐 + 版本键', one.appVersion, '2.109.0')
  check(Object.keys(seenHeaders).sort().join(',') === 'Accept,User-Agent', '实际请求头只有 UA/Accept（**不携带凭据**）', Object.keys(seenHeaders), ['User-Agent', 'Accept'])

  const retryFetch = mkFetch((url) => (url === S1 ? { status: 500, body: 'boom' } : { status: 200, body: S1_TEXT }))
  const two = await fetchVersionCandidates({ fetchImpl: retryFetch, now: NOW })
  show('S1 500 → S2', { ok: two.ok, attempts: two.attempts.map((a) => a.sourceId + ':' + a.httpStatus), sourceUrl: two.sourceUrl })
  check(two.ok === true && two.attempts.length === 2 && two.attempts[0].httpStatus === 500 && two.sourceUrl === S2, 'S1 失败 ⇒ 换 S2 镜像（最多 1 次重试）', two.attempts.map((a) => a.httpStatus), [500, 200])

  const timeoutFetch = mkFetch((url) => (url === S1 ? { abort: true } : { status: 200, body: S1_TEXT }))
  const to = await fetchVersionCandidates({ fetchImpl: timeoutFetch, now: NOW })
  show('S1 timeout → S2', { ok: to.ok, attempts: to.attempts.map((a) => a.sourceId + ':' + a.error) })
  check(to.ok === true && to.attempts[0].error === 'TIMEOUT', '超时（AbortError）⇒ 记 TIMEOUT 并换源', to.attempts[0].error, 'TIMEOUT')

  const downFetch = mkFetch(() => ({ status: 503, body: 'down' }))
  const down = await fetchVersionCandidates({ fetchImpl: downFetch, now: NOW })
  show('both down', { ok: down.ok, code: down.code, attempts: down.attempts.length })
  check(down.ok === false && down.code === 'VERSION_FETCH_FAILED' && down.attempts.length === 2, 'S1+S2 全失败 ⇒ VERSION_FETCH_FAILED（2 次尝试）', down.code, 'VERSION_FETCH_FAILED')

  const garbageFetch = mkFetch(() => ({ status: 200, body: 'no useful fields here' }))
  const garbage = await fetchVersionCandidates({ fetchImpl: garbageFetch, now: NOW })
  check(garbage.ok === false && garbage.code === 'SALT_SHAPE_INVALID', '200 但内容不可用 ⇒ 继续换源，最终 SALT_SHAPE_INVALID', garbage.code, 'SALT_SHAPE_INVALID')

  const s1GarbageS2Ok = mkFetch((url) => (url === S1 ? { status: 200, body: 'garbage' } : { status: 200, body: S1_TEXT }))
  const mixed = await fetchVersionCandidates({ fetchImpl: s1GarbageS2Ok, now: NOW })
  check(mixed.ok === true && mixed.attempts.length === 2, 'S1 内容不可用 ⇒ 仍换 S2 成功（不因一次坏体放弃）', mixed.ok, true)
  // -------------------------------------------------------------------------
  // t22 / A4：§3.5.8 **受控默认出站**（`lib/**` 唯一落点）的离线用例
  //   ① 白名单外 URL ⇒ 结构化拒绝（VersionError VERSION_SOURCE_NOT_ALLOWED）且**不发出请求**
  //   ② 请求头只有 UA/Accept（逐字断言，零凭据）——调用方塞入凭据/签名头也会被丢弃
  //   ③ 超时（连接+读取合计）经 AbortController 生效；调用方 signal 串联即立即中止
  //   ④ 「最多 1 次换源」用**默认 transport** 再走一遍 S1 500 ⇒ S2
  //   ⑤ 无全局 fetch ⇒ `createDefaultVersionFetch` 返回 null（保持"未注入"语义 ⇒ VERSION_FETCH_FAILED）
  //   本段临时用**假 global fetch** 替换哨兵（结束时立刻换回），全程仍是**零真实网络**。
  // -------------------------------------------------------------------------
  const UA_FIXED = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 miHoYoBBS/'
  const S1_URL = VERSION_SOURCES[0].url
  const S2_URL = VERSION_SOURCES[1].url
  const captured = []
  try {
    globalThis.fetch = async (url, init) => { captured.push({ url, init }); return { status: 200, text: async () => S1_TEXT } }
    const def = createDefaultVersionFetch({})
    check(typeof def === 'function', 'A4① 默认出站 transport 可构造（全局 fetch 存在时）', typeof def, 'function')

    // ② 请求头逐字断言（含"塞入凭据也不外泄"）
    await def(S1_URL, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': UA_FIXED + '2.109.0', Accept: 'text/plain', Cookie: 'SECRET-VALUE', 'x-rpc-sign': 'zz', Authorization: 'Bearer zz' },
    })
    const cap = captured[captured.length - 1]
    show('A4② 捕获到的请求头', cap.init.headers)
    check(Object.keys(cap.init.headers).sort().join(',') === 'Accept,User-Agent', 'A4② 请求头**只有** UA/Accept（逐字；凭据/签名头一律丢弃）', Object.keys(cap.init.headers), ['Accept', 'User-Agent'])
    check(cap.init.headers['User-Agent'] === UA_FIXED + '2.109.0', 'A4② 固定 UA 前缀 + 配置版本（逐字）', cap.init.headers['User-Agent'], UA_FIXED + '2.109.0')
    const leak = SENSITIVE_TOKENS.filter((t) => JSON.stringify(cap.init).toLowerCase().includes(String(t).toLowerCase()))
    check(leak.length === 0, 'A4② init 中不含任何敏感 token（跨用 mask.js 词表 ⇒ 零凭据）', leak, '[]')
    const uaBad = pickAllowedOutboundHeaders({ 'User-Agent': 'curl/8', Cookie: 'x' }, { appVersion: '9.9.9' })
    check(Object.keys(uaBad).sort().join(',') === 'Accept,User-Agent' && uaBad['User-Agent'] === UA_FIXED + '9.9.9', 'A4② 非固定 UA ⇒ 替换为固定 UA（版本取自 opts.appVersion）且凭据头被丢弃', uaBad, { 'User-Agent': UA_FIXED + '9.9.9', Accept: 'text/plain' })

    // ① 白名单外 URL ⇒ 结构化拒绝，且不发出请求
    const before = captured.length
    let rejected = null
    try { await def('https://evil.example.com/setting.py', { headers: {} }) } catch (e) { rejected = e }
    check(rejected instanceof VersionError && rejected.code === VERSION_ERR.VERSION_SOURCE_NOT_ALLOWED, 'A4① 白名单外 URL ⇒ VersionError VERSION_SOURCE_NOT_ALLOWED（结构化拒绝）', rejected && rejected.code, 'VERSION_SOURCE_NOT_ALLOWED')
    check(captured.length === before, 'A4① 白名单外 URL **未发出任何请求**（不静默、不回落）', captured.length - before, 0)
    let notAllowed = null
    try { assertAllowedSource('https://api.miyoushe.com/x') } catch (e) { notAllowed = e }
    check(notAllowed !== null && notAllowed.code === VERSION_ERR.VERSION_SOURCE_NOT_ALLOWED, 'A4① 米游社官方域名**不在**白名单（受控出站打不到官方域名）', notAllowed && notAllowed.code, 'VERSION_SOURCE_NOT_ALLOWED')

    // ④ 默认 transport 走一遍「S1 失败 ⇒ 换 S2（最多 1 次）」
    globalThis.fetch = async (url, init) => { captured.push({ url, init }); return url === S1_URL ? { status: 500, text: async () => 'boom' } : { status: 200, text: async () => S1_TEXT } }
    const viaDefault = await fetchVersionCandidates({ fetchImpl: def, now: NOW })
    show('A4④ 默认 transport：S1 500 ⇒ S2', { ok: viaDefault.ok, attempts: viaDefault.attempts.map((a) => a.sourceId + ':' + a.httpStatus), sourceUrl: viaDefault.sourceUrl })
    check(viaDefault.ok === true && viaDefault.attempts.length === MAX_ATTEMPTS && viaDefault.sourceUrl === S2_URL, 'A4④ 默认 transport 下仍「最多 1 次换源」并落到 S2', viaDefault.attempts.map((a) => a.sourceId), ['S1', 'S2'])

    // ③ 超时（默认 transport 自带 AbortController；用 25ms 复现，默认值＝FETCH_TIMEOUT_MS）
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
    })
    const fast = createDefaultVersionFetch({ timeoutMs: 25 })
    const t0 = Date.now()
    let toErr = null
    try { await fast(S1_URL, { headers: {} }) } catch (e) { toErr = e }
    const elapsed = Date.now() - t0
    show('A4③ 超时复现', { name: toErr && toErr.name, ms: elapsed, defaultMs: FETCH_TIMEOUT_MS })
    check(toErr !== null && toErr.name === 'AbortError' && elapsed < 2000, 'A4③ transport 超时经 AbortController 中止（连接+读取合计）', { name: toErr && toErr.name, ms: elapsed }, 'AbortError <2000ms')

    // ③′ 调用方 signal 串联：外层中止 ⇒ 立即中止（不必等满 timeoutMs）
    const outer = new AbortController()
    globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
      setTimeout(() => { try { outer.abort() } catch (e) { /* noop */ } }, 20)
    })
    const chained = createDefaultVersionFetch({ timeoutMs: 5000 })
    const t1 = Date.now()
    let chErr = null
    try { await chained(S1_URL, { headers: {}, signal: outer.signal }) } catch (e) { chErr = e }
    check(chErr !== null && chErr.name === 'AbortError' && (Date.now() - t1) < 2000, 'A4③ 调用方 signal 串联（外层中止 ⇒ 立即中止，不等 timeoutMs）', chErr && chErr.name, 'AbortError')

    // ⑤ 无全局 fetch ⇒ null（保持"未注入"语义），且经 candidates 仍是 VERSION_FETCH_FAILED
    const savedFetch = globalThis.fetch
    let nul = 'unset'
    let noImpl2 = null
    try {
      delete globalThis.fetch
      nul = createDefaultVersionFetch({})
      noImpl2 = await fetchVersionCandidates({ fetchImpl: createDefaultVersionFetch({ timeoutMs: 50 }), now: NOW })
    } finally { globalThis.fetch = savedFetch }
    check(nul === null, 'A4⑤ 无全局 fetch ⇒ createDefaultVersionFetch 返回 null（不静默回落）', nul, null)
    show('A4⑤ null transport ⇒ refresh', { ok: noImpl2.ok, code: noImpl2.code, attempts: noImpl2.attempts.length })
    check(noImpl2.ok === false && noImpl2.code === VERSION_ERR.VERSION_FETCH_FAILED && noImpl2.attempts.length === 0, 'A4⑤ 缺 fetchImpl（transport=null）⇒ 仍 VERSION_FETCH_FAILED（0 次尝试）', noImpl2.code, 'VERSION_FETCH_FAILED')

    // ①′ 非白名单源经 candidates ⇒ 该次尝试记结构化拒绝原因（不静默）
    const badSrc = await fetchVersionCandidates({ fetchImpl: () => { throw new Error('should-not-be-called') }, now: NOW, sources: [{ id: 'S9', url: 'https://evil.example.com/setting.py' }] })
    show('A4①′ 非白名单源（经 candidates）', badSrc.attempts.map((a) => a.sourceId + ':' + a.error))
    check(badSrc.ok === false && badSrc.attempts.length === 1 && badSrc.attempts[0].error === VERSION_ERR.VERSION_SOURCE_NOT_ALLOWED, 'A4①′ 非白名单源 ⇒ 尝试记录 VERSION_SOURCE_NOT_ALLOWED（不静默）', badSrc.attempts[0] && badSrc.attempts[0].error, 'VERSION_SOURCE_NOT_ALLOWED')
  } finally {
    globalThis.fetch = sentinelFetch
  }

  check(guardCalls === 0, '**零真实网络**：全局 fetch 哨兵调用数=0（全程只用注入的假 fetch）', guardCalls, 0)
} finally {
  globalThis.fetch = realFetch
}

console.log('\n== 静态面：模块自身无直连网络 / 无 fs（A4）＋ §3.5.8 受控出站**唯一落点**（t22/A3③）==')
{
  const src = readFileSync(join(ROOT, 'lib', 'miyoushe-version.js'), 'utf8')
  const gateSrc = readFileSync(join(ROOT, 'lib', 'gate.js'), 'utf8')
  for (const [name, s] of [['lib/miyoushe-version.js', src], ['lib/gate.js', gateSrc]]) {
    check(!s.includes('node:fs') && !s.includes("from 'fs'"), name + ' 无 fs 直连', 'ok', 'no-fs')
    // t22 / A3③：改前＝「`fetch(` 计数 = 0（网络只能注入）」；改后＝受控出站唯一落点计数 = 1，其它 lib 文件恒为 0
    const want = name === 'lib/miyoushe-version.js' ? 1 : 0
    check((s.split('fetch(').length - 1) === want, name + ' fetch 调用计数 = ' + want + (want === 1 ? '（§3.5.8 受控出站唯一落点）' : '（出站不得外溢）'), (s.split('fetch(').length - 1), want)
    check(!/from '(node:)?(http|https|net|dns)'/.test(s), name + ' 无 http/net/dns 直连', 'ok', 'none')
    check((s.match(/[0-9a-fA-F]{32}/g) || []).length === 0, name + ' 无 32hex 字面量（无盐明文）', 'ok', '[]')
  }
  check(SENSITIVE_TOKENS.length > 0 && src.length > 0, '跨用 mask.js 的敏感词表做凭据头检查（夹具健全性）', 'ok', 'ok')
  check(new VersionError('X', 'm').code === 'X' && VERSION_ERR.FP_BAD_SALT === 'FP_BAD_SALT', 'VersionError / VERSION_ERR 导出', 'ok', 'ok')
}

console.log('')
console.log('VERSION failures=' + failures + ' skipped=' + skips)
process.exitCode = failures === 0 ? 0 : 1
