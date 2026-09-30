// U-45 / W-B：`文档索引.json` 的纯逻辑（upsert / 三方对照 / updatedAt 刷新）。
//
// 与 relations-core.js / insp-retire-core.js 同法：**零 import、零副作用、纯函数** ⇒ 本地 `node --test` 真跑；
// lib/index.js 只做「读盘 → 调本模块 → 写盘 → 回 JSON」的薄接线。
//
// 🔴 红线（设计 §3.2 写死，本批唯一风险点）：
//   ① `rebuild` **只**补新增候选 / 只报缺失 / 只重算 `updatedAt`；
//   ② 已填的 `work`/`type`/`tags`/`zone`/`links`/`status` **绝不覆盖**（哪怕推导结果不同）；
//   ③ `missingOnDisk` **绝不自动删**（归档/删除只能由人/agent 决定）；
//   ④ 新增候选**默认只报不建**（`createMissing` 显式开启才建）。

// ============================== 常量 ==============================

/** 索引条目字段（附录 C 的十个，`path` 同时是主键）。 */
export const INDEX_ENTRY_FIELDS = ['path', 'zone', 'type', 'work', 'title', 'tags', 'links', 'status', 'owner', 'updatedAt']

/** 新建条目的默认值：**推导不出的留空**（设计 §3.2）。 */
export function entryDefaults(now) {
  return {
    path: '', zone: '', type: '', work: '', title: '',
    tags: [], links: [], status: '活文档', owner: '创作教练',
    updatedAt: String(now || '')
  }
}

/** 列举时跳过的目录名（点开头另判）。 */
export const INDEX_SKIP_DIRS = ['_backup', 'node_modules']

/** 列举最大深度（对齐 `listDraftPathsDeep` 的 DRAFT_LIST_MAX_DEPTH）。 */
export const INDEX_MAX_DEPTH = 4

/** 本批动作名真源（404 的 actions 与分支判定共用，避免漂移）。 */
export const INDEX_ACTIONS = ['indexUpsert', 'indexRebuild']

// ============================== path 归一与列举规则 ==============================

/**
 * 索引 `path` 归一：必须是非空、**根内相对**、不含 `..`、不以 `/` 开头、不越出 `写作训练/`。
 * 允许以 `/` 结尾（目录级条目，excluded 里用它）。
 * @param {unknown} v
 * @returns {{ok:true, path:string} | {ok:false, error:string}}
 */
export function normalizeIndexPath(v) {
  const raw = (v === undefined || v === null) ? '' : String(v).trim()
  if (!raw) return { ok: false, error: '缺少 path' }
  const p = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (p.charAt(0) === '/') return { ok: false, error: 'path 必须是根内相对路径（不得以 / 开头）: ' + raw }
  if (/^[A-Za-z]:/.test(p)) return { ok: false, error: 'path 不得是绝对路径: ' + raw }
  if (p.split('/').indexOf('..') >= 0) return { ok: false, error: 'path 不得包含 ..: ' + raw }
  if (p.indexOf('写作训练/') === 0) return { ok: false, error: 'path 应相对 写作训练/（不要带根名）: ' + raw }
  const isDir = p.charAt(p.length - 1) === '/'
  const segs = p.replace(/\/$/, '').split('/').filter(Boolean)
  if (!segs.length) return { ok: false, error: 'path 为空: ' + raw }
  return { ok: true, path: segs.join('/') + (isDir ? '/' : '') }
}

/** 目录/文件名是否应跳过列举：点开头 或 含 `.bak`。 */
export function shouldSkipName(name) {
  const n = String(name || '')
  if (!n) return true
  if (n.charAt(0) === '.') return true
  if (INDEX_SKIP_DIRS.indexOf(n) >= 0) return true
  if (n.indexOf('.bak') >= 0) return true
  return false
}

/** 某相对路径是否被"池子"覆盖（池中项以 `/` 结尾时为其下全部）。 */
export function coveredBy(rel, pool) {
  const list = Array.isArray(pool) ? pool : []
  if (list.indexOf(rel) >= 0) return true
  for (let i = 0; i < list.length; i++) {
    const q = String(list[i] || '')
    if (q.charAt(q.length - 1) === '/' && rel.indexOf(q) === 0) return true
  }
  return false
}

