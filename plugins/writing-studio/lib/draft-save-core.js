// writing-studio · U-37（2026-09-27）：按相对路径保存草稿的**纯校验/决策逻辑**。
//
// 为什么单独成模块：lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'（本机不存在、无法 import），
// 其逻辑本地不可能真实运行。故把 draft-save 路由里**所有可判定的纯逻辑**收敛到这里 ——
// 零 import、零副作用、纯函数 ⇒ 可被本地 node --test 真跑；index.js 只做「读参数 → 调本模块 → 写盘 → 返回」的薄接线。
//
// 契约权威：docs/superpowers/plans/2026-09-27-writing-studio-draft-save-route-plan.md §2。

// 落点白名单前缀（相对工作区根）：只能写这一个子树（§2.2「落点白名单」）。
export const DRAFT_SAVE_PREFIX = '写作训练/草稿/'

// 单文件大小上限 2 MiB（§2.2「大小上限」；正文类稿件足够）。
export const SIZE_LIMIT = 2 * 1024 * 1024

// 控制字符（含 NUL 与 DEL）：路径里出现即拒。
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * 校验「相对工作区根」的草稿路径是否可写。
 * 白名单：必须命中 `写作训练/草稿/**.md`。fail-closed（宁拒绝不误写）。
 * 明确拒绝：非字符串/空、绝对路径（`/…`）、盘符（`C:…`）、含反斜杠 `\`（**不做静默转换**）、
 *           `..`/`.`/空段、控制字符、非 `.md` 后缀。
 * @param {unknown} relPath
 * @returns {{ok:true, rel:string} | {ok:false, code:'BAD_PATH', message:string}}
 */
export function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 必填且为非空字符串' }
  }
  const rel = relPath
  if (CONTROL_CHARS.test(rel)) {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 含控制字符，拒绝' }
  }
  // 分隔符一律 `/`：入参含 `\` 直接拒绝（§2.2 分隔符；不静默转换，避免把历史坏写法喂回去）
  if (rel.indexOf('\\') >= 0) {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 含反斜杠，只允许 `/`（拒绝，不做静默转换）' }
  }
  if (rel.charAt(0) === '/') {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 不允许绝对路径' }
  }
  if (/^[A-Za-z]:/.test(rel)) {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 不允许盘符' }
  }
  if (rel.indexOf(DRAFT_SAVE_PREFIX) !== 0) {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 越界：只允许写入 ' + DRAFT_SAVE_PREFIX + ' 下的 .md' }
  }
  const rest = rel.slice(DRAFT_SAVE_PREFIX.length)
  const segs = rest.split('/')
  for (const s of segs) {
    if (s === '') return { ok: false, code: 'BAD_PATH', message: 'relPath 含空路径段（多余的 `/`）' }
    if (s === '.' || s === '..') return { ok: false, code: 'BAD_PATH', message: 'relPath 不允许 `.` / `..` 路径段' }
  }
  if (!/\.md$/i.test(segs[segs.length - 1])) {
    return { ok: false, code: 'BAD_PATH', message: 'relPath 只允许 .md 后缀' }
  }
  return { ok: true, rel: rel }
}

/**
 * 「默认不覆盖」决策（§2.2「覆盖语义」）。
 * - 不存在 ⇒ create
 * - 存在 + force:true ⇒ overwrite
 * - 存在 + 给了 baseVersion 且与 currentVersion 相符 ⇒ overwrite（版本一致的覆盖；同内容即幂等）
 * - 存在 + 未给 baseVersion ⇒ conflict（VERSION_CONFLICT）
 * - 存在 + baseVersion 不匹配 ⇒ conflict（VERSION_CONFLICT）
 * @param {{exists?:boolean, baseVersion?:unknown, force?:boolean, currentVersion?:unknown}} input
 * @returns {{action:'create'|'overwrite'} | {action:'conflict', code:'VERSION_CONFLICT', message:string}}
 */
export function decideWrite(input) {
  const o = input || {}
  const exists = o.exists === true
  const force = o.force === true
  const baseVersion = (o.baseVersion === undefined || o.baseVersion === null) ? '' : String(o.baseVersion)
  const currentVersion = (o.currentVersion === undefined || o.currentVersion === null) ? '' : String(o.currentVersion)
  if (!exists) return { action: 'create' }
  if (force) return { action: 'overwrite' }
  if (!baseVersion) {
    return { action: 'conflict', code: 'VERSION_CONFLICT', message: '文件已存在：覆盖需提供 baseVersion，或显式 force:true' }
  }
  if (baseVersion !== currentVersion) {
    return { action: 'conflict', code: 'VERSION_CONFLICT', message: '版本不符（baseVersion 与当前文件不一致），拒绝覆盖' }
  }
  return { action: 'overwrite' }
}

/**
 * 大小闸（§2.2「大小上限」）：超出 2 MiB ⇒ 413 TOO_LARGE。
 * @param {unknown} bytes
 * @returns {{ok:true} | {ok:false, code:'TOO_LARGE', message:string}}
 */
export function checkSize(bytes) {
  const n = Number(bytes)
  if (!isFinite(n) || n < 0) {
    return { ok: false, code: 'TOO_LARGE', message: '字节数非法: ' + String(bytes) }
  }
  if (n > SIZE_LIMIT) {
    return { ok: false, code: 'TOO_LARGE', message: '正文超过上限（' + SIZE_LIMIT + ' 字节）' }
  }
  return { ok: true }
}

// —— 稳定内容版本串（纯 JS、零依赖）：同内容 ⇒ 同串，异内容 ⇒ 几乎必不同 ——
// 双 32-bit FNV-1a 车道（Math.imul，快且无 BigInt 开销）；第二车道混入长度，降低碰撞。
function fnv1a32(str, seed) {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 由内容算出稳定版本串（用于响应里的 `version` 与「同路径同内容 ⇒ 幂等」判定）。
 * @param {unknown} content
 * @returns {string}
 */
export function versionOf(content) {
  const s = String(content === undefined || content === null ? '' : content)
  const a = fnv1a32(s, 0x811c9dc5)
  const b = fnv1a32(s, (0x9e3779b9 ^ s.length) >>> 0)
  return 'v1-' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
