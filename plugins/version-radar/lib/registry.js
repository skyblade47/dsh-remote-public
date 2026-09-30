// @local/version-radar —— registry.js：出网层的**唯一**入口
// 职责：只取 npm packument 的 `dist-tags`，并带**体积上限 + 超时 + fail-closed**。
//
// 纪律落地（spec §6-5 / §6-6）：
//   · 只取 dist-tags：解析后只返回 latest/next/alpha，**不把 versions 带进进程**。
//   · 体积上限：默认 256 KB；超限**中途断流**（reader.cancel）并抛错 → 转 ok:false。
//   · 超时：默认 8 s，用 `AbortSignal.timeout()`（**不用 setTimeout**，避免启动期定时器纪律问题）。
//   · fail-closed：任何失败都返回 { ok:false, error }，**绝不**返回"有更新"。
//   · 可注入：fetchImpl（测试注入假 fetch ⇒ **不联网**）。
//
// ⚠️ 本文件不含 token / cookie / 带凭据的 URL：只请求公开 npm registry。

const DEFAULT_REGISTRY = 'registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_MAX_BYTES = 256 * 1024
const PACKUMENT_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh'
const TAGS = ['latest', 'next', 'alpha']

/** 读响应体，带**硬体积上限**（超限中途断流，不整包读入） */
async function readTextCapped(res, maxBytes) {
  const tooLarge = (bytes) => {
    const e = new Error('RESPONSE_TOO_LARGE: ' + bytes + ' > ' + maxBytes)
    e.code = 'TOO_LARGE'
    return e
  }
  const body = res && res.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      const value = step.value || new Uint8Array(0)
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch (_) { /* 断流失败不影响判定 */ }
        throw tooLarge(total)
      }
      chunks.push(Buffer.from(value))
    }
    const buf = Buffer.concat(chunks)
    return { text: buf.toString('utf8'), bytes: buf.length }
  }
  if (typeof res.arrayBuffer === 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw tooLarge(buf.length)
    return { text: buf.toString('utf8'), bytes: buf.length }
  }
  const text = String(await res.text())
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) throw tooLarge(bytes)
  return { text, bytes }
}

/** 从 JSON 文本里只取 dist-tags（缺 latest 视为无意义 ⇒ fail-closed） */
function pickTags(text) {
  let doc
  try { doc = JSON.parse(text) } catch (e) { return { ok: false, error: 'BAD_JSON: ' + String((e && e.message) || e) } }
  const dt = doc && doc['dist-tags']
  if (!dt || typeof dt !== 'object') return { ok: false, error: 'NO_DIST_TAGS' }
  const out = {}
  for (const k of TAGS) out[k] = (typeof dt[k] === 'string' && dt[k]) ? dt[k] : null
  if (!out.latest) return { ok: false, error: 'NO_LATEST_TAG' }
  return { ok: true, distTags: out }
}

/**
 * 取上游 dsh 的 dist-tags。**全插件唯一的出网路径**。
 * @param {{ fetchImpl?: Function, timeoutMs?: number, maxBytes?: number, registry?: string, url?: string }} [opts]
 * @returns {Promise<{ok: boolean, registry: string, distTags: object|null, bytes: number, error: string|null}>}
 */
export async function fetchDistTags(opts) {
  const o = opts || {}
  const registry = String(o.registry || DEFAULT_REGISTRY)
  const url = String(o.url || PACKUMENT_URL)
  const timeoutMs = Number.isFinite(o.timeoutMs) ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxBytes = Number.isFinite(o.maxBytes) ? Number(o.maxBytes) : DEFAULT_MAX_BYTES
  const fetchImpl = (o.fetchImpl === undefined) ? globalThis.fetch : o.fetchImpl
  const fail = (error) => ({ ok: false, registry, distTags: null, bytes: 0, error: String(error) })
  if (typeof fetchImpl !== 'function') return fail('NO_FETCH')
  const signal = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  let res
  try {
    res = await fetchImpl(url, { method: 'GET', signal, headers: { accept: 'application/json' } })
  } catch (e) {
    const name = String((e && e.name) || '')
    if (name === 'TimeoutError') return fail('TIMEOUT:' + timeoutMs + 'ms')
    if (name === 'AbortError') return fail('ABORTED')
    return fail('FETCH_ERROR: ' + String((e && e.message) || e))
  }
  if (!res || res.ok !== true) return fail('HTTP_' + String((res && res.status) != null ? res.status : 'NO_RESPONSE'))
  let read
  try {
    read = await readTextCapped(res, maxBytes)
  } catch (e) {
    const code = (e && e.code) === 'TOO_LARGE' ? 'TOO_LARGE' : 'READ_ERROR'
    return fail(code + ': ' + String((e && e.message) || e))
  }
  const picked = pickTags(read.text)
  if (!picked.ok) return fail(picked.error)
  return { ok: true, registry, distTags: picked.distTags, bytes: read.bytes, error: null }
}

export { DEFAULT_MAX_BYTES, DEFAULT_REGISTRY, DEFAULT_TIMEOUT_MS, PACKUMENT_URL }
