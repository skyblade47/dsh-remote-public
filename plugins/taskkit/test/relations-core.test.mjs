// U-7 / T1b：taskkit relations 纯逻辑真单测（无宿主依赖 ⇒ 本地可真跑）。
// 用法（仓库根目录）：node --test plugins/taskkit/test/relations-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELATIONS_ACTIONS, normalizeDraftArg, deleteRelation } from '../lib/relations-core.js'

// ---------- actions 真源 ----------
test('① RELATIONS_ACTIONS：list/update 保留 + 新增 delete（404 的 actions 与分支判定同一真源）', () => {
  assert.deepEqual(RELATIONS_ACTIONS, ['list', 'update', 'delete'])
})

// ---------- normalizeDraftArg：必填、非空（去首尾空白） ----------
test('② normalizeDraftArg：缺失/空 ⇒ 400（error=缺少 draft）', () => {
  for (const v of [undefined, null, '', '   ', '\t\n']) {
    const r = normalizeDraftArg(v)
    assert.equal(r.ok, false, String(v))
    assert.equal(r.error, '缺少 draft')
  }
})

test('③ normalizeDraftArg：非空 ⇒ 去首尾空白后放行', () => {
  assert.deepEqual(normalizeDraftArg('  第三章.md  '), { ok: true, draft: '第三章.md' })
  assert.deepEqual(normalizeDraftArg('心渊纪元/第一章.md'), { ok: true, draft: '心渊纪元/第一章.md' })
  // 非字符串按 String() 归一（与 update 分支既有口径一致：String(args.draft || '').trim()）
  assert.deepEqual(normalizeDraftArg(123), { ok: true, draft: '123' })
})

// ---------- deleteRelation：幂等删除语义 ----------
test('④ 键存在 ⇒ removed:true，新表已删键，且**不改入参**', () => {
  const orig = { 'a.md': { type: '自由写作' }, 'b.md': { type: '灵感衍生' } }
  const out = deleteRelation(orig, 'a.md')
  assert.equal(out.removed, true)
  assert.deepEqual(out.relations, { 'b.md': { type: '灵感衍生' } })
  assert.deepEqual(orig, { 'a.md': { type: '自由写作' }, 'b.md': { type: '灵感衍生' } }, '入参不得被改写')
  assert.notEqual(out.relations, orig, '必须返回新对象')
})

test('⑤ 键不存在 ⇒ removed:false，**不报错**、表内容不变（幂等）', () => {
  const orig = { 'a.md': { type: '自由写作' } }
  const out = deleteRelation(orig, '不存在.md')
  assert.equal(out.removed, false)
  assert.deepEqual(out.relations, orig)
  assert.notEqual(out.relations, orig)
})

test('⑥ 值恰为 null/undefined 的键同样算"存在"并被删（判存在用 hasOwnProperty，不看真值）', () => {
  assert.equal(deleteRelation({ x: null }, 'x').removed, true)
  assert.equal(deleteRelation({ x: undefined }, 'x').removed, true)
  // 原型上的属性不算自有键（防误删）
  assert.equal(deleteRelation({}, 'toString').removed, false)
})

test('⑦ 入参非对象/数组 ⇒ 按空表处理（removed:false，不抛）', () => {
  for (const bad of [null, undefined, 'x', 123, [], true]) {
    const out = deleteRelation(bad, 'a.md')
    assert.equal(out.removed, false, String(bad))
    assert.deepEqual(out.relations, {})
  }
})
