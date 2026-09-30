// C11 契约锁：draft-list / draft-read / draft-delete 路由的**源码静态断言**（不是行为测试）。
// ⚠️ 与 draft-save-wiring.test.mjs 同口径 —— lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'
// （本机不存在、import 即 MODULE_NOT_FOUND）⇒ 线路无法本地真跑，故只对源码做静态断言；
// 纯逻辑已由 draft-sync-core.test.mjs 真单测（23 条），HTTP 行为需装载后真机验收。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/draft-sync-wiring.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as CORE from '../lib/draft-sync-core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

// 按"下一个 `} else if (action === '`"收口，拿到单个分支体（新增分支不会污染已锁的分支）
function branchOf(name) {
  const at = SRC.indexOf("action === '" + name + "'")
  if (at < 0) return ''
  return SRC.slice(at, SRC.indexOf("} else if (action === '", at))
}
const LIST = branchOf('draft-list')
const READ = branchOf('draft-read')
const DEL = branchOf('draft-delete')
// C11 三个分支的合计（用于"不得出现真删 API"这类全局断言）+ 软删 helper 本体
const SYNC_ALL = LIST + READ + DEL
// ⚠️ 收口锚点必须取"helper **之后**的第一个分节横幅"：`记忆工作台` 这个串在文件里出现 4 次，
//    直接 indexOf 会命中文档头部的注释（在 helper 之前）⇒ 切片反向成空。
const HELP_AT = SRC.indexOf('function softDeleteDraft(')
const HELPERS = HELP_AT < 0 ? '' : SRC.slice(HELP_AT, SRC.indexOf('\n  // ============', HELP_AT))

// ---------- ① 接线 ----------
test('① 纯模块已抽出并接线：import ./draft-sync-core.js', () => {
  assert.match(SRC, /from '\.\/draft-sync-core\.js'/)
})

test('① import 进来的名字**全部**在 draft-sync-core 的导出里（挡拼写 / 漏导出）', () => {
  // ⚠️ 必须用 `[^{}]*`：用 `[\s\S]*?` 会从**上一个** import 的 `{` 起跨过来
  const m = /\{([^{}]*)\}\s*from\s*'\.\/draft-sync-core\.js'/.exec(SRC)
  assert.ok(m, '没找到 draft-sync-core 的 import 块')
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean)
  assert.ok(names.length >= 10, '导入名字太少，像是解析失败：' + names.length)
  for (const n of names) {
    assert.ok(Object.prototype.hasOwnProperty.call(CORE, n), 'draft-sync-core 未导出 ' + n)
  }
})

test('① 三个 action 分支都在', () => {
  for (const [name, body] of [['draft-list', LIST], ['draft-read', READ], ['draft-delete', DEL]]) {
    assert.ok(body.length > 80, '未找到（或过短）分支: ' + name)
  }
})

