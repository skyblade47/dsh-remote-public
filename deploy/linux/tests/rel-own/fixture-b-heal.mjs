// 夹具 B 本体：以**当前（非 root）用户**调 heal，落 result.json。
// 用法：node fixture-b-heal.mjs <caseDir> <scenario>
// 关键点：调的是 app-boot 的**公开入口** healProfilesModuleFallback({installAnchor, profile, home})；
//   它内部会走到未导出的 ensureProfileSymlink / removeProfileSymlink（见「发现的设计缺口」G1）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TOOLS_ROOT = process.env.REL_OWN_TOOLS || '/tmp/rel-own-tools'
const BOOT = process.env.REL_OWN_APP_BOOT_LIB
  || path.join(TOOLS_ROOT, 'app-boot', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
const CASE = process.argv[2]
const SCEN = process.argv[3]
const VER = process.env.REL_OWN_VER || '0.1.5-rc.1'

const ROOT = CASE
const HOME = path.join(ROOT, 'home')
const REL = path.join(ROOT, 'release', VER)
const PROFILE = path.join(HOME, 'profiles', 'web')
const KDIR = path.join(REL, 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
const BDIR = path.join(REL, 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh-base')
const TKDIR = path.join(REL, 'plugins', 'taskkit')

function inventory(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      out.push(`${path.relative(dir, p)}\t${st.isSymbolicLink() ? 'l->' + fs.readlinkSync(p) : st.isDirectory() ? 'd' : 'f'}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort().join('\n')
}

const { healProfilesModuleFallback } = await import(pathToFileURL(BOOT).href)

const profile = {
  dir: PROFILE,
  layers: [
    { packageName: '@deepseek-ai/dsh', packageDir: KDIR },
    { packageName: '@deepseek-ai/dsh-base', packageDir: BDIR },
    { packageName: '@local/taskkit', packageDir: TKDIR },
  ],
}

const pnm = path.join(PROFILE, 'node_modules')
const isLinkBefore = fs.lstatSync(pnm).isSymbolicLink()
const targetBefore = fs.readlinkSync(pnm)
const before = inventory(REL)

let errCode = ''
let errMessage = ''
try {
  await healProfilesModuleFallback({ installAnchor: path.join(KDIR, 'package.json'), profile, home: HOME })
} catch (e) {
  errCode = String((e && e.code) || '')
  errMessage = String((e && e.message) || e).split('\n')[0]
}

const after = inventory(REL)
const removed = before.split('\n').filter((l) => !after.split('\n').includes(l))
const added = after.split('\n').filter((l) => !before.split('\n').includes(l))

process.stdout.write(JSON.stringify({
  scenario: SCEN,
  errCode,
  errMessage,
  isLinkBefore,
  targetBefore,
  isLinkAfter: fs.lstatSync(pnm).isSymbolicLink(),
  targetAfter: fs.readlinkSync(pnm),
  releaseChanged: before !== after,
  added,
  removed,
}, null, 2) + '\n')
