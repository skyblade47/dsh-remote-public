// U-44 / W-A：taskkit 灵感退役纯逻辑真单测（无宿主依赖 ⇒ 本地可真跑）。
// 用法（仓库根目录）：node --test plugins/taskkit/test/insp-retire-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INSP_RETIRE_DIR_REL,
  INSP_RETIRE_MANIFEST_REL,
  INSP_EDITABLE_FIELDS,
  INSP_LIST_DEFAULT_LIMIT,
  INSP_LIST_MAX_LIMIT,
  normalizeInspIdArg,
  retireFileName,
  extractEntry,
  insertEntry,
  emptyManifest,
  normalizeManifest,
  buildRetireRow,
  findRetireRow,
  upsertRetireRow,
  markRetireRowRestored,
  resolveListLimit,
  stripContent,
  normalizeTags,
  worldviewKeys,
  worldviewWarn
} from '../lib/insp-retire-core.js'

// ---------- 夹具 ----------
function entry(id, over) {
  return Object.assign({
    id: id, title: '灵感 ' + id, oneLiner: '一句话', content: '正文……',
    tags: ['主题:废土', '世界观:原创/心渊纪元'], status: '预存', fixed: false,
    history: [], settingsRef: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
  }, over || {})
}
const LIB3 = () => [entry('insp-000001-01'), entry('insp-000002-02'), entry('insp-000003-03')]

// ============================== 常量真源 ==============================
test('① 路径/清单/可编辑字段常量：并集含 category（修掉工具侧漂移）', () => {
  assert.equal(INSP_RETIRE_DIR_REL, '灵感库/灵感退役')
  assert.equal(INSP_RETIRE_MANIFEST_REL, '灵感库/退役清单.json')
  // A2：并集 9 字段，且**必须含 category**（工具侧原来缺、HTTP 侧有 ⇒ 取并集）
  assert.deepEqual(INSP_EDITABLE_FIELDS, ['title', 'content', 'source', 'oneLiner', 'hook', 'settingsRef', 'status', 'category', 'annotations'])
  assert.ok(INSP_EDITABLE_FIELDS.includes('category'), 'category 必须在并集内')
})

test('② A3 上限口径：默认 20 / 上限 50', () => {
  assert.equal(INSP_LIST_DEFAULT_LIMIT, 20)
  assert.equal(INSP_LIST_MAX_LIMIT, 50)
})

// ============================== A1 入参：缺参 ==============================
test('③ normalizeInspIdArg：缺失/空 ⇒ 400（error=缺少 id）', () => {
  for (const v of [undefined, null, '', '   ', '\t\n']) {
    const r = normalizeInspIdArg(v)
    assert.equal(r.ok, false, String(v))
    assert.equal(r.error, '缺少 id')
  }
})

test('④ normalizeInspIdArg：非空 ⇒ 去首尾空白后放行；非字符串按 String 归一', () => {
  assert.deepEqual(normalizeInspIdArg('  insp-913339-58  '), { ok: true, id: 'insp-913339-58' })
  assert.deepEqual(normalizeInspIdArg(123), { ok: true, id: '123' })
})

test('⑤ retireFileName：按 id 推出文件名（无需存路径）', () => {
  assert.equal(retireFileName('insp-913339-58'), 'insp-913339-58.json')
  assert.equal(retireFileName('  insp-a  '), 'insp-a.json')
})

// ============================== A1 正例：退役摘出 ==============================
test('⑥ extractEntry 正例：命中 ⇒ found:true + 条目原样 + rest 少一条，且**不改入参**', () => {
  const src = LIB3()
  const snapshot = JSON.parse(JSON.stringify(src))
  const out = extractEntry(src, 'insp-000002-02')
  assert.equal(out.found, true)
  assert.equal(out.entry.id, 'insp-000002-02')
  assert.equal(out.rest.length, 2)
  assert.deepEqual(out.rest.map(e => e.id), ['insp-000001-01', 'insp-000003-03'])
  assert.deepEqual(src, snapshot, '入参不得被改写')
  assert.notEqual(out.rest, src, '必须返回新数组')
  // 摘出的条目**逐字节**等于原条目（退役文件要逐字节保留）
  assert.deepEqual(out.entry, snapshot[1])
})

