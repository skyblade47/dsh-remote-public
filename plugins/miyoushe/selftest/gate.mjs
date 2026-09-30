// @local/miyoushe —— 门禁纯函数单测（设计 §6.5；node 直调，**不加载插件、零网络、零写盘**）
// 运行：node selftest/gate.mjs      （退出码 0 = 全过）
//
// 覆盖（t13/A3 的 ①–⑤ + 边界）：
//   ① G2「换盐后旧 success 不满足」（reason=salt_changed）
//   ② 「只失败过（doneKeys 有 failed 记录）但无同源 success ⇒ 不得放行」
//   ③ scope='all' 时任一组合缺同源 success ⇒ 拒绝
//   ④ unverified-current ⇒ 软阻断 + mode:'unverified'
//   ⑤ reasons[] 上限 20 + truncated + missingGroups
//   ⑥ 边界：G1/G4(stale|五码)/G5 硬阻断不可越权；G3 doneKeys_conflict；N 天窗口与上限 30；id↔reason 映射
//
// 纪律：盐值一律**运行时生成**（不落 32hex 字面量）；`now` 全部注入 ⇒ 结果可复跑。

import { createHash } from 'node:crypto'
import {
  evaluateGate, evaluateGroupSuccess, normalizeGroups, collectBlockingCodes, activeSaltInfo,
  findConflictingDoneKey, effectiveMaxSignAgeDays, toGateError,
  MAX_REASONS, MAX_SIGN_AGE_DAYS_CAP, HARD_BLOCKING_CODES,
} from '../lib/gate.js'
import { fingerprint } from '../lib/miyoushe-version.js'

let failures = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
const show = (label, obj) => console.log('  ' + label + ' => ' + JSON.stringify(obj))

// ---------------------------------------------------------------------------
// 夹具（盐运行时生成；不含 32hex 字面量）
// ---------------------------------------------------------------------------
const hexSalt = (seed) => createHash('sha256').update(seed).digest('hex').slice(0, 32)
const SALT_A = hexSalt('gate-test-salt-A')
const SALT_B = hexSalt('gate-test-salt-B')
const FP_A = fingerprint(SALT_A)
const FP_B = fingerprint(SALT_B)
const NOW = Date.parse('2026-09-20T02:00:00Z')
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString()
const DAY = 86400 * 1000

const READY = { settingsReadable: true, endpointsReadable: true, dataDirExists: true }
const CRED_OK = { configured: true, lastOkAt: ISO(2 * DAY) }

function mkSalts(o) {
  const x = o || {}
  const appVersion = x.appVersion === undefined ? '2.109.0' : x.appVersion
  const status = x.status === undefined ? 'verified' : x.status
  const salt = x.salt === undefined ? SALT_A : x.salt
  const entries = x.entries === undefined
    ? { [appVersion]: { clientType: '5', salt, status, sourceKind: x.sourceKind === undefined ? 'manual' : x.sourceKind, fetchedAt: ISO(2 * DAY) } }
    : x.entries
  return {
    version: 2,
    updatedAt: ISO(2 * DAY),
    active: { appVersion, clientType: '5' },
    entries,
    versionCache: x.versionCache === undefined
      ? { appVersion, clientType: '5', fetchedAt: ISO(2 * DAY), ttlMs: 86400000, lastFetchOk: true, lastFetchError: null }
      : x.versionCache,
  }
}
function mkState(o) {
  const x = o || {}
  return {
    version: 1,
    schedule: { enabled: false, mode: 'readonly', nextAt: null, lastRunAt: null, pausedBy: x.pausedBy === undefined ? null : x.pausedBy },
    credentials: x.credentials === undefined ? CRED_OK : x.credentials,
    doneKeys: x.doneKeys === undefined ? {} : x.doneKeys,
    lastSignSuccess: x.lastSignSuccess === undefined ? {} : x.lastSignSuccess,
    lastError: x.lastError === undefined ? null : x.lastError,
    lock: null,
  }
}
const successRec = (o) => Object.assign({
  outcome: 'success',
  at: ISO(1 * DAY),
  saltFingerprint: FP_A,
  appVersion: '2.109.0',
  retcode: 0,
}, o || {})
const G = (accountKey, gameKey) => ({ accountKey, gameKey })
const A1 = 'acct-***1234'
const A2 = 'acct-***5678'
const ctx = (extra) => Object.assign({ now: NOW, readiness: READY }, extra || {})
const settingsOf = (maxSignAgeDays) => ({ gate: maxSignAgeDays === undefined ? {} : { maxSignAgeDays } })

