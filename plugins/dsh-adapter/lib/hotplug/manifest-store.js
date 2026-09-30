// @local/dsh-adapter —— 白名单 manifest（yml）内存镜像 + 原子回写
//
// 从 sandbox/lib/manifest-store.js 迁移。保留的关键设计：
//   · 所有写操作静默降级为"仅内存态"（Windows 上 EPERM/杀软锁定/fs-sandbox 拦截都真实出现过），
//     绝不向 apply() 抛错 —— 白名单落盘失败不该让宿主起不来。
//   · tmp→rename 原子写 + 失败回退直接覆盖 + 再失败标 degraded。
//
// 与 sandbox 的两点差异：
//   1. 文件名 hotplug-manifest.yml；写盘头注释同步改名。
//   2. **不再硬编码 builtin 白名单**（sandbox 把 taskkit/wrpro/lanr 写死为 builtin，见
//      sandbox/lib/index.js L156-160）。默认条目改由部署 config 提供；历史条目由
//      migrate.js 从旧 sandbox-manifest.yml 一次性搬过来。
//   `builtin` 字段保留，但语义收窄为"加载来源标记"（是否由 bundles 带进来），
//    **不再参与热替门禁** —— 门禁由 tiers.classify 按 loader 树实际位置判定。

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { HotplugError, HotplugCode } from './errors.js'

export function serializeYml(data) {
  let out = `# hotplug manifest (auto-generated, do not edit while dsh running)\n`
  out += `version: ${data.version}\n`
  out += `entries:\n`
  for (const e of data.entries) {
    out += `  - id: ${JSON.stringify(e.id)}\n`
    out += `    path: ${JSON.stringify(e.path)}\n`
    out += `    builtin: ${e.builtin ? 'true' : 'false'}\n`
    out += `    enabled: ${e.enabled ? 'true' : 'false'}\n`
    out += `    config: ${JSON.stringify(e.config || {})}\n`
  }
  return out
}

export function parseYml(text) {
  const lines = String(text || '').split(/\r?\n/)
  const data = { version: 1, entries: [] }
  let cur = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('version:')) {
      data.version = parseInt(line.slice('version:'.length).trim(), 10) || 1
    } else if (line === 'entries:') {
      // 段头，无内容
    } else if (line.startsWith('- id:')) {
      if (cur) data.entries.push(cur)
      cur = { id: _parseScalar(line.slice('- id:'.length).trim()) }
    } else if (line.startsWith('id:') && cur) {
      cur.id = _parseScalar(line.slice('id:'.length).trim())
    } else if (line.startsWith('path:') && cur) {
      cur.path = _parseScalar(line.slice('path:'.length).trim())
    } else if (line.startsWith('builtin:') && cur) {
      cur.builtin = line.slice('builtin:'.length).trim() === 'true'
    } else if (line.startsWith('enabled:') && cur) {
      cur.enabled = line.slice('enabled:'.length).trim() === 'true'
    } else if (line.startsWith('config:') && cur) {
      try { cur.config = JSON.parse(line.slice('config:'.length).trim() || '{}') } catch (_) { cur.config = {} }
    }
  }
  if (cur) data.entries.push(cur)
  return data
}

function _parseScalar(s) {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1)
  return s
}

export class ManifestStore {
  constructor(ymlPath) {
    this.ymlPath = ymlPath
    this._map = new Map()
    this._raw = { version: 1, entries: [] }
    this._degraded = false
    this._lastWriteErr = null
  }

  load(defaultEntries = []) {
    if (!existsSync(this.ymlPath)) {
      this._raw = { version: 1, entries: [...(defaultEntries || [])] }
      this._rebuildMap()
      // 首次不存在：落盘一份（失败则静默降级，不影响启动）
      try { this._atomicWrite() } catch (e) {
        this._degraded = true
        this._lastWriteErr = (e && e.message) || String(e)
      }
      try { this._fileMtime = statSync(this.ymlPath).mtimeMs } catch (_) {}
      return
    }
    try {
      this._raw = parseYml(readFileSync(this.ymlPath, 'utf8'))
      this._rebuildMap()
      try { this._fileMtime = statSync(this.ymlPath).mtimeMs } catch (_) {}
    } catch (eRead) {
      // 解析/读取失败：退回 defaults，但不抛
      this._raw = { version: 1, entries: [...(defaultEntries || [])] }
      this._rebuildMap()
      this._degraded = true
      this._lastWriteErr = 'parse/read: ' + ((eRead && eRead.message) || String(eRead))
    }
  }

