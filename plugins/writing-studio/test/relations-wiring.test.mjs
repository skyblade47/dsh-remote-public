// U-7 / T1a 契约锁：writing-studio 的 relations 读写**改走 taskkit**，且**对外 6 个端点的形状一字不改**。
// ⚠️ 与 draft-save-wiring.test.mjs 同口径 —— lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'
//（本机不可 import），故只能对源码做静态断言；纯逻辑已由 relations-core.test.mjs 真单测，
// HTTP 行为需装载后验收（taskkit 是否真可达只能装载后验）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/relations-wiring.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
// relations 分支体（action === 'relations' → 下一个 action === 'training'）
const REL_IDX = SRC.indexOf("action === 'relations'")
const BRANCH = SRC.slice(REL_IDX, SRC.indexOf("action === 'training'", REL_IDX))
// readRelations 实现体
const READ_REL = SRC.slice(SRC.indexOf('async function readRelations()'), SRC.indexOf('async function attachRelation'))

test('① 纯模块已抽出并接线：import ./relations-core.js', () => {
  assert.match(SRC, /from '\.\/relations-core\.js'/)
  for (const sym of ['TASKKIT_RELATIONS_LIST', 'TASKKIT_RELATIONS_UPDATE', 'TASKKIT_RELATIONS_DELETE', 'responseFailed', 'adaptRelationsDoc', 'buildAttachPayload']) {
    assert.match(SRC, new RegExp(sym), sym + ' 未接线')
  }
})

test('② readRelations 改从 taskkit 读（list），失败**抛错**、不再静默兜底', () => {
  assert.ok(READ_REL.length > 0, '未找到 readRelations')
  assert.match(READ_REL, /await loopPost\(TASKKIT_RELATIONS_LIST, \{\}\)/)
  assert.match(READ_REL, /const err = responseFailed\(r, 'list'\)/)
  assert.match(READ_REL, /if \(err\) throw new Error\(err\)/)
  assert.match(READ_REL, /return adaptRelationsDoc\(r\)/)
  // 不得再回退成空表兜底（旧行为：readJson(..., {version:1,relations:{}})）
  assert.doesNotMatch(READ_REL, /version: 1, relations: \{\s*\}\s*\)/)
})

test('③ attach ⇒ taskkit update；detach ⇒ taskkit delete（T1b 新增）', () => {
  assert.match(SRC, /async function attachRelation\(draft, rel\)/)
  assert.match(SRC, /await loopPost\(TASKKIT_RELATIONS_UPDATE, buildAttachPayload\(draft, rel\)\)/)
  assert.match(SRC, /async function detachRelation\(draft\)/)
  assert.match(SRC, /await loopPost\(TASKKIT_RELATIONS_DELETE, \{ draft: draft \}\)/)
  // 两个动作都必须如实报错
  assert.match(SRC, /const err = responseFailed\(r, 'update'\)[\s\S]*?if \(err\) throw new Error\(err\)/)
  assert.match(SRC, /const err = responseFailed\(r, 'delete'\)[\s\S]*?if \(err\) throw new Error\(err\)/)
  // 分支确实改调了这两个 helper
  assert.match(BRANCH, /await attachRelation\(draft, rel\)/)
  assert.match(BRANCH, /await detachRelation\(draft\)/)
})

test('④ 🔴 不再自持/读写 写作训练/relations.json（RELATIONS_REL 与 writeRelations 已删）', () => {
  assert.doesNotMatch(SRC, /const RELATIONS_REL/)
  assert.doesNotMatch(SRC, /async function writeRelations\(/)
  assert.doesNotMatch(SRC, /writeRelations\(/)
  assert.doesNotMatch(SRC, /readJson\(ROOT_TRAIN, RELATIONS_REL/)
  assert.doesNotMatch(SRC, /writeJsonRaw\(ROOT_TRAIN, RELATIONS_REL/)
})

test('⑤ 🔴 对外端点 URL / 方法 / 响应形状一字不改（前端「移除关联」等按钮依赖）', () => {
  // 路由前缀不变；子动作仍取 parts[3]
  assert.match(SRC, /path: '\/writing-studio\/api'/)
  assert.match(BRANCH, /const sub = parts\.length >= 4 \? parts\[3\] : ''/)
  // 六个子动作的响应形状逐字保留
  assert.match(BRANCH, /send\(200, \{ ok: true, relations: relData\.relations, byInsp: byInsp, byDraft: byDraft, byDate: byDate, total: Object\.keys\(relData\.relations \|\| \{\}\)\.length \}\)/)
  assert.match(BRANCH, /send\(200, \{ ok: true, inspId: id, drafts: related \}\)/)
  assert.match(BRANCH, /send\(200, \{ ok: true, draft: name, relation: \(relData\.relations \|\| \{\}\)\[name\] \|\| null \}\)/)
  assert.match(BRANCH, /send\(200, \{ ok: true, date: date, drafts: items \}\)/)
  assert.match(BRANCH, /send\(200, \{ ok: true, draft: draft, relation: rel \}\)/)
  assert.match(BRANCH, /send\(200, \{ ok: true, draft: draft, detached: true \}\)/)
  // 404 的 actions 清单不变
  assert.match(BRANCH, /actions: \['overview', 'byInsp', 'byDraft', 'byDate', 'attach', 'detach'\]/)
})

test('⑥ 请求参数契约不变：attach/detach 仍要求 POST、仍校验缺少 draft ⇒ 400', () => {
  const postGuards = BRANCH.match(/req\.method !== 'POST'\) return send\(405, \{ ok: false, error: '需要 POST' \}\)/g) || []
  assert.ok(postGuards.length >= 2, 'attach/detach 的 POST 守卫丢失')
  const draftGuards = BRANCH.match(/if \(!draft\) return send\(400, \{ ok: false, error: '缺少 draft' \}\)/g) || []
  assert.ok(draftGuards.length >= 2, 'attach/detach 的 draft 必填校验丢失')
})

test('⑦ attach 的本地合并语义保留（含 date 回显），只把落库换成 taskkit', () => {
  assert.match(BRANCH, /\{ type: '自由写作', refInspId: '', refResourceId: '', note: '', date: '' \}/)
  assert.match(BRANCH, /if \(args\.date !== undefined\) rel\.date = String\(args\.date \|\| ''\)/)
})
