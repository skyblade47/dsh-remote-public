// U-44 / W-A·A1–A5：灵感退役（软删）与复原的**纯逻辑**。
//
// 为什么单独成模块：与 relations-core.js 同法 —— 本模块**零 import、零副作用、纯函数**，
// 可被本地 `node --test` 真跑；lib/index.js 只做「读盘 → 调本模块 → 写盘 → 回 JSON」的薄接线。
//
// 形状对齐来源：memory-system/lib/index.js 的 doRetire(:1197-1349) / doRestore(:1359-1400)
// 与 writing-studio 的 memArchiveList(:1013-1041)。逐条对照见
//   docs/superpowers/evidence/2026-09-29-window-w-a/A-0-shape-alignment.md
//
// 🔴 红线：
//   ① 退役条目**逐字节保留**（不转 md、不压缩）⇒ 复原后可与退役前逐字段对账；
//   ② 所有数组变换**不改入参**（返回新对象），与 deleteRelation 同款；
//   ③ `insp_list`/`insp_search` 的**默认视图不变**（退役条目仅在 includeRetired 时出现）。

// ============================== 常量：唯一真源 ==============================

/** 退役文件落点（根 写作训练 内相对）。 */
export const INSP_RETIRE_DIR_REL = '灵感库/灵感退役'
/** 退役清单（根 写作训练 内相对）。 */
export const INSP_RETIRE_MANIFEST_REL = '灵感库/退役清单.json'
/** 退役条目的状态词（写入清单行的快照与 history 的 to）。 */
export const INSP_RETIRE_STATUS = '已退役'
/** 清单版本。 */
export const INSP_MANIFEST_VERSION = 1

// ---- 灵感库 HTTP 动作真源 ----
// 404 响应的 `actions` 字段与分支判定**共用这一处**（同 relations-core 的 RELATIONS_ACTIONS），避免两处漂移。
export const INSP_HTTP_ACTIONS = ['list', 'search', 'create', 'update', 'toggleFixed', 'saveMeeting', 'category', 'overview', 'retire', 'restore', 'retiredList']

// ---- A2：`insp_update` 可编辑字段的**并集真源** ----
// 修掉的历史漂移：工具侧（index.js:2241）缺 `category`，HTTP 侧（:2386）有。
// 取并集 ⇒ 两侧同源，后续新增字段只改这一处。
export const INSP_EDITABLE_FIELDS = ['title', 'content', 'source', 'oneLiner', 'hook', 'settingsRef', 'status', 'category', 'annotations']

// ---- A3：分页与体积 ----
// 对齐 writing_coach_retrieve 的口径（默认 20 / 上限 50）。
export const INSP_LIST_DEFAULT_LIMIT = 20
export const INSP_LIST_MAX_LIMIT = 50

// ---- A5：世界观键（U-42）----
export const INSP_WORLDVIEW_PREFIX = '世界观:'

// ============================== A1：入参归一 ==============================

/**
 * 灵感条目 id 归一：必填、去首尾空白后非空。
 * 缺失 / null / 空串 / 全空白 / 不可表示值 ⇒ `{ok:false, error:'缺少 id'}`。
 * @param {unknown} v
 * @returns {{ok:true, id:string} | {ok:false, error:string}}
 */
export function normalizeInspIdArg(v) {
  const id = (v === undefined || v === null) ? '' : String(v).trim()
  if (!id) return { ok: false, error: '缺少 id' }
  return { ok: true, id: id }
}

/** 退役文件名（按 id 推出，无需存路径也能找到）。 */
export function retireFileName(id) {
  return String(id === undefined || id === null ? '' : id).trim() + '.json'
}

// ============================== A1：数组变换（不改入参） ==============================

/**
 * 从活跃条目数组里**摘出**指定 id（退役用）。
 * 找不到 ⇒ `{found:false, entry:null, rest: 入参副本}`，**不报错**（幂等）。
 * @param {unknown} entries
 * @param {string} id
 * @returns {{found:boolean, entry:object|null, rest:object[]}}
 */
export function extractEntry(entries, id) {
  const src = Array.isArray(entries) ? entries : []
  const key = String(id === undefined || id === null ? '' : id).trim()
  let hit = -1
  for (let i = 0; i < src.length; i++) {
    const e = src[i]
    if (e && typeof e === 'object' && String(e.id || '').trim() === key) { hit = i; break }
  }
  const rest = src.slice()
  if (hit < 0) return { found: false, entry: null, rest: rest }
  const entry = rest.splice(hit, 1)[0]
  return { found: true, entry: entry, rest: rest }
}

