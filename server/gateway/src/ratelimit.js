// 登录限速器：滑动窗口**准入** + 失败累计后的**封禁退避**。
//
// 为什么两层都要（S1）：
//   只有滑动窗口不够 —— 窗口一过计数就清零，攻击者可以用"5 次/分钟"的低速永久撞库，
//   一天也能试 7200 次，而且永远不会触发上限。所以再加一层"打得多了就关门外"。
//
// 分工：
//   · check(ip)          准入判定。每个请求都过，防突发。
//   · recordFailure(ip)  凭据错误后调用，累计打击数；到阈值即封禁，时长指数增长。
//   · recordSuccess(ip)  登录成功后调用，清零（正常人自己也用得上）。
//
// 反向对照：**弱密码 / 用户名不存在 都算失败**，因为对攻击者而言它们都是"这一次没猜中"。
//
// 内存实现（网关单进程，无需分布式）。**重启即清空**是已知取舍：
// 网关重启本身需要更高权限、也不是高频动作，不构成绕过封禁的实用手段。
export function createRateLimiter({
  maxAttempts = 5,
  windowMs = 60_000,
  banAfterFailures = 10, // 累计失败达到多少次开始封禁
  baseBanMs = 60_000, // 首次封禁时长（1 分钟）
  maxBanMs = 24 * 60 * 60_000, // 封禁时长上限（24 小时）
} = {}) {
  const attempts = new Map() // ip -> [timestamp, ...]（滑动窗口）
  const strikes = new Map() // ip -> { failures, bans, bannedUntil }

  function clean(ip, now) {
    const list = attempts.get(ip)
    if (!list) return
    const filtered = list.filter((t) => now - t < windowMs)
    if (filtered.length === 0) attempts.delete(ip)
    else attempts.set(ip, filtered)
  }

  function state(ip) {
    let s = strikes.get(ip)
    if (!s) {
      s = { failures: 0, bans: 0, bannedUntil: 0 }
      strikes.set(ip, s)
    }
    return s
  }

  return {
    check(ip) {
      const now = Date.now()
      const s = state(ip)
      // 封禁优先于滑动窗口：封禁期间一律拒，连计数都不必做
      if (s.bannedUntil > now) {
        return { allowed: false, retryAfter: s.bannedUntil - now, banned: true, bannedForMs: s.bannedUntil - now }
      }
      clean(ip, now)
      const list = attempts.get(ip) || []
      if (list.length >= maxAttempts) {
        return { allowed: false, retryAfter: windowMs - (now - list[0]), banned: false }
      }
      list.push(now)
      attempts.set(ip, list)
      return { allowed: true, remaining: maxAttempts - list.length }
    },

    // 返回 { banned, banMs?, bans?, until? }，供调用方决定要不要写审计
    recordFailure(ip) {
      const now = Date.now()
      const s = state(ip)
      s.failures += 1
      if (s.failures < banAfterFailures) {
        return { banned: false, failures: s.failures, failuresLeft: banAfterFailures - s.failures }
      }
      // 到阈值：封禁，时长按"第几次封禁"指数增长（1×、2×、4×…），封顶
      s.bans += 1
      s.failures = 0
      const banMs = Math.min(baseBanMs * 2 ** (s.bans - 1), maxBanMs)
      s.bannedUntil = now + banMs
      attempts.delete(ip)
      return { banned: true, banMs, bans: s.bans, until: s.bannedUntil }
    },

    recordSuccess(ip) {
      strikes.delete(ip)
      attempts.delete(ip)
    },

    reset(ip) {
      attempts.delete(ip)
      strikes.delete(ip)
    },

    // 观测用（测试与排障）：读出某来源当前的状态，不改动它
    peek(ip) {
      const s = strikes.get(ip)
      return s ? { ...s } : { failures: 0, bans: 0, bannedUntil: 0 }
    },
  }
}
