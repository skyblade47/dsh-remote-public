// U-45 / W-B：writing-studio 索引纯逻辑真单测（无宿主依赖 ⇒ 本地可真跑）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/index-sync-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INDEX_ENTRY_FIELDS, INDEX_ACTIONS, INDEX_SKIP_DIRS, INDEX_MAX_DEPTH,
  TOP_LEVEL_ZONE, FIXED_NAME_TYPE,
  entryDefaults, normalizeIndexPath, shouldSkipName, coveredBy, mentionsTop,
  scanRootsFromEntries, upsertEntry, diffIndex, formatMtime, refreshUpdatedAt, deriveEntry
} from '../lib/index-sync-core.js'

const NOW = '2026-09-29T18:00:00.000Z'
function E(path, over) {
  return Object.assign({
    path: path, zone: 'Z1', type: '章节正文', work: '心渊纪元', title: 'T',
    tags: [], links: [], status: '活文档', owner: '创作教练', updatedAt: '2026-09-29T17:16:20+08:00'
  }, over || {})
}

// ============================== 常量真源 ==============================
test('① 字段真源：条目十字段与附录 C 一致；path 在列', () => {
  assert.deepEqual(INDEX_ENTRY_FIELDS, ['path', 'zone', 'type', 'work', 'title', 'tags', 'links', 'status', 'owner', 'updatedAt'])
  assert.equal(INDEX_ENTRY_FIELDS[0], 'path', 'path 是主键且排首位')
  assert.deepEqual(INDEX_ACTIONS, ['indexUpsert', 'indexRebuild'])
  assert.equal(INDEX_MAX_DEPTH, 4)
  assert.ok(INDEX_SKIP_DIRS.includes('_backup'))
})

test('② entryDefaults：推导不出的**留空**（zone/type/work 空串、tags/links 空数组）', () => {
  const d = entryDefaults(NOW)
  assert.deepEqual(d, {
    path: '', zone: '', type: '', work: '', title: '', tags: [], links: [],
    status: '活文档', owner: '创作教练', updatedAt: NOW
  })
})

// ============================== path 归一（第 4 条验收的底） ==============================
test('③ normalizeIndexPath：合法（含目录级 / 反斜杠归一 / 折叠 //）', () => {
  assert.deepEqual(normalizeIndexPath('设定/心渊纪元/人物.md'), { ok: true, path: '设定/心渊纪元/人物.md' })
  assert.deepEqual(normalizeIndexPath('  草稿/心渊纪元/第01章-秘密会议.md  '), { ok: true, path: '草稿/心渊纪元/第01章-秘密会议.md' })
  assert.deepEqual(normalizeIndexPath('草稿\\心渊纪元\\x.md'), { ok: true, path: '草稿/心渊纪元/x.md' })
  assert.deepEqual(normalizeIndexPath('草稿//a.md'), { ok: true, path: '草稿/a.md' })
  assert.deepEqual(normalizeIndexPath('草稿/.archive/'), { ok: true, path: '草稿/.archive/' }, '目录级（excluded 用）')
})

test('④ normalizeIndexPath：非法 ⇒ ok:false（空 / 绝对 / .. / 带根名）——**绝不写文件**的前置', () => {
  for (const v of [undefined, null, '', '   ', '/', '/etc/passwd']) {
    assert.equal(normalizeIndexPath(v).ok, false, String(v))
  }
  assert.match(normalizeIndexPath('/abs/a.md').error, /根内相对/)
  assert.match(normalizeIndexPath('C:/x/a.md').error, /绝对路径/)
  assert.match(normalizeIndexPath('草稿/../../etc/passwd').error, /\.\./)
  assert.match(normalizeIndexPath('写作训练/草稿/a.md').error, /不要带根名/)
})

// ============================== 列举跳过规则 ==============================
test('⑤ shouldSkipName：点开头 / .bak / _backup / node_modules 一律跳过', () => {
  for (const n of ['.archive', '.deleted', '.tombstones.json', '_backup', 'node_modules', '灵感库.json.bak-clean-20260929', 'x.bak']) {
    assert.equal(shouldSkipName(n), true, n)
  }
  for (const n of ['草稿', '灵感库.json', '第01章.md', 'README.md', '其他']) {
    assert.equal(shouldSkipName(n), false, n)
  }
  assert.equal(shouldSkipName(''), true)
})

