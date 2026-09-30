// @local/dsh-adapter —— 重启自恢复（P3-U11）：**重启门闸**
//
// 定位（P3 计划 §U11 对齐结论，用户裁定）：优雅重启**前**拦住重启，等在飞工作收敛。
//   服务的是「不中断更新」，**不是**崩溃检测 —— 所以查询时进程还活着，判定权威是**活会话存储**。
//
// 两个时刻、两个权威（都是内核原生，理由见计划 §U11）：
//   · 进程活着（本文件）→ `ctx.sessions.list()` 活会话存储（内存态、零磁盘读）
//   · 重启之后（./scan.js）→ 会话日志（尾帧 + lastTurnState）
// `subagent/start`/`end` 事件表（./inflight.js）降级为**快路径 + 交叉校验**，不单独承载判定：
//   adapter 被热拔插 reload 时内存表会清零，只依赖它的门闸会在 reload 后**假报安全**。
//
// ⛔ 四条硬禁止：
//   1. **禁止把"查不到"当"安全"**。任何一类判不出来 ⇒ `ok:false` + `safe:false` + reason（fail-closed）。
//      这是 `setupSkipped` 那次事故的教训：静默退化比故障更坏。
//   2. **禁止用事件表"缺项"推断"没有在飞"**。表只补字段、不加阻塞项。
//   3. **禁止扫全量会话日志**判 turn 未闭合。磁盘上大量"重启被截断、永远停在 open"的历史会话
//      （真机实测 P0 命中 236/419 = 56%）会让门闸**恒不安全**。只用驻留会话（`sessions.list()`）。
//   4. **禁止**用 subagent 的 `activity` 判在途（重启后一律 inactive，见 scan.js 文件头）。
//
// 三类阻塞项（用户勾选）：
//   · `delegations` — 驻留**子**会话（`origin:'subagent'` 等）里 turn 未闭合的
//   · `hotplugOps`  — hotplug 的在飞操作 / loader 树不稳定
//   · `openTurns`   — 驻留**主**会话里 turn 未闭合的（活进程里这是"真有一轮在跑"，不是陈旧日志）
//
// ⚠️ "未闭合"在**活进程门闸**与**重启后扫描**两处口径**刻意不同**（2026-09-24 真机踩坑后分开，别"顺手统一"）：
//   · **本文件（活进程）**只看 `kind === 'open'`：最后一条边界是 `turn/start`、没有配对 `turn/end` —— 这才是"真有一轮在跑"。
//     `interrupted` 是**已经结束**的一轮（内核重启 / 中断时补的 `turn/end` 收尾），活进程里它只说明"这一轮曾被打断"，
//     **不代表现在在跑**；若沿用 `lastTurnState().unfinished`（它把 interrupted 也算未完成），门闸会**恒不安全**：
//     真机实录 `session-fd9f5874` 驻留主会话末态 `turn/end(interrupted)` ⇒ `openTurns` 恒 1 条 ⇒ `safe:false`，
//     于是 `restart-kernel.sh` 不带 `--force` 就**永远拒绝重启**。口径与内核自己的 `OPEN_TURN` 判据一致
//     （"最后一条边界是 `turn/start`"才算未闭合，见 docs/superpowers/plans/2026-09-22-dsh-remote-p3-resume-on-boot.md 的 F-U11-4）。
//   · **./scan.js（重启之后、读日志）**必须**保持**把 `interrupted` 算未完成（`lastTurnState().unfinished`）：
//     内核恢复后会把未闭合 turn **补成** `turn/end(interrupted)`，只看 `open` 会让"恢复过一次的会话"再也不算候选
//     （见 ./detect.js 的 F1 说明）。两处是**两套语义、两个时刻**（见文件头"两个时刻、两个权威"），不是重复实现。
//
// ⚠️ **2026-09-24 决定：保持"一个 evaluate()、一套口径"，不把 `delegations` 单独从严。**
//   即：`interrupted` 在**主 / 子两类里一致地不拦**（判定发生在主子分流**之前**，是刻意的）。
//   理由：① 本仓忌讳"同一判据两份实现"—— 同一 `evaluate()` 里出现两种"在飞"定义，比"子会话稍宽"更危险；
//        ② 活进程里 interrupted 子会话同样只是"一轮已结束"；若父在等子，**父的 open turn 会兜住**。
//   ⇒ 这是**有意识的取舍，不是疏漏**。不要为了"让 delegations 更严"而把判定挪进 `openTurns` 分支。

