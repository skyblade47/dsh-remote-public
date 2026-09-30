// @local/dsh-adapter —— 重启自恢复：单测共用的假宿主（**不是**测试文件：文件名不匹配 resume-*.test.mjs）
//
// 为什么需要假宿主：P3 的扫描要碰 sessionQuery / sessionProjectionCache / subagents 宿主服务
// （⚠️ 子代理服务名是**复数** `subagents`，与内核 `super(ctx, "subagents")` 一致；scan.js 复数优先、单数兜底），
// 真机验证一次要起内核 + 造夹具（§2C）。这里把三个服务的**契约**（调用形状、返回形状）固定下来，
// 判据才能被单测锁住，而不是靠"真机试一次"。
//
// 末尾还有"会话文件"夹具（U8 尾帧读取用）：真机会话日志是 append-only 的多帧 zstd 流，
// `<home>/sessions/<bucket>/<sessionId>/session.jsonl.zstd`，故这里用 `node:zlib` 合成同构文件。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'

/**
 * 固定时钟：所有"窗口内/窗口外"的判定都用 `NOW - 偏移` 表达，故同一轮内完全确定。
 * 刻意**贴合真实当前时间**（而不是写死一个常数）：状态文件的 30 天 prune 用的是真实 `Date.now()`，
 * 若把假时钟设到很远的未来，测试里刚写的幂等记录会被 prune 掉，幂等用例就会假失败。
 */
export const NOW = Date.now()
export const HOUR = 3600 * 1000

export const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
export const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
export const otherEvent = () => ({ type: 'request/context', data: {} })

/**
 * 主会话 header。
 * ⚠️ 刻意带上一个"看起来新鲜"的 `mtime`（= NOW）：一级预筛**不得**用它，
 * 否则"窗口外的会话"会被错误放行（真机实测 554 个文件的 mtime 去重后只有 1 个值）。
 */
export function header(id, opts = {}) {
  const { createdAt = NOW - 1 * HOUR, ...rest } = opts
  return { id, createdAt, cwd: '/srv/ws', agentPreset: 'minimal', mtime: NOW, ...rest }
}

/** listSessions 返回项的规范形状（SessionRecord：`{ header }`） */
export const record = (h) => ({ header: h })

/** 子会话 header（D6：父子关系持久化在 header；id 不带 `session-` 前缀） */
export const subagentRecord = (id, parentSession) => record({ id: id, createdAt: NOW - 1 * HOUR, origin: 'subagent', parentSession, delegationDepth: 1 })

export function mkSessionQuery({ logs = {}, records = [] } = {}) {
  const calls = { list: 0, read: [] }
  return {
    calls,
    listSessions: async () => { calls.list++; return records },
    readSession: async (id) => {
      calls.read.push(id)
      const events = logs[id]
      if (!events) throw new Error('no log for ' + id)
      return { events, header: { id } }
    },
  }
}

/**
 * 假投影缓存。`map[id]` 既接受 `{ lastPromptAt }`（直出元数据），
 * 也接受 `{ ver, seq, val: { lastPromptAt } }`（真机实测的缓存行形状）——两种都要能读出。
 */
export function mkProjection(map = {}) {
  return { cachedSnapshot: (h) => (map[h.id] ? { values: { sessionListMetadata: map[h.id] } } : null) }
}

/** 假 subagents（内核服务名是**复数**）：`listChildren(parentId, signal)` → `{id, mode, label, activity, hasChildren}[]` */
export function mkSubagent(map = {}) {
  return {
    listChildren: async (parentId) => map[parentId] || [],
  }
}

/**
 * 假 descendants 条目（内核 `SubagentDescendantListEntry = SubagentListEntry & {parentId, depth}`）。
 * `kind:'diagnostic'` 是内核会返回的"无身份"行（descriptor 缺失/损坏 ⇒ corrupt/unavailable），
 * 对照审计必须能把它与真正的 `child` 行分开计数。
 */
export const descendant = (id, { depth = 1, parentId = null, kind = 'child', mode = 'one-shot', reason = 'corrupt' } = {}) =>
  (kind === 'diagnostic'
    ? { kind: 'diagnostic', id, reason, parentId, depth }
    : { kind: 'child', id, mode, activity: 'inactive', hasChildren: depth < 2, parentId, depth })

/**
 * 假 subagents **带 `listDescendants`**（P3-U11-DESC 对照审计用）。
 * 刻意做成"只有显式传 `descendants` 才挂这个方法" —— 用来覆盖"宿主没有该能力"那一侧
 * （compat.js 把 `subagents.listDescendants` 标 informational，即缺失属预期、不是缺口）。
 *
 * @param {object} map `listChildren` 的返回表
 * @param {{ descendants?:object, descendantsThrows?:boolean, descendantsNonArray?:boolean }} [opts]
 */
