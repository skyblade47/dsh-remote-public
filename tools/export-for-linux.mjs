// 导出 Linux 迁移包：把「改写 cwd 后的会话 + 工作区 + 网关/内核状态」打成一个 tar.gz。
//
// 为什么需要它（而不是直接 rsync 目录）：
// 1) 会话必须先做 cwd 改写与换桶（见 server/scripts/session-migrate.mjs 头部说明），
//    否则内核在新平台上根本找不到旧会话；
// 2) 源目录里混着大量「可重建」与「不该走网络」的东西（380 MB node_modules、
//    59 MB 日志、含 API Key 的 .credentials.yaml），需要一个可审计的取舍清单；
// 3) 产物要能校验（SHA256）与一次性搬运（单个归档 + 清单 + 还原脚本）。
//
// 包含 / 排除（这是本工具的契约，改动请同步改 MANIFEST 与文档）：
//   包含：sessions（改写后） / users（仅哈希） / workspaces / storages / settings.yaml /
//         工作区树（含其中的 .git 与插件状态）
//   排除：profiles（node_modules 可重建） / logs（本机诊断） / .agent-presets（与模板逐字一致，
//         setup.sh 会放） / .credentials.yaml（含 DEEPSEEK_API_KEY 等，默认不随包） /
//         _*backup* / node_modules / *.bak* / _tmp_* / *.log / 宿主与未安装插件的运行态
//
// 用法（dry-run 先看清单，再真跑）：
//   node tools/export-for-linux.mjs --dry-run
//   node tools/export-for-linux.mjs --out E:\exports\dsh-migrate.tar.gz
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { migrateSessions, listSessionFiles } from '../server/scripts/session-migrate.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- 过滤规则

// 目录名命中即整棵跳过（不进入、不跟随）
const EXCLUDE_DIR_NAMES = new Set(['node_modules'])
const EXCLUDE_DIR_PATTERNS = [/^_.*backup.*$/i, /^_tmp_/i]
// 文件名命中即跳过
const EXCLUDE_FILE_PATTERNS = [/\.bak$/i, /\.bak-/i, /^_tmp_/i, /\.log$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i]

function excludedDirReason(name) {
  if (EXCLUDE_DIR_NAMES.has(name)) return 'node_modules（可重建）'
  for (const p of EXCLUDE_DIR_PATTERNS) if (p.test(name)) return '备份/临时目录'
  return null
}

function excludedFileReason(name) {
  for (const p of EXCLUDE_FILE_PATTERNS) if (p.test(name)) return '备份/临时/日志文件'
  return null
}

// ---------------------------------------------------------------- 工具

