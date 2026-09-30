// @local/miyoushe —— 调度器单测（设计 §5；**注入时钟、内存数据面、零真实网络**）
// 运行：node selftest/scheduler.mjs      （退出码 0 = 全过）
//
// 覆盖（t16/A5①）：去重键 §5.2 / 启动补偿 §5.3（≠ 无条件补签）/ 有限退避 §5.4 / 抖动 §5.1 / 单飞锁 §5.5
//   以及 `createScheduler` 与 store（adapterFs）的接线：dryRun 为**纯预览不写盘**、真跑时经注入的 execute。

import { createHash } from 'node:crypto'
import {
  TARGETS, OUTCOMES, TERMINAL_OUTCOMES, DEFAULTS, LOCK_TTL_MS, SPREAD_JITTER_DEFAULT, SPREAD_DEFAULTS,
  localDateOf, hmToMinutes, minutesOfDay, inWindow, nextWindowStart, jitterFor,
  dedupeKey, parseDedupeKey, lookupDoneEntry, backoffFor, isTerminal, decideOne, planTick, planCompensate,
  applyResult, lockDecision, createScheduler,
  spreadMinGapOf, spreadJitterOf, spreadEnabledOf, randInRange, windowSpanFor, comboKeyOf,
  targetSelected, buildDailyPlan, dailyPlanOf, dailyPlanUsable, ensureDailyPlan,
  applySpreadToDecision, spreadPendingKeys, planItemIndex, planKeyOf, SPREAD_DEGRADE_REASON,
  ANCHOR_JITTER_MS, // 补丁②（2026-08-30「开机即签」）
  migrateLegacyDoneKeys, // t50/N1
} from '../lib/scheduler.js'
import { findConflictingDoneKey } from '../lib/gate.js' // t50/N1：用**真实门禁判据**验证"迁移后 G3 不再冲突"

let failures = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
const show = (l, o) => console.log('  ' + l + ' => ' + JSON.stringify(o))
/** t39：可复现的随机源（按序列循环取值） */
const seqRand = (arr) => { let i = 0; return () => arr[(i++) % arr.length] }

// ---- 注入时钟（本地时区固定为 2026-09-20 的若干时刻）----
const at = (h, m) => new Date(2026, 8, 20, h, m, 0, 0).getTime() // 月份 0-based：8=九月
const T_0900 = at(9, 0)
const T_0700 = at(7, 0)
const T_2331 = at(23, 31)
const hexSalt = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32)
const SALT = hexSalt('sched-salt')
const TODAY = localDateOf(T_0900)

console.log('== §5.1 时间模型：hm/窗口/下次窗口起点 ==')
{
  check(hmToMinutes('08:00') === 480 && hmToMinutes('23:30') === 1410, 'hmToMinutes 正常', [hmToMinutes('08:00'), hmToMinutes('23:30')], [480, 1410])
  check(hmToMinutes('24:00') === null && hmToMinutes('8') === null && hmToMinutes(null) === null, 'hmToMinutes 非法 ⇒ null（不猜）', [hmToMinutes('24:00'), hmToMinutes('8')], [null, null])
  check(inWindow(at(8, 0), '08:00', '23:30') && inWindow(at(23, 30), '08:00', '23:30'), '窗口含端点', 'ok', 'true')
  check(!inWindow(at(7, 59), '08:00', '23:30') && !inWindow(at(23, 31), '08:00', '23:30'), '窗口外（07:59 / 23:31）', 'ok', 'false')
  check(inWindow(at(23, 30), '23:00', '02:00') && !inWindow(at(12, 0), '23:00', '02:00'), '跨零点窗口（23:00–02:00）', 'ok', 'true/false')
  check(minutesOfDay(at(9, 30)) === 570, 'minutesOfDay', minutesOfDay(at(9, 30)), 570)
  const nxt = nextWindowStart(T_0700, '08:00')
  show('nextWindowStart(07:00)', new Date(nxt).toTimeString().slice(0, 8))
  check(new Date(nxt).getHours() === 8 && new Date(nxt).getMinutes() === 0 && nxt > T_0700, '窗口前 ⇒ 当天 08:00', new Date(nxt).toISOString(), '<today 08:00>')
  const nxt2 = nextWindowStart(T_0900, '08:00')
  check(new Date(nxt2).getDate() === 21 && new Date(nxt2).getHours() === 8, '已在窗口内 ⇒ 次日 08:00', new Date(nxt2).toISOString(), '<next day 08:00>')
}

console.log('== §5.1 抖动：确定性（同 key+日期恒等，不依赖 Math.random）==')
{
  const a1 = jitterFor('acct-***1234:hk4e', TODAY, DEFAULTS.dailyJitterMs)
  const a2 = jitterFor('acct-***1234:hk4e', TODAY, DEFAULTS.dailyJitterMs)
  const b = jitterFor('acct-***5678:hk4e', TODAY, DEFAULTS.dailyJitterMs)
  const c = jitterFor('acct-***1234:hk4e', '2026-09-21', DEFAULTS.dailyJitterMs)
  show('jitter', { same: a1, other: b, otherDay: c, span: DEFAULTS.dailyJitterMs })
  check(a1 === a2, '同 key+日期 ⇒ 恒等（可复跑）', a1, a2)
  check(a1 !== b || a1 !== c, '不同 key/日期 ⇒ 抖动不同（至少其一）', [a1, b, c], '<不全相同>')
  check(a1 >= 0 && a1 < DEFAULTS.dailyJitterMs, '抖动在 [0, jitter) 内', a1, '<span>')
  check(jitterFor('x', TODAY, 0) === 0, 'jitterMs=0 ⇒ 0', jitterFor('x', TODAY, 0), 0)
}

console.log('== §5.2 当日去重键（t39/P10：region 感知）==')
{
  const k = dedupeKey('acct-***1234', 'hk4e', TODAY)
  show('dedupeKey（无 region ⇒ 旧格式）', k)
  check(k === 'acct-***1234:hk4e:' + TODAY, '形状 ${accountId}:${target}:${yyyy-mm-dd}（无 region ⇒ 与旧格式逐字一致）', k, '<形状>')
  check(JSON.stringify(parseDedupeKey(k)) === JSON.stringify({ accountId: 'acct-***1234', target: 'hk4e', dateLocal: TODAY, region: '' }), '反解一致（region 缺省为空串）', parseDedupeKey(k), '<同>')
  check(parseDedupeKey('a:b') === null && parseDedupeKey('a:hk4e:not-a-date') === null, '非法键 ⇒ null', 'ok', 'null')
  // t39/P10：region 感知 —— bh3 三区服必须是**三个互不相同**的键（旧口径会折叠成一个 ⇒ 漏签两个区服）
  const kBh3 = ['bb01', 'pc01', 'android01'].map((r) => dedupeKey('acct-***1234', 'bh3', TODAY, r))
  show('bh3 三区服键', kBh3)
  check(new Set(kBh3).size === 3, 'P10 同账号 bh3 三区服 ⇒ 3 个**互不相同**的去重键', kBh3.length, 3)
  check(kBh3[0] === 'acct-***1234:bh3:' + TODAY + ':bb01', 'P10 带 region 的形状 ${acct}:${target}:${date}:${region}', kBh3[0], '<4 段>')
  check(kBh3.every((x) => x !== dedupeKey('acct-***1234', 'bh3', TODAY)), 'P10 带 region 的键 ≠ 无 region 的旧键（不混用）', 'ok', 'true')
  check(JSON.stringify(parseDedupeKey(kBh3[0])) === JSON.stringify({ accountId: 'acct-***1234', target: 'bh3', dateLocal: TODAY, region: 'bb01' }), 'P10 4 段键可反解出 region', parseDedupeKey(kBh3[0]), '<含 region=bb01>')
  check(parseDedupeKey(dedupeKey('acct-***1234', 'bbs', TODAY, '')) === null || parseDedupeKey(dedupeKey('acct-***1234', 'bbs', TODAY, '')).region === '', 'P10 bbs（无区服）仍走 3 段旧格式', dedupeKey('acct-***1234', 'bbs', TODAY, ''), '<3 段>')
  // P10 兼容读：新（region）键优先，旧 3 段键回退（升级前遗留记录不会被"看不见"）
  const dk = { ['acct-***1234:bh3:' + TODAY + ':bb01']: { status: 'signed' }, ['acct-***1234:hk4e:' + TODAY]: { status: 'human_required', attempts: 1 } }
  const hitNew = lookupDoneEntry(dk, 'acct-***1234', 'bh3', TODAY, 'bb01')
  const hitLegacy = lookupDoneEntry(dk, 'acct-***1234', 'hk4e', TODAY, 'cn_gf01')
  const hitNone = lookupDoneEntry(dk, 'acct-***1234', 'bh3', TODAY, 'pc01')
  show('P10 lookupDoneEntry', { newKey: hitNew.entry && hitNew.entry.status, legacy: hitLegacy.entry && hitLegacy.entry.status, legacyFlag: hitLegacy.legacy, none: hitNone.entry })
  check(hitNew.entry.status === 'signed' && hitNew.legacy === false, 'P10 新键命中（legacy:false）', hitNew.legacy, false)
  check(hitLegacy.entry.status === 'human_required' && hitLegacy.legacy === true, 'P10 旧 3 段键回退命中（legacy:true ⇒ force 的人工重试语义不被绕过）', hitLegacy.legacy, true)
  check(hitNone.entry === null, 'P10 未跑过的区服（bh3:pc01）⇒ 无记录（三个区服互不干扰）', hitNone.entry, null)
  check(OUTCOMES.includes('human_required') && TERMINAL_OUTCOMES.includes('failed') && !TERMINAL_OUTCOMES.includes('pending'), '状态集与终态集正确', [OUTCOMES.length, TERMINAL_OUTCOMES.length], [8, 6])
  check(TARGETS.join(',') === 'hk4e,hkrpg,zzz,bh3,bbs', '五个 target', TARGETS.join(','), 'hk4e,hkrpg,zzz,bh3,bbs')
}

console.log('== §5.4 退避（有限，不无限重试）==')
{
  check(backoffFor(1, DEFAULTS.backoffMs) === 300000, '第 1 次失败 ⇒ 5min', backoffFor(1, DEFAULTS.backoffMs), 300000)
  check(backoffFor(2, DEFAULTS.backoffMs) === 1200000, '第 2 次 ⇒ 20min', backoffFor(2, DEFAULTS.backoffMs), 1200000)
  check(backoffFor(3, DEFAULTS.backoffMs) === 3600000, '第 3 次 ⇒ 60min', backoffFor(3, DEFAULTS.backoffMs), 3600000)
  check(backoffFor(99, DEFAULTS.backoffMs) === 3600000, '超过表长 ⇒ 取最后一档（有上限）', backoffFor(99, DEFAULTS.backoffMs), 3600000)
}

