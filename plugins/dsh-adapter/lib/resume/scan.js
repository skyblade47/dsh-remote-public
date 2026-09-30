// @local/dsh-adapter —— 重启自恢复：扫描与候选构建（P3 §2B 两级扫描 + §2D D6 分层判据）
//
// 实现计划：docs/superpowers/plans/2026-09-22-dsh-remote-p3-resume-on-boot.md
//   一级预筛 = §2B/U8：取"最后活跃时间"落在 recentWindowMs 内的会话；
//   二级判定 = §2D：只对幸存者读完整日志，按 P1（父已闭合 + 子未闭合）→ P0（自身未闭合）分层。
//
// ⛔ 三条**硬禁止**（都由真机实测换来，不要"优化"掉）：
//   1. **禁止用文件 mtime 当闸门**。Linux 迁移把 554 个快照文件的 mtime 刷成同一时刻（≈迁移时刻）
//      ⇒ 用 mtime 等于没有闸门（会放行全部）。
//   2. **禁止用 subagent 的 `activity` 当"在途"判据**。`activity:'running'` 只对**活着的**
//      子会话成立，重启后一律 `inactive` ⇒ 拿它判"重启时子代理是否在途"必然全错。
//   3. **禁止把闸门套在 `header.createdAt` 上**（U7b 的坏法）。`createdAt` 是**会话创建时间**：
//      真机 dryRun 实录 539 条 skip **全部** `lastActiveSource:"createdAt", hasProjection:false`
//      ⇒ 26 天前创建、今早才活跃的会话被误排除。**闸门必须套在日志最后一帧的最后事件时间上**（U8）。
//
// 一级预筛的成本（§2B/U8）：每会话一次 `stat` + 读尾几 KB + 一次小帧解压（见 ./tail.js），
//   **不再依赖投影缓存是否水合**；二级判定**只碰一级预筛的幸存者**（554 个会话、单个日志可达 30MB）。

import { lastTurnState, SIGNAL } from './detect.js'
import { lastEventOf, buildSessionFileIndex, turnStateFromTail, DEFAULT_MAX_TAIL_TAIL } from './tail.js'

/**
 * 判据层（§2D D6）。P2/P3 本轮**不实现**，仅作扩展点（见 selectByLayer 与 index.js 的 TODO）。
 *
 * ⚠️ `P0` 里有一个**必须区分**的子类：`delegationInFlight`（自身未闭合 **且**名下有未闭合子会话）。
 *    它不是新层（层仍是 P0，因为父的 turn 确实没闭合），但**唤醒策略与纯 P0 完全不同** ——
 *    详见 `selectByLayer` 与 `layerRank`。
 */
export const LAYER = { P1: 'P1', P0: 'P0', P2: 'P2', P3: 'P3' }

/** 默认时间窗（6 小时，§2B：真实数据里 P0 命中 56% ⇒ 时间窗是让 P0 可用的前提，不是优化） */
export const DEFAULT_RECENT_WINDOW_MS = 6 * 3600 * 1000

const LIST_TIMEOUT_MS = 15000
const READ_TIMEOUT_MS = 15000

const getService = (ctx, name) => {
  try { return (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null) || null } catch (_) { return null }
}

const errMsg = (e) => String((e && e.message) || e)

/**
 * 带超时的 Promise 竞争（与 wake.js 同款语义）。
 * 与 wake.js 的差别：这里**必须清掉**兜底定时器，否则扫描里的每个 timeout 都会挂着一个
 * 未 unref 的 timer，进程/测试的事件循环无法退出。
 */
async function withTimeout(promise, ms, fallback) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise)
  let timer = null
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** listSessions 的返回项可能是 `{ header }`（SessionRecord），也可能就是 header 本身 —— 两种都认 */
export function headerOf(record) {
  if (!record || typeof record !== 'object') return null
  if (record.header && typeof record.header === 'object') return record.header
  return record
}

/**
 * 是否子会话（D6 的形态事实：父子关系**持久化在 header**）。
 *
 * 依据 `origin === 'subagent'` / `parentSession` / `delegationDepth > 0`。
 * 交叉校验：子会话 id **不带 `session-` 前缀**，主会话才带（真机实测）——
 * 这里**不用** id 前缀做判据（前缀是弱信号，改一次命名规范就会静默失效），
 * 只在审计里带上 id 供人工核对。
 */
export function isSubagentSession(header) {
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (header.parentSession || header.parentSessionId) return true
  if (Number(header.delegationDepth) > 0) return true
  return false
}

const finiteAt = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 一级预筛的时间判定（**四级降级链**，§2B U8 实测结论）。
 *
 *   1. `tail`：会话日志**最后一帧的最后一条事件**的 `time`（精确；见 ./tail.js，成本 = 一次 stat + 读尾几 KB）
 *   2. `sessionProjectionCache` 的 `lastPromptAt`（**保留**，但降为第 2 级）
 *   3. `header.createdAt`（粗：它是**会话创建时间**、不是活跃时间，长会话会偏早，但 100% 可得）
 *   4. 三级都拿不到、或拿到的都落在窗口外 ⇒ 跳过（**宁漏不滥**，调用方必须写审计）
 *
 * 为什么 `tail` 在前而投影缓存降级：真机 dryRun（539 个会话）里 `lastPromptAt` **一次都没命中**
 * （全部退化成 `createdAt`）⇒ 旧的两级链把闸门套在了"创建时间"上，26 天前创建、今早才活跃的会话
 * 会被误排除。投影缓存机制本身可用（U7 实测），只是覆盖面/水合不可靠 ⇒ 留作兜底，**不当主路径**。
 *
 * 另注：`lastPromptAt` 是**最后一条用户消息**的时间（agent 之后跑很久才被掐断就会偏早），
 * 而 `tail` 拿的是最后一条**事件**的时间 ⇒ 更准，窗口默认取宽松值（6h）仍保守。
 *
 * @returns {{ at: number|null, source: 'tail'|'lastPromptAt'|'createdAt'|'none', inWindow: boolean }}
 */
export function pickLastActiveInWindow({ tailTime, lastPromptAt, createdAt } = {}, { now, windowMs } = {}) {
  const lower = Number(now) - Number(windowMs)
  const t = finiteAt(tailTime)
  if (t !== null && t >= lower) return { at: t, source: 'tail', inWindow: true }
  const p = finiteAt(lastPromptAt)
  if (p !== null && p >= lower) return { at: p, source: 'lastPromptAt', inWindow: true }
  const c = finiteAt(createdAt)
  if (c !== null && c >= lower) return { at: c, source: 'createdAt', inWindow: true }
  if (t !== null) return { at: t, source: 'tail', inWindow: false }
  if (p !== null) return { at: p, source: 'lastPromptAt', inWindow: false }
  if (c !== null) return { at: c, source: 'createdAt', inWindow: false }
  return { at: null, source: 'none', inWindow: false }
}

/**
 * 读投影缓存里的 `lastPromptAt`（降级链第 2 级）。
 *
 * 调用形状按 P3 §2B 实测：`cachedSnapshot(header, 0, ['sessionListMetadata'])`
 * → `.values.sessionListMetadata.lastPromptAt`；缓存行形如 `{ver, seq, val}`（真机实测），
 * 故 `val` 是对象时取 `val`，否则把该行本身当元数据。任何异常/缺失一律返回 null（降级，不抛）。
 */
export async function readProjectionLastPromptAt(ctx, header) {
  const svc = getService(ctx, 'sessionProjectionCache')
  if (!svc || typeof svc.cachedSnapshot !== 'function') return null
  let snap
  try {
    snap = svc.cachedSnapshot(header, 0, ['sessionListMetadata'])
  } catch (_) { return null }
  if (snap && typeof snap.then === 'function') {
    try { snap = await snap } catch (_) { return null }
  }
  const row = snap && snap.values ? snap.values.sessionListMetadata : null
  if (!row || typeof row !== 'object') return null
  const meta = (row.val && typeof row.val === 'object') ? row.val : row
  return finiteAt(meta.lastPromptAt)
}