test('⑥ coveredBy：精确项 + **目录级前缀**（以 / 结尾覆盖其下全部）', () => {
  const pool = ['草稿/README.md', '规范/', '草稿/.archive/', '其他/x.md']
  assert.equal(coveredBy('草稿/README.md', pool), true)
  assert.equal(coveredBy('规范/写作规范.md', pool), true, '目录级覆盖')
  assert.equal(coveredBy('草稿/.archive/深/层/a.md', pool), true)
  assert.equal(coveredBy('草稿/心渊纪元/第01章.md', pool), false)
  assert.deepEqual(coveredBy('x', undefined), false)
  // mentionsTop 是 coveredBy 的**反向**：池中项落在该顶层目录下 = 提及
  assert.equal(mentionsTop(['草稿/README.md'], '草稿'), true)
  assert.equal(mentionsTop(['草稿/.archive/'], '草稿'), true, '目录级也算提及')
  assert.equal(mentionsTop(['规范/'], '规范'), true)
  assert.equal(mentionsTop(['设定/a/人物.md'], '草稿'), false)
  assert.equal(mentionsTop([], '草稿'), false)
})

// ============================== 扫描根反推 ==============================
test('⑦ scanRootsFromEntries：反推顶层目录（去重+排序）；**跳过根级散件与点开头**', () => {
  const roots = scanRootsFromEntries([
    E('草稿/a/第01章.md'), E('草稿/b/第02章.md'), E('设定/a/人物.md'),
    E('会话工作文档/创作教练/文件地图.md'), E('灵感库/灵感库.json'),
    E('写作记录.json'),            // 根级散件 ⇒ 不是"目录"，不进
    E('.hidden/x.md')              // 点开头 ⇒ 不进
  ])
  assert.deepEqual(roots, ['会话工作文档', '灵感库', '草稿', '设定'])
  assert.deepEqual(scanRootsFromEntries([]), [])
})

// ============================== upsert ==============================
test('⑧ upsertEntry 新建：未给字段取默认（**留空**），path 正确，created:true，不改入参', () => {
  const src = [E('草稿/a/第01章.md')]
  const snap = JSON.parse(JSON.stringify(src))
  const out = upsertEntry(src, { path: '其他/新件.md' }, NOW)
  assert.equal(out.ok, true)
  assert.equal(out.created, true)
  assert.equal(out.entries.length, 2)
  const added = out.entries[1]
  assert.equal(added.path, '其他/新件.md')
  assert.equal(added.zone, '', '推不出 ⇒ 留空')
  assert.equal(added.type, '')
  assert.equal(added.work, '')
  assert.equal(added.updatedAt, NOW)
  assert.deepEqual(src, snap, '入参不得被改写')
})

test('⑨ upsertEntry 已存在：**只覆盖 patch 里显式出现的字段**，其余一字不动；created:false', () => {
  const src = [E('草稿/a/第01章.md', { title: '原标题', tags: ['主题:旧'], work: '心渊纪元' })]
  const out = upsertEntry(src, { path: '草稿/a/第01章.md', title: '新标题' }, NOW)
  assert.equal(out.created, false)
  assert.equal(out.entries.length, 1)
  const e = out.entries[0]
  assert.equal(e.title, '新标题', 'patch 里给了 ⇒ 改')
  assert.deepEqual(e.tags, ['主题:旧'], 'patch 里没给 ⇒ **绝不覆盖**')
  assert.equal(e.work, '心渊纪元', 'patch 里没给 ⇒ **绝不覆盖**')
  assert.equal(e.updatedAt, NOW, 'updatedAt 随写入刷新')
})

test('⑩ upsertEntry：非法 path ⇒ ok:false（调用方据此 400，**不写文件**）', () => {
  assert.equal(upsertEntry([], { path: '../x.md' }, NOW).ok, false)
  assert.equal(upsertEntry([], { path: '/abs.md' }, NOW).ok, false)
  assert.equal(upsertEntry([], {}, NOW).ok, false)
})

