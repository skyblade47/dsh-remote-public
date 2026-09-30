// 存储层：session-owners.json 的原子读写（会话 -> 属主用户）。
// 设计要点：
// 1) dataDir 即 users 目录（与 users.json 同目录）
// 2) 原子写：临时文件 + rename，避免半写状态
// 3) 读文件失败（不存在/损坏）回退到空结构，不致命
import fs from 'node:fs'
import path from 'node:path'

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function scanSessionIds(sessionsRoot) {
  const ids = new Set()
  let buckets
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketPath = path.join(sessionsRoot, bucket.name)
    let sessionDirs
    try {
      sessionDirs = fs.readdirSync(bucketPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of sessionDirs) {
      if (!entry.isDirectory() || !isNonEmptyString(entry.name)) continue
      const marker = path.join(bucketPath, entry.name, 'session.jsonl.zstd')
      if (fs.existsSync(marker)) ids.add(entry.name)
    }
  }
  return [...ids].sort()
}

export function createSessionOwnerStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })

  const file = path.join(dataDir, 'session-owners.json')

  let data = readJson(file, { version: 1, owners: {} })
  if (!data || typeof data !== 'object' || !data.owners || typeof data.owners !== 'object') {
    data = { version: 1, owners: {} }
  }
  const owners = data.owners

  // 启动时回写一次，确保文件存在且格式正确
  if (!fs.existsSync(file)) atomicWrite(file, { version: 1, owners })

  return {
    getOwner(sessionId) {
      return Object.prototype.hasOwnProperty.call(owners, sessionId) ? owners[sessionId] : null
    },
    setOwner(sessionId, userId) {
      if (!isNonEmptyString(sessionId)) throw new TypeError('sessionId 必须是非空字符串')
      if (!isNonEmptyString(userId)) throw new TypeError('userId 必须是非空字符串')
      owners[sessionId] = userId
      atomicWrite(file, { version: 1, owners })
      return { sessionId, userId }
    },
    listByOwner(userId) {
      const result = []
      for (const sessionId of Object.keys(owners)) {
        if (owners[sessionId] === userId) result.push(sessionId)
      }
      return result
    },
    getAll() {
      return { ...owners }
    },
    migrateLegacy(adminId, allSessionIds) {
      const migrated = []
      let skipped = 0
      for (const sessionId of allSessionIds) {
        if (Object.prototype.hasOwnProperty.call(owners, sessionId)) {
          skipped += 1
        } else {
          owners[sessionId] = adminId
          migrated.push(sessionId)
        }
      }
      if (migrated.length > 0) atomicWrite(file, { version: 1, owners })
      return { migrated, skipped }
    },
  }
}
