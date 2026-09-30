// ============================================================================
// @local/session-janitor —— 只读 survey 核心
//   结构性 RFC8878 帧解析 + 计数 + 分组（G-A…G-F）+ 双口径预估。
//
// ⚠️ 硬性内存纪律（全部由 J1 服务端实测换来，不要"优化"掉）：
//   · J1 v1（逐帧全量解压）实测把服务器 RSS 顶到 **1.04 GB**，并把内核 VmSwap 从 182 顶到 540 MB；
//     而该机器只有 1740 MB。根因：单个会话里存在**解压后 82.7 MB** 的巨帧，逐帧扫描会持续制造
//     大量"可回收但未被及时回收"的字符串。
//   · J1 结构性探针（只读帧头做帧边界解析 + FCS、不解压）实测只用 **139 MB RSS** ⇒ 这才是在服务器上可行的形态。
//   ⇒ 因此本模块从代码层面**禁止"逐条全量解压"**：
//       ① 内容信号扫描（anyUser / assistantText / hasPath）**默认关闭**（contentProbe=false），
//          未探测的会话标 `contentLevel:'needs-local'`（内容级判定交回本地）;
//       ② 任何解压都同时受「帧级预算 MAX_FCS」与「会话级预算 SESSION_DECODE_BUDGET」约束，
//          并有 HARD_DECODE_CAP 硬顶（任何人传参都越不过）；
//       ③ 唯一整会话解压的例外：**frames <= 2** 的会话（服务端实测这类最大 456,888 B，远小于预算）——
//          G-A（可清理纯空壳）全部落在这一类，故关键分组的判定是完整的;
//       ④ 尾帧探测（为 sources.tail 取「末条带时间事件」，与内核 lastTimedEvent 同语义）受
//          tailWalkMax 帧数上限约束，最多从末尾回溯 12 帧。
//
// 判据 / 分组 / 白名单与 J1（.runtime/migrate/janitor/janitor-survey.mjs v2）**逐条一致**，
// 差别只在"默认不做内容扫描"这一条（见上）。
// 纯只读：不写/删/移任何会话、配置、workspace.json、projcache。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------------------------------------------------------------------------
// RFC8878 结构性帧解析（逐字来自 server/scripts/session-migrate.mjs#parseFrames）
//
// 为什么不能用"扫魔数"：0x28B52FFD 可能巧合地出现在压缩负载内部 ⇒ 魔数计数天然不可信。
// 这里按 Frame_Header_Descriptor → Window_Descriptor → Dictionary_ID → Frame_Content_Size
// → 若干 Block（Block_Header 的 3 字节带 last_block 位与 block_type/size）→ Checksum 逐块走过，
// 得到的 [start,end) 自洽（所有帧首尾相接、Σsize === fileSize）。
// 插件不能 import 仓库外的 server/scripts（symlink 进 node_modules 后相对路径不可解析）⇒ 内联。
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 0xfd2fb528 // buf.readUInt32LE 视角的 0x28 0xB5 0x2F 0xFD

export function parseFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4) throw new Error(`尾部残留 ${buf.length - off} 字节，不是完整帧（offset=${off}）`)
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) {
      throw new Error(`offset=${off} 处不是 zstd 帧魔数（0x${buf.readUInt32LE(off).toString(16)}）`)
    }
    off += 4
    const fhd = buf.readUInt8(off); off += 1
    const fcsFlag = (fhd >> 6) & 0x3
    const singleSegment = (fhd >> 5) & 0x1
    const checksumFlag = (fhd >> 2) & 0x1
    const dictIdFlag = fhd & 0x3
    if (!singleSegment) off += 1 // Window_Descriptor
    off += dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4 // Dictionary_ID
    off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8 // Frame_Content_Size
    let last = false
    while (!last) {
      if (buf.length - off < 3) throw new Error(`frame@${start} 块头被截断（offset=${off}）`)
      const bh = buf.readUInt32LE(off) & 0xffffff
      const blockType = (bh >> 1) & 0x3
      const blockSize = (bh >> 3) & 0x1fffff
      off += 3
      if (blockType === 3) throw new Error(`frame@${start} 出现保留块类型（offset=${off - 3}）`)
      off += blockType === 1 ? 1 : blockSize // RLE 只有 1 字节负载；Raw/Compressed 为 blockSize
      last = (bh & 0x1) === 1
      if (off > buf.length) throw new Error(`frame@${start} 块越界（offset=${off} > ${buf.length}）`)
    }
    if (checksumFlag) off += 4
    if (off > buf.length) throw new Error(`frame@${start} 越界（offset=${off} > ${buf.length}）`)
    frames.push({ start, end: off })
  }
  return frames
}

