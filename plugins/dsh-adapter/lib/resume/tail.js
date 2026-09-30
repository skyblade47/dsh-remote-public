// @local/dsh-adapter —— 重启自恢复（P3 §2B/U8）：只读会话日志的**尾部窗口**，拿"真实最后活跃时间"
// （U12 起，"取最后时间"的判据是 `time` → 分片事件的 `time0`，见 `lastEventOf` 的注释）
//
// 为什么需要它（两次真机实测换来的，不要"简化"回去）：
//   · 文件 mtime **不能当闸门**：Linux 迁移把 554 个文件的 mtime 刷成同一时刻（≈迁移时刻）。
//   · 投影缓存 lastPromptAt **不能单独当闸门**：539 个会话的 dryRun 里**一次都没命中**
//     （全部退化成 `header.createdAt` = **会话创建时间**）⇒ 26 天前创建、今早才活跃的会话被误排除，
//     而那正是最该唤醒的一类（U7b 的坏法）。
//   · 会话日志是 **append-only 的多帧 zstd 流**，**最后一帧就是最新事件** ⇒ 读文件尾部几 KB 即可解出。
//     真机实测（23MB 文件）：尾窗 8192 字节、窗口内帧数=2、命中帧长 7984 字节、该帧 3 条事件。
//
// 三条实现要点（每条都有实测依据，改之前先读完）：
//   ① **必须从后往前**试魔数候选：压缩数据内部可能**巧合**出现 `28 B5 2F FD`
//      （zstd 对不可压缩载荷走 Raw_Block，载荷字节原样保留）⇒ 从前往后试会把"假帧首"当真帧首。
//   ② 窗口要**自适应放大**：单条事件可能远大于 8KB（大工具结果很常见），小窗口会截不到帧首。
//   ③ zstd 帧**可独立解码** ⇒ 只解最后一帧是合法的，不需要解全量（30MB 会话解不起）。
//
// 代价：每会话一次 stat + 读尾几 KB + 一次小帧解压；**不依赖投影缓存是否水合**。
// 纪律：**任何情况都不抛异常**（一级预筛在启动路径上，抛错会毁掉整轮恢复），失败一律 `{ ok:false, reason }`。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { lastTurnState } from './detect.js'

/** zstd 帧魔数（小端 0xFD2FB528） */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 首次尝试的尾部窗口（真机实测 8192 足够命中 23MB 文件的最后一帧） */
export const DEFAULT_INITIAL_TAIL = 8192

/** 自适应放大阶梯（在 initialTail 之后依次尝试；最后再试整个文件） */
const WINDOW_LADDER = [65536, 1048576]

/**
 * 判"末态"时允许放大的**尾部窗口上限**（U10；2026-09-25 T1-2 由 2 MiB 提到 4 MiB）。
 *
 * 为什么需要它：一级预筛只需要"最后一条事件的时间"（几 KB 就够），而二级判定要的是**最后一条 turn 边界**
 * ——边界可能离文件尾很远（一个长 turn 里几十条大工具结果很常见）⇒ 需要更大的窗口。
 *
 * ⚠️ **T1-2 之后这个上限的含义变了**：二级判定**不再回退读全量**（见 `scan.js#turnStateOf`），
 * 所以它从"回退前的最后一档"变成了"**能不能判出末态的唯一杠杆**" ⇒ 必须放大。
 *
 * 取 4 MiB 的理由（真机实测 406 个会话，每个取版本最高的那份快照）：
 *   p50 58 KB / p90 213 KB / p95 321 KB / p99 844 KB / max 22.6 MiB；
 *   **>2 MiB 仅 4 个（1.0%）、>4 MiB 仅 3 个（0.7%）**，而 >4 MiB 的那 3 个占**全部字节的 56%**。
 *   ⇒ 4 MiB 让**99.3% 的会话"整份日志都落在窗口内"**（判末态**零漏判**，因为窗口右端就是文件尾），
 *     同时把单次读的内存天花板钉死在 4 MiB（比全量读便宜两个数量级）。
 * 这个常数会被写进 `resume.scan` 审计（`maxTail`），便于按真机数据调参。
 */