console.log('== 夹具指纹（运行时生成，供下列断言引用）==')
show('fingerprint(SALT_A)', FP_A)
show('fingerprint(SALT_B)', FP_B)
check(FP_A !== FP_B, '换盐 ⇒ 指纹变化（G2③ 的判据基础）', FP_A, '≠' + FP_B)

console.log('\n== ① G2：换盐后旧 success 不再满足（reason=salt_changed）==')
{
  const state = mkState({ lastSignSuccess: { [A1]: { hk4e: successRec({ saltFingerprint: FP_A, appVersion: '2.107.0' }) } } })
  const salts = mkSalts({ appVersion: '2.109.0', salt: SALT_B }) // 当前版本/盐已变
  const gate = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  show('gate(G2-salt_changed)', { ok: gate.ok, mode: gate.mode, softItems: gate.softItems, hardItems: gate.hardItems, reasons: gate.reasons })
  const r = gate.reasons.find((x) => x.id === 'G2')
  check(gate.ok === false && gate.mode === 'readonly', '默认拒绝（未越权）', { ok: gate.ok, mode: gate.mode }, { ok: false, mode: 'readonly' })
  check(r && r.reason === 'salt_changed', 'reason=salt_changed', r && r.reason, 'salt_changed')
  check(r && r.scope && r.scope.accountKey === A1 && r.scope.gameKey === 'hk4e', 'reasons 条目带 scope', r && r.scope, { accountKey: A1, gameKey: 'hk4e' })
  check(gate.failedByGroup[A1] && gate.failedByGroup[A1].hk4e.join(',') === 'G2', 'failedByGroup 映射到 G2', gate.failedByGroup, obj({ [A1]: { hk4e: ['G2'] } }))
  check(gate.softItems.join(',') === 'G2' && gate.hardItems.length === 0, 'G2 属**软**阻断（无硬项）', { soft: gate.softItems, hard: gate.hardItems }, { soft: ['G2'], hard: [] })
  const over = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')], confirm: true, acknowledgeUnverified: true }))
  show('gate(同上 + confirm+ack)', { ok: over.ok, mode: over.mode, overridden: over.overridden })
  check(over.ok === true && over.mode === 'unverified' && over.overridden === true, '显式越权 ⇒ mode=unverified（不是 auto）', { ok: over.ok, mode: over.mode, overridden: over.overridden }, { ok: true, mode: 'unverified', overridden: true })
  // 同源（版本+指纹都一致）⇒ G2 通过
  const okGate = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  check(okGate.ok === true && okGate.mode === 'auto' && okGate.softItems.length === 0, '同源 success ⇒ 直接 auto', { ok: okGate.ok, mode: okGate.mode }, { ok: true, mode: 'auto' })
}

console.log('\n== ② 只失败过（doneKeys 有 failed）但无同源 success ⇒ 不得放行 ==')
{
  const state = mkState({
    lastSignSuccess: {},
    doneKeys: { [A1 + ':hk4e:2026-09-20']: { status: 'failed', at: ISO(1 * DAY), retcode: -100, attempts: 3 } },
  })
  const salts = mkSalts()
  const gate = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  show('gate(doneKeys=failed)",', { ok: gate.ok, mode: gate.mode, reasons: gate.reasons })
  const r = gate.reasons.find((x) => x.id === 'G2' && x.scope)
  check(gate.ok === false, '默认不放行', gate.ok, false)
  check(r && r.reason === 'no_success', 'doneKeys 不作门禁证据 ⇒ reason=no_success', r && r.reason, 'no_success')
  check(!gate.reasons.some((x) => x.id === 'G3'), 'G2 未过时不报 G3（id↔reason 判序：先 G2 后 G3）', gate.reasons.map((x) => x.id), '不含 G3')
  const over = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')], confirm: true, acknowledgeUnverified: true }))
  check(over.ok === true && over.mode === 'unverified', '越权也只能到 unverified（绝不因 doneKeys 变 auto）', { ok: over.ok, mode: over.mode }, { ok: true, mode: 'unverified' })
}

