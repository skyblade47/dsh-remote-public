// @local/miyoushe —— A4 可复跑断言：源码中不存在 Cookie 回显路径 + 数据面纪律（node 直调，**不加载插件**）
// 运行：node selftest/assert-source-discipline.mjs    （退出码 0 = 全部断言成立）
//
// 断言集（每条都可复跑、结论可核对）：
//  D1  lib/*.js **不**import 任何 fs 模块（数据读写一律经 adapterFs，§10.1）
//  D2  lib/*.js 的**非注释代码行**不出现敏感 token；`mask.js` **不再整份豁免**，豁免**仅限**两处结构性定义行
//      （见下方 EXEMPT_CRITERION 原文），其余行（含 mask.js 的 maskValue/findSecrets/exitPayload…）一并受扫；
//      并用**合成样例**自证豁免"非空洞"（在 mask.js 的普通行注入违例必须被抓到）
//  D3  lib/*.js 不含任何 32 位 hex 字面量（上游盐值全是 32hex ⇒ 等价于"源码里没有盐明文"）
//  D4  selftest/*.mjs 与证据文件里的 32hex 字面量 ⊆ §3.3 三条向量 md5（白名单）
//  D5  inject **恰为** [`tools`,`webServer`]（apply 期就要用的两个服务；t26 起），且**不含**任何可选服务
//      （`adapterFs`/`fs`/`sandboxPolicy`/端口类）；含合成负例自证判别力（旧口径为"inject 为空"，见下方 D5 块注）
//  D6  运行时：出口护栏语义（默认 fail-closed 阻断真值 / 已打码占位放行 / maskOnly 兜底可选）
//
// t11 变更（F4 修复）：D2 由「整份豁免 mask.js」改为「按行豁免 + 合成样例自证」。
// t11 变更（F2 相关）：D6 随 lib/mask.js 的默认语义调整（默认 fail-closed；maskOnly 显式兜底）。

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SENSITIVE_TOKENS, exitPayload, assertNoSecrets, REDACTED } from '../lib/mask.js'
import * as plugin from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LIB = join(ROOT, 'lib')

let failures = 0
const hits = []
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}

// 去注释：整行注释 + 行尾注释（`//` 前须是行首或空白）
function stripComment(line) {
  return line.replace(/(^|\s)\/\/.*$/, '$1')
}
function isCommentLine(line) {
  return /^\s*(\/\/|\/\*|\*|\*\/)/.test(line)
}

// ---------------------------------------------------------------------------
// 豁免判据（**唯一且可解释**，D2 用）：
//   EXEMPT_CRITERION =
//   在 lib/mask.js 中，**且仅**位于 `SECRET_KEYS` / `SENSITIVE_TOKENS` 两个 `Object.freeze([ ... ])`
//   数组字面量内部的行（即"敏感字段名清单"本身）免扫。
//   理由：脱敏器必须**逐字列出**这些键名才能识别/打码，属于"必要定义"；除此之外 mask.js 的任何
//   代码行（SECRET_SET 构造、maskText、maskValue、findSecrets、scanTextSecrets、exitPayload…）
//   与其余 lib/*.js **完全同等受扫**（F4：不再整份豁免）。
// ---------------------------------------------------------------------------
const EXEMPT_CRITERION = 'lib/mask.js 中 SECRET_KEYS / SENSITIVE_TOKENS 两个 Object.freeze([...]) 数组字面量内部的行免扫；其余一律受扫'
const TOKEN_RE = new RegExp('(' + SENSITIVE_TOKENS.join('|') + ')', 'i')
const BLOCK_OPEN_RE = /^export const (SECRET_KEYS|SENSITIVE_TOKENS) = Object\.freeze\(\[/

/** 纯函数：返回该源文件的豁免行号集合（仅 mask.js 有豁免，且仅限上述两处数组块） */
function exemptLinesOf(fileName, src) {
  const exempt = new Set()
  if (fileName !== 'mask.js') return exempt
  let block = null
  src.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1
    if (block === null) {
      const m = BLOCK_OPEN_RE.exec(line.trim())
      if (m) { block = m[1]; exempt.add(n) }
      return
    }
    exempt.add(n)
    if (/\]\)\s*$/.test(line)) block = null
  })
  return exempt
}

