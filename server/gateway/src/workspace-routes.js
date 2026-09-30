// 工作区路由处理器（设计文档 §3）。
// 路由：
//   GET    /api/workspaces                       → 列出当前用户的工作区
//   POST   /api/workspaces                       → 创建空工作区
//   GET    /api/workspaces/:id                   → 工作区元信息
//   DELETE /api/workspaces/:id                   → 删除工作区
//   GET    /api/workspaces/:id/tree?depth=N      → 文件树
//   GET    /api/workspaces/:id/files/*           → 单文件预览（文本原样 / 二进制仅元信息）
//   GET    /api/workspaces/:id/download?path=    → 单文件下载（attachment）
//   GET    /api/workspaces/:id/download-zip      → 整工作区 ZIP 下载
//
// 所有路由均需认证；index.js 中先走 authMiddleware 再调用 match。
import {
  buildFileTree,
  readFileMeta,
  readTextContent,
  readFileForDownload,
  formatVersion,
} from './workspace-fs.js'
import {
  createTextFile,
  updateTextFile,
  removeEntry,
  moveEntry,
  makeDirectory,
} from './workspace-write.js'
import { createWorkspaceStore, resolveWorkspacesRoot, isValidWorkspaceId } from './workspace-store.js'
import { streamWorkspaceZip, ZIP_DEFAULTS } from './workspace-zip.js'
import { createRateLimiter } from './ratelimit.js'

// 请求体上限 12MB（为 JSON 转义留余量）；写入内容上限 10MB（与读侧预览上限对称）
const WRITE_BODY_MAX_BYTES = 12 * 1024 * 1024
const WRITE_MAX_CONTENT_BYTES = 10 * 1024 * 1024

// 写失败需要留痕的安全/并发错误码（设计文档 §5）
const AUDITED_WRITE_ERRORS = new Set([
  'VERSION_CONFLICT',
  'PROTECTED_ENTRY',
  'DIRECTORY_NOT_EMPTY',
  'INVALID_MOVE',
  'SYMLINK_NOT_FOLLOWED',
  'PATH_TRAVERSAL_DETECTED',
])

/**
 * 读取并解析 JSON 请求体。
 * 超限时**先发响应再排空**：实测对仍在发送的请求体调用 req.destroy() 会让客户端收到
 * ECONNRESET 而非 413，因此这里 reject 后由调用方先回 413，再 req.resume() 排空剩余字节。
 */
function readBody(req, { maxBytes = WRITE_BODY_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0
    let body = ''
    let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > maxBytes) {
        done = true
        const e = new Error(`请求体超过上限 ${maxBytes} 字节`)
        e.code = 'PAYLOAD_TOO_LARGE'
        reject(e)
        return
      }
      body += c
    })
    req.on('end', () => {
      if (done) return
      done = true
      try { resolve(body ? JSON.parse(body) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', (e) => {
      if (done) return
      done = true
      reject(e)
    })
  })
}