console.log('== decideOne（单键决策）==')
{
  const base = { now: T_0900, settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY }
  check(decideOne(Object.assign({}, base, { entry: null })).decision === 'run', '无记录 + 窗口内（抖动已过）⇒ run', decideOne(Object.assign({}, base, { entry: null })).decision, 'run')
  check(decideOne(Object.assign({}, base, { entry: { status: 'signed', attempts: 1 } })).decision === 'done', '终态 ⇒ done（不再重试）', 'done', 'done')
  check(decideOne(Object.assign({}, base, { entry: { status: 'already' } })).decision === 'done', 'already 也是终态', 'done', 'done')
  const early = decideOne({ now: at(8, 1), settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY, entry: null })
  check(early.decision === 'jitter_wait' && Number.isFinite(early.nextRetryAt), '窗口刚开但抖动未到 ⇒ jitter_wait', early.decision, 'jitter_wait')
  const late = decideOne({ now: T_2331, settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY, entry: null })
  check(late.decision === 'expired_window' && late.reason === 'skipped_window', '过窗口 ⇒ skipped_window（不偷偷补签）', late.reason, 'skipped_window')
  const lateAllow = decideOne({ now: T_2331, settings: Object.assign({}, DEFAULTS, { allowLateSign: true }), dedupeKey: 'k', dateLocal: TODAY, entry: null })
  check(lateAllow.decision === 'run' && lateAllow.late === true && lateAllow.reason === 'late_oneshot', 'allowLateSign + 从未尝试 ⇒ 补一次（标 late）', [lateAllow.decision, lateAllow.late], ['run', true])
  const lateAllowTried = decideOne({ now: T_2331, settings: Object.assign({}, DEFAULTS, { allowLateSign: true }), dedupeKey: 'k', dateLocal: TODAY, entry: { status: 'pending', attempts: 1 } })
  check(lateAllowTried.decision === 'expired_window', 'allowLateSign 但已尝试过 ⇒ 不再补（只补一次）', lateAllowTried.decision, 'expired_window')
  const backoff = decideOne({ now: T_0900, settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY, entry: { status: 'pending', attempts: 1, nextRetryAt: T_0900 + 60000 } })
  check(backoff.decision === 'backoff_wait', '退避未到 ⇒ backoff_wait', backoff.decision, 'backoff_wait')
  const exhausted = decideOne({ now: T_0900, settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY, entry: { status: 'failed', attempts: 3 } })
  check(exhausted.decision === 'done' && exhausted.reason === 'failed(maxAttempts)', '达到当日上限 ⇒ 终态 failed(maxAttempts)', [exhausted.decision, exhausted.reason], ['done', 'failed(maxAttempts)'])
  const midRetry = decideOne({ now: T_0900, settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY, entry: { status: 'failed', attempts: 1 } })
  check(midRetry.decision === 'run' && midRetry.reason === 'retry', '失败但未达上限 ⇒ 仍可重试（retry）', midRetry.reason, 'retry')
  const disabled = decideOne({ now: T_0900, settings: DEFAULTS, dedupeKey: 'k', dateLocal: TODAY, entry: null, enabled: false })
  check(disabled.decision === 'disabled' && disabled.reason === 'skipped_disabled', '开关关闭 ⇒ skipped_disabled', disabled.reason, 'skipped_disabled')
}

console.log('== planTick（逐组合计划 + nextAt 由窗口/抖动/退避解出）==')
{
  const groups = [
    { accountKey: 'acct-***1234', target: 'hk4e' },
    { accountKey: 'acct-***1234', target: 'bbs' },
    { accountKey: 'acct-***5678', target: 'zzz' },
  ]
  const state = { doneKeys: { [dedupeKey('acct-***1234', 'hk4e', TODAY)]: { status: 'signed', attempts: 1 } } }
  const p = planTick({ now: T_0900, settings: DEFAULTS, state, groups, enabled: true })
  show('planTick', { run: p.run.map((x) => x.accountKey + '/' + x.target), skipped: p.skipped.map((x) => x.target + ':' + x.reason), nextAt: new Date(p.nextAt).toISOString(), today: p.today })
  check(p.run.length === 2 && p.skipped.length === 1, '3 组合：1 已签跳过 + 2 待跑', [p.run.length, p.skipped.length], [2, 1])
  check(p.skipped[0].reason === 'terminal', '终态组合被跳过（去重键生效）', p.skipped[0].reason, 'terminal')
  check(p.plan.length === 3 && p.today === TODAY, 'plan 覆盖全部组合且 today 正确', p.plan.length, 3)
  const pNoFeed = planTick({ now: T_0900, settings: Object.assign({}, DEFAULTS, { bbsEnabled: false }), state: {}, groups, enabled: true })
  check(pNoFeed.plan.some((x) => x.target === 'bbs' && x.reason === 'skipped_disabled'), 'bbsEnabled=false ⇒ bbs 组合 skipped_disabled', pNoFeed.plan.find((x) => x.target === 'bbs').reason, 'skipped_disabled')
  const pOff = planTick({ now: T_0900, settings: DEFAULTS, state: {}, groups, enabled: false })
  check(pOff.run.length === 0, '开关关闭 ⇒ 无 run', pOff.run.length, 0)
}

console.log('== t39/P1 设置项：默认值 + 形状校验（纯函数口径）==')
{
  check(DEFAULTS.schedule === undefined && SPREAD_DEFAULTS.spreadMinGapMs === 600000, 'P1 缺省值只作为**声明**（SPREAD_DEFAULTS）而不进 DEFAULTS ⇒ 不隐式启用分散', [DEFAULTS.schedule === undefined, SPREAD_DEFAULTS.spreadMinGapMs], [true, 600000])
  check(JSON.stringify(SPREAD_DEFAULTS.spreadJitterMs) === JSON.stringify([30000, 120000]), 'P1 声明缺省 spreadJitterMs = [30000,120000]（30 秒–2 分钟）', SPREAD_DEFAULTS.spreadJitterMs, [30000, 120000])
  check(Array.isArray(SPREAD_DEFAULTS.targets) && SPREAD_DEFAULTS.targets.length === 0, 'P1 声明缺省 targets = []（空 ⇒ 全部组合）', SPREAD_DEFAULTS.targets, [])
  check(spreadMinGapOf(DEFAULTS) === 0 && spreadMinGapOf({ schedule: {} }) === 0, 'P1 未配置（旧 settings）⇒ 最小间隔 0 ⇒ **不启用分散**（旧行为不变）', [spreadMinGapOf(DEFAULTS), spreadMinGapOf({ schedule: {} })], [0, 0])
  check(JSON.stringify(spreadJitterOf(DEFAULTS)) === JSON.stringify([0, 0]), 'P1 未配置 ⇒ 抖动区间 [0,0]', spreadJitterOf(DEFAULTS), [0, 0])
  check(spreadEnabledOf({}) === false && spreadEnabledOf({ schedule: { spreadMinGapMs: 1 } }) === true, 'P1 spreadEnabledOf 判据（任一为正 ⇒ 启用）', [spreadEnabledOf({}), spreadEnabledOf({ schedule: { spreadMinGapMs: 1 } })], [false, true])
  const off = Object.assign({}, DEFAULTS, { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } })
  check(spreadMinGapOf(off) === 600000 && JSON.stringify(spreadJitterOf(off)) === JSON.stringify([30000, 120000]), 'P1 显式配置后解析正确', [spreadMinGapOf(off), spreadJitterOf(off)], [600000, [30000, 120000]])
  check(JSON.stringify(spreadJitterOf({ schedule: { spreadJitterMs: [5000] } })) === JSON.stringify([0, 0]), 'P1 区间数组长度≠2 ⇒ 回落 [0,0]（不猜）', spreadJitterOf({ schedule: { spreadJitterMs: [5000] } }), [0, 0])
  check(JSON.stringify(spreadJitterOf({ schedule: { spreadJitterMs: [-1, -2] } })) === JSON.stringify([0, 0]), 'P1 负区间 ⇒ 归零（不静默变负）', spreadJitterOf({ schedule: { spreadJitterMs: [-1, -2] } }), [0, 0])
}

