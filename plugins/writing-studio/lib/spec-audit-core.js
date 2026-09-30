// U-41 / P5（2026-09-29）：**规范体检**的纯逻辑（零 import、零 IO、零副作用 ⇒ 本地 node --test 真跑）。
//
// 契约：docs/superpowers/evidence/2026-09-29-window-u41-p5/DESIGN.md §乙（含 §丙）
// 🔴 为什么需要它：本日的规范违反**全是人工对账发现的**（settingsRef 失效 12 条、索引缺 type、混装 7 件…）
//    ⇒ 把"人对账"变成"一条命令"。
// 🔴 边界（写死）：本模块与调用方都**只读**；灵感库 owner 是 taskkit ⇒ 这里只做**只读快照**判定。

/** 世界观键前缀（U-42）。 */
export const WORLDVIEW_PREFIX = '世界观:'

/** 别名残留表（U-42 W7 归一后不应再出现）。 */
export const STALE_ALIASES = ['崩铁', '原創', '2077']

/** 需要 `work` 的区（Z1–Z4）；其余区（Z5/Z7/Z9/其他…）可以空 ⇒ 不报，避免噪音。 */
export const ZONES_NEEDING_WORK = ['Z1', 'Z2', 'Z3', 'Z4']

// ============================== ① 索引组 ==============================

/**
 * 索引体检（只看调用方喂进来的数据，不做 IO）。
 * @param {{entries?:object[], newCandidates?:string[], missingOnDisk?:string[], pathDrift?:object[],
 *          newTopLevelDirs?:string[], excludedGone?:string[]}} input
 */
export function auditIndex(input) {
  const i = input || {}
  const es = Array.isArray(i.entries) ? i.entries : []
  const noType = []
  const noZone = []
  const noWork = []
  let archived = 0
  for (let k = 0; k < es.length; k++) {
    const e = es[k] || {}
    const p = String(e.path || '')
    // 🔴 归档件是**历史快照**（用户已拍「老件不搬」）⇒ **不套现行规范**。
    //    本批实测：不跳的话 `noWork` 会刷出 64 条（全是 `.archive/_版本前照片/**` 这类历史件），
    //    把真正的问题淹没 —— 体检的价值在于"能一眼看到真问题"。
    if (String(e.status || '') === '归档' || p.indexOf('草稿/.archive/') === 0) { archived++; continue }
    const zone = String(e.zone || '')
    if (!String(e.type || '').trim()) noType.push(p)
    if (!zone.trim()) noZone.push(p)
    // 🔴 `work` 的判据要**排开非作品目录**：`<区>/_<练习|模板|演练>/<文档>.md` 的第二段是**下划线开头**的
    //    练习/模板类目录 —— 本日实测 7 条 `noWork` **全部属于此类**（`规划/_训练习作`、`设定/_训练习作`、
    //    `过程/_模板`、`过程/_训练习作`）⇒ 它们**不属于任何作品**，`work` 为空是**对的**。
    //    （若跑去"把 work 填上"，等于给练习件硬编一个作品名 —— 那才是污染。）
    const segs = p.split('/')
    const nonWorkDir = segs.length >= 2 && String(segs[1]).charAt(0) === '_'
    if (!nonWorkDir && ZONES_NEEDING_WORK.indexOf(zone) >= 0 && !String(e.work || '').trim()) noWork.push(p)
  }
  return {
    total: es.length,
    archivedSkipped: archived,
    noType: noType.sort(),
    noZone: noZone.sort(),
    noWork: noWork.sort(),
    newCandidates: (Array.isArray(i.newCandidates) ? i.newCandidates : []).slice().sort(),
    missingOnDisk: (Array.isArray(i.missingOnDisk) ? i.missingOnDisk : []).slice().sort(),
    pathDrift: Array.isArray(i.pathDrift) ? i.pathDrift : [],
    newTopLevelDirs: (Array.isArray(i.newTopLevelDirs) ? i.newTopLevelDirs : []).slice().sort(),
    excludedGone: (Array.isArray(i.excludedGone) ? i.excludedGone : []).slice().sort()
  }
}

// ============================== ② 灵感库组（只读快照） ==============================

