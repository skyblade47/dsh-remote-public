// @local/dsh-adapter —— 重启自恢复：扫描与分层判据单测（P3 §2B 两级扫描 + §2D D6 分层）
//
// 锁住的语义（对应 P3 计划与任务规格）：
//   1. 一级预筛：窗口内保留、窗口外剔除，且 **mtime 完全不参与判定**
//   2. 降级链（U8 四级）：**尾帧最后事件时间**（tail）→ 投影 lastPromptAt → header.createdAt → 跳过
//   3. ★U7b 回归：createdAt 很旧但尾帧很新 ⇒ **必须**是 survivor 且 source='tail'（闸门不许套在创建时间上）
//   4. P1 优先于 P0：父已闭合 + 子未闭合 ⇒ 识别为 P1 且**目标=父会话**
//   5. P1 的父会话不会被 P0 重复产出（去重）；子会话本身永不作为唤醒目标
//   6. ★服务名是**复数** `subagents`（内核 `super(ctx, "subagents")`）：只给复数名时 P1 必须跑通；
//      只给旧的单数名时也要跑通（版本漂移余量）；两条来源都不行才跳过，且 P0 不受影响
//   7. ★P1 的兜底来源：完全没有 subagents 服务时，仅靠 header（origin/parentSession）也要识别出 P1，
//      并在 stats.candidates 里标明 `childSource: 'service' | 'headers' | 'none'`
//   8. subagents 的 activity **不得**当"在途"判据（重启后一律 inactive）
//   + scope 分支（tasks-only 只出 P1 / all 出 P1+P0）与 maxResumePerBoot 截断
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { prescanSessions, judgeCandidates, selectByLayer, pickLastActiveInWindow, isSubagentSession, LAYER } from '../lib/resume/scan.js'
import { buildSessionFileIndex, DEFAULT_MAX_TAIL_TAIL } from '../lib/resume/tail.js'
import {
  NOW, HOUR, turnStart, turnEnd, header, record, subagentRecord,
  mkSessionQuery, mkProjection, mkSubagent, child, fakeCtx,
  zstdFrame, writeSessionFile, timedEvent, mkTempHome,
} from './_resume-fakes.mjs'

const WINDOW = 6 * HOUR
const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('一级预筛：窗口内保留、窗口外剔除，**且 mtime 不参与判定**（无会话文件 ⇒ 退到降级链的第 2/3 级）', async () => {
  const logs = {}
  const sessionQuery = mkSessionQuery({
    records: [
      record(header('session-a')), // createdAt 1h 前 ⇒ 窗口内（header.mtime 是 NOW，但来源仍是 createdAt）
      record(header('session-b', { createdAt: NOW - 100 * HOUR })), // 都超窗 ⇒ 剔除（mtime 是 NOW 也不放行）
      record(header('session-c', { createdAt: NOW - 100 * HOUR })), // 投影 lastPromptAt 1h 前 ⇒ 救回
    ],
    logs,
  })
  // 缓存行用真机的 `{ver, seq, val}` 形状，验证 val 解包
  const projection = mkProjection({ 'session-c': { ver: 3, seq: 42, val: { lastPromptAt: NOW - 1 * HOUR } } })

  const r = await prescanSessions({
    ctx: fakeCtx({ sessionQuery, sessionProjectionCache: projection }),
    now: () => NOW, recentWindowMs: WINDOW,
  })

  assert.equal(r.ok, true)
  assert.equal(r.total, 3)
  assert.deepEqual(r.survivors.map((s) => s.sessionId).sort(), ['session-a', 'session-c'])
  const a = r.survivors.find((s) => s.sessionId === 'session-a')
  const c = r.survivors.find((s) => s.sessionId === 'session-c')
  assert.equal(a.lastActiveSource, 'createdAt', '无尾帧、无投影 ⇒ 走降级链第 3 级')
  assert.equal(c.lastActiveSource, 'lastPromptAt', '有投影 ⇒ 用投影的 lastPromptAt（第 2 级）')
  assert.equal(a.header.mtime, NOW, '（前提）a 的 mtime 是"新鲜的"')
  assert.equal(c.header.mtime, NOW, '（前提）c 的 mtime 是"新鲜的"')

  const b = r.skipped.find((s) => s.sessionId === 'session-b')
  assert.ok(b, '窗口外的会话必须出现在 skipped 里（供调用方写审计）')
  assert.match(b.reason, /window-out/)
  assert.equal(b.lastActiveSource, 'createdAt')
  assert.equal(b.hasProjection, false)
  assert.equal(b.header, undefined, '审计项不得夹带整个 header（避免审计爆量）')

  // 没有 dshHome / 会话文件 ⇒ tail 那级整轮不可用，但**必须如实记数**（否则下次坏了看不出来）
  assert.equal(r.stats.indexSize, 0)
  assert.equal(r.stats.sources.tail, 0)
  assert.equal(r.stats.tailNoFile, 3)
  assert.equal(r.stats.tailFailed, 0)

  assert.equal(sessionQuery.calls.read.length, 0, '一级预筛**绝不读日志**（554 个会话读不起）')
})

