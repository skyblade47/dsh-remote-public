// U-37 契约锁：draft-save 路由的**源码静态断言**（不是行为测试）。
// ⚠️ 与 draft-listing-recursive.test.mjs / agent-save-tool.test.mjs 同口径 —— lib/index.js 依赖宿主包
// '@deepseek-ai/dsh-tools'（本机不存在、import 即 MODULE_NOT_FOUND）⇒ 线路无法本地真跑，
// 故只对源码做静态断言；纯逻辑已由 draft-save-core.test.mjs 真单测，HTTP 行为需装载后验收（计划 §5）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/draft-save-wiring.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
// draft-save 分支体：从 action 判定切到**下一个** action 分支为止。
// ⚠️ 2026-09-29：C11 在 draft-save 与 insp 之间**插入了 draft-list/draft-read/draft-delete 三个分支**
//    ⇒ 原写法（切到 `action === 'insp'`）会把那三个分支一起圈进来，使本文件"不得出现 DRAFT_DIR_REL"等
//    断言假失败。改为按"下一个 `} else if (action === '`"收口 —— 语义不变（仍只锁 draft-save 自己）。
const DRAFT_SAVE_AT = SRC.indexOf("action === 'draft-save'")
const BRANCH = SRC.slice(DRAFT_SAVE_AT, SRC.indexOf("} else if (action === '", DRAFT_SAVE_AT))

test('① 纯模块已抽出并接线：import ./draft-save-core.js', () => {
  assert.match(SRC, /from '\.\/draft-save-core\.js'/)
  assert.match(SRC, /validateRelPath/)
  assert.match(SRC, /decideWrite/)
  assert.match(SRC, /checkSize/)
  assert.match(SRC, /versionOf/)
})

test("② 新增 action 分支：POST /writing-studio/api/draft-save", () => {
  assert.ok(BRANCH.length > 0, '未找到 draft-save 分支')
  assert.match(BRANCH, /req\.method !== 'POST'/)
})

test('③ 薄接线：校验/决策/大小/版本全部委托纯模块（本文件不重造规则）', () => {
  assert.match(BRANCH, /validateRelPath\(args && args\.relPath\)/)
  assert.match(BRANCH, /checkSize\(bytes\)/)
  assert.match(BRANCH, /versionOf\(content\)/)
  assert.match(BRANCH, /decideWrite\(\{ exists: exists, baseVersion: args\.baseVersion, force: args\.force === true, currentVersion: currentVersion \}\)/)
})

