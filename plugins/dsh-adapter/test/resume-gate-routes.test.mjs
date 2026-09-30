// @local/dsh-adapter —— 门闸 HTTP 数据面单测（/adapter/api/resume/gate）
//
// 锁住的语义：
//   1. 非本路径**返回 false 让位**（同一个 /adapter/api 前缀下还有 hotplug 与 status，不能抢路由）
//   2. ★**fail-closed 贯穿到 HTTP 层**：gate 缺失 ⇒ 503 且 `safe:false`，
//      **绝不**返回 200/safe —— 运维脚本照 `safe` 字段决策，给错一个 200 就等于放行重启
//   3. GET = 只读判定；POST force = 写**审计**（留痕只能有一处，落在 resume-audit.jsonl）
//   4. 未知 op / 非法 body / 不支持的方法各自明确报错，且都带 `safe:false`
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createResumeGateRoutes } from '../lib/resume/routes.js'

/** 假 req：`readJsonBody` 用 on('data')/on('end')，故必须给真的事件发射器 */
const mkReq = (method, url, body) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  }, 0)
  return req
}

const mkRes = () => {
  const out = { status: null, body: null, ended: false }
  return {
    out,
    writeHead(status) { out.status = status },
    end(payload) { out.ended = true; try { out.body = JSON.parse(payload) } catch (_) { out.body = payload } },
  }
}

/** 假 gate：只实现被路由用到的三个方法，并记录调用 */
const mkGate = ({ safe = true, blockers = null, throwOnEval = false } = {}) => {
  const calls = { evaluate: 0, noteForce: [] }
  return {
    calls,
    evaluate() {
      calls.evaluate++
      if (throwOnEval) throw new Error('eval boom')
      return {
        ok: true, safe,
        reason: safe ? null : 'unjudgeable',
        blockers: blockers || { delegations: [], hotplugOps: [], openTurns: [] },
        counts: { liveSessions: 0, delegations: 0, hotplugOps: 0, openTurns: 0 },
        unjudgeable: [], table: null, checkedAt: '2026-09-22T00:00:00.000Z',
      }
    },
    noteForce(o) { calls.noteForce.push(o); return { ok: true } },
  }
}

const call = async (handler, req) => { const res = mkRes(); const handled = await handler(req, res); await new Promise((r) => setTimeout(r, 5)); return { handled, res: res.out } }

test('非本路径 ⇒ 返回 false 让位（不能抢同前缀下的 hotplug / status）', async () => {
  const handler = createResumeGateRoutes({ gate: mkGate() })
  for (const url of ['/adapter/api/hotplug', '/adapter/api', '/adapter/api/resume', '/other']) {
    const { handled, res } = await call(handler, mkReq('GET', url))
    assert.equal(handled, false, url + ' 不该被本处理器接管')
    assert.equal(res.status, null, '让位时不得写任何响应')
  }
})

test('gate 缺失 ⇒ 503 且 safe:false（fail-closed 贯穿到 HTTP 层，绝不 200 放行）', async () => {
  for (const gate of [null, {}, { evaluate: 'not-a-function' }]) {
    const handler = createResumeGateRoutes({ gate })
    const { handled, res } = await call(handler, mkReq('GET', '/adapter/api/resume/gate'))
    assert.equal(handled, true)
    assert.equal(res.status, 503)
    assert.equal(res.body.safe, false, '门闸不可用时必须明确报"不安全"')
    assert.equal(res.body.code, 'GATE_UNAVAILABLE')
  }
})

test('GET ⇒ 200 + 判定结果原样返回（含 safe / blockers / counts）', async () => {
  const gate = mkGate({ safe: false, blockers: { delegations: [{ childId: 'c1' }], hotplugOps: [], openTurns: [] } })
  const handler = createResumeGateRoutes({ gate })
  const { res } = await call(handler, mkReq('GET', '/adapter/api/resume/gate'))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.safe, false)
  assert.equal(res.body.blockers.delegations.length, 1)
  assert.equal(gate.calls.evaluate, 1)
})

test('GET 带 query 也能命中（路径匹配要剥掉 ? 之后的部分）', async () => {
  const handler = createResumeGateRoutes({ gate: mkGate() })
  const { handled, res } = await call(handler, mkReq('GET', '/adapter/api/resume/gate?waitMs=1000'))
  assert.equal(handled, true)
  assert.equal(res.status, 200)
})

test('门闸求值抛错 ⇒ 500 且 safe:false（出错不许被当成"安全"）', async () => {
  const handler = createResumeGateRoutes({ gate: mkGate({ throwOnEval: true }) })
  const { res } = await call(handler, mkReq('GET', '/adapter/api/resume/gate'))
  assert.equal(res.status, 500)
  assert.equal(res.body.safe, false)
  assert.match(res.body.message, /eval boom/)
})

test('POST force ⇒ 调用 noteForce 写审计（留痕只落一处），并回带当时的阻塞项', async () => {
  const gate = mkGate({ safe: false })
  const handler = createResumeGateRoutes({ gate })
  const { res } = await call(handler, mkReq('POST', '/adapter/api/resume/gate', {
    op: 'force', reason: 'timeout', by: 'restart-kernel.sh',
    blockers: { delegations: 3, hotplugOps: 0, openTurns: 2 },
  }))
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(gate.calls.noteForce.length, 1)
  assert.equal(gate.calls.noteForce[0].reason, 'timeout')
  assert.equal(gate.calls.noteForce[0].by, 'restart-kernel.sh')
  assert.deepEqual(gate.calls.noteForce[0].blockers, { delegations: 3, hotplugOps: 0, openTurns: 2 })
})

test('POST force 未带 blockers ⇒ 由门闸自查一次补上（脚本超时后才决定 --force 的情形）', async () => {
  const gate = mkGate()
  const handler = createResumeGateRoutes({ gate })
  await call(handler, mkReq('POST', '/adapter/api/resume/gate', { op: 'force' }))
  assert.equal(gate.calls.evaluate, 1, '应补跑一次 evaluate 抓当时的事实')
  assert.deepEqual(gate.calls.noteForce[0].blockers, { liveSessions: 0, delegations: 0, hotplugOps: 0, openTurns: 0 })
})

test('未知 op / 非法 JSON / 不支持的方法：各自明确报错且都带 safe:false', async () => {
  const handler = createResumeGateRoutes({ gate: mkGate() })

  const a = await call(handler, mkReq('POST', '/adapter/api/resume/gate', { op: 'nope' }))
  assert.equal(a.res.status, 400)
  assert.equal(a.res.body.safe, false)
  assert.match(a.res.body.message, /未知 op/)

  const b = await call(handler, mkReq('POST', '/adapter/api/resume/gate', '{not json'))
  assert.equal(b.res.status, 400)
  assert.equal(b.res.body.safe, false)

  const c = await call(handler, mkReq('DELETE', '/adapter/api/resume/gate'))
  assert.equal(c.res.status, 405)
  assert.equal(c.res.body.safe, false)
})

test('POST audit ⇒ 返回审计 tail（供重启脚本排查时顺带看一眼）', async () => {
  const seen = []
  const handler = createResumeGateRoutes({ gate: mkGate(), auditTail: (o) => { seen.push(o); return [{ event: 'resume.gate' }] } })
  const { res } = await call(handler, mkReq('POST', '/adapter/api/resume/gate', { op: 'audit', tail: 10 }))
  assert.equal(res.status, 200)
  assert.equal(res.body.entries.length, 1)
  assert.equal(seen[0].tail, 10)
})
