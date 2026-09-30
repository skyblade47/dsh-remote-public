// @local/dsh-adapter —— 异步互斥锁 + in-flight 标志
//
// 从 sandbox/lib/mutex.js 迁移，语义保留（30s 锁超时、in-flight 持续到操作完成、
// in-flight 超 60s 判定 loader 不稳定并熔断），只把错误类型换成 HotplugError。
// 单飞（single-flight）是 spec §5.4 对 guarded 档安全网的三条之一：同一 id 同时只允许
// 一个热替操作，避免并发 create 造成工具重复注册。

import { HotplugError, HotplugCode } from './errors.js'

export class AsyncMutex {
  constructor() {
    this._queue = []
    this._locked = false
    this.inFlightOp = null
    this.loaderUnstable = false
    this.unstableReason = null
  }

  async runExclusive(fn, meta = {}) {
    const timeoutMs = meta.timeoutMs ?? 30000

    if (this.loaderUnstable) {
      throw new HotplugError(HotplugCode.OP_IN_FLIGHT,
        'loader 树已判定为不稳定，需重启宿主后再操作' + (this.unstableReason ? `（${this.unstableReason}）` : ''),
        { extra: { unstableReason: this.unstableReason } })
    }

    if (this.inFlightOp) {
      const elapsed = Date.now() - this.inFlightOp.startedAt
      if (elapsed > 60000) {
        this.loaderUnstable = true
        this.unstableReason = 'in_flight_timeout'
        throw new HotplugError(HotplugCode.OP_IN_FLIGHT,
          '已有操作在途超过 60s，判定 loader 不稳定，需重启宿主',
          { extra: { inFlight: this.inFlightOp } })
      }
      throw new HotplugError(HotplugCode.OP_IN_FLIGHT,
        `已有操作在途: ${this.inFlightOp.action} on ${this.inFlightOp.id}`,
        { extra: { inFlight: this.inFlightOp } })
    }

    const acquired = await this._acquire(timeoutMs)
    if (!acquired) {
      throw new HotplugError(HotplugCode.LOCK_TIMEOUT, `等待互斥锁超时（${timeoutMs}ms）`)
    }

    this.inFlightOp = { id: meta.id, action: meta.action, startedAt: Date.now() }

    try {
      return await fn()
    } finally {
      this.inFlightOp = null
      this._release()
    }
  }

  _acquire(timeoutMs) {
    return new Promise((resolve) => {
      if (!this._locked) {
        this._locked = true
        resolve(true)
        return
      }
      const waiter = { resolve, timer: null }
      const timer = setTimeout(() => {
        const idx = this._queue.indexOf(waiter)
        if (idx >= 0) this._queue.splice(idx, 1)
        resolve(false)
      }, timeoutMs)
      waiter.timer = timer
      this._queue.push(waiter)
    })
  }

  _release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift()
      clearTimeout(next.timer)
      next.resolve(true)
    } else {
      this._locked = false
    }
  }

  getInFlight() { return this.inFlightOp }
  isUnstable() { return this.loaderUnstable }
  markUnstable(reason) {
    this.loaderUnstable = true
    this.unstableReason = reason
  }
}
