// ============================================================================
// @local/session-janitor —— reap / restore 核心（**纯逻辑，不 import @deepseek-ai/dsh-tools**）
//
// 为什么单独成模块：与 lib/survey.js 同款理由 —— 便于本地（无内核）单测。
//   · 这里的每一条护栏都能用合成会话在本地逐条证伪/证实（见 .runtime/migrate/janitor/j5/）。
//   · 身份（调用方是谁）由 lib/index.js 从**不可伪造的** exec.agent 取得后**注入**本模块；
//     本模块只做"给定的身份能不能干这件事"的判定，不自己取身份。
//
// 铁律（用户 2026-09-24 对「agent 工作完成后清理自己的子代理」用例的约束）：
//   🚫 只允许删子会话（delegationDepth>0 或 parentSession 存在 或 origin=='subagent'）—— 绝不能删主会话
//   🚫 只允许删"自己派生的"（parentSession == 调用方会话 id）
//   ✅ 必须已完成（有 turn/end 且 reason.kind ∈ {completed,error}；末边界必须是 turn/end）
//   ✅ 必须无 session.lock（内核可能正在写）
//   ✅ 默认 dryRun:true；confirm:true 才真做
//   ✅ 进回收区（rename，同分区原子），不是 rm
//   ⚠️ fail-closed：**证不出"已完成"就不动**（解压预算不够 ⇒ 跳过，不算 eligible）
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { parseFrames, fcsOf, isSnapshotName, versionOf, SEED_IDS, defaultSessionsRoot } from './survey.js'

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const _msg = (e) => String((e && e.message) || e)

export function defaultRecycleRoot() {
  const home = (process.env && process.env.DSH_HOME) || '/srv/dsh-home'
  return path.join(home, '_janitor-recycle')
}
/** 账本放在 <DSH_HOME>/_janitor/（插件自有状态目录，**不在回收区内**，不碰 E1 遗留的 378 条） */
export function defaultLedgerPath() {
  const home = (process.env && process.env.DSH_HOME) || '/srv/dsh-home'
  return path.join(home, '_janitor', 'reap-ledger.json')
}

/** 认为"已闭合"的 turn/end 原因（interrupted/aborted 不算完成） */
export const CLOSED_KINDS = Object.freeze(['completed', 'error'])

const DEFAULT_LIMITS = Object.freeze({
  MAX_FCS: 8 * 1024 * 1024,
  SESSION_DECODE_BUDGET: 16 * 1024 * 1024,
})

export function sha256File(abs) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(abs))
  return h.digest('hex')
}

/** 目录指纹：逐文件 sha256 + 由 (name:sha256) 排序后合成的 dirHash */
export function hashDir(dir) {
  const files = []
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile()) continue
    const abs = path.join(dir, f.name)
    let h = null; let bytes = 0
    try { h = sha256File(abs); bytes = fs.statSync(abs).size } catch (_) { h = null }
    files.push({ name: f.name, sha256: h, bytes })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  const dirHash = crypto.createHash('sha256').update(files.map((x) => `${x.name}:${x.sha256}`).join('\n')).digest('hex')
  return { files, dirHash, fileCount: files.length }
}

/**
 * 打开一个会话目录，取 header + 闭合状态。只解压"活日志"那一份，且受帧级/会话级预算约束。
 * @returns {object} 见下方字段
 */