function dirSize(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      try {
        const st = fs.lstatSync(p)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) walk(p)
        else if (st.isFile()) { files++; bytes += st.size }
      } catch { /* 权限/竞态：忽略 */ }
    }
  }
  walk(dir)
  return { files, bytes }
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`
const nowStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')

// 递归复制，带过滤；不跟随符号链接/junction（避免把链接目标整棵树抄进来）
function copyTree(src, dst, { onProgress } = {}) {
  const stat = { files: 0, bytes: 0, skipped: [] }
  const walk = (from, to, rel) => {
    fs.mkdirSync(to, { recursive: true })
    let entries
    try { entries = fs.readdirSync(from, { withFileTypes: true }) } catch (e) {
      stat.skipped.push({ rel, reason: `读取失败: ${e.code}` })
      return
    }
    for (const e of entries) {
      const srcPath = path.join(from, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      let st
      try { st = fs.lstatSync(srcPath) } catch { continue }
      if (st.isSymbolicLink()) {
        stat.skipped.push({ rel: relPath, reason: '符号链接/junction（不跟随）' })
        continue
      }
      if (st.isDirectory()) {
        const why = excludedDirReason(e.name)
        if (why) { stat.skipped.push({ rel: relPath, reason: why }); continue }
        walk(srcPath, path.join(to, e.name), relPath)
        continue
      }
      if (!st.isFile()) continue
      const why = excludedFileReason(e.name)
      if (why) { stat.skipped.push({ rel: relPath, reason: why }); continue }
      fs.copyFileSync(srcPath, path.join(to, e.name))
      stat.files++
      stat.bytes += st.size
      if (onProgress && stat.files % 500 === 0) onProgress(stat.files, stat.bytes)
    }
  }
  walk(src, dst, '')
  return stat
}

// dsh-home 顶层：只带走这些（名单式，避免误搬 380 MB 可重建物与运行态）
const DSH_HOME_DIRS = ['users', 'workspaces', 'storages']
const DSH_HOME_FILES = ['settings.yaml']

// 这些是宿主/未安装插件的运行态，明确不带（列出来是为了让报告可审计）
const DSH_HOME_KNOWN_SKIP = {
  profiles: 'node_modules 可重建（setup.sh 会重新装配）',
  logs: '本机诊断日志（含适配器 apply 日志）',
  '.agent-presets': '与 server/data/templates 逐字一致，setup.sh 会放',
  '.credentials.yaml': '含 API Key 与会话密钥，默认不随包（可用 --include-credentials）',
  '.anonymous-user-id': '匿名身份标识，新环境重新生成',
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const args = {
    dshHome: process.env.DSH_HOME || '',
    workspace: 'E:\\DSH工作区',
    out: '',
    targetDshHome: '/srv/dsh-home',
    targetWorkspace: '/srv/dsh-workspace',
    maps: [],
    defaultNewCwd: '',
    staging: '',
    keepStaging: false,
    includeCredentials: false,
    noCompress: false,
    dryRun: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dsh-home') args.dshHome = argv[++i]
    else if (a === '--workspace') args.workspace = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--target-dsh-home') args.targetDshHome = argv[++i]
    else if (a === '--target-workspace') args.targetWorkspace = argv[++i]
    else if (a === '--map') args.maps.push(argv[++i])
    else if (a === '--default') args.defaultNewCwd = argv[++i]
    else if (a === '--staging') args.staging = argv[++i]
    else if (a === '--keep-staging') args.keepStaging = true
    else if (a === '--include-credentials') args.includeCredentials = true
    else if (a === '--no-compress') args.noCompress = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '-h' || a === '--help') { args.help = true }
    else throw new Error(`未知参数：${a}`)
  }
  return args
}

function usage() {
  console.log(`导出 Linux 迁移包

用法：
  node tools/export-for-linux.mjs --dsh-home <源 DSH_HOME> --workspace <源工作区根> \\
       --out <输出 .tar.gz> [选项]

选项：
  --target-dsh-home <路径>     Linux 上的 DSH_HOME（默认 /srv/dsh-home）
  --target-workspace <路径>    Linux 上的工作区根（默认 /srv/dsh-workspace）
  --map "旧cwd=新cwd"          追加 cwd 映射（工作区那一条已自动生成，可多次）
  --default <新cwd>            未命中映射的会话兜底 cwd（缺省则跳过并在清单里列出）
  --staging <目录>             暂存目录（默认用系统临时目录）
  --keep-staging               保留暂存目录便于人工检查
  --include-credentials        把 .credentials.yaml 一并打包（⚠ 内含 API Key，会告警）
  --no-compress                只打 tar 不 gzip（会话已是 zstd，gzip 收益很小但耗时明显）
  --dry-run                    只出清单与统计，不落盘、不打包