// ============================== 三方对照 ==============================
test('⑪ diffIndex ①新增候选：盘上有、entries/excluded 都没有 ⇒ 列出（**只报不建**）', () => {
  const r = diffIndex({
    diskFiles: ['草稿/a/第01章.md', '草稿/a/新件.md', '结构/a.md'],
    entries: [E('草稿/a/第01章.md')],
    excluded: []
  })
  assert.deepEqual(r.newCandidates, ['结构/a.md', '草稿/a/新件.md'])
})

test('⑫ diffIndex ①新增候选：被 excluded **目录级**覆盖 ⇒ 不算新增', () => {
  const r = diffIndex({
    diskFiles: ['草稿/.archive/x/a.md', '规范/写作规范.md', '草稿/a/新件.md'],
    entries: [],
    excluded: [{ path: '草稿/.archive/' }, { path: '规范/' }]
  })
  assert.deepEqual(r.newCandidates, ['草稿/a/新件.md'])
})

test('⑬ diffIndex ②缺失：existsMap **优先**（覆盖点开头目录），且**绝不自动删**', () => {
  const r = diffIndex({
    diskFiles: [],                                  // 列举口径看不见 .archive
    entries: [E('草稿/.archive/_阶段习作/D4.md'), E('草稿/a/第01章.md')],
    excluded: [],
    existsMap: { '草稿/.archive/_阶段习作/D4.md': true, '草稿/a/第01章.md': false }
  })
  assert.deepEqual(r.missingOnDisk, ['草稿/a/第01章.md'], 'existsMap 说在 ⇒ 不算缺失（列举口径的假缺失被排除）')
})

test('⑭ diffIndex ③excluded 消失 + ④新顶层目录（目录级不判存在性）', () => {
  const r = diffIndex({
    diskFiles: [], entries: [], excluded: [{ path: '草稿/README.md' }, { path: '规范/' }],
    existsMap: { '草稿/README.md': false },
    topLevelDirs: ['草稿', '设定', '日志', '规范', 'brand-new']
  })
  assert.deepEqual(r.excludedGone, ['草稿/README.md'], '目录级 excluded 不判存在性')
  assert.deepEqual(r.newTopLevelDirs, ['brand-new', '日志', '设定'],
    '只报"**未被索引提及**"的顶层目录：草稿（被 草稿/README.md 提及）/规范（被 规范/ 提及）都不算；日志与设定确未涉及 ⇒ 如实报出')
})

test('⑮ diffIndex ⑤path 漂移：只对**缺失**项、且盘上别处有同名文件', () => {
  const r = diffIndex({
    diskFiles: ['草稿/b/第01章.md'],
    entries: [E('草稿/a/第01章.md')],
    excluded: [],
    existsMap: { '草稿/a/第01章.md': false }
  })
  assert.deepEqual(r.missingOnDisk, ['草稿/a/第01章.md'])
  assert.deepEqual(r.pathDrift, [{ path: '草稿/a/第01章.md', sameNameAt: ['草稿/b/第01章.md'] }])
})

// ============================== updatedAt ==============================
test('⑯ formatMtime：索引既有口径 `YYYY-MM-DDTHH:mm:ss+08:00`', () => {
  // 2026-09-29T17:16:20+08:00 == 2026-09-29T09:16:20Z
  const ms = Date.UTC(2026, 8, 29, 9, 16, 20)
  assert.equal(formatMtime(ms), '2026-09-29T17:16:20+08:00')
  assert.equal(formatMtime(ms, 0), '2026-09-29T09:16:20+00:00')
  assert.equal(formatMtime(ms, -300), '2026-09-29T04:16:20-05:00')
})

