// @local/miyoushe —— 脱敏与"只进不出"出口护栏（设计 §4.2 硬性规则 / §4.3 明确禁止）
//
// §4.2 规则（逐条落地）：
//  1) 只显尾号：任何输出里的账号标识一律 uid 尾 4 位（`***1234`）；无 uid 时用 accountId 尾 4 位。
//  2) Cookie 永不回显：status/accounts/logs/工具输出**一律不含** cookie/ltoken/token/stoken 字段
//     （连前缀都不给）；设置卡只显示"已配置/未配置 + 最后更新时间"。
//  3) 日志脱敏：日志写入前过一层 mask()；原始响应体入库前也要 mask。
//  4) 错误透传：服务端 message 原样给用户，但不含我方请求头的 Cookie/DS；mask() 兜底。
// §4.3：凭据不得进入任何文档/知识库/看板/记忆/静态化源码，不得出现在工具返回值、action 响应、
//       控制台输出、异常堆栈里。
//
// 本模块是**唯一**在代码里命名敏感字段的地方，但**豁免是分行的、不是整文件**（F4 修复，t11）：
//   仅 `SECRET_KEYS` / `SENSITIVE_TOKENS` 的表项行 + `textSecretRe()` 的正则定义行 免扫；
//   本文件其余代码行（maskValue/findSecrets/exitPayload…）与其余 lib/*.js **一视同仁**受扫描。
//   判据文本与可复跑输出见 `selftest/assert-source-discipline.mjs`（D2 + 非空洞自证）。

import { createHash } from 'node:crypto'
import { toLossless, assertLossless } from './lossless.js'

export const REDACTED = '<redacted>'
export const CIRCULAR_MARK = '[Circular]'

/**
 * 「已打码占位符」判据（**F2 修复的判定口**）：本插件的 REDACTED 常量本身，或其**后缀化**形式
 * （`<redacted:uid>` / `<redacted:salt>` 这类带标注的占位）。
 * **只有**命中该判据的尖括号值才被视为"已脱敏产物"；其它任何 `<...>` 值**仍按明文处理**
 * （防"用尖括号把明文藏起来"）——因此本修复不构成"放宽检查"（A2 反例必拒）。
 * 该判据与 `textSecretRe()` 的 value 分支**必须成对维护**：只改其一即破坏「脱敏→复查」的幂等性（F2 教训）。
 */
export const PLACEHOLDER_RE = /^<redacted(?::[A-Za-z0-9_.:-]+)?>$/

/** 是否已是"已打码占位符"（脱敏产物，不算残留） */
export function isPlaceholder(v) {
  return typeof v === 'string' && (v === REDACTED || PLACEHOLDER_RE.test(v))
}

/**
 * **绝不回显**的键（§4.2 规则 2 + §4.3）：出现即视为凭据/令牌材料。
 * 一律替换为 `'<redacted>'`，且出口护栏 assertNoSecrets() 会在替换后复查。
 */
export const SECRET_KEYS = Object.freeze([
  'cookie', 'cookieraw', 'cookie_raw', 'rawcookie', 'raw_cookie',
  'ltoken', 'ltoken_v2', 'stoken', 'stoken_v2',
  'cookie_token', 'cookie_token_v2', 'login_ticket', 'login_ticket_token',
  'token', 'access_token', 'accesstoken', 'refresh_token',
  'ltuid', 'ltuid_v2', 'account_id', 'accountid', 'mid',
  'device_id', 'deviceid', 'device_fp', 'devicefp',
  'ds', // 我方请求头的 DS 也不回显（§4.2 规则 4）
  'salt', // 盐＝签名密钥材料；输出只给 saltFingerprint（§3.5.7）
])

/** 只显尾号的账号标识键（§4.2 规则 1） */
export const TAIL_KEYS = Object.freeze(['uid', 'gameuid', 'game_uid'])

/** 敏感 token 的**源码级**词表（供 A4 可复跑断言扫描 lib/*.js） */
export const SENSITIVE_TOKENS = Object.freeze([
  'cookie', 'cookieraw', 'ltoken', 'stoken', 'cookie_token', 'login_ticket',
  'accesstoken', 'access_token', 'ltuid', 'account_id', 'device_fp',
])

const SECRET_SET = new Set(SECRET_KEYS)
const TAIL_SET = new Set(TAIL_KEYS)

