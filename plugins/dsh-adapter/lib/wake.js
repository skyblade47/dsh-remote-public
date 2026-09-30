// @local/dsh-adapter —— 唤醒通道（`adapterWake`）
//
// 为什么放在 adapter：`agentPresets.resolve/mount`、`sessionQuery.readSession`、`agents.resume`
// 都是**宿主 API 胶水**，而 adapter 的既定职责就是收敛各业务插件重复的宿主胶水代码。
// taskkit 已有一份等价实现（`plugins/taskkit/lib/index.js` L1159 `resolveSessionPresetId` /
// L1192 `presetMountSetupFor`），本模块把它抽成**单一来源**，供 `resume-on-boot` 消费，
// 避免出现第三份实现（P3 计划 D1 方案 A）。
//
// 依赖纪律（关键）：**不进 adapter 的 inject**，全部惰性 `ctx.get`。
// 理由：adapter 是最小集成员，若把 `agents`/`sessionQuery` 写进 inject，adapter 的 apply 会被
// 推迟到它们就绪之后——而别的插件正等着 adapter 的 adapterFs/adapterHttp。宁可本服务在依赖
// 缺失时报"缺什么"，也不要让 adapter 整体变慢或变脆。
//
// 与 taskkit 版本的**一处有意增强**：taskkit 的 setup 在 `agentPresets` 缺失时**静默 return**，
// 结果是"唤醒成功但缺 32 个 preset 工具"。本实现把"是否真的挂载了"作为返回值上报
// （`setupMounted`），让调用方能把这个致命退化**记进审计**而不是静默发生。
//
// ⚠️ 2026-09-22 修复（真机验收发现的隐患）：**上报了 `setupMounted` 还不够** ——
//   只要 `resumeWithPreset` 的 `ok` 仍只看"有没有 agent 句柄"，调用方（`resume/index.js` 的 `run()`）
//   就仍会把"唤醒成功、但 preset 根本没挂上"当成成功并写幂等状态 ⇒ **再也不会重试**，
//   正是 A2（工具数完整性）存在的理由所对应的失败模式。
//   现语义（决策原则）：**唤醒只有一件事要做 —— 把会话的完整工具面恢复回来**；
//   `setupMounted !== true` ⇒ 不能算成功（归类见 `classifyPresetSetup`，未知原因一律 fail-closed）。

// ⚠️ 2026-09-25 削峰（T1-1，见 `docs/superpowers/plans/2026-09-25-plugin-memory-control-design.md` §4.2）：
//   原先为了找一条 `agent-preset/selected` 就 `sessionQuery.readSession(sessionId)`（**整份会话全量物化**），
//   而且 6 s 超时是 `Promise.race`（**不取消底层读**）⇒ 调用方以为放弃了，堆里却还在长。
//   现改为：**先只读会话文件的尾窗**（复用自研 `resume/tail.js`，实测比全量读便宜两个数量级），
//   并按**体积闸门**决定读不读；**不再发起全量读** ⇒ 孤儿读从构造上消失。
//   上游事实（本轮只读复核）：`dsh-session-query/lib/index.js:1073 async readSession(sessionId)`
//   —— **不接受 signal**（类型 `readSession(sessionId: SessionId): Promise<SessionLogSnapshot>`），
//   所以"可取消"这条路在当前内核下不成立；本实现采用的是任务允许的替代："**闸门先行 + 不再发起**"。

import fs from 'node:fs'
import { buildSessionFileIndex, readTailEvents } from './resume/tail.js'

const DEFAULT_CACHE_MS = 60_000
const DEFAULT_READ_TIMEOUT_MS = 6_000
const DEFAULT_RESUME_TIMEOUT_MS = 8_000

/**
 * T1-1（2026-09-25）：尾窗读的**体积闸门**（字节）。会话文件超过它就**完全不读日志**，直接退 header
 * （并照旧写 `wake.preset_degraded` 审计 —— **不静默**）。
 *
 * 取 4 MiB 的理由（与 `resume/tail.js#DEFAULT_MAX_TAIL_TAIL` 同值，规则统一成一句
 * "**≤4 MiB 的会话整份都能被尾窗覆盖 ⇒ 读它零信息损失；>4 MiB 的一律不读**"）：
 *   · 真机实测 406 个会话的最高版本快照：p50 58 KB / p90 213 KB / p99 844 KB / max 22.6 MiB；
 *     **>4 MiB 只有 3 个（0.7%）**，而这 3 个占全部字节的 **56%**（50.7 MB / 90.5 MB）
 *     ⇒ 闸门只影响 **0.7% 的会话**，却挡住了**过半的日志体积**（正是"全量物化 × 无上限增长"里最重的那部分）；
 *   · 闸门内的文件：`readTailEvents(initialTail = size)` 一次就把**整个文件**读进窗口 ⇒ 与全量读
 *     **信息等价**（只是不做 JSON→对象 的物化），所以对 99.3% 的会话**零能力损失**。
 */
