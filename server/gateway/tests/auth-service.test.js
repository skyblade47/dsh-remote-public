import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../src/store.js'
import { createAuthService } from '../src/auth-service.js'

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-test-'))
  const store = createStore(dir)
  const audit = { log() {}, file: path.join(dir, 'audit.jsonl') }
  const auth = createAuthService({ store, audit })
  return { dir, store, auth }
}

test('首个注册用户自动成为 admin', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  assert.equal(u.role, 'admin')
})

test('后续注册用户为 pending', () => {
  const { auth } = makeCtx()
  auth.registerUser({ name: 'admin', password: 'password123' })
  const u = auth.registerUser({ name: 'user1', password: 'password123' })
  assert.equal(u.role, 'pending')
})

test('密码不足 8 位抛错', () => {
  const { auth } = makeCtx()
  assert.throws(() => auth.registerUser({ name: 'x', password: '123' }), /至少 8 位/)
})

test('用户名重复抛错', () => {
  const { auth } = makeCtx()
  auth.registerUser({ name: 'dup', password: 'password123' })
  assert.throws(() => auth.registerUser({ name: 'dup', password: 'password123' }), /已存在/)
})

test('登录验证：正确凭证', () => {
  const { auth } = makeCtx()
  auth.registerUser({ name: 'alice', password: 'password123' })
  const u = auth.verifyUser('alice', 'password123')
  assert.ok(u)
  assert.equal(u.name, 'alice')
})

test('登录验证：错误密码返回 null', () => {
  const { auth } = makeCtx()
  auth.registerUser({ name: 'alice', password: 'password123' })
  assert.equal(auth.verifyUser('alice', 'wrong'), null)
})

test('登录验证：不存在的用户返回 null', () => {
  const { auth } = makeCtx()
  assert.equal(auth.verifyUser('nobody', 'password123'), null)
})

test('禁用用户无法登录', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'bob', password: 'password123' })
  auth.updateUser(u.id, { disabled: true })
  assert.equal(auth.verifyUser('bob', 'password123'), null)
})

test('审批 pending 用户', () => {
  const { auth } = makeCtx()
  auth.registerUser({ name: 'admin', password: 'password123' })
  const pending = auth.registerUser({ name: 'new', password: 'password123' })
  assert.equal(pending.role, 'pending')
  const approved = auth.approveUser(pending.id, 'admin-id')
  assert.equal(approved.role, 'user')
  assert.ok(approved.approvedAt)
})

test('设备 Token：创建与验证', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const { id, token } = auth.createDeviceToken({ userId: u.id, label: 'test' })
  assert.ok(token)
  assert.equal(id.length > 0, true)
  const result = auth.authenticateToken(token)
  assert.ok(result)
  assert.equal(result.user.id, u.id)
})

test('设备 Token：吊销后无效', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const { id, token } = auth.createDeviceToken({ userId: u.id, label: 'test' })
  auth.revokeToken(id, u.id)
  assert.equal(auth.authenticateToken(token), null)
})

test('设备 Token：无效 token 返回 null', () => {
  const { auth } = makeCtx()
  assert.equal(auth.authenticateToken('invalid-token'), null)
})

// ---- V10：设备 Token 到期（此前签发时漏写 expiresAt ⇒ 永不过期）----

const DAY = 24 * 60 * 60 * 1000

test('V10 设备 Token：签发时即写入 30 天有效期', () => {
  const { auth, store } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const before = Date.now()
  const { id } = auth.createDeviceToken({ userId: u.id, label: 'test' })
  const rec = store.findTokenById(id)
  assert.ok(rec.expiresAt, '签发时必须写 expiresAt —— 漏写会让校验端的分支永不触发')
  assert.ok(rec.expiresAt >= before + 30 * DAY, `expiresAt 应 ≈ 签发时间 + 30 天，实际 ${rec.expiresAt}`)
  assert.ok(rec.expiresAt <= Date.now() + 30 * DAY)
})

test('V10 设备 Token：过期后认证返回 null', () => {
  const { auth, store } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const { id, token } = auth.createDeviceToken({ userId: u.id, label: 'test' })
  assert.ok(auth.authenticateToken(token), '未过期时应可用')

  const rec = store.findTokenById(id)
  rec.expiresAt = Date.now() - 1000
  store.saveToken(rec)
  assert.equal(auth.authenticateToken(token), null, '过期后必须失效')
})

test('V10 历史 Token（无 expiresAt）：按签发时间补写，不续期', () => {
  const { auth, store } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const { id, token } = auth.createDeviceToken({ userId: u.id, label: 'legacy' })

  // 模拟 V10 修复前签发的记录：没有 expiresAt，且是 31 天前签的
  const rec = store.findTokenById(id)
  delete rec.expiresAt
  rec.createdAt = Date.now() - 31 * DAY
  store.saveToken(rec)

  assert.equal(
    auth.authenticateToken(token),
    null,
    '31 天前签发、有效期 30 天的旧凭据必须失效（若按「现在 + TTL」补写就等于没修）',
  )
  const after = store.findTokenById(id)
  assert.ok(after.expiresAt, '补写后应留下 expiresAt，避免每次认证重复补')
  assert.equal(after.expiresAt, rec.createdAt + 30 * DAY, '补写值必须是「签发时间 + TTL」')
})

