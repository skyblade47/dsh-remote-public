// 工作区文件系统操作：路径遍历防护 + 文件树 + 文件预览。
// 设计要点（对应设计文档 §4）：
// 1) 路径遍历三重防护：输入校验 + 规范化比对 + 符号链接不跟随
// 2) 文件树深度限制（默认 5，硬上限 10）
// 3) 文件数限制（默认 100,000）防止 DoS
// 4) 文本/二进制判定按扩展名白名单，二进制文件不预览内容
// 5) .dsh-workspace.json 不出现在文件树中（内部元信息不暴露给客户端）
import fs from 'node:fs'
import path from 'node:path'

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.markdown',
  '.txt', '.yaml', '.yml', '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.svg', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.sh',
  '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd', '.toml',
  '.ini', '.conf', '.env', '.log', '.csv', '.tsv', '.sql',
  '.graphql', '.gql', '.proto',
])

// 无扩展名的已知文本文件名（大小写不敏感）
const KNOWN_TEXT_NO_EXT = new Set([
  'readme', 'makefile', 'license', 'changelog', 'authors',
  'contributors', 'dockerfile', 'gemfile', 'rakefile',
])

// 工作区内部元信息文件名：不出现在文件树中，且禁止经写 API 修改
export const PROTECTED_META_FILE = '.dsh-workspace.json'

const DEFAULT_MAX_DEPTH = 10
const DEFAULT_MAX_FILES = 100_000
const DEFAULT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024 // 10MB 文本预览上限
const DEFAULT_FILE_MAX_BYTES = 100 * 1024 * 1024 // 100MB 单文件下载上限

/**
 * 安全解析路径。三重防护：
 * L1 输入校验：路径段中包含 .. 即拒绝
 * L2 规范化比对：resolve 后必须仍在 root 下
 * L3 符号链接：在调用方处理（buildFileTree / readFileMeta 中 lstatSync）
 * 分隔符：`\` 与 `/` 视为**等价**（先归一化再 resolve，与 L1 的 `split(/[\\/]/)` 同口径）
 */
export function safeResolve(root, requestedPath) {
  if (typeof requestedPath !== 'string') {
    requestedPath = ''
  }
  const rootAbs = path.resolve(root)

  // 空路径、当前目录、根斜杠都直接返回根（避免 Windows 盘符大小写差异误判）
  if (requestedPath === '' || requestedPath === '.' || requestedPath === './' || requestedPath === '/') {
    return rootAbs
  }

  // L1: 输入校验，路径段中禁止出现 ..
  const segments = requestedPath.split(/[\\/]/).filter(Boolean)
  for (const seg of segments) {
    if (seg === '..') {
      const err = new Error('path traversal detected: .. segment')
      err.code = 'PATH_TRAVERSAL_DETECTED'
      throw err
    }
  }

  // 🔴 分隔符归一化 —— 必须与 L1 的判定口径**一致**：
  //    L1 的遍历校验是 `split(/[\\/]/)`（**认**反斜杠为分隔符），但 `path.resolve` 在 POSIX 上
  //    把 `\` 当**普通字符** ⇒ `src\index.js` 会被解析成"文件名里含反斜杠的那一个条目"，
  //    与 L1 自相矛盾（客户端在跨平台场景会传 Windows 风格相对路径）。
  //    ⚠️ 只做「`\` → `/`」这一件事：**不过滤空段、不去前导 `/`** —— 否则 `/etc/passwd`
  //       会从"L2 越界拒绝"退化成"被当成 root 下的 etc/passwd 而放行"，削弱 L2（有专测守着）。
  const normalizedPath = requestedPath.replace(/\\/g, '/')

  // L2: 规范化比对
  const target = path.resolve(rootAbs, normalizedPath)
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    const err = new Error('path traversal detected: resolved outside root')
    err.code = 'PATH_TRAVERSAL_DETECTED'
    throw err
  }
  return target
}

export function isTextFile(filename) {
  const base = path.basename(filename).toLowerCase()
  const ext = path.extname(base)
  if (!ext) return KNOWN_TEXT_NO_EXT.has(base)
  return TEXT_EXTENSIONS.has(ext)
}

/**
 * 受保护条目判定：仅当条目恰为工作区根目录下该精确名时为 true。
 * 子目录中的同名文件不受保护（与 buildFileTree 的隐藏规则一致）。
 */
export function isProtectedEntry(root, absPath) {
  const rootAbs = path.resolve(root)
  const target = path.resolve(absPath)
  return path.dirname(target) === rootAbs && path.basename(target) === PROTECTED_META_FILE
}

/**
 * 生成版本串（ETag 形态，含双引号）："<mtimeMs>-<size>"
 * @param {{ mtimeMs: number, size: number }} stat fs.Stats 或 readFileMeta 结果
 */
export function formatVersion(stat) {
  return `"${stat.mtimeMs}-${stat.size}"`
}

/**
 * 解析版本串：容忍带/不带双引号；畸形返回 null。
 * @returns {{ mtimeMs: number, size: number } | null}
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  const m = /^(\d+(?:\.\d+)?)-(\d+)$/.exec(s)
  if (!m) return null
  const mtimeMs = Number(m[1])
  const size = Number(m[2])
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return null
  return { mtimeMs, size }
}

/**
 * 构建文件树。
 * @param {string} root 工作区物理根目录
 * @param {string} requestedPath 子路径（相对 root，默认 ''）
 * @param {number} depth 递归深度（默认 5）
 * @param {object} opts 可选：{ maxDepth, maxFiles }
 * @returns 树节点 { type, name, children?, size? }
 */
