// U-53（2026-09-30）：**工具返回值必须是"无损 JSON"** 契约锁
// 用法（仓库根目录）：node --test plugins/taskkit/test/tool-output-lossless.test.mjs
//
// 起因（真机报错原文）：`Error: tool "insp_update" returned invalid output: value is not lossless JSON`
//
// 判据（宿主源码）：`@deepseek-ai/dsh-tools/lib/types/index.js:106-118`
//   function snapshotToolValue(toolName, candidate) {
//     const detached = snapshotJsonValue(candidate)
//     if (detached === undefined) throw new ToolOutputError(toolName, ['value is not lossless JSON'])
//     ...
//   }
//   ⇒ 返回值必须是"能被 JSON 无损失地表示"的数据；**最典型的不合格就是值为 `undefined` 的属性**
//     （`{warn: undefined}`：JSON.stringify 会把这个键整个丢掉 ⇒ 有损失）。
//
// 真凶：`insp_update` 的 `return { …, warn: uWarn || undefined, … }` —— 无告警时（绝大多数情况）恰好
//   产生 `warn: undefined` ⇒ **每一次调用都失败**；而 `insp_create` 用的是**条件赋值**
//   （`if (warnMsg) created.warn = warnMsg`）⇒ 它一直没事。本文件 ③ 锁"两者必须同写法"。
//
// ⚠️ **诚实标注**：本文件是**静态源码锁**（扫"单行 return 对象字面量"），它**不是**完整证明 ——
//    多行对象字面量、动态组装（Object.assign / 展开）都扫不到。完整证明只能靠**真机调用**
//    （宿主会在那里做无损快照）。本锁的价值是**防"改回去/再犯一次"**，不是替代真机验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const RAW = readFileSync(join(LIB, 'index.js'), 'utf8')
/** 去注释（本锁只关心代码；不处理"字符串里的 //"这种边界，够用且已在下方标注局限） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const SRC = stripComments(RAW)

function seg(name) {
  const i = SRC.indexOf("name: '" + name + "'")
  assert.ok(i > 0, '未找到工具 ' + name)
  const j = SRC.indexOf('registerTool({', i)
  return SRC.slice(i, j < 0 ? SRC.length : j)
}

/** 无损 JSON 的**等价实现**（按语义重写，非宿主源码）：不接受 undefined / 函数 / symbol / bigint / 非有限数 */
function isLossless(v) {
  if (v === null) return true
  const t = typeof v
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(v)
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return false
  if (Array.isArray(v)) return v.every(isLossless)
  if (t === 'object') return Object.keys(v).every((k) => isLossless(v[k]))
  return false
}
/** 扫一段代码里所有**单行** `return {…}`，挑出"值表达式会产出 undefined"的 */
function badSingleLineReturns(code) {
  const bad = []
  const re = /\breturn \{([^\n{}]*)\}/g
  let m
  while ((m = re.exec(code)) !== null) {
    const body = m[1]
    if (/\|\|\s*undefined/.test(body) || /:\s*undefined\s*[,}]/.test(body) || /\?\?\s*undefined/.test(body)) {
      bad.push(body.trim().slice(0, 100))
    }
  }
  return bad
}

test('① 判据自证：`{warn: undefined}` **确实不是**无损 JSON（先证明这把锁抓得住这类值）', () => {
  assert.equal(isLossless({ ok: true, warn: undefined }), false, 'undefined 值属性必须被判不合格')
  assert.equal(isLossless({ ok: true }), true)
  assert.equal(isLossless({ ok: true, warn: '' }), true, '空串是合法值 —— 所以修法是"省略键"而不是"塞空串"')
  assert.equal(isLossless({ a: [1, undefined] }), false, '数组元素里的 undefined 同样不合格')
  assert.equal(isLossless({ a: NaN }), false, 'NaN 不是合法 JSON 数值')
  // 反证：用 JSON.stringify 往返是**测不出** `{warn: undefined}` 的（第一遍就把键丢了）⇒ 这条就是"为什么之前的自测没拦住"
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify({ ok: true, warn: undefined }))), JSON.stringify({ ok: true, warn: undefined }))
})

test('② insp_update：warn 必须**条件赋值**，返回值里不得再出现 `|| undefined`（真凶写法）', () => {
  const s = seg('insp_update')
  assert.ok(s.indexOf('if (uWarn) updated.warn = uWarn') > 0, 'warn 必须条件赋值（与 insp_create 同写法）')
  assert.deepEqual(badSingleLineReturns(s), [], 'insp_update 里不得有会产出 undefined 的单行 return 对象')
  // 直接锁住真凶那一行的**返回值**形态（审计行里用 `|| undefined` 是合法的：它不进工具返回）
  assert.equal(s.indexOf('warn: uWarn || undefined, summary'), -1, '不得再写成 `warn: uWarn || undefined` 塞进返回对象')
})

test('③ 同族一致性：insp_create 与 insp_update 对 `warn` 用**同一种**写法', () => {
  const c = seg('insp_create')
  assert.ok(c.indexOf('if (warnMsg) created.warn = warnMsg') > 0, 'insp_create 的条件赋值是基准写法，不得被改掉')
  for (const nm of ['insp_create', 'insp_update']) {
    assert.deepEqual(badSingleLineReturns(seg(nm)), [], nm + ' 的单行 return 对象不得含 undefined 值')
  }
})

test('④ 泛扫：本插件 lib/index.js 全部单行 return 对象不得含 undefined 值', () => {
  const bad = badSingleLineReturns(SRC)
  assert.deepEqual(bad, [], '单行 return 对象里出现 undefined 值 ⇒ 会触 `not lossless JSON`：\n  - ' + bad.join('\n  - '))
})

test('⑤ 泛扫：lib/ 下所有 .js（跨文件兜底）', () => {
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); continue }
      if (n.endsWith('.js')) files.push(p)
    }
  }
  walk(LIB)
  const bad = []
  for (const f of files) {
    for (const b of badSingleLineReturns(stripComments(readFileSync(f, 'utf8')))) {
      bad.push(f.slice(f.indexOf('lib')) + ' → ' + b)
    }
  }
  assert.deepEqual(bad, [], 'lib/ 下出现会产出 undefined 的单行 return 对象：\n  - ' + bad.join('\n  - '))
})
