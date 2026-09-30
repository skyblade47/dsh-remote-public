// writing-studio · C11（2026-09-29 additive）：多端文档同步的**纯校验/决策逻辑**。
//
// 与 `draft-save-core.js` 同口径：**零宿主依赖、零副作用、纯函数** ⇒ 可本地 `node --test` 真跑；
// `lib/index.js` 只做「读参数 → 调本模块 → 读写盘 → 返回」的薄接线。
//
// 契约权威：docs/superpowers/plans/2026-09-29-multidevice-doc-sync-design.md §4
//   GET  /writing-studio/api/draft-list     列远端草稿（元数据，无正文）+ 墓碑
//   GET  /writing-studio/api/draft-read     按 relPath 读回正文（404 = 远端没有，**不是**"未知"）
//   POST /writing-studio/api/draft-delete   **软删**：搬进 `.deleted/` + 写墓碑（**永不真删**）
//
// 🔴 三条设计要点（都靠"`.` 开头"这一条既有规则兜住）：
//   1. 回收站放 `写作训练/草稿/.deleted/`、墓碑放 `写作训练/草稿/.tombstones.json`；
//      既有 `listDraftRelPaths` 会**跳过 `.` 开头的条目**（index.js:588）⇒ 两者对既有
//      `collectDrafts` / `draftCount` / `training.drafts` **零污染**，且**不改任何既有函数**。
//   2. 软删是 **rename 搬家**，不是删除 ⇒ 任何时刻稿件都还在盘上。
//   3. 墓碑只增不减、**不做 GC**（宁多留，不可误判"没删过"）。

import { DRAFT_SAVE_PREFIX, versionOf } from './draft-save-core.js'

/** 草稿根（工作区相对）。与服务端 draft-save 的白名单前缀、客户端 `send.js` 的 `DRAFT_ROOT` **三处必须一致**。 */
export const DRAFT_ROOT = DRAFT_SAVE_PREFIX

/** 回收站目录名（`.` 开头 ⇒ 既有草稿列举天然看不见它） */
export const TRASH_DIR_NAME = '.deleted'

/** 墓碑文件名（`.` 开头 + 非 `.md` ⇒ 同样看不见） */
export const TOMBSTONE_FILE_NAME = '.tombstones.json'

/** 墓碑文件（工作区相对） */
export const TOMBSTONE_REL = DRAFT_ROOT + TOMBSTONE_FILE_NAME

// ── 路径换算 ──────────────────────────────────────────────────────────────

/**
 * 工作区相对路径 → **草稿根内**的相对路径（相对 `写作训练/草稿/`）。
 * @param {unknown} wsRel
 * @returns {string|null} 不在草稿根下 ⇒ `null`
 */
export function innerRelOf(wsRel) {
  const s = String(wsRel === undefined || wsRel === null ? '' : wsRel)
  if (s.indexOf(DRAFT_ROOT) !== 0) return null
  const rest = s.slice(DRAFT_ROOT.length)
  return rest ? rest : null
}

/**
 * 草稿根内的相对路径 → 工作区相对路径。
 * @param {unknown} inner
 * @returns {string|null}
 */
export function wsRelOf(inner) {
  const s = String(inner === undefined || inner === null ? '' : inner)
  if (!s || s.charAt(0) === '/') return null
  return DRAFT_ROOT + s
}

/**
 * 路径里有没有 **`.` 开头的段**？
 * 🔴 这是把客户端请求挡在回收站/墓碑之外的**唯一一道闸** —— `validateRelPath` 只拒 `.` 与 `..`
 * 这两个**整段相等**的，`.deleted` / `.tombstones.json` 是**放行的**。
 * @param {unknown} inner
 * @returns {boolean} 空串 / 含点段 ⇒ `true`（fail-closed）
 */
export function hasDotSegment(inner) {
  const s = String(inner === undefined || inner === null ? '' : inner)
  if (!s) return true
  const segs = s.split('/')
  for (let i = 0; i < segs.length; i++) if (segs[i].charAt(0) === '.') return true
  return false
}

/** 软删的**回收站目标**（草稿根内相对路径）：`.deleted/<原相对路径>` */
export function trashInnerRelOf(inner) {
  return TRASH_DIR_NAME + '/' + String(inner === undefined || inner === null ? '' : inner)
}

// ── 墓碑 ──────────────────────────────────────────────────────────────────

/**
 * 宽容归一化：坏的/缺的 ⇒ 空墓碑（不抛）。**归一化不丢信息**，只丢弃形状不对的条目。
 * @param {unknown} raw
 * @returns {{version:1, items:object}} items = `{ '<工作区相对 relPath>': {deletedAt, deletedBy, lastVersion} }`
 */
export function normalizeTombstones(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const src = (o.items && typeof o.items === 'object' && !Array.isArray(o.items)) ? o.items : {}
  const items = {}
  for (const k of Object.keys(src)) {
    const v = src[k]
    if (!k || !v || typeof v !== 'object' || Array.isArray(v)) continue
    items[k] = {
      deletedAt: typeof v.deletedAt === 'string' ? v.deletedAt : '',
      deletedBy: typeof v.deletedBy === 'string' ? v.deletedBy : '',
      lastVersion: typeof v.lastVersion === 'string' ? v.lastVersion : '',
    }
  }
  return { version: 1, items: items }
}

