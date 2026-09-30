// @local/dsh-adapter —— AdapterFs 实现（§3 接口全量；极薄：路径解析胶水 + 读写 + 缓存失效 + 错误映射）
// 设计要点：
//  - 不产生业务数据语义，只标准化 路径解析/读写/缓存失效 三件事
//  - readJson 默认 cache:false 直读盘（消灭 30s 陈旧坑）；带 cacheMs 才用 TTL
//  - resolveRef 相对引用自动拼 defaultDataRoot（消灭 settingsRef 锚错根坑）
//  - 写后自动 invalidate；fallback 只在 FS_NOT_FOUND/FS_NOT_TEXT/JSON.parse 三类触发（§3.3 触发集合）

import { AdapterError } from './errors.js'

const FALLBACK_TRIGGER_CODES = new Set(['FS_NOT_FOUND', 'FS_NOT_TEXT', 'EBADJSON'])

// 路径规范化（缓存键比对用）：统一正/反斜杠，避免同一文件两种写法互不命中
const norm = (s) => String(s).replace(/\\/g, '/')

// 绝对路径前缀识别：UNC(//host/share) / POSIX(/) / Windows 盘符(C:)
const ABS_PREFIX_RE = /^(\/\/[^/]+\/[^/]+|\/|[A-Za-z]:)/

// 绝对路径判定。不要写成只认盘符的 /^[A-Za-z]:[\\/]/：
// 那在 Linux 上会把 /srv/... 判成相对路径，进而回退到 process.cwd()（错锚）。
const isAbsolutePath = (p) => typeof p === 'string' && ABS_PREFIX_RE.test(p)

/**
 * 在登记根下拼相对引用，并拦截 `..` 逃逸。
 *
 * ⚠ 必须保留原始前缀：早期实现是 `split('/')` → 丢空串 → `join('/')`，
 * 这在 Windows 上没问题（盘符 `E:\x` 的首段是非空的 `E:`），
 * 但 POSIX 的前导 `/` 会被当成空串丢掉 —— `/srv/dsh-workspace/全局数据`
 * 会退化成相对路径 `srv/dsh-workspace/全局数据`，宿主再按 `process.cwd()`
 * 解析，插件数据就静默写到 `<cwd>/srv/dsh-workspace/...` 去了
 * （2026-09-22 在 Linux 上实测踩到：memory-system 的 dataDir 被拼到 DSH_HOME 下）。
 */
function joinUnderRoot(rootPath, rel) {
  const normRoot = String(rootPath).replace(/\\/g, '/').replace(/\/+$/, '')
  const m = normRoot.match(ABS_PREFIX_RE)
  let prefix = ''
  let rest = normRoot
  if (m) {
    prefix = m[1]
    rest = normRoot.slice(prefix.length).replace(/^\/+/, '')
  }
  const rootSegs = rest.split('/').filter(Boolean)
  const out = [...rootSegs]
  for (const s of String(rel).replace(/\\/g, '/').split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      // 相对引用只允许根内子路径：退到根之前即判逃逸
      if (out.length <= rootSegs.length) throw new AdapterError('BAD_ARG', 'path escapes root: ' + rel)
      out.pop()
    } else {
      out.push(s)
    }
  }
  const joined = out.join('/')
  if (!prefix) return joined
  // 前缀统一补一个 '/' 收尾：POSIX 的 '/' 原样、盘符 'E:' → 'E:/'、UNC '//host/share' → '//host/share/'
  return prefix + (prefix.endsWith('/') ? '' : '/') + joined
}

export class AdapterFsImpl {
  constructor(deps) {
    // deps: { fs, sandboxPolicy?, config }
    this._fs = deps.fs
    this._sandboxPolicy = deps.sandboxPolicy // may be undefined
    this._cfg = deps.config || {}
    this._roots = (this._cfg.roots || {}) // rootName -> absolutePath
    this._cache = new Map() // key -> { at, data }
  }

  // ---- 内部：目标解析 ----
  async _resolveTarget(rootRef, rel) {
    const fs = this._fs
    if (!fs) throw new AdapterError('ADAPTER_UNAVAILABLE', 'ctx.fs missing')
    // rootRef 可为：绝对路径（盘符/UNC/posix /）或根表登记名
    let rootPath
    if (typeof rootRef === 'string' && rootRef.length) {
      if (/^[A-Za-z]:[\\/]/.test(rootRef) || rootRef.startsWith('/') || rootRef.startsWith('\\\\')) {
        rootPath = rootRef
      } else {
        rootPath = this._roots[rootRef]
        if (rootPath === undefined) throw new AdapterError('ROOT_UNKNOWN', 'unknown root: ' + rootRef)
      }
    } else {
      throw new AdapterError('BAD_ARG', 'rootRef required (root name or absolute path)')
    }
    let full = rootPath
    if (rel) {
      full = joinUnderRoot(rootPath, rel)
    }
    return fs.resolve(full, { cwd: process.cwd() })
  }

