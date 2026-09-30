// 会话迁移：把会话数据从一个工作目录迁到另一个目录（跨盘、跨平台，如 Windows → Linux）。
//
// 为什么必须做这三件事（约束都来自内核实现，不是猜测）：
// 1) 会话按 cwd 编码分桶：sessions/--<projectKey(cwd)>--/<会话>/。projectKey 的实现见
//    @deepseek-ai/dsh-session-persistence-jsonl：路径分隔符折叠为 '-'，其余非安全字符
//    转义为 ~XXXX，末尾按 251 字符截断。cwd 一变，桶名就变，内核不会再去找旧桶。
// 2) 每个会话首行是 header，其 cwd 必须是「当前平台的绝对路径」，否则 header 校验不过
//    （Windows 的 C:\... 在 Linux 上 path.isAbsolute() 为 false）。
// 3) 会话体是 zstd 压缩的单行 JSONL；Node >= 22.15 的 node:zlib 原生支持
//    zstdCompressSync / zstdDecompressSync，因此无需任何第三方依赖。
// 4) ⚠ 会话文件是**多帧拼接**的 append-only 流：第一帧只装 header，之后每次追加各成一帧。
//    实测一个 35.6 MB 的会话含 5000+ 帧。而 Node 的 zstdDecompressSync **只解第一帧就静默
//    停止**（同一个文件只解出 173 字符的 header）。因此绝不能按"整文件解压→改写→重新压缩"
//    处理：那会把会话内容全部清空且不报任何错（2026-09-22 实测踩到）。
//    正确做法：只把**第一帧**解出来改写并重压缩，其余帧**逐字节原样保留**。这样既无数据丢失，
//    又省掉对几十 MB 内容的解压/重压缩。
//
// ─────────────────────────────────────────────────────────────────────────────
// 帧边界怎么定：RFC 8878 结构性解析（不是魔数扫描）
// ─────────────────────────────────────────────────────────────────────────────
// `0x28B52FFD` 是 zstd 帧魔数，但它**可能巧合地出现在压缩数据的负载内部**，因此"扫魔数"
// 得到的帧数天然不可信。本脚本改为按 RFC 8878 的帧/块结构逐块走过：
//   Frame_Header_Descriptor → (Window_Descriptor) → (Dictionary_ID) → (Frame_Content_Size)
//   → 若干 Block（Block_Header 的 3 字节里带 last_block 位与 block_type/size）→ (Checksum)
// 这样得到的 [start,end) 是自洽的：所有帧首尾相接、Σ(frame.size) === fileSize。
// 交叉验证（本机 554 个真实会话文件）：结构解析 0 报错；Σ size 全部等于文件大小；
// 结构帧数与魔数扫描命中数 554/554 一致；第 0 帧 100% 是 `{"type":"session",…,"cwd":…}`。
// 导出的 splitFirstFrame / decompressAllFrames / countFrames 仍保留一条"魔数候选 + 解码校验"
// 的退路，供损坏文件上的报告用途（结构性解析失败时才启用，且不作为安全判据）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 两遍式（Pass A / Pass B）与产物清单
// ─────────────────────────────────────────────────────────────────────────────
// Pass A：把每个文件读完、结构解析、校验、并**造好新的第一帧**，全部驻留内存；
//         **任何一条失败就整体不落盘**（宁可不做，也不做一半）。
// Pass B：才真正写盘；每个文件写盘前做三项硬校验（帧数守恒 / 第 2..N 帧逐字节相同 /
//         第一帧 cwd 已是目标值），并在内存里比对，不通过就不写该文件。
// 产物：<outRoot>/manifest-sessions.json —— 每条
//         { rel, srcBytes, srcSha256, dstBytes, dstSha256, framesIn, framesOut }
//       （仅在真实写入时产出；--dry-run 不落任何盘）
//
// ─────────────────────────────────────────────────────────────────────────────
// projectKey「不许手推」的机器化约束
// ─────────────────────────────────────────────────────────────────────────────
// 内核里做这个转义的函数是 `projectKey(cwd)`，位置：
//   <内核安装目录>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
// 下面的 `projectKey` 是其等价实现；脚本启动时用**两个已知真实样本**回放自检
// （见 PROJECTKEY_SAMPLES / assertProjectKeySamples），不符即退出 —— 即"不许手推"。
//
// 安全性设计：
// - 只改 header 里的 cwd 值（字符串级精确替换），其余帧与文件其余部分逐字节保留；
// - 迁移前把原文件与 cwd 映射写入备份目录，可回滚；
// - 支持 --dry-run 只统计不落盘；
// - 迁移后自校验：**逐帧解压**比对「除 cwd 外内容完全一致」。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

