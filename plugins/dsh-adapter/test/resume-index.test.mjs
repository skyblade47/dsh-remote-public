// @local/dsh-adapter —— 重启自恢复：配置与编排单测（收敛自原 skeleton.test.mjs + 新增编排语义）
//
// 锁住的语义：
//   · 配置：默认值、嵌套/扁平写法、非法值回退默认 + warning（**绝不抛**）
//   · 记账：enabled=false ⇒ 唤醒数 0；dryRun ⇒ 只出候选清单不唤醒；maxResumePerBoot 截断
//   · 判据分层：tasks-only 只跑 P1；all 才 P1+P0
//   · 幂等：同一次未结束状态第二次扫描变成 resume.skip（D3）；**失败不写状态**（否则永不重试）
//   · 留痕：窗口外跳过、subagent 缺失、P2/P3 未实现、adapterWake 缺失都必须有审计
//   · ★成败判据（2026-09-22 修复）：**preset 没挂上（setupMounted !== true）一律判失败** ——
//     不许"有 agent 句柄就算成功"，否则会写幂等状态且永不重试（静默少工具的失败模式）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAdapterResume, normalizeConfig, noticeTextFor } from '../lib/resume/index.js'
import { createAdapterWake, classifyPresetSetup } from '../lib/wake.js'
import { LAYER } from '../lib/resume/scan.js'
import {
  NOW, HOUR, turnStart, turnEnd, header, record, subagentRecord,
  mkSessionQuery, mkProjection, mkSubagent, child, fakeCtx, mkWake, mkWakeHost, collectAudit,
  zstdFrame, writeSessionFile, timedEvent,
} from './_resume-fakes.mjs'

const WINDOW = 6 * HOUR

/** 一个可控场景：父会话已闭合 + 子未闭合（P1），两个自身未闭合的会话（P0），一个窗口外的会话 */
function scenario() {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')],
    'child-1': [turnStart(2)],
    'session-q': [turnStart(1)],
    'session-r': [turnStart(1)],
    'session-old': [turnStart(1)],
  }
  const records = [
    record(header('session-p')),
    record(header('session-q')),
    record(header('session-r')),
    record(header('session-old', { createdAt: NOW - 100 * HOUR })),
  ]
  return {
    services: {
      sessionQuery: mkSessionQuery({ records, logs }),
      sessionProjectionCache: mkProjection({}),
      subagents: mkSubagent({ 'session-p': [child('child-1')] }),
    },
  }
}

