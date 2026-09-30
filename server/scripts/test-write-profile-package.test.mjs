// writeProfilePackage 的"应用模板"行为契约：已有 profile 也要按模板换插件集。
// 用法：node --test server/scripts/test-write-profile-package.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeProfilePackage } from './lib/profile-package.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const REAL_TEMPLATES_DIR = path.join(REPO_ROOT, 'server', 'data', 'templates')
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins')
const SEED_TPL = 'profile-web-minimal.package.json'

const SEED_TEXT = fs.readFileSync(path.join(REAL_TEMPLATES_DIR, SEED_TPL), 'utf8')
const SEED = JSON.parse(SEED_TEXT)

const roots = []

// 每个用例一个独立临时根：profileDir 与 templatesDir 都在其下，互不干扰。
function makeCase(seedText = SEED_TEXT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-pkg-'))
  roots.push(root)
  const profileDir = path.join(root, 'profiles', 'web')
  const templatesDir = path.join(root, 'templates')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(templatesDir, { recursive: true })
  fs.writeFileSync(path.join(templatesDir, SEED_TPL), seedText, 'utf8')
  return { profileDir, templatesDir, opts: { templatesDir, pluginsDir: PLUGINS_DIR } }
}

function writePkg(profileDir, pkg) {
  const text = JSON.stringify(pkg, null, 2) + '\n'
  fs.writeFileSync(path.join(profileDir, 'package.json'), text, 'utf8')
  return text
}

function readPkgText(profileDir) {
  return fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')
}

function bakFiles(profileDir) {
  return fs.readdirSync(profileDir).filter((f) => f.includes('.bak-')).sort()
}

// 与实现同一套推导规则算期望值（POSIX 分隔符的 link: 相对路径）。
function expectedLink(profileDir, short) {
  return 'link:' + path.relative(profileDir, path.join(PLUGINS_DIR, short)).split(path.sep).join('/')
}

// 造一个"旧 profile"：@local 依赖是别的链接形式，bundles 是旧插件集。
function makeOldPkg() {
  return {
    name: 'dsh-profile-web-old',
    private: true,
    dependencies: {
      '@local/dsh-adapter': 'link:../../plugins/dsh-adapter',
      '@local/memory-system': 'link:../../plugins/memory-system',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@local/dsh-adapter',
          '@local/memory-system',
        ],
      },
    },
  }
}

test('created：profile 不存在 ⇒ 按模板创建，内容与模板逐字节一致', () => {
  const { profileDir, opts } = makeCase()
  const result = writeProfilePackage(profileDir, SEED_TPL, opts)
  assert.equal(result, `created(by ${SEED_TPL})`)
  assert.equal(readPkgText(profileDir), SEED_TEXT)
  assert.deepEqual(bakFiles(profileDir), [])
})

test('applied-template：已存在 profile 按模板换插件集，@local 依赖由 bundles 推导', () => {
  const { profileDir, opts } = makeCase()
  const beforeText = writePkg(profileDir, makeOldPkg())

  const result = writeProfilePackage(profileDir, SEED_TPL, opts)
  assert.equal(result, 'applied-template')

  const pkg = JSON.parse(readPkgText(profileDir))

  // bundles 恰为模板的 3 条
  assert.deepEqual(pkg.dsh.profile.bundles, SEED.dsh.profile.bundles)
  assert.equal(pkg.dsh.profile.bundles.length, 3)

  // dependencies 含模板的 4 个第三方，值精确等于模板里的版本串
  assert.equal(Object.keys(SEED.dependencies).length, 4)
  for (const [name, spec] of Object.entries(SEED.dependencies)) {
    assert.equal(pkg.dependencies[name], spec, `依赖 ${name} 应为模板值`)
  }

  // @local/dsh-adapter 由 bundles 推导为 link:（bundles 引用了它，就必须有依赖）
  assert.ok('@local/dsh-adapter' in pkg.dependencies, '@local/dsh-adapter 不得从依赖中消失')
  assert.equal(pkg.dependencies['@local/dsh-adapter'], expectedLink(profileDir, 'dsh-adapter'))

  // 模板 bundles 未引用的 @local 依赖不得留下
  assert.ok(!('@local/memory-system' in pkg.dependencies), '@local/memory-system 应被移除')

  // 模板未声明的顶层键保留
  assert.equal(pkg.name, 'dsh-profile-web-old')
  assert.equal(pkg.private, true)

  // 备份：.bak-apply-<ts>，内容为改动前原文
  const baks = bakFiles(profileDir)
  assert.deepEqual(baks.map((f) => (/\.bak-apply-\d+$/.test(f) ? 'apply' : f)), ['apply'])
  assert.equal(fs.readFileSync(path.join(profileDir, baks[0]), 'utf8'), beforeText)
})

