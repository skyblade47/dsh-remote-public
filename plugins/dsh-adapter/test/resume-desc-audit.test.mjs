// @local/dsh-adapter —— P3-U11-DESC：`listDescendants` **对照审计**单测
//
// 这一项**不是**判据，只是一次"先看清差多少再决定要不要换枚举路径"的对照。所以本文件锁的是两件事：
//   A. 差异算得对（只报"直接子代漏报"与"差异项里有未闭合的"，孙代不算漏报、diagnostic 单独计数）
//   B. ★**判据一个字都不因此改变**（candidates / openChildren 与不开对照时完全一致）
//   C. 成本有界：**无差异 ⇒ 零额外读**；差异大时只**抽样**判 turn（DESC_DELTA_LIMIT）
//   D. 能力缺失 / 抛错 / 返回非数组 ⇒ 只降级留痕，绝不影响 P1 判定
import test from 'node:test'
import assert from 'node:assert/strict'
import { prescanSessions, judgeCandidates, LAYER } from '../lib/resume/scan.js'
import {
  NOW, HOUR, turnStart, turnEnd, header, record, subagentRecord,
  mkSessionQuery, mkSubagent, mkSubagentWithDescendants, descendant, child, fakeCtx,
} from './_resume-fakes.mjs'

const WINDOW = 6 * HOUR

/** 父已闭合 + 子未闭合的标准 P1 场景；父/子/差异项的日志都要给全（否则末态读不出来） */
const baseLogs = () => ({
  'session-p': [turnStart(1), turnEnd(1, 'completed')], // 父：已闭合
  'child-1': [turnStart(2)],                            // 子：未闭合
})
const baseRecords = () => [record(header('session-p')), subagentRecord('child-1', 'session-p')]

const run = async ({ logs, records, childrenMap, descOpts = null, subagents = null } = {}) => {
  const svc = subagents || (descOpts
    ? mkSubagentWithDescendants(childrenMap || {}, descOpts)
    : mkSubagent(childrenMap || {}))
  const sessionQuery = mkSessionQuery({ records: records || baseRecords(), logs: logs || baseLogs() })
  const ctx = fakeCtx({ sessionQuery, subagents: svc })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })
  const p1 = judged.details.find((d) => d.sessionId === 'session-p')
  return { judged, p1, svc, sessionQuery }
}

test('能力不可用（宿主没有 listDescendants）⇒ source=unavailable，判据照常，stats 记 descAvailable=false', async () => {
  const { judged, p1 } = await run({ childrenMap: { 'session-p': [child('child-1')] } })
  assert.equal(p1.desc.source, 'unavailable')
  assert.equal(judged.stats.descAvailable, false)
  assert.equal(judged.stats.descCompared, 0, '没比较过就不该计入')
  assert.equal(judged.candidates.filter((c) => c.layer === LAYER.P1).length, 1, 'P1 照常产出')
})

test('★无差异 ⇒ **零额外读**（不该为审计白读一堆会话日志）', async () => {
  const { p1, sessionQuery } = await run({
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: { descendants: { 'session-p': [descendant('child-1', { depth: 1, parentId: 'session-p' })] } },
  })
  assert.equal(p1.desc.source, 'ok')
  assert.equal(p1.desc.rawCount, 1)
  assert.equal(p1.desc.onlyInDescDirectTotal, 0)
  assert.equal(p1.desc.onlyInDescDeeperTotal, 0)
  assert.equal(p1.desc.onlyInServiceTotal, 0)
  assert.equal(p1.desc.deltaTotal, 0)
  assert.equal(p1.desc.deltaChecked, 0, '差异为空 ⇒ 不进抽样循环')
  // 读次数 = 父自身 1 + 子 1，**不含**任何审计读
  assert.equal(sessionQuery.calls.read.length, 2, '无差异时不得多读（实际读到: ' + sessionQuery.calls.read.join(',') + '）')
})

test('★直接子代漏报：descendants 多出一条 depth=1 且未闭合 ⇒ 报漏报；但**判据不变**', async () => {
  const { judged, p1, sessionQuery } = await run({
    logs: { ...baseLogs(), 'child-missed': [turnStart(1)] }, // 被漏掉的那个子代：未闭合
    records: [...baseRecords(), subagentRecord('child-missed', 'session-p')],
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: {
      descendants: {
        'session-p': [
          descendant('child-1', { depth: 1, parentId: 'session-p' }),
          descendant('child-missed', { depth: 1, parentId: 'session-p' }),
        ],
      },
    },
  })
  // 差异被看见
  assert.equal(p1.desc.onlyInDescDirectTotal, 1)
  assert.equal(p1.desc.onlyInDescDirect[0].id, 'child-missed')
  assert.equal(p1.desc.onlyInDescDirect[0].depth, 1)
  assert.equal(p1.desc.deltaChecked, 1)
  assert.equal(p1.desc.deltaOpenTotal, 1, '差异项里那条确实是未闭合的')
  assert.equal(p1.desc.deltaOpen[0].id, 'child-missed')
  assert.equal(p1.desc.deltaOpen[0].kind, 'open')
  // ★判据不受影响：candidates 里仍然只有 listChildren 给的那个子代
  const p1c = judged.candidates.find((c) => c.layer === LAYER.P1)
  assert.deepEqual(p1c.openChildren.map((x) => x.id), ['child-1'], '对照审计**不得**把漏报项塞进判据')
  assert.equal(p1.childrenChecked, 1, 'childrenChecked 仍是 listChildren 那条路径的结果')
  assert.equal(judged.stats.descMissed, 1, '汇总里必须记到 1 例漏报（这是升级枚举路径的唯一依据）')
  assert.equal(judged.stats.descDeltaOpen, 1)
  // 抽样确实读了那一条差异项（父 + 子 + 漏报项）
  assert.equal(sessionQuery.calls.read.length, 3)
})