/** 灵感库体检：缺/多世界观键 + 别名残留。 */
export function auditInsp(input) {
  const es = Array.isArray((input || {}).entries) ? input.entries : []
  const missKey = []
  const multiKey = []
  const staleAlias = []
  for (let k = 0; k < es.length; k++) {
    const e = es[k] || {}
    const id = String(e.id || '')
    const tags = Array.isArray(e.tags) ? e.tags : []
    const wv = tags.filter(function (t) { return String(t).indexOf(WORLDVIEW_PREFIX) === 0 })
    if (wv.length === 0) missKey.push(id)
    else if (wv.length > 1) multiKey.push(id)
    for (let j = 0; j < tags.length; j++) {
      // 键值可能带分层（如 `世界观:同人/崩铁`）⇒ 别名要连**末段**一起比，
      // 否则"崩铁"藏在 `同人/崩铁` 里就漏了（本批实测到的漏报）。
      const bare = String(tags[j]).replace(/^[^:]+:/, '').trim()
      const seg = bare.split('/').pop().trim()
      if (STALE_ALIASES.indexOf(bare) >= 0 || STALE_ALIASES.indexOf(seg) >= 0) {
        staleAlias.push({ id: id, tag: String(tags[j]) })
      }
    }
  }
  return { total: es.length, missKey: missKey.sort(), multiKey: multiKey.sort(), staleAlias: staleAlias }
}

/**
 * `settingsRef` 存在性（**保守**：只判"看起来像 `写作训练/` 内相对路径"的，
 * 其余（自由文本/URL/纯名字）**一律跳过** ⇒ 不误报）。
 * @param {object[]} entries 灵感条目
 * @param {object} existsMap `{ [ref]: boolean }` —— 由装配层对**候选项**逐个 stat 得出
 */
export function auditSettingsRef(entries, existsMap) {
  const es = Array.isArray(entries) ? entries : []
  const map = (existsMap && typeof existsMap === 'object') ? existsMap : {}
  const broken = []
  for (let k = 0; k < es.length; k++) {
    const e = es[k] || {}
    const ref = String(e.settingsRef || '').trim()
    if (!ref) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) continue          // URL ⇒ 跳过（不是根内路径，报了就是误报）
    const looksPath = ref.indexOf('/') >= 0 && /\.md$/i.test(ref) && ref.charAt(0) !== '/'
    if (!looksPath) continue
    if (map[ref] === false) broken.push({ id: String(e.id || ''), settingsRef: ref })
  }
  return broken.sort(function (x, y) { return x.id.localeCompare(y.id) })
}

// ============================== ③ 归档断链组（§2.4 要防的） ==============================

/**
 * 归档断链：**有同名活文档**却**无任何条目 links 指向它**的归档件。
 * ⚠️ 刻意**不**报"孤立归档件"（没有同名活文档的）—— 用户已拍「老件不搬」，
 *    那些历史归档本就不该有 `替代` 关联，全报会淹没真正的问题。
 * @param {object[]} entries
 */
export function auditArchiveLinks(entries) {
  const es = Array.isArray(entries) ? entries : []
  const activeByBase = {}
  const pointed = {}
  for (let k = 0; k < es.length; k++) {
    const e = es[k] || {}
    const p = String(e.path || '')
    const isArch = String(e.status || '') === '归档' || p.indexOf('草稿/.archive/') === 0
    if (!isArch) {
      const b = p.split('/').pop()
      if (b) activeByBase[b] = (activeByBase[b] || []).concat([p])
    }
    const links = Array.isArray(e.links) ? e.links : []
    for (let j = 0; j < links.length; j++) {
      const to = String((links[j] && links[j].to) || '')
      if (to.indexOf('doc:') === 0) pointed[to.slice(4)] = 1
    }
  }
  const broken = []
  for (let k = 0; k < es.length; k++) {
    const e = es[k] || {}
    const p = String(e.path || '')
    const isArch = String(e.status || '') === '归档' || p.indexOf('草稿/.archive/') === 0
    if (!isArch) continue
    const b = p.split('/').pop()
    if (!activeByBase[b]) continue
    if (pointed[p]) continue
    broken.push({ archived: p, activeSiblings: activeByBase[b].slice().sort() })
  }
  return broken.sort(function (x, y) { return x.archived.localeCompare(y.archived) })
}

// ============================== ④ 规范件同源（丙） ==============================

/**
 * 从正文里抽一段：`fromAnchor` 行 → `toAnchor` 行**之前**（两条锚点都必须**存在且唯一**）。
 * 🔴 与 `install-manual-specs.sh` 同口径；锚点不唯一就**拒抽**（本日正是"锚点写死字样"导致过事故）。
 */