console.log('== t39/P5 目标筛选 + P2 每日计划（注入 rand 可复现）==')
{
  const SPREAD_TARGETS = ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn', 'bh3:bb01']
  const SPREAD = Object.assign({}, DEFAULTS, { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: SPREAD_TARGETS } })
  const SPREAD_ALL = Object.assign({}, DEFAULTS, { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } })
  // 真实形状夹具（与运行期 accounts.json 同形：6 个角色）
  const groups6 = [
    { accountKey: 'acct-***4968', target: 'bh3', region: 'bb01', comboKey: 'bh3:bb01' },
    { accountKey: 'acct-***4968', target: 'bh3', region: 'pc01', comboKey: 'bh3:pc01' },
    { accountKey: 'acct-***4968', target: 'bh3', region: 'android01', comboKey: 'bh3:android01' },
    { accountKey: 'acct-***4968', target: 'hk4e', region: 'cn_gf01', comboKey: 'hk4e:cn_gf01' },
    { accountKey: 'acct-***4968', target: 'hkrpg', region: 'prod_gf_cn', comboKey: 'hkrpg:prod_gf_cn' },
    { accountKey: 'acct-***4968', target: 'zzz', region: 'prod_gf_cn', comboKey: 'zzz:prod_gf_cn' },
  ]
  const seqRandLocal = seqRand // 见文件头助手
  const b1 = buildDailyPlan({ dayMs: T_0900, settings: SPREAD, groups: groups6, rand: seqRandLocal([0, 0, 0, 0]) })
  show('P2 计划（4 目标）', b1.plan.items.map((x) => x.comboKey + '@' + new Date(x.at).toTimeString().slice(0, 5)))
  check(b1.plan.items.length === 4, 'P5 targets=4 个主号 ⇒ 组合数 = 4（bh3:pc01 / bh3:android01 被排除）', b1.plan.items.length, 4)
  check(b1.skippedByTarget.slice().sort().join(',') === 'bh3:android01,bh3:pc01', 'P5 被排除的正是两个 1 级崩坏3 副号区服', b1.skippedByTarget.slice().sort().join(','), 'bh3:android01,bh3:pc01')
  check(b1.plan.items.map((x) => x.comboKey).join(',') === 'bh3:bb01,hk4e:cn_gf01,hkrpg:prod_gf_cn,zzz:prod_gf_cn', 'P5 保留组合（顺序＝发现顺序）', b1.plan.items.map((x) => x.comboKey).join(','), '<4 个>')
  // 相邻实际间隔 ∈ [minGap, minGap + max(jitter)]（rand=0 ⇒ 下界；rand→1 ⇒ 上界）
  const gaps = b1.plan.items.slice(1).map((it, i) => it.at - b1.plan.items[i].at)
  show('P2 相邻间隔（rand=0）', gaps.map((g) => g / 60000 + 'min'))
  check(gaps.every((g) => g >= 600000 && g <= 720000), 'P2① 相邻实际间隔 ∈ [600000, 720000]（10–12 分钟）', gaps, '<全在区间内>')
  const b2 = buildDailyPlan({ dayMs: T_0900, settings: SPREAD, groups: groups6, rand: seqRand([0.999999, 0.999999, 0.999999, 0.999999]) })
  const gaps2 = b2.plan.items.slice(1).map((it, i) => it.at - b2.plan.items[i].at)
  show('P2 相邻间隔（rand→1）', gaps2.map((g) => g / 60000 + 'min'))
  check(gaps2.every((g) => g >= 600000 && g <= 720000), 'P2① rand→1 时同样 ∈ [600000, 720000]', gaps2, '<全在区间内>')
  // 补丁②（2026-08-30「开机即签」）**改写**了这条断言：首槽不再是「窗口内任意随机」，
  //   而是 `max(窗口起点, 计划生成时刻) + 小抖动`。本用例 dayMs=T_0900（09:00，晚于窗口起点 08:00）
  //   ⇒ 首槽应落在 [09:00, 09:02]（rand=0 ⇒ 恰好 09:00）。
  check(b1.plan.items[0].at >= T_0900 && b1.plan.items[0].at <= T_0900 + ANCHOR_JITTER_MS, 'P2②(补丁②) 首槽 = max(窗口起点, 计划生成时刻) + 小抖动 ⇒ [09:00, 09:02]', new Date(b1.plan.items[0].at).toTimeString().slice(0, 5), '<09:00–09:02>')
  check(b1.plan.date === TODAY && typeof b1.plan.generatedAt === 'string', 'P3 计划带 date/generatedAt（可审计）', { d: b1.plan.date, g: typeof b1.plan.generatedAt }, { d: TODAY, g: 'string' })
  // P6②：同一 date 两次规划结果一致（注入同一 rand）
  const again = buildDailyPlan({ dayMs: T_0900, settings: SPREAD, groups: groups6, rand: seqRand([0, 0, 0, 0]) })
  check(JSON.stringify(again.plan.items) === JSON.stringify(b1.plan.items), 'P6② 同一 date + 同一 rand ⇒ 结果**一致**（不重掷）', 'ok', '相同')
  // P6③：不同 date 用**固定 rand** 断言结果不同（跨天重抽）
  const nextDay = at(9, 0) + 24 * 3600 * 1000
  const other = buildDailyPlan({ dayMs: nextDay, settings: SPREAD, groups: groups6, rand: seqRand([0, 0, 0, 0]) })
  check(other.plan.date !== b1.plan.date && JSON.stringify(other.plan.items) !== JSON.stringify(b1.plan.items), 'P6③ 跨天（固定 rand）⇒ 计划**不同**（每日重抽）', { d: other.plan.date }, { d: '<次日>' })
  // P5 反向：targets 为空 ⇒ 全部组合（6）
  const bAll = buildDailyPlan({ dayMs: T_0900, settings: SPREAD_ALL, groups: groups6, rand: seqRand([0, 0, 0, 0, 0, 0]) })
  check(bAll.plan.items.length === 6 && bAll.skippedByTarget.length === 0, 'P5 targets 空 ⇒ 全部组合（6）', bAll.plan.items.length, 6)
  // P2/P6⑤：约束不可满足 ⇒ 确定性降级 + 原因（不静默重叠）
  const tiny = Object.assign({}, DEFAULTS, { windowStart: '08:00', windowEnd: '08:30', schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } })
  const bDeg = buildDailyPlan({ dayMs: T_0900, settings: tiny, groups: groups6, rand: seqRand([0.5]) })
  show('P6⑤ 降级', { degraded: bDeg.plan.spreadDegraded, reason: bDeg.plan.spreadDegradedReason, ats: bDeg.plan.items.map((x) => new Date(x.at).toTimeString().slice(0, 5)) })
  check(bDeg.plan.spreadDegraded === true && bDeg.plan.spreadDegradedReason === 'window_span_lt_last_item_plus_gap', 'P6⑤ 窗口过短 ⇒ spreadDegraded:true + 机器可读原因', bDeg.plan.spreadDegradedReason, 'window_span_lt_last_item_plus_gap')
  const degAt = bDeg.plan.items.map((x) => x.at)
  check(degAt.every((v, i) => i === 0 || v >= degAt[i - 1]) && degAt[degAt.length - 1] < new Date(T_0900).setHours(0, 0, 0, 0) + 8 * 3600 * 1000 + 30 * 60000, 'P6⑤ 降级后仍**非降序**且全部落在窗口内（不静默重叠到窗口外）', degAt.map((x) => new Date(x).toTimeString().slice(0, 5)), '<窗口内非降序>')
  check(bDeg.plan.items.length === 6, 'P6⑤ 降级不丢组合（6 个都在计划里）', bDeg.plan.items.length, 6)
  // 跨零点窗口可用
  const cross = buildDailyPlan({ dayMs: T_0900, settings: Object.assign({}, DEFAULTS, { windowStart: '23:00', windowEnd: '02:00', schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } }), groups: groups6, rand: seqRand([0.5]) })
  check(cross.plan.spreadDegraded === false && cross.plan.items.length === 6, 'P2 跨零点窗口仍可排（不误判为过短）', cross.plan.spreadDegraded, false)
}

console.log('== 补丁②「开机即签」：集群起点 = max(窗口起点, 当天首次 tick) + 小抖动（间隔语义不变）==')
{
  const SPREAD_TARGETS = ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn', 'bh3:bb01']
  const SPREAD = Object.assign({}, DEFAULTS, { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: SPREAD_TARGETS } })
  const groups4 = [
    { accountKey: 'acct-***4968', target: 'hk4e', region: 'cn_gf01' },
    { accountKey: 'acct-***4968', target: 'hkrpg', region: 'prod_gf_cn' },
    { accountKey: 'acct-***4968', target: 'zzz', region: 'prod_gf_cn' },
    { accountKey: 'acct-***4968', target: 'bh3', region: 'bb01' },
  ]
  const WIN = { start: '08:00', end: '23:30' }
  const jMin = ANCHOR_JITTER_MS / 60000
  // 三个「开机时刻」：02:00（早于窗口起点）/ 09:30（窗口内）/ 22:40（窗口末段）
  for (const [label, bootMs] of [['02:00', at(2, 0)], ['09:30', at(9, 30)], ['22:40', at(22, 40)]]) {
    const b = buildDailyPlan({ dayMs: bootMs, settings: SPREAD, groups: groups4, rand: seqRand([0, 0, 0, 0, 0, 0]) })
    const ats = b.plan.items.map((x) => x.at)
    const first = ats[0], last = ats[ats.length - 1]
    show('补丁② 开机 ' + label, b.plan.items.map((x) => x.comboKey + '@' + new Date(x.at).toTimeString().slice(0, 5)))
    const span = windowSpanFor(bootMs, WIN.start, WIN.end)
    const anchorFloor = Math.max(span.startMs, bootMs)
    const hm = (v) => new Date(v).toTimeString().slice(0, 5)
    // ① 锚点：首槽 ∈ [max(窗口起点, 开机), +小抖动]（rand=0 ⇒ 恰为下界）
    check(first >= anchorFloor && first <= anchorFloor + ANCHOR_JITTER_MS, '补丁②[' + label + '] 首槽 ∈ [max(窗口起点,开机), +' + jMin + 'min]', hm(first), '<' + hm(anchorFloor) + '–' + hm(anchorFloor + ANCHOR_JITTER_MS) + '>')
    // ② 整簇非降序且末槽仍在窗口内
    check(ats.every((v, i) => i === 0 || v >= ats[i - 1]), '补丁②[' + label + '] 排程非降序', ats, '<非降序>')
    check(last < span.endMs, '补丁②[' + label + '] 末槽仍在窗口内', hm(last), '<窗口内>')
    // ③ **反例证明间隔语义未被改动**：相邻间隔恒 ∈ [600000, 720000]（10–12 分钟）
    const gaps = ats.slice(1).map((v, i) => v - ats[i])
    check(gaps.every((g) => g >= 600000 && g <= 720000), '补丁②[' + label + '] 相邻间隔仍 ∈ [600000,720000]（10–12 分钟，未被改动）', gaps.map((g) => g / 60000), '<每项 10–12>')
    // ④ 整簇自**锚点**起算 30–38 分钟内跑完（开机早于窗口起点时锚点＝窗口起点 ⇒ 不能从 bootMs 起算）
    const finishMin = (last - anchorFloor) / 60000
    check(finishMin >= 30 && finishMin <= 38, '补丁②[' + label + '] 自锚点起 30–38 分钟内跑完 4 条', Math.round(finishMin * 100) / 100, '<30–38>')
  }
  // ⑤ 开机早于窗口起点 ⇒ 锚点回落窗口起点（旧语义的退化分支）
  const early = buildDailyPlan({ dayMs: at(2, 0), settings: SPREAD, groups: groups4, rand: seqRand([0.5]) })
  const wEarly = windowSpanFor(at(2, 0), WIN.start, WIN.end)
  check(early.plan.items[0].at >= wEarly.startMs && early.plan.items[0].at <= wEarly.startMs + ANCHOR_JITTER_MS, '补丁② 开机早于窗口起点 ⇒ 锚点回落窗口起点 08:00（+小抖动）', new Date(early.plan.items[0].at).toTimeString().slice(0, 5), '<08:00–08:02>')
  // ⑥ 末段开机 ⇒ 锚点向 lastFeasible 收敛（不留窗口外）
  const late = buildDailyPlan({ dayMs: at(23, 20), settings: SPREAD, groups: groups4, rand: seqRand([0.5]) })
  const wLate = windowSpanFor(at(23, 20), WIN.start, WIN.end)
  const lastFeasL = wLate.endMs - 3 * 600000
  check(late.plan.items[0].at <= lastFeasL, '补丁② 末段开机 ⇒ 锚点收敛到 lastFeasible（不越窗口末）', new Date(late.plan.items[0].at).toTimeString().slice(0, 5), '<≤' + new Date(lastFeasL).toTimeString().slice(0, 5) + '>')
  // ⑦ 门控复核：补丁② 后首槽 = 锚点 + 小抖动 ⇒ "**窗口内、首槽之前**"这一区间**首次真正存在**
  //   （旧代码首槽＝窗口起点，该区间为空）⇒ 正好用来证明 `spread_wait` 间隔门仍在生效、没有退化成一次性全签。
  const jitPlan = buildDailyPlan({ dayMs: T_0900, settings: SPREAD, groups: groups4, rand: seqRand([1]) })
  const firstJit = jitPlan.plan.items[0].at
  check(firstJit === T_0900 + ANCHOR_JITTER_MS, '补丁② rand→1 ⇒ 首槽 = 生成时刻 + 小抖动上界（09:02）', new Date(firstJit).toTimeString().slice(0, 5), '<09:02>')
  const gw = applySpreadToDecision({ decision: 'run', comboKey: 'hk4e:cn_gf01' }, firstJit, firstJit - 30000)
  check(gw && gw.decision === 'spread_wait' && gw.nextRetryAt === firstJit, '补丁② 窗口内、首槽前 30s ⇒ spread_wait（间隔门仍未失效）', gw && gw.decision, 'spread_wait')
  check(applySpreadToDecision({ decision: 'run', comboKey: 'hk4e:cn_gf01' }, firstJit, firstJit) === null, '补丁② 到点 ⇒ 交回原决策（不再被 spread 拦）', applySpreadToDecision({ decision: 'run' }, firstJit, firstJit), 'null')
}

