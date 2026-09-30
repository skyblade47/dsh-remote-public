// @local/dsh-adapter —— 重启自恢复（P3-U11）：在飞委派事件表
//
// 定位（P3 计划 §U11 对齐结论）：「重启门闸」的**快路径 + 交叉校验**，
//   **不单独承载判定**。判定权威是 `ctx.sessions.list()`（活会话存储，见 ./gate.js）——
//   因为 adapter 被热拔插 reload 时本表会清零，只依赖它的门闸会在 reload 后**假报安全**。
//
// 三条来自取证的硬知识（依据记在 P3 计划 §U11 的 F-U11-* 表里，别凭感觉改）：
//   1. 内核发 `subagent/start` / `subagent/end`，用 `runId` 配对；
//      one-shot run 与 continuable 的 **Activation 驻留 epoch** 发的是同一套边沿。
//   2. 事件带 **scope target = 发起委派的父 Agent**，而 cordis 的 `dispatch` 会 `callback.bind(thisArg)`
//      ⇒ **回调里的 `this` 就是父 Agent**。这是"谁写父映射"的原生答案，不必反查 header。
//   3. `ctx.on(name, fn, { global: true })` **绕过 scope 过滤**（cordis `EventOptions.global`），
//      ⇒ 根级的 adapter 才收得到**全部**子代理边沿。不加这个选项会静默只收到一部分。
//
// ⛔ 两条禁止：
//   - **禁止**用本表"缺项"推断"没有在飞"（缺项只可能是漏订/漏写），所以本表**只补字段、不加阻塞项**。
//   - **禁止**用 subagent 的 `activity` 判在途（重启后一律 inactive，见 scan.js 文件头）。
//
// ⚠️ 事件类依赖**无法用存在性探针覆盖**（cordis 没有"枚举已注册事件名"的接口），
//    缓解手段就是本文件把事件名集中在 `SUBAGENT_EVENTS` 一处常量，升级时只改这里；
//    另用 `observed` 计数器做运行期佐证（订阅到了却没观察到任何边沿 ⇒ 可能是名字漂移）。

/**
 * 宿主子代理生命周期事件名（**集中一处**，升级时只改这里）。
 * `provider-removed` 不带父载体（`this` 为 null），只用于清表。
 */
export const SUBAGENT_EVENTS = Object.freeze({
  start: 'subagent/start',
  end: 'subagent/end',
  providerRemoved: 'subagent/provider-removed',
})

/** 表内条目的默认存活上限（纯卫生用途；到期条目只是不再出现在快照里） */
export const DEFAULT_ENTRY_TTL_MS = 24 * 3600 * 1000

/**
 * 从"父 Agent"上取会话 id。
 *
 * Agent 的对象形状随宿主版本可能不同，故**多形状探测**：命中任一即返回。
 * 刻意不抛、不猜：全都不命中时返回 null，并把这一事实记进条目（`parentIdResolved:false`），
 * 而不是让整条记录变成垃圾——因为它至少还能靠 `childId` 与活会话存储对上账。
 */
