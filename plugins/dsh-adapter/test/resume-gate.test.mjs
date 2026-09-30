// @local/dsh-adapter —— 重启门闸单测（P3-U11）
//
// 锁住的语义（对应 P3 计划 §U11 与四条硬禁止）：
//   1. ★判定权威是**活会话存储**（`ctx.sessions.list()`）：只统计**驻留**会话，
//      **绝不**扫全量会话日志 —— 磁盘上大量"重启被截断、永远停在 open"的历史会话
//      （真机 P0 命中 236/419 = 56%）会让门闸**恒不安全**
//   2. 三类阻塞项：`delegations`（驻留子会话 turn 未闭合）/ `hotplugOps` / `openTurns`（驻留主会话）
//      ⚠️ **活进程口径 = 只有 `kind==='open'` 算"在飞"**：`interrupted` 是一轮**已结束**的收尾
//         （重启/中断补的 turn/end），活进程里不代表"在跑"。与 ./scan.js 的 `unfinished` 口径
//         **刻意不同**（那边要保持把 interrupted 算未完成），理由见 lib/resume/gate.js 文件头。
//   3. ★**fail-closed**：任何一类判不出来 ⇒ `ok:false` + `safe:false` + reason，
//      **绝不允许**把"没查到"当"安全"（`setupSkipped` 那次事故的教训）
//   4. ★事件表只**补字段 + 告警**，**绝不**因为表里缺项就放行、也绝不因为表里有残余就加阻塞项
//   5. categories 关掉某类 ⇒ 该类既不拦、也不再因它 fail-closed
//   6. test-only 注入（`testForceInflight`）⇒ 恒定一条伪在飞 + 构造期 WARN 审计
//   7. 审计按**状态变化**写（轮询端点每次写会刷爆审计）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createResumeGate, normalizeGateConfig } from '../lib/resume/gate.js'
import { createInflightTable, SUBAGENT_EVENTS } from '../lib/resume/inflight.js'
import {
  mkEventCtx, collectAudit, turnStart, turnEnd, liveSession, liveChild, mkLiveSessions, mkHotplug, NOW,
} from './_resume-fakes.mjs'

/** 造一个门闸（`services` 直接喂给假 ctx） */
const mkGate = ({ services = {}, hotplug = mkHotplug(), inflight = null, config = {} } = {}) => {
  const ctx = mkEventCtx(services)
  const a = collectAudit()
  const gate = createResumeGate({ ctx, hotplug, inflight, config, audit: a.audit, now: () => NOW })
  return { ctx, gate, a }
}

const turn = (n, kind = 'completed') => [turnStart(n), turnEnd(n, kind)]
const openTurn = (n) => [turnStart(n)]
const turnEnded = (n) => [turnEnd(n)]

test('无驻留会话 + hotplug 干净 ⇒ ok:true / safe:true（空集是"安全"的正常来源，不是 fail-closed）', () => {
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([]) } })
  const r = gate.evaluate()
  assert.equal(r.ok, true)
  assert.equal(r.safe, true)
  assert.equal(r.reason, null)
  assert.deepEqual(r.counts, { liveSessions: 0, delegations: 0, hotplugOps: 0, openTurns: 0 })
  assert.deepEqual(r.unjudgeable, [])
})

test('驻留**主**会话 turn 未闭合 ⇒ 进 openTurns（活进程里这是"真有一轮在跑"，不是陈旧日志）', () => {
  const s = liveSession('session-a', { events: openTurn(3) })
  const closed = liveSession('session-b', { events: turn(1) })
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([s, closed]) } })
  const r = gate.evaluate()
  assert.equal(r.ok, true)
  assert.equal(r.safe, false)
  assert.equal(r.counts.openTurns, 1)
  assert.equal(r.counts.delegations, 0)
  assert.equal(r.blockers.openTurns[0].sessionId, 'session-a')
  assert.equal(r.blockers.openTurns[0].turn, 3)
  assert.equal(r.blockers.openTurns[0].kind, 'open')
})

test('驻留**子**会话 turn 未闭合 ⇒ 进 delegations（带 parentId），**不得**重复进 openTurns', () => {
  const c = liveChild('child-1', 'session-parent', { events: openTurn(1) })
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([c]) } })
  const r = gate.evaluate()
  assert.equal(r.safe, false)
  assert.equal(r.counts.delegations, 1)
  assert.equal(r.counts.openTurns, 0, '子会话不能被当成主会话计入 openTurns')
  assert.equal(r.blockers.delegations[0].childId, 'child-1')
  assert.equal(r.blockers.delegations[0].parentId, 'session-parent')
})