test('V10 历史 Token（无 expiresAt）：仍在有效期内时补写后可继续用', () => {
  const { auth, store } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const { id, token } = auth.createDeviceToken({ userId: u.id, label: 'legacy2' })

  const rec = store.findTokenById(id)
  delete rec.expiresAt
  rec.createdAt = Date.now() - 1 * DAY // 1 天前签发，未超 30 天
  store.saveToken(rec)

  const out = auth.authenticateToken(token)
  assert.ok(out, '1 天前签发的旧凭据应仍可用，不该把所有人一刀切踢下线')
  assert.equal(out.user.id, u.id)
  assert.ok(store.findTokenById(id).expiresAt)
})

test('listUserTokens 不返回 hash', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.createDeviceToken({ userId: u.id, label: 't1' })
  const tokens = auth.listUserTokens(u.id)
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].tokenHash, undefined)
  assert.equal(tokens[0].label, 't1')
})

test('toPublicUser 不含 passwordHash', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  const pub = auth.toPublicUser(u)
  assert.equal(pub.passwordHash, undefined)
  assert.equal(pub.name, 'admin')
})

// ---- S3：GitHub Token 不能从任何"公开用户对象"里漏出去 ----
//
// toPublicUser 是 `GET /api/auth/me`、`GET /api/auth/users` 等接口共用的出口，
// 而 user.github 里存着**明文** token。只要它没被剥掉，任何用了 toPublicUser 的接口
// 都会把 token 一并返回 —— 这比"磁盘上明文"更直接。
test('S3：toPublicUser 不得带出 GitHub 明文 token', () => {
  const { auth, store } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.saveGithubBinding(u.id, { token: 'ghp_secret_value', githubUser: { login: 'octocat' } })

  const pub = auth.toPublicUser(store.findUserById(u.id))
  assert.equal(pub.passwordHash, undefined, '密码哈希本来就不该出现')
  const leaked = pub.github && pub.github.token
  assert.equal(leaked, undefined,
    `toPublicUser 带出了明文 GitHub token（实际 ${JSON.stringify(pub.github)}）—— `
    + '所有用它的接口都会泄漏凭据')
})

test('S3：getGithubBinding 仍能拿到明文 token（服务端内部要用它调 GitHub / git push）', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.saveGithubBinding(u.id, { token: 'ghp_secret_value', githubUser: { login: 'octocat' } })
  assert.equal(auth.getGithubBinding(u.id).token, 'ghp_secret_value',
    '剥的是"对外"，不是"对内" —— 否则发布功能会坏')
})

// ---- GitHub 绑定 ----

test('GitHub 绑定：保存后能取回，含 token', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.saveGithubBinding(u.id, {
    token: 'ghp_testtoken',
    githubUser: { login: 'octocat', name: 'Octo Cat', avatarUrl: 'https://x', htmlUrl: 'https://github.com/octocat' },
  })
  const binding = auth.getGithubBinding(u.id)
  assert.equal(binding.login, 'octocat')
  assert.equal(binding.token, 'ghp_testtoken')
  assert.equal(binding.name, 'Octo Cat')
  assert.ok(binding.boundAt)
})

test('GitHub 绑定：toPublicGithub 去除 token', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.saveGithubBinding(u.id, {
    token: 'ghp_secret',
    githubUser: { login: 'octocat' },
  })
  const pub = auth.toPublicGithub(auth.getGithubBinding(u.id))
  assert.equal(pub.token, undefined)
  assert.equal(pub.login, 'octocat')
})

test('GitHub 绑定：未绑定时返回 null', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  assert.equal(auth.getGithubBinding(u.id), null)
  assert.equal(auth.toPublicGithub(null), null)
})

test('GitHub 绑定：clearGithubBinding 解绑', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.saveGithubBinding(u.id, { token: 'ghp_x', githubUser: { login: 'octocat' } })
  assert.equal(auth.clearGithubBinding(u.id), true)
  assert.equal(auth.getGithubBinding(u.id), null)
})

test('GitHub 绑定：未绑定时 clear 返回 false', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  assert.equal(auth.clearGithubBinding(u.id), false)
})

test('GitHub 绑定：覆盖更新（再次保存）', () => {
  const { auth } = makeCtx()
  const u = auth.registerUser({ name: 'admin', password: 'password123' })
  auth.saveGithubBinding(u.id, { token: 'token1', githubUser: { login: 'user1' } })
  auth.saveGithubBinding(u.id, { token: 'token2', githubUser: { login: 'user2' } })
  const binding = auth.getGithubBinding(u.id)
  assert.equal(binding.login, 'user2')
  assert.equal(binding.token, 'token2')
})
