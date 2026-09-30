// 生成 dsh 内核的认证 cookie（dsh-auth-*）。
// 网关认证通过后，转发请求到上游时需要注入此 cookie，
// 否则内核会因缺少 dsh-auth 而返回 401。
//
// Cookie 格式：
//   name:  dsh-auth-<base64url(sha256(authority))>
//   value: v1.<base64url(payload)>.<base64url(hmac-sha256(secret, payload))>
//   payload: { version:1, authority, issuedAt, expiresAt }
//
// secret 来源：$DSH_HOME/.credentials.yaml 中 client-connection/browser-session 的 secret
import fs from 'node:fs'
import crypto from 'node:crypto'

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4)
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function loadSecret(credentialsPath) {
  const yaml = fs.readFileSync(credentialsPath, 'utf8')
  // 匹配 client-connection/browser-session 下的 secret
  const match = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
  if (!match) throw new Error(`在 ${credentialsPath} 中未找到 client-connection/browser-session secret`)
  return b64urlDecode(match[1])
}

export function createDshAuth({ credentialsPath, authority }) {
  const secret = loadSecret(credentialsPath)
  const cookieName = 'dsh-auth-' + b64urlEncode(crypto.createHash('sha256').update(authority).digest())

  function generate() {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + 30 * 86400_000 // 30 天
    const payload = { version: 1, authority, issuedAt, expiresAt }
    const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
    const sig = crypto.createHmac('sha256', secret).update(body).digest()
    return `${cookieName}=v1.${body}.${b64urlEncode(sig)}`
  }

  return { cookieName, generate }
}
