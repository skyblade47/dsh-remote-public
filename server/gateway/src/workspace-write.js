// 工作区写操作 fs 原语（设计文档 §4）。
// 约定：本文件不出现 req/res 与 HTTP 状态码；错误以 err.code 抛出，由路由层 sendFsError 映射。
// 写盘流程：同目录临时文件（flag: 'wx' 排他创建）→ renameSync 原子替换。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { safeResolve, isTextFile, isProtectedEntry, formatVersion } from './workspace-fs.js'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 单次写入内容上限 10MB
const DEFAULT_MAX_ENTRIES = 10_000 // 递归删除条目上限

// 临时文件名的单调计数器（同进程内避免复用旧名）
let tmpCounter = 0

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 文本内容 hash，审计字段形如 sha256:<hex> */
function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 行数：空串为 0；忽略结尾单个换行（'a\n' 为 1 行） */
function lineCount(text) {
  if (text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

/**
 * 行变更规模（非 LCS diff，仅规模指标）：按 \n 切分为行多重集做计数差。
 */
function lineStats(oldText, newText) {
  const tally = (text) => {
    const map = new Map()
    if (text === '') return map
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    for (const line of body.split('\n')) map.set(line, (map.get(line) || 0) + 1)
    return map
  }
  const before = tally(oldText)
  const after = tally(newText)
  let linesAdded = 0
  let linesRemoved = 0
  for (const [line, n] of after) {
    const old = before.get(line) || 0
    if (n > old) linesAdded += n - old
  }
  for (const [line, n] of before) {
    const now = after.get(line) || 0
    if (n > now) linesRemoved += n - now
  }
  return { linesAdded, linesRemoved }
}

function lstatOrNull(abs) {
  try {
    return fs.lstatSync(abs)
  } catch {
    return null
  }
}

/** 路径合法性：必须是工作区内的非根条目，且不是受保护的元信息文件 */
function assertWritable(root, relPath) {
  const abs = safeResolve(root, relPath)
  if (abs === path.resolve(root)) {
    throw fail('INVALID_PATH', '不允许对工作区根执行写操作')
  }
  if (isProtectedEntry(root, abs)) {
    throw fail('PROTECTED_ENTRY', '工作区元信息文件受保护，不可写')
  }
  return abs
}

/** 父目录必须存在、非符号链接、且是目录 */
function assertParentDir(abs) {
  const parent = path.dirname(abs)
  const st = lstatOrNull(parent)
  if (!st) throw fail('PARENT_NOT_FOUND', '父目录不存在')
  if (st.isSymbolicLink()) throw fail('SYMLINK_NOT_FOLLOWED', '父目录是符号链接，不跟随')
  if (!st.isDirectory()) throw fail('NOT_A_DIRECTORY', '父路径不是目录')
  return parent
}

/** 文本白名单 + 内容大小校验 */
function assertTextContent(abs, content, maxBytes) {
  if (typeof content !== 'string') throw fail('BAD_REQUEST', 'content 必须是字符串')
  if (!isTextFile(path.basename(abs))) {
    throw fail('UNSUPPORTED_FILE_TYPE', '该文件类型不支持在线编辑')
  }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw fail('CONTENT_TOO_LARGE', `内容超过上限 ${maxBytes} 字节`)
  }
}

/** 原子写：同目录 tmp（wx 排他创建）+ renameSync；失败时清理 tmp 后抛原错 */
function atomicWrite(abs, content) {
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${process.pid}.${++tmpCounter}.tmp`
  )
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(tmp, abs)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

/**
 * 源条目 stat 校验（写/删/移共用）。
 * kind='file' 时要求是普通文件；force 为 true 时跳过版本比对。
 */
function assertSourceStat(abs, { expectedVersion = null, force = false, kind = 'any' } = {}) {
  const st = lstatOrNull(abs)
  if (!st) throw fail('PATH_NOT_FOUND', '路径不存在')
  if (st.isSymbolicLink()) throw fail('SYMLINK_NOT_FOLLOWED', '符号链接不跟随')
  if (kind === 'file' && !st.isFile()) throw fail('NOT_A_FILE', '路径不是普通文件')
  if (!force && expectedVersion !== null && expectedVersion !== formatVersion(st)) {
    const e = fail('VERSION_CONFLICT', '版本不一致，请重新读取后再试')
    e.currentVersion = formatVersion(st)
    throw e
  }
  return st
}

/**
 * 新建文本文件。目标已存在（文件或目录）→ ENTRY_EXISTS；父级缺失 → PARENT_NOT_FOUND。
 * @returns {{ path: string, size: number, version: string, hash: string, lines: number }}
 */
export function createTextFile(root, relPath, content, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const abs = assertWritable(root, relPath)
  assertParentDir(abs)
  assertTextContent(abs, content, maxBytes)
  if (lstatOrNull(abs)) throw fail('ENTRY_EXISTS', '目标已存在')

  atomicWrite(abs, content)
  const st = fs.lstatSync(abs)
  return {
    path: relPath,
    size: st.size,
    version: formatVersion(st),
    hash: sha256(content),
    lines: lineCount(content),
  }
}

/**
 * 修改已有文本文件。
 * 校验顺序刻意如此：源 stat（缺失/目录/版本）→ 文本白名单 → 内容大小。
 * 若先查白名单，`PUT` 一个无扩展名目录会误报 UNSUPPORTED_FILE_TYPE（设计要求 NOT_A_FILE）。
 * @returns {{ path, size, version, oldHash, newHash, linesAdded, linesRemoved }}
 */
export function updateTextFile(
  root,
  relPath,
  content,
  { expectedVersion = null, force = false, maxBytes = DEFAULT_MAX_BYTES } = {}
) {
  const abs = assertWritable(root, relPath)
  assertSourceStat(abs, { expectedVersion, force, kind: 'file' })
  assertTextContent(abs, content, maxBytes)

  const oldText = fs.readFileSync(abs, 'utf8')
  const { linesAdded, linesRemoved } = lineStats(oldText, content)
  atomicWrite(abs, content)
  const after = fs.lstatSync(abs)

  return {
    path: relPath,
    size: after.size,
    version: formatVersion(after),
    oldHash: sha256(oldText),
    newHash: sha256(content),
    linesAdded,
    linesRemoved,
  }
}

/**
 * 迭代式收集待删条目（不用递归函数、不用 fs.rm），先完整计数后执行。
 * - 显式栈 DFS；symlink 只计链接本身、不跟随
 * - 目录按"发现顺序"记录后反序，保证子先于父 rmdir
 * - 计数超过 maxEntries 立即抛 TOO_MANY_FILES（此时尚未删除任何条目）
 * @returns {{ files: string[], dirs: string[] }} dirs 已自底向上排序
 */
function collectEntries(rootAbs, maxEntries) {
  const files = []
  const dirs = []
  const stack = [rootAbs]
  let count = 0

  const bump = () => {
    count++
    if (count > maxEntries) throw fail('TOO_MANY_FILES', `待删除条目数超过上限 ${maxEntries}`)
  }

  while (stack.length > 0) {
    const cur = stack.pop()
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const child = path.join(cur, e.name)
      if (e.isSymbolicLink()) {
        bump()
        files.push(child) // 只删链接本身
      } else if (e.isFile()) {
        bump()
        files.push(child)
      } else if (e.isDirectory()) {
        bump()
        dirs.push(child)
        stack.push(child)
      }
    }
  }
  dirs.reverse()
  return { files, dirs }
}

/**
 * 删除文件或目录。
 * - 目录默认拒绝（DIRECTORY_NOT_EMPTY），须显式 recursive=true
 * - recursive 时先完整计数（上限 maxEntries），超限不删除任何条目
 * - 目录不支持版本校验（携带版本 → BAD_REQUEST）
 * @returns {{ path: string, removedCount: number, oldHash: string | null }}
 */
export function removeEntry(
  root,
  relPath,
  { recursive = false, expectedVersion = null, maxEntries = DEFAULT_MAX_ENTRIES } = {}
) {
  const abs = assertWritable(root, relPath)
  // 先只校验存在性与类型（force: true 跳过版本比对），版本语义分文件/目录单独处理
  const st = assertSourceStat(abs, { force: true })

  if (st.isDirectory() && expectedVersion !== null) {
    throw fail('BAD_REQUEST', '目录不支持版本校验，请去掉版本参数')
  }

  if (st.isFile()) {
    if (expectedVersion !== null && expectedVersion !== formatVersion(st)) {
      const e = fail('VERSION_CONFLICT', '版本不一致，请重新读取后再试')
      e.currentVersion = formatVersion(st)
      throw e
    }
    const buf = fs.readFileSync(abs)
    const oldHash = 'sha256:' + createHash('sha256').update(buf).digest('hex')
    fs.unlinkSync(abs)
    return { path: relPath, removedCount: 1, oldHash }
  }

  if (!st.isDirectory()) throw fail('NOT_A_FILE', '不支持的条目类型，无法删除')

  if (!recursive) {
    if (fs.readdirSync(abs).length > 0) {
      throw fail('DIRECTORY_NOT_EMPTY', '目录非空，需显式 recursive=true')
    }
    fs.rmdirSync(abs)
    return { path: relPath, removedCount: 1, oldHash: null }
  }

  const plan = collectEntries(abs, maxEntries)
  for (const f of plan.files) fs.unlinkSync(f)
  for (const d of plan.dirs) fs.rmdirSync(d)
  fs.rmdirSync(abs)
  return { path: relPath, removedCount: plan.files.length + plan.dirs.length + 1, oldHash: null }
}

/**
 * 重命名/移动条目（文件或目录）。
 * - 不做 Unix"移入目录"语义：目标为已存在目录时一律拒绝（TARGET_IS_DIRECTORY）
 * - 目标父目录必须已存在（PARENT_NOT_FOUND），不隐式创建
 * - force 仅表示"允许覆盖已存在文件"，同时跳过版本校验
 * @returns {{ from, path, size, version: string | null, hash: string | null }}
 */
export function moveEntry(root, relPath, newRelPath, { force = false, expectedVersion = null } = {}) {
  const abs = assertWritable(root, relPath)
  if (typeof newRelPath !== 'string' || newRelPath === '') {
    throw fail('INVALID_PATH', 'newPath 缺失或为空')
  }
  const absNew = assertWritable(root, newRelPath)

  if (absNew === abs) throw fail('INVALID_MOVE', '源路径与目标路径相同')
  if (absNew.startsWith(abs + path.sep)) throw fail('INVALID_MOVE', '不允许移动到自身子树')

  const st = assertSourceStat(abs, { expectedVersion, force })
  if (!st.isFile() && !st.isDirectory()) throw fail('NOT_A_FILE', '不支持的条目类型')

  // 目标父目录
  const parent = path.dirname(absNew)
  const pst = lstatOrNull(parent)
  if (!pst) throw fail('PARENT_NOT_FOUND', '目标父目录不存在')
  if (pst.isSymbolicLink()) throw fail('SYMLINK_NOT_FOLLOWED', '目标父目录是符号链接，不跟随')
  if (!pst.isDirectory()) throw fail('NOT_A_DIRECTORY', '目标父路径不是目录')

  // 目标已存在：必须先 lstat 判定类型，避免 Windows 上 rename 文件覆盖目录抛 EPERM
  const target = lstatOrNull(absNew)
  if (target) {
    if (!force) throw fail('ENTRY_EXISTS', '目标已存在')
    if (target.isSymbolicLink()) throw fail('SYMLINK_NOT_FOLLOWED', '目标符号链接不跟随')
    if (target.isDirectory()) throw fail('TARGET_IS_DIRECTORY', '目标已存在同名目录，拒绝覆盖')
    if (st.isDirectory()) throw fail('TARGET_IS_DIRECTORY', '目录不能覆盖已存在文件')
  }

  fs.renameSync(abs, absNew)

  if (st.isFile()) {
    const after = fs.lstatSync(absNew)
    const buf = fs.readFileSync(absNew)
    return {
      from: relPath,
      path: newRelPath,
      size: after.size,
      version: formatVersion(after),
      hash: 'sha256:' + createHash('sha256').update(buf).digest('hex'),
    }
  }
  return { from: relPath, path: newRelPath, size: 0, version: null, hash: null }
}

/**
 * 新建目录（不隐式创建父目录）。
 * @returns {{ path: string }}
 */
export function makeDirectory(root, relPath) {
  const abs = assertWritable(root, relPath)
  assertParentDir(abs)
  if (lstatOrNull(abs)) throw fail('ENTRY_EXISTS', '目标已存在')
  fs.mkdirSync(abs)
  return { path: relPath }
}