export function mkSubagentWithDescendants(map = {}, { descendants = {}, descendantsThrows = false, descendantsNonArray = false } = {}) {
  const calls = { listChildren: [], listDescendants: [] }
  return {
    calls,
    listChildren: async (parentId) => { calls.listChildren.push(parentId); return map[parentId] || [] },
    listDescendants: async (rootId) => {
      calls.listDescendants.push(rootId)
      if (descendantsThrows) throw new Error('descendants boom')
      if (descendantsNonArray) return { nope: true }
      return descendants[rootId] || []
    },
  }
}

export const child = (id, extra = {}) => ({
  id, mode: 'one-shot', label: id, activity: 'inactive', hasChildren: false, ...extra,
})

/**
 * 假唤醒通道（adapterWake 的契约：resumeWithPreset / injectNotice / available）。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.failFor] 这些会话 id 一律返回失败
 * @param {boolean} [opts.failOnTestOverride] 收到非空的 `testForceMissingPresetId` 时返回失败
 *   （模拟真机：假 preset id 挂不上 ⇒ 唤醒失败）
 */
export function mkWake({ failFor = [], failOnTestOverride = false } = {}) {
  const calls = { resume: [], resumeOpts: [], notice: [] }
  return {
    calls,
    available: () => ({ ok: true, missing: [], services: {} }),
    resumeWithPreset: async (sessionId, opts = {}) => {
      calls.resume.push(sessionId)
      calls.resumeOpts.push(opts || {})
      if (failFor.includes(sessionId)) {
        return { ok: false, agent: null, handle: null, presetId: null, setupMounted: false, skipped: null, error: 'resume boom' }
      }
      const forced = opts && typeof opts.testForceMissingPresetId === 'string' && opts.testForceMissingPresetId
      if (failOnTestOverride && forced) {
        // 真机语义：preset resolve/mount 抛错 ⇒ 唤醒整体失败（且**不允许**被当成"成功但 skipped"）
        return {
          ok: false, agent: null, handle: null, presetId: forced,
          setupMounted: false, skipped: null, error: 'preset 不存在: ' + forced,
        }
      }
      return {
        ok: true, agent: { send: async () => {} }, handle: { agent: {} },
        presetId: 'minimal', setupMounted: true, skipped: null, error: null,
      }
    },
    injectNotice: async (agent, text, opts) => { calls.notice.push({ text, opts }); return { ok: true, id: 'notice-1' } },
  }
}

export const fakeCtx = (services = {}) => ({ get: (name) => services[name] })

/**
 * 假宿主（**给 `lib/wake.js` 的真实唤醒通道用**，与 `mkWake` 那个假通道不同）：
 * `agents.resume` 做成真机会做的动作 —— "发布 agent **之前**调用 setup"
 * （setup 抛错 ⇒ resume 整体失败）。用它才能覆盖"不抛但 preset 没挂上"那条分支。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.presets]   `false` = 不提供 `agentPresets`（⇒ setup 走
 *   `report.skipped='agentPresets.mount 不可用'` 后 return、**不抛**的那条分支）
 * @param {boolean} [opts.callSetup] `false` = 宿主压根**不调用** setup（模拟"未知路径"：skipped 为空）
 * @param {string}  [opts.selected]  会话最后选中的 preset id（写进 `agent-preset/selected` 事件）
 * @returns {object} 可直接交给 `fakeCtx(...)` 的服务表
 */
export function mkWakeHost({ presets = true, callSetup = true, selected = 'coach' } = {}) {
  const services = {
    agents: {
      resume: async (arg) => {
        if (callSetup && typeof arg.setup === 'function') await arg.setup('AGENTCTX')
        return { agent: { id: 'a', send: async () => {} } }
      },
    },
    sessionQuery: {
      readSession: async (id) => ({
        events: selected ? [{ type: 'agent-preset/selected', data: { agentPreset: selected } }] : [],
        header: { id, agentPreset: selected },
      }),
      listSessions: async () => [],
    },
  }
  if (presets) services.agentPresets = { resolve: async (id) => ({ id: id === undefined ? 'default' : id }), mount: async () => {} }
  return services
}

/** 审计收集器：`audit(level, event, message, extra)` */
export function collectAudit() {
  const lines = []
  const audit = (level, event, message, extra) => lines.push({ level, event, message, extra: extra || {} })
  const find = (event, pred) => lines.filter((l) => l.event === event && (!pred || pred(l)))
  return { lines, audit, find }
}