test('★U7b 回归：header.createdAt 很旧（26 天前创建）但尾帧很新 ⇒ **必须是 survivor 且 lastActiveSource=tail**', async () => {
  const home = mkTempHome()
  try {
    const id = 'session-touched-this-morning'
    const lastActive = NOW - 5 * 60 * 1000
    // 会话是"26 天前创建、今早才活跃过"的那一类 —— 最该被唤醒，旧链（createdAt 当闸门）会把它误杀
    writeSessionFile(home, id, [
      zstdFrame([turnStart(1)]),
      zstdFrame([timedEvent(lastActive, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })]),
    ])
    const sessionQuery = mkSessionQuery({ records: [record(header(id, { createdAt: NOW - 26 * 24 * HOUR }))], logs: {} })

    const r = await prescanSessions({
      ctx: fakeCtx({ sessionQuery, sessionProjectionCache: mkProjection({}) }),
      dshHome: home, now: () => NOW, recentWindowMs: WINDOW,
    })

    assert.deepEqual(r.survivors.map((s) => s.sessionId), [id],
      '旧链会把它判成 window-out（createdAt 在 26 天前）⇒ 这正是 U7b 的坏法，必须防复发')
    assert.equal(r.survivors[0].lastActiveSource, 'tail')
    assert.equal(r.survivors[0].lastActiveAt, lastActive)
    assert.equal(r.survivors[0].lastEventType, 'turn/end')
    assert.equal(r.stats.sources.tail, 1, '来源分布必须一眼可见：这条必须记在 tail 名下')
    assert.equal(r.stats.sources.createdAt, 0)
    assert.equal(r.stats.indexSize, 1, 'dshHome 传进去了 ⇒ 会话文件索引非空')
    assert.equal(r.stats.tailFailed, 0)
    assert.equal(sessionQuery.calls.read.length, 0, '一级预筛绝不读完整日志（只读尾几 KB）')

    // 反向对照：这就是被否掉的旧链 —— 只看 createdAt 会得到"窗口外"
    const oldChain = pickLastActiveInWindow({ lastPromptAt: null, createdAt: NOW - 26 * 24 * HOUR }, { now: NOW, windowMs: WINDOW })
    assert.equal(oldChain.inWindow, false)
  } finally { cleanup(home) }
})

test('尾帧读取失败 ⇒ 降级到 lastPromptAt / createdAt，且审计**如实记来源**（不许假装是 tail）', async () => {
  const home = mkTempHome()
  try {
    // 两个会话都有文件，但文件里不是 zstd（模拟快照损坏/被截断成垃圾）
    writeSessionFile(home, 'session-x', Buffer.from('这不是 zstd 帧'))
    writeSessionFile(home, 'session-y', Buffer.from('这也不是'))
    const records = [
      record(header('session-x', { createdAt: NOW - 26 * 24 * HOUR })), // createdAt 超窗，只有投影能救
      record(header('session-y')), // createdAt 在窗口内
    ]
    const ctx = fakeCtx({
      sessionQuery: mkSessionQuery({ records, logs: {} }),
      sessionProjectionCache: mkProjection({ 'session-x': { ver: 1, seq: 1, val: { lastPromptAt: NOW - 2 * HOUR } } }),
    })
    const r = await prescanSessions({ ctx, dshHome: home, now: () => NOW, recentWindowMs: WINDOW })

    const x = r.survivors.find((s) => s.sessionId === 'session-x')
    const y = r.survivors.find((s) => s.sessionId === 'session-y')
    assert.equal(x.lastActiveSource, 'lastPromptAt', '尾帧不可用 ⇒ 第 2 级兜住')
    assert.equal(y.lastActiveSource, 'createdAt', '尾帧不可用、无投影 ⇒ 第 3 级兜住')
    assert.equal(r.stats.sources.tail, 0)
    assert.equal(r.stats.sources.lastPromptAt, 1)
    assert.equal(r.stats.sources.createdAt, 1)
    assert.equal(r.stats.tailFailed, 2, '两个会话都定位到了文件但尾帧解不出 ⇒ 必须如实计入 tailFailed')
    assert.equal(r.stats.tailNoFile, 0)

    // 反向：尾帧读不出来时**绝不能**被当成"窗口外"或"已唤醒"
    assert.equal(r.skipped.filter((s) => s.sessionId === 'session-x').length, 0)
  } finally { cleanup(home) }
})

test('三个来源都超窗 ⇒ skip + window-out 审计（带 lastActiveSource/lastActiveAt/lastEventType/windowMs/now）', async () => {
  const home = mkTempHome()
  try {
    const id = 'session-all-old'
    const tailTime = NOW - 40 * 24 * HOUR
    writeSessionFile(home, id, [zstdFrame([timedEvent(tailTime, { type: 'turn/end' })])])
    const ctx = fakeCtx({
      sessionQuery: mkSessionQuery({ records: [record(header(id, { createdAt: NOW - 40 * 24 * HOUR }))], logs: {} }),
      sessionProjectionCache: mkProjection({ [id]: { lastPromptAt: NOW - 30 * 24 * HOUR } }),
    })
    const r = await prescanSessions({ ctx, dshHome: home, now: () => NOW, recentWindowMs: WINDOW })

    assert.deepEqual(r.survivors, [])
    assert.equal(r.skipped.length, 1)
    const s = r.skipped[0]
    assert.equal(s.sessionId, id)
    assert.match(s.reason, /window-out/)
    assert.equal(s.lastActiveAt, tailTime, '如实报优先级最高的那个来源的时间')
    assert.equal(s.lastActiveSource, 'tail', '三级都能取到 ⇒ 记优先级最高的来源（便于按真数据回调窗口）')
    assert.equal(s.lastEventType, 'turn/end')
    assert.equal(s.windowMs, WINDOW)
    assert.equal(s.now, NOW)
    assert.equal(s.hasProjection, true)
    assert.equal(s.hasSessionFile, true)
    assert.equal(s.header, undefined)
    assert.equal(r.stats.sources.tail, 1, '来源分布：决策来源记 tail')
    assert.equal(r.stats.tailFailed, 0)
    assert.ok(r.stats.durationMs >= 0)
  } finally { cleanup(home) }
})