/** 复刻内核的 projectKey：把 cwd 编码成一个文件系统安全的单层目录名。 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cwd 不能为空')
  }
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const head = readable.replace(/^-+/, '') || 'root'
  return `--${head.slice(0, 251)}--`
}

/**
 * 两个**已知真实样本**（来自服务端磁盘上实际存在的桶名与本地实况）。
 * 自检不过 ⇒ 说明 projectKey 与内核脱钩 ⇒ 必须停下，不许继续写盘。
 */
export const PROJECTKEY_SAMPLES = [
  ['E:\\DSH工作区', '--E-DSH~5DE5~4F5C~533A--'],
  ['/home/dsh', '--home-dsh--'],
]

/** 「不许手推」的机器化约束：拿已知真实样本回放，不符就抛错（CLI 会据此退出）。 */
export function assertProjectKeySamples() {
  for (const [input, expected] of PROJECTKEY_SAMPLES) {
    const got = projectKey(input)
    if (got !== expected) {
      throw new Error(`projectKey 自检失败: in=${JSON.stringify(input)} expected=${expected} got=${got}`)
    }
  }
}

/** 会话文件是否是需要迁移的会话快照（排除各类 .bak 备份）。 */
export function isSessionSnapshot(name) {
  return /^session.*\.jsonl\.zstd$/i.test(name) && !name.includes('.bak')
}

/**
 * 匹配用归一化：把反斜杠统一成正斜杠并去掉尾部斜杠。
 * 实测真实数据里同一目录存在 `E:\DSH工作区` 与 `E:/DSH工作区` 两种写法，
 * 若用精确字符串比较会漏掉后者。注意：只用于「匹配」，写回 header 的仍是目标路径原样。
 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 枚举 sessions 根目录下的所有会话快照文件。 */
export function listSessionFiles(sessionsRoot) {
  const out = []
  if (!fs.existsSync(sessionsRoot)) return out
  for (const bucket of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory() || !bucket.name.startsWith('--')) continue
    const bucketDir = path.join(sessionsRoot, bucket.name)
    for (const session of fs.readdirSync(bucketDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(bucketDir, session.name)
      for (const file of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        if (!file.isFile() || !isSessionSnapshot(file.name)) continue
        out.push({
          bucket: bucket.name,
          session: session.name,
          file: file.name,
          abs: path.join(sessionDir, file.name),
        })
      }
    }
  }
  return out
}

function escapeJsonString(value) {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * 解出「第一帧文本」里的 header 行并 JSON.parse。
 * ⚠ 必须先按首个换行截断：**单帧**会话文件的第一帧里 header 与正文同帧，
 *   直接 JSON.parse 整个帧文本会报 "Unexpected non-whitespace character after JSON"。
 */
function parseHeaderLine(text) {
  const nl = text.indexOf('\n')
  return JSON.parse(nl === -1 ? text : text.slice(0, nl))
}

/**
 * 只替换 header 首行里的 cwd 值，其余部分保持原样。
 * 返回 { text, oldCwd, changed }；若 header 不可解析或没有 cwd 字段则返回 null。
 */
export function rewriteHeaderCwd(rawText, newCwd) {
  const nl = rawText.indexOf('\n')
  const headerLine = nl === -1 ? rawText : rawText.slice(0, nl)
  const rest = nl === -1 ? '' : rawText.slice(nl)
  let header
  try {
    header = JSON.parse(headerLine)
  } catch {
    return null
  }
  if (!header || header.type !== 'session' || typeof header.cwd !== 'string') return null

  const oldCwd = header.cwd
  if (oldCwd === newCwd) return { text: rawText, oldCwd, changed: false }

  // 精确替换 `"cwd":"<原值>"` 这一段（容忍键与值之间的空白差异）
  const pattern = /("cwd"\s*:\s*")((?:[^"\\]|\\.)*)(")/
  if (!pattern.test(headerLine)) return null
  const newHeaderLine = headerLine.replace(pattern, (_m, p1, _old, p3) => p1 + escapeJsonString(newCwd) + p3)
  return { text: newHeaderLine + rest, oldCwd, changed: true }
}

