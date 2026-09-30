// U-41 / P2（2026-09-29）：客户端「提交」纯逻辑真单测（无宿主依赖 ⇒ 本地可真跑）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/submit-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIENT_ZONE_REL, CLIENT_BODY_REL, CLIENT_LOG_REL, CLIENT_PROGRESS_REL, CLIENT_RECYCLE_REL,
  SUBMIT_PREFIX, ARCHIVE_PREFIX, SUPERSEDE_KIND,
  normalizeSubmitTarget, findArchivedSiblings, supersedeLink, withSupersede, withOriginSource, ORIGIN_KIND,
  buildSubmitLogRow, decideSubmitWrite, submitVersion, SUBMIT_SIZE_LIMIT, archivePathOf
} from '../lib/submit-core.js'

// ============================== 常量 ==============================
test('① 区域常量：客户端区与 写作训练 平级；四个子域齐；落点前缀正确', () => {
  assert.equal(CLIENT_ZONE_REL, '客户端区')
  assert.equal(CLIENT_BODY_REL, '客户端区/正文')
  assert.equal(CLIENT_PROGRESS_REL, '客户端区/进度')
  assert.equal(CLIENT_RECYCLE_REL, '客户端区/回收')
  assert.equal(CLIENT_LOG_REL, '客户端区/提交记录.jsonl')
  assert.equal(SUBMIT_PREFIX, '写作训练/草稿/')
  assert.equal(ARCHIVE_PREFIX, '草稿/.archive/')
  assert.equal(SUPERSEDE_KIND, '替代')
  assert.equal(SUBMIT_SIZE_LIMIT, 2 * 1024 * 1024)
})

// ============================== 目标归一 ==============================
test('② normalizeSubmitTarget 正例：doc 自动补 .md；三条路径口径各不相同且正确', () => {
  const r = normalizeSubmitTarget('心渊纪元', '第01章-秘密会议')
  assert.equal(r.ok, true)
  assert.equal(r.work, '心渊纪元')
  assert.equal(r.doc, '第01章-秘密会议.md')
  assert.equal(r.indexPath, '草稿/心渊纪元/第01章-秘密会议.md', '索引用「相对 写作训练」')
  assert.equal(r.wsRel, '写作训练/草稿/心渊纪元/第01章-秘密会议.md', '落点用「工作区相对」')
  assert.equal(r.bodyWsRel, '客户端区/正文/心渊纪元/第01章-秘密会议.md', '源用「工作区相对」')

  assert.equal(normalizeSubmitTarget('心渊纪元', '第01章.md').doc, '第01章.md', '已带 .md 不重复补')
  assert.equal(normalizeSubmitTarget('心渊纪元', '第01章.MD').doc, '第01章.MD', '后缀大小写不敏感')
  assert.equal(normalizeSubmitTarget('  心渊纪元  ', ' 第01章 ').work, '心渊纪元', '首尾空白去掉')
})

test('③ normalizeSubmitTarget 非法 ⇒ ok:false（缺参 / 含分隔符 / 点开头 / . .. / 过长）', () => {
  assert.equal(normalizeSubmitTarget('', 'a').code, 'BAD_WORK')
  assert.equal(normalizeSubmitTarget('w', '').code, 'BAD_DOC')
  assert.equal(normalizeSubmitTarget('a/b', 'x').code, 'BAD_WORK', 'work 含 / ⇒ 拒')
  assert.equal(normalizeSubmitTarget('w', 'a/b').code, 'BAD_DOC', 'doc 含 / ⇒ 拒')
  assert.equal(normalizeSubmitTarget('a\\b', 'x').code, 'BAD_WORK', 'work 含 \\ ⇒ 拒')
  assert.equal(normalizeSubmitTarget('.archive', 'x').code, 'BAD_PATH', 'work 点开头 ⇒ 拒（**挡归档区**）')
  assert.equal(normalizeSubmitTarget('w', '.hidden').code, 'BAD_PATH', 'doc 点开头 ⇒ 拒')
  assert.equal(normalizeSubmitTarget('..', 'x').code, 'BAD_PATH')
  assert.equal(normalizeSubmitTarget('w', '..').code, 'BAD_PATH')
  assert.equal(normalizeSubmitTarget('x'.repeat(81), 'a').code, 'BAD_PATH', 'work 过长')
  assert.equal(normalizeSubmitTarget('w', 'a'.repeat(121)).code, 'BAD_PATH', 'doc 过长')
})