test('unchanged：内容已是模板合并结果 ⇒ 不写不备份，内容与 mtime 不变', () => {
  const { profileDir, opts } = makeCase()
  writePkg(profileDir, makeOldPkg())
  // 先应用一次，得到"与模板合并后的结果"作为起点
  assert.equal(writeProfilePackage(profileDir, SEED_TPL, opts), 'applied-template')

  const pkgPath = path.join(profileDir, 'package.json')
  const beforeText = readPkgText(profileDir)
  const beforeMtime = fs.statSync(pkgPath).mtimeMs
  const beforeFiles = fs.readdirSync(profileDir).sort()

  const result = writeProfilePackage(profileDir, SEED_TPL, opts)

  assert.equal(result, 'unchanged')
  assert.deepEqual(fs.readdirSync(profileDir).sort(), beforeFiles, '不得产生任何备份')
  assert.equal(readPkgText(profileDir), beforeText)
  assert.equal(fs.statSync(pkgPath).mtimeMs, beforeMtime, 'mtime 不得变化')
})

test('门禁1：模板 bundles 缺内核底座 ⇒ throw 且目标文件逐字节不变、无备份', () => {
  const tpl = JSON.parse(SEED_TEXT)
  tpl.dsh.profile.bundles = tpl.dsh.profile.bundles.filter((b) => b !== '@deepseek-ai/dsh-base')
  const { profileDir, opts } = makeCase(JSON.stringify(tpl, null, 2) + '\n')
  writePkg(profileDir, makeOldPkg())

  const pkgPath = path.join(profileDir, 'package.json')
  const before = fs.readFileSync(pkgPath)

  assert.throws(() => writeProfilePackage(profileDir, SEED_TPL, opts), /内核底座/)

  assert.deepEqual(fs.readFileSync(pkgPath), before)
  assert.deepEqual(bakFiles(profileDir), [])
})

test('门禁2：模板 bundles 为空数组 ⇒ throw 且目标文件逐字节不变、无备份', () => {
  const tpl = JSON.parse(SEED_TEXT)
  tpl.dsh.profile.bundles = []
  const { profileDir, opts } = makeCase(JSON.stringify(tpl, null, 2) + '\n')
  writePkg(profileDir, makeOldPkg())

  const pkgPath = path.join(profileDir, 'package.json')
  const before = fs.readFileSync(pkgPath)

  assert.throws(() => writeProfilePackage(profileDir, SEED_TPL, opts), /bundles 为空/)

  assert.deepEqual(fs.readFileSync(pkgPath), before)
  assert.deepEqual(bakFiles(profileDir), [])
})

test('门禁3：原子写不留 .tmp 残留，写入结果是合法 JSON', () => {
  const { profileDir, opts } = makeCase()
  writePkg(profileDir, makeOldPkg())

  assert.equal(writeProfilePackage(profileDir, SEED_TPL, opts), 'applied-template')

  const files = fs.readdirSync(profileDir)
  assert.ok(!files.includes('package.json.tmp'), `不得残留 .tmp：${files.join(', ')}`)
  assert.doesNotThrow(() => JSON.parse(readPkgText(profileDir)))
})

test('link 路径为 POSIX 风格：推导出的 link: 值不含反斜杠', () => {
  const { profileDir, opts } = makeCase()
  // 旧 profile 的 dependencies 里**没有** @local/dsh-adapter，只能由 bundles 推导得到
  writePkg(profileDir, {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-adapter'] } },
  })

  writeProfilePackage(profileDir, SEED_TPL, opts)

  const pkg = JSON.parse(readPkgText(profileDir))
  const link = pkg.dependencies['@local/dsh-adapter']
  assert.ok(typeof link === 'string' && link.startsWith('link:'), `应为 link: 依赖，实得 ${link}`)
  assert.ok(!link.includes('\\'), `link 值不得含反斜杠：${link}`)
  assert.equal(link, expectedLink(profileDir, 'dsh-adapter'))
})

test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})