/** 显式豁免标记（t16 追加；t19 收紧为「可审计棘轮」）：`// discipline-exempt: <类别>: <具体产物>` */
const MARKER_RE = /\/\/\s*discipline-exempt\s*:\s*(.+)$/
const BAD_REASONS = ['-', 'todo', 'n/a', 'na', 'none', '无', '待补', '略']

// ---------------------------------------------------------------------------
// t19 加固（captain 对 t16 独立验证结论：10 条豁免共用同一句样板原因 ⇒ 复制即隐身）：
//   ① **原因逐行唯一**：扫描器跨文件共享 seenReasons；重复原因的那一行**不予豁免**、仍判违规。
//   ② **原因必须写成 `<类别>: <具体产物>`**，类别限定为下列四类（扫描输出逐行打印 `file:line 类别 原因`）。
//   ③ **豁免行数上限 EXEMPT_CEILING（棘轮）**：超过即 FAIL；
//      **提高上限须经 captain 裁决，并在【对应任务】的证据文件登记理由**——
//      实现者不得自行放宽（这正是"复制即隐身"的封堵点）。
//      （t29 提额留痕：10 → **11**，理由是新增 API 通道模块 `lib/mys-http.js` 的 §2.2 头名表一行；
//        裁决与理由登记见 `selftest/mys-http_现场与证据.md` §A6/A11——**不**改动任何历史任务的证据文件。）
// ---------------------------------------------------------------------------
const EXEMPT_CEILING = 11 // 棘轮：= 当前豁免行数；提高须 captain 裁决 + 【对应任务】证据文件登记理由（t29：10→11）
const EXEMPT_CATEGORIES = ['用户可见文案', '官方端点路径', '设计规定的入参名', '工具 description']
const REASON_RE = new RegExp(
  '^(' + EXEMPT_CATEGORIES.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*[:：]\\s*(.+)$',
)

/** 原因合法性判据：`<四类之一>: <具体产物 ≥6 字符、非占位>` */
function parseReason(reason) {
  const r = typeof reason === 'string' ? reason.trim() : ''
  const m = REASON_RE.exec(r)
  if (!m) return { ok: false, category: null, artifact: null, why: '原因必须写成 `<四类类别之一>: <具体产物>`（t19）' }
  const artifact = m[2].trim()
  if (artifact.length < 6) return { ok: false, category: m[1], artifact, why: '具体产物不足 6 字符' }
  if (BAD_REASONS.includes(artifact.toLowerCase())) return { ok: false, category: m[1], artifact, why: '具体产物是占位词' }
  return { ok: true, category: m[1], artifact, why: null }
}

/** 纯函数：扫描一份源码（供真实文件与**合成样例**共用；这是 D2 的唯一判据实现）
 *  `seenReasons`：跨文件共享的已用原因集合（t19 唯一性棘轮）；省略时按单文件独立集合处理。 */