// ============================== 归档同名检测 ==============================
test('④ findArchivedSiblings：只认 .archive 前缀；basename 大小写不敏感；多命中排序', () => {
  const pool = [
    '草稿/.archive/_阶段习作/D9_一生一次的美味_定稿_2026-08-31.md',
    '草稿/.archive/_版本前照片/D9_一生一次的美味_定稿_2026-08-31.md',
    '草稿/心渊纪元/第01章-秘密会议.md',                     // 不在归档区 ⇒ 不算
    '草稿/.archive/上传/崩铁世界观重设_核心设定.md',
    '草稿/.archive/_阶段习作/README.md',
    '草稿/.archive/_阶段习作/not-md.txt'                    // 非 .md ⇒ 不算
  ]
  const hit = findArchivedSiblings(pool, 'D9_一生一次的美味_定稿_2026-08-31.md')
  assert.deepEqual(hit, [
    '草稿/.archive/_版本前照片/D9_一生一次的美味_定稿_2026-08-31.md',
    '草稿/.archive/_阶段习作/D9_一生一次的美味_定稿_2026-08-31.md'
  ], '两处同名都命中且已排序')
  assert.deepEqual(findArchivedSiblings(pool, 'd9_一生一次的美味_定稿_2026-08-31.MD'), hit, '大小写不敏感')
  assert.deepEqual(findArchivedSiblings(pool, '第01章-秘密会议.md'), [], '不在归档区 ⇒ 不算')
  assert.deepEqual(findArchivedSiblings(pool, 'not-md.txt'), [], '非 .md ⇒ 不算')
  assert.deepEqual(findArchivedSiblings(pool, ''), [])
  assert.deepEqual(findArchivedSiblings(undefined, 'x.md'), [])
})

// ============================== 替代关联 ==============================
test('⑤ supersedeLink：形状固定（to=doc:<归档路径> / kind=替代 / note 带日期）', () => {
  assert.deepEqual(supersedeLink('草稿/.archive/_阶段习作/A.md', '2026-09-29'), {
    to: 'doc:草稿/.archive/_阶段习作/A.md',
    kind: '替代',
    note: '提交于 2026-09-29，取代该归档件'
  })
})

test('⑤b archivePathOf：拼接归档 path **绝不产生双斜杠**（实测 bug 的回归锁）', () => {
  assert.equal(archivePathOf(''), '草稿/.archive/', '目录级')
  assert.equal(archivePathOf('A.md'), '草稿/.archive/A.md')
  assert.equal(archivePathOf('_阶段习作/A.md'), '草稿/.archive/_阶段习作/A.md')
  assert.equal(archivePathOf('a/b/c.md'), '草稿/.archive/a/b/c.md')
  // 🔴 回归锁：下面这些拼法以前会产出 `草稿/.archive//…`
  for (const bad of ['', '/', '//', 'a//b.md', '/a/b.md', 'a/b.md/', undefined, null]) {
    const p = archivePathOf(bad)
    assert.ok(p.indexOf('//') < 0, '不得含双斜杠：' + JSON.stringify(bad) + ' → ' + p)
    assert.ok(p.indexOf(ARCHIVE_PREFIX) === 0, '必须以归档前缀开头：' + p)
  }
  // 与 findArchivedSiblings 串起来：拼出来的路径必须能被识别为归档件
  assert.deepEqual(findArchivedSiblings([archivePathOf('X/更新版.md')], '更新版.md'), ['草稿/.archive/X/更新版.md'])
})

