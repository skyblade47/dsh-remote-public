#!/usr/bin/env node
// mirror-audit —— 仓库 ↔ 服务器镜像的**内容级**一致性对账（只读，不改任何东西）
// =============================================================================
// 为什么需要它：本仓的线上/服务器侧有**多份副本**（`/opt/dsh-remote` 镜像、release 内插件快照、
// 工作区文档镜像）。副本一多就必然漂移，而"漂移"在本仓已经真实咬过人：
//   · `plugins/dsh-adapter/dsh-bundle-patch.yml` —— **有人只改了服务器部署副本**（未入版本控制），
//     文档里自己写着"下一次 rsync 即回退"（见该文件内注释）；
//   · 仓库脚本头部长期自称"草案、未在任何服务器执行过"，而它其实**已经投产**（rc.1→rc.3 真升级用过）。
//
// 判定的关键：**按 git blob 哈希比，不按文件哈希比**。
//   · blob 哈希 = "GitHub 上的内容"的哈希（git 侧已做 CRLF→LF 归一）⇒ 不会把**行尾差异**误报成内容差异；
//   · 另外单独识别"**仅 CRLF 不同**"这一类（本仓 `plugins/**` 曾有这种历史遗留）。
//
// 用法（两段式：仓库在开发机、镜像在服务器）：
//   ① 开发机（仓库根）：node tools/mirror-audit.mjs emit --out mirror-manifest.tsv
//   ② 传到目标机：      scp mirror-manifest.tsv tools/mirror-audit.mjs root@<host>:/tmp/
//   ③ 目标机：          node /tmp/mirror-audit.mjs check --manifest /tmp/mirror-manifest.tsv --mirror /opt/dsh-remote
//
// 退出码：0 = 内容零差异；1 = 有差异（DIFF/仅 CRLF）；2 = 用法或环境错误
//
// 🔴 它**只报告、不修**。"缺失/多出"是**说明性**的：镜像本来就不全等 ——
//    例如 `deploy/linux/tests/**` 不进镜像、`client/web/**` 被仓库 .gitignore 排除、
//    插件 `*.bak-*` 与 `*_现场与证据.md` 是运行期审计产物、`backups/` 是运维备份。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

function die(msg, code = 2) {
  console.error(`mirror-audit: ${msg}`)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { mode: null, out: null, manifest: null, mirror: null }
  out.mode = argv[0] || null
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--out') out.out = v
    else if (k === '--manifest') out.manifest = v
    else if (k === '--mirror') out.mirror = v
    else die(`未知参数 ${k}`)
  }
  return out
}

/** git 的对象哈希：sha1("blob <len>\0" + content) */
function gitBlob(data) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
    .digest('hex')
}

function emit(outFile) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // 🔴 `-z` + `core.quotepath=false`：否则**中文路径会被转义成 `"\346\226\207…"`**，
  //    在目标机上 stat 必然失败 ⇒ 一排假的"缺失/多出"（本工具自测时踩到过）。
  const tree = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', 'HEAD'], { encoding: 'utf8' })
  const lines = tree.split('\0').filter(Boolean).map((l) => {
    const m = l.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/)
    return m ? `${m[1]}\t${m[2]}` : null
  }).filter(Boolean)
  const body = `# mirror-audit manifest\n# commit\t${commit}\n# count\t${lines.length}\n${lines.join('\n')}\n`
  if (outFile) {
    fs.writeFileSync(outFile, body, 'utf8')
    console.log(`已写出 ${outFile}（commit ${commit} · ${lines.length} 个文件）`)
  } else {
    process.stdout.write(body)
  }
}

function check(manifestFile, mirror) {
  if (!manifestFile) die('缺少 --manifest')
  if (!mirror) die('缺少 --mirror')
  if (!fs.existsSync(mirror)) die(`镜像目录不存在：${mirror}`)

  const entries = fs.readFileSync(manifestFile, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('\t')
      return { blob: l.slice(0, i), rel: l.slice(i + 1) }
    })

  let ok = 0
  const diff = []
  const crlfOnly = []
  const missing = []
  const tracked = new Set()

  for (const { blob, rel } of entries) {
    tracked.add(rel)
    const abs = path.join(mirror, rel)
    let data
    try {
      if (!fs.statSync(abs).isFile()) continue
      data = fs.readFileSync(abs)
    } catch {
      missing.push(rel)
      continue
    }
    if (gitBlob(data) === blob) { ok++; continue }
    const lf = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    if (gitBlob(lf) === blob) crlfOnly.push(rel)
    else diff.push(rel)
  }

  // 镜像独有文件（跳过 node_modules/.git/backups）—— 说明性信息，不是错误
  const extras = []
  ;(function walk(dir, rel) {
    let entries2 = []
    try { entries2 = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries2) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (r === 'backups') continue
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (!tracked.has(r)) extras.push(r)
    }
  })(mirror, '')

  console.log('=== mirror-audit 汇总 ===')
  console.log(`镜像目录          : ${mirror}`)
  console.log(`清单文件数        : ${tracked.size}`)
  console.log(`一致 OK           : ${ok}`)
  console.log(`🔴 内容不一致     : ${diff.length}`)
  console.log(`🟡 仅行尾(CRLF)   : ${crlfOnly.length}`)
  console.log(`服务器缺失        : ${missing.length}（说明性：镜像本来就不全等）`)
  console.log(`服务器多出        : ${extras.length}（说明性：备份/审计产物/被 .gitignore 的源码）`)

  if (diff.length) {
    console.log('\n--- 内容不一致（逐条）---')
    for (const d of diff) console.log('  ' + d)
  }
  if (crlfOnly.length) {
    console.log('\n--- 仅行尾不同 ---')
    for (const d of crlfOnly) console.log('  ' + d)
  }
  if (extras.length) {
    console.log('\n--- 服务器多出（前 40 条）---')
    for (const e of extras.slice(0, 40)) console.log('  ' + e)
    if (extras.length > 40) console.log(`  ... 还有 ${extras.length - 40} 条`)
  }

  const bad = diff.length + crlfOnly.length
  console.log(`\n结论：${bad === 0 ? '✅ 仓库与镜像内容一致' : `❌ 有 ${bad} 个文件需要对齐`}`)
  process.exit(bad === 0 ? 0 : 1)
}

const args = parseArgs(process.argv.slice(2))
if (args.mode === 'emit') emit(args.out)
else if (args.mode === 'check') check(args.manifest, args.mirror)
else die('用法：mirror-audit.mjs emit --out <file>  |  check --manifest <file> --mirror <dir>')