  _cacheKey(target) {
    try {
      const d = target && (target.targetKey || target.displayPath || String(target))
      return String(d)
    } catch (e) { return null }
  }

  _cacheGet(key) {
    if (!key) return undefined
    const hit = this._cache.get(key)
    if (!hit) return undefined
    return hit.data
  }

  // ---- A1/A2/A8：根与路径 ----
  root(name) {
    const p = this._roots[name]
    if (p === undefined) return Promise.reject(new AdapterError('ROOT_UNKNOWN', 'unknown root: ' + name))
    return this._resolveTarget(p, null).then((t) => ({ targetKey: this._targetKey(t), displayPath: this._display(t) }))
  }

  _targetKey(t) { return t && t.targetKey !== undefined ? t.targetKey : String(t) }
  _display(t) { return t && t.displayPath !== undefined ? t.displayPath : String(t) }

  resolve(rootRef, rel, opts) {
    return this._resolveTarget(rootRef, rel).then((t) => ({ targetKey: this._targetKey(t), displayPath: this._display(t) }))
  }

  // 默认根解析（§3.1 A2 触发条件表）：
  //  - 声明且值为非空 → 该值即默认根（绝对路径 / 已登记根名 / 原样交给 _resolveTarget 判 ROOT_UNKNOWN）
  //  - 声明且值为空（''/null/undefined）→ **唯一**触发 adapter 自有极薄回退链：env.DSH_WORKSPACE → sandboxPolicy.workspaceRoot → process.cwd()
  //  - 未声明该键 → 无默认根（返回 null，绝不推导；与"声明空值"语义严格区分，防隐式错锚）
  _defaultRootPath() {
    const cfg = this._cfg
    const declared = Object.prototype.hasOwnProperty.call(cfg, 'defaultDataRoot')
    const d = cfg.defaultDataRoot
    if (!declared) return null
    if (d === undefined || d === null || d === '') {
      if (isAbsolutePath(process.env.DSH_WORKSPACE)) return process.env.DSH_WORKSPACE
      if (this._sandboxPolicy && typeof this._sandboxPolicy.resolve === 'function') {
        try {
          const r = this._sandboxPolicy.resolve()
          if (r && isAbsolutePath(r.workspaceRoot)) return r.workspaceRoot
        } catch (e) {}
      }
      return process.cwd()
    }
    // 非空声明：绝对路径直接返回；登记根名解析；否则原样（_resolveTarget 未登记 → ROOT_UNKNOWN）
    if (isAbsolutePath(d)) return d
    if (this._roots[d] !== undefined) return this._roots[d]
    return d
  }

  // 引用解析：绝对直解；相对走 root ?? defaultRoot（消灭 §2.3 settingsRef 锚错宿主 cwd 的坑）
  async resolveRef(ref, opts) {
    if (typeof ref !== 'string' || !ref.length) throw new AdapterError('BAD_ARG', 'ref required')
    if (/^[A-Za-z]:[\\/]/.test(ref) || ref.startsWith('/') || ref.startsWith('\\\\')) {
      return this._resolveTarget(ref, null).then((t) => ({ targetKey: this._targetKey(t), displayPath: this._display(t) }))
    }
    let root = opts && opts.root
    if (root === undefined || root === null || root === '') {
      root = this._defaultRootPath()
      // §3.1 A2 触发表 / §4.4 D9：无默认根（未声明 defaultDataRoot）且未显式给 root → BAD_ARG（显式失败防错锚）
      if (root === null) throw new AdapterError('BAD_ARG', 'no default root: declare config.defaultDataRoot or pass opts.root')
    }
    return this._resolveTarget(root, ref).then((t) => ({ targetKey: this._targetKey(t), displayPath: this._display(t) }))
  }

  // ---- 读（默认 cache:false）----
  async _statOrNull(target) {
    try {
      const st = await this._fs.stat(target)
      return st
    } catch (e) {
      if (e && e.code === 'FS_NOT_FOUND') return undefined
      throw e
    }
  }

  stat(rootRef, rel) {
    return this._resolveTarget(rootRef, rel).then((t) => this._statOrNull(t))
  }

  exists(rootRef, rel) {
    return this._resolveTarget(rootRef, rel).then((t) => this._statOrNull(t).then((s) => s !== undefined))
  }

  listDir(rootRef, rel) {
    return this._resolveTarget(rootRef, rel).then((t) => this._fs.listDir(t).then((items) => (Array.isArray(items) ? items.map((e) => ({
      name: e.name,
      type: e.type,
      version: e.version !== undefined ? e.version : undefined,
      size: e.size !== undefined ? e.size : undefined,
    })) : [])))
  }

