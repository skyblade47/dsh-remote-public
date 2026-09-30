// 夹具 A「链解析」：造「link -> link -> dir」三层链 + 包内 pnpm 式相对链，验 Node 解析与断链报错。
// 判据：A-1 CJS require / A-2 ESM import / A-3 realpath 落点 / A-4 断链必须报错 / A-5 包内相对链可解析。
// ⚠️ 全部造在 /tmp（Linux fs）；裸导入与断链**必须在新进程里测**（否则命中模块缓存，得到假结果）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-own-a-'))
const RELEASE_ROOT = path.join(ROOT, 'release')
const VER = '0.1.5-rc.1'
const REL = path.join(RELEASE_ROOT, VER)
const PROFILE = path.join(ROOT, 'home', 'profiles', 'web')
const CUR = path.join(RELEASE_ROOT, 'current')

let failed = 0
const ok = (id, cond, extra = '') => {
  console.log(`${cond ? 'OK ' : 'NG '} ${id} ${extra}`)
  if (!cond) failed = 1
}
const runNode = (file) => spawnSync('node', [file], { encoding: 'utf8' })
const firstLine = (s) => String(s).trim().split('\n').find((l) => l.length > 0) || ''

// ---- 造树
const plugins = ['dsh-adapter', 'taskkit']
const storeDep = path.join(REL, 'profile', 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep')
fs.mkdirSync(storeDep, { recursive: true })
fs.writeFileSync(path.join(storeDep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }))
fs.writeFileSync(path.join(storeDep, 'index.js'), 'module.exports = { tag: "dep" }\n')

for (const n of plugins) {
  const p = path.join(REL, 'plugins', n)
  fs.mkdirSync(path.join(p, 'lib'), { recursive: true })
  // 镜像真实插件形态：type=module + main + exports（plugins/*/package.json 实测如此）
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({
    name: `@local/${n}`, version: '1.0.0', type: 'module', main: 'lib/index.js',
    exports: { '.': { default: './lib/index.js' }, './package.json': './package.json' },
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(p, 'lib', 'index.js'), 'import dep from "dep"\nexport const tag = "plugin-esm+" + dep.tag\n')
  // 包内 pnpm 式相对链：<plugin>/node_modules/dep -> ../../../profile/node_modules/.pnpm/…
  fs.mkdirSync(path.join(p, 'node_modules'), { recursive: true })
  fs.symlinkSync('../../../profile/node_modules/.pnpm/dep@1.0.0/node_modules/dep', path.join(p, 'node_modules', 'dep'))
}

fs.symlinkSync(REL, CUR)                                        // 第一层：current -> <ver>
const localDir = path.join(PROFILE, 'node_modules', '@local')   // 第二层：@local/<n> -> current/plugins/<n>
fs.mkdirSync(localDir, { recursive: true })
for (const n of plugins) fs.symlinkSync(path.join(CUR, 'plugins', n), path.join(localDir, n))

// 探针必须放在 profile 内（裸导入按**导入方所在目录**向上找 node_modules）
const cjsProbe = path.join(PROFILE, 'probe.cjs')
const esmProbe = path.join(PROFILE, 'probe.mjs')
fs.writeFileSync(cjsProbe, 'const m = require("@local/taskkit"); console.log("CJS", m.tag)\n')
fs.writeFileSync(esmProbe, 'import { tag } from "@local/dsh-adapter"; console.log("ESM", tag)\n')

// ---- A-1 CJS require
let r = runNode(cjsProbe)
ok('A-1 CJS require("@local/taskkit")', r.status === 0 && /CJS plugin-esm\+dep/.test(r.stdout), firstLine(r.stdout || r.stderr))

// ---- A-2 ESM import
r = runNode(esmProbe)
ok('A-2 ESM import "@local/dsh-adapter"', r.status === 0 && /ESM plugin-esm\+dep/.test(r.stdout), firstLine(r.stdout || r.stderr))

// ---- A-5 包内相对链（从插件真实目录解析第三方）
const depProbe = path.join(REL, 'plugins', 'taskkit', 'lib', 'probe-dep.mjs')
fs.writeFileSync(depProbe, 'import dep from "dep"; console.log("DEP", dep.tag)\n')
r = runNode(depProbe)
ok('A-5 包内 pnpm 式相对链可解析（穿软链）', r.status === 0 && /DEP dep/.test(r.stdout), firstLine(r.stdout || r.stderr))
fs.unlinkSync(depProbe)

// ---- A-3 realpath 落点 + 非软链 + 链层数
const rp = fs.realpathSync(path.join(localDir, 'taskkit'))
ok('A-3 realpathSync 落在 <release>/plugins/taskkit', rp === path.join(REL, 'plugins', 'taskkit'), rp)
ok('A-3b realpath 非软链（真实文件目录）', !fs.lstatSync(rp).isSymbolicLink())
ok('A-3c 链层数 = 2（@local→current、current→ver）',
  fs.lstatSync(path.join(localDir, 'taskkit')).isSymbolicLink() && fs.lstatSync(CUR).isSymbolicLink())

// ---- A-4 断链必须明确报错（新进程！）
fs.unlinkSync(CUR)
fs.symlinkSync(path.join(RELEASE_ROOT, '9.9.9-nope'), CUR)
r = runNode(cjsProbe)
const m1 = `${r.stdout}${r.stderr}`
ok('A-4 断链时 require 必须报错（不许静默回退）',
  r.status !== 0 && /Cannot find module|MODULE_NOT_FOUND|ENOENT/.test(m1), firstLine(m1))
r = runNode(esmProbe)
const m2 = `${r.stdout}${r.stderr}`
ok('A-4b 断链时 import 必须报错（不许静默回退）',
  r.status !== 0 && /ERR_MODULE_NOT_FOUND|ENOENT/.test(m2), firstLine(m2))

console.log(`[fixture-a] 临时树：${ROOT}`)
process.exit(failed)