/**
 * 一级预筛：**一次 `listSessions()` 拿全部 header**（不自己遍历文件系统拿会话清单），
 * 再用**日志最后一帧的最后事件时间**（U8）过时间窗。
 *
 * 成本 = 每会话一次 `stat` + 读尾几 KB + 一次小帧解压（见 ./tail.js），
 * **不再依赖投影缓存是否水合**；投影缓存只在尾帧没命中窗口时才去问一次。
 *
 * @param {object} opts
 * @param {object} opts.ctx 宿主 ctx（`sessionQuery` / `sessionProjectionCache` 惰性取）
 * @param {string} opts.dshHome **必须由调用方传入**：用于建 `<home>/sessions` 的会话文件索引；
 *   为空/缺省 ⇒ 索引为空 Map ⇒ tail 那级整体不可用（自动退到 lastPromptAt/createdAt，不抛）
 * @param {Map<string,string>} [opts.index] 会话文件索引（U10）：由调用方 `buildSessionFileIndex(dshHome)`
 *   建一次后**同时**传给本函数与 `judgeCandidates`，避免建两遍；不传则本函数自己建（保持向后兼容）
 * @returns {{ ok:boolean, reason?:string, total:number, survivors:Array, skipped:Array, stats:object, childrenByParent:Map }}
 *   `stats` = 一级预筛的**来源分布**（tail/lastPromptAt/createdAt/none 各多少条）+ `tailTimeSources`
 *   （tail 那级的时间取自 time / time0 各多少条）+ tailFailed + tailNoFile + indexSize + durationMs
 *   —— 供调用方写 `resume.prescan` 汇总审计。
 *   ⚠️ 这条汇总审计是**必须**的：U7b 就是靠"每条都写着 createdAt"才发现闸门套错了量；
 *   来源分布必须一眼可见，否则下次坏了还是看不出来。
 *   ⚠️ U12 结论（2026-09-22 真机复核）：U8 那轮的 `tailFailed=53~56`（≈10%）**不是读取失败**，
 *   而是判据漏了分片事件的 `time0`（末条是 `text-chunks`/`reasoning-chunks`/`assistant/chunk`，时间在 time0）。
 *   改成"窗口内从尾往前找 time → time0"后 tailFailed 应当掉到接近 0、`tailTimeSources.time0` 顶上——
 *   所以**不要**为了让数字好看去放宽判据；反过来，若 tailTimeSources.time0 为 0 而 tailFailed 又涨回去，
 *   说明这条链又断了一处。
 *   `childrenByParent` = **运行期结构**（`Map<parentId, childId[]>`，父子关系从 header 派生，D6），
 *   供 P1 在 `subagents` 服务不可用时兜底枚举子会话（见 judgeCandidates）。
 *   ⚠️ **不要**把它塞进 stats、也不要序列化进 JSON 审计（审计是 JSONL，会话多时会爆量）。
 *   `survivors[].detail` = 每个幸存者的**审计明细**（sessionId / lastActiveAt / lastActiveSource /
 *   lastEventType / lastEventSeq / hasSessionFile / cwd / origin / createdAt / windowMs / now），
 *   由调用方（index.js）逐条 emit 成 `resume.survivor` —— 本函数**不持审计通道**，只把数据交出去。
 */
export async function prescanSessions({ ctx, dshHome = '', index = null, now = Date.now, recentWindowMs = DEFAULT_RECENT_WINDOW_MS, signal } = {}) {
  const started = Number(now())
  const stats = {
    total: 0, survivors: 0,
    sources: { tail: 0, lastPromptAt: 0, createdAt: 0, none: 0 },
    // U12：tail 那级取到的"最后活跃时间"落在哪一列上（time=普通事件；time0=**流式分片**事件）。
    // 真机 539 会话里那 56 个"定位到文件却取不到时间"的末条**全是分片事件**（只有 time0 没有 time），
    // ⇒ 修好后这里的 time0 应当把 tailFailed 顶掉（真机预期 tail 351→407、createdAt 53→0）。
    tailTimeSources: { time: 0, time0: 0 },
    tailFailed: 0, tailNoFile: 0, subagentSkipped: 0, indexSize: 0, durationMs: 0,
  }
  // D6：父子关系持久化在 header（`origin:'subagent'` / `parentSession` / `delegationDepth`），
  // 遍历 header 时**顺带**把 `父id → 子id[]` 收下来 —— 这是 P1 不依赖 `subagents` 服务的兜底来源。
  const childrenByParent = new Map()
  const out = { ok: false, total: 0, survivors: [], skipped: [], stats, childrenByParent }
  const done = (r) => { stats.durationMs = Math.max(0, Number(now()) - started); return r }

  const sessionQuery = getService(ctx, 'sessionQuery')
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') {
    // 不抛：本轮干净退出，由调用方记审计（"不静默"）。
    return done({ ...out, reason: 'sessionQuery 不可用（listSessions 缺失）' })
  }

  let records
  try {
    records = await withTimeout(sessionQuery.listSessions(signal), LIST_TIMEOUT_MS, null)
  } catch (e) {
    return done({ ...out, reason: 'listSessions 抛错: ' + errMsg(e) })
  }
  if (!Array.isArray(records)) return done({ ...out, reason: 'listSessions 未返回数组' })
  out.total = records.length
  stats.total = records.length

  const t = Number(now())
  // 会话文件索引只遍历一次（~554 个目录）：bucket 命名规则会漂移，按 header.cwd 反推不可靠。
  // U10：索引由调用方建好后传进来（一级预筛与二级判定共用同一份），不再各自建一遍。
  const fileIndex = (index && typeof index.get === 'function') ? index : buildSessionFileIndex(dshHome)
  stats.indexSize = fileIndex.size

  for (const rec of records) {
    const header = headerOf(rec)
    const id = header && (header.id || (rec && rec.sessionId))
    if (!id) {
      out.skipped.push({ sessionId: null, reason: '无 id，无法定位会话' })
      continue
    }
    if (isSubagentSession(header)) {
      // ⚠️ 顺序有讲究：父子关系的收集**必须在"跳过子会话"之前**做，
      // 否则子会话在这里就被 `continue` 掉了，兜底路径的 childrenByParent 会永远是空 Map。
      const parentId = header.parentSession || header.parentSessionId || null
      if (parentId) {
        const key = String(parentId)
        const arr = childrenByParent.get(key)
        if (arr) arr.push(id)
        else childrenByParent.set(key, [id])
      }
      // 子会话绝不作为唤醒目标（没有用户来源，自己跑不起来）——它只能经父会话的 listChildren/header 被看到。
      stats.subagentSkipped++
      out.skipped.push({
        sessionId: id, reason: 'subagent 会话不作为唤醒目标（D6）',
        origin: header.origin || null, parentSession: header.parentSession || null,
      })
      continue
    }

    // ---- 降级链第 1 级：日志尾部窗口的"最后活跃时间"（U8 / U12）----
    const file = fileIndex.get(String(id)) || null
    const tailRes = file ? lastEventOf(file) : null
    const tailAt = (tailRes && tailRes.ok) ? finiteAt(tailRes.lastEventTime) : null
    const tailUsable = tailAt !== null
    // U12：这个时间取自哪一列（time / time0）—— 修好分片事件判据后，tailFailed 应当掉到接近 0
    const tailTimeSource = (tailRes && tailRes.ok) ? tailRes.lastEventTimeSource : null
    if (tailTimeSource) stats.tailTimeSources[tailTimeSource] = (stats.tailTimeSources[tailTimeSource] || 0) + 1
    if (!file) stats.tailNoFile++
    else if (!tailUsable) stats.tailFailed++

    // 尾帧命中窗口 ⇒ **不再去碰投影缓存**（省掉一次宿主服务调用，这是 U8 的成本主张）
    let picked = pickLastActiveInWindow({ tailTime: tailAt }, { now: t, windowMs: recentWindowMs })
    let lastPromptAt = null
    if (!picked.inWindow) {
      lastPromptAt = await readProjectionLastPromptAt(ctx, header)
      picked = pickLastActiveInWindow(
        { tailTime: tailAt, lastPromptAt, createdAt: header.createdAt },
        { now: t, windowMs: recentWindowMs },
      )
    }
    stats.sources[picked.source] = (stats.sources[picked.source] || 0) + 1

    // 每条 skip/保留都如实记来源与判据输入（**不带 header 本体**，避免审计爆量）
    const auditFields = {
      lastActiveAt: picked.at, lastActiveSource: picked.source,
      lastEventType: (tailRes && tailRes.ok) ? tailRes.lastEventType : null,
      // 末条事件的 seq：与 lastEventType 一起，供人工把"日志最后一条事件"与窗口边界对上
      lastEventSeq: (tailRes && tailRes.ok) ? tailRes.lastEventSeq : null,
      // U12：拿到的最后活跃时间取自哪一列（time / time0；null = 窗口内没有可用时间 ⇒ 走了降级链）
      lastEventTimeSource: tailTimeSource,
      windowMs: recentWindowMs, now: t,
      createdAt: finiteAt(header.createdAt), hasProjection: lastPromptAt !== null,
      hasSessionFile: !!file, tailUsable, tailWindow: (tailRes && tailRes.ok) ? tailRes.window : null,
    }

    if (!picked.inWindow) {
      // 降级链走到头：跳过 + 必须入审计（这是以后按真数据回调 recentWindowMs 的唯一依据）
      out.skipped.push({ sessionId: id, reason: 'window-out：最后活跃时间落在窗口外', ...auditFields })
      continue
    }
    out.survivors.push({
      sessionId: id, header,
      lastActiveAt: picked.at, lastActiveSource: picked.source,
      lastEventType: auditFields.lastEventType, windowMs: recentWindowMs, now: t,
      // ★逐条明细（**不进汇总行**，由 index.js 统一 emit 成 `resume.survivor`）：
      //   真机 12h 窗下"survivors=1 却 P1=P0=0"，而汇总行只报**条数** ⇒ 分不出
      //   "幸存的其实是另一个会话"还是"幸存者就是这个父会话、只是子枚举返回了空"。
      //   故必须逐条报出"是谁 + 窗口套在哪一列上"。幸存者数量很小，不会刷屏。
      detail: {
        sessionId: id,
        lastActiveAt: picked.at, lastActiveSource: picked.source,
        lastEventType: auditFields.lastEventType, lastEventSeq: auditFields.lastEventSeq,
        // U12：这一条的"最后活跃时间"落在哪一列上（time / time0）—— 真机复测一眼确认分片事件被认到了
        lastEventTimeSource: auditFields.lastEventTimeSource,
        hasSessionFile: !!file,
        // cwd/origin 供人工核对"这个会话是什么角色"（origin='subagent' 的在上方就 continue 了，这里一般是主会话）
        cwd: header.cwd || null, origin: header.origin || null,
        createdAt: finiteAt(header.createdAt),
        parentSession: header.parentSession || header.parentSessionId || null,
        windowMs: recentWindowMs, now: t,
        tailUsable, tailWindow: auditFields.tailWindow,
      },
    })
  }
  stats.survivors = out.survivors.length
  out.ok = true
  return done(out)
}