// ---------------------------------------------------------------------------
// 重启门闸（P3-U11）夹具：**活会话存储** / hotplug / 带事件总线的 ctx

/**
 * 一个"活会话"（`ctx.sessions.list()` 的返回项形状）。
 * 判定只看两件东西：`header`（判是否子会话）与 `snapshotEvents()`（判 turn 是否闭合，**内存态**）。
 * @param {string} id
 * @param {{ header?:object, events?:Array, noSnapshot?:boolean }} [opts]
 *   `noSnapshot=true` 模拟实例被改版（没有 snapshotEvents）⇒ 调用方必须按"不可判定"处理
 */
export function liveSession(id, { header: h, events, noSnapshot = false } = {}) {
  const s = { id, header: h || { id, createdAt: NOW - 1 * HOUR, cwd: '/srv/ws', agentPreset: 'minimal' } }
  if (!noSnapshot) s.snapshotEvents = () => (Array.isArray(events) ? events : [])
  return s
}

/** 活会话子会话条目（`origin:'subagent'` + 父 id） */
export const liveChild = (id, parentId, opts = {}) =>
  liveSession(id, { header: { id, createdAt: NOW - 1 * HOUR, origin: 'subagent', parentSession: parentId, delegationDepth: 1 }, ...opts })

/**
 * 假 `sessions` 服务。
 * @param {Array} items
 * @param {{ throwOnList?:boolean, notArray?:boolean }} [opts] 用于覆盖两条 fail-closed 路径
 */
export function mkLiveSessions(items = [], { throwOnList = false, notArray = false } = {}) {
  return {
    list() {
      if (throwOnList) throw new Error('list boom')
      return notArray ? { nope: true } : items
    },
    get(id) { return items.find((s) => s && s.id === id) || undefined },
  }
}

/** 假 hotplug（只有门闸用到的那部分：`snapshot()`） */
export function mkHotplug({ inFlight = null, unstable = false, unstableReason = null } = {}) {
  return { snapshot: () => ({ inFlight, unstable, unstableReason, gens: {}, treeAvailable: true }) }
}

/**
 * 带事件总线的假 ctx（在飞表用 `ctx.on` 订阅生命周期事件）。
 * `emit(name, info, parent)` 按 cordis `dispatch` 的语义派发：
 *   · 有 parent ⇒ `callback.bind(parent)`（**回调里的 `this` 就是父 Agent**）
 *   · 无 parent ⇒ `this` 为 null
 * 并记录每次 `on` 的 options，供断言"必须带 `{global:true}`"。
 */
export function mkEventCtx(services = {}) {
  const hooks = {}
  const onCalls = []
  return {
    get: (n) => services[n],
    on(name, fn, opts) {
      onCalls.push({ name, opts })
      ;(hooks[name] ||= []).push({ fn, opts })
      return () => { hooks[name] = (hooks[name] || []).filter((h) => h.fn !== fn) }
    },
    hooks,
    onCalls,
    emitWithParent(name, info, parent) { (hooks[name] || []).forEach((h) => h.fn.call(parent === undefined ? null : parent, info)) },
    emit(name, info) { this.emitWithParent(name, info, undefined) },
  }
}

// ---------------------------------------------------------------------------
// 会话文件夹具（U8：`<home>/sessions/<bucket>/<sessionId>/<session 快照>`）

/** 临时 home（调用方负责 rmSync 清理） */
export const mkTempHome = (prefix = 'rob-resume-') => mkdtempSync(join(tmpdir(), prefix))

/** 把事件数组压成**一个** zstd 帧（多帧 = 多调一次这个函数再拼起来，真机即 append-only 追加帧） */
export const zstdFrame = (events) => zlib.zstdCompressSync(
  Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'),
)

/**
 * 造一个会话文件，返回其绝对路径。
 * @param {string} home 假 DSH_HOME
 * @param {string} sessionId 会话 id（= 目录名）
 * @param {Buffer[]|Buffer} frames 帧（Buffer 数组按顺序拼接）
 */
export function writeSessionFile(home, sessionId, frames, { bucket = '--ws--', name = 'session.jsonl.zstd' } = {}) {
  const dir = join(home, 'sessions', bucket, sessionId)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, Buffer.concat(Array.isArray(frames) ? frames : [frames]))
  return p
}

/** 事件（带 time/seq 的普通事件；`type` 默认给 turn/end 便于断言） */
export const timedEvent = (time, extra = {}) => ({ type: 'turn/end', time, seq: time, data: {}, ...extra })
