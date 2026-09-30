// 契约测试：钉住插件清单（package.json / cordis.patch.yml）。
// 用法（仓库根目录）：node --test plugins/version-radar/test/contract.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(ROOT, 'package.json')
const PATCH_PATH = join(ROOT, 'cordis.patch.yml')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('package.json：name / type / main 三件套', () => {
  const pkg = readJson(PKG_PATH)
  assert.equal(pkg.name, '@local/version-radar')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
})

test('package.json：dsh.bundle.patch 指向的文件**真实存在**', () => {
  const pkg = readJson(PKG_PATH)
  const rel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  assert.equal(rel, './cordis.patch.yml')
  assert.equal(existsSync(join(ROOT, rel)), true, 'patch 文件必须真实存在：' + rel)
})

test('package.json：files 覆盖 lib 与 patch 文件', () => {
  const pkg = readJson(PKG_PATH)
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(files.includes('lib'), 'files 必须含 lib')
  assert.ok(files.includes('cordis.patch.yml'), 'files 必须含 cordis.patch.yml')
})

test('package.json：engines.dsh 为精确值，且与 compat-matrix 的声明口径一致', () => {
  const pkg = readJson(PKG_PATH)
  // 🔒 精确值（不是 `>=`）：宿主一升就不匹配、被 adapter 报出来 ⇒ 形成一次"强制复核"。
  //    2026-09-27 宿主由 rc.1 真升级到 rc.3、冒烟通过后，13 个自研插件同步提到该值。
  assert.equal(pkg.engines && pkg.engines.dsh, '0.1.5-rc.3')
  // 🔒 与兼容矩阵的两处口径绑死：任何一边漂移都立刻失败（此前只有名字写着"一致"，实际没校验）
  const matrix = readJson(join(ROOT, '..', 'dsh-adapter', 'compat-matrix.json'))
  assert.equal(pkg.engines.dsh, matrix.localPlugins.declared)
})

test('cordis.patch.yml：含 - insert 且 id/name 本插件', () => {
  const text = readFileSync(PATCH_PATH, 'utf8')
  assert.match(text, /^-\s*insert:/m)
  assert.match(text, /id:\s*version-radar/)
  assert.match(text, /name:\s*'@local\/version-radar'/)
})