import { lastTurnState } from './detect.js'
import { isSubagentSession } from './scan.js'

/** 默认配置（`adapter.resume.gate.*`） */
export const DEFAULT_GATE_CONFIG = {
  // 三类判据开关。**默认全开**；关掉某一类等于"这一类不拦"⇒ 该类的 `unknown` 也不再 fail-closed。
  categories: { delegations: true, hotplugOps: true, openTurns: true },
  // ⚠️ test-only（命名必须带 test）：伪造一条"在飞委派"用于**验收门闸真的会拦**。
  //    非空字符串 = 伪造的 childId。仅供真机验收，**生产不得设置**；启用时构造期即留 WARN 审计
  //    （照 `testForceMissingPresetId` 的先例）。
  testForceInflight: null,
}

const errMsg = (e) => String((e && e.message) || e)

const getService = (ctx, name) => {
  try { return (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null) || null } catch (_) { return null }
}

const str = (v) => (v == null ? null : String(v))

/** 配置归一化（非法值不抛，回退默认并记 warning —— 配置写错不该让内核起不来） */
export function normalizeGateConfig(config) {
  const raw = (config && typeof config === 'object' ? config : {})
  const warnings = []
  const rawCats = (raw.categories && typeof raw.categories === 'object') ? raw.categories : {}
  const categories = {}
  for (const k of Object.keys(DEFAULT_GATE_CONFIG.categories)) {
    categories[k] = rawCats[k] === undefined ? DEFAULT_GATE_CONFIG.categories[k] : !!rawCats[k]
  }
  let testForceInflight = DEFAULT_GATE_CONFIG.testForceInflight
  const rawForce = raw.testForceInflight
  if (rawForce !== undefined && rawForce !== null) {
    if (typeof rawForce === 'string' && rawForce.trim() !== '') {
      testForceInflight = rawForce.trim()
    } else {
      warnings.push(`testForceInflight 非法(${JSON.stringify(rawForce)})，回退默认 null（该项 test-only，仅接受非空字符串）`)
      testForceInflight = null
    }
  }
  return { cfg: { categories, testForceInflight }, warnings }
}

/**
 * 构造门闸（**建对象不碰宿主** ⇒ apply 期零成本）。
 *
 * @param {object} opts
 * @param {object} opts.ctx       宿主 ctx（`sessions` 惰性 ctx.get）
 * @param {object} [opts.hotplug] HotplugService（用于 `hotplugOps` 类；缺省且该类开启 ⇒ fail-closed）
 * @param {object} [opts.inflight] 在飞事件表（./inflight.js；缺省 ⇒ 少一条交叉校验来源，判定不受影响）
 * @param {Function} [opts.log]   诊断日志器
 * @param {Function} [opts.audit] 审计落盘 (level, event, message, extra)
 * @param {Function} [opts.now]   时钟（可注入，便于单测）
 */