console.log('== t39/P3 计划持久化（同日复用 / 跨天重生成 / 集合变更重生成）==')
{
  const SPREAD = Object.assign({}, DEFAULTS, { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } })
  const groups = [{ accountKey: 'A', target: 'hk4e', region: 'cn_gf01' }, { accountKey: 'A', target: 'zzz', region: 'prod_gf_cn' }]
  const r1 = seqRand([0, 0])
  const first = ensureDailyPlan({ dayMs: T_0900, settings: SPREAD, groups, rand: r1, state: {} })
  check(first.reused === false && first.plan.items.length === 2, 'P3 无计划 ⇒ 生成（reused:false）', { r: first.reused, n: first.plan.items.length }, { r: false, n: 2 })
  const state = { dailyPlan: first.plan }
  const again = ensureDailyPlan({ dayMs: T_0900, settings: SPREAD, groups, rand: seqRand([0.9, 0.9]), state })
  check(again.reused === true && JSON.stringify(again.plan.items) === JSON.stringify(first.plan.items), 'P3 同日 + 同集合 ⇒ **复用**（即使 rand 变了也不重掷）', { r: again.reused }, { r: true })
  const nextDayMs = T_0900 + 24 * 3600 * 1000
  const nextDay = ensureDailyPlan({ dayMs: nextDayMs, settings: SPREAD, groups, rand: seqRand([0, 0]), state })
  check(nextDay.reused === false && nextDay.plan.date !== first.plan.date, 'P3 跨天 ⇒ **重新生成**（日期变更检测）', { r: nextDay.reused, d: nextDay.plan.date }, { r: false, d: '<次日>' })
  const changed = ensureDailyPlan({ dayMs: T_0900, settings: SPREAD, groups: groups.concat([{ accountKey: 'A', target: 'bbs', region: '' }]), rand: seqRand([0, 0, 0]), state })
  check(changed.reused === false && changed.plan.items.length === 3, 'P3 组合集合变化（发现到新角色）⇒ 重新生成', changed.plan.items.length, 3)
  const changedGap = ensureDailyPlan({ dayMs: T_0900, settings: Object.assign({}, SPREAD, { schedule: { spreadMinGapMs: 300000, spreadJitterMs: [30000, 120000], targets: [] } }), groups, rand: seqRand([0, 0]), state })
  check(changedGap.reused === false && changedGap.plan.spreadMinGapMs === 300000, 'P3 分散设置变更 ⇒ 重新生成（不沿用旧间隔）', changedGap.plan.spreadMinGapMs, 300000)
  check(dailyPlanOf({}) === null && dailyPlanOf({ dailyPlan: { date: 'x' } }) === null, 'P3 state.dailyPlan 形状非法 ⇒ null（不猜）', 'ok', 'null')
}

console.log('== planCompensate（§5.3：补偿 ≠ 无条件补签）==')
{
  const groups = [{ accountKey: 'A', target: 'hk4e' }, { accountKey: 'A', target: 'zzz' }]
  const inWin = planCompensate({ now: T_0900, settings: DEFAULTS, state: {}, groups, enabled: true })
  show('补偿（窗口内、无记录）', { due: inWin.dueKeys.length, ran: inWin.ranKeys.length, skipped: inWin.skippedKeys.length })
  check(inWin.dueKeys.length === 2 && inWin.ranKeys.length === 2 && inWin.ranKeys.every((x) => x.late === false), '窗口内无记录 ⇒ 立即跑（late:false）', inWin.ranKeys, '<2 且 late:false>')
  const past = planCompensate({ now: T_2331, settings: DEFAULTS, state: {}, groups, enabled: true })
  show('补偿（已过窗口、无记录）', { ran: past.ranKeys.length, skipped: past.skippedKeys.map((x) => x.reason) })
  check(past.ranKeys.length === 0 && past.skippedKeys.every((x) => x.reason === 'skipped_window'), '过窗口 ⇒ 一律 skipped_window（**不偷偷补签**）', past.skippedKeys.map((x) => x.reason), ['skipped_window', 'skipped_window'])
  const pastAllow = planCompensate({ now: T_2331, settings: Object.assign({}, DEFAULTS, { allowLateSign: true }), state: {}, groups, enabled: true })
  check(pastAllow.ranKeys.length === 2 && pastAllow.ranKeys.every((x) => x.late === true), 'allowLateSign ⇒ 补一次并标 late:true', pastAllow.ranKeys.map((x) => x.late), [true, true])
  const st2 = { doneKeys: { [dedupeKey('A', 'hk4e', TODAY)]: { status: 'signed' }, [dedupeKey('A', 'zzz', TODAY)]: { status: 'pending', attempts: 1 } } }
  const mix = planCompensate({ now: T_0900, settings: DEFAULTS, state: st2, groups, enabled: true })
  check(mix.skippedKeys.some((x) => x.reason === 'terminal') && mix.skippedKeys.some((x) => x.reason === 'in_flight'), '终态 / 进行中 分别跳过', mix.skippedKeys.map((x) => x.reason), '<terminal+in_flight>')
}

console.log('== applyResult / 锁（§5.4 + §5.5）==')
{
  const s0 = { doneKeys: {}, lastSignSuccess: {} }
  const s1 = applyResult(s0, { dedupeKey: 'A:hk4e:' + TODAY, accountKey: 'A', target: 'hk4e', outcome: 'failed', retcode: -100, now: T_0900, maxAttemptsPerDay: 3 })
  show('failed 后', s1.doneKeys['A:hk4e:' + TODAY])
  check(s1.doneKeys['A:hk4e:' + TODAY].attempts === 1 && s1.doneKeys['A:hk4e:' + TODAY].nextRetryAt === T_0900 + 300000, '失败 ⇒ attempts+1 且 nextRetryAt=now+backoff(1)', s1.doneKeys['A:hk4e:' + TODAY].nextRetryAt, T_0900 + 300000)
  check(s0.doneKeys['A:hk4e:' + TODAY] === undefined, '纯函数：入参未被改动', 'ok', 'undefined')
  const s2 = applyResult(s1, { dedupeKey: 'A:hk4e:' + TODAY, accountKey: 'A', target: 'hk4e', outcome: 'signed', retcode: 0, now: T_0900 + 600000, saltFingerprint: 'abcd1234', appVersion: '2.109.0', maxAttemptsPerDay: 3 })
  check(s2.doneKeys['A:hk4e:' + TODAY].status === 'signed' && s2.doneKeys['A:hk4e:' + TODAY].nextRetryAt === null, '成功 ⇒ 终态、无下次重试', s2.doneKeys['A:hk4e:' + TODAY].nextRetryAt, null)
  check(s2.lastSignSuccess.A.hk4e.saltFingerprint === 'abcd1234' && s2.lastSignSuccess.A.hk4e.outcome === 'success', '成功写 lastSignSuccess（含指纹/版本＝门禁 G2③ 的同源依据）', s2.lastSignSuccess.A.hk4e, '<含指纹>')
  const s3 = applyResult(s1, { dedupeKey: 'A:hk4e:' + TODAY, accountKey: 'A', target: 'hk4e', outcome: 'failed', now: T_0900 + 1000, maxAttemptsPerDay: 1 })
  check(s3.doneKeys['A:hk4e:' + TODAY].nextRetryAt === null, '已达 maxAttempts ⇒ 不再排下次（有限重试）', s3.doneKeys['A:hk4e:' + TODAY].nextRetryAt, null)
  check(isTerminal({ status: 'human_required' }) === true && isTerminal({ status: 'pending' }) === false, 'isTerminal', 'ok', 'true/false')
  check(lockDecision({}, T_0900).canRun === true, '无锁 ⇒ 可跑', 'ok', 'true')
  check(lockDecision({ lock: { owner: 'x', startedAt: T_0900, ttlMs: LOCK_TTL_MS } }, T_0900 + 1000).canRun === false, '新鲜锁 ⇒ 拒绝', 'ok', 'false')
  const takeover = lockDecision({ lock: { owner: 'x', startedAt: T_0900, ttlMs: LOCK_TTL_MS } }, T_0900 + LOCK_TTL_MS + 1)
  check(takeover.canRun === true && takeover.takeover === true && takeover.reason === 'lock_expired', '锁过期 ⇒ 自动接管（宿主重启不卡死）', takeover.reason, 'lock_expired')
}

// ---------------------------------------------------------------------------
// createScheduler：与 store（adapterFs）接线；dryRun 纯预览；单飞；零网络
// ---------------------------------------------------------------------------
console.log('== createScheduler：接 memory adapterFs + 注入时钟 + 注入 execute（零真实网络）==')
const DATA_ROOT = 'E:/DSH工作区/全局数据'
const DIR = DATA_ROOT + '/miyoushe'
class MemFs {
  constructor(o) {
    const x = o || {}
    this.roots = { 全局数据: DATA_ROOT }
    this.dirs = new Set([DIR, DIR + '/logs'])
    this.files = new Map(x.files || [[DIR + '/logs/.keep', '']])
    this.calls = []
  }
  _p(root, rel) { const b = this.roots[root]; if (b === undefined) { const e = new Error('unknown root'); e.code = 'ROOT_UNKNOWN'; throw e } return rel ? b + '/' + rel : b }
  _rec(op, rel) { this.calls.push(op + ' ' + rel) }
  count(op, rel) { return this.calls.filter((c) => c.startsWith(op + ' ') && (!rel || c.endsWith(rel))).length }
  async exists(root, rel) { const p = this._p(root, rel); this._rec('exists', rel); return this.dirs.has(p) || this.files.has(p) }
  async readText(root, rel) { const p = this._p(root, rel); this._rec('readText', rel); if (!this.files.has(p)) { const e = new Error('nf'); e.code = 'FS_NOT_FOUND'; throw e } return this.files.get(p) }
  async readJson(root, rel) { const t = await this.readText(root, rel); this._rec('readJson', rel); try { return JSON.parse(t) } catch (e) { const err = new Error('bad'); err.code = 'EBADJSON'; throw err } }
  async writeText(root, rel, text) { const p = this._p(root, rel); this._rec('writeText', rel); this.files.set(p, text); return { ok: true } }
  async writeJson(root, rel, data) { const p = this._p(root, rel); this._rec('writeJson', rel); this.files.set(p, JSON.stringify(data, null, 2)); return { ok: true } }
  async listDir(root, rel) { this._rec('listDir', rel); return [] }
  async resolve(root, rel) { const p = this._p(root, rel); return { targetKey: p, displayPath: p } }
}