/** 读一个会话的完整事件（§2B 硬约束：`readSession` 只能读全量，没有 tail/limit） */
async function readEvents(sessionQuery, sessionId, timeoutMs) {
  const snap = await withTimeout(Promise.resolve().then(() => sessionQuery.readSession(sessionId)), timeoutMs, null)
  if (!snap || !Array.isArray(snap.events)) throw new Error('readSession 无事件（超时或返回空）')
  return snap.events
}

/**
 * 回退路径：读**全量**日志 + `lastTurnState`（U10 之前二级判定的唯一取法，语义原样保留）。
 * 读失败**不抛**，而是如实返回 `{ ok:false }` —— 由调用方按"读失败"处理（绝不改成"当作已闭合"）。
 */
async function stateFromFullRead(sessionId, sessionQuery, timeoutMs) {
  try {
    return { ok: true, state: lastTurnState(await readEvents(sessionQuery, sessionId, timeoutMs)), source: 'read' }
  } catch (e) {
    return { ok: false, source: 'read', error: errMsg(e) }
  }
}

/**
 * T1-2（2026-09-25）：二级判定是否允许"尾帧判不了 ⇒ **回退读全量日志**"。
 *
 * **置 false = 关闭回退**（当前值，见 `2026-09-25-plugin-memory-control-design.md` §4.2 T1-2）。
 *
 * 为什么关：回退走的是 `sessionQuery.readSession(sessionId)`（内核冷读，**整份会话全量物化**，
 * 见上游 `dsh-session-query/lib/index.js:1073`；且它的签名**不接受 signal** ⇒ 发起后无法取消）。
 * 真机末轮实测 `末态取法 tail=11/回退读全量=2`，而单个大会话（实测 12.9 MB 压缩 ⇒ 解压 61 MB JSONL）
 * 一次物化就是几百 MB 堆 —— 这是本仓"全量物化 × 无上限增长"这条张力的最重一处。
 *
 * 语义安全性（**不是"改判据"，只是"拿不到就说拿不到"**）：`tail.js:248-252` 已证
 * "窗口贴着文件尾 ⇒ 绝不会给出**错的**末态，最多是**这一轮拿不到**" ⇒ 代价是**漏判**，不是错判。
 *
 * 怎么回退：把下面这个常量改回 `true`（保留全量回退）即可；`stateFromFullRead` / `readEvents`
 * 与 `READ_TIMEOUT_MS` 全部原样保留、不删，就是为了让这条回退仍是一行开关。
 */
const ALLOW_FULL_READ_FALLBACK = false

/**
 * 单个会话"末态"的取法（U10；**2026-09-25 T1-2 收紧**）。
 *
 * 1. 会话文件索引里有这个会话 ⇒ `turnStateFromTail`（只读尾窗、不读全量日志）；
 * 2. 尾帧**判不了**（窗口内没有 turn 边界 —— 即"该会话的末条边界比 `maxTail` 更深 / 文件相对阈值太大"）
 *    ⇒ **不再回退读全量**（`ALLOW_FULL_READ_FALLBACK=true` 时才走原来的 `stateFromFullRead`）；
 * 3. 索引里**没有**这个会话（连文件都定位不到）⇒ **保留**既有回退（语义与改造前完全一致）：
 *    这种情况**没有文件可 `stat`**，体积闸门根本无从施加，而且真机上"我们定位不到文件"通常
 *    意味着内核也读不到它（同一棵树）⇒ 那一次读多半是**便宜或直接失败**的，不是本项要治的形态。
 *    ⇒ 这个分支是**已知的残留缺口**（无法按体积约束），已在审计里用 `tailReason:'no-session-file'` 标记；
 *      要彻底关掉它需要"发起前按体积熔断"的能力（设计文档 §4.2 **T1-8**），本轮不做。
 *
 * ⚠️ 判据本身**一个字都没改**：`lastTurnState` 的定义、P1 优先、scope、resumeKeyFor 全都原样，
 * 变的只是"**有文件但判不了时不再用全量读去救**"。父会话自身与每个子会话都走这条路径。
 *
 * ⚠️ **降级必须可分辨（不静默）**：返回值的 `error` 文案里显式写明"已禁用全量回退"与具体原因，
 * 它会一路进 `resume.skip`（WARN）与 `resume.judge` 的 `detail.error`；同时 `fullReadSkipped:true`
 * 让调用方能把它与"回退读了但读失败"区分开（两者在 `tailJudgeFailed` 里长得一样）。
 *
 * @returns {{ ok:true, state:object, source:'tail'|'read', window?:number, framesInWindow?:number,
 *             tailFailed?:boolean, tailReason?:string }
 *          | { ok:false, source:'tail'|'read', error:string, tailFailed?:boolean, tailReason?:string,
 *              tailWindow?:number|null, fullReadSkipped?:true }}
 */