  _rebuildMap() {
    this._map.clear()
    for (const e of this._raw.entries) {
      if (e && e.id) this._map.set(e.id, e)
    }
  }

  _safeWrite(path, content) {
    try {
      const tmp = path + '.tmp.' + Math.random().toString(36).slice(2, 8)
      try { writeFileSync(tmp, content, 'utf8') } catch (_) {
        writeFileSync(path, content, 'utf8')   // 写 tmp 失败：直接覆盖，放弃原子性
        return true
      }
      try { renameSync(tmp, path) } catch (_) {
        try { unlinkSync(tmp) } catch (__) {}
        writeFileSync(path, content, 'utf8')
      }
      return true
    } catch (eFinal) {
      this._degraded = true
      this._lastWriteErr = ((eFinal && eFinal.code) || 'WRITE_FAIL') + ': ' + ((eFinal && eFinal.message) || String(eFinal))
      return false
    }
  }

  _atomicWrite() {
    try {
      if (existsSync(this.ymlPath)) {
        try { writeFileSync(this.ymlPath + '.bak', readFileSync(this.ymlPath)) } catch (_) { /* 备份失败可忽略 */ }
      }
      this._safeWrite(this.ymlPath, serializeYml(this._raw))
    } catch (eOuter) {
      this._degraded = true
      this._lastWriteErr = ((eOuter && eOuter.code) || 'ATOMIC_FAIL') + ': ' + ((eOuter && eOuter.message) || String(eOuter))
    }
  }

  get(id) { return this._map.get(id) }
  has(id) { return this._map.has(id) }
  isAllowed(id) { const e = this._map.get(id); return !!e && e.enabled === true }
  list() { return Array.from(this._map.values()) }

  degradedInfo() {
    return { degraded: this._degraded, lastWriteErr: this._lastWriteErr, path: this.ymlPath }
  }

  add(entry) {
    if (this._map.has(entry.id)) {
      throw new HotplugError(HotplugCode.DUPLICATE_ID, `id 已存在: ${entry.id}`, { extra: { id: entry.id } })
    }
    if (!entry.path) {
      throw new HotplugError(HotplugCode.INVALID_PATH, 'path 为空', { extra: { id: entry.id } })
    }
    const normalized = {
      id: entry.id,
      path: entry.path,
      config: entry.config || {},
      builtin: entry.builtin === true,   // 仅作"加载来源"标记，不参与门禁
      enabled: entry.enabled !== false,
    }
    this._raw.entries.push(normalized)
    this._map.set(normalized.id, normalized)
    this._atomicWrite()
    return normalized
  }

  remove(id) {
    if (!this._map.has(id)) {
      throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    }
    this._map.delete(id)
    this._raw.entries = this._raw.entries.filter((e) => e.id !== id)
    this._atomicWrite()
  }

  update(id, patch) {
    const e = this._map.get(id)
    if (!e) {
      throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    }
    Object.assign(e, patch)
    this._atomicWrite()
    return e
  }

  /** 运行时热加载：外部改了 yml 不重启也能生效（按 mtime 探测） */
  refreshIfChanged() {
    try {
      if (!existsSync(this.ymlPath)) return false
      const m = statSync(this.ymlPath).mtimeMs
      if (this._fileMtime !== undefined && m > this._fileMtime) {
        this._raw = parseYml(readFileSync(this.ymlPath, 'utf8'))
        this._rebuildMap()
        this._fileMtime = m
        return true
      }
    } catch (_) { /* 探测失败不算错误 */ }
    return false
  }
}