console.log('\n== ③ scope=all：任一组合缺同源 success ⇒ 拒绝（逐组合，不接受"别的组合的成功"）==')
{
  const state = mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } } }) // 只有 A1/hk4e
  const salts = mkSalts()
  const gate = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e'), G(A1, 'zzz'), G(A2, 'hk4e')] }))
  show('gate(3 combos,1 ok)', { ok: gate.ok, evaluatedGroups: gate.evaluatedGroups, totalFailingGroups: gate.totalFailingGroups, failedByGroup: gate.failedByGroup, groupReasons: gate.reasons.filter((x) => x.scope) })
  check(gate.ok === false, '任一组合不合格 ⇒ 整体拒绝', gate.ok, false)
  check(gate.evaluatedGroups === 3 && gate.totalFailingGroups === 2, '评估 3 组合、2 组不合格', { n: gate.evaluatedGroups, f: gate.totalFailingGroups }, { n: 3, f: 2 })
  check(gate.failedByGroup[A1].zzz.join(',') === 'G2' && gate.failedByGroup[A2].hk4e.join(',') === 'G2', 'failedByGroup 精确到 (account,game)', gate.failedByGroup, obj({ [A1]: { zzz: ['G2'] }, [A2]: { hk4e: ['G2'] } }))
  const scoped = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e'), G(A1, 'zzz'), G(A2, 'zzz')], scope: 'account', accountKey: A2 }))
  show('gate(scope=account A2)', { ok: scoped.ok, evaluatedGroups: scoped.evaluatedGroups, failedByGroup: scoped.failedByGroup })
  check(scoped.ok === false && scoped.evaluatedGroups === 1 && scoped.failedByGroup[A2] && scoped.failedByGroup[A2].zzz.join(',') === 'G2', 'scope=account 只评估该账号（A2/zzz 缺同源 ⇒ 拒绝）', { ok: scoped.ok, n: scoped.evaluatedGroups }, { ok: false, n: 1 })
  // fail-closed：组合清单为空/不可得 ⇒ 不允许"零组合直接放行"
  const empty = evaluateGate(state, salts, settingsOf(), ctx({ groups: [] }))
  show('gate(空组合清单)', { ok: empty.ok, groupsEmpty: empty.groupsEmpty, hardItems: empty.hardItems, g5: empty.reasons.find((x) => x.id === 'G5') })
  check(empty.ok === false && empty.groupsEmpty === true && empty.hardItems.join(',') === 'G5', '零组合 ⇒ fail-closed（G5 硬阻断，绝不静默放行）', { ok: empty.ok, hard: empty.hardItems }, { ok: false, hard: ['G5'] })
  const emptyOver = evaluateGate(state, salts, settingsOf(), ctx({ groups: [], confirm: true, acknowledgeUnverified: true }))
  check(emptyOver.ok === false, '零组合 + 越权 ⇒ 仍拒绝（硬项不可越权）', emptyOver.ok, false)
}

console.log('\n== ④ unverified-current ⇒ 软阻断 + mode:unverified（默认仍拒绝）==')
{
  const state = mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } } })
  const salts = mkSalts({ status: 'unverified-current' })
  const gate = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  show('gate(unverified, no opt-in)', { ok: gate.ok, mode: gate.mode, softItems: gate.softItems, hardItems: gate.hardItems, g4: gate.reasons.find((x) => x.id === 'G4') })
  check(gate.ok === false && gate.mode === 'readonly', '默认拒绝', { ok: gate.ok, mode: gate.mode }, { ok: false, mode: 'readonly' })
  check(gate.softItems.join(',') === 'G4' && gate.hardItems.length === 0, 'G4-unverified 属软项', { soft: gate.softItems, hard: gate.hardItems }, { soft: ['G4'], hard: [] })
  const over = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')], confirm: true, acknowledgeUnverified: true }))
  check(over.ok === true && over.mode === 'unverified' && over.overridden === true, 'confirm+ack ⇒ mode=unverified', { ok: over.ok, mode: over.mode }, { ok: true, mode: 'unverified' })
  // 只传一半（缺 acknowledgeUnverified）⇒ 逃生口不可达（§6.5 t6/F4 更正）
  const half = evaluateGate(state, salts, settingsOf(), ctx({ groups: [G(A1, 'hk4e')], confirm: true }))
  check(half.ok === false && half.mode === 'readonly', '只传 confirm ⇒ 仍拒绝（软项逃生口需两项齐备）', { ok: half.ok, mode: half.mode }, { ok: false, mode: 'readonly' })
}