test('尾帧命中窗口 ⇒ **不去碰投影缓存**（U8 的成本主张：不再依赖缓存是否水合）', async () => {
  const home = mkTempHome()
  try {
    const fresh = 'session-fresh'
    const noFile = 'session-nofile'
    writeSessionFile(home, fresh, [zstdFrame([timedEvent(NOW - 60 * 1000)])])
    let projectionCalls = 0
    const projection = { cachedSnapshot: () => { projectionCalls++; return null } }
    const ctx = fakeCtx({
      sessionQuery: mkSessionQuery({ records: [record(header(fresh)), record(header(noFile, { createdAt: NOW - 26 * 24 * HOUR }))], logs: {} }),
      sessionProjectionCache: projection,
    })
    const r = await prescanSessions({ ctx, dshHome: home, now: () => NOW, recentWindowMs: WINDOW })

    assert.deepEqual(r.survivors.map((s) => s.sessionId), [fresh])
    assert.equal(r.stats.sources.tail, 1)
    assert.equal(projectionCalls, 1, '只有"尾帧没命中"的那一个会话才去问投影缓存（尾帧命中的不碰）')
  } finally { cleanup(home) }
})

test('降级链第 4 级：三个来源都取不到 ⇒ 跳过（不抛、不进幸存者，来源记 none）', async () => {
  const sessionQuery = mkSessionQuery({
    records: [record({ id: 'session-nothing', mtime: NOW })], // 既无 createdAt、也无尾帧、也无投影
    logs: {},
  })
  const r = await prescanSessions({ ctx: fakeCtx({ sessionQuery }), now: () => NOW, recentWindowMs: WINDOW })
  assert.deepEqual(r.survivors, [])
  assert.equal(r.skipped.length, 1)
  assert.equal(r.skipped[0].lastActiveSource, 'none')
  assert.equal(r.skipped[0].lastActiveAt, null)
  assert.equal(r.stats.sources.none, 1)
})

test('降级链优先级：tail > lastPromptAt > createdAt；在窗口内的取"优先级最高的那个"', () => {
  // tail 在窗口内 ⇒ 一律用 tail（哪怕 createdAt 更新也是 tail 说了算：它才是真活跃时间）
  const byTail = pickLastActiveInWindow(
    { tailTime: NOW - 1 * HOUR, lastPromptAt: NOW - 2 * HOUR, createdAt: NOW - 1 * HOUR },
    { now: NOW, windowMs: WINDOW },
  )
  assert.equal(byTail.inWindow, true)
  assert.equal(byTail.source, 'tail')
  assert.equal(byTail.at, NOW - 1 * HOUR)

  // tail 超窗、lastPromptAt 在窗口内 ⇒ 用 lastPromptAt（第 2 级）
  const byProjection = pickLastActiveInWindow(
    { tailTime: NOW - 100 * HOUR, lastPromptAt: NOW - 1 * HOUR, createdAt: NOW - 100 * HOUR },
    { now: NOW, windowMs: WINDOW },
  )
  assert.equal(byProjection.inWindow, true)
  assert.equal(byProjection.source, 'lastPromptAt')

  // 前两级都超窗、createdAt 在窗口内 ⇒ 用 createdAt（第 3 级）
  const byCreated = pickLastActiveInWindow(
    { tailTime: NOW - 100 * HOUR, lastPromptAt: NOW - 100 * HOUR, createdAt: NOW - 1 * HOUR },
    { now: NOW, windowMs: WINDOW },
  )
  assert.equal(byCreated.inWindow, true)
  assert.equal(byCreated.source, 'createdAt')

  // 三级都有值但都超窗 ⇒ inWindow=false，且如实报优先级最高的来源（不是"随便挑一个"）
  const allOut = pickLastActiveInWindow(
    { tailTime: NOW - 30 * HOUR, lastPromptAt: NOW - 40 * HOUR, createdAt: NOW - 50 * HOUR },
    { now: NOW, windowMs: WINDOW },
  )
  assert.equal(allOut.inWindow, false)
  assert.equal(allOut.source, 'tail')
  assert.equal(allOut.at, NOW - 30 * HOUR)

  const out = pickLastActiveInWindow({ lastPromptAt: undefined, createdAt: undefined }, { now: NOW, windowMs: WINDOW })
  assert.equal(out.inWindow, false)
  assert.equal(out.source, 'none')
  assert.equal(out.at, null)
})

