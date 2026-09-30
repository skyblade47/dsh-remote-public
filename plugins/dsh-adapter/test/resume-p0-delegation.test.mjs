// @local/dsh-adapter —— P0「前台委派被掐断」单测（2026-09-22 新增）
//
// 背景：前台委派（主对话**正等着**子代理）被重启掐断时，父会话的 turn **不会闭合**（它还在等），
// 于是只落 P0；而 `scope: tasks-only` 默认不唤醒 P0 ⇒ **这类会话永远不会被恢复**。
// 真数据里 P1 命中的 8 例父会话全是 closed（那是**后台委派**形态），前台形态此前完全没有覆盖。
//
// 本文件锁住的语义：
//   1. ★自身未闭合 **且**名下有未闭合子代 ⇒ `delegationInFlight:true`、层仍是 P0、primary=SUBAGENT
//   2. ★`scope: tasks-only` 下**放行**它；纯 P0（名下无未闭合子代）仍然只记审计
//   3. 排序：P1 → P0+在飞 → 纯 P0（maxResumePerBoot 截断时先丢噪声大的那类）
//   4. 幂等键走 `sub:<父>:<子>[:t<n>]`：**不同子代 ⇒ 不同键**（否则同一父会话日后再被掐断会静默不恢复）
//   5. 通知文案必须**同时**说清"上一轮被中断"与"当时在等子代理"（只说前者会让模型忽略被掐断的子任务）
//   6. ★判不了要留痕：两条子会话来源都不可用时**保守取纯 P0**（不猜、不唤醒），但必须写 skip 说明
//   7. childSource='headers' 兜底路径也能检出（不依赖 subagents 服务）
import test from 'node:test'
import assert from 'node:assert/strict'
import { prescanSessions, judgeCandidates, selectByLayer, LAYER } from '../lib/resume/scan.js'
import { resumeKeyFor, SIGNAL } from '../lib/resume/detect.js'
import { noticeTextFor } from '../lib/resume/index.js'
import {
  NOW, HOUR, turnStart, turnEnd, header, record, subagentRecord,
  mkSessionQuery, mkSubagent, mkSubagentWithDescendants, child, fakeCtx,
} from './_resume-fakes.mjs'

const WINDOW = 6 * HOUR

const run = async ({ logs, records, subagents } = {}) => {
  const ctx = fakeCtx({ sessionQuery: mkSessionQuery({ records, logs }), ...(subagents ? { subagents } : {}) })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })
  return { judged, pre }
}

/** 标准场景：父会话自身未闭合（在前台等子代理）+ 一个未闭合子代 */
const frontDelegation = () => ({
  logs: { 'session-p': [turnStart(1)], 'child-1': [turnStart(2)] },
  records: [record(header('session-p')), subagentRecord('child-1', 'session-p')],
  subagents: mkSubagent({ 'session-p': [child('child-1')] }),
})

test('★前台委派被掐断：自身未闭合 + 名下未闭合子代 ⇒ delegationInFlight=true（层仍是 P0）', async () => {
  const { judged } = await run(frontDelegation())
  const c = judged.candidates[0]
  assert.equal(c.layer, LAYER.P0, '层仍是 P0 —— 父的 turn 确实没闭合，不该被算成 P1')
  assert.equal(c.delegationInFlight, true)
  assert.equal(c.primary, SIGNAL.SUBAGENT, 'primary 取 SUBAGENT ⇒ 幂等键自动走 sub: 前缀')
  assert.deepEqual(c.openChildren.map((x) => x.id), ['child-1'])
  assert.equal(c.childId, 'child-1')
  assert.equal(c.childSource, 'service')
  assert.equal(judged.stats.p0InFlight, 1)
  assert.equal(judged.stats.p0, 0, '它不是"纯 P0"，不该被计进 p0')
  assert.equal(judged.stats.p1, 0)
  const d = judged.details.find((x) => x.sessionId === 'session-p')
  assert.equal(d.path, 'p0-with-delegation')
  assert.equal(d.delegationInFlight, true)
  assert.equal(d.openChildrenTotal, 1)
})