function scanSourceForSensitiveTokens(fileName, src, seenReasons) {
  const seen = seenReasons instanceof Set ? seenReasons : new Set()
  const exempt = exemptLinesOf(fileName, src)
  const lines = src.split(/\r?\n/)
  const found = []
  const exempted = []
  let scanned = 0
  lines.forEach((line, i) => {
    const n = i + 1
    if (exempt.has(n)) return
    if (isCommentLine(line)) return
    const code = stripComment(line)
    if (!code.trim()) return
    scanned++
    const m = TOKEN_RE.exec(code)
    if (!m) return
    const mk = MARKER_RE.exec(line)
    const rawReason = mk ? mk[1].trim() : ''
    const parsed = mk ? parseReason(rawReason) : { ok: false, category: null, artifact: null, why: '未标记' }
    const echoPattern = new RegExp('JSON\\.stringify\\s*\\([^)]*' + m[1], 'i').test(code)
    if (mk && parsed.ok && !echoPattern && !seen.has(rawReason)) {
      seen.add(rawReason)
      exempted.push({ file: 'lib/' + fileName, line: n, token: m[1], reason: rawReason, category: parsed.category, artifact: parsed.artifact })
      return
    }
    let why
    if (!mk) why = '未标记'
    else if (!parsed.ok) why = parsed.why
    else if (echoPattern) why = '标记行出现在 echo 写法上（JSON.stringify(<token>…)）'
    else why = '原因重复（唯一性棘轮：同一 reason 已被更早的豁免行占用）'
    found.push({ file: 'lib/' + fileName, line: n, token: m[1], text: code.trim(), why })
  })
  return { scanned, exempt: Array.from(exempt).sort((a, b) => a - b), exempted, hits: found }
}

const libFiles = readdirSync(LIB).filter((f) => f.endsWith('.js')).sort()
console.log('== 受检文件 ==')
for (const f of libFiles) console.log('  lib/' + f)

console.log('== D1 lib/*.js 不 import fs（一律经 adapterFs，§10.1）==')
for (const f of libFiles) {
  const src = readFileSync(join(LIB, f), 'utf8')
  const bad = []
  src.split(/\r?\n/).forEach((l, i) => {
    if (/from\s+['"](node:)?fs['"]/.test(l) || /require\(\s*['"](node:)?fs['"]\s*\)/.test(l) || /import\(\s*['"](node:)?fs['"]/.test(l)) bad.push((i + 1) + ': ' + l.trim())
  })
  check(bad.length === 0, 'D1 lib/' + f + ' 无 fs import', bad, '[]')
}

console.log('== D2 非注释代码行不出现敏感 token（豁免＝按行：脱敏器定义块 + **t19 可审计棘轮标记**）==')
console.log('  豁免判据①：' + EXEMPT_CRITERION)
console.log('  豁免判据②：行尾 `// discipline-exempt: <类别>: <具体产物>`；类别 ∈ ' + JSON.stringify(EXEMPT_CATEGORIES))
console.log('  棘轮判据③：原因**逐行唯一**（同一原因被复制到第二行 ⇒ 第二行不豁免、仍判违规）；豁免总行数 ≤ EXEMPT_CEILING=' + EXEMPT_CEILING)
{
  let scannedTotal = 0
  const allMarked = []
  // t19：跨文件共享的已用原因集合 ⇒ 唯一性是**扫描期**强制（不是事后去重）
  const seenReasons = new Set()
  for (const f of libFiles) {
    const src = readFileSync(join(LIB, f), 'utf8')
    const r = scanSourceForSensitiveTokens(f, src, seenReasons)
    scannedTotal += r.scanned
    if (r.exempt.length) {
      const lines = src.split(/\r?\n/)
      for (const n of r.exempt) console.log('  EXEMPT-BLOCK lib/' + f + ':' + n + ' => ' + (lines[n - 1] || '').trim())
    }
    // A2 要求的逐行打印形态：`file:line  类别  原因`
    for (const e of r.exempted) { allMarked.push(e); console.log('  EXEMPT-MARK  ' + e.file + ':' + e.line + '  [' + e.category + ']  ' + e.reason) }
    for (const h of r.hits) hits.push(h)
    console.log('  ' + (r.hits.length ? 'FAIL' : 'PASS') + ' lib/' + f + '：受扫行=' + r.scanned + ' 定义块豁免=' + r.exempt.length + ' 标记豁免=' + r.exempted.length + ' 命中=' + r.hits.length)
  }
  for (const h of hits) console.log('  HIT ' + h.file + ':' + h.line + ' token=' + h.token + ' why=' + h.why + ' => ' + h.text)
  check(hits.length === 0, 'D2 受扫代码行 0 处敏感 token（合计受扫 ' + scannedTotal + ' 行；标记豁免 ' + allMarked.length + ' 行）', hits.length, 0)
  // A1：原因两两不同（唯一性棘轮；重复行在扫描期已落入 hits，此处再对豁免集合本身断言）
  const dupReasons = allMarked.map((e) => e.reason).filter((x, i, a) => a.indexOf(x) !== i)
  check(new Set(allMarked.map((e) => e.reason)).size === allMarked.length && dupReasons.length === 0,
    'D2-A1 豁免原因**逐行唯一**（' + allMarked.length + ' 条两两不同；重复者不豁免）',
    dupReasons, '[]')
  // A2：类别命名 + 具体产物长度（扫描输出已逐行打印 `file:line 类别 原因`）
  const badCat = allMarked.filter((e) => !EXEMPT_CATEGORIES.includes(e.category) || !e.artifact || e.artifact.length < 6)
  check(badCat.length === 0,
    'D2-A2 每条豁免原因 = `<四类类别之一>: <具体产物≥6字>`（类别 ∈ ' + EXEMPT_CATEGORIES.join('/') + '）',
    badCat, '[]')
  // A3：上限棘轮（失败文案必须出现 EXEMPT_CEILING）
  check(allMarked.length <= EXEMPT_CEILING,
    'D2-A3 豁免行数 ' + allMarked.length + ' ≤ EXEMPT_CEILING=' + EXEMPT_CEILING + '（棘轮：提高上限须经 captain 裁决，并在【对应任务】的证据文件登记理由（t29 提额理由见 selftest/mys-http_现场与证据.md））',
    allMarked.length, '<= EXEMPT_CEILING=' + EXEMPT_CEILING)
}