function resolveParentId(parent) {
  if (!parent || typeof parent !== 'object') return null
  const cands = [
    parent.sessionId,
    parent.session && parent.session.id,
    parent.session && parent.session.sessionId,
    parent.id,
    parent.session,
  ]
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

const errMsg = (e) => String((e && e.message) || e)

/**
 * 构造在飞委派事件表（**建对象不碰宿主**；订阅在 `start()` 里发生）。
 *
 * @param {object} opts
 * @param {object} opts.ctx   宿主 ctx（只用 `ctx.on`）
 * @param {Function} [opts.log] 诊断日志器
 * @param {Function} [opts.audit] 审计落盘 (level, event, message, extra)
 * @param {number} [opts.ttlMs] 条目存活上限（默认 24h）
 * @param {Function} [opts.now] 时钟（可注入，便于单测）
 */
export function createInflightTable({ ctx, log = () => {}, audit = () => {}, ttlMs = DEFAULT_ENTRY_TTL_MS, now = Date.now } = {}) {
  /** @type {Map<string, object>} runId → 条目 */
  const byRunId = new Map()
  /** @type {Map<string, string>} childId → runId（供门闸按 childId 配对；一个 child 同时只应有一个在飞 epoch） */
  const runIdByChild = new Map()
  const observed = { start: 0, end: 0, providerRemoved: 0, missingRunId: 0, parentIdUnresolved: 0 }
  const disposers = []
  let subscribed = false
  let subscribeError = null
  let lastEventAt = null

  const emit = (level, event, message, extra) => {
    try { audit(level, event, message, extra || {}) } catch (_) { /* 审计失败不阻断 */ }
  }

  const ttlOf = () => (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_ENTRY_TTL_MS)

  /** 单调递增的代次号：同一 child 的多个 epoch 靠它区分先后（不依赖时间戳，避免同毫秒并列） */
  let startGeneration = 1

  /** 事件回调里拿到的 `this` 就是父 Agent；cords 在无 scope target 时传 null */
  function onStart(info) {
    try {
      const parent = this && typeof this === 'object' ? this : null
      if (!info || typeof info !== 'object') return
      const childId = info.id != null ? String(info.id) : null
      if (!childId) return
      // runId 是**内存态**配对键（跨重启无意义）；缺了就退化为按 childId 计键，并留痕——
      // 缺 runId 会让"配不上对的 end"清不掉表项，属需要被看见的形态漂移。
      let runId = info.runId != null ? String(info.runId) : null
      if (!runId) {
        observed.missingRunId++
        runId = 'child:' + childId
      }
      const parentId = resolveParentId(parent)
      if (parent && parentId === null) observed.parentIdUnresolved++
      byRunId.set(runId, {
        runId, childId,
        provider: info.provider != null ? String(info.provider) : null,
        local: info.local === true,
        parentId,
        parentIdResolved: parentId !== null,
        // 父 Agent 只以 **WeakRef** 持有：会话结束后 Agent 不该被我们钉住（内存泄漏）。
        // ⚠️ 这不是"能不能判在飞"的前提——判在飞靠活会话存储；它只决定能**不能主动 interrupt**。
        parentRef: parent ? makeWeakRef(parent) : null,
        startedAt: Number(now()),
        generation: startGeneration,
      })
      runIdByChild.set(childId, runId)
      startGeneration++
      observed.start++
      lastEventAt = Number(now())
    } catch (e) {
      emit('WARN', 'resume.inflight_handler_error', 'subagent/start 处理异常（已忽略，不影响宿主）', { error: errMsg(e), phase: 'start' })
    }
  }

  function onEnd(info) {
    try {
      if (!info || typeof info !== 'object') return
      const runId = info.runId != null ? String(info.runId) : null
      const childId = info.id != null ? String(info.id) : null
      const key = runId || (childId ? 'child:' + childId : null)
      if (!key) return
      const had = byRunId.delete(key)
      if (childId) {
        // 只在映射确实指向本条 run 时才删，避免"新 epoch 的映射被旧 end 抹掉"
        if (runIdByChild.get(childId) === key) runIdByChild.delete(childId)
      }
      observed.end++
      lastEventAt = Number(now())
      if (!had) {
        // 配不上对的 end（典型：start 发生在订阅之前，或 runId 形态变了）⇒ 留痕，不报错
        emit('DEBUG', 'resume.inflight_orphan_end', 'subagent/end 未匹配到 start（可能订阅晚于 start）',
          { runId, childId, provider: info.provider != null ? String(info.provider) : null, stopReason: info.stopReason != null ? String(info.stopReason) : null })
      }
    } catch (e) {
      emit('WARN', 'resume.inflight_handler_error', 'subagent/end 处理异常（已忽略）', { error: errMsg(e), phase: 'end' })
    }
  }

  function onProviderRemoved() {
    try { observed.providerRemoved++; lastEventAt = Number(now()) } catch (_) {}
  }

  /**
   * 订阅三个生命周期事件。**幂等**：重复调用只订阅一次。
   * 订阅失败**只降级不抛**（门闸会因此少一条交叉校验来源，但权威在活会话存储，判定不受影响）。
   * @returns {{ subscribed:boolean, error:string|null, global:boolean }}
   */
  function start() {
    if (subscribed) return { subscribed: true, error: subscribeError, global: true }
    if (!ctx || typeof ctx.on !== 'function') {
      subscribeError = 'ctx.on 不可用'
      emit('WARN', 'resume.inflight_subscribe_failed', '在飞表无法订阅子代理生命周期事件：' + subscribeError, { error: subscribeError })
      return { subscribed: false, error: subscribeError, global: true }
    }
    const errors = []
    // ⚠️ 必须 { global: true }：内核发这些事件时把父 Agent 作为 scope target，
    //    不加 global 会被 scope 过滤掉一部分甚至全部（见文件头硬知识 3）。
    for (const name of [SUBAGENT_EVENTS.start, SUBAGENT_EVENTS.end, SUBAGENT_EVENTS.providerRemoved]) {
      const fn = name === SUBAGENT_EVENTS.start ? onStart
        : name === SUBAGENT_EVENTS.end ? onEnd : onProviderRemoved
      try {
        const dispose = ctx.on(name, fn, { global: true })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (e) {
        errors.push(name + ': ' + errMsg(e))
      }
    }
    subscribed = errors.length === 0
    subscribeError = errors.length ? errors.join('; ') : null
    if (subscribeError) {
      emit('WARN', 'resume.inflight_subscribe_failed', '在飞表部分订阅失败（门闸仍可用，缺的是交叉校验来源）',
        { error: subscribeError, events: Object.values(SUBAGENT_EVENTS) })
    }
    return { subscribed, error: subscribeError, global: true }
  }

  /** 取消订阅（fiber dispose 时用） */
  function stop() {
    for (const d of disposers.splice(0)) { try { d() } catch (_) {} }
    subscribed = false
    return true
  }

  /** 清掉超过 TTL 的条目（纯卫生；被清掉的条目只影响交叉校验的覆盖率） */
  function prune() {
    const t = ttlOf()
    const at = Number(now())
    let removed = 0
    for (const [k, v] of byRunId) {
      if (!v || !Number.isFinite(v.startedAt) || at - v.startedAt > t) {
        byRunId.delete(k)
        if (v && v.childId && runIdByChild.get(v.childId) === k) runIdByChild.delete(v.childId)
        removed++
      }
    }
    return removed
  }

  /**
   * 快照（供门闸做**补字段**与交叉校验）。
   * ⚠️ 调用方**不得**把它当作"在飞全集"——它只是"我们观察到过且还没收到 end"的集合。
   * @returns {{ subscribed:boolean, subscribeError:string|null, entries:Array, observed:object, lastEventAt:number|null }}
   */
  function snapshot() {
    const entries = []
    for (const v of byRunId.values()) entries.push({ ...v, ageMs: Math.max(0, Number(now()) - v.startedAt) })
    entries.sort((a, b) => a.startedAt - b.startedAt)
    return {
      subscribed,
      subscribeError,
      global: true,
      events: SUBAGENT_EVENTS,
      entries,
      // observed 是**运行期佐证**：订阅成功却始终 start=end=0 ⇒ 事件名可能已漂移（探针覆盖不到的那类依赖）
      observed: { ...observed },
      lastEventAt,
      size: entries.length,
    }
  }

  /** 按 childId 取条目（门闸用；同 child 多 epoch 时取最近一次 start） */
  function byChildId(childId) {
    if (childId == null) return null
    const runId = runIdByChild.get(String(childId))
    if (!runId) return null
    const v = byRunId.get(runId)
    return v ? { ...v, ageMs: Math.max(0, Number(now()) - v.startedAt) } : null
  }

  return { start, stop, prune, snapshot, byChildId, events: SUBAGENT_EVENTS, serviceName: 'adapterInflight' }
}

/** WeakRef 兜底：宿主 Node < 14.6 或非常规环境时退化为"不持有"（代价：不能主动中断，不影响判定） */
function makeWeakRef(obj) {
  try {
    if (typeof WeakRef === 'function') return new WeakRef(obj)
  } catch (_) { /* 继续 */ }
  return null
}

/**
 * 从条目的 `parentRef` 解出父 Agent（取不到返回 null）。
 * 门闸**只在**需要"主动中断"时才用它；判在飞不依赖它。
 */
export function derefParent(entry) {
  try {
    if (!entry || !entry.parentRef) return null
    return typeof entry.parentRef.deref === 'function' ? (entry.parentRef.deref() || null) : null
  } catch (_) { return null }
}