export const DEFAULT_MAX_TAIL_TAIL = 4 * 1024 * 1024

/** 判末态时的窗口放大阶梯（在 DEFAULT_INITIAL_TAIL 之上依次放大，最后到 maxTail 上限） */
const TURN_STATE_WINDOW_LADDER = [65536, 262144, 1048576]

const errMsg = (e) => String((e && e.message) || e)

const finiteNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 枚举 buf 内**全部**魔数候选位置（顺序即偏移递增） */
function magicOffsets(buf) {
  const out = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i)
  }
  return out
}

/**
 * 试把一个候选偏移当帧首解码。
 * 判据：zstd 解得开 **且** 解出的文本按 `\n` 切后**每一行都能 JSON.parse**
 * （假帧首即使侥幸解开，也几乎不可能整段是合法 JSONL）；空帧视为失败。
 *
 * @returns {object[]|null} 事件数组；不是真帧边界则 null
 */
function decodeEventsAt(buf, off) {
  let text
  try {
    text = zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8')
  } catch (_) { return null }
  if (!text) return null
  const lines = text.split('\n').filter((s) => s.trim())
  if (!lines.length) return null
  const events = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch (_) { return null }
  }
  return events
}

/**
 * 只解会话文件的**最后一帧**（即最新事件所在帧）。
 *
 * 窗口依序 `[initialTail, 65536, 1048576, 文件大小]`（去重、按实际可读长度截断为 fileSize），
 * 每个窗口内**从最后一个魔数候选往前**逐个尝试解码，成功即返回。
 *
 * @param {string} filePath 会话文件（如 `<home>/sessions/<bucket>/<id>/session.jsonl.zstd`）
 * @param {{ initialTail?: number }} [opts]
 * @returns {{ ok:true, window:number, frameBytes:number, framesInWindow:number, events:object[] }
 *          | { ok:false, reason:string }}
 *   `window` = 实际生效的尾部窗口字节数；`frameBytes` = 命中帧的字节长度；
 *   `framesInWindow` = 窗口内的魔数候选个数（诊断用：>1 说明确实遇到过误导候选）。
 */
export function readLastFrame(filePath, { initialTail = DEFAULT_INITIAL_TAIL } = {}) {
  let fd = null
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, reason: '未给出会话文件路径' }
    let size = 0
    try { size = fs.statSync(filePath).size } catch (e) { return { ok: false, reason: 'stat 失败：' + errMsg(e) } }
    if (!size) return { ok: false, reason: '文件为空' }

    const wins = []
    for (const raw of [initialTail, ...WINDOW_LADDER, size]) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) continue
      const len = Math.min(Math.trunc(n), size)
      if (!wins.includes(len)) wins.push(len)
    }

    fd = fs.openSync(filePath, 'r')
    for (const len of wins) {
      const buf = Buffer.alloc(len)
      let read = 0
      try { read = fs.readSync(fd, buf, 0, len, size - len) } catch (_) { continue }
      if (read <= 0) continue
      const view = read === len ? buf : buf.subarray(0, read)
      const offs = magicOffsets(view)
      // ① 从后往前：靠后的候选更可能是"真帧首"，靠前/靠后的假候选都要被试过才排除
      for (let i = offs.length - 1; i >= 0; i--) {
        const events = decodeEventsAt(view, offs[i])
        if (!events) continue
        return { ok: true, window: view.length, frameBytes: view.length - offs[i], framesInWindow: offs.length, events }
      }
    }
    return { ok: false, reason: '尾部窗口（最大 ' + wins[wins.length - 1] + ' 字节）内没有可解的完整帧' }
  } catch (e) {
    return { ok: false, reason: '读尾帧异常：' + errMsg(e) }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (_) { /* 关不掉也不抛 */ } }
  }
}

