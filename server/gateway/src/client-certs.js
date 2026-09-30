// 客户端证书（mTLS）白名单：用一个本地 CA 为每台设备签发客户端证书，
// 网关只接受能通过证书链校验、且指纹在白名单内的连接。
// 与 IP 锁相比不依赖来源地址（家庭/出差/移动网络都可用），并支持即时吊销。
//
// 落盘位置（<网关数据目录>/tls 下）：
//   client-ca.pem / client-ca.key.pem    客户端 CA（自签）
//   clients/<name>.cert.pem | .key.pem   每台设备的证书与私钥
//   clients/allowlist.json               指纹白名单（吊销 = 从中移除，立即生效）
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  der,
  encodeIntegerBytes,
  encodeName,
  encodeOid,
  encodeUtcTime,
} from './tls-cert.js'

const TAG_INTEGER = 0x02
const TAG_BITSTRING = 0x03
const TAG_OCTETSTRING = 0x04
const TAG_SEQUENCE = 0x30
const TAG_BOOLEAN = 0x01

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_KEY_USAGE = '2.5.29.15'
const OID_EXT_KEY_USAGE = '2.5.29.37'
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

const CA_CN = 'DSH Remote Client CA'

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

function toPem(type, derBuf) {
  const lines = derBuf.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`
}

export function tlsDir(dataDir) {
  return path.join(dataDir, 'tls')
}

export function clientsDir(dataDir) {
  return path.join(tlsDir(dataDir), 'clients')
}

export function clientCaPaths(dataDir) {
  const dir = tlsDir(dataDir)
  return {
    certFile: path.join(dir, 'client-ca.pem'),
    keyFile: path.join(dir, 'client-ca.key.pem'),
  }
}

export function allowlistPath(dataDir) {
  return path.join(clientsDir(dataDir), 'allowlist.json')
}

// ---------- 证书构造 ----------

function certExtension(oid, critical, valueDer) {
  const parts = [encodeOid(oid)]
  if (critical) parts.push(der(TAG_BOOLEAN, Buffer.from([0xff])))
  parts.push(der(TAG_OCTETSTRING, valueDer))
  return der(TAG_SEQUENCE, parts)
}

function signCert({ subjectName, issuerName, spki, extensions, daysValid, signerKey }) {
  const algId = der(TAG_SEQUENCE, [encodeOid(OID_ECDSA_SHA256)])
  // notBefore 回拨 5 分钟，容忍设备与本机的时钟偏差
  const notBefore = new Date(Date.now() - 5 * 60 * 1000)
  const notAfter = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000)
  const validity = der(TAG_SEQUENCE, [encodeUtcTime(notBefore), encodeUtcTime(notAfter)])
  const tbs = der(TAG_SEQUENCE, [
    der(0xa0, der(TAG_INTEGER, Buffer.from([2]))), // v3
    encodeIntegerBytes(crypto.randomBytes(16)),
    algId,
    encodeName(issuerName),
    validity,
    encodeName(subjectName),
    spki,
    der(0xa3, der(TAG_SEQUENCE, extensions)),
  ])
  const signature = crypto.createSign('SHA256').update(tbs).sign({
    key: signerKey,
    dsaEncoding: 'der',
  })
  const certDer = der(TAG_SEQUENCE, [
    tbs,
    algId,
    der(TAG_BITSTRING, Buffer.concat([Buffer.from([0]), signature])),
  ])
  return { certPem: toPem('CERTIFICATE', certDer), notAfter }
}

// ---------- 客户端 CA ----------

export function generateClientCa({ daysValid = 3650 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  // CA: basicConstraints CA=TRUE + keyUsage keyCertSign|cRLSign
  const basicConstraints = certExtension(
    OID_BASIC_CONSTRAINTS,
    true,
    der(TAG_SEQUENCE, [der(TAG_BOOLEAN, Buffer.from([0xff]))]),
  )
  const keyUsage = certExtension(
    OID_KEY_USAGE,
    true,
    der(TAG_BITSTRING, Buffer.from([0x01, 0x06])),
  )
  const { certPem } = signCert({
    subjectName: CA_CN,
    issuerName: CA_CN,
    spki: publicKey.export({ type: 'spki', format: 'der' }),
    extensions: [basicConstraints, keyUsage],
    daysValid,
    signerKey: privateKey,
  })
  return { certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

export function loadOrCreateClientCa({ dataDir, log = () => {}, daysValid = 3650 }) {
  const { certFile, keyFile } = clientCaPaths(dataDir)
  fs.mkdirSync(tlsDir(dataDir), { recursive: true })
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const certPem = fs.readFileSync(certFile, 'utf8')
    const keyPem = fs.readFileSync(keyFile, 'utf8')
    const x509 = new crypto.X509Certificate(certPem)
    const msLeft = new Date(x509.validTo).getTime() - Date.now()
    if (msLeft > 30 * 24 * 60 * 60 * 1000) {
      log(`复用已有客户端 CA（到期 ${x509.validTo}，${x509.fingerprint256.slice(0, 17)}…）`)
      return { certPem, keyPem, certFile, keyFile }
    }
  }
  const { certPem, keyPem } = generateClientCa({ daysValid })
  atomicWrite(keyFile, keyPem)
  atomicWrite(certFile, certPem)
  try {
    fs.chmodSync(keyFile, 0o600)
  } catch {}
  log(`已生成客户端 CA（证书: ${certFile}）`)
  return { certPem, keyPem, certFile, keyFile }
}

// ---------- 设备证书签发 ----------

export function issueClientCert({ dataDir, name, daysValid = 3650 }) {
  if (!/^[A-Za-z0-9._-]+$/.test(name || '')) {
    throw new Error('设备名只能包含字母、数字、点、下划线和短横线')
  }
  const { certPem: caCertPem, keyPem: caKeyPem } = loadOrCreateClientCa({ dataDir })
  const caX509 = new crypto.X509Certificate(caCertPem)
  const caKey = crypto.createPrivateKey(caKeyPem)

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const basicConstraints = certExtension(
    OID_BASIC_CONSTRAINTS,
    true,
    der(TAG_SEQUENCE, [der(TAG_BOOLEAN, Buffer.from([0x00]))]),
  )
  // keyUsage = digitalSignature；extendedKeyUsage = clientAuth
  const keyUsage = certExtension(
    OID_KEY_USAGE,
    true,
    der(TAG_BITSTRING, Buffer.from([0x07, 0x80])),
  )
  const extKeyUsage = certExtension(
    OID_EXT_KEY_USAGE,
    false,
    der(TAG_SEQUENCE, [encodeOid(OID_CLIENT_AUTH)]),
  )

  const { certPem, notAfter } = signCert({
    subjectName: name,
    issuerName: caX509.subject.replace(/^CN=/, ''),
    spki: publicKey.export({ type: 'spki', format: 'der' }),
    extensions: [basicConstraints, keyUsage, extKeyUsage],
    daysValid,
    signerKey: caKey,
  })

  const dir = clientsDir(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const certFile = path.join(dir, `${name}.cert.pem`)
  const keyFile = path.join(dir, `${name}.key.pem`)
  atomicWrite(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  atomicWrite(certFile, certPem)
  try {
    fs.chmodSync(keyFile, 0o600)
  } catch {}

  const fingerprint256 = new crypto.X509Certificate(certPem).fingerprint256
  const allow = readAllowlist(dataDir)
  allow.entries[fingerprint256] = { name, addedAt: new Date().toISOString() }
  writeAllowlist(dataDir, allow)

  return { name, certPem, certFile, keyFile, fingerprint256, notAfter }
}

// ---------- 指纹白名单（授权与即时吊销）----------

export function readAllowlist(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(allowlistPath(dataDir), 'utf8'))
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw
  } catch {
    // 缺失或损坏都按空白名单处理（fail-closed）
  }
  return { version: 1, entries: {} }
}

function writeAllowlist(dataDir, allow) {
  fs.mkdirSync(clientsDir(dataDir), { recursive: true })
  atomicWrite(allowlistPath(dataDir), JSON.stringify(allow, null, 2))
}

export function isClientAllowed(dataDir, fingerprint256) {
  if (typeof fingerprint256 !== 'string' || fingerprint256 === '') return false
  const allow = readAllowlist(dataDir)
  return Object.prototype.hasOwnProperty.call(allow.entries, fingerprint256)
}

export function revokeClientCert({ dataDir, name }) {
  const allow = readAllowlist(dataDir)
  const hit = Object.entries(allow.entries).find(([, v]) => v && v.name === name)
  if (!hit) return false
  delete allow.entries[hit[0]]
  writeAllowlist(dataDir, allow)
  return true
}

// ---------- 网关装配 ----------

// 构造 mTLS 的 TLS 选项：要求客户端证书且必须能由我们的客户端 CA 验证。
export function buildMtlsTlsOptions(dataDir, baseOptions = {}) {
  const { certFile } = clientCaPaths(dataDir)
  if (!fs.existsSync(certFile)) {
    const e = new Error(`已启用 mTLS 但缺少客户端 CA：${certFile}`)
    e.code = 'CLIENT_CA_MISSING'
    throw e
  }
  return {
    ...baseOptions,
    ca: fs.readFileSync(certFile, 'utf8'),
    requestCert: true,
    rejectUnauthorized: true,
  }
}

// 握手失败的审计取舍。
//
// **不能"全记"**：`tlsClientError` 对**任何**握手失败都会触发，端口扫描、明文 HTTP 误发到
// TLS 端口都算（实测见下表），全记会在公网暴露时把审计刷爆。
//
// **也不能"按证书关键词白名单记"**：实测中最要紧的一类 —— 外部 CA 签发的客户端证书 ——
// 服务端只报 `ERR_SSL_EVP_LIB` / reason=`EVP lib`，**字面与证书毫无关联**，白名单必然漏掉它。
//
// ⇒ 规则：**只排除实测确认与证书无关的两类**，其余一律记录。
//    方向上是 **fail-open**（遇到没见过的错误码会记下来）—— 对审计而言"多记"比"漏记"安全；
//    代价用审计轮转兜底（见 P1 计划 §4.1 的 S4）。
//
// 实测依据（2026-09-23，`.runtime/kernel-inspect/probe-tls-client-error.mjs`）：
//   场景                        服务端 code                                 判定
//   不带客户端证书               ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE  ✅ 记（证书问题）
//   外部 CA 签发的证书           ERR_SSL_EVP_LIB (library=asn1)             ✅ 记（证书问题）
//   裸 TCP 连上就断（端口探针）   ECONNRESET                                 ❌ 不记
//   明文 HTTP 打到 TLS 端口      ERR_SSL_HTTP_REQUEST                       ❌ 不记
//   TLS 但不发客户端证书         ECONNRESET                                 ❌ 不记
//
// ⚠️ 命名说明：落到这里的事件仍叫 `auth.client_cert_denied`（便于"因 mTLS 被拒"一次筛全），
//    但 fail-open 下它可能含未分类的握手失败 —— 具体原因看 `phase` 与 `code` 字段。
const NON_CERT_HANDSHAKE_ERRORS = new Set([
  'ECONNRESET', // 对端直接断开 / RST：没有 OpenSSL 层信息，说明压根没走到证书处理
  'ERR_SSL_HTTP_REQUEST', // 明文 HTTP 打到了 TLS 端口：协议不匹配，与证书无关
])

function describeAuditableHandshakeError(err) {
  if (!err) return null
  const code = err.code || null
  if (code && NON_CERT_HANDSHAKE_ERRORS.has(code)) return null
  return { code, reason: err.reason || null, library: err.library || null }
}

// 握手通过后再按指纹白名单授权：不在白名单内（含已吊销）立即断开连接。
// 与 IP 锁不同，这里判断的是客户端身份，因此家庭/出差等地址变化不影响使用。
export function attachMtlsEnforcement(server, { dataDir, log = () => {}, audit = null }) {
  server.on('secureConnection', (socket) => {
    const peer = socket.getPeerCertificate()
    const fingerprint = peer && peer.fingerprint256
    if (isClientAllowed(dataDir, fingerprint)) return
    log(`拒绝未授权的客户端证书: ${fingerprint || '(未提供证书)'}`)
    // phase 用于区分三条拒绝路径：
    //   handshake         = 新连接握手时，链合法但不在白名单（未授权 / 已吊销）
    //   handshake-invalid = 新连接握手时，**证书链本身校验不过**（外部 CA / 未提供 / 过期）
    //   request           = keep-alive 复用连接时的每请求复核（记在 index.js 的 routeRequest 里）
    // 三处都要留痕，否则"谁在拿废证书敲门"或"被吊销设备还在重试"就没有任何痕迹。
    if (audit) audit.log('auth.client_cert_denied', { phase: 'handshake', fingerprint: fingerprint || null })
    socket.destroy()
  })
  server.on('tlsClientError', (err, socket) => {
    const info = describeAuditableHandshakeError(err)
    log(`TLS 握手失败${info ? '（需审计）' : ''}: ${err.code || err.message}`)
    if (audit && info) {
      audit.log('auth.client_cert_denied', {
        phase: 'handshake-invalid',
        fingerprint: null, // 链都没校验过，拿不到可信指纹
        ...info,
      })
    }
    socket.destroy()
  })
  return server
}

// 从请求上取客户端证书指纹（HTTPS 连接才有）。
export function getRequestClientFingerprint(req) {
  const socket = req && req.socket
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null
  const peer = socket.getPeerCertificate()
  return (peer && peer.fingerprint256) || null
}

// 每请求复核：TLS 连接会被 keep-alive 复用，若只在握手时校验，
// 已吊销的设备可凭旧连接继续访问。这里在 HTTP 入口再判一次，吊销即刻生效。
export function isRequestClientAllowed(dataDir, req) {
  return isClientAllowed(dataDir, getRequestClientFingerprint(req))
}

// 该请求**是否必须**携带已授权的客户端证书（每请求复核的入口判断）。
//
// 🔴 为什么不能简化成 `config.mtls`：C 方案要求"两种正式入口并存"——
//   · **明文口**（`DSH_GATEWAY_PLAIN_KEEP=1`）：给 Funnel `--https` 用。tailscaled 已经终止 TLS，
//     后端只见明文 ⇒ 客户端**不可能**带客户端证书；这条入口的身份由**网关登录**负责。
//   · **TLS 口**：给 Funnel `--tcp` + mTLS 用，身份由**客户端证书**负责。
//   若对明文请求也强制证书，第一种入口会被 100% 403 打死（2026-09-28 真机踩到过）。
//   ⚠️ 只有**显式**打开 PLAIN_KEEP 才放行明文请求；默认 false 时行为与原先**逐字一致**。
export function needsClientCert(config, req) {
  if (!config || !config.mtls) return false
  if (config.plainKeep && !(req && req.socket && req.socket.encrypted)) return false
  return true
}

export function listClientCerts(dataDir) {
  const dir = clientsDir(dataDir)
  const allow = readAllowlist(dataDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.cert.pem'))
    .map((f) => {
      const certPem = fs.readFileSync(path.join(dir, f), 'utf8')
      const x509 = new crypto.X509Certificate(certPem)
      const name = f.replace(/\.cert\.pem$/, '')
      return {
        name,
        subject: x509.subject,
        notAfter: x509.validTo,
        fingerprint256: x509.fingerprint256,
        allowed: Object.prototype.hasOwnProperty.call(allow.entries, x509.fingerprint256),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