/** 只读帧头拿「解压后大小」(Frame_Content_Size)；读不到返回 null（不假定） */
export function fcsOf(buf, start) {
  try {
    let off = start + 4
    const fhd = buf.readUInt8(off); off += 1
    const fcsFlag = (fhd >> 6) & 0x3
    const singleSegment = (fhd >> 5) & 0x1
    const dictIdFlag = fhd & 0x3
    if (!singleSegment) off += 1
    off += dictIdFlag === 0 ? 0 : dictIdFlag === 1 ? 1 : dictIdFlag === 2 ? 2 : 4
    if (fcsFlag === 0) return singleSegment ? buf.readUInt8(off) : null
    if (fcsFlag === 1) return buf.readUInt16LE(off) + 256
    if (fcsFlag === 2) return buf.readUInt32LE(off)
    const lo = buf.readUInt32LE(off); const hi = buf.readUInt32LE(off + 4)
    return hi * 4294967296 + lo
  } catch { return null }
}

// ---------------------------------------------------------------------------
// 预算与常量
// ---------------------------------------------------------------------------
export const DEFAULT_LIMITS = Object.freeze({
  // 单帧「解压后大小」上限：超过就跳过该帧（不判定其内容），并标 partial。
  // 任务要求 4–8 MB；取上界 8 MB（服务端单帧最大 82.7 MB ⇒ 巨帧一律被跳过，不会进内存）。
  MAX_FCS: 8 * 1024 * 1024,
  // 单个会话的累计解压预算：超过就停并标 partial。
  SESSION_DECODE_BUDGET: 16 * 1024 * 1024,
  // 硬顶：无论调用方传什么参数都不能越过（"逐条全量解压"在代码层被禁止）。
  HARD_DECODE_CAP: 24 * 1024 * 1024,
  // 尾帧探测最多回溯多少帧
  TAIL_WALK_MAX: 12,
  AGE_DAYS: 30,
})

/** R5 白名单：系统种子（纯控制事件空壳，固定 id） */
export const SEED_IDS = Object.freeze(['session-00000000-0000-4000-8000-000000000001'])

export const isSnapshotName = (n) => /^session.*\.jsonl\.zstd$/i.test(String(n || '')) && !String(n || '').includes('.bak')
export const versionOf = (n) => { const m = /\.v(\d+)\.jsonl\.zstd$/i.exec(String(n || '')); return m ? Number(m[1]) : 0 }

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const pos = (v) => { const n = num(v); return n > 0 ? n : null }
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString())
export const mb = (b) => Math.round((b / 1048576) * 10) / 10

const yieldLoop = () => new Promise((r) => setImmediate(r))

/** 默认 sessions 根：<DSH_HOME>/sessions（与 dsh-adapter 的 resolveDshHome 同源） */
export function defaultSessionsRoot() {
  const home = (process.env && process.env.DSH_HOME) || '/srv/dsh-home'
  return path.join(home, 'sessions')
}

export function defaultWorkspaceRoot() {
  const env = process.env || {}
  return env.DSH_WORKSPACE_ROOT || env.DSH_WORKSPACE || env.DSH_WS_ROOT || '/srv/dsh-workspace'
}

