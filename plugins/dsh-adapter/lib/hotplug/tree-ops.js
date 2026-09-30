// @local/dsh-adapter —— loader 树操作原语
//
// 从 sandbox/lib/sandbox-service.js 迁移的遍历/卸载能力（那套代码在生产里跑过，
// 五种卸载策略是被真实失败逼出来的，不要精简成一种）。差异：
//   · 去掉 manifest/state/audit 耦合，只保留纯树操作 ⇒ 可注入假树做单测
//   · 遍历结果显式返回 depth/path，供 tiers.js 判档使用
//
// 关键背景（为什么需要这么绕）：
//   cordis 的 loader 是 EntryTree（Loader extends EntryTree），自身带 store/entries()/ensureId；
//   bundles 复合层会把条目放进 EntryGroup 的嵌套 store 里，路径形如
//   `tree.store.include.subtree.store.local-taskkit` —— 所以"按 id 直接查 store"常常查不到，
//   必须深遍历；而深遍历又要避开 ctx/fiber/registry 这类会造成环或爆炸的键。

const SKIP_KEYS = new Set(['ctx', 'runtime', 'parent', 'scope', 'fiber', 'registry'])
const MAX_NODES = 20000
const MAX_DEPTH = 50
const LOCAL_PREFIX = 'local-'

/**
 * 深遍历 loader / EntryGroup 的嵌套结构，收集所有"看起来是条目"的对象。
 * 判定条件与 sandbox 一致：有 id 或 name，且带 remove / options / fiber 之一。
 * @returns {Array<{entry:object, path:string, depth:number}>}
 */
export function walkTree(root) {
  const out = []
  if (!root) return out
  const seen = new WeakSet()
  const queue = [{ obj: root, path: 'tree', depth: 0 }]
  let iter = 0
  while (queue.length && ++iter < MAX_NODES) {
    const { obj, path, depth } = queue.shift()
    if (!obj || typeof obj !== 'object') continue
    if (depth > MAX_DEPTH) continue
    if (seen.has(obj)) continue
    try { seen.add(obj) } catch (_) { /* 原始对象不可 WeakSet，忽略 */ }

    const idS = typeof obj.id === 'string' ? obj.id : ''
    const nameS = typeof obj.name === 'string' ? obj.name : ''
    if ((idS || nameS) &&
        (typeof obj.remove === 'function' ||
         (obj.options && typeof obj.options === 'object') ||
         (obj.fiber && typeof obj.fiber === 'object'))) {
      out.push({ entry: obj, path, depth })
    }

    let keys = []
    try { keys = Object.keys(obj) } catch (_) { /* ignore */ }
    for (const k of keys) {
      if (SKIP_KEYS.has(k)) continue
      let v
      try { v = obj[k] } catch (_) { continue }
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) queue.push({ obj: v[i], path: `${path}[${k}][${i}]`, depth: depth + 1 })
      } else if (v && typeof v === 'object') {
        queue.push({ obj: v, path: `${path}.${k}`, depth: depth + 1 })
      }
    }
  }
  return out
}

/** 条目是否对应 manifest 里的某个 id（覆盖 id/name/alias/options.* 与 local-/@local/ 前缀） */
export function matchesId(entry, id) {
  if (!entry || !id) return false
  const pkgName = `@local/${id}`
  const localId = LOCAL_PREFIX + id
  const n = typeof entry.name === 'string' ? entry.name : ''
  const a = typeof entry.alias === 'string' ? entry.alias : ''
  const d = typeof entry.id === 'string' ? entry.id : ''
  const oid = (entry.options && typeof entry.options.id === 'string') ? entry.options.id : ''
  const ona = (entry.options && typeof entry.options.name === 'string') ? entry.options.name : ''
  return (n === id || n === pkgName) ||
    (a === id || a === pkgName || a === localId) ||
    (d === id || d === localId || d === pkgName) ||
    (oid === id || oid === localId || oid === pkgName) ||
    (ona === id || ona === pkgName)
}

