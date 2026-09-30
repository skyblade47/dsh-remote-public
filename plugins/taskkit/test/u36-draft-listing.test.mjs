// U-36 / T3 契约锁：taskkit 的草稿清单必须**递归列举 写作训练/草稿/**，不得回退硬编码清单。
// ⚠️ 与 version-radar/test/wiring.test.mjs 同口径 —— lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'
//（本机不可 import），故只能对源码做静态断言；真实列举结果需装载后验收（计划 T5）。
// 用法（仓库根目录）：node --test plugins/taskkit/test/u36-draft-listing.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

test('① 硬编码草稿清单与旧函数名已删除（注释里提及历史名不算）', () => {
  assert.doesNotMatch(SRC, /const KNOWN_DRAFT_NAMES/)
  assert.doesNotMatch(SRC, /async function collectKnownDrafts/)
  assert.doesNotMatch(SRC, /KNOWN_DRAFT_NAMES\.forEach/)
})

test('② 递归列举助手存在（directory 下钻 + file/.md 收口）', () => {
  assert.match(SRC, /async function listDraftPathsDeep\(/)
  assert.match(SRC, /entry\.type === 'directory'/)
  assert.match(SRC, /entry\.type === 'file' && \/\\\.md\$\/i/)
  assert.match(SRC, /listDraftPathsDeep\(root, childRel, childPrefix, depth \+ 1\)/)
})

test('③ 三个消费点全部改走递归列举（少一处就会漏稿）', () => {
  const hits = SRC.match(/listDraftPathsDeep\(ROOT_TRAIN, DRAFT_DIR_REL, '', 0\)/g) || []
  assert.equal(hits.length, 3, '期望 3 处：collectDrafts / listDraftFiles / KB 导入的草稿支路')
})

test('④ readDraftFile 允许子目录路径但拒绝越界（不再把 "/" 剥掉）', () => {
  const block = SRC.slice(SRC.indexOf('async function readDraftFile'), SRC.indexOf('async function readRelations'))
  assert.doesNotMatch(block, /replace\(\/\[\\\\\/\]\/g, ''\)/)
  assert.match(block, /replace\(\/\\\\\/g, '\/'\)/)
  assert.match(block, /=== '\.\.'/)
})

test('⑤ 递归深度上限仍在（防病态目录树）', () => {
  assert.match(SRC, /DRAFT_LIST_MAX_DEPTH/)
  assert.match(SRC, /depth < DRAFT_LIST_MAX_DEPTH/)
})