const DEFAULT_PRESET_TAIL_MAX_BYTES = 4 * 1024 * 1024

/**
 * "良性跳过"允许清单 —— **当前为空**。
 *
 * 事实枚举（`presetMountSetupFor` 里**所有**"不抛、但 `mounted` 不为 true"的路径）：
 *   ① `agentPresets` 服务缺失（`!presets`）⇒ `report.skipped = 'agentPresets.mount 不可用'` 后 return；
 *   ② 服务在、但 `mount` 不是函数 ⇒ 与① 同一个 skip 字符串（同一条 return）；
 *   ③ 宿主**根本没调用 setup**（`agents.resume` 直接返回句柄）⇒ mounted/skipped/error 全保持初值（`skipped=null`）。
 * 除此之外，`resolve`/`mount` 抛错那条路会 `throw`（走 error 通道，不属于"不抛"）。
 *
 * 为什么清单为空：
 *   · ① ② 是"**服务不可用**"⇒ 被唤醒的会话必然缺 preset 工具面，是**真失败**，不是"无事可做"；
 *   · "该会话本就未选择 preset 且 profile 也没有可用默认 preset"这类"属实无事可做"的情形，
 *     在当前实现里**不会产生 skip**：`presetId` 为 `undefined` 时仍会 `presets.resolve(undefined)`
 *     落到 profile default，mount 照常执行（resolve 失败会走 throw 通道）⇒ 现网不存在良性跳过。
 *   ⇒ 因此今天"没挂上"一律按失败处理（fail-closed）。
 *
 * 若将来确实出现"属实无事可做"的 skip（必须满足：真的没有 preset 需要挂、且挂不挂对工具面无差别），
 * 就把它**显式登记**到这里并写明"为什么它是良性的"。登记后它**仍不算成功**
 * （决策原则：`setupMounted !== true` ⇒ 不能算成功），只是 `reason` 从 `preset-not-mounted`
 * 变成 `preset-benign-skip`，好让审计一眼分清"服务坏了"与"确实没活干"；
 * 而且它照样走 `run()` 的 `resume.fail`（WARN）通道 ⇒ 不会被静默吞掉。
 */
const BENIGN_SETUP_SKIPS = Object.freeze([])

/**
 * 归类一次 preset setup 的最终结论。**唯一成功判据：`setupMounted === true`**（不另立判据）。
 * 未知 skip 原因 / `skipped` 为空 / 有 error ⇒ 一律失败（fail-closed：本次要修的就是"静默误判成功"，
 * 对未知原因采取失败是唯一安全的方向）。
 *
 * @param {{setupMounted?: boolean, skipped?: string|null}} [r]
 * @returns {{ok:boolean, reason:string|null}} `ok=false` 时 `reason` 非空
 */
export function classifyPresetSetup({ setupMounted, skipped } = {}) {
  if (setupMounted === true) return { ok: true, reason: null }
  const s = (typeof skipped === 'string' && skipped) ? skipped : null
  return { ok: false, reason: s && BENIGN_SETUP_SKIPS.includes(s) ? 'preset-benign-skip' : 'preset-not-mounted' }
}

/** 带超时的 Promise 竞争：不给宿主 API 无限等待的机会（taskkit 同款做法） */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/**
 * 构造 `adapterWake` 服务（**apply 期只建对象、不调宿主服务** ⇒ 零启动阻塞）。
 *
 * @param {object} opts
 * @param {object} opts.ctx 宿主 ctx（全部依赖惰性 `ctx.get`）
 * @param {Function} [opts.log] 诊断日志（adapter 接 `logApply`）
 * @param {Function} [opts.audit] 审计落盘 `(level, event, message, extra)`
 * @param {Function} [opts.now] 时钟（可注入，便于单测）
 * @param {string} [opts.dshHome] `DSH_HOME`（T1-1 用：尾窗读要定位 `<home>/sessions/<bucket>/<id>/<file>`）。
 *   **不传/为空 ⇒ 尾窗读不可用**，此时保持改造前的 `readSession` 路径**完全不变**（单测/未接线的嵌入场景）。
 */
