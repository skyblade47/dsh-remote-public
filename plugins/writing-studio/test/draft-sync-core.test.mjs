// C11：draft-sync 纯模块真单测（无宿主依赖 ⇒ 本地可真跑）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/draft-sync-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_ROOT, TRASH_DIR_NAME, TOMBSTONE_FILE_NAME, TOMBSTONE_REL,
  innerRelOf, wsRelOf, hasDotSegment, trashInnerRelOf,
  normalizeTombstones, putTombstone, getTombstone, tombstoneList,
  decideDelete, byteLength, wordCount, buildListItem, isoOf,
} from '../lib/draft-sync-core.js'
import { DRAFT_SAVE_PREFIX, validateRelPath, versionOf, SIZE_LIMIT } from '../lib/draft-save-core.js'

// ---------- ① 常量一致性 ----------
test('① DRAFT_ROOT 与 draft-save 的白名单前缀**同一份**（不许两套口径）', () => {
  assert.equal(DRAFT_ROOT, DRAFT_SAVE_PREFIX)
  assert.equal(DRAFT_ROOT, '写作训练/草稿/')
  assert.equal(TOMBSTONE_REL, '写作训练/草稿/.tombstones.json')
  assert.equal(TRASH_DIR_NAME, '.deleted')
  assert.equal(TOMBSTONE_FILE_NAME, '.tombstones.json')
})

test('① 回收站与墓碑都靠 `.` 开头对既有列举"隐身"（这就是零污染的全部理由）', () => {
  // 既有的 listDraftRelPaths 跳过 `name.charAt(0) === '.'`；本模块没有任何既有函数的改动
  assert.ok(TRASH_DIR_NAME.charAt(0) === '.', '回收站必须以 . 开头')
  assert.ok(TOMBSTONE_FILE_NAME.charAt(0) === '.', '墓碑必须以 . 开头')
  assert.ok(!/\.md$/i.test(TOMBSTONE_FILE_NAME), '墓碑不能是 .md（否则会被当草稿列出来）')
})

// ---------- ② 路径换算 ----------
test('② innerRelOf：剥前缀；不在草稿根下 / 只有前缀 ⇒ null', () => {
  assert.equal(innerRelOf('写作训练/草稿/作品甲/第一章.md'), '作品甲/第一章.md')
  assert.equal(innerRelOf('写作训练/草稿/x.md'), 'x.md')
  assert.equal(innerRelOf('写作训练/草稿/'), null)
  assert.equal(innerRelOf('写作训练/灵感库/a.md'), null)
  assert.equal(innerRelOf('写作训练/草稿X/a.md'), null) // 前缀必须整段匹配
  assert.equal(innerRelOf(''), null)
  assert.equal(innerRelOf(null), null)
  assert.equal(innerRelOf(undefined), null)
})

test('② wsRelOf：加前缀；空 / 绝对 ⇒ null；与 innerRelOf 互逆', () => {
  assert.equal(wsRelOf('作品甲/第一章.md'), '写作训练/草稿/作品甲/第一章.md')
  assert.equal(wsRelOf(''), null)
  assert.equal(wsRelOf('/x.md'), null)
  assert.equal(wsRelOf(null), null)
  assert.equal(innerRelOf(wsRelOf('a/b.md')), 'a/b.md')
})

test('🔴 ② hasDotSegment：挡住回收站/墓碑（fail-closed，空串也算命中）', () => {
  assert.equal(hasDotSegment('作品甲/第一章.md'), false)
  assert.equal(hasDotSegment('x.md'), false)
  assert.equal(hasDotSegment('.deleted/x.md'), true)
  assert.equal(hasDotSegment('作品甲/.deleted/x.md'), true)
  assert.equal(hasDotSegment('.tombstones.json'), true)
  assert.equal(hasDotSegment('a/.hidden/b.md'), true)
  assert.equal(hasDotSegment(''), true)
  assert.equal(hasDotSegment(null), true)
})

