// @local/dsh-adapter —— 重启自恢复（P3）：配置与编排
//
// 归属（P3 计划 §2D D5，用户裁定）：唤醒与扫描**唯一实现在 adapter**，
//   `ctx.provide('adapterResume', …)` 是入口；`plugins/resume-on-boot/`（Phase 1 骨架，从未注册进 profile）作废。
//   这样做同时避开了"往 dsh.profile.bundles 里加包会让整个内核起不来"的高危区。
//
// 编排（设计 §8.1 时序的 adapter 版）：
//   1. `startDelayMs` 定时器到点（apply 期**不做**扫描、不阻塞）—— 给内核其余部分留出就绪时间
//   2. 一级预筛（./scan.js prescan）→ 3. 二级判定（judgeCandidates，P1→P0 分层）
//   4. 去重（./state.js，键含 `sub:<parentId>` / `turn:<n>`，D3+D6）
//   5. 逐会话 `adapterWake.resumeWithPreset(...)`（复用既有唤醒通道，不重写）
//   6. 注入可追溯说明（`adapterWake.injectNotice`，inbox 投递，U2b 裁决）
//   7. **成功之后**才写幂等状态（失败不得写，否则永不重试）
//   8. 单个失败 → 记审计 → 继续（设计 §8.2 硬要求）
//
// 依赖纪律（与 wake.js 同）：**不进 adapter 的 inject**，全部惰性 `ctx.get`；
//   apply 期零宿主调用、零阻塞异步、绝不抛（adapter 在最小集里，抛错会直接让宿主起不来）。

import { ResumeState, statePathForHome, resolveStatePath } from './state.js'
import { resumeKeyFor } from './detect.js'
import { buildSessionFileIndex } from './tail.js'
import { LAYER, DEFAULT_RECENT_WINDOW_MS, prescanSessions, judgeCandidates, selectByLayer } from './scan.js'

/** 默认配置（P3 §Phase 3 的口径 + §2B 的时间窗） */
export const DEFAULT_CONFIG = {
  enabled: true, // 总开关（蓝绿影子实例必须置 false，否则两个实例抢同一会话的唤醒）
  scope: 'tasks-only', // 'tasks-only'（默认，D4）| 'all'
  startDelayMs: 0, // 启动后延时再扫描；真机建议 5000~15000
  maxResumePerBoot: 5, // 单次启动最多唤醒数，防重启风暴
  dryRun: false, // true = 只扫描并输出候选清单，不唤醒
  recentWindowMs: DEFAULT_RECENT_WINDOW_MS, // 一级预筛的时间窗（默认 6h）
  stateMaxAgeDays: 30, // 幂等状态保留天数
  statePath: undefined, // 可由配置覆盖；默认 $DSH_HOME/users/resume-state.json
  // ⚠️ test-only（命名必须带 test）：真机验收"唤醒失败 ⇒ 不写幂等状态"（T9）用的失败注入开关。
  //    非空字符串 = 唤醒时**强制**使用这个（不存在的）preset id ⇒ preset 必然挂不上 ⇒ 唤醒走既有失败通道。
  //    仅供真机验收失败路径，**生产不得设置**；启用时会留 WARN 审计 `resume.test_override`（见下）。
  testForceMissingPresetId: null,
}

const SCOPES = ['tasks-only', 'all']

const num = (raw, v, dft, min, warnings, label) => {
  if (v === undefined || v === null || v === '') return dft
  const n = Number(v)
  if (!Number.isFinite(n) || n < min) {
    warnings.push(`${label} 非法(${JSON.stringify(v)})，回退默认 ${dft}`)
    return dft
  }
  return n
}

/**
 * 配置归一化（带校验）。非法值**不抛**，回退默认并记录 warning —— 配置写错不该让内核起不来。
 * 两种写法都认：`adapter.resume.{…}`（推荐）与 `adapter.resumeOnBoot.{…}`；也接受扁平对象（便于单测）。
 *
 * @returns {{ cfg: object, warnings: string[] }}
 */
