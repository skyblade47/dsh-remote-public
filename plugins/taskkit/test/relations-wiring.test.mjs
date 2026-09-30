// U-7 / T1b 契约锁：taskkit 的 relations 路由新增 `delete`，且 **list/update 的既有行为与响应形状一字不改**。
// ⚠️ 与 u36-draft-listing.test.mjs 同口径 —— lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'
//（本机不可 import），故只能对源码做静态断言；纯逻辑已由 relations-core.test.mjs 真单测，
// HTTP 行为需装载后验收。
// 用法（仓库根目录）：node --test plugins/taskkit/test/relations-wiring.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')
// relations 路由处理器体（从 handler 定义到其 register）
const HANDLER = SRC.slice(
  SRC.indexOf('const relationsHandler'),
  SRC.indexOf("ws.register({ kind: 'prefix', path: '/taskkit/api/relations'")
)

test('① 纯模块已抽出并接线：import ./relations-core.js', () => {
  assert.ok(HANDLER.length > 0, '未找到 relationsHandler')
  assert.match(SRC, /import \{ RELATIONS_ACTIONS, normalizeDraftArg, deleteRelation \} from '\.\/relations-core\.js'/)
})

test('② 新增 action delete：入参 {draft}，缺 ⇒ 400', () => {
  assert.match(HANDLER, /action === 'delete'/)
  assert.match(HANDLER, /const d = normalizeDraftArg\(args\.draft\)/)
  assert.match(HANDLER, /if \(!d\.ok\) return send\(400, \{ ok: false, error: d\.error \}\)/)
})

test('③ delete 语义：幂等（键不存在也 ok），且**只在真删掉时才落盘**', () => {
  assert.match(HANDLER, /const out = deleteRelation\(relations\.relations, d\.draft\)/)
  assert.match(HANDLER, /if \(out\.removed\) \{/)
  assert.match(HANDLER, /relations\.relations = out\.relations/)
  assert.match(HANDLER, /await writeRelations\(relations\)/)
  // 响应形状：{ ok:true, draft, removed:<bool> }
  assert.match(HANDLER, /send\(200, \{ ok: true, draft: d\.draft, removed: out\.removed \}\)/)
})

test('④ 404 的 actions 清单含 delete，且取自 RELATIONS_ACTIONS 单一真源', () => {
  assert.match(HANDLER, /actions: RELATIONS_ACTIONS/)
  assert.doesNotMatch(HANDLER, /actions: \['list', 'update'\]/)
})

test('⑤ 🔴 list 响应形状一字不改（外部客户端直接读它）', () => {
  assert.match(HANDLER, /send\(200, \{ ok: true, relations: relations\.relations, drafts: drafts, byInsp: byInsp, total: Object\.keys\(relations\.relations \|\| \{\}\)\.length \}\)/)
})

test('⑥ 🔴 update 响应形状与落库字段一字不改', () => {
  assert.match(HANDLER, /send\(200, \{ ok: true, draft: draft, relation: relations\.relations\[draft\] \}\)/)
  assert.match(HANDLER, /relations\.relations\[draft\] = \{/)
  // 四个字段（与迁移前逐字一致）
  assert.match(HANDLER, /type: \['灵感衍生', '训练产出', '自由写作'\]\.indexOf\(args\.type\) >= 0 \? args\.type : '自由写作'/)
  assert.match(HANDLER, /refInspId: String\(args\.refInspId \|\| ''\)/)
  assert.match(HANDLER, /refResourceId: String\(args\.refResourceId \|\| ''\)/)
  assert.match(HANDLER, /note: String\(args\.note \|\| ''\)/)
})