test('子会话已闭合（turnEnd）⇒ 两类都空（父会话已闭合 + 子已收尾不是阻塞项）', () => {
  const c = liveChild('child-1', 'P', { events: turnEnded(1) })
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([c]) } })
  const r = gate.evaluate()
  assert.equal(r.safe, true)
  assert.equal(r.counts.delegations, 0)
})

test('★活进程只把 `open` 当"在飞"：末态 interrupted（一轮**已结束**）不阻塞（2026-09-24 修复）', () => {
  // 修复前的坏法：`interrupted` 也是 `unfinished:true` ⇒ 子会话进 delegations、主会话进 openTurns
  // ⇒ 门闸**恒不安全**。真机实录 `session-fd9f5874` 驻留主会话末态 `turn/end(interrupted)`
  // ⇒ `openTurns` 恒 1 条 ⇒ `safe:false`，`restart-kernel.sh` 不带 --force 永久拒绝重启。
  const c = liveChild('child-1', 'P', { events: turn(1, 'interrupted') })
  const m = liveSession('session-m', { events: turn(1, 'interrupted') })
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([c, m]) } })
  const r = gate.evaluate()
  assert.equal(r.ok, true)
  assert.equal(r.safe, true, 'interrupted = 已结束的一轮，不是"正在跑"')
  assert.equal(r.counts.delegations, 0, '子会话 interrupted 也不该阻塞')
  assert.equal(r.counts.openTurns, 0)
})

test('★★红线：同批里只要有一条真 open ⇒ 仍 `safe:false`（修 interrupted **不得**放过 open）', () => {
  const intr = liveSession('session-intr', { events: turn(1, 'interrupted') })
  const open = liveSession('session-open', { events: openTurn(5) })
  const childOpen = liveChild('child-open', 'P', { events: openTurn(2) })
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([intr, open, childOpen]) } })
  const r = gate.evaluate()
  assert.equal(r.ok, true)
  assert.equal(r.safe, false, 'open turn 仍然拦 —— 安全闸没被废掉')
  assert.equal(r.counts.openTurns, 1)
  assert.equal(r.blockers.openTurns[0].sessionId, 'session-open')
  assert.equal(r.blockers.openTurns[0].kind, 'open')
  assert.equal(r.counts.delegations, 1)
  assert.equal(r.blockers.delegations[0].childId, 'child-open')
})

test('★fail-closed：sessions 服务缺失 ⇒ ok:false + safe:false + reason（绝不报安全）', () => {
  const { gate } = mkGate({ services: {} })
  const r = gate.evaluate()
  assert.equal(r.ok, false)
  assert.equal(r.safe, false)
  assert.equal(r.reason, 'live-sessions-unavailable')
  assert.equal(r.failClosed, true)
})

test('★fail-closed：sessions.list() 抛错 / 返回非数组 ⇒ 各自 reason，且仍然 safe:false', () => {
  const a = mkGate({ services: { sessions: mkLiveSessions([], { throwOnList: true }) } })
  assert.equal(a.gate.evaluate().reason, 'live-sessions-list-threw')
  assert.equal(a.gate.evaluate().safe, false)

  const b = mkGate({ services: { sessions: mkLiveSessions([], { notArray: true }) } })
  assert.equal(b.gate.evaluate().reason, 'live-sessions-not-array')
  assert.equal(b.gate.evaluate().safe, false)
})

test('★fail-closed：驻留会话缺 snapshotEvents ⇒ 判不了，**不得**当作已闭合', () => {
  const broken = liveSession('session-a', { noSnapshot: true })
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([broken]) } })
  const r = gate.evaluate()
  assert.equal(r.ok, false, '判据不完整 ⇒ ok 必须是 false')
  assert.equal(r.safe, false)
  assert.equal(r.reason, 'unjudgeable')
  assert.equal(r.unjudgeable.length, 1)
  assert.equal(r.unjudgeable[0].reason, 'snapshotEvents-unavailable')
})

test('★fail-closed：驻留会话缺 header（判不出是否子会话）⇒ unjudgeable', () => {
  const s = liveSession('session-a', { events: openTurn(1) })
  delete s.header
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([s]) } })
  const r = gate.evaluate()
  assert.equal(r.ok, false)
  assert.equal(r.unjudgeable[0].reason, 'header-unavailable')
})

