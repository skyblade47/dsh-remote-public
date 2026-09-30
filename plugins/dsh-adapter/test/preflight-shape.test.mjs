// 回归：preflight 不得因"注释头超过 1KB"而误杀合法插件
//
// 复现条件（与生产一致）：入口文件开头是较长的注释头（本仓插件普遍如此，
// 例如 plugins/memory-system/lib/index.js 的首个 export 在第 24 行）。
//
// 缺陷 2 的表现：preflight 抛 INVALID_PATH「入口前 1KB 未见 export/apply/default」
// 期望：preflight 通过（模块形状由 linkValidate 真实 import 后判定，不归 preflight）
//
// 用法：node --test plugins/dsh-adapter/test/preflight-shape.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { preflight } from '../lib/hotplug/preflight.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-preflight-shape-'))
const pluginDir = join(dir, 'plug')
mkdirSync(join(pluginDir, 'lib'), { recursive: true })

// 注释头 > 1KB，export 落在 1KB 之后
const longComment = '// ' + 'x'.repeat(1400) + '\n'
writeFileSync(join(pluginDir, 'lib', 'index.js'), longComment + 'export default () => {}\n', 'utf8')
writeFileSync(
  join(pluginDir, 'package.json'),
  JSON.stringify({
    name: '@local/plug',
    version: '0.0.1',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': { default: './lib/index.js' }, './package.json': './package.json' },
  }),
  'utf8',
)

test('preflight：注释头 >1KB 的合法模块必须通过', async () => {
  const r = await preflight({ id: 'plug', path: pluginDir })
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'dir')
  assert.equal(r.mainPath, join(pluginDir, 'lib', 'index.js'))
})

test('preflight：真实插件目录（memory-system）必须通过', async () => {
  // 用仓库里真实插件做夹具，防止"只对合成夹具成立"
  const real = fileURLToPath(new URL('../../memory-system', import.meta.url))
  const r = await preflight({ id: 'memory-system', path: real })
  assert.equal(r.ok, true)
})

test('preflight：云盘占位符仍必须被拦（这条检查有独有价值，不能一起删掉）', async () => {
  const bad = join(dir, 'placeholder')
  mkdirSync(join(bad, 'lib'), { recursive: true })
  writeFileSync(join(bad, 'lib', 'index.js'), Buffer.from([0xEF, 0xBB, 0xBF]), 'utf8')
  writeFileSync(join(bad, 'package.json'), JSON.stringify({ name: '@local/bad', main: 'lib/index.js' }), 'utf8')
  await assert.rejects(() => preflight({ id: 'bad', path: bad }), (e) => {
    assert.equal(e.code, 'INVALID_PATH')
    assert.match(e.message, /占位符/)
    return true
  })
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
