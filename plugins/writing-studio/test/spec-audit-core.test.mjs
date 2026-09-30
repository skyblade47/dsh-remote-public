// U-41 / P5（2026-09-29）：规范体检纯逻辑真单测。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/spec-audit-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORLDVIEW_PREFIX, STALE_ALIASES, ZONES_NEEDING_WORK,
  auditIndex, auditInsp, auditSettingsRef, auditArchiveLinks,
  extractBetween, compareSpec, buildReport,
  extractByLineAnchors, extractFindSpec, extractWriteSpec, formatAuditLines
} from '../lib/spec-audit-core.js'

function E(path, over) {
  return Object.assign({ path: path, zone: 'Z1', type: '章节正文', work: '心渊纪元', title: 'T', tags: [], links: [], status: '活文档' }, over || {})
}

// ============================== ① 索引组 ==============================
test('① auditIndex：缺 type / 缺 zone / **需要 work 的区**缺 work；其余区空 work 不报', () => {
  const r = auditIndex({
    entries: [
      E('草稿/a/一.md'),
      E('草稿/b/二.md', { type: '' }),
      E('草稿/c/三.md', { zone: '' }),
      E('草稿/d/四.md', { work: '' }),
      E('会话工作文档/创作教练/文件地图.md', { zone: 'Z9', type: '文件地图', work: '' }),  // Z9 空 work ⇒ 正常
      E('上传/x.md', { zone: 'Z7', type: '上传件', work: '' }),                          // Z7 空 work ⇒ 正常
      E('过程/_模板/批改记录模板.md', { zone: 'Z4', type: '模板', work: '' }),            // 下划线目录 ⇒ **不要求 work**
      E('草稿/.archive/_版本前照片/老件.md', { status: '归档', zone: 'Z1', type: '', work: '' })  // 归档件 ⇒ **整个跳过**
    ],
    newCandidates: ['草稿/z/新.md'], missingOnDisk: ['草稿/old/走的.md'],
    pathDrift: [{ path: 'a.md', sameNameAt: ['b/a.md'] }], newTopLevelDirs: ['待导入设定'], excludedGone: []
  })
  assert.equal(r.total, 8)
  assert.equal(r.archivedSkipped, 1, '🔴 归档件（历史快照）不套现行规范 ⇒ 跳过，否则会刷出几十条噪音')
  assert.deepEqual(r.noType, ['草稿/b/二.md'])
  assert.deepEqual(r.noZone, ['草稿/c/三.md'])
  assert.deepEqual(r.noWork, ['草稿/d/四.md'],
    'Z9/Z7 空 work 不报；**下划线目录**（`过程/_模板/…`）也不报 —— 那是练习/模板类，不属于任何作品')
  assert.deepEqual(r.newCandidates, ['草稿/z/新.md'])
  assert.deepEqual(r.missingOnDisk, ['草稿/old/走的.md'])
  assert.equal(r.pathDrift.length, 1)
  assert.deepEqual(r.newTopLevelDirs, ['待导入设定'])
  assert.deepEqual(ZONES_NEEDING_WORK, ['Z1', 'Z2', 'Z3', 'Z4'])
})

test('② auditIndex：空/缺省入参不抛', () => {
  const r = auditIndex(undefined)
  assert.equal(r.total, 0)
  assert.deepEqual(r.noType, [])
  assert.deepEqual(r.pathDrift, [])
})

// ============================== ② 灵感库组 ==============================
test('③ auditInsp：缺世界观键 / 多键 / 别名残留', () => {
  const r = auditInsp({
    entries: [
      { id: 'a', tags: ['主题:废土', '世界观:原创/心渊纪元'] },          // 正常
      { id: 'b', tags: ['主题:废土'] },                                  // 缺键
      { id: 'c', tags: ['世界观:原创/X', '世界观:同人/Y'] },              // 多键
      { id: 'd', tags: ['世界观:同人/崩铁'] },                           // 别名残留（键内）
      { id: 'e', tags: ['主题:2077'] }                                   // 别名残留（主题内）
    ]
  })
  assert.equal(r.total, 5)
  assert.deepEqual(r.missKey, ['b', 'e'], '`e` 只有 `主题:2077` ⇒ **既缺世界观键、又含别名** ⇒ 两条都报（互不排斥）')
  assert.deepEqual(r.multiKey, ['c'])
  assert.deepEqual(r.staleAlias, [
    { id: 'd', tag: '世界观:同人/崩铁' },
    { id: 'e', tag: '主题:2077' }
  ])
  assert.equal(WORLDVIEW_PREFIX, '世界观:')
  assert.deepEqual(STALE_ALIASES, ['崩铁', '原創', '2077'])
})