test('P1：父会话已闭合 + 子会话未闭合 ⇒ 识别为 P1 且**目标是父会话**；且 P1 排在 P0 之前', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')], // 父：自身已闭合
    '053f471b-child': [turnStart(2)], // 子：未闭合
    'session-q': [turnStart(1), turnEnd(1, 'completed'), turnStart(2)], // 自身未闭合 ⇒ P0
  }
  const sessionQuery = mkSessionQuery({
    records: [
      record(header('session-p')),
      record(header('session-q')),
      subagentRecord('053f471b-child', 'session-p'), // 子会话也在列表里（真机如此）
    ],
    logs,
  })
  const ctx = fakeCtx({
    sessionQuery,
    sessionProjectionCache: mkProjection({}),
    subagents: mkSubagent({ 'session-p': [child('053f471b-child')] }),
  })

  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  // 子会话：绝不作为唤醒目标（没有用户来源，自己跑不起来），在预筛阶段就被剔除
  assert.ok(pre.skipped.some((s) => s.sessionId === '053f471b-child' && /subagent/.test(s.reason)))
  assert.deepEqual(pre.survivors.map((s) => s.sessionId).sort(), ['session-p', 'session-q'])

  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, now: () => NOW })
  assert.equal(judged.subagentAvailable, true)
  assert.deepEqual(judged.candidates.map((c) => c.layer), [LAYER.P1, LAYER.P0], 'P1 必须排在 P0 之前')

  const p1 = judged.candidates.find((c) => c.layer === LAYER.P1)
  assert.equal(p1.sessionId, 'session-p', 'P1 的唤醒目标是**父会话**（不是子会话）')
  assert.equal(p1.childId, '053f471b-child')
  assert.deepEqual(p1.openChildren.map((x) => x.id), ['053f471b-child'])
  assert.equal(p1.openChildren[0].kind, 'open')

  // 去重：同一个父会话只产出一条候选，且是 P1（父自身已闭合 ⇒ 不可能同时是 P0）
  assert.equal(judged.candidates.filter((c) => c.sessionId === 'session-p').length, 1)
  assert.equal(judged.stats.p1, 1)
  assert.equal(judged.stats.p0, 1)

  // scope 分支（D4 + §2D D5）：tasks-only 本轮只跑 P1；all 才 P1+P0
  const only = selectByLayer(judged.candidates, { scope: 'tasks-only', maxResume: 5 })
  assert.deepEqual(only.resume.map((c) => c.sessionId), ['session-p'])
  assert.equal(only.skip.length, 1)
  assert.match(only.skip[0].reason, /tasks-only/)

  const all = selectByLayer(judged.candidates, { scope: 'all', maxResume: 5 })
  assert.deepEqual(all.resume.map((c) => c.sessionId), ['session-p', 'session-q'], 'P1 仍在 P0 之前')
})

test('P1 只在"自身已闭合"时成立：子会话末态已闭合 ⇒ 不产出 P1（父会话被放过）', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')],
    'child-closed': [turnStart(2), turnEnd(2, 'completed')],
    // ⚠️ 重启后 activity 一律 inactive；这里刻意给 'running' 反证"绝不能用 activity 当在途判据"
    'child-running-but-closed': [turnStart(3), turnEnd(3, 'completed')],
  }
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-p'))], logs }),
    subagents: mkSubagent({ 'session-p': [child('child-closed'), child('child-running-but-closed', { activity: 'running' })] }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, now: () => NOW })
  assert.deepEqual(judged.candidates, [], '子会话已闭合（哪怕 activity=running）都不是候选')
})

test('★服务名复数：假宿主只提供 subagents（不给 subagent）⇒ P1 必须跑通并识别出候选', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')], // 父：自身已闭合
    'child-1': [turnStart(2)], // 子：未闭合
  }
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({
      records: [record(header('session-p')), subagentRecord('child-1', 'session-p')],
      logs,
    }),
    subagents: mkSubagent({ 'session-p': [child('child-1')] }), // ⚠️ 只有复数名（内核就是这个）
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })

  assert.equal(judged.stats.subagentAvailable, true, '复数 subagents 必须被取到（真机写成单数 ⇒ 这里恒 false、P1 整层静默跳过）')
  const p1 = judged.candidates.find((c) => c.layer === LAYER.P1)
  assert.ok(p1, '复数服务名下 P1 必须产出候选')
  assert.equal(p1.sessionId, 'session-p', '唤醒目标=父会话')
  assert.equal(p1.childId, 'child-1')
  assert.equal(p1.childSource, 'service', '走了服务路径就要如实标明')
  assert.equal(judged.stats.childSource, 'service')

  // 版本漂移余量：只提供旧的单数名也必须能跑通（scan.js 复数优先、单数兜底）
  const legacyCtx = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-p')), subagentRecord('child-1', 'session-p')], logs }),
    subagent: mkSubagent({ 'session-p': [child('child-1')] }),
  })
  const pre2 = await prescanSessions({ ctx: legacyCtx, now: () => NOW, recentWindowMs: WINDOW })
  const judged2 = await judgeCandidates({ ctx: legacyCtx, survivors: pre2.survivors, now: () => NOW })
  assert.equal(judged2.stats.subagentAvailable, true, '单数名作为兜底仍可用（对新旧内核都留余量）')
  assert.equal(judged2.stats.p1, 1)
})

test('★兜底路径：完全不提供 subagents 服务，仅靠 header（origin + parentSession）也必须识别 P1，childSource=headers', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')], // 父：自身已闭合
    'child-open': [turnStart(2)], // 子：未闭合 ⇒ 参与 P1
    'child-closed': [turnStart(3), turnEnd(3, 'completed')], // 子：已闭合 ⇒ 不参与
    'session-q': [turnStart(1)], // 自身未闭合 ⇒ P0
  }
  const ctx = fakeCtx({
    // 刻意**不给** subagents / subagent：父子关系只能从 header 拿
    sessionQuery: mkSessionQuery({
      records: [
        record(header('session-p')), record(header('session-q')),
        subagentRecord('child-open', 'session-p'), subagentRecord('child-closed', 'session-p'),
      ],
      logs,
    }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  // 子会话仍然不作为唤醒目标（预筛阶段就被剔除），但它们已收进 header 派生的父子关系里
  assert.equal(pre.stats.subagentSkipped, 2)
  assert.deepEqual((pre.childrenByParent.get('session-p') || []).slice().sort(), ['child-closed', 'child-open'],
    '父子关系必须在"跳过子会话"之前收集，否则兜底来源永远是空 Map')

  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })
  assert.equal(judged.stats.subagentAvailable, false)
  assert.equal(judged.stats.headerChildrenAvailable, true)
  assert.equal(judged.stats.childSource, 'headers')
  const p1 = judged.candidates.find((c) => c.layer === LAYER.P1)
  assert.ok(p1, 'subagents 服务缺失时 header 兜底必须顶上（真机上 P1 曾因此整层没跑）')
  assert.equal(p1.sessionId, 'session-p', '唤醒目标仍是父会话')
  assert.equal(p1.childSource, 'headers')
  assert.deepEqual(p1.openChildren.map((x) => x.id), ['child-open'],
    '是否未闭合只看**子会话自己的日志末态**：已闭合的子会话不参与')
  assert.equal(judged.stats.p0, 1, 'P0（session-q）照常判定')
})