test('★tasks-only 下放行「P0+在飞委派」，纯 P0 仍只记审计', async () => {
  const { judged } = await run(frontDelegation())
  const strict = selectByLayer(judged.candidates, { scope: 'tasks-only', maxResume: 5 })
  assert.deepEqual(strict.resume.map((c) => c.sessionId), ['session-p'], '前台委派被掐断的会话**必须**能被唤醒')
  assert.equal(strict.skip.length, 0)

  // 对照：纯 P0（自身未闭合、名下**没有**未闭合子代）
  const plain = await run({
    logs: { 'session-q': [turnStart(1)], 'child-2': [turnStart(2), turnEnd(2)] },
    records: [record(header('session-q')), subagentRecord('child-2', 'session-q')],
    subagents: mkSubagent({ 'session-q': [child('child-2')] }),
  })
  const cq = plain.judged.candidates[0]
  assert.equal(cq.layer, LAYER.P0)
  assert.equal(cq.delegationInFlight, false, '子代都闭合了 ⇒ 不是在飞委派')
  assert.equal(plain.judged.stats.p0, 1)
  assert.equal(plain.judged.stats.p0InFlight, 0)
  const s2 = selectByLayer(plain.judged.candidates, { scope: 'tasks-only', maxResume: 5 })
  assert.equal(s2.resume.length, 0, '纯 P0 在 tasks-only 下仍不唤醒（噪声大于收益）')
  assert.match(s2.skip[0].reason, /纯 P0/)
  // scope=all 才带上纯 P0
  assert.deepEqual(selectByLayer(plain.judged.candidates, { scope: 'all', maxResume: 5 }).resume.map((c) => c.sessionId), ['session-q'])
})

test('★排序：P1 → P0+在飞委派 → 纯 P0（截断时先丢噪声大的那类）', async () => {
  const logs = {
    'session-p1': [turnStart(1), turnEnd(1)],  // 父已闭合 + 子未闭合 ⇒ P1
    'session-pf': [turnStart(1)],              // 父未闭合 + 子未闭合 ⇒ P0+在飞
    'session-p0': [turnStart(1)],              // 父未闭合、无在飞子代 ⇒ 纯 P0
    'child-a': [turnStart(2)],
    'child-b': [turnStart(2)],
    'child-c': [turnStart(2), turnEnd(2)],
  }
  const records = [
    record(header('session-p1')), record(header('session-pf')), record(header('session-p0')),
    subagentRecord('child-a', 'session-p1'), subagentRecord('child-b', 'session-pf'), subagentRecord('child-c', 'session-p0'),
  ]
  const { judged } = await run({
    logs, records,
    subagents: mkSubagent({ 'session-p1': [child('child-a')], 'session-pf': [child('child-b')], 'session-p0': [child('child-c')] }),
  })
  assert.deepEqual(
    judged.candidates.map((c) => c.sessionId),
    ['session-p1', 'session-pf', 'session-p0'],
    'P1 最前、P0+在飞居中、纯 P0 最后',
  )
  // 只留 1 个名额时，必须留下 P1（最明确的那类）
  const one = selectByLayer(judged.candidates, { scope: 'tasks-only', maxResume: 1 })
  assert.deepEqual(one.resume.map((c) => c.sessionId), ['session-p1'])
})

test('★幂等键：P0+在飞 走 sub: 前缀，且**不同子代 ⇒ 不同键**', async () => {
  const a = await run({
    logs: { 'session-p': [turnStart(1)], 'child-1': [turnStart(2)] },
    records: [record(header('session-p')), subagentRecord('child-1', 'session-p')],
    subagents: mkSubagent({ 'session-p': [child('child-1')] }),
  })
  const b = await run({
    logs: { 'session-p': [turnStart(1)], 'child-9': [turnStart(7)] },
    records: [record(header('session-p')), subagentRecord('child-9', 'session-p')],
    subagents: mkSubagent({ 'session-p': [child('child-9')] }),
  })
  const k1 = resumeKeyFor(a.judged.candidates[0])
  const k2 = resumeKeyFor(b.judged.candidates[0])
  assert.equal(k1, 'sub:session-p:child-1:t2')
  assert.equal(k2, 'sub:session-p:child-9:t7')
  assert.notEqual(k1, k2, '同一父会话的不同在飞子代必须各记一条 —— 否则日后再被掐断会静默不恢复')
})

