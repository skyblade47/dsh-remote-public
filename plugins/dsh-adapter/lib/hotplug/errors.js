// @local/dsh-adapter —— 热拔插错误类型与错误码
// 参照 sandbox/lib/errors.js 的形状（code + extra + httpStatusFor），但码表按本设计重划：
//   - 新增 HOTPLUG_LINK_INVALID：Phase 0 link-validate 拦截（缺陷③修复的对外信号）
//   - 新增 HOTPLUG_ROLLBACK_OK / FAILED：Phase 2 旧代次自愈的结果
//   - 新增 HOTPLUG_TIER_LOCKED：三档判定里 locked 档的明确拒绝（缺陷①修复的对外信号）
//   - 新增 BUSTER_UNAVAILABLE：跨 Node 版本自检失败后的"退让兜底"信号（不静默失败）

export class HotplugError extends Error {
  constructor(code, message, { cause, extra } = {}) {
    super(message || code)
    this.name = 'HotplugError'
    this.code = code
    if (cause !== undefined) this.cause = cause
    this.extra = extra || {}
  }
}

export const HotplugCode = Object.freeze({
  // 底座可用性
  TREE_UNAVAILABLE: 'TREE_UNAVAILABLE',
  BUSTER_UNAVAILABLE: 'BUSTER_UNAVAILABLE',
  // 门禁层
  NOT_WHITELISTED: 'NOT_WHITELISTED',
  WHITELIST_DISABLED: 'WHITELIST_DISABLED',
  DUPLICATE_ID: 'DUPLICATE_ID',
  INVALID_PATH: 'INVALID_PATH',
  INVALID_ARGS: 'INVALID_ARGS',
  // 状态层
  ALREADY_LOADED: 'ALREADY_LOADED',
  NOT_LOADED: 'NOT_LOADED',
  // 并发层
  OP_IN_FLIGHT: 'OP_IN_FLIGHT',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  // 执行层
  LOAD_FAILED: 'LOAD_FAILED',
  UNLOAD_FAILED: 'UNLOAD_FAILED',
  UNLOAD_FAILED_BUT_REMAINS: 'UNLOAD_FAILED_BUT_REMAINS',
  // 热替专用
  HOTPLUG_LINK_INVALID: 'HOTPLUG_LINK_INVALID',
  HOTPLUG_ROLLBACK_OK: 'HOTPLUG_ROLLBACK_OK',
  HOTPLUG_ROLLBACK_FAILED: 'HOTPLUG_ROLLBACK_FAILED',
  HOTPLUG_TIER_LOCKED: 'HOTPLUG_TIER_LOCKED',
  // 退让兜底
  RESTART_REQUIRED: 'RESTART_REQUIRED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

export const httpStatusFor = (code) => {
  const map = {
    [HotplugCode.TREE_UNAVAILABLE]: 503,
    [HotplugCode.BUSTER_UNAVAILABLE]: 503,
    [HotplugCode.NOT_WHITELISTED]: 403,
    [HotplugCode.WHITELIST_DISABLED]: 403,
    [HotplugCode.DUPLICATE_ID]: 409,
    [HotplugCode.INVALID_PATH]: 400,
    [HotplugCode.INVALID_ARGS]: 400,
    [HotplugCode.ALREADY_LOADED]: 409,
    [HotplugCode.NOT_LOADED]: 404,
    [HotplugCode.OP_IN_FLIGHT]: 409,
    [HotplugCode.LOCK_TIMEOUT]: 408,
    [HotplugCode.LOAD_FAILED]: 424,
    [HotplugCode.UNLOAD_FAILED]: 424,
    [HotplugCode.UNLOAD_FAILED_BUT_REMAINS]: 424,
    [HotplugCode.HOTPLUG_LINK_INVALID]: 422,
    [HotplugCode.HOTPLUG_ROLLBACK_OK]: 424,
    [HotplugCode.HOTPLUG_ROLLBACK_FAILED]: 500,
    [HotplugCode.HOTPLUG_TIER_LOCKED]: 409,
    [HotplugCode.RESTART_REQUIRED]: 409,
    [HotplugCode.INTERNAL_ERROR]: 500,
  }
  return map[code] || 500
}

export const err = (code, message, opts) => new HotplugError(code, message, opts)