// ---------- 多帧 zstd：内核的会话文件是 append-only 的帧序列 ----------
// 见文件头第 4 条。下面这些函数是整套迁移的安全地基：只有按帧处理才能既改 header 又不丢内容。

const ZSTD_MAGIC = 0xfd2fb528 // 小端读作 0x28B52FFD

/**
 * RFC 8878 结构性帧边界解析：只定位、不解压，返回每个帧的 { start, end }。
 *
 * 为什么不扫魔数：`0x28B52FFD` 可能出现在压缩负载内部，扫魔数会把巧合字节误判成帧界。
 * 结构自洽性由调用方用 `Σ frame.size === fileSize` 交叉验证。
 *
 * 帧布局：Magic → Frame_Header_Descriptor → [Window_Descriptor] → [Dictionary_ID]
 *        → [Frame_Content_Size] → Block* → [Checksum]
 */
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

/** 惰性枚举 [start, end) 区间内所有 zstd 帧魔数位置（仅在结构解析失败时兜底用）。 */
function* magicOffsetsFrom(buf, start) {
  for (let i = start; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) yield i
  }
}

/**
 * 兜底：魔数候选 + 解码校验的帧切分（旧实现）。
 * 只在结构性解析失败时启用，用于对**损坏文件**给出可读报告；迁移主流程不使用它
 * （主流程的 Pass A 直接调 parseFrames，解析不过就是硬失败）。
 */
function legacyFrameRanges(buf) {
  const ranges = []
  let off = 0
  while (off < buf.length) {
    if (!buf.subarray(off, off + 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
      throw new Error(`offset ${off} 处不是帧魔数，文件可能被截断`)
    }
    let end = -1
    for (const cand of magicOffsetsFrom(buf, off + 1)) {
      try {
        zlib.zstdDecompressSync(buf.subarray(off, cand))
        end = cand
        break
      } catch { /* 该候选不是真边界，继续往后找 */ }
    }
    if (end === -1) {
      zlib.zstdDecompressSync(buf.subarray(off)) // 收尾帧必须能解出来
      end = buf.length
    }
    ranges.push({ start: off, end })
    off = end
    if (ranges.length > 5000000) throw new Error('帧数异常，疑似死循环')
  }
  return ranges
}

/** 结构解析优先，失败才退到魔数兜底（供只读工具函数使用）。 */
function frameRanges(buf) {
  try {
    return parseFrames(buf)
  } catch {
    return legacyFrameRanges(buf)
  }
}

/**
 * 切出第一帧：返回 { firstText, firstFrameEnd, singleFrame }
 * - firstText：第一帧解出的文本（即 header 行）
 * - firstFrameEnd：第一帧在文件中的结束偏移；后续字节必须逐字节保留
 * - singleFrame：整文件只有一帧（此时 firstFrameEnd === buf.length）
 */
export function splitFirstFrame(buf) {
  let firstText
  try {
    firstText = zlib.zstdDecompressSync(buf).toString('utf8')
  } catch (e) {
    throw new Error(`第一帧不是合法 zstd：${e.message}`)
  }
  const ranges = frameRanges(buf)
  return { firstText, firstFrameEnd: ranges[0].end, singleFrame: ranges.length === 1 }
}

/**
 * 逐帧解压整条流，返回拼接后的完整文本。
 * 用途：校验与统计——这是唯一能证明"多帧内容没被丢掉"的手段。
 */
export function decompressAllFrames(buf) {
  if (!buf.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
    throw new Error('不是 zstd 帧序列：开头没有帧魔数')
  }
  const ranges = frameRanges(buf)
  const chunks = []
  for (const f of ranges) chunks.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)))
  return Buffer.concat(chunks)
}

/**
 * 统计帧数（不解压内容，用于报告）。
 * ⚠ 安全判据一律用 parseFrames 的返回值；本函数在结构解析失败时退化为魔数计数，
 *   只适合"给人看"的场景（损坏文件上的粗估）。
 */
export function countFrames(buf) {
  try {
    return parseFrames(buf).length
  } catch {
    let n = 0
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) n++
    }
    return n
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 把 header 的 cwd 改写为目标值，其余帧逐字节保留。
 * @param {Buffer} srcBuf 源文件字节
 * @param {string} newCwd 目标 cwd
 * @param {string} firstText 已解出的第一帧文本
 * @param {number} firstFrameEnd 第一帧结束偏移（之后的字节原样拼接）
 * @returns {{ buf: Buffer, oldCwd: string, changed: boolean } | null} header 不可解析时返回 null
 */