test('🔴 ② 为什么必须有 hasDotSegment：validateRelPath **放行** `.deleted/**.md`', () => {
  // validateRelPath 只拒「整段 == . 或 ..」的段
  for (const p of ['.', '..']) {
    assert.equal(validateRelPath('写作训练/草稿/' + p + '/x.md').ok, false, p)
  }
  // 🔴 而 `.deleted/x.md` 是**放行**的（它是 `.*` 段、不是 `.`/`..`，后缀又是 .md）
  assert.equal(validateRelPath('写作训练/草稿/.deleted/x.md').ok, true, '前提变了：validateRelPath 现在会拦 .deleted？')
  assert.equal(hasDotSegment(innerRelOf('写作训练/草稿/.deleted/x.md')), true)
  // 墓碑另有一层保护：它不是 .md ⇒ 被后缀规则挡掉（这条**不是**唯一防线，别指望它）
  assert.equal(validateRelPath('写作训练/草稿/.tombstones.json').ok, false)
  assert.equal(hasDotSegment(innerRelOf('写作训练/草稿/.tombstones.json')), true)
})

test('② trashInnerRelOf：搬进 .deleted/ 且保持原相对结构', () => {
  assert.equal(trashInnerRelOf('作品甲/第一章.md'), '.deleted/作品甲/第一章.md')
  assert.equal(trashInnerRelOf('x.md'), '.deleted/x.md')
})

// ---------- ③ 墓碑：归一化 / 增 / 查 / 列 ----------
test('③ normalizeTombstones：坏输入一律退化成空墓碑（不抛）', () => {
  for (const bad of [null, undefined, {}, 'x', 1, [], { items: [] }, { items: 'y' }, { items: null }]) {
    const t = normalizeTombstones(bad)
    assert.equal(t.version, 1)
    assert.deepEqual(t.items, {})
  }
})

test('③ normalizeTombstones：丢弃形状不对的条目，保留合法条目', () => {
  const t = normalizeTombstones({
    items: {
      '写作训练/草稿/a.md': { deletedAt: 'T', deletedBy: 'PC-A', lastVersion: 'v1-1' },
      '写作训练/草稿/b.md': 'oops',
      '写作训练/草稿/c.md': { deletedAt: 5 },   // 非字符串 ⇒ 归一成 ''
      '写作训练/草稿/d.md': null,
    },
  })
  assert.deepEqual(Object.keys(t.items).sort(), ['写作训练/草稿/a.md', '写作训练/草稿/c.md'])
  assert.equal(t.items['写作训练/草稿/a.md'].deletedBy, 'PC-A')
  assert.equal(t.items['写作训练/草稿/c.md'].deletedAt, '')
})

test('③ putTombstone：**纯函数**（不改入参） + 缺 deletedAt 时自动补现在', () => {
  const b0 = normalizeTombstones(null)
  const b1 = putTombstone(b0, '写作训练/草稿/a.md', { deletedBy: 'PC-A', lastVersion: 'v1-1' })
  assert.deepEqual(b0.items, {}, '入参不能被改')
  assert.equal(b1.items['写作训练/草稿/a.md'].deletedBy, 'PC-A')
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(b1.items['写作训练/草稿/a.md'].deletedAt), '应自动补 ISO 时间')
  const b2 = putTombstone(b1, '写作训练/草稿/b.md', { deletedAt: 'FIXED', deletedBy: 'PC-B' })
  assert.equal(b2.items['写作训练/草稿/b.md'].deletedAt, 'FIXED')
  assert.equal(Object.keys(b1.items).length, 1, '入参不能被改')
})

test('③ putTombstone：空 relPath ⇒ 原样返回（不写脏键）；重复 put 同一条 ⇒ 覆盖而非追加', () => {
  const b0 = normalizeTombstones(null)
  assert.deepEqual(putTombstone(b0, '', { deletedBy: 'x' }).items, {})
  const b1 = putTombstone(b0, 'K', { deletedBy: 'A' })
  const b2 = putTombstone(b1, 'K', { deletedBy: 'B' })
  assert.equal(Object.keys(b2.items).length, 1)
  assert.equal(b2.items.K.deletedBy, 'B')
})

test('③ getTombstone：命中 / 未命中 ⇒ null', () => {
  const b = putTombstone(null, '写作训练/草稿/a.md', { deletedBy: 'PC-A' })
  assert.equal(getTombstone(b, '写作训练/草稿/a.md').deletedBy, 'PC-A')
  assert.equal(getTombstone(b, '写作训练/草稿/zzz.md'), null)
  assert.equal(getTombstone(null, 'x'), null)
})

