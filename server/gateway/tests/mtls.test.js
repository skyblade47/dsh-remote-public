import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { attachMtlsEnforcement, buildMtlsTlsOptions, isRequestClientAllowed, issueClientCert, revokeClientCert } from '../src/client-certs.js'
import { loadOrCreateTlsCert } from '../src/tls-cert.js'

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mtls-'))
}

// 起一个与网关同构的 mTLS 服务端（复用生产代码里的 TLS 选项、握手授权与每请求复核）
async function startServer(dataDir) {
  const serverCred = loadOrCreateTlsCert({ dataDir, log: () => {} })
  const tlsOptions = buildMtlsTlsOptions(dataDir, { cert: serverCred.cert, key: serverCred.key })
  const server = https.createServer(tlsOptions, (req, res) => {
    if (!isRequestClientAllowed(dataDir, req)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('denied')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  attachMtlsEnforcement(server, { dataDir, log: () => {}, audit: null })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, ca: serverCred.cert }
}

function request({ port, ca, cert, key, agent }) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: '127.0.0.1', port, path: '/', ca, cert, key, servername: 'localhost', agent },
      (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ ok: true, status: res.statusCode, body }))
      },
    )
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }))
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
  })
}

test('mTLS：白名单内的客户端证书可访问', async () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'laptop' })
  const { server, port, ca } = await startServer(dir)
  try {
    const res = await request({ port, ca, cert: issued.certPem, key: fs.readFileSync(issued.keyFile, 'utf8') })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(res.status, 200)
    assert.equal(res.body, 'ok')
  } finally {
    server.close()
  }
})

test('mTLS：不带客户端证书的连接被握手阶段拒绝', async () => {
  const dir = makeDir()
  issueClientCert({ dataDir: dir, name: 'laptop' })
  const { server, port, ca } = await startServer(dir)
  try {
    const res = await request({ port, ca })
    assert.equal(res.ok, false, '未提供客户端证书不应连通')
  } finally {
    server.close()
  }
})

test('mTLS：已吊销的客户端证书被拒，且复用连接也会被拦下（无需重启）', async () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'lost-phone' })
  const { server, port, ca } = await startServer(dir)
  const agent = new https.Agent({ keepAlive: true })
  const opts = { port, ca, cert: issued.certPem, key: fs.readFileSync(issued.keyFile, 'utf8'), agent }
  try {
    const before = await request(opts)
    assert.equal(before.ok, true, '吊销前应可访问')

    revokeClientCert({ dataDir: dir, name: 'lost-phone' })

    // 复用上一条 keep-alive 连接：握手不再发生，必须靠每请求复核拦住
    const reused = await request(opts)
    assert.equal(reused.ok, true, '连接本身仍存在（keep-alive）')
    assert.equal(reused.status, 403, '复用连接上的请求必须被拒')
  } finally {
    agent.destroy()
    server.close()
  }
})

test('mTLS：其它 CA 签发的客户端证书被拒', async () => {
  const dir = makeDir()
  issueClientCert({ dataDir: dir, name: 'laptop' })
  const otherDir = makeDir()
  const foreign = issueClientCert({ dataDir: otherDir, name: 'intruder' })
  const { server, port, ca } = await startServer(dir)
  try {
    const res = await request({ port, ca, cert: foreign.certPem, key: fs.readFileSync(foreign.keyFile, 'utf8') })
    assert.equal(res.ok, false, '非本 CA 签发的证书不应连通')
  } finally {
    server.close()
  }
})

test('mTLS：缺少客户端 CA 时装配直接报错', () => {
  const dir = makeDir()
  assert.throws(
    () => buildMtlsTlsOptions(dir, {}),
    (e) => e.code === 'CLIENT_CA_MISSING',
  )
})

// 审计必须留痕：被拒的客户端证书是安全事件，漏记会让"谁在拿废证书敲门"无从追查。
//
// 三条拒绝路径都要留痕，本文件覆盖其中两条（新连接的两种失败），第三条（keep-alive 复用连接
// 时的每请求复核，记在 index.js 的 routeRequest 里）靠 server/scripts/p1-verify-v8-v9.mjs
// 端到端覆盖 —— index.js 是带副作用入口，无法直接单测。
//
// ⚠️ 样本要选对，两条路径由**证书状态**决定：
//    · 链合法但不在白名单（已吊销）→ 握手能建立 → secureConnection → phase='handshake'
//    · 链本身校验不过（外部 CA 签发）→ 握手就被 OpenSSL 拒 → tlsClientError → phase='handshake-invalid'
//    · 链合法且在白名单 → 正常放行，不记
// 2026-09-23 之前第二种只写 log 不写审计，是个真缺口（已修）。
test('mTLS：握手阶段发现"链合法但未授权"时写审计，phase=handshake', async () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'revoked-device' })
  revokeClientCert({ dataDir: dir, name: 'revoked-device' }) // 链仍合法，但不在白名单

  const events = []
  const audit = { log: (event, data) => events.push({ event, ...data }) }

  const serverCred = loadOrCreateTlsCert({ dataDir: dir, log: () => {} })
  const tlsOptions = buildMtlsTlsOptions(dir, { cert: serverCred.cert, key: serverCred.key })
  const server = https.createServer(tlsOptions, (req, res) => { res.writeHead(200); res.end('ok') })
  attachMtlsEnforcement(server, { dataDir: dir, log: () => {}, audit })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const res = await request({
      port,
      ca: serverCred.cert,
      cert: issued.certPem,
      key: fs.readFileSync(issued.keyFile, 'utf8'),
    })
    assert.equal(res.ok, false, '已吊销的证书不应连通')

    // 拒绝是在 socket 销毁路径上记的，可能稍晚于客户端看到错误
    for (let i = 0; i < 40 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const hit = events.find((e) => e.event === 'auth.client_cert_denied')
    assert.ok(hit, `应留下 auth.client_cert_denied 审计，实际: ${JSON.stringify(events)}`)
    assert.equal(hit.phase, 'handshake', '链合法但未授权的拒绝必须标 phase=handshake')
  } finally {
    server.close()
  }
})