// ---------------------------------------------------------------------------
// 单文件结构扫描
// ---------------------------------------------------------------------------
function scanFile(abs, name, limits, contentProbe, sample) {
  const out = {
    file: name, version: versionOf(name), bytes: 0, mtimeMs: 0, frames: null,
    header: null, headerError: null, parseError: null,
    maxFcs: 0, sumFcs: 0,
    contentScanComplete: true, contentScanStoppedAt: null, decodedFrames: 0, skippedFcsFrames: 0,
    lastEventType: null, lastTime: null, lastTimeSource: null, lastFrameDecoded: false, lastTimeApprox: false,
    firstEventTime: null, firstEventTimeSource: null,
    anyUser: false, realUser: false, userCount: 0,
    anyAssistant: false, assistantText: false, assistantCount: 0,
    hasPath: false, pathCount: 0, title: null, errorTurns: 0,
    probeSkipped: false, contentProbed: false,
    eventTypes: {}, ok: false, error: null,
  }
  let buf
  try { buf = fs.readFileSync(abs) } catch (e) { out.error = 'read: ' + e.message; return out }
  try { out.mtimeMs = fs.statSync(abs).mtimeMs } catch { /* 忽略 */ }
  out.bytes = buf.length
  sample('file-read')

  let rs
  try { rs = parseFrames(buf) } catch (e) { out.parseError = 'parseFrames: ' + e.message; return out }
  out.frames = rs.length

  const fcs = rs.map((r) => fcsOf(buf, r.start))
  out.maxFcs = fcs.reduce((m, x) => (x && x > m ? x : m), 0)
  out.sumFcs = fcs.reduce((a, x) => a + (x || 0), 0)

  // 帧 0 = header（首行 JSON）
  try {
    const f0 = zlib.zstdDecompressSync(buf.subarray(rs[0].start, rs[0].end)).toString('utf8')
    const nl = f0.indexOf('\n')
    out.header = JSON.parse(nl === -1 ? f0 : f0.slice(0, nl))
  } catch (e) { out.headerError = e.message }
  sample('header-decoded')

  const scanText = (text, frameIdx) => {
    const lines = text.split('\n')
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim()
      if (!line) continue
      if (frameIdx === 0 && li === 0) continue // header 行
      let ev; try { ev = JSON.parse(line) } catch { continue }
      const ty = typeof ev.type === 'string' ? ev.type : null
      if (ty) out.eventTypes[ty] = (out.eventTypes[ty] || 0) + 1
      const tv = pos(ev.time); const t0 = pos(ev.time0)
      if (out.firstEventTime === null && (tv !== null || t0 !== null)) { out.firstEventTime = tv !== null ? tv : t0; out.firstEventTimeSource = tv !== null ? 'time' : 'time0' }
      if (ty === 'user/message') { out.anyUser = true; out.userCount++; const k = ev.data && ev.data.source && ev.data.source.kind; if (k === 'user') out.realUser = true }
      else if (ty === 'assistant/message') {
        out.anyAssistant = true; out.assistantCount++
        const d = ev.data || {}
        const c = (d.message && Array.isArray(d.message.content)) ? d.message.content : (Array.isArray(d.content) ? d.content : null)
        if (c && c.some((x) => x && x.type === 'text' && typeof x.text === 'string' && x.text.trim())) out.assistantText = true
      } else if (ty === 'session/title') {
        const d = ev.data || {}
        const v = d.title !== undefined ? d.title : (d.name !== undefined ? d.name : ev.title)
        if (typeof v === 'string' && v && out.title === null) out.title = v
      } else if (ty === 'turn/end') {
        const r = ev.data && ev.data.reason
        if (r && r.kind === 'error') out.errorTurns++
      }
    }
  }

  const budget = Math.min(limits.SESSION_DECODE_BUDGET, limits.HARD_DECODE_CAP)

  // ---- 内容信号（默认关闭；唯一例外：frames<=2 的会话整体解压 —— 它们很小）----
  const fullScan = contentProbe || rs.length <= 2
  if (fullScan) {
    out.contentProbed = true
    let used = 0
    const allSignals = () => out.anyUser && out.assistantText && out.hasPath
    for (let i = 1; i < rs.length; i++) {
      if (allSignals()) { out.contentScanStoppedAt = i; break }
      const f = fcs[i]
      if (f !== null && f > limits.MAX_FCS) { out.skippedFcsFrames++; continue }
      if (f !== null && used + f > budget) { out.contentScanComplete = false; out.contentScanStoppedAt = i; break }
      let text
      try { text = zlib.zstdDecompressSync(buf.subarray(rs[i].start, rs[i].end)).toString('utf8') } catch { out.contentScanComplete = false; continue }
      used += (f !== null ? f : rs[i].end - rs[i].start); out.decodedFrames++
      if (text.indexOf('<path>') >= 0) {
        const pm = text.match(/<path>[\s\S]*?<\/path>/g)
        if (pm) { out.hasPath = true; out.pathCount += pm.length }
      }
      scanText(text, i)
    }
    if (out.skippedFcsFrames > 0) out.contentScanComplete = false
    else if (out.contentScanStoppedAt !== null && out.contentScanStoppedAt < rs.length && !allSignals()) out.contentScanComplete = false
  } else {
    // 内容级判定交回本地：标 partial，不做内容扫描
    out.probeSkipped = true
    out.contentScanComplete = false
  }
  sample('content-phase')

  // ---- 尾帧探测（为 sources.tail 取「末条带时间事件」；内核 lastTimedEvent 同语义）----
  // 只解压，不做内容统计；受 tailWalkMax 帧数 + 帧级预算约束。
  {
    let used = 0
    const lo = Math.max(0, rs.length - 1 - limits.TAIL_WALK_MAX)
    for (let i = rs.length - 1; i >= lo; i--) {
      if (i === 0) continue
      const f = fcs[i]
      if (f !== null && f > limits.MAX_FCS) { if (i === rs.length - 1) out.lastTimeApprox = true; continue }
      if (f !== null && used + f > budget) { if (i === rs.length - 1) out.lastTimeApprox = true; break }
      let text
      try { text = zlib.zstdDecompressSync(buf.subarray(rs[i].start, rs[i].end)).toString('utf8') }
      catch { if (i === rs.length - 1) out.lastTimeApprox = true; continue }
      used += (f !== null ? f : rs[i].end - rs[i].start)
      if (i === rs.length - 1) out.lastFrameDecoded = true
      const lines = text.split('\n')
      let foundType = null
      for (let li = lines.length - 1; li >= 0; li--) {
        const s = lines[li].trim(); if (!s) continue
        try { const ev = JSON.parse(s); if (typeof ev.type === 'string') { foundType = ev.type } break } catch { /* 继续 */ }
      }
      if (i === rs.length - 1 && foundType) out.lastEventType = foundType
      let hit = null
      for (let li = lines.length - 1; li >= 0; li--) {
        const s = lines[li].trim(); if (!s) continue
        let ev; try { ev = JSON.parse(s) } catch { continue }
        const tv = pos(ev.time); const t0 = pos(ev.time0)
        if (tv !== null || t0 !== null) { hit = { time: tv !== null ? tv : t0, source: tv !== null ? 'time' : 'time0' }; break }
      }
      if (hit) { out.lastTime = hit.time; out.lastTimeSource = hit.source; break }
    }
  }
  sample('tail-phase')

  out.ok = out.frames !== null
  return out
}

