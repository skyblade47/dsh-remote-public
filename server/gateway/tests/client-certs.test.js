import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  allowlistPath,
  clientCaPaths,
  isClientAllowed,
  issueClientCert,
  listClientCerts,
  loadOrCreateClientCa,
  needsClientCert,
  revokeClientCert,
} from '../src/client-certs.js'

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'client-certs-'))
}

// ---- 每请求复核的"是否必须客户端证书"（C 方案：明文口与 TLS 口作为两种正式入口并存）----

test('needsClientCert：mTLS 关 ⇒ 不要求；PLAIN_KEEP 下的明文请求 ⇒ 不要求；TLS 请求照旧要求', () => {
  const tlsReq = { socket: { encrypted: true } }
  const plainReq = { socket: { encrypted: false } }

  assert.equal(needsClientCert({ mtls: false }, tlsReq), false, 'mTLS 关时一概不要求')
  assert.equal(needsClientCert({ mtls: true }, tlsReq), true)
  assert.equal(
    needsClientCert({ mtls: true, plainKeep: true }, plainReq),
    false,
    'PLAIN_KEEP 下的明文口是"另一种正式入口"（身份交给网关登录），强制证书会 403 打死它',
  )
  assert.equal(
    needsClientCert({ mtls: true, plainKeep: true }, tlsReq),
    true,
    'TLS 口照旧强制 —— 那才是 mTLS 的本职',
  )
  assert.equal(
    needsClientCert({ mtls: true, plainKeep: false }, plainReq),
    true,
    '未显式保留明文口 ⇒ 行为与原先一致（明文请求也要证书）',
  )
  assert.equal(needsClientCert(null, tlsReq), false, '没有 config 不要求（防御性）')
})

test('客户端 CA 生成为 CA 证书并可复用', () => {
  const dir = makeDir()
  const ca = loadOrCreateClientCa({ dataDir: dir })
  const x509 = new crypto.X509Certificate(ca.certPem)
  assert.equal(x509.ca, true)
  assert.equal(x509.subject, 'CN=DSH Remote Client CA')
  assert.ok(fs.existsSync(clientCaPaths(dir).keyFile))

  const again = loadOrCreateClientCa({ dataDir: dir })
  assert.equal(again.certPem, ca.certPem)
})

test('签发的设备证书可被 CA 公钥验证通过', () => {
  const dir = makeDir()
  const ca = loadOrCreateClientCa({ dataDir: dir })
  const issued = issueClientCert({ dataDir: dir, name: 'iphone' })
  const leaf = new crypto.X509Certificate(issued.certPem)
  const caX509 = new crypto.X509Certificate(ca.certPem)

  assert.equal(leaf.subject, 'CN=iphone')
  assert.equal(leaf.issuer, 'CN=DSH Remote Client CA')
  assert.equal(leaf.ca, false)
  assert.equal(leaf.verify(caX509.publicKey), true, '证书链校验应通过')
  assert.match(leaf.subjectAltName || '', /^$/)
  assert.equal(leaf.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(issued.keyFile, 'utf8'))), true)
})

test('设备证书声明 clientAuth 用途', () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'laptop' })
  const leaf = new crypto.X509Certificate(issued.certPem)
  // 1.3.6.1.5.5.7.3.2 clientAuth
  const { raw } = leaf
  const clientAuthDer = Buffer.from('06082b06010505070302', 'hex')
  assert.ok(raw.includes(clientAuthDer), '应包含 extendedKeyUsage=clientAuth')
})

test('签发后进入白名单，吊销后立即失效', () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'ipad' })
  assert.equal(isClientAllowed(dir, issued.fingerprint256), true)

  assert.equal(revokeClientCert({ dataDir: dir, name: 'ipad' }), true)
  assert.equal(isClientAllowed(dir, issued.fingerprint256), false)
  assert.equal(revokeClientCert({ dataDir: dir, name: 'ipad' }), false, '重复吊销返回 false')
})

test('未知指纹一律拒绝（fail-closed）', () => {
  const dir = makeDir()
  assert.equal(isClientAllowed(dir, 'AA:BB:CC'), false)
  assert.equal(isClientAllowed(dir, ''), false)
  assert.equal(isClientAllowed(dir, undefined), false)
})

test('白名单文件损坏时按空白名单处理', () => {
  const dir = makeDir()
  const issued = issueClientCert({ dataDir: dir, name: 'phone' })
  fs.writeFileSync(allowlistPath(dir), '{坏 json')
  assert.equal(isClientAllowed(dir, issued.fingerprint256), false)
})

test('list 反映证书与授权状态', () => {
  const dir = makeDir()
  issueClientCert({ dataDir: dir, name: 'a-device' })
  const b = issueClientCert({ dataDir: dir, name: 'b-device' })
  revokeClientCert({ dataDir: dir, name: 'b-device' })

  const list = listClientCerts(dir)
  assert.deepEqual(list.map((c) => c.name), ['a-device', 'b-device'])
  assert.equal(list.find((c) => c.name === 'a-device').allowed, true)
  assert.equal(list.find((c) => c.name === 'b-device').allowed, false)
  assert.equal(list.find((c) => c.name === 'b-device').fingerprint256, b.fingerprint256)
})

test('非法设备名被拒绝', () => {
  const dir = makeDir()
  for (const bad of ['../evil', 'a/b', '', 'has space']) {
    assert.throws(() => issueClientCert({ dataDir: dir, name: bad }), /设备名/)
  }
})