  readText(rootRef, rel) {
    return this._resolveTarget(rootRef, rel).then((t) => this._fs.readText(t))
  }

  async readJson(rootRef, rel, opts) {
    const o = opts || {}
    const target = await this._resolveTarget(rootRef, rel)
    const key = this._cacheKey(target)
    if (o.cacheMs && key) {
      const hit = this._cache.get(key)
      if (hit && Date.now() - hit.at < o.cacheMs) return hit.data
    }
    try {
      const text = await this._fs.readText(target)
      let data
      try {
        data = JSON.parse(text)
      } catch (pe) {
        if (o.fallback !== undefined) return o.fallback
        throw new AdapterError('EBADJSON', 'invalid json at ' + (this._display(target)), pe)
      }
      if (o.cacheMs && key) this._cache.set(key, { at: Date.now(), data })
      return data
    } catch (e) {
      // fallback 触发集合：FS_NOT_FOUND / FS_NOT_TEXT / EBADJSON（JSON.parse 已在上面单独处理成 EBADJSON）
      if (e instanceof AdapterError && e.code === 'EBADJSON') {
        if (o.fallback !== undefined) return o.fallback
        throw e
      }
      if (e && (e.code === 'FS_NOT_FOUND' || e.code === 'FS_NOT_TEXT')) {
        if (o.fallback !== undefined) return o.fallback
      }
      throw e // FS_SANDBOX_DENIED / FS_IO_ERROR / FS_STALE_VERSION / ROOT_UNKNOWN / BAD_ARG 仍显式抛
    }
  }

  // ---- 写（写后自动 invalidate）----
  _writePolicy(opts) {
    const p = (opts && opts.policy) || this._cfg.writePolicy
    if (p) return p
    // fs.sandboxMode === undefined → 无闸本地 fs：不传第 5 参（对齐 §5.1/§7 降级分支）
    if (this._fs && this._fs.sandboxMode === undefined) return undefined
    return { mode: 'danger-full-access' }
  }

  async writeJson(rootRef, rel, data, opts) {
    const o = opts || {}
    const target = await this._resolveTarget(rootRef, rel)
    const prev = await this._statOrNull(target)
    const text = JSON.stringify(data, null, 2)
    const policy = this._writePolicy(o)
    const args = [target, text, undefined, undefined]
    if (policy !== undefined) args.push(policy)
    await this._fs.writeText(...args)
    const key = this._cacheKey(target)
    if (key) this._cache.delete(key)
    const after = await this._statOrNull(target)
    return { ok: true, operation: prev ? 'update' : 'create', version: after && after.version !== undefined ? after.version : undefined }
  }

  async writeText(rootRef, rel, content, opts) {
    const o = opts || {}
    const target = await this._resolveTarget(rootRef, rel)
    const prev = await this._statOrNull(target)
    const policy = this._writePolicy(o)
    const args = [target, content, undefined, undefined]
    if (policy !== undefined) args.push(policy)
    await this._fs.writeText(...args)
    const key = this._cacheKey(target)
    if (key) this._cache.delete(key)
    const after = await this._statOrNull(target)
    return { ok: true, operation: prev ? 'update' : 'create', version: after && after.version !== undefined ? after.version : undefined }
  }

  // ---- 缓存（A6）----
  // key 省略 = 全清；否则支持三种写法：'root:rel'（§3.2 契约写法，root 为登记根名或默认根）、绝对路径、或路径片段
  invalidate(key) {
    if (key === undefined || key === null) { this._cache.clear(); return }
    const raw = String(key)
    const needles = new Set([norm(raw)])
    const i = raw.indexOf(':')
    if (i > 0 && !/^[A-Za-z]:[\\/]/.test(raw)) {
      // 'root:rel' → 实际盘上路径（同步解析：根表是普通映射，无需 async）
      const rootName = raw.slice(0, i)
      const rel = raw.slice(i + 1)
      let rootPath = this._roots[rootName]
      if (rootPath === undefined) {
        const def = this._defaultRootPath()
        if (def !== null) rootPath = (this._roots[def] !== undefined) ? this._roots[def] : def
      }
      if (rootPath) needles.add(norm(String(rootPath).replace(/[\\/]+$/, '') + '/' + rel))
    }
    for (const k of Array.from(this._cache.keys())) {
      const nk = norm(k)
      for (const n of needles) {
        if (nk.includes(n)) { this._cache.delete(k); break }
      }
    }
  }

  // ---- 内部（禁业务直用）----
  _target(rootRef, rel) { return this._resolveTarget(rootRef, rel) }
}
