// 仓库级「密钥闸门」守卫（2026-09-27）
//
// 用途：把"仓库里有没有硬编码凭据"从**人工翻代码**变成**可复跑的清单**。
//   · 默认扫 **工作树**（受 git 跟踪的文件，含未提交改动）；
//   · `--history` 另扫 **全部历史**（只看新增行）—— 用于回答"某个密钥是否已经进过历史"。
//
// 🔴 两条硬约束（本工具存在的理由）：
//   ① **输出永不泄漏秘密** —— 只打印 `文件:行号 + 规则名 + 键名 + 长度/字符类别指纹`，
//      **绝不打印值的任何片段**（哪怕是前 12 个字符）。
//   ② **有命中必须让退出码非零** —— 否则这闸门只是"打印了一行字"，CI 里等于没有。
//   📌 隔壁仓 `deepseek-harness-shell/repo-secret-gate.mjs` 这两点都不满足（它用 `slice(0,12)`
//      打出了值的开头，且无论命中多少都 `exit 0`）⇒ 本文件是**同名能力的修正版**，不是它的复制。
//
// 退出码：0 = 干净；1 = 有高置信命中（输出即待办清单）；2 = 用法 / 环境错误
//
// 用法：
//   node tools/scan-secrets.mjs                                    # 扫工作树
//   node tools/scan-secrets.mjs --history                          # 另扫全部历史
//   node tools/scan-secrets.mjs --history -- plugins/email-bridge  # 缩到指定路径
//   node tools/scan-secrets.mjs --json                             # 机器可读
//   node tools/scan-secrets.mjs --root=<仓库根>                    # 改扫另一个检出（默认：本工具所在仓库）
//
// ── 判据分三层（**先定"什么不算命中"，再定"什么算"**）──────────────────────
//   ⛔ **一律不算命中**（否则闸门会"永远红"、等于失效）：
//      · **占位符 / 合成串**：`your_…` / `xxx` / `changeme` / 单字符重复 / `${…}` 开头 /
//        含 `EXAMPLE`（AWS 官方示例键就是 `AKIA…EXAMPLE`）/ `SYNTHETIC-NOT-A-REAL…`；
//      · **代码片段而非字面量**：值里**含空白或引号外拼接**（如 `` `Bearer ${token}` ``、
//        `"$(grep … | head -1)"`）⇒ 真凭据是**单个无空白的 token**，据此判；
//      · **测试 / 自测 / 文档路径**里的「键=长字面量」（见下）—— 夹具与引用文合法。
//   📌 **A 层（任何位置都判失败）**：形态明确的密钥 —— `sk-` / `ghp_` / `AKIA` / 私钥块 /
//      `Bearer <长串>` / `xox?-`。
//   📌 **B 层（仅在非测试/文档路径判失败）**：「凭据键名 = 单个无空白长字面量」（值 ≥ 8 字符）。
//      这条是**启发式**，天然会有夹具误报 ⇒ 用路径分层把它压到"只在产品/脚本代码里才响"。
//   📌 **豁免标记**（对齐本仓 `linux-ready-exempt` 的"可审计棘轮"惯例）：行内标
//      `secret-scan-exempt: <原因≥6字>` 即跳过，并在汇总里**单独报出条数**（豁免要可审计）。
//   📌 **仅提示（I 层，从不失败）**：`.credentials.yaml` 这类**路径引用** —— 本仓到处都在引用它。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const WITH_HISTORY = argv.includes('--history')
const rootArg = argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : resolve(HERE, '..')
const sepAt = argv.indexOf('--')
const PATHS = sepAt >= 0 ? argv.slice(sepAt + 1) : []
const KNOWN = new Set(['--json', '--history', '--'])
const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN.has(a) && !a.startsWith('--root='))
if (unknown.length) {
  console.error('用法错误：未知选项 ' + unknown.join(' '))
  console.error('用法：node tools/scan-secrets.mjs [--history] [--json] [--root=<仓库根>] [-- <路径>...]')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// git 包装（把"属主不一致"这类环境错误变成一句能照做的提示）
// ---------------------------------------------------------------------------
function gitSafe(args) {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || '')
    if (/dubious ownership/i.test(msg)) {
      console.error('环境错误：git 认为仓库属主与当前用户不一致，拒绝读取。')
      console.error('  请用**仓库属主**身份运行本工具（不要为此改全局 git 配置）。')
    } else {
      console.error('环境错误：git 调用失败 —— ' + msg.split('\n')[0])
    }
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// 规则集
// ---------------------------------------------------------------------------
// A 层：形态明确，任何位置都判失败。`valueGroup` 给出"要判定占位符与指纹"的捕获组。
const RULES_A = [
  { id: 'S1', label: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'S2', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'S3', label: 'AWS AccessKey', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'S4', label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'S5', label: 'Bearer token', re: /\bBearer\s+([A-Za-z0-9\-._~+/]{30,})/g, valueGroup: 1 },
  { id: 'S6', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
]

// B 层：启发式（"凭据键名 = 长字面量"），只在非测试/文档路径判失败
const RULES_B = [
  {
    id: 'S7',
    label: '凭据键赋值（值为长字面量）',
    re: /(pass|passwd|password|secret|token|apikey|api_key|access_key|credential|auth_code|authorization)\s*[:=]\s*(['"`])((?:\\.|(?!\2).){8,})\2/gi,
    valueGroup: 3,
    keyGroup: 1,
  },
]

// I 层：仅提示，从不失败
const INFO_RULES = [{ id: 'I1', label: '凭据文件引用（提示）', re: /\.credentials\.ya?ml/g }]

const EXEMPT_RE = /secret-scan-exempt:\s*\S{6,}/

// 占位符 / 合成串
const PLACEHOLDER =
  /^(your|xxx+|-{2,}|\.{3}|changeme|change_me|placeholder|example|sample|dummy|fake|todo|none|null|undefined|redacted|masked|omitted|<[^>]*>|\$\{)/i
const SYNTHETIC = /SYNTHETIC-NOT-A-REAL|NOT-A-REAL-CREDENTIAL|EXAMPLE/i

// 真凭据是**单个无空白的 token**；含空白/换行的一律是代码片段或自然语言
const SINGLE_TOKEN = /^[A-Za-z0-9_\-./+=:@%~]{8,}$/

function isBenign(v) {
  const s = String(v ?? '')
  if (PLACEHOLDER.test(s)) return true
  if (SYNTHETIC.test(s)) return true
  if (/^(.)\1{7,}$/.test(s)) return true // xxxxxxxx / 00000000 / --------
  return false
}

// 测试 / 自测 / 夹具 / 文档路径：B 层在这里降级为提示
const FIXTURE_DIR_RE = /(^|\/)(tests?|__tests__|fixtures?|selftest|selfcheck|specs?)\//i
const FIXTURE_NAME_RE = /(test|spec|fixture|selftest|selfcheck|e2e|verify|probe|smoke|sample|demo|mock)/i
function isFixturePath(p) {
  const flat = String(p).replace(/\\/g, '/')
  if (FIXTURE_DIR_RE.test(flat)) return true
  if (/\.md$/i.test(flat) || /^docs\//i.test(flat)) return true
  return FIXTURE_NAME_RE.test(basename(flat))
}

// 值的**无泄漏指纹**：长度 + 字符类别。绝不回显值本身。
function fingerprint(v) {
  const s = String(v)
  const cls = []
  if (/[a-z]/.test(s)) cls.push('a-z')
  if (/[A-Z]/.test(s)) cls.push('A-Z')
  if (/[0-9]/.test(s)) cls.push('0-9')
  if (/[^a-zA-Z0-9]/.test(s)) cls.push('符号')
  return `len=${s.length} 类别=[${cls.join(',')}]`
}

/**
 * 扫一行。`fixture` = 该行所在文件是否属测试/文档路径。
 * 返回 'exempt' | 'hit' | 'info' | null
 */
function scanLine(line, ctx, emit) {
  if (EXEMPT_RE.test(line)) {
    emit({ kind: 'exempt', rule: 'X', label: '人工豁免', where: ctx.where, key: null, fingerprint: null })
    return
  }
  for (const r of RULES_A) {
    r.re.lastIndex = 0
    let m
    while ((m = r.re.exec(line))) {
      const value = r.valueGroup ? m[r.valueGroup] : m[0]
      if (isBenign(value)) continue
      emit({ kind: 'hit', rule: r.id, label: r.label, where: ctx.where, key: null, fingerprint: fingerprint(value) })
    }
  }
  for (const r of RULES_B) {
    r.re.lastIndex = 0
    let m
    while ((m = r.re.exec(line))) {
      const value = m[r.valueGroup]
      if (isBenign(value)) continue
      // 只认"单个无空白 token"：排除 `Bearer ${token}`、`"$(grep … | head -1)"` 这类代码片段
      if (!SINGLE_TOKEN.test(value)) continue
      emit({
        kind: ctx.fixture ? 'info' : 'hit',
        rule: r.id,
        label: ctx.fixture ? r.label + '（测试/文档路径，不计失败）' : r.label,
        where: ctx.where,
        key: m[r.keyGroup],
        fingerprint: fingerprint(value),
      })
    }
  }
  for (const r of INFO_RULES) {
    r.re.lastIndex = 0
    if (r.re.test(line)) {
      emit({ kind: 'info', rule: r.id, label: r.label, where: ctx.where, key: null, fingerprint: null })
    }
  }
}

const looksBinary = (text) => text.slice(0, 8192).includes('\u0000')

// ---------------------------------------------------------------------------
// ① 工作树
// ---------------------------------------------------------------------------
function scanWorktree() {
  const out = gitSafe(['ls-files', '-z', ...(PATHS.length ? ['--', ...PATHS] : [])])
  const files = out.split('\0').filter(Boolean)
  const findings = []
  let scanned = 0
  for (const f of files) {
    let text
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8')
    } catch {
      continue // 已删除 / 不可读 / 子模块目录
    }
    if (looksBinary(text)) continue
    scanned++
    const fixture = isFixturePath(f)
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      scanLine(lines[i], { where: `${f}:${i + 1}`, fixture }, (d) => findings.push(d))
    }
  }
  return { scope: '工作树', scanned, findings }
}

// ---------------------------------------------------------------------------
// ② 历史（只看新增行）
// ---------------------------------------------------------------------------
function scanHistory() {
  // ⚠️ 标记串必须与 diff 的 hunk 头（`@@ -0,0 +1 @@`）**开头不同** —— 否则会把 hunk 头当成提交号。
  const MARK = '@@COMMIT@@'
  const args = ['log', '--all', '--no-color', '--no-renames', '--unified=0', `--format=${MARK}%H`]
  args.push('-p', ...(PATHS.length ? ['--', ...PATHS] : []))
  const out = gitSafe(args)
  const findings = []
  let commit = '?'
  let file = '?'
  let scanned = 0
  for (const raw of out.split('\n')) {
    if (raw.startsWith(MARK)) {
      commit = raw.slice(MARK.length, MARK.length + 12)
      continue
    }
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '')
      continue
    }
    if (raw[0] !== '+') continue
    const line = raw.slice(1)
    if (looksBinary(line)) continue
    scanned++
    const fixture = isFixturePath(file)
    scanLine(line, { where: `${file} @${commit}`, fixture }, (d) => findings.push(d))
  }
  return { scope: '历史（新增行）', scanned, findings }
}

// ---------------------------------------------------------------------------
// 跑 + 报告
// ---------------------------------------------------------------------------
const reports = [scanWorktree()]
if (WITH_HISTORY) reports.push(scanHistory())

const all = reports.flatMap((r) => r.findings)
const hits = all.filter((f) => f.kind === 'hit')
const infos = all.filter((f) => f.kind === 'info')
const exempts = all.filter((f) => f.kind === 'exempt')

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        hits,
        infos,
        exempts,
        reports: reports.map((r) => ({ scope: r.scope, scanned: r.scanned })),
      },
      null,
      2
    )
  )
} else {
  for (const r of reports) {
    console.log(`-- ${r.scope}：已扫 ${r.scanned} 行/文件 --`)
    if (!r.findings.length) console.log('PASS 无命中')
    for (const f of r.findings) {
      const tag = f.kind === 'hit' ? 'HIT ' : f.kind === 'exempt' ? 'SKIP' : 'INFO'
      const key = f.key ? ` 键=${f.key}` : ''
      const fp = f.fingerprint ? ` 值指纹=${f.fingerprint}` : ''
      console.log(`${tag} [${f.rule} ${f.label}] ${f.where}${key}${fp}`)
    }
  }
  console.log('')
  console.log(
    `高置信命中 ${hits.length} 处（计入失败）；提示 ${infos.length} 处；人工豁免 ${exempts.length} 处`
  )
  console.log('（以上输出已全程掩码：只给长度与字符类别，未打印任何值片段）')
  if (!hits.length && (infos.length || exempts.length)) {
    console.log('⇒ 退出码 0：命中项均属"测试/文档"或"人工已豁免"。')
  }
}

process.exit(hits.length ? 1 : 0)
