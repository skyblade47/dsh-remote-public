// 认证服务：用户管理 + Token 管理。
// 整合 store、crypto、audit。
import { hashPassword, verifyPassword, generateToken, hashToken, generateId } from './crypto.js'

// 设备 Token 的有效期。
// 登录 Cookie 的 Max-Age 从这里取（auth-routes.js），**不要各写一份** ——
// 两边漂移会造出"Cookie 还在、Token 已过期"的既带 cookie 又 401 的状态，
// 那正是本项目在 authority 绑定上花过一整轮才排掉的那类困惑。
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天

export function createAuthService({ store, audit }) {
  // ---- 用户管理 ----

  // 对外可见的 user 字段**允许列表**。
  // ⚠️ 刻意用允许列表，而不是"从完整对象里删掉密码哈希"：
  //    后者是 fail-open —— 将来 user 上新增任何敏感字段（token、恢复码、密钥…）
  //    都默认会外泄，除非有人记得回来改这一行。
  const PUBLIC_USER_FIELDS = [
    'id', 'name', 'displayName', 'role', 'disabled',
    'createdAt', 'approvedAt', 'approvedBy',
  ]

  function toPublicUser(u) {
    const out = {}
    for (const k of PUBLIC_USER_FIELDS) {
      if (u && u[k] !== undefined) out[k] = u[k]
    }
    // github **不能照原样带出**：它里面是**明文** token。
    // 这里复用 toPublicGithub 的脱敏口径（保留 login/name/avatarUrl 等展示字段）。
    // 修复前实测：`GET /api/auth/me` 的 `user.github.token` 就是明文凭据，
    // 而 admin 的 `GET /api/auth/users` 会把每个用户的 token 全列出来。
    if (u && u.github) out.github = toPublicGithub(u.github)
    return out
  }

  function createUser({ name, password, role = 'pending' }) {
    // ⚠️ 这两个检查的**顺序是有意的**：先校验密码长度，再判用户名是否占用。
    // 反过来的话会旁路掉 S2 的"统一响应"：攻击者用**弱密码**去试，
    // 已存在的名字走 USER_EXISTS 分支（被统一成 201），可用的名字走 WEAK_PASSWORD（400）
    // ⇒ 两者可区分，照样能枚举。顺序换过来后，弱密码一律 400，不再泄漏。
    if (password.length < 8) {
      throw Object.assign(new Error('密码至少 8 位'), { code: 'WEAK_PASSWORD' })
    }
    if (store.findUserByName(name)) {
      throw Object.assign(new Error('用户名已存在'), { code: 'USER_EXISTS' })
    }
    const user = {
      id: generateId(),
      name,
      displayName: name,
      passwordHash: hashPassword(password),
      role,
      disabled: false,
      createdAt: Date.now(),
    }
    store.saveUser(user)
    audit.log('user.created', { userId: user.id, name, role })
    return user
  }

  // 首个注册的账号自动成为 admin
  function registerUser({ name, password }) {
    const isFirst = store.listUsers().length === 0
    const user = createUser({ name, password, role: isFirst ? 'admin' : 'pending' })
    if (isFirst) audit.log('user.first-admin', { userId: user.id })
    return user
  }

  function verifyUser(name, password) {
    const user = store.findUserByName(name)
    if (!user) return null
    if (user.disabled) return null
    if (!verifyPassword(password, user.passwordHash)) return null
    return user
  }

  function approveUser(userId, approvedBy) {
    const user = store.findUserById(userId)
    if (!user) throw Object.assign(new Error('用户不存在'), { code: 'NOT_FOUND' })
    if (user.role !== 'pending') {
      throw Object.assign(new Error('仅 pending 账号可审批'), { code: 'INVALID_STATE' })
    }
    user.role = 'user'
    user.approvedAt = Date.now()
    user.approvedBy = approvedBy
    store.saveUser(user)
    audit.log('user.approved', { userId, approvedBy })
    return user
  }

  function updateUser(userId, updates) {
    const user = store.findUserById(userId)
    if (!user) throw Object.assign(new Error('用户不存在'), { code: 'NOT_FOUND' })
    if (updates.displayName !== undefined) user.displayName = updates.displayName
    if (updates.role !== undefined) user.role = updates.role
    if (updates.disabled !== undefined) user.disabled = updates.disabled
    if (updates.password) {
      if (updates.password.length < 8) {
        throw Object.assign(new Error('密码至少 8 位'), { code: 'WEAK_PASSWORD' })
      }
      user.passwordHash = hashPassword(updates.password)
    }
    store.saveUser(user)
    audit.log('user.updated', { userId, fields: Object.keys(updates) })
    return user
  }

  // ---- Token 管理 ----
  function createDeviceToken({ userId, label }) {
    const token = generateToken()
    const now = Date.now()
    const record = {
      id: generateId(),
      userId,
      label: label || '未命名设备',
      tokenHash: hashToken(token),
      createdAt: now,
      // V10 修复：此前**漏写 expiresAt**，而校验端写的是 `if (record.expiresAt && ...)`
      // ⇒ 该分支永不触发 ⇒ 设备 Token 实际上永不过期（丢失的凭据无法自然失效，只能手工删）。
      expiresAt: now + TOKEN_TTL_MS,
    }
    store.saveToken(record)
    audit.log('token.created', { tokenId: record.id, userId, label, expiresAt: record.expiresAt })
    return { id: record.id, token } // 明文仅返回一次
  }

  function authenticateToken(token) {
    const record = store.findTokenByHash(hashToken(token))
    if (!record) return null
    if (record.revokedAt) return null
    if (!record.expiresAt) {
      // 兼容 V10 修复前签发的历史 Token：按「**签发时** + TTL」补写。
      // 不能按「现在 + TTL」补 —— 那等于给旧凭据又续一期，等于没修。
      // 补写后若已过期，本次认证即失效（fail-closed），代价是用户需重新登录一次。
      record.expiresAt = (record.createdAt || Date.now()) + TOKEN_TTL_MS
      store.saveToken(record)
    }
    if (record.expiresAt < Date.now()) return null
    // 更新 lastUsedAt
    record.lastUsedAt = Date.now()
    store.saveToken(record)
    const user = store.findUserById(record.userId)
    if (!user || user.disabled) return null
    return { user, tokenId: record.id }
  }

  function revokeToken(tokenId, userId) {
    const token = store.findTokenById(tokenId)
    if (!token) throw Object.assign(new Error('Token 不存在'), { code: 'NOT_FOUND' })
    if (token.userId !== userId) {
      throw Object.assign(new Error('无权操作此 Token'), { code: 'FORBIDDEN' })
    }
    token.revokedAt = Date.now()
    store.saveToken(token)
    audit.log('token.revoked', { tokenId, userId })
  }

  function listUserTokens(userId) {
    return store
      .listTokens()
      .filter((t) => t.userId === userId)
      .map(({ tokenHash, ...rest }) => rest) // 不返回 hash
  }

  // ---- GitHub 绑定 ----
  // user.github = { token, login, name, avatarUrl, boundAt }
  // token 明文存储，因为发布时需要调用 GitHub API 与 git push
  function saveGithubBinding(userId, { token, githubUser }) {
    const u = store.findUserById(userId)
    if (!u) throw Object.assign(new Error('用户不存在'), { code: 'NOT_FOUND' })
    u.github = {
      token,
      login: githubUser.login,
      name: githubUser.name || githubUser.login,
      avatarUrl: githubUser.avatarUrl,
      htmlUrl: githubUser.htmlUrl,
      boundAt: Date.now(),
    }
    store.saveUser(u)
    audit.log('github.bound', { userId, login: githubUser.login })
    return u
  }

  function getGithubBinding(userId) {
    // 服务内部使用，返回包含 token 的完整绑定
    const u = store.findUserById(userId)
    return u && u.github ? u.github : null
  }

  function toPublicGithub(binding) {
    // 路由层对外返回，去除 token 明文
    if (!binding) return null
    const { token, ...rest } = binding
    return rest
  }

  function clearGithubBinding(userId) {
    const u = store.findUserById(userId)
    if (!u) return false
    if (!u.github) return false
    delete u.github
    store.saveUser(u)
    audit.log('github.unbound', { userId })
    return true
  }

  return {
    store,
    toPublicUser,
    listUsers: () => store.listUsers(),
    createUser,
    registerUser,
    verifyUser,
    approveUser,
    updateUser,
    createDeviceToken,
    authenticateToken,
    revokeToken,
    listUserTokens,
    saveGithubBinding,
    getGithubBinding,
    toPublicGithub,
    clearGithubBinding,
  }
}