console.log('\n== ⑤ reasons[] 上限 20 + truncated + missingGroups ==')
{
  const groups = []
  for (let i = 0; i < 30; i++) groups.push(G('acct-***' + String(1000 + i), 'hk4e'))
  const gate = evaluateGate(mkState(), mkSalts(), settingsOf(), ctx({ groups }))
  const groupReasons = gate.reasons.filter((x) => x.scope)
  show('gate(30 failing groups)', { reasonsLen: gate.reasons.length, truncated: gate.truncated, missingGroups: gate.missingGroups, totalFailingGroups: gate.totalFailingGroups, failedByGroupKeys: Object.keys(gate.failedByGroup).length, globalIds: gate.reasons.filter((x) => !x.scope).map((x) => x.id) })
  check(gate.reasons.length === MAX_REASONS, 'reasons 恰好 20 条（上限）', gate.reasons.length, MAX_REASONS)
  check(gate.truncated === true, 'truncated=true', gate.truncated, true)
  check(gate.missingGroups === 33 - MAX_REASONS, 'missingGroups=被截断条数（1+30+2-20=13）', gate.missingGroups, 13)
  check(groupReasons.length === MAX_REASONS - 3, '全局项永远保留（G1/G4/G5 占 3 条，组合条目占 17）', groupReasons.length, 17)
  check(['G1', 'G4', 'G5'].every((id) => gate.reasons.some((x) => x.id === id && !x.scope)), 'G1/G4/G5 未被截断', gate.reasons.filter((x) => !x.scope).map((x) => x.id), '含 G1/G4/G5')
  check(Object.keys(gate.failedByGroup).length === 30 && gate.totalFailingGroups === 30, 'failedByGroup 完整（不被截断，供机器消费）', Object.keys(gate.failedByGroup).length, 30)
  const small = evaluateGate(mkState(), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  check(small.truncated === false && small.missingGroups === 0, '未超限时 truncated=false / missingGroups=0', { t: small.truncated, m: small.missingGroups }, { t: false, m: 0 })
}

console.log('\n== ⑥ 硬阻断不可越权（G1 / G4-stale / G4-五码 / G5）==')
{
  const groups = [G(A1, 'hk4e')]
  const okState = mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } } })
  const ow = { groups, confirm: true, acknowledgeUnverified: true }

  const g1 = evaluateGate(mkState({ credentials: { configured: true, lastOkAt: null }, lastSignSuccess: { [A1]: { hk4e: successRec() } } }), mkSalts(), settingsOf(), ctx(ow))
  show('gate(G1 fail + 越权)', { ok: g1.ok, mode: g1.mode, hardItems: g1.hardItems, hardBlocked: g1.hardBlocked })
  check(g1.ok === false && g1.hardBlocked === true && g1.hardItems.join(',') === 'G1', 'G1 硬阻断（configured 但 lastOkAt=null）', { ok: g1.ok, hard: g1.hardItems }, { ok: false, hard: ['G1'] })

  const stale = evaluateGate(okState, mkSalts({ status: 'stale' }), settingsOf(), ctx(ow))
  const rejected = evaluateGate(okState, mkSalts({ status: 'rejected' }), settingsOf(), ctx(ow))
  check(stale.ok === false && stale.hardItems.join(',') === 'G4' && stale.mode === 'readonly', 'G4=stale ⇒ 硬阻断且越权无效', { ok: stale.ok, hard: stale.hardItems, mode: stale.mode }, { ok: false, hard: ['G4'], mode: 'readonly' })
  check(rejected.ok === false && rejected.hardItems.join(',') === 'G4', 'G4=rejected ⇒ 硬阻断', rejected.hardItems, ['G4'])

  for (const code of HARD_BLOCKING_CODES) {
    const viaCode = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } }, lastError: { code, at: ISO(3600 * 1000) } }), mkSalts(), settingsOf(), ctx(ow))
    check(viaCode.ok === false && viaCode.hardItems.join(',') === 'G4', '五错误码硬阻断：' + code, { ok: viaCode.ok, hard: viaCode.hardItems }, { ok: false, hard: ['G4'] })
  }
  const viaCache = evaluateGate(okState, mkSalts({ versionCache: { appVersion: '2.109.0', clientType: '5', fetchedAt: ISO(2 * DAY), ttlMs: 86400000, lastFetchOk: false, lastFetchError: 'TIMEOUT' } }), settingsOf(), ctx(ow))
  check(viaCache.ok === false && viaCache.hardItems.join(',') === 'G4' && collectBlockingCodes(mkState({}), mkSalts({ versionCache: { lastFetchOk: false } })).join(',') === 'VERSION_STALE', 'versionCache.lastFetchOk=false ⇒ VERSION_STALE 硬阻断', viaCache.hardItems, ['G4'])

  const g5 = evaluateGate(okState, mkSalts(), settingsOf(), ctx({ groups, confirm: true, acknowledgeUnverified: true, readiness: { settingsReadable: true, endpointsReadable: true, dataDirExists: false } }))
  show('gate(G5 fail + 越权)', { ok: g5.ok, hardItems: g5.hardItems, g5reason: g5.reasons.find((x) => x.id === 'G5') })
  check(g5.ok === false && g5.hardItems.join(',') === 'G5' && g5.mode === 'readonly', 'G5（数据目录缺失）硬阻断', { ok: g5.ok, hard: g5.hardItems }, { ok: false, hard: ['G5'] })
  check(g5.reasons.find((x) => x.id === 'G5').detail.includes('全局数据/miyoushe/'), 'G5 detail 指明缺什么', g5.reasons.find((x) => x.id === 'G5').detail, '<含路径>')
}

