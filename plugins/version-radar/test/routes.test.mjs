// routes.js 单测：spec §8-7（secret fail-closed）+ **/status 永不联网** 断言 + 零 dsh 依赖。
// 用法（仓库根目录）：node --test plugins/version-radar/test/routes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildResponse, resolveSecret, API_PREFIX, STALE_MS } from '../lib/routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'routes.js'), 'utf8')
const NOW = Date.parse('2026-09-26T09:40:00Z')
const TOKEN = 'unit-test-token-should-never-be-logged'

function mk(over) {
  const calls = { runCheck: [], getLastResult: 0 }
  const baseDeps = {
    now: () => NOW,
    getLastResult: () => { calls.getLastResult += 1; return { lastRunAt: null, result: null } },
    runCheck: async (a) => { calls.runCheck.push(a); return { ok: true, verdict: '可升' } },
    resolveSecret: () => ({ secret: null, source: null }),
  }
  const o = over || {}
  const req = Object.assign(
    { method: 'GET', path: API_PREFIX + '/status', query: {}, headers: {}, config: {} },
    o,
    { deps: Object.assign({}, baseDeps, o.deps || {}) },
  )
  return { req, calls }
}

test('§8-7 secret fail-closed：未配 secret ⇒ /check 403 且**不执行**检测', async () => {
  const { req, calls } = mk({ method: 'POST', path: API_PREFIX + '/check' })
  const r = await buildResponse(req)
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'CHECK_DISABLED_NO_SECRET')
  assert.equal(calls.runCheck.length, 0)
})

test('§8-7 配了但错 ⇒ 403（BAD_TOKEN），且值不外泄', async () => {
  const { req, calls } = mk({
    method: 'POST',
    path: API_PREFIX + '/check',
    headers: { 'x-version-radar-token': 'wrong' },
    deps: { resolveSecret: () => ({ secret: TOKEN, source: 'config:httpSecret' }) },
  })
  const r = await buildResponse(req)
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'BAD_TOKEN')
  assert.equal(JSON.stringify(r.body).includes(TOKEN), false)
  assert.equal(calls.runCheck.length, 0)
})

test('§8-7 正确 token ⇒ 200 且执行一次检测（?report=1 透传）', async () => {
  const { req, calls } = mk({
    method: 'POST',
    path: API_PREFIX + '/check',
    query: { report: '1' },
    headers: { 'x-version-radar-token': TOKEN },
    deps: { resolveSecret: () => ({ secret: TOKEN, source: 'config:httpSecret' }) },
  })
  const r = await buildResponse(req)
  assert.equal(r.status, 200)
  assert.equal(r.body.report, true)
  assert.deepEqual(calls.runCheck, [{ via: 'http', report: true }])
})

test('secret 读取顺序：config.httpSecretFile 优先于 httpSecret / 环境变量', () => {
  const fs = { readFileSync: (p) => { assert.equal(p, '/etc/vr/secret'); return TOKEN + '\n' } }
  const r = resolveSecret({
    config: { httpSecretFile: '/etc/vr/secret', httpSecret: 'ignored' },
    fs,
    env: { DSH_VERSION_RADAR_HTTP_SECRET: 'ignored-too' },
  })
  assert.equal(r.secret, TOKEN)
  assert.equal(r.source, 'file:/etc/vr/secret')
})

test('secret 读取：文件不可读 ⇒ secret:null（fail-closed），不外泄路径内容', () => {
  const fs = { readFileSync: () => { throw new Error('EACCES') } }
  const r = resolveSecret({ config: { httpSecretFile: '/etc/vr/secret' }, fs, env: {} })
  assert.equal(r.secret, null)
  assert.match(String(r.source), /file-unreadable/)
})

test('/status **永不联网**：只回进程内缓存（lastRunAt / result / stale）', async () => {
  const { req, calls } = mk({
    deps: {
      getLastResult: () => { calls.getLastResult += 1; return { lastRunAt: '2026-09-26T09:39:00Z', result: { verdict: '可升' } } },
    },
  })
  const r = await buildResponse(req)
  assert.equal(r.status, 200)
  assert.equal(r.body.lastRunAt, '2026-09-26T09:39:00Z')
  assert.equal(r.body.stale, false)
  assert.deepEqual(r.body.result, { verdict: '可升' })
  assert.equal(calls.runCheck.length, 0, '/status 绝不允许触发检测（否则等于无关请求联网）')
})

test('/status 空缓存 ⇒ stale:true，且绝不触发检测', async () => {
  const { req, calls } = mk({})
  const r = await buildResponse(req)
  assert.equal(r.body.stale, true)
  assert.equal(r.body.result, null)
  assert.equal(calls.runCheck.length, 0)
})

test('/status 过期（> STALE_MS）⇒ stale:true', async () => {
  const old = new Date(NOW - STALE_MS - 1000).toISOString()
  const { req } = mk({ deps: { getLastResult: () => ({ lastRunAt: old, result: {} }) } })
  const r = await buildResponse(req)
  assert.equal(r.body.stale, true)
})

test('未知路由 ⇒ 404；方法不对 ⇒ 405', async () => {
  const a = await buildResponse(mk({ path: API_PREFIX + '/nope' }).req)
  assert.equal(a.status, 404)
  const b = await buildResponse(mk({ method: 'GET', path: API_PREFIX + '/check' }).req)
  assert.equal(b.status, 405)
  const c = await buildResponse(mk({ method: 'POST', path: API_PREFIX + '/status' }).req)
  assert.equal(c.status, 405)
})

test('零 dsh 依赖 + 零出网（源码契约）：不引 dsh 包、不含 fetch 调用', () => {
  assert.equal(API_PREFIX, '/version-radar/api')
  assert.doesNotMatch(SRC, /@deepseek-ai\//)
  assert.doesNotMatch(SRC, /\bfetch\s*\(/)
  assert.doesNotMatch(SRC, /node:child_process/)
})