/**
 * 找到所有匹配条目：先查顶层 store 的三个候选键（这些是 depth=1 的 FREE 候选），
 * 再深遍历补齐嵌套条目。seen 去重避免同一对象被重复收集。
 * @returns {Array<{entry:object, path:string, depth:number, refKey:string|null}>}
 */
export function findAllMatchingEntries(tree, id) {
  const out = []
  if (!tree || !id) return out

  try {
    for (const key of [id, LOCAL_PREFIX + id, `@local/${id}`]) {
      if (tree.store && tree.store[key]) {
        out.push({ entry: tree.store[key], path: `tree.store['${key}']`, depth: 1, refKey: key })
      }
    }
  } catch (_) { /* ignore */ }

  const seen = new WeakSet()
  for (const x of out) { try { seen.add(x.entry) } catch (_) {} }

  for (const { entry, path, depth } of walkTree(tree)) {
    if (seen.has(entry)) continue
    if (!matchesId(entry, id)) continue
    try { seen.add(entry) } catch (_) {}
    out.push({ entry, path, depth, refKey: typeof entry.id === 'string' ? entry.id : null })
  }
  return out
}

/** 是否已加载（顶层 store 命中或深遍历命中） */
export function isLoaded(tree, id) {
  if (!tree || !id) return false
  try {
    if (tree.store && (tree.store[id] || tree.store[LOCAL_PREFIX + id])) return true
  } catch (_) { /* ignore */ }
  for (const { entry } of walkTree(tree)) {
    if (matchesId(entry, id)) return true
  }
  return false
}

/** 按形如 `tree.store.include.subtree` 的路径串解析对象（支持点号与方括号两种 token） */
export function resolveByPath(tree, pathStr) {
  if (!pathStr || typeof pathStr !== 'string') return null
  let cur = { tree }
  const tokens = []
  let i = 0
  while (i < pathStr.length) {
    const ch = pathStr[i]
    if (ch === '.') {
      i++
      let j = i
      while (j < pathStr.length && /[A-Za-z0-9_$]/.test(pathStr[j])) j++
      if (j > i) { tokens.push({ key: pathStr.slice(i, j) }); i = j }
    } else if (ch === '[') {
      i++
      let j = i
      if (pathStr[j] === "'" || pathStr[j] === '"') {
        const q = pathStr[j]; j++
        const buf = []
        while (j < pathStr.length && pathStr[j] !== q) {
          buf.push(pathStr[j])
          if (pathStr[j] === '\\') j += 2
          else j++
        }
        j++
        if (pathStr[j] === ']') j++
        tokens.push({ key: buf.join('') })
      } else {
        while (j < pathStr.length && pathStr[j] !== ']') j++
        const num = pathStr.slice(i, j)
        if (pathStr[j] === ']') j++
        tokens.push({ key: isNaN(Number(num)) ? num : Number(num) })
      }
      i = j
    } else {
      let j = i
      while (j < pathStr.length && /[A-Za-z0-9_$]/.test(pathStr[j])) j++
      if (j > i) { tokens.push({ key: pathStr.slice(i, j) }); i = j }
      else break
    }
  }
  for (const t of tokens) {
    if (cur == null) return null
    cur = cur[t.key]
  }
  return cur
}

export function detectResiduals(tree, id) {
  const effects = []
  try {
    const entry = tree && tree.store && tree.store[id]
    if (!entry) return effects
    if (entry.fiber && entry.fiber.runtime && entry.fiber.runtime.effects) {
      effects.push(`effects:${entry.fiber.runtime.effects.length}`)
    }
    effects.push('note:scan limited (cordis registry not exposed)')
  } catch (_) {
    effects.push('note:scan failed')
  }
  return effects
}

/**
 * 强制清理所有匹配条目（unload / reload / swap 的前置清理）。
 *
 * 五种策略按"从精确到兜底"排列，每一步都 try/catch 且记录是否成功：
 *   ① entry.remove()
 *   ② 由遍历路径推出父 EntryGroup，调 parent.remove(optionsId)
 *   ③ 直接 delete parent.store[key]
 *   ④ 顶层 tree.remove(optionsId / refKey)
 *   ⑤ registry.dispose(callback) / fiber.runtime._dispose()
 * 最后二次扫描确认是否仍有残留 —— 残留即 unclean，调用方必须据此中止而不是继续 create
 * （继续会工具重复注册，这是 sandbox 时期的真实踩坑）。
 *
 * @returns {Promise<{removed:string[], failed:Array, remains:boolean, residuals:string[], removedCount:number, matchedCount:number}>}
 */