function rewriteSessionBuffer(srcBuf, newCwd, firstText, firstFrameEnd) {
  const rewritten = rewriteHeaderCwd(firstText, newCwd)
  if (!rewritten) return null
  if (!rewritten.changed) return { buf: srcBuf, oldCwd: rewritten.oldCwd, changed: false }
  const head = zlib.zstdCompressSync(Buffer.from(rewritten.text, 'utf8'))
  // 第一帧之外的所有字节原样拼接（不重新压缩 → 不可能丢内容）
  return { buf: Buffer.concat([head, srcBuf.subarray(firstFrameEnd)]), oldCwd: rewritten.oldCwd, changed: true }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

/**
 * 执行迁移（两遍式）。
 * @param {object} opts
 * @param {string} opts.sessionsRoot 源 sessions 目录
 * @param {string} opts.outRoot      目标 sessions 目录（可为同一目录，用于原地迁移）
 * @param {string} opts.backupDir    备份目录（写入原文件与 headers-backup.json）
 * @param {Map<string,string>|object} opts.cwdMap 旧 cwd → 新 cwd 的精确映射
 * @param {string} [opts.defaultNewCwd] 未命中映射时的兜底目标（缺省则跳过并记为 skipped）
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.manifestPath] 清单落点（缺省 <outRoot>/manifest-sessions.json）
 * @param {(msg:string)=>void} [opts.log]
 */
export function migrateSessions(opts) {
  const {
    sessionsRoot,
    outRoot = sessionsRoot,
    backupDir,
    cwdMap = {},
    defaultNewCwd = '',
    dryRun = false,
    manifestPath = '',
    log = () => {},
  } = opts

  const map = cwdMap instanceof Map ? cwdMap : new Map(Object.entries(cwdMap))
  // 归一化后的查找表：兼容 E:\x 与 E:/x 这类同目录不同写法
  const normalizedMap = new Map()
  for (const [oldCwd, newCwd] of map) normalizedMap.set(normalizeCwd(oldCwd), newCwd)
  const files = listSessionFiles(sessionsRoot)
  const records = []
  const stats = { total: files.length, migrated: 0, unchanged: 0, skipped: 0, failed: 0 }
  const buckets = new Map()
  const plan = []
  const failures = []

  // ===== Pass A：读 + 结构解析 + 校验 + 造好新第一帧；一条失败就整体不落盘 =====
  for (const f of files) {
    try {
      const srcBuf = fs.readFileSync(f.abs)
      // 严格结构解析：不用魔数扫描（压缩数据内部可能含魔数）
      const ranges = parseFrames(srcBuf)
      if (ranges.length === 0) throw new Error('帧数为 0')
      let sum = 0
      for (const r of ranges) sum += r.end - r.start
      if (sum !== srcBuf.length) {
        throw new Error(`帧边界不自洽（Σ frame.size = ${sum} != fileSize = ${srcBuf.length}）`)
      }

      const firstFrame = srcBuf.subarray(ranges[0].start, ranges[0].end)
      const firstText = zlib.zstdDecompressSync(firstFrame).toString('utf8')
      const oldHeader = parseHeaderLine(firstText)
      const oldCwd = oldHeader && typeof oldHeader.cwd === 'string' ? oldHeader.cwd : null
      if (!oldCwd) {
        stats.skipped++
        log(`跳过（header 无 cwd）: ${f.session}/${f.file}`)
        records.push({
          sessionId: f.session,
          file: f.file,
          fromBucket: f.bucket,
          oldCwd: null,
          newCwd: null,
          changed: false,
          skipped: 'no-cwd-in-header',
        })
        continue
      }
      const newCwd = normalizedMap.get(normalizeCwd(oldCwd)) || defaultNewCwd
      if (!newCwd) {
        stats.skipped++
        log(`跳过（无映射）: cwd=${oldCwd} ← ${f.session}/${f.file}`)
        records.push({
          sessionId: f.session,
          file: f.file,
          fromBucket: f.bucket,
          oldCwd,
          newCwd: null,
          changed: false,
          skipped: 'no-mapping',
        })
        continue
      }

      const rewritten = rewriteSessionBuffer(srcBuf, newCwd, firstText, ranges[0].end)
      if (!rewritten) {
        stats.skipped++
        log(`跳过（header 不可解析）: ${f.session}/${f.file}`)
        records.push({
          sessionId: f.session,
          file: f.file,
          fromBucket: f.bucket,
          oldCwd,
          newCwd,
          changed: false,
          skipped: 'unparsable-header',
        })
        continue
      }

      const newBucket = projectKey(newCwd)
      buckets.set(newBucket, newCwd)
      if (rewritten.changed) stats.migrated++
      else stats.unchanged++
      records.push({
        sessionId: f.session,
        file: f.file,
        fromBucket: f.bucket,
        toBucket: newBucket,
        oldCwd,
        newCwd,
        changed: rewritten.changed,
      })
      plan.push({ f, srcBuf, ranges, rewritten, newCwd, newBucket, oldCwd })
    } catch (e) {
      failures.push({ session: f.session, file: f.file, abs: f.abs, error: e.message })
    }
  }

  if (failures.length > 0) {
    stats.failed = failures.length
    log(`\n有 ${failures.length} 个文件在 Pass A 校验失败 —— 按纪律【整体不落盘】：`)
    for (const x of failures.slice(0, 50)) log(`  FAIL ${x.session}/${x.file} :: ${x.error}`)
    if (failures.length > 50) log(`  ...还有 ${failures.length - 50} 个`)
    return { stats, records, aborted: true }
  }

  // ===== Pass B：写盘（每个文件都先在内存里过三项硬校验，不过则不写） =====
  const manifest = []
  let writeFailures = 0
  if (!dryRun) {
    for (const p of plan) {
      const targetDir = path.join(outRoot, p.newBucket, p.f.session)
      const targetFile = path.join(targetDir, p.f.file)
      const outBuf = p.rewritten.buf
      const tag = `${p.f.session}/${p.f.file}`

      // 【校验 1】帧数守恒：写回后重新做结构解析，帧数必须等于源帧数。
      //   —— 本项目踩过"多帧被截断成首帧导致数据丢失但校验假通过"，这是那道闸门；
      //      用独立的结构解析重新数一遍，而不是信任写入时的中间量。
      let outRanges
      try {
        outRanges = parseFrames(outBuf)
      } catch (e) {
        log(`  FAIL 回读失败 ${tag} :: ${e.message}`)
        writeFailures++
        continue
      }
      if (outRanges.length !== p.ranges.length) {
        log(`  FAIL 帧数不守恒 ${tag}: framesIn=${p.ranges.length} framesOut=${outRanges.length}`)
        writeFailures++
        continue
      }
      // 【校验 2】第 2..N 帧必须逐字节相同（"只改了第一帧"的硬判据）
      let sameAfterFirst = true
      for (let i = 1; i < p.ranges.length; i++) {
        const s = p.srcBuf.subarray(p.ranges[i].start, p.ranges[i].end)
        const d = outBuf.subarray(outRanges[i].start, outRanges[i].end)
        if (!s.equals(d)) { sameAfterFirst = false; log(`  FAIL 第 ${i + 1} 帧被改动 ${tag}`); break }
      }
      if (!sameAfterFirst) { writeFailures++; continue }
      // 【校验 3】第一帧解出来必须是目标 cwd
      if (p.rewritten.changed) {
        const h0 = parseHeaderLine(zlib.zstdDecompressSync(outBuf.subarray(outRanges[0].start, outRanges[0].end)).toString('utf8'))
        if (h0.cwd !== p.newCwd) {
          log(`  FAIL 第 1 帧 cwd 未改成目标值 ${tag}: ${JSON.stringify(h0.cwd)}`)
          writeFailures++
          continue
        }
      }

      fs.mkdirSync(targetDir, { recursive: true })
      if (p.rewritten.changed && backupDir) {
        // 备份原文件（保持目录结构）
        const bak = path.join(backupDir, p.f.bucket, p.f.session, p.f.file)
        fs.mkdirSync(path.dirname(bak), { recursive: true })
        fs.copyFileSync(p.f.abs, bak)
      }
      atomicWrite(targetFile, outBuf)

      manifest.push({
        rel: path.join(p.newBucket, p.f.session, p.f.file),
        srcBytes: p.srcBuf.length,
        srcSha256: sha256(p.srcBuf),
        dstBytes: outBuf.length,
        dstSha256: sha256(outBuf),
        framesIn: p.ranges.length,
        framesOut: outRanges.length,
      })
      log(`  OK ${tag}  frames ${p.ranges.length}->${outRanges.length}  bytes ${p.srcBuf.length}->${outBuf.length}  cwd ${JSON.stringify(p.oldCwd)} -> ${JSON.stringify(p.newCwd)}`)
    }

    if (manifest.length > 0) {
      const mf = manifestPath ? path.resolve(manifestPath) : path.join(outRoot, 'manifest-sessions.json')
      atomicWrite(mf, JSON.stringify(manifest, null, 2) + '\n')
      log(`\nmanifest      : ${mf}`)
    }
  }
  stats.failed += writeFailures

  // 备份目录里留一份映射，便于审计与回滚（沿用 2026-08-20 那次迁移的做法）
  if (!dryRun && backupDir) {
    fs.mkdirSync(backupDir, { recursive: true })
    atomicWrite(
      path.join(backupDir, 'headers-backup.json'),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          sessionsRoot,
          outRoot,
          buckets: [...buckets].map(([key, cwd]) => ({ bucket: key, cwd })),
          ...stats,
          records,
        },
        null,
        2,
      ),
    )
  }

  return { stats, records }
}

