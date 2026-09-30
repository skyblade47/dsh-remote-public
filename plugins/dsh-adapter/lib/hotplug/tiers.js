// @local/dsh-adapter —— 三档可热替性判定（缺陷①的修复）
//
// 现状（sandbox）是一刀切：只要 manifest 里 builtin: true 就抛 RESTART_REQUIRED
// （_guardBuiltinHotplug，sandbox-service.js L418-428）。实测后果：wrpro 被误伤拒绝，
// 而同批 writing-studio（non-builtin）成功 —— 因为 builtin 表达的是**加载来源**（走 bundles），
// 不是**dispose 风险等级**。
//
// 真正的风险来源是：该条目的 fiber dispose 是否会牵动 bundles 复合层。据此分三档：
// 三档：
//   free    —— loader 顶层独立条目
//   guarded —— 位于复合层子树内：**权限与 free 相同**（四类操作全放行），差别只在
//              "每次操作都要过 §5.4 安全网"（超时熔断 + 单飞 + 前置 link-validate）
//              与"作为可观测信号"（标识该插件是 bundles 带进来的）
//   locked  —— 条目自身就是复合层容器（含子条目）：全部拒绝并明确要求重启
//
// 2026-09-22 决策：guarded 由"禁止 unload"改为"与 free 同权"。依据是 reload 的 Phase 1
// 本来就要在复合层子树内摘掉条目再重建，unload 只是少了重建一步，风险面同源 ——
// 既然 reload 可用，单独禁止 unload 就没有依据。
//
// 关键差别（相对现状）：现状是"扫到了 builtin 就拒"，这里是"扫到了先判档，再按档放行"。

import { findAllMatchingEntries } from './tree-ops.js'
import { HotplugError, HotplugCode } from './errors.js'

export const Tier = Object.freeze({ FREE: 'free', GUARDED: 'guarded', LOCKED: 'locked' })

const ALL_OPS = ['load', 'unload', 'swap', 'reload']
const OPS = Object.freeze({
  [Tier.FREE]: ALL_OPS,
  [Tier.GUARDED]: ALL_OPS,
  [Tier.LOCKED]: [],
})

/** 该档位是否需要走完整安全网（超时熔断 + 单飞 + 前置校验） */
export function needsSafetyNet(tier) {
  return tier === Tier.GUARDED
}

export function allowedOps(tier) {
  return OPS[tier] ? OPS[tier].slice() : []
}

// 条目自身是否是"复合层容器"：有非空 store 即视为容器。
// 叶子条目即使带 store 也是空的 ⇒ 不会误判；反向误判（真容器判成叶子）才会出事，
// 所以这里宁可保守：有子条目就判容器。
function isContainer(entry) {
  try {
    if (!entry || !entry.store || typeof entry.store !== 'object') return false
    return Object.keys(entry.store).length > 0
  } catch (_) {
    return false
  }
}

/**
 * 判定某个 id 当前的可热替档位。
 * @returns {{id:string, tier:string, reason:string, path:string|null, depth:number|null, matchCount:number}}
 */
export function classify(id, tree) {
  if (!tree || !tree.store) {
    return { id, tier: Tier.LOCKED, reason: 'loader tree 不可用，无法判定档位', path: null, depth: null, matchCount: 0 }
  }
  const matches = findAllMatchingEntries(tree, id)
  if (!matches.length) {
    // 尚未在树中：load 走顶层 tree.create ⇒ 归 free。
    // （这与 sandbox 的"不在树中即 skip auto-load"不同，语义见 spec §5.2）
    return { id, tier: Tier.FREE, reason: '当前不在树中（load 将在顶层创建）', path: null, depth: null, matchCount: 0 }
  }

  // 顶层直接命中（depth=1，即 tree.store[<key>]）优先：这是最强的 free 信号
  const top = matches.find((m) => m.depth === 1)
  if (top) {
    if (isContainer(top.entry)) {
      return { id, tier: Tier.LOCKED, reason: '条目自身是复合层容器（含子条目）', path: top.path, depth: top.depth, matchCount: matches.length }
    }
    return { id, tier: Tier.FREE, reason: 'loader 顶层独立条目', path: top.path, depth: top.depth, matchCount: matches.length }
  }

  const nested = matches[0]
  if (isContainer(nested.entry)) {
    return { id, tier: Tier.LOCKED, reason: '条目自身是复合层容器（含子条目）', path: nested.path, depth: nested.depth, matchCount: matches.length }
  }
  return {
    id, tier: Tier.GUARDED,
    reason: `位于复合层子树内（${nested.path}）`,
    path: nested.path, depth: nested.depth, matchCount: matches.length,
  }
}

/**
 * 档位门禁：不允许时抛带具体理由的错误（不静默失败，spec §2 的"退让兜底"）。
 */
export function assertOpAllowed(tierInfo, op) {
  const allowed = allowedOps(tierInfo.tier)
  if (allowed.includes(op)) return

  if (tierInfo.tier === Tier.LOCKED) {
    throw new HotplugError(HotplugCode.HOTPLUG_TIER_LOCKED,
      `${op} 被拒绝：${tierInfo.id} 判为 locked（${tierInfo.reason}）；需重启宿主生效`,
      { extra: { ...tierInfo, op, allowed, fallback: 'host_restart' } })
  }
  throw new HotplugError(HotplugCode.HOTPLUG_TIER_LOCKED,
    `${op} 不被允许：${tierInfo.id}（tier=${tierInfo.tier}）`,
    { extra: { ...tierInfo, op, allowed } })
}

/** 批量判档（供 list / GET /adapter/api/hotplug 使用） */
export function classifyAll(tree, entries) {
  const out = []
  for (const e of entries || []) {
    if (!e || !e.id) continue
    out.push(classify(e.id, tree))
  }
  return out
}
