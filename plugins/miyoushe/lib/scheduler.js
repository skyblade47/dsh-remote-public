// @local/miyoushe —— 调度器（设计 §5；**纯逻辑 + 可注入时钟**，state 只经 adapterFs）
//
// 设计锚点（**章节号 + grep 模式**，不写行号——设计文档自指行号已漂移）：
//   §5.1 时间模型     锚：grep 模式 `tickMs. \| .60000`、`dailyJitterMs`、`accountGapMs`、`maxAttemptsPerDay`、`backoffMs`
//   §5.2 当日去重键   锚：grep 模式 `dedupeKey = `
//   §5.3 启动补偿     锚：grep 模式 `启动补偿（补偿 ≠ 无条件补签）`
//   §5.4 退避与日志   锚：grep 模式 `失败退避与日志字段`
//   §5.5 并发/重入    锚：grep 模式 `并发 / 重入保护`
//
// 纪律：
//   1) **零网络**：本模块**不**发起任何请求；"提交一次签到"由 `deps.execute(任务)` 注入（测试注入假实现）。
//   2) **纯逻辑可注入时钟**：`deps.clock.now()`（默认 `Date.now`）；抖动用**确定性散列**（同一 key+日期恒等，
//      测试可复跑；不依赖 `Math.random`）。
//   3) `state.json` **只经 adapterFs**（经 `lib/store.js` 的 `store.readState/writeState`），本模块不碰 fs。
//   4) 单飞锁：进程内 `running` 标志 + 跨重载 `state.lock={owner,startedAt,ttlMs}`（TTL 10min 可接管，§5.5）。

export const TARGETS = Object.freeze(['hk4e', 'hkrpg', 'zzz', 'bh3', 'bbs'])

/** §5.2 可判定状态集（终态＝不再重试） */
export const OUTCOMES = Object.freeze(['pending', 'running', 'signed', 'already', 'failed', 'human_required', 'skipped_window', 'skipped_disabled'])
export const TERMINAL_OUTCOMES = Object.freeze(['signed', 'already', 'human_required', 'failed', 'skipped_window', 'skipped_disabled'])

/**
 * §5.1 默认值（与 store.js 的 SETTINGS_DEFAULTS 对齐；此处独立导出便于纯函数测试）。
 *
 * ⚠️ **t39 有意不把「分散时刻」三项放进这里**：`planTick` 会把 `DEFAULTS` 与用户 settings **浅合并**，
 * 一旦这里带上 `schedule.spreadMinGapMs`，那么**任何旧部署**（settings.json 没有这三项）都会突然被启用分散
 * ⇒ 一次性全签退化为"一天只签 1 条"，且旧测试的意义被静默改变。故三项的**缺省值只在写入路径（config 校验）**
 * 与**文档**里给出（见 `SPREAD_DEFAULTS` / `index.js` 的 `validateSchedulePatch`），
 * 运行期读侧一律**只看用户是否真的配了**：未配 ⇒ 最小间隔 0、抖动 [0,0] ⇒ **不启用分散，行为与本切片之前逐字一致**。
 *
 * t39 新增三类设置（用户新要求：四个主号分散、带随机空间，模拟正常人请求；**放在 `settings.schedule` 下**）：
 *   - `schedule.spreadMinGapMs` 默认 **600000**（10 分钟）：相邻组合的**最小**间隔；
 *   - `schedule.spreadJitterMs` 默认 **[30000, 120000]**（30 秒–2 分钟）：最小间隔之上叠加的**区间抖动**
 *     ⇒ 相邻**实际间隔 10–12 分钟**；
 *   - `schedule.targets` 默认 `[]`（空 = 全部组合）：目标组合白名单，元素 `"<gameKey>:<region>"`（如 `"hk4e:cn_gf01"`）。
 */
import { maskText } from './mask.js'   // t82/P0：提交日志的 messageMasked 复用**既有**权威掩码器（不自造一份，避免权威分裂）

export const DEFAULTS = Object.freeze({
  tickMs: 60000,
  windowStart: '08:00',
  windowEnd: '23:30',
  dailyJitterMs: 15 * 60 * 1000,
  accountGapMs: [5000, 25000],
  maxAttemptsPerDay: 3,
  backoffMs: [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000],
  bbsEnabled: true,
  allowLateSign: false,
})

/** t39 分散时刻的**缺省值**（供 config 写入路径与文档；运行期不隐式套用，见上方 ⚠️） */
export const SPREAD_DEFAULTS = Object.freeze({
  spreadMinGapMs: 600000,
  spreadJitterMs: Object.freeze([30000, 120000]),
  targets: Object.freeze([]),
})

/** 区间数组缺省值（非法/缺省时回落到此；与 `accountGapMs`/`backoffMs` 的区间写法一致） */
export const SPREAD_JITTER_DEFAULT = Object.freeze([30000, 120000])

/**
 * 补丁②（2026-08-30「开机即签」）：集群**起点**在 `max(窗口起点, 当天首次 tick)` 之上叠加的**小抖动**上界。
 * 量级定为 **0–2 分钟**：与既有 `spreadJitterMs` 上界同阶（不引入新的时间尺度），且把「首槽 → 末槽」
 * 的整簇控制在开机后约 30–38 分钟内（间隔 10–12 分钟 × 3 段不可压），再大就会挤到窗口末端触发左移降级。
 */
export const ANCHOR_JITTER_MS = 120000

export const LOCK_TTL_MS = 10 * 60 * 1000 // §5.5：跨重载锁 TTL，过期自动接管

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地日期 `yyyy-mm-dd`（注入 ms ⇒ 可复跑；与 store.localDate 同口径） */
export function localDateOf(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** `'08:00'` → 分钟数；非法 ⇒ null */
export function hmToMinutes(hm) {
  if (typeof hm !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

/** 当日零点起的分钟数（**本地时区**） */
export function minutesOfDay(ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** 是否在每日窗口内（含端点；窗口跨零点时按 `start > end` 处理为跨日窗口） */
export function inWindow(ms, windowStart, windowEnd) {
  const s = hmToMinutes(windowStart)
  const e = hmToMinutes(windowEnd)
  if (s === null || e === null) return false
  const cur = minutesOfDay(ms)
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e // 跨零点
}

/** 下一次窗口起点的时间戳（若当前在窗口内 ⇒ 返回当前 ms 对齐到"现在"） */
export function nextWindowStart(ms, windowStart) {
  const s = hmToMinutes(windowStart)
  if (s === null) return null
  const d = new Date(ms)
  if (minutesOfDay(ms) < s) {
    d.setHours(Math.floor(s / 60), s % 60, 0, 0)
    return d.getTime()
  }
  const t = new Date(ms)
  t.setDate(t.getDate() + 1)
  t.setHours(Math.floor(s / 60), s % 60, 0, 0)
  return t.getTime()
}

/** 确定性抖动（§5.1：窗口内首次尝试时刻抖动）——同一 (key, 日期) 恒等，范围 `[0, jitterMs)` */
export function jitterFor(key, dateLocal, jitterMs) {
  const span = Number.isFinite(jitterMs) && jitterMs > 0 ? Math.floor(jitterMs) : 0
  if (span === 0) return 0
  let h = 2166136261 // FNV-1a
  const s = String(key) + '@' + String(dateLocal)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % span
}

/**
 * §5.2 当日去重键。**t39/P10：region 感知**（用户核定的 4 个主号里有 `bh3` 三个区服，
 * 旧口径 `(account, game)` 会把三个区服折叠成**同一个键** ⇒ 真实提交只发 1 次、漏签两个区服）。
 *   - 有 region ⇒ `${accountId}:${target}:${yyyy-mm-dd}:${region}`（4 段）
 *   - 无 region（含 `bbs` 这类无区服目标）⇒ 旧格式 `${accountId}:${target}:${yyyy-mm-dd}`（3 段）
 * ⇒ **未提供 region 的调用方行为逐字不变**（旧键可继续被读；`state.json` 现无 `doneKeys` 历史数据，无迁移问题）。
 */
export function dedupeKey(accountId, target, dateLocal, region) {
  const base = String(accountId) + ':' + String(target) + ':' + String(dateLocal)
  const r = region === undefined || region === null ? '' : String(region).trim()
  return r === '' ? base : base + ':' + r
}

/** 反解去重键（宽松：3 段＝旧格式（无 region）；4 段＝t39 起带 region；更多段 ⇒ accountId 含冒号，仍可读） */
export function parseDedupeKey(key) {
  const parts = String(key).split(':')
  if (parts.length < 3) return null
  const dateLocal = parts[parts.length - 1]
  const target = parts[parts.length - 2]
  const accountId = parts.slice(0, parts.length - 2).join(':')
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateLocal)) return { accountId, target, dateLocal, region: '' }
  if (parts.length >= 4) {
    const dateLocal4 = parts[parts.length - 2]
    const target4 = parts[parts.length - 3]
    const accountId4 = parts.slice(0, parts.length - 3).join(':')
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateLocal4)) return { accountId: accountId4, target: target4, dateLocal: dateLocal4, region: dateLocal }
  }
  return null
}

