// 用 dsh-auth 签名 cookie 探测网关鉴权。
// 环境变量：
//   DSH_CREDENTIALS_FILE  凭证文件路径（默认 $DSH_HOME/.credentials.yaml）
//   DSH_GATEWAY_UPSTREAM  上游内核地址（默认 http://127.0.0.1:3080）
//   DSH_GATEWAY_PORT      网关端口（默认 8080）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const credentialsFile = process.env.DSH_CREDENTIALS_FILE
  || path.join(process.env.DSH_HOME || './dsh-data', '.credentials.yaml')
const yaml = fs.readFileSync(credentialsFile, 'utf8')
const secretMatch = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
function dec(s){const p='='.repeat((4-s.length%4)%4);return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/')+p,'base64')}
function enc(b){return Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
const secret=dec(secretMatch[1])
const upstream = new URL(process.env.DSH_GATEWAY_UPSTREAM || 'http://127.0.0.1:3080')
const auth=`${upstream.hostname}:${upstream.port}`
const cn='dsh-auth-'+enc(crypto.createHash('sha256').update(auth).digest())
const ia=Date.now()
const ea=ia+30*86400000
const pl={version:1,authority:auth,issuedAt:ia,expiresAt:ea}
const bd=enc(Buffer.from(JSON.stringify(pl),'utf8'))
const sg=crypto.createHmac('sha256',secret).update(bd).digest()
const cv='v1.'+bd+'.'+enc(sg)
const COOKIE=cn+'='+cv
console.log('Cookie:', COOKIE.slice(0,80)+'...')

// 测试认证
const gateway = process.env.DSH_GATEWAY_URL
  || `http://127.0.0.1:${process.env.DSH_GATEWAY_PORT || 8080}`
const r = await fetch(`${gateway}/api/session/create`, {
  method:'POST',
  headers:{Cookie:COOKIE,'Content-Type':'application/json'},
  body:'{}'
})
console.log('status:', r.status)
const text = await r.text()
console.log('body:', text.slice(0,500))

if (r.status === 200) {
  const d = JSON.parse(text)
  console.log('result:', JSON.stringify(d.result || d, null, 2).slice(0,500))
}