const realFetch = globalThis.fetch
let guardCalls = 0
try {
  globalThis.fetch = () => { guardCalls++; throw new Error('REAL_NETWORK_ATTEMPT_BLOCKED') }
  const { createCore, createActions, migrateLegacyDoneKeys: migrateLegacyEntry, selectGroupsForAction, gateShape } = await import('../lib/index.js')
  const accounts = [
    { accountKey: 'acct-***1234', uid: '123456789', roles: [{ gameKey: 'hk4e' }, { gameKey: 'zzz' }] },
  ]
  const fs = new MemFs({
    files: [
      [DIR + '/logs/.keep', ''],
      [DIR + '/settings.json', JSON.stringify(Object.assign({}, DEFAULTS, { accountGapMs: [1, 1] }))],
      [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: true, mode: 'auto' }, doneKeys: {}, lastSignSuccess: {}, lock: null })],
      [DIR + '/accounts.json', JSON.stringify({ accounts })],
      [DIR + '/salts.json', JSON.stringify({ version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { salt: SALT, status: 'verified', clientType: '5' } }, versionCache: null })],
    ],
  })
  const calls = []
  const core = createCore({ adapterFs: fs, now: () => T_0900 })
  const s = createScheduler({ store: core.store, clock: () => T_0900, execute: async (t) => { calls.push(t); return { outcome: 'signed', retcode: 0, saltFingerprint: 'fp-1234', appVersion: '2.109.0' } } })

  const sch = await s.schedule({ now: T_0900 })
  show('schedule()', { ok: sch.ok, enabled: sch.enabled, nextAt: sch.nextAt, targets: sch.nextTargets.length, groups: sch.groups.length })
  check(sch.ok === true && sch.enabled === true && typeof sch.nextAt === 'string', 'schedule() 正常（含 nextAt/nextTargets）', sch.nextAt, '<ISO>')
  check(sch.groups.length === 3, '组合清单＝2 游戏 + bbs', sch.groups.length, 3)

  const dry = await s.tick({ now: T_0900, dryRun: true })
  show('tick(dryRun)', { ran: dry.ran.length, outcomes: dry.ran.map((x) => x.outcome), writes: fs.count('writeJson'), executeCalls: calls.length })
  check(dry.ok === true && dry.dryRun === true && dry.ran.every((x) => x.outcome === 'would_run'), 'dryRun ⇒ 全部 would_run（不提交）', dry.ran.map((x) => x.outcome), '<would_run>')
  check(calls.length === 0, 'dryRun 不调用 execute（零提交）', calls.length, 0)
  check(fs.count('writeJson') === 0, 'dryRun **不写盘**（纯预览）', fs.count('writeJson'), 0)

  const real = await s.tick({ now: T_0900 })
  show('tick(real)', { ran: real.ran.length, calls: calls.length, writes: fs.count('writeJson') })
  check(real.ran.length === 3 && calls.length === 3, '真跑 ⇒ 对每个组合调用注入的 execute（3 次）', calls.length, 3)
  check(fs.count('writeJson') === 2, '真跑写盘：锁 + 结果回写（各一次 writeJson）', fs.count('writeJson'), 2)
  const stAfter = JSON.parse(fs.files.get(DIR + '/state.json'))
  check(Object.keys(stAfter.doneKeys).length === 3 && stAfter.lock === null, 'state 落盘：3 个 doneKey + 清锁', { n: Object.keys(stAfter.doneKeys).length, lock: stAfter.lock }, { n: 3, lock: null })
  check(stAfter.lastSignSuccess['acct-***1234'] && stAfter.lastSignSuccess['acct-***1234'].hk4e.saltFingerprint === 'fp-1234', 'lastSignSuccess 落盘（含盐指纹＝门禁 G2③ 依据）', stAfter.lastSignSuccess['acct-***1234'].hk4e.saltFingerprint, 'fp-1234')

  const second = await s.tick({ now: T_0900 })
  check(second.ran.length === 0, '第二次 tick：全部已终态 ⇒ 不再提交（去重键）', second.ran.length, 0)

  // 单飞：并发第二次 tick 必须被拒（用**全新 state**（空 doneKeys）才能让 p1 真正进入 execute 并停住）
  const fs2 = new MemFs({
    files: [
      [DIR + '/logs/.keep', ''],
      [DIR + '/settings.json', fs.files.get(DIR + '/settings.json')],
      [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: true, mode: 'auto' }, doneKeys: {}, lastSignSuccess: {}, lock: null })],
      [DIR + '/accounts.json', fs.files.get(DIR + '/accounts.json')],
      [DIR + '/salts.json', fs.files.get(DIR + '/salts.json')],
    ],
  })
  const core2 = createCore({ adapterFs: fs2, now: () => T_0900 })
  let gate = null
  const s2 = createScheduler({
    store: core2.store, clock: () => T_0900,
    execute: async () => { gate = true; await new Promise((r) => setTimeout(r, 20)); return { outcome: 'signed', retcode: 0 } },
  })
  const p1 = s2.tick({ now: T_0900 })
  await new Promise((r) => setTimeout(r, 5)) // 让 p1 完成微任务并进入 execute（此时 running=true）
  const p2 = await s2.tick({ now: T_0900 })
  show('并发第二 tick', p2)
  check(p2.skipped === true && p2.reason === 'running_in_process', '单飞：进程内重入被拒（running_in_process）', p2.reason, 'running_in_process')
  check(gate === true, 'p1 确实已进入 execute（并发的第二次 tick 才有意义）', gate, true)
  const done1 = await p1
  check(done1.ok === true && done1.ran.length === 3, 'p1 正常完成（3 个组合）', done1.ran.length, 3)

  const comp = await s.compensate({ now: T_0900 })
  show('compensate()', { due: comp.dueKeys.length, ran: comp.ranKeys.length, skipped: comp.skippedKeys.length, summary: comp.summary })
  check(comp.ok === true && typeof comp.summary === 'string' && comp.summary.includes('今日补偿'), 'compensate 返回可读汇总', comp.summary, '<今日补偿：n 已处理 / m 跳过>')

  // -------------------------------------------------------------------------
  // t39/P4：分散时刻 —— tick **只处理已到时刻**的组合（不再一次性全签）+ 计划落 state
  // -------------------------------------------------------------------------
  // ⚠️ 补丁②（2026-08-30「开机即签」）后，集群锚点 = `max(窗口起点, 计划生成时刻) + 小抖动`：
  //   `tick()` 会先 `ensureDailyPlanSafe` 再落盘，而"计划时刻"**不再与生成时刻无关** ⇒ 本块"计划时刻
  //   对 tick 时刻不变"的前提需要夹具配合，故做两处**正交**调整（都不触及本块的主题＝分散门）：
  //     ① `windowStart: '09:00'`（＝本夹具时钟 T_0900）⇒ `anchorBase = max(09:00, now)`：
  //        now=09:00 时 = 09:00（与补丁前"首槽=窗口起点=09:00"逐字一致）；now=08:59 时仍 = 09:00
  //        ⇒ "提前 1 分钟 tick" 不会再被重新锚成"当场到点"；
  //     ② `dailyJitterMs: 0` ⇒ 关掉与窗口起点绑定的**旧 per-key 抖动**。补丁前该抖动（≤15 分钟）
  //        因 now(09:00) 已比 08:00 晚一小时而**自然失效**；现在窗口起点抬到 09:00，必须显式归零才能复现
  //        "抖动已失效"的同一条件（且 `planTick` 对**有计划时刻**的组合本就强制 `dailyJitterMs: 0`）。
  const SPREAD_SETTINGS = JSON.stringify(Object.assign({}, DEFAULTS, {
    accountGapMs: [1, 1],
    dailyJitterMs: 0,
    windowStart: '09:00',
    schedule: { enabled: true, mode: 'auto', spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] },
  }))
  const spreadAccounts = [
    { accountKey: 'acct-***1234', uid: '123456789', roles: [{ gameKey: 'hk4e', region: 'cn_gf01' }, { gameKey: 'zzz', region: 'prod_gf_cn' }, { gameKey: 'bh3', region: 'bb01' }] },
  ]
  const fs3 = new MemFs({
    files: [
      [DIR + '/logs/.keep', ''],
      [DIR + '/settings.json', SPREAD_SETTINGS],
      [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: true, mode: 'auto' }, doneKeys: {}, lastSignSuccess: {}, lock: null })],
      [DIR + '/accounts.json', JSON.stringify({ accounts: spreadAccounts })],
      [DIR + '/salts.json', fs.files.get(DIR + '/salts.json')],
    ],
  })
  const exec3 = []
  const s3 = createScheduler({
    store: createCore({ adapterFs: fs3, now: () => T_0900 }).store,
    clock: () => T_0900, rand: () => 0,
    execute: async (t) => { exec3.push(t); return { outcome: 'signed', retcode: 0 } },
  })
  const sch3 = await s3.schedule({ now: T_0900 })
  show('P3 schedule() 计划', { n: sch3.dailyPlan.items.length, ats: sch3.dailyPlan.items.map((x) => new Date(x.at).toTimeString().slice(0, 5)), spread: sch3.spread })
  check(sch3.ok === true && sch3.groups.length === 4, 'P4 组合清单 = 3 游戏（含 bh3 区服）+ bbs = 4', sch3.groups.length, 4)
  check(sch3.dailyPlan && sch3.dailyPlan.items.length === 4 && sch3.spread.enabled === true, 'P3/P4 schedule() 暴露当日计划且标注 spread.enabled', { n: sch3.dailyPlan.items.length, e: sch3.spread.enabled }, { n: 4, e: true })
  const sch3b = await s3.schedule({ now: T_0900 })
  check(JSON.stringify(sch3b.dailyPlan.items) === JSON.stringify(sch3.dailyPlan.items), 'P3 读侧两次调用 ⇒ 计划一致（同 rand 可复现）', 'ok', '相同')

  // 计划已落 state（tick 后）⇒ 即使换一个**不同**的 rand 实例（模拟重启后重新加载），计划也**不重掷**
  const restartRand = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
  let restartI = 0
  const s3r = createScheduler({
    store: createCore({ adapterFs: fs3, now: () => T_0900 }).store,
    clock: () => T_0900, rand: () => restartRand[restartI++ % restartRand.length],
    execute: async () => ({ outcome: 'signed', retcode: 0 }),
  })

  const t0 = sch3.dailyPlan.items[0].at
  const dry3 = await s3.tick({ now: T_0900, dryRun: true })
  check(dry3.dryRun === true && dry3.ran.length === 4, 'P4 dryRun 是**纯预览**：给出全天 4 条（不套分散门）且零提交', { n: dry3.ran.length, calls: exec3.length }, { n: 4, calls: 0 })

  const tick0 = await s3.tick({ now: t0 - 60000 })
  check(tick0.ran.length === 0, 'P4 计划时刻**前** 1 分钟 tick ⇒ 0 提交（不再一次性全签）', tick0.ran.length, 0)
  const st0 = JSON.parse(fs3.files.get(DIR + '/state.json'))
  check(st0.dailyPlan && st0.dailyPlan.date === TODAY && st0.dailyPlan.items.length === 4, 'P3 当日计划已落 state（4 条，含 date）', { d: st0.dailyPlan && st0.dailyPlan.date, n: st0.dailyPlan && st0.dailyPlan.items.length }, { d: TODAY, n: 4 })
  check(st0.dailyPlan.items.map((x) => x.comboKey).join(',') === 'hk4e:cn_gf01,zzz:prod_gf_cn,bh3:bb01,bbs', 'P3 计划按组合键落盘（gameKey:region；bbs 无区服）', st0.dailyPlan.items.map((x) => x.comboKey).join(','), '<4 个组合键>')
  // P3：计划落盘后，**同日重启**（换一个完全不同的 rand 实例）也不重掷、不漂移
  const sch3r = await s3r.schedule({ now: T_0900 })
  check(sch3r.spread.reused === true && JSON.stringify(sch3r.dailyPlan.items) === JSON.stringify(st0.dailyPlan.items), 'P3 计划已落 state ⇒ 同日**重启**（不同 rand）也复用同一张表', { reused: sch3r.spread.reused, same: JSON.stringify(sch3r.dailyPlan.items) === JSON.stringify(st0.dailyPlan.items) }, { reused: true, same: true })

  const tick1 = await s3.tick({ now: t0 })
  show('P4 tick@第1条时刻', { ran: tick1.ran.map((x) => x.comboKey + ':' + x.outcome), calls: exec3.length })
  check(tick1.ran.length === 1 && exec3.length === 1, 'P4 到点 ⇒ **只**提交第 1 条（1 次 execute）', { n: tick1.ran.length, calls: exec3.length }, { n: 1, calls: 1 })
  check(tick1.ran[0].comboKey === 'hk4e:cn_gf01' && tick1.ran[0].dedupeKey === 'acct-***1234:hk4e:' + TODAY + ':cn_gf01', 'P10 提交项的 key 带 region（region 感知）', tick1.ran[0].dedupeKey, '<4 段>')
  const tick2 = await s3.tick({ now: t0 + 30000 })
  check(tick2.ran.length === 0, 'P4 到点后 30s（下一组合未到）⇒ 仍 0 提交', tick2.ran.length, 0)
  const t3 = sch3.dailyPlan.items[3].at
  const tick4 = await s3.tick({ now: t3 })
  show('P4 tick@第4条时刻', { ran: tick4.ran.map((x) => x.comboKey) })
  check(tick4.ran.length === 3 && exec3.length === 4, 'P4 到最后一条时刻 ⇒ 补齐剩余 3 条（共 4 次 execute，一天分 4 次发）', { ran: tick4.ran.length, calls: exec3.length }, { ran: 3, calls: 4 })
  const gapsReal = sch3.dailyPlan.items.slice(1).map((it, i) => it.at - sch3.dailyPlan.items[i].at)
  check(gapsReal.every((g) => g >= 600000 && g <= 720000), 'P2 实际计划相邻间隔 ∈ [10,12] 分钟（真跑用的就是这张表）', gapsReal.map((g) => g / 60000), '<全在区间>')

  const sch3c = await s3.schedule({ now: t0 })
  check(typeof sch3c.nextAt === 'string' && Date.parse(sch3c.nextAt) > t0, 'P4 nextAt 反映**下一个**组合时刻（已过的不再算）', sch3c.nextAt, '<>' + new Date(t0).toISOString())

  check(guardCalls === 0, '**零真实网络**：全局 fetch 哨兵调用数=0（调度器不发起任何请求）', guardCalls, 0)

  // -------------------------------------------------------------------------
  // t39/P1（读侧）：`settings.schedule` 三项的**读侧语义与非法值防御**
  // -------------------------------------------------------------------------
  // ⚠️ 边界登记：`miyoushe_config` 的**写入侧形状校验/缺省补齐**落在 `lib/index.js`（config action）。
  //   按本任务 P7，`lib/index.js` 被**冻结**在 t38 基线指纹 (`20B2B3EBD4099C92`) ⇒ 我**不能**在那里加
  //   校验/补齐逻辑。因此本套件只在**调度器读侧**断言：合法值被正确解析、非法/缺省值**不启用分散**（安全方向）。
  //   写入侧校验的缺口已在证据文件 §11 登记，等 captain 裁决（解冻 index.js 或接受该缺口）。
  {
    const legal = { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: ['hk4e:cn_gf01'] } }
    check(spreadMinGapOf(legal) === 600000 && JSON.stringify(spreadJitterOf(legal)) === '[30000,120000]' && spreadEnabledOf(legal) === true, 'P1 读侧：合法三项 ⇒ 正确解析且启用分散', [spreadMinGapOf(legal), spreadJitterOf(legal), spreadEnabledOf(legal)], [600000, [30000, 120000], true])
    const bad = [
      { schedule: { spreadMinGapMs: -1 } },
      { schedule: { spreadMinGapMs: 1.5 } },
      { schedule: { spreadJitterMs: [120000, 30000] } },
      { schedule: { spreadJitterMs: 30000 } },
      { schedule: { spreadJitterMs: [1] } },
      { schedule: { spreadMinGapMs: 'x', spreadJitterMs: 'y' } },
    ]
    const outs = bad.map((s) => ({ g: spreadMinGapOf(s), j: spreadJitterOf(s), on: spreadEnabledOf(s) }))
    show('P1 读侧非法/畸形 => ' + JSON.stringify(outs))
    check(outs.every((o) => o.on === false), 'P1 读侧：非法/畸形值 ⇒ **一律不启用分散**（安全方向：绝不放大请求）', outs.map((o) => o.on), '<全 false>')
    check(outs[1].g === 0 && outs[0].g === 0, 'P1 读侧：负值/小数 ⇒ 归零（不产生负间隔或小数间隔）', [outs[0].g, outs[1].g], [0, 0])
    check(JSON.stringify(outs[2].j) === '[0,0]' && JSON.stringify(outs[3].j) === '[0,0]', 'P1 读侧：区间颠倒/非数组 ⇒ 抖动归零', [outs[2].j, outs[3].j], [[0, 0], [0, 0]])
    const offExplicit = { schedule: { spreadMinGapMs: 0, spreadJitterMs: [0, 0], targets: [] } }
    check(spreadEnabledOf(offExplicit) === false, 'P1 显式关掉分散（0 / [0,0]）⇒ 关闭（与"未配置"同效，方向一致）', spreadEnabledOf(offExplicit), false)
    const tgtBad = ['HK4E:CN', '', 123]
    check(tgtBad.every((t) => targetSelected(['hk4e'], t) === false), 'P1 读侧：非法 target 字面量（大写/空/非串）⇒ 匹配不到任何组合（fail-closed，不会误放开）', tgtBad.map((t) => targetSelected(['hk4e'], t)), [false, false, false])
  }
  // ---------------------------------------------------------------------------
  // t50：N1 legacy 去重键代码级迁移 + N2 计划来源标注 + O1/O2 组合选择器
  // ---------------------------------------------------------------------------
  console.log('\n== t50/N1 legacy 3 段键代码级迁移（G3 doneKeys_conflict 的结构性解法）==')
  {
    // 现场形状：hk4e 的 legacy 3 段失败键 + 同组合的 4 段成功键并存
    const live = {
      'acct-***4968:hk4e:2026-09-20': { status: 'failed', retcode: -400005, attempts: 1 },
      'acct-***4968:hk4e:2026-09-20:cn_gf01': { status: 'signed', retcode: 0, attempts: 2 },
      'acct-***4968:hkrpg:2026-09-20:prod_gf_cn': { status: 'signed', retcode: 0 },
      'acct-***4968:bbs:2026-09-20': { status: 'signed', retcode: 0 },
    }
    // 负侧①：迁移**前**，真实门禁判据确实报冲突（证明确有该缺口）
    const before = findConflictingDoneKey(live, 'acct-***4968', 'hk4e')
    show('迁移前 findConflictingDoneKey(hk4e)', before && { key: before.key, status: before.status })
    check(before && before.key === 'acct-***4968:hk4e:2026-09-20', 'N1 负侧①：迁移前门禁对 hk4e 报 doneKeys_conflict（缺口可复现）', before && before.key, 'acct-***4968:hk4e:2026-09-20')

    const m = migrateLegacyDoneKeys(live)
    show('migrateLegacyDoneKeys => ', { removed: m.removed, kept: m.kept })
    // 正侧①：legacy 键被移除，且**成功记录不丢**（4 段成功键仍在）
    check(m.changed === true && m.removed.length === 1 && m.removed[0].key === 'acct-***4968:hk4e:2026-09-20', 'N1 正侧①：同前缀存在 4 段成功键 ⇒ legacy 3 段键被移除', m.removed.map((r) => r.key), ['acct-***4968:hk4e:2026-09-20'])
    check(m.removed[0].supersededBy === 'acct-***4968:hk4e:2026-09-20:cn_gf01' && m.removed[0].status === 'failed', 'N1 正侧①：移除项**如实记录**被谁取代 + 原状态（可审计，不静默丢弃）', m.removed[0], '<supersededBy/status>')
    check(!!(m.doneKeys['acct-***4968:hk4e:2026-09-20:cn_gf01'] && m.doneKeys['acct-***4968:hk4e:2026-09-20:cn_gf01'].status === 'signed'), 'N1 正侧①：**成功记录不丢**（4 段 signed 键保留）', m.doneKeys['acct-***4968:hk4e:2026-09-20:cn_gf01'], '<signed>')
    // 正侧②：迁移**后**门禁真实判据不再报冲突
    const after = findConflictingDoneKey(m.doneKeys, 'acct-***4968', 'hk4e')
    check(after === null, 'N1 正侧②：迁移后 `findConflictingDoneKey(hk4e) === null` ⇒ **G3 不再报 doneKeys_conflict**', after, null)
    // 正侧③：不动无关键
    check(Object.keys(m.doneKeys).length === 3, 'N1 正侧③：其余键一条不少（4→3 只少了那一条 legacy）', Object.keys(m.doneKeys).length, 3)

    // 负侧②：**只有 legacy 键** ⇒ 原样保留（不误删、不误判；lookupDoneEntry 仍可回退读到）
    const legacyOnly = { 'acct-***4968:hk4e:2026-09-19': { status: 'human_required' } }
    const m2 = migrateLegacyDoneKeys(legacyOnly)
    check(m2.changed === false && m2.doneKeys['acct-***4968:hk4e:2026-09-19'] && lookupDoneEntry(m2.doneKeys, 'acct-***4968', 'hk4e', '2026-09-19').entry !== null, 'N1 负侧②：只有 legacy 键 ⇒ **保留**且仍可被 `lookupDoneEntry` 读到', { changed: m2.changed, hit: lookupDoneEntry(m2.doneKeys, 'acct-***4968', 'hk4e', '2026-09-19').entry !== null }, { changed: false, hit: true })
    // 负侧③：`bbs` 的**规范键本来就是 3 段** ⇒ 永不误删（哪怕当天已有同前缀 4 段键）
    const bbs = { 'acct-***4968:bbs:2026-09-20': { status: 'failed' }, 'acct-***4968:bbs:2026-09-20:x': { status: 'signed' } }
    const m3 = migrateLegacyDoneKeys(bbs)
    check(m3.changed === false && !!m3.doneKeys['acct-***4968:bbs:2026-09-20'], 'N1 负侧③：`bbs` 无区服 ⇒ 规范键即 3 段，**绝不当作 legacy 删除**', m3.removed.map((r) => r.key), [])
    // 负侧④：4 段键状态非成功（failed/human_required）⇒ **不**触发移除（不许用失败键"取代"legacy）
    const nonSuccess = { 'acct-***4968:zzz:2026-09-20': { status: 'human_required' }, 'acct-***4968:zzz:2026-09-20:prod_gf_cn': { status: 'failed' } }
    const m4 = migrateLegacyDoneKeys(nonSuccess)
    check(m4.changed === false && !!m4.doneKeys['acct-***4968:zzz:2026-09-20'], 'N1 负侧④：4 段键非 signed/already ⇒ 不移除 legacy（`supersedeStatuses` 只认成功）', m4.removed.map((r) => r.key), [])
    // 负侧⑤：畸形键（段数<3）原样保留；空/非对象输入不炸
    const m5 = migrateLegacyDoneKeys({ 'bad-key': { status: 'signed' } })
    check(m5.changed === false && !!m5.doneKeys['bad-key'] && migrateLegacyDoneKeys(null).changed === false && migrateLegacyDoneKeys([]).changed === false, 'N1 负侧⑤：畸形键/空输入/数组输入 ⇒ 原样保留或不炸（不猜）', [m5.changed, migrateLegacyDoneKeys(null).changed], [false, false])

    // 交叉断言：入口镜像（index.js）与 scheduler.js 的实现在多组输入上**逐字一致**（防漂移；E17 加载顺序纪律要求两份）
    const cases = [live, legacyOnly, bbs, nonSuccess, { 'bad-key': 1 }, null, {}, { 'a:b:2026-09-20': { status: 'failed' }, 'a:b:2026-09-20:r': { status: 'already' } }]
    const same = cases.every((c) => JSON.stringify(migrateLegacyDoneKeys(c)) === JSON.stringify(migrateLegacyEntry(c)))
    check(same, 'N1 交叉断言：`index.js` 镜像与 `scheduler.js` 的 `migrateLegacyDoneKeys` 在 8 组输入上**逐字一致**', same, true)
  }

  console.log('\n== t50/N2 计划来源标注（读侧 vs 权威计划）+ O1/O2 组合选择器 ==')
  {
    // N2-a：`state.dailyPlan` 缺失 ⇒ 展示的是**候选**计划（必须显式标注，不得冒充权威时刻表）
    const fsNo = new MemFs({
      files: [
        [DIR + '/logs/.keep', ''],
        [DIR + '/settings.json', JSON.stringify(Object.assign({}, DEFAULTS, { accountGapMs: [1, 1], schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } }))],
        [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: false, mode: 'readonly' }, doneKeys: {}, lastSignSuccess: {}, lock: null })],
        [DIR + '/accounts.json', JSON.stringify({ accounts })],
        [DIR + '/salts.json', JSON.stringify({ version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { salt: SALT, status: 'verified', clientType: '5' } }, versionCache: null })],
      ],
    })
    const coreNo = createCore({ adapterFs: fsNo, now: () => T_0900 })
    const ANo = createActions(coreNo)
    const schNo = await ANo.schedule()
    show('A.schedule()（无 state.dailyPlan）', { persisted: schNo.dailyPlanPersisted, source: schNo.dailyPlanSource, items: (schNo.dailyPlan && schNo.dailyPlan.items || []).length })
    check(schNo.dailyPlanPersisted === false && schNo.dailyPlanSource === 'candidate', 'N2-a 未落盘 ⇒ 显式标注 `dailyPlanPersisted:false` / `dailyPlanSource:"candidate"`', { p: schNo.dailyPlanPersisted, s: schNo.dailyPlanSource }, { p: false, s: 'candidate' })
    check(typeof schNo.dailyPlanNote === 'string' && schNo.dailyPlanNote.indexOf('候选') >= 0 && schNo.dailyPlanNote.indexOf('tick') >= 0, 'N2-a 未落盘 ⇒ note 明说"候选/权威计划在首次 tick 后才存在"（nextAt 亦只是候选值）', schNo.dailyPlanNote, '<含 候选/tick>')
    check(schNo.dailyPlan !== null && JSON.parse(fsNo.files.get(DIR + '/state.json')).dailyPlan === undefined, 'N2-a 读侧**不写盘**（state.json 仍无 dailyPlan 键）', true, true)

    // N2-b：`state.dailyPlan` 可用（同日 + 组合一致 + 窗口/分散一致）⇒ 展示**逐字等同** state.dailyPlan，并标 persisted
    const frozenPlan = {
      date: localDateOf(T_0900),
      generatedAt: new Date(T_0900).toISOString(),
      window: { start: DEFAULTS.windowStart, end: DEFAULTS.windowEnd },
      spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], spreadDegraded: false, spreadDegradedReason: null, targets: [],
      items: [
        { comboKey: 'hk4e', accountKey: 'acct-***1234', target: 'hk4e', region: '', at: T_0900 + 600000 },
        { comboKey: 'zzz', accountKey: 'acct-***1234', target: 'zzz', region: '', at: T_0900 + 1200000 },
        { comboKey: 'bbs', accountKey: 'acct-***1234', target: 'bbs', region: '', at: T_0900 + 1800000 },
      ],
    }
    const fsYes = new MemFs({
      files: [
        [DIR + '/logs/.keep', ''],
        [DIR + '/settings.json', JSON.stringify(Object.assign({}, DEFAULTS, { accountGapMs: [1, 1], schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] } }))],
        [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: true, mode: 'auto' }, dailyPlan: frozenPlan, doneKeys: {}, lastSignSuccess: {}, lock: null })],
        [DIR + '/accounts.json', JSON.stringify({ accounts })],
        [DIR + '/salts.json', JSON.stringify({ version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { salt: SALT, status: 'verified', clientType: '5' } }, versionCache: null })],
      ],
    })
    const AYes = createActions(createCore({ adapterFs: fsYes, now: () => T_0900 }))
    const schYes = await AYes.schedule()
    show('A.schedule()（有可用 state.dailyPlan）', { persisted: schYes.dailyPlanPersisted, source: schYes.dailyPlanSource, at: (schYes.dailyPlan && schYes.dailyPlan.items || []).map((i) => i.at) })
    check(schYes.dailyPlanPersisted === true && schYes.dailyPlanSource === 'persisted', 'N2-b 权威计划可用 ⇒ 标 `persisted:true` / `"persisted"`', { p: schYes.dailyPlanPersisted, s: schYes.dailyPlanSource }, { p: true, s: 'persisted' })
    check(JSON.stringify(schYes.dailyPlan) === JSON.stringify(frozenPlan), 'N2-b 展示的 `dailyPlan` 与 `state.dailyPlan` **逐字一致**（同一份，不重掷）', schYes.dailyPlan && schYes.dailyPlan.items.map((i) => i.at), frozenPlan.items.map((i) => i.at))
    check(schYes.dailyPlanNote.indexOf('权威') >= 0, 'N2-b note 明说来自 state.dailyPlan（权威）', schYes.dailyPlanNote, '<含 权威>')

    // N1 端到端（经 index.js 读侧）：legacy 冲突键在读 state 时即被迁移 ⇒ gate 不再报 G3
    const fsLeg = new MemFs({
      files: [
        [DIR + '/logs/.keep', ''],
        [DIR + '/settings.json', JSON.stringify(Object.assign({}, DEFAULTS, { accountGapMs: [1, 1], schedule: { targets: [] } }))],
        [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: false, mode: 'readonly' }, credentials: { configured: true, lastOkAt: new Date(T_0900).toISOString() }, doneKeys: { 'acct-***1234:hk4e:2026-09-20': { status: 'failed', retcode: -400005 }, 'acct-***1234:hk4e:2026-09-20:cn_gf01': { status: 'signed', retcode: 0 } }, lastSignSuccess: { 'acct-***1234': { hk4e: { outcome: 'success', at: new Date(T_0900).toISOString(), retcode: 0, saltFingerprint: 'deadbeef', appVersion: '2.109.0' } } }, lock: null })],
        [DIR + '/accounts.json', JSON.stringify({ accounts })],
        [DIR + '/salts.json', JSON.stringify({ version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { salt: SALT, saltFingerprint: 'deadbeef', status: 'verified', clientType: '5' } }, versionCache: null })],
      ],
    })
    const ALeg = createActions(createCore({ adapterFs: fsLeg, now: () => T_0900 }))
    const schLeg = await ALeg.schedule()
    const g3 = (schLeg.gate.reasons || []).filter((r) => r.id === 'G3')
    show('N1 端到端 gate G3', { legacyKeysRemoved: schLeg.legacyKeysRemoved, g3: g3.length, failedByGroup: schLeg.gate.failedByGroup })
    check(schLeg.legacyKeysRemoved.length === 1 && g3.length === 0, 'N1 端到端：读侧迁移后 **gate.reasons 无 G3**（缺口在 actions 层也已闭合）', { removed: schLeg.legacyKeysRemoved.length, g3: g3.length }, { removed: 1, g3: 0 })
  }

  console.log('\n== t50/O1+O2 提交侧与门禁侧同源（R3 根治）+ 单组合精确选中（R1）==')
  {
    const settings = { schedule: { targets: ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn', 'bh3:bb01'] } }
    const groups = [
      { accountKey: 'acct-***1234', gameKey: 'bh3', region: 'bb01', comboKey: 'bh3:bb01' },
      { accountKey: 'acct-***1234', gameKey: 'bh3', region: 'pc01', comboKey: 'bh3:pc01' },
      { accountKey: 'acct-***1234', gameKey: 'bh3', region: 'android01', comboKey: 'bh3:android01' },
      { accountKey: 'acct-***1234', gameKey: 'hk4e', region: 'cn_gf01', comboKey: 'hk4e:cn_gf01' },
      { accountKey: 'acct-***1234', gameKey: 'hkrpg', region: 'prod_gf_cn', comboKey: 'hkrpg:prod_gf_cn' },
      { accountKey: 'acct-***1234', gameKey: 'zzz', region: 'prod_gf_cn', comboKey: 'zzz:prod_gf_cn' },
      { accountKey: 'acct-***1234', gameKey: 'bbs', region: '', comboKey: 'bbs' },
    ]
    const bare = selectGroupsForAction(groups, settings, {})
    show('O1 裸选（targets=4）=> ', bare.map((g) => g.comboKey))
    check(bare.length === 4 && bare.map((g) => g.comboKey).join(',') === 'bh3:bb01,hk4e:cn_gf01,hkrpg:prod_gf_cn,zzz:prod_gf_cn', 'O1 裸调用（无 gameKey）⇒ **只选 targets 内 4 个组合**（此前是 7：含 pc01/android01/bbs）', bare.map((g) => g.comboKey), ['bh3:bb01', 'hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn'])
    check(selectGroupsForAction(groups, settings, { all: true }).length === 7, 'O1 显式 `all:true` ⇒ 才全量 7 个（全量能力保留，但必须显式）', selectGroupsForAction(groups, settings, { all: true }).length, 7)
    const one = selectGroupsForAction(groups, settings, { gameKey: 'bh3', region: 'bb01' })
    check(one.length === 1 && one[0].comboKey === 'bh3:bb01', 'O2 `{gameKey:"bh3", region:"bb01"}` ⇒ **恰好 1 个组合**（R1 的根治解）', one.map((g) => g.comboKey), ['bh3:bb01'])
    const oneCk = selectGroupsForAction(groups, settings, { comboKey: 'bh3:pc01' })
    check(oneCk.length === 1 && oneCk[0].region === 'pc01', 'O2 `comboKey` 亦可精确选中（**显式意图** ⇒ 不受 targets 过滤限制，故 targets 外的 pc01 也能被指名选中）', oneCk.map((g) => g.comboKey), ['bh3:pc01'])
    check(selectGroupsForAction(groups, settings, { gameKey: 'bh3' }).length === 1, 'O1 `{gameKey:"bh3"}`（**不含** region/comboKey）⇒ 只剩 targets 内的 bb01 ⇒ 1 个（pc01/android01 被收窄）', selectGroupsForAction(groups, settings, { gameKey: 'bh3' }).map((g) => g.comboKey), ['bh3:bb01'])
    check(selectGroupsForAction(groups, { schedule: { targets: [] } }, {}).length === 7, 'O1 targets 空 ⇒ 不过滤（与 targetSelected 的"全选"口径一致）', selectGroupsForAction(groups, { schedule: { targets: [] } }, {}).length, 7)
  }

  console.log('\n== t50/O1+O2 **行动层**：`A.sign{dryRun:true}` 的 `selected`（7→4 / 精确 1）==')
  {
    const accounts7 = [{
      accountKey: 'acct-***1234', uid: '123456789',
      roles: [
        { gameKey: 'bh3', region: 'bb01', gameUid: '1' },
        { gameKey: 'bh3', region: 'pc01', gameUid: '2' },
        { gameKey: 'bh3', region: 'android01', gameUid: '3' },
        { gameKey: 'hk4e', region: 'cn_gf01', gameUid: '4' },
        { gameKey: 'hkrpg', region: 'prod_gf_cn', gameUid: '5' },
        { gameKey: 'zzz', region: 'prod_gf_cn', gameUid: '6' },
      ],
    }]
    const TARGETS4 = ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn', 'bh3:bb01']
    const mkSig = (targets) => createActions(createCore({
      adapterFs: new MemFs({
        files: [
          [DIR + '/logs/.keep', ''],
          [DIR + '/settings.json', JSON.stringify(Object.assign({}, DEFAULTS, { schedule: { targets } }))],
          [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: false, mode: 'readonly' }, credentials: { configured: true, lastOkAt: new Date(T_0900).toISOString() }, doneKeys: {}, lastSignSuccess: {}, lock: null })],
          [DIR + '/accounts.json', JSON.stringify({ accounts: accounts7 })],
          [DIR + '/salts.json', JSON.stringify({ version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { salt: SALT, saltFingerprint: 'deadbeef', status: 'verified', clientType: '5' } }, versionCache: null })],
        ],
      }),
      now: () => T_0900,
    }))
    const ASig = mkSig(TARGETS4)
    const bare = await ASig.sign({ dryRun: true })
    show('A.sign{} => ', { selected: bare.selected, excluded: (bare.excludedByTargets || []).map((e) => e.comboKey) })
    check(bare.selected === 4, 'O1 行动层：裸 `{dryRun:true}`（targets=4）⇒ **`selected=4`**（此前 7）', bare.selected, 4)
    check((bare.excludedByTargets || []).map((e) => e.comboKey).sort().join(',') === 'bbs,bh3:android01,bh3:pc01', 'O1 行动层：被排除的正是 `bh3:pc01`/`bh3:android01`/`bbs`，且**如实列出**（reason=not_in_schedule_targets）', (bare.excludedByTargets || []).map((e) => e.comboKey).sort().join(','), 'bbs,bh3:android01,bh3:pc01')
    check((bare.excludedByTargets || []).every((e) => e.reason === 'not_in_schedule_targets'), 'O1 行动层：排除项 reason 逐字＝`not_in_schedule_targets`', (bare.excludedByTargets || [])[0] && (bare.excludedByTargets || [])[0].reason, 'not_in_schedule_targets')
    const s1 = await ASig.sign({ dryRun: true, gameKey: 'bh3', region: 'bb01' })
    check(s1.selected === 1, "O2 行动层：`{gameKey:'bh3', region:'bb01'}` ⇒ **`selected=1`**", s1.selected, 1)
    const s2 = await ASig.sign({ dryRun: true, comboKey: 'bh3:bb01' })
    check(s2.selected === 1, "O2 行动层：`{comboKey:'bh3:bb01'}` ⇒ **`selected=1`**", s2.selected, 1)
    const s3 = await ASig.sign({ dryRun: true, gameKey: 'bh3' })
    check(s3.selected === 1, "O2 行动层：`{gameKey:'bh3'}` 在 targets=4 时 ⇒ **`selected=1`**（被 targets 收窄）", s3.selected, 1)
    const s4 = await ASig.sign({ dryRun: true, all: true })
    check(s4.selected === 7, 'O1 行动层：显式 `{all:true}` ⇒ `selected=7`（全量能力保留，但必须显式）', s4.selected, 7)
    const s5 = await mkSig([]).sign({ dryRun: true })
    check(s5.selected === 7, 'O1 行动层：targets 空 ⇒ 不过滤（`selected=7`，与 targetSelected「空即全选」同口径）', s5.selected, 7)
    const s6 = await ASig.sign({ dryRun: true, comboKey: 'bh3:pc01' })
    check(s6.selected === 1, "O2 行动层：显式指名 targets 外的 `{comboKey:'bh3:pc01'}` ⇒ `selected=1`（显式意图不受 targets 限制）", s6.selected, 1)
  }

  console.log('\n== t50/O3 门禁 hint 可执行性纠偏（R4）==')
  {
    const shaped = gateShape({ ok: false, reasons: [{ id: 'G2', ok: false, scope: { accountKey: 'acct-***1234', gameKey: 'bh3' }, hint: "对该账号该游戏单独试签一次（miyoushe_run {accountKey:'acct-***1234', gameKey:'bh3', dryRun:false}），确认 App 里出现奖励后再开启定时" }, { id: 'G1', ok: true, hint: null }] })
    const h = shaped.reasons[0].hint
    show('O3 纠偏后 hint', h)
    check(h.indexOf('miyoushe_sign {') >= 0 && h.indexOf('miyoushe_run {') === -1, 'O3 被拦 hint **不再给出**未实现的 `miyoushe_run {…}` 调用形式，改为可执行的 `miyoushe_sign {…}`', h, '<含 miyoushe_sign {…} 且不含 miyoushe_run {…}>')
    check(h.indexOf("accountKey:'acct-***1234'") >= 0 && h.indexOf("gameKey:'bh3'") >= 0, 'O3 纠偏保留 scope 里的 accountKey/gameKey（照做即可成功）', h, '<含两者>')
    check(shaped.reasons[1].hint === null, 'O3 无关 hint 原样不动（null 仍是 null）', shaped.reasons[1].hint, null)
  }
} finally {
  globalThis.fetch = realFetch
}