async function turnStateOf(sessionId, { index = null, sessionQuery = null, timeoutMs } = {}) {
  const file = (index && typeof index.get === 'function') ? (index.get(String(sessionId)) || null) : null
  if (file) {
    const t = turnStateFromTail(file)
    if (t.ok) return { ok: true, state: t.state, source: 'tail', window: t.window, framesInWindow: t.framesInWindow }
    const tailWindow = t.window == null ? null : t.window
    if (ALLOW_FULL_READ_FALLBACK) {
      // 尾帧判不了 ⇒ 回退（记下原因，便于审计里区分"没有文件"与"窗口内没边界"）
      const fb = await stateFromFullRead(sessionId, sessionQuery, timeoutMs)
      return { ...fb, tailFailed: true, tailReason: t.reason || null, tailWindow }
    }
    return {
      ok: false, source: 'tail', fullReadSkipped: true,
      error: '末态判不了：尾窗（上限 ' + DEFAULT_MAX_TAIL_TAIL + 'B）内没有 turn 边界'
        + '，且已禁用全量回退（T1-2：不再调用 sessionQuery.readSession）'
        + '（tail=' + (t.reason || 'unknown') + (t.detail ? ', ' + t.detail : '') + '）',
      tailFailed: true, tailReason: t.reason || null, tailWindow,
    }
  }
  // ⚠️ 没有文件可 stat ⇒ 体积闸门无从施加 ⇒ **保留既有回退**（= 改造前语义），并如实标 tailReason
  const fb = await stateFromFullRead(sessionId, sessionQuery, timeoutMs)
  return { ...fb, tailFailed: true, tailReason: 'no-session-file' }
}

/**
 * 唤醒优先级（2026-09-22 扩展）。
 *
 * 顺序：**P1**（父已闭合 + 子未闭合）→ **P0+在飞委派**（父未闭合 + 子未闭合）→ **P0**（父未闭合、无子）→ 其它。
 * 为什么 P1 排在 P0+在飞委派前：P1 的父会话已经安静下来，唤醒它成本更低、更不像打扰；
 * 而 P0+在飞委派的父会话可能有半句话没写完。两者都是"明确有活没干完"，故都在 tasks-only 下放行；
 * 单次上限 `maxResumePerBoot` 截断时，先丢的是噪声更大的那类。
 */
const layerRank = (c) => {
  if (c.layer === LAYER.P1) return 0
  if (c.layer === LAYER.P0) return c.delegationInFlight ? 1 : 2
  return 3
}
const byLayerThenRecency = (a, b) => {
  const d = layerRank(a) - layerRank(b)
  return d !== 0 ? d : (b.lastActiveAt || 0) - (a.lastActiveAt || 0)
}

/**
 * 把"子会话引用"归一化：`subagents.listChildren` 给的是 `{id, mode, label, activity,…}`，
 * 而 header 兜底给的是裸 id 字符串 ⇒ 两种形状都要认。
 * ⚠️ 刻意**不**读取/不传递那里的 `activity`（重启后一律 inactive，判不了"在途"，见文件头硬禁止 2）。
 */
function childRef(ch) {
  if (typeof ch === 'string') return ch ? { id: ch, mode: null } : null
  if (!ch || typeof ch !== 'object') return null
  const id = ch.id || ch.sessionId
  return id ? { id, mode: ch.mode || null } : null
}

/** 审计里 `openChildren` 的截断长度（子会话可能上百个，明细行必须**有界**） */
const OPEN_CHILDREN_AUDIT_LIMIT = 10

/** 审计里 `childrenRawSample` 的条数（只前 3 条，明细行必须**有界**） */
const CHILD_SAMPLE_LIMIT = 3

/**
 * 子会话条目的**形态摘要**（纯诊断字段，必须**有界**：只挑少量字段，绝不把整条塞进审计）。
 *
 * 为什么需要它：真机出现过"P1=0 但本该有未闭合子会话"，而两种可能（服务返回空数组 / 服务返回
 * 了别的形状如 `{kind:'diagnostic', id, reason}`）在只报条数的审计里分不开 ⇒
 * 必须能一眼看出返回的到底是 `{kind:'child', id, mode, activity}` 还是诊断项还是别的形状。
 * 只取几个标量 + 前 8 个键名 + 截断的 reason，单条体积可控。
 */
function childShapeSample(ch) {
  if (typeof ch === 'string') return { shape: 'string', id: ch }
  if (!ch || typeof ch !== 'object') return { shape: typeof ch, id: null }
  return {
    shape: Array.isArray(ch) ? 'array' : 'object',
    id: ch.id || ch.sessionId || null,
    kind: typeof ch.kind === 'string' ? ch.kind : null,
    mode: typeof ch.mode === 'string' ? ch.mode : null,
    activity: typeof ch.activity === 'string' ? ch.activity : null,
    reason: typeof ch.reason === 'string' ? ch.reason.slice(0, 120) : null,
    keys: Object.keys(ch).slice(0, 8),
  }
}

/** 审计里差异项样本的截断长度（`onlyInDescDirect` / `deltaOpen`；明细行必须**有界**） */
const DESC_AUDIT_LIMIT = 10

/**
 * 对差异项最多**抽样**判多少个 turn 状态。
 * 每个 ≈ 一次尾窗读（U10 实测约 97ms），故必须有界：差异大时（例如 listChildren 返回空、
 * 而后代树有 135 项）全判会把一轮扫描重新拖回分钟级。
 */
const DESC_DELTA_LIMIT = 10

/**
 * 对照审计（P3-U11-DESC）：同一父会话再用内核原生的 `subagents.listDescendants(rootId)` 枚举一次
 * **整棵后代树**，把与本次实际使用来源的差异写进审计。
 *
 * **为什么先审计、不当场升级**（2026-09-22 已裁定）：
 * `listChildren` 的文档自陈有两种"看着像漏了"的形态 —— `creation window` 内 running 但
 * descriptor 尚未落盘的条目**会被省略**、以及 `kind:'diagnostic'` 行（corrupt / unavailable）。
 * 但 P1 在真数据上已命中 8 例、路径已验过 ⇒ 不为了"可能更全"直接改判据，
 * **先看清差多少再决定**（与"跨 profile 绝对值不可比"那类教训一脉相承）。
 *
 * **成本控制**：无差异时**零额外读**（`delta` 为空 ⇒ 不进抽样循环）；有差异才抽样，
 * 且**直接子代优先**（那才是"本该被枚举到却被漏掉"的候选），抽满 `DESC_DELTA_LIMIT` 即止。
 *
 * ⛔ 本函数**绝不参与判据**：返回值只交给审计，`children` / `openChildren` / `candidates` 不受影响。
 *
 * @returns {Promise<object>} 见 judgeCandidates 文档的 `desc` 字段说明
 */
