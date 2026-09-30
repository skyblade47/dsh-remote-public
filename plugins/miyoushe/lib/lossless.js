// @local/miyoushe —— 无损 JSON 出口工具（设计 §6.2.2 纪律 3）
//
// 血泪教训（本项目既有事故）：宿主对 agent 工具的返回值做「无损 JSON」校验——对象里只要出现
// `undefined`/函数/非纯对象字段，就报 `invalid output: value is not lossless JSON`。
// HTTP 路径因 JSON.stringify 天然丢弃 undefined 而侥幸通过，工具路径直传则直接报错。
//
// 本模块提供**显式**消毒与**可复跑**断言：
//   undefined / function / symbol  → 对象里剔除该键；数组里转 null
//   Date                           → ISO 字符串（§6.2.2 纪律 3）
//   NaN / Infinity                 → null（JSON 无此值）
//   BigInt                         → 十进制字符串
//   Map / Set / TypedArray          → 普通对象 / 数组（类实例一律降为纯对象）
//   Error                          → {name, message, code}
//   循环引用                        → '[Circular]'（剪断，不抛）
// 出口顺序固定为：mask → toLossless → assertLossless（见 lib/mask.js 的 exitPayload）。

export const CIRCULAR = '[Circular]'

const OMIT = Symbol('omit')

export class LosslessError extends Error {
  constructor(violations, label) {
    const head = violations.slice(0, 5).map((v) => v.path + ' (' + v.reason + ')').join('; ')
    super('非无损 JSON 出口' + (label ? '[' + label + ']' : '') + '：' + violations.length + ' 处，例：' + head)
    this.name = 'LosslessError'
    this.code = 'NOT_LOSSLESS'
    this.violations = violations
  }
}

function walkLossless(value, inArray, seen) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? null : OMIT
  }
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'bigint') return value.toString()
  if (t !== 'object') return null

  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (value instanceof RegExp) return value.toString()
  if (value instanceof Error) {
    const e = { name: String(value.name || 'Error'), message: String(value.message === undefined ? '' : value.message) }
    e.code = value.code === undefined || value.code === null ? null : String(value.code)
    return e
  }
  if (ArrayBuffer.isView(value)) return Array.from(value, (x) => walkLossless(x, true, seen))
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  let out
  if (Array.isArray(value)) {
    out = value.map((x) => walkLossless(x, true, seen))
  } else if (value instanceof Map) {
    out = {}
    for (const [k, v] of value) {
      const w = walkLossless(v, false, seen)
      if (w !== OMIT) out[String(k)] = w
    }
  } else if (value instanceof Set) {
    out = Array.from(value, (x) => walkLossless(x, true, seen))
  } else {
    out = {}
    for (const k of Object.keys(value)) {
      const w = walkLossless(value[k], false, seen)
      if (w !== OMIT) out[k] = w
    }
  }
  seen.delete(value) // 同一对象在 DAG 里出现两次不算环；只有真环才剪断
  return out
}

/** 返回一个「无损 JSON」副本（永不抛；不可表达的值按上表归一） */
export function toLossless(value) {
  const r = walkLossless(value, false, new WeakSet())
  return r === OMIT ? null : r
}

/** 扫描非无损成分（不改动入参）；path 形如 `a.b[0].c` */
export function findLosslessViolations(value) {
  const out = []
  const seen = new WeakSet()
  const walk = (v, path) => {
    if (v === undefined) return void out.push({ path, reason: 'undefined' })
    if (typeof v === 'function') return void out.push({ path, reason: 'function' })
    if (typeof v === 'symbol') return void out.push({ path, reason: 'symbol' })
    if (typeof v === 'bigint') return void out.push({ path, reason: 'bigint' })
    if (typeof v === 'number' && !Number.isFinite(v)) return void out.push({ path, reason: 'non-finite number' })
    if (v instanceof Date) return void out.push({ path, reason: 'Date（须先 toISOString）' })
    if (v instanceof Map) return void out.push({ path, reason: 'Map' })
    if (v instanceof Set) return void out.push({ path, reason: 'Set' })
    if (v instanceof Error) return void out.push({ path, reason: 'Error（须先归一为普通对象）' })
    if (v && typeof v === 'object') {
      if (seen.has(v)) return void out.push({ path, reason: 'circular' })
      seen.add(v)
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '[' + i + ']'))
      else for (const k of Object.keys(v)) walk(v[k], path + '.' + k)
      seen.delete(v)
    }
  }
  walk(value, '$')
  return out
}

/** 断言已是无损 JSON；违反即抛（出口护栏用） */
export function assertLossless(value, label) {
  const violations = findLosslessViolations(value)
  if (violations.length) throw new LosslessError(violations, label)
  if (JSON.stringify(value) === undefined) {
    throw new LosslessError([{ path: '$', reason: 'JSON.stringify 返回 undefined' }], label)
  }
  return value
}
