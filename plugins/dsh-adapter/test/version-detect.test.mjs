// detectHost() 的布局识别：新增 argv[1]-lib 分支（2026-09-26）
//   · 必须覆盖两种真实布局：release 布局（<release>/kernel/bin/dsh）与旧 npm -g 布局（<prefix>/bin/dsh）
//   · 回归护栏：便携版形态（<portable>/resources/<x>/node_modules/@deepseek-ai/dsh/lib/bin.js）仍走既有 ③ 分支
//   · 不误命中：argv[1] 树下没有 dsh 包时，新分支不得返回宿主
//   用法（仓库根目录）：node --test plugins/dsh-adapter/test/version-detect.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectHost } from '../lib/version.js'

/** 造一棵"宿主安装树"：<root>/lib/node_modules/@deepseek-ai/dsh/package.json */
function makeHostTree(root, version) {
  const pkgDir = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }), 'utf8')
  return join(pkgDir, 'package.json')
}

/** 临时把 process.argv[1] 换成给定值、并清掉 DSH_VERSION，跑完还原（detectHost 读的正是这两个） */
function withArgv1(argv1, fn) {
  const savedArgv1 = process.argv[1]
  const savedVer = process.env.DSH_VERSION
  try {
    process.argv[1] = argv1
    delete process.env.DSH_VERSION
    return fn()
  } finally {
    process.argv[1] = savedArgv1
    if (savedVer === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = savedVer
  }
}

test('release 布局：<release>/kernel/bin/dsh ⇒ 命中 <release>/kernel/lib/node_modules/@deepseek-ai/dsh', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-detect-release-'))
  try {
    const pkg = makeHostTree(join(root, 'kernel'), '9.9.9-rc.9')
    const h = withArgv1(join(root, 'kernel', 'bin', 'dsh'), () => detectHost())
    assert.equal(h.version, '9.9.9-rc.9')
    assert.equal(h.source, 'argv[1]-lib')
    assert.equal(h.dshPkgPath, pkg)
    assert.equal(h.installRoot, join(root, 'kernel', 'lib', 'node_modules'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('旧 npm -g 布局：<prefix>/bin/dsh ⇒ 向上找到 <prefix>/lib/node_modules/@deepseek-ai/dsh', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-detect-npmg-'))
  try {
    const pkg = makeHostTree(root, '8.8.8')
    const h = withArgv1(join(root, 'bin', 'dsh'), () => detectHost())
    assert.equal(h.version, '8.8.8')
    assert.equal(h.source, 'argv[1]-lib')
    assert.equal(h.dshPkgPath, pkg)
    assert.equal(h.installRoot, join(root, 'lib', 'node_modules'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('回归护栏：便携版 argv[1]（…/@deepseek-ai/dsh/lib/bin.js）仍走既有 ③ 分支', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-detect-portable-'))
  try {
    const pkgDir = join(root, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    const pkg = join(pkgDir, 'package.json')
    writeFileSync(pkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' }), 'utf8')
    writeFileSync(join(pkgDir, 'lib', 'bin.js'), '', 'utf8')
    const h = withArgv1(join(pkgDir, 'lib', 'bin.js'), () => detectHost())
    assert.equal(h.version, '0.1.5-rc.1')
    assert.equal(h.source, 'argv[1]')   // ← 既有 ③ 分支优先，新分支不得抢走
    assert.equal(h.dshPkgPath, pkg)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('不误命中：argv[1] 树下没有 @deepseek-ai/dsh ⇒ 新分支不得返回（source ≠ argv[1]-lib）', () => {
  const root = mkdtempSync(join(tmpdir(), 'vr-detect-empty-'))
  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    const h = withArgv1(join(root, 'bin', 'dsh'), () => detectHost())
    assert.notEqual(h.source, 'argv[1]-lib')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
