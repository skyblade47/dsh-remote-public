// @local/dsh-adapter —— 重启门闸：在飞委派事件表单测（P3-U11）
//
// 这是**交叉校验**用的表，不是判定权威（权威是活会话存储，见 resume-gate.test.mjs）。
// 故本文件锁住的是"表本身别骗人"这一组性质：
//   1. ★订阅必须带 `{ global: true }` —— 内核把父 Agent 作为 scope target 派发，
//      不绕过 scope 过滤会漏掉一部分甚至全部边沿（漏了就会让交叉校验盲目乐观）
//   2. ★回调里的 `this` **就是父 Agent**（cordis `dispatch` 会 bind scope target）⇒ parentId 从这里来
//   3. start/end 用 `runId` 配对；**runId 缺失时退化为 child 键并留痕**（形态漂移要被看见）
//   4. 孤儿 end（订阅晚于 start）只留痕、绝不抛
//   5. 父 Agent 只以 **WeakRef** 持有（不钉住会话对象）；取不到父 id 时条目**仍然保留**（靠 childId 配对）
//   6. 同一 child 的第二个 epoch 顶替映射，且**旧 epoch 的 end 不得抹掉新映射**
//   7. TTL 到期清理；`ctx.on` 不可用只降级不抛；`stop()` 真的取消订阅
//   8. 坏载荷不得让宿主抛错（监听器异常会被 cordis 记 warning，但不该由我们引出来）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInflightTable, SUBAGENT_EVENTS, derefParent } from '../lib/resume/inflight.js'
import { mkEventCtx, collectAudit, NOW } from './_resume-fakes.mjs'

const mkTable = ({ services = {}, ttlMs, now } = {}) => {
  const ctx = mkEventCtx(services)
  const a = collectAudit()
  const table = createInflightTable({ ctx, audit: a.audit, ttlMs, now: now || (() => NOW) })
  return { ctx, table, a }
}

const parentAgent = (sessionId) => ({ sessionId, kind: 'agent' })

test('订阅三个生命周期事件，且**必须**带 { global: true }（否则边沿会被 scope 过滤掉）', () => {
  const { ctx, table } = mkTable()
  const r = table.start()
  assert.equal(r.subscribed, true)
  assert.equal(r.global, true)
  assert.deepEqual(ctx.onCalls.map((c) => c.name).sort(),
    [SUBAGENT_EVENTS.start, SUBAGENT_EVENTS.end, SUBAGENT_EVENTS.providerRemoved].sort())
  for (const c of ctx.onCalls) {
    assert.equal(c.opts && c.opts.global, true, `事件 ${c.name} 的订阅必须带 global:true`)
  }
})

test('start 边沿：`this` 为父 Agent ⇒ 解出 parentId；childId/runId/provider/local 如实记录', () => {
  const { ctx, table } = mkTable()
  table.start()
  const parent = parentAgent('session-parent')
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1', provider: 'in-process', local: true }, parent)

  const s = table.snapshot()
  assert.equal(s.size, 1)
  const e = s.entries[0]
  assert.equal(e.runId, 'r1')
  assert.equal(e.childId, 'child-1')
  assert.equal(e.parentId, 'session-parent', '父 id 必须来自回调的 `this`（原生答案）')
  assert.equal(e.parentIdResolved, true)
  assert.equal(e.provider, 'in-process')
  assert.equal(e.local, true)
  assert.equal(s.observed.start, 1)
  assert.equal(s.observed.parentIdUnresolved, 0)
})

test('end 边沿：用 runId 配对清除；byChildId 随之失效', () => {
  const { ctx, table } = mkTable()
  table.start()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1', provider: 'p' }, parentAgent('P'))
  assert.ok(table.byChildId('child-1'), 'start 后应能在表里按 child 找到')

  ctx.emit(SUBAGENT_EVENTS.end, { runId: 'r1', id: 'child-1', provider: 'p', stopReason: 'completed' })
  assert.equal(table.snapshot().size, 0)
  assert.equal(table.byChildId('child-1'), null)
  assert.equal(table.snapshot().observed.end, 1)
})

test('孤儿 end（订阅晚于 start）只留痕不抛', () => {
  const { ctx, table, a } = mkTable()
  table.start()
  ctx.emit(SUBAGENT_EVENTS.end, { runId: 'never-seen', id: 'child-x', provider: 'p', stopReason: 'aborted' })
  assert.equal(table.snapshot().size, 0)
  assert.equal(table.snapshot().observed.end, 1)
  assert.equal(a.find('resume.inflight_orphan_end').length, 1, '配不上对的 end 必须留痕（形态漂移的线索）')
})