test('hotplugOps：在飞操作 ⇒ 拦；loader 不稳定 ⇒ 拦（同一类"重启会掐断"的风险）', () => {
  const svc = { sessions: mkLiveSessions([]) }
  const a = mkGate({ services: svc, hotplug: mkHotplug({ inFlight: { id: 'pkg-x', op: 'reload', startedAt: NOW - 5000 } }) })
  const ra = a.gate.evaluate()
  assert.equal(ra.safe, false)
  assert.equal(ra.counts.hotplugOps, 1)
  assert.equal(ra.blockers.hotplugOps[0].id, 'pkg-x')
  assert.equal(ra.blockers.hotplugOps[0].ageMs, 5000)

  const b = mkGate({ services: svc, hotplug: mkHotplug({ unstable: true, unstableReason: 'link 校验失败' }) })
  const rb = b.gate.evaluate()
  assert.equal(rb.safe, false)
  assert.equal(rb.blockers.hotplugOps[0].kind, 'loader-unstable')
  assert.match(rb.blockers.hotplugOps[0].reason, /link/)
})

test('★fail-closed：hotplugOps 类开启但 hotplug 服务缺失 ⇒ unjudgeable（不视为安全）', () => {
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([]) }, hotplug: null })
  const r = gate.evaluate()
  assert.equal(r.safe, false)
  assert.equal(r.ok, false)
  assert.equal(r.unjudgeable[0].reason, 'hotplug-unavailable')
})

test('categories 关掉某类 ⇒ 该类既不拦、也不再因它 fail-closed', () => {
  const { gate } = mkGate({
    services: { sessions: mkLiveSessions([liveSession('s1', { events: openTurn(1) })]) },
    hotplug: null,
    config: { categories: { delegations: true, hotplugOps: false, openTurns: false } },
  })
  const r = gate.evaluate()
  assert.equal(r.ok, true, '关掉的类不该再产生 unjudgeable')
  assert.equal(r.safe, true, 'openTurns 关掉 ⇒ 未闭合 turn 不拦')
  assert.equal(r.counts.openTurns, 0)
})

test('三类全关 ⇒ 恒 safe:true（但这是**显式**配置的结果，不是静默退化）', () => {
  const { gate } = mkGate({
    services: { sessions: mkLiveSessions([liveChild('c', 'P', { events: openTurn(1) })]) },
    hotplug: mkHotplug({ unstable: true }),
    config: { categories: { delegations: false, hotplugOps: false, openTurns: false } },
  })
  const r = gate.evaluate()
  assert.equal(r.safe, true)
  assert.equal(r.ok, true)
})

test('test-only 注入 ⇒ 恒定一条伪在飞（带 test 标记）+ 构造期即留 WARN 审计', () => {
  const { gate, a } = mkGate({
    services: { sessions: mkLiveSessions([]) },
    config: { testForceInflight: 'fake-child-999' },
  })
  assert.equal(a.find('resume.gate_test_override').length, 1, '构造期就该留痕（即便没被查询过）')
  const r = gate.evaluate()
  assert.equal(r.safe, false)
  assert.equal(r.counts.delegations, 1)
  assert.equal(r.blockers.delegations[0].childId, 'fake-child-999')
  assert.equal(r.blockers.delegations[0].test, true)
})

test('★交叉校验：表里有同一 child ⇒ 补 runId/provider/startedAt（只补字段，判据不变）', () => {
  const services = { sessions: null }
  const ctx = mkEventCtx(services)
  const a = collectAudit()
  const table = createInflightTable({ ctx, audit: a.audit, now: () => NOW })
  table.start()
  services.sessions = mkLiveSessions([liveChild('child-1', 'P', { events: openTurn(1) })])
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1', provider: 'in-process' }, { sessionId: 'P' })

  const gate = createResumeGate({ ctx, hotplug: mkHotplug(), inflight: table, audit: a.audit, now: () => NOW })
  const r = gate.evaluate()
  assert.equal(r.counts.delegations, 1)
  assert.equal(r.blockers.delegations[0].tableMatch, true)
  assert.equal(r.blockers.delegations[0].runId, 'r1')
  assert.equal(r.blockers.delegations[0].provider, 'in-process')
  assert.equal(r.blockers.delegations[0].startedAt, NOW)
  assert.equal(r.table.matched, 1)
  assert.equal(r.table.missing, 0)
})