/**
 * 读当日记录，**region 键优先、旧 3 段键回退**（t39/P10 兼容读）。
 * 为什么需要：升级为 region 感知键后，若某组合在升级**之前**已留下记录（例如 `human_required`），
 * 只查新键会"看不到它" ⇒ ① `force` 的人工重试语义被绕过、② 终态组合被当成"从未跑过"而重发。
 * ⇒ 新键查不到时回退查同 `(account, target, date)` 的旧键；**新键永远优先**（不混用、不误判）。
 * （实测当前 `state.json` 无 `doneKeys` 历史数据 ⇒ 这是**防御性**兼容，不是必需迁移。）
 */
export function lookupDoneEntry(doneKeys, accountKey, target, dateLocal, region) {
  const dk = doneKeys && typeof doneKeys === 'object' ? doneKeys : {}
  const key = dedupeKey(accountKey, target, dateLocal, region)
  const hit = dk[key]
  if (hit && typeof hit === 'object') return { key, entry: hit, legacy: false }
  const legacyKey = dedupeKey(accountKey, target, dateLocal)
  if (legacyKey !== key) {
    const old = dk[legacyKey]
    if (old && typeof old === 'object') return { key: legacyKey, entry: old, legacy: true }
  }
  return { key, entry: null, legacy: false }
}

/**
 * t50/N1：**legacy 3 段去重键的代码级迁移**（纯函数，不落盘；由调用方在读 state 后就地归一化）。
 *
 * 背景（现场）：t41 起键升为 region 感知 4 段（`acct:game:date:region`），升级**之前**留下的 3 段键
 *   （`acct:game:date`）不会被自动清理 ⇒ 当同一 `(account, game, date)` 既有 4 段成功键、又有 3 段
 *   失败键时，门禁 G3 会报 `doneKeys_conflict`（现场：hk4e 的 legacy `failed/-400005` 与 4 段 `signed/0` 并存）。
 *   该冲突在 t47 是**人工删键**解决的 ⇒ 必须代码化，否则每个老用户都要手工处置。
 *
 * 规则（与合同 N1 逐字对齐）：
 *   - **4 段键**（`a:g:d:r`）且 `status ∈ {signed, already}` ⇒ 同前缀 `a:g:d` 的 **3 段键被移除**（记入 `removed`）；
 *     成功信息**不丢**：保留的正是那条 4 段成功记录（3 段键无 region，是升级前的**同组合**记录）。
 *   - **只有 3 段键**（无对应 4 段成功键）⇒ **原样保留**（不误删、不误判；`lookupDoneEntry` 仍可回退读到它）。
 *   - **`bbs` 例外（关键）**：`bbs` 这类**无区服**目标的**规范键本来就是 3 段**（见 `dedupeKey`）
 *     ⇒ 绝不当作 legacy 处理，永远保留。
 *   - 形状非法的键（段数 <3）一律原样保留（不猜）。
 *
 * @returns `{ doneKeys, removed:[{key,supersededBy,status}], kept:[key], changed:boolean }`
 */
export function migrateLegacyDoneKeys(doneKeys, opts) {
  const o = opts || {}
  const supersedeStatuses = Array.isArray(o.supersedeStatuses) && o.supersedeStatuses.length
    ? o.supersedeStatuses
    : ['signed', 'already']
  const src = doneKeys && typeof doneKeys === 'object' && !Array.isArray(doneKeys) ? doneKeys : {}
  const keys = Object.keys(src)
  // ① 先索引「4 段成功键」：前缀（前 3 段 = a:g:d）→ 该 4 段键
  const winner = {}
  for (const k of keys) {
    const segs = String(k).split(':')
    if (segs.length !== 4) continue
    const v = src[k] && typeof src[k] === 'object' ? src[k] : {}
    if (supersedeStatuses.includes(v.status)) winner[segs.slice(0, 3).join(':')] = k
  }
  // ② 逐键判定
  const out = {}
  const removed = []
  const kept = []
  for (const k of keys) {
    const segs = String(k).split(':')
    const isLegacyShape = segs.length === 3
    const target = segs.length >= 3 ? segs[segs.length - 2] : null // 3 段 ⇒ 中间段即 game
    if (isLegacyShape && target !== 'bbs' && winner[k]) {
      const v = src[k] && typeof src[k] === 'object' ? src[k] : {}
      removed.push({ key: k, supersededBy: winner[k], status: v.status === undefined ? null : String(v.status) })
      continue
    }
    out[k] = src[k]
    kept.push(k)
  }
  return { doneKeys: out, removed, kept, changed: removed.length > 0 }
}

/** §5.4 退避：第 n 次失败后的等待（有上限，不无限重试） */
export function backoffFor(attempt, backoffMs) {
  const arr = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : DEFAULTS.backoffMs
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(Number(attempt) || 1) - 1))
  const v = Number(arr[i])
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS.backoffMs[0]
}

/** 终态判定（§5.2）：`failed` 仅当当日尝试数达上限时才算终态（否则仍在退避重试窗口内） */
export function isTerminal(entry, opts) {
  if (!entry || typeof entry !== 'object') return false
  const st = entry.status
  if (st === 'failed') {
    const max = Number.isFinite(opts && opts.maxAttemptsPerDay) ? opts.maxAttemptsPerDay : DEFAULTS.maxAttemptsPerDay
    const attempts = Number.isFinite(entry.attempts) ? entry.attempts : 0
    return attempts >= max
  }
  return TERMINAL_OUTCOMES.includes(st)
}

/**
 * 单键决策（**纯函数**）：给定 now / settings / 该键既有记录 ⇒ 今天这一刻该做什么。
 * 返回 `{decision, reason, nextRetryAt}`，decision ∈ run｜done｜expired_window｜jitter_wait｜backoff_wait｜attempts_exhausted|disabled
 */
export function decideOne(opts) {
  const o = opts || {}
  const settings = Object.assign({}, DEFAULTS, o.settings || {})
  const now = o.now
  const entry = o.entry || null
  const attempt = entry && Number.isFinite(entry.attempts) ? entry.attempts : 0
  const windowStart = settings.windowStart
  const windowEnd = settings.windowEnd
  if (o.enabled === false) return { decision: 'disabled', reason: 'skipped_disabled', nextRetryAt: null }
  if (isTerminal(entry, { maxAttemptsPerDay: settings.maxAttemptsPerDay })) {
    return { decision: 'done', reason: entry.status === 'failed' ? 'failed(maxAttempts)' : 'terminal', nextRetryAt: null }
  }
  if (attempt >= settings.maxAttemptsPerDay) return { decision: 'attempts_exhausted', reason: 'failed(maxAttempts)', nextRetryAt: null }
  const jitter = jitterFor(o.dedupeKey || '', o.dateLocal, settings.dailyJitterMs)
  const startMs = new Date(now).setHours(0, 0, 0, 0) + (hmToMinutes(windowStart) || 0) * 60000 + jitter
  if (now < startMs) return { decision: 'jitter_wait', reason: 'jitter_wait', nextRetryAt: startMs }
  if (!inWindow(now, windowStart, windowEnd)) {
    // 已过窗口且未达上限：默认不再补签（§5.3「晚到语义」），仅当 allowLateSign 且从未尝试过 ⇒ 允许一次
    if (settings.allowLateSign === true && attempt === 0) return { decision: 'run', reason: 'late_oneshot', nextRetryAt: null, late: true }
    return { decision: 'expired_window', reason: 'skipped_window', nextRetryAt: null }
  }
  if (attempt >= settings.maxAttemptsPerDay && entry && entry.status === 'failed') {
    return { decision: 'attempts_exhausted', reason: 'failed(maxAttempts)', nextRetryAt: null }
  }
  const retryAt = entry && Number.isFinite(entry.nextRetryAt) ? entry.nextRetryAt : null
  if (retryAt !== null && now < retryAt) return { decision: 'backoff_wait', reason: 'backoff', nextRetryAt: retryAt }
  return { decision: 'run', reason: attempt === 0 ? 'due' : 'retry', nextRetryAt: null }
}

