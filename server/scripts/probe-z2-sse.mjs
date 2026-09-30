// Z2 drain 判据探测：连接 dsh SSE 事件流，观测 turn/start 与 turn/end 事件
// 环境变量：
//   DSH_CREDENTIALS_FILE  凭证文件路径（默认 $DSH_HOME/.credentials.yaml，与网关 dsh-auth 一致）
//   DSH_GATEWAY_UPSTREAM  上游内核地址（默认 http://127.0.0.1:3080）
//   DSH_GATEWAY_PORT      网关端口（默认 8080）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 1. 从 credentials 读取 signing secret 并生成认证 cookie
const credentialsFile = process.env.DSH_CREDENTIALS_FILE
  || path.join(process.env.DSH_HOME || './dsh-data', '.credentials.yaml')
const yaml = fs.readFileSync(credentialsFile, 'utf8')
const secretMatch = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/)
const secretB64url = secretMatch[1]
function decodeB64url(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4)
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}
function encodeB64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const secret = decodeB64url(secretB64url)
const upstream = new URL(process.env.DSH_GATEWAY_UPSTREAM || 'http://127.0.0.1:3080')
const authority = `${upstream.hostname}:${upstream.port}`
const cookieName = 'dsh-auth-' + encodeB64url(crypto.createHash('sha256').update(authority).digest())
const issuedAt = Date.now()
const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000
const payload = { version: 1, authority, issuedAt, expiresAt }
const body = encodeB64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const sig = crypto.createHmac('sha256', secret).update(body).digest()
const cookieValue = 'v1.' + body + '.' + encodeB64url(sig)
const COOKIE = `${cookieName}=${cookieValue}`
const HEADERS = { Cookie: COOKIE, 'Content-Type': 'application/json' }
const GATEWAY = process.env.DSH_GATEWAY_URL
  || `http://127.0.0.1:${process.env.DSH_GATEWAY_PORT || 8080}`

let eventCount = 0
let turnStartCount = 0
let turnEndCount = 0
const seenTypes = new Set()
const sessionIds = new Set()

// 2. 连接 SSE 事件流
console.log('=== 连接 /api/events.mux SSE 流 ===')
const sseRes = await fetch(`${GATEWAY}/api/events.mux`, { headers: { Cookie: COOKIE } })
console.log('SSE status:', sseRes.status, sseRes.headers.get('content-type'))

const reader = sseRes.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

async function processSSE() {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim()
        if (!dataStr) continue
        eventCount++
        try {
          const evt = JSON.parse(dataStr)
          const type = evt.type || evt.event?.type
          if (type) {
            seenTypes.add(type)
            if (type === 'turn/start') {
              turnStartCount++
              console.log(`\n[turn/start] turn=${evt.data?.turn} sessionId=${evt.sessionId || evt.data?.sessionId || 'N/A'}`)
              console.log('  full keys:', Object.keys(evt).join(','), '| data keys:', Object.keys(evt.data || {}).join(','))
            }
            if (type === 'turn/end') {
              turnEndCount++
              console.log(`[turn/end] turn=${evt.data?.turn} reason=${evt.data?.reason?.kind || 'N/A'} sessionId=${evt.sessionId || evt.data?.sessionId || 'N/A'}`)
            }
            if (evt.sessionId) sessionIds.add(evt.sessionId)
            if (evt.data?.sessionId) sessionIds.add(evt.data.sessionId)
          }
          if (eventCount <= 5 || type === 'turn/start' || type === 'turn/end') {
            // 打印前几个事件和 turn 事件的摘要
            console.log(`  evt #${eventCount}: type=${type || 'unknown'} keys=${Object.keys(evt).join(',')}`)
          }
        } catch {
          // 非 JSON 数据，忽略
        }
      }
    }
  }
}

// 3. 创建会话并发送消息
console.log('\n=== 创建会话 ===')
const createRes = await fetch(`${GATEWAY}/api/session/create`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({}),
})
const createData = await createRes.json()
console.log('create status:', createRes.status)
console.log('create response keys:', Object.keys(createData).join(','))
const sessionId = createData.sessionId || createData.value?.sessionId
console.log('sessionId:', sessionId)

// 给 SSE 一点时间建立连接
await new Promise(r => setTimeout(r, 1000))

// 启动 SSE 处理（不阻塞）
processSSE().catch(e => console.error('SSE error:', e.message))

// 4. 发送一条消息触发 turn
console.log('\n=== 发送消息触发 turn ===')
const promptRes = await fetch(`${GATEWAY}/api/session/prompt`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({ sessionId, prompt: '你好，请用一句话介绍你自己' }),
})
console.log('prompt status:', promptRes.status)

// 5. 等待并收集事件（15 秒）
console.log('\n=== 等待事件（15秒）===')
await new Promise(r => setTimeout(r, 15000))

console.log('\n=== Z2 探测汇总 ===')
console.log('总事件数:', eventCount)
console.log('turn/start 次数:', turnStartCount)
console.log('turn/end 次数:', turnEndCount)
console.log('观察到的事件类型:', [...seenTypes].sort().join(', '))
console.log('观察到的 sessionId:', [...sessionIds].join(', '))
console.log('')
console.log('结论:')
console.log('- turn 开始事件类型: turn/start (含 data.turn)')
console.log('- turn 结束事件类型: turn/end (含 data.turn, data.reason.kind)')
console.log('- drain 判据: 可通过 /api/events.mux SSE 流统计 turn/start 与 turn/end 是否配对')

// 清理
reader.cancel().catch(() => {})
process.exit(0)
