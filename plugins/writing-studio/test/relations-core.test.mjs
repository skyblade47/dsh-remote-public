// U-7 / T1a：writing-studio 的 taskkit 适配纯逻辑真单测（无宿主依赖 ⇒ 本地可真跑）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/relations-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASKKIT_RELATIONS_LIST,
  TASKKIT_RELATIONS_UPDATE,
  TASKKIT_RELATIONS_DELETE,
  RELATIONS_DOC_VERSION,
  responseFailed,
  adaptRelationsDoc,
  buildAttachPayload
} from '../lib/relations-core.js'

test('① 三个 taskkit 端点常量（delete 为 T1b 新增）', () => {
  assert.equal(TASKKIT_RELATIONS_LIST, '/taskkit/api/relations/list')
  assert.equal(TASKKIT_RELATIONS_UPDATE, '/taskkit/api/relations/update')
  assert.equal(TASKKIT_RELATIONS_DELETE, '/taskkit/api/relations/delete')
  assert.equal(RELATIONS_DOC_VERSION, 1)
})

// ---------- responseFailed：如实报错（不静默兜底） ----------
test('② ok:true ⇒ null（成功）', () => {
  assert.equal(responseFailed({ status: 200, ok: true, data: { ok: true } }, 'list'), null)
})

test('③ ok:false / 无返回 ⇒ 可读失败原因（含 action 与具体 error/status）', () => {
  assert.match(responseFailed({ ok: false, error: 'timeout' }, 'list'), /relations\/list 失败: timeout/)
  assert.match(responseFailed({ ok: false, status: 0, error: 'no-adapterHttp（…）' }, 'update'), /relations\/update 失败: no-adapterHttp/)
  assert.match(responseFailed({ ok: false, status: 500 }, 'delete'), /relations\/delete 失败: HTTP 500/)
  assert.match(responseFailed(null, 'list'), /relations\/list 失败: taskkit 不可达/)
  assert.match(responseFailed(undefined, 'delete'), /relations\/delete 失败: taskkit 不可达/)
})

// ---------- adaptRelationsDoc：taskkit list → 本插件对外形状 ----------
test('④ taskkit relations 映射为 {version:1, relations}（调用方形状不变）', () => {
  const doc = adaptRelationsDoc({ ok: true, data: { relations: { 'a.md': { type: '自由写作' } }, drafts: [], total: 1 } })
  assert.deepEqual(doc, { version: 1, relations: { 'a.md': { type: '自由写作' } } })
})

test('⑤ relations 缺失/非法 ⇒ 空表（权威表为空是合法状态，不是错误）', () => {
  assert.deepEqual(adaptRelationsDoc({ ok: true, data: {} }), { version: 1, relations: {} })
  assert.deepEqual(adaptRelationsDoc({ ok: true, data: { relations: null } }), { version: 1, relations: {} })
  assert.deepEqual(adaptRelationsDoc({ ok: true, data: { relations: [] } }), { version: 1, relations: {} })
  assert.deepEqual(adaptRelationsDoc({ ok: true, data: { relations: 'x' } }), { version: 1, relations: {} })
  assert.deepEqual(adaptRelationsDoc(null), { version: 1, relations: {} })
  assert.deepEqual(adaptRelationsDoc(undefined), { version: 1, relations: {} })
})

// ---------- buildAttachPayload：attach → taskkit update 参数映射 ----------
test('⑥ 只下发 taskkit update 认得的四个字段；本插件自持键（date）不下发', () => {
  const payload = buildAttachPayload('第三章.md', { type: '灵感衍生', refInspId: 'i1', refResourceId: 'r2', note: '备注', date: '2026-09-28' })
  assert.deepEqual(payload, { draft: '第三章.md', type: '灵感衍生', refInspId: 'i1', refResourceId: 'r2', note: '备注' })
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'date'), false)
  assert.deepEqual(Object.keys(payload).sort(), ['draft', 'note', 'refInspId', 'refResourceId', 'type'])
})

test('⑦ 字段缺省透传（由 taskkit update 侧归一兜底）', () => {
  const payload = buildAttachPayload('x.md', undefined)
  assert.equal(payload.draft, 'x.md')
  assert.equal(payload.type, undefined)
  assert.equal(payload.refInspId, undefined)
  assert.equal(payload.refResourceId, undefined)
  assert.equal(payload.note, undefined)
})