/** 池中是否有任意项**落在**该顶层目录下（含目录级 `top/` 与裸 `top`）——反向于 coveredBy。 */
export function mentionsTop(pool, top) {
  const list = Array.isArray(pool) ? pool : []
  const t = String(top || '')
  if (!t) return false
  const pre = t + '/'
  for (let i = 0; i < list.length; i++) {
    const p = String(list[i] || '')
    if (p === t || p.indexOf(pre) === 0) return true
  }
  return false
}

/** 从 entries 反推"需扫的顶层目录"（rebuild 只在这范围内发现新增候选 ⇒ 天然排除 日志/ 等基础设施）。 */
export function scanRootsFromEntries(entries) {
  const set = {}
  const out = []
  const list = Array.isArray(entries) ? entries : []
  for (let i = 0; i < list.length; i++) {
    const p = String((list[i] && list[i].path) || '')
    const top = p.split('/')[0]
    if (!top || top === p) continue          // 跳过根级散件（本就不登记）
    if (top.charAt(0) === '.') continue
    if (!set[top]) { set[top] = 1; out.push(top) }
  }
  return out.sort()
}

// ============================== upsert ==============================

/**
 * 按 `path` **增或改**一条 entry（不改入参）。
 *  - 已存在 ⇒ **只覆盖 patch 里显式出现的字段**（其余一字不动；`path` 本身不可改）；
 *  - 不存在 ⇒ 新建，未给的字段取 `entryDefaults()`（**推导不出的留空**）。
 * @param {unknown} entries
 * @param {object} patch
 * @param {string} [now]
 * @returns {{ok:true, entries:object[], created:boolean, path:string} | {ok:false, error:string}}
 */
export function upsertEntry(entries, patch, now) {
  const src = Array.isArray(entries) ? entries : []
  const p = (patch && typeof patch === 'object') ? patch : {}
  const nr = normalizeIndexPath(p.path)
  if (!nr.ok) return { ok: false, error: nr.error }
  const path = nr.path
  const at = String(now || new Date().toISOString())
  const next = []
  let created = true
  for (let i = 0; i < src.length; i++) {
    const e = src[i]
    if (e && typeof e === 'object' && String(e.path || '') === path) {
      created = false
      const merged = Object.assign({}, e)
      for (const k of INDEX_ENTRY_FIELDS) {
        if (k === 'path') continue
        if (p[k] !== undefined) merged[k] = p[k]
      }
      merged.path = path
      merged.updatedAt = at
      next.push(merged)
    } else {
      next.push(e)
    }
  }
  if (created) {
    const fresh = entryDefaults(at)
    for (const k of INDEX_ENTRY_FIELDS) {
      if (k === 'path') continue
      if (p[k] !== undefined) fresh[k] = p[k]
    }
    fresh.path = path
    next.push(fresh)
  }
  return { ok: true, entries: next, created: created, path: path }
}

// ============================== 三方对照（只报不改） ==============================

/**
 * 盘上清单 + 现有 entries/excluded ⇒ 四张清单（**全部只报不改**）。
 * @param {{diskFiles?:string[], entries?:object[], excluded?:object[], existsMap?:object, topLevelDirs?:string[]}} input
 *   - `diskFiles`：在 `scanRootsFromEntries()` 限定范围内列举到的文件（已过滤跳过项）
 *   - `existsMap`：`{ [path]: boolean }` —— 由装配层用 stat 直判（**覆盖点开头目录**，不依赖列举）
 *   - `topLevelDirs`：`写作训练/` 下实际存在的顶层目录（用于发现**未被索引覆盖的新顶层目录**）
 *   - `excludedTopLevel`：**已登记**"已知且有意不索引"的顶层目录（己 · 2026-09-29）⇒ `newTopLevelDirs` 不再报它们
 * @returns {{newCandidates:string[], missingOnDisk:string[], excludedGone:string[], newTopLevelDirs:string[], pathDrift:object[]}}
 */
