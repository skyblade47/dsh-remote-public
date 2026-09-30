#!/usr/bin/env node
// 夹具：把指定会话改成「未闭合 turn」状态 —— P3（重启自恢复）真机验收用
//
// 计划出处：docs/superpowers/plans/2026-09-22-dsh-remote-p3-resume-on-boot.md §2C
//
// 为什么不用「真跑 + 杀内核」造未闭合会话（计划 §2C 路线 A）：
//   时序不可控（turn 何时落盘、杀在哪个瞬间），且会污染真实 DSH_HOME。
//   这里用**确定性**做法：先把会话跑成正常一轮，再**删掉最后一条 turn/end**。
//
// 三条安全设计（都来自本项目踩过的坑）：
//   1. **多帧**：会话是 append-only 的 zstd 帧序列，`zstdDecompressSync` **只解第一帧就静默停止**
//      （35MB 会话含 5000+ 帧，却只解出 173 字符的 header —— 2026-09-22 实测踩到）。
//      本脚本复用 `server/scripts/session-migrate.mjs` 的帧切分，且**只改最后一帧**，
//      其余帧**逐字节原样保留**（与迁移同款哲学：不重新压缩就不可能丢内容）。
//   2. **隔离**：只允许在带夹具标记文件 `<home>/.rob-fixture` 的 DSH_HOME 上运行，
//      拒绝在真实 home 上跑（防 E3：误改真实会话）。
//   3. **自校验**：写盘**前**验证「末态未闭合 + seq 连续 + 全帧可解」，不通过就拒绝写盘（防 R1）。
//
// 用法：
//   node tools/rob-fixture.mjs --home <DSH_HOME> --session <id> --report      # 只体检，不改
//   node tools/rob-fixture.mjs --home <DSH_HOME> --session <id>               # 造未闭合
//   node tools/rob-fixture.mjs --home <DSH_HOME> --session <id> --restore     # 还原
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { decompressAllFrames, countFrames, isSessionSnapshot } from '../server/scripts/session-migrate.mjs'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const MARKER = '.rob-fixture'
const BACKUP_SUFFIX = '.pre-rob-fixture'

/** 枚举 [start,end) 内的帧魔数候选位置（魔数可能巧合出现在压缩数据内部，故候选需解码校验） */
function* magicOffsetsFrom(buf, start) {
  for (let i = start; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) yield i
  }
}

/**
 * 切出**全部**帧（不只是第一帧）：返回 [{ start, end, text }]。
 * 边界判定与 session-migrate 的 splitFirstFrame 同法：对每个魔数候选做"解码后内容一致"校验，
 * 只有能解出同样内容的候选才算真边界 —— 仅靠魔数扫描会把压缩数据内部的巧合字节误判成帧界。
 */
export function splitFrames(buf) {
  if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) throw new Error('不是 zstd 帧序列：开头没有帧魔数')
  const out = []
  let off = 0
  while (off < buf.length) {
    if (!buf.subarray(off, off + 4).equals(ZSTD_MAGIC)) throw new Error(`offset ${off} 处不是帧魔数，文件可能被截断`)
    let text = null
    let end = -1
    for (const cand of magicOffsetsFrom(buf, off + 4)) {
      try {
        text = zlib.zstdDecompressSync(buf.subarray(off, cand)).toString('utf8')
        end = cand
        break
      } catch { /* 候选不是真边界 */ }
    }
    if (text === null) {
      text = zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8')
      end = buf.length
    }
    out.push({ start: off, end, text })
    off = end
    if (out.length > 5_000_000) throw new Error('帧数异常，疑似死循环')
  }
  return out
}

/** 解析 JSONL 文本为事件数组（跳过空行，保留原始行以便逐行改写） */
export function parseLines(text) {
  const lines = text.split('\n')
  const events = []
  const idxOf = []
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (!s) continue
    let ev
    try { ev = JSON.parse(s) } catch (e) { throw new Error(`第 ${i} 行不是合法 JSON：${e.message}`) }
    events.push(ev)
    idxOf.push(i)
  }
  return { lines, events, idxOf }
}

/** 末条 turn 边界（与插件 lib/detect.js 的 lastTurnState 同义，此处独立实现以便脚本零依赖插件） */
export function lastTurnBoundary(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && (ev.type === 'turn/start' || ev.type === 'turn/end')) return { index: i, event: ev }
  }
  return null
}