test('③ tombstoneList：稳定排序 + 拍平成数组（供 draft-list 用）', () => {
  let b = normalizeTombstones(null)
  b = putTombstone(b, '写作训练/草稿/b.md', { deletedBy: 'B', deletedAt: 'D2', lastVersion: 'v1-b' })
  b = putTombstone(b, '写作训练/草稿/a.md', { deletedBy: 'A', deletedAt: 'D1', lastVersion: 'v1-a' })
  const l = tombstoneList(b)
  assert.deepEqual(l.map((x) => x.relPath), ['写作训练/草稿/a.md', '写作训练/草稿/b.md'])
  assert.equal(l[0].deletedBy, 'A')
  assert.deepEqual(Object.keys(l[0]).sort(), ['deletedAt', 'deletedBy', 'lastVersion', 'relPath'])
  assert.deepEqual(tombstoneList(null), [])
})

// ---------- ④ decideDelete ----------
test('④ decideDelete：存在 ⇒ delete', () => {
  assert.equal(decideDelete({ exists: true }).action, 'delete')
  assert.equal(decideDelete({ exists: true, baseVersion: 'v1-1', currentVersion: 'v1-1' }).action, 'delete')
})

test('④ decideDelete：不存在 + 有墓碑 ⇒ already（幂等，重放删请求仍 200）', () => {
  assert.equal(decideDelete({ exists: false, tombstoned: true }).action, 'already')
})

test('④ decideDelete：不存在 + 无墓碑 ⇒ notfound', () => {
  assert.equal(decideDelete({ exists: false }).action, 'notfound')
  assert.equal(decideDelete({}).action, 'notfound')
  assert.equal(decideDelete(null).action, 'notfound')
})

test('🔴 ④ decideDelete：给了 baseVersion 且不符 ⇒ conflict（**拒绝删除**，不静默删）', () => {
  const r = decideDelete({ exists: true, baseVersion: 'v1-old', currentVersion: 'v1-new' })
  assert.equal(r.action, 'conflict')
  assert.equal(r.code, 'VERSION_CONFLICT')
})

test('④ decideDelete：未给 baseVersion ⇒ 允许删（与 draft-save 的"默认不覆盖"不同，这里语义是"显式删"）', () => {
  assert.equal(decideDelete({ exists: true, currentVersion: 'v1-x' }).action, 'delete')
})

// ---------- ⑤ 口径与 draft-save 对齐 ----------
test('⑤ byteLength / wordCount 与 draft-save 同一口径', () => {
  assert.equal(byteLength(''), 0)
  assert.equal(byteLength('abc'), 3)
  assert.equal(byteLength('中文'), 6)                    // UTF-8 按字节
  assert.equal(byteLength(undefined), 0)
  assert.equal(byteLength(null), 0)
  assert.equal(wordCount('a b\nc'), 3)
  assert.equal(wordCount('  '), 0)
  assert.equal(wordCount(undefined), 0)
})

test('⑤ 常量与 draft-save 的大小闸一致（读/写对称，S-5）', () => {
  assert.equal(SIZE_LIMIT, 2 * 1024 * 1024)
})

test('⑤ buildListItem 形状：relPath / version(服务端 versionOf) / bytes / mtime', () => {
  const it = buildListItem('写作训练/草稿/作品甲/第一章.md', 'abc', 1700000000000)
  assert.deepEqual(Object.keys(it).sort(), ['bytes', 'mtime', 'relPath', 'version'])
  assert.equal(it.relPath, '写作训练/草稿/作品甲/第一章.md')
  assert.equal(it.version, versionOf('abc'))             // 🔴 必须用服务端那份 versionOf
  assert.equal(it.bytes, 3)
  assert.equal(it.mtime, new Date(1700000000000).toISOString())
})

test('⑤ buildListItem：空内容 / 缺 mtime 也不抛', () => {
  const it = buildListItem('写作训练/草稿/x.md', undefined, null)
  assert.equal(it.version, versionOf(''))
  assert.equal(it.bytes, 0)
  assert.equal(it.mtime, null)
})

test('⑤ isoOf：毫秒 / ISO 串 / Date / 非法', () => {
  assert.equal(isoOf(null), null)
  assert.equal(isoOf(''), null)
  assert.equal(isoOf(undefined), null)
  assert.equal(isoOf(0), new Date(0).toISOString())
  assert.equal(isoOf(new Date(0)), new Date(0).toISOString())
  assert.equal(isoOf('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z') // 合法 ISO ⇒ 原样（规范化后同值）
  assert.equal(isoOf('not-a-date'), null)   // 垃圾**不原样透传**
  assert.equal(isoOf(NaN), null)
})