test('⑦ extractEntry 幂等：id 不存在 ⇒ found:false、entry:null、rest 内容不变（不报错）', () => {
  const src = LIB3()
  const out = extractEntry(src, '不存在-xx')
  assert.equal(out.found, false)
  assert.equal(out.entry, null)
  assert.deepEqual(out.rest, src)
  assert.notEqual(out.rest, src)
})

// ============================== A1 复原：插回 + 防覆盖 ==============================
test('⑧ insertEntry 正例：插到**头部**（与 insp_create 的 unshift 同位置口径），不改入参', () => {
  const src = LIB3()
  const snapshot = JSON.parse(JSON.stringify(src))
  const back = entry('insp-000009-09')
  const out = insertEntry(src, back)
  assert.equal(out.ok, true)
  assert.equal(out.entries.length, 4)
  assert.equal(out.entries[0].id, 'insp-000009-09')
  assert.deepEqual(out.entries.slice(1).map(e => e.id), ['insp-000001-01', 'insp-000002-02', 'insp-000003-03'])
  assert.deepEqual(src, snapshot, '入参不得被改写')
})

test('⑨ insertEntry 防覆盖：同 id 已存在 ⇒ conflict:true（对应 409），不产生新数组', () => {
  const out = insertEntry(LIB3(), entry('insp-000002-02'))
  assert.equal(out.ok, false)
  assert.equal(out.conflict, true)
  assert.match(out.error, /已存在同 id/)
})

test('⑩ insertEntry 非法条目 ⇒ conflict:false', () => {
  assert.equal(insertEntry([], null).conflict, false)
  assert.equal(insertEntry([], { title: '没有 id' }).conflict, false)
})

// ============================== A1 清单 ==============================
test('⑪ 清单归一：空/损坏/数组/旧形状 ⇒ 一律退回空清单，不抛', () => {
  assert.deepEqual(normalizeManifest(null), emptyManifest())
  assert.deepEqual(normalizeManifest('x'), emptyManifest())
  assert.deepEqual(normalizeManifest([]), emptyManifest())
  assert.deepEqual(normalizeManifest({ rows: 'nope' }).rows, [])
  // rows 里的非对象项被滤掉
  assert.equal(normalizeManifest({ rows: [{ id: 'a' }, null, 3] }).rows.length, 1)
  assert.equal(normalizeManifest({ version: 2, updatedAt: 'T' }).version, 2)
})

test('⑫ buildRetireRow：字段对齐 memory（id/退役时间/原路径/路径 + restored:false）+ 动作留痕在**清单行**', () => {
  const row = buildRetireRow(entry('insp-000002-02'), { at: '2026-09-29T10:00:00.000Z', reason: '并入其它条目' })
  assert.deepEqual(row, {
    id: 'insp-000002-02',
    title: '灵感 insp-000002-02',
    退役时间: '2026-09-29T10:00:00.000Z',
    原因: '并入其它条目',
    原路径: '灵感库/灵感库.json',
    路径: '灵感库/灵感退役/insp-000002-02.json',
    restored: false,
    restored_at: null,
    // 🔴 history 在清单行（条目侧必须逐字节保留，不能写痕）
    history: [{ at: '2026-09-29T10:00:00.000Z', by: '学员', field: 'status', from: '预存', to: '已退役' }]
  })
})

test('⑬ upsertRetireRow：无 ⇒ 追加；有 ⇒ **整行替换**（restored 复位 false），不改入参', () => {
  const rows0 = [buildRetireRow(entry('a'), { at: 'T1' })]
  const snap = JSON.parse(JSON.stringify(rows0))
  const withB = upsertRetireRow(rows0, buildRetireRow(entry('b'), { at: 'T2' }))
  assert.deepEqual(withB.map(r => r.id), ['a', 'b'])
  // 已复原的行重新退役 ⇒ 必须复位为未复原
  const rows1 = markRetireRowRestored(withB, 'a', 'T3')
  assert.equal(rows1[0].restored, true)
  const again = upsertRetireRow(rows1, buildRetireRow(entry('a'), { at: 'T4' }))
  assert.equal(again.length, 2, '不得产生重复行')
  assert.equal(findRetireRow(again, 'a').restored, false, '重新退役应复位 restored')
  assert.equal(findRetireRow(again, 'a').退役时间, 'T4')
  assert.deepEqual(rows0, snap, '入参不得被改写')
})