// ---------------------------------------------------------------------------
// survey 主流程
// ---------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {string} [opts.sessionsRoot] 默认 <DSH_HOME>/sessions
 * @param {number} [opts.ageDays]      默认 30
 * @param {number} [opts.limit]        只扫前 N 个会话目录（0=全量），便于快速自检
 * @param {boolean}[opts.contentProbe] 默认 false（内容信号扫描；服务端**不建议**开启 —— 见文件头内存纪律）
 * @param {number} [opts.maxFcs]       帧级预算（上限 HARD_DECODE_CAP 之内）
 * @param {number} [opts.sessionDecodeBudget] 会话级预算
 * @returns {Promise<object>} report
 */
export async function runSurvey(opts) {
  const o = opts || {}
  const limits = {
    MAX_FCS: Math.min(Number(o.maxFcs) > 0 ? Number(o.maxFcs) : DEFAULT_LIMITS.MAX_FCS, DEFAULT_LIMITS.HARD_DECODE_CAP),
    SESSION_DECODE_BUDGET: Math.min(Number(o.sessionDecodeBudget) > 0 ? Number(o.sessionDecodeBudget) : DEFAULT_LIMITS.SESSION_DECODE_BUDGET, DEFAULT_LIMITS.HARD_DECODE_CAP),
    HARD_DECODE_CAP: DEFAULT_LIMITS.HARD_DECODE_CAP,
    TAIL_WALK_MAX: DEFAULT_LIMITS.TAIL_WALK_MAX,
  }
  const contentProbe = o.contentProbe === true
  const AGE_DAYS = Number(o.ageDays) > 0 ? Number(o.ageDays) : DEFAULT_LIMITS.AGE_DAYS
  const SESSIONS_ROOT = o.sessionsRoot ? String(o.sessionsRoot) : defaultSessionsRoot()
  const LIMIT = Number(o.limit) > 0 ? Math.floor(Number(o.limit)) : 0
  const NOW = Number.isFinite(o.now) ? Number(o.now) : Date.now()

  const memBefore = process.memoryUsage()
  let peakRss = memBefore.rss
  const sample = () => { const r = process.memoryUsage(); if (r.rss > peakRss) peakRss = r.rss }

  const buckets = []
  const sessionDirs = []
  const unreadableDirs = []
  const t0 = Date.now()
  try {
    for (const d of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) if (d.isDirectory()) buckets.push(d.name)
  } catch (e) {
    return { ok: false, error: 'read: ' + e.message, sessionsRoot: SESSIONS_ROOT }
  }
  for (const b of buckets.slice().sort()) {
    const bdir = path.join(SESSIONS_ROOT, b)
    let entries
    try { entries = fs.readdirSync(bdir, { withFileTypes: true }) } catch (e) { unreadableDirs.push({ dir: bdir, error: e.message }); continue }
    for (const e of entries.slice().sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.isDirectory()) sessionDirs.push({ bucket: b, sessionId: e.name, dir: path.join(bdir, e.name) })
    }
  }
  const DIRS = LIMIT > 0 ? sessionDirs.slice(0, LIMIT) : sessionDirs

  const globalEventTypes = {}
  const scanStats = { filesScanned: 0, framesDecoded: 0, framesSkippedFcs: 0, partialFiles: 0, parseFailures: 0 }

  const raw = []
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i]
    let files = []
    let hasLock = false
    try {
      for (const f of fs.readdirSync(d.dir, { withFileTypes: true })) {
        if (f.isFile() && f.name === 'session.lock') hasLock = true
        if (f.isFile() && isSnapshotName(f.name)) files.push(f.name)
      }
    } catch (e) { raw.push({ sessionId: d.sessionId, bucket: d.bucket, files: [], hasLock: false, scanned: [], dirError: e.message }); continue }
    // 活日志那份：版本最高；并列取 mtime 最大（与内核 buildSessionFileIndex 口径一致）
    const withM = files.map((fn) => ({ fn, v: versionOf(fn), m: (() => { try { return fs.statSync(path.join(d.dir, fn)).mtimeMs } catch { return 0 } })() }))
    withM.sort((a, b) => (b.v - a.v) || (b.m - a.m) || a.fn.localeCompare(b.fn))
    const scanned = []
    for (const x of withM) {
      const s = scanFile(path.join(d.dir, x.fn), x.fn, limits, contentProbe, sample)
      scanned.push(s)
      scanStats.filesScanned++
      scanStats.framesDecoded += s.decodedFrames + (s.frames && s.frames > 0 ? 1 : 0) // +1 = header
      scanStats.framesSkippedFcs += s.skippedFcsFrames
      scanStats.parseFailures += s.parseError ? 1 : 0
      if (s.contentScanComplete === false && s.frames > 2) scanStats.partialFiles++
      for (const [k, v] of Object.entries(s.eventTypes)) globalEventTypes[k] = (globalEventTypes[k] || 0) + v
    }
    raw.push({ sessionId: d.sessionId, bucket: d.bucket, files: withM.map((x) => x.fn), hasLock, scanned })
    sample()
    // 让出事件循环：survey 跑在**内核进程内**，长时间同步扫描会卡住内核的请求处理。
    // 实测（并发探针 /adapter/api/hotplug）：空载中位 0.20s；每 16 个目录让出一次时中位 0.64s。
    // 收紧到每 4 个目录让出一次，把"单次阻塞窗口"压到 4 个目录的读盘量（大文件 57 MB 的单次
    // readFileSync 仍无法避免 —— 但那是单次、且远小于 J1 v1 的逐帧全量解压）。
    if ((i + 1) % 4 === 0) await yieldLoop()
  }
  await yieldLoop()

  // ---------------- 合并成「会话记录」 ----------------
  const sessions = []
  for (const r of raw) {
    const sc = r.scanned || []
    const active = sc.length ? sc[0] : null
    const any = (f) => sc.some((s) => s[f])
    const sum = (f) => sc.reduce((a, s) => a + (s[f] || 0), 0)
    const header = active ? active.header : null
    const titles = [...new Set(sc.map((s) => s.title).filter((x) => x))]
    const parent = header ? (header.parentSession || header.parentSessionId || null) : null
    const createdAt = header ? num(header.createdAt) : null
    const firstEventTime = active ? active.firstEventTime : null
    sessions.push({
      sessionId: r.sessionId,
      normId: r.sessionId.startsWith('session-') ? r.sessionId.slice('session-'.length) : r.sessionId,
      bucket: r.bucket,
      files: r.files, fileCount: r.files.length,
      hasLock: !!r.hasLock, dirError: r.dirError || null,
      bytes: sum('bytes'), bytesActive: active ? active.bytes : 0,
      frames: sum('frames'), framesActive: active ? active.frames : null,
      activeFile: active ? active.file : null,
      headerMissing: !header,
      delegationDepth: header ? num(header.delegationDepth) : null,
      origin: header ? (header.origin || null) : null,
      parentSession: parent,
      agentPreset: header ? (header.agentPreset || null) : null,
      createdAt, createdAtISO: iso(createdAt),
      firstEventTime, firstEventTimeISO: iso(firstEventTime),
      ageDaysByFirstEvent: firstEventTime !== null ? Math.round(((NOW - firstEventTime) / 86400000) * 100) / 100 : null,
      ageDaysByCreatedAt: createdAt !== null ? Math.round(((NOW - createdAt) / 86400000) * 100) / 100 : null,
      lastEventTime: active ? active.lastTime : null,
      lastEventType: active ? active.lastEventType : null,
      lastEventTimeSource: active ? active.lastTimeSource : null,
      lastTimeApprox: active ? !!active.lastTimeApprox : null,
      activeFileMaxFcs: active ? active.maxFcs : null,
      contentProbed: sc.every((s) => s.contentProbed),
      contentScanComplete: sc.every((s) => s.contentScanComplete),
      skippedFcsFrames: sum('skippedFcsFrames'),
      anyUser: any('anyUser'), realUser: any('realUser'), userCount: sum('userCount'),
      anyAssistant: any('anyAssistant'), assistantText: any('assistantText'), assistantCount: sum('assistantCount'),
      hasPath: any('hasPath'), pathCount: sum('pathCount'), errorTurns: sum('errorTurns'),
      titles, title: titles.length ? titles[0] : null,
      parseError: active ? active.parseError : null,
    })
  }
  const sessionsById = new Map(sessions.map((s) => [s.sessionId, s]))
  const byNorm = new Map()
  for (const s of sessions) if (!byNorm.has(s.normId)) byNorm.set(s.normId, s)

  // ---------------- 判据（R5 保守起点，与 J1 一致） ----------------
  const parentRefs = new Set()
  const danglingParentRefs = []
  for (const s of sessions) {
    if (!s.parentSession) continue
    const pid = String(s.parentSession); parentRefs.add(pid)
    const p = sessionsById.get(pid) || byNorm.get(pid.startsWith('session-') ? pid.slice(8) : pid)
    if (!p) danglingParentRefs.push({ child: s.sessionId, parentSession: pid })
  }
  for (const s of sessions) {
    const c = {}
    c.framesLe2 = s.frames !== null && s.frames <= 2
    c.noUser = !s.anyUser
    c.noAssistantText = !s.assistantText
    c.noPath = !s.hasPath
    c.noLock = !s.hasLock
    c.notParent = !parentRefs.has(s.sessionId) && !parentRefs.has(s.normId)
    c.ageGt30d_byFirstEvent = s.ageDaysByFirstEvent !== null && s.ageDaysByFirstEvent > AGE_DAYS
    c.ageGt30d_byCreatedAt = s.ageDaysByCreatedAt !== null && s.ageDaysByCreatedAt > AGE_DAYS
    c.notSeed = !SEED_IDS.includes(s.sessionId) && !SEED_IDS.includes(s.normId)
    c.contentScanComplete = s.contentScanComplete
    const isEmptyCore = c.framesLe2 && c.noUser && c.noAssistantText && c.noPath && c.contentScanComplete
    s.conds = c
    s.isEmptyCore = isEmptyCore
    s.isShellFrames = c.framesLe2
    s.hasContent = s.assistantText || s.realUser || s.hasPath
    s.isSeed = !c.notSeed
    s.isParent = !c.notParent
    s.removableEmptyShell = isEmptyCore && c.noLock && c.notParent && c.ageGt30d_byFirstEvent && c.notSeed
    s.excludeReasons = []
    if (s.isShellFrames && !s.removableEmptyShell) {
      if (!c.contentScanComplete) s.excludeReasons.push('content-scan-partial')
      if (!c.noLock) s.excludeReasons.push('has-lock')
      if (!c.notParent) s.excludeReasons.push('is-parentSession')
      if (!c.ageGt30d_byFirstEvent) s.excludeReasons.push(s.ageDaysByFirstEvent === null ? 'age-unknown' : 'age<=30d')
      if (!c.noUser) s.excludeReasons.push('has-user/message(incl-plugin)')
      if (!c.noAssistantText) s.excludeReasons.push('has-assistant-text')
      if (!c.noPath) s.excludeReasons.push('has-<path>')
      if (!c.notSeed) s.excludeReasons.push('system-seed-whitelist')
    }
    // 内容级判定是否「已探测」
    s.contentLevel = (s.isShellFrames || s.contentProbed) ? 'probed' : 'needs-local'
  }

  // ---------------- 分组 ----------------
  // 互斥主划分：G_E 系统种子 > G_D 父会话 > G_A 纯空壳 > G_B 空壳但被排除 > G_C 有内容 > G_F 残余
  // ⚠️ 默认（contentProbe=false）下，frames>2 的会话未做内容判定 ⇒ 单独归入 G_C_or_F（内容级判定需本地补），
  //    绝不把"未判定"当成"无内容"（那会把 G_C 误并入 G_F）。
  const groupOf = (s) => (
    s.isSeed ? 'G_E'
      : s.isParent ? 'G_D'
        : s.removableEmptyShell ? 'G_A'
          : s.isShellFrames ? 'G_B'
            : (s.contentProbed ? (s.hasContent ? 'G_C' : 'G_F') : 'G_C_or_F')
  )
  for (const s of sessions) s.group = groupOf(s)

  const sumf = (l, f) => l.reduce((a, s) => a + (s[f] || 0), 0)
  function agg(list) {
    return {
      sessions: list.length, files: sumf(list, 'fileCount'),
      bytes: sumf(list, 'bytes'), frames: sumf(list, 'frames'),
      framesActiveOnly: sumf(list, 'framesActive'),
      withLock: list.filter((s) => s.hasLock).length,
      hasUserAny: list.filter((s) => s.anyUser).length,
      hasRealUser: list.filter((s) => s.realUser).length,
      hasAssistantText: list.filter((s) => s.assistantText).length,
      hasPath: list.filter((s) => s.hasPath).length,
      contentProbed: list.filter((s) => s.contentProbed).length,
      contentScanComplete: list.filter((s) => s.contentScanComplete).length,
      tailUsable: list.filter((s) => s.lastEventTime !== null).length,
      tailTime: list.filter((s) => s.lastEventTimeSource === 'time').length,
      tailTime0: list.filter((s) => s.lastEventTimeSource === 'time0').length,
      tailTimeApprox: list.filter((s) => s.lastTimeApprox).length,
    }
  }
  const GROUP_KEYS = ['G_A', 'G_B', 'G_C', 'G_F', 'G_D', 'G_E', 'G_C_or_F']
  const G = {}; for (const k of GROUP_KEYS) G[k] = sessions.filter((s) => s.group === k)
  const groups = {}; for (const k of GROUP_KEYS) groups[k] = agg(G[k])

  const shellSpace = sessions.filter((s) => s.isShellFrames)
  const shellExclusionHist = {}
  for (const s of shellSpace) {
    if (s.removableEmptyShell) { shellExclusionHist['(可清理 G-A)'] = (shellExclusionHist['(可清理 G-A)'] || 0) + 1; continue }
    for (const r of s.excludeReasons) shellExclusionHist[r] = (shellExclusionHist[r] || 0) + 1
  }

  // ---------------- 双口径预估（清掉 G-A 之后） ----------------
  const totalBefore = sessions.length
  const framesBefore = sumf(sessions, 'frames')
  const bytesBefore = sumf(sessions, 'bytes')
  const filesBefore = sumf(sessions, 'fileCount')
  const tailUsableBefore = sessions.filter((s) => s.lastEventTime !== null).length
  const tailTimeBefore = sessions.filter((s) => s.lastEventTimeSource === 'time').length
  const tailTime0Before = sessions.filter((s) => s.lastEventTimeSource === 'time0').length
  const ga = G.G_A
  const gaTail = ga.filter((s) => s.lastEventTime !== null).length
  const estimate = {
    note: '双口径：total/indexSize = 内核列出的会话数 / 会话文件索引大小；sources.tail = 一级预筛里「活跃时间取自日志尾部」的条数。⚠ 只看 total 会误导：E1 实测砍 25% 会话而 sources.tail 不变（砍掉的是 subagentSkipped，从未计入 sources）。',
    beforeRemoveGA: {
      total: totalBefore, indexSize: totalBefore,
      sourcesTail: tailUsableBefore, sourcesTail_time: tailTimeBefore, sourcesTail_time0: tailTime0Before,
      frames: framesBefore, framesActiveOnly: sumf(sessions, 'framesActive'),
      bytes: bytesBefore, files: filesBefore,
    },
    afterRemoveGA: {
      total: totalBefore - ga.length, indexSize: totalBefore - ga.length,
      sourcesTail: tailUsableBefore - gaTail,
      sourcesTail_time: tailTimeBefore - ga.filter((s) => s.lastEventTimeSource === 'time').length,
      sourcesTail_time0: tailTime0Before - ga.filter((s) => s.lastEventTimeSource === 'time0').length,
      frames: framesBefore - sumf(ga, 'frames'),
      framesActiveOnly: sumf(sessions, 'framesActive') - sumf(ga, 'framesActive'),
      bytes: bytesBefore - sumf(ga, 'bytes'),
      files: filesBefore - sumf(ga, 'fileCount'),
    },
    delta: {
      sessions: -ga.length, total: -ga.length, indexSize: -ga.length,
      sourcesTail: -gaTail,
      frames: -sumf(ga, 'frames'), framesActiveOnly: -sumf(ga, 'framesActive'),
      bytes: -sumf(ga, 'bytes'), files: -sumf(ga, 'fileCount'),
    },
    memoryImpact: '⚠ 不能从这些数字直接推出内存影响（M1 实测：稳态不是问题，只有启动瞬时是；E1 已证明"砍 25% 会话对启动内存曲线几乎无影响"）。total/indexSize 是条目数；sources.tail 是"每次一条尾窗读"的次数；堆峰值主要来自 listSessions 的 header 全量驻留 + 建索引 + 尾窗临时缓冲，比例关系**未实测**。',
  }

  const candidates = ga.map((s) => ({
    sessionId: s.sessionId, files: s.files, bytes: s.bytes, frames: s.frames,
    createdAtISO: s.createdAtISO, firstEventTimeISO: s.firstEventTimeISO, ageDaysByFirstEvent: s.ageDaysByFirstEvent,
    lastEventTime: s.lastEventTime, lastEventTimeSource: s.lastEventTimeSource, title: s.title, lastEventType: s.lastEventType,
  })).sort((a, b) => b.bytes - a.bytes)

  const crosscheck = {
    serverSessions: sessions.length, serverFiles: filesBefore,
    serverFramesMerged: framesBefore, serverFramesActiveOnly: sumf(sessions, 'framesActive'),
    serverBytes: bytesBefore,
    dirsWithTwoFiles: sessions.filter((s) => s.fileCount > 1).length,
    namingBreakdown: { 'session-<uuid>': sessions.filter((s) => s.sessionId.startsWith('session-')).length, '<uuid>': sessions.filter((s) => !s.sessionId.startsWith('session-')).length },
    v3Sessions: sessions.filter((s) => s.files.some((f) => versionOf(f) >= 3)).length,
    delegationDepthGt0: sessions.filter((s) => s.delegationDepth !== null && Number(s.delegationDepth) > 0).length,
    originSubagent: sessions.filter((s) => s.origin === 'subagent').length,
    withParentSession: sessions.filter((s) => !!s.parentSession).length,
    distinctParentRefs: parentRefs.size, danglingParentRefs,
    framesLe2: shellSpace.length,
    framesGe3: sessions.filter((s) => s.frames !== null && s.frames > 2).length,
    withTitle: sessions.filter((s) => !!s.title).length,
    withRealUser: sessions.filter((s) => s.realUser).length,
    withAnyUser: sessions.filter((s) => s.anyUser).length,
    withAssistantText: sessions.filter((s) => s.assistantText).length,
    withPath: sessions.filter((s) => s.hasPath).length,
    withErrorTurns: sessions.filter((s) => s.errorTurns > 0).length,
    parseFailures: scanStats.parseFailures, headerMissing: sessions.filter((s) => s.headerMissing).length,
    contentScanIncomplete: sessions.filter((s) => !s.contentScanComplete).length,
    contentLevelNeedsLocal: sessions.filter((s) => s.contentLevel === 'needs-local').length,
    unreadableDirs,
  }

  const memAfter = process.memoryUsage()
  const report = {
    ok: true,
    meta: {
      runAt: new Date().toISOString(),
      scanner: '@local/session-janitor survey-core (read-only, structural-first)',
      sessionsRoot: SESSIONS_ROOT, ageDays: AGE_DAYS, limit: LIMIT, full: LIMIT === 0,
      contentProbe,
      node: process.version,
      durationSec: Math.round((Date.now() - t0) / 100) / 10,
      limits: { MAX_FCS_bytes: limits.MAX_FCS, SESSION_DECODE_BUDGET_bytes: limits.SESSION_DECODE_BUDGET, HARD_DECODE_CAP_bytes: limits.HARD_DECODE_CAP, TAIL_WALK_MAX: limits.TAIL_WALK_MAX },
      scanStats: { ...scanStats, partialFiles: scanStats.partialFiles },
    },
    // 进程 RSS（跑在内核进程内 ⇒ 绝对值含内核基线；看**增量**）
    process: {
      rssBeforeMB: mb(memBefore.rss), rssPeakMB: mb(peakRss), rssAfterMB: mb(memAfter.rss),
      rssDeltaPeakMB: mb(peakRss - memBefore.rss),
      heapUsedBeforeMB: mb(memBefore.heapUsed), heapUsedPeakNote: 'heapUsed 由 V8 管理，这里给 before/after',
      heapUsedAfterMB: mb(memAfter.heapUsed),
      externalBeforeMB: mb(memBefore.external), externalAfterMB: mb(memAfter.external),
    },
    criteria: {
      r5: 'frames<=2 AND 无 user/message(含插件注入) AND 无 assistant/message 文本 AND 无 <path> AND 无 session.lock AND 不是任何会话的 parentSession AND age(firstEventTime)>30d',
      whitelist: [...SEED_IDS],
      framesSemantics: 'frames = 同 sessionId 两份文件求和（J1 口径）；framesActive = 活日志那份（版本最高、并列取 mtime 最大，与内核 buildSessionFileIndex 一致）',
      ageSemantics: 'firstEvent（活日志首个带时间事件）优先；createdAt（header）作对照。G-A 用 firstEvent 口径。',
      contentCaveat: 'contentProbe=false ⇒ 内容信号（user/assistant/<path>）仅对 **frames<=2** 的会话完整扫描（G-A/G-B 判定完整）；frames>2 的会话内容级判定标 needs-local，归入 G_C_or_F。',
    },
    totals: { sessions: sessions.length, files: filesBefore, bytes: bytesBefore, framesMerged: framesBefore, framesActiveOnly: sumf(sessions, 'framesActive'), buckets, limited: LIMIT > 0 },
    groups,
    groupMembers: Object.fromEntries(GROUP_KEYS.map((k) => [k, G[k].map((s) => s.sessionId).sort()])),
    shellSpace: { count: shellSpace.length, agg: agg(shellSpace), exclusionHistogram: shellExclusionHist },
    estimate,
    cleanupCandidates: { criteria: 'R5 保守起点（G-A：纯空壳，可自动清理）', count: candidates.length, candidates },
    crosscheck, globalEventTypes,
    contentLevel: {
      status: contentProbe ? 'probed' : 'needs-local',
      needsLocalSessions: sessions.filter((s) => s.contentLevel === 'needs-local').length,
      note: contentProbe ? '本轮已做内容扫描（服务端不建议；RSS 见 meta）' : '内容级判定需本地补（本地用 .runtime/migrate/janitor/janitor-survey-local.mjs 全量版）',
    },
  }
  return report
}