产物结构（解压后）：
  dsh-migrate-<ts>/MANIFEST.json      包含内容/排除项/会话迁移统计/cwd 映射/SHA256
  dsh-migrate-<ts>/restore.sh         在 Linux 上把数据搬到目标位置并做自检
  dsh-migrate-<ts>/dsh-home/          → 目标 DSH_HOME
  dsh-migrate-<ts>/workspace/         → 目标工作区根`)
}

// ---------------------------------------------------------------- 主流程

function main() {
  const args = parseArgs(process.argv)
  if (args.help) { usage(); return }

  if (!args.dshHome) throw new Error('必须指定 --dsh-home（或用环境变量 DSH_HOME）')
  const dshHome = path.resolve(args.dshHome)
  const workspace = path.resolve(args.workspace)
  if (!fs.existsSync(dshHome)) throw new Error(`源 DSH_HOME 不存在：${dshHome}`)
  if (!fs.existsSync(workspace)) throw new Error(`源工作区不存在：${workspace}`)
  if (!args.dryRun && !args.out) throw new Error('必须指定 --out（或用 --dry-run 只看清单）')

  // cwd 映射：主映射 = 工作区根 → 目标工作区根；--map 可补充其它 cwd
  const cwdMap = new Map([[workspace, args.targetWorkspace]])
  for (const m of args.maps) {
    const i = m.lastIndexOf('=')
    if (i <= 0) throw new Error(`--map 格式应为 旧=新，收到：${m}`)
    cwdMap.set(m.slice(0, i), m.slice(i + 1))
  }

  const t0 = Date.now()
  console.log('='.repeat(66))
  console.log('源 DSH_HOME :', dshHome)
  console.log('源工作区    :', workspace)
  console.log('目标 DSH_HOME:', args.targetDshHome)
  console.log('目标工作区  :', args.targetWorkspace)
  for (const [o, n] of cwdMap) console.log(`cwd 映射    : ${o}  →  ${n}`)
  if (args.defaultNewCwd) console.log(`cwd 兜底    : ${args.defaultNewCwd}`)
  if (args.includeCredentials) {
    console.log('')
    console.log('⚠  --include-credentials：.credentials.yaml 内含 API Key 与会话密钥，')
    console.log('    产物是明文压缩包，请只在可信通道传输，用完即删。')
  }
  if (args.dryRun) console.log('（dry-run：只统计，不落盘）')
  console.log('='.repeat(66))

  const stamp = nowStamp()
  const bundleName = `dsh-migrate-${stamp}`
  const stagingParent = args.staging ? path.resolve(args.staging) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-export-'))
  const staging = path.join(stagingParent, bundleName)
  const stageDshHome = path.join(staging, 'dsh-home')
  const stageWorkspace = path.join(staging, 'workspace')

  // ---- 1) 会话：改写 cwd + 换桶 ----
  console.log('\n[1/5] 会话：改写 header.cwd 并重算桶名 ...')
  const sessionsRoot = path.join(dshHome, 'sessions')
  if (!fs.existsSync(sessionsRoot)) throw new Error(`源 sessions 目录不存在：${sessionsRoot}`)
  const sourceSessionFiles = listSessionFiles(sessionsRoot).length

  const { stats: sessionStats, records } = migrateSessions({
    sessionsRoot,
    outRoot: path.join(stageDshHome, 'sessions'),
    backupDir: '',                 // 目标目录是新建的，源目录天然就是"备份"，无需再复制一份
    cwdMap,
    defaultNewCwd: args.defaultNewCwd,
    dryRun: args.dryRun,
    log: () => {},                 // 逐条跳过日志太吵，汇总进清单
  })
  const skippedSessions = records.filter((r) => r.skipped)
  const buckets = new Map()
  for (const r of records) {
    if (!r.toBucket) continue
    buckets.set(r.toBucket, (buckets.get(r.toBucket) || 0) + 1)
  }
  const sessionBytes = args.dryRun ? 0 : dirSize(path.join(stageDshHome, 'sessions')).bytes
  console.log(`      总会话文件 ${sessionStats.total}｜改写 ${sessionStats.migrated}｜无需改写 ${sessionStats.unchanged}｜跳过 ${sessionStats.skipped}｜失败 ${sessionStats.failed}`)
  for (const [b, n] of buckets) console.log(`      目标桶 ${b}  (${n})`)
  if (skippedSessions.length) {
    console.log(`      ⚠ ${skippedSessions.length} 个文件因 cwd 不在映射表内被跳过（不含在产物里）：`)
    const byCwd = new Map()
    for (const r of skippedSessions) byCwd.set(r.oldCwd, (byCwd.get(r.oldCwd) || 0) + 1)
    for (const [cwd, n] of byCwd) console.log(`          cwd=${cwd}  →  ${n} 个文件`)
    console.log('        如需一并带走，加 --default <新cwd> 重跑（清单里会记录）')
  }
  if (sessionStats.failed) throw new Error(`有 ${sessionStats.failed} 个会话迁移失败，已中止（产物未生成）`)

  // ---- 2) DSH_HOME 其余状态 ----
  console.log('\n[2/5] DSH_HOME 状态（账号/工作区/内核存储/设置）...')
  const components = []
  const copyInto = (name, isDir) => {
    const src = path.join(dshHome, name)
    if (!fs.existsSync(src)) return
    // dry-run 只统计体积，绝不写盘
    if (args.dryRun) {
      const size = isDir ? dirSize(src) : { files: 1, bytes: fs.statSync(src).size }
      components.push({ name, files: size.files, bytes: size.bytes })
      console.log(`      ${name} → ${size.files} 文件 ${mb(size.bytes)}`)
      return
    }
    const dst = path.join(stageDshHome, name)
    if (isDir) {
      const st = copyTree(src, dst)
      components.push({ name, files: st.files, bytes: st.bytes })
      console.log(`      ${name}/ → ${st.files} 文件 ${mb(st.bytes)}`)
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      const bytes = fs.statSync(dst).size
      components.push({ name, files: 1, bytes })
      console.log(`      ${name} → ${mb(bytes)}`)
    }
  }
  for (const d of DSH_HOME_DIRS) copyInto(d, true)
  for (const f of DSH_HOME_FILES) copyInto(f, false)
  if (args.includeCredentials) copyInto('.credentials.yaml', false)
  components.unshift({ name: 'sessions', files: sessionStats.migrated + sessionStats.unchanged, bytes: sessionBytes })

  // 未带走的 dsh-home 顶层项（审计用）
  const excludedEntries = []
  for (const e of fs.readdirSync(dshHome, { withFileTypes: true })) {
    const taken = components.some((c) => c.name === e.name)
    if (taken) continue
    const p = path.join(dshHome, e.name)
    let size = { files: 0, bytes: 0 }
    try { size = e.isDirectory() ? dirSize(p) : { files: 1, bytes: fs.statSync(p).size } } catch { /* 忽略 */ }
    excludedEntries.push({
      name: e.name,
      files: size.files,
      bytes: size.bytes,
      reason: DSH_HOME_KNOWN_SKIP[e.name] || '不在包含名单内（宿主/未安装插件的运行态）',
    })
  }
  console.log(`      未包含的顶层项 ${excludedEntries.length} 个，合计 ${mb(excludedEntries.reduce((s, x) => s + x.bytes, 0))}（清单里有逐项原因）`)

  // ---- 3) 工作区 ----
  console.log('\n[3/5] 工作区 ...')
  let wsStat = { files: 0, bytes: 0, skipped: [] }
  if (!args.dryRun) {
    wsStat = copyTree(workspace, stageWorkspace, {
      onProgress: (files, bytes) => process.stdout.write(`\r      已复制 ${files} 文件 / ${mb(bytes)}   `),
    })
    process.stdout.write('\r')
  } else {
    // dry-run：只统计过滤后会带走多少
    const countOnly = (from) => {
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const p = path.join(from, e.name)
        let st
        try { st = fs.lstatSync(p) } catch { continue }
        if (st.isSymbolicLink()) { wsStat.skipped.push({ rel: e.name, reason: '符号链接/junction' }); continue }
        if (st.isDirectory()) {
          const why = excludedDirReason(e.name)
          if (why) { wsStat.skipped.push({ rel: e.name, reason: why }); continue }
          countOnly(p)
        } else if (st.isFile()) {
          const why = excludedFileReason(e.name)
          if (why) { wsStat.skipped.push({ rel: e.name, reason: why }); continue }
          wsStat.files++; wsStat.bytes += st.size
        }
      }
    }
    countOnly(workspace)
  }
  const wsSkippedDirs = wsStat.skipped.filter((s) => s.reason.includes('node_modules') || s.reason.includes('备份') || s.reason.includes('临时'))
  console.log(`      工作区 → ${wsStat.files} 文件 ${mb(wsStat.bytes)}；过滤掉 ${wsStat.skipped.length} 项`)
  for (const s of wsSkippedDirs.slice(0, 12)) console.log(`          ${s.rel}  (${s.reason})`)
  if (wsSkippedDirs.length > 12) console.log(`          ...还有 ${wsSkippedDirs.length - 12} 项同类（清单里全量记录）`)

  // ---- 4) 清单 + 还原脚本 ----
  const manifest = {
    schemaVersion: 1,
    generator: 'tools/export-for-linux.mjs',
    generatedAt: new Date().toISOString(),
    source: { dshHome, workspace, sourceSessionFiles },
    target: { dshHome: args.targetDshHome, workspace: args.targetWorkspace },
    cwdMap: Object.fromEntries(cwdMap),
    defaultNewCwd: args.defaultNewCwd,
    credentialsIncluded: args.includeCredentials,
    compressed: !args.noCompress,
    components,
    sessions: {
      stats: sessionStats,
      targetBuckets: Object.fromEntries(buckets),
      skipped: skippedSessions.map((r) => ({
        sessionId: r.sessionId,
        file: r.file,
        fromBucket: r.fromBucket,
        oldCwd: r.oldCwd,
        reason: r.skipped,
      })),
    },
    workspace: {
      files: wsStat.files,
      bytes: wsStat.bytes,
      skipped: wsStat.skipped,
    },
    excludedSourceEntries: excludedEntries,
  }

  if (!args.dryRun) {
    console.log('\n[4/5] 写清单与还原脚本 ...')
    fs.writeFileSync(path.join(staging, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    fs.writeFileSync(path.join(staging, 'restore.sh'), restoreScript({
      targetDshHome: args.targetDshHome,
      targetWorkspace: args.targetWorkspace,
      sessionFiles: sessionStats.migrated + sessionStats.unchanged,
      workspaceFiles: wsStat.files,
      buckets: [...buckets.keys()],
      sourceSessionFiles,
      skippedSessions: skippedSessions.length,
    }), 'utf8')
    fs.chmodSync(path.join(staging, 'restore.sh'), 0o755)

    // ---- 5) 打包 ----
    const out = path.resolve(args.out)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    console.log(`[5/5] 打包 → ${out}${args.noCompress ? '（不压缩）' : '（gzip）'} ...`)
    const tarArgs = args.noCompress ? ['-cf', out, '-C', stagingParent, bundleName] : ['-czf', out, '-C', stagingParent, bundleName]
    const r = spawnSync('tar', tarArgs, { stdio: ['ignore', 'inherit', 'inherit'] })
    if (r.status !== 0) throw new Error(`tar 失败（exit=${r.status}）${r.error ? '：' + r.error.message : ''}`)
    if (!fs.existsSync(out)) throw new Error('tar 未生成产物')

    const outBytes = fs.statSync(out).size
    const rawBytes = components.reduce((s, c) => s + c.bytes, 0) + wsStat.bytes
    const sha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')
    console.log('')
    console.log('='.repeat(66))
    console.log(`产物      : ${out}`)
    console.log(`大小      : ${mb(outBytes)}（原始数据 ${mb(rawBytes)}${args.noCompress ? '' : `，gzip 后节省 ${(100 - (outBytes / rawBytes) * 100).toFixed(1)}%`}）`)
    console.log(`SHA256    : ${sha}`)
    console.log(`包含      : 会话 ${sessionStats.migrated + sessionStats.unchanged} 文件 / 状态 ${components.length - 1} 项 / 工作区 ${wsStat.files} 文件`)
    if (skippedSessions.length) console.log(`未包含    : ${skippedSessions.length} 个会话文件（cwd 无映射，清单里有逐条原因）`)
    console.log(`耗时      : ${((Date.now() - t0) / 1000).toFixed(1)} 秒`)
    console.log('')
    console.log('下一步（在 Linux 主机上）：')
    console.log(`  1. 传过去：scp ${path.basename(out)} <用户>@<主机>:/tmp/`)
    console.log(`  2. 校验：  sha256sum /tmp/${path.basename(out)}   # 应等于上面的 SHA256`)
    console.log(`  3. 解压：  tar -xzf /tmp/${path.basename(out)} -C /tmp/`)
    console.log(`  4. 先装配运行时：sudo bash /opt/dsh-remote/deploy/linux/setup.sh`)
    console.log(`  5. 再导入数据：  sudo bash /tmp/${bundleName}/restore.sh`)
    console.log('='.repeat(66))
  } else {
    console.log('\n（dry-run 结束，未生成产物）')
    console.log(`  预计包含：会话 ${sessionStats.migrated + sessionStats.unchanged} 文件｜状态 ${components.length - 1} 项｜工作区 ${wsStat.files} 文件 / ${mb(wsStat.bytes)}`)
  }

  // 清理暂存（保留时告知路径）
  if (args.dryRun) {
    if (!args.staging) fs.rmSync(stagingParent, { recursive: true, force: true })
  } else if (args.keepStaging) {
    console.log(`\n暂存目录已保留：${staging}`)
  } else {
    fs.rmSync(staging, { recursive: true, force: true })
    if (!args.staging) fs.rmSync(stagingParent, { recursive: true, force: true })
  }
}

