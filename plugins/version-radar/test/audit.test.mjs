// audit.js 单测：事件名 / 路径 / **不含 token·cookie** / 写失败不阻断
// 用法（仓库根目录）：node --test plugins/version-radar/test/audit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { appendAudit, defaultAuditPath, EVENTS } from '../lib/audit.js'

const HOME = 'sandbox/dsh-home'
const FILE = join(HOME, 'logs', 'version-radar-audit.jsonl')
const AT = '2026-09-26T09:40:00Z'

function makeStubFs(opts) {
  const o = opts || {}
  const lines = []
  const dirs = []
  return {
    lines,
    dirs,
    mkdirSync(p) { dirs.push(p) },
    appendFileSync(p, d) {
      if (o.failWrite) throw new Error('EACCES: ' + p)
      lines.push([p, String(d)])
    },
  }
}

test('defaultAuditPath：<DSH_HOME>/logs/version-radar-audit.jsonl', () => {
  assert.equal(defaultAuditPath({ DSH_HOME: HOME }), FILE)
  assert.equal(defaultAuditPath({}), join('/srv/dsh-home', 'logs', 'version-radar-audit.jsonl'))
})

test('trigger 事件：JSONL 一行 / 字段白名单 / **不含 token·cookie**', () => {
  const fs = makeStubFs()
  const r = appendAudit({
    fs,
    file: FILE,
    event: EVENTS.TRIGGER,
    at: AT,
    payload: { via: 'http', token: 'SUPER_SECRET', cookie: 'sid=abc' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.file, FILE)
  assert.deepEqual(fs.dirs, [join(HOME, 'logs')])
  assert.equal(fs.lines.length, 1)
  assert.equal(fs.lines[0][0], FILE)
  const obj = JSON.parse(fs.lines[0][1].trim())
  assert.equal(obj.event, 'version.check.trigger')
  assert.deepEqual(obj.payload, { via: 'http', at: AT })
  assert.doesNotMatch(fs.lines[0][1], /token|cookie|secret|authorization/i)
})

test('done 事件：只落 host / upstream.distTags / thirdParty / verdict / sources（丢弃其余键）', () => {
  const fs = makeStubFs()
  const r = appendAudit({
    fs,
    file: FILE,
    event: EVENTS.DONE,
    at: AT,
    payload: {
      host: { version: '0.1.5-rc.1', source: 'argv[1]', dshPkgPath: '/x/dsh/package.json', installRoot: '/x/node_modules' },
      upstream: { ok: true, registry: 'registry.npmjs.org', latest: '0.1.5-rc.3', next: '0.1.7-rc.2', alpha: null, error: null, checkedAt: AT },
      thirdParty: [{ name: 'dshmarket', installed: '1.47.0', peers: [{ pkg: '@deepseek-ai/dsh', range: '^0.1.0-rc.7', satisfies: false }], supported: false }],
      verdict: '需人工判定',
      reasons: ['存在第三方声明不支持'],
      sources: ['host:argv[1]', 'upstream:registry.npmjs.org dist-tags'],
      extraSecret: 'nope',
    },
  })
  assert.equal(r.ok, true)
  const obj = JSON.parse(fs.lines[0][1].trim())
  assert.deepEqual(obj.payload.host, { version: '0.1.5-rc.1', source: 'argv[1]' })
  assert.deepEqual(obj.payload.upstream.distTags, { latest: '0.1.5-rc.3', next: '0.1.7-rc.2', alpha: null })
  assert.deepEqual(obj.payload.thirdParty, [{ name: 'dshmarket', installed: '1.47.0', supported: false }])
  assert.equal(obj.payload.verdict, '需人工判定')
  assert.deepEqual(obj.payload.sources, ['host:argv[1]', 'upstream:registry.npmjs.org dist-tags'])
  assert.equal(Object.prototype.hasOwnProperty.call(obj.payload, 'extraSecret'), false)
  assert.doesNotMatch(fs.lines[0][1], /token|cookie|secret|authorization/i)
})

test('error 事件：只落 {reason, at}', () => {
  const fs = makeStubFs()
  appendAudit({ fs, file: FILE, event: EVENTS.ERROR, at: AT, payload: { reason: 'TIMEOUT:8000ms' } })
  const obj = JSON.parse(fs.lines[0][1].trim())
  assert.equal(obj.event, 'version.check.error')
  assert.deepEqual(obj.payload, { reason: 'TIMEOUT:8000ms', at: AT })
})

test('写失败**不阻断**：返回 ok:false 且不抛', () => {
  const fs = makeStubFs({ failWrite: true })
  let r
  assert.doesNotThrow(() => { r = appendAudit({ fs, file: FILE, event: EVENTS.ERROR, payload: { reason: 'boom' } }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /WRITE_FAIL/)
  assert.equal(fs.lines.length, 0)
})

test('未知事件 ⇒ 明确拒绝（防未来随手加事件名）', () => {
  const r = appendAudit({ fs: makeStubFs(), file: FILE, event: 'version.check.made-up' })
  assert.equal(r.ok, false)
  assert.match(r.error, /UNKNOWN_EVENT/)
})
