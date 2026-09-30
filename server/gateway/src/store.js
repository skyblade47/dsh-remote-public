// 存储层：users.json / tokens.json 的原子读写。
// 设计要点：
// 1) 数据目录由 DSH_GATEWAY_DATA_DIR 指定，默认 $DSH_HOME/users
// 2) 原子写：临时文件 + rename，避免半写状态
// 3) 启动时若文件不存在则初始化空结构
import fs from 'node:fs'
import path from 'node:path'

export function resolveDataDir(env = process.env) {
  const base = env.DSH_GATEWAY_DATA_DIR || env.DSH_HOME || './dsh-data'
  return path.join(base, 'users')
}

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

export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })

  const usersFile = path.join(dataDir, 'users.json')
  const tokensFile = path.join(dataDir, 'tokens.json')

  let users = readJson(usersFile, { version: 1, users: [] })
  let tokens = readJson(tokensFile, { version: 1, tokens: [] })

  // 启动时回写一次，确保文件存在且格式正确
  if (!fs.existsSync(usersFile)) atomicWrite(usersFile, users)
  if (!fs.existsSync(tokensFile)) atomicWrite(tokensFile, tokens)

  return {
    // 用户
    listUsers() {
      return users.users
    },
    findUserByName(name) {
      return users.users.find((u) => u.name === name)
    },
    findUserById(id) {
      return users.users.find((u) => u.id === id)
    },
    saveUser(user) {
      const idx = users.users.findIndex((u) => u.id === user.id)
      if (idx >= 0) users.users[idx] = user
      else users.users.push(user)
      atomicWrite(usersFile, users)
    },
    // Token
    listTokens() {
      return tokens.tokens
    },
    findTokenByHash(tokenHash) {
      return tokens.tokens.find((t) => t.tokenHash === tokenHash && !t.revokedAt)
    },
    findTokenById(id) {
      return tokens.tokens.find((t) => t.id === id)
    },
    saveToken(token) {
      const idx = tokens.tokens.findIndex((t) => t.id === token.id)
      if (idx >= 0) tokens.tokens[idx] = token
      else tokens.tokens.push(token)
      atomicWrite(tokensFile, tokens)
    },
  }
}
