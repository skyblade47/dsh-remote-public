// lib/audit.js — taskkit 审计日志模块
// 双格式 JSONL + 人类可读文本，5MB 大小轮转保留 3 份，ERROR 级桥接 cordis logger
// 防御性原则：自身永不 throw，所有内部错误静默 catch

import { writeFileSync, appendFileSync, statSync, existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_BACKUPS = 3
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

function pad(str, len) {
  str = String(str)
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length)
}

export class AuditLogger {
  constructor(ctx) {
    this.ctx = ctx
    this.enabled = false
    this.toolCount = 0
    try {
      const dshHome = process.env.DSH_HOME || ''
      const logsDir = dshHome ? join(dshHome, 'logs') : join(process.cwd(), 'logs')
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
      this.jsonlPath = join(logsDir, 'taskkit-audit.jsonl')
      this.textPath = join(logsDir, 'taskkit-audit.log')
      this.enabled = true
    } catch (e) {
      // 静默：构造失败不阻断插件
      this.enabled = false
    }
  }

  _rotate(filePath) {
    try {
      if (!existsSync(filePath)) return
      const stat = statSync(filePath)
      if (stat.size < MAX_FILE_SIZE) return
      // .2 → .3 (覆盖), .1 → .2, current → .1
      for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
        const older = filePath + '.' + i
        const newer = filePath + '.' + (i + 1)
        if (existsSync(older)) {
          try { renameSync(older, newer) } catch (e) {}
        }
      }
      try { renameSync(filePath, filePath + '.1') } catch (e) {}
    } catch (e) { /* 静默 */ }
  }

  _formatText(entry) {
    const ts = entry.ts || new Date().toISOString()
    const level = pad(entry.level || 'INFO', 5)
    const cat = pad(entry.category || '', 14)
    const evt = pad(entry.event || '', 20)
    let line = `[${ts}] ${level} [${cat}] ${evt} ${entry.message || ''}`
    if (entry.sessionId) line += ` (session=${entry.sessionId})`
    if (entry.extra && Object.keys(entry.extra).length > 0) {
      const pairs = Object.entries(entry.extra).map(([k, v]) => `${k}=${v}`).join(', ')
      line += ` {${pairs}}`
    }
    return line + '\n'
  }

  log({ level, category, event, message, sessionId, extra }) {
    if (!this.enabled) return
    try {
      const entry = {
        ts: new Date().toISOString(),
        level: level || 'INFO',
        category: category || '',
        event: event || '',
        plugin: 'taskkit',
        sessionId: sessionId || null,
        message: message || '',
        extra: extra || {}
      }

      // 1. 写 JSONL
      this._rotate(this.jsonlPath)
      appendFileSync(this.jsonlPath, JSON.stringify(entry) + '\n', 'utf8')

      // 2. 写人类可读文本
      this._rotate(this.textPath)
      appendFileSync(this.textPath, this._formatText(entry), 'utf8')

      // 3. 统计工具数
      if (event === 'tool.registered') this.toolCount++

      // 4. ERROR 级桥接 cordis logger
      if (level === 'ERROR') {
        try {
          const logger = this.ctx.get('logger')
          if (logger && typeof logger.error === 'function') {
            logger.error(`[taskkit:audit] ${message || event}`)
          }
        } catch (e) { /* logger 不可用，静默 */ }
      }
    } catch (e) {
      // 最终防线：审计写入任何失败都不阻断 taskkit 主流程
    }
  }

  close() {
    // 无流需要 flush（appendFileSync 是同步的），此方法为接口预留
    try {
      this.log({ level: 'INFO', category: 'lifecycle', event: 'plugin.dispose', message: 'taskkit plugin disposed' })
    } catch (e) {}
  }

  /**
   * 读取尾部审计日志（从 JSONL 文件）。支持按级别 / 分类 / 关键词过滤。
   * @param {{tail?:number,minLevel?:string,category?:string,q?:string,kw?:string}} opts
   * @returns {Array<any>}
   */
  tail(opts = {}) {
    const tail = Math.max(1, opts.tail ? (opts.tail | 0) : 200)
    const LEVEL_RANK = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 }
    const rank = LEVEL_RANK[opts.minLevel] || 0
    const category = opts.category || null
    const kw = (opts.kw || opts.q || '').toString().trim() || null
    const lines = this._readTailLines(this.jsonlPath, tail * 3)
    const results = []
    const seen = new Set()
    for (const line of lines) {
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (!e || !e.ts) continue
      if (rank && LEVEL_RANK[e.level] && LEVEL_RANK[e.level] < rank) continue
      if (category && e.category !== category) continue
      if (kw) {
        const hay = ((e.event || '') + ' ' + (e.message || '') + ' ' + (e.plugin || '') + ' ' + (e.sessionId || '') + ' ' + JSON.stringify(e.extra || {})).toLowerCase()
        if (!hay.includes(kw.toLowerCase())) continue
      }
      const key = e.ts + '|' + (e.event || '') + '|' + (e.message || '')
      if (seen.has(key)) continue
      seen.add(key); results.push(e)
    }
    results.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    return results.slice(-tail)
  }
  

  _readTailLines(path, n) {
    if (!path || !existsSync(path)) return []
    try {
      const buf = readFileSync(path, 'utf8');
      const NL = String.fromCharCode(10);
      const CR = String.fromCharCode(13);
      const arr = buf.toString().split(NL).map(s => (s.endsWith(CR) ? s.slice(0, -1) : s)).filter(Boolean);
      return arr.slice(-Math.max(1, (n | 0)));
    } catch (_) { return [] }
  }
}
