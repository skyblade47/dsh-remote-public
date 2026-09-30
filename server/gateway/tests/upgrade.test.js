import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { createUpgradeHandler } from '../src/upgrade.js'

// 极简 WebSocket 服务端：完成握手后把收到的字节原样回显。
// 注意：不做帧解析，回显的是原始字节（含掩码），因此测试必须按字节比对，
// 不能用 includes('ping') —— 掩码后的载荷里不存在明文。
function startEchoWsServer(seenHosts, liveSockets) {
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    seenHosts.push(req.headers.host)
    if (liveSockets) liveSockets.push(socket)
    const key = req.headers['sec-websocket-key']
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on('data', (buf) => socket.write(buf))
  })
  return server
}

// 构造一个最简单的掩码文本帧
function makeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked])
}

// ⚠️ 超时守卫：本用例末尾要断言「客户端干净断开后，网关把 FIN 转发到了上游」。
//    若断言不成立，**必须"失败"而不是"挂住"** —— 历史上它正是以**进程永不退出**的形态
//    卡死整个 `node --test`（实测 exit=124）。根因与处置见 roadmap §8 **U-32**。
test('升级请求被转发到上游，且 Host 已被改写', { timeout: 10_000 }, async () => {
  const seenHosts = []
  const upstreamSockets = []
  const upstream = startEchoWsServer(seenHosts, upstreamSockets)
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upPort = upstream.address().port

  const gateway = http.createServer()
  gateway.on('upgrade', createUpgradeHandler({ hostname: '127.0.0.1', port: upPort }))
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
  const gwPort = gateway.address().port

  const socket = net.connect(gwPort, '127.0.0.1')
  await new Promise((r) => socket.once('connect', r))

  const key = crypto.randomBytes(16).toString('base64')
  socket.write(
    'GET /api/events.mux HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${gwPort}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  )

  // 读握手响应；把可能同段到达的后续字节保留下来（否则会丢帧）
  const { head, rest } = await new Promise((resolve) => {
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx !== -1) {
        socket.off('data', onData)
        resolve({
          head: buf.subarray(0, idx + 4).toString('latin1'),
          rest: buf.subarray(idx + 4),
        })
      }
    }
    socket.on('data', onData)
  })
  assert.match(head, /HTTP\/1\.1 101/)

  // 回显验证：按字节比对，证明双向管道已打通
  const frame = makeTextFrame('ping')
  socket.write(frame)
  const echoed = await new Promise((resolve) => {
    let acc = rest
    if (acc.length >= frame.length) {
      resolve(acc)
      return
    }
    const onData = (d) => {
      acc = Buffer.concat([acc, d])
      if (acc.length >= frame.length) {
        socket.off('data', onData)
        resolve(acc)
      }
    }
    socket.on('data', onData)
  })
  assert.deepEqual(echoed.subarray(0, frame.length), frame)

  // 关键断言：上游看到的 Host 已被改写为它自己的回环地址
  assert.equal(seenHosts[0], `127.0.0.1:${upPort}`)

  // ---- 收尾 ----
  // ① 先走「干净 FIN」：`socket.end()`。网关侧 `socket.pipe(upstreamSocket)` 会把 FIN **转发**给
  //    上游 —— 下面断言这一条（这是**网关**的行为，不是对端的行为）。
  //    📌 「**突然**断开（destroy / RST）时网关是否拆对端」是**另一条路径**，已由下面的
  //    **U-32(ii)** 两个用例覆盖（该缺口已于 2026-09-27 修复，见 [`2026-09-27-gateway-ws-teardown-plan.md`]）。
  const srvSock = upstreamSockets[0]
  const forwarded = new Promise((resolve) => {
    if (srvSock.readableEnded) resolve()
    else srvSock.once('end', resolve)
  })
  socket.end()
  await Promise.race([
    forwarded,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('网关未在 1500ms 内把 FIN 转发到上游')), 1500),
    ),
  ])
  assert.equal(srvSock.readableEnded, true, '客户端干净断开后，网关必须把 FIN 转发到上游')

  // ② 🔴 兜底收尾（**缺了它整个 `node --test` 都不会退出**）：
  //    · 本用例的"上游"是个极简回显服务，**收到 FIN 不会关自己那一侧**
  //      （实测 `readableEnded=true` 而 `writableEnded=false`、`destroyed=false`）
  //      ⇒ 若不强拆，`upstream.close()` 永不回调 ⇒ 进程留活句柄 ⇒ 套件挂死
  //      （这正是 **U-32** 观察到的 **exit=124**）。
  //    · ⚠️ **`server.closeAllConnections()` 覆盖不到「已升级」的 socket**（upgrade 后该 socket
  //      已从 HTTP server 的连接表里摘出）⇒ **必须显式 destroy 我们自己捕获的那条**。
  //    ⇒ 态度：**测试自己负责把连接清干净**，不依赖被测代码、也不依赖对端。
  socket.destroy()
  for (const s of upstreamSockets) s.destroy()
  gateway.closeAllConnections()
  upstream.closeAllConnections()
  await Promise.all([
    new Promise((r) => gateway.close(r)),
    new Promise((r) => upstream.close(r)),
  ])
})