function makeResume(services, config = {}, opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  const audit = collectAudit()
  const wake = opts.wake || mkWake()
  const svc = createAdapterResume({
    // 真机里 adapter 同时把 wake 实例 provide 成 ctx 服务（dependencyStatus 就查它），测试照做
    ctx: fakeCtx(opts.wake === null ? services : { ...services, adapterWake: wake }),
    wake: opts.wake === null ? null : wake,
    dshHome: home,
    config: { statePath: join(home, 'users', 'resume-state.json'), ...config },
    audit: audit.audit,
    // 不传 log：走默认空实现（也顺带锁"日志器缺省不抛"）
  })
  return { svc, wake, audit, home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
test('normalizeConfig：默认值 + 嵌套（adapter.resume / resumeOnBoot）与扁平写法都接受', () => {
  const d = normalizeConfig(undefined).cfg
  assert.equal(d.enabled, true)
  assert.equal(d.scope, 'tasks-only')
  assert.equal(d.startDelayMs, 0)
  assert.equal(d.maxResumePerBoot, 5)
  assert.equal(d.dryRun, false)
  assert.equal(d.recentWindowMs, WINDOW, '默认窗口 6 小时（P3 §2B）')
  assert.equal(d.stateMaxAgeDays, 30)

  assert.equal(normalizeConfig({ scope: 'all' }).cfg.scope, 'all', '扁平')
  assert.equal(normalizeConfig({ resume: { scope: 'all' } }).cfg.scope, 'all', 'adapter.resume')
  assert.equal(normalizeConfig({ resumeOnBoot: { scope: 'all' } }).cfg.scope, 'all', 'resumeOnBoot')
  assert.equal(normalizeConfig({ resume: { dryRun: true } }).cfg.dryRun, true)
})

// ★test-only（T9 失败注入）：默认 null；仅接受**非空字符串**；非法回退 null + warning，**绝不抛**
test('normalizeConfig：testForceMissingPresetId（test-only）默认 null；仅接受非空字符串；非法回退 null + warning', () => {
  assert.equal(normalizeConfig(undefined).cfg.testForceMissingPresetId, null, '默认 null（不注入）')
  assert.equal(normalizeConfig({}).cfg.testForceMissingPresetId, null)

  // 合法：非空字符串（两种写法都要认）
  const ok = normalizeConfig({ testForceMissingPresetId: 'ghost-preset' })
  assert.equal(ok.cfg.testForceMissingPresetId, 'ghost-preset')
  assert.equal(ok.warnings.length, 0, '合法值不该有 warning')
  assert.equal(normalizeConfig({ resume: { testForceMissingPresetId: 'ghost-preset' } }).cfg.testForceMissingPresetId, 'ghost-preset', 'adapter.resume 写法')
  assert.equal(normalizeConfig({ resumeOnBoot: { testForceMissingPresetId: 'ghost-preset' } }).cfg.testForceMissingPresetId, 'ghost-preset', 'resumeOnBoot 写法')

  // null / undefined 都是合法（= 不启用）
  assert.equal(normalizeConfig({ testForceMissingPresetId: null }).cfg.testForceMissingPresetId, null)
  assert.equal(normalizeConfig({ testForceMissingPresetId: null }).warnings.length, 0)

  // 非法：数字 / 布尔 / 空串 / 空白串 / 数组 / 对象 ⇒ 回退 null + warning，不抛
  for (const bad of [123, true, '', '   ', [], {}]) {
    const r = normalizeConfig({ testForceMissingPresetId: bad })
    assert.equal(r.cfg.testForceMissingPresetId, null, '非法值回退 null: ' + JSON.stringify(bad))
    assert.equal(r.warnings.length, 1, '非法值必须留 warning: ' + JSON.stringify(bad))
    assert.match(r.warnings[0], /testForceMissingPresetId/)
    assert.match(r.warnings[0], /回退默认 null/)
  }
  assert.doesNotThrow(() => normalizeConfig(null))
})

test('normalizeConfig：非法值回退默认并给 warning，**绝不抛**（配置写错不该让内核起不来）', () => {
  const r = normalizeConfig({ scope: 'nonsense', startDelayMs: -5, maxResumePerBoot: 'abc', recentWindowMs: 0, stateMaxAgeDays: 0 })
  assert.equal(r.cfg.scope, 'tasks-only')
  assert.equal(r.cfg.startDelayMs, 0)
  assert.equal(r.cfg.maxResumePerBoot, 5)
  assert.equal(r.cfg.recentWindowMs, WINDOW)
  assert.equal(r.cfg.stateMaxAgeDays, 30)
  assert.equal(r.warnings.length, 5)
  assert.doesNotThrow(() => normalizeConfig(null))
  assert.doesNotThrow(() => normalizeConfig('not-an-object'))
})

test('配置非法：构造与 run 都不抛，且审计里留下 invalid-config 的 resume.skip', async () => {
  const { svc, audit, cleanup } = makeResume({}, { scope: 'nonsense' })
  try {
    const s = await svc.run()
    assert.equal(s.scope, 'tasks-only', '回退默认')
    assert.ok(audit.find('resume.skip', (l) => l.extra.reason === 'invalid-config').length >= 1)
  } finally { cleanup() }
})

test('依赖缺失：sessionQuery 不可用 ⇒ 干净退出、写 resume.fail、不抛', async () => {
  const { svc, audit, cleanup } = makeResume({})
  try {
    const s = await svc.run()
    assert.equal(s.ok, false)
    assert.match(s.reason, /sessionQuery/)
    assert.equal(audit.find('resume.fail').length, 1)
    assert.match(audit.find('resume.fail')[0].extra.reason, /sessionQuery/)
  } finally { cleanup() }
})

test('ctx 完全不完整：构造 + run 都不抛（apply 期与定时器回调都不许把内核带崩）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  try {
    const svcNoCtx = createAdapterResume({ dshHome: home })
    assert.doesNotThrow(() => svcNoCtx.status())
    await assert.doesNotReject(() => svcNoCtx.run())
    const svcNullCtx = createAdapterResume({ ctx: null, wake: null, audit: null, log: null, dshHome: home })
    await assert.doesNotReject(() => svcNullCtx.run())
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('一级预筛窗口外的会话：跳过且**写了审计**（这是回调 recentWindowMs 的唯一依据）', async () => {
  const { svc, audit, cleanup } = makeResume(scenario().services, { scope: 'all' })
  try {
    const s = await svc.run()
    assert.equal(s.total, 4)
    const skip = audit.find('resume.skip', (l) => l.extra.sessionId === 'session-old')
    assert.equal(skip.length, 1)
    assert.match(skip[0].extra.reason, /window-out/)
    assert.equal(skip[0].extra.lastActiveSource, 'createdAt')
    assert.equal(skip[0].extra.hasProjection, false)

    // 一级预筛的汇总审计（U8）：**来源分布必须一眼可见**，否则下次闸门坏了还是看不出来
    const prescan = audit.find('resume.prescan')
    assert.equal(prescan.length, 1)
    assert.equal(prescan[0].extra.total, 4)
    assert.equal(prescan[0].extra.survivors, 3)
    assert.deepEqual(prescan[0].extra.sources, { tail: 0, lastPromptAt: 0, createdAt: 4, none: 0 },
      'scenario 里没有会话文件 ⇒ tail 全不可用（这里正是如实反映"闸门退化成 createdAt"的地方）')
    assert.equal(prescan[0].extra.tailFailed + prescan[0].extra.tailNoFile, 4)
    assert.equal(typeof prescan[0].extra.durationMs, 'number')
  } finally { cleanup() }
})

test('U8 接线：dshHome 真的被传进了一级预筛（尾帧很新 ⇒ 用 tail 来源救回"创建很早"的会话）', async () => {
  // scenario 里 session-old 的 createdAt 在 100 小时前（旧链必判 window-out）；
  // 但它的日志尾帧写着"1 分钟前还活跃过" ⇒ 新链必须把它救回来并唤醒。
  const { svc, audit, home, cleanup } = makeResume(scenario().services, { scope: 'all', dryRun: true })
  try {
    const lastActive = NOW - 60 * 1000
    // ⚠️ 夹具必须**自洽**（U10）：scenario 的 logs 里 session-old 是"turn 未闭合"（要出 P0），
    // 会话文件里也必须以 turn/start 收尾 —— 否则二级判定改走尾帧后会读到"已闭合"，与用例前提冲突。
    // （真实世界里"文件就是日志"，两者不可能不一致；这里只是把夹具对齐。）
    writeSessionFile(home, 'session-old', [zstdFrame([timedEvent(lastActive, { type: 'turn/start', data: { turn: 1 } })])])

    const s = await svc.run()
    assert.equal(s.survivors, 4, '尾帧把 session-old 救回来了（旧链这里是 3）')
    assert.equal(s.prescanStats.sources.tail, 1, '来源分布必须记在 tail 名下：dshHome 没传对时这里会是 0')
    const selected = s.selected.find((c) => c.sessionId === 'session-old')
    assert.ok(selected, '同一个会话在 scope=all 下是 P0 候选，必须被选中')
    assert.equal(selected.lastActiveSource, 'tail')
    assert.equal(selected.lastActiveAt, lastActive)
    assert.equal(audit.find('resume.skip', (l) => l.extra.sessionId === 'session-old' && /window-out/.test(l.extra.reason)).length, 0)
  } finally { cleanup() }
})

test('scope=tasks-only（默认）：只唤醒 P1；P0 只记 skip（D4 + §2D D5）', async () => {
  const { svc, wake, audit, cleanup } = makeResume(scenario().services)
  try {
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, ['session-p'], '只有"父已闭合 + 子未闭合"被唤醒')
    assert.equal(s.resumed, 1)
    assert.deepEqual(s.selected.map((c) => [c.sessionId, c.layer]), [['session-p', 'P1']])
    assert.match(s.selected[0].key, /^sub:session-p:child-1/, 'P1 键必须带子会话 id（否则父会话永远只被唤醒一次）')
    const p0Skip = audit.find('resume.skip', (l) => l.extra.layer === 'P0')
    assert.equal(p0Skip.length, 2)
    assert.ok(p0Skip.every((l) => /tasks-only/.test(l.extra.reason)))
  } finally { cleanup() }
})

test('scope=all：P1 + P0 都唤醒，且 P1 在先', async () => {
  const { svc, wake, cleanup } = makeResume(scenario().services, { scope: 'all' })
  try {
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, ['session-p', 'session-q', 'session-r'])
    assert.equal(s.resumed, 3)
    assert.deepEqual(s.selected.map((c) => c.layer), ['P1', 'P0', 'P0'])
  } finally { cleanup() }
})

test('dryRun：只产出候选清单与审计，**不调用唤醒**', async () => {
  const { svc, wake, audit, cleanup } = makeResume(scenario().services, { scope: 'all', dryRun: true })
  try {
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, [], 'dryRun 绝不允许真唤醒')
    assert.equal(s.resumed, 0)
    assert.equal(s.selected.length, 3, '候选清单仍要产出')
    const scan = audit.find('resume.scan')
    assert.equal(scan.length, 1)
    assert.deepEqual(scan[0].extra.candidates.map((c) => c.sessionId), ['session-p', 'session-q', 'session-r'])
    assert.equal(scan[0].extra.dryRun, true)
    assert.equal(scan[0].extra.childSource, 'service', '审计必须标明 P1 的子会话枚举走了哪条路径')
    assert.equal(scan[0].extra.subagentsAvailable, true)
    assert.ok(audit.find('resume.skip', (l) => l.extra.reason === 'dryRun').length === 3)
  } finally { cleanup() }
})

