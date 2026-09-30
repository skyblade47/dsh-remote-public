// 白名单 path 可解析性自检
//
// 契约（2026-09-23 真机实证）：白名单条目的 path 必须是**能从 profile 解析到的包名**。
// 理由：adapter 的 resolveEntryName 对非 file: 输入原样返回，绝对目录会被 loader 直接
//       import，而 ESM 不支持目录导入（实测报 `Directory import ... is not supported`）。
//
// 用法：node server/scripts/check-hotplug-paths.mjs <DSH_HOME>
// 退出码：0=全部可解析；1=有不可解析项（调用方据此中止装配）；2=参数缺失
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const dshHome = process.argv[2] || process.env.DSH_HOME
if (!dshHome) {
  console.error('用法: node check-hotplug-paths.mjs <DSH_HOME>')
  process.exit(2)
}

const ymlPath = path.join(dshHome, 'hotplug-manifest.yml')
const profileDir = path.join(dshHome, 'profiles', 'web')

if (!fs.existsSync(ymlPath)) {
  console.log('无白名单文件，跳过')
  process.exit(0)
}

const text = fs.readFileSync(ymlPath, 'utf8')
// 极简解析：本 manifest 由本仓自己写、格式稳定，故只取 id/path 的成对行。
// 刻意不引入 YAML 依赖 —— 装配机不该为一次自检多装一个包。
const ids = [...text.matchAll(/^\s*-?\s*id:\s*"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1].trim())
const paths = [...text.matchAll(/^\s*path:\s*"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1].trim())

// baseDir 必须与 adapter 生产里用的那个一致：profile 根目录（见 lib/index.js 的
// baseDir: join(dshHome, 'profiles', 'web')）。不一致的话这个自检就没意义了。
const req = createRequire(path.join(profileDir, '__resolve__.js'))
let bad = 0
for (let i = 0; i < paths.length; i++) {
  const p = paths[i]
  const id = ids[i] || '(未知 id)'
  if (!p) continue
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) {
    console.error(`  ✗ ${id}: path 是文件系统路径（${p}）—— 契约要求包名；绝对目录会被 loader 直接 import，而 ESM 不支持目录导入`)
    bad++
    continue
  }
  if (p.startsWith('file:')) continue
  try {
    req.resolve(p + '/package.json')
  } catch (_) {
    try {
      req.resolve(p)
    } catch (e) {
      console.error(`  ✗ ${id}: 无法从 profile 解析包名 ${p}（${e && e.code ? e.code : e}）`)
      bad++
    }
  }
}
if (bad) {
  console.error(`白名单自检失败：${bad} / ${paths.length} 条不可解析`)
  process.exit(1)
}
console.log(`白名单 path 自检通过 ✓（${paths.length} 条包名均可从 profile 解析）`)
