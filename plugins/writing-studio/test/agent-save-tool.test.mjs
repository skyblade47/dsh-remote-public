// ⚠️ **与 version-radar/test/wiring.test.mjs 同口径：这是契约锁，不是行为测试。**
// lib/index.js 必须 import '@deepseek-ai/dsh-tools'，而该包**只存在于宿主机** ⇒ index.js 本机无法被 import
// （import 即 MODULE_NOT_FOUND）。⇒ 这里只对源码做静态契约断言。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/agent-save-tool.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

test('① 注册了 agent 工具 writing_studio_save', () => {
  assert.match(SRC, /name:\s*'writing_studio_save'/)
  assert.match(SRC, /ctx\.tools\.register\(\s*defineTool\(\{/)
})

test('② 参数形状 = { title?(可选), content(必填) }', () => {
  const block = SRC.slice(SRC.indexOf("name: 'writing_studio_save'"))
  // 🔴 宿主规范（2026-09-27 真机踩中）：**可选参数必须省略 `required`** —— 写 `required: false` 会被 loader 直接拒绝：
  //   `unsupported JSON schema: parameters.title.required must be true when present`
  assert.match(block, /title:\s*\{\s*type:\s*'string',\s*description:/)
  assert.match(block, /content:\s*\{\s*type:\s*'string',\s*required:\s*true/)
})

test('②b 工具参数里不得出现 `required: false`（会被宿主 loader 拒绝，见上）', () => {
  assert.doesNotMatch(SRC, /required:\s*false/)
})

test('③ 落盘复用同一 saveDraft()（不得出现第二套落盘实现）', () => {
  const start = SRC.indexOf("name: 'writing_studio_save'")
  const end = SRC.indexOf('// HTTP API', start)
  const block = SRC.slice(start, end)
  assert.match(block, /await saveDraft\(String\(content\), String\(\(args && args\.title\) \|\| ''\)\)/)
  // 工具体内**不得**自己写盘（否则就是第二套口径/第二个写者）
  assert.doesNotMatch(block, /writeTextRaw|writeJsonRaw|WRITING_RECORD_REL|DRAFT_DIR_REL/)
})

test('④ content 缺失 ⇒ 明确报错（不静默写空稿）', () => {
  const start = SRC.indexOf("name: 'writing_studio_save'")
  const block = SRC.slice(start, SRC.indexOf('// HTTP API', start))
  assert.match(block, /if \(content === undefined \|\| content === null\) return \{ ok: false, error: '缺少 content' \}/)
})

test('⑤ 失败路径不抛到 agent（返回 {ok:false,error}）', () => {
  const start = SRC.indexOf("name: 'writing_studio_save'")
  const block = SRC.slice(start, SRC.indexOf('// HTTP API', start))
  assert.match(block, /return \{ ok: false, error: '写入失败: ' \+ String\(e && e\.message \|\| e\) \}/)
})

test('⑥ 写者唯一性：草稿落盘的写入点仍只有 saveDraft 一处', () => {
  // 构造草稿相对路径（DRAFT_DIR_REL + '/' + filename）与真正写盘（writeTextRaw(ROOT_TRAIN, draftInner, …)）各只应有一处
  assert.equal((SRC.match(/DRAFT_DIR_REL \+ '\/' \+ filename/g) || []).length, 1)
  assert.equal((SRC.match(/writeTextRaw\(ROOT_TRAIN, draftInner/g) || []).length, 1)
})