console.log('== D2\u2032 豁免"非空洞"自证（合成样例；证明 mask.js 不再整份豁免）==')
{
  const synthMaskViolation = [
    "export const SECRET_KEYS = Object.freeze([",
    "  'cookie', 'ltoken',",
    "])",
    "const leak = 'cookie=abc123'",
    "export function maskText(t) { return t }",
  ].join('\n')
  const r1 = scanSourceForSensitiveTokens('mask.js', synthMaskViolation)
  console.log('  合成-1 mask.js 普通行注入违例 ⇒ hits=' + JSON.stringify(r1.hits.map((h) => 'L' + h.line + ':' + h.token)) + ' exemptLines=' + JSON.stringify(r1.exempt))
  check(r1.hits.length === 1 && r1.hits[0].line === 4, 'D2\u2032a mask.js 普通行的违例**必须被抓到**（不再整份豁免）', r1.hits, 'L4')

  const synthMaskClean = [
    "export const SECRET_KEYS = Object.freeze([",
    "  'cookie', 'ltoken',",
    "])",
    "export function maskText(t) { return t }",
  ].join('\n')
  const r2 = scanSourceForSensitiveTokens('mask.js', synthMaskClean)
  check(r2.hits.length === 0, 'D2\u2032b 仅表项行免扫（列在数组内的键名不算违例）', r2.hits, '[]')
  check(r2.exempt.join(',') === '1,2,3', 'D2\u2032c 豁免行号精确等于数组块（L1–L3）', r2.exempt.join(','), '1,2,3')

  const synthOther = ["const x = 1", "const y = 'device_fp'"].join('\n')
  const r3 = scanSourceForSensitiveTokens('store.js', synthOther)
  check(r3.hits.length === 1 && r3.exempt.length === 0, 'D2\u2032d 非 mask.js 文件**无任何豁免**', { hits: r3.hits, exempt: r3.exempt }, 'hits:L2 exempt:[]')

  // t16：显式标记豁免的边界（三条：合法标记 / 空壳原因 / echo 写法）；t19：原因改带类别
  const synthMarked = ["const a = i.cookie // discipline-exempt: 设计规定的入参名: 合成样例的输入字段名（自证用）"].join('\n')
  const r5 = scanSourceForSensitiveTokens('index.js', synthMarked)
  console.log('  合成-标记合法 ⇒ exempted=' + JSON.stringify(r5.exempted.map((e) => 'L' + e.line)) + ' hits=' + r5.hits.length)
  check(r5.hits.length === 0 && r5.exempted.length === 1, 'D2\u2032f 带合法原因的标记行被豁免（并记录类别与具体产物）', { hits: r5.hits, ex: r5.exempted.length }, { hits: 0, ex: 1 })

  const synthBadReason = ["const a = i.cookie // discipline-exempt: todo"].join('\n')
  const r6 = scanSourceForSensitiveTokens('index.js', synthBadReason)
  check(r6.hits.length === 1 && r6.exempted.length === 0, 'D2\u2032g 空壳原因（无类别、占位 todo）⇒ **不豁免**，仍判违规', r6.hits.length, 1)

  const synthEcho = ["const out = JSON.stringify(i.cookie) // discipline-exempt: 用户可见文案: 想蒙混过去的具体产物文本"].join('\n')
  const r7 = scanSourceForSensitiveTokens('index.js', synthEcho)
  check(r7.hits.length === 1 && r7.exempted.length === 0, 'D2\u2032h 标记行出现在 `JSON.stringify(<token>` 的 echo 写法上 ⇒ **不豁免**', { h: r7.hits.length, e: r7.exempted.length }, { h: 1, e: 0 })

  const synthComment = ["// cookie=abc123 说明", "const z = 1"].join('\n')
  const r4 = scanSourceForSensitiveTokens('mask.js', synthComment)
  check(r4.hits.length === 0, 'D2\u2032e 注释行不计（注释不是可执行的回显路径）', r4.hits, '[]')

  // -------------------------------------------------------------------------
  // t19 棘轮负例（这两条是"复制即隐身"的封堵点，必须能 FAIL）
  // -------------------------------------------------------------------------
  // A4 负例 1：两行共享**同一句**原因 ⇒ 第二行不予豁免、仍判违规
  const sharedReason = '用户可见文案: 同一句原因被复制到第二行（负例）'
  const synthDup = [
    "const a = 'cookie=1' // discipline-exempt: " + sharedReason,
    "const b = 'cookie=2' // discipline-exempt: " + sharedReason,
  ].join('\n')
  const r8 = scanSourceForSensitiveTokens('index.js', synthDup)
  console.log('  合成-负例A4 重复原因 ⇒ exempted=' + JSON.stringify(r8.exempted.map((e) => 'L' + e.line)) + ' hits=' + JSON.stringify(r8.hits.map((h) => 'L' + h.line + ':' + h.why)))
  check(r8.exempted.length === 1 && r8.exempted[0].line === 1 && r8.hits.length === 1 && r8.hits[0].line === 2,
    'D2-A4 负例1：两行共用同一原因 ⇒ 第 2 行**不被豁免**、仍判违规（唯一性棘轮生效）',
    { ex: r8.exempted.map((e) => e.line), hits: r8.hits.map((h) => h.line) }, { ex: [1], hits: [2] })

  // A5 负例 2：EXEMPT_CEILING + 1 行、原因**唯一且合法** ⇒ 上限守卫必须整体 FAIL
  const synthCeiling = []
  for (let i = 1; i <= EXEMPT_CEILING + 1; i++) {
    synthCeiling.push("const x" + i + " = 'cookie=" + i + "' // discipline-exempt: 用户可见文案: 合成上限负例第 " + i + ' 条（逐行唯一）')
  }
  const r9 = scanSourceForSensitiveTokens('index.js', synthCeiling.join('\n'))
  const ceilingExceeded = r9.exempted.length > EXEMPT_CEILING
  console.log('  合成-负例A5 行数=' + (EXEMPT_CEILING + 1) + '（原因均唯一合法） ⇒ exempted=' + r9.exempted.length + ' ceilingExceeded=' + ceilingExceeded)
  check(ceilingExceeded === true,
    'D2-A5 负例2：豁免行数 ' + r9.exempted.length + ' > EXEMPT_CEILING=' + EXEMPT_CEILING + ' ⇒ 必须整体 FAIL（棘轮上限生效）',
    r9.exempted.length, '> EXEMPT_CEILING=' + EXEMPT_CEILING)
  console.log('  D2-A5 触发的失败文案示例：D2-A3 豁免行数 ' + r9.exempted.length + ' ≤ EXEMPT_CEILING=' + EXEMPT_CEILING + '（棘轮：提高上限须经 captain 裁决，并在【对应任务】的证据文件登记理由（t29 提额理由见 selftest/mys-http_现场与证据.md）） => FAIL')
}