/**
 * 把**尾部窗口**当作一段连续字节流，从窗口内**最早**的那个真帧边界解到文件末尾（U10）。
 *
 * 与 `readLastFrame` 的差别（别把两者合并，用途不同）：
 *   · `readLastFrame` 只解**最后一帧** ⇒ 给一级预筛取"最后一条事件的时间"，几 KB 就够；
 *   · 本函数解**窗口内最早的边界→EOF** ⇒ 给二级判定取"最后一条 turn 边界"，而边界可能远在最后一帧之前。
 *
 * ⚠️ 实现要点（实测换来的，别"顺手简化"成"从边界解到 EOF 一把梭"）：
 *   Node 的 `zlib.zstdDecompressSync` **一次只解第一帧**——喂多帧拼接的缓冲时后面的帧被直接忽略
 *   （实测：3 个帧拼起来，从 offset 0 解出来只有第 1 帧的内容）。所以这里必须**按魔数候选逐帧解**
 *   （每次只喂 `view.subarray(off)`，靠"只解第一帧"的语义天然收在帧尾），再把**偏移递增**的结果按序拼起来。
 *   判据沿用 readLastFrame 那一套：候选偏移处解得开 **且** 解出的 JSONL 每行都能 `JSON.parse`
 *   （假帧首即使侥幸解开，也几乎不可能整段是合法 JSONL）。压不进的载荷里可能**巧合**出现魔数 ⇒
 *   这类候选解不开、被跳过；真帧候选一个都不会漏（每个真帧首都在候选里）。
 *
 * 窗口 = `min(initialTail, maxTail, 文件大小)`：`maxTail` 是**上限**（clamp），放大阶梯由 `turnStateFromTail` 负责。
 *
 * ⚠️ 已知边界情形（**如实失败、不假装成功**）：若文件尾部的最后一帧被写坏/截断（崩溃正在 append 时），
 * 就**不返回**倒数第二个帧的边界，而是直接 `ok:false`（那个半帧里可能正好是 `turn/start` ⇒
 * 照旧返回会给出**错的**末态）⇒ 由调用方回退读全量。
 *
 * 纪律：**任何情况都不抛**（二级判定也在启动路径上）。
 *
 * ⚠️ 本函数是**内部内核**（U12 起 `lastEventOf` 也复用它 ⇒ 额外多带一个 `lastFrameBytes`）。
 *    对外导出的仍是 `readTailEvents`（形状与本文档一致，不多不少）。
 *
 * @param {string} filePath 会话文件
 * @param {{ initialTail?: number, maxTail?: number }} [opts]
 * @returns {{ ok:true, events:object[], window:number, framesInWindow:number, lastFrameBytes:number }
 *          | { ok:false, reason:string }}
 *   `events` = 从窗口内最早的真帧边界到文件末尾的**全部事件**（按序）；
 *   `window` = 实际生效的尾部窗口字节数；`framesInWindow` = 窗口内**成功解出**的帧数
 *   （< 魔数候选数时就说明遇到过误导候选）；`lastFrameBytes` = 最后一个解得开的真帧的字节长度。
 */
