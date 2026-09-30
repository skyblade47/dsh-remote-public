// U-41 / P2（2026-09-29）：客户端「提交」的**纯逻辑**（零宿主依赖 ⇒ 本地 node --test 真跑）。
//
// 契约权威：docs/superpowers/plans/2026-09-29-client-zone-and-shared-progress-design.md
//   §2.1 区域划分 · §2.2 唯一跨界动作=提交 · §2.4 「已归档同名件」处置（**甲案**，2026-09-29 用户拍定）
//
// 🔴 红线：
//   ① 归档件**只读不动**（不删/不改/不移动）—— 新旧并留，关联只写在**新条目**上且**单向**；
//   ② 关联**幂等**（同一 `to` 的 `替代` 已存在则不再追加）；
//   ③ 提交落点恒为 `写作训练/草稿/<作品>/<文档>.md`；work/doc **不得含分隔符、不得点开头**（挡归档区等点目录）。
//
// 覆盖语义**复用** draft-save 的既有闸（`decideWrite`）：不另立第二套口径。

import { decideWrite, versionOf, SIZE_LIMIT } from './draft-save-core.js'

/** 客户端区（与 `写作训练/` 平级，**工作区相对**）。 */
export const CLIENT_ZONE_REL = '客户端区'
/** 客户端正文副本（提交的**源**）。 */
export const CLIENT_BODY_REL = '客户端区/正文'
/** 端间进度（每设备一份）。 */
export const CLIENT_PROGRESS_REL = '客户端区/进度'
/** 客户端侧回收站。 */
export const CLIENT_RECYCLE_REL = '客户端区/回收'
/** 提交记录（追加型 JSONL）。 */
export const CLIENT_LOG_REL = '客户端区/提交记录.jsonl'

/** 提交落点前缀（**工作区相对**）。 */
export const SUBMIT_PREFIX = '写作训练/草稿/'
/** 归档区前缀（**相对 写作训练**，与索引 path 同口径）。 */
export const ARCHIVE_PREFIX = '草稿/.archive/'
/** 归档件在索引 path 里的前缀（同 `ARCHIVE_PREFIX`，语义别名，便于阅读）。 */
export const INDEX_ARCHIVE_PREFIX = '草稿/.archive/'
/** 关联类型：新版指向被取代的归档件。 */
export const SUPERSEDE_KIND = '替代'

const BAD_CHARS = /[\\/]|[\u0000-\u001f\u007f]/

/**
 * 由 work/doc 归一提交目标。
 * doc 自动补 `.md`；work/doc 不得含 `/` `\` 或控制字符、不得为 `.`/`..`、**不得以点开头**。
 * @returns {{ok:true, work:string, doc:string, indexPath:string, wsRel:string, bodyWsRel:string}
 *          | {ok:false, code:string, message:string}}
 */
export function normalizeSubmitTarget(work, doc) {
  const w = String(work === undefined || work === null ? '' : work).trim()
  const dRaw = String(doc === undefined || doc === null ? '' : doc).trim()
  if (!w) return { ok: false, code: 'BAD_WORK', message: '缺少 work（作品名）' }
  if (!dRaw) return { ok: false, code: 'BAD_DOC', message: '缺少 doc（文档名）' }
  if (BAD_CHARS.test(w)) return { ok: false, code: 'BAD_WORK', message: 'work 不得含 / \\ 或控制字符' }
  if (BAD_CHARS.test(dRaw)) return { ok: false, code: 'BAD_DOC', message: 'doc 不得含 / \\ 或控制字符' }
  const d = /\.md$/i.test(dRaw) ? dRaw : (dRaw + '.md')
  if (w === '.' || w === '..' || d === '.' || d === '..') return { ok: false, code: 'BAD_PATH', message: 'work/doc 不得为 . 或 ..' }
  if (w.charAt(0) === '.' || d.charAt(0) === '.') {
    return { ok: false, code: 'BAD_PATH', message: 'work/doc 不得以点开头（归档区等点目录不接受提交）' }
  }
  if (w.length > 80 || d.length > 120) return { ok: false, code: 'BAD_PATH', message: 'work/doc 过长' }
  return {
    ok: true,
    work: w,
    doc: d,
    indexPath: '草稿/' + w + '/' + d,                       // 相对 写作训练（索引 path 口径）
    wsRel: SUBMIT_PREFIX + w + '/' + d,                     // 工作区相对（落点）
    bodyWsRel: CLIENT_BODY_REL + '/' + w + '/' + d          // 工作区相对（源）
  }
}

/**
 * 在归档清单里找**同名**（basename 相等、大小写不敏感）的 `.md`。
 * 只认 `草稿/.archive/` 前缀 —— 其它位置的同名不算。
 * @param {unknown} archivePaths 索引里 `status=归档` 或 `.archive/` 下的 path 列表（**相对 写作训练**）
 * @param {string} docFile
 * @returns {string[]} 命中的归档 path（已排序；可能多份）
 */
export function findArchivedSiblings(archivePaths, docFile) {
  const want = String(docFile === undefined || docFile === null ? '' : docFile).toLowerCase()
  const list = Array.isArray(archivePaths) ? archivePaths : []
  if (!want) return []
  return list.filter(function (p) {
    const s = String(p === undefined || p === null ? '' : p)
    if (s.indexOf(ARCHIVE_PREFIX) !== 0) return false
    if (!/\.md$/i.test(s)) return false
    return s.split('/').pop().toLowerCase() === want
  }).sort()
}