/** 最后一个含 tools 的 request/header 的工具数（用来回答计划里的风险 R2） */
export function lastHeaderTools(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev && ev.type === 'request/header' && ev.data && ev.data.header) {
      const tools = ev.data.header.tools
      return { found: true, hasTools: Array.isArray(tools), count: Array.isArray(tools) ? tools.length : null, seq: ev.seq }
    }
  }
  return { found: false, hasTools: false, count: null, seq: null }
}

/**
 * 体检报告（只读，用于 --report 与自校验）。
 *
 * ⚠️ seq 的真实口径（2026-09-22 用 554 个真实会话文件核实，纠正了先前假设）：
 *   · **首行（header，`type:"session"`）没有 `seq`**（实测 `seqs[0] === null`）；
 *   · 其后的行才有 seq，且为 **0,1,2,… 严格递增**；
 *   ⇒ 所以 seq 是"**不含 header** 的事件序号"，**不等于行索引**（差 1）。
 *   据此，本函数只断言"**严格递增**"（内核 invariant 的真实要求），不再断言 seq === 行索引。
 */
export function inspect(buf, label) {
  const frames = splitFrames(buf)
  const text = new TextDecoder().decode(decompressAllFrames(buf))
  const { events } = parseLines(text)
  const boundary = lastTurnBoundary(events)
  const seqs = events.map((ev) => (typeof ev.seq === 'number' ? ev.seq : null))
  const numbered = seqs.filter((v) => v !== null)
  const strictlyIncreasing = numbered.every((v, i) => i === 0 || v > numbered[i - 1])
  const noDuplicate = new Set(numbered).size === numbered.length
  return {
    label,
    frames: frames.length,
    magicCount: countFrames(buf),
    bytes: buf.length,
    events: events.length,
    headerHasSeq: seqs.length ? seqs[0] !== null : false,
    seqStrict: strictlyIncreasing && noDuplicate,
    seqSample: seqs.slice(0, 6),
    lastEventType: events.length ? events[events.length - 1].type : null,
    lastBoundaryType: boundary ? boundary.event.type : null,
    lastBoundaryReason: boundary && boundary.event.data && boundary.event.data.reason ? boundary.event.data.reason.kind : null,
    unfinished: !!(boundary && (boundary.event.type === 'turn/start'
      || (boundary.event.type === 'turn/end' && boundary.event.data && boundary.event.data.reason && boundary.event.data.reason.kind === 'interrupted'))),
    headerTools: lastHeaderTools(events),
  }
}

/**
 * 造未闭合：删掉**最后一条** `turn/end`。
 *
 * ⚠️ 必须**跨全部帧**找边界，不能只看最后一帧：内核每追加一个事件就多一帧，
 * 一轮结束后还可能有非 turn 事件（session/title、model/selection 等）落在更后面的帧里，
 * 于是"最后一条 turn 边界"完全可能不在最后一帧。只看最后一帧会**找不到边界**
 * （2026-09-22 单测实测踩到）。
 *
 * 为什么删 end 是安全的、而"补 end"不是：invariant 里**没有"未闭合即失败"的规则**
 * （未闭合本身就是 interrupted 状态）；但 `turn/end` 若在 step 仍打开时出现会被拒
 * （`turn/end … while step … is still open`）。⇒ 只删、不补。
 *
 * 帧处理策略：**边界所在帧之前的所有帧逐字节原样保留**；从边界帧起（含）重写成**一个**新帧。
 * 依据：内核读多帧流的方式是"逐帧解压后按行拼接"，重新分帧不改变语义；
 * 而"不动的部分不动"是本项目迁移脚本已验证的纪律。
 *
 * @returns {{ buf: Buffer|null, reason: string, removedSeq: number|null }}
 */