test('★交叉校验：表里有残余、活会话说没在飞 ⇒ 只进 table.unmatched，**不加阻塞项**', () => {
  const services = { sessions: null }
  const ctx = mkEventCtx(services)
  const a = collectAudit()
  const table = createInflightTable({ ctx, audit: a.audit, now: () => NOW })
  table.start()
  // 表里有一条"在飞"，但活会话里那个 child 已经闭合了（模拟漏收 end / 表陈旧）
  services.sessions = mkLiveSessions([liveChild('child-1', 'P', { events: turnEnded(1) })])
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1' }, { sessionId: 'P' })

  const gate = createResumeGate({ ctx, hotplug: mkHotplug(), inflight: table, audit: a.audit, now: () => NOW })
  const r = gate.evaluate()
  assert.equal(r.safe, true, '表只告警不加阻塞项 ⇒ 仍可判安全')
  assert.equal(r.counts.delegations, 0)
  assert.equal(r.table.unmatched.length, 1)
  assert.equal(r.table.unmatched[0].childId, 'child-1')
})

test('★事件表**缺项**不得被当成"没有在飞"的证据：没有表时 delegations 照常判出', () => {
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([liveChild('child-1', 'P', { events: openTurn(1) })]) }, inflight: null })
  const r = gate.evaluate()
  assert.equal(r.counts.delegations, 1, '判定权威是活会话存储，不依赖表')
  assert.equal(r.table.available, false)
})

test('审计按**状态变化**写：连续两次相同结果只写一条，状态变化时再写', () => {
  const services = { sessions: mkLiveSessions([liveSession('s1', { events: openTurn(1) })]) }
  const ctx = mkEventCtx(services)
  const a = collectAudit()
  const gate = createResumeGate({ ctx, hotplug: mkHotplug(), audit: a.audit, now: () => NOW })
  gate.evaluate()
  gate.evaluate()
  gate.evaluate()
  assert.equal(a.find('resume.gate').length, 1, '轮询期间状态不变 ⇒ 不重复记（否则会刷爆审计）')

  services.sessions = mkLiveSessions([]) // 变成安全
  gate.evaluate()
  const lines = a.find('resume.gate')
  assert.equal(lines.length, 2)
  assert.equal(lines[1].extra.safe, true)
  assert.equal(lines[0].extra.safe, false)
})

test('noteForce 把"--force 跳过门闸"连同当时的阻塞项写进审计', () => {
  const { gate, a } = mkGate({ services: { sessions: mkLiveSessions([]) } })
  gate.noteForce({ reason: 'timeout', by: 'restart-kernel.sh', blockers: { delegations: 2, hotplugOps: 0, openTurns: 1 } })
  const lines = a.find('resume.gate_force')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].level, 'WARN')
  assert.equal(lines[0].extra.reason, 'timeout')
  assert.equal(lines[0].extra.by, 'restart-kernel.sh')
})

test('配置归一化：非法值回退默认并记 warning（配置写错不该让内核起不来）', () => {
  const r1 = normalizeGateConfig({ categories: { delegations: 'yes' }, testForceInflight: 123 })
  assert.equal(r1.cfg.testForceInflight, null)
  assert.equal(r1.warnings.length, 1)
  assert.match(r1.warnings[0], /testForceInflight/)

  const r2 = normalizeGateConfig({})
  assert.deepEqual(r2.cfg.categories, { delegations: true, hotplugOps: true, openTurns: true })
  assert.equal(r2.warnings.length, 0)

  const r3 = normalizeGateConfig({ testForceInflight: '   ' })
  assert.equal(r3.cfg.testForceInflight, null, '空白串不算有效注入')
  assert.equal(r3.warnings.length, 1)
})

test('status() 如实暴露 test-only 开关（生产巡检发现非 null 即为"开关被遗留"）', () => {
  const { gate } = mkGate({ services: { sessions: mkLiveSessions([]) }, config: { testForceInflight: 'x' } })
  assert.equal(gate.status().testForceInflight, 'x')
  const { gate: g2 } = mkGate({ services: { sessions: mkLiveSessions([]) } })
  assert.equal(g2.status().testForceInflight, null)
})

test('evaluate 永不抛（任何内部异常都收敛成 fail-closed 结果）', () => {
  const boom = { get: () => { throw new Error('get boom') } }
  const a = collectAudit()
  const gate = createResumeGate({ ctx: boom, hotplug: mkHotplug(), audit: a.audit, now: () => NOW })
  const r = gate.evaluate()
  assert.equal(r.ok, false)
  assert.equal(r.safe, false)
})