test('★通知文案：必须同时说清"上一轮被中断"与"当时在等子代理"', async () => {
  const { judged } = await run(frontDelegation())
  const text = noticeTextFor(judged.candidates[0])
  assert.match(text, /在等子代理/, '不点明"当时在等子代理"，模型会以为可以从中断处接着写')
  assert.match(text, /child-1/, '要带上被掐断的子代 id')
  assert.match(text, /in-flight-children="1"/)
  assert.match(text, /不会自动冷恢复子代理/)

  // 对照：纯 P0 的文案**不该**出现"在等子代理"
  const plain = await run({
    logs: { 'session-q': [turnStart(3)] },
    records: [record(header('session-q'))],
  })
  const t2 = noticeTextFor(plain.judged.candidates[0])
  assert.doesNotMatch(t2, /在等子代理/)
  assert.match(t2, /turn #3/)
})

test('★判不了要留痕：两条子会话来源都不可用 ⇒ 保守取纯 P0 + 写 skip 说明', async () => {
  const { judged } = await run({
    logs: { 'session-q': [turnStart(1)] },
    records: [record(header('session-q'))], // 没有 subagent header ⇒ childrenByParent 为空
  })
  const c = judged.candidates[0]
  assert.equal(c.layer, LAYER.P0)
  assert.equal(c.delegationInFlight, false, '判不了就不许猜"有在飞委派"')
  assert.equal(judged.stats.childSource, 'none')
  const note = judged.skipped.find((s) => s.sessionId === 'session-q' && /判不了/.test(s.reason))
  assert.ok(note, '"该唤醒的没唤醒"绝不能是静默的')
  assert.match(note.reason, /可能漏掉前台委派被掐断的会话/)
})

test('header 兜底路径也能检出 P0+在飞委派（不依赖 subagents 服务）', async () => {
  const { judged } = await run({
    logs: { 'session-p': [turnStart(1)], 'child-1': [turnStart(2)] },
    records: [record(header('session-p')), subagentRecord('child-1', 'session-p')],
    // 刻意不给 subagents 服务
  })
  const c = judged.candidates[0]
  assert.equal(c.delegationInFlight, true)
  assert.equal(c.childSource, 'headers')
  assert.deepEqual(c.openChildren.map((x) => x.id), ['child-1'])
})

test('cost 边界：P0 路径**不**触发 listDescendants 对照审计（那是 P1 专属）', async () => {
  const subagents = mkSubagentWithDescendants(
    { 'session-p': [child('child-1')] },
    { descendants: { 'session-p': [] } },
  )
  const { judged } = await run({
    logs: { 'session-p': [turnStart(1)], 'child-1': [turnStart(2)] },
    records: [record(header('session-p')), subagentRecord('child-1', 'session-p')],
    subagents,
  })
  assert.equal(judged.candidates[0].delegationInFlight, true)
  assert.equal(judged.stats.descCompared, 0, 'P0+在飞委派不该为对照审计多花一次宿主调用')
  assert.deepEqual(subagents.calls.listDescendants, [], '一次都不该调')
  const d = judged.details.find((x) => x.sessionId === 'session-p')
  assert.equal(d.desc, undefined, 'P0 明细不带 desc 字段')
})

test('未闭合子代有多个时：childId 取第一个、openChildren 全量带上（但审计截断到 10 条）', async () => {
  const logs = { 'session-p': [turnStart(1)] }
  const recs = [record(header('session-p'))]
  const kids = []
  for (let i = 0; i < 12; i++) {
    logs['c' + i] = [turnStart(2)]
    recs.push(subagentRecord('c' + i, 'session-p'))
    kids.push(child('c' + i))
  }
  const { judged } = await run({ logs, records: recs, subagents: mkSubagent({ 'session-p': kids }) })
  const c = judged.candidates[0]
  assert.equal(c.delegationInFlight, true)
  assert.equal(c.openChildren.length, 12, '候选里带全量（唤醒文案要用）')
  const d = judged.details.find((x) => x.sessionId === 'session-p')
  assert.equal(d.openChildrenTotal, 12)
  assert.equal(d.openChildren.length, 10, '审计明细必须**有界**（截断到 10）')
})