/**
 * 写入/覆盖一条墓碑。**纯函数**（返回新对象，不改入参）。
 * @param {unknown} raw 现有墓碑
 * @param {string} wsRel 工作区相对 relPath
 * @param {{deletedAt?:string, deletedBy?:string, lastVersion?:string}} info
 */
export function putTombstone(raw, wsRel, info) {
  const base = normalizeTombstones(raw)
  const key = String(wsRel === undefined || wsRel === null ? '' : wsRel)
  if (!key) return base
  const i = info || {}
  const items = {}
  for (const k of Object.keys(base.items)) items[k] = base.items[k]
  items[key] = {
    deletedAt: typeof i.deletedAt === 'string' && i.deletedAt ? i.deletedAt : new Date().toISOString(),
    deletedBy: typeof i.deletedBy === 'string' ? i.deletedBy : '',
    lastVersion: typeof i.lastVersion === 'string' ? i.lastVersion : '',
  }
  return { version: 1, items: items }
}

/** 取某条的墓碑（没有 ⇒ `null`） */
export function getTombstone(raw, wsRel) {
  const base = normalizeTombstones(raw)
  const hit = base.items[String(wsRel === undefined || wsRel === null ? '' : wsRel)]
  return hit || null
}

/**
 * 给 `draft-list` 用的墓碑数组（稳定排序，便于客户端 diff 与人工比对）。
 * @param {unknown} raw
 * @returns {Array<{relPath:string, deletedAt:string, deletedBy:string, lastVersion:string}>}
 */
export function tombstoneList(raw) {
  const base = normalizeTombstones(raw)
  return Object.keys(base.items).sort().map(function (k) {
    const t = base.items[k]
    return { relPath: k, deletedAt: t.deletedAt, deletedBy: t.deletedBy, lastVersion: t.lastVersion }
  })
}

// ── 软删决策 ──────────────────────────────────────────────────────────────

/**
 * 「软删」的决策（不改盘，只判该不该动）。
 * - 不存在 + 有墓碑 ⇒ `already`（幂等：重放同一个删除请求返回 200）
 * - 不存在 + 无墓碑 ⇒ `notfound`（404）
 * - 存在 + 给了 `baseVersion` 且与当前不符 ⇒ `conflict`（409，**拒绝删除**）
 * - 其余 ⇒ `delete`
 * @param {{exists?:boolean, tombstoned?:boolean, baseVersion?:unknown, currentVersion?:unknown}} input
 * @returns {{action:'delete'|'already'} | {action:'notfound'} | {action:'conflict', code:'VERSION_CONFLICT', message:string}}
 */
export function decideDelete(input) {
  const o = input || {}
  const exists = o.exists === true
  const tombstoned = o.tombstoned === true
  const baseVersion = (o.baseVersion === undefined || o.baseVersion === null) ? '' : String(o.baseVersion)
  const currentVersion = (o.currentVersion === undefined || o.currentVersion === null) ? '' : String(o.currentVersion)
  if (!exists) {
    return tombstoned ? { action: 'already' } : { action: 'notfound' }
  }
  if (baseVersion && baseVersion !== currentVersion) {
    return { action: 'conflict', code: 'VERSION_CONFLICT', message: '版本不符（baseVersion 与当前文件不一致），拒绝删除' }
  }
  return { action: 'delete' }
}

// ── 列举条目 ──────────────────────────────────────────────────────────────

/** 正文的 UTF-8 字节数（与 `draft-save` 的大小闸**同一口径**：按字节，不按字符） */
export function byteLength(content) {
  const c = String(content === undefined || content === null ? '' : content)
  return Buffer.byteLength(c, 'utf8')
}

/** 正文字数（与 `draft-save` 响应里的 `words` **同一口径**：去空白后计数） */
export function wordCount(content) {
  return String(content === undefined || content === null ? '' : content).replace(/\s+/g, '').length
}

/**
 * 一条 `draft-list` 条目。**不回正文**（列表要轻）。
 * @param {string} wsRel 工作区相对 relPath
 * @param {unknown} content
 * @param {unknown} mtime 毫秒时间戳 / ISO 串（拿不到就传 null）
 */
export function buildListItem(wsRel, content, mtime) {
  const c = String(content === undefined || content === null ? '' : content)
  return {
    relPath: String(wsRel === undefined || wsRel === null ? '' : wsRel),
    version: versionOf(c),
    bytes: byteLength(c),
    mtime: isoOf(mtime),
  }
}

/**
 * 时间 → ISO 串（拿不到/非法 ⇒ `null`）。允许传毫秒数、ISO 串或 `Date`。
 * ⚠️ 传字符串时会**过一遍解析**：不是合法时间就回 `null`（不原样透传，免得把垃圾写进列表）。
 * @param {unknown} v
 * @returns {string|null}
 */
export function isoOf(v) {
  if (v === undefined || v === null || v === '') return null
  const d = (v instanceof Date) ? v : new Date(typeof v === 'string' ? v : Number(v))
  const t = d.getTime()
  return isFinite(t) ? d.toISOString() : null
}