console.log('== D3 lib/*.js 无 32 位 hex 字面量（⇒ 无盐明文 / 无 md5 硬编码）==')
{
  const bad = []
  for (const f of libFiles) {
    const src = readFileSync(join(LIB, f), 'utf8')
    const found = src.match(/[0-9a-fA-F]{32}/g) || []
    if (found.length) bad.push({ file: 'lib/' + f, found })
  }
  check(bad.length === 0, 'D3 lib/*.js 无 32hex', bad, '[]')
}

console.log('== D4 selftest 与证据文件的 32hex ⊆ §3.3 三条向量 md5 ==')
{
  const ALLOW = new Set([
    'f3bc2ed061695cb6d5ab1fe3584e4663',
    '2e5e32fd6b53a5a282c31911e6eafd8b',
    'ceb5357b02dea3b8920405c9db15bde4',
  ])
  const targets = readdirSync(HERE).filter((f) => f.endsWith('.mjs') || f.endsWith('.md'))
  const evidence = join(ROOT, '离线核心_现场与证据.md')
  if (existsSync(evidence)) targets.push(join('..', '离线核心_现场与证据.md'))
  const evidence2 = join(ROOT, 'F2_脱敏自撞修复_现场与证据.md')
  if (existsSync(evidence2)) targets.push(join('..', 'F2_脱敏自撞修复_现场与证据.md'))
  const bad = []
  let total = 0
  for (const t of targets) {
    const p = join(HERE, t)
    if (!existsSync(p)) continue
    const src = readFileSync(p, 'utf8')
    const found = new Set(src.match(/[0-9a-fA-F]{32}/g) || [])
    for (const x of found) { total++; if (!ALLOW.has(x)) bad.push({ file: t, hex: x }) }
  }
  console.log('  受检 32hex 去重计数=' + total + ' 白名单=' + Array.from(ALLOW).length)
  check(bad.length === 0, 'D4 无白名单外 32hex（无盐明文/无凭据）', bad, '[]')
}