console.log('\n== ⑦ G3 独有 reason＝doneKeys_conflict（同源 success 与终态失败互相矛盾）==')
{
  const state = mkState({
    lastSignSuccess: { [A1]: { hk4e: successRec() } },
    doneKeys: { [A1 + ':hk4e:2026-09-20']: { status: 'human_required', at: ISO(3600 * 1000) } },
  })
  const gate = evaluateGate(state, mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  const r = gate.reasons.find((x) => x.scope)
  show('gate(G3 conflict)', { ok: gate.ok, reasonId: r && r.id, reason: r && r.reason, softItems: gate.softItems })
  check(r && r.id === 'G3' && r.reason === 'doneKeys_conflict', 'id=G3 / reason=doneKeys_conflict', r && [r.id, r.reason], ['G3', 'doneKeys_conflict'])
  check(gate.failedByGroup[A1].hk4e.join(',') === 'G3', 'failedByGroup 记 G3', gate.failedByGroup[A1], obj({ hk4e: ['G3'] }))
  check(findConflictingDoneKey({ 'x:zzz:2026-09-20': { status: 'signed' } }, A1, 'zzz') === null, '非终态失败标记不算冲突', null, null)
  const valShape = findConflictingDoneKey({ 'anyKey': { accountKey: A1, gameKey: 'hk4e', status: 'skipped_window' } }, A1, 'hk4e')
  check(valShape && valShape.status === 'skipped_window', '兼容"值对象带 accountKey/gameKey"的写法', valShape && valShape.status, 'skipped_window')
}

console.log('\n== ⑧ 窗口边界与 maxSignAgeDays 上限 ==')
{
  const freshSide = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec({ at: ISO(6.9 * DAY) }) } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  const staleSide = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec({ at: ISO(7.1 * DAY) }) } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  const badAt = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec({ at: 'not-a-date' }) } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  check(freshSide.ok === true, '6.9 天前 ⇒ 在窗口内（通过）', freshSide.ok, true)
  check(staleSide.ok === false && staleSide.reasons.find((x) => x.scope).reason === 'expired', '7.1 天前 ⇒ expired', staleSide.reasons.find((x) => x.scope).reason, 'expired')
  check(badAt.ok === false && badAt.reasons.find((x) => x.scope).reason === 'expired', 'at 非法 ⇒ expired（不静默通过）', badAt.reasons.find((x) => x.scope).reason, 'expired')
  check(effectiveMaxSignAgeDays(settingsOf(999)) === MAX_SIGN_AGE_DAYS_CAP, 'maxSignAgeDays 上限 30（传 999）', effectiveMaxSignAgeDays(settingsOf(999)), 30)
  check(effectiveMaxSignAgeDays(settingsOf(0)) === 7 && effectiveMaxSignAgeDays({}) === 7, '非法/缺省 ⇒ 7', [effectiveMaxSignAgeDays(settingsOf(0)), effectiveMaxSignAgeDays({})], [7, 7])
  const wide = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec({ at: ISO(20 * DAY) }) } } }), mkSalts(), settingsOf(30), ctx({ groups: [G(A1, 'hk4e')] }))
  check(wide.ok === true, 'settings.gate.maxSignAgeDays=30 ⇒ 20 天的记录仍通过', wide.ok, true)
  const capped = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec({ at: ISO(31 * DAY) }) } } }), mkSalts(), settingsOf(999), ctx({ groups: [G(A1, 'hk4e')] }))
  check(capped.ok === false, '上限 30 生效：31 天前 ⇒ 拒绝', capped.ok, false)
}