test('enabled=false：唤醒数为 0，且**连扫描都不跑**（蓝绿影子实例不能抢唤醒）', async () => {
  const { services } = scenario()
  const { svc, wake, audit, cleanup } = makeResume(services, { enabled: false, scope: 'all' })
  try {
    const s = await svc.run()
    assert.equal(s.resumed, 0)
    assert.deepEqual(wake.calls.resume, [])
    assert.equal(services.sessionQuery.calls.list, 0, '禁用了就不该碰宿主会话列表')
    assert.equal(audit.find('resume.skip', (l) => l.extra.reason === 'enabled=false').length, 1)
    assert.equal(svc.status().enabled, false)
  } finally { cleanup() }
})

test('maxResumePerBoot=1：截断 P0，保住 P1，并给出原因', async () => {
  const { svc, wake, audit, cleanup } = makeResume(scenario().services, { scope: 'all', maxResumePerBoot: 1 })
  try {
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, ['session-p'])
    assert.equal(s.resumed, 1)
    const capped = audit.find('resume.skip', (l) => /maxResumePerBoot/.test(l.extra.reason || ''))
    assert.equal(capped.length, 2)
  } finally { cleanup() }
})

test('adapterWake 不可用：明确拒绝唤醒并留 ERROR 审计（不静默地"不恢复"）', async () => {
  const { svc, audit, cleanup } = makeResume(scenario().services, {}, { wake: null })
  try {
    const s = await svc.run()
    assert.equal(s.resumed, 0)
    const fail = audit.find('resume.fail', (l) => l.extra.reason === 'adapterWake-unavailable')
    assert.equal(fail.length, 1)
    assert.equal(fail[0].level, 'ERROR')
    assert.equal(fail[0].extra.selected.length, 1, '候选仍要留在审计里，便于依赖就绪后复盘')
  } finally { cleanup() }
})

test('子会话来源两条都不可用（subagents 服务缺失 + header 无父子关系）：P1 整体跳过、有审计、不抛；P0 照常（scope=all）', async () => {
  const s0 = scenario()
  delete s0.services.subagents
  const { svc, wake, audit, cleanup } = makeResume(s0.services, { scope: 'all' })
  try {
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, ['session-q', 'session-r'])
    const warn = audit.find('resume.skip', (l) => l.extra.reason === 'child-source-unavailable')
    assert.equal(warn.length, 1)
    assert.equal(warn[0].extra.layer, 'P1')
    assert.equal(warn[0].extra.subagentsAvailable, false)
    assert.equal(warn[0].extra.headerChildrenAvailable, false, 'scenario 的 listSessions 里没有任何 subagent header ⇒ 兜底也无从谈起')
    assert.equal(s.resumed, 2)
  } finally { cleanup() }
})

test('P1 唤醒会注入可追溯说明（含子代理 id），且幂等键写进状态文件', async () => {
  const { svc, wake, audit, home, cleanup } = makeResume(scenario().services)
  try {
    const s = await svc.run()
    assert.equal(s.resumed, 1)
    assert.equal(wake.calls.notice.length, 1, '唤醒成功后必须注入说明')
    const notice = wake.calls.notice[0]
    assert.match(notice.text, /<resume-notice/)
    assert.match(notice.text, /child-1/, '必须能追溯到"哪个子代理被掐断"')
    assert.match(notice.text, /你的子代理 child-1 在重启时被中断/)
    assert.equal(notice.opts.plugin, 'dsh-adapter')

    const okLine = audit.find('resume.ok')[0]
    assert.equal(okLine.extra.layer, 'P1')
    assert.match(okLine.extra.key, /^sub:session-p:child-1/)
    assert.equal(okLine.extra.setupMounted, true)
    assert.equal(okLine.extra.statePersisted, true)
    assert.equal(okLine.extra.noticeOk, true)

    const statePath = join(home, 'users', 'resume-state.json')
    assert.equal(existsSync(statePath), true, '状态文件必须落在配置指定路径（默认 $DSH_HOME/users/）')
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.match(saved.records['session-p'].key, /^sub:session-p:child-1/)
    assert.match(saved.records['session-p'].note, /child-1/)
  } finally { cleanup() }
})