/**
 * tick 计划（**纯函数**，§5.2 判定顺序 + §5.3 补偿语义）：
 * @param opts { now, settings, state, groups:[{accountKey,target}], enabled }
 * @returns { plan:[{dedupeKey,accountKey,target,decision,reason,nextRetryAt,late?}], run:[…], skipped:[…], nextAt, today }
 */
export function planTick(opts) {
  const o = opts || {}
  const settings = Object.assign({}, DEFAULTS, o.settings || {})
  const now = o.now
  const today = o.dateLocal || localDateOf(now)
  const state = o.state && typeof o.state === 'object' ? o.state : {}
  const doneKeys = state.doneKeys && typeof state.doneKeys === 'object' ? state.doneKeys : {}
  const groups = Array.isArray(o.groups) ? o.groups : []
  const plan = []
  // t39：传了当日计划 ⇒ 逐组合**再受计划时刻约束**（未到点 ⇒ spread_wait，不再一次性全签）
  const spread = o.dailyPlan && Array.isArray(o.dailyPlan.items) ? planItemIndex(o.dailyPlan) : null
  for (const g of groups) {
    const target = g && g.target !== undefined ? g.target : g && g.gameKey
    const accountKey = g && g.accountKey
    if (!accountKey || !target) continue
    const region = g && g.region !== undefined && g.region !== null ? String(g.region) : ''
    if (target === 'bbs' && settings.bbsEnabled === false) {
      plan.push({ dedupeKey: dedupeKey(accountKey, target, today, region), accountKey, target, region, comboKey: comboKeyOf(target, region), decision: 'disabled', reason: 'skipped_disabled', nextRetryAt: null })
      continue
    }
    const key = dedupeKey(accountKey, target, today, region)
    // P10 兼容读：新（region）键优先，旧 3 段键回退（见 `lookupDoneEntry` 注释）
    const found = lookupDoneEntry(doneKeys, accountKey, target, today, region)
    const entryNow = found.entry
    // t39：**有当日计划时刻的组合，计划时刻就是权威**（不再叠加旧的 per-key 随机抖动）。
    // 理由（自测抓到的真实交互缺口）：旧抖动是 `jitterFor(key,date,dailyJitterMs)`（默认 15 分钟内随机），
    // 它会把"计划 08:00"的组合再推迟到 08:00+jitter ⇒ ① 实际时刻漂移、② 各组合到达顺序可能被打乱，
    // 与"分散到计划时刻"的目标直接冲突。⇒ 有计划时刻时用 `dailyJitterMs: 0`（**分散本身已提供随机性**）；
    // 无计划（未启用分散）时**逐字保持**旧行为。
    let r = decideOne({ now, settings, entry: entryNow, dedupeKey: key, dateLocal: today, enabled: o.enabled })
    if (spread) {
      const it = spread[planKeyOf(accountKey, target, region)]
      if (it) {
        r = decideOne({ now, settings: Object.assign({}, settings, { dailyJitterMs: 0 }), entry: entryNow, dedupeKey: key, dateLocal: today, enabled: o.enabled })
        const sp = applySpreadToDecision(r, it.at, now)
        if (sp) r = Object.assign({}, r, sp)
      }
      r = Object.assign({}, r, { comboKey: it ? it.comboKey : comboKeyOf(target, region), planAt: it && Number.isFinite(it.at) ? it.at : null })
    }
    r = Object.assign({}, r, { legacyKey: found.legacy === true })
    plan.push(Object.assign({ dedupeKey: key, accountKey, target, region }, r))
  }
  const run = plan.filter((x) => x.decision === 'run')
  const skipped = plan.filter((x) => x.decision !== 'run')
  // 下次"可能真正提交"的时刻：取最早的 nextRetryAt / 抖动起点，否则下一个窗口起点
  const candidates = plan.map((x) => x.nextRetryAt).filter((v) => Number.isFinite(v) && v > now)
  let nextAt = candidates.length ? Math.min.apply(null, candidates) : null
  if (nextAt === null) nextAt = nextWindowStart(now, settings.windowStart)
  return { plan, run, skipped, nextAt, today }
}

// ---------------------------------------------------------------------------
// t39：**按组合的每日随机签到时刻**（用户新要求：四个主号分散、带随机空间，模拟正常人请求）
//
// 语义（与合同 P1–P6 一一对应）：
//   - 第一个目标组合的时刻落在 `[windowStart, windowEnd)` 内**随机**（每天重抽）；
//   - 其后每个组合 ＝ **前一个 ＋ spreadMinGapMs ＋ rand(spreadJitterMs)** ⇒ 相邻实际间隔 **10–12 分钟**；
//   - 计划**按组合**（`gameKey:region`，bbs 组合键为 `bbs`）落 `state.dailyPlan` ⇒ 同日重启不重掷、
//     跨天重掷、可审计（每个组合的时刻都在 state 里看得见）；
//   - 逐组合决策在既有 `decideOne`（终态/退避/窗口/抖动）之上**再加一层** `spread_wait`：
//     未到本组合的计划时刻 ⇒ 不跑（⇒ tick 不再一次性全签，P4）；
//   - 约束不可满足（组合太多 / 窗口太短）⇒ **确定性降级**：压缩到窗口内**等距**分布并标
//     `spreadDegraded:true` + 机器可读原因（P2：不得静默重叠）。
//
// 随机源：`opts.rand` 可注入（测试用固定值复现）；缺省用 `Math.random`。
// ⚠️ **未配置分散设置时（`spreadMinGapMs`/`spreadJitterMs` 均非正、且未传 dailyPlan）行为与本切片之前完全一致**。
// ---------------------------------------------------------------------------

/**
 * `spreadMinGapMs`：非负**整数**有限数 ⇒ 取整；非法/缺省/小数 ⇒ 0（＝不启用分散）。
 * 小数为什么归零而不是取整（`1.5 → 1`）：读侧的角色是"**要么按声明的毫秒数精确执行，要么不做**"。
 *   静默取整会把用户的笔误变成一个**没有人声明的**间隔（`1.5ms` 或 `0`），比直接不启用更难排查；
 *   而"精确执行"又要求值与声明逐字一致——所以小数一律判为"未配置"。写侧的形状校验（拒绝小数）
 *   归属 `lib/index.js` 的 config action（见本文件 §11 边界登记）。
 */
export function spreadMinGapOf(settings) {
  const sc = settings && settings.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}
  const v = sc.spreadMinGapMs
  if (!Number.isFinite(v) || v < 0 || Math.floor(v) !== v) return 0
  return Math.floor(v)
}

/**
 * `spreadJitterMs`：`[lo, hi]`（沿用 `accountGapMs`/`backoffMs` 的区间写法）。
 * **fail-closed 读侧契约**（自测抓到并收紧的一处）：非法/畸形一律归零 `[0, 0]` ⇒ **不启用分散**，
 *   绝不"顺手修正成合法值"——`[120000, 30000]`（区间颠倒）若被静默夹成 `[120000, 120000]`，
 *   等于把一次笔误放大成"每次必然 +2 分钟"，与本功能"最小扰动、模拟正常人"的目标正相反。
 *   缺省/非法 ⇒ `[0, 0]`（＝**不启用**，而非"用 30 秒–2 分钟"；那组缺省值只在写侧声明，见 `SPREAD_DEFAULTS`）。
 */