/** 写端点统一读体：失败时已写好响应，返回 { ok: false } */
async function readJsonBody(req, res, maxBytes = WRITE_BODY_MAX_BYTES) {
  try {
    return { ok: true, body: await readBody(req, { maxBytes }) }
  } catch (e) {
    if (e.code === 'PAYLOAD_TOO_LARGE') {
      err(res, 413, 'PAYLOAD_TOO_LARGE', '请求体超过 12MB 上限')
      req.resume() // 排空剩余请求体，避免客户端拿到 ECONNRESET
      return { ok: false }
    }
    err(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON')
    return { ok: false }
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function err(res, status, code, message, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify({ ok: false, error: { code, message } }))
}

// RFC 6266：ASCII 回退名 + filename* 传递 UTF-8 原名
function contentDisposition(filename) {
  const ascii = String(filename)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\\r\n]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

// 文件系统层错误码 → HTTP 状态映射
function sendFsError(res, e) {
  switch (e.code) {
    case 'PATH_TRAVERSAL_DETECTED':
      return err(res, 400, 'PATH_TRAVERSAL_DETECTED', '检测到路径遍历尝试')
    case 'PATH_TOO_DEEP':
    case 'INVALID_DEPTH':
      return err(res, 400, e.code, e.message)
    case 'PATH_NOT_FOUND':
      return err(res, 404, 'PATH_NOT_FOUND', '文件或目录不存在')
    case 'SYMLINK_NOT_FOLLOWED':
      return err(res, 400, 'SYMLINK_NOT_FOLLOWED', '符号链接不跟随')
    case 'NOT_A_FILE':
      return err(res, 400, 'NOT_A_FILE', '路径不是普通文件')
    case 'INVALID_PATH':
      return err(res, 400, 'INVALID_PATH', e.message)
    case 'PROTECTED_ENTRY':
      return err(res, 400, 'PROTECTED_ENTRY', '工作区元信息文件受保护，不可写')
    case 'NOT_A_DIRECTORY':
      return err(res, 400, 'NOT_A_DIRECTORY', '路径不是目录')
    case 'INVALID_MOVE':
      return err(res, 400, 'INVALID_MOVE', '不允许移动到自身或自身子树')
    case 'BAD_REQUEST':
      return err(res, 400, 'BAD_REQUEST', e.message)
    case 'UNSUPPORTED_ENCODING':
      return err(res, 400, 'UNSUPPORTED_ENCODING', '仅支持 utf-8 编码')
    case 'ENTRY_EXISTS':
      return err(res, 409, 'ENTRY_EXISTS', '目标已存在')
    case 'PARENT_NOT_FOUND':
      return err(res, 409, 'PARENT_NOT_FOUND', '父目录不存在')
    case 'DIRECTORY_NOT_EMPTY':
      return err(res, 409, 'DIRECTORY_NOT_EMPTY', '目录非空，需显式 recursive=true')
    case 'TARGET_IS_DIRECTORY':
      return err(res, 409, 'TARGET_IS_DIRECTORY', '目标已存在同名目录，拒绝覆盖')
    case 'UNSUPPORTED_FILE_TYPE':
      return err(res, 415, 'UNSUPPORTED_FILE_TYPE', '该文件类型不支持在线编辑')
    case 'CONTENT_TOO_LARGE':
      return err(res, 413, 'CONTENT_TOO_LARGE', e.message)
    case 'PAYLOAD_TOO_LARGE':
      return err(res, 413, 'PAYLOAD_TOO_LARGE', '请求体超过 12MB 上限')
    case 'VERSION_CONFLICT':
      res.writeHead(409, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        ok: false,
        error: { code: 'VERSION_CONFLICT', message: '版本不一致，请重新读取后再试' },
        currentVersion: e.currentVersion ?? null,
      }))
    case 'INVALID_WORKSPACE_ID':
      return err(res, 400, 'INVALID_WORKSPACE_ID', '非法工作区 ID')
    case 'WORKSPACE_LIMIT_REACHED':
      return err(res, 400, 'WORKSPACE_LIMIT_REACHED', e.message)
    case 'FILE_TOO_LARGE':
      return err(res, 413, 'FILE_TOO_LARGE', e.message)
    case 'TOO_MANY_FILES':
      return err(res, 413, 'TOO_MANY_FILES', e.message)
    case 'WORKSPACE_TOO_LARGE':
      return err(res, 413, 'WORKSPACE_TOO_LARGE', e.message)
    default:
      return err(res, 500, 'INTERNAL_ERROR', e.message || '内部错误')
  }
}