test('P0 也注入说明（含 turn 号）；noticeTextFor 对 P1/P0 都带上 layer 与 session', () => {
  const p1 = noticeTextFor({ layer: LAYER.P1, sessionId: 'session-p', childId: 'c1', openChildren: [{ id: 'c1', kind: 'interrupted', turn: 3 }] })
  assert.match(p1, /<resume-notice plugin="dsh-adapter" layer="P1" session="session-p" child="c1"/)
  assert.match(p1, /你的子代理 c1 在重启时被中断/)
  assert.match(p1, /不会自动冷恢复子代理/)

  const p0 = noticeTextFor({ layer: LAYER.P0, sessionId: 'session-q', turn: 7, reasonKind: 'interrupted' })
  assert.match(p0, /layer="P0"/)
  assert.match(p0, /#7/)
})

test('幂等（D3/A4）：第二次扫描（模拟再次重启）变成 resume.skip(already-resumed)，不再唤醒', async () => {
  const { services } = scenario()
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  const statePath = join(home, 'users', 'resume-state.json')
  const shared = { sessionQuery: services.sessionQuery, sessionProjectionCache: services.sessionProjectionCache, subagents: services.subagents }
  try {
    // 第一次启动
    const a1 = collectAudit()
    const wake1 = mkWake()
    const svc1 = createAdapterResume({ ctx: fakeCtx(shared), wake: wake1, dshHome: home, config: { statePath }, audit: a1.audit })
    const r1 = await svc1.run()
    assert.equal(r1.resumed, 1)
    assert.equal(a1.find('resume.ok').length, 1)

    // 第二次启动（新实例、同一状态文件 = 模拟内核重启）
    const a2 = collectAudit()
    const wake2 = mkWake()
    const svc2 = createAdapterResume({ ctx: fakeCtx(shared), wake: wake2, dshHome: home, config: { statePath }, audit: a2.audit })
    const r2 = await svc2.run()
    assert.equal(r2.resumed, 0)
    assert.deepEqual(wake2.calls.resume, [], 'A4：同一次未结束状态绝不能再唤醒一次')
    const skips = a2.find('resume.skip', (l) => l.extra.reason === 'already-resumed')
    assert.equal(skips.length, 1)
    assert.match(skips[0].extra.key, /^sub:session-p:child-1/)
    assert.equal(r2.skipped >= 1, true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('失败不写状态（"失败不留疤"）：唤醒失败 ⇒ resume.fail(stateWritten=false)，下次重启仍会重试', async () => {
  const { services } = scenario()
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  const statePath = join(home, 'users', 'resume-state.json')
  try {
    const a1 = collectAudit()
    const wake1 = mkWake({ failFor: ['session-p'] })
    const svc1 = createAdapterResume({ ctx: fakeCtx(services), wake: wake1, dshHome: home, config: { statePath }, audit: a1.audit })
    const r1 = await svc1.run()
    assert.equal(r1.resumed, 0)
    assert.equal(r1.failed, 1)
    const failLine = a1.find('resume.fail', (l) => l.extra.reason === 'wake-failed')[0]
    assert.equal(failLine.extra.stateWritten, false, '失败必须如实声明"没写状态"')
    assert.equal(existsSync(statePath), false, '失败不得落盘幂等键，否则永不重试')

    const wake2 = mkWake()
    const svc2 = createAdapterResume({ ctx: fakeCtx(services), wake: wake2, dshHome: home, config: { statePath }, audit: collectAudit().audit })
    const r2 = await svc2.run()
    assert.deepEqual(wake2.calls.resume, ['session-p'], '上一次失败 ⇒ 这次仍会重试')
    assert.equal(r2.resumed, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ★2026-09-22 修复：**preset 没挂上却被当成"唤醒成功"**（真机验收发现的静默误判）。
//   唤醒只有一件事要做：把会话的**完整工具面**恢复回来（A1/A2）⇒ `setupMounted !== true` 不能算成功。
//   旧代码只判"有没有 agent 句柄"⇒ `agentPresets.mount` 不可用那条**不抛**的分支会被当成成功并写幂等状态。

test('★核心：preset 没挂上（agentPresets.mount 不可用，skipped 非空且**不抛**）⇒ 判失败、不写幂等状态、下次仍重试', async () => {
  const { services } = scenario()
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  const statePath = join(home, 'users', 'resume-state.json')
  try {
    // 真唤醒通道 + 缺 agentPresets 的宿主 ⇒ `presetMountSetupFor` 走
    // "report.skipped='agentPresets.mount 不可用' 后 return（**不抛**）"那条分支。
    const wake = createAdapterWake({ ctx: fakeCtx(mkWakeHost({ presets: false })) })

    // ① 通道层：agent 句柄**拿到了**（旧代码正是"看句柄就算成功"），但 preset 没挂上 ⇒ ok 必须为 false
    const r = await wake.resumeWithPreset('session-p')
    assert.equal(!!r.agent, true, '（前提）句柄存在 —— 这正是旧代码误判成功的来源')
    assert.equal(r.setupMounted, false)
    assert.equal(r.skipped, 'agentPresets.mount 不可用')
    assert.equal(r.ok, false, 'preset 没挂上 ⇒ 不能算成功（A1/A2）')
    assert.equal(r.reason, 'preset-not-mounted')
    assert.match(r.error, /preset 未挂上/)

    // ② 编排层：**走既有失败通道**（不新造失败类型），且绝不调 markResumed / 绝不注入"已恢复"说明
    let markCalls = 0
    let noticeCalls = 0
    const wakeWrapped = {
      ...wake,
      injectNotice: async (...a) => { noticeCalls++; return wake.injectNotice(...a) },
    }
    const audit = collectAudit()
    const svc = createAdapterResume({
      ctx: fakeCtx({ ...services, adapterWake: wakeWrapped }),
      wake: wakeWrapped, dshHome: home, config: { statePath }, audit: audit.audit,
    })
    const origMark = svc.state.markResumed.bind(svc.state)
    svc.state.markResumed = (...a) => { markCalls++; return origMark(...a) }

    const s = await svc.run()
    assert.deepEqual(s.selected.map((c) => c.sessionId), ['session-p'], '（前提）候选是 P1 的 session-p')
    assert.equal(s.resumed, 0)
    assert.equal(s.failed, 1)
    assert.equal(markCalls, 0, 'preset 没挂上 ⇒ markResumed **不得被调用**')
    assert.equal(noticeCalls, 0, '没挂上就不算唤醒成功 ⇒ 不该注入"已恢复"说明')
    assert.equal(audit.find('resume.ok').length, 0)
    assert.equal(svc.state.summary().entries, 0, '幂等状态里不得有这个 key')

    const fail = audit.find('resume.fail', (l) => l.extra.reason === 'preset-not-mounted')
    assert.equal(fail.length, 1, '失败走**既有**的 resume.fail（reason 由唤醒通道给出）')
    assert.equal(fail[0].level, 'WARN')
    assert.equal(fail[0].extra.setupSkipped, 'agentPresets.mount 不可用', '跳过原因必须一眼可见')
    assert.equal(fail[0].extra.setupMounted, false)
    assert.equal(fail[0].extra.stateWritten, false)
    assert.equal(existsSync(statePath), false, '失败不得落盘幂等键（状态文件都不该被创建）')

    // ③ "失败不留疤"（与 T9 的 wake-failed 对齐）：下次启动（新实例、同一状态文件）**仍会重试**
    const wake2 = mkWake()
    const svc2 = createAdapterResume({
      ctx: fakeCtx({ ...services, adapterWake: wake2 }), wake: wake2, dshHome: home,
      config: { statePath }, audit: collectAudit().audit,
    })
    const s2 = await svc2.run()
    assert.deepEqual(wake2.calls.resume, ['session-p'], 'preset 没挂上 ≠ 已处理过 ⇒ 下次重启必须重试')
    assert.equal(s2.resumed, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★回归：setupMounted=true ⇒ 仍判成功并写幂等状态（行为不变）', async () => {
  const { services } = scenario()
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  const statePath = join(home, 'users', 'resume-state.json')
  try {
    const wake = createAdapterWake({ ctx: fakeCtx(mkWakeHost({ presets: true })) })

    // ① 通道层：挂上了 ⇒ 一切照旧（ok/presetId/skipped/error 都不变）
    const r = await wake.resumeWithPreset('session-p')
    assert.equal(r.ok, true)
    assert.equal(r.setupMounted, true)
    assert.equal(r.presetId, 'coach', '仍是会话最后选中的 preset')
    assert.equal(r.skipped, null)
    assert.equal(r.error, null)
    assert.equal(r.reason, null, '成功时不得带失败原因')

    // ② 编排层：resume.ok + 写幂等状态
    const audit = collectAudit()
    const svc = createAdapterResume({
      ctx: fakeCtx({ ...services, adapterWake: wake }), wake, dshHome: home,
      config: { statePath }, audit: audit.audit,
    })
    const s = await svc.run()
    assert.equal(s.resumed, 1)
    assert.equal(s.failed, 0)
    const okLine = audit.find('resume.ok')[0]
    assert.equal(okLine.extra.setupMounted, true)
    assert.equal(okLine.extra.statePersisted, true)
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.match(saved.records['session-p'].key, /^sub:session-p:child-1/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('★fail-closed：未知 skip 原因 / 压根没调 setup（skipped 为空）⇒ 一律按失败处理', async () => {
  // 判据只有一条：**挂上了**才算成功；未知原因采取失败是唯一安全的方向
  assert.deepEqual(classifyPresetSetup({ setupMounted: true, skipped: null }), { ok: true, reason: null })
  assert.deepEqual(classifyPresetSetup({ setupMounted: false, skipped: 'agentPresets.mount 不可用' }),
    { ok: false, reason: 'preset-not-mounted' })
  assert.deepEqual(classifyPresetSetup({ setupMounted: false, skipped: '某个以后才出现的未知原因' }),
    { ok: false, reason: 'preset-not-mounted' }, '未知 skip 原因 ⇒ fail-closed')
  assert.deepEqual(classifyPresetSetup({ setupMounted: false, skipped: null }),
    { ok: false, reason: 'preset-not-mounted' }, 'skipped 为空（不知道原因）同样是失败')
  assert.deepEqual(classifyPresetSetup({}), { ok: false, reason: 'preset-not-mounted' })
  // ⚠️ 良性跳过允许清单当前为**空**（事实枚举与依据见 lib/wake.js 的注释）：唯一那条 skip
  //    （`agentPresets.mount 不可用`）是"服务不可用 = 真失败"；而"会话未选 preset 且无默认 preset"
  //    在当前实现里不会产生 skip（presetId 为 undefined 仍会 resolve(undefined) 落 default）。
  //    ⇒ 今天不存在"良性 skip"可断言；若将来登记，必须在此补：reason='preset-benign-skip'
  //      + **仍不写幂等状态**（决策原则：setupMounted !== true ⇒ 不能算成功）+ 走 WARN。

  // 真通道：宿主发布了 agent 却**没调用** setup ⇒ skipped 为空，也必须判失败（不许默认当成功）
  const wake = createAdapterWake({ ctx: fakeCtx(mkWakeHost({ callSetup: false })) })
  const r = await wake.resumeWithPreset('session-p')
  assert.equal(!!r.agent, true)
  assert.equal(r.setupMounted, false)
  assert.equal(r.skipped, null)
  assert.equal(r.ok, false, '不知道 preset 挂没挂 ⇒ 不能算成功（fail-closed）')
  assert.equal(r.reason, 'preset-not-mounted')
})

// ---------------------------------------------------------------------------
// ★test-only 失败注入（T9：唤醒失败 ⇒ 不写幂等状态）。真机实测两条注入路都不通（挪走 .agent-presets 无效、
//   会话日志里没有 preset id），故改用**显式注入**：强制用一个不存在的 preset id，走 T9 想验的那条真实代码路径
//   （preset 挂不上 ⇒ 唤醒失败 ⇒ 不得写状态）。

test('★test-only 注入点（wake）：testForceMissingPresetId 非空 ⇒ 用它替换"决定 preset id"这一步；preset 挂不上 ⇒ 唤醒失败', async () => {
  const readIds = []
  const resolveIds = []
  const madePresets = () => ({
    resolve: async (id) => {
      resolveIds.push(id)
      if (id === 'ghost-preset') throw new Error('preset 不存在: ' + id)
      return { id: id === undefined ? 'default' : id }
    },
    mount: async () => {},
  })
  // 真机形状：宿主在"发布 agent 之前"调用 setup（setup 抛错 ⇒ resume 整体失败）
  const madeCtx = () => fakeCtx({
    agents: { resume: async (arg) => { await arg.setup('AGENTCTX'); return { agent: { id: 'a', send: async () => {} } } } },
    sessionQuery: {
      readSession: async (id) => {
        readIds.push(id)
        return { events: [{ type: 'agent-preset/selected', data: { agentPreset: 'coach' } }], header: { id } }
      },
      listSessions: async () => [],
    },
    agentPresets: madePresets(),
  })

  // ① 默认（不传选项）⇒ 与现在**完全一致**：按会话解析出的 preset 挂载
  const w1 = createAdapterWake({ ctx: madeCtx() })
  const ok1 = await w1.resumeWithPreset('session-p')
  assert.equal(ok1.ok, true)
  assert.equal(ok1.presetId, 'coach')
  assert.equal(ok1.setupMounted, true)
  assert.deepEqual(resolveIds, ['coach'], '默认仍按会话解析出的 preset 挂载')
  assert.deepEqual(readIds, ['session-p'])

  // ② 覆盖 ⇒ 不解析会话 preset，直接拿假 id 去 resolve ⇒ 挂载抛错 ⇒ 唤醒失败（完整流程照常跑，不提前短路）
  readIds.length = 0
  resolveIds.length = 0
  const w2 = createAdapterWake({ ctx: madeCtx() })
  const ok2 = await w2.resumeWithPreset('session-p', { testForceMissingPresetId: 'ghost-preset' })
  assert.equal(ok2.ok, false, 'preset 挂不上 ⇒ 唤醒必须失败（不许伪造成功）')
  assert.equal(ok2.presetId, 'ghost-preset')
  assert.equal(ok2.setupMounted, false)
  assert.match(ok2.error, /preset 不存在/)
  assert.deepEqual(resolveIds, ['ghost-preset'], '直接拿覆盖值去 resolve')
  assert.deepEqual(readIds, [], '"决定 preset id"这一步被替换 ⇒ 不再读会话 preset')

  // ③ 非字符串/空串的选项值一律视为**未启用**（与默认行为一致）
  readIds.length = 0
  resolveIds.length = 0
  const w3 = createAdapterWake({ ctx: madeCtx() })
  const ok3 = await w3.resumeWithPreset('session-p', { testForceMissingPresetId: '' })
  assert.equal(ok3.ok, true)
  assert.equal(ok3.presetId, 'coach')
})

test('★test-only 注入（端到端）：testForceMissingPresetId 非空 ⇒ 唤醒失败 + resume.fail + resume.test_override，且**幂等状态文件里没有该 key**（markResumed 未被调用）', async () => {
  const { services } = scenario()
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  const statePath = join(home, 'users', 'resume-state.json')
  try {
    const audit = collectAudit()
    const wake = mkWake({ failOnTestOverride: true })
    const svc = createAdapterResume({
      ctx: fakeCtx({ ...services, adapterWake: wake }),
      wake, dshHome: home,
      config: { statePath, testForceMissingPresetId: 'ghost-preset' },
      audit: audit.audit,
    })

    // ① 留痕：**构造期**即有一条 WARN resume.test_override（这种开关最怕被遗留在生产里）
    const ov = audit.find('resume.test_override')
    assert.equal(ov.length, 1)
    assert.equal(ov[0].level, 'WARN')
    assert.equal(ov[0].extra.testForceMissingPresetId, 'ghost-preset')
    assert.match(ov[0].message, /ghost-preset/)
    assert.match(ov[0].message, /生产/)
    assert.equal(svc.status().testForceMissingPresetId, 'ghost-preset', 'status() 如实暴露该开关')

    // ② 覆盖值确实透传到了唤醒通道（决定 preset id 这一步被替换）
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, ['session-p'], '（前提）scope 默认 tasks-only ⇒ 候选就是 P1 的 session-p')
    assert.equal(wake.calls.resumeOpts[0].testForceMissingPresetId, 'ghost-preset')

    // ③ 走**既有**失败通道（不新造失败类型）
    assert.equal(s.resumed, 0)
    assert.equal(s.failed, 1)
    const failLine = audit.find('resume.fail', (l) => l.extra.reason === 'wake-failed')[0]
    assert.ok(failLine, '唤醒失败必须落既有的 resume.fail（reason=wake-failed）')
    assert.equal(failLine.extra.stateWritten, false)
    assert.match(failLine.extra.error, /ghost-preset/)
    assert.equal(audit.find('resume.ok').length, 0)

    // ④ "失败不留疤"：幂等状态文件根本不该被创建（markResumed 未被调用 ⇒ 下次重启仍会重试）
    assert.equal(existsSync(statePath), false, '唤醒失败绝不写幂等状态')

    // ⑤ 反证：默认（不设该项）行为与现在完全一致 —— 选项是 `{}`，唤醒照常成功并写状态
    const audit2 = collectAudit()
    const wake2 = mkWake()
    const svc2 = createAdapterResume({
      ctx: fakeCtx({ ...services, adapterWake: wake2 }),
      wake: wake2, dshHome: home,
      config: { statePath },
      audit: audit2.audit,
    })
    assert.equal(audit2.find('resume.test_override').length, 0, '未启用 ⇒ 不得有注入留痕')
    const s2 = await svc2.run()
    assert.deepEqual(wake2.calls.resumeOpts, [{}], '默认透传空选项（行为与改动前一致）')
    assert.equal(s2.resumed, 1)
    assert.equal(existsSync(statePath), true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('P2/P3 未实现必须留痕（resume.not_implemented），且 status() 如实标注实现的层', async () => {
  const { svc, audit, cleanup } = makeResume(scenario().services)
  try {
    await svc.run()
    const ni = audit.find('resume.not_implemented')
    assert.equal(ni.length, 1)
    assert.deepEqual(ni[0].extra.layers, ['P2', 'P3'])
    const st = svc.status()
    assert.deepEqual(st.layers.implemented, ['P1', 'P0'])
    assert.deepEqual(st.layers.notImplemented, ['P2', 'P3'])
    assert.equal(st.service, 'adapterResume')
    assert.equal(st.lastRound.resumed, 1)
    assert.equal(st.state.entries, 1)
    assert.equal(st.dependencies.sessionQuery, true)
    assert.equal(st.dependencies.subagents, true, '子代理服务名是**复数** subagents（真机偏差：写成单数 ⇒ P1 整层静默跳过）')
    assert.equal(st.dependencies.adapterWake, true)
  } finally { cleanup() }
})

test('schedule()：用 setTimeout 延时执行（不阻塞调用方），cancel() 可拦下', async () => {
  const { svc, wake, cleanup } = makeResume(scenario().services, { startDelayMs: 5 })
  try {
    svc.schedule()
    assert.equal(svc.status().scheduled, true)
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(wake.calls.resume, ['session-p'], '到点后自动跑一轮')

    const { svc: svc2, wake: wake2, cleanup: cleanup2 } = makeResume(scenario().services, { startDelayMs: 30 })
    try {
      svc2.schedule()
      svc2.cancel()
      await new Promise((r) => setTimeout(r, 60))
      assert.deepEqual(wake2.calls.resume, [], 'cancel 后不得再唤醒')
    } finally { cleanup2() }
  } finally { cleanup() }
})

test('statePath 可由配置覆盖，默认落在 $DSH_HOME/users/resume-state.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'rob-resume-'))
  try {
    const custom = createAdapterResume({ ctx: fakeCtx({}), dshHome: home, config: { statePath: join(home, 'custom', 'x.json') } })
    assert.equal(custom.status().state.path, join(home, 'custom', 'x.json'))
    const dflt = createAdapterResume({ ctx: fakeCtx({}), dshHome: home })
    assert.equal(dflt.status().state.path, join(home, 'users', 'resume-state.json'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ★明细审计（2026-09-22 补，**只加审计、不改任何判据**）：真机实录"survivors=1 但 P1=0"，
//   而原审计只报**条数** ⇒ 分不清 "幸存的其实是另一个会话"（正确行为）还是
//   "幸存者就是那个父会话、只是 listChildren 返回了空数组"（P1 仍有 bug）。以下用例把两者分开。

test('★明细审计：每个幸存者一条 resume.survivor（字段齐全，不夹带 header，明细不进汇总行）', async () => {
  const { svc, audit, cleanup } = makeResume(scenario().services, { scope: 'all', dryRun: true })
  try {
    const s = await svc.run()
    const lines = audit.find('resume.survivor')
    assert.equal(lines.length, s.survivors, '幸存者逐条一行（数量与汇总一致）')
    assert.deepEqual(lines.map((l) => l.extra.sessionId).sort(), ['session-p', 'session-q', 'session-r'])
    for (const l of lines) {
      assert.equal(l.level, 'INFO')
      for (const k of ['sessionId', 'lastActiveAt', 'lastActiveSource', 'lastEventType', 'lastEventSeq',
        'hasSessionFile', 'cwd', 'origin', 'createdAt', 'windowMs', 'now']) {
        assert.ok(k in l.extra, 'resume.survivor 必须带字段 ' + k)
      }
      // 明细必须**有界**：不得夹带整个 header
      assert.equal(l.extra.header, undefined)
    }
    assert.equal(lines[0].extra.cwd, '/srv/ws')
    assert.equal(lines[0].extra.windowMs, WINDOW, '“窗口套在哪一列上”要能人工核对')
    // 汇总行保持精简：明细**不进**汇总行（便于一眼扫）
    const prescan = audit.find('resume.prescan')[0]
    assert.equal(prescan.extra.details, undefined)
    assert.equal(prescan.extra.survivorDetails, undefined)
    assert.equal(prescan.extra.candidates, undefined)
  } finally { cleanup() }
})

test('★明细审计：P1 命中时 resume.judge 的 verdict=p1-candidate、openChildren 含预期子会话 id', async () => {
  const { svc, audit, cleanup } = makeResume(scenario().services, { scope: 'all', dryRun: true })
  try {
    await svc.run()
    const judges = audit.find('resume.judge')
    assert.equal(judges.length, 3, '每个幸存者一条 resume.judge')

    const p1 = judges.find((l) => l.extra.sessionId === 'session-p')
    assert.equal(p1.level, 'INFO')
    assert.equal(p1.extra.path, 'p1-eval')
    assert.equal(p1.extra.ownKind, 'closed')
    assert.equal(p1.extra.ownTurn, 1)
    assert.equal(p1.extra.childSource, 'service')
    assert.equal(p1.extra.childrenRawCount, 1)
    assert.equal(p1.extra.serviceChildrenCount, 1)
    assert.equal(p1.extra.childrenChecked, 1)
    assert.equal(p1.extra.verdict, 'p1-candidate')
    assert.deepEqual(p1.extra.openChildren.map((c) => c.id), ['child-1'])
    assert.equal(p1.extra.openChildren[0].ownKind, 'open')
    // childrenRawSample 是**形态摘要**（有界）：要能看出返回的是 {id, mode, label, activity} 这种条目
    assert.equal(p1.extra.childrenRawSample.length, 1)
    assert.equal(p1.extra.childrenRawSample[0].shape, 'object')
    assert.equal(p1.extra.childrenRawSample[0].id, 'child-1')
    assert.deepEqual(p1.extra.childrenRawSample[0].keys, ['id', 'mode', 'label', 'activity', 'hasChildren'])
    assert.match(p1.message, /verdict=p1-candidate/)

    // 没走 P1 评估的会话也要有明细（P0 路径）
    const q = judges.find((l) => l.extra.sessionId === 'session-q')
    assert.equal(q.extra.path, 'p0')
    assert.equal(q.extra.verdict, undefined)
    // 汇总行仍精简：不含 details 明细数组
    assert.equal(audit.find('resume.scan')[0].extra.details, undefined)
  } finally { cleanup() }
})

test('★分歧告警：服务返回空数组 + header 有子会话 ⇒ WARN child-source-disagreement（两个数量都对），childSource 仍是 service', async () => {
  const logs = { 'session-p': [turnStart(1), turnEnd(1, 'completed')] }
  const records = [record(header('session-p'))]
  for (const cid of ['child-a', 'child-b', 'child-c']) records.push(subagentRecord(cid, 'session-p'))
  const services = {
    sessionQuery: mkSessionQuery({ records, logs }),
    sessionProjectionCache: mkProjection({}),
    // ★服务"说没有子会话"（返回空数组），而 header 明明派生出 3 个
    subagents: mkSubagent({ 'session-p': [] }),
  }
  const { svc, audit, cleanup } = makeResume(services, { scope: 'all', dryRun: true })
  try {
    const s = await svc.run()
    assert.equal(s.survivors, 1)
    assert.deepEqual(s.candidates, [], '（前提）服务说没有子会话 ⇒ 本轮 P1=0（这正是真机待解释的现象）')

    const warn = audit.find('resume.child_source_disagreement')
    assert.equal(warn.length, 1, '服务/header 分歧必须有一条 WARN，否则"P1 失灵"看不出来')
    assert.equal(warn[0].level, 'WARN')
    assert.equal(warn[0].extra.reason, 'child-source-disagreement')
    assert.equal(warn[0].extra.serviceChildrenCount, 0)
    assert.equal(warn[0].extra.headerChildrenCount, 3, '两个数量都必须报出来')
    assert.equal(warn[0].extra.sessionId, 'session-p')
    assert.equal(warn[0].extra.childSource, 'service')
    assert.match(warn[0].message, /返回 0 条/)
    assert.match(warn[0].message, /header 派生有 3 条/)

    const judge = audit.find('resume.judge', (l) => l.extra.sessionId === 'session-p')[0]
    assert.equal(judge.extra.childSource, 'service', '★判据不许被悄悄改掉：仍以服务返回为准')
    assert.equal(judge.extra.verdict, 'empty-children')
    assert.equal(judge.extra.childrenRawCount, 0)
    assert.equal(judge.extra.headerChildrenCount, 3)
    assert.equal(judge.extra.childSourceDisagreement.serviceChildrenCount, 0)
    assert.equal(audit.find('resume.scan')[0].extra.childSource, 'service', 'stats 里的来源也仍是 service')
  } finally { cleanup() }
})

test('★明细审计：服务不可用走 header 兜底 ⇒ childSource=headers、verdict 正常、无分歧告警', async () => {
  const logs = {
    'session-p': [turnStart(1), turnEnd(1, 'completed')],
    'child-open': [turnStart(2)],
  }
  const services = {
    sessionQuery: mkSessionQuery({
      records: [record(header('session-p')), subagentRecord('child-open', 'session-p')], logs,
    }),
    sessionProjectionCache: mkProjection({}),
    // 刻意**不给** subagents / subagent：走 header 兜底
  }
  const { svc, wake, audit, cleanup } = makeResume(services, { scope: 'all' })
  try {
    const s = await svc.run()
    assert.deepEqual(wake.calls.resume, ['session-p'], 'P1 经 header 兜底照常命中')

    const judge = audit.find('resume.judge', (l) => l.extra.sessionId === 'session-p')[0]
    assert.equal(judge.extra.childSource, 'headers')
    assert.equal(judge.extra.path, 'p1-eval')
    assert.equal(judge.extra.serviceChildrenCount, null, '服务没被调用 ⇒ null（与"返回 0 条"是两件事）')
    assert.equal(judge.extra.headerChildrenCount, 1)
    assert.equal(judge.extra.verdict, 'p1-candidate')
    assert.deepEqual(judge.extra.openChildren.map((c) => c.id), ['child-open'])
    assert.equal(judge.extra.childrenRawSample[0].shape, 'string', 'header 兜底给的是裸 id 字符串')
    assert.equal(audit.find('resume.child_source_disagreement').length, 0, '没走服务路径 ⇒ 无"分歧"可言')
    assert.equal(s.resumed, 1)
  } finally { cleanup() }
})