export function spreadJitterOf(settings) {
  const sc = settings && settings.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}
  const a = sc.spreadJitterMs
  if (!Array.isArray(a) || a.length !== 2) return [0, 0]
  const lo = Number.isFinite(a[0]) ? Math.max(0, Math.floor(a[0])) : NaN
  const hi = Number.isFinite(a[1]) ? Math.max(0, Math.floor(a[1])) : NaN
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [0, 0]
  return [lo, hi]
}

/** 是否启用「按组合分散时刻」（最小间隔或抖动区间任一为正 ⇒ 启用） */
export function spreadEnabledOf(settings) {
  const g = spreadMinGapOf(settings)
  const j = spreadJitterOf(settings)
  return g > 0 || j[1] > 0
}

/** 随机源归一化：注入函数直接用；否则 `Math.random` */
export function randFn(rand) {
  return typeof rand === 'function' ? rand : Math.random
}

/** 区间内随机整数（含端点；`hi <= lo` ⇒ `lo`） */
export function randInRange(lo, hi, rand) {
  const a = Number.isFinite(lo) ? Math.floor(lo) : 0
  const b = Number.isFinite(hi) ? Math.floor(hi) : a
  if (b <= a) return a
  const r = Number(randFn(rand)())
  const clamped = !Number.isFinite(r) ? 0 : (r < 0 ? 0 : (r >= 1 ? 0.9999999999999999 : r))
  return a + Math.floor(clamped * (b - a + 1))
}

export const SPREAD_DEGRADE_REASON = Object.freeze({
  WINDOW_UNUSABLE: 'window_unusable',
  WINDOW_TOO_SHORT: 'window_span_lt_last_item_plus_gap',
})

/** 跨零点窗口的**绝对区间** `[startMs, endMs)`（本地时区；`endMs` 晚于 `startMs`） */
export function windowSpanFor(dayMs, windowStart, windowEnd) {
  const s = hmToMinutes(windowStart)
  const e = hmToMinutes(windowEnd)
  if (s === null || e === null) return null
  const start = new Date(dayMs).setHours(0, 0, 0, 0) + s * 60000
  let end = new Date(dayMs).setHours(0, 0, 0, 0) + e * 60000
  if (end <= start) end += 24 * 60 * 60 * 1000 // 跨零点
  return { startMs: start, endMs: end, spanMs: end - start }
}

/** 组合键：游戏 ⇒ `"<gameKey>:<region>"`（region 缺失 ⇒ 只看 gameKey）；bbs ⇒ `"bbs"` */
export function comboKeyOf(target, region) {
  const t = typeof target === 'string' ? target.trim() : ''
  if (!t) return null
  const r = region === undefined || region === null ? '' : String(region).trim()
  if (t === 'bbs' || r === '') return t
  return t + ':' + r
}

/**
 * 该组合是否被 `schedule.targets` 选中（**空/缺省 ⇒ 全选**，P5）。匹配规则（按 spec 逐条）：
 *   1) spec 与组合键**逐字相等** ⇒ 命中；
 *   2) spec 带 region（`"bh3:bb01"`）⇒ **只**命中该区服，**不**命中同游戏其它区服
 *      （这正是 P5 要排除 `bh3:pc01`/`bh3:android01` 的判据）；
 *   3) spec 不带 region（`"bh3"`）⇒ 命中该游戏**全部**区服（`bh3:*`）。
 * ⚠️ 第 2 条是本文件在自测里修掉的一个真实缺口：早先的"宽松"写法会把 `bh3:pc01` 也当成命中
 * `bh3:bb01` 的 spec（因为二者共享前缀 `bh3`）⇒ 目标筛选静默失效（副号照签）。
 */
export function targetSelected(list, comboKey, target) {
  const arr = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : []
  if (arr.length === 0) return true
  const key = typeof comboKey === 'string' ? comboKey : ''
  for (const raw of arr) {
    const s = raw.trim()
    if (s === key) return true
    if (s.indexOf(':') === -1) {
      if (key === s || key.indexOf(s + ':') === 0) return true
      continue
    }
    // spec 带 region ⇒ 只认逐字相等（上面已判），绝不按游戏前缀放宽
    continue
  }
  return false
}

/**
 * 生成当日计划（**纯函数**）：一次遍历完成 ①目标筛选 ②首项窗口内随机 ③后续 `最小间隔+区间抖动` ④必要时确定性降级。
 * @param opts { dayMs, settings, groups:[{accountKey,target,region?}], rand }
 * @returns { plan:{date, generatedAt, spreadMinGapMs, spreadJitterMs, spreadDegraded, spreadDegradedReason, targets,
 *                  items:[{comboKey, accountKey, target, region, at}]}, skippedByTarget:[comboKey…] }
 */
export function buildDailyPlan(opts) {
  const o = opts || {}
  const settings = Object.assign({}, DEFAULTS, o.settings || {})
  const dayMs = Number.isFinite(o.dayMs) ? o.dayMs : Date.now()
  const rand = randFn(o.rand)
  const date = o.dateLocal || localDateOf(dayMs)
  const sc = settings.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}
  const targets = Array.isArray(sc.targets) ? sc.targets.filter((x) => typeof x === 'string' && x.trim()) : []
  const gap = spreadMinGapOf(settings)
  const jitter = spreadJitterOf(settings)
  const groups = Array.isArray(o.groups) ? o.groups : []
  const items = []
  const skippedByTarget = []
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const target = g && (g.target !== undefined ? g.target : g.gameKey)
    if (!g || !g.accountKey || !target) continue
    const region = g.region === undefined || g.region === null ? '' : String(g.region)
    const comboKey = comboKeyOf(target, region)
    if (!targetSelected(targets, comboKey, target)) { skippedByTarget.push(comboKey); continue }
    items.push({ comboKey, accountKey: g.accountKey, target, region, at: 0 })
  }
  const span = windowSpanFor(dayMs, settings.windowStart, settings.windowEnd)
  let spreadDegraded = false
  let spreadDegradedReason = null
  if (span === null) {
    // 窗口配置非法：**显式降级**（不做任何隐藏的"反正都跑"）
    spreadDegraded = true
    spreadDegradedReason = SPREAD_DEGRADE_REASON.WINDOW_UNUSABLE
    const base = new Date(dayMs).setHours(0, 0, 0, 0) + 8 * 60 * 60 * 1000
    for (let i = 0; i < items.length; i++) items[i].at = base + i * Math.max(gap, 0)
  } else {
    const need = items.length === 0 ? 0 : (items.length - 1) * gap
    if (need < span.spanMs) {
      // 正常路径：首项窗口内**随机**，其后 前一项 + 最小间隔 + 区间随机。
      // 若某次抖动把链推过窗口末端 ⇒ **整段后缀一起左移**（保持间隔不变、不产生"时间的倒流"或级联越界），
      // 并显式标记降级 —— **绝不静默把两条排到同一时刻**（P2）。
      // 补丁②（2026-08-30「开机即签」）：**只改集群起点**。
      //   旧行为：`窗口起点 + 覆盖整窗口的随机` ⇒ 首槽落在当天某个随机时刻，用户在该时刻前关机即整天漏签
      //   （实测：今日 state.dailyPlan 抽到 20:59–21:33，而机器当天 09:43 才起来）。
      //   新行为：`anchorBase = clamp(dayMs, startMs, lastFeasible)` —— `dayMs` 就是**本计划被生成的那一刻**；
      //   计划只在「当天首次 tick（state.dailyPlan 缺失/跨天）」或「组合集合/窗口/分散设置变更」时被采纳并落盘
      //   （复用判据见 `ensureDailyPlanSafe`，唯一写盘处见 `tick()`）⇒ `dayMs` ≡ 当天首次 tick 的 now。
      //   故锚点 = **max(窗口起点, 当天首次 tick) + 小抖动**：无论几点开机，整簇都落在开机后不久。
      //   ⚠️ 相邻间隔仍是 `gap + rand(jitter)`（10–12 分钟），逐字未动；晚于窗口末段开机时向 `lastFeasible` 收敛。
      const lastFeasible = span.endMs - need
      const anchorBase = Math.min(Math.max(span.startMs, Number.isFinite(dayMs) ? dayMs : span.startMs), lastFeasible)
      let prev = null
      for (let i = 0; i < items.length; i++) {
        if (i === 0) {
          items[i].at = Math.min(anchorBase + randInRange(0, ANCHOR_JITTER_MS, rand), lastFeasible)
        } else {
          items[i].at = prev + gap + randInRange(jitter[0], jitter[1], rand)
        }
        if (items[i].at > span.endMs) {
          const shift = items[i].at - span.endMs
          for (let k = 0; k <= i; k++) items[k].at -= shift
          spreadDegraded = true
          spreadDegradedReason = SPREAD_DEGRADE_REASON.WINDOW_TOO_SHORT
        }
        prev = items[i].at
      }
    } else {
      // 约束不可满足 ⇒ **确定性降级**：窗口内等距分布（首末端点内均匀），并显式记录原因
      spreadDegraded = true
      spreadDegradedReason = SPREAD_DEGRADE_REASON.WINDOW_TOO_SHORT
      const n = items.length
      for (let i = 0; i < n; i++) {
        items[i].at = n === 1 ? span.startMs : span.startMs + Math.round((span.spanMs - 1) * i / (n - 1))
      }
    }
  }
  return {
    plan: {
      date, generatedAt: new Date(dayMs).toISOString(), window: { start: settings.windowStart, end: settings.windowEnd },
      spreadMinGapMs: gap, spreadJitterMs: jitter, spreadDegraded, spreadDegradedReason, targets,
      items,
    },
    skippedByTarget,
  }
}