/** 造一条「替代」关联（新版 → 归档件）。 */
export function supersedeLink(archivePath, dateStr) {
  return {
    to: 'doc:' + String(archivePath === undefined || archivePath === null ? '' : archivePath),
    kind: SUPERSEDE_KIND,
    note: '提交于 ' + String(dateStr === undefined || dateStr === null ? '' : dateStr) + '，取代该归档件'
  }
}

/**
 * 把 `.archive` 内的相对段拼成**索引口径**的归档 path。
 * 🔴 专门修一个实测 bug：调用方按 `ARCHIVE_PREFIX + rel + '/' + name` 拼，当 `rel` 为空串时会产出
 *    `草稿/.archive//x.md`（**双斜杠**）⇒ 与索引里的 path 对不上。此处统一折叠空段。
 * @param {unknown} rel
 * @returns {string} 形如 `草稿/.archive/` 或 `草稿/.archive/a/b.md`
 */
export function archivePathOf(rel) {
  const segs = String(rel === undefined || rel === null ? '' : rel).split('/').filter(function (s) { return s !== '' })
  return ARCHIVE_PREFIX + segs.join('/')
}

/**
 * 往 links 里**幂等**追加「替代」关联（不改入参）。
 * 已存在指向同一 `to` 的 `替代` ⇒ 跳过。
 * @returns {{links:object[], added:object[]}}
 */
export function withSupersede(links, archivePaths, dateStr) {
  const next = Array.isArray(links) ? links.slice() : []
  const seen = {}
  for (let i = 0; i < next.length; i++) {
    const l = next[i]
    if (l && typeof l === 'object' && l.kind === SUPERSEDE_KIND && typeof l.to === 'string') seen[l.to] = 1
  }
  const added = []
  const list = Array.isArray(archivePaths) ? archivePaths : []
  for (let i = 0; i < list.length; i++) {
    const to = 'doc:' + list[i]
    if (seen[to]) continue
    const lk = supersedeLink(list[i], dateStr)
    next.push(lk)
    seen[to] = 1
    added.push(lk)
  }
  return { links: next, added: added }
}

/** 关联类型：**谁把件送进来的**（客户端提交）。 */
export const ORIGIN_KIND = '来源'

/**
 * 甲（2026-09-29）：往 links 里**幂等**追加一条「来源」。
 * 用途：提交来的件在索引里**看得出是客户端给的** ⇒ 归档时不再"不知道该归谁"（U-41 §1 点名的现状债）。
 * 🔴 **不动十字段**：`links` 本就是自由数组 ⇒ 零规范改动、零字段新增；与 §2.4 的「替代」关联**共存**
 *    （语义不同：`来源`＝谁给的；`替代`＝取代了谁）。
 * @param {unknown} links
 * @param {string} bodyWsRel 源件的**工作区相对**路径（如 `客户端区/正文/<作品>/<文档>.md`）
 * @param {string} dateStr
 * @param {unknown} deviceId
 * @returns {{links:object[], added:object|null}} added=null 表示幂等命中（未追加）
 */
export function withOriginSource(links, bodyWsRel, dateStr, deviceId) {
  const next = Array.isArray(links) ? links.slice() : []
  const to = 'client:' + String(bodyWsRel === undefined || bodyWsRel === null ? '' : bodyWsRel)
  for (let i = 0; i < next.length; i++) {
    const l = next[i]
    if (l && typeof l === 'object' && l.kind === ORIGIN_KIND && l.to === to) return { links: next, added: null }
  }
  const dev = String(deviceId === undefined || deviceId === null ? '' : deviceId).trim()
  const lk = {
    to: to,
    kind: ORIGIN_KIND,
    note: '客户端提交于 ' + String(dateStr === undefined || dateStr === null ? '' : dateStr) + (dev ? '；设备 ' + dev : '')
  }
  next.push(lk)
  return { links: next, added: lk }
}

/** 提交记录的一行（JSONL）。 */
export function buildSubmitLogRow(input) {
  const o = input || {}
  return {
    ts: String(o.ts === undefined || o.ts === null ? '' : o.ts),
    deviceId: String(o.deviceId === undefined || o.deviceId === null ? '' : o.deviceId),
    work: String(o.work === undefined || o.work === null ? '' : o.work),
    doc: String(o.doc === undefined || o.doc === null ? '' : o.doc),
    path: String(o.path === undefined || o.path === null ? '' : o.path),
    from: String(o.from === undefined || o.from === null ? '' : o.from),
    version: String(o.version === undefined || o.version === null ? '' : o.version),
    action: String(o.action === undefined || o.action === null ? '' : o.action),
    supersedes: Array.isArray(o.supersedes) ? o.supersedes.slice() : []
  }
}

/** 供装配层复用的覆盖决策（**不另立口径**，直接转发 draft-save 的既有闸）。 */
export function decideSubmitWrite(input) { return decideWrite(input) }
/** 供装配层复用的版本串（内容哈希）。 */
export function submitVersion(content) { return versionOf(content) }
/** 供装配层复用的体积上限。 */
export const SUBMIT_SIZE_LIMIT = SIZE_LIMIT