// 生成还原脚本：在 Linux 上把数据搬到目标位置 + 权限归一化 + 自检对账
function restoreScript(o) {
  const bucketList = o.buckets.map((b) => `  echo "    ${b}"`).join('\n')
  return `#!/usr/bin/env bash
# 由 tools/export-for-linux.mjs 生成 —— 把迁移包导入 Linux 目标位置。
#
# 前置：先跑过 deploy/linux/setup.sh（它建好服务用户、目录与 /etc/dsh-remote.env）
# 用法：sudo bash restore.sh
set -euo pipefail

TARGET_DSH_HOME="\${TARGET_DSH_HOME:-${o.targetDshHome}}"
TARGET_WORKSPACE="\${TARGET_WORKSPACE:-${o.targetWorkspace}}"
SERVICE_USER="\${SERVICE_USER:-dsh}"
EXPECT_SESSIONS=${o.sessionFiles}
EXPECT_WORKSPACE_FILES=${o.workspaceFiles}
SOURCE_SESSION_FILES=${o.sourceSessionFiles}
SKIPPED_SESSIONS=${o.skippedSessions}

HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
log() { printf '\\033[36m[restore]\\033[0m %s\\n' "$*"; }
die() { printf '\\033[31m[restore] %s\\033[0m\\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash restore.sh）"
[[ -d "$TARGET_DSH_HOME" ]] || die "目标 DSH_HOME 不存在：$TARGET_DSH_HOME（请先跑 deploy/linux/setup.sh）"
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "服务用户不存在：$SERVICE_USER（请先跑 deploy/linux/setup.sh）"

# 1) 会话：目标已存在则先整目录留档（不删除，由你确认后再清理）
if [[ -d "$TARGET_DSH_HOME/sessions" && -n "$(ls -A "$TARGET_DSH_HOME/sessions" 2>/dev/null)" ]]; then
  BAK="$TARGET_DSH_HOME/sessions.pre-restore-$(date +%Y%m%d-%H%M%S)"
  log "目标已有会话，先留档到 $BAK"
  mv "$TARGET_DSH_HOME/sessions" "$BAK"
fi
log "导入会话 ..."
mkdir -p "$TARGET_DSH_HOME"
cp -a "$HERE/dsh-home/sessions" "$TARGET_DSH_HOME/sessions"

# 2) 其余状态（users / workspaces / storages / settings.yaml）
for item in users workspaces storages; do
  [[ -d "$HERE/dsh-home/$item" ]] || continue
  log "导入 $item/ ..."
  mkdir -p "$TARGET_DSH_HOME/$item"
  cp -a "$HERE/dsh-home/$item/." "$TARGET_DSH_HOME/$item/"
done
[[ -f "$HERE/dsh-home/settings.yaml" ]] && { log "导入 settings.yaml ..."; cp -a "$HERE/dsh-home/settings.yaml" "$TARGET_DSH_HOME/settings.yaml"; }

# 3) 凭据（仅当导出时显式包含；否则由 setup.sh 生成的模板继续生效）
if [[ -f "$HERE/dsh-home/.credentials.yaml" ]]; then
  log "导入 .credentials.yaml（权限将收紧为 600）"
  cp -a "$HERE/dsh-home/.credentials.yaml" "$TARGET_DSH_HOME/.credentials.yaml"
fi

# 4) 工作区
log "导入工作区 ..."
mkdir -p "$TARGET_WORKSPACE"
cp -a "$HERE/workspace/." "$TARGET_WORKSPACE/"

# 5) 权限归一化（tar 在 Windows 上记录的权限位偏宽，且内核要求凭据属主专属）
log "归一化权限与属主 ..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$TARGET_DSH_HOME" "$TARGET_WORKSPACE"
chmod -R u+rwX,go-w "$TARGET_DSH_HOME" "$TARGET_WORKSPACE" 2>/dev/null || true
[[ -f "$TARGET_DSH_HOME/.credentials.yaml" ]] && chmod 600 "$TARGET_DSH_HOME/.credentials.yaml"

# 6) 自检对账
log "自检 ..."
got_sessions=$(find "$TARGET_DSH_HOME/sessions" -type f -name 'session*.jsonl.zstd' | wc -l)
got_ws=$(find "$TARGET_WORKSPACE" -type f | wc -l)
echo "  会话文件: $got_sessions （期望 $EXPECT_SESSIONS）"
echo "  工作区文件: $got_ws （期望 $EXPECT_WORKSPACE_FILES）"
echo "  会话桶:"
${bucketList}

[[ "$got_sessions" -eq "$EXPECT_SESSIONS" ]] || die "会话文件数不符：期望 $EXPECT_SESSIONS，实际 $got_sessions"
if [[ "$SKIPPED_SESSIONS" -gt 0 ]]; then
  echo ""
  echo "  注意：源端共 $SOURCE_SESSION_FILES 个会话文件，其中 $SKIPPED_SESSIONS 个因 cwd 无映射未随包"
  echo "        （原因见 MANIFEST.json 的 sessions.skipped）"
fi
# 工作区文件数允许因权限/竞态略有出入，只告警不中断
[[ "$got_ws" -eq "$EXPECT_WORKSPACE_FILES" ]] || echo "  ⚠ 工作区文件数与清单不一致（期望 $EXPECT_WORKSPACE_FILES，实际 $got_ws），请核对"

echo ""
log "完成。下一步："
echo "  sudo systemctl restart dsh-kernel dsh-remote"
echo "  然后按 Linux 迁移计划 §验收清单 逐项确认（旧会话能列出并打开、记忆可查）"
`
}

try {
  main()
} catch (e) {
  console.error(`\n导出失败：${e.message}`)
  process.exit(1)
}