console.log('== D5 inject 纪律：硬依赖**恰为** ["tools","webServer"]；可选服务一律不进 inject（§10.1 + t26/A8）==')
// t26 口径变更（旧：`inject.length === 0`，即"本切片零硬依赖"）：
//   启动（boot graph）激活期 `ctx.get('tools')` / `ctx.get('webServer')` 均为 undefined；声明 `[]` ⇒ cordis **不等服务**
//   就把插件激活 ⇒ `apply` 照跑、**注册为空、只打警告**（`tools 服务不可用` / `webServer 不可用`）；而 sandbox autoload
//   又因 `sandbox-state.json` 里 `loaded=true` 判 `already loaded, skip` ⇒ **没有任何人再注册** ⇒ 每次重启后 14 个工具
//   **静默消失**、必须手工 `sandbox_reload` 才恢复（t26 根因，启动日志原文见 `selftest/inject_修复_现场与证据.md` §1）。
//   ⇒ 两个"apply 期就要用"的服务改为**硬依赖**（cordis 等服务就绪再激活），对齐同 profile 的 4 个已知可用插件
//      （`knowledge-base` / `writing-coach` / `prompt-router` / `skill-center`：`['tools','fs','sandboxPolicy','webServer']`）。
//   **可选服务绝不进 inject**（缺失即永久挂起激活）：`adapterFs`（§10.1 明令可选、调用期显式 NOT_READY 降级）、
//      `fs`/`sandboxPolicy`（本插件不直接读盘）、以及端口类（`httpPort`/`credentialsPort`/`fetchImpl`/`miyousheHttp`）。
const EXPECTED_INJECT = ['tools', 'webServer']
const OPTIONAL_MUST_NOT_INJECT = ['adapterFs', 'fs', 'sandboxPolicy', 'httpPort', 'credentialsPort', 'fetchImpl', 'miyousheHttp']
check(Array.isArray(plugin.inject), 'inject 是数组', typeof plugin.inject, 'object')
{
  const got = Array.isArray(plugin.inject) ? plugin.inject.slice() : []
  const setEq = got.length === EXPECTED_INJECT.length && EXPECTED_INJECT.every((s) => got.includes(s))
  const banned = got.filter((s) => OPTIONAL_MUST_NOT_INJECT.includes(s))
  check(setEq, 'A8 inject **恰为** ' + JSON.stringify(EXPECTED_INJECT) + '（集合相等、顺序不限）', got, EXPECTED_INJECT)
  check(banned.length === 0, 'A8 inject **不含**可选服务（' + OPTIONAL_MUST_NOT_INJECT.join(' / ') + '）', banned, '[]')
  check(!got.includes('adapterFs'), 'inject 不含 adapterFs（§10.1 可选依赖纪律，原断言保留）', got, '<无 adapterFs>')
  // -------------------------------------------------------------------------
  // A8 判别力自证（**合成负例**）：判据与真实断言**同一表达式**（同一 EXPECTED_INJECT / OPTIONAL_MUST_NOT_INJECT）。
  //   口径比较（**判别方向**）：
  //     - 旧口径 `length === 0`：只认 `[]` ⇒ 会把 t26 的**缺陷形态**判 PASS，却把**正确修复** `['tools','webServer']` 判 FAIL
  //       （方向是反的），且**分不出**"合法两硬依赖"与"混入可选服务/少一个"的组合。
  //     - 新口径：`[]` 判 FAIL（N4）、少一个硬依赖判 FAIL（N3）、混入可选服务由**禁用清单**命中（N1/N2）。
  //   ⇒ 判别力**未降低**：`[]` 与非法组合都 FAIL，且失败原因可读（setEq / banned）。
  // -------------------------------------------------------------------------
  const judge = (inj) => {
    const setEq2 = inj.length === EXPECTED_INJECT.length && EXPECTED_INJECT.every((s) => inj.includes(s))
    const banned2 = inj.filter((s) => OPTIONAL_MUST_NOT_INJECT.includes(s))
    return { pass: setEq2 && banned2.length === 0, setEq: setEq2, banned: banned2 }
  }
  const NEG = [
    { name: 'N1 混入可选服务 fs（由**禁用清单**命中：banned=["fs"]；旧口径只按"非空"判失败、分不出合法/非法组合）', inject: ['tools', 'webServer', 'fs'] },
    { name: 'N2 注入 adapterFs（§10.1 明令不进 inject；禁用清单命中）', inject: ['tools', 'webServer', 'adapterFs'] },
    { name: 'N3 少注入 webServer（A2 的 `HTTP actions ready: 12` 会静默不注册）', inject: ['tools'] },
    { name: 'N4 退化为空数组（**旧口径唯一放过的形态**＝t26 缺陷本身；新口径必须判 FAIL）', inject: [] },
  ]
  for (const n of NEG) {
    const r = judge(n.inject)
    console.log('  合成负例 ' + n.name + ' => ' + JSON.stringify({ inject: n.inject, pass: r.pass, setEq: r.setEq, banned: r.banned }))
    check(r.pass === false, 'A8 合成负例必须判 FAIL：' + n.name, { inject: n.inject, setEq: r.setEq, banned: r.banned }, 'pass=false')
  }
}
check(plugin.name === '@local/miyoushe', 'plugin.name', plugin.name, '@local/miyoushe')
check(typeof plugin.apply === 'function' && typeof plugin.createCore === 'function', 'apply/createCore 均导出', 'ok', 'ok')