function readTailCore(filePath, { initialTail = DEFAULT_INITIAL_TAIL, maxTail = DEFAULT_MAX_TAIL_TAIL } = {}) {
  let fd = null
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, reason: '未给出会话文件路径' }
    let size = 0
    try { size = fs.statSync(filePath).size } catch (e) { return { ok: false, reason: 'stat 失败：' + errMsg(e) } }
    if (!size) return { ok: false, reason: '文件为空' }

    const cap = Math.min(finiteNum(maxTail) || DEFAULT_MAX_TAIL_TAIL, size)
    const want = finiteNum(initialTail) || DEFAULT_INITIAL_TAIL
    const len = Math.max(1, Math.min(want, cap))

    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(len)
    let read = 0
    try { read = fs.readSync(fd, buf, 0, len, size - len) } catch (e) { return { ok: false, reason: '读尾部失败：' + errMsg(e) } }
    if (read <= 0) return { ok: false, reason: '读尾部返回 0 字节' }
    const view = read === len ? buf : buf.subarray(0, read)

    // 偏移递增：第一个解得开的候选就是"窗口内最早的真帧边界"，其后解出的帧一路拼到文件末尾。
    const offs = magicOffsets(view)
    const events = []
    let frames = 0
    let lastGoodOff = -1
    for (const off of offs) {
      const evs = decodeEventsAt(view, off)
      if (!evs) continue
      frames++
      lastGoodOff = off
      for (const e of evs) events.push(e)
    }
    if (!frames) return { ok: false, reason: '尾部窗口（' + view.length + ' 字节）内没有能解出的完整帧' }
    // ⚠️ 窗口内**最后一个**候选解不开 ⇒ 文件尾可能是"写坏的半帧"（崩溃正在 append 时）。
    //    这时若照旧返回"倒数第二个帧"的边界，就可能给出**错的**末态（半帧里可能正好是 turn/start）
    //    ⇒ 如实报失败，让调用方回退读全量（宁慢不滥）。窗口右端就是文件末尾，故只可能是尾部被写坏。
    if (lastGoodOff !== offs[offs.length - 1]) {
      return { ok: false, reason: '尾部最后一个帧候选解不开（可能是写坏的半帧，偏移 ' + offs[offs.length - 1] + '）' }
    }
    return { ok: true, events, window: view.length, framesInWindow: frames, lastFrameBytes: view.length - lastGoodOff }
  } catch (e) {
    return { ok: false, reason: '读尾部事件异常：' + errMsg(e) }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (_) { /* 关不掉也不抛 */ } }
  }
}

/**
 * `readTailCore` 的对外门面：形状与本文档一致（**不多不少**，`lastFrameBytes` 只给内部用）。
 *
 * @param {string} filePath 会话文件
 * @param {{ initialTail?: number, maxTail?: number }} [opts]
 * @returns {{ ok:true, events:object[], window:number, framesInWindow:number } | { ok:false, reason:string }}
 */
export function readTailEvents(filePath, opts = {}) {
  const r = readTailCore(filePath, opts)
  if (!r.ok) return r
  return { ok: true, events: r.events, window: r.window, framesInWindow: r.framesInWindow }
}

/** 尾窗放大阶梯（去重、升序、按 maxTail 截断）——**取时间与判末态共用同一套阶梯** */
function tailWindowLadder(maxTail) {
  const cap = finiteNum(maxTail) || DEFAULT_MAX_TAIL_TAIL
  const windows = []
  for (const raw of [DEFAULT_INITIAL_TAIL, ...TURN_STATE_WINDOW_LADDER, cap]) {
    const n = finiteNum(raw)
    if (n === null) continue
    const len = Math.min(Math.trunc(n), cap)
    if (!windows.includes(len)) windows.push(len)
  }
  windows.sort((a, b) => a - b)
  return windows
}

/**
 * 从会话日志尾部直接判"末态"（U10）—— 二级判定的主路径，替代"读全量日志"。
 *
 * ★★ 本方案成立的关键推理（改动前请先读懂这条）★★
 * 窗口是**贴着文件尾**的（每次都解到 EOF），所以**窗口内"从后往前找到的第一条 turn 边界"就是整条日志的最后一条**
 * —— 不存在"真正的最后边界落在窗口之后"这种情况（窗口的右端就是文件末尾，没有"之后"）。
 * ⇒ 唯一的失败模式只有"窗口内一条 turn 边界都没有"（边界比窗口更深），此时**放大窗口**；
 *    放大到 `maxTail` 上限仍没有，才回退读全量。
 * 换句话说：本路径**绝不会**因为窗口太小而给出一个**错的**末态，最多是"这一轮拿不到"。
 *
 * 依序放大窗口 `[DEFAULT_INITIAL_TAIL, 65536, 262144, 1048576, maxTail]`（去重、升序、按 maxTail 截断），
 * 每轮 `readTailEvents` 后跑 `lastTurnState(events)`，只要 `kind !== 'none'` 就返回。
 *
 * 成本：真机实测一级预筛（539 个会话读尾帧）只用 3.7 秒 ⇒ 两级都走尾帧后，二级判定不再逐个读
 * 135 个子会话的完整日志（其中有的 13764 事件）。
 *
 * @returns {{ ok:true, state:object, source:'tail', window:number, framesInWindow:number }
 *          | { ok:false, reason:'no-turn-boundary-in-window', window:number, detail:string }}
 *   `reason` 恒为 `'no-turn-boundary-in-window'`（含"文件读不出/不存在"：同样拿不到边界），
 *   精确原因放在 `detail` 里（审计用，判据只看 `ok`）。**任何情况都不抛**。
 */