async function descendantsCompare({ subagents, sessionId, children, index, sessionQuery, signal, timeoutMs }) {
  const out = {
    source: 'unavailable', error: null,
    rawCount: 0, childCount: 0, diagnosticCount: 0, maxDepth: 0, directCount: 0,
    onlyInDescDirect: [], onlyInDescDirectTotal: 0,
    onlyInDescDeeperTotal: 0, onlyInServiceTotal: 0,
    deltaTotal: 0, deltaChecked: 0, deltaOpen: [], deltaOpenTotal: 0,
  }
  if (!subagents || typeof subagents.listDescendants !== 'function') return out

  let entries
  try {
    const r = await withTimeout(subagents.listDescendants(sessionId, signal), READ_TIMEOUT_MS, null)
    if (!Array.isArray(r)) {
      out.source = 'failed'
      out.error = r === null ? 'listDescendants 超时/无返回' : 'listDescendants 返回非数组'
      return out
    }
    entries = r
  } catch (e) {
    // 失败只降级 + 留痕（consolidated 到审计），**不影响 P1 判定**
    out.source = 'failed'
    out.error = errMsg(e)
    return out
  }
  out.source = 'ok'
  out.rawCount = entries.length

  // 基线 = 本次**实际使用的**来源（service 或 header 兜底），这样两边的差异才有意义
  const baseline = new Set(
    (Array.isArray(children) ? children : [])
      .map((ch) => { const r = childRef(ch); return r ? String(r.id) : null })
      .filter(Boolean),
  )

  const descIds = new Set()
  const deltaDirect = []
  const deltaDeeper = []
  for (const e of entries) {
    const ref = childRef(e)
    if (!ref) continue
    const id = String(ref.id)
    descIds.add(id)
    const diag = !!(e && e.kind === 'diagnostic')
    if (diag) out.diagnosticCount++
    else out.childCount++
    const depth = Number(e && e.depth)
    if (Number.isFinite(depth)) {
      if (depth > out.maxDepth) out.maxDepth = depth
      if (depth === 1) out.directCount++
    }
    if (baseline.has(id)) continue
    const item = { id, depth: Number.isFinite(depth) ? depth : null, mode: ref.mode || null, diag }
    // depth===1 才是"**本该被枚举到的直接子代**"（真正的漏报候选）；
    // 更深层（孙代等）是 listDescendants 带来的**新增覆盖**，不是漏报 —— 必须分开报，否则看不出性质。
    if (depth === 1) deltaDirect.push(item)
    else deltaDeeper.push(item)
  }
  let onlyInService = 0
  for (const id of baseline) if (!descIds.has(id)) onlyInService++

  out.onlyInDescDirectTotal = deltaDirect.length
  out.onlyInDescDeeperTotal = deltaDeeper.length
  out.onlyInServiceTotal = onlyInService
  out.onlyInDescDirect = deltaDirect.slice(0, DESC_AUDIT_LIMIT)

  // 抽样判 turn：直接子代优先；只判到上限，剩下的如实记在 deltaTotal 里（供判断抽样是否足够）
  const probe = deltaDirect.concat(deltaDeeper).slice(0, DESC_DELTA_LIMIT)
  out.deltaTotal = deltaDirect.length + deltaDeeper.length
  for (const it of probe) {
    const stRes = await turnStateOf(it.id, { index, sessionQuery, timeoutMs })
    out.deltaChecked++
    if (stRes.ok && stRes.state && stRes.state.unfinished) {
      out.deltaOpenTotal++
      if (out.deltaOpen.length < DESC_AUDIT_LIMIT) {
        out.deltaOpen.push({
          id: it.id, depth: it.depth, diag: it.diag,
          kind: stRes.state.kind, turn: stRes.state.turn == null ? null : stRes.state.turn,
        })
      }
    }
  }
  return out
}

/**
 * 取一个会话名下的**子会话条目**列表（两条来源互为兜底，任一条可用即可）：
 *   1. 内核原生 `subagents.listChildren(parentId)`（**首选**，返回值带 mode/label）；
 *   2. `headerChildren`（一级预筛**从 header 派生**的 `父id → 子id[]`）—— 父子关系本来就持久化在 header，
 *      且"子会话是否未闭合"无论如何都要读子会话自己的日志 ⇒ 这条路径**完全不依赖任何服务**。
 * 两条都不可用 ⇒ `childSource:'none'`（调用方按"判定不可进行"处理并如实记审计）。
 *
 * ⚠️ **为什么抽成函数**：P1（父已闭合）与 P0+在飞委派（父未闭合）**都要枚举子会话**。
 *    两份实现迟早漂移 —— 本项目已经吃过"同一判据两处实现"的亏。
 */
async function resolveChildren({ subagents, sessionId, headerChildren, subagentAvailable, signal, stats, skipped, layer }) {
  let children = null
  let childSource = null
  let serviceChildrenCount = null
  let childListError = null
  if (subagentAvailable) {
    try {
      const r = await withTimeout(subagents.listChildren(sessionId, signal), READ_TIMEOUT_MS, null)
      if (Array.isArray(r)) { children = r; childSource = 'service'; serviceChildrenCount = r.length }
      else childListError = (r === null ? 'listChildren 超时/无返回' : 'listChildren 返回非数组')
    } catch (e) {
      stats.childListFailed++
      childListError = 'listChildren 抛错: ' + errMsg(e)
    }
  }
  if (childSource === null) {
    if (headerChildren === null) return { children: null, childSource: 'none', serviceChildrenCount, childListError }
    children = headerChildren
    childSource = 'headers'
  }
  if (childListError) {
    skipped.push({
      sessionId, layer,
      reason: childListError + '，改用 header 兜底' + (childSource === 'headers' ? '' : '（未生效）'),
    })
  }
  return { children, childSource, serviceChildrenCount, childListError }
}

/**
 * 从子会话条目里挑出**未闭合**的那些（末态判定同样"尾帧优先、全量兜底"，U10）。
 * ⚠️ **只看子会话自己的末态**，不看 `activity`（重启后一律 inactive，判不了"在途"，见文件头硬禁止 2）。
 * ⚠️ 与 `resolveChildren` 一样，抽出来是为了让 P1 与 P0+在飞委派**共用一份实现**。
 */
async function openChildrenOf({ children, index, sessionQuery, readTimeoutMs, stats, childStateSources, parentId, skipped }) {
  const openChildren = []
  let childrenChecked = 0
  for (const ch of children) {
    const ref = childRef(ch) // 服务返回 `{id, mode, label}`；header 兜底给的是裸 id 字符串
    if (!ref) continue
    childrenChecked++
    const stRes = await turnStateOf(ref.id, { index, sessionQuery, timeoutMs: readTimeoutMs })
    if (stRes.fullReadSkipped) {
      // T1-2：主动没读 ⇒ 既不进 tailJudged 也不进 fallbackReads/childStateSources
      stats.fullReadSkipped++
    } else if (stRes.source === 'tail') { stats.tailJudged++; childStateSources.tail++ }
    else { stats.fallbackReads++; childStateSources.read++ }
    if (stRes.tailFailed) stats.tailJudgeFailed++
    if (!stRes.ok) {
      stats.childReadFailed++
      skipped.push({
        sessionId: parentId,
        reason: stRes.fullReadSkipped
          ? '子会话末态判不了且已禁用全量回退（T1-2：不再调用 sessionQuery.readSession），按未判定处理'
          : '子会话日志读取失败，按未判定处理',
        childId: ref.id, error: stRes.error,
      })
      continue
    }
    const st = stRes.state
    if (st.unfinished) openChildren.push({ id: ref.id, turn: st.turn, kind: st.kind, mode: ref.mode })
  }
  return { openChildren, childrenChecked }
}