/**
 * 自校验：比对迁移前后「除 cwd 外内容完全一致」。
 * ⚠ 必须逐帧解压：多帧文件若只用 zstdDecompressSync，两侧都只会读到 header，
 *   从而"看起来一致"——那正是 2026-09-22 那次静默丢内容的成因。这里额外比对
 *   帧数，任何帧数变化都判为问题。
 */
export function verifyMigration({ backups, targets, newCwd }) {
  const problems = []
  for (const rel of Object.keys(backups)) {
    const beforeBuf = fs.readFileSync(backups[rel])
    const afterBuf = fs.readFileSync(targets[rel])
    let before
    let after
    try {
      before = decompressAllFrames(beforeBuf).toString('utf8')
      after = decompressAllFrames(afterBuf).toString('utf8')
    } catch (e) {
      problems.push(`${rel}: 逐帧解压失败 — ${e.message}`)
      continue
    }
    const framesBefore = countFrames(beforeBuf)
    const framesAfter = countFrames(afterBuf)
    if (framesBefore !== framesAfter) {
      problems.push(`${rel}: 帧数变化 ${framesBefore} → ${framesAfter}（正文帧被改动，属数据丢失）`)
      continue
    }
    const expected = rewriteHeaderCwd(before, newCwd)
    if (!expected) {
      problems.push(`${rel}: 原文件 header 不可解析`)
      continue
    }
    if (expected.text !== after) {
      problems.push(`${rel}: 迁移后内容与预期不一致（除 cwd 外应逐字节相同，实际解压长度 ${after.length} vs 期望 ${expected.text.length}）`)
    }
  }
  return problems
}