console.log('\n== ⑨ 输出形状 / 全绿 / 工具函数 ==')
{
  const green = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  show('gate(all green)', green)
  check(green.ok === true && green.mode === 'auto' && green.hardBlocked === false && green.overridden === false, '全绿 ⇒ ok/auto', { ok: green.ok, mode: green.mode }, { ok: true, mode: 'auto' })
  check(green.reasons.length === 4 && green.reasons.every((r) => r.ok === true), 'reasons 含每条被评估判据（G1/G2/G4/G5，均 ok=true；对齐 §6.5.1 示例的 G5 ok:true 口径）', green.reasons.map((r) => r.id + ':' + r.ok), ['G1:true', 'G2:true', 'G4:true', 'G5:true'])
  check(green.reasonScope === 'per-group' && green.maxReasonEntries === MAX_REASONS, 'reasonScope/maxReasonEntries 字段', [green.reasonScope, green.maxReasonEntries], ['per-group', 20])
  check(typeof green.at === 'string' && green.at === new Date(NOW).toISOString(), 'at 由注入的 now 决定（可复跑）', green.at, new Date(NOW).toISOString())
  check(green.effective.activeSaltFingerprint === FP_A, 'effective 只带指纹（不带盐明文）', green.effective.activeSaltFingerprint, FP_A)
  check(!JSON.stringify(green).includes(SALT_A), '门禁输出**不含盐明文**', '(含)', '(不含)')
  const err = toGateError(green)
  check(err.code === 'SCHEDULE_GATE_BLOCKED' && Array.isArray(err.reasons), 'toGateError ⇒ SCHEDULE_GATE_BLOCKED + reasons[]', { code: err.code, n: err.reasons.length }, { code: 'SCHEDULE_GATE_BLOCKED', n: 4 })
  check(normalizeGroups({ groups: [G(A1, 'hk4e'), G(A1, 'hk4e')] }).length === 1, 'normalizeGroups 去重', 1, 1)
  check(activeSaltInfo({ active: { appVersion: '9.9.9' }, entries: {} }).status === 'missing', 'salt 条目缺失 ⇒ status=missing（不静默）', 'missing', 'missing')
  check(JSON.stringify(activeSaltInfo({}).fingerprint) === 'null' && activeSaltInfo({}).fingerprintError === null, '无盐 ⇒ fingerprint=null / 无异常', 'ok', 'null')
}