test('④ auditSettingsRef：**只判"像路径"的**，自由文本一律跳过（不误报）', () => {
  const r = auditSettingsRef([
    { id: 'a', settingsRef: '设定/心渊纪元/世界观.md' },   // 像路径且失效 ⇒ 报
    { id: 'b', settingsRef: '设定/心渊纪元/人物.md' },     // 像路径且存在 ⇒ 不报
    { id: 'c', settingsRef: '见正文第三节' },              // 自由文本 ⇒ 跳过
    { id: 'd', settingsRef: 'https://x.com/a.md' },        // URL ⇒ 跳过（即使 existsMap 说它不存在也不报）
    { id: 'e', settingsRef: '' },                          // 空 ⇒ 跳过
    { id: 'f', settingsRef: '世界观.md' }                  // 无 / ⇒ 跳过（可能只是同目录）
  ], {
    '设定/心渊纪元/世界观.md': false,
    '设定/心渊纪元/人物.md': true,
    'https://x.com/a.md': false
  })
  assert.deepEqual(r.map(x => x.id), ['a'], '自由文本 / 无斜杠 / 空串 / **URL** 都被保守跳过')
  assert.equal(r[0].settingsRef, '设定/心渊纪元/世界观.md')
})

// ============================== ③ 归档断链组 ==============================
test('⑤ auditArchiveLinks：**有同名活文档**且未建立「替代」关联才报；孤立归档不报', () => {
  const r = auditArchiveLinks([
    // 断链：归档件与活文档同名，且没人指向归档件
    E('草稿/.archive/_版本前照片/第01章.md', { status: '归档' }),
    E('草稿/心渊纪元/第01章.md'),
    // 已关联：活文档 links 指向归档件 ⇒ 不报
    E('草稿/.archive/_版本前照片/第02章.md', { status: '归档' }),
    E('草稿/心渊纪元/第02章.md', { links: [{ to: 'doc:草稿/.archive/_版本前照片/第02章.md', kind: '替代' }] }),
    // 孤立归档：没有同名活文档 ⇒ **刻意不报**（用户已拍「老件不搬」，历史归档不该有替代关联）
    E('草稿/.archive/_阶段习作/D9_定稿.md', { status: '归档' })
  ])
  assert.equal(r.length, 1, '只报真正断链的那一条')
  assert.equal(r[0].archived, '草稿/.archive/_版本前照片/第01章.md')
  assert.deepEqual(r[0].activeSiblings, ['草稿/心渊纪元/第01章.md'])
})

test('⑥ auditArchiveLinks：空入参不抛', () => {
  assert.deepEqual(auditArchiveLinks(undefined), [])
})

// ============================== ④ 规范件同源（丙） ==============================
test('⑦ extractBetween：正例（含尾随空行裁掉）；**锚点不唯一/缺失即拒抽**', () => {
  const s = '# A\n开头\n# 附录 B\nBB1\nBB2\n\n# 附录 C\n后面\n'
  const r = extractBetween(s, '# 附录 B', '# 附录 C')
  assert.equal(r.ok, true)
  assert.equal(r.text, '# 附录 B\nBB1\nBB2\n')
  // 锚点不唯一 ⇒ 拒（本日事故的教训：锚点写死字样/重复会抽错）
  const dup = '# 附录 B\nx\n# 附录 B\ny\n# 附录 C\n'
  assert.equal(extractBetween(dup, '# 附录 B', '# 附录 C').ok, false)
  assert.match(extractBetween(dup, '# 附录 B', '# 附录 C').error, /不唯一/)
  // 锚点缺失
  assert.equal(extractBetween(s, '# 附录 Z', '# 附录 C').ok, false)
  assert.equal(extractBetween(s, '# 附录 B', '# 附录 Z').ok, false)
})