export function inspectSession(dir, limitsIn) {
  const limits = { MAX_FCS: (limitsIn && limitsIn.MAX_FCS) || DEFAULT_LIMITS.MAX_FCS, SESSION_DECODE_BUDGET: (limitsIn && limitsIn.SESSION_DECODE_BUDGET) || DEFAULT_LIMITS.SESSION_DECODE_BUDGET }
  const out = {
    dir, readError: null, files: [], activeFile: null, hasLock: false,
    header: null, headerError: null, frames: null, parseError: null,
    lastBoundary: null, lastTurnEndKind: null, turnEnds: 0, turnStarts: 0,
    lastEventTime: null, decodedFrames: 0, budgetExceeded: false, completionProbed: false,
  }
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { out.readError = _msg(e); return out }
  const snaps = []
  for (const f of entries) {
    if (!f.isFile()) continue
    if (f.name === 'session.lock') out.hasLock = true
    if (isSnapshotName(f.name)) {
      let m = 0; try { m = fs.statSync(path.join(dir, f.name)).mtimeMs } catch (_) {}
      snaps.push({ fn: f.name, v: versionOf(f.name), m })
    }
  }
  out.files = snaps.map((s) => s.fn)
  if (!snaps.length) { out.readError = 'no session snapshot file'; return out }
  snaps.sort((a, b) => (b.v - a.v) || (b.m - a.m) || a.fn.localeCompare(b.fn))
  out.activeFile = snaps[0].fn

  const abs = path.join(dir, snaps[0].fn)
  let buf
  try { buf = fs.readFileSync(abs) } catch (e) { out.readError = 'read: ' + _msg(e); return out }
  let rs
  try { rs = parseFrames(buf) } catch (e) { out.parseError = 'parseFrames: ' + _msg(e); return out }
  out.frames = rs.length

  try {
    const f0 = zlib.zstdDecompressSync(buf.subarray(rs[0].start, rs[0].end)).toString('utf8')
    const nl = f0.indexOf('\n')
    out.header = JSON.parse(nl === -1 ? f0 : f0.slice(0, nl))
  } catch (e) { out.headerError = _msg(e) }

  const budget = limits.SESSION_DECODE_BUDGET
  let used = 0
  let sawEnd = false
  for (let i = rs.length - 1; i >= 1; i--) {
    const f = fcsOf(buf, rs[i].start)
    if (f !== null && f > limits.MAX_FCS) { out.budgetExceeded = true; break }
    if (f !== null && used + f > budget) { out.budgetExceeded = true; break }
    let text
    try { text = zlib.zstdDecompressSync(buf.subarray(rs[i].start, rs[i].end)).toString('utf8') }
    catch { continue }
    used += (f !== null ? f : rs[i].end - rs[i].start); out.decodedFrames++
    const lines = text.split('\n')
    for (let li = lines.length - 1; li >= 0; li--) {
      const s = lines[li].trim(); if (!s) continue
      let ev; try { ev = JSON.parse(s) } catch { continue }
      const ty = typeof ev.type === 'string' ? ev.type : null
      const tv = num(ev.time); const t0 = num(ev.time0)
      if (out.lastEventTime === null && (tv !== null || t0 !== null)) out.lastEventTime = tv !== null ? tv : t0
      if (ty === 'turn/end') {
        out.turnEnds++
        const r = ev.data && ev.data.reason
        if (out.lastBoundary === null) { out.lastBoundary = 'end'; out.lastTurnEndKind = (r && typeof r.kind === 'string') ? r.kind : null }
        sawEnd = true
      } else if (ty === 'turn/start') {
        out.turnStarts++
        if (out.lastBoundary === null) out.lastBoundary = 'start'
      }
    }
    // 已经看到"末边界 = turn/end"（从尾往前遇到的第一个边界），且已拿到 lastEventTime ⇒ 够判断了
    if (sawEnd && out.lastBoundary === 'end' && out.lastEventTime !== null) break
  }
  out.completionProbed = !out.budgetExceeded
  if (out.budgetExceeded) { out.lastBoundary = null; out.lastTurnEndKind = null }
  return out
}

/** 子会话判定（与 dsh-adapter resume/scan.js 同判据） */
export function isSubagentHeader(header) {
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (header.parentSession || header.parentSessionId) return true
  const d = num(header.delegationDepth)
  return d !== null && d > 0
}

function listBucketDirs(sessionsRoot) {
  const out = []
  try {
    for (const d of fs.readdirSync(sessionsRoot, { withFileTypes: true })) if (d.isDirectory()) out.push(d.name)
  } catch (_) {}
  return out.sort()
}

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {})
}

