// @local/dsh-adapter —— 重启自恢复：候选识别单测（纯函数，无需宿主）
//
// 迁入来源：`plugins/resume-on-boot/test/detect.test.mjs`（用例语义保持不变，import 路径改到 lib/resume/）。
// 覆盖 P3 §Phase 1B 点名的用例：①正常闭合 ②未闭合 ③interrupted ④空事件 ⑤只有 start
// 外加 D2（信号合并与优先级）、D3（幂等键）、D4（scope 与上限）、D6（`sub:<parentId>` 键）的锁定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { lastTurnState, collectCandidates, resumeKeyFor, selectResumable, SIGNAL } from '../lib/resume/detect.js'

const tStart = (turn) => ({ type: 'turn/start', data: { turn } })
const tEnd = (turn, kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const other = () => ({ type: 'message/user', data: {} })

test('lastTurnState ①正常闭合：最后是 completed 的 turn/end → closed', () => {
  const r = lastTurnState([tStart(1), other(), tEnd(1, 'completed')])
  assert.equal(r.kind, 'closed')
  assert.equal(r.unfinished, false)
  assert.equal(r.turn, 1)
  assert.equal(r.reasonKind, 'completed')
})

test('lastTurnState ②未闭合：最后是 turn/start → open', () => {
  const r = lastTurnState([tStart(1), tEnd(1, 'completed'), tStart(2), other()])
  assert.equal(r.kind, 'open')
  assert.equal(r.unfinished, true)
  assert.equal(r.turn, 2)
})

test('lastTurnState ③interrupted：内核重启自动补的收尾 → 仍算未完成', () => {
  const r = lastTurnState([tStart(3), tEnd(3, 'interrupted')])
  assert.equal(r.kind, 'interrupted')
  assert.equal(r.unfinished, true)
  assert.equal(r.reasonKind, 'interrupted')
})

test('lastTurnState ④空事件 / 非数组 / 无 turn 边界 → none', () => {
  for (const input of [[], null, undefined, 'x', [other(), other()]]) {
    const r = lastTurnState(input)
    assert.equal(r.kind, 'none', 'input=' + JSON.stringify(input))
    assert.equal(r.unfinished, false)
  }
})

test('lastTurnState ⑤只有 start，且忽略乱序/缺字段的脏事件', () => {
  assert.equal(lastTurnState([tStart(7)]).kind, 'open')
  // 缺 turn 编号不该抛，也不该被算成数字
  const r = lastTurnState([{ type: 'turn/start', data: {} }])
  assert.equal(r.kind, 'open')
  assert.equal(r.turn, null)
})

test('collectCandidates：同一会话多信号合并，primary 优先级 task > goal > turn', () => {
  const c = collectCandidates({
    turnSignals: [{ sessionId: 's1', turn: 5 }, { sessionId: 's2', turn: 1 }],
    goals: [{ sessionId: 's1', goalId: 'g1' }],
    tasks: [{ sessionId: 's1', taskId: 't1' }],
  })
  const s1 = c.find((x) => x.sessionId === 's1')
  const s2 = c.find((x) => x.sessionId === 's2')
  assert.deepEqual(s1.signals.sort(), [SIGNAL.GOAL, SIGNAL.TASK, SIGNAL.TURN])
  assert.equal(s1.primary, SIGNAL.TASK)
  assert.equal(s2.primary, SIGNAL.TURN)
  assert.equal(s2.goalId, null)
})

test('collectCandidates：字符串形式的目标/任务也接受；空输入返回空数组', () => {
  const c = collectCandidates({ goals: ['s9'], tasks: ['s9'] })
  assert.equal(c.length, 1)
  assert.equal(c[0].primary, SIGNAL.TASK)
  assert.deepEqual(collectCandidates({}), [])
  assert.deepEqual(collectCandidates(), [])
})

test('resumeKeyFor（D3）：键必须区分"这一次未结束"，不能只有 sessionId', () => {
  assert.equal(resumeKeyFor({ primary: SIGNAL.TASK, taskId: 't1' }), 'task:t1')
  assert.equal(resumeKeyFor({ primary: SIGNAL.GOAL, goalId: 'g1' }), 'goal:g1')
  assert.equal(resumeKeyFor({ primary: SIGNAL.TURN, turn: 4 }), 'turn:4')
  // 同一会话的两次中断 → 两个不同的键（这正是 D3 要保证的）
  const first = resumeKeyFor({ primary: SIGNAL.TURN, turn: 4 })
  const second = resumeKeyFor({ primary: SIGNAL.TURN, turn: 9 })
  assert.notEqual(first, second)
  assert.equal(resumeKeyFor(null), null)
})

test('resumeKeyFor（D6）：P1 键带子会话 id，且与 P0 的 `turn:<n>` 互不遮蔽', () => {
  const p1 = resumeKeyFor({ sessionId: 'session-p', layer: 'P1', primary: SIGNAL.SUBAGENT, childId: '053f471b', turn: 3 })
  assert.equal(p1, 'sub:session-p:053f471b:t3', 'P1 的键记在**父会话**上，且必须带子会话 id')
  const p0 = resumeKeyFor({ sessionId: 'session-p', layer: 'P0', primary: SIGNAL.TURN, turn: 3 })
  assert.equal(p0, 'turn:3')
  assert.notEqual(p1, p0, '同一个父会话，P1 与 P0 必须是两个不同的键')

  // **本次修正的核心**：换成另一个被掐断的子会话，键必须不同 ——
  // 否则同一父会话日后再次被掐断时会被判"已处理"而静默不恢复。
  const p1b = resumeKeyFor({ sessionId: 'session-p', layer: 'P1', primary: SIGNAL.SUBAGENT, childId: '9abc1234', turn: 3 })
  assert.notEqual(p1b, p1, '不同子会话必须得到不同键（否则父会话永远只被唤醒一次）')
  // 子会话 turn 为空（one-shot 常态）时退化为"父 + 子"键，而不是拼出 ':tundefined'
  assert.equal(resumeKeyFor({ sessionId: 'session-p', layer: 'P1', primary: SIGNAL.SUBAGENT, childId: 'c1' }), 'sub:session-p:c1')
  // 只有 openChildren 没有 childId 时也要能取到子会话 id
  assert.equal(
    resumeKeyFor({ sessionId: 'session-p', layer: 'P1', primary: SIGNAL.SUBAGENT, openChildren: [{ id: 'c9', turn: null }] }),
    'sub:session-p:c9',
  )

  // 只给 primary（没有 layer）也要能识别出 P1 语义
  assert.equal(resumeKeyFor({ sessionId: 'session-x', primary: SIGNAL.SUBAGENT }).startsWith('sub:session-x:'), true)
  // 缺 id 时退化为占位，绝不拼出 'sub:undefined'
  assert.equal(resumeKeyFor({ layer: 'P1', primary: SIGNAL.SUBAGENT }), 'sub:?:?')
})

test('selectResumable（D4）：默认 tasks-only —— 只有 turn/goal 信号的进 skip 而不是被唤醒', () => {
  const cands = collectCandidates({
    turnSignals: [{ sessionId: 'only-turn', turn: 1 }],
    goals: [{ sessionId: 'only-goal', goalId: 'g' }],
    tasks: [{ sessionId: 'has-task', taskId: 't' }],
  })
  const { resume, skip } = selectResumable(cands)
  assert.deepEqual(resume.map((r) => r.sessionId), ['has-task'])
  assert.equal(skip.length, 2)
  assert.ok(skip.every((s) => s.reason.includes('tasks-only')))
})

test('selectResumable：scope=all 时 S1/S2 也唤醒；maxResume 上限生效并给出原因', () => {
  const cands = collectCandidates({
    turnSignals: [{ sessionId: 'a', turn: 1 }, { sessionId: 'b', turn: 2 }],
    tasks: [{ sessionId: 'c', taskId: 't' }],
  })
  assert.equal(selectResumable(cands, { scope: 'all' }).resume.length, 3)
  assert.equal(selectResumable(cands, { scope: 'all' }).skip.length, 0)

  const capped = selectResumable(cands, { scope: 'all', maxResume: 2 })
  assert.equal(capped.resume.length, 2)
  assert.equal(capped.skip.length, 1)
  assert.ok(capped.skip[0].reason.includes('maxResumePerBoot'))
})

test('selectResumable：空/异常输入不抛', () => {
  assert.deepEqual(selectResumable(null).resume, [])
  assert.deepEqual(selectResumable(undefined).skip, [])
})