test('★两条来源都不可用：P1 层整体跳过、不抛错、P0 不受影响、childSource=none', async () => {
  const logs = { 'session-q': [turnStart(1)] }
  const ctx = fakeCtx({ sessionQuery: mkSessionQuery({ records: [record(header('session-q'))], logs }) })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  assert.equal(pre.childrenByParent.size, 0, '列表里没有任何 subagent header ⇒ 兜底来源为空')
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })
  assert.equal(judged.stats.subagentAvailable, false)
  assert.equal(judged.stats.headerChildrenAvailable, false)
  assert.equal(judged.stats.childSource, 'none')
  assert.deepEqual(judged.candidates.map((c) => c.layer), [LAYER.P0], 'P1 整体跳过，P0 照常判定')
  // 两条来源都拿不到 ⇒ 绝不"自己遍历子会话"瞎猜
  assert.equal(judged.stats.p1, 0)
})

test('健壮性：readSession 失败 / 日志缺失 ⇒ 记入 skipped，不抛、不产出候选', async () => {
  const logs = { 'session-ok': [turnStart(1)] } // session-broken 没有日志 ⇒ readSession 抛
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-broken')), record(header('session-ok'))], logs }),
    subagents: mkSubagent({}),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  assert.equal(pre.survivors.length, 2)
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, now: () => NOW })
  assert.deepEqual(judged.candidates.map((c) => c.sessionId), ['session-ok'])
  assert.ok(judged.skipped.some((s) => s.sessionId === 'session-broken' && /readSession/.test(s.reason)))
  assert.equal(judged.stats.readFailed, 1)
})

test('P1：子会话日志读失败 ⇒ 保守处理（不把该父会话当 P1），并留下 skip 记录', async () => {
  const logs = { 'session-p': [turnStart(1), turnEnd(1, 'completed')] } // 子会话无日志
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-p'))], logs }),
    subagents: mkSubagent({ 'session-p': [child('child-broken')] }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, now: () => NOW })
  assert.deepEqual(judged.candidates, [], '读不出子会话末态 ⇒ 不产出 P1（宁漏不滥）')
  assert.ok(judged.skipped.some((s) => s.childId === 'child-broken'))
  assert.equal(judged.stats.childReadFailed, 1)
})

test('maxResumePerBoot：截断先丢 P0（P1 已排在前面）', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')],
    'child-1': [turnStart(2)],
    'session-q': [turnStart(1)],
    'session-r': [turnStart(1)],
  }
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-p')), record(header('session-q')), record(header('session-r'))], logs }),
    subagents: mkSubagent({ 'session-p': [child('child-1')] }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, now: () => NOW })
  const picked = selectByLayer(judged.candidates, { scope: 'all', maxResume: 1 })
  assert.deepEqual(picked.resume.map((c) => c.sessionId), ['session-p'], '截断时保住 P1')
  assert.equal(picked.skip.length, 2)
  assert.ok(picked.skip.every((s) => /maxResumePerBoot/.test(s.reason) || /tasks-only/.test(s.reason)))
})

test('isSubagentSession：按 header 判父子关系（不用 id 前缀这种弱信号）', () => {
  assert.equal(isSubagentSession({ id: '053f471b-abc' , origin: 'subagent' }), true)
  assert.equal(isSubagentSession({ id: 'x', parentSession: 'session-p' }), true)
  assert.equal(isSubagentSession({ id: 'x', delegationDepth: 2 }), true)
  assert.equal(isSubagentSession({ id: 'session-main' }), false)
  assert.equal(isSubagentSession(null), false)
  // 只有 id 前缀、没有 header 证据 ⇒ 不算子会话（前缀会随命名规范漂移）
  assert.equal(isSubagentSession({ id: '053f471b-abc' }), false)
})

// ---------------------------------------------------------------------------
// ★明细审计（2026-09-22 补，**只加审计、不改任何判据**）：
//   用来定位真机"survivors=1 但 P1=0"的真因 —— 汇总行只报**条数**，
//   "是谁"（resume.survivor）与"子枚举到底返回了什么"（resume.judge）必须逐条看得到。