console.log('== D6 运行时出口语义（t14：默认＝**掩码兜底**；`strict:true`＝fail-closed；已打码两姿态皆 OK）==')
{
  let code = null
  try { assertNoSecrets({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }) } catch (e) { code = e && e.code }
  check(code === 'CREDENTIAL_ECHO_BLOCKED', 'D6a 护栏 assertNoSecrets 阻断未脱敏输入（与姿态无关）', code, 'CREDENTIAL_ECHO_BLOCKED')
  let strictKey = null
  try { exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'p', { strict: true }) } catch (e) { strictKey = e && e.code }
  check(strictKey === 'CREDENTIAL_ECHO_BLOCKED', 'D6b **strict** 出口阻断敏感键', strictKey, 'CREDENTIAL_ECHO_BLOCKED')
  let strictText = null
  try { exitPayload({ note: 'ds=realvalue123' }, 'p', { strict: true }) } catch (e) { strictText = e && e.code }
  check(strictText === 'CREDENTIAL_ECHO_BLOCKED', 'D6c **strict** 出口阻断文本级真值', strictText, 'CREDENTIAL_ECHO_BLOCKED')
  let defKeyErr = null
  let defKey = null
  try { defKey = exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'p') } catch (e) { defKeyErr = e }
  console.log('  D6d default raw=' + JSON.stringify(defKey))
  check(defKeyErr === null && defKey.cookie === REDACTED, 'D6d 默认姿态＝掩码兜底（不抛 + <redacted>）', { err: defKeyErr && defKeyErr.code, out: defKey }, '<redacted>')
  const defText = exitPayload({ note: 'ds=realvalue123' }, 'p')
  check(defText.note === 'ds=<redacted>' && !JSON.stringify(defText).includes('realvalue123'), 'D6e 默认姿态把文本级真值打码且无明文', defText.note, 'ds=<redacted>')
  const maskedBoth = (mode) => {
    try {
      const v = { note: 'ds=<redacted>', message: '上游回显：cookie=<redacted>' }
      return JSON.stringify(mode === 'strict' ? exitPayload(v, 'p', { strict: true }) : exitPayload(v, 'p'))
    } catch (e) { return 'THROW ' + e.code }
  }
  console.log('  D6f masked/default=' + maskedBoth('default') + ' | strict=' + maskedBoth('strict'))
  check(maskedBoth('default').startsWith('{') && maskedBoth('strict').startsWith('{'), 'D6f 已打码占位两姿态皆 OK（F2 自撞已修）', [maskedBoth('default'), maskedBoth('strict')], '<两姿态成功>')
  const aliasOut = exitPayload({ note: 'ds=realvalue123' }, 'p', { maskOnly: true })
  check(JSON.stringify(aliasOut) === JSON.stringify(defText), 'D6g `maskOnly` 兼容别名 ≡ 默认（输出逐字相同）', aliasOut.note, defText.note)
  const out = exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL', uid: '123456789' }, 'default')
  console.log('  D6h raw=' + JSON.stringify(out))
  check(out.cookie === REDACTED && out.uid === '***6789', 'D6h 默认姿态脱敏（<redacted> / 尾号）', out, '<redacted/***6789>')
  check(!JSON.stringify(out).includes('SYNTHETIC-NOT-A-REAL-CREDENTIAL'), 'D6i 出口串无凭据值残留', '(含)', '(不含)')
}

console.log('')
console.log('SOURCE_DISCIPLINE failures=' + failures + ' sensitiveHits=' + hits.length)
process.exitCode = failures === 0 ? 0 : 1