console.log('')
console.log('\n== t82/P0：**tick 执行路径落账**（决定跑 ⇒ 落 doneKeys / 落 sign_result / 受上限约束）==')
{
  const { createCore } = await import('../lib/index.js')   // 上面的 createCore 在上一个 try 块作用域内，这里各自导入
  // 夹具：一份**已到点**的当日计划（item.at 早于 tick 时刻）⇒ tick 会真的决定 run
  const T82 = at(10, 30)
  const D82 = localDateOf(T82)
  const KEY82 = 'acct-***1234:hk4e:' + D82 + ':cn_gf01'
  const S82 = JSON.stringify(Object.assign({}, DEFAULTS, {
    accountGapMs: [1, 1], dailyJitterMs: 0, allowLateSign: true, windowStart: '08:00', windowEnd: '23:30',
    schedule: { enabled: true, mode: 'auto', spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: ['hk4e:cn_gf01'] },
  }))
  const A82 = { version: 1, accounts: [{ accountKey: 'acct-***1234', uid: '1', roles: [{ gameKey: 'hk4e', region: 'cn_gf01' }] }] }
  const SALT82 = { version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { clientType: '5', salt: SALT, status: 'verified', fetchedAt: '2026-09-20T00:00:00Z' } } }
  const plan82 = { date: D82, generatedAt: new Date(T82).toISOString(), window: { start: '08:00', end: '23:30' }, spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], spreadDegraded: false, spreadDegradedReason: null, targets: ['hk4e:cn_gf01'], items: [{ comboKey: 'hk4e:cn_gf01', accountKey: 'acct-***1234', target: 'hk4e', region: 'cn_gf01', at: T82 - 60000 }] }
  const mk82 = (execute) => {
    const fsx = new MemFs({ files: [
      [DIR + '/logs/.keep', ''],
      [DIR + '/settings.json', S82],
      [DIR + '/accounts.json', JSON.stringify(A82)],
      [DIR + '/salts.json', JSON.stringify(SALT82)],
      [DIR + '/state.json', JSON.stringify({ version: 1, schedule: { enabled: true, mode: 'auto' }, credentials: { configured: true, lastOkAt: '2026-09-20T00:00:00Z' }, doneKeys: {}, lastSignSuccess: {}, lock: null, dailyPlan: plan82 })],
    ] })
    const core = createCore(Object.assign({ adapterFs: fsx, now: () => T82 }, execute ? { execute } : null))
    return { fsx, core }
  }
  const stOf82 = (fsx) => JSON.parse(fsx.files.get(DIR + '/state.json'))
  const evOf82 = (fsx) => { const o = []; for (const [k, v] of fsx.files.entries()) if (k.indexOf('/logs/') >= 0 && k.endsWith('.ndjson')) for (const l of String(v).split('\n').filter(Boolean)) { try { o.push(JSON.parse(l)) } catch (e) {} } return o }

  // ① 未接线（P0 的复现前提）：必须落 failed + doneKeys + attempts + sign_result，而**不是**静默 would_run
  {
    const { fsx, core } = mk82(null)
    const r1 = await core.scheduler.tick({ now: T82 })
    check(r1.ran.length === 1 && r1.ran[0].outcome === 'failed' && String(r1.ran[0].message).indexOf('EXECUTE_NOT_WIRED') >= 0, 'P0① 未接线 ⇒ 结果 = failed/EXECUTE_NOT_WIRED（不再是 would_run）', (r1.ran[0] || {}).outcome, 'failed')
    const s1 = stOf82(fsx)
    check(s1.doneKeys[KEY82] !== undefined, 'P0① **落 doneKeys**（修复前完全没写）', Object.keys(s1.doneKeys), [KEY82])
    check(s1.doneKeys[KEY82].attempts === 1, 'P0① attempts 0→1（修复前不增长 ⇒ 无限重试）', s1.doneKeys[KEY82].attempts, 1)
    const sr1 = evOf82(fsx).filter((e) => e.event === 'sign_result')
    check(sr1.length === 1 && sr1[0].dedupeKey === KEY82 && sr1[0].outcome === 'failed', 'P0① **落一条 sign_result 日志**（修复前没有）', evOf82(fsx).map((e) => e.event), ['sign_result'])
    show('t82 sign_result（未接线）', sr1[0])
  }

  // ② 接线后（注入 fake execute 成功）：落 signed + 落 sign_result（含 retcode/httpStatus）
  {
    const { fsx, core } = mk82(async () => ({ outcome: 'signed', retcode: 0, httpStatus: 200, classify: null, message: null }))
    const r2 = await core.scheduler.tick({ now: T82 })
    check(r2.ran.length === 1 && r2.ran[0].outcome === 'signed', 'P0② 真提交 ⇒ outcome=signed', (r2.ran[0] || {}).outcome, 'signed')
    check(stOf82(fsx).doneKeys[KEY82].status === 'signed', 'P0② doneKeys 记 signed', stOf82(fsx).doneKeys[KEY82].status, 'signed')
    const sr2 = evOf82(fsx).filter((e) => e.event === 'sign_result')
    check(sr2.length === 1 && sr2[0].outcome === 'signed' && sr2[0].retcode === 0 && sr2[0].httpStatus === 200, 'P0② sign_result 含 outcome/retcode/httpStatus', sr2[0], '<signed/0/200>')
    show('t82 sign_result（signed）', sr2[0])
  }

  // ③ 上限：失败最多 maxAttemptsPerDay(=3) 次，之后不再提交
  {
    const { fsx, core } = mk82(null)
    const seq = []
    for (const t of [T82, T82 + 3600000, T82 + 7200000, T82 + 10800000, T82 + 14400000]) seq.push((await core.scheduler.tick({ now: t })).ran.length)
    show('t82 连续 5 次 tick 的 ran.length', seq)
    check(seq.filter((n) => n === 1).length === 3, 'P0③ 只尝试 3 次 = maxAttemptsPerDay', seq.filter((n) => n === 1).length, 3)
    check(seq[seq.length - 1] === 0, 'P0③ 之后不再提交（上限生效，非无限重试）', seq, '<第4/5次为0>')
    check(stOf82(fsx).doneKeys[KEY82].attempts === 3 && stOf82(fsx).doneKeys[KEY82].status === 'failed', 'P0③ attempts 封顶 3 且终态 failed（可审计）', stOf82(fsx).doneKeys[KEY82], '<attempts 3 / failed>')
    check(evOf82(fsx).filter((e) => e.event === 'sign_result').length === 3, 'P0③ 恰好 3 条 sign_result（每次真实尝试一条）', evOf82(fsx).filter((e) => e.event === 'sign_result').length, 3)
  }
}

console.log('SCHEDULER failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