export function makeUnclosed(buf) {
  const frames = splitFrames(buf)
  const perFrame = frames.map((f) => f.text.split('\n').filter((s) => s.trim()))

  // 展平为全局行序（seq 的内核口径 = log.length = 全局行索引）
  const flat = []
  perFrame.forEach((lines, fi) => lines.forEach((raw, li) => flat.push({ fi, li, raw })))

  // 跨全部帧找"最后一条 turn 边界"
  let hit = -1
  let hitEvent = null
  for (let i = flat.length - 1; i >= 0; i--) {
    const ev = JSON.parse(flat[i].raw)
    if (ev.type === 'turn/start' || ev.type === 'turn/end') { hit = i; hitEvent = ev; break }
  }
  if (!hitEvent) return { buf: null, reason: '最后一条 turn 边界不存在（该会话没有 turn 事件）', removedSeq: null }
  const reasonKind = hitEvent.data && hitEvent.data.reason ? hitEvent.data.reason.kind : null
  if (hitEvent.type === 'turn/end' && reasonKind === 'interrupted') {
    return { buf: null, reason: '末态已是 interrupted（本就视为未完成），无需改动', removedSeq: null }
  }
  if (hitEvent.type === 'turn/start') {
    return { buf: null, reason: '末态已经是未闭合 turn，无需改动', removedSeq: null }
  }

  // 删掉该项；并对其**之后**的所有行把 seq **递减 1**（不是改成行索引！）
  // 理由：真实文件里 seq 是"不含 header 的事件序号"（header 无 seq），并非行索引；
  // 按索引硬写会把文件的编号方案改掉。递减 1 只补上被删掉的空洞，保持原有方案与严格递增。
  const kept = flat.filter((_, i) => i !== hit)
  for (let i = hit; i < kept.length; i++) {
    const ev = JSON.parse(kept[i].raw)
    if (typeof ev.seq === 'number') ev.seq = ev.seq - 1
    kept[i].raw = JSON.stringify(ev)
  }

  const boundaryFrame = flat[hit].fi
  const preserved = frames.slice(0, boundaryFrame).map((f) => buf.subarray(f.start, f.end))
  const tailLines = kept.filter((x) => x.fi >= boundaryFrame).map((x) => x.raw)
  // ⚠️ **必须以 '\n' 结尾**（真机上踩到的坑，2026-09-22 T3/R1）：
  // 内核按"完整帧里的 JSONL 记录"解析，结尾缺 '\n' 会被判
  // `complete frame contains a torn JSONL record` ⇒ 整个会话显示为"损坏"、内核拒绝加载。
  // 内核自己每追加一条记录就写一帧，且内容形如 `<json>\n`，所以这里必须补回行尾换行。
  const newTail = zlib.zstdCompressSync(Buffer.from(tailLines.join('\n') + '\n', 'utf8'))
  return { buf: Buffer.concat([...preserved, newTail]), reason: 'ok', removedSeq: hitEvent.seq }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function findSessionDir(home, sessionId) {
  const root = path.join(home, 'sessions')
  if (!fs.existsSync(root)) throw new Error('夹具 home 下没有 sessions 目录：' + root)
  for (const bucket of fs.readdirSync(root, { withFileTypes: true })) {
    if (!bucket.isDirectory() || !bucket.name.startsWith('--')) continue
    const dir = path.join(root, bucket.name, sessionId)
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir
  }
  return null
}

function snapshotFiles(sessionDir) {
  return fs.readdirSync(sessionDir, { withFileTypes: true })
    .filter((e) => e.isFile() && isSessionSnapshot(e.name))
    .map((e) => path.join(sessionDir, e.name))
}

function parseArgs(argv) {
  const out = { report: false, restore: false, dryRun: false, session: null, home: null, file: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--report') out.report = true
    else if (a === '--restore') out.restore = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--home') out.home = argv[++i]
    else if (a === '--session') out.session = argv[++i]
    else if (a === '--file') out.file = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error('未知参数：' + a)
  }
  return out
}

const USAGE = `用法：
  node tools/rob-fixture.mjs --home <DSH_HOME> --session <id> --report
  node tools/rob-fixture.mjs --home <DSH_HOME> --session <id> [--dry-run]
  node tools/rob-fixture.mjs --home <DSH_HOME> --session <id> --restore

前置：夹具 home 必须含标记文件 ${MARKER}（本脚本拒绝在真实 DSH_HOME 上运行）。`

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.home || !args.session) { console.log(USAGE); process.exit(args.help ? 0 : 2) }

  const home = path.resolve(args.home)
  // ==== 隔离断言（E3）：没有标记文件就拒绝，防止误改真实会话 ====
  if (!fs.existsSync(path.join(home, MARKER))) {
    console.error(`✘ 拒绝运行：${home} 下没有 ${MARKER} 标记文件。`)
    console.error('  这是夹具专用保护：本脚本会改写会话日志，不得在真实 DSH_HOME 上执行。')
    console.error(`  若确要建夹具环境：mkdir -p "${home}" && touch "${home}/${MARKER}"`)
    process.exit(3)
  }

  const sessionDir = findSessionDir(home, args.session)
  if (!sessionDir) { console.error(`✘ 未在 ${home}/sessions 下找到会话 ${args.session}`); process.exit(4) }
  const files = args.file ? [path.resolve(args.file)] : snapshotFiles(sessionDir)
  if (!files.length) { console.error('✘ 该会话目录下没有会话快照文件（session*.jsonl.zstd）'); process.exit(4) }

  console.log(`夹具 home : ${home}`)
  console.log(`会话目录  : ${sessionDir}`)
  console.log(`快照文件  : ${files.length} 个 → ${files.map((f) => path.basename(f)).join(', ')}`)
  console.log('')

  let hardFail = 0
  for (const file of files) {
    const name = path.basename(file)
    const backup = file + BACKUP_SUFFIX

    if (args.restore) {
      if (!fs.existsSync(backup)) { console.log(`[${name}] 无备份可还原（${path.basename(backup)} 不存在）`); continue }
      atomicWrite(file, fs.readFileSync(backup))
      console.log(`[${name}] 已还原（来自 ${path.basename(backup)}）`)
      console.log('  ' + JSON.stringify(inspect(fs.readFileSync(file), name)))
      continue
    }

    const before = fs.readFileSync(file)
    const rep = inspect(before, name)
    console.log(`[${name}] —— 改前体检 ——`)
    console.log('  ' + JSON.stringify(rep))
    // 改前 seq 必须严格递增（内核 invariant 的真实要求）
    // 注意：**不能**要求"seq === 行索引" —— 首行 header 没有 seq，seq 是不含 header 的事件序号
    if (!rep.seqStrict) { console.log(`  ✘ seq 非严格递增（seqStrict=false）：该文件可能不是内核正常写入的，拒绝改动`); hardFail++; continue }
    if (!rep.headerTools.found) console.log('  ⚠ 未找到 request/header（风险 R2：无法据此断言工具数）')
    else if (!rep.headerTools.hasTools) console.log('  ⚠ 最后一个 request/header 的 header.tools 不是数组（风险 R2 命中）')
    else console.log(`  ✔ 最后一个 request/header 的工具数 = ${rep.headerTools.count}（计划 §2C 的 A2 判据可用）`)

    if (args.report) continue

    const r = makeUnclosed(before)
    if (!r.buf) { console.log(`  · 不改动：${r.reason}`); continue }

    // ==== 写盘前自校验（R1）：全帧可解 + seq 连续 + 末态未闭合 ====
    const after = inspect(r.buf, name)
    const problems = []
    if (!after.seqStrict) problems.push('seq 非严格递增')
    if (!after.unfinished) problems.push('末态仍不是"未闭合"')
    if (after.events !== rep.events - 1) problems.push(`事件数应为 ${rep.events - 1}，实为 ${after.events}`)
    const decoded = new TextDecoder().decode(decompressAllFrames(r.buf))
    if (decoded.split('\n').filter((s) => s.trim()).length !== after.events) problems.push('解出的行数与事件数不符')
    // 结尾换行 + 每条记录完整 —— 这两条对应内核的 `complete frame contains a torn JSONL record`
    if (!decoded.endsWith('\n')) problems.push('日志结尾缺少换行（内核会判为 torn JSONL record）')
    for (const line of decoded.split('\n')) {
      if (!line.trim()) continue
      try { JSON.parse(line) } catch { problems.push(`存在不完整/非法 JSON 记录：${line.slice(0, 40)}…`); break }
    }
    if (problems.length) {
      console.log(`  ✘ 自校验未通过，拒绝写盘：${problems.join('；')}`)
      hardFail++
      continue
    }

    console.log(`  → 删除 turn/end（原 seq=${r.removedSeq}），末态变为未闭合`)
    console.log('  ' + JSON.stringify(after))
    if (args.dryRun) { console.log('  (dry-run：未写盘)'); continue }
    if (!fs.existsSync(backup)) atomicWrite(backup, before)
    atomicWrite(file, r.buf)
    console.log(`  ✔ 已写盘（原件备份为 ${path.basename(backup)}）`)
  }

  console.log('')
  if (hardFail) { console.log(`结果：${hardFail} 个文件未通过，未改动`); process.exit(5) }
  console.log(args.report ? '结果：体检完成（未改动任何文件）' : '结果：完成')
}

// 仅在被当作脚本执行时跑 main（可被单测 import）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('rob-fixture.mjs')) main()