export function diffIndex(input) {
  const inp = input || {}
  const disk = Array.isArray(inp.diskFiles) ? inp.diskFiles : []
  const ent = Array.isArray(inp.entries) ? inp.entries : []
  const exc = Array.isArray(inp.excluded) ? inp.excluded : []
  const existsMap = (inp.existsMap && typeof inp.existsMap === 'object') ? inp.existsMap : {}
  const tops = Array.isArray(inp.topLevelDirs) ? inp.topLevelDirs : []
  // 己（2026-09-29）：**已登记**的顶层目录（已知且有意不索引，如 日志/邮件桥/prompt-router/skills）⇒ 不再当"新目录"报
  const excTop = Array.isArray(inp.excludedTopLevel) ? inp.excludedTopLevel.map(function (t) { return String(t || '') }) : []

  const entPaths = ent.map(function (e) { return String((e && e.path) || '') }).filter(Boolean)
  const excPaths = exc.map(function (e) { return String((e && e.path) || '') }).filter(Boolean)
  const diskSet = {}
  for (let i = 0; i < disk.length; i++) diskSet[disk[i]] = 1

  // ① 盘上有、entries 与 excluded 都没有（**新增候选**）
  const newCandidates = []
  for (let i = 0; i < disk.length; i++) {
    const p = disk[i]
    if (coveredBy(p, entPaths) || coveredBy(p, excPaths)) continue
    newCandidates.push(p)
  }
  newCandidates.sort()

  // ② entries 有、盘上无（**绝不自动删**；existsMap 优先，缺项退回 diskFiles 口径）
  const missingOnDisk = []
  for (let i = 0; i < entPaths.length; i++) {
    const p = entPaths[i]
    const known = Object.prototype.hasOwnProperty.call(existsMap, p)
    const alive = known ? !!existsMap[p] : (!!diskSet[p] || coveredBy(p, excPaths))
    if (!alive) missingOnDisk.push(p)
  }
  missingOnDisk.sort()

  // ③ excluded 有（文件级）、盘上无
  const excludedGone = []
  for (let i = 0; i < excPaths.length; i++) {
    const p = excPaths[i]
    if (p.charAt(p.length - 1) === '/') continue      // 目录级不判存在性
    if (existsMap[p] === false) excludedGone.push(p)
  }
  excludedGone.sort()

  // ④ 未被索引**提及**的顶层目录（只报；目录级 excluded 也算"提及"；**已登记**的不报）
  const newTopLevelDirs = tops
    .map(function (t) { return String(t || '') })
    .filter(function (t) { return t && t.charAt(0) !== '.' && INDEX_SKIP_DIRS.indexOf(t) < 0 })
    .filter(function (t) { return excTop.indexOf(t) < 0 })
    .filter(function (t) { return !mentionsTop(entPaths, t) && !mentionsTop(excPaths, t) })
    .sort()

  // ⑤ path 漂移：对**缺失**的 entry，若盘上别处有同名文件 ⇒ 疑似被移动（只报）
  const byBase = {}
  for (let i = 0; i < disk.length; i++) {
    const b = disk[i].split('/').pop()
    if (!byBase[b]) byBase[b] = []
    byBase[b].push(disk[i])
  }
  const pathDrift = []
  for (let i = 0; i < missingOnDisk.length; i++) {
    const p = missingOnDisk[i]
    const hit = (byBase[p.split('/').pop()] || []).filter(function (x) { return x !== p })
    if (hit.length) pathDrift.push({ path: p, sameNameAt: hit.sort() })
  }

  return {
    newCandidates: newCandidates,
    missingOnDisk: missingOnDisk,
    excludedGone: excludedGone,
    newTopLevelDirs: newTopLevelDirs,
    pathDrift: pathDrift
  }
}

// ============================== updatedAt 刷新（唯一允许重算的字段） ==============================

/**
 * 把 epoch 毫秒格式化成索引既有口径：`YYYY-MM-DDTHH:mm:ss+08:00`。
 * @param {number} ms
 * @param {number} [offsetMinutes] 默认 480（东八区）
 * @returns {string}
 */
export function formatMtime(ms, offsetMinutes) {
  const off = (typeof offsetMinutes === 'number') ? offsetMinutes : 480
  const t = new Date(Number(ms) + off * 60000)
  const p = function (n, w) { return String(n).padStart(w || 2, '0') }
  const sign = off >= 0 ? '+' : '-'
  const ao = Math.abs(off)
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) +
    'T' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds()) +
    sign + p(Math.floor(ao / 60)) + ':' + p(ao % 60)
}