// 文本级凭据检测（§4.2 规则 3/4）：`key=value` / `key: value` 形式。
//
// 【F2 修复点（t11）】value 分支**排除尖括号**，并把尖括号值单列一支：
//   ① `[^&;\s"'\\<>]+` → 普通明文值（不含 < >）
//   ② `<[^<>]*>`       → 尖括号值，交给 isPlaceholder() 判定
// ①的排除使**脱敏产物 `key=<redacted>` 不再被判成明文**（修复前自撞抛 CREDENTIAL_ECHO_BLOCKED，与
// 设计 §6.1②「服务端 message 原样给用户」直接冲突）；②的存在使"用尖括号藏明文"（如 `ds=<realvalue>`）
// **仍然被拒绝** ⇒ 修复只识别"已打码"，不放宽对真值的检查。
//
// 每次新建（不用共享带 g 的正则，避免 lastIndex 状态串味）；lookbehind 词边界避免 "words:" 里被误判。
const VALUE_SRC = '[^&;\\s"\'\\\\<>]+|<[^<>]*>'

function textSecretRe() {
  return new RegExp(
    '(?<![A-Za-z0-9_])(?:' + SECRET_KEYS.join('|') + ')\\s*[=:]\\s*(' + VALUE_SRC + ')',
    'gi',
  )
}

/**
 * 文本级凭据扫描（`findSecrets` 与自测共用；可直接复跑的探针）。
 * 返回 `[{match, value, placeholder}]`：`placeholder === false` 的项即「未脱敏明文」。
 */
export function scanTextSecrets(text) {
  if (typeof text !== 'string' || !text.length) return []
  const re = textSecretRe()
  const out = []
  let m
  while ((m = re.exec(text)) !== null) {
    const value = m[1]
    if (value === undefined) { // 理论上不可达（value 分支至少 1 字符）；防御性防死循环
      if (re.lastIndex === m.index) re.lastIndex++
      continue
    }
    out.push({ match: m[0], value, placeholder: isPlaceholder(value) })
  }
  return out
}

/** 尾 4 位脱敏（§4.2 规则 1）；无法取尾号时返回 `null` */
export function uidTail(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  if (!s) return null
  return '***' + (s.length > 4 ? s.slice(-4) : s)
}

/** 账号键（§5.4 `acct-***1234`） */
export function accountKey(accountId) {
  const tail = uidTail(accountId)
  return tail === null ? null : 'acct-' + tail
}

/** 盐指纹（§3.5.7：SHA-256 **前 8 位**）——审计只落指纹，不落盐明文 */
export function saltFingerprint(salt) {
  if (typeof salt !== 'string' || !salt.length) return null
  return createHash('sha256').update(salt, 'utf8').digest('hex').slice(0, 8)
}

/** 文本级打码（错误 message / 日志行兜底）；**幂等**：已打码的 `key=<redacted>` 原样保留（F2） */
export function maskText(text) {
  if (typeof text !== 'string' || !text.length) return text
  return text.replace(textSecretRe(), (m, value) => {
    if (isPlaceholder(value)) return m // 已打码 ⇒ 不再改写（幂等：杜绝"脱敏产物被当作明文再打一次"）
    const i = m.search(/[=:]/)
    return m.slice(0, i + 1) + REDACTED
  })
}

function maskKeyed(value, seen) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return maskText(value)
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value
  if (seen.has(value)) return CIRCULAR_MARK
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((x) => maskKeyed(x, seen))
  } else {
    out = {}
    for (const k of Object.keys(value)) {
      const kl = k.toLowerCase()
      if (SECRET_SET.has(kl)) { out[k] = REDACTED; continue }
      if (TAIL_SET.has(kl)) { out[k] = uidTail(value[k]); continue }
      out[k] = maskKeyed(value[k], seen)
    }
  }
  seen.delete(value)
  return out
}

/** 深度脱敏（不改动入参，返回新对象/新数组；未知结构按 §4.2 规则 1/2 处理） */
export function maskValue(value) {
  return maskKeyed(value, new WeakSet())
}