test('★明细审计：每个幸存者带完整 detail（是谁 + 窗口套在哪一列上），且**有界**', async () => {
  const home = mkTempHome()
  try {
    const id = 'session-53c34b02-5ee1-4b23-bf44-e714a964d9d6'
    const lastActive = NOW - 30 * 60 * 1000
    const seq = 4242
    writeSessionFile(home, id, [zstdFrame([timedEvent(lastActive, { seq })])])
    const ctx = fakeCtx({
      sessionQuery: mkSessionQuery({
        records: [record(header(id, { createdAt: NOW - 26 * 24 * HOUR, cwd: '/srv/ws-x' }))], logs: {},
      }),
      sessionProjectionCache: mkProjection({}),
    })
    const r = await prescanSessions({ ctx, dshHome: home, now: () => NOW, recentWindowMs: WINDOW })

    assert.equal(r.survivors.length, 1)
    const d = r.survivors[0].detail
    assert.ok(d, '每个幸存者都必须带 detail（由 index.js emit 成 resume.survivor）')
    assert.equal(d.sessionId, id)
    assert.equal(d.lastActiveAt, lastActive)
    assert.equal(d.lastActiveSource, 'tail', '窗口套在哪一列上一眼可见（这里=日志最后一条事件的时间）')
    assert.equal(d.lastEventType, 'turn/end')
    assert.equal(d.lastEventSeq, seq)
    assert.equal(d.hasSessionFile, true)
    assert.equal(d.cwd, '/srv/ws-x')
    assert.equal(d.createdAt, NOW - 26 * 24 * HOUR)
    assert.equal(d.origin, null)
    assert.equal(d.parentSession, null)
    assert.equal(d.windowMs, WINDOW)
    assert.equal(d.now, NOW)
    assert.equal(d.tailUsable, true)
    // 明细必须**有界**：不得夹带整个 header（真机 539 个会话时会把审计撑爆）
    assert.equal(d.header, undefined)
    assert.ok(JSON.stringify(d).length < 1000, '单条明细要小：actual=' + JSON.stringify(d).length)
  } finally { cleanup(home) }
})

test('★明细审计：P1 命中 ⇒ path=p1-eval、verdict=p1-candidate、openChildren 含预期子会话 id 与 ownKind', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')], // 父：自身已闭合
    'child-open': [turnStart(2)], // 子：未闭合
    'child-closed': [turnStart(3), turnEnd(3, 'completed')], // 子：已闭合
    'session-q': [turnStart(1)], // 自身未闭合 ⇒ P0
  }
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({
      records: [
        record(header('session-p')), record(header('session-q')),
        subagentRecord('child-open', 'session-p'), subagentRecord('child-closed', 'session-p'),
      ],
      logs,
    }),
    subagents: mkSubagent({ 'session-p': [child('child-open'), child('child-closed')] }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })

  assert.equal(judged.details.length, judged.stats.survivors, '每个幸存者一条明细（含没产出候选的）')

  const p1 = judged.details.find((d) => d.sessionId === 'session-p')
  assert.equal(p1.path, 'p1-eval')
  assert.equal(p1.ownKind, 'closed', 'P1 的前提是"自身已闭合"')
  assert.equal(p1.ownTurn, 1)
  assert.equal(p1.childSource, 'service')
  assert.equal(p1.childrenRawCount, 2)
  assert.equal(p1.serviceChildrenCount, 2, 'listChildren 返回的条数')
  assert.equal(p1.headerChildrenCount, 2, 'header 派生也数得出来 ⇒ 两条来源可交叉校验')
  assert.equal(p1.childrenChecked, 2, '实际读了日志的子会话数')
  assert.equal(p1.openChildrenTotal, 1)
  assert.deepEqual(p1.openChildren.map((c) => c.id), ['child-open'])
  assert.equal(p1.openChildren[0].ownKind, 'open', '每个未闭合子会话都要带自己的 ownKind')
  assert.equal(p1.verdict, 'p1-candidate')
  assert.equal(p1.layer, LAYER.P1)
  assert.equal(p1.childSourceDisagreement, undefined, '两条来源一致 ⇒ 不得报分歧')
  // 形态摘要：能看出返回的是 {id, mode, label, activity} 这种条目，且**有界**（只前 3 条）
  assert.equal(p1.childrenRawSample.length, 2)
  assert.equal(p1.childrenRawSample[0].shape, 'object')
  assert.equal(p1.childrenRawSample[0].id, 'child-open')
  assert.equal(p1.childrenRawSample[0].mode, 'one-shot')

  const p0 = judged.details.find((d) => d.sessionId === 'session-q')
  assert.equal(p0.path, 'p0')
  assert.equal(p0.ownKind, 'open')
  assert.equal(p0.verdict, undefined, 'verdict 只对 P1 评估路径有意义')
})

test('★明细审计：服务返回空数组 + header 有子会话 ⇒ childSourceDisagreement 带两个数量，但 childSource 仍是 service', async () => {
  const logs = { 'session-p': [turnStart(1), turnEnd(1, 'completed')] }
  const records = [record(header('session-p'))]
  for (const cid of ['child-a', 'child-b', 'child-c']) records.push(subagentRecord(cid, 'session-p'))
  const ctx = fakeCtx({
    sessionQuery: mkSessionQuery({ records, logs }),
    // 服务"说没有子会话"，而 header 明明派生出 3 个 ⇒ 正是真机 (b) 那种"P1 失灵"的形态
    subagents: mkSubagent({ 'session-p': [] }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })

  assert.deepEqual(judged.candidates, [], '（前提）服务说没有子会话 ⇒ 本轮不产出 P1')
  const d = judged.details[0]
  assert.equal(d.path, 'p1-eval')
  assert.equal(d.childSource, 'service', '★判据没被悄悄改掉：仍以服务返回为准，没有自动换 header 兜底')
  assert.equal(d.childrenRawCount, 0)
  assert.equal(d.serviceChildrenCount, 0)
  assert.equal(d.headerChildrenCount, 3, '两个数量都必须报出来（这条正是定位真因的关键）')
  assert.equal(d.verdict, 'empty-children')
  assert.deepEqual(d.childrenRawSample, [], '空数组 ⇒ 无样本')
  assert.deepEqual(d.openChildren, [])
  assert.equal(d.childrenChecked, 0)

  const dis = d.childSourceDisagreement
  assert.ok(dis, '必须留下"来源分歧"标记，供 index.js emit WARN')
  assert.equal(dis.reason, 'child-source-disagreement')
  assert.equal(dis.serviceChildrenCount, 0)
  assert.equal(dis.headerChildrenCount, 3)
  assert.equal(dis.childSource, 'service')
  assert.equal(judged.stats.childSource, 'service', '（不改判据）stats 里的来源也仍是 service')
})

test('★明细审计：服务不可用走 header 兜底 ⇒ childSource=headers、verdict 正常、无分歧标记', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')],
    'child-open': [turnStart(2)],
    'child-closed': [turnStart(3), turnEnd(3, 'completed')],
  }
  const ctx = fakeCtx({
    // 刻意**不给** subagents / subagent：父子关系只能从 header 拿
    sessionQuery: mkSessionQuery({
      records: [record(header('session-p')), subagentRecord('child-open', 'session-p'), subagentRecord('child-closed', 'session-p')],
      logs,
    }),
  })
  const pre = await prescanSessions({ ctx, now: () => NOW, recentWindowMs: WINDOW })
  const judged = await judgeCandidates({ ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, now: () => NOW })

  const d = judged.details.find((x) => x.sessionId === 'session-p')
  assert.equal(d.path, 'p1-eval')
  assert.equal(d.childSource, 'headers')
  assert.equal(d.childrenRawCount, 2)
  assert.equal(d.serviceChildrenCount, null, '服务没被调用 ⇒ null（与"返回 0 条"是两件事）')
  assert.equal(d.headerChildrenCount, 2)
  assert.equal(d.childrenChecked, 2)
  assert.equal(d.verdict, 'p1-candidate')
  assert.deepEqual(d.openChildren.map((c) => c.id), ['child-open'])
  assert.equal(d.childrenRawSample[0].shape, 'string', 'header 兜底给的是裸 id 字符串 ⇒ 形态摘要要看得出来')
  assert.equal(d.childrenRawSample[0].id, 'child-open')
  assert.equal(d.childSourceDisagreement, undefined, '没走服务路径 ⇒ 无所谓"分歧"')
})