/**
 * 二级判定：**只对一级预筛的幸存者**读完整日志，按 D6 分层产出候选。
 *
 * | 层 | 判据 | 唤醒目标 |
 * |---|---|---|
 * | P1 | 会话**自身末态已闭合**（closed/none），但**名下存在未闭合子会话** | **父会话**（就是它自己） |
 * | P0 + 在飞委派 | 会话自身末态**未闭合**，**且**名下存在未闭合子会话（`delegationInFlight:true`） | 它自己 |
 * | P0 | 会话自身末态**未闭合**，名下**没有**未闭合子会话 | 它自己（默认只记审计） |
 *
 * 前两层是**"明确有活没干完"的两种形态**：P1 对应**后台委派**（父派完 job 就结束了 turn），
 * P0+在飞委派对应**前台委派**（主对话正等着子代理时被重启掐断，turn 自然没闭合）。
 *
 * P1 枚举子会话有**两条来源**（互为兜底，任一条可用即可）：
 *   1. 内核原生 `subagents.listChildren(parentId, signal)`（**首选**，返回值里带 mode/label）；
 *   2. `childrenByParent`（一级预筛**从 header 派生**的 `父id → 子id[]`，见 prescanSessions）——
 *      父子关系本来就持久化在 header 上，且"子会话是否未闭合"无论如何都要读子会话自己的日志，
 *      所以这条路径**完全不依赖 subagents 服务**。
 * 两条都拿不到才跳过该会话的 P1 判定（P0 **不受影响**）。
 * 子会话是否未闭合仍需读该子会话自己的日志末尾——listChildren **没有** turn 状态字段。
 *
 * 另有**第三条来源 `listDescendants`，但只做对照审计（P3-U11-DESC），不参与判据**：
 * 见 `descendantsCompare` 的注释（为什么先审计再决定、为什么不当场升级）。
 *
 * P2（active goal）/ P3（外部插件注册信号）本轮不实现，接入位置见下方 TODO 与 index.js。
 *
 * **逐条判定明细**（`details`，每个幸存者一条）：本函数是纯数据函数、**不持审计通道**，
 * 故明细随返回值交出去，由 index.js 统一 emit 成 `resume.judge`。字段：
 * `sessionId` / `ownKind`（open|interrupted|closed|none）/ `ownTurn` /
 * `ownStateSource`（`tail` | `read`：**自身末态是尾帧判的还是回退读全量的**，U10）/
 * `childStateSources`（`{tail, read}`：子会话末态的取法计数，U10）/
 * `path`（`p0` | `p1-eval` | `skipped-no-child-source` | `skipped-read-failed`）；
 * 走 `p1-eval` 时另带 `childSource` / `childrenRawCount`（本条来源返回的原始条数）/
 * `serviceChildrenCount`（`listChildren` 返回条数，未调用/超时/抛错 → null）/
 * `headerChildrenCount` / `childrenRawSample`（**前 3 条**的形态摘要，有界）/
 * `childrenChecked` / `openChildren`（未闭合子会话 `[{id, ownKind, turn}]`，**截断到 10 条**）/
 * `openChildrenTotal` / `verdict`（`p1-candidate` | `no-open-children` | `empty-children` | `children-unusable`）。
 * 另有**交叉校验标记** `childSourceDisagreement`（服务返回空数组、而 header 派生非空 ⇒ 见下），
 * 调用方据此 emit WARN —— ⚠️ 它**只用于告警，不改变判据**：仍以服务返回为准。
 *
 * 走 `p1-eval` 时还带 `desc`（**P3-U11-DESC 对照审计**，见 `descendantsCompare`）：
 * `source`（`ok` | `unavailable` | `failed`）/ `error` /
 * `rawCount` / `childCount` / `diagnosticCount` / `maxDepth` / `directCount`（`depth===1`）/
 * `onlyInDescDirect` + `onlyInDescDirectTotal`（**真正值得关注的"漏了直接子代"**）/
 * `onlyInDescDeeperTotal`（孙代等更深层，属**新增覆盖**而非漏报）/
 * `onlyInServiceTotal`（descendants 没给出而 listChildren 给了，反向差异）/
 * `deltaChecked` + `deltaOpen` + `deltaOpenTotal`（对差异项**抽样**判 turn，看有没有"未被枚举到的未闭合子会话"）。
 * ⚠️ `desc` **绝不参与判据**：`children` / `openChildren` / `candidates` 一个字都不因它改变。
 *
 * @param {object} opts
 * @param {Map} [opts.childrenByParent] prescanSessions 派生的运行期结构（**不进审计**）
 * @param {Map<string,string>} [opts.index] 会话文件索引（U10，由调用方与 prescanSessions 共用同一份）：
 *   有它 ⇒ 末态判定走**尾帧**（只读尾窗几 KB~2MB）；没有/拿不到 ⇒ 回退读全量日志（语义完全不变）
 * @returns {{ subagentAvailable:boolean, candidates:Array, skipped:Array, details:Array, stats:object }}
 */
