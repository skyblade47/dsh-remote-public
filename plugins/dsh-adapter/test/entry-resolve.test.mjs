// 回归：入口解析必须落在真实入口文件，不能落到 package.json
//
// 复现条件（与生产一致）：
//   1. 插件 package.json 的 exports **显式导出** "./package.json"
//      —— 本仓 12 个自研插件全都是这样（adapter 运行期要读它）
//   2. 于是 fsPathOf 的 `req.resolve(path + '/package.json')` 会成功
//
// 缺陷 1 的表现：resolveEntryFileUrl 返回 file://.../package.json（错）
// 期望：返回 file://.../lib/index.js
//
// 用法：node --test plugins/dsh-adapter/test/entry-resolve.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { fsPathOf, resolveEntryFileUrl, resolvePluginRoot } from '../lib/hotplug/plugin-path.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-entry-resolve-'))
const pluginDir = join(dir, 'plug')
mkdirSync(join(pluginDir, 'lib'), { recursive: true })
writeFileSync(join(pluginDir, 'lib', 'index.js'), 'export default () => {}\n', 'utf8')
// ⚠️ 关键：exports 里要显式导出 "./package.json"（与自家插件一致）
writeFileSync(
  join(pluginDir, 'package.json'),
  JSON.stringify({
    name: '@local/plug',
    version: '0.0.1',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': { default: './lib/index.js' },
      './package.json': './package.json',
    },
  }),
  'utf8',
)

test('fsPathOf：目录输入必须返回包根目录，而不是 package.json', () => {
  assert.equal(fsPathOf(pluginDir), pluginDir)
})

test('resolveEntryFileUrl：必须返回真实入口文件，而不是 package.json', () => {
  assert.equal(resolveEntryFileUrl(pluginDir), pathToFileURL(join(pluginDir, 'lib', 'index.js')).href)
})

test('resolvePluginRoot：必须返回包根目录（此前的侥幸正确不能回退）', () => {
  assert.deepEqual(resolvePluginRoot(pluginDir), {
    rootPath: pluginDir,
    rootUrl: pathToFileURL(pluginDir).href,
  })
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
