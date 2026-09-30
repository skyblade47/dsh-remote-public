// 零依赖自签名 X.509 证书：手写 ASN.1 DER 编码，使用 EC P-256。
// 用途：浏览器到网关的 HTTPS 加密；证书持久化复用，过期前自动重签。
// 默认 SAN 覆盖 localhost / 127.0.0.1 / ::1；云上固定 IP 或域名访问时
// 通过 DSH_GATEWAY_TLS_SAN 追加对应条目，首次访问信任一次即可。
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const TAG_INTEGER = 0x02
const TAG_BITSTRING = 0x03
const TAG_OCTETSTRING = 0x04
const TAG_NULL = 0x05
const TAG_OID = 0x06
const TAG_UTF8 = 0x0c
const TAG_UTCTIME = 0x17
const TAG_SEQUENCE = 0x30
const TAG_SET = 0x31
const TAG_BOOLEAN = 0x01

export function derLength(len) {
  if (len < 128) return Buffer.from([len])
  const bytes = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n = Math.floor(n / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

export function encodeOid(oid) {
  const arcs = oid.split('.').map(Number)
  const out = [40 * arcs[0] + arcs[1]]
  for (let i = 2; i < arcs.length; i++) {
    let v = arcs[i]
    const stack = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(...stack)
  }
  return der(TAG_OID, Buffer.from(out))
}

export function encodeIntegerBytes(bytes) {
  let b = bytes
  while (b.length > 1 && b[0] === 0) b = b.subarray(1)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return der(TAG_INTEGER, b)
}

export function encodeName(cn) {
  const attr = der(TAG_SEQUENCE, [
    encodeOid('2.5.4.3'),
    der(TAG_UTF8, Buffer.from(cn, 'utf8')),
  ])
  return der(TAG_SEQUENCE, [der(TAG_SET, [attr])])
}

export function encodeUtcTime(date) {
  const p = (n) => String(n).padStart(2, '0')
  const s =
    `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  return der(TAG_UTCTIME, Buffer.from(s))
}

function toPem(type, derBuf) {
  const lines = derBuf.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`
}

// ---------- SubjectAltName ----------

export const DEFAULT_SAN = ['localhost', '127.0.0.1', '::1']

// 归一化：去空白、去方括号（IPv6 常见写法）、去重并保持顺序。
export function normalizeSanList(list) {
  const out = []
  for (const raw of [].concat(list || [])) {
    if (typeof raw !== 'string') continue
    const v = raw.trim().replace(/^\[|\]$/g, '')
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// IPv6 → 16 字节；支持 :: 压缩与末尾嵌入式 IPv4（如 ::ffff:127.0.0.1）。
function ipv6ToBytes(raw) {
  const addr = raw.replace(/^\[|\]$/g, '')
  const hasCompression = addr.includes('::')
  const [left, right] = hasCompression ? addr.split('::') : [addr, null]
  const split = (part) => (part ? part.split(':') : [])
  const leftGroups = split(left)
  const rightGroups = hasCompression ? split(right) : []
  const weight = (groups) => groups.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0)

  let groups
  if (hasCompression) {
    const missing = 8 - weight(leftGroups) - weight(rightGroups)
    if (missing < 0) throw new Error(`无法解析的 IPv6 地址: ${raw}`)
    groups = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups]
  } else {
    groups = leftGroups
  }

  const bytes = []
  for (const g of groups) {
    if (g.includes('.')) {
      const v4 = g.split('.').map(Number)
      if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        throw new Error(`无法解析的 IPv6 地址: ${raw}`)
      }
      bytes.push(...v4)
    } else {
      const n = parseInt(g || '0', 16)
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`无法解析的 IPv6 地址: ${raw}`)
      bytes.push((n >> 8) & 0xff, n & 0xff)
    }
  }
  if (bytes.length !== 16) throw new Error(`无法解析的 IPv6 地址: ${raw}`)
  return Buffer.from(bytes)
}

// 条目类型：IP 字面量走 iPAddress(0x87)，其余按 DNS 名(0x82)处理。
function sanEntryToDer(value) {
  const ipVersion = net.isIP(value)
  if (ipVersion === 4) {
    return der(0x87, Buffer.from(value.split('.').map(Number)))
  }
  if (ipVersion === 6) {
    return der(0x87, ipv6ToBytes(value))
  }
  return der(0x82, Buffer.from(value, 'ascii'))
}

function encodeSubjectAltName(entries) {
  const list = normalizeSanList(entries.length ? entries : DEFAULT_SAN)
  if (list.length === 0) throw new Error('证书 SAN 不能为空')
  return der(TAG_SEQUENCE, list.map(sanEntryToDer))
}