/** 扫描**未脱敏**的敏感残留（期望值恒为 REDACTED）；同时扫描明文凭据串 */
export function findSecrets(value) {
  const out = []
  const seen = new WeakSet()
  const walk = (v, path) => {
    if (typeof v === 'string') {
      // 只把**非占位**的凭据串算作残留：占位＝脱敏器自己的产物（PLACEHOLDER_RE），不是明文（F2 修复）
      if (scanTextSecrets(v).some((h) => h.placeholder === false)) {
        out.push({ path, reason: 'text-looks-like-credential' })
      }
      return
    }
    if (v === null || v === undefined || typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); seen.delete(v); return }
    for (const k of Object.keys(v)) {
      const kl = k.toLowerCase()
      const child = v[k]
      if (SECRET_SET.has(kl) && child !== REDACTED) {
        out.push({ path: path + '.' + k, reason: 'secret-key-with-value' })
      }
      walk(child, path + '.' + k)
    }
    seen.delete(v)
  }
  walk(value, '$')
  return out
}

export class MaskError extends Error {
  constructor(hits, label) {
    const head = hits.slice(0, 5).map((h) => h.path + ' (' + h.reason + ')').join('; ')
    super('出口含未脱敏凭据' + (label ? '[' + label + ']' : '') + '：' + hits.length + ' 处，例：' + head)
    this.name = 'MaskError'
    this.code = 'CREDENTIAL_ECHO_BLOCKED'
    this.hits = hits
  }
}

/** 出口护栏（§4.2 规则 2 的"声明式保证"）：残留即抛，绝不把凭据交出去 */
export function assertNoSecrets(value, label) {
  const hits = findSecrets(value)
  if (hits.length) throw new MaskError(hits, label)
  return value
}

/**
 * **唯一**对外出口：所有 action / agent 工具的返回值一律走这里（§6.2.2 纪律 3 + §4.2 + §6.1②）。
 *
 * **签名（三参，顺序固定）**：`exitPayload(value, label, opts)`
 *   - `value` 任意可序列化值（内部对象；出口处会被脱敏 + 无损化）。
 *   - `label` **只接受字符串**（可选）：用于 `MaskError` 消息里标注来源，例如 `'status'` / `'miyoushe_credentials'`。
 *     ⚠️ 历史事故（t14 记）：曾有调用方把 opts 传到第 2 参（`exitPayload(v, {strict:true})`），
 *     于是 `label` 位置收到对象、抛错时打出 `[[object Object]]`。本实现**对第 2 参做防御性纠错**：
 *     若第 2 参不是字符串且第 3 参缺失，则把它当作 `opts` 使用并复位 `label=undefined`（语义不丢、消息干净）。
 *   - `opts`（可选）：
 *     * `strict: true` ⇒ **fail-closed**：先 `assertNoSecrets(value)`（入参含真值/未打码敏感键即抛
 *       `CREDENTIAL_ECHO_BLOCKED`），再脱敏复查。**「只进不出」类路径必须显式用它**（如未来的
 *       `miyoushe_credentials` —— 凭据写入回执绝不允许携带凭据原件）。
 *     * `maskOnly: true` ⇒ **兼容别名，等价于默认**（历史签名；保留以免既有调用点失效）。
 *
 * **默认姿态（captain 裁决 2026-09-20，落地于 t14）＝「掩码兜底」**：先脱敏 → 再复查 → 无损化：
 *   - 真值（如 `ds=realvalue123`）被替换为 `<redacted>`，**不抛** ⇒ 服务端 `message` 可原样回显给用户（§6.1②）；
 *   - **已打码占位**（`<redacted>` / `<redacted:xxx>`）原样保留（幂等，F2 修复）；
 *   - **脱敏后复查在任何姿态下都执行** —— 它是防"掩码器漏检"的真正护栏（掩码漏掉的真值仍会被拦下）。
 */
export function exitPayload(value, label, opts) {
  let lbl = label
  let o = opts
  // 防御性纠错（t14）：label 只可能是字符串；对象落到 label 位视为历史误用 ⇒ 当 opts 用（见上方 JSDoc）
  if (lbl !== undefined && lbl !== null && typeof lbl !== 'string') {
    if (o === undefined) o = lbl
    lbl = undefined
  }
  const opt = o || {}
  if (opt.strict === true) assertNoSecrets(value, lbl)
  const masked = maskValue(value)
  assertNoSecrets(masked, lbl) // 两种姿态都保留：防掩码器漏检
  const lossless = toLossless(masked)
  assertLossless(lossless, lbl)
  return lossless
}