test('⑥ withSupersede 正例：为每个命中追加一条；**不改入参**', () => {
  const src = [{ to: 'doc:规划/心渊纪元/结构.md', kind: '引用', note: 'X' }]
  const snap = JSON.parse(JSON.stringify(src))
  const hits = ['草稿/.archive/a/A.md', '草稿/.archive/b/A.md']
  const r = withSupersede(src, hits, '2026-09-29')
  assert.equal(r.links.length, 3)
  assert.equal(r.added.length, 2)
  assert.equal(r.links[0].kind, '引用', '原有 link 保持原位')
  assert.deepEqual(r.links.slice(1, 3).map(l => l.to), ['doc:草稿/.archive/a/A.md', 'doc:草稿/.archive/b/A.md'])
  assert.deepEqual(src, snap, '入参不得被改写')
})

test('⑦ withSupersede 幂等：同一 to 的「替代」已存在 ⇒ 不重复追加', () => {
  const links = [{ to: 'doc:草稿/.archive/a/A.md', kind: '替代', note: '早先' }]
  const r = withSupersede(links, ['草稿/.archive/a/A.md'], '2026-09-29')
  assert.equal(r.links.length, 1, '不重复')
  assert.equal(r.added.length, 0)
  assert.equal(r.links[0].note, '早先', '原有那条不被改写')
  // 新增的那条才追加（混合场景）
  const r2 = withSupersede(links, ['草稿/.archive/a/A.md', '草稿/.archive/b/B.md'], '2026-09-29')
  assert.equal(r2.links.length, 2)
  assert.deepEqual(r2.added.map(l => l.to), ['doc:草稿/.archive/b/B.md'])
})

test('⑧ withSupersede：空命中/空 links/非法入参 都不抛', () => {
  assert.deepEqual(withSupersede([], [], 'D').links, [])
  assert.deepEqual(withSupersede(undefined, undefined, 'D').links, [])
  assert.equal(withSupersede(undefined, ['草稿/.archive/x/y.md'], 'D').links.length, 1)
})

// ============================== 提交记录 ==============================
test('⑨ buildSubmitLogRow：字段齐全（含 supersedes 数组），缺项填空不抛', () => {
  const row = buildSubmitLogRow({
    ts: '2026-09-29T18:00:00+08:00', deviceId: 'dev-A', work: '心渊纪元', doc: '第01章.md',
    path: '写作训练/草稿/心渊纪元/第01章.md', from: '客户端区/正文/心渊纪元/第01章.md',
    version: 'v1-abc123', action: 'create', supersedes: ['草稿/.archive/x.md']
  })
  assert.deepEqual(row, {
    ts: '2026-09-29T18:00:00+08:00', deviceId: 'dev-A', work: '心渊纪元', doc: '第01章.md',
    path: '写作训练/草稿/心渊纪元/第01章.md', from: '客户端区/正文/心渊纪元/第01章.md',
    version: 'v1-abc123', action: 'create', supersedes: ['草稿/.archive/x.md']
  })
  const bare = buildSubmitLogRow()
  assert.equal(bare.deviceId, '')
  assert.deepEqual(bare.supersedes, [])
})

// ============================== 覆盖语义（复用既有闸，不另立口径） ==============================
test('⑩ decideSubmitWrite 直接转发 draft-save 的闸：不存在⇒create / 无版本⇒冲突 / 版本符⇒覆盖', () => {
  assert.equal(decideSubmitWrite({ exists: false }).action, 'create')
  assert.equal(decideSubmitWrite({ exists: true, force: true }).action, 'overwrite')
  const c = decideSubmitWrite({ exists: true, currentVersion: 'v1-x' })
  assert.equal(c.action, 'conflict')
  assert.equal(c.code, 'VERSION_CONFLICT')
  assert.equal(decideSubmitWrite({ exists: true, baseVersion: 'v1-x', currentVersion: 'v1-x' }).action, 'overwrite')
  assert.equal(decideSubmitWrite({ exists: true, baseVersion: 'v1-old', currentVersion: 'v1-x' }).action, 'conflict')
})