console.log('\n== ⑩ t52：G2 接受 already（G2b）· G3 当日限定（T2）· 源头 hint 可执行（T1）==')
{
  const ld = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) }
  const today = ld(NOW)
  const yesterday = ld(NOW - 86400000)
  const alreadyRec = { outcome: 'already', at: ISO(3600 * 1000), retcode: -5003, saltFingerprint: FP_A, appVersion: '2.109.0' }
  // G2b 正：already + **同源**指纹 ⇒ G2 通过
  const gb = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: alreadyRec } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  show('G2b(already 同源)', { ok: gb.ok, soft: gb.softItems })
  check(gb.ok === true, 'G2b `outcome:already` + 同源指纹 ⇒ **G2 通过**（不再 `no_success`）', gb.ok, true)
  // G2b 负①：already 但**换盐** ⇒ 仍 salt_changed（`:203` 一字未动）
  const saltDiff = Object.assign({}, alreadyRec, { saltFingerprint: FP_B, appVersion: '2.107.0' })
  const gb2 = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: saltDiff } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  const r2 = gb2.reasons.filter((x) => x.id === 'G2')[0] || {}
  check(gb2.ok === false && r2.reason === 'salt_changed', 'G2b **禁止跨盐复用**未被放宽：already 记录换了盐 ⇒ 仍 `salt_changed`', r2.reason, 'salt_changed')
  // G2b 负②：只放宽到 {success, already} ⇒ failed 仍 no_success
  const gb3 = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: Object.assign({}, alreadyRec, { outcome: 'failed' }) } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  const r3 = gb3.reasons.filter((x) => x.id === 'G2')[0] || {}
  check(gb3.ok === false && r3.reason === 'no_success', 'G2b 只放宽到 `{success, already}`：`failed` 记录仍 `no_success`', r3.reason, 'no_success')
  // T2 负：**当日** failed + 同源 success ⇒ 仍报 G3
  const t2a = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } }, doneKeys: { [A1 + ':hk4e:' + today + ':cn_gf01']: { status: 'failed', at: new Date(NOW).toISOString() } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  check(t2a.reasons.some((x) => x.id === 'G3' && x.reason === 'doneKeys_conflict'), 'T2 **当日** failed + 同源 success ⇒ **仍报 G3**（缺口不被掩盖）', t2a.reasons.map((x) => x.id).join(','), '<含 G3>')
  // T2 正：**昨日** failed + 今日 success ⇒ 不再报 G3
  const t2b = evaluateGate(mkState({ lastSignSuccess: { [A1]: { hk4e: successRec() } }, doneKeys: { [A1 + ':hk4e:' + yesterday + ':cn_gf01']: { status: 'failed', at: new Date(NOW - 86400000).toISOString() } } }), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  show('T2(昨日 failed)', { ok: t2b.ok, ids: t2b.reasons.map((x) => x.id + ':' + x.ok) })
  check(t2b.ok === true && !t2b.reasons.some((x) => x.id === 'G3'), 'T2 **昨日** failed + 今日 success ⇒ **不再报 G3**（长跑不再被历史失败键永久挡住）', t2b.reasons.map((x) => x.id + ':' + x.ok).join(','), '<无 G3>')
  // T2 纯函数：给 dateLocal ⇒ 只判当日；不给 ⇒ 保持旧盲扫（兼容）
  const oldKey = A1 + ':hk4e:' + yesterday
  check(findConflictingDoneKey({ [oldKey]: { status: 'failed' } }, A1, 'hk4e', today) === null && findConflictingDoneKey({ [oldKey]: { status: 'failed' } }, A1, 'hk4e') !== null, 'T2 纯函数：给 `dateLocal` ⇒ 只判当日；**不给** ⇒ 保持旧盲扫语义（向后兼容）', 'see-expr', '<null / 命中>')
  // T1：gate.js **源头** hint 已可执行（不再指向未实现的 run 分支）
  const noSucc = evaluateGate(mkState({}), mkSalts(), settingsOf(), ctx({ groups: [G(A1, 'hk4e')] }))
  const hint = ((noSucc.reasons.filter((x) => x.id === 'G2')[0] || {}).hint) || ''
  show('T1 源头 hint', hint)
  check(hint.includes('miyoushe_sign {') && hint.indexOf('miyoushe_run {') === -1, 'T1 `gate.js` **源头** hint 是可执行的 `miyoushe_sign {…}`（不含 `miyoushe_run {…}`）', hint.slice(0, 56), '<含 sign / 不含 run 调用形式>')
}

function obj(o) { return o }

console.log('')
console.log('GATE failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