export function generateSelfSignedCert({ daysValid = 3650, san = DEFAULT_SAN } = {}) {
  const sanEntries = normalizeSanList(san.length ? san : DEFAULT_SAN)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  const algId = der(TAG_SEQUENCE, [encodeOid('1.2.840.10045.4.3.2')])
  const name = encodeName('DSH Remote Localhost')

  // notBefore 回拨 5 分钟，容忍各终端与本机的时钟偏差
  const notBefore = new Date(Date.now() - 5 * 60 * 1000)
  const notAfter = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000)
  const validity = der(TAG_SEQUENCE, [encodeUtcTime(notBefore), encodeUtcTime(notAfter)])

  // 终端实体证书：cA=FALSE。若标为 CA，用户把这台机器的证书导入受信任根后，
  // 泄露的私钥可被用来签发任意站点证书，放大 MITM 风险。
  const basicConstraints = der(TAG_SEQUENCE, [
    encodeOid('2.5.29.19'),
    der(TAG_BOOLEAN, Buffer.from([0xff])),
    der(TAG_OCTETSTRING, der(TAG_SEQUENCE, [der(TAG_BOOLEAN, Buffer.from([0x00]))])),
  ])

  // keyUsage = digitalSignature + keyEncipherment（不含 keyCertSign）
  const keyUsageValue = der(TAG_BITSTRING, Buffer.from([0x05, 0xa0]))
  const keyUsage = der(TAG_SEQUENCE, [
    encodeOid('2.5.29.15'),
    der(TAG_BOOLEAN, Buffer.from([0xff])),
    der(TAG_OCTETSTRING, keyUsageValue),
  ])

  // extendedKeyUsage = serverAuth（1.3.6.1.5.5.7.3.1）
  const extendedKeyUsage = der(TAG_SEQUENCE, [
    encodeOid('2.5.29.37'),
    der(TAG_OCTETSTRING, der(TAG_SEQUENCE, [encodeOid('1.3.6.1.5.5.7.3.1')])),
  ])

  const sanDer = encodeSubjectAltName(sanEntries)
  const subjectAltName = der(TAG_SEQUENCE, [
    encodeOid('2.5.29.17'),
    der(TAG_OCTETSTRING, sanDer),
  ])

  const extensions = der(TAG_SEQUENCE, [basicConstraints, keyUsage, extendedKeyUsage, subjectAltName])

  const serial = encodeIntegerBytes(crypto.randomBytes(16))
  const version = der(0xa0, der(TAG_INTEGER, Buffer.from([2])))

  const tbs = der(TAG_SEQUENCE, [
    version,
    serial,
    algId,
    name,
    validity,
    name,
    spki,
    der(0xa3, extensions),
  ])

  const signature = crypto.createSign('SHA256').update(tbs).sign({
    key: privateKey,
    dsaEncoding: 'der',
  })
  const certDer = der(TAG_SEQUENCE, [
    tbs,
    algId,
    der(TAG_BITSTRING, Buffer.concat([Buffer.from([0]), signature])),
  ])

  return {
    certPem: toPem('CERTIFICATE', certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certDer,
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

export function loadOrCreateTlsCert({ dataDir, log = () => {}, daysValid = 3650, san = [] }) {
  const dir = path.join(dataDir, 'tls')
  fs.mkdirSync(dir, { recursive: true })
  const certFile = path.join(dir, 'cert.pem')
  const keyFile = path.join(dir, 'key.pem')
  // 记录签发时使用的 SAN，配置变更后据此重新签发（否则浏览器仍会报不匹配）。
  const metaFile = path.join(dir, 'san.json')
  const wanted = normalizeSanList(san.length ? san : DEFAULT_SAN)

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    try {
      const certPem = fs.readFileSync(certFile, 'utf8')
      const keyPem = fs.readFileSync(keyFile, 'utf8')
      const x509 = new crypto.X509Certificate(certPem)
      const msLeft = new Date(x509.validTo).getTime() - Date.now()
      const recorded = JSON.parse(fs.readFileSync(metaFile, 'utf8')).san
      const sanUnchanged = Array.isArray(recorded)
        && recorded.length === wanted.length
        && recorded.every((v, i) => v === wanted[i])
      if (msLeft > 30 * 24 * 60 * 60 * 1000 && sanUnchanged) {
        log(`复用已有自签名证书（到期 ${x509.validTo}，指纹 ${x509.fingerprint512.slice(0, 17)}…）`)
        return { cert: certPem, key: keyPem }
      }
      if (!sanUnchanged) log(`证书 SAN 配置已变更，重新签发：${wanted.join(' / ')}`)
    } catch {
      // 证书或元信息损坏则继续重签
    }
  }

  const { certPem, keyPem } = generateSelfSignedCert({ daysValid, san: wanted })
  atomicWrite(keyFile, keyPem)
  atomicWrite(certFile, certPem)
  atomicWrite(metaFile, JSON.stringify({ san: wanted }, null, 2))
  try {
    fs.chmodSync(keyFile, 0o600)
  } catch {}
  const x509 = new crypto.X509Certificate(certPem)
  log(`已生成自签名证书（到期 ${x509.validTo}，SAN: ${wanted.join(' / ')}）`)
  return { cert: certPem, key: keyPem }
}
