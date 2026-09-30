import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('缺省配置：监听 8080，上游回环 3080', () => {
  const c = loadConfig({})
  assert.equal(c.port, 8080)
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.upstream.hostname, '127.0.0.1')
  assert.equal(c.upstream.port, 3080)
})

test('环境变量可覆盖端口与上游', () => {
  const c = loadConfig({
    DSH_GATEWAY_PORT: '9000',
    DSH_GATEWAY_UPSTREAM: 'http://127.0.0.1:3081',
  })
  assert.equal(c.port, 9000)
  assert.equal(c.upstream.port, 3081)
})

test('非法端口抛错', () => {
  assert.throws(() => loadConfig({ DSH_GATEWAY_PORT: 'abc' }), /非法端口/)
  assert.throws(() => loadConfig({ DSH_GATEWAY_PORT: '70000' }), /非法端口/)
})

test('非 http 协议的上游抛错', () => {
  assert.throws(() => loadConfig({ DSH_GATEWAY_UPSTREAM: 'ftp://127.0.0.1:3080' }), /只支持 http/)
})

test('非回环上游被拒绝（本阶段仅允许本机实例）', () => {
  assert.throws(() => loadConfig({ DSH_GATEWAY_UPSTREAM: 'http://10.0.0.5:3080' }), /必须是回环地址/)
})

// ---- 证书 SAN 与监听地址（云上固定 IP 直连）----

test('默认 tlsSan 为空数组', () => {
  assert.deepEqual(loadConfig({}).tlsSan, [])
})

test('tlsSan 按逗号切分并去空白', () => {
  const c = loadConfig({ DSH_GATEWAY_TLS_SAN: ' 203.0.113.9 , dsh.example.com ,' })
  assert.deepEqual(c.tlsSan, ['203.0.113.9', 'dsh.example.com'])
})

test('host 可配置为 0.0.0.0（对外监听），默认仍为回环', () => {
  assert.equal(loadConfig({}).host, '127.0.0.1')
  assert.equal(loadConfig({ DSH_GATEWAY_HOST: '0.0.0.0' }).host, '0.0.0.0')
})

test('mTLS 默认关闭，且必须与 TLS 同时启用', () => {
  assert.equal(loadConfig({}).mtls, false)
  assert.equal(loadConfig({ DSH_GATEWAY_TLS: '1' }).mtls, false)
  assert.equal(loadConfig({ DSH_GATEWAY_TLS: '1', DSH_GATEWAY_MTLS: '1' }).mtls, true)
  assert.equal(loadConfig({ DSH_GATEWAY_MTLS: '1' }).mtls, false, '仅开 mTLS 无意义（无 TLS 层）')
})

// ---- 明文口保留（C 方案：Funnel --https 走明文口 + Funnel --tcp 走 TLS 口，两种入口并存）----

test('plainKeep 默认关闭（明文口仍是 301 跳转口），且必须与 TLS 同时启用', () => {
  assert.equal(loadConfig({}).plainKeep, false)
  assert.equal(loadConfig({ DSH_GATEWAY_TLS: '1' }).plainKeep, false, '开 TLS 但未显式保留 ⇒ 沿用原行为')
  assert.equal(
    loadConfig({ DSH_GATEWAY_TLS: '1', DSH_GATEWAY_PLAIN_KEEP: '1' }).plainKeep,
    true,
  )
  assert.equal(
    loadConfig({ DSH_GATEWAY_PLAIN_KEEP: '1' }).plainKeep,
    false,
    '仅开 PLAIN_KEEP 无意义（没有 TLS 层时明文口本来就是完整服务）',
  )
})

// ---- 客户端静态资源目录（客户端已拆分为独立仓库）----

test('webDir 默认为空（回退仓库内 client/web）', () => {
  assert.equal(loadConfig({}).webDir, '')
})

test('webDir 可由 DSH_GATEWAY_WEB_DIR 指定', () => {
  const c = loadConfig({ DSH_GATEWAY_WEB_DIR: 'E:\\web-client\\web' })
  assert.equal(c.webDir, 'E:\\web-client\\web')
})