/** 身份判定（唯一入口）：调用方身份要么来自不可伪造的 exec.agent，要么来自 HTTP 共享 secret。attach_sessions 也复用本入口。 */
export function authorize({ callerSessionId, httpAuthorized, parentSessionId }) {
  const caller = callerSessionId ? String(callerSessionId).trim() : ''
  if (caller) {
    if (parentSessionId && caller !== parentSessionId) {
      return { ok: false, code: 'PARENT_MISMATCH', message: `PARENT_MISMATCH：调用方 ${caller} 只能清理自己派生的子会话（请求的 parentSessionId=${parentSessionId}）`, via: 'tool:caller', caller }
    }
    return { ok: true, via: 'tool:caller', caller }
  }
  if (httpAuthorized === true) return { ok: true, via: 'http:secret', caller: null }
  return { ok: false, code: 'UNAUTHORIZED', message: 'UNAUTHORIZED：既没有 exec.agent 身份，也没有有效的 x-janitor-token（fail-closed）', via: null }
}

/**
 * reap：只清「调用方自己派生的 ∧ 已完成的 ∧ 无 lock ∧ 非主会话」的子会话 → 回收区。
 */
export function runReap(opts) {
  const o = opts || {}
  const sessionsRoot = o.sessionsRoot ? String(o.sessionsRoot) : defaultSessionsRoot()
  const recycleRoot = o.recycleRoot ? String(o.recycleRoot) : defaultRecycleRoot()
  const ledgerPath = o.ledgerPath ? String(o.ledgerPath) : defaultLedgerPath()
  const parentSessionId = o.parentSessionId ? String(o.parentSessionId).trim() : ''
  const dryRun = o.dryRun !== false
  const confirm = o.confirm === true
  const olderThanMinutes = Number(o.olderThanMinutes) > 0 ? Number(o.olderThanMinutes) : 0
  const NOW = Number.isFinite(o.now) ? Number(o.now) : Date.now()

  if (!parentSessionId) return fail('PARENT_REQUIRED', 'PARENT_REQUIRED：必须给出 parentSessionId（工具路径默认取 exec.agent.id）')

  const auth = authorize({ callerSessionId: o.callerSessionId, httpAuthorized: o.httpAuthorized, parentSessionId })
  if (!auth.ok) return Object.assign({ action: 'janitor_reap_subagents', parentSessionId, dryRun }, auth)
  if (!dryRun && !confirm) return fail('CONFIRM_REQUIRED', 'CONFIRM_REQUIRED：dryRun:false 必须同时 confirm:true', { action: 'janitor_reap_subagents', parentSessionId, dryRun })

  if (!fs.existsSync(sessionsRoot)) return fail('SESSIONS_ROOT_MISSING', 'sessions 根不存在: ' + sessionsRoot)

  const limits = { MAX_FCS: DEFAULT_LIMITS.MAX_FCS, SESSION_DECODE_BUDGET: DEFAULT_LIMITS.SESSION_DECODE_BUDGET }
  const eligible = []
  const skipped = []
  const skip = (sessionId, reason, extra) => skipped.push(Object.assign({ sessionId, reason }, extra || {}))

  for (const bucket of listBucketDirs(sessionsRoot)) {
    const bdir = path.join(sessionsRoot, bucket)
    for (const e of fs.readdirSync(bdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const sessionId = e.name
      const dir = path.join(bdir, sessionId)
      const info = inspectSession(dir, limits)
      if (info.readError) { skip(sessionId, 'dir-read-error', { detail: info.readError }); continue }
      const h = info.header
      const parent = h ? (h.parentSession || h.parentSessionId || null) : null
      const base = { sessionId, bucket, parentSession: parent, delegationDepth: h ? num(h.delegationDepth) : null, origin: h ? (h.origin || null) : null }

      // ① 硬红线：主会话绝不删
      if (!isSubagentHeader(h)) { skip(sessionId, 'not-subagent(main-session)', base); continue }
      // ② 系统种子
      if (SEED_IDS.includes(sessionId)) { skip(sessionId, 'system-seed', base); continue }
      // ③ 只删自己派生的
      if (String(parent || '') !== parentSessionId) { skip(sessionId, 'not-own-child', base); continue }
      // ④ 无 lock
      if (info.hasLock) { skip(sessionId, 'has-lock', base); continue }
      // ⑤ 必须已完成 + 可证
      if (!info.completionProbed) { skip(sessionId, 'completion-unprobed(fail-closed)', base); continue }
      if (info.lastBoundary !== 'end') { skip(sessionId, 'incomplete(no turn/end at tail boundary)', Object.assign({ lastBoundary: info.lastBoundary }, base)); continue }
      if (!CLOSED_KINDS.includes(String(info.lastTurnEndKind || ''))) { skip(sessionId, 'not-completed-kind(' + String(info.lastTurnEndKind || 'null') + ')', base); continue }
      // ⑥ 可选：最小年龄
      if (olderThanMinutes > 0) {
        if (info.lastEventTime === null) { skip(sessionId, 'age-unknown', base); continue }
        const ageMin = (NOW - info.lastEventTime) / 60000
        if (ageMin < olderThanMinutes) { skip(sessionId, 'too-recent', Object.assign({ ageMinutes: Math.round(ageMin * 10) / 10 }, base)); continue }
      }
      eligible.push(Object.assign({ dir, files: info.files, frames: info.frames, lastTurnEndKind: info.lastTurnEndKind, lastEventTime: info.lastEventTime, lastEventTimeISO: info.lastEventTime ? new Date(info.lastEventTime).toISOString() : null }, base))
    }
  }

  const summaryBase = `janitor_reap_subagents(${dryRun ? 'dryRun' : 'REAL'}) parent=${parentSessionId} auth=${auth.via} eligible=${eligible.length} skipped=${skipped.length}`

  if (dryRun) {
    return {
      ok: true, action: 'janitor_reap_subagents', dryRun: true, authVia: auth.via, caller: auth.caller,
      parentSessionId, sessionsRoot, recycleRoot, eligible, skipped,
      summary: summaryBase + '（dryRun：未动任何文件）',
    }
  }

  // ---- 真做：rename 进回收区（同分区原子），先记账再动 ----
  if (o.recycleRoot === undefined && o.recycleRootTestOnly !== true) { /* 默认回收区 */ }
  const moved = []
  const moveFailed = []
  const ledger = readLedger(ledgerPath)
  for (const c of eligible) {
    const target = path.join(recycleRoot, c.sessionId)
    if (fs.existsSync(target)) { moveFailed.push({ sessionId: c.sessionId, reason: 'recycle-target-exists(refuse-to-overwrite)' }); continue }
    let pre
    try { pre = hashDir(c.dir) } catch (e) { moveFailed.push({ sessionId: c.sessionId, reason: 'hash-before-failed: ' + _msg(e) }); continue }
    try {
      fs.mkdirSync(recycleRoot, { recursive: true })
      fs.renameSync(c.dir, target)
    } catch (e) { moveFailed.push({ sessionId: c.sessionId, reason: 'rename-failed: ' + _msg(e) }); continue }
    let post = null
    try { post = hashDir(target) } catch (_) {}
    const verified = !!(post && post.dirHash === pre.dirHash)
    moved.push({ sessionId: c.sessionId, bucket: c.bucket, recyclePath: target, dirHash: pre.dirHash, bytes: pre.files.reduce((a, x) => a + (x.bytes || 0), 0), fileCount: pre.fileCount, verifiedSameHashAfterMove: verified })
    ledger.entries[c.sessionId] = { sessionId: c.sessionId, bucket: c.bucket, reapedAt: new Date().toISOString(), dirHash: pre.dirHash, files: pre.files, parentSession: c.parentSession }
  }
  try { writeLedger(ledgerPath, ledger) } catch (e) { moveFailed.push({ sessionId: '(ledger)', reason: 'ledger-write-failed: ' + _msg(e) }); }

  return {
    ok: true, action: 'janitor_reap_subagents', dryRun: false, authVia: auth.via, caller: auth.caller,
    parentSessionId, sessionsRoot, recycleRoot,
    moved, moveFailed, eligible, skipped,
    summary: summaryBase + ` moved=${moved.length} moveFailed=${moveFailed.length}`,
  }
}

/** restore：从回收区搬回 sessions/<bucket>/<id>，并逐文件哈希比对账本 */
export function runRestore(opts) {
  const o = opts || {}
  const sessionsRoot = o.sessionsRoot ? String(o.sessionsRoot) : defaultSessionsRoot()
  const recycleRoot = o.recycleRoot ? String(o.recycleRoot) : defaultRecycleRoot()
  const ledgerPath = o.ledgerPath ? String(o.ledgerPath) : defaultLedgerPath()
  const dryRun = o.dryRun !== false
  const confirm = o.confirm === true
  const ids = String(o.sessionIds || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) return fail('IDS_REQUIRED', 'IDS_REQUIRED：必须给 sessionIds（逗号分隔）')

  const auth = authorize({ callerSessionId: o.callerSessionId, httpAuthorized: o.httpAuthorized, parentSessionId: null })
  if (!auth.ok) return Object.assign({ action: 'janitor_restore', dryRun }, auth)
  if (!dryRun && !confirm) return fail('CONFIRM_REQUIRED', 'CONFIRM_REQUIRED：dryRun:false 必须同时 confirm:true', { action: 'janitor_restore', dryRun })

  const ledger = readLedger(ledgerPath)
  const buckets = listBucketDirs(sessionsRoot)
  const restored = []
  const restoreFailed = []
  const skip = []
  for (const id of ids) {
    const src = path.join(recycleRoot, id)
    if (!fs.existsSync(src)) { skip.push({ sessionId: id, reason: 'recycle-missing' }); continue }
    const meta = ledger.entries[id] || null
    const bucket = (meta && meta.bucket) || o.bucket || (buckets.length === 1 ? buckets[0] : null)
    if (!bucket) { skip.push({ sessionId: id, reason: 'bucket-unknown(账本缺条目且未显式给 bucket)' }); continue }
    const target = path.join(sessionsRoot, bucket, id)
    if (fs.existsSync(target)) { skip.push({ sessionId: id, reason: 'target-exists' }); continue }
    if (dryRun) { restored.push({ sessionId: id, bucket, from: src, to: target, planned: true }); continue }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(src, target)
    } catch (e) { restoreFailed.push({ sessionId: id, reason: 'rename-failed: ' + _msg(e) }); continue }
    const post = hashDir(target)
    const expect = meta ? meta.dirHash : null
    const hashMatches = expect ? (post.dirHash === expect) : null
    restored.push({ sessionId: id, bucket, to: target, dirHash: post.dirHash, expectedDirHash: expect, hashMatches, fileCount: post.fileCount })
    if (hashMatches === true) delete ledger.entries[id]
  }
  if (!dryRun) { try { writeLedger(ledgerPath, ledger) } catch (_) {} }

  return {
    ok: true, action: 'janitor_restore', dryRun, authVia: auth.via, caller: auth.caller,
    restored, restoreFailed, skipped: skip,
    allHashesMatch: restored.length > 0 && restored.every((r) => r.hashMatches !== false),
    summary: `janitor_restore(${dryRun ? 'dryRun' : 'REAL'}) requested=${ids.length} restored=${restored.length} skipped=${skip.length} failed=${restoreFailed.length}`,
  }
}

// ---------------------------------------------------------------------------
// 账本（<DSH_HOME>/_janitor/reap-ledger.json）—— 便于 restore 自足；坏文件当空账本
// ---------------------------------------------------------------------------
export function readLedger(p) {
  const empty = { version: 1, entries: {} }
  try {
    if (!fs.existsSync(p)) return empty
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') return { version: j.version || 1, entries: j.entries }
  } catch (_) { /* 坏账本：当空 */ }
  return empty
}
export function writeLedger(p, ledger) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2))
}
