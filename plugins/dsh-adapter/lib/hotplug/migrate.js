// @local/dsh-adapter —— 旧 sandbox 数据的一次性迁移
//
// 迁移范围（spec §3.3）：
//   sandbox-manifest.yml → hotplug-manifest.yml   （字段格式完全相同，直接搬运）
//   sandbox-state.json   → 丢弃（纯运行时状态，重启即失效，无迁移价值）
//   logs/sandbox-audit.jsonl → 保留为历史，不改写（新审计写 hotplug-audit.jsonl）
//
// 迁移策略：**不改旧文件内容**，只在成功后加 `.migrated` 后缀留档。
// 这样即使新实现有问题，旧文件仍在原地可回滚，且"搬没搬过"一眼可查。

import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseYml } from './manifest-store.js'

export const LEGACY_MANIFEST = 'sandbox-manifest.yml'
export const LEGACY_STATE = 'sandbox-state.json'
export const LEGACY_AUDIT = 'logs/sandbox-audit.jsonl'

/**
 * 读旧 manifest 的条目（供 manifestStore.load 作为 defaults 落盘）。
 * 只有在"新文件尚不存在"时才返回值——否则会覆盖用户已在新文件里的改动。
 * @returns {{entries:Array, legacyPath:string}|null}
 */
export function readLegacyManifestEntries(dshHome, newManifestPath) {
  try {
    const legacyPath = join(dshHome, LEGACY_MANIFEST)
    if (!existsSync(legacyPath)) return null
    if (newManifestPath && existsSync(newManifestPath)) return null
    const parsed = parseYml(readFileSync(legacyPath, 'utf8'))
    const entries = (parsed.entries || []).filter((e) => e && e.id && e.path)
    if (!entries.length) return null
    return { entries, legacyPath }
  } catch (_) {
    return null
  }
}

/** 迁移成功后给旧文件加后缀留档（失败不影响启动） */
export function markLegacyMigrated(legacyPath) {
  try {
    if (!existsSync(legacyPath)) return false
    const dest = legacyPath + '.migrated'
    if (existsSync(dest)) return false
    renameSync(legacyPath, dest)
    return true
  } catch (_) {
    return false
  }
}

/** 迁移前置盘点（写入审计，便于事后对账"到底搬了什么"） */
export function inspectLegacy(dshHome) {
  const out = {}
  for (const rel of [LEGACY_MANIFEST, LEGACY_STATE, LEGACY_AUDIT]) {
    const p = join(dshHome, rel)
    try {
      out[rel] = existsSync(p) ? { exists: true, size: statSync(p).size } : { exists: false }
    } catch (_) {
      out[rel] = { exists: false, error: 'stat failed' }
    }
  }
  return out
}
