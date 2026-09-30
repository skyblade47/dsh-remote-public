// @local/dsh-adapter —— 重启自恢复：幂等状态（默认 `$DSH_HOME/users/resume-state.json`）
//
// 迁入来源：`plugins/resume-on-boot/lib/state.js`（P3 Phase 1 骨架，逻辑与语义保持不变）。
// 设计 §8.2：「幂等：同一"未结束"状态只唤醒一次」。
//
// 三条从本项目既有插件继承的纪律（不是新发明）：
//   1. **写失败静默降级为内存态**——沿用 adapter `manifest-store.js` 的做法：
//      状态落盘失败绝不该让内核起不来；但要在 `degraded` 上留痕，供审计暴露。
//   2. **失败不得写状态**——唤醒失败时若已写幂等键，就会**永不重试**（静默丢任务）。
//      所以 API 只提供 `markResumed()`，由调用方在**成功之后**调用，本类不提供"预先占位"。
//   3. 路径可由配置覆盖（`adapter.resume.statePath`），默认落在 `$DSH_HOME/users/`。
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 默认落盘路径：`<DSH_HOME>/users/resume-state.json`（DSH_HOME 未设时退回 cwd/dsh-data，与全仓口径一致） */
export function resolveStatePath(env) {
  const e = env || process.env
  const home = String((e && e.DSH_HOME) || '').trim()
  const base = home || join(resolve('.'), 'dsh-data')
  return join(base, 'users', 'resume-state.json')
}

/** 由已推导出的 DSH_HOME 直接给出状态文件路径（adapter apply 里用的是这条，避免再读一次 env） */
export function statePathForHome(dshHome) {
  const home = String(dshHome || '').trim()
  return home ? join(home, 'users', 'resume-state.json') : resolveStatePath()
}

export class ResumeState {
  /**
   * @param {object} opts
   * @param {string} [opts.path]  状态文件路径（默认按 DSH_HOME 推导）
   * @param {object} [opts.log]   最小日志器 { warn(msg, extra), info(msg, extra) }
   */
  constructor({ path, log } = {}) {
    this.path = path || resolveStatePath()
    this.log = log || { warn() {}, info() {} }
    this.records = {} // sessionId -> { key, at, signal, note }
    this.degraded = false // 落盘失败时置位（内存态继续工作）
    this.loaded = false
  }

  /** 容错加载：文件缺失/损坏一律视为空，绝不抛（损坏时另存为 .corrupt 以便取证） */
  load() {
    this.loaded = true
    if (!existsSync(this.path)) return { ok: true, entries: 0, fresh: true }
    let raw
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (e) {
      this.degraded = true
      this.log.warn('resume-state 读取失败，按空态继续', { path: this.path, error: String(e && e.message || e) })
      return { ok: false, entries: 0, error: 'READ_FAILED' }
    }
    try {
      const parsed = JSON.parse(raw)
      const recs = parsed && typeof parsed === 'object' && parsed.records && typeof parsed.records === 'object'
        ? parsed.records
        : {}
      this.records = recs
      return { ok: true, entries: Object.keys(recs).length, fresh: false }
    } catch (e) {
      // 损坏：留证后从空态继续（不让一个坏文件永久阻断恢复）
      try { writeFileSync(this.path + '.corrupt', raw, 'utf8') } catch (_) {}
      this.records = {}
      this.log.warn('resume-state 损坏，已另存 .corrupt 并按空态继续', { path: this.path, error: String(e && e.message || e) })
      return { ok: false, entries: 0, error: 'PARSE_FAILED' }
    }
  }

  /** 是否已处理过"这一次未结束"（D3：键含 turn/sub 标识，不是只有 sessionId） */
  isResumed(sessionId, key) {
    const rec = this.records[sessionId]
    return !!(rec && rec.key === key)
  }

  /**
   * 标记已唤醒成功。**只在成功之后调用**（见文件头纪律 2）。
   * @returns {boolean} 是否落盘成功（失败时仍更新内存态并置 degraded）
   */
  markResumed(sessionId, key, { signal, note } = {}) {
    if (!sessionId || !key) return false
    this.records[sessionId] = { key, at: Date.now(), signal: signal || null, note: note || '' }
    return this._persist()
  }

  /** 清理过期记录（默认 30 天） */
  prune({ maxAgeMs = 30 * 24 * 3600 * 1000, now = Date.now() } = {}) {
    let removed = 0
    for (const [id, rec] of Object.entries(this.records)) {
      if (!rec || !Number.isFinite(rec.at) || now - rec.at > maxAgeMs) {
        delete this.records[id]
        removed++
      }
    }
    if (removed) this._persist()
    return removed
  }

  summary() {
    return {
      path: this.path,
      entries: Object.keys(this.records).length,
      degraded: this.degraded,
      loaded: this.loaded,
    }
  }

  /** tmp → rename 原子写；失败回退直接覆盖；再失败则降级为内存态（不抛） */
  _persist() {
    const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records: this.records }, null, 2)
    const tmp = this.path + '.tmp-' + process.pid
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(tmp, body, 'utf8')
      try {
        renameSync(tmp, this.path)
      } catch (_) {
        // 跨设备/Windows 占用时 rename 可能失败 → 直接覆盖，再不行就降级
        writeFileSync(this.path, body, 'utf8')
        try { unlinkSync(tmp) } catch (_) {}
      }
      this.degraded = false
      return true
    } catch (e) {
      this.degraded = true
      try { unlinkSync(tmp) } catch (_) {}
      this.log.warn('resume-state 落盘失败，降级为内存态（内核继续运行）', { path: this.path, error: String(e && e.message || e) })
      return false
    }
  }
}