/** `state.dailyPlan` 读侧归一化（形状非法 ⇒ null） */
export function dailyPlanOf(state) {
  const dp = state && state.dailyPlan && typeof state.dailyPlan === 'object' ? state.dailyPlan : null
  if (!dp || typeof dp.date !== 'string' || !Array.isArray(dp.items)) return null
  return dp
}

/** 当日计划是否可用：日期一致 **且** 组合集合与当前一致（集合变了 ⇒ 重新生成，例如目标筛选/账号发现变化） */
export function dailyPlanUsable(dp, date, items) {
  if (!dp || dp.date !== date) return false
  const a = (Array.isArray(dp.items) ? dp.items : []).map((x) => x && x.comboKey).slice().sort()
  const b = (Array.isArray(items) ? items : []).map((x) => x && x.comboKey).slice().sort()
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 确保当日计划存在且可用（**纯函数**）：可用 ⇒ 原样返回；否则重新生成。
 * 可用判据（三者全中才算"复用"）：
 *   ① `date` 一致（同日不重掷 / 跨天重掷）；
 *   ② 组合集合一致（账号发现/目标筛选变化 ⇒ 重掷）；
 *   ③ **分散设置一致**（`spreadMinGapMs`/`spreadJitterMs` 变了 ⇒ 重掷，绝不沿用旧间隔）。
 * 注意：**不**在此把 `DEFAULTS` 合并进 settings —— 缺省项由调用方（scheduler 实例）负责补齐，
 * 这样"用户没配分散"这一事实不会被 DEFAULTS 掩盖（见文件头 ⚠️）。
 */
export function ensureDailyPlan(opts) {
  const o = opts || {}
  const settings = o.settings && typeof o.settings === 'object' ? o.settings : {}
  const dayMs = Number.isFinite(o.dayMs) ? o.dayMs : Date.now()
  const date = o.dateLocal || localDateOf(dayMs)
  const built = buildDailyPlan({ dayMs, settings, groups: o.groups, rand: o.rand, dateLocal: date })
  const cur = dailyPlanOf(o.state)
  const gapNow = spreadMinGapOf(settings)
  const jitNow = spreadJitterOf(settings)
  const settingsSame = !!cur &&
    cur.spreadMinGapMs === gapNow &&
    Array.isArray(cur.spreadJitterMs) && cur.spreadJitterMs[0] === jitNow[0] && cur.spreadJitterMs[1] === jitNow[1] &&
    (!cur.window || (cur.window.start === (settings.windowStart || DEFAULTS.windowStart) && cur.window.end === (settings.windowEnd || DEFAULTS.windowEnd)))
  if (dailyPlanUsable(cur, date, built.plan.items) && settingsSame) {
    return { plan: Object.assign({}, cur, { reused: true }), skippedByTarget: built.skippedByTarget, built: built.plan, reused: true }
  }
  return { plan: built.plan, skippedByTarget: built.skippedByTarget, built: built.plan, reused: false }
}

/** 定向函数（**新**）：把既有 `decideOne` 结果**再受当日计划时刻约束**；返回 `null` ⇒ 交回原决策 */
export function applySpreadToDecision(decision, itemAt, now) {
  if (!Number.isFinite(itemAt)) return null
  if (!Number.isFinite(now) || now >= itemAt) return null
  return { decision: 'spread_wait', reason: 'spread_wait', nextRetryAt: itemAt, at: itemAt, comboKey: decision && decision.comboKey ? decision.comboKey : null }
}

/** 当日计划里**尚未到点**的组合键集合 */
export function spreadPendingKeys(plan, now) {
  const out = {}
  const items = plan && Array.isArray(plan.items) ? plan.items : []
  for (const it of items) {
    if (!it || typeof it.comboKey !== 'string') continue
    if (Number.isFinite(it.at) && it.at > now) out[it.comboKey] = it.at
  }
  return out
}

/** 待跑组合的 `(accountKey,target)` → 计划时刻（返回 Map 语义的普通对象，键 = `accountKey + '\\u0000' + target + '\\u0000' + region`） */
export function planItemIndex(plan) {
  const idx = {}
  const items = plan && Array.isArray(plan.items) ? plan.items : []
  for (const it of items) {
    if (!it || it.target === undefined) continue
    idx[planKeyOf(it.accountKey, it.target, it.region)] = it
  }
  return idx
}

export function planKeyOf(accountKey, target, region) {
  return String(accountKey) + '\u0000' + String(target) + '\u0000' + String(region === undefined || region === null ? '' : region)
}


/**
 * 启动补偿计划（**纯函数**，§5.3：补偿 ≠ 无条件补签）：
 * 对"今天应有的键集合"里**无记录**的键：窗口内 ⇒ 立即跑（late:false）；已过窗口 ⇒ 默认 `skipped_window`，仅 `allowLateSign` 时补一次并标 `late:true`。
 */
export function planCompensate(opts) {
  const o = opts || {}
  const settings = Object.assign({}, DEFAULTS, o.settings || {})
  const now = o.now
  const today = o.dateLocal || localDateOf(now)
  const state = o.state && typeof o.state === 'object' ? o.state : {}
  const doneKeys = state.doneKeys && typeof state.doneKeys === 'object' ? state.doneKeys : {}
  const groups = Array.isArray(o.groups) ? o.groups : []
  const dueKeys = []
  const ranKeys = []
  const skippedKeys = []
  for (const g of groups) {
    const target = g && g.target !== undefined ? g.target : g && g.gameKey
    const accountKey = g && g.accountKey
    if (!accountKey || !target) continue
    if (target === 'bbs' && settings.bbsEnabled === false) continue
    const region = g && g.region !== undefined && g.region !== null ? String(g.region) : ''
    const comboKey = comboKeyOf(target, region)
    const key = dedupeKey(accountKey, target, today, region)
    dueKeys.push(key)
    const entry = lookupDoneEntry(doneKeys, accountKey, target, today, region).entry
    if (isTerminal(entry, { maxAttemptsPerDay: settings.maxAttemptsPerDay })) { skippedKeys.push({ dedupeKey: key, comboKey, reason: 'terminal' }); continue }
    if (entry && !isTerminal(entry, { maxAttemptsPerDay: settings.maxAttemptsPerDay })) { skippedKeys.push({ dedupeKey: key, comboKey, reason: 'in_flight' }); continue }
    if (!inWindow(now, settings.windowStart, settings.windowEnd)) {
      if (settings.allowLateSign === true) ranKeys.push({ dedupeKey: key, accountKey, target, region, comboKey, late: true })
      else skippedKeys.push({ dedupeKey: key, comboKey, reason: 'skipped_window' })
      continue
    }
    const r = decideOne({ now, settings, entry, dedupeKey: key, dateLocal: today, enabled: o.enabled })
    if (r.decision === 'run') ranKeys.push({ dedupeKey: key, accountKey, target, region, comboKey, late: false })
    else skippedKeys.push({ dedupeKey: key, comboKey, reason: r.reason })
  }
  return { dueKeys, ranKeys, skippedKeys }
}

/** 把一次执行结果写回 state（**纯函数**：返回新 state，不改入参） */
export function applyResult(state, opts) {
  const o = opts || {}
  const src = state && typeof state === 'object' ? state : {}
  const doneKeys = Object.assign({}, src.doneKeys && typeof src.doneKeys === 'object' ? src.doneKeys : {})
  const prev = doneKeys[o.dedupeKey] && typeof doneKeys[o.dedupeKey] === 'object' ? doneKeys[o.dedupeKey] : null
  const attempts = (prev && Number.isFinite(prev.attempts) ? prev.attempts : 0) + 1
  const outcome = String(o.outcome)
  const terminal = TERMINAL_OUTCOMES.includes(outcome)
  const nextRetryAt = terminal ? (outcome === 'failed' && attempts < (o.maxAttemptsPerDay || DEFAULTS.maxAttemptsPerDay)
    ? o.now + backoffFor(attempts, o.backoffMs)
    : null)
    : o.now + backoffFor(attempts, o.backoffMs)
  doneKeys[o.dedupeKey] = {
    status: outcome,
    at: new Date(o.now).toISOString(),
    retcode: o.retcode === undefined ? null : o.retcode,
    message: o.message === undefined ? null : String(o.message),
    attempts,
    nextRetryAt,
    late: o.late === true,
  }
  const lastSignSuccess = Object.assign({}, src.lastSignSuccess && typeof src.lastSignSuccess === 'object' ? src.lastSignSuccess : {})
  // t52/G2a：**`already` 也算「已被服务端接受的认证成功」**（captain 裁决 A）。
  //   理由：`-5003`「已签到」证明服务端**用当前这把盐**受理了请求并告知状态 ⇒ 与 t46/J1 对 G1 的口径一致。
  //   护栏：① `outcome` **保持 `'already'`**（绝不写 `'success'`）⇒ "真签"与"已签"仍可区分；
  //         ② `doneKeys.status` 仍由上行写为 `'already'`（本函数**不动** doneKeys 的既有键）；
  //         ③ **不新增任何「今日新签」计数**。自测有负对照（见 selftest/sign_path.mjs 的 S2 块）。
  if (outcome === 'success' || outcome === 'signed' || outcome === 'already') {
    const per = Object.assign({}, lastSignSuccess[o.accountKey] && typeof lastSignSuccess[o.accountKey] === 'object' ? lastSignSuccess[o.accountKey] : {})
    per[o.target] = {
      // 'signed' 仍记 'success'（既有语义逐字不变）；'already' 记 'already'（护栏①）
      outcome: outcome === 'already' ? 'already' : 'success',
      at: new Date(o.now).toISOString(),
      retcode: o.retcode === undefined ? 0 : o.retcode,
      saltFingerprint: o.saltFingerprint === undefined ? null : o.saltFingerprint,
      appVersion: o.appVersion === undefined ? null : o.appVersion,
    }
    lastSignSuccess[o.accountKey] = per
  }
  return Object.assign({}, src, { doneKeys, lastSignSuccess })
}

/** 单飞锁（§5.5）：进程内 running 标志 + 跨重载 `state.lock` 判定（纯函数部分） */
export function lockDecision(state, now, ttlMs) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : LOCK_TTL_MS
  const lock = state && state.lock && typeof state.lock === 'object' ? state.lock : null
  if (!lock) return { canRun: true, reason: 'no_lock', takeover: false }
  const startedAt = Number.isFinite(lock.startedAt) ? lock.startedAt : Date.parse(lock.startedAt)
  if (!Number.isFinite(startedAt)) return { canRun: true, reason: 'bad_lock_timestamp', takeover: true }
  if (now - startedAt > ttl) return { canRun: true, reason: 'lock_expired', takeover: true }
  return { canRun: false, reason: 'locked', takeover: false }
}