// ---------- ② draft-list ----------
test('② draft-list：GET-only，复用既有列举器（自动跳过 `.` 开头 ⇒ 回收站/墓碑不入列）', () => {
  assert.match(LIST, /req\.method !== 'GET' && req\.method !== 'HEAD'/)
  assert.match(LIST, /listDraftRelPaths\(ROOT_TRAIN, DRAFT_DIR_REL, '', 0\)/)
  assert.match(LIST, /tombstoneList\(await readTombstones\(\)\)/)
  assert.match(LIST, /buildListItem\(wsRelOf\(inner\)/)
})

test('🔴 ② draft-list **不回正文**（列表要轻；正文只走 draft-read）', () => {
  const sendBlock = LIST.slice(LIST.indexOf('send(200'))
  assert.ok(sendBlock.length > 0, '没找到 draft-list 的响应块')
  assert.ok(!/content/.test(sendBlock), 'draft-list 响应块里出现了 content')
  assert.ok(!/content:/.test(LIST), 'draft-list 分支里出现了 `content:` 键')
})

test('② draft-list：单条读失败**跳过**而不是整表失败（并发改名/删除是常态）', () => {
  assert.match(LIST, /catch \(e\) \{ continue \}/)
})

// ---------- ③ draft-read ----------
test('③ draft-read：GET-only + 越界 400 + 不存在 404 + 超限 413', () => {
  assert.match(READ, /req\.method !== 'GET' && req\.method !== 'HEAD'/)
  assert.match(READ, /validateRelPath\(relArgOf\(args, u\)\)/)
  assert.match(READ, /send\(400, \{ ok: false, code: vPath\.code \|\| 'BAD_PATH'/)
  assert.match(READ, /send\(404, \{ ok: false, code: 'NOT_FOUND'/)
  assert.match(READ, /send\(413, \{ ok: false, code: sizeChk\.code \|\| 'TOO_LARGE'/)
})

test('🔴 ③ draft-read：墓碑命中 ⇒ 404（"远端确实没有"），不是 500', () => {
  assert.match(READ, /getTombstone\(await readTombstones\(\), vPath\.rel\)/)
})

test('③ draft-read 的响应形状与设计 §4.2 一致', () => {
  for (const k of ['relPath:', 'version:', 'content:', 'bytes:', 'words:', 'mtime:']) {
    assert.ok(READ.indexOf(k) > 0, 'draft-read 响应缺字段 ' + k)
  }
  assert.match(READ, /version: versionOf\(content\)/)
  assert.match(READ, /words: wordCount\(content\)/)
})

// ---------- ④ draft-delete ----------
test('④ draft-delete：POST-only + 空体 400 + 越界 400', () => {
  assert.match(DEL, /req\.method !== 'POST'/)
  assert.match(DEL, /if \(!body\) return send\(400/)
  assert.match(DEL, /send\(400, \{ ok: false, code: vPath\.code \|\| 'BAD_PATH'/)
})

test('④ draft-delete：404 / 409 / 幂等 already / 搬家失败 500 齐备', () => {
  assert.match(DEL, /decision\.action === 'notfound'[\s\S]{0,120}?send\(404/)
  assert.match(DEL, /decision\.action === 'conflict'[\s\S]{0,160}?send\(409/)
  assert.match(DEL, /decision\.action === 'already'[\s\S]{0,200}?alreadyDeleted: true/)
  assert.match(DEL, /catch \(e\) \{[\s\S]{0,120}?send\(500, \{ ok: false, code: 'IO_ERROR'/)
})

test('④ draft-delete：决策委托纯模块（本文件不重造规则）', () => {
  assert.match(DEL, /decideDelete\(\{/)
  assert.match(DEL, /putTombstone\(tombR, vPath\.rel, \{/)
  assert.match(DEL, /baseVersion: args && args\.baseVersion/)
  assert.match(DEL, /deletedBy: \(args && args\.device\)/)
})

// ---------- ⑤ 🔴 三条"不丢稿"的硬锁 ----------
test('🔴 ⑤ 软删是 rename 搬家：C11 分支 + 软删 helper 里**不得**出现任何真删 API', () => {
  const area = SYNC_ALL + HELPERS
  assert.ok(HELPERS.length > 200, '没圈到 softDeleteDraft（切片锚点变了？）')
  for (const api of ['unlinkSync', 'unlink(', 'rmSync', 'rmdirSync', 'rm(', 'truncateSync']) {
    assert.ok(area.indexOf(api) < 0, 'C11 区域里出现了真删 API: ' + api)
  }
  assert.match(HELPERS, /renameSync\(src\.abs, dst\.abs\)/, 'softDeleteDraft 没用 renameSync')
})

test('🔴 ⑤ 回收站里已有同名 ⇒ 带时间戳后缀，**绝不覆盖**旧件', () => {
  assert.match(SRC, /if \(nfs\.existsSync\(dst\.abs\)\)/)
  assert.match(SRC, /'\.deleted-' \+ new Date\(\)\.toISOString\(\)/)
})

test('🔴 ⑤ 顺序：**先搬家成功、再写墓碑**（墓碑写失败也不会丢稿）', () => {
  const trashAt = DEL.indexOf('await softDeleteDraft(vPath.rel)')
  const tombAt = DEL.indexOf('await writeJsonRaw(ROOT_TRAIN, TOMBSTONE_INNER, nextTomb)')
  assert.ok(trashAt > 0, '没调 softDeleteDraft')
  assert.ok(tombAt > 0, '没写墓碑')
  assert.ok(trashAt < tombAt, `顺序错了：trash@${trashAt} tombstone@${tombAt}（必须先搬家）`)
})

test('🔴 ⑤ 墓碑写失败要如实回报（tombstoneSaved:false），不假装成功', () => {
  assert.match(DEL, /let tombSaved = true/)
  assert.match(DEL, /catch \(e\) \{ tombSaved = false \}/)
  assert.match(DEL, /tombstoneSaved: tombSaved/)
})

// ---------- ⑥ 🔴 隐藏段闸（回收站/墓碑不能被客户端读写） ----------
test('🔴 ⑥ draft-read 与 draft-delete **都**用 hasDotSegment 挡隐藏段（缺一个就能读写回收站）', () => {
  assert.match(READ, /if \(hasDotSegment\(inner\)\) return send\(400/)
  assert.match(DEL, /if \(hasDotSegment\(inner\)\) return send\(400/)
})

test('🔴 ⑥ 为什么必须挡：validateRelPath 放行 `.deleted/**.md`（前提已在 core 单测锁定）', () => {
  // 这里只复述结论，真正的前提校验在 draft-sync-core.test.mjs 的对应用例里
  assert.ok(CORE.hasDotSegment('.deleted/x.md') === true)
  assert.ok(CORE.hasDotSegment('作品甲/第一章.md') === false)
})

// ---------- ⑦ 不改既有 ----------
test('🔴 ⑦ 三个新分支**不动既有行为**：不调用 saveDraft / 不写 writing 记录', () => {
  assert.ok(SYNC_ALL.indexOf('saveDraft(') < 0, 'C11 分支里调了 saveDraft（会改既有落盘口径）')
  assert.ok(SYNC_ALL.indexOf('ROOT_TRAIN, INSP_LIB_REL') < 0, 'C11 分支里动了灵感库')
})

test('⑦ draft-save 分支仍在且未被改动（409/413 判据还在）', () => {
  const SAVE = branchOf('draft-save')
  assert.match(SAVE, /decideWrite\(\{ exists: exists, baseVersion: args\.baseVersion, force: args\.force === true, currentVersion: currentVersion \}\)/)
  assert.match(SAVE, /send\(409, \{ ok: false, code: decision\.code \|\| 'VERSION_CONFLICT'/)
  assert.match(SAVE, /send\(413, \{ ok: false, code: sizeChk\.code \|\| 'TOO_LARGE'/)
})

test('⑦ 审计已接（draft-delete 落一条 draft-sync 审计）', () => {
  assert.match(SRC, /function auditDraftSync\(op, e\)/)
  assert.match(DEL, /auditDraftSync\('draft-delete'/)
})

// ---------- ⑧ 🔴 GET 参数来源（回归锁：曾在真机抓过一次） ----------
test('🔴 ⑧ GET 参数必须自己从查询串取（`args` 只装 body）', () => {
  // 前提锁：handler 里的 args 确实只来自 JSON body
  assert.match(SRC, /let args = \{\}[\s\S]{0,160}?JSON\.parse\(body\)/, '前提变了：args 现在可能已含查询串')
  assert.match(SRC, /function relArgOf\(argsIn, u\)/, '缺 relArgOf helper')
  assert.match(SRC, /u\.searchParams\.get\('relPath'\)/, 'relArgOf 没查查询串')
  assert.match(READ, /validateRelPath\(relArgOf\(args, u\)\)/, 'draft-read 仍直接用 args.relPath（GET 下恒空）')
  assert.match(DEL, /validateRelPath\(relArgOf\(args, u\)\)/, 'draft-delete 仍直接用 args.relPath')
  // 反例锁：三个分支里都不许再出现 `validateRelPath(args && args.relPath)`
  assert.ok(SYNC_ALL.indexOf('validateRelPath(args && args.relPath)') < 0, '还有分支在用裸 args.relPath')
})

// ---------- ⑨ 🔴 U-41/P4 收口闸（**删除也是写**） ----------
test('🔴 ⑨ P4 收口闸：draft-delete 与 draft-save **同闸**，且**读端点不设闸**', () => {
  assert.match(SRC, /const DRAFT_WRITE_MODE = 'open'/, '默认 open ⇒ 与收口前一致')
  assert.ok(DEL.indexOf('draftWriteClosed(') > 0, 'draft-delete 分支含收口闸')
  assert.ok(DEL.indexOf('draftWriteClosed(') < DEL.indexOf('validateRelPath('),
    '🔴 闸必须在校验/写入之前 ⇒ 被拒时盘上零变化（不搬家、不写墓碑）')
  assert.match(DEL, /send\(403, \{ ok: false, code: 'DRAFT_WRITE_CLOSED'/)
  // 🔴 只收「写」不收「读」：list/read 在任何取值下都保留
  //    （用户已拍「老件不搬」⇒ 旧客户端必须还能看见并拉回 草稿/ 里的旧稿）
  assert.ok(LIST.indexOf('draftWriteClosed(') < 0, 'draft-list 不得设闸（只读保留）')
  assert.ok(READ.indexOf('draftWriteClosed(') < 0, 'draft-read 不得设闸（只读保留）')
})
