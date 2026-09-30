// 生成 dsh-auth 签名 cookie。
// 环境变量：
//   DSH_CREDENTIALS_FILE  凭证文件路径（默认 $DSH_HOME/.credentials.yaml）
//   DSH_GATEWAY_UPSTREAM  上游内核地址（默认 http://127.0.0.1:3080）
//   DSH_GATEWAY_PORT      网关端口（默认 8080）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const credentialsFile = process.env.DSH_CREDENTIALS_FILE
  || path.join(process.env.DSH_HOME || './dsh-data', '.credentials.yaml')
const yaml = fs.readFileSync(credentialsFile, 'utf8')
const secretMatch = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
function dec(s){const p='='.repeat((4-s.length%4)%4);return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/')+p,'base64')}
function enc(b){return Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
const secret=dec(secretMatch[1])
const upstream = new URL(process.env.DSH_GATEWAY_UPSTREAM || 'http://127.0.0.1:3080')
const authority=`${upstream.hostname}:${upstream.port}`
const cookieName='dsh-auth-'+enc(crypto.createHash('sha256').update(authority).digest())
const issuedAt=Date.now()
const expiresAt=issuedAt+30*86400000
const payload={version:1,authority,issuedAt,expiresAt}
const body=enc(Buffer.from(JSON.stringify(payload),'utf8'))
const sig=crypto.createHmac('sha256',secret).update(body).digest()
const cookieValue='v1.'+body+'.'+enc(sig)
const COOKIE=`${cookieName}=${cookieValue}`

// 保存 cookie 供 curl 使用（写到脚本所在目录，已在 .gitignore）
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '_cookie.txt')
fs.writeFileSync(outFile, COOKIE)

console.log('Cookie saved:', outFile, 'length:', COOKIE.length)

// 用 fetch 测试认证
const gateway = process.env.DSH_GATEWAY_URL
  || `http://127.0.0.1:${process.env.DSH_GATEWAY_PORT || 8080}`
const r = await fetch(`${gateway}/`, { headers: { Cookie: COOKIE } })
console.log('GET / via gateway:', r.status)

const r2 = await fetch(`${gateway}/api`, {
  method: 'POST',
  headers: { Cookie: COOKIE, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type:'client-request', rpcId:'probe-1', method:'session.list', payload:{} })
})
console.log('POST /api session.list:', r2.status)
const t2 = await r2.text()
console.log('body:', t2.slice(0, 300))
