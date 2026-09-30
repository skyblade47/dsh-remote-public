// 夹具 B 建树器：造隔离场景，每个场景自带 release/ 与 home/。
//   b2 = 条目逐条对齐（期望：零写入）
//   b3 = 故意少一条（期望：ensureProfileSymlink → symlinkSync 穿过软链 → EACCES）
//   b4 = 故意多一条（期望：removeProfileSymlink → unlinkSync 穿过软链 → EACCES）
// 全部造在 /tmp；app-boot 的真实语义（0.1.5-rc.1）：
//   healProfilesModuleFallback({installAnchor, profile, home}) → healProfileModuleFallback(profile, packageNames)
//   profileModulesDir = profile.dir/node_modules（P-A 下 = 指向 release 的软链）
//   ownedModulesDir   = profile.dir/.dsh-module-fallback/node_modules（在 DSH_HOME，可写）
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.REL_OWN_BASE || '/tmp/rel-own-fixture-b'
const SCENARIOS = ['b2', 'b3', 'b4']
const VER = '0.1.5-rc.1'
fs.rmSync(BASE, { recursive: true, force: true })

function writePkg(dir, obj) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(obj, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const tag = "x"\n')
}

function inventory(REL) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      out.push(`${path.relative(REL, p)}\t${st.isSymbolicLink() ? 'l->' + fs.readlinkSync(p) : st.isDirectory() ? 'd' : 'f'}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(REL)
  return out.sort().join('\n')
}

for (const c of SCENARIOS) {
  const ROOT = path.join(BASE, c)
  const HOME = path.join(ROOT, 'home')
  const RELEASE_ROOT = path.join(ROOT, 'release')
  const REL = path.join(RELEASE_ROOT, VER)
  const PROFILES = path.join(HOME, 'profiles')
  const PROFILE = path.join(PROFILES, 'web')

  // 内核锚：<release>/kernel/lib/node_modules/@deepseek-ai/dsh
  const KDIR = path.join(REL, 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  writePkg(KDIR, { name: '@deepseek-ai/dsh', version: VER, type: 'module', dependencies: { '@deepseek-ai/dsh-base': '1.0.0' } })
  const BDIR = path.join(REL, 'kernel', 'lib', 'node_modules', '@deepseek-ai', 'dsh-base')
  writePkg(BDIR, { name: '@deepseek-ai/dsh-base', version: '1.0.0', type: 'module', dependencies: {} })

  // release 里的自研插件快照
  const TKDIR = path.join(REL, 'plugins', 'taskkit')
  writePkg(TKDIR, {
    name: '@local/taskkit', version: '1.0.0', type: 'module',
    dependencies: c === 'b2' ? {} : { 'dep-x': '1.0.0' },
  })
  if (c !== 'b2') writePkg(path.join(TKDIR, 'node_modules', 'dep-x'), { name: 'dep-x', version: '1.0.0', type: 'module', dependencies: {} })

  // release 里的 profile/node_modules（P-A 形态：这就是被软链过去的目录）
  const REL_PNM = path.join(REL, 'profile', 'node_modules')
  fs.mkdirSync(REL_PNM, { recursive: true })

  fs.mkdirSync(PROFILE, { recursive: true })
  writePkg(PROFILE, {
    name: 'web-profile', version: '0.0.0', private: true,
    dependencies: { '@local/taskkit': 'link:../../../../release/current/plugins/taskkit' },
  })

  if (c === 'b4') {
    // 「多一条」：profile 自有 fallback 里有一条 dep-y，且 profile 的 node_modules 里有一条指向它
    const OWNED = path.join(PROFILE, '.dsh-module-fallback', 'node_modules')
    fs.mkdirSync(OWNED, { recursive: true })
    fs.symlinkSync(TKDIR, path.join(OWNED, 'dep-y'))
    fs.symlinkSync(path.join(OWNED, 'dep-y'), path.join(REL_PNM, 'dep-y'))
  }

  // 共享 fallback（DSH_HOME/profiles/node_modules，可写，与 release 无关）
  const SHARED = path.join(PROFILES, 'node_modules')
  fs.mkdirSync(path.join(SHARED, '@deepseek-ai'), { recursive: true })
  fs.symlinkSync(KDIR, path.join(SHARED, '@deepseek-ai', 'dsh'))
  fs.symlinkSync(BDIR, path.join(SHARED, '@deepseek-ai', 'dsh-base'))

  // P-A：profile 的 node_modules 改成软链 -> <release>/profile/node_modules
  fs.symlinkSync(REL_PNM, path.join(PROFILE, 'node_modules'))
  const LOCAL = path.join(PROFILE, 'node_modules', '@local')
  fs.mkdirSync(LOCAL, { recursive: true })
  fs.symlinkSync(TKDIR, path.join(LOCAL, 'taskkit'))

  fs.symlinkSync(REL, path.join(RELEASE_ROOT, 'current'))

  fs.writeFileSync(path.join(ROOT, 'release.before.txt'), inventory(REL))
}

console.log(`[fixture-b-build] 已建 ${SCENARIOS.length} 个场景于 ${BASE}`)