test('mTLS：握手阶段发现"链不合法"时也写审计，phase=handshake-invalid', async () => {
  const dir = makeDir()
  issueClientCert({ dataDir: dir, name: 'legit' }) // 让本实例有自己的 CA
  const otherDir = makeDir()
  const foreign = issueClientCert({ dataDir: otherDir, name: 'intruder' }) // 别的 CA 签发 ⇒ 链校验不过

  const events = []
  const audit = { log: (event, data) => events.push({ event, ...data }) }

  const serverCred = loadOrCreateTlsCert({ dataDir: dir, log: () => {} })
  const tlsOptions = buildMtlsTlsOptions(dir, { cert: serverCred.cert, key: serverCred.key })
  const server = https.createServer(tlsOptions, (req, res) => { res.writeHead(200); res.end('ok') })
  attachMtlsEnforcement(server, { dataDir: dir, log: () => {}, audit })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    const res = await request({
      port,
      ca: serverCred.cert,
      cert: foreign.certPem,
      key: fs.readFileSync(foreign.keyFile, 'utf8'),
    })
    assert.equal(res.ok, false, '非本 CA 签发的证书不应连通')

    for (let i = 0; i < 40 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const hit = events.find((e) => e.event === 'auth.client_cert_denied')
    assert.ok(hit, `链不合法的拒绝也必须留痕，实际: ${JSON.stringify(events)}`)
    assert.equal(hit.phase, 'handshake-invalid')
    assert.ok(hit.code, '应带上 OpenSSL 的错误码，便于区分原因')
  } finally {
    server.close()
  }
})

// 这条锁住的是上面那个"fail-open"规则的**代价边界**：
// 只排除实测确认与证书无关的两类（ECONNRESET / ERR_SSL_HTTP_REQUEST），
// 否则公网暴露时端口扫描就能把审计刷爆。
// 实测依据见 client-certs.js 里 NON_CERT_HANDSHAKE_ERRORS 上方的那张表。
test('mTLS：扫描/误配类握手失败**不**写审计（防刷爆）', async () => {
  const dir = makeDir()
  issueClientCert({ dataDir: dir, name: 'legit' })
  const events = []
  const audit = { log: (event, data) => events.push({ event, ...data }) }

  const serverCred = loadOrCreateTlsCert({ dataDir: dir, log: () => {} })
  const tlsOptions = buildMtlsTlsOptions(dir, { cert: serverCred.cert, key: serverCred.key })
  const server = https.createServer(tlsOptions, (req, res) => { res.writeHead(200); res.end('ok') })
  attachMtlsEnforcement(server, { dataDir: dir, log: () => {}, audit })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    // 1) 裸 TCP：连上就断（端口探针的典型行为）
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve() })
      s.on('error', () => resolve())
    })
    // 2) 明文 HTTP 打到 TLS 端口（误配/扫描）
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
      })
      s.on('close', resolve)
      s.on('error', resolve)
      setTimeout(() => { s.destroy(); resolve() }, 1000)
    })

    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(events, [], `扫描类握手失败不应写审计，实际: ${JSON.stringify(events)}`)
  } finally {
    server.close()
  }
})

test('mTLS：白名单校验独立于来源地址（换 IP 不影响授权）', async () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'roaming-laptop' })
  const { server, port, ca } = await startServer(dir)
  try {
    // 同一张证书从不同本地地址发起（模拟家庭/出差不同网络）
    for (const localAddress of ['127.0.0.1', '127.0.0.2']) {
      const res = await new Promise((resolve) => {
        const req = https.request(
          {
            host: '127.0.0.1',
            port,
            path: '/',
            ca,
            cert: issued.certPem,
            key: fs.readFileSync(issued.keyFile, 'utf8'),
            servername: 'localhost',
            localAddress,
          },
          (r) => { r.resume(); r.on('end', () => resolve({ ok: true, status: r.statusCode })) },
        )
        req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }))
        req.end()
      })
      assert.equal(res.ok, true, `来源 ${localAddress} 应可访问: ${JSON.stringify(res)}`)
    }
  } finally {
    server.close()
  }
})