export function normalizeConfig(config) {
  const src = config && typeof config === 'object' ? config : {}
  const raw = (src.resume && typeof src.resume === 'object') ? src.resume
    : (src.resumeOnBoot && typeof src.resumeOnBoot === 'object') ? src.resumeOnBoot
      : src
  const warnings = []

  let scope = raw.scope === undefined ? DEFAULT_CONFIG.scope : String(raw.scope)
  if (!SCOPES.includes(scope)) {
    warnings.push(`scope 非法(${JSON.stringify(raw.scope)})，回退默认 ${DEFAULT_CONFIG.scope}`)
    scope = DEFAULT_CONFIG.scope
  }
  // ⚠️ test-only 失败注入（T9 真机验收"唤醒失败 ⇒ 不写幂等状态"）：
  //    仅接受**非空字符串**（要强制使用的假 preset id）；null/undefined = 不启用（默认）。
  //    其它任何值（数字/布尔/空串/空白串/数组/对象）一律回退 null 并记 warning —— 沿用本函数"不抛"的风格。
  //    命名必须带 test：**生产不得设置该项**；启用时构造期留 WARN 审计 `resume.test_override`（见下）。
  let testForceMissingPresetId = DEFAULT_CONFIG.testForceMissingPresetId
  const rawForce = raw.testForceMissingPresetId
  if (rawForce !== undefined && rawForce !== null) {
    if (typeof rawForce === 'string' && rawForce.trim() !== '') {
      testForceMissingPresetId = rawForce
    } else {
      warnings.push(`testForceMissingPresetId 非法(${JSON.stringify(rawForce)})，回退默认 null（该项 test-only，仅接受非空字符串）`)
      testForceMissingPresetId = null
    }
  }
  const cfg = {
    enabled: raw.enabled === undefined ? DEFAULT_CONFIG.enabled : !!raw.enabled,
    scope,
    startDelayMs: num(raw, raw.startDelayMs, DEFAULT_CONFIG.startDelayMs, 0, warnings, 'startDelayMs'),
    maxResumePerBoot: num(raw, raw.maxResumePerBoot, DEFAULT_CONFIG.maxResumePerBoot, 0, warnings, 'maxResumePerBoot'),
    dryRun: raw.dryRun === undefined ? DEFAULT_CONFIG.dryRun : !!raw.dryRun,
    recentWindowMs: num(raw, raw.recentWindowMs, DEFAULT_CONFIG.recentWindowMs, 1, warnings, 'recentWindowMs'),
    stateMaxAgeDays: num(raw, raw.stateMaxAgeDays, DEFAULT_CONFIG.stateMaxAgeDays, 1, warnings, 'stateMaxAgeDays'),
    statePath: raw.statePath ? String(raw.statePath) : undefined,
    testForceMissingPresetId,
  }
  return { cfg, warnings }
}

/** 可选依赖体检（惰性、只读；缺什么明说，供审计与诊断） */
function dependencyStatus(ctx) {
  const has = (name, member) => {
    try {
      const svc = ctx && typeof ctx.get === 'function' ? ctx.get(name) : null
      return !!(svc && (!member || typeof svc[member] === 'function'))
    } catch (_) { return false }
  }
  return {
    sessionQuery: has('sessionQuery', 'listSessions'),
    sessionProjectionCache: has('sessionProjectionCache', 'cachedSnapshot'),
    // ⚠️ 服务名是**复数** `subagents`（内核注册 `super(ctx, "subagents")`）；
    // 真机偏差实录：只查单数 `subagent` ⇒ 这里恒为 false、且 P1 整层静默跳过（只留一条 WARN）。
    // 故复数优先、单数兜底，体检结果必须与 scan.js 的实际取值口径一致。
    subagents: has('subagents', 'listChildren') || has('subagent', 'listChildren'),
    adapterWake: has('adapterWake', 'resumeWithPreset'),
  }
}

/** P1 的说明文本：必须含"你的子代理 <childId> 在重启时被中断"这类可追溯信息（§2D 唤醒目标纪律） */
export function noticeTextFor(candidate) {
  const open = Array.isArray(candidate.openChildren) ? candidate.openChildren : []
  const childList = open.map((c) => c.id + '(' + (c.kind || '?') + (c.turn == null ? '' : ' turn=' + c.turn) + ')').join(', ')
  if (candidate.layer === LAYER.P1) {
    return '<resume-notice plugin="dsh-adapter" layer="P1" session="' + candidate.sessionId + '" child="' + (candidate.childId || '') + '">\n'
      + '服务端重启：你的子代理 ' + (candidate.childId || '(未知)') + ' 在重启时被中断（未闭合：' + (childList || '—') + '）。\n'
      + '本会话（父会话）已由 @local/dsh-adapter 的 adapterResume 自动恢复，请自行决定继续推进还是放弃这次子代理任务。\n'
      + '注意：本次不会自动冷恢复子代理（子会话没有用户来源，需由你重新派发）。\n'
      + '</resume-notice>'
  }
  // P0 + 在飞委派（前台委派被掐断）：**必须同时说清两件事** —— 上一轮被中断、且当时在等子代理。
  // 只说"上一轮被中断"会让模型以为可以从中断处接着写，从而**忽略掉那个被掐断的子任务**。
  if (candidate.delegationInFlight) {
    return '<resume-notice plugin="dsh-adapter" layer="P0" session="' + candidate.sessionId
      + '" turn="' + (candidate.turn == null ? '' : candidate.turn) + '" in-flight-children="' + open.length + '">\n'
      + '服务端重启：本会话上一轮 turn' + (candidate.turn == null ? '' : ' #' + candidate.turn) + ' 在重启时被中断，'
      + '**并且当时正在等子代理**（未闭合：' + (childList || '—') + '）。\n'
      + '本会话已由 @local/dsh-adapter 的 adapterResume 自动恢复，请自行决定继续推进还是放弃这次子代理任务。\n'
      + '注意：本次不会自动冷恢复子代理（子会话没有用户来源，需由你重新派发）。\n'
      + '</resume-notice>'
  }
  return '<resume-notice plugin="dsh-adapter" layer="P0" session="' + candidate.sessionId + '" turn="' + (candidate.turn == null ? '' : candidate.turn) + '">\n'
    + '服务端重启：本会话上一轮 turn' + (candidate.turn == null ? '' : ' #' + candidate.turn) + ' 在重启时被中断（' + (candidate.reasonKind || candidate.ownKind || '?') + '），已自动恢复，请从中断处继续。\n'
    + '</resume-notice>'
}

