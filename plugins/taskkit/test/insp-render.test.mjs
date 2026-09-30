// U-49（2026-09-30）：`insp_list` / `insp_search` 的**模型可见渲染**与**标签前缀过滤**契约锁
// 用法（仓库根目录）：node --test plugins/taskkit/test/insp-render.test.mjs
//
// 锁的起因（真机实证）：这两个工具的 `output.render` 原来只返回 `summary` 一行计数，
// entries 全走 presentationMeta（= 客户端 UI 投影，不进模型上下文）⇒ **agent 看不到任何 id/标题/标签**。
// 灵感工坊（session-9ee72482）因此报"条目明细(标题/正文/id)读不出来"，且只能靠"猜键—看计数"探测世界观键。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderInspListText,
  filterTagsPrefix,
  clipFlat,
  clipBlock,
  INSP_RENDER_CONTENT_CAP
} from '../lib/insp-render-core.js'

// ---------- 夹具（形状对齐 inspListPage 的返回值）----------
function entry(id, over) {
  return Object.assign({
    id: id, number: '', title: '灵感 ' + id, oneLiner: '一句话', content: '正文……',
    tags: ['主题:废土', '世界观:原创/心渊纪元'], status: '预存', category: '待启动',
    fixed: false, settingsRef: '', hook: '', source: ''
  }, over || {})
}
function page(entries, over) {
  const n = entries.length
  return Object.assign({
    ok: true, count: n, returned: n, truncated: false, limit: 20,
    entries: entries, summary: '灵感库 ' + n + ' 条（库内 ' + n + ' 条）'
  }, over || {})
}

// ============================== ① 回归锁：明细必须进模型可见文本 ==============================
test('① renderInspListText：**默认就带 id / 标题 / 状态 / 世界观键**（这就是"读不出来"那个 bug 的锁）', () => {
  const txt = renderInspListText({}, page([entry('insp-000001-01')]))
  assert.ok(txt.indexOf('insp-000001-01') >= 0, '必须出现 id')
  assert.ok(txt.indexOf('灵感 insp-000001-01') >= 0, '必须出现标题')
  assert.ok(txt.indexOf('世界观:原创/心渊纪元') >= 0, '世界观键必须**带前缀**出现（可直接复制做 tags 过滤）')
  assert.ok(txt.indexOf('状态=预存') >= 0, '必须出现状态')
  assert.ok(txt.indexOf('主题:废土') >= 0, '其他标签要在（且与世界观键分开列）')
  // 世界观键与其他标签分列 ⇒ 世界观行里不应混入「主题:废土」
  const wvLine = txt.split('\n').find((l) => l.indexOf('世界观键：') >= 0)
  assert.equal(wvLine.indexOf('主题:废土'), -1, '世界观键行不得混入其他标签')
})

test('② includeContent 语义：默认**不含正文**，只在 true 时带（且 id/标题/标签两种情况下都在）', () => {
  const p = page([entry('insp-000001-01', { content: '正文全文甲乙丙' })])
  const off = renderInspListText({}, p)
  assert.equal(off.indexOf('正文全文甲乙丙'), -1, '默认不得带正文')
  assert.ok(off.indexOf('insp-000001-01') >= 0 && off.indexOf('世界观:原创/心渊纪元') >= 0, '默认仍须带 id/键')
  const on = renderInspListText({ includeContent: 'true' }, p)
  assert.ok(on.indexOf('正文全文甲乙丙') >= 0, 'includeContent=true 必须带正文')
})

test('③ 截断：超长一句话/正文按上限截断并标注原长度（token 安全）', () => {
  const long = '甲'.repeat(INSP_RENDER_CONTENT_CAP + 100)
  const txt = renderInspListText({ includeContent: 'true' }, page([entry('insp-000001-01', { oneLiner: '乙'.repeat(300), content: long })]))
  assert.ok(txt.indexOf('已截断，原 300 字') >= 0, '一句话截断须标注原长')
  assert.ok(txt.indexOf('已截断，原 ' + long.length + ' 字') >= 0, '正文截断须标注原长')
  assert.equal(txt.indexOf(long), -1, '超长正文**不得原样出现**（确实被截断了）')
  assert.equal(clipFlat('abc', 10), 'abc', '未超限不过截断')
  assert.equal(clipBlock('a\nb', 10), 'a\nb', '块字段保留换行')
})