test('⑰ refreshUpdatedAt：**只动 updatedAt**、列出 changed、mtime 缺失则跳过、不改入参', () => {
  const src = [
    E('a.md', { updatedAt: '2026-09-29T17:16:20+08:00' }),
    E('b.md', { updatedAt: '2026-09-01T00:00:00+08:00' }),
    E('c.md', { updatedAt: '保持不动' })
  ]
  const snap = JSON.parse(JSON.stringify(src))
  const ms = Date.UTC(2026, 8, 29, 9, 16, 20)
  const out = refreshUpdatedAt(src, { 'a.md': ms, 'b.md': ms }, 480)
  assert.deepEqual(out.changed, ['b.md'], 'a.md 的 updatedAt 已等于目标值 ⇒ 不算变化')
  assert.equal(out.entries[0].updatedAt, '2026-09-29T17:16:20+08:00')
  assert.equal(out.entries[1].updatedAt, '2026-09-29T17:16:20+08:00')
  assert.equal(out.entries[2].updatedAt, '保持不动', 'mtime 缺失 ⇒ 跳过')
  // 只动 updatedAt：其余字段逐条相等
  for (let i = 0; i < src.length; i++) {
    const a = Object.assign({}, out.entries[i]); delete a.updatedAt
    const b = Object.assign({}, src[i]); delete b.updatedAt
    assert.deepEqual(a, b, '除 updatedAt 外不得有任何变化（第 ' + i + ' 条）')
  }
  assert.deepEqual(src, snap, '入参不得被改写')
})

// ============================== 机械推导（仅 createMissing 用） ==============================
test('⑱ deriveEntry：能推的推出（zone by 顶层、type by 固定名、work by 二级）；推不出**留空并点名**', () => {
  const a = deriveEntry('设定/心渊纪元/人物.md')
  assert.equal(a.entry.zone, 'Z3')
  assert.equal(a.entry.type, '人物卡')
  assert.equal(a.entry.work, '心渊纪元')
  assert.deepEqual(a.unresolved, [])

  const b = deriveEntry('会话工作文档/创作教练/文件地图.md')
  assert.equal(b.entry.zone, 'Z9')
  assert.equal(b.entry.type, '', '非固定名 ⇒ type 留空')
  assert.ok(b.unresolved.includes('type'), '推不出必须点名 ⇒ 进 needsJudgement')

  const c = deriveEntry('草稿/第01章-x.md')
  assert.equal(c.entry.zone, 'Z1')
  assert.ok(c.unresolved.includes('work'), '草稿下但没有作品层 ⇒ work 留空并点名')

  assert.equal(TOP_LEVEL_ZONE['上传'], 'Z7')
  assert.equal(FIXED_NAME_TYPE['伏笔回收.md'], '伏笔与回收清单')
})

// ============================== 己：已登记的顶层目录 ==============================
test('⑲ 己 excludedTopLevel：**已登记**"有意不索引"的顶层目录不再报；未登记的仍报', () => {
  const base = { diskFiles: [], entries: [], excluded: [], topLevelDirs: ['草稿', '日志', '邮件桥', '待导入设定'] }
  // 未登记 ⇒ 全报
  assert.deepEqual(diffIndex(base).newTopLevelDirs.slice().sort(), ['待导入设定', '日志', '草稿', '邮件桥'].sort())
  // 登记两个 ⇒ 不再报它们；未登记的（草稿/待导入设定）仍报
  const r1 = diffIndex(Object.assign({}, base, { excludedTopLevel: ['日志', '邮件桥'] }))
  assert.deepEqual(r1.newTopLevelDirs.slice().sort(), ['待导入设定', '草稿'].sort(),
    '⚪ 未登记的仍报（`待导入设定` 故意不登记 ⇒ 继续提醒有人看一眼）')
  // 全登记 ⇒ 空
  assert.deepEqual(diffIndex(Object.assign({}, base, { excludedTopLevel: ['日志', '邮件桥', '待导入设定', '草稿'] })).newTopLevelDirs, [])
  // 登记项不存在于盘上也不报错（宽松）
  assert.deepEqual(diffIndex(Object.assign({}, base, { excludedTopLevel: ['不存在的目录'] })).newTopLevelDirs.slice().sort(),
    ['待导入设定', '日志', '草稿', '邮件桥'].sort())
  // 缺省/非数组 ⇒ 不抛
  assert.deepEqual(diffIndex(Object.assign({}, base, { excludedTopLevel: undefined })).newTopLevelDirs.length, 4)
})