export function buildFileTree(root, requestedPath = '', depth = 5, opts = {}) {
  const maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH
  if (depth > maxDepth) {
    const err = new Error(`depth ${depth} exceeds max ${maxDepth}`)
    err.code = 'PATH_TOO_DEEP'
    throw err
  }
  if (depth < 0) {
    const err = new Error('depth must be >= 0')
    err.code = 'INVALID_DEPTH'
    throw err
  }
  const absRoot = safeResolve(root, requestedPath)
  const ctx = { count: { n: 0 }, maxFiles: opts.maxFiles || DEFAULT_MAX_FILES }
  return _buildTree(absRoot, depth, ctx)
}

function _buildTree(absPath, depth, ctx) {
  const name = path.basename(absPath)
  let stat
  try {
    stat = fs.lstatSync(absPath)
  } catch (e) {
    // 文件不存在或无权限，跳过
    return { type: 'other', name }
  }

  // L3: 符号链接一律不跟随
  if (stat.isSymbolicLink()) {
    return { type: 'symlink', name }
  }
  if (stat.isFile()) {
    _bumpFileCount(ctx)
    return { type: 'file', name, size: stat.size }
  }
  if (stat.isDirectory()) {
    if (depth <= 0) {
      // 不递归，只返回目录本身（不带 children 字段）
      return { type: 'dir', name }
    }
    const node = { type: 'dir', name, children: [] }
    let entries
    try {
      entries = fs.readdirSync(absPath, { withFileTypes: true })
    } catch (e) {
      // 无权限读目录，返回空 children
      return node
    }
    for (const e of entries) {
      // 内部元信息文件不暴露给客户端
      if (e.name === PROTECTED_META_FILE) continue
      const childPath = path.join(absPath, e.name)
      if (e.isSymbolicLink()) {
        node.children.push({ type: 'symlink', name: e.name })
      } else if (e.isFile()) {
        _bumpFileCount(ctx)
        let size = 0
        try { size = fs.lstatSync(childPath).size } catch {}
        node.children.push({ type: 'file', name: e.name, size })
      } else if (e.isDirectory()) {
        node.children.push(_buildTree(childPath, depth - 1, ctx))
      }
      // 其他类型（FIFO、socket、device）跳过
    }
    return node
  }
  return { type: 'other', name }
}

function _bumpFileCount(ctx) {
  ctx.count.n++
  if (ctx.count.n > ctx.maxFiles) {
    const err = new Error(`file count exceeds limit ${ctx.maxFiles}`)
    err.code = 'TOO_MANY_FILES'
    throw err
  }
}

/**
 * 读取文件元信息（不读内容）。
 * @returns { name, size, binary } 或抛错
 */
export function readFileMeta(root, requestedPath) {
  const absPath = safeResolve(root, requestedPath)
  let stat
  try {
    stat = fs.lstatSync(absPath)
  } catch (e) {
    const err = new Error('path not found')
    err.code = 'PATH_NOT_FOUND'
    throw err
  }
  // 符号链接不跟随
  if (stat.isSymbolicLink()) {
    const err = new Error('cannot read symlink: symlink not followed')
    err.code = 'SYMLINK_NOT_FOLLOWED'
    throw err
  }
  if (!stat.isFile()) {
    const err = new Error('not a regular file')
    err.code = 'NOT_A_FILE'
    throw err
  }
  const name = path.basename(absPath)
  return {
    name,
    size: stat.size,
    binary: !isTextFile(name),
    mtimeMs: stat.mtimeMs,
  }
}

/**
 * 读取文本文件内容（仅文本文件，二进制抛 BINARY_FILE）。
 * @param {number} maxBytes 预览上限（默认 10MB）
 */
export function readTextContent(root, requestedPath, maxBytes = DEFAULT_PREVIEW_MAX_BYTES) {
  const meta = readFileMeta(root, requestedPath)
  if (meta.binary) {
    const err = new Error('binary file: use download endpoint instead')
    err.code = 'BINARY_FILE'
    throw err
  }
  if (meta.size > maxBytes) {
    const err = new Error(`file too large for preview: ${meta.size} > ${maxBytes}`)
    err.code = 'FILE_TOO_LARGE'
    throw err
  }
  const absPath = safeResolve(root, requestedPath)
  return fs.readFileSync(absPath, 'utf8')
}

/**
 * 读取二进制文件流（用于下载）。
 * 返回 Buffer。单文件大小硬上限 100MB（可配置）。
 */
export function readFileForDownload(root, requestedPath, maxBytes = DEFAULT_FILE_MAX_BYTES) {
  const meta = readFileMeta(root, requestedPath)
  if (meta.size > maxBytes) {
    const err = new Error(`file too large for download: ${meta.size} > ${maxBytes}`)
    err.code = 'FILE_TOO_LARGE'
    throw err
  }
  const absPath = safeResolve(root, requestedPath)
  return {
    buffer: fs.readFileSync(absPath),
    name: meta.name,
    size: meta.size,
  }
}

export const DEFAULTS = {
  MAX_DEPTH: DEFAULT_MAX_DEPTH,
  MAX_FILES: DEFAULT_MAX_FILES,
  PREVIEW_MAX_BYTES: DEFAULT_PREVIEW_MAX_BYTES,
  FILE_MAX_BYTES: DEFAULT_FILE_MAX_BYTES,
  TEXT_EXTENSIONS: Array.from(TEXT_EXTENSIONS),
}