export function turnStateFromTail(filePath, { maxTail = DEFAULT_MAX_TAIL_TAIL } = {}) {
  const cap = finiteNum(maxTail) || DEFAULT_MAX_TAIL_TAIL
  const windows = tailWindowLadder(maxTail)

  let lastWindow = windows.length ? windows[windows.length - 1] : cap
  let detail = '未尝试任何窗口'
  for (const w of windows) {
    const r = readTailEvents(filePath, { initialTail: w, maxTail: w })
    if (r.window != null) lastWindow = r.window
    if (!r.ok) { detail = r.reason; continue }
    const state = lastTurnState(r.events)
    if (state && state.kind !== 'none') {
      return { ok: true, state, source: 'tail', window: r.window, framesInWindow: r.framesInWindow }
    }
    detail = '窗口 ' + r.window + ' 字节内没有 turn/start 或 turn/end 事件'
  }
  return { ok: false, reason: 'no-turn-boundary-in-window', window: lastWindow, detail }
}

/**
 * 会话日志里**存在不携带 `time` 的分片事件**（流式 delta 的聚合条目，如 `text-chunks` / `reasoning-chunks` /
 * `assistant/chunk`）：这类事件用 `seq0` / `time0` 表达"这段 delta 属于哪个 seq、**从什么时候开始**"——
 * 即时间在 `time0` 里，`time` 字段**根本不存在**。2026-09-22 真机实录（539 会话）：
 *   成功且有 time = 483、成功但取不到时间 = 56、**真读取失败 = 0**，而那 56 个的末条事件**全是分片事件**
 *   （`{"type":"text-chunks","seq0":...,"time0":1787826396479,...}`，同一窗口更早还有一条
 *   `assistant/chunk time=1787826396174`，与分片的 `time0` 只差 305ms ⇒ 就是同一时刻的表达）。
 *   ⇒ 判据漏了 `time0` 会让这 56 个（≈10%）会话退到 `header.createdAt`（**会话创建时间**），
 *     变成"创建很早、最近才活跃"的会话被误判过期（U7b 那类误判）。
 * **任何"取最后时间"的逻辑都必须走 `time` → `time0` 这条链**，不要只看 `time`。
 *
 * 取法（U12）：基于**整个尾部窗口**的事件（`readTailCore`），按现有窗口阶梯**逐级放大**
 * （`DEFAULT_MAX_TAIL_TAIL` 为上限），直到窗口内有可用时间或到上限；在窗口事件里**从尾往前**找
 * 第一条"带可用时间"的事件（即**最近**的那条，不是最早的）：① `time` ② `time0`。
 *
 * @param {string} filePath 会话文件
 * @param {{ maxTail?: number }} [opts]
 * @returns {{ ok:true, lastEventType:string|null, lastEventTime:number|null, lastEventTimeSource:'time'|'time0'|null,
 *             lastEventSeq:number|null, frameBytes:number, window:number, framesInWindow:number }
 *          | { ok:false, reason:string }}
 *   `lastEventType` / `lastEventSeq` = **真·末条事件**的 type / seq（审计字段，语义**不变**：
 *   不要改成"找到时间的那条"的类型）；`lastEventTime` = 找到的那条的时间；
 *   `lastEventTimeSource` = 那个时间取自哪一列（null = 窗口内没有任何可用时间）；
 *   `lastEventTime === null` 时仍是 `ok:true`（调用方据此降级到 lastPromptAt/createdAt）——
 *   **不要**改成 `ok:false`（ok:false 专表"文件读不出"）。
 *   **任何情况都不抛**；文件不存在/垃圾/截断仍走原有失败语义。
 */
