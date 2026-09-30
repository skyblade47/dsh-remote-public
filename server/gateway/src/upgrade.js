// WebSocket 升级转发：把客户端与上游之间的 TCP 双向打通。
// 必须手工重建请求行与头部（因为要改写 Host、剥离 Origin、注入 dsh-auth），
// 不能用 http.request —— 它不处理 101 切换后的裸字节流。
import net from 'node:net'
import { rewriteHeaders } from './proxy.js'

function injectDshAuth(headers, dshAuthCookie) {
  if (!dshAuthCookie) return headers
  const out = { ...headers }
  const existing = out.cookie ? out.cookie + '; ' : ''
  out.cookie = existing + dshAuthCookie
  return out
}

function serializeRequest(req, upstream, dshAuthCookie) {
  const headers = injectDshAuth(rewriteHeaders(req.headers, upstream), dshAuthCookie)
  const lines = [`${req.method} ${req.url} HTTP/1.1`]
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const one of value) lines.push(`${key}: ${one}`)
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  return lines.join('\r\n') + '\r\n\r\n'
}

// 对端地址（含端口）——**必须**进日志：网关侧此前无法区分"是哪条客户端断了"
// （诊断 2026-09-25 §1.4 的观测盲点）。
function peerOf(socket) {
  if (!socket.remoteAddress) return 'unknown'
  return socket.remotePort ? `${socket.remoteAddress}:${socket.remotePort}` : socket.remoteAddress
}

export function createUpgradeHandler(upstream, log = () => {}, dshAuth = null) {
  return function handle(req, socket, head) {
    const dshAuthCookie = dshAuth ? dshAuth.generate() : null
    // WS 生命周期日志：补上"客户端侧断开"这一**结构性观测盲点** —— 此前只有上游 error
    // 会打印（且不带对端地址），客户端侧 RST / 干净 FIN 在网关侧完全静默（无 access log）。
    // 只记连接级事件（close/error），**不记每帧/每消息**；且**只加日志，不改 destroy() 的时机与语义**。
    const path = req.url
    const clientPeer = peerOf(socket)
    let upstreamPeer = `${upstream.hostname}:${upstream.port}`
    const lifecycle = (direction, event, err) => {
      const peer = direction === 'client' ? clientPeer : upstreamPeer
      const code = err && err.code ? ` code=${err.code}` : ''
      const message = err && err.message ? ` message=${err.message}` : ''
      log(`ws lifecycle: ${direction} ${event} peer=${peer} path=${path}${code}${message}`)
    }

    const upstreamSocket = net.connect(upstream.port, upstream.hostname, () => {
      upstreamPeer = peerOf(upstreamSocket)
      upstreamSocket.write(serializeRequest(req, upstream, dshAuthCookie))
      if (head && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })

    upstreamSocket.on('error', (err) => {
      log(`upgrade upstream error: ${err.message}`)
      lifecycle('upstream', 'error', err)
      socket.destroy()
    })
    socket.on('error', (err) => {
      lifecycle('client', 'error', err)
      upstreamSocket.destroy()
    })

    // 🔴 U-32(ii)：`pipe()` 的默认 `{ end: true }` **只能传播"干净 end"**（一端 `end()` → 另一端 `end()`），
    //    **传播不了 `destroy()`**；而"本地 destroy / 服务端关闭连接"这类路径**只发 `close`、不发 `error`**
    //    ⇒ 只靠上面两个 `error` 回调，对面会被留下来（**半开**）。
    //    WS 是**单条双向流**：一侧没了，对侧即无意义 ⇒ 把 `close` 也接到拆除上。
    //    幂等：`destroyed` 判断 + `destroy()` 本身可重复调用。
    //    ⚠️ 真实触发场景：**只重启网关、不重启内核** —— Node 关闭 HTTP server 时会 destroy 客户端 socket
    //       （不是 end），每条活跃 WS 都会留一条半开到内核的 :3080 连接，直到内核自己超时。
    //    ⚠️ 日志形态刻意不变：`lifecycle(...)` 仍在 `destroy` **之前**调用。
    upstreamSocket.on('close', () => {
      lifecycle('upstream', 'close')
      if (!socket.destroyed) socket.destroy()
    })
    socket.on('close', () => {
      lifecycle('client', 'close')
      if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    })
  }
}
