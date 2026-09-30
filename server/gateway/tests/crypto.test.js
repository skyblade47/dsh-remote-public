import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, generateToken, hashToken } from '../src/crypto.js'

test('密码哈希与验证：正确密码通过', () => {
  const hash = hashPassword('correct-horse-battery')
  assert.equal(verifyPassword('correct-horse-battery', hash), true)
})

test('密码哈希与验证：错误密码拒绝', () => {
  const hash = hashPassword('correct-horse-battery')
  assert.equal(verifyPassword('wrong-password', hash), false)
})

test('哈希不可逆：相同密码产生不同哈希', () => {
  const h1 = hashPassword('same-password')
  const h2 = hashPassword('same-password')
  assert.notEqual(h1, h2) // salt 不同
})

test('Token 生成与哈希：长度和唯一性', () => {
  const t1 = generateToken()
  const t2 = generateToken()
  assert.equal(t1.length, 64) // 32 bytes hex
  assert.notEqual(t1, t2)
  assert.equal(hashToken(t1).length, 64) // sha256 hex
})

test('无效哈希格式返回 false', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false)
  assert.equal(verifyPassword('x', 'bcrypt$xxx'), false)
})