export function lastEventOf(filePath, { maxTail = DEFAULT_MAX_TAIL_TAIL } = {}) {
  const windows = tailWindowLadder(maxTail)
  let firstOk = null
  for (const w of windows) {
    const r = readTailCore(filePath, { initialTail: w, maxTail: w })
    if (!r.ok) continue
    const last = r.events[r.events.length - 1]
    if (!last || typeof last !== 'object' || Array.isArray(last)) {
      return { ok: false, reason: '窗口的最后一行不是事件对象' }
    }
    // 首个成功窗口先留着：更大窗口也没找到可用时间时，用它的真·末条事件 + window/frameBytes 输出
    if (!firstOk) firstOk = r
    const hit = lastTimedEvent(r.events)
    if (hit) return lastEventResult(r, last, hit)
  }
  if (firstOk) {
    return lastEventResult(firstOk, firstOk.events[firstOk.events.length - 1], null)
  }
  // 整条阶梯内"窗口内最早边界→EOF"都解不出（文件尾可能是写坏的半帧，或窗口内全是误导候选）⇒
  // 退回 U8 的"只解最后一帧"路径（语义原样保留：取最后一个解得开的候选帧）。
  const lf = readLastFrame(filePath)
  if (!lf.ok) return { ok: false, reason: lf.reason }
  const last = lf.events[lf.events.length - 1]
  if (!last || typeof last !== 'object' || Array.isArray(last)) {
    return { ok: false, reason: '最后一帧的最后一行不是事件对象' }
  }
  return {
    ok: true,
    lastEventType: typeof last.type === 'string' ? last.type : null,
    lastEventSeq: finiteNum(last.seq),
    frameBytes: lf.frameBytes,
    window: lf.window,
    framesInWindow: lf.framesInWindow,
    ...lastEventResultTime(lastTimedEvent(lf.events)),
  }
}

/**
 * 组织 `lastEventOf` 的返回值：`lastEventType`/`lastEventSeq` 永远来自**真·末条事件**（`last`），
 * 时间去哪儿找（`hit`）只影响 `lastEventTime`/`lastEventTimeSource` —— 两者刻意分离。
 */
function lastEventResult(r, last, hit) {
  return {
    ok: true,
    lastEventType: typeof last.type === 'string' ? last.type : null,
    lastEventSeq: finiteNum(last.seq),
    frameBytes: r.lastFrameBytes,
    window: r.window,
    framesInWindow: r.framesInWindow,
    ...lastEventResultTime(hit),
  }
}

const lastEventResultTime = (hit) => ({
  lastEventTime: hit ? hit.time : null,
  lastEventTimeSource: hit ? hit.source : null,
})

/** 单条事件可用的"最后活跃时间"：`time` 优先，其次分片事件的 `time0`（取不到有效数值 ⇒ null） */
function pickEventTime(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null
  const t = finiteNum(ev.time)
  if (t !== null) return { time: t, source: 'time' }
  const t0 = finiteNum(ev.time0)
  if (t0 !== null) return { time: t0, source: 'time0' }
  return null
}

/** 从尾往前找**最近**的那条"带可用时间"的事件（不是最早的） */
function lastTimedEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const hit = pickEventTime(events[i])
    if (hit) return hit
  }
  return null
}

/** 会话快照文件的判据（与内核/迁移脚本同一口径：`server/scripts/session-migrate.mjs#isSessionSnapshot`） */
export function isSessionSnapshotFileName(name) {
  return /^session.*\.jsonl\.zstd$/i.test(String(name || '')) && !String(name || '').includes('.bak')
}