/**
 * 构造 adapterResume 服务（**建对象不碰宿主** ⇒ apply 期零成本）。
 *
 * @param {object} opts
 * @param {object} opts.ctx     宿主 ctx（全部依赖惰性 ctx.get）
 * @param {Function} [opts.log] 诊断日志器（adapter 里接 logApply）
 * @param {Function} [opts.audit] 审计落盘 (level, event, message, extra) —— 复用 adapter 既有审计通道
 * @param {object} [opts.wake]  adapterWake（唤醒通道，缺失时明确拒绝唤醒并留痕，不静默降级）
 * @param {string} [opts.dshHome] DSH_HOME（状态文件默认落 `<home>/users/resume-state.json`）
 * @param {object} [opts.config] 配置（见 normalizeConfig）
 * @param {Function} [opts.now]  时钟（可注入，便于单测）
 */
export function createAdapterResume({
  ctx, log = () => {}, audit = () => {}, wake = null, dshHome = '', config = {}, now = Date.now,
} = {}) {
  const { cfg, warnings } = normalizeConfig(config)
  const state = new ResumeState({
    path: cfg.statePath || statePathForHome(dshHome) || resolveStatePath(),
    log: { warn: (m, x) => log(m + (x ? ' ' + JSON.stringify(x) : '')) },
  })
  const emit = (level, event, message, extra) => {
    try { audit(level, event, message, extra || {}) } catch (_) { /* 审计失败不阻断 */ }
  }
  for (const w of warnings) {
    log('CONFIG_WARN ' + w)
    emit('WARN', 'resume.skip', '配置项非法，已回退默认值：' + w, { reason: 'invalid-config', warning: w })
  }

  // ⚠️ test-only 失败注入开关的**留痕**：这类开关最怕被遗留在生产里 ⇒ 一旦启用就 WARN。
  //    刻意放在**构造期**（而不是等 run）：即便本轮扫描/唤醒没跑到（enabled=false、dryRun、依赖缺失），
  //    审计里也照样能一眼看出"这个实例被注入了假 preset id"。
  if (cfg.testForceMissingPresetId) {
    log('TEST_OVERRIDE testForceMissingPresetId=' + cfg.testForceMissingPresetId)
    emit('WARN', 'resume.test_override',
      '⚠️ test-only 注入已启用：唤醒时将**强制**使用测试用的假 preset id `' + cfg.testForceMissingPresetId
      + '`（preset 必然挂不上 ⇒ 唤醒必然失败，用于验收"失败不写幂等状态"）；该开关仅供真机验收失败路径，生产不得设置 testForceMissingPresetId',
      { reason: 'test-only-preset-override', testForceMissingPresetId: cfg.testForceMissingPresetId })
  }

  let stateLoaded = false
  const ensureState = () => {
    if (!stateLoaded) { stateLoaded = true; try { state.load() } catch (e) { log('state.load 异常: ' + errMsg(e)) } }
    return state
  }

  let timer = null
  let lastRound = null
  let scheduled = false

  const brief = (c) => ({
    sessionId: c.sessionId, layer: c.layer, key: resumeKeyFor(c),
    turn: c.turn == null ? null : c.turn,
    childId: c.childId || null,
    // ★2026-09-22：P0 的两个子类必须可分辨（纯 P0 只记审计、"P0+在飞委派"会唤醒），
    //   否则审计里看到 layer=P0 完全推不出"为什么它被唤醒了"。
    delegationInFlight: c.delegationInFlight === true,
    // 子会话枚举走了哪条路径（'service' | 'headers'；见 scan.js judgeCandidates）——
    // 真机排查"P1/P0在飞 为什么没跑起来"时，这条字段比 WARN 文字更直接
    childSource: c.childSource || null,
    openChildren: Array.isArray(c.openChildren) ? c.openChildren.map((x) => x.id) : [],
    lastActiveAt: c.lastActiveAt || null, lastActiveSource: c.lastActiveSource || null,
  })

  /**
   * 跑一轮扫描 + 唤醒。**整体 try/catch，绝不抛**（调用方是定时器回调）。
   * @returns {Promise<object>} 本轮摘要（同时进 status().lastRound）
   */
  async function run() {
    const started = Number(now())
    const summary = {
      ok: false, enabled: cfg.enabled, scope: cfg.scope, dryRun: cfg.dryRun,
      total: 0, survivors: 0, candidates: [], selected: [], notImplemented: [LAYER.P2, LAYER.P3],
      resumed: 0, skipped: 0, failed: 0, durationMs: 0, reason: null,
      // 一级预筛的来源分布（tail/lastPromptAt/createdAt/none）——「一眼可见」的落点，见 resume.prescan 审计
      prescanStats: null,
    }
    lastRound = summary
    try {
      const st = ensureState()
      st.prune({ maxAgeMs: cfg.stateMaxAgeDays * 24 * 3600 * 1000, now: Number(now()) })

      if (!cfg.enabled) {
        // P3 §Phase 3 验收：enabled=false 时唤醒次数必须为 0（日志可查）
        summary.reason = 'enabled=false'
        emit('INFO', 'resume.skip', 'resume 已禁用（enabled=false）：本轮不扫描、不唤醒（蓝绿影子实例必须如此）',
          { reason: 'enabled=false', scope: cfg.scope, dryRun: cfg.dryRun })
        return summary
      }

      const deps = dependencyStatus(ctx)

      // ---- 一级预筛 ----
      // dshHome 必须传：U8 的闸门读的是 `<home>/sessions/<bucket>/<id>/session.jsonl.zstd` 的**最后一帧**
      // （不传就等于把 tail 那级整体关掉，只剩 lastPromptAt/createdAt —— 正是 U7b 的坏法）
      // U10：会话文件索引只建**一次**，一级预筛（读尾帧拿时间）与二级判定（读尾帧拿末态）共用同一份
      // （建索引要遍历 ~554 个会话目录；各建一遍纯属浪费）
      const sessionIndex = buildSessionFileIndex(dshHome)
      const pre = await prescanSessions({ ctx, dshHome, index: sessionIndex, now, recentWindowMs: cfg.recentWindowMs })
      if (!pre.ok) {
        summary.reason = pre.reason
        emit('WARN', 'resume.fail', '一级预筛无法进行，本轮放弃（不抛、不影响内核启动）',
          { reason: pre.reason, dependencies: deps })
        return summary
      }
      summary.total = pre.total
      summary.survivors = pre.survivors.length
      summary.prescanStats = pre.stats
      // 一级预筛的**来源分布**必须一眼可见（U7b 就是靠"每条都写着 createdAt"才发现闸门套错了量）：
      // 若这里 sources.tail 常年为 0 而 createdAt 占满，说明尾帧那级坏了/索引没建起来（indexSize=0/tailFailed 高）。
      emit('INFO', 'resume.prescan', '一级预筛完成：tail=' + pre.stats.sources.tail + ' lastPromptAt=' + pre.stats.sources.lastPromptAt
        + ' createdAt=' + pre.stats.sources.createdAt + ' none=' + pre.stats.sources.none
        + ' → 幸存 ' + pre.survivors.length + '/' + pre.total, {
        ...pre.stats, recentWindowMs: cfg.recentWindowMs, dryRun: cfg.dryRun,
      })
      // 每个幸存者**一条明细**（`resume.survivor`）：只报条数时，"survivors=1 的到底是哪一个会话"
      // 无从得知 —— 真机 12h 窗就卡在这儿（分不清"幸存者是另一个会话"还是"幸存者就是这个父会话、
      // 只是子枚举返回了空"）。幸存者数量很小，不会刷屏；明细**不进**上面那条汇总行。
      for (const s of pre.survivors) {
        const d = s.detail || { sessionId: s.sessionId }
        emit('INFO', 'resume.survivor', '一级预筛幸存者：' + d.sessionId
          + ' lastActiveAt=' + iso(d.lastActiveAt) + '(source=' + d.lastActiveSource + ')'
          + ' hasSessionFile=' + !!d.hasSessionFile
          + '（窗口 now=' + iso(d.now) + ' - ' + (d.windowMs == null ? '?' : d.windowMs) + 'ms）', d)
      }
      for (const s of pre.skipped) {
        summary.skipped++
        // 窗口外跳过**必须**入审计（§2B 降级链第 3 级：便于以后按真数据回调 recentWindowMs）
        emit(s.reason && s.reason.indexOf('subagent') === 0 ? 'DEBUG' : 'INFO', 'resume.skip', s.reason || '跳过',
          { ...s, layer: null, reason: s.reason })
      }

      // ---- 二级判定 ----
      // U10：末态判定改为**尾帧优先（只读尾窗）、全量兜底**，用的就是一级预筛那份索引 ⇒
      // 不再对父会话逐个读 135 个子会话的完整日志（真机 190 秒那轮的瓶颈）。
      // `childrenByParent` 是一级预筛从 header 派生的父子关系（D6）⇒ 传给 P1 作**不依赖服务**的兜底来源
      const judged = await judgeCandidates({
        ctx, survivors: pre.survivors, childrenByParent: pre.childrenByParent, index: sessionIndex, now,
      })
      summary.candidates = judged.candidates.map(brief)
      // 每个幸存者**一条判定明细**（`resume.judge`）：走了哪条路径、末态是尾帧还是回退读全量的、
      // 子枚举到底返回了什么（含 `childrenRawSample` 前 3 条形态、`openChildren`、`verdict`）
      // ——同样**不进**汇总行。
      for (const d of judged.details) {
        emit('INFO', 'resume.judge', '二级判定：' + d.sessionId + ' own=' + (d.ownKind || '?')
          + (d.ownTurn == null ? '' : ' turn=' + d.ownTurn) + ' via=' + (d.ownStateSource || '?')
          + ' path=' + d.path
          // ★P0+在飞委派：这条路径此前不存在（P0 直接 continue），必须在审计里一眼可见
          + (d.path === 'p0-with-delegation'
            ? ' **前台委派在飞** open=' + d.openChildrenTotal + ' childSource=' + d.childSource
            : '')
          + (d.verdict ? ' verdict=' + d.verdict : '')
          + (d.path === 'p1-eval'
            ? ' childSource=' + d.childSource + ' childrenRaw=' + d.childrenRawCount
              + '(service=' + jsonish(d.serviceChildrenCount) + ' headers=' + jsonish(d.headerChildrenCount) + ')'
              + ' checked=' + d.childrenChecked + ' open=' + d.openChildrenTotal
              + ' childStates(tail/read)=' + stateCounts(d.childStateSources)
              + ' desc=' + descBrief(d.desc)
            : ''), d)
        // ★对照审计的**决定性信号**（P3-U11-DESC）：`listDescendants` 看到了本次来源**没给**的条目，
        //   而且其中还有未闭合的 ⇒ 说明"当前枚举路径存在检出漏报"，这才值得升级。
        //   只报 direct/deeper 差异**本身**不报（孙代差异会常出现，报了就是噪声）。
        const dsc = d.desc
        if (dsc && dsc.source === 'ok' && (dsc.onlyInDescDirectTotal > 0 || dsc.deltaOpenTotal > 0)) {
          emit('WARN', 'resume.desc_missed',
            '枚举漏报信号：listDescendants 给出 ' + dsc.rawCount + ' 条后代（child=' + dsc.childCount
            + ' diag=' + dsc.diagnosticCount + '），而本次来源只有 ' + d.childrenRawCount + ' 条；'
            + '其中**直接子代**多出 ' + dsc.onlyInDescDirectTotal + ' 条、'
            + '抽样 ' + dsc.deltaChecked + '/' + dsc.deltaTotal + ' 条差异项里**未闭合** ' + dsc.deltaOpenTotal + ' 条'
            + '（会话 ' + d.sessionId + '，childSource=' + d.childSource + '）'
            + '—— 仅作对照记录，**判据未改**（仍以 listChildren / header 为准），是否升级待定',
            { ...dsc, sessionId: d.sessionId, childSource: d.childSource, childrenRawCount: d.childrenRawCount, verdict: d.verdict || null })
        }
        const dis = d.childSourceDisagreement
        if (dis) {
          // ★分歧告警（真机定位"survivors=1 但 P1=0"的关键一条）：**只告警、不改变判据** ——
          //   仍以服务返回为准（childSource 保持 'service'），绝不因为发现分歧就自动改用 header 兜底
          //  （那会悄悄改变行为，是更坏的做法）。两个数量都报出来，一眼可见。
          emit('WARN', 'resume.child_source_disagreement',
            '子会话来源分歧：服务 listChildren 返回 ' + dis.serviceChildrenCount + ' 条，而 header 派生有 '
            + dis.headerChildrenCount + ' 条（会话 ' + d.sessionId + '）'
            + '——仍以服务返回为准（未自动改用 header 兜底），请人工核对该父会话的血缘',
            { ...dis, sessionId: d.sessionId, childSource: d.childSource, verdict: d.verdict || null })
        }
      }
      for (const s of judged.skipped) {
        summary.skipped++
        emit('WARN', 'resume.skip', '二级判定跳过：' + s.reason, { ...s, layer: s.layer || null })
      }
      if (!judged.stats.subagentAvailable && !judged.stats.headerChildrenAvailable) {
        // P1 层整体跳过（两条子会话来源都不可用）：不报错、不让 P3 整体失败，但必须留痕
        emit('WARN', 'resume.skip', 'P1 的子会话来源两条都不可用（subagents 服务缺失 + header 里没有父子关系）：'
          + 'P1 层（父已闭合 + 子未闭合）整体跳过，P0 不受影响',
        { reason: 'child-source-unavailable', layer: LAYER.P1, subagentsAvailable: false, headerChildrenAvailable: false })
      }

      // ---- 分层选择（scope / maxResumePerBoot）----
      const picked = selectByLayer(judged.candidates, { scope: cfg.scope, maxResume: cfg.maxResumePerBoot })
      summary.selected = picked.resume.map(brief)
      for (const s of picked.skip) {
        summary.skipped++
        emit('INFO', 'resume.skip', '未唤醒：' + s.reason, { ...brief(s), reason: s.reason })
      }

      // ---- 本轮扫描审计（dryRun 时的"候选清单"就是这条）----
      emit('INFO', 'resume.scan', '扫描完成：候选 ' + judged.candidates.length + ' 个（P1=' + judged.stats.p1
        + ' P0在飞=' + judged.stats.p0InFlight + ' P0=' + judged.stats.p0
        + '），选中 ' + picked.resume.length + ' 个，子会话来源=' + judged.stats.childSource
        + '，末态取法 tail=' + judged.stats.tailJudged + '/回退读全量=' + judged.stats.fallbackReads
        + '/未判[T1-2 已禁用全量回退]=' + judged.stats.fullReadSkipped
        + '（尾帧判不了 ' + judged.stats.tailJudgeFailed + ' 次，尾窗上限 ' + judged.stats.maxTail + ' 字节）'
        // ★P3-U11-DESC：后代对照审计的汇总必须一眼可见 —— `漏报` > 0 才是"该考虑换枚举路径"的依据
        + '，后代对照[可用=' + judged.stats.descAvailable + ' 比较=' + judged.stats.descCompared
        + ' 失败=' + judged.stats.descFailed + ' **漏报=' + judged.stats.descMissed + '**'
        + ' 抽样判turn=' + judged.stats.descDeltaChecked + '/未闭合=' + judged.stats.descDeltaOpen + ']'
        + '，累计 ' + totalMs(started, now) + 'ms',
        {
          total: summary.total, survivors: summary.survivors, skipped: summary.skipped,
          p1: judged.stats.p1, p0: judged.stats.p0, p0InFlight: judged.stats.p0InFlight,
          readFailed: judged.stats.readFailed,
          // P1 的子会话枚举来源必须一眼可见：'service'=subagents 服务 / 'headers'=header 兜底 / 'none'=两条都没用上
          childSource: judged.stats.childSource,
          subagentsAvailable: judged.stats.subagentAvailable,
          headerChildrenAvailable: judged.stats.headerChildrenAvailable,
          childReadFailed: judged.stats.childReadFailed, childListFailed: judged.stats.childListFailed,
          // ★U10 末态取法分布（**只是计数**）：tailJudged 常年偏小 / fallbackReads 偏大 ⇒ 尾窗上限需要调
          tailJudged: judged.stats.tailJudged, fallbackReads: judged.stats.fallbackReads,
          tailJudgeFailed: judged.stats.tailJudgeFailed, maxTail: judged.stats.maxTail,
          // ★T1-2：因"已禁用全量回退"而**未判**的次数（= 本轮漏判数；与 tailJudgeFailed 一起看，
          //   能立刻区分"尾帧判不了但读了全量救回来"与"判不了且按新策略没读"）
          fullReadSkipped: judged.stats.fullReadSkipped,
          // ★P3-U11-DESC 后代对照审计的汇总（只有标量；`descMissed` 是升级枚举路径的唯一依据）
          descAvailable: judged.stats.descAvailable, descCompared: judged.stats.descCompared,
          descFailed: judged.stats.descFailed, descMissed: judged.stats.descMissed,
          descDeltaChecked: judged.stats.descDeltaChecked, descDeltaOpen: judged.stats.descDeltaOpen,
          selected: summary.selected, candidates: summary.candidates,
          scope: cfg.scope, dryRun: cfg.dryRun, recentWindowMs: cfg.recentWindowMs,
          enabled: cfg.enabled, dependencies: deps,
        })

      // P2/P3 未实现必须留痕（本仓纪律：装了但没做的事要显式说，别让人以为已在工作）
      emit('INFO', 'resume.not_implemented',
        'P2（active goal）/ P3（外部插件注册信号）本轮未实现：接入位置见 lib/resume/scan.js 的 TODO(P2) 与 lib/resume/index.js 的 TODO(P3/registerSignalProvider)',
        { layers: [LAYER.P2, LAYER.P3], hooks: ['lib/resume/scan.js#judgeCandidates#TODO(P2)', 'lib/resume/index.js#createAdapterResume#TODO(P3)'] })

      if (cfg.dryRun) {
        // dryRun：只产出候选清单与审计，**不调用唤醒**
        for (const c of picked.resume) {
          summary.skipped++
          emit('INFO', 'resume.skip', 'dryRun=true：只扫描不唤醒', { ...brief(c), reason: 'dryRun' })
        }
        summary.ok = true
        return summary
      }

      // ---- 唤醒（复用 adapterWake，不重写）----
      const wakeOk = !!(wake && typeof wake.resumeWithPreset === 'function')
      const wakeAvail = (wake && typeof wake.available === 'function') ? safeAvailable(wake) : null
      if (!wakeOk) {
        summary.reason = 'adapterWake-unavailable'
        // 明确拒绝恢复并告警，**不静默地不恢复**（P3 §2A 硬要求）
        emit('ERROR', 'resume.fail', 'adapterWake 不可用：明确拒绝唤醒（不静默降级）；本轮候选保留，待依赖就绪后再重启扫描',
          { reason: 'adapterWake-unavailable', selected: summary.selected, wakeAvailable: wakeAvail })
        return summary
      }
      if (wakeAvail && wakeAvail.ok === false) {
        emit('WARN', 'resume.fail', '唤醒通道依赖不全：' + (wakeAvail.missing || []).join(',') + '（仍尝试唤醒，由 adapterWake 自行报错）',
          { reason: 'wake-deps-missing', missing: wakeAvail.missing })
      }

      for (const c of picked.resume) {
        const key = resumeKeyFor(c)
        if (state.isResumed(c.sessionId, key)) {
          summary.skipped++
          emit('INFO', 'resume.skip', '已处理过同一次未结束状态（幂等，D3）', { ...brief(c), reason: 'already-resumed', key })
          continue
        }
        try {
          // test-only（T9）：把失败注入开关透传给唤醒通道 ⇒ wake 用假 preset id 替换"决定 preset id"这一步，
          // 后面**完整挂载流程**照常跑并自然失败。默认 null ⇒ 传 `{}`，行为与现在**完全一致**。
          const r = await wake.resumeWithPreset(c.sessionId,
            cfg.testForceMissingPresetId ? { testForceMissingPresetId: cfg.testForceMissingPresetId } : {})
          if (!r || !r.ok) {
            summary.failed++
            // 失败**不写**幂等状态（否则永不重试）
            // ★2026-09-22 修复：唤醒通道在"preset 根本没挂上"时也会返回 `ok:false`
            //   （`reason:'preset-not-mounted'`，见 lib/wake.js）⇒ 走到这里就是**该走的失败通道**，
            //   上层**不加**特判来遮住它。`setupSkipped`/`setupMounted` 必须如实落审计，
            //   让"服务不可用导致工具面缺失"这种静默退化一眼可见（A1/A2 的判据落点）。
            emit('WARN', 'resume.fail', '唤醒失败：' + ((r && r.error) || '未知'), {
              ...brief(c), reason: (r && r.reason) || 'wake-failed', error: (r && r.error) || null,
              // 失败时 presetSource 同样要留：`header-no-read` + 挂载失败往往同源（读不动那个会话）
              presetId: (r && r.presetId) || null, presetSource: (r && r.presetSource) || null,
              setupMounted: !!(r && r.setupMounted), setupSkipped: (r && r.skipped) || null, stateWritten: false,
            })
            continue
          }
          let notice = { ok: false, error: 'agent.send 不可用' }
          try {
            if (typeof wake.injectNotice === 'function') notice = await wake.injectNotice(r.agent, noticeTextFor(c), { plugin: 'dsh-adapter' })
            else notice = { ok: false, error: 'adapterWake.injectNotice 缺失' }
          } catch (e) { notice = { ok: false, error: errMsg(e) } }
          const persisted = state.markResumed(c.sessionId, key, {
            signal: c.layer,
            note: c.layer === LAYER.P1 ? 'child=' + (c.childId || '') + ' openChildren=' + (Array.isArray(c.openChildren) ? c.openChildren.length : 0) : 'turn=' + c.turn,
          })
          summary.resumed++
          emit('INFO', 'resume.ok', '唤醒成功（layer=' + c.layer + ' setupMounted=' + !!r.setupMounted + '）', {
            ...brief(c), layer: c.layer, setupMounted: !!r.setupMounted, presetId: r.presetId || null,
            // presetSource：event/header = 可靠；header-no-read = **退化**（读不到日志，可能挂错，
            // 见 wake.js 的 resolvePresetDetailed）。放在这里是为了"为什么它的工具层不对"能一眼查。
            presetSource: r.presetSource || null,
            setupSkipped: r.skipped || null, noticeOk: !!notice.ok, noticeError: notice.error || null,
            statePersisted: persisted, stateDegraded: state.degraded,
          })
        } catch (e) {
          // 单个失败 → 记审计 → 继续（设计 §8.2 硬要求）
          summary.failed++
          emit('ERROR', 'resume.fail', '唤醒异常（继续处理下一个）：' + errMsg(e), { ...brief(c), reason: 'exception', error: errMsg(e), stateWritten: false })
        }
      }
      summary.ok = true
      return summary
    } catch (e) {
      summary.reason = 'exception: ' + errMsg(e)
      emit('ERROR', 'resume.fail', '本轮扫描/唤醒整体异常（已吞掉，不影响内核启动）', {
        error: errMsg(e), stack: String((e && e.stack) || '').slice(0, 800),
      })
      return summary
    } finally {
      summary.durationMs = Math.max(0, Number(now()) - started)
      try { log('ROUND enabled=' + cfg.enabled + ' scope=' + cfg.scope + ' dryRun=' + cfg.dryRun
        + ' total=' + summary.total + ' survivors=' + summary.survivors + ' selected=' + summary.selected.length
        + ' resumed=' + summary.resumed + ' failed=' + summary.failed + ' skipped=' + summary.skipped
        + ' durationMs=' + summary.durationMs) } catch (_) {}
    }
  }

  /**
   * 用 `setTimeout` 延时执行一轮（**不阻塞 apply**）。定时器由 adapter 挂在 ctx.effect 上，
   * fiber dispose 时调用 `cancel()`。
   */
  function schedule() {
    if (timer) return timer
    const delay = Math.max(0, Number(cfg.startDelayMs) || 0)
    scheduled = true
    timer = setTimeout(() => {
      timer = null
      Promise.resolve().then(run).catch((e) => log('RESUME run 未捕获异常: ' + errMsg(e)))
    }, delay)
    log('SCHEDULED delayMs=' + delay + ' scope=' + cfg.scope + ' maxResumePerBoot=' + cfg.maxResumePerBoot
      + ' dryRun=' + cfg.dryRun + ' recentWindowMs=' + cfg.recentWindowMs + ' state=' + state.path)
    return timer
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null }
    return true
  }

  function status() {
    return {
      service: 'adapterResume',
      plugin: '@local/dsh-adapter',
      enabled: cfg.enabled,
      scope: cfg.scope,
      startDelayMs: cfg.startDelayMs,
      maxResumePerBoot: cfg.maxResumePerBoot,
      dryRun: cfg.dryRun,
      recentWindowMs: cfg.recentWindowMs,
      stateMaxAgeDays: cfg.stateMaxAgeDays,
      // test-only 开关如实暴露（null = 未启用）；生产巡检发现非 null 即为"开关被遗留"
      testForceMissingPresetId: cfg.testForceMissingPresetId,
      state: state.summary(),
      scheduled,
      lastRound: lastRound
        ? { ok: lastRound.ok, total: lastRound.total, survivors: lastRound.survivors, selected: lastRound.selected.length,
            resumed: lastRound.resumed, failed: lastRound.failed, skipped: lastRound.skipped,
            durationMs: lastRound.durationMs, reason: lastRound.reason }
        : null,
      layers: { implemented: [LAYER.P1, LAYER.P0], notImplemented: [LAYER.P2, LAYER.P3] },
      dependencies: dependencyStatus(ctx),
      warnings,
    }
  }

  // TODO(P3 扩展点 · 本轮不实现)：外部插件（taskkit 等）**注册待办信号**的入口，计划形状
  //   registerSignalProvider({ id, listPending(signal) => [{ sessionId, taskId, goalId, reason }] })
  // 接入位置（三处，缺一不可）：
  //   ① 本工厂的返回对象加 registerSignalProvider（注册表 + 幂等按 id 覆盖）；
  //   ② ./scan.js 的 judgeCandidates 末尾把这些信号合成 layer='P3' 的候选（唤醒目标=注册方指定）；
  //   ③ ./scan.js 的 selectByLayer 放开 P3（tasks-only 下 P3 与 P1 同属"明确有活没干完"）。
  // 在此之前，taskkit 之类需要唤醒时只能走 ctx.get('adapterWake')（本仓依赖方向：adapter 提供能力 → taskkit 调用，
  // adapter **不读** taskkit 的任何文件）。
  return {
    run, schedule, cancel, status,
    config: () => ({ ...cfg }),
    state,
    /** 服务标识（供日志/诊断） */
    serviceName: 'adapterResume',
  }
}