export function extractBetween(text, fromAnchor, toAnchor) {
  const s = String(text === undefined || text === null ? '' : text)
  const a = s.indexOf(fromAnchor)
  if (a < 0) return { ok: false, error: '找不到起始锚点: ' + fromAnchor }
  if (s.indexOf(fromAnchor, a + fromAnchor.length) >= 0) return { ok: false, error: '起始锚点不唯一: ' + fromAnchor }
  const b = s.indexOf(toAnchor, a + fromAnchor.length)
  if (b < 0) return { ok: false, error: '找不到结束锚点: ' + toAnchor }
  return { ok: true, text: s.slice(a, b).replace(/\s+$/, '') + '\n' }
}

/** 规范件同源比对：**逐字节**，不相同则定位**首个差异行**（供人一眼定位）。 */
export function compareSpec(expected, actual) {
  const e = String(expected === undefined || expected === null ? '' : expected)
  const a = String(actual === undefined || actual === null ? '' : actual)
  const eb = Buffer.byteLength(e, 'utf8')
  const ab = Buffer.byteLength(a, 'utf8')
  if (e === a) return { same: true, expectedBytes: eb, actualBytes: ab }
  const el = e.split('\n')
  const al = a.split('\n')
  let i = 0
  while (i < el.length && i < al.length && el[i] === al[i]) i++
  return {
    same: false, expectedBytes: eb, actualBytes: ab, firstDiffLine: i + 1,
    expectedLine: String(el[i] === undefined ? '(缺行)' : el[i]).slice(0, 120),
    actualLine: String(al[i] === undefined ? '(缺行)' : al[i]).slice(0, 120)
  }
}

/**
 * **行级**锚点抽取（2026-09-29 定口径，用于 `specs` 组）。
 * 🔴 与 `install-manual-specs.sh` 的 awk **唯一的有意差异**：锚点必须**恰好命中 1 次**，否则**拒抽**。
 *    awk 的 `/re/ { s = NR }` 是"后者覆盖前者 ⇒ **静默取最后一次**" —— 那是本日事故的同类源头
 *    （锚点失配 + 静默 ⇒ `写作规范.md` 曾被截成 0 字节）。这里宁可拒抽，也不静默抽错。
 * 其余完全照搬在役口径：CRLF→LF 归一 · 去尾部空行 · 末行后恰好 1 个 `\n`。
 * @param {string} text
 * @param {RegExp} fromRe 起始行锚点（逐行 test）
 * @param {RegExp} toRe   结束行锚点（**该行不包含**在结果里）
 */
export function extractByLineAnchors(text, fromRe, toRe) {
  const s = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n')
  const lines = s.split('\n')
  const hits = function (re) {
    const out = []
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i)
    return out
  }
  const A = hits(fromRe)
  const B = hits(toRe)
  if (A.length !== 1) return { ok: false, error: '起始锚点命中 ' + A.length + ' 次（须恰好 1 次）: ' + String(fromRe) }
  if (B.length !== 1) return { ok: false, error: '结束锚点命中 ' + B.length + ' 次（须恰好 1 次）: ' + String(toRe) }
  if (B[0] <= A[0]) return { ok: false, error: '结束锚点不晚于起始锚点' }
  let end = B[0] - 1
  while (end > A[0] && lines[end] === '') end--
  return { ok: true, text: lines.slice(A[0], end + 1).join('\n') + '\n' }
}

/**
 * 「查找规范.md」的抽取口径（2026-09-29 定，用户选「照搬在役口径 + 锚点唯一」）：
 *   = A.4 段（`^## A.4` → `^## A.5` 之前）
 *   + **恰好 1 个空行**
 *   + 标签段（`^标签用.*受控前缀` → `^# 附录 C` 之前）
 * 与 `install-manual-specs.sh` §4 的 awk 逐行等价。
 */