// ---------- --inspect（只读探针） ----------

/** 只读体检一个会话文件：帧数、逐帧大小/偏移、第 0 帧解码内容、哪些帧含目标字符串。 */
export function inspectFile(file, needle = 'DSH工作区') {
  const buf = fs.readFileSync(file)
  const ranges = parseFrames(buf)
  const sum = ranges.reduce((s, f) => s + (f.end - f.start), 0)
  console.log(`file        : ${file}`)
  console.log(`srcBytes    : ${buf.length}`)
  console.log(`srcSha256   : ${sha256(buf)}`)
  console.log(`frames      : ${ranges.length}   (Σ frame.size = ${sum} ${sum === buf.length ? '== fileSize OK' : '!= fileSize 异常'})`)
  console.log('idx\tstart\tend\tsize\thead(16B hex)')
  ranges.forEach((f, i) => {
    const head = buf.subarray(f.start, Math.min(f.start + 16, f.end)).toString('hex')
    console.log(`${i}\t${f.start}\t${f.end}\t${f.end - f.start}\t${head}`)
  })
  const f0 = zlib.zstdDecompressSync(buf.subarray(ranges[0].start, ranges[0].end))
  console.log('\n--- frame 0 decoded (utf8) ---')
  console.log(f0.toString('utf8'))
  console.log('--- end frame 0 ---')
  const pat = Buffer.from(needle, 'utf8')
  const hits = []
  for (let i = 0; i < ranges.length; i++) {
    const d = zlib.zstdDecompressSync(buf.subarray(ranges[i].start, ranges[i].end))
    if (d.includes(pat)) hits.push(i)
  }
  console.log(`含 ${JSON.stringify(needle)} 的帧索引: ${JSON.stringify(hits)}`)
  return 0
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { sessions: '', out: '', backup: '', maps: [], defaultNew: '', dryRun: false, inspect: '', manifest: '' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sessions') args.sessions = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--backup') args.backup = argv[++i]
    else if (a === '--map') args.maps.push(argv[++i])
    else if (a === '--default') args.defaultNew = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--inspect') args.inspect = argv[++i]
    else if (a === '--manifest') args.manifest = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv)
  // 「不许手推」：启动即用两个已知真实样本回放 projectKey，不符直接抛错退出。
  assertProjectKeySamples()

  if (args.inspect) return inspectFile(args.inspect)

  if (!args.sessions) {
    console.log('用法:')
    console.log('  node server/scripts/session-migrate.mjs \\')
    console.log('    --sessions <旧 sessions 目录> \\')
    console.log('    [--out <新 sessions 目录>]   # 缺省为原地迁移')
    console.log('    [--backup <备份目录>]        # 缺省为 <sessions>/_cwd-migration-backup-<ts>')
    console.log('    --map "E:\\DSH工作区=/srv/dsh-workspace" [--map "旧=新" ...]')
    console.log('    [--default <未命中时的兜底新 cwd>]')
    console.log('    [--manifest <清单路径>]      # 缺省 <out>/manifest-sessions.json')
    console.log('    [--dry-run]')
    console.log('')
    console.log('  node server/scripts/session-migrate.mjs --inspect <file.zstd>')
    console.log('    # 只读探针：帧数、逐帧大小/偏移、第 0 帧解码内容、含 "DSH工作区" 的帧索引')
    return
  }
  const sessionsRoot = path.resolve(args.sessions)
  const outRoot = args.out ? path.resolve(args.out) : sessionsRoot
  const backupDir = args.backup
    ? path.resolve(args.backup)
    : path.join(
        outRoot,
        `_cwd-migration-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
      )

  const cwdMap = new Map()
  for (const m of args.maps) {
    const i = m.lastIndexOf('=')
    if (i <= 0) throw new Error(`--map 格式应为 旧=新，收到: ${m}`)
    cwdMap.set(m.slice(0, i), m.slice(i + 1))
  }
  const log = (msg) => process.stdout.write(`${msg}\n`)

  log(`源 sessions: ${sessionsRoot}`)
  log(`目标 sessions: ${outRoot}`)
  if (args.dryRun) log('（dry-run：只统计不落盘）')
  for (const [o, n] of cwdMap) log(`映射: ${o}  →  ${n}`)
  if (args.defaultNew) log(`兜底: 未命中映射的会话 → ${args.defaultNew}`)

  const { stats, records, aborted } = migrateSessions({
    sessionsRoot,
    outRoot,
    backupDir: args.dryRun ? '' : backupDir,
    cwdMap,
    defaultNewCwd: args.defaultNew,
    dryRun: args.dryRun,
    manifestPath: args.manifest,
    log,
  })

  log('')
  log('=== 统计 ===')
  log(`总会话文件: ${stats.total}`)
  log(`已迁移（改写 cwd + 换桶）: ${stats.migrated}`)
  log(`无需改写（已是目标 cwd）: ${stats.unchanged}`)
  log(`跳过: ${stats.skipped}`)
  log(`失败: ${stats.failed}`)
  const bucketSummary = new Map()
  for (const r of records) {
    if (!r.toBucket) continue // 跳过项没有目标桶
    bucketSummary.set(r.toBucket, (bucketSummary.get(r.toBucket) || 0) + 1)
  }
  log('')
  log('=== 目标桶分布 ===')
  for (const [b, n] of bucketSummary) log(`  ${b}  (${n})`)
  if (aborted) {
    log('\n⚠ Pass A 有失败项，已按纪律整体不落盘（未写任何文件）。')
    return 1
  }
  if (!args.dryRun) log(`\n备份与映射记录: ${backupDir}`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('session-migrate.mjs')) {
  try {
    process.exitCode = main()
  } catch (e) {
    console.error(`迁移失败: ${e.message}`)
    process.exit(1)
  }
}