test('⑧ compareSpec：相同 ⇒ same:true 带字节数；不同 ⇒ 定位**首个差异行**', () => {
  assert.deepEqual(compareSpec('a\nb\n', 'a\nb\n'), { same: true, expectedBytes: 4, actualBytes: 4 })
  const r = compareSpec('l1\nl2\nl3\n', 'l1\nXX\nl3\n')
  assert.equal(r.same, false)
  assert.equal(r.firstDiffLine, 2)
  assert.equal(r.expectedLine, 'l2')
  assert.equal(r.actualLine, 'XX')
  // 一方更短（**真缺行**：右串少一整行，而非"尾空串"）
  const r2 = compareSpec('a\nb\n', 'a')
  assert.equal(r2.firstDiffLine, 2)
  assert.equal(r2.actualLine, '(缺行)')
  // 空串
  assert.equal(compareSpec('', '').same, true)
})

// ============================== ④b 行级锚点口径（2026-09-29 定） ==============================
test('⑩ extractByLineAnchors：CRLF 归一 + 去尾空行 + 末行 1 个 \\n；**锚点须恰好 1 次否则拒抽**', () => {
  const s = 'head\n# A\nx\r\ny\n\n# B\ntail\n'
  const r = extractByLineAnchors(s, /^# A$/, /^# B$/)
  assert.equal(r.ok, true)
  assert.equal(r.text, '# A\nx\ny\n', 'CRLF 归一为 LF；尾部空行去掉；末行 1 个 \\n')
  // 🔴 锚点重复 ⇒ 拒抽（awk 会静默取最后一次 —— 本日事故源，刻意不照搬）
  const dup = '# A\n1\n# A\n2\n# B\n'
  const r2 = extractByLineAnchors(dup, /^# A$/, /^# B$/)
  assert.equal(r2.ok, false)
  assert.match(r2.error, /命中 2 次/)
  // 结束锚点也须唯一 / 顺序须正确 / 缺失要报
  assert.equal(extractByLineAnchors(s, /^缺/, /^# B$/).ok, false)
  assert.equal(extractByLineAnchors(s, /^# B$/, /^# A$/).ok, false)
})

test('⑪ extractFindSpec：**A.4 段 ＋ 恰好 1 个空行 ＋ 标签段**（与 install-manual-specs.sh §4 逐行等价）', () => {
  const manual = [
    '# 附录 A', '## A.3', 'aaa', '## A.4', 'A4-行1', 'A4-行2', '', '', '## A.5', 'a5',
    '# 附录 B', '标签用五类受控前缀：…（实为受控前缀段）', 'B-尾', '', '# 附录 C', 'c'
  ].join('\n') + '\n'
  const r = extractFindSpec(manual)
  assert.equal(r.ok, true)
  // A.4 段（去尾空行）+ 1 个空行 + 标签段（到附录 C 之前，去尾空行）
  assert.equal(r.text, '## A.4\nA4-行1\nA4-行2\n' + '\n' + '标签用五类受控前缀：…（实为受控前缀段）\nB-尾\n')
  // 写作规范.md = 整个附录 B
  assert.equal(extractWriteSpec(manual).text, '# 附录 B\n标签用五类受控前缀：…（实为受控前缀段）\nB-尾\n')
  // 缺 A.5 ⇒ 拒抽（不静默抽半截）
  assert.equal(extractFindSpec('# 附录 A\n## A.4\nx\n# 附录 C\n').ok, false)
})
test('⑫ formatAuditLines：**凡计入 counts 的组必须逐条出现在明细里**（首版只渲染 specs ⇒ 被用户当场抓出）', () => {
  const rep = {
    summary: '规范体检：共 6 项',
    total: 6,
    counts: { index: 4, insp: 1, archive: 1, clientZone: 0, specs: 0 },
    index: {
      total: 10, archivedSkipped: 3,
      newTopLevelDirs: ['待导入设定'], noType: ['草稿/a/一.md'],
      noZone: [], noWork: [],
      newCandidates: ['草稿/z/新.md'], missingOnDisk: [], pathDrift: [], excludedGone: ['x/y.md']
    },
    insp: { missKey: ['i-1'], multiKey: [], staleAlias: [], brokenSettingsRef: [] },
    archiveLinks: [{ archived: '草稿/.archive/A/B.md', activeSiblings: ['草稿/B/心渊.md'] }],
    clientZone: { submitLogLines: 0, submitLogMissingTarget: [] },
    specs: [{ file: '写作规范.md', same: true }, { file: '查找规范.md', same: false, firstDiffLine: 7 }]
  }
  const txt = formatAuditLines(rep).join('\n')
  // 🔴 核心断言：summary 里的每一类非零，明细里都能找到对应的**具体条目**
  assert.match(txt, /待导入设定/, '未登记的新顶层目录要有条目')
  assert.match(txt, /草稿\/a\/一\.md/, '缺 type 要有具体路径')
  assert.match(txt, /草稿\/z\/新\.md/, '新增候选要有具体路径')
  assert.match(txt, /x\/y\.md/, 'excludedGone 要有具体路径')
  assert.match(txt, /i-1/, '灵感库缺键要有 id')
  assert.match(txt, /草稿\/\.archive\/A\/B\.md/, '归档断链要有具体路径')
  assert.match(txt, /草稿\/B\/心渊\.md/, '归档断链要带活件路径')
  // 通过项也照列；不同源要指出首差异行
  assert.match(txt, /写作规范\.md：同源 ✅/)
  assert.match(txt, /查找规范\.md：\*\*不同源\*\*（首个差异行 7）/)
  // 声明必须在
  assert.match(txt, /本动作不会改动任何文件/)
  // 计数口径：明细条数 == counts 里各项之和（这里 index 4 = 1+1+1+1，insp 1，archive 1 ⇒ 6）
  const detailLines = txt.split('\n').filter(l => /^ {6}- /.test(l)).length
  assert.equal(detailLines, 6, '明细行数应等于 counts 的合计（不多不少）')
})

test('⑬ formatAuditLines：超 cap 给省略；零命中时明说"未发现问题"', () => {
  const many = { summary: 's', total: 7, index: { noType: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'] } }
  const t2 = formatAuditLines(many, 3).join('\n')
  assert.match(t2, /- a\.md/); assert.match(t2, /- c\.md/)
  assert.doesNotMatch(t2, /- d\.md/, '超过 cap 的不列')
  assert.match(t2, /… 另 4 条/, '超出部分给总数')
  const empty = formatAuditLines({ summary: '规范体检：共 0 项', total: 0, index: { noType: [] }, specs: [] }).join('\n')
  assert.match(empty, /未发现问题/)
})

test('⑨ buildReport：分组计数 + total；specs 组只数"不相同"的', () => {
  const rep = buildReport({
    index: auditIndex({ entries: [E('a.md', { type: '' })], newCandidates: ['x'], missingOnDisk: [], pathDrift: [], newTopLevelDirs: ['待导入设定'], excludedGone: [] }),
    insp: Object.assign(auditInsp({ entries: [{ id: 'b', tags: [] }] }), { brokenSettingsRef: [{ id: 'c', settingsRef: 'p.md' }] }),
    archiveLinks: [{ archived: 'z.md', activeSiblings: [] }],
    clientZone: { submitLogMissingTarget: [{ path: 'p' }], missingOnDisk: [] },
    specs: [{ file: '写作规范.md', same: true }, { file: '查找规范.md', same: false }]
  })
  assert.deepEqual(rep.counts, { index: 3, insp: 2, archive: 1, clientZone: 1, specs: 1 })
  assert.equal(rep.total, 8)
  assert.deepEqual(buildReport().counts, { index: 0, insp: 0, archive: 0, clientZone: 0, specs: 0 })
})