export function createWorkspaceRoutes({ audit, env = process.env } = {}) {
  const store = createWorkspaceStore(resolveWorkspacesRoot(env))
  // ZIP 下载限速：10 次/分钟/用户（设计文档 §4.3）
  const zipLimiter = createRateLimiter({ maxAttempts: 10, windowMs: 60_000 })
  const noopAudit = { log() {} }
  const auditLog = audit || noopAudit

  const writeLimiter = createRateLimiter({ maxAttempts: 60, windowMs: 60_000 })

  /** 写端点限速检查；超限时已回 429 并审计，返回 false */
  function checkWriteLimit(req, res, relPath) {
    const limit = writeLimiter.check(req.user.id)
    if (limit.allowed) return true
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfter / 1000))
    auditLog.log('workspace.write_rate_limited', {
      userId: req.user.id, workspaceId: req.params.id, path: relPath,
    })
    err(res, 429, 'RATE_LIMITED', '写操作过于频繁，请稍后再试', { 'retry-after': String(retryAfter) })
    return false
  }

  /** 写原语统一出口：安全/并发错误记 write_failed，其余错误只映射状态码 */
  function finishWrite(req, res, relPath, work) {
    try {
      return work()
    } catch (e) {
      if (AUDITED_WRITE_ERRORS.has(e.code)) {
        auditLog.log('workspace.write_failed', {
          userId: req.user.id, workspaceId: req.params.id, path: relPath, errorCode: e.code,
        })
      }
      sendFsError(res, e)
    }
  }

  /** 文件写/移成功响应：JSON + ETag 头（与 version 同值） */
  function respondFile(res, status, r) {
    res.writeHead(status, { 'content-type': 'application/json', etag: r.version })
    res.end(JSON.stringify({ ok: true, path: r.path, version: r.version, size: r.size }))
  }

  // 工作区摘要。`path` 是该工作区的**绝对物理目录**（服务端权威值，客户端不自行拼接）：
  // 「在此工作区开对话」要用它作为内核 `session.create` 的 `cwd`（设计文档 §2.2 软对接）。
  // 与元信息里的 `cwd`（工作区内的相对根，默认 `/`）不是同一个概念，故另立字段。
  function summary(meta, dir) {
    return {
      id: meta.id,
      name: meta.name,
      path: dir,
      createdAt: meta.createdAt,
      createdAtIso: meta.createdAtIso,
    }
  }

  // 归属校验：不存在 → 404，属于他人 → 403（设计文档 §4.2）
  // 返回 { meta, dir }
  function resolveOwned(req, res) {
    const id = req.params.id
    if (!isValidWorkspaceId(id)) {
      err(res, 400, 'INVALID_WORKSPACE_ID', '非法工作区 ID')
      return null
    }
    const found = store.findWorkspaceOwner(id)
    if (!found) {
      err(res, 404, 'WORKSPACE_NOT_FOUND', '工作区不存在')
      return null
    }
    if (found.userId !== req.user.id) {
      auditLog.log('workspace.access_denied', {
        userId: req.user.id, workspaceId: id, ownerId: found.userId,
      })
      err(res, 403, 'FORBIDDEN_WORKSPACE', '无权访问该工作区')
      return null
    }
    return { meta: found.meta, dir: store.workspaceDir(req.user.id, id) }
  }

  const handlers = {
    // GET /api/workspaces
    list(req, res) {
      const list = store.listWorkspaces(req.user.id)
        .map((meta) => summary(meta, store.workspaceDir(req.user.id, meta.id)))
      json(res, 200, { ok: true, workspaces: list })
    },

    // POST /api/workspaces
    async create(req, res) {
      let body = {}
      try {
        body = await readBody(req)
      } catch {
        return err(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON')
      }
      try {
        const meta = store.createWorkspace({ userId: req.user.id, name: body.name })
        auditLog.log('workspace.create', { userId: req.user.id, workspaceId: meta.id, name: meta.name })
        const dir = store.workspaceDir(req.user.id, meta.id)
        json(res, 201, { ok: true, workspace: { ...summary(meta, dir), cwd: meta.cwd, tags: meta.tags } })
      } catch (e) {
        sendFsError(res, e)
      }
    },

    // GET /api/workspaces/:id
    detail(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      json(res, 200, {
        ok: true,
        workspace: { ...summary(owned.meta, owned.dir), cwd: owned.meta.cwd, tags: owned.meta.tags },
      })
    },

    // DELETE /api/workspaces/:id
    remove(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      try {
        store.deleteWorkspace(req.user.id, req.params.id)
        auditLog.log('workspace.delete', { userId: req.user.id, workspaceId: req.params.id })
        json(res, 200, { ok: true, deleted: true })
      } catch (e) {
        sendFsError(res, e)
      }
    },

    // GET /api/workspaces/:id/tree?depth=N
    tree(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      let depth = 5
      const raw = req.query.get('depth')
      if (raw !== null) {
        if (!/^\d+$/.test(raw)) {
          return err(res, 400, 'INVALID_DEPTH', 'depth 必须是非负整数')
        }
        depth = Number.parseInt(raw, 10)
      }
      try {
        const root = buildFileTree(owned.dir, '', depth)
        json(res, 200, { ok: true, root })
      } catch (e) {
        sendFsError(res, e)
      }
    },

    // GET /api/workspaces/:id/files/*
    preview(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.params.path
      if (!relPath) {
        return err(res, 400, 'BAD_REQUEST', '缺少文件路径')
      }
      try {
        const meta = readFileMeta(owned.dir, relPath)
        const version = formatVersion(meta)
        if (meta.binary) {
          return json(res, 200, {
            ok: true,
            file: { name: meta.name, size: meta.size, binary: true, version },
          })
        }
        const content = readTextContent(owned.dir, relPath)
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'x-file-name': encodeURIComponent(meta.name),
          'x-file-size': String(meta.size),
          etag: version,
        })
        res.end(content)
      } catch (e) {
        sendFsError(res, e)
      }
    },

    // POST /api/workspaces/:id/files/*
    async fileCreate(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.params.path
      if (!checkWriteLimit(req, res, relPath)) return
      const parsed = await readJsonBody(req, res)
      if (!parsed.ok) return
      const body = parsed.body
      if (typeof body.content !== 'string') {
        return err(res, 400, 'BAD_REQUEST', 'content 必须是字符串')
      }
      if (body.encoding !== undefined && body.encoding !== 'utf-8') {
        return err(res, 400, 'UNSUPPORTED_ENCODING', '仅支持 utf-8 编码')
      }
      finishWrite(req, res, relPath, () => {
        const r = createTextFile(owned.dir, relPath, body.content, {
          maxBytes: WRITE_MAX_CONTENT_BYTES,
        })
        auditLog.log('workspace.file_create', {
          userId: req.user.id, workspaceId: req.params.id, path: r.path,
          size: r.size, hash: r.hash, lines: r.lines,
        })
        res.writeHead(201, { 'content-type': 'application/json', etag: r.version })
        res.end(JSON.stringify({ ok: true, path: r.path, version: r.version, size: r.size }))
      })
    },

    // PUT /api/workspaces/:id/files/*
    async fileUpdate(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.params.path
      if (!checkWriteLimit(req, res, relPath)) return
      const parsed = await readJsonBody(req, res)
      if (!parsed.ok) return
      const body = parsed.body
      if (typeof body.content !== 'string') {
        return err(res, 400, 'BAD_REQUEST', 'content 必须是字符串')
      }
      if (body.encoding !== undefined && body.encoding !== 'utf-8') {
        return err(res, 400, 'UNSUPPORTED_ENCODING', '仅支持 utf-8 编码')
      }
      // 内容大小在源 stat 之前判定：与读侧对称，也避免不存在路径先报 404
      if (Buffer.byteLength(body.content, 'utf8') > WRITE_MAX_CONTENT_BYTES) {
        return err(res, 413, 'CONTENT_TOO_LARGE', `内容超过上限 ${WRITE_MAX_CONTENT_BYTES} 字节`)
      }

      const force = req.query.get('force') === 'true'
      const headerVersion = req.headers['if-match']
      // 两通道等价，If-Match 优先
      const expectedVersion = typeof headerVersion === 'string' && headerVersion !== ''
        ? headerVersion
        : (typeof body.version === 'string' ? body.version : null)
      if (expectedVersion === null && !force) {
        return err(
          res, 428, 'PRECONDITION_REQUIRED',
          '缺少版本前置条件：请提供 If-Match 头或 body.version，或使用 force=true'
        )
      }

      finishWrite(req, res, relPath, () => {
        // 源存在性/类型先行：非文本类型一律 415，不与版本比对纠缠
        if (readFileMeta(owned.dir, relPath).binary) {
          throw Object.assign(
            new Error('该文件类型不支持在线编辑'),
            { code: 'UNSUPPORTED_FILE_TYPE' }
          )
        }
        const r = updateTextFile(owned.dir, relPath, body.content, {
          expectedVersion, force, maxBytes: WRITE_MAX_CONTENT_BYTES,
        })
        auditLog.log('workspace.file_update', {
          userId: req.user.id, workspaceId: req.params.id, path: r.path,
          size: r.size, oldHash: r.oldHash, newHash: r.newHash,
          oldVersion: expectedVersion, newVersion: r.version,
          linesAdded: r.linesAdded, linesRemoved: r.linesRemoved, forced: force,
        })
        respondFile(res, 200, r)
      })
    },

    // DELETE /api/workspaces/:id/files/*?recursive=true
    fileRemove(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.params.path
      if (!checkWriteLimit(req, res, relPath)) return
      // 破坏性动作：仅精确 "true" 视为真，其它值一律按假
      const recursive = req.query.get('recursive') === 'true'
      const headerVersion = req.headers['if-match']
      const hadVersion = typeof headerVersion === 'string' && headerVersion !== ''
      const expectedVersion = hadVersion ? headerVersion : null

      finishWrite(req, res, relPath, () => {
        const r = removeEntry(owned.dir, relPath, { recursive, expectedVersion })
        auditLog.log('workspace.file_delete', {
          userId: req.user.id, workspaceId: req.params.id, path: r.path,
          recursive, removedCount: r.removedCount, oldHash: r.oldHash, hadVersion,
        })
        json(res, 200, { ok: true, deleted: true, removedCount: r.removedCount })
      })
    },

    // PATCH /api/workspaces/:id/files/*?force=true
    async fileMove(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.params.path
      if (!checkWriteLimit(req, res, relPath)) return
      const parsed = await readJsonBody(req, res)
      if (!parsed.ok) return
      const body = parsed.body
      if (typeof body.newPath !== 'string' || body.newPath === '') {
        return err(res, 400, 'INVALID_PATH', 'newPath 缺失或为空')
      }

      const force = req.query.get('force') === 'true' || body.force === true
      const headerVersion = req.headers['if-match']
      const hadVersion = (typeof headerVersion === 'string' && headerVersion !== '')
        || typeof body.version === 'string'
      const expectedVersion = typeof headerVersion === 'string' && headerVersion !== ''
        ? headerVersion
        : (typeof body.version === 'string' ? body.version : null)

      finishWrite(req, res, body.newPath, () => {
        const r = moveEntry(owned.dir, relPath, body.newPath, { force, expectedVersion })
        auditLog.log('workspace.entry_move', {
          userId: req.user.id, workspaceId: req.params.id, from: r.from, path: r.path,
          size: r.size, hash: r.hash, forced: force, hadVersion,
        })
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(r.version === null ? {} : { etag: r.version }),
        })
        res.end(JSON.stringify({
          ok: true, from: r.from, path: r.path, version: r.version, size: r.size,
        }))
      })
    },

    // POST /api/workspaces/:id/dirs/*
    dirCreate(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.params.path
      if (!checkWriteLimit(req, res, relPath)) return
      finishWrite(req, res, relPath, () => {
        const r = makeDirectory(owned.dir, relPath)
        auditLog.log('workspace.dir_create', {
          userId: req.user.id, workspaceId: req.params.id, path: r.path,
        })
        json(res, 201, { ok: true, path: r.path })
      })
    },

    // GET /api/workspaces/:id/download?path=
    download(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const relPath = req.query.get('path') || ''
      if (!relPath) {
        return err(res, 400, 'BAD_REQUEST', '缺少 path 查询参数')
      }
      try {
        const { buffer, name, size } = readFileForDownload(owned.dir, relPath)
        auditLog.log('workspace.download', {
          userId: req.user.id, workspaceId: req.params.id, path: relPath, size,
        })
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': contentDisposition(name),
          'content-length': String(size),
        })
        res.end(buffer)
      } catch (e) {
        sendFsError(res, e)
      }
    },

    // GET /api/workspaces/:id/download-zip
    async downloadZip(req, res) {
      const owned = resolveOwned(req, res)
      if (!owned) return
      const limit = zipLimiter.check(req.user.id)
      if (!limit.allowed) {
        const retryAfter = Math.max(1, Math.ceil(limit.retryAfter / 1000))
        return err(res, 429, 'RATE_LIMITED', 'ZIP 下载过于频繁，请稍后再试', { 'retry-after': String(retryAfter) })
      }
      // WQ3：?includeHidden=false 时排除点开头的文件/目录；缺省或其它值一律包含
      const includeHidden = !['false', '0', 'no'].includes(
        String(req.query.get('includeHidden') ?? '').toLowerCase()
      )
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition(`${owned.meta.name || 'workspace'}.zip`),
      })
      try {
        const result = await streamWorkspaceZip(owned.dir, res, {
          maxTotalBytes: ZIP_DEFAULTS.MAX_TOTAL_BYTES,
          maxFiles: ZIP_DEFAULTS.MAX_FILES,
          includeHidden,
        })
        auditLog.log('workspace.download_zip', {
          userId: req.user.id,
          workspaceId: req.params.id,
          fileCount: result.fileCount,
          totalBytes: result.totalBytes,
          includeHidden,
        })
        res.end()
      } catch (e) {
        auditLog.log('workspace.download_zip_failed', {
          userId: req.user.id, workspaceId: req.params.id, error: e.message,
        })
        if (!res.headersSent) {
          return sendFsError(res, e)
        }
        // 头已发出，无法再回退为 JSON 错误，直接终止流
        res.destroy(e)
      }
    },
  }

  // 显式按段匹配（plugin-routes 的 matchPath 不支持尾部通配，files/* 在此自行处理）
  // 注意：路径必须基于 req.url 原始串手工切分，不能用 new URL()——
  // WHATWG URL 会折叠 .. 段，导致路径遍历请求在匹配前就被规范化（设计要求原始 .. 返回 400）。
  function match(req) {
    const qIndex = req.url.indexOf('?')
    const pathname = qIndex === -1 ? req.url : req.url.slice(0, qIndex)
    const search = qIndex === -1 ? '' : req.url.slice(qIndex + 1)
    const parts = pathname.split('/').slice(1) // 去掉首个空段
    const method = req.method
    req.query = new URLSearchParams(search)

    if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'workspaces') {
      if (method === 'GET') return { handler: handlers.list, params: {} }
      if (method === 'POST') return { handler: handlers.create, params: {} }
      return null
    }

    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'workspaces') {
      const params = { id: safeDecode(parts[2]) }
      if (method === 'GET') return { handler: handlers.detail, params }
      if (method === 'DELETE') return { handler: handlers.remove, params }
      return null
    }

    if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'workspaces') {
      const params = { id: safeDecode(parts[2]) }
      if (parts[3] === 'tree' && method === 'GET') return { handler: handlers.tree, params }
      if (parts[3] === 'download' && method === 'GET') return { handler: handlers.download, params }
      if (parts[3] === 'download-zip' && method === 'GET') return { handler: handlers.downloadZip, params }
      // 无尾部路径的写操作：交给 handler 判空 → 400 INVALID_PATH
      if (parts[3] === 'files' && method === 'POST') {
        return { handler: handlers.fileCreate, params: { ...params, path: '' } }
      }
      if (parts[3] === 'files' && method === 'PUT') {
        return { handler: handlers.fileUpdate, params: { ...params, path: '' } }
      }
      if (parts[3] === 'files' && method === 'DELETE') return { handler: handlers.fileRemove, params: { ...params, path: '' } }
      if (parts[3] === 'files' && method === 'PATCH') return { handler: handlers.fileMove, params: { ...params, path: '' } }
      if (parts[3] === 'dirs' && method === 'POST') {
        return { handler: handlers.dirCreate, params: { ...params, path: '' } }
      }
      return null
    }

    // /api/workspaces/:id/files/<剩余全部段为文件相对路径>
    if (parts.length >= 5 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'files') {
      const params = { id: safeDecode(parts[2]), path: parts.slice(4).map(safeDecode).join('/') }
      if (method === 'GET') return { handler: handlers.preview, params }
      if (method === 'POST') return { handler: handlers.fileCreate, params }
      if (method === 'PUT') return { handler: handlers.fileUpdate, params }
      if (method === 'DELETE') return { handler: handlers.fileRemove, params }
      if (method === 'PATCH') return { handler: handlers.fileMove, params }
      return null
    }

    // /api/workspaces/:id/dirs/<剩余全部段为目录相对路径>
    if (parts.length >= 5 && parts[0] === 'api' && parts[1] === 'workspaces' && parts[3] === 'dirs') {
      if (method !== 'POST') return null
      const params = { id: safeDecode(parts[2]), path: parts.slice(4).map(safeDecode).join('/') }
      return { handler: handlers.dirCreate, params }
    }

    return null
  }

  function safeDecode(segment) {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment // 非法百分号编码原样传入，下游校验自然失败
    }
  }

  return {
    match,
    isWorkspaceRoute(url) {
      const pathname = url.split('?')[0]
      return pathname === '/api/workspaces' || pathname.startsWith('/api/workspaces/')
    },
  }
}