test('★明细审计：path 如实记"为什么没走成 P1-eval"（skipped-read-failed / skipped-no-child-source）', async () => {
  // (1) 自身日志读失败 ⇒ skipped-read-failed（不给 ownKind/ownTurn 编造值）
  const broken = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-broken'))], logs: {} }),
    subagents: mkSubagent({}),
  })
  const pre1 = await prescanSessions({ ctx: broken, now: () => NOW, recentWindowMs: WINDOW })
  const judged1 = await judgeCandidates({ ctx: broken, survivors: pre1.survivors, now: () => NOW })
  assert.equal(judged1.details[0].path, 'skipped-read-failed')
  assert.equal(judged1.details[0].ownKind, null)
  assert.equal(judged1.details[0].ownTurn, null)
  assert.match(judged1.details[0].error, /readSession|no log/)

  // (2) 两条子会话来源都不可用（无 subagents 服务 + 没传 childrenByParent）⇒ skipped-no-child-source
  const closed = fakeCtx({
    sessionQuery: mkSessionQuery({ records: [record(header('session-p'))], logs: { 'session-p': [turnStart(1), turnEnd(1, 'completed')] } }),
  })
  const pre2 = await prescanSessions({ ctx: closed, now: () => NOW, recentWindowMs: WINDOW })
  const judged2 = await judgeCandidates({ ctx: closed, survivors: pre2.survivors, now: () => NOW })
  assert.deepEqual(judged2.candidates, [])
  const d2 = judged2.details[0]
  assert.equal(d2.path, 'skipped-no-child-source')
  assert.equal(d2.ownKind, 'closed')
  assert.equal(d2.childSource, 'none')
  assert.equal(d2.verdict, 'children-unusable', '判定根本不可进行 ⇒ 如实标 unusable（不假装"没有未闭合子会话"）')
  assert.equal(d2.childrenRawCount, null)
  assert.equal(d2.headerChildrenCount, null)
  assert.equal(d2.childrenChecked, 0)
})

// ---------------------------------------------------------------------------
// ★U10（2026-09-22）：二级判定的"末态"改为**尾帧优先**；★T1-2（2026-09-25）：**有文件但判不了时不再回退读全量**。
//   真机数字：RESUME ROUND 190487ms（539 会话）里，一级预筛只占 3.7s ⇒ 瓶颈是二级判定逐个读
//   135 个子会话的**完整日志**（有的 13764 / 3104 / 2165 事件）外加父会话自己的 23MB 日志。
//   以下用例锁住：能读尾帧就**绝不**读全量；**有文件却判不了时也不再回退**（宁漏不滥，且必须留痕）。
//   ⚠️ 反例保留：索引里**根本没有**该会话（连文件都定位不到）时，仍走既有回退 —— 那种形态没有文件可 stat，
//      体积闸门无从施加，且真机上"我们定位不到文件"通常意味着内核也读不到（见 scan.js#turnStateOf 的说明）。

