// B-6 判据脚本：与 deploy/linux/kernel-release.sh 的 A9 / A10 同口径，判一个夹具 case 的 result.json。
// 用法：node judge-a9a10.mjs <caseDir> <releaseRoot> <profileNodeModules> <--expect-pass|--expect-fail>
//
// 🔴 两个口径（这是本脚本最要紧的一点）：
//   · 夹具口径（本脚本的判定用）：错误文本里出现 EACCES|EPERM|exists and is not a symlink|EEXIST 即算命中。
//   · 真机口径（kernel-release.sh 的 A9）：只认**同时提及 release 路径**的行（避免切包瞬间 heal 重写
//     DSH_HOME/profiles/node_modules 的 ~163 条软链产生的噪声把整次切换误判成"未通过"）。
//   ⚠️ 实测（G4）：heal 穿过软链写 release 时抛的 EACCES，报错路径是 **DSH_HOME 侧的软链路径**，
//     不含 release 字面 ⇒ 真机收紧口径会**漏报**。所以本脚本两种口径都打印，判定用夹具口径。
import fs from 'node:fs'
import path from 'node:path'

const [caseDir, releaseRoot, pnmPath, expect] = process.argv.slice(2)
if (!caseDir || !releaseRoot || !pnmPath || !['--expect-pass', '--expect-fail'].includes(expect)) {
  console.error('用法：node judge-a9a10.mjs <caseDir> <releaseRoot> <profileNodeModules> <--expect-pass|--expect-fail>')
  process.exit(2)
}
const VER = process.env.REL_OWN_VER || '0.1.5-rc.1'

const r = JSON.parse(fs.readFileSync(path.join(caseDir, 'result.json'), 'utf8'))
const text = `${r.errCode} ${r.errMessage}`

// ---- A9：fallback / 权限类错误是否发生
const PAT = /EACCES|EPERM|exists and is not a symlink|EEXIST/
const hitAll = PAT.test(text) ? 1 : 0
const hitRel = hitAll === 1 && text.includes(releaseRoot) ? 1 : 0
const a9 = hitAll === 0
console.log(`[judge] ${path.basename(caseDir)} A9 命中(夹具口径/真机口径) = ${hitAll}/${hitRel} ⇒ ${a9 ? 'OK' : 'NG'}`)
if (hitAll > 0 && hitRel === 0) {
  console.log('[judge] ⚠️ 真机收紧口径会漏报本条（报错路径是 DSH_HOME 侧软链路径，不含 release 字面）—— 见 G4')
}

// ---- A10：profiles/web/node_modules 仍是软链、且 readlink 仍指向目标 release
const isLink = fs.lstatSync(pnmPath).isSymbolicLink()
const target = isLink ? fs.readlinkSync(pnmPath) : ''
const wanted = path.join(releaseRoot, VER, 'profile', 'node_modules')
const a10 = isLink && target === wanted && r.targetAfter === r.targetBefore
console.log(`[judge] ${path.basename(caseDir)} A10 软链=${isLink} readlink=${target} ⇒ ${a10 ? 'OK' : 'NG'}`)

const casePass = a9 && a10
console.log(`[judge] ${path.basename(caseDir)} CASE ${casePass ? 'PASS' : 'FAIL'}`)

const want = expect === '--expect-pass'
if (casePass === want) process.exit(0)
console.error(`[judge] 🔴 ${path.basename(caseDir)} 期望 ${want ? 'PASS' : 'FAIL'}，实际 ${casePass ? 'PASS' : 'FAIL'}`)
process.exit(1)
