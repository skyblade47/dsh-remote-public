// 钉住白名单 path 的契约（三种输入形态的明确行为）：
//   包名            → resolveEntryName 原样返回（loader 用它 import，UI graph 靠它 require.resolve）
//   file: 目录      → 解析到 <dir>/<main> 的 file URL
//   file: 文件      → 原样返回
//   绝对目录路径    → **明确报错**（不再静默返回目录：ESM 不支持目录导入，会得到
//                     "报成功但没生效"式的远处故障）
//
// 用法：node --test plugins/dsh-adapter/test/plugin-path-contract.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { resolveEntryName } from '../lib/hotplug/plugin-path.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-path-contract-'))
const pluginDir = join(dir, 'plug')
mkdirSync(join(pluginDir, 'lib'), { recursive: true })
writeFileSync(join(pluginDir, 'lib', 'index.js'), 'export default () => {}\n', 'utf8')
writeFileSync(join(pluginDir, 'package.json'),
  JSON.stringify({ name: '@local/plug', version: '0.0.1', type: 'module', main: 'lib/index.js' }), 'utf8')

test('包名：原样返回（loader 要靠它做标准解析 / UI graph）', () => {
  assert.equal(resolveEntryName('@local/plug'), '@local/plug')
})

test('file: 目录：解析到 <dir>/<main> 的 file URL', () => {
  assert.equal(resolveEntryName(pathToFileURL(pluginDir).href), pathToFileURL(join(pluginDir, 'lib', 'index.js')).href)
})

test('file: 文件：原样返回', () => {
  const f = pathToFileURL(join(pluginDir, 'lib', 'index.js')).href
  assert.equal(resolveEntryName(f), f)
})

test('绝对目录路径：必须明确报错，不得静默返回目录', () => {
  assert.throws(() => resolveEntryName(pluginDir), (e) => {
    assert.match(String(e.message), /包名|目录|path/)
    return true
  })
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
