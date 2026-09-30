// 密码哈希与 Token 生成。
// 选用 Node.js 内置 crypto.scrypt（零依赖），参数对标 bcrypt cost≥12：
//   N=16384 (2^14), r=8, p=1 → 计算量约等于 bcrypt cost 12
// Token 用 crypto.randomBytes(32) 生成，存 sha256。
import crypto from 'node:crypto'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  // 格式：scrypt$N$r$p$saltHex$hashHex
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPassword(password, stored) {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltHex, hashHex] = parts
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const derived = crypto.scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return crypto.timingSafeEqual(derived, expected)
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function generateId() {
  return crypto.randomUUID()
}