/**
 * 把条目**插回**活跃数组头部（复原用；与 insp_create 的 unshift 同位置口径）。
 * 同 id 已存在 ⇒ `{ok:false, conflict:true}`（对应 HTTP 409，**禁止覆盖**，对齐 memory doRestore:1375）。
 * @param {unknown} entries
 * @param {object} entry
 * @returns {{ok:true, entries:object[]} | {ok:false, conflict:boolean, error:string}}
 */
export function insertEntry(entries, entry) {
  const src = Array.isArray(entries) ? entries : []
  if (!entry || typeof entry !== 'object') return { ok: false, conflict: false, error: '条目非法' }
  const id = String(entry.id || '').trim()
  if (!id) return { ok: false, conflict: false, error: '条目缺少 id' }
  for (let i = 0; i < src.length; i++) {
    const e = src[i]
    if (e && typeof e === 'object' && String(e.id || '').trim() === id) {
      return { ok: false, conflict: true, error: '库中已存在同 id 条目：' + id + '（禁止覆盖）' }
    }
  }
  const next = [entry]
  for (let i = 0; i < src.length; i++) next.push(src[i])
  return { ok: true, entries: next }
}

// ============================== A1：退役清单 ==============================

/** 空清单。 */
export function emptyManifest() {
  return { version: INSP_MANIFEST_VERSION, rows: [], updatedAt: null }
}

/**
 * 清单归一：容错读（文件缺失/损坏/旧形状一律退回空清单，不抛）。
 * @param {unknown} raw
 * @returns {{version:number, rows:object[], updatedAt:string|null}}
 */
export function normalizeManifest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyManifest()
  const rows = Array.isArray(raw.rows) ? raw.rows.filter(function (r) { return r && typeof r === 'object' }) : []
  return {
    version: typeof raw.version === 'number' ? raw.version : INSP_MANIFEST_VERSION,
    rows: rows,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  }
}

/**
 * 构造一行退役记录。
 * 字段对齐 memory 清单条目（task_id→id / archived_at→退役时间 / path→路径），
 * `原路径` 记退役前所在文件（审计），`路径` 记退役后落点（对齐 memory 的 path）。
 * 🔴 `history` 放在**清单行**而非条目里 —— 退役文件必须与退役前**逐字节一致**，
 *    故动作留痕只能落在这里（等效于 memory 用 `archived_at`/`readCount` 承载审计）。
 * @param {object} entry
 * @param {{at?:string, reason?:string, fromRel?:string, dirRel?:string}} [opts]
 * @returns {object}
 */
export function buildRetireRow(entry, opts) {
  const o = opts || {}
  const e = (entry && typeof entry === 'object') ? entry : {}
  const id = String(e.id || '').trim()
  const at = String(o.at || new Date().toISOString())
  const fromRel = String(o.fromRel || '灵感库/灵感库.json')
  const dirRel = String(o.dirRel || INSP_RETIRE_DIR_REL)
  return {
    id: id,
    title: String(e.title || id),
    退役时间: at,
    原因: String(o.reason || '').trim(),
    原路径: fromRel,
    路径: dirRel + '/' + retireFileName(id),
    restored: false,
    restored_at: null,
    history: [{ at: at, by: '学员', field: 'status', from: String(e.status || ''), to: INSP_RETIRE_STATUS }]
  }
}

/** 按 id 找清单行（找不到 ⇒ null）。 */
export function findRetireRow(rows, id) {
  const src = Array.isArray(rows) ? rows : []
  const key = String(id === undefined || id === null ? '' : id).trim()
  for (let i = 0; i < src.length; i++) {
    const r = src[i]
    if (r && typeof r === 'object' && String(r.id || '').trim() === key) return r
  }
  return null
}

/**
 * 按 id **upsert** 清单行（不改入参）。
 * 已有同 id ⇒ 整行替换为新的 row（`restored` 随之复位 false —— 重新退役后不应再显示"已复原"）；
 * 无 ⇒ 追加到末尾。
 * @param {unknown} rows
 * @param {object} row
 * @returns {object[]}
 */
