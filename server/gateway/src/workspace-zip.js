// 零依赖 ZIP 打包（设计文档 §5.3）。
// 用 node:zlib 的 deflateRawSync + 手写 PKZIP 二进制结构实现。
//
// ZIP 布局：
//   [Local File Header + File Data] ... 流式逐个写入
//   [Central Directory Header] ...    汇总后写入
//   [End of Central Directory Record]
//
// 设计要点：
// 1) 边遍历边写本地头 + 文件数据（流模式），但每个文件仍需读入内存做 deflate + CRC32
//    —— 单文件上限已在 workspace-fs 层限制为 100MB，可接受；不做全工作区缓存
// 2) 已压缩文件（.zip/.gz 等）用 method=0（store），避免二次压缩浪费 CPU
// 3) 符号链接不跟随、不打包
// 4) .dsh-workspace.json 不打包（内部元信息不进包）
// 5) 总大小（未压缩字节）超阈值抛 WORKSPACE_TOO_LARGE
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// CRC32 查表
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// 已是压缩格式的扩展名 → 直接 store，不再 deflate
const STORE_EXTENSIONS = new Set([
  '.zip', '.gz', '.tgz', '.bz2', '.tbz2', '.xz', '.7z', '.rar',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.ico',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.ogg', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf',
])

const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024 // 500MB 未压缩总量
const DEFAULT_MAX_FILES = 100_000

function shouldStore(fileName) {
  return STORE_EXTENSIONS.has(path.extname(fileName).toLowerCase())
}

// DOS 时间/日期（ZIP 历史格式）
function dosTime(date = new Date()) {
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xFFFF
}
function dosDate(date = new Date()) {
  return (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF
}

// 构造一个本地文件头（30 字节固定区 + 文件名）
function buildLocalHeader({ nameBuf, crc, compSize, uncompSize, method, modTime, modDate }) {
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)   // 签名
  h.writeUInt16LE(20, 4)            // 版本
  h.writeUInt16LE(0x0800, 6)        // flag: bit 11 = UTF-8 文件名
  h.writeUInt16LE(method, 8)        // 0=store, 8=deflate
  h.writeUInt16LE(modTime, 10)
  h.writeUInt16LE(modDate, 12)
  h.writeUInt32LE(crc, 14)
  h.writeUInt32LE(compSize, 18)
  h.writeUInt32LE(uncompSize, 22)
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(0, 28)            // extra length
  return Buffer.concat([h, nameBuf])
}

// 构造中央目录头（46 字节固定区 + 文件名），offset 为本地头起始偏移
function buildCentralHeader({ nameBuf, crc, compSize, uncompSize, method, modTime, modDate, offset }) {
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)   // 签名
  h.writeUInt16LE(20, 4)            // 制作版本
  h.writeUInt16LE(20, 6)            // 解压所需版本
  h.writeUInt16LE(0x0800, 8)        // UTF-8
  h.writeUInt16LE(method, 10)
  h.writeUInt16LE(modTime, 12)
  h.writeUInt16LE(modDate, 14)
  h.writeUInt32LE(crc, 16)
  h.writeUInt32LE(compSize, 20)
  h.writeUInt32LE(uncompSize, 24)
  h.writeUInt16LE(nameBuf.length, 28)
  h.writeUInt16LE(0, 30)            // extra
  h.writeUInt16LE(0, 32)            // comment
  h.writeUInt16LE(0, 34)            // disk number
  h.writeUInt16LE(0, 36)            // internal attrs
  h.writeUInt32LE(0, 38)            // external attrs
  h.writeUInt32LE(offset, 42)       // 本地头偏移
  return Buffer.concat([h, nameBuf])
}

function buildEndOfCentralDirectory({ count, centralSize, centralOffset }) {
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)                 // disk
  eocd.writeUInt16LE(0, 6)                 // start disk
  eocd.writeUInt16LE(count, 8)             // 本盘条目数
  eocd.writeUInt16LE(count, 10)            // 总条目数
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)                // comment length
  return eocd
}

/**
 * 遍历工作区，收集文件条目（不读内容，只做安全过滤与大小预检）。
 * @param {object} opts { maxFiles, maxTotalBytes, includeHidden }
 *   includeHidden=false（WQ3）时排除所有点开头的文件/目录；
 *   默认 true：除根下 .dsh-workspace.json 外全部打包。
 * @returns Array<{ absPath, zipName, size, mtime }>
 */