const errMsg = (e) => String((e && e.message) || e)
const totalMs = (started, nowFn) => Math.max(0, Number(nowFn()) - started)
/** 审计消息里把 epoch ms 写成 ISO（人工读日志时直接和墙上时间对；非法值/空值一律 'null'，绝不抛） */
const iso = (t) => {
  try {
    return (Number.isFinite(Number(t)) && Number(t) > 0) ? new Date(Number(t)).toISOString() : 'null'
  } catch (_) { return 'null' }
}
/** 允许为 null 的数字型明细字段（null = "这条路径根本没调用/拿不到"，与 0 是两件事） */
const jsonish = (v) => (v === null || v === undefined ? 'null' : String(v))
/** `{tail, read}` 计数写成 `tail:n/read:m`（U10 审计用；缺失时给 'n/a'，绝不抛） */
const stateCounts = (c) => (c && typeof c === 'object' ? 'tail:' + (c.tail || 0) + '/read:' + (c.read || 0) : 'n/a')

/**
 * `desc`（P3-U11-DESC 对照审计）的一行摘要 —— 只为了让 `resume.judge` 那行**一眼可读**，
 * 完整字段本来就随 detail 一起落盘。缺失/异常一律给 'n/a'，绝不抛。
 */
const descBrief = (d) => {
  if (!d || typeof d !== 'object') return 'n/a'
  if (d.source !== 'ok') return d.source + (d.error ? '(' + String(d.error).slice(0, 60) + ')' : '')
  return 'raw=' + d.rawCount + '(child=' + d.childCount + ',diag=' + d.diagnosticCount + ')'
    + ' maxDepth=' + d.maxDepth
    + ' onlyInDesc(direct=' + d.onlyInDescDirectTotal + ',deeper=' + d.onlyInDescDeeperTotal + ')'
    + ' onlyInService=' + d.onlyInServiceTotal
    + ' deltaChecked=' + d.deltaChecked + '/' + d.deltaTotal
    + ' deltaOpen=' + d.deltaOpenTotal
}

function safeAvailable(wake) {
  try { return wake.available() } catch (_) { return null }
}

export { prescanSessions, judgeCandidates, selectByLayer, resumeKeyFor, LAYER, ResumeState, statePathForHome, resolveStatePath, DEFAULT_RECENT_WINDOW_MS }
