// 工作区元信息存储层。
// 设计要点：
// 1) 工作区根目录：$DSH_HOME/workspaces/<userId>/<workspaceId>/
// 2) 每个工作区一个 .dsh-workspace.json 元信息文件（原子写）
// 3) 工作区 ID 用 ws_ 前缀 + 8 hex，便于识别且全局几乎不碰撞
// 4) 路径里就含 userId，A 用户无法构造路径访问 B 用户的工作区
//    （owner 校验天然成立，不需要全局索引）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function resolveWorkspacesRoot(env = process.env) {
  const base = env.DSH_GATEWAY_DATA_DIR || env.DSH_HOME || './dsh-data'
  return path.join(base, 'workspaces')
}

// 工作区 ID 白名单：ws_ 前缀 + 字母数字。路由层传入的 id 必须先过此校验，
// 防止通过 ../ 等路径分隔符注入逃出 <userId>/ 分桶。
const WORKSPACE_ID_RE = /^ws_[a-z0-9]+$/i

export function isValidWorkspaceId(workspaceId) {
  return typeof workspaceId === 'string' && WORKSPACE_ID_RE.test(workspaceId)
}

function generateWorkspaceId() {
  return 'ws_' + crypto.randomBytes(4).toString('hex')
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

// 单用户工作区数上限（设计文档 §4.3）
const MAX_WORKSPACES_PER_USER = 50

export function createWorkspaceStore(workspacesRoot) {
  fs.mkdirSync(workspacesRoot, { recursive: true })

  function userRoot(userId) {
    return path.join(workspacesRoot, userId)
  }

  function workspaceDir(userId, workspaceId) {
    return path.join(userRoot(userId), workspaceId)
  }

  function metaPath(userId, workspaceId) {
    return path.join(workspaceDir(userId, workspaceId), '.dsh-workspace.json')
  }

  function createWorkspace({ userId, name }) {
    const uRoot = userRoot(userId)
    fs.mkdirSync(uRoot, { recursive: true })

    // 容量校验
    const existing = fs.readdirSync(uRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory()).length
    if (existing >= MAX_WORKSPACES_PER_USER) {
      throw Object.assign(
        new Error(`工作区数量已达上限 ${MAX_WORKSPACES_PER_USER}`),
        { code: 'WORKSPACE_LIMIT_REACHED' }
      )
    }

    // 生成 ID，最多重试 3 次以避免极小概率碰撞
    let id = null
    let dir = null
    for (let i = 0; i < 3; i++) {
      const candidate = generateWorkspaceId()
      const candidateDir = workspaceDir(userId, candidate)
      if (!fs.existsSync(candidateDir)) {
        id = candidate
        dir = candidateDir
        break
      }
    }
    if (!id) {
      throw Object.assign(new Error('工作区 ID 碰撞，请重试'), { code: 'ID_COLLISION' })
    }

    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const meta = {
      version: 1,
      id,
      ownerId: userId,
      name: name && String(name).slice(0, 128) || 'untitled',
      createdAt: now,
      createdAtIso: new Date(now).toISOString(),
      cwd: '/',
      tags: [],
    }
    atomicWrite(metaPath(userId, id), meta)
    return meta
  }

  function getWorkspaceMeta(userId, workspaceId) {
    const p = metaPath(userId, workspaceId)
    if (!fs.existsSync(p)) return null
    return readJson(p, null)
  }

  function listWorkspaces(userId) {
    const uRoot = userRoot(userId)
    if (!fs.existsSync(uRoot)) return []
    const entries = fs.readdirSync(uRoot, { withFileTypes: true })
    const result = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.endsWith('.tmp') || e.name.startsWith('.')) continue
      const meta = readJson(path.join(uRoot, e.name, '.dsh-workspace.json'), null)
      if (meta) result.push(meta)
    }
    // 按创建时间倒序（新创建的在前）。
    // 🔴 并列时**再按 id 倒序** —— `createdAt` 是 ms 级 `Date.now()`，**同一毫秒内创建的两个
    //    工作区会平局**，而 `Array.prototype.sort` 对相等元素**不保证稳定顺序** ⇒ 同一份数据
    //    两次调用可能给出不同顺序（§8 U-35）。加了次级键后顺序**恒定**。
    //    ⚠️ 次级键用**纯码点比较**（不用 `localeCompare`）—— 后者的结果依赖 locale/ICU，
    //    会让"顺序恒定"变成"在同一个环境里恒定"，与本节要解决的问题同源。
    result.sort((a, b) => {
      const byTime = (b.createdAt || 0) - (a.createdAt || 0)
      if (byTime !== 0) return byTime
      const bi = String(b.id || '')
      const ai = String(a.id || '')
      return bi > ai ? 1 : bi < ai ? -1 : 0
    })
    return result
  }

  function deleteWorkspace(userId, workspaceId) {
    if (!isValidWorkspaceId(workspaceId)) {
      throw Object.assign(new Error('非法工作区 ID'), { code: 'INVALID_WORKSPACE_ID' })
    }
    const dir = workspaceDir(userId, workspaceId)
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  }

  // 仅凭 workspaceId 全局定位 owner（设计文档 §4.2 越权判定）。
  // 路由层据此区分 404（任何用户名下都不存在）与 403（属于别的用户）。
  // 返回 { userId, meta } 或 null。
  function findWorkspaceOwner(workspaceId) {
    if (!isValidWorkspaceId(workspaceId) || !fs.existsSync(workspacesRoot)) return null
    let userDirs = []
    try {
      userDirs = fs.readdirSync(workspacesRoot, { withFileTypes: true })
    } catch {
      return null
    }
    for (const u of userDirs) {
      if (!u.isDirectory() || u.name.startsWith('.')) continue
      const meta = readJson(
        path.join(workspacesRoot, u.name, workspaceId, '.dsh-workspace.json'),
        null
      )
      if (meta) return { userId: u.name, meta }
    }
    return null
  }

  function updateMeta(userId, workspaceId, updates) {
    const meta = getWorkspaceMeta(userId, workspaceId)
    if (!meta) return null
    if (updates.name !== undefined) {
      meta.name = String(updates.name).slice(0, 128)
    }
    if (updates.tags !== undefined) {
      meta.tags = Array.isArray(updates.tags) ? updates.tags.slice(0, 16) : meta.tags
    }
    atomicWrite(metaPath(userId, workspaceId), meta)
    return meta
  }

  return {
    createWorkspace,
    getWorkspaceMeta,
    listWorkspaces,
    deleteWorkspace,
    updateMeta,
    findWorkspaceOwner,
    workspaceDir: workspaceDir, // 暴露给 fs 模块使用（路由层编排）
    userRoot,
    MAX_WORKSPACES_PER_USER,
  }
}