export function upsertRetireRow(rows, row) {
  const src = Array.isArray(rows) ? rows : []
  const r = (row && typeof row === 'object') ? row : {}
  const key = String(r.id || '').trim()
  const next = []
  let replaced = false
  for (let i = 0; i < src.length; i++) {
    const cur = src[i]
    if (cur && typeof cur === 'object' && String(cur.id || '').trim() === key) {
      next.push(r)
      replaced = true
    } else {
      next.push(cur)
    }
  }
  if (!replaced) next.push(r)
  return next
}

/**
 * 给某 id 的清单行打"已复原"标（不改入参）；行不存在 ⇒ 原样返回（不报错）。
 * 对齐 memory doRestore:1385-1388（行**保留**供审计）。
 * @param {unknown} rows
 * @param {string} id
 * @param {string} at
 * @returns {object[]}
 */
export function markRetireRowRestored(rows, id, at) {
  const src = Array.isArray(rows) ? rows : []
  const key = String(id === undefined || id === null ? '' : id).trim()
  const when = String(at || new Date().toISOString())
  return src.map(function (r) {
    if (!r || typeof r !== 'object' || String(r.id || '').trim() !== key) return r
    const copy = Object.assign({}, r)
    copy.restored = true
    copy.restored_at = when
    // 复原也留痕（`to` 取退役行的 `from`＝退役前的状态），与退役记录同数组成时间线
    const hist = Array.isArray(r.history) ? r.history : []
    const back = hist.length ? String(hist[0].from || '') : ''
    copy.history = hist.concat([{ at: when, by: '学员', field: 'status', from: INSP_RETIRE_STATUS, to: back }])
    return copy
  })
}

// ============================== A3：分页与体积 ==============================

/**
 * `limit` 归一：缺省/非法/小于 1 ⇒ 默认 20；超过上限 ⇒ 上限 50（向下取整）。
 * @param {unknown} v
 * @returns {number}
 */
export function resolveListLimit(v) {
  if (v === undefined || v === null || v === '') return INSP_LIST_DEFAULT_LIMIT
  const n = Number(v)
  if (!isFinite(n) || n < 1) return INSP_LIST_DEFAULT_LIMIT
  const i = Math.floor(n)
  return i > INSP_LIST_MAX_LIMIT ? INSP_LIST_MAX_LIMIT : i
}

/**
 * 去掉每条目的 `content`（不改入参；保持其余字段与字段顺序）。
 * 用于「默认不返回正文」以省 token —— 需要正文时调用方显式带 `includeContent:'true'`。
 * @param {unknown} entries
 * @returns {object[]}
 */
export function stripContent(entries) {
  const src = Array.isArray(entries) ? entries : []
  return src.map(function (e) {
    if (!e || typeof e !== 'object') return e
    const copy = Object.assign({}, e)
    delete copy.content
    return copy
  })
}

// ============================== A5：世界观键告警（不硬拒） ==============================

/** tags 归一：数组直用；字符串按逗号切。 */
export function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.filter(function (t) { return typeof t === 'string' }).map(function (t) { return t.trim() }).filter(Boolean)
  if (typeof tags === 'string') return tags.split(',').map(function (s) { return s.trim() }).filter(Boolean)
  return []
}

/** 取出 tags 里的世界观键（`世界观:` 开头），返回键值数组（去空白，保序）。 */
export function worldviewKeys(tags) {
  return normalizeTags(tags)
    .filter(function (t) { return t.indexOf(INSP_WORLDVIEW_PREFIX) === 0 })
    .map(function (t) { return t.slice(INSP_WORLDVIEW_PREFIX.length).trim() })
    .filter(Boolean)
}

/**
 * 世界观键告警（U-42 W1 口径：每条灵感必须带、且只带一个 `世界观:<键>`）。
 * 正常（恰好 1 个）⇒ null；缺失 / 多于一个 ⇒ 中文告警串（**软告警，不阻断入库**）。
 * @param {unknown} tags
 * @returns {string|null}
 */
export function worldviewWarn(tags) {
  const keys = worldviewKeys(tags)
  if (keys.length === 0) return '缺少世界观键（应带且只带一个 `世界观:<键>`，键不确定时先问，不要自造）'
  if (keys.length > 1) return '世界观键多于一个（' + keys.length + ' 个：' + keys.join('、') + '），应只保留一个'
  return null
}