test('④ 截断提示：truncated 时明说"只渲染 N 条 / 命中 M 条 + 出路"', () => {
  const txt = renderInspListText({}, page([entry('insp-000001-01')], { count: 31, returned: 1, truncated: true, limit: 1 }))
  assert.ok(txt.indexOf('只渲染 1 条') >= 0 && txt.indexOf('命中 31 条') >= 0, '须报渲染数/命中数')
  assert.ok(txt.indexOf('tagsPrefix') >= 0, '须给出枚举/收窄的出路')
})

test('⑤ 空结果与失败：只回 summary，不抛错、不伪造条目', () => {
  assert.equal(renderInspListText({}, page([], { count: 0, summary: '灵感库 0 条（库内 31 条）' })), '灵感库 0 条（库内 31 条）')
  const bad = renderInspListText({}, { ok: false, error: 'x', summary: '失败：x' })
  assert.equal(bad, '失败：x')
  assert.equal(renderInspListText({}, null), '')
})

// ============================== ② 前缀过滤语义 ==============================
test('⑥ filterTagsPrefix：`世界观:` 命中全部带键条目；`世界观:原创/` 只命中该大类', () => {
  const list = [
    entry('a', { tags: ['世界观:原创/心渊纪元'] }),
    entry('b', { tags: ['世界观:原创/未立项/缘系统'] }),
    entry('c', { tags: ['世界观:同人/绝区零同人'] }),
    entry('d', { tags: ['主题:废土'] })
  ]
  const ids = (r) => r.map((e) => e.id).join(',')
  assert.equal(ids(filterTagsPrefix(list, '世界观:')), 'a,b,c')
  assert.equal(ids(filterTagsPrefix(list, '世界观:原创/')), 'a,b')
  assert.equal(ids(filterTagsPrefix(list, '世界观:同人/')), 'c')
  // 前缀语义：`世界观:原创` 是 `世界观:原创/心渊纪元` 的前缀 ⇒ **应当命中**（这正是它比 tags 整值匹配能枚举的原因）
  assert.equal(ids(filterTagsPrefix(list, '世界观:原创')), 'a,b')
  assert.equal(ids(filterTagsPrefix(list, '主题:')), 'd')
})

test('⑦ filterTagsPrefix：空/缺省 prefix 原样返回（**拷贝**，不改调用方数组）；无 tags 条目不被命中', () => {
  const list = [entry('a'), entry('b', { tags: [] }), entry('c', { tags: undefined })]
  assert.equal(filterTagsPrefix(list, '').length, 3)
  assert.equal(filterTagsPrefix(list, undefined).length, 3)
  assert.notEqual(filterTagsPrefix(list, ''), list, '必须返回新数组（不得别名）')
  assert.equal(filterTagsPrefix(list, '世界观:').length, 1, '无 tags 的条目不得被前缀命中')
  assert.equal(filterTagsPrefix(null, '世界观:').length, 0)
})

test('⑧ 契约：两个工具共用同一渲染函数 ⇒ 渲染面一致（防"改一个漏一个"）', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'))
  const ours = src.match(/text: renderInspListText\(args, value\)/g) || []
  assert.equal(ours.length, 2, 'insp_list 与 insp_search **两处**都必须走 renderInspListText')
  // 逐工具段检查：这两个工具的 render 里**不得**残留 summary-only 写法
  const seg = (name) => {
    const i = src.indexOf("name: '" + name + "'")
    const j = src.indexOf('registerTool({', i)
    return src.slice(i, j < 0 ? src.length : j)
  }
  for (const n of ['insp_list', 'insp_search']) {
    const s = seg(n)
    assert.ok(s.indexOf('renderInspListText') >= 0, n + ' 必须走新渲染')
    assert.equal(s.indexOf('? value.summary : JSON.stringify(value)'), -1, n + ' 不得残留 summary-only 渲染')
    assert.ok(s.indexOf('tagsPrefix') >= 0, n + ' 必须暴露 tagsPrefix 参数')
  }
})
