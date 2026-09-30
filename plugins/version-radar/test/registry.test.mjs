// registry.js 单测：**全部注入假 fetch，绝不联网**（spec §8-3 / §8-5）
// 用法（仓库根目录）：node --test plugins/version-radar/test/registry.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDistTags, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, PACKUMENT_URL } from '../lib/registry.js'

const GOOD = JSON.stringify({
  name: '@deepseek-ai/dsh',
  versions: { '0.1.5-rc.1': { pad: 'x' }, '0.1.5-rc.3': {} },
  'dist-tags': { latest: '0.1.5-rc.3', next: '0.1.7-rc.2', alpha: '0.1.7-alpha.2' },
})

const jsonRes = (text, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => text })

function recorder(impl) {
  const calls = []
  return { calls, fetchImpl: (url, opts) => { calls.push({ url, opts }); return impl(url, opts) } }
}

test('正常：只取 dist-tags（versions 不外泄），并把 AbortSignal 传给 fetch', async () => {
  const rec = recorder(() => Promise.resolve(jsonRes(GOOD)))
  const r = await fetchDistTags({ fetchImpl: rec.fetchImpl })
  assert.equal(r.ok, true)
  assert.deepEqual(r.distTags, { latest: '0.1.5-rc.3', next: '0.1.7-rc.2', alpha: '0.1.7-alpha.2' })
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'versions'), false)
  assert.equal(r.bytes > 0, true)
  assert.equal(rec.calls.length, 1)
  assert.equal(rec.calls[0].url, PACKUMENT_URL)
  assert.ok(rec.calls[0].opts.signal instanceof AbortSignal, '必须把 AbortSignal.timeout 传给 fetch')
})

test('HTTP 500 ⇒ fail-closed（ok:false / HTTP_500）', async () => {
  const r = await fetchDistTags({ fetchImpl: () => Promise.resolve(jsonRes('boom', 500)) })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'HTTP_500')
  assert.equal(r.distTags, null)
})

test('响应超体积（text 路径）⇒ fail-closed（TOO_LARGE）', async () => {
  const big = JSON.stringify({ 'dist-tags': { latest: '0.1.5-rc.3' }, pad: 'y'.repeat(4096) })
  const r = await fetchDistTags({ fetchImpl: () => Promise.resolve(jsonRes(big)), maxBytes: 64 })
  assert.equal(r.ok, false)
  assert.match(r.error, /TOO_LARGE/)
})

test('流式响应超体积 ⇒ 用 reader.cancel 中途断流（不整包读入）', async () => {
  let cancelled = false
  const chunks = [new Uint8Array(64).fill(120), new Uint8Array(64).fill(121)]
  let i = 0
  const res = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => { cancelled = true },
      }),
    },
  }
  const r = await fetchDistTags({ fetchImpl: () => Promise.resolve(res), maxBytes: 80 })
  assert.equal(r.ok, false)
  assert.match(r.error, /TOO_LARGE/)
  assert.equal(cancelled, true, '超限必须断流')
})

test('超时 ⇒ AbortSignal.timeout 真的触发，并映射为 TIMEOUT', async () => {
  // ⚠️ AbortSignal.timeout() 的定时器是 **unref** 的：只等它会让事件循环空掉，
  //    node:test 会报「Promise resolution is still pending but the event loop has already resolved」。
  //    ⇒ 这里用一根**被 ref 的** keepAlive 定时器把事件循环撑住，abort 后立刻清掉。
  const fetchImpl = (_url, opts) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 200)
    opts.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive)
      reject(opts.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })
  const r = await fetchDistTags({ fetchImpl, timeoutMs: 20 })
  assert.equal(r.ok, false)
  assert.match(r.error, /TIMEOUT/)
})

test('非 JSON ⇒ fail-closed（BAD_JSON）', async () => {
  const r = await fetchDistTags({ fetchImpl: () => Promise.resolve(jsonRes('<html>nope</html>')) })
  assert.equal(r.ok, false)
  assert.match(r.error, /BAD_JSON/)
})

test('缺 dist-tags / 缺 latest ⇒ fail-closed', async () => {
  const a = await fetchDistTags({ fetchImpl: () => Promise.resolve(jsonRes(JSON.stringify({ versions: {} }))) })
  assert.equal(a.ok, false)
  assert.equal(a.error, 'NO_DIST_TAGS')
  const b = await fetchDistTags({ fetchImpl: () => Promise.resolve(jsonRes(JSON.stringify({ 'dist-tags': { next: '0.1.7-rc.2' } }))) })
  assert.equal(b.ok, false)
  assert.equal(b.error, 'NO_LATEST_TAG')
})

test('没有可用 fetch ⇒ fail-closed（NO_FETCH，不误用全局 fetch）', async () => {
  const r = await fetchDistTags({ fetchImpl: null })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NO_FETCH')
})

test('默认参数：256 KB / 8 s（spec §6-5）', () => {
  assert.equal(DEFAULT_MAX_BYTES, 256 * 1024)
  assert.equal(DEFAULT_TIMEOUT_MS, 8000)
})