/**
 * 按 mtime 刷新 `updatedAt`（**只动这一个字段**，不改入参）。
 * 只列**确有变化**的 path；mtime 缺失则跳过。
 * @param {unknown} entries
 * @param {object} mtimeMap `{ [path]: epochMs }`
 * @param {number} [offsetMinutes]
 * @returns {{entries:object[], changed:string[]}}
 */
export function refreshUpdatedAt(entries, mtimeMap, offsetMinutes) {
  const src = Array.isArray(entries) ? entries : []
  const map = (mtimeMap && typeof mtimeMap === 'object') ? mtimeMap : {}
  const changed = []
  const out = src.map(function (e) {
    if (!e || typeof e !== 'object') return e
    const p = String(e.path || '')
    const ms = map[p]
    if (typeof ms !== 'number' || !isFinite(ms)) return e
    const stamp = formatMtime(ms, offsetMinutes)
    if (String(e.updatedAt || '') === stamp) return e
    changed.push(p)
    return Object.assign({}, e, { updatedAt: stamp })
  })
  return { entries: out, changed: changed.sort() }
}

// ============================== 机械推导（仅 createMissing 时用；推不出留空） ==============================

/** 顶层目录 → zone 的**保守**映射（推不出 ⇒ 空串，进 needsJudgement）。 */
export const TOP_LEVEL_ZONE = {
  '草稿': 'Z1', '规划': 'Z2', '设定': 'Z3', '过程': 'Z4',
  '灵感库': 'Z5', '训练': 'Z6', '上传': 'Z7', '会话工作文档': 'Z9', '其他': '其他'
}

/** 固定文件名 → type 的**保守**映射（附录 B；推不出 ⇒ 空串）。 */
export const FIXED_NAME_TYPE = {
  '立项.md': '立项卡', '主题.md': '主题与母题', '结构.md': '故事结构', '节拍.md': '节拍表',
  '大纲.md': '大纲', '细纲.md': '细纲', '章节计划.md': '章节计划', '伏笔回收.md': '伏笔与回收清单',
  '视角时间线.md': '视角与时间排布', '世界观.md': '世界观与规则', '人物.md': '人物卡',
  '关系.md': '人物关系', '地理.md': '地理与场景', '势力.md': '势力与组织', '时间线.md': '时间线与大事记',
  '术语.md': '术语与称谓', '考据.md': '考据与参考', '批注.md': '批注与审稿意见',
  '修改记录.md': '修改记录与决策', '待办.md': '卡点与待办', '素材.md': '素材与采风',
  '训练计划.md': '训练计划', '技法速查.md': '技法速查手册', '起点自述.md': '起点自述'
}

/**
 * 机械推导新建条目的字段（**只推确定的**；推不出留空）。
 * @param {string} rel
 * @returns {{entry:object, unresolved:string[]}} unresolved 非空 ⇒ 调用方应把它列进 needsJudgement
 */
export function deriveEntry(rel) {
  const segs = String(rel || '').split('/').filter(Boolean)
  const top = segs[0] || ''
  const base = segs[segs.length - 1] || ''
  const e = entryDefaults('')
  e.path = segs.join('/')
  e.zone = TOP_LEVEL_ZONE[top] || ''
  e.type = FIXED_NAME_TYPE[base] || ''
  // 作品名：草稿/<作品>/… 取第二段（仅 Z1 口径；其余留空）
  if (top === '草稿' && segs.length >= 3) e.work = segs[1]
  if (top === '设定' && segs.length >= 3) e.work = segs[1]
  if (top === '规划' && segs.length >= 3) e.work = segs[1]
  if (top === '过程' && segs.length >= 3) e.work = segs[1]
  const unresolved = []
  if (!e.zone) unresolved.push('zone')
  if (!e.type) unresolved.push('type')
  if (!e.work && (top === '草稿' || top === '设定' || top === '规划' || top === '过程')) unresolved.push('work')
  return { entry: e, unresolved: unresolved }
}