function collectEntries(rootDir, { maxFiles, maxTotalBytes, includeHidden = true }) {
  const entries = []
  let total = 0
  let fileCount = 0

  function walk(absDir, zipPrefix) {
    let dirents
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return // 无权限目录跳过
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue // L3：符号链接不跟随
      // WQ3：要求排除隐藏项时，点开头的文件/目录整支剪枝
      if (!includeHidden && d.name.startsWith('.')) continue
      const abs = path.join(absDir, d.name)
      if (d.isDirectory()) {
        walk(abs, zipPrefix + d.name + '/')
      } else if (d.isFile()) {
        // 工作区根下的内部元信息任何情况下都不打包
        if (zipPrefix === '' && d.name === '.dsh-workspace.json') continue
        fileCount++
        if (fileCount > maxFiles) {
          throw Object.assign(new Error(`文件数超过上限 ${maxFiles}`), { code: 'TOO_MANY_FILES' })
        }
        let size = 0
        let mtime = new Date()
        try {
          const st = fs.lstatSync(abs)
          size = st.size
          mtime = st.mtime
        } catch {
          continue
        }
        total += size
        if (total > maxTotalBytes) {
          throw Object.assign(
            new Error(`工作区总大小超过上限 ${maxTotalBytes}`),
            { code: 'WORKSPACE_TOO_LARGE' }
          )
        }
        entries.push({ absPath: abs, zipName: zipPrefix + d.name, size, mtime })
      }
    }
  }

  walk(rootDir, '')
  return { entries, totalBytes: total }
}

/**
 * 流式打包整个工作区到可写流（HTTP response / 文件流）。
 * @param {string} rootDir 工作区物理根目录（已做过归属与遍历防护）
 * @param {Writable} output 可写流
 * @param {object} opts { maxTotalBytes, maxFiles, includeHidden }
 * @returns Promise<{ fileCount, totalBytes, compressedBytes }>
 */
export async function streamWorkspaceZip(rootDir, output, opts = {}) {
  const maxTotalBytes = opts.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES
  const includeHidden = opts.includeHidden !== false // 缺省 true

  const { entries, totalBytes } = collectEntries(rootDir, { maxFiles, maxTotalBytes, includeHidden })

  const centralRecords = []
  let offset = 0
  let compressedBytes = 0

  function writeChunk(buf) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        output.removeListener('drain', onDrain)
        reject(err)
      }
      const onDrain = () => {
        output.removeListener('error', onError)
        resolve()
      }
      if (!output.write(buf)) {
        output.once('drain', onDrain)
        output.once('error', onError)
      } else {
        process.nextTick(onDrain)
      }
    })
  }

  for (const entry of entries) {
    const raw = fs.readFileSync(entry.absPath)
    const crc = crc32(raw)
    const method = shouldStore(entry.zipName) ? 0 : 8
    const data = method === 8 ? zlib.deflateRawSync(raw, { level: 6 }) : raw
    const nameBuf = Buffer.from(entry.zipName, 'utf8')
    const modTime = dosTime(entry.mtime)
    const modDate = dosDate(entry.mtime)

    const local = buildLocalHeader({
      nameBuf, crc, compSize: data.length, uncompSize: raw.length,
      method, modTime, modDate,
    })

    // 记录中央目录信息（在写本地头之前记录其起始 offset）
    centralRecords.push(buildCentralHeader({
      nameBuf, crc, compSize: data.length, uncompSize: raw.length,
      method, modTime, modDate, offset,
    }))

    await writeChunk(local)
    await writeChunk(data)
    offset += local.length + data.length
    compressedBytes += data.length
  }

  const centralOffset = offset
  const centralBuf = Buffer.concat(centralRecords)
  await writeChunk(centralBuf)
  const eocd = buildEndOfCentralDirectory({
    count: entries.length,
    centralSize: centralBuf.length,
    centralOffset,
  })
  await writeChunk(eocd)

  return {
    fileCount: entries.length,
    totalBytes,
    compressedBytes: compressedBytes + centralBuf.length + eocd.length,
  }
}

export const ZIP_DEFAULTS = {
  MAX_TOTAL_BYTES: DEFAULT_MAX_TOTAL_BYTES,
  MAX_FILES: DEFAULT_MAX_FILES,
}