// ---------------------------------------------------------------------------
// U-32(ii)：**突然**断开（`destroy`，而不是 `end`）时，网关必须把**对端**也拆掉。
//
// 🔴 判据口径（为什么必须这么写）：`pipe()` 的默认 `{ end: true }` **只能传播"干净 end"**，
//    **传播不了 `destroy`**。所以**用 `end()` 触发是测不出这个缺口的** —— 那正是它长期没被测到的原因。
//    本组用例一律用 `destroy` / `resetAndDestroy`（RST，不经 FIN）触发。
//
// 真实触发场景：**只重启网关、不重启内核** —— Node 关闭 HTTP server 时会 **destroy** 客户端侧
//    socket（不是 end）⇒ 若网关不拆对端，每条活跃 WS 都会留一条半开到内核 `:3080` 的连接，
//    直到内核自己超时。
// ---------------------------------------------------------------------------

/** 建一对「客户端 ↔ 网关 ↔ 上游」并完成 WS 握手，返回两端句柄与清理函数。 */
async function setupProxy() {
  const seenHosts = []
  const upstreamSockets = []
  const upstream = startEchoWsServer(seenHosts, upstreamSockets)
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upPort = upstream.address().port

  let gwSock = null
  const handler = createUpgradeHandler({ hostname: '127.0.0.1', port: upPort })
  const gateway = http.createServer()
  gateway.on('upgrade', (req, socket, head) => {
    gwSock = socket // 捕获**网关侧**那条 socket：本组用例要直接 destroy 它
    handler(req, socket, head)
  })
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
  const gwPort = gateway.address().port

  const client = net.connect(gwPort, '127.0.0.1')
  await new Promise((r) => client.once('connect', r))
  const key = crypto.randomBytes(16).toString('base64')
  client.write(
    'GET /api/events.mux HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${gwPort}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  )
  await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      if (buf.indexOf('\r\n\r\n') !== -1) {
        client.off('data', onData)
        resolve()
      }
    }
    client.on('data', onData)
    setTimeout(() => reject(new Error('握手超时')), 5000)
  })

  const cleanup = async () => {
    client.destroy()
    for (const s of upstreamSockets) s.destroy()
    if (gwSock) gwSock.destroy()
    // ⚠️ `closeAllConnections()` 覆盖不到「已升级」的 socket ⇒ 上两行必须显式 destroy。
    //    缺了任何一条，`server.close()` 永不回调 ⇒ 进程留活句柄 ⇒ 套件挂死（U-32 的 exit=124）。
    gateway.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([
      new Promise((r) => gateway.close(r)),
      new Promise((r) => upstream.close(r)),
    ])
  }
  return {
    client,
    gwSock: () => gwSock,
    upstreamSocket: () => upstreamSockets[0],
    seenHosts,
    cleanup,
  }
}

/** 等待 socket 被"拆掉"（已 destroyed 或收到 close），超时即失败 —— 不许挂住。 */
function raceClose(sock, what, ms = 1500) {
  return Promise.race([
    new Promise((r) => (sock.destroyed ? r() : sock.once('close', r))),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what} 未在 ${ms}ms 内被拆除（U-32(ii) 回归）`)), ms),
    ),
  ])
}

/** 等待对端看到"连接结束"（`readableEnded`），超时即失败。 */
function raceEnd(sock, what, ms = 1500) {
  return Promise.race([
    new Promise((r) => (sock.readableEnded ? r() : sock.once('end', r))),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what} 未在 ${ms}ms 内看到对端关闭（U-32(ii) 回归）`)), ms),
    ),
  ])
}

test('U-32(ii)：网关侧 socket 被 destroy（客户端仍在线、无 error）⇒ 必须拆掉上游', { timeout: 10_000 }, async () => {
  const p = await setupProxy()
  try {
    const up = p.upstreamSocket()
    assert.ok(up, '上游 socket 应已建立')
    assert.equal(up.readableEnded, false, '前置：上游此刻还没看到对端关闭')

    // 模拟"网关单方面关掉这条连接"（服务关闭时 Node 就是这么干的：**destroy，不是 end**）
    p.gwSock().destroy()

    await raceEnd(up, '上游侧 socket')
    assert.equal(up.readableEnded, true, '网关侧 destroy 后必须拆掉上游 —— 否则留下半开连接')
  } finally {
    await p.cleanup()
  }
})

// 🔵 反向用例（下面这条）**修复前后都通过** —— 它走的是 `error` 路径（RST ⇒ ECONNRESET），
//    那条路径**本来就**会拆对端。⇒ 它钉的是**既有行为不被弄坏**，**不是**本缺口的判据。
//    本缺口的判据是**上一条**（网关侧 `destroy`，无 `error`）——已实测：**撤掉修复即 `not ok`**。
test('U-32(ii) 反向（🔵 修复前后都过 · 钉既有 error 路径）：上游突然 RST（不经 FIN）⇒ 客户端被拆', { timeout: 10_000 }, async () => {
  const p = await setupProxy()
  try {
    const gw = p.gwSock()
    assert.equal(gw.destroyed, false, '前置：网关侧 socket 还在')

    p.upstreamSocket().resetAndDestroy() // 强制 RST（不走 FIN）⇒ 网关侧拿到 ECONNRESET

    await raceClose(gw, '网关侧 socket')
    assert.equal(gw.destroyed, true, '上游 RST 后必须拆掉客户端连接')
  } finally {
    await p.cleanup()
  }
})