export function extractFindSpec(manualText) {
  const a4 = extractByLineAnchors(manualText, /^## A\.4/, /^## A\.5/)
  if (!a4.ok) return a4
  const tag = extractByLineAnchors(manualText, /^标签用.*受控前缀/, /^# 附录 C/)
  if (!tag.ok) return tag
  return { ok: true, text: a4.text + '\n' + tag.text }
}

/** 「写作规范.md」的抽取口径：整个附录 B（`^# 附录 B` → `^# 附录 C` 之前）。 */
export function extractWriteSpec(manualText) {
  return extractByLineAnchors(manualText, /^# 附录 B/, /^# 附录 C/)
}

/**
 * 把体检报告格式化成**可处理**的多行文本（2026-09-29 补）。
 * 🔴 为什么补：首版 `render` **只遍历 `specs`**，索引/灵感库/归档/客户端区**只出现在 summary 的计数里**，
 *    一条明细都不给 ⇒ agent 拿到"索引 1"却**不知道是哪条、该干什么**，等于把真问题藏了。
 *    本条由用户在 agent 会话里跑工具后**当场指出**（"summary 说命中 1 项…明细里没有那 1 条"）⇒ 修。
 * ⇒ 原则：**凡计入 counts 的组，必须在明细里逐条出现**；每组最多列 `cap` 条，超出给"…另 N 条"。
 * @param {object} rep `specAudit` 的返回体
 * @param {number} [maxPerGroup=5] 每组最多列几条明细
 */
export function formatAuditLines(rep, maxPerGroup) {
  const r = rep || {}
  const cap = (typeof maxPerGroup === 'number' && maxPerGroup > 0) ? maxPerGroup : 5
  const out = [String(r.summary || '规范体检完成')]
  const push = function (label, arr, hint) {
    if (!Array.isArray(arr) || arr.length === 0) return
    out.push('  · ' + label + '（' + arr.length + '）' + (hint ? '　' + hint : ''))
    const n = Math.min(arr.length, cap)
    for (let i = 0; i < n; i++) out.push('      - ' + String(arr[i]))
    if (arr.length > cap) out.push('      … 另 ' + (arr.length - cap) + ' 条')
  }
  const idx = r.index || {}
  push('索引·未登记的新顶层目录', idx.newTopLevelDirs, '（若属基础设施目录 ⇒ 登记进 excludedTopLevel；否则应纳入索引）')
  push('索引·缺 type', idx.noType, '（按附录 C 该区类型集补）')
  push('索引·缺 zone', idx.noZone)
  push('索引·缺 work', idx.noWork, '（仅 Z1–Z4 且非下划线练习/模板目录才要求）')
  push('索引·盘上有但未索引（新增候选）', idx.newCandidates)
  push('索引·索引有但盘上缺失', idx.missingOnDisk)
  push('索引·同名路径漂移', (idx.pathDrift || []).map(function (d) { return String((d && d.path) || '') }))
  push('索引·excluded 已消失', idx.excludedGone)
  const insp = r.insp || {}
  push('灵感库·缺世界观键', insp.missKey)
  push('灵感库·多世界观键', insp.multiKey)
  push('灵感库·别名残留', (insp.staleAlias || []).map(function (x) { return String((x && x.id) || '') + ' → ' + String((x && x.tag) || '') }))
  push('灵感库·settingsRef 失效', (insp.brokenSettingsRef || []).map(function (x) { return String((x && x.id) || '') + ' → ' + String((x && x.settingsRef) || '') }))
  push('归档断链（有同名活文档却无「替代」关联）', (r.archiveLinks || []).map(function (x) {
    return String((x && x.archived) || '') + '　（活件：' + String(((x && x.activeSiblings) || []).join(' / ')) + '）'
  }))
  const cz = r.clientZone || {}
  push('客户端区·提交记录落点已不存在', (cz.submitLogMissingTarget || []).map(function (x) { return String((x && x.path) || '') }))
  const sp = Array.isArray(r.specs) ? r.specs : []
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i] || {}
    out.push('  · 规范件 ' + String(s.file || '') + '：' + (s.same ? '同源 ✅'
      : ('**不同源**（' + (s.error || ('首个差异行 ' + s.firstDiffLine)) + '）')))
  }
  if (r.total === 0) out.push('  （未发现问题）')
  out.push('  （只读报告：发现问题请人工/按规范决定处置，本动作不会改动任何文件）')
  return out
}

// ============================== ⑤ 汇总 ==============================

/** 把各组计数汇总（装配层把数据喂进来；这里只数）。 */
export function buildReport(groups) {
  const g = groups || {}
  const num = function (x) { return Array.isArray(x) ? x.length : 0 }
  const idx = g.index || {}
  const insp = g.insp || {}
  const cz = g.clientZone || {}
  const counts = {
    index: num(idx.noType) + num(idx.noZone) + num(idx.noWork) + num(idx.newCandidates) +
      num(idx.missingOnDisk) + num(idx.pathDrift) + num(idx.newTopLevelDirs) + num(idx.excludedGone),
    insp: num(insp.missKey) + num(insp.multiKey) + num(insp.staleAlias) + num(insp.brokenSettingsRef),
    archive: num(g.archiveLinks),
    clientZone: num(cz.submitLogMissingTarget) + num(cz.missingOnDisk),
    specs: num(g.specs ? g.specs.filter(function (s) { return s && s.same === false }) : [])
  }
  let total = 0
  for (const k in counts) total += counts[k]
  return { counts: counts, total: total }
}
