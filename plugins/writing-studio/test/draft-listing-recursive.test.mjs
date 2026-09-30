// U-36 / T3 契约锁：草稿清单必须**递归列举 写作训练/草稿/**，不得回退硬编码清单。
// ⚠️ 与 version-radar/test/wiring.test.mjs 同口径 —— lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'
//（本机不可 import），故只能对源码做静态断言；真实列举结果需装载后验收（计划 T5）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/draft-listing-recursive.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

test('① 硬编码草稿清单已删除（归档把草稿/ 改成按作品分层后它已失效）', () => {
  assert.doesNotMatch(SRC, /KNOWN_DRAFT_NAMES/)
})

test('② 存在递归列举：按 type===\'directory\' 下钻 + 按 type===\'file\' 收 .md', () => {
  assert.match(SRC, /async function listDraftRelPaths\(/)
  assert.match(SRC, /e\.type === 'directory'/)
  assert.match(SRC, /e\.type === 'file' && \/\\\.md\$\/i/)
  assert.match(SRC, /listDraftRelPaths\(root, childRel, childPrefix, depth \+ 1\)/)
})

test('③ 有递归深度上限（防病态目录树把请求挂死）', () => {
  assert.match(SRC, /DRAFT_LIST_MAX_DEPTH/)
  assert.match(SRC, /depth < DRAFT_LIST_MAX_DEPTH/)
})

test('④ collectDrafts 走递归列举，且保留 lastFile 兜底（幂等）', () => {
  const block = SRC.slice(SRC.indexOf('async function collectDrafts()'), SRC.indexOf('async function trainingOverview'))
  assert.match(block, /await listDraftRelPaths\(ROOT_TRAIN, DRAFT_DIR_REL, '', 0\)/)
  assert.match(block, /rec\.lastFile/)
})

test('⑤ 不跳过目录本身的下钻（顶层只有目录时仍能拿到稿件）', () => {
  assert.doesNotMatch(SRC, /listDir\(ROOT_TRAIN, DRAFT_DIR_REL\)\)\s*\.filter/)
})