export async function judgeCandidates({ ctx, survivors, childrenByParent = null, index = null, now = Date.now, signal, readTimeoutMs = READ_TIMEOUT_MS } = {}) {
  const sessionQuery = getService(ctx, 'sessionQuery')
  // ⚠️ 服务名是**复数** `subagents`（内核 `@deepseek-ai/dsh-subagent` 里注册的是 `super(ctx, "subagents")`）。
  // 真机实测教训：写成单数 `subagent` 时 `ctx.get` 恒为 null ⇒ **P1 整层静默跳过**，
  // 而 P1 恰恰是"父对话已闭合、子代理被掐断"（8 个真实会话）唯一的求助通道 —— 而且在审计里只留一条
  // WARN，从字面完全看不出是"名字写错"。故这里复数优先、单数兜底（对内核版本漂移留余量）。
  const subagents = getService(ctx, 'subagents') || getService(ctx, 'subagent')
  const subagentAvailable = !!(subagents && typeof subagents.listChildren === 'function')
  const list = Array.isArray(survivors) ? survivors : []
  // 兜底来源是否"存在"（Map 为空 = 真机上没有任何子会话 header ⇒ 也等于没有兜底可言）
  const headerChildrenAvailable = !!(childrenByParent && typeof childrenByParent.get === 'function'
    && (typeof childrenByParent.size !== 'number' || childrenByParent.size > 0))
  const skipped = []
  const candidates = []
  // ★逐条判定明细（**不进那条汇总行**）：本函数不持审计通道 ⇒ 明细随返回值出去，由 index.js emit。
  //   真机 12h 窗下"幸存者=1 却 P1=P0=0"，只报条数时分不出"这个幸存者本该命中 P1 但子枚举返回空"
  //   还是"它本来就没子会话" —— 每幸存者一条明细正是为了分清这两种情况。
  const details = []
  const stats = {
    survivors: list.length, p1: 0, p0: 0, p0InFlight: 0, readFailed: 0, childReadFailed: 0, childListFailed: 0,
    subagentAvailable, headerChildrenAvailable,
    // 实际用到的子会话枚举来源：'service'（首选）/ 'headers'（header 兜底）/ 'none'（两条都没用上）
    childSource: 'none',
    // ★U10：末态取法分布（**只是计数**，不进明细、不许爆量）。
    //   tailJudged     = 末态由**尾帧**判出（父自身 + 子会话合计；**只算成功**）
    //   fallbackReads  = **发起**回退读全量日志的次数（父自身 + 子会话合计；T1-2 关掉回退后恒为 0）
    //   tailJudgeFailed= 尾帧判不了而回退的次数（无索引项 / 窗口内没有 turn 边界）
    //   fullReadSkipped= T1-2：尾帧判不了**且按新策略跳过了全量读**的次数（= 本轮"漏判"数；
    //                    与 fallbackReads 互补：两者相加 = tailJudgeFailed 里"还能救但没读"那部分）
    //   maxTail        = 当前尾窗上限（字节），便于按真机数据调参
    tailJudged: 0, fallbackReads: 0, tailJudgeFailed: 0, fullReadSkipped: 0, maxTail: DEFAULT_MAX_TAIL_TAIL,
    // ★P3-U11-DESC：对照审计的**汇总计数**（只有标量；`descMissed` > 0 才值得考虑升级枚举路径）。
    //   `descAvailable=false` 表示宿主没有 `listDescendants` —— 属**可选能力缺失**，不是缺口
    //   （与 compat.js 里 `subagents.listDescendants` 标 informational 一致）。
    descAvailable: !!(subagents && typeof subagents.listDescendants === 'function'),
    descCompared: 0, descFailed: 0, descMissed: 0, descDeltaChecked: 0, descDeltaOpen: 0,
  }
  const markChildSource = (src) => {
    if (src === 'service') stats.childSource = 'service'
    else if (src === 'headers' && stats.childSource !== 'service') stats.childSource = 'headers'
  }

  for (const s of list) {
    // 每个幸存者一条明细；下面各分支只填"实际走的路径"与判据事实，**不改任何判据**
    const detail = { sessionId: s.sessionId, ownKind: null, ownTurn: null, ownStateSource: null, path: null, layer: null }
    // 子会话末态的取法分布（U10 审计）：只有两个计数，与 childrenChecked 一样是**有界标量**
    const childStateSources = { tail: 0, read: 0 }
    detail.childStateSources = childStateSources
    details.push(detail)

    // ---- 自身末态：只走尾帧（T1-2；判不了不救，见 turnStateOf）----
    const ownRes = await turnStateOf(s.sessionId, { index, sessionQuery, timeoutMs: readTimeoutMs })
    detail.ownStateSource = ownRes.source
    if (ownRes.fullReadSkipped) {
      // T1-2：这一轮**主动没读** ⇒ 既不算 tailJudged（没判出来）也不算 fallbackReads（没读）
      stats.fullReadSkipped++
    } else if (ownRes.source === 'tail') stats.tailJudged++
    else stats.fallbackReads++
    if (ownRes.tailFailed) stats.tailJudgeFailed++
    if (!ownRes.ok) {
      // 判不了 ⇒ **保持原语义**：按"读失败"处理（绝不改成"当作已闭合"）
      stats.readFailed++
      detail.path = 'skipped-read-failed'
      detail.error = ownRes.error
      if (ownRes.fullReadSkipped) detail.fullReadSkipped = true
      skipped.push({
        sessionId: s.sessionId,
        reason: ownRes.fullReadSkipped
          ? '末态判不了且已禁用全量回退（T1-2：不再调用 sessionQuery.readSession）⇒ 跳过（不唤醒）'
          : '末态判不了且回退读全量也失败（sessionQuery.readSession 报错）⇒ 跳过',
        error: ownRes.error,
      })
      continue
    }
    const own = ownRes.state
    detail.ownKind = own.kind
    detail.ownTurn = own.turn == null ? null : own.turn

    // 子会话条目来源之一：header 派生的 `父id → 子id[]`（**P0 与 P1 都要用**，故提前取）
    //
    // ⚠️ `null` 与 `[]` 是**两件事**，别混淆（2026-09-22 修）：
    //   · `null` = **兜底来源整体不可用**（索引里连一条 subagent header 都没有）⇒ 判不了，走 'none'
    //   · `[]`   = 兜底来源可用，只是**这个会话名下没有子会话** ⇒ 合法的"零子代"
    //   直接用 `childrenByParent.get(id) || []` 会把"空 Map"退化成 `[]`，
    //   从而把一个**不可判**的会话伪装成"零子代"（P1 会走 empty-children，P0 会静默变成纯 P0）。
    const headerChildren = (headerChildrenAvailable && childrenByParent && typeof childrenByParent.get === 'function')
      ? (childrenByParent.get(String(s.sessionId)) || [])
      : null

    // ---- P0：自身未闭合（open / interrupted）----
    if (own.unfinished) {
      // ★前台委派被掐断（2026-09-22 新增）：自身未闭合 **且名下有未闭合子会话** ⇒ 与 P1 同级唤醒。
      //   为什么必须补这一层：前台委派（主对话**正等着**子代理）被重启掐断时，父会话的 turn
      //   **不会闭合**（它还在等），于是只落 P0；而 `scope: tasks-only` 默认不唤醒 P0
      //   ⇒ **这类会话永远不会被恢复** —— 而它恰恰是用户最初提出的那个场景。
      //   真数据里 P1 命中的 8 例父会话**全是 closed**：那是**后台委派**（父派完 job 就结束 turn）的形态，
      //   前台形态此前**完全没有覆盖**。
      //   ⚠️ `lastTurnState` 判不出"父在等子"与"父在生成"的差别，故用"名下有未闭合子会话"作**代理判据**。
      const resolved0 = await resolveChildren({
        subagents, sessionId: s.sessionId, headerChildren, subagentAvailable, signal, stats, skipped, layer: LAYER.P0,
      })
      let openChildren = []
      if (resolved0.children) {
        const r0 = await openChildrenOf({
          children: resolved0.children, index, sessionQuery, readTimeoutMs, stats, childStateSources,
          parentId: s.sessionId, skipped,
        })
        openChildren = r0.openChildren
        detail.childrenChecked = r0.childrenChecked
        detail.childrenRawCount = resolved0.children.length
        detail.serviceChildrenCount = resolved0.serviceChildrenCount
        detail.childSource = resolved0.childSource
        if (resolved0.childSource !== 'none') markChildSource(resolved0.childSource)
      } else {
        // 两条来源都不可用 ⇒ **"是不是前台委派"判不了**。保守取纯 P0（不猜、不唤醒），
        // 但必须留痕：否则"该唤醒的没唤醒"会是**静默**的（本仓最忌讳的那种漏）。
        detail.childSource = 'none'
        detail.childrenChecked = 0
        detail.childrenRawCount = null
        detail.serviceChildrenCount = resolved0.serviceChildrenCount
        skipped.push({
          sessionId: s.sessionId, layer: LAYER.P0,
          reason: 'P0 的「是否有在飞委派」判不了（subagents 服务与 header 兜底两条来源都不可用）'
            + '⇒ 按纯 P0 处理（scope=tasks-only 下不唤醒），可能漏掉前台委派被掐断的会话',
        })
      }
      const inFlight = openChildren.length > 0
      detail.path = inFlight ? 'p0-with-delegation' : 'p0'
      detail.layer = LAYER.P0
      detail.delegationInFlight = inFlight
      detail.openChildrenTotal = openChildren.length
      detail.openChildren = openChildren.slice(0, OPEN_CHILDREN_AUDIT_LIMIT)
        .map((c) => ({ id: c.id, ownKind: c.kind, turn: c.turn == null ? null : c.turn }))
      if (inFlight) stats.p0InFlight++
      else stats.p0++
      candidates.push({
        sessionId: s.sessionId, layer: LAYER.P0,
        // 在飞委派时 primary 取 SUBAGENT ⇒ 幂等键自动走 `sub:<parent>:<child>[:t<n>]`
        // （每个"被掐断的子"各记一条；否则同一父会话日后再被掐断会被判"已处理"而**静默不恢复**）
        primary: inFlight ? SIGNAL.SUBAGENT : SIGNAL.TURN,
        signals: inFlight ? [SIGNAL.SUBAGENT, SIGNAL.TURN] : [SIGNAL.TURN],
        turn: own.turn, reasonKind: own.reasonKind, ownKind: own.kind,
        delegationInFlight: inFlight,
        childId: inFlight ? openChildren[0].id : null,
        openChildren: inFlight ? openChildren : [],
        childSource: resolved0.childSource,
        lastActiveAt: s.lastActiveAt, lastActiveSource: s.lastActiveSource,
      })
      continue
    }

    // ---- P1：自身已闭合，但名下有未闭合子会话 ⇒ 唤醒**父会话** ----
    const resolved = await resolveChildren({
      subagents, sessionId: s.sessionId, headerChildren, subagentAvailable, signal, stats, skipped, layer: LAYER.P1,
    })
    if (resolved.children === null) {
      // 两条路径都不可用 ⇒ 跳过该会话的 P1（P0 在上面已单独处理，不受影响）；明细里如实记"判定不可进行"
      detail.path = 'skipped-no-child-source'
      detail.childSource = 'none'
      detail.verdict = 'children-unusable'
      detail.childrenRawCount = null
      detail.serviceChildrenCount = resolved.serviceChildrenCount
      detail.headerChildrenCount = null
      detail.childrenRawSample = []
      detail.childrenChecked = 0
      detail.openChildrenTotal = 0
      detail.openChildren = []
      continue
    }
    const children = resolved.children
    const childSource = resolved.childSource
    const serviceChildrenCount = resolved.serviceChildrenCount
    markChildSource(childSource)

    const headerChildrenCount = headerChildren === null ? null : headerChildren.length
    detail.path = 'p1-eval'
    detail.childSource = childSource
    detail.childrenRawCount = children.length
    detail.serviceChildrenCount = serviceChildrenCount
    detail.headerChildrenCount = headerChildrenCount
    detail.childrenRawSample = children.slice(0, CHILD_SAMPLE_LIMIT).map(childShapeSample)
    // ★对照审计（P3-U11-DESC）：再用内核原生的 `listDescendants` 枚举一次整棵后代树，与本次实际
    //   使用的来源做差异对照。**只读、只写审计，绝不参与判据**（放在 `!children.length` 的提前
    //   continue **之前** —— "listChildren 返回空、后代树却非空"恰恰是最值得看的那个场景）。
    detail.desc = await descendantsCompare({
      subagents, sessionId: s.sessionId, children, index, sessionQuery, signal, timeoutMs: readTimeoutMs,
    })
    // 汇总计数（只有标量）：`descMissed` 是"要不要把枚举路径换成 listDescendants"的唯一依据
    if (detail.desc.source === 'ok') {
      stats.descCompared++
      stats.descDeltaChecked += detail.desc.deltaChecked
      stats.descDeltaOpen += detail.desc.deltaOpenTotal
      if (detail.desc.onlyInDescDirectTotal > 0 || detail.desc.deltaOpenTotal > 0) stats.descMissed++
    } else if (detail.desc.source === 'failed') {
      stats.descFailed++
    }
    // ★交叉校验（**只告警，不改变判据**）：服务说"没有子会话"，header 却说"有一堆"。
    //   真机就是靠这条分辨"P1=0 是正确行为"还是"listChildren 返回空数组导致 P1 失灵"
    //   （childListFailed=0 + childReadFailed=0 与"返回空数组"的现象完全一致，只报条数分不开）。
    //   ⚠️ 这里**不**因为发现分歧就改用 header 兜底：仍以服务返回为准（childSource='service'），
    //      悄悄换来源是更坏的做法；本字段只供调用方 emit WARN，让人一眼看见分歧。
    if (childSource === 'service' && children.length === 0 && headerChildrenCount !== null && headerChildrenCount > 0) {
      detail.childSourceDisagreement = {
        reason: 'child-source-disagreement',
        childSource: childSource,
        serviceChildrenCount: 0,
        headerChildrenCount: headerChildrenCount,
      }
    }
    if (!children.length) {
      detail.verdict = 'empty-children'
      detail.childrenChecked = 0
      detail.openChildrenTotal = 0
      detail.openChildren = []
      continue
    }

    // 子会话末态：与 P0+在飞委派**共用同一份实现**（尾帧优先、全量兜底，U10）
    const oc = await openChildrenOf({
      children, index, sessionQuery, readTimeoutMs, stats, childStateSources, parentId: s.sessionId, skipped,
    })
    const openChildren = oc.openChildren
    const childrenChecked = oc.childrenChecked
    detail.childrenChecked = childrenChecked
    detail.openChildrenTotal = openChildren.length
    // 明细里的 openChildren 只带 {id, ownKind, turn} 并**截断到 10 条**（子会话可能上百个）
    detail.openChildren = openChildren.slice(0, OPEN_CHILDREN_AUDIT_LIMIT)
      .map((c) => ({ id: c.id, ownKind: c.kind, turn: c.turn == null ? null : c.turn }))
    if (!openChildren.length) {
      // childrenChecked=0 = 一条都没读成（条目全不可归一化 / 全读失败）⇒ 判定事实不成立，如实标 unusable
      detail.verdict = childrenChecked === 0 ? 'children-unusable' : 'no-open-children'
      continue
    }

    stats.p1++
    detail.verdict = 'p1-candidate'
    detail.layer = LAYER.P1
    detail.delegationInFlight = false   // P1 的定义就是"父已闭合"，与 P0+在飞委派互斥
    candidates.push({
      sessionId: s.sessionId, layer: LAYER.P1, primary: SIGNAL.SUBAGENT, signals: [SIGNAL.SUBAGENT],
      delegationInFlight: false,        // 唤醒策略与 P0+在飞委派不同（见 selectByLayer），显式带上避免"缺字段"歧义
      childId: openChildren[0].id, openChildren, turn: openChildren[0].turn, ownKind: own.kind,
      childSource, lastActiveAt: s.lastActiveAt, lastActiveSource: s.lastActiveSource,
    })
  }

  // ⚠️ P1 与 "P0+在飞委派" 必须排在纯 P0 之前：前两者是"看着已收工、实则没干完"；
  // 先跑纯 P0 会把它当"已完成的会话"放过，且在 maxResumePerBoot 截断时先丢真正重要的那些。
  candidates.sort(byLayerThenRecency)

  // TODO(P2 扩展点 · 本轮不实现)：在此处追加"存在 GoalPhase==='active' 的 goal"的会话，
  //   layer='P2'、唤醒目标=它自己。接入位置：本函数 `return` 之前（读 ctx.get('goals') 或对应服务），
  //   并在 index.js 的候选清单里带上 layer —— 不要改 P0/P1 的判据。
  // TODO(P3 扩展点 · 本轮不实现)：外部插件（taskkit 等）经 adapter 注册的待办信号，
  //   layer='P3'、唤醒目标=注册方指定。接入位置：index.js 的 `registerSignalProvider`（见该文件 TODO）。

  return { subagentAvailable, candidates, skipped, details, stats }
}