test('孙代（depth>1）**不算漏报**：计入 onlyInDescDeeperTotal，不计入 direct', async () => {
  const { p1 } = await run({
    logs: { ...baseLogs(), 'gc-1': [turnStart(3)] },
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: {
      descendants: {
        'session-p': [
          descendant('child-1', { depth: 1, parentId: 'session-p' }),
          descendant('gc-1', { depth: 2, parentId: 'child-1' }),
        ],
      },
    },
  })
  assert.equal(p1.desc.onlyInDescDirectTotal, 0, '孙代不是"漏了直接子代"')
  assert.equal(p1.desc.onlyInDescDeeperTotal, 1)
  assert.equal(p1.desc.maxDepth, 2)
  assert.equal(p1.desc.directCount, 1)
  assert.equal(p1.desc.childCount, 2)
  assert.equal(p1.desc.deltaTotal, 1)
})

test('diagnostic 行单独计数（descriptor 缺失/损坏的"无身份"行不该混进 child 计数）', async () => {
  const { p1 } = await run({
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: {
      descendants: {
        'session-p': [
          descendant('child-1', { depth: 1, parentId: 'session-p' }),
          descendant('child-broken', { depth: 1, parentId: 'session-p', kind: 'diagnostic', reason: 'corrupt' }),
        ],
      },
    },
  })
  assert.equal(p1.desc.rawCount, 2)
  assert.equal(p1.desc.childCount, 1)
  assert.equal(p1.desc.diagnosticCount, 1)
  assert.equal(p1.desc.onlyInDescDirectTotal, 1)
  assert.equal(p1.desc.onlyInDescDirect[0].diag, true, '差异样本要能看出它其实是 diagnostic')
})

test('反向差异：listChildren 给了、descendants 没给 ⇒ 计入 onlyInServiceTotal', async () => {
  const { p1 } = await run({
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: { descendants: { 'session-p': [] } }, // descendants 什么都没给
  })
  assert.equal(p1.desc.onlyInServiceTotal, 1)
  assert.equal(p1.desc.onlyInDescDirectTotal, 0)
  assert.equal(p1.desc.rawCount, 0)
})

test('★listChildren 返回空、descendants 非空 ⇒ 仍走 empty-children 分支，但**对照要照样做**', async () => {
  const { judged, p1 } = await run({
    logs: { ...baseLogs(), 'child-x': [turnStart(1)] },
    records: [...baseRecords(), subagentRecord('child-x', 'session-p')],
    childrenMap: { 'session-p': [] }, // 服务说没有子会话
    descOpts: { descendants: { 'session-p': [descendant('child-x', { depth: 1, parentId: 'session-p' })] } },
  })
  assert.equal(p1.verdict, 'empty-children', '判据仍是"空子会话"')
  assert.equal(p1.desc.source, 'ok', '但对照审计必须照样跑（这正是最值得看的场景）')
  assert.equal(p1.desc.onlyInDescDirectTotal, 1, '必须报出"后代树里其实有一个直接子代"')
  assert.equal(judged.stats.p1, 0, '判据未改：仍然不产生 P1 候选')
})

test('★抽样有界：差异 15 条 ⇒ deltaChecked 只到上限（不许把一轮扫描拖回分钟级）', async () => {
  const logs = { ...baseLogs() }
  const recs = [...baseRecords()]
  const desc = [descendant('child-1', { depth: 1, parentId: 'session-p' })]
  for (let i = 0; i < 15; i++) {
    logs['d-' + i] = [turnStart(1)]
    recs.push(subagentRecord('d-' + i, 'session-p'))
    desc.push(descendant('d-' + i, { depth: 6, parentId: 'p' + i })) // 全是深层，避免与 direct 语义混淆
  }
  const { p1 } = await run({
    logs, records: recs,
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: { descendants: { 'session-p': desc } },
  })
  assert.equal(p1.desc.deltaTotal, 15)
  assert.equal(p1.desc.deltaChecked, 10, '抽样上限必须生效')
  assert.equal(p1.desc.deltaOpenTotal, 10)
})

test('listDescendants 抛错 ⇒ source=failed + error；P1 判据不受影响（统计进 descFailed）', async () => {
  const { judged, p1 } = await run({
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: { descendantsThrows: true },
  })
  assert.equal(p1.desc.source, 'failed')
  assert.match(p1.desc.error, /descendants boom/)
  assert.equal(judged.stats.descFailed, 1)
  assert.equal(judged.stats.descCompared, 0)
  assert.equal(judged.candidates.filter((c) => c.layer === LAYER.P1).length, 1)
})

test('listDescendants 返回非数组 ⇒ source=failed（不抛）', async () => {
  const { p1 } = await run({
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: { descendantsNonArray: true },
  })
  assert.equal(p1.desc.source, 'failed')
  assert.match(p1.desc.error, /非数组/)
})

test('对照审计只在 p1-eval 路径跑（P0 会话不该为它多花一次宿主调用）', async () => {
  // 父自身未闭合 ⇒ 走 P0，提前 continue，不进 P1 的枚举分支
  const { judged, svc } = await run({
    logs: { 'session-p': [turnStart(9)] },
    records: [record(header('session-p'))],
    childrenMap: { 'session-p': [child('child-1')] },
    descOpts: { descendants: { 'session-p': [descendant('child-1', { depth: 1, parentId: 'session-p' })] } },
  })
  assert.equal(judged.candidates[0].layer, LAYER.P0)
  assert.deepEqual(svc.calls.listDescendants, [], 'P0 不该触发后代枚举')
})