/**
 * 调度器实例：把上面纯函数接到 store（adapterFs）与**注入的执行器**上。
 * @param deps { store, clock?, execute?, logger?, config?, pid?, rand? }
 *   - `store`：`lib/store.js` 的实例（读写一律经 adapterFs）
 *   - `execute({accountKey,target,region,dryRun,late})` → `{outcome, retcode, message, saltFingerprint, appVersion}`
 *     **必须注入**；未注入时 `tick` 只会产出计划（`dryRun` 语义），绝不自己发请求（零网络）。
 *   - `rand`（t39）：随机源，可注入 ⇒ 每日分散时刻可复现；缺省 `Math.random`。
 */
export function createScheduler(deps) {
  const d = deps || {}
  const store = d.store
  const clock = typeof d.clock === 'function' ? d.clock : (d.clock && typeof d.clock.now === 'function' ? () => d.clock.now() : () => Date.now())
  const cfg = d.config && typeof d.config === 'object' ? d.config : {}
  const logger = d.logger
  // t39：随机源可注入（测试复现）；缺省 `Math.random`（生产）
  const rand = randFn(typeof d.rand === 'function' ? d.rand : (d.rand && typeof d.rand.random === 'function' ? () => d.rand.random() : null))
  let running = false

  const log = (msg) => { try { if (logger && typeof logger.warn === 'function') logger.warn(msg) } catch (e) { /* 忽略 */ } }

  async function readContext() {
    if (!store || typeof store.readState !== 'function') {
      return { error: { code: 'NOT_READY', message: '调度器未接入数据面（store 缺失）：请先接线 adapterFs' } }
    }
    try {
      const [settings, state] = await Promise.all([store.readSettings(), store.readState()])
      // t50/N1：**读侧就地迁移 legacy 3 段键** ⇒ `schedule()`（展示/门禁侧同源）与 `tick()`（唯一写盘处）
      //   看到的是同一份干净 `doneKeys`；`tick` 落盘时迁移结果随之持久化（无需单独写盘路径）。
      const migrated = migrateLegacyDoneKeys(state && state.doneKeys)
      const stateClean = migrated.changed ? Object.assign({}, state, { doneKeys: migrated.doneKeys }) : state
      let accounts = []
      try {
        const acc = await store.readAccounts()
        accounts = Array.isArray(acc && acc.accounts) ? acc.accounts : []
      } catch (e) { accounts = [] }
      return { settings, state: stateClean, accounts, legacyKeysRemoved: migrated.removed }
    } catch (e) {
      const code = e && e.code ? String(e.code) : 'NOT_READY'
      return { error: { code, message: e && e.message ? String(e.message) : '读取数据面失败', detail: e && e.detail ? String(e.detail) : null } }
    }
  }

  /**
   * 把 accounts.json 展平成逐组合清单（target=游戏或 bbs）。
   * t39：① 带上 `region`（组合键 `gameKey:region` 需要它）；② 按 `schedule.targets` **筛选**（P5：空 ⇒ 全选）。
   * 筛选口径与 `buildDailyPlan` 一致（同一函数 `targetSelected`）⇒ 门禁的组合清单与调度实际组合不会分叉。
   */
  function groupsOf(accounts, settings) {
    const sc = settings && settings.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}
    const targets = Array.isArray(sc.targets) ? sc.targets.filter((x) => typeof x === 'string' && x.trim()) : []
    const out = []
    const push = (accountKey, target, region) => {
      if (target === 'bbs' && settings && settings.bbsEnabled === false) return
      const comboKey = comboKeyOf(target, region)
      if (!targetSelected(targets, comboKey, target)) return
      if (out.some((x) => x.accountKey === accountKey && x.target === target && x.region === (region || ''))) return
      out.push({ accountKey, target, region: region || '', comboKey })
    }
    for (const a of Array.isArray(accounts) ? accounts : []) {
      if (!a) continue
      const roles = Array.isArray(a.roles) ? a.roles : (Array.isArray(a.games) ? a.games : [])
      for (const r of roles) {
        const t = r && (r.gameKey || r.target)
        if (t) push(a.accountKey, t, r && r.region !== undefined && r.region !== null ? String(r.region) : '')
      }
    }
    if (settings && settings.bbsEnabled !== false) {
      for (const a of Array.isArray(accounts) ? accounts : []) if (a && a.bbs !== false) push(a.accountKey, 'bbs', '')
    }
    return out
  }

  /**
   * 当日计划（**读侧不写盘**）：形状/设置一致 ⇒ 复用 `state.dailyPlan`（同日不重掷）；
   * 日期变更或组合集合/分散设置变更 ⇒ 现场生成用于展示。`tick()` 是唯一写盘处（P3）。
   */
  function ensureDailyPlanSafe(opts) {
    const o = opts || {}
    const dateNow = localDateOf(o.now)
    const cur = dailyPlanOf(o.state)
    const gapNow = spreadMinGapOf(o.settings)
    const jitNow = spreadJitterOf(o.settings)
    const winStart = (o.settings && o.settings.windowStart) || DEFAULTS.windowStart
    const winEnd = (o.settings && o.settings.windowEnd) || DEFAULTS.windowEnd
    // 自测抓到的真实缺口：**窗口也是计划的一部分**。早先只比 minGap/jitter ⇒ 改了窗口仍复用旧时刻表
    // （旧表按旧窗口排的 ⇒ 新窗口形同虚设、降级判据也不会被触发）。窗口变了必须重排。
    const windowSame = !cur || !cur.window || (cur.window.start === winStart && cur.window.end === winEnd)
    if (dailyPlanUsable(cur, dateNow, o.groups) &&
        cur.spreadMinGapMs === gapNow &&
        Array.isArray(cur.spreadJitterMs) && cur.spreadJitterMs[0] === jitNow[0] && cur.spreadJitterMs[1] === jitNow[1] &&
        windowSame) {
      return { plan: cur, skippedByTarget: [], reused: true }
    }
    const built = buildDailyPlan({ dayMs: o.now, settings: o.settings, groups: o.groups, rand, dateLocal: dateNow })
    return { plan: built.plan, skippedByTarget: built.skippedByTarget, reused: false }
  }

  /** 是否**真的**启用分散门（计划的时间戳必须真的拉开；否则不改变旧行为） */
  function spreadGating(plan, settings) {
    if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return false
    return spreadEnabledOf(settings)
  }

  /** 计划（供 miyoushe_schedule/status 用；只读，不写盘） */
  async function schedule(opts) {
    const o = opts || {}
    const ctxRes = await readContext()
    if (ctxRes.error) return { ok: false, error: ctxRes.error }
    const { settings, state, accounts } = ctxRes
    const now = Number.isFinite(o.now) ? o.now : clock()
    const groups = groupsOf(accounts, settings)
    const enabled = state.schedule && state.schedule.enabled === true
    const dp = ensureDailyPlanSafe({ settings, state, groups, now })
    const p = planTick({ now, settings, state, groups, enabled, dailyPlan: spreadGating(dp.plan, settings) ? dp.plan : null })
    return {
      ok: true,
      enabled,
      mode: state.schedule && typeof state.schedule.mode === 'string' ? state.schedule.mode : (enabled ? 'auto' : 'readonly'),
      tickMs: Number.isFinite(settings.tickMs) ? settings.tickMs : DEFAULTS.tickMs,
      window: { start: settings.windowStart || DEFAULTS.windowStart, end: settings.windowEnd || DEFAULTS.windowEnd },
      nextAt: new Date(p.nextAt).toISOString(),
      nextTargets: p.run.map((x) => ({ accountKey: x.accountKey, target: x.target, region: x.region || '', comboKey: x.comboKey || null })),
      lastRunAt: state.schedule && state.schedule.lastRunAt ? state.schedule.lastRunAt : null,
      lastOutcome: state.schedule && state.schedule.lastOutcome ? state.schedule.lastOutcome : null,
      pausedBy: state.schedule && state.schedule.pausedBy ? state.schedule.pausedBy : null,
      groups,
      dailyPlan: dp.plan,
      // t50/N2：**计划来源必须显式标注**。读侧（本函数）不写盘（P3：`tick()` 是唯一写盘处），
      //   因此当 `state.dailyPlan` 不可复用（日期/组合集合/窗口/分散设置变了）时，这里给出的是
      //   **现场现算的候选计划**，**不是**权威时刻表 ⇒ 调用方（`miyoushe_schedule`）不得把它当成
      //   已生效的排程；`reused:true` 时 `dailyPlan` 与 `state.dailyPlan` **同一个对象**（逐字一致）。
      dailyPlanPersisted: dp.reused === true,
      dailyPlanSource: dp.reused === true ? 'persisted' : 'candidate',
      legacyKeysRemoved: Array.isArray(ctxRes.legacyKeysRemoved) ? ctxRes.legacyKeysRemoved : [],
      spread: {
        enabled: spreadGating(dp.plan, settings),
        reused: dp.reused === true,
        degraded: dp.plan.spreadDegraded === true,
        degradedReason: dp.plan.spreadDegradedReason || null,
        minGapMs: dp.plan.spreadMinGapMs,
        jitterMs: dp.plan.spreadJitterMs,
        targets: dp.plan.targets.slice(),
        skippedByTarget: dp.skippedByTarget.slice(),
      },
    }
  }

  /** 单飞：同一进程内 tick 重入 ⇒ 记 lock_skip；跨重载锁由 state.lock 判定 */
  async function tick(opts) {
    const o = opts || {}
    const now = Number.isFinite(o.now) ? o.now : clock()
    if (running) return { ok: true, skipped: true, reason: 'running_in_process' }
    const ctxRes = await readContext()
    if (ctxRes.error) return { ok: false, error: ctxRes.error }
    const { settings, state, accounts } = ctxRes
    const lock = lockDecision(state, now, cfg.lockTtlMs)
    if (!lock.canRun) {
      await safeLog({ event: 'lock_skip', reason: lock.reason })
      return { ok: true, skipped: true, reason: 'locked', lock }
    }
    const enabled = state.schedule && state.schedule.enabled === true
    if (!enabled && o.force !== true) return { ok: true, skipped: true, reason: 'disabled' }
    const groups = groupsOf(accounts, settings)
    // t39：当日计划（P3）。`dryRun` 是**纯预览/不写盘** ⇒ 预览**不套**分散门（否则"今天此刻只会有 1 条"，
    //   预览失去意义）；真跑才按计划时刻逐条放行，并把计划落 state。
    const dp = ensureDailyPlanSafe({ settings, state, groups, now })
    const spreadOn = o.dryRun !== true && o.ignoreSpread !== true && spreadGating(dp.plan, settings)
    const p = planTick({ now, settings, state, groups, enabled, dailyPlan: spreadOn ? dp.plan : null })
    running = true
    try {
      // 写锁（§5.5：TTL 过期可接管）；**dryRun 是纯预览 ⇒ 不写任何盘**（无副作用）
      if (o.dryRun !== true) {
        const withPlan = spreadOn && !dp.reused ? Object.assign({}, state, { dailyPlan: dp.plan }) : state
        await writeStateSafe(Object.assign({}, withPlan, { lock: { owner: String(cfg.pid === undefined ? 'miyoushe' : cfg.pid), startedAt: now, ttlMs: cfg.lockTtlMs || LOCK_TTL_MS } }))
      }
      const results = []
      if (o.dryRun !== true && typeof d.execute === 'function') {
        for (const task of p.run) {
          const gap = Array.isArray(settings.accountGapMs) ? settings.accountGapMs : DEFAULTS.accountGapMs
          void gap // 账号间间隔由调用方/宿主 tick 频率保证；此处不 sleep（保持纯逻辑可测）
          let res
          try {
            res = await d.execute({ accountKey: task.accountKey, target: task.target, region: task.region || '', dryRun: false, late: task.late === true })
          } catch (e) {
            res = { outcome: 'failed', retcode: null, message: e && e.message ? String(e.message) : 'execute threw' }
          }
          results.push(Object.assign({ dedupeKey: task.dedupeKey, accountKey: task.accountKey, target: task.target, region: task.region || '', comboKey: task.comboKey || null, planAt: task.planAt === undefined ? null : task.planAt }, res))
        }
      } else {
        // t82/P0①（防御层）：**真跑却没有注入 execute ⇒ 逐条产出 `failed/EXECUTE_NOT_WIRED`**，
        //   让它们走正常落账（doneKeys + attempts + sign_result 日志）⇒ 受 `maxAttemptsPerDay` 保护。
        //   绝不静默降级为 `would_run` —— 那会被下面那句 `if (r.outcome === 'would_run') continue`
        //   **整批丢弃**：不落 doneKeys / 不记 lastError / attempts 不增长 ⇒ 无限重试（2026-09-21 的 P0）。
        //   `dryRun` 仍保持**纯预览**语义（继续产出 would_run，不落账）。
        const notWired = o.dryRun !== true
        for (const task of p.run) results.push({
          dedupeKey: task.dedupeKey, accountKey: task.accountKey, target: task.target, region: task.region || '',
          comboKey: task.comboKey || null, planAt: task.planAt === undefined ? null : task.planAt,
          outcome: notWired ? 'failed' : 'would_run', dryRun: o.dryRun === true,
          message: notWired ? 'EXECUTE_NOT_WIRED' : undefined,
        })
      }
      // 回写 state：先应用执行结果，再落 lastRunAt/lastOutcome/清锁
      let next = spreadOn && !dp.reused ? Object.assign({}, state, { dailyPlan: dp.plan }) : state
      const nowIso = new Date(now).toISOString()
      // t82/P0②：**每次真实提交（成功或失败）都落一条日志事件**。此前「决定跑但无结果」完全没有日志，
      //   是本次故障最贵的一课：`tick` 事件里的 ranKeys 只是**计划**要跑的键，并不代表真的提交过。
      //   凭据绝不出现：message 走 `maskText`（与出口同一权威掩码器）。
      for (const r of results) {
        if (r.outcome === 'would_run') continue
        await safeLog({
          event: 'sign_result',
          dedupeKey: r.dedupeKey, accountKey: r.accountKey, target: r.target, region: r.region || '',
          outcome: r.outcome,
          retcode: r.retcode === undefined ? null : r.retcode,
          httpStatus: r.httpStatus === undefined ? null : r.httpStatus,
          classify: r.classify === undefined ? null : r.classify,
          messageMasked: r.message === undefined || r.message === null ? null : maskText(String(r.message)).slice(0, 400),
          persisted: r.persisted === true,
          late: r.late === true,
        })
      }
      for (const r of results) {
        if (r.outcome === 'would_run') continue
        // t82/P0③：提交方（execute 注入）若**已自行落账** ⇒ 这里不得再用 tick 开始时读到的**过期 state**
        //   去 applyResult/整份回写 —— 那会覆盖它刚写下的 doneKeys/lastOkAt/盐升级。
        if (r.persisted === true) continue
        next = applyResult(next, {
          dedupeKey: r.dedupeKey, accountKey: r.accountKey, target: r.target, outcome: r.outcome,
          retcode: r.retcode, message: r.message, now, late: r.late === true,
          maxAttemptsPerDay: settings.maxAttemptsPerDay, backoffMs: settings.backoffMs,
          saltFingerprint: r.saltFingerprint, appVersion: r.appVersion,
        })
      }
      const lastOutcomeNow = results.length ? results[results.length - 1].outcome : 'idle'
      const externallyPersisted = results.length > 0 && results.every((r) => r.persisted === true)
      next = Object.assign({}, next, {
        lock: null,
        schedule: Object.assign({}, next.schedule || {}, {
          lastRunAt: nowIso,
          lastOutcome: lastOutcomeNow,
        }),
      })
      if (o.dryRun !== true) {
        if (externallyPersisted) {
          // 全部结果由提交方落账 ⇒ **重读最新 state 后只合并** lock/lastRunAt/lastOutcome（不整份回写）
          const fresh = await readContext()
          const baseState = fresh && !fresh.error && fresh.state ? fresh.state : next
          await writeStateSafe(Object.assign({}, baseState, {
            lock: null,
            schedule: Object.assign({}, baseState.schedule || {}, { lastRunAt: nowIso, lastOutcome: lastOutcomeNow }),
          }))
        } else {
          await writeStateSafe(next)
        }
      }
      await safeLog({ event: 'tick', ranKeys: p.run.map((x) => x.dedupeKey), skippedKeys: p.skipped.map((x) => ({ key: x.dedupeKey, reason: x.reason })), dryRun: o.dryRun === true })
      return { ok: true, skipped: false, ran: results, plan: p.plan, nextAt: new Date(p.nextAt).toISOString(), dryRun: o.dryRun === true }
    } finally {
      running = false
    }
  }

  /** 启动补偿（§5.3）：只对"无记录"的键按窗口语义决定，绝不无条件补签 */
  async function compensate(opts) {
    const o = opts || {}
    const now = Number.isFinite(o.now) ? o.now : clock()
    const ctxRes = await readContext()
    if (ctxRes.error) return { ok: false, error: ctxRes.error }
    const { settings, state, accounts } = ctxRes
    const groups = groupsOf(accounts, settings)
    const c = planCompensate({ now, settings, state, groups, enabled: state.schedule ? state.schedule.enabled === true : false })
    await safeLog({ event: 'compensate', dueKeys: c.dueKeys, ranKeys: c.ranKeys.map((x) => x.dedupeKey), skippedKeys: c.skippedKeys })
    return { ok: true, dueKeys: c.dueKeys, ranKeys: c.ranKeys, skippedKeys: c.skippedKeys, summary: '今日补偿：' + c.ranKeys.length + ' 已处理 / ' + c.skippedKeys.length + ' 跳过' }
  }

  async function writeStateSafe(state) {
    if (!store || typeof store.writeState !== 'function') return { ok: false, error: { code: 'NOT_READY' } }
    try { return await store.writeState(state) } catch (e) { return { ok: false, error: { code: e && e.code ? String(e.code) : 'FS_IO_ERROR', message: e && e.message ? String(e.message) : '写 state 失败' } } }
  }
  async function safeLog(rec) {
    if (!store || typeof store.appendLog !== 'function') return
    try { await store.appendLog(rec) } catch (e) { log('[miyoushe] scheduler log failed: ' + String(e && e.message || e)) }
  }

  /**
   * 当日计划**读侧**（只读、不写盘）：供 `miyoushe_schedule`/`status` 展示（P3/P8 可审计）。
   * 与 `tick()` 用**同一个** `ensureDailyPlanSafe` ⇒ 展示与执行不会分叉。
   */
  async function dailyPlan(opts) {
    const o = opts || {}
    const ctxRes = await readContext()
    if (ctxRes.error) return { ok: false, error: ctxRes.error }
    const { settings, state, accounts } = ctxRes
    const now = Number.isFinite(o.now) ? o.now : clock()
    const groups = groupsOf(accounts, settings)
    const dp = ensureDailyPlanSafe({ settings, state, groups, now })
    return {
      ok: true,
      reused: dp.reused === true,
      enabled: spreadGating(dp.plan, settings),
      plan: dp.plan,
      skippedByTarget: dp.skippedByTarget,
      groups,
    }
  }

  return {
    schedule,
    dailyPlan,
    tick,
    compensate,
    isRunning: () => running,
    /** 读侧工具（供 actions 复用，避免各自重算） */
    groupsOf,
    lockDecision: (state, now) => lockDecision(state, now, cfg.lockTtlMs),
  }
}