test('⑭ markRetireRowRestored：打标 + 行**保留**（审计）+ 复原留痕；id 不存在 ⇒ 原样', () => {
  const rows = [buildRetireRow(entry('a'), { at: 'T1' })]
  const out = markRetireRowRestored(rows, 'a', 'T9')
  assert.equal(out.length, 1, '行必须保留（对齐 memory：清单条目保留供审计）')
  assert.equal(out[0].restored, true)
  assert.equal(out[0].restored_at, 'T9')
  // 复原留痕：追加第二条，`to` 回到退役前的状态
  assert.equal(out[0].history.length, 2)
  assert.deepEqual(out[0].history[1], { at: 'T9', by: '学员', field: 'status', from: '已退役', to: '预存' })
  assert.equal(rows[0].restored, false, '不改入参')
  assert.equal(rows[0].history.length, 1, '入参 history 不得被改写')
  assert.deepEqual(markRetireRowRestored(rows, 'zzz', 'T9'), rows)
})

// ============================== A3 limit / content ==============================
test('⑮ resolveListLimit：缺省/非法/<1 ⇒ 20；>50 ⇒ 50；正常值向下取整', () => {
  for (const v of [undefined, null, '', 'abc', 0, -3, NaN, {}]) {
    assert.equal(resolveListLimit(v), 20, String(v))
  }
  assert.equal(resolveListLimit(5), 5)
  assert.equal(resolveListLimit('7'), 7)
  assert.equal(resolveListLimit(3.9), 3)
  assert.equal(resolveListLimit(50), 50)
  assert.equal(resolveListLimit(51), 50)
  assert.equal(resolveListLimit(9999), 50)
})

test('⑯ stripContent：去掉 content、其余字段与顺序不变、不改入参', () => {
  const src = LIB3()
  const snap = JSON.parse(JSON.stringify(src))
  const out = stripContent(src)
  assert.equal(out.length, 3)
  assert.ok(!('content' in out[0]), 'content 必须被去掉')
  assert.equal(out[0].id, src[0].id)
  assert.equal(out[0].oneLiner, src[0].oneLiner)
  assert.deepEqual(Object.keys(out[0]), Object.keys(src[0]).filter(k => k !== 'content'), '字段顺序保持')
  assert.deepEqual(src, snap, '入参不得被改写')
  // 非对象项原样透传
  assert.deepEqual(stripContent([null, 1]), [null, 1])
})

// ============================== A5 世界观键告警 ==============================
test('⑰ normalizeTags / worldviewKeys：数组直用、字符串按逗号切；只取 世界观: 前缀', () => {
  assert.deepEqual(normalizeTags(' a , b ,, c '), ['a', 'b', 'c'])
  assert.deepEqual(normalizeTags(['a', '', ' b ']), ['a', 'b'])
  assert.deepEqual(normalizeTags(undefined), [])
  assert.deepEqual(worldviewKeys(['主题:废土', '世界观:同人/星穹铁道', '世界观:原创/心渊纪元']), ['同人/星穹铁道', '原创/心渊纪元'])
  assert.deepEqual(worldviewKeys('世界观:通用/母题'), ['通用/母题'])
})

test('⑱ worldviewWarn：恰好 1 个 ⇒ null；0 个 ⇒ 缺键告警；多个 ⇒ 多键告警（**均为软告警**）', () => {
  assert.equal(worldviewWarn(['主题:废土', '世界观:原创/心渊纪元']), null)
  assert.equal(worldviewWarn('世界观:通用/母题'), null)
  const miss = worldviewWarn(['主题:废土'])
  assert.match(miss, /缺少世界观键/)
  assert.match(miss, /不要自造/)
  const many = worldviewWarn(['世界观:a', '世界观:b'])
  assert.match(many, /多于一个/)
  assert.match(many, /a、b/)
})
