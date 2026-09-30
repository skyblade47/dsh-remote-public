// @local/dsh-adapter —— ModuleGraphBuster 的纯逻辑核心
//
// 职责边界：只回答两个纯函数问题——
//   ① 这个模块 URL 是否属于"可 bust 范围"？
//   ② 若属于，应改写为哪个 URL？
// 不碰 node:module、不做 I/O ⇒ 可在任意 Node 版本上直接单测。
// 这是缺陷②（只 bust 入口、子模块仍在 ESM 缓存）修复的可验证基础：
// hook 只是把这两个纯函数接到模块解析链上，逻辑本身与宿主环境无关。
//
// 设计约束（spec §4.2，两条边界规则，由单测固化）：
//   规则 1：只 bust 插件自身根目录下的文件（最长前缀匹配）。
//   规则 2：绝不 bust node_modules 内的依赖——否则同一依赖会复制 N 份，且可能破坏单例语义
//           （典型受害者是 cordis 自身的 Context 类）。

import { fileURLToPath } from 'node:url'

const GEN_PARAM = 'dshgen'
const FILE_SCHEME = 'file:'

// Windows 上同一文件可能出现大小写不同的盘符（file:///E:/ 与 file:///e:/），
// 而 URL 字符串比较是大小写敏感的 ⇒ 需要按平台决定比较方式。
const CASE_INSENSITIVE = process.platform === 'win32'

// 去掉 URL 的 query/hash，得到"干净"的 URL。用于前缀比较与幂等改写。
export function stripUrlNoise(url) {
  if (typeof url !== 'string') return url
  const q = url.indexOf('?')
  const h = url.indexOf('#')
  let cut = -1
  if (q >= 0 && h >= 0) cut = Math.min(q, h)
  else if (q >= 0) cut = q
  else if (h >= 0) cut = h
  return cut < 0 ? url : url.slice(0, cut)
}

// 拆出 { base, query, hash } 三段，便于幂等改写 dshgen。
function splitUrl(url) {
  const base = stripUrlNoise(url)
  const hIdx = url.indexOf('#')
  const hash = hIdx >= 0 ? url.slice(hIdx) : ''
  const qIdx = url.indexOf('?')
  let query = ''
  if (qIdx >= 0) {
    const end = hIdx > qIdx ? hIdx : url.length
    query = url.slice(qIdx + 1, end)
  }
  return { base, query, hash }
}

// 读取 URL 上已有的 dshgen 值；无则返回 null。
export function readGen(url) {
  if (typeof url !== 'string') return null
  const { query } = splitUrl(url)
  if (!query) return null
  for (const part of query.split('&')) {
    if (part.startsWith(GEN_PARAM + '=')) return part.slice(GEN_PARAM.length + 1)
  }
  return null
}

// 改写 dshgen（保留其余 query 参数与 hash）；gen 为 0/null 时表示"去掉代次"。
function writeGen(url, gen) {
  const { base, query, hash } = splitUrl(url)
  const kept = query.split('&').filter(Boolean).filter((p) => !p.startsWith(GEN_PARAM + '='))
  if (gen) kept.push(GEN_PARAM + '=' + gen)
  if (!kept.length) return base + hash
  return base + '?' + kept.join('&') + hash
}

/**
 * file: URL → 平台文件系统路径（Windows 得 C:\x\y，POSIX 得 /x/y）。
 * 用 fileURLToPath 而不是手工 slice：手写剥前缀在 `file:///C:/...` 上会得到
 * `///C:/...`（多两个斜杠），Windows 下 statSync 直接失败——落盘证据会全变成
 * mtime=0/size=0/hash='' 的假记录。这是实测踩到的坑，不要再退回手工切片。
 * 仅用于**记录与展示**；路径比较请走下面的 matchRoot（内部做分隔符归一）。
 */
export function urlToFsPath(url) {
  if (typeof url !== 'string' || !url.startsWith(FILE_SCHEME)) return null
  try { return fileURLToPath(stripUrlNoise(url)) } catch (_) { return null }
}

// 比较用归一：统一分隔符 + 按平台决定大小写。
function cmpPath(p) {
  const s = p.replace(/\\/g, '/')
  return CASE_INSENSITIVE ? s.toLowerCase() : s
}

// 规则 2 的实现：node_modules 内一律不 bust。
export function isInsideNodeModules(url) {
  const p = urlToFsPath(url)
  if (p === null) return false
  const s = cmpPath(p)
  return s.includes('/node_modules/') || s.endsWith('/node_modules')
}

/**
 * 是否属于"可 bust 范围"。
 * 只接受 file: URL——bare specifier 与 node: 内建模块的解析结果不应被改写。
 */
export function isBustable(url) {
  if (typeof url !== 'string') return false
  if (!url.startsWith(FILE_SCHEME)) return false
  if (isInsideNodeModules(url)) return false
  return true
}

/**
 * 最长前缀匹配插件根。
 * @param {string} url 模块 URL（可含 query）
 * @param {Array<{id:string, rootUrl:string, gen:number}>} roots
 * @returns {{id:string, rootUrl:string, gen:number, rootPath:string}|null}
 */
export function matchRoot(url, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return null
  const target = urlToFsPath(url)
  if (target === null) return null
  const cmpTarget = cmpPath(target)
  let best = null
  for (const r of roots) {
    if (!r || typeof r.rootUrl !== 'string') continue
    const rootPath = urlToFsPath(r.rootUrl)
    if (rootPath === null) continue
    // 去掉尾部斜杠，避免 'root//a' 这种拼接
    const trimmed = cmpPath(rootPath).replace(/\/+$/, '')
    if (!trimmed) continue
    // 边界判定：完全相同，或以 rootPath + '/' 开头。
    // 用 '/' 收尾是为了避免 '/a/bc' 被 '/a/b' 误匹配。
    const hit = cmpTarget === trimmed || cmpTarget.startsWith(trimmed + '/')
    if (!hit) continue
    if (!best || trimmed.length > best.rootPath.length) {
      best = { id: r.id, rootUrl: r.rootUrl, gen: r.gen, rootPath: trimmed }
    }
  }
  return best
}

/**
 * 核心改写：给定模块 URL 与根表，返回应使用的 URL。
 * 幂等：当前代次已一致时原样返回（避免制造无意义的 URL 抖动）。
 */
export function applyGen(url, roots) {
  if (!isBustable(url)) return url
  const hit = matchRoot(url, roots)
  if (!hit) return url
  const want = hit.gen ? String(hit.gen) : null
  const cur = readGen(url)
  if (want === null) {
    // 该根当前无代次：若 URL 上残留旧代次则清掉，否则原样
    return cur === null ? url : writeGen(url, null)
  }
  if (cur === want) return url
  return writeGen(url, want)
}

export const GEN_QUERY_PARAM = GEN_PARAM