export function createAdapterWake({ ctx, log = () => {}, audit = () => {}, now = Date.now, dshHome = '' } = {}) {
  const presetIdCache = new Map()
  // T1-1：会话文件索引（惰性建一次并缓存；建不起来 ⇒ 尾窗读不可用，退回既有路径，绝不抛）
  let fileIndex = null
  let tailDisabledLogged = false

  const getService = (name) => {
    try { return (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null) || null } catch (_) { return null }
  }

  /** 依赖体检：缺什么就明说（调用方据此决定是否放弃本轮） */
  function available() {
    const svc = { agents: getService('agents'), sessionQuery: getService('sessionQuery'), agentPresets: getService('agentPresets') }
    const missing = Object.keys(svc).filter((k) => !svc[k])
    return { ok: missing.length === 0, missing, services: svc }
  }

  /** 会话文件索引（惰性建一次；未配 dshHome / 建不起来 ⇒ null = 尾窗读不可用） */
  function fileIndexOrNull() {
    if (fileIndex) return fileIndex
    if (!dshHome || typeof dshHome !== 'string') return null
    try { fileIndex = buildSessionFileIndex(dshHome) } catch (_) { fileIndex = new Map() }
    return fileIndex
  }

  /**
   * T1-1：**只读会话文件的尾窗**，找最后一条 `agent-preset/selected`（不物化整份会话）。
   *
   * 复用自研 `resume/tail.js`（zstd 多帧 append-only ⇒ 帧可独立解码；窗口贴着文件尾 ⇒ 解到 EOF）。
   * 本函数**绝不抛**：任何失败都返回 `{ ok:false, reason }`，由调用方决定退化并**留痕**。
   *
   * @returns {{ ok:true, presetId:string|null, size:number, window:number, framesInWindow:number }
   *          | { ok:false, reason:string, size?:number }}
   *   `reason === 'no-dsh-home'` 是**唯一**"尾窗能力不可用"的信号（调用方据此走既有 readSession 路径）；
   *   其余 reason（`no-session-file` / `file-too-large` / `tail-read-failed` / `stat-failed` / `empty-file`）
   *   都是"**能判但没读到**" ⇒ 一律**不再发起全量读**，直接退 header + 告警。
   */
  function readPresetFromTail(sessionId, maxBytes) {
    if (!dshHome || typeof dshHome !== 'string') return { ok: false, reason: 'no-dsh-home' }
    let index = fileIndexOrNull()
    let file = index ? (index.get(String(sessionId)) || null) : null
    if (!file) {
      // 索引是惰性建一次并缓存的 ⇒ 会话可能在建索引**之后**才落盘：**重扫一次**再判定（只重扫一次）
      try { fileIndex = buildSessionFileIndex(dshHome) } catch (_) { fileIndex = index || new Map() }
      file = fileIndex.get(String(sessionId)) || null
    }
    if (!file) return { ok: false, reason: 'no-session-file' }
    let size
    try { size = fs.statSync(file).size } catch (e) { return { ok: false, reason: 'stat-failed: ' + String((e && e.message) || e) } }
    if (!(size > 0)) return { ok: false, reason: 'empty-file', size }
    if (size > maxBytes) return { ok: false, reason: 'file-too-large', size }
    // 闸门内：initialTail = size ⇒ 一次把**整个文件**纳入窗口（与全量读信息等价，不做 JSON→对象 物化）
    const r = readTailEvents(file, { initialTail: Math.min(size, maxBytes), maxTail: maxBytes })
    if (!r.ok) return { ok: false, reason: 'tail-read-failed: ' + r.reason, size }
    let presetId = null
    for (let i = r.events.length - 1; i >= 0; i--) {
      const ev = r.events[i]
      if (ev && ev.type === 'agent-preset/selected' && ev.data && typeof ev.data.agentPreset === 'string' && ev.data.agentPreset) {
        presetId = ev.data.agentPreset
        break
      }
    }
    return { ok: true, presetId, size, window: r.window, framesInWindow: r.framesInWindow }
  }

  /**
   * 解析会话当前生效的 preset id（**详细版**：带来源，供审计与调用方判断可信度）。
   *
   * **语义与 taskkit 逐条对齐**（这是本项目踩过的坑）：
   * 优先读会话**最后一条 `agent-preset/selected` 事件**，而不是只读 header ——
   * header 是创建时冻结的事实，会话**中途切换 preset 只写 selected 事件**，
   * 只读 header 会让已切换的会话在恢复时丢掉 preset（回到 default）。
   *
   * ⚠️ **2026-09-22 补：退化的读法必须留痕、且不得缓存。**
   * `readSession` 可能会**读不到**（服务缺失 / 超时 / 抛错 / 形状不对，或该会话是当前内核读不动的旧格式），
   * 此时只能退到 header —— 而 header 是创建时冻结值 ⇒ 中途切过 preset 的会被**按创建时的 preset 恢复**
   * （compat-matrix 里 `sessionQuery.readSession` 那条警告描述的就是这个风险，此前是**静默**发生的）。
   * 故：① 如实写审计 `wake.preset_degraded`；② **不写缓存** —— 否则一次读失败会在 TTL 内持续生效，
   * 而下次很可能就读得到了。
   *
   * ⚠️ `readOk` 的口径是"**我们真的拿到了这段日志的事件**"，**不等于**"事件完整"：
   * 旧格式会话可能少给甚至给空（本项目实测过 `readSession` 少报），这种情形这里判不出来。
   * 所以本函数只对**明确的"没读到"**告警，不对"读到了但可能不全"告警（后者会变成假警报）。
   *
   * ★T1-1（2026-09-25）：读法改为**三条路径**（`readPath` 字段如实标注，便于审计归因）：
   *   · `tail`       —— 只读会话文件尾窗（**主路径**，不物化整份会话）；
   *   · `tail-skip`  —— 尾窗读可用但没成功（文件超体积闸门 / 不在索引 / 解不开）⇒ **主动不读**，退 header；
   *   · `readSession`—— **仅当未配置 `dshHome`**（尾窗能力不可用）时的旧路径（行为与改造前完全一致）。
   *
   * @returns {{ presetId: string|undefined, via: 'event'|'header'|'header-no-read'|'none'|'forced', cacheHit: boolean }}
   *   `via`：`event` = 读到日志且有 selected 事件（**唯一可靠**）；`header` = 读到日志但无 selected 事件
   *   ⇒ header 就是生效值、**无风险**；`header-no-read` = **压根没读到日志** ⇒ 有风险；
   *   `none` = 都没拿到（退 default preset）。**审计 `wake.preset_degraded` 只在"没读到日志"时写** ——
   *   会话本身没记 preset（`none` 且读得到）属正常，不告警（否则是假警报，真机实测踩到过）。
   */
  async function resolvePresetDetailed(sessionId, opts = {}) {
    const cacheMs = opts.cacheMs === undefined ? DEFAULT_CACHE_MS : opts.cacheMs
    const hit = presetIdCache.get(sessionId)
    if (hit && now() - hit.ts < cacheMs) return { presetId: hit.presetId, via: hit.via || 'event', cacheHit: true }

    const sessionQuery = getService('sessionQuery')
    const maxBytes = opts.presetTailMaxBytes === undefined ? DEFAULT_PRESET_TAIL_MAX_BYTES : opts.presetTailMaxBytes
    let presetId
    let via = 'none'
    let readOk = false
    let readError = null
    // T1-1 审计用：本次 preset 从**哪条读路径**来的 + 尾窗事实（退化时一定要一眼看出为什么）
    let readPath = 'none'
    let tailSize = null
    if (sessionQuery && typeof sessionQuery.readSession === 'function') {
      const tail = readPresetFromTail(sessionId, maxBytes)
      if (tail.ok) {
        // ---- 路径 1（主路径，T1-1）：只读尾窗，**不物化整份会话** ----
        readPath = 'tail'
        readOk = true
        tailSize = tail.size
        if (tail.presetId) { presetId = tail.presetId; via = 'event' }
      } else if (tail.reason === 'no-dsh-home') {
        // ---- 路径 2：尾窗能力不可用（未配 dshHome，如单测/未接线的嵌入场景）----
        //      ⚠️ 这里**刻意保持改造前的 readSession 路径完全不变**（含超时/抛错语义），避免引入回归。
        readPath = 'readSession'
        if (!tailDisabledLogged) {
          tailDisabledLogged = true
          log('T1-1：未提供 dshHome ⇒ 尾窗读不可用，preset 解析退回既有 readSession 路径（该路径会把整份会话读进堆）')
        }
        // ⚠️ `.catch` 不是装饰：`withTimeout` 用的是 `Promise.race`，**只要 readSession 抛错就立刻 reject**
        //    （超时兜底只在"它自己 resolve 得更快"时才生效）。改动前这个 rejection 会**直接冒出**
        //    `resolvePresetDetailed` → `resumeWithPreset` → 调用方记 `reason:'exception'` 且**不写幂等状态**
        //    ⇒ 每次重启都重试同一会话，而下面这条"退到 header"的兜底路径**永远走不到**。
        //    既有的 `listSessions` 兜底说明设计意图本来就是"读不到也一样能用 header 干活"，
        //    故这里统一收敛到退化路径，并把原因如实带进审计。
        const snap = await withTimeout(
          Promise.resolve().then(() => sessionQuery.readSession(sessionId)),
          opts.readTimeoutMs || DEFAULT_READ_TIMEOUT_MS,
          null,
        ).catch((e) => { readError = String((e && e.message) || e); return null })
        readOk = !!(snap && Array.isArray(snap.events))
        const evs = readOk ? snap.events : []
        for (let i = evs.length - 1; i >= 0; i--) {
          const ev = evs[i]
          if (ev && ev.type === 'agent-preset/selected' && ev.data && typeof ev.data.agentPreset === 'string' && ev.data.agentPreset) {
            presetId = ev.data.agentPreset
            via = 'event'
            break
          }
        }
        // 取值顺序与改动前**完全一致**（仍会用 snap.header）；只是把"有没有真读到日志"如实标出来
        if (!presetId && snap && snap.header && snap.header.agentPreset) {
          presetId = snap.header.agentPreset
          via = readOk ? 'header' : 'header-no-read'
        }
      } else {
        // ---- 路径 3：尾窗读**可用但没成功**（文件超闸门 / 不在索引里 / 解不开）----
        //      ⇒ 🔴 **不再发起全量读**（T1-1 的核心：从构造上消灭"超时不取消的孤儿读"），
        //        直接退 header，并由下面的既有告警通道**如实留痕**（不静默）。
        readPath = 'tail-skip'
        readOk = false
        tailSize = tail.size === undefined ? null : tail.size
        readError = tail.reason + (tail.size === undefined ? '' : '（size=' + tail.size + 'B, 闸门=' + maxBytes + 'B）')
      }
    }
    if (!presetId && sessionQuery && typeof sessionQuery.listSessions === 'function') {
      const rec = await withTimeout(
        Promise.resolve().then(() => sessionQuery.listSessions()),
        opts.listTimeoutMs || 5_000,
        null,
      )
      const found = Array.isArray(rec) ? rec.find((r) => r && r.header && r.header.id === sessionId) : null
      if (found && found.header && found.header.agentPreset) {
        presetId = found.header.agentPreset
        // ⚠️ 与 snap.header 分支同口径：**读没读到日志**才是退化判据。
        //    读到过日志（哪怕里面没有 selected 事件）⇒ 这个 header 值就是生效值，属 `header`（安全）。
        via = readOk ? 'header' : 'header-no-read'
      }
    }
    // 只有**非退化**的结果才进缓存（见上方说明）
    if (presetId && via !== 'header-no-read') presetIdCache.set(sessionId, { presetId, via, ts: now() })
    // ⚠️ 告警的判据是「**我们没读到日志**」（`readOk===false` 或读的时候抛了），
    //    **不是**「日志里没有 preset 记录」——
    //    后者是**完全正常**的状态（会话本来就没显式选过 preset，用 default 才对），
    //    对它告警会变成**假警报**（本仓最忌讳的一类；真机夹具实测踩到过：rob-probe 造的会话
    //    没有任何 preset 记录，于是 `via='none'` 却毫无风险）。
    const readFailed = readError !== null || readOk === false
    if (via === 'header-no-read' || (via === 'none' && readFailed)) {
      // T1-1：把"为什么没读到"写进文案本身（退化的两种来源在审计里必须一眼分得开：
      //   tail-skip = 按体积闸门**主动没读**；readSession = 走了旧路径但读不到）
      const why = readPath === 'tail-skip'
        ? '（T1-1：已按体积闸门**跳过日志读** —— ' + (readError || '未知原因') + '）'
        : ''
      const msg = via === 'header-no-read'
        ? 'preset 解析退化为 header：读不到会话日志（' + sessionId + '）' + why
          + ' ⇒ 若该会话中途切过 preset，将按**创建时**的 preset 恢复'
        : 'preset 解析失败且读不到会话日志（' + sessionId + '）' + why
          + ' ⇒ 唤醒会退回 **default** preset，但**无法确认**该会话是否显式选过 preset'
      log(msg)
      audit('WARN', 'wake.preset_degraded', msg, {
        sessionId, presetId: presetId || null, via,
        readOk, readError: readError || null,
        // T1-1：读路径与尾窗事实（readPath='tail' 读到 / 'tail-skip' 主动没读 / 'readSession' 旧路径）
        readPath, tailSize,
        presetTailMaxBytes: maxBytes,
        hint: '常见原因：① T1-1 体积闸门（会话文件超过 presetTailMaxBytes）② 会话不在文件索引里'
          + ' ③ 尾窗解不开 ④ 走了旧 readSession 路径且读不到（服务不可用/超时/抛错/旧格式，见 P3 计划的会话格式调查）',
      })
    }
    return { presetId, via, cacheHit: false }
  }

  /**
   * 只取 preset id（**对外契约不变**：仍返回字符串）。
   * 需要知道"这个 preset 是从哪读出来的"时用 `resolvePresetDetailed`（内部/审计用）。
   */
  async function resolveSessionPresetId(sessionId, opts = {}) {
    return (await resolvePresetDetailed(sessionId, opts)).presetId
  }

  /**
   * 构造 resume 用的 `setup` 回调：agent 发布前把 preset 组合挂到其 scope 上下文。
   * 与宿主 api-proxy 的 composeAgent 等价；presetId 为 undefined 时 resolve(undefined) 走 default。
   *
   * @param {string} sessionId
   * @param {object} [opts]
   * @param {string} [opts.testForceMissingPresetId] ⚠️ **test-only**（真机验收失败路径用）：
   *   非空字符串时，**替换"决定 preset id"这一步** —— 不解析会话 preset，直接用该值去 resolve/mount，
   *   后面完整挂载流程照常跑并**自然失败**（不伪造失败、不提前短路）。不传/其它值 ⇒ 行为与原先完全一致。
   *   生产不得设置；配置入口为 resume 的 `testForceMissingPresetId`（启用时会写 `resume.test_override` 审计）。
   *
   * 返回值上挂了 `result` 对象，`resumeWithPreset` 会读它来上报"到底挂没挂上"。
   */
  async function presetMountSetupFor(sessionId, opts = {}) {
    const forced = (typeof opts.testForceMissingPresetId === 'string' && opts.testForceMissingPresetId)
      ? opts.testForceMissingPresetId : null
    const resolved = forced ? { presetId: forced, via: 'forced' } : await resolvePresetDetailed(sessionId)
    const presetId = resolved.presetId
    if (forced) {
      log('TEST_OVERRIDE 用假 presetId=' + forced + ' 替换会话 preset 解析（test-only，生产不该出现）sessionId=' + sessionId)
    }
    // `presetSource` 会一路上浮到 `resume.ok/…` 审计 —— 它让"这个 preset 是从哪读出来的"可查：
    //   event / header（安全） vs header-no-read（退化，见 resolvePresetDetailed 的说明）
    const report = { presetId: presetId || null, presetSource: resolved.via, mounted: false, error: null, skipped: null }
    const setup = async function (agentCtx) {
      const presets = getService('agentPresets')
      if (!presets || typeof presets.mount !== 'function') {
        // 有意增强：不再静默 return，而是留下"跳过原因"
        report.skipped = 'agentPresets.mount 不可用'
        log('preset mount 跳过: ' + report.skipped + ' sessionId=' + sessionId)
        return
      }
      try {
        const resolved = await presets.resolve(presetId)
        await presets.mount(agentCtx, resolved.id)
        report.mounted = true
        report.presetId = resolved.id
      } catch (e) {
        report.error = String((e && e.message) || e)
        log('preset mount 失败: ' + report.error + ' sessionId=' + sessionId + ' presetId=' + report.presetId)
        throw e
      }
    }
    setup.result = report
    return setup
  }

  /**
   * 唤醒一个持久化会话，并（尽力）挂上它的 preset。
   *
   * ⚠️ 成败判据（2026-09-22 修复）：**agent 句柄存在 且 `setupMounted === true`**。
   *   "句柄有了、但 preset 没挂上"（`agentPresets.mount` 不可用那条**不抛**的分支）必须返回
   *   `ok:false` + `reason:'preset-not-mounted'`，让调用方的 `if (r.ok)` 自然走到失败分支
   *   （不在上层加特判来遮住它）⇒ 失败不留疤，下次重启仍会重试。
   *
   * @param {string} sessionId
   * @param {object} [opts] 透传给 setup 构建（含 test-only 的 `testForceMissingPresetId`，见 presetMountSetupFor）
   * @returns {Promise<{ok:boolean, agent:object|null, handle:object|null, presetId:string|null, setupMounted:boolean, skipped:string|null, error:string|null, reason:string|null}>}
   *   `reason`（新增字段）：`ok=false` 且失败原因是"preset 没挂上"时为 `preset-not-mounted`
   *   （或将来登记进允许清单后的 `preset-benign-skip`）；句柄级失败（超时/未发布/抛错）时为 `null`
   *   ⇒ 调用方落回既有的 `wake-failed`，语义不变。
   */
  async function resumeWithPreset(sessionId, opts = {}) {
    const agents = getService('agents')
    if (!agents || typeof agents.resume !== 'function') {
      return { ok: false, agent: null, handle: null, presetId: null, presetSource: null, setupMounted: false, skipped: null, error: 'agents.resume 不可用', reason: null }
    }
    const setup = await presetMountSetupFor(sessionId, opts)
    const agentOptions = opts.agentOptions || {
      provider: opts.provider || 'deepseek-official',
      model: opts.model || 'deepseek-v4-flash',
    }
    let handle = null
    let error = null
    try {
      handle = await withTimeout(
        Promise.resolve().then(() => agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          ...(setup ? { setup } : {}),
        })),
        opts.timeoutMs || DEFAULT_RESUME_TIMEOUT_MS,
        null,
      )
    } catch (e) {
      error = String((e && e.message) || e)
    }
    const r = setup && setup.result ? setup.result : { presetId: null, presetSource: null, mounted: false, skipped: null, error: null }
    const setupMounted = !!r.mounted
    const agentOk = !!(handle && handle.agent)
    const verdict = classifyPresetSetup({ setupMounted, skipped: r.skipped })
    // 句柄级失败（超时/未发布/抛错）沿用既有口径，`reason` 留空 ⇒ 调用方仍记 `wake-failed`
    const wakeError = error || r.error || (handle ? null : 'resume 超时或未返回 agent 句柄')
    const notMounted = agentOk && !verdict.ok
    return {
      ok: agentOk && verdict.ok,
      agent: (handle && handle.agent) || null,
      handle: handle || null,
      presetId: r.presetId,
      // 让审计能看出"这个 preset 是读事件来的（可靠）还是退到 header 来的（可能挂错）"
      presetSource: r.presetSource || null,
      setupMounted,
      skipped: r.skipped || null,
      error: wakeError || (notMounted ? 'preset 未挂上：' + (r.skipped || '未知原因') : null),
      reason: notMounted ? verdict.reason : null,
    }
  }

  /**
   * 向会话投递一条说明（U2b 裁决：inbox 投递，角色 user）。
   *
   * 为什么不是 `system/message`：那条路要注册 `dsh-system-prompt` / `sessionProjections`，
   * 语义是**持续性系统提示**；内核注释明确 "injected context project in **user role**" 是**预期**行为。
   * 见 `docs/spikes/2026-09-22-u2-system-message-injection.md`。
   *
   * ⚠️ `role:'user'` 与第 3 个参数 `false` **按 taskkit 实码先例**（L1652/L1712），
   * 属 spike 的残留项 R1/R2，需真机确认后才能宣称完全对齐。
   */
  async function injectNotice(agent, text, opts = {}) {
    if (!agent || typeof agent.send !== 'function') return { ok: false, error: 'agent.send 不可用' }
    const plugin = opts.plugin || 'resume-on-boot'
    const id = opts.id || 'notice-' + plugin + '-' + now()
    try {
      await agent.send(
        {
          id,
          role: 'user',
          content: [{ type: 'text', text: String(text) }],
          source: { kind: 'plugin', plugin },
        },
        opts.target || 'next-turn',
        false,
      )
      return { ok: true, id }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  return { available, resolveSessionPresetId, presetMountSetupFor, resumeWithPreset, injectNotice }
}