test('★U10 尾帧优先：父自身与子会话的末态都由尾帧判出 ⇒ readSession **一次都不许**被调用', async () => {
  const home = mkTempHome()
  try {
    writeSessionFile(home, 'session-p', [zstdFrame([turnStart(1)]), zstdFrame([turnEnd(1, 'completed')])])
    writeSessionFile(home, 'child-open', [zstdFrame([turnStart(2)])])
    const sessionQuery = mkSessionQuery({
      records: [record(header('session-p')), subagentRecord('child-open', 'session-p')],
      // 刻意**不给任何日志**：一旦回退读全量就会抛错（⇒ 同时也证明"没有回退"）
      logs: {},
    })
    const ctx = fakeCtx({ sessionQuery, subagents: mkSubagent({ 'session-p': [child('child-open')] }) })
    const index = buildSessionFileIndex(home)

    const pre = await prescanSessions({ ctx, dshHome: home, index, now: () => NOW, recentWindowMs: WINDOW })
    const judged = await judgeCandidates({
      ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, index, now: () => NOW,
    })

    assert.deepEqual(sessionQuery.calls.read, [], '尾帧可用 ⇒ 绝不读全量日志（U10 的成本主张）')
    assert.equal(judged.stats.tailJudged, 2, '末态由尾帧判出：父自身 + 1 个子会话')
    assert.equal(judged.stats.fallbackReads, 0)
    assert.equal(judged.stats.tailJudgeFailed, 0)
    assert.equal(judged.stats.maxTail, DEFAULT_MAX_TAIL_TAIL, '尾窗上限要能一眼看到（便于调参）')

    const p1 = judged.candidates.find((c) => c.layer === LAYER.P1)
    assert.ok(p1, '尾帧判出的末态必须与全量读取同结论：父已闭合 + 子未闭合 ⇒ P1')
    assert.equal(p1.sessionId, 'session-p')
    assert.equal(p1.childId, 'child-open')

    const d = judged.details.find((x) => x.sessionId === 'session-p')
    assert.equal(d.path, 'p1-eval')
    assert.equal(d.ownKind, 'closed')
    assert.equal(d.ownStateSource, 'tail', '父会话自身的末态也走尾帧')
    assert.deepEqual(d.childStateSources, { tail: 1, read: 0 })
  } finally { cleanup(home) }
})

test('★T1-2：子会话"有文件但尾帧判不了" ⇒ **不再回退读全量**（该子会话判不了 ⇒ 父会话不产出 P1，且必须留痕）', async () => {
  const home = mkTempHome()
  try {
    writeSessionFile(home, 'session-p', [zstdFrame([turnStart(1)]), zstdFrame([turnEnd(1, 'completed')])])
    // 子会话文件解得开，但**整个文件里没有任何 turn 边界** ⇒ tail 判不了（这就是唯一的失败模式）
    writeSessionFile(home, 'child-noturn', [zstdFrame([timedEvent(1, { type: 'request/context' })])])
    const sessionQuery = mkSessionQuery({
      records: [record(header('session-p')), subagentRecord('child-noturn', 'session-p')],
      // 子会话**故意给得出日志**（改造前这里会被回退读全量）⇒ 用它反证"现在没读"
      logs: { 'child-noturn': [turnStart(2)] },
    })
    const ctx = fakeCtx({ sessionQuery, subagents: mkSubagent({ 'session-p': [child('child-noturn')] }) })
    const index = buildSessionFileIndex(home)

    const pre = await prescanSessions({ ctx, dshHome: home, index, now: () => NOW, recentWindowMs: WINDOW })
    const judged = await judgeCandidates({
      ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, index, now: () => NOW,
    })

    assert.deepEqual(sessionQuery.calls.read, [], 'T1-2：尾帧判不了也**绝不**回退读全量日志')
    assert.equal(judged.stats.tailJudgeFailed, 1, '尾帧判不了的次数必须如实记')
    assert.equal(judged.stats.fallbackReads, 0, '没有再发起任何全量读')
    assert.equal(judged.stats.fullReadSkipped, 1, 'T1-2：按新策略跳过的次数同样要如实记（= 本轮漏判数）')
    assert.equal(judged.stats.tailJudged, 1, '父自身的末态仍是尾帧判的')

    const d = judged.details.find((x) => x.sessionId === 'session-p')
    assert.equal(d.ownStateSource, 'tail')
    assert.deepEqual(d.childStateSources, { tail: 0, read: 0 }, '跳过的子会话不计入任何一条取法')
    assert.equal(judged.stats.p1, 0, '子会话判不了 ⇒ 父会话不产出 P1（宁漏不滥：这一轮拿不到末态）')
    assert.equal(d.verdict, 'no-open-children', '判定路径不变（p1-eval），只是没有未闭合子会话可判定')
    assert.ok(
      judged.skipped.some((s) => s.childId === 'child-noturn' && /禁用全量回退/.test(s.reason)),
      '必须留痕：跳过原因里要写明"已禁用全量回退"（不静默）',
    )
  } finally { cleanup(home) }
})

test('★U10 父会话自身也走尾帧：ownStateSource=tail，且父会话 id 不出现在 readSession 调用里', async () => {
  const home = mkTempHome()
  try {
    const id = 'session-own-tail'
    writeSessionFile(home, id, [zstdFrame([turnStart(3)]), zstdFrame([turnEnd(3, 'completed')])])
    const sessionQuery = mkSessionQuery({ records: [record(header(id))], logs: {} })
    const ctx = fakeCtx({ sessionQuery, subagents: mkSubagent({}) })
    const index = buildSessionFileIndex(home)

    const pre = await prescanSessions({ ctx, dshHome: home, index, now: () => NOW, recentWindowMs: WINDOW })
    const judged = await judgeCandidates({
      ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, index, now: () => NOW,
    })

    const d = judged.details[0]
    assert.equal(d.ownStateSource, 'tail')
    assert.equal(d.ownKind, 'closed', '尾帧判出的末态：turn/end(completed)')
    assert.equal(d.ownTurn, 3)
    assert.equal(sessionQuery.calls.read.includes(id), false, '父会话自身绝不被 readSession 读')
    assert.equal(judged.stats.tailJudged, 1)
    assert.equal(judged.stats.p0, 0)
    // 没有任何子会话 ⇒ 走 p1-eval 但 verdict=empty-children（路径语义没变）
    assert.equal(d.path, 'p1-eval')
    assert.equal(d.verdict, 'empty-children')
  } finally { cleanup(home) }
})