test('④ 错误码齐备：空体/越界 ⇒ 400 BAD_PATH；超限 ⇒ 413 TOO_LARGE；冲突 ⇒ 409 VERSION_CONFLICT', () => {
  assert.match(BRANCH, /if \(!body\) return send\(400, \{ ok: false, error: '空请求体/)
  assert.match(BRANCH, /send\(400, \{ ok: false, code: vPath\.code \|\| 'BAD_PATH'/)
  assert.match(BRANCH, /send\(413, \{ ok: false, code: sizeChk\.code \|\| 'TOO_LARGE'/)
  assert.match(BRANCH, /send\(409, \{ ok: false, code: decision\.code \|\| 'VERSION_CONFLICT'/)
})

test('⑤ 原子写：临时文件 + rename，父目录逐级创建（mkdir recursive）', () => {
  assert.match(SRC, /async function writeDraftAtomic\(rel, content\)/)
  assert.match(SRC, /const tmp = abs \+ '\.tmp-' \+ process\.pid/)
  assert.match(SRC, /renameSync\(tmp, abs\)/)
  assert.match(SRC, /mkdirSync\(dir, \{ recursive: true \}\)/)
  assert.match(BRANCH, /await writeDraftAtomic\(vPath\.rel, content\)/)
})

test('⑥ 审计：落一条 draft-save（relPath / bytes / created / 是否覆盖），失败不阻断', () => {
  assert.match(SRC, /function auditDraftSave\(e\)/)
  assert.match(SRC, /\[writing-studio:audit\] draft-save relPath=/)
  assert.match(SRC, /bytes=' \+ Number\(x\.bytes \|\| 0\) \+ ' created=' \+ \(x\.created === true\) \+ ' overwrote=' \+ \(x\.overwrote === true\)/)
  assert.match(BRANCH, /auditDraftSave\(\{ relPath: vPath\.rel, bytes: bytes, created: !exists, overwrote: decision\.action === 'overwrite' \}\)/)
})

test('⑦ 响应体形状按 §2.1：{ok, path, filename, version, words, created}', () => {
  assert.match(BRANCH, /path: vPath\.rel/)
  assert.match(BRANCH, /filename: vPath\.rel\.slice\(vPath\.rel\.lastIndexOf\('\/'\) \+ 1\)/)
  assert.match(BRANCH, /version: newVersion/)
  assert.match(BRANCH, /words: content\.replace\(\/\\s\+\/g, ''\)\.length/) // 既有字数口径
  assert.match(BRANCH, /created: !exists/)
})

test('⑧ 🔴 saveDraft 既有行为未被改动，且新路由不调用它（第二套命名不得出现）', () => {
  // 既有函数签名与写盘路径原样保留
  assert.match(SRC, /async function saveDraft\(content, title\)/)
  const saveBlock = SRC.slice(SRC.indexOf('async function saveDraft(content, title)'), SRC.indexOf('async function collectDrafts'))
  assert.match(saveBlock, /const draftInner = DRAFT_DIR_REL \+ '\/' \+ filename/)
  assert.match(saveBlock, /await writeTextRaw\(ROOT_TRAIN, draftInner, fileContent\)/)
  // draft-save 分支不得走 saveDraft（否则又叠一层 <标题>_<日期>_<时间> 命名）
  assert.doesNotMatch(BRANCH, /saveDraft\(/)
})

test('⑨ 写者唯一性：草稿命名/写盘点仍各只有一处（本路由按调用方给定路径写，不新增时间戳命名）', () => {
  assert.equal((SRC.match(/DRAFT_DIR_REL \+ '\/' \+ filename/g) || []).length, 1)
  assert.equal((SRC.match(/writeTextRaw\(ROOT_TRAIN, draftInner/g) || []).length, 1)
  // 本路由不得自造 DRAFT_DIR_REL 命名（它用的是调用方 relPath）
  assert.doesNotMatch(BRANCH, /DRAFT_DIR_REL/)
})

test('⑩ 🔴 relPath 必须先剥掉根前缀再喂 adapterFs（防"双前缀"回归）', () => {
  // adapterFs 的 (rootRef, rel) = `joinUnderRoot(roots[rootRef], rel)`（dsh-adapter/lib/fs.js:32 `_resolveTarget`）。
  // relPath 是**工作区相对**的 `写作训练/草稿/…`，若原样传入会拼成 `写作训练/写作训练/草稿/…`：
  //   读取恒抛错 ⇒ exists 恒 false ⇒ **"默认不覆盖"失效**；写入会落到多余的嵌套目录。
  assert.match(BRANCH, /const relInTrain = vPath\.rel\.slice\(ROOT_TRAIN\.length \+ 1\)/)
  assert.match(BRANCH, /adapterFs\.readText\(ROOT_TRAIN, relInTrain\)/)
  assert.doesNotMatch(BRANCH, /adapterFs\.readText\(ROOT_TRAIN, vPath\.rel\)/)
  // 原子写里同样要剥（幂等：调用方已剥则不重复剥）
  assert.match(SRC, /const inner = String\(rel\)\.indexOf\(ROOT_TRAIN \+ '\/'\) === 0/)
  assert.match(SRC, /absOf\(ROOT_TRAIN, inner\)/)
  assert.doesNotMatch(SRC, /absOf\(ROOT_TRAIN, rel\)/)
})

test('⑪ 🔴 U-41/P4 收口闸：draft-save **先判后写**，默认 open（= 收口前行为）', () => {
  assert.match(SRC, /const DRAFT_WRITE_MODE = 'open'/, '默认 open ⇒ 行为与收口前完全一致')
  assert.match(SRC, /function draftWriteClosed\(action, relPath\)/)
  assert.ok(BRANCH.indexOf('draftWriteClosed(') > 0, 'draft-save 分支含收口闸')
  assert.ok(BRANCH.indexOf('draftWriteClosed(') < BRANCH.indexOf('validateRelPath('),
    '🔴 闸必须在 validateRelPath 之前 ⇒ 被拒时盘上零变化')
  assert.match(BRANCH, /send\(403, \{ ok: false, code: 'DRAFT_WRITE_CLOSED'/)
  // 被拒也要留痕（供"还有旧客户端在敲"的判据；既有 auditDraftSave 一字未动）
  assert.match(SRC, /draft-write-rejected action=/)
  assert.match(SRC, /' mode=' \+ DRAFT_WRITE_MODE \+ ' relPath='/)
})
