import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateSelfSignedCert, loadOrCreateTlsCert, normalizeSanList } from '../src/tls-cert.js'

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tls-cert-'))
}

// 1.3.6.1.5.5.7.3.1 serverAuth 的 DER 编码
const SERVER_AUTH_DER = Buffer.from('06082b06010505070301', 'hex')

test('生成的自签证书可被 X509Certificate 解析', () => {
  const { certPem, keyPem, certDer } = generateSelfSignedCert()
  const x509 = new crypto.X509Certificate(certPem)
  assert.equal(x509.subject, 'CN=DSH Remote Localhost')
  assert.equal(x509.issuer, 'CN=DSH Remote Localhost')
  assert.equal(Buffer.isBuffer(certDer), true)
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(keyPem)), true)
})

test('SAN 覆盖 localhost / 127.0.0.1 / ::1', () => {
  const { certPem } = generateSelfSignedCert()
  const san = new crypto.X509Certificate(certPem).subjectAltName
  assert.match(san, /DNS:localhost/)
  assert.match(san, /IP Address:127\.0\.0\.1/)
  assert.match(san, /IP Address:0:0:0:0:0:0:0:1|IP Address:::1/)
})

test('证书是终端实体而非 CA，且 keyUsage 不含 keyCertSign', () => {
  const { certPem, certDer } = generateSelfSignedCert()
  const x509 = new crypto.X509Certificate(certPem)
  assert.equal(x509.ca, false, 'cA 必须为 false，避免被当作可签任意证书的 CA')
  const hex = certDer.toString('hex')
  // keyUsage 扩展：OID 2.5.29.15 + critical + OCTET STRING(03 02 05 a0)
  // 0xa0 = digitalSignature + keyEncipherment；含 keyCertSign 的旧组合为 0x84
  assert.ok(hex.includes('0603551d0f0101ff0404030205a0'), 'keyUsage 应为 digitalSignature + keyEncipherment')
  assert.ok(!hex.includes('030284'), '不应包含 keyCertSign 位')
})

test('证书声明 serverAuth 用途', () => {
  const { certDer } = generateSelfSignedCert()
  assert.ok(certDer.includes(SERVER_AUTH_DER), '应包含 extendedKeyUsage=serverAuth')
})

test('notBefore 回拨以容忍时钟偏差', () => {
  const { certPem } = generateSelfSignedCert()
  const x509 = new crypto.X509Certificate(certPem)
  assert.ok(new Date(x509.validFrom).getTime() <= Date.now(), 'notBefore 不应晚于当前时间')
})

test('loadOrCreateTlsCert 生成并复用同一证书', () => {
  const dir = makeDir()
  const logs = []
  const first = loadOrCreateTlsCert({ dataDir: dir, log: (m) => logs.push(m) })
  assert.ok(fs.existsSync(path.join(dir, 'tls', 'cert.pem')))
  assert.ok(fs.existsSync(path.join(dir, 'tls', 'key.pem')))

  const second = loadOrCreateTlsCert({ dataDir: dir, log: (m) => logs.push(m) })
  assert.equal(first.cert, second.cert, '未过期时应复用已有证书')
  assert.equal(first.key, second.key)
})

test('证书文件损坏时重新签发', () => {
  const dir = makeDir()
  const first = loadOrCreateTlsCert({ dataDir: dir, log: () => {} })
  fs.writeFileSync(path.join(dir, 'tls', 'cert.pem'), 'not a cert')
  const second = loadOrCreateTlsCert({ dataDir: dir, log: () => {} })
  assert.notEqual(first.cert, second.cert)
  assert.doesNotThrow(() => new crypto.X509Certificate(second.cert))
})

// ---- 自定义 SAN（云上固定 IP / 域名访问）----

test('normalizeSanList: 去空白、去方括号、去重', () => {
  assert.deepEqual(normalizeSanList([' 1.2.3.4 ', '[::1]', '1.2.3.4', '', null]), ['1.2.3.4', '::1'])
  assert.deepEqual(normalizeSanList('a.com'), ['a.com'])
  assert.deepEqual(normalizeSanList(undefined), [])
})

test('自定义 SAN 支持 IPv4 / IPv6 / DNS 名', () => {
  const { certPem } = generateSelfSignedCert({ san: ['example.com', '203.0.113.9', '2001:db8::1'] })
  const san = new crypto.X509Certificate(certPem).subjectAltName
  assert.match(san, /DNS:example\.com/)
  assert.match(san, /IP Address:203\.0\.113\.9/)
  assert.match(san, /IP Address:2001:db8:(0:){5}1/i)
})

test('未传 san 时使用默认回环 SAN', () => {
  const { certPem } = generateSelfSignedCert()
  const san = new crypto.X509Certificate(certPem).subjectAltName
  assert.match(san, /DNS:localhost/)
  assert.match(san, /IP Address:127\.0\.0\.1/)
})

test('loadOrCreateTlsCert: 追加公网 IP 后重新签发', () => {
  const dir = makeDir()
  const first = loadOrCreateTlsCert({ dataDir: dir, log: () => {} })
  const logs = []
  const second = loadOrCreateTlsCert({ dataDir: dir, log: (m) => logs.push(m), san: ['203.0.113.9'] })
  assert.notEqual(first.cert, second.cert, 'SAN 变化必须重签，否则浏览器仍报不匹配')
  assert.ok(logs.some((m) => m.includes('203.0.113.9')))
  assert.match(new crypto.X509Certificate(second.cert).subjectAltName, /IP Address:203\.0\.113\.9/)
})

test('loadOrCreateTlsCert: SAN 未变化时复用证书', () => {
  const dir = makeDir()
  const san = ['localhost', '203.0.113.9']
  const first = loadOrCreateTlsCert({ dataDir: dir, log: () => {}, san })
  const second = loadOrCreateTlsCert({ dataDir: dir, log: () => {}, san })
  assert.equal(first.cert, second.cert)
})
