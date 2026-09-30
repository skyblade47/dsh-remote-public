// @local/version-radar —— audit.js：审计落盘（<DSH_HOME>/logs/version-radar-audit.jsonl）
//
// 纪律落地：
//   · 写审计失败**不阻断**主流程（spec §5.3）：一律 try/catch 后返回 { ok:false, error }，由调用方告警。
//   · **不含 token / cookie / 凭据**：payload 只由本文件的白名单组装（buildPayload），
//     调用方传进来的原始对象（可能含 headers / config）**永远不直接序列化**。
//   · 事件名冻结（spec §5.3）：version.check.trigger / version.check.done / version.check.error。

import fsDefault from 'node:fs'
import { join, dirname } from 'node:path'

const EVENTS = Object.freeze({
  TRIGGER: 'version.check.trigger',
  DONE: 'version.check.done',
  ERROR: 'version.check.error',
})

/** 默认审计文件：<DSH_HOME>/logs/version-radar-audit.jsonl */
export function defaultAuditPath(env) {
  const e = env || process.env || {}
  const home = String(e.DSH_HOME || '').trim() || '/srv/dsh-home'
  return join(home, 'logs', 'version-radar-audit.jsonl')
}

/** 只取白名单字段（**绝不含** token / cookie / authorization / headers / config） */
function buildPayload(event, payload) {
  const p = payload || {}
  if (event === EVENTS.TRIGGER) return { via: (p.via === 'http' ? 'http' : 'tool'), at: String(p.at || '') }
  if (event === EVENTS.ERROR) return { reason: String(p.reason || 'unknown'), at: String(p.at || '') }
  const u = p.upstream || {}
  const supported = (v) => (v === true ? true : (v === false ? false : null))
  return {
    host: (p.host && typeof p.host === 'object') ? { version: p.host.version, source: p.host.source } : null,
    upstream: {
      ok: u.ok === true,
      registry: u.registry || null,
      distTags: { latest: u.latest || null, next: u.next || null, alpha: u.alpha || null },
    },
    thirdParty: Array.isArray(p.thirdParty)
      ? p.thirdParty.map((t) => ({ name: String((t && t.name) || ''), installed: (t && t.installed) || null, supported: supported(t && t.supported) }))
      : [],
    verdict: String(p.verdict || 'unknown'),
    sources: Array.isArray(p.sources) ? p.sources.map((s) => String(s)) : [],
    at: String(p.at || ''),
  }
}

/**
 * 追加一条审计（**不抛**）。
 * @param {{ fs?: object, file?: string, env?: object, event: string, payload?: object, at?: string }} opts
 * @returns {{ ok: boolean, file: string, bytes: number, error: string|null }}
 */
export function appendAudit(opts) {
  const o = opts || {}
  const fs = o.fs || fsDefault
  const file = String(o.file || defaultAuditPath(o.env))
  const at = String(o.at || new Date().toISOString())
  const event = String(o.event || '')
  if (!Object.values(EVENTS).includes(event)) return { ok: false, file, bytes: 0, error: 'UNKNOWN_EVENT:' + event }
  let line
  try {
    line = JSON.stringify({ event, payload: buildPayload(event, Object.assign({}, o.payload, { at })) }) + '\n'
  } catch (e) {
    return { ok: false, file, bytes: 0, error: 'SERIALIZE_FAIL: ' + String((e && e.message) || e) }
  }
  try {
    if (typeof fs.mkdirSync === 'function') fs.mkdirSync(dirname(file), { recursive: true })
    fs.appendFileSync(file, line, 'utf8')
    return { ok: true, file, bytes: Buffer.byteLength(line, 'utf8'), error: null }
  } catch (e) {
    return { ok: false, file, bytes: 0, error: 'WRITE_FAIL: ' + String((e && e.message) || e) }
  }
}

export { EVENTS }