test('runId 缺失 ⇒ 退化为 child 键并计数（形态漂移要被看见，但不能因此丢条目）', () => {
  const { ctx, table } = mkTable()
  table.start()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { id: 'child-1', provider: 'p' }, parentAgent('P'))
  const s = table.snapshot()
  assert.equal(s.size, 1)
  assert.equal(s.entries[0].runId, 'child:child-1')
  assert.equal(s.observed.missingRunId, 1)
  // 退化键下 end 仍能清掉
  ctx.emit(SUBAGENT_EVENTS.end, { id: 'child-1' })
  assert.equal(table.snapshot().size, 0)
})

test('父 Agent 形状未知 ⇒ parentId=null 且计数，但**条目仍然保留**（靠 childId 仍可配对）', () => {
  const { ctx, table } = mkTable()
  table.start()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1' }, { weird: true })
  const e = table.snapshot().entries[0]
  assert.equal(e.parentId, null)
  assert.equal(e.parentIdResolved, false)
  assert.equal(table.snapshot().observed.parentIdUnresolved, 1)
  assert.ok(table.byChildId('child-1'), '拿不到父 id 不该让整条记录作废')
})

test('父 Agent 只以 WeakRef 持有（不钉住会话对象），deref 可取回', () => {
  const { ctx, table } = mkTable()
  table.start()
  const parent = parentAgent('P')
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1' }, parent)
  const e = table.snapshot().entries[0]
  assert.ok(e.parentRef, '应持有 parentRef')
  assert.equal(typeof e.parentRef.deref, 'function', '必须是 WeakRef（不是强引用）')
  assert.equal(derefParent(e), parent, 'deref 应取回原 Agent')
})

test('无 scope target（provider-removed 一类）时 `this` 为 null ⇒ 不抛、不产生条目', () => {
  const { ctx, table } = mkTable()
  table.start()
  ctx.emit(SUBAGENT_EVENTS.providerRemoved, 'in-process')
  assert.equal(table.snapshot().size, 0)
  assert.equal(table.snapshot().observed.providerRemoved, 1)
})

test('同一 child 的第二个 epoch 顶替映射；旧 epoch 的 end **不得**抹掉新映射', () => {
  const { ctx, table } = mkTable()
  table.start()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1' }, parentAgent('P'))
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r2', id: 'child-1' }, parentAgent('P'))
  assert.equal(table.byChildId('child-1').runId, 'r2')

  ctx.emit(SUBAGENT_EVENTS.end, { runId: 'r1', id: 'child-1' })
  assert.equal(table.byChildId('child-1').runId, 'r2', '旧代次的 end 不该把新代次的映射删掉')
  ctx.emit(SUBAGENT_EVENTS.end, { runId: 'r2', id: 'child-1' })
  assert.equal(table.byChildId('child-1'), null)
})

test('TTL 到期清理（纯卫生；被清掉的条目只影响交叉校验覆盖率）', () => {
  let clock = NOW
  const { ctx, table } = mkTable({ ttlMs: 1000, now: () => clock })
  table.start()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1' }, parentAgent('P'))
  clock += 500
  assert.equal(table.prune(), 0)
  assert.equal(table.snapshot().size, 1)
  clock += 1000
  assert.equal(table.prune(), 1)
  assert.equal(table.snapshot().size, 0)
  assert.equal(table.byChildId('child-1'), null)
})

test('ctx.on 不可用 ⇒ 只降级（subscribed:false + 留痕），绝不抛', () => {
  const a = collectAudit()
  const table = createInflightTable({ ctx: { get: () => null }, audit: a.audit })
  const r = table.start()
  assert.equal(r.subscribed, false)
  assert.match(String(r.error), /ctx\.on/)
  assert.equal(a.find('resume.inflight_subscribe_failed').length, 1)
})

test('stop() 真的取消订阅（之后边沿不再被计数）', () => {
  const { ctx, table } = mkTable()
  table.start()
  table.stop()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r1', id: 'child-1' }, parentAgent('P'))
  assert.equal(table.snapshot().size, 0, 'stop 之后不该再收边沿')
})

test('start() 幂等：重复调用不重复订阅', () => {
  const { ctx, table } = mkTable()
  table.start()
  table.start()
  assert.equal(ctx.onCalls.length, 3, '三个事件各订阅一次，不该翻倍')
})

test('坏载荷（null / 无 id）不得让宿主抛错', () => {
  const { ctx, table } = mkTable()
  table.start()
  ctx.emitWithParent(SUBAGENT_EVENTS.start, null, parentAgent('P'))
  ctx.emitWithParent(SUBAGENT_EVENTS.start, { runId: 'r' }, parentAgent('P'))
  ctx.emit(SUBAGENT_EVENTS.end, null)
  ctx.emit(SUBAGENT_EVENTS.end, {})
  assert.equal(table.snapshot().size, 0)
})

test('事件名集中在 SUBAGENT_EVENTS 一处常量（事件类依赖无法探针化，靠集中 + 运行期佐证）', () => {
  assert.deepEqual(Object.keys(SUBAGENT_EVENTS).sort(), ['end', 'providerRemoved', 'start'])
  for (const v of Object.values(SUBAGENT_EVENTS)) assert.match(v, /^subagent\//)
})