export async function forceRemoveAll({ tree, ctx, id }) {
  const matched = findAllMatchingEntries(tree, id)
  const removed = []
  const failed = []
  // 深层先卸：先卸子条目再卸父容器，避免父容器 dispose 后子条目引用失效
  matched.sort((a, b) => b.depth - a.depth)

  for (const info of matched) {
    const entry = info.entry
    const label = info.refKey || info.path
    const optionsId = entry && entry.options && typeof entry.options.id === 'string' ? entry.options.id : null
    const optionsName = entry && entry.options && typeof entry.options.name === 'string' ? entry.options.name : null
    const callback = entry && entry.fiber && entry.fiber.runtime && entry.fiber.runtime.callback
    let disposed = false

    // 策略①：entry.remove()
    try {
      if (entry && typeof entry.remove === 'function') {
        const p = entry.remove()
        if (p && typeof p.then === 'function') await p
        disposed = true
      }
    } catch (_) { disposed = false }

    // 策略②③：从遍历路径推断父容器
    //   典型路径 tree.store.include.subtree.store.local-taskkit
    //   → 父 EntryGroup = tree.store.include.subtree，其 .store[optionsId] 才是该条目
    if (!disposed && typeof info.path === 'string') {
      const storeIdx = info.path.lastIndexOf('.store.')
      if (storeIdx >= 0) {
        const parent = resolveByPath(tree, info.path.slice(0, storeIdx))
        const key = optionsId || info.path.slice(storeIdx + '.store.'.length)
        if (parent && typeof parent.remove === 'function') {
          try {
            const p = parent.remove(key)
            if (p && typeof p.then === 'function') await p
            disposed = true
          } catch (_) { disposed = false }
        }
        if (!disposed && parent && parent.store && key) {
          try {
            if (parent.store[key]) { delete parent.store[key]; disposed = true }
          } catch (_) { disposed = false }
        }
      }
    }

    // 策略④：顶层 tree.remove
    if (!disposed) {
      const tryKeys = []
      if (optionsId) tryKeys.push(optionsId)
      if (info.refKey) tryKeys.push(info.refKey)
      for (const k of tryKeys) {
        if (disposed) break
        try {
          if (tree && typeof tree.remove === 'function') {
            const p = tree.remove(k)
            if (p && typeof p.then === 'function') await p
            disposed = true
          }
        } catch (_) { disposed = false }
      }
    }

    // 策略⑤：兜底用 registry.dispose(callback) 清副作用（工具 / ctx 提供服务）
    if (ctx && ctx.registry && typeof ctx.registry.dispose === 'function' && callback) {
      try {
        const p = ctx.registry.dispose(callback)
        if (p && typeof p.then === 'function') await p
        if (!disposed) disposed = true
      } catch (_) { /* ignore */ }
    }
    if (!disposed && entry && entry.fiber && entry.fiber.runtime) {
      try {
        const rt = entry.fiber.runtime
        const fn = typeof rt._dispose === 'function' ? rt._dispose : (typeof rt.dispose === 'function' ? rt.dispose : null)
        if (fn) {
          const p = fn.call(rt)
          if (p && typeof p.then === 'function') await p
          disposed = true
        }
      } catch (_) { /* ignore */ }
    }

    if (disposed) removed.push(label + (optionsName ? `(${optionsName})` : ''))
    else failed.push({ k: label, optionsId, err: '五种卸载策略都未成功' })
  }

  const remains = isLoaded(tree, id)
  return {
    removed, failed, remains,
    residuals: remains ? detectResiduals(tree, id) : [],
    removedCount: removed.length,
    matchedCount: matched.length,
  }
}