/**
 * 分层选择（D4 + D6 + §2D D5 的 scope 语义；2026-09-22 扩展"P0+在飞委派"）。
 *
 * 判据的本质是**"名下有未闭合子会话" = 明确有活没干完**，而不是"父的 turn 闭没闭合"：
 *   · `P1`            —— 父已闭合 + 子未闭合（**后台委派**形态：父派完 job 就结束了 turn）
 *   · `P0+在飞委派`   —— 父**未**闭合 + 子未闭合（**前台委派**形态：主对话正等着子代理时被重启掐断）
 *   · 纯 `P0`         —— 父未闭合、名下没有未闭合子会话 ⇒ "可能只是半句话被打断"
 *
 * **`scope: 'tasks-only'`（默认）= P1 + P0+在飞委派**：
 *   前两类都是"明确有活没干完"，必须唤醒。
 *   纯 P0 在真数据上命中 56%（236/419），噪声大于收益，默认只记 skip ——
 *   理由是"重启后突然在一个只有半句话的会话里继续生成内容，对用户是惊吓而不是帮助"。
 * **`scope: 'all'`：三类都唤醒**（真机夹具 A5 就是靠这一支才验得出唤醒链）。
 *
 * ⚠️ 2026-09-22 之前这里**只放行 P1**，于是前台委派被掐断的会话（落 P0）**永远不会被恢复** ——
 *    而"主对话正在等子代理时被重启"恰恰是用户最初提出的关切。补这一条就是为了堵它。
 *
 * @returns {{ resume:Array, skip:Array }}
 */
export function selectByLayer(candidates, { scope = 'tasks-only', maxResume = Infinity } = {}) {
  const ordered = [...(Array.isArray(candidates) ? candidates : [])].sort(byLayerThenRecency)
  const resume = []
  const skip = []
  for (const c of ordered) {
    if (c.layer !== LAYER.P1 && c.layer !== LAYER.P0) {
      skip.push({ ...c, reason: 'layer ' + c.layer + ' 本轮未实现（P2/P3 仅为扩展点）' })
      continue
    }
    // 纯 P0（父未闭合 + 名下无未闭合子会话）在 tasks-only 下不唤醒；
    // "P0+在飞委派"与之**同层不同命**，必须放行（否则前台委派被掐断的会话永远不恢复）。
    if (c.layer === LAYER.P0 && !c.delegationInFlight && scope !== 'all') {
      skip.push({
        ...c,
        reason: 'scope=tasks-only：只唤醒 P1 与「P0+在飞委派」；纯 P0（自身未闭合、名下无未闭合子会话）只记审计',
      })
      continue
    }
    if (resume.length >= maxResume) {
      skip.push({ ...c, reason: '超出 maxResumePerBoot 上限（默认 5，防重启风暴）' })
      continue
    }
    resume.push(c)
  }
  return { resume, skip }
}