export function createResumeGate({ ctx, hotplug = null, inflight = null, config = {}, log = () => {}, audit = () => {}, now = Date.now } = {}) {
  const { cfg, warnings } = normalizeGateConfig(config)
  const emit = (level, event, message, extra) => {
    try { audit(level, event, message, extra || {}) } catch (_) { /* 审计失败不阻断 */ }
  }
  for (const w of warnings) {
    log('GATE_CONFIG_WARN ' + w)
    emit('WARN', 'resume.gate_config_warn', '门闸配置项非法，已回退默认值：' + w, { reason: 'invalid-config', warning: w })
  }
  // test-only 开关的留痕放在**构造期**：即便本轮没被查询过，审计里也能一眼看出"这个实例被注入了伪在飞"
  if (cfg.testForceInflight) {
    log('GATE_TEST_OVERRIDE testForceInflight=' + cfg.testForceInflight)
    emit('WARN', 'resume.gate_test_override',
      '⚠️ test-only 注入已启用：门闸将**恒定**报出一条伪造的在飞委派 `' + cfg.testForceInflight
      + '`（用于验收"门闸真的会拦住重启"）；该项仅供真机验收，生产不得设置 testForceInflight',
      { reason: 'test-only-inflight-override', testForceInflight: cfg.testForceInflight })
  }

  let evaluations = 0
  let lastSignature = null
  let lastResult = null

  const failClosed = (reason, extra) => ({
    ok: false,
    safe: false,
    reason,
    blockers: { delegations: [], hotplugOps: [], openTurns: [] },
    counts: { liveSessions: 0, delegations: 0, hotplugOps: 0, openTurns: 0 },
    unjudgeable: [],
    table: null,
    checkedAt: new Date(Number(now())).toISOString(),
    ...(extra || {}),
    failClosed: true,
  })

  /** 从活会话对象取"是否是子会话"所需的信息（拿不到 header 时返回 null ⇒ 调用方按不可判定处理） */
  const headerOf = (s) => {
    try {
      const h = s && s.header
      return (h && typeof h === 'object') ? h : null
    } catch (_) { return null }
  }

  /** 从活会话对象取事件快照（**内存态**，零磁盘读）；不是函数或抛错 ⇒ null */
  const eventsOf = (s) => {
    try {
      if (!s || typeof s.snapshotEvents !== 'function') return null
      const evs = s.snapshotEvents()
      return Array.isArray(evs) ? evs : null
    } catch (_) { return null }
  }

  /**
   * 判一次门闸。**整体不抛**（调用方是 HTTP 处理器与运维脚本）。
   * @returns {object} `{ ok, safe, reason, blockers, counts, unjudgeable, table, checkedAt }`
   *   `ok` = 三类判据**都判成功了**；`safe` = 且三类皆空。任何一类判不出来 ⇒ `ok:false, safe:false`。
   */
  function evaluate() {
    evaluations++
    const started = Number(now())
    const blockers = { delegations: [], hotplugOps: [], openTurns: [] }
    const unjudgeable = []
    let liveCount = 0

    try {
      // ---- 活会话存储（唯一的判定权威）----
      const sessions = getService(ctx, 'sessions')
      if (!sessions || typeof sessions.list !== 'function') {
        return finish(failClosed('live-sessions-unavailable'), started)
      }
      let live
      try { live = sessions.list() } catch (e) {
        return finish(failClosed('live-sessions-list-threw', { error: errMsg(e) }), started)
      }
      if (!Array.isArray(live)) return finish(failClosed('live-sessions-not-array'), started)
      liveCount = live.length

      const needTurn = cfg.categories.delegations || cfg.categories.openTurns
      if (needTurn) {
        for (const s of live) {
          const id = str(s && s.id)
          if (!id) { unjudgeable.push({ sessionId: null, reason: 'no-id' }); continue }
          const header = headerOf(s)
          const events = eventsOf(s)
          if (events === null) {
            // 拿不到内存事件 ⇒ **判不了**（不是"已闭合"）。fail-closed 的落点。
            unjudgeable.push({ sessionId: id, reason: 'snapshotEvents-unavailable' })
            continue
          }
          const st = lastTurnState(events)
          // ★活进程只认 `open`（最后一条边界是 turn/start）—— 见文件头"两处口径刻意不同"。
          //   绝不能用 `st.unfinished`：`interrupted` 也是 `unfinished:true`，但它是一轮**已结束**的收尾
          //   （重启/中断补的 turn/end），活进程里不代表"在跑"；沿用 unfinished 会让门闸**恒不安全**。
          //   `open` 仍然拦（这是本门的核心能力，绝不能因为修 interrupted 而放过它）。
          if (st.kind !== 'open') continue
          if (header === null) {
            unjudgeable.push({ sessionId: id, reason: 'header-unavailable' })
            continue
          }
          // 子会话（`origin:'subagent'` / `parentSession` / `delegationDepth>0`）——判据复用 scan.js，
          // 避免"子会话"有两份定义而悄悄漂移。
          if (isSubagentSession(header)) {
            if (cfg.categories.delegations) {
              blockers.delegations.push({
                childId: id,
                parentId: str(header.parentSession || header.parentSessionId),
                turn: st.turn == null ? null : st.turn,
                kind: st.kind,
                runId: null, provider: null, startedAt: null, tableMatch: false,
              })
            }
          } else if (cfg.categories.openTurns) {
            blockers.openTurns.push({
              sessionId: id,
              turn: st.turn == null ? null : st.turn,
              kind: st.kind,
              origin: str(header.origin),
            })
          }
        }
      }

      // ---- hotplug 在飞（同一类"重启会掐断"的风险，合成一个门闸更难绕过）----
      if (cfg.categories.hotplugOps) {
        if (!hotplug || typeof hotplug.snapshot !== 'function') {
          unjudgeable.push({ sessionId: null, reason: 'hotplug-unavailable' })
        } else {
          let snap = null
          try { snap = hotplug.snapshot() } catch (e) {
            unjudgeable.push({ sessionId: null, reason: 'hotplug-snapshot-threw', error: errMsg(e) })
          }
          if (snap) {
            if (snap.inFlight) {
              blockers.hotplugOps.push({
                kind: 'op-in-flight',
                id: str(snap.inFlight.id),
                op: str(snap.inFlight.op),
                startedAt: Number.isFinite(snap.inFlight.startedAt) ? snap.inFlight.startedAt : null,
                ageMs: Number.isFinite(snap.inFlight.startedAt) ? Math.max(0, started - snap.inFlight.startedAt) : null,
              })
            }
            if (snap.unstable) {
              blockers.hotplugOps.push({ kind: 'loader-unstable', reason: str(snap.unstableReason) })
            }
          }
        }
      }

      // ---- 与事件表交叉校验（**只补字段 + 只告警，绝不改判据**）----
      const table = crossCheck(blockers)

      // ---- test-only 伪在飞注入（验收"拦不拦得住"）----
      if (cfg.testForceInflight) {
        blockers.delegations.push({
          childId: cfg.testForceInflight, parentId: null, turn: null, kind: 'test-injected',
          runId: null, provider: null, startedAt: null, tableMatch: false, test: true,
        })
      }

      const counts = {
        liveSessions: liveCount,
        delegations: blockers.delegations.length,
        hotplugOps: blockers.hotplugOps.length,
        openTurns: blockers.openTurns.length,
      }
      const total = counts.delegations + counts.hotplugOps + counts.openTurns
      // unjudgeable 非空 ⇒ 判据不完整 ⇒ **不能报安全**（fail-closed，见文件头硬禁止 1）
      const ok = unjudgeable.length === 0
      const result = {
        ok,
        safe: ok && total === 0,
        reason: ok ? null : 'unjudgeable',
        blockers, counts, unjudgeable, table,
        checkedAt: new Date(Number(now())).toISOString(),
      }
      return finish(result, started)
    } catch (e) {
      // 兜底：本函数绝不抛（HTTP 处理器与运维脚本都不该被它打断）
      return finish(failClosed('gate-exception', { error: errMsg(e), stack: String((e && e.stack) || '').slice(0, 600) }), started)
    }
  }

  /**
   * 与在飞表对账。**只补字段、只告警**：
   *   · 命中（活会话说在飞 + 表里也有）⇒ 补 `runId`/`provider`/`startedAt`
   *   · 表里有、活会话里没有 ⇒ `table.unmatched`（表陈旧，或 end 边沿没收到）—— 告警但**不加阻塞项**
   *   · 活会话有、表里没有 ⇒ `table.missing`（订阅晚于 start，或 adapter 刚被 reload）—— 正常，只记数
   */
  function crossCheck(b) {
    if (!inflight || typeof inflight.snapshot !== 'function') return { available: false, matched: 0, missing: 0, unmatched: [], entries: 0 }
    let snap
    try { snap = inflight.snapshot() } catch (_) { return { available: false, matched: 0, missing: 0, unmatched: [], entries: 0 } }
    const entries = Array.isArray(snap.entries) ? snap.entries : []
    const byChild = new Map()
    for (const e of entries) if (e && e.childId) byChild.set(String(e.childId), e)
    let matched = 0
    const seen = new Set()
    for (const d of b.delegations) {
      seen.add(String(d.childId))
      const e = byChild.get(String(d.childId))
      if (!e) continue
      matched++
      d.runId = e.runId || null
      d.provider = e.provider || null
      d.startedAt = Number.isFinite(e.startedAt) ? e.startedAt : null
      d.tableMatch = true
      if (!d.parentId && e.parentId) d.parentId = e.parentId
    }
    const unmatched = entries
      .filter((e) => e && e.childId && !seen.has(String(e.childId)))
      .map((e) => ({ childId: String(e.childId), runId: e.runId || null, ageMs: Number.isFinite(e.ageMs) ? e.ageMs : null }))
    return {
      available: true,
      subscribed: snap.subscribed === true,
      subscribeError: snap.subscribeError || null,
      // 订阅成功却始终没观察到任何边沿 ⇒ 事件名可能已漂移（事件类依赖无法探针化，靠这条运行期佐证）
      observed: snap.observed || null,
      entries: entries.length,
      matched,
      missing: b.delegations.length - matched,
      unmatched,
    }
  }

  /** 收尾：记耗时、按**状态变化**写审计（轮询端点每次写会刷爆审计） */
  function finish(result, started) {
    try { result.durationMs = Math.max(0, Number(now()) - started) } catch (_) { result.durationMs = 0 }
    result.evaluations = evaluations
    lastResult = result
    const sig = signatureOf(result)
    if (sig !== lastSignature) {
      const prev = lastSignature
      lastSignature = sig
      const msg = result.safe
        ? '门闸：安全（无在飞工作）'
        : '门闸：不安全 —— ' + describe(result)
      // 从"不安全"变"安全"、或首次、或阻塞项构成变化 ⇒ 记一条；轮询期间状态不变则**不重复记**
      emit(result.safe ? 'INFO' : 'WARN', 'resume.gate', msg, {
        safe: result.safe, ok: result.ok, reason: result.reason,
        counts: result.counts, previous: prev,
        blockers: result.blockers, unjudgeable: result.unjudgeable, table: result.table,
      })
    }
    return result
  }

  /** 阻塞项构成签名（用于抑制重复审计；不含时间戳与 ageMs，避免每次轮询都变） */
  function signatureOf(r) {
    const ids = []
    for (const d of r.blockers.delegations) ids.push('d:' + d.childId + (d.test ? '!' : ''))
    for (const o of r.blockers.hotplugOps) ids.push('h:' + (o.kind || '') + ':' + (o.id || ''))
    for (const t of r.blockers.openTurns) ids.push('t:' + t.sessionId)
    for (const u of r.unjudgeable) ids.push('u:' + (u.reason || '') + ':' + (u.sessionId || ''))
    return (r.safe ? 'SAFE' : 'UNSAFE') + '|' + ids.sort().join(',')
  }

  function describe(r) {
    const c = r.counts || {}
    const parts = []
    if (c.delegations) parts.push('在飞委派 ' + c.delegations + ' 个')
    if (c.hotplugOps) parts.push('热拔插在飞/不稳定 ' + c.hotplugOps + ' 项')
    if (c.openTurns) parts.push('未闭合 turn ' + c.openTurns + ' 个（驻留会话）')
    if (r.unjudgeable && r.unjudgeable.length) parts.push('无法判定 ' + r.unjudgeable.length + ' 项（fail-closed，不得视为安全）')
    return parts.join('；') || '（无阻塞项但判定不完整）'
  }

  /** 供 `POST { op:'force' }` 用：把"带着阻塞项强行跳过门闸"这件事写进审计（含当时的明细） */
  function noteForce({ reason = null, by = null, blockers = null } = {}) {
    emit('WARN', 'resume.gate_force',
      '⚠️ 门闸被 **--force 跳过**：带着在飞工作强行重启' + (reason ? '（' + reason + '）' : '')
      + '。当时的阻塞项：' + (blockers ? describe({ counts: blockers, unjudgeable: [] }) : '（调用方未提供明细）'),
      { reason: reason || 'force', by: by || null, blockers: blockers || null, at: new Date(Number(now())).toISOString() })
    return { ok: true }
  }

  function status() {
    return {
      service: 'adapterGate',
      plugin: '@local/dsh-adapter',
      categories: { ...cfg.categories },
      // test-only 开关如实暴露（null = 未启用）；生产巡检发现非 null 即为"开关被遗留"
      testForceInflight: cfg.testForceInflight,
      evaluations,
      last: lastResult ? {
        ok: lastResult.ok, safe: lastResult.safe, reason: lastResult.reason,
        counts: lastResult.counts, unjudgeable: lastResult.unjudgeable.length,
      } : null,
      table: (inflight && typeof inflight.snapshot === 'function')
        ? (() => { try { const s = inflight.snapshot(); return { subscribed: s.subscribed, subscribeError: s.subscribeError, size: s.size, observed: s.observed } } catch (_) { return null } })()
        : null,
      warnings,
    }
  }

  return { evaluate, status, noteForce, config: () => ({ categories: { ...cfg.categories }, testForceInflight: cfg.testForceInflight }), serviceName: 'adapterGate' }
}
