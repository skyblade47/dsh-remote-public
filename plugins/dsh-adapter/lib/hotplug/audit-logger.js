// @local/dsh-adapter —— 热拔插审计日志（jsonl 追加）
//
// 从 sandbox/lib/index.js 的 _SandboxAuditLogger 迁移。保留其独立于业务插件的生命周期
// （不随 taskkit 等 dispose 而失效），仅把文件名与目录改为 hotplug-*。
//
// 与旧 sandbox-audit.jsonl 的关系：旧文件**保留为历史不改写**，新审计写新文件。
// 这样"迁移"不会污染历史证据链，对账时两段各自完整。

import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LEVEL_RANK = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }

export class HotplugAuditLogger {
  /**
   * @param {object} opts
   * @param {string} [opts.dshHome] 默认 `<DSH_HOME>`（未给则退回 process.env.DSH_HOME → cwd/dsh-data）
   * @param {string} [opts.fileName] 审计文件名；默认 `hotplug-audit.jsonl`。
   *   P3 重启自恢复复用同一个落盘器写 `resume-audit.jsonl`（形状同款，事件名 `resume.*`），
   *   两份审计回答不同问题（"谁改了哪个插件" / "重启后唤醒了谁"），故分文件而不混写。
   */
  constructor({ dshHome, fileName } = {}) {
    this.enabled = false
    this.jsonlPath = null
    try {
      const base = dshHome || process.env.DSH_HOME || join(process.cwd(), 'dsh-data')
      const logsDir = join(base, 'logs')
      try { mkdirSync(logsDir, { recursive: true }) } catch (_) {}
      this.jsonlPath = join(logsDir, fileName || 'hotplug-audit.jsonl')
      this.enabled = true
    } catch (_) {
      this.enabled = false
    }
  }

  log(rec) {
    if (!this.enabled) return
    try {
      const entry = Object.assign({}, rec, {
        ts: rec.ts || new Date().toISOString(),
        level: rec.level || 'INFO',
        category: rec.category || 'hotplug',
        plugin: 'dsh-adapter',
        extra: rec.extra || {},
      })
      try { appendFileSync(this.jsonlPath, JSON.stringify(entry) + '\n', 'utf8') } catch (_) { /* 追加失败不抛 */ }
    } catch (_) { /* 序列化失败不抛 */ }
  }

  /** 读回最近 N 条，支持级别/关键字过滤（设置界面的审计面板用） */
  tail(opts = {}) {
    const tail = Math.max(1, (opts.tail | 0) || 200)
    const rank = LEVEL_RANK[opts.minLevel] || 0
    const category = opts.category || null
    const kw = String(opts.kw || opts.q || '').trim().toLowerCase() || null
    let lines = []
    try {
      lines = readFileSync(this.jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean)
    } catch (_) { return [] }

    const results = []
    const seen = new Set()
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (!e || !e.ts) continue
      if (rank && LEVEL_RANK[e.level] && LEVEL_RANK[e.level] < rank) continue
      if (category && e.category !== category) continue
      if (kw) {
        const hay = ((e.event || '') + ' ' + (e.message || '') + ' ' + (e.plugin || '') + ' ' + JSON.stringify(e.extra || {})).toLowerCase()
        if (!hay.includes(kw)) continue
      }
      const key = e.ts + '|' + (e.event || '') + '|' + (e.message || '')
      if (seen.has(key)) continue
      seen.add(key)
      results.push(e)
    }
    results.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    return results.slice(-tail)
  }

  info() { return { enabled: this.enabled, path: this.jsonlPath } }
}
