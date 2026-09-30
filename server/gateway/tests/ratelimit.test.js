import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../src/ratelimit.js'

test('限速器：允许窗口内请求', () => {
  const rl = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 })
  assert.equal(rl.check('1.1.1.1').allowed, true)
  assert.equal(rl.check('1.1.1.1').allowed, true)
  assert.equal(rl.check('1.1.1.1').allowed, true)
})

test('限速器：超过窗口拒绝', () => {
  const rl = createRateLimiter({ maxAttempts: 2, windowMs: 60_000 })
  rl.check('2.2.2.2')
  rl.check('2.2.2.2')
  const r = rl.check('2.2.2.2')
  assert.equal(r.allowed, false)
  assert.ok(r.retryAfter > 0)
})

test('限速器：不同 IP 独立计数', () => {
  const rl = createRateLimiter({ maxAttempts: 1, windowMs: 60_000 })
  assert.equal(rl.check('3.3.3.3').allowed, true)
  assert.equal(rl.check('4.4.4.4').allowed, true) // 不同 IP，仍允许
})

test('限速器：reset 后可重新请求', () => {
  const rl = createRateLimiter({ maxAttempts: 1, windowMs: 60_000 })
  rl.check('5.5.5.5')
  assert.equal(rl.check('5.5.5.5').allowed, false)
  rl.reset('5.5.5.5')
  assert.equal(rl.check('5.5.5.5').allowed, true)
})

// ---- S1：封禁退避 ----
//
// 只靠滑动窗口挡不住"低速撞库"：窗口一过计数清零，攻击者可以永远以
// maxAttempts/windowMs 的节奏尝试，一天也试几千次而永不触发上限。
// 这一组锁住"失败会累计，累计到阈值就封禁，且封禁时长递增"。

function banOpts(extra = {}) {
  return { maxAttempts: 1000, windowMs: 60_000, banAfterFailures: 3, baseBanMs: 1000, ...extra }
}

test('S1：连续失败累计到阈值即封禁，并报告封禁时长', () => {
  const rl = createRateLimiter(banOpts())
  assert.equal(rl.recordFailure('9.9.9.9').banned, false)
  assert.equal(rl.recordFailure('9.9.9.9').banned, false)
  const third = rl.recordFailure('9.9.9.9')
  assert.equal(third.banned, true, '第 3 次失败应触发封禁')
  assert.equal(third.banMs, 1000)
  assert.equal(third.bans, 1)
})

test('S1：封禁期间 check 一律拒，且能报出剩余时长', () => {
  const rl = createRateLimiter(banOpts())
  for (let i = 0; i < 3; i++) rl.recordFailure('9.9.9.10')
  const r = rl.check('9.9.9.10')
  assert.equal(r.allowed, false)
  assert.equal(r.banned, true, '要能让调用方区分"封禁"与"窗口限流"')
  assert.ok(r.retryAfter > 0)
})

test('S1：封禁时长随封禁次数指数增长并封顶', () => {
  const rl = createRateLimiter(banOpts({ baseBanMs: 1000, maxBanMs: 4000 }))
  const bans = []
  for (let round = 0; round < 4; round++) {
    let last
    for (let i = 0; i < 3; i++) last = rl.recordFailure('9.9.9.11')
    bans.push(last.banMs)
  }
  assert.deepEqual(bans, [1000, 2000, 4000, 4000], '1× → 2× → 4× → 封顶 4×')
})

test('S1：登录成功清零累计（正常人打错几次能自己复位）', () => {
  const rl = createRateLimiter(banOpts())
  rl.recordFailure('9.9.9.12')
  rl.recordFailure('9.9.9.12')
  rl.recordSuccess('9.9.9.12')
  assert.equal(rl.peek('9.9.9.12').failures, 0)
  // 清零后再失败 3 次才该触发封禁
  assert.equal(rl.recordFailure('9.9.9.12').banned, false)
  assert.equal(rl.recordFailure('9.9.9.12').banned, false)
  assert.equal(rl.recordFailure('9.9.9.12').banned, true)
})

test('S1：不同来源的打击数互不影响', () => {
  const rl = createRateLimiter(banOpts())
  rl.recordFailure('9.9.9.13')
  rl.recordFailure('9.9.9.13')
  assert.equal(rl.peek('9.9.9.13').failures, 2)
  assert.equal(rl.peek('9.9.9.14').failures, 0)
  assert.equal(rl.recordFailure('9.9.9.14').banned, false, '没打过交道的来源不该被牵连')
})

test('S1：封禁到期后自动恢复（不需要人工解封）', async () => {
  const rl = createRateLimiter(banOpts({ baseBanMs: 60 }))
  for (let i = 0; i < 3; i++) rl.recordFailure('9.9.9.15')
  assert.equal(rl.check('9.9.9.15').allowed, false)
  await new Promise((r) => setTimeout(r, 90))
  assert.equal(rl.check('9.9.9.15').allowed, true, '到期即放行')
})
