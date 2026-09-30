// U-41 / P3 前置（2026-09-29）：客户端区读写通道纯逻辑真单测。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/client-zone-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CZ_ACTIONS, CZ_ALLOWED_SUBDIRS, CZ_SUBDIR_EXT, CZ_SUBDIR_RELS, CZ_SIZE_LIMIT,
  normalizeClientZonePath, normalizeClientZonePrefix, recycleRelOf,
  decideClientZoneWrite, czVersion
} from '../lib/client-zone-core.js'

test('① 端点族与子域常量', () => {
  assert.deepEqual(CZ_ACTIONS, ['clientZoneSave', 'clientZoneList', 'clientZoneRead', 'clientZoneDelete'])
  assert.deepEqual(CZ_ALLOWED_SUBDIRS, ['正文', '进度', '回收'])
  assert.deepEqual(CZ_SUBDIR_EXT, { '正文': '.md', '进度': '.json' })
  assert.equal(CZ_SUBDIR_RELS['正文'], '客户端区/正文')
  assert.equal(CZ_SUBDIR_RELS['进度'], '客户端区/进度')
  assert.equal(CZ_SIZE_LIMIT, 2 * 1024 * 1024)
})

test('② normalizeClientZonePath 正例：三条子域各自成立', () => {
  const a = normalizeClientZonePath('正文/心渊纪元/第01章.md')
  assert.deepEqual(a, { ok: true, rel: '正文/心渊纪元/第01章.md', wsRel: '客户端区/正文/心渊纪元/第01章.md', sub: '正文' })
  const b = normalizeClientZonePath('进度/dev-A.json')
  assert.equal(b.ok, true)
  assert.equal(b.wsRel, '客户端区/进度/dev-A.json')
  assert.equal(b.sub, '进度')
  const c = normalizeClientZonePath('回收/正文/心渊纪元/第01章.md')
  assert.equal(c.ok, true)
  assert.equal(c.sub, '回收')
  // 折叠重复斜杠 / 去首尾空白
  assert.equal(normalizeClientZonePath('  正文//a//x.md  ').rel, '正文/a/x.md')
})

test('③ normalizeClientZonePath 非法 ⇒ ok:false（越界 / 点开头 / 子域 / 后缀 / 层级）', () => {
  for (const v of [undefined, null, '', '   ']) assert.equal(normalizeClientZonePath(v).ok, false, String(v))
  assert.equal(normalizeClientZonePath('/abs/x.md').code, 'BAD_PATH')
  assert.equal(normalizeClientZonePath('C:/x.md').code, 'BAD_PATH')
  assert.equal(normalizeClientZonePath('正文/../x.md').code, 'BAD_PATH')
  assert.equal(normalizeClientZonePath('正文/.hidden/x.md').code, 'BAD_PATH', '点开头段 ⇒ 拒')
  assert.equal(normalizeClientZonePath('客户端区/正文/x.md').code, 'BAD_PATH', '不要带 客户端区/ 前缀')
  assert.equal(normalizeClientZonePath('草稿/x.md').code, 'BAD_SUBDIR', '**不得越界到 agent 区**')
  assert.equal(normalizeClientZonePath('正文').code, 'BAD_PATH', '必须指向具体文件')
  assert.equal(normalizeClientZonePath('正文/x.txt').code, 'BAD_PATH', '正文/ 只收 .md')
  assert.equal(normalizeClientZonePath('进度/x.md').code, 'BAD_PATH', '进度/ 只收 .json')
  assert.equal(normalizeClientZonePath('a/b/c/d/e/f/g.md').code, 'BAD_SUBDIR', '首段非允许子域 ⇒ 先报 BAD_SUBDIR')
  assert.equal(normalizeClientZonePath('正文/a/b/c/d/e/f/g.md').code, 'BAD_PATH', '层级过深（合法子域下）')
})

test('④ normalizeClientZonePrefix：空 = 整个客户端区；否则首段必须合法', () => {
  assert.deepEqual(normalizeClientZonePrefix(''), { ok: true, prefix: '' })
  assert.deepEqual(normalizeClientZonePrefix(undefined), { ok: true, prefix: '' })
  assert.deepEqual(normalizeClientZonePrefix('正文/'), { ok: true, prefix: '正文' })
  assert.equal(normalizeClientZonePrefix('正文/心渊纪元/').prefix, '正文/心渊纪元')
  assert.equal(normalizeClientZonePrefix('草稿/').code, 'BAD_SUBDIR')
  assert.equal(normalizeClientZonePrefix('正文/../x').code, 'BAD_PATH')
})

test('⑤ recycleRelOf：软删落点 = 回收/<原路径>', () => {
  assert.equal(recycleRelOf('正文/心渊纪元/第01章.md'), '回收/正文/心渊纪元/第01章.md')
  assert.equal(recycleRelOf('/正文//a.md/'), '回收/正文/a.md')
  assert.equal(recycleRelOf(''), '回收/')
})

test('⑥ 覆盖决策与版本：直接复用既有口径（不另立第二套）', () => {
  assert.equal(decideClientZoneWrite({ exists: false }).action, 'create')
  assert.equal(decideClientZoneWrite({ exists: true, force: true }).action, 'overwrite')
  const c = decideClientZoneWrite({ exists: true, currentVersion: 'v1-a' })
  assert.equal(c.action, 'conflict')
  assert.equal(c.code, 'VERSION_CONFLICT')
  assert.equal(decideClientZoneWrite({ exists: true, baseVersion: 'v1-a', currentVersion: 'v1-a' }).action, 'overwrite')
  assert.equal(czVersion('abc'), czVersion('abc'))
  assert.notEqual(czVersion('abc'), czVersion('abd'))
})