test('⑪ submitVersion：同内容同串、异内容异串', () => {
  assert.equal(submitVersion('abc'), submitVersion('abc'))
  assert.notEqual(submitVersion('abc'), submitVersion('abd'))
})

// ============================== 端到端纯逻辑：本问题的核心场景 ==============================
test('⑫ 核心场景：提交「已归档文档的更新版」⇒ 落点新建 + 自动补「替代」 + 归档件不动', () => {
  const t = normalizeSubmitTarget('心渊纪元', '第01章-秘密会议')
  assert.equal(t.ok, true)
  // 归档区里存在同名（原件已被归档）
  const archivePaths = [
    '草稿/.archive/_版本前照片/第01章-秘密会议.md',
    '草稿/心渊纪元/第02章-别的.md'
  ]
  const hits = findArchivedSiblings(archivePaths, t.doc)
  assert.deepEqual(hits, ['草稿/.archive/_版本前照片/第01章-秘密会议.md'])
  // 目标路径为空（原件已移走）⇒ create（**不会碰到归档件**）
  assert.equal(decideSubmitWrite({ exists: false }).action, 'create')
  // 新条目自动带单向「替代」关联
  const built = withSupersede([], hits, '2026-09-29')
  assert.deepEqual(built.links, [{
    to: 'doc:草稿/.archive/_版本前照片/第01章-秘密会议.md',
    kind: '替代',
    note: '提交于 2026-09-29，取代该归档件'
  }])
  // 归档件路径**只出现在 link 的 to 里**（只读引用），本模块没有任何"写归档"的出口
  assert.equal(built.links[0].to.indexOf('doc:草稿/.archive/'), 0)
})

// ============================== 甲：submit 记「来源」==============================
test('⑬ 甲 withOriginSource：形状固定 + **幂等** + 与「替代」共存 + 不改入参', () => {
  assert.equal(ORIGIN_KIND, '来源')
  const BODY = '客户端区/正文/心渊纪元/第01章.md'
  const r1 = withOriginSource([], BODY, '2026-09-29', 'dev-A')
  assert.deepEqual(r1.links, [{
    to: 'client:' + BODY, kind: '来源', note: '客户端提交于 2026-09-29；设备 dev-A'
  }])
  // 幂等：同 to 不重复追加
  const r2 = withOriginSource(r1.links, BODY, '2026-09-30', 'dev-B')
  assert.equal(r2.links.length, 1, '同 to 不重复追加')
  assert.equal(r2.added, null)
  assert.equal(r2.links[0].note.indexOf('dev-A') > 0, true, '原有那条不被改写')
  // 与「替代」共存（两类 link 语义不同：来源=谁给的；替代=取代了谁）
  const sup = withSupersede(r1.links, ['草稿/.archive/a/A.md'], '2026-09-29')
  const both = withOriginSource(sup.links, BODY, '2026-09-29', 'dev-A')
  assert.equal(both.links.length, 2, '两类共存')
  assert.deepEqual(both.links.map(l => l.kind).sort(), ['来源', '替代'].sort())
  assert.equal(both.added, null, '来源已存在 ⇒ 仍幂等')
  // 无 deviceId 时 note 不带设备段
  assert.equal(withOriginSource([], '客户端区/正文/x.md', '2026-09-29', '').links[0].note, '客户端提交于 2026-09-29')
  // 不改入参
  const src = [{ to: 'client:a', kind: '来源', note: 'n' }]
  const snap = JSON.parse(JSON.stringify(src))
  withOriginSource(src, 'b', 'D', 'x')
  assert.deepEqual(src, snap, '入参不得被改写')
  // 空/非法入参不抛
  assert.equal(withOriginSource(undefined, undefined, 'D', undefined).links.length, 1)
})