/**
 * 从快照文件名解析**格式版本**：`session.v3.jsonl.zstd` → `3`；无版本号的 `session.jsonl.zstd` → `0`。
 *
 * 为什么要这个：同一会话目录下可能同时躺着旧格式快照与当前格式的活日志，
 * 而"取 mtime 最大"在 mtime 被迁移刷平后**没有任何区分力**（详见 `buildSessionFileIndex` 里的实测记录）。
 */
export function snapshotVersionOf(name) {
  const m = /\.v(\d+)\.jsonl\.zstd$/i.exec(String(name || ''))
  return m ? Number(m[1]) : 0
}

/**
 * 建会话文件索引：`Map<sessionId, filePath>`。
 *
 * 结构：`<home>/sessions/<bucket>/<sessionId>/<session 快照文件>`（bucket 名 = cwd 编码）。
 * **为什么用遍历而不是按 `header.cwd` 反推 bucket 名**：bucket 命名规则会漂移
 * （分隔符折叠、非安全字符转义、末尾截断），反推一次漂移就静默失效；遍历一次（~554 个目录）更稳、也更省心。
 * 同一会话目录内有多个匹配文件时（真机实测混有 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`）
 * 取 **mtime 最大**的那个。
 *
 * 不抛：`home` 为空 / `sessions` 不存在 / 某目录读不动 ⇒ 返回空 Map（或已建好的部分）。
 *
 * @returns {Map<string,string>}
 */
export function buildSessionFileIndex(home) {
  const map = new Map()
  try {
    if (!home || typeof home !== 'string') return map
    const sessionsRoot = path.join(home, 'sessions')
    let buckets
    try { buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true }) } catch (_) { return map }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      let sessionDirs
      try { sessionDirs = fs.readdirSync(path.join(sessionsRoot, bucket.name), { withFileTypes: true }) } catch (_) { continue }
      for (const dir of sessionDirs) {
        if (!dir.isDirectory()) continue
        const dirPath = path.join(sessionsRoot, bucket.name, dir.name)
        let files
        try { files = fs.readdirSync(dirPath, { withFileTypes: true }) } catch (_) { continue }
        // ⚠️ 选**版本最高**的快照，而不是 mtime 最大的（2026-09-22 真机实测，这个坑很隐蔽）：
        // 同一会话目录下可能同时存在 `session.jsonl.zstd`（旧格式快照）与 `session.v3.jsonl.zstd`（活日志），
        // 而 Linux 迁移把两者的 mtime 刷成了**同一时刻** ⇒ "取 mtime 最大"在平局时**任选**。
        // 实测就选中了陈旧的那份：它最后事件是 `2026-09-17T05:22:21Z`（seq 1381507），
        // 而 v3 活日志是 `2026-09-22T01:42:24Z`（seq 26766）。
        // 后果最坏的一种：**看起来完全正常**（时间戳合理、帧解得开），但整个会话被判出时间窗，
        // 连带它名下 8 个未闭合子会话一起被漏掉，而日志里没有任何异常可看。
        // 独立佐证 v3 才是活日志：投影缓存里该会话的 `lastPromptAt≈01:41Z`，与 v3 的 `01:42Z` 吻合。
        let best = null
        for (const f of files) {
          if (!f.isFile() || !isSessionSnapshotFileName(f.name)) continue
          const p = path.join(dirPath, f.name)
          let mtimeMs = 0
          try { mtimeMs = fs.statSync(p).mtimeMs } catch (_) { continue }
          const cand = { path: p, mtimeMs, version: snapshotVersionOf(f.name) }
          if (!best
            || cand.version > best.version
            || (cand.version === best.version && cand.mtimeMs > best.mtimeMs)) best = cand
        }
        // 目录名即会话 id（与内核 `sessions/<bucket>/<sessionId>/` 的落盘口径一致）
        if (best) map.set(dir.name, best.path)
      }
    }
  } catch (_) { /* 索引建到一半也不抛：只是 tail 那级少了几个会话，由降级链（lastPromptAt/createdAt）兜住 */ }
  return map
}
