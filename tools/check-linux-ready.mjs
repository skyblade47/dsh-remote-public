// 仓库级 Linux 化守卫（2026-09-22）
//
// 用途：把"插件跨平台化"从**印象**变成**可复跑的清单**——
//   ① 扫描 plugins/*/{lib,client}/**/*.js 里残留的 Windows 专有依赖，逐条点名 file:line 与原因；
//   ② 对已抽出的平台路径推导函数做**双平台断言**（不是"看代码觉得对"）。
// 退出码：0 = 全部已 Linux 化；1 = 仍有残留（输出即为待办清单）。
//
// 用法：node tools/check-linux-ready.mjs
//
// 判据与豁免（对齐本仓既有 `discipline-exempt` 的"可审计棘轮"惯例）：
//   · 只看**非注释**代码行（注释里说明"原写死 E:\\..."是正常的，不应报警）；
//   · 有意保留的 Windows 历史默认值，须在该行标 `// linux-ready-exempt: <原因≥6字>`；
//   · `*.yml` 配置里的 `${DSH_WORKSPACE_ROOT:-E:/DSH工作区}` 属**设计内的**双平台写法，不扫。

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PLUGINS = join(ROOT, 'plugins')

const flat = (p) => String(p).replace(/\\/g, '/')

let failures = 0
const check = (cond, label, got, want) => {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}

// ---------------------------------------------------------------------------
// 规则集：Windows 专有依赖
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: 'W1', label: 'Windows 盘符绝对路径',
    re: /(^|[^A-Za-z0-9_])([A-Za-z]):[\\/]/,
    why: '硬编码盘符（如 E:/DSH工作区、C:/Users/<user> Linux 上必然失效；应改走工作区根/DSH_HOME 派生',
  },
  {
    id: 'W2', label: 'Windows 专有目录或可执行文件',
    re: /nvm4w|Windows[\\/]Temp|AppData[\\/]Local|node\.exe/i,
    why: 'Windows 专有路径；Linux 上应分别用 process.execPath / os.tmpdir() / 环境派生的数据目录',
  },
  {
    id: 'W3', label: 'Windows 专有进程管理',
    re: /\btaskkill\b|\btasklist\b|Get-CimInstance|Stop-Process|Get-Process|Win32_Process|\bpowershell\b/i,
    why: 'PowerShell/CIM 查进程与杀进程在 Linux 上不存在；需跨平台实现（见 email-bridge 待办）',
  },
  {
    id: 'W4', label: 'Windows 便携版安装路径',
    re: /DeepSeek-Harness-\d/i,
    why: '指向 Windows 便携版安装目录；应改由 DSH_HOME 派生',
  },
]

/** 去掉注释（保留字符串内容——要找的路径就在字符串里；保留换行以对齐行号） */
function stripComments(src) {
  let out = ''
  let i = 0
  let inBlock = false
  let inLine = false
  let inStr = null
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (inLine) {
      if (c === '\n') { inLine = false; out += c } else out += ' '
      i++
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; out += '  '; i += 2; continue }
      out += (c === '\n' ? c : ' ')
      i++
      continue
    }
    if (inStr) {
      if (c === '\\') { out += c + (n || ''); i += 2; continue }
      if (c === inStr) inStr = null
      out += c
      i++
      continue
    }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i += 2; continue }
    if (c === '/' && n === '*') { inBlock = true; out += '  '; i += 2; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue }
    out += c
    i++
  }
  return out
}

// URL scheme 先剥掉，避免把 `http://`、`file://` 误判成盘符（`p:` + `//`）
const stripScheme = (line) => line.replace(/\b(https?|file|ftp|wss?|node|data|blob):/gi, '')

const MARKER_RE = /\/\/\s*linux-ready-exempt\s*:\s*(.+)$/

function collectFiles(dir, acc) {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch (_) { return acc }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '_backup' || e.name.charAt(0) === '.') continue
      collectFiles(p, acc)
    } else if (e.isFile() && e.name.endsWith('.js')) {
      acc.push(p)
    }
  }
  return acc
}

// ---------------------------------------------------------------------------
// ① 源码扫描
// ---------------------------------------------------------------------------
console.log('== ① 扫描 plugins/*/{lib,client} 的 Windows 专有依赖 ==')
const findings = []
const exempted = []
let scannedFiles = 0

let pluginDirs = []
try {
  pluginDirs = readdirSync(PLUGINS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.charAt(0) !== '_' && e.name.charAt(0) !== '.')
    .map((e) => e.name)
    .sort()
} catch (e) {
  console.log('  plugins 目录不可读：' + String(e && e.message || e))
}

for (const plugin of pluginDirs) {
  const files = []
  for (const sub of ['lib', 'client']) {
    const d = join(PLUGINS, plugin, sub)
    try { if (statSync(d).isDirectory()) collectFiles(d, files) } catch (_) {}
  }
  if (!files.length) continue
  for (const f of files) {
    const rel = flat(f.slice(ROOT.length + 1))
    let src = ''
    try { src = readFileSync(f, 'utf8') } catch (_) { continue }
    scannedFiles++
    const stripped = stripComments(src)
    const rawLines = src.split(/\r?\n/)
    const codeLines = stripped.split(/\r?\n/)
    codeLines.forEach((code, idx) => {
      const line = stripScheme(code)
      if (!line.trim()) return
      for (const r of RULES) {
        if (!r.re.test(line)) continue
        const n = idx + 1
        const mk = MARKER_RE.exec(rawLines[idx] || '')
        if (mk && String(mk[1]).trim().length >= 6) {
          exempted.push({ file: rel, line: n, rule: r.id, reason: String(mk[1]).trim() })
          return
        }
        findings.push({ plugin, file: rel, line: n, rule: r.id, label: r.label, why: r.why, text: (rawLines[idx] || '').trim().slice(0, 140) })
      }
    })
  }
}

console.log('  受扫文件=' + scannedFiles + ' 豁免行=' + exempted.length + ' 命中=' + findings.length)
for (const e of exempted) console.log('  EXEMPT  ' + e.file + ':' + e.line + '  [' + e.rule + ']  ' + e.reason)

if (findings.length) {
  console.log('\n  —— 待处理（按插件分组）——')
  const byPlugin = {}
  for (const f of findings) (byPlugin[f.plugin] = byPlugin[f.plugin] || []).push(f)
  for (const p of Object.keys(byPlugin).sort()) {
    console.log('  [' + p + ']  ' + byPlugin[p].length + ' 处')
    for (const f of byPlugin[p]) console.log('    ' + f.rule + ' ' + f.file + ':' + f.line + '  ' + f.label + '\n        ' + f.text)
  }
}
check(findings.length === 0, '① 无 Windows 专有依赖残留（豁免 ' + exempted.length + ' 行为有意保留）', findings.length, 0)

// ---------------------------------------------------------------------------
// ② 平台路径推导的双平台断言（真断言，不是"看代码觉得对"）
// ---------------------------------------------------------------------------
console.log('\n== ② 平台路径推导：Windows 默认 / Linux 注入 / 显式覆盖 三态断言 ==')

// writing-coach：.credentials.yaml
try {
  const wc = await import(new URL('../plugins/writing-coach/lib/paths.js', import.meta.url))
  const noExists = () => false
  const home = flat(wc.resolveCredentialsPath({ DSH_HOME: '/srv/dsh-home' }, '/tmp/x', noExists))
  const over = flat(wc.resolveCredentialsPath({ DSH_CREDENTIALS_FILE: '/etc/dsh/cred.yaml' }, '/tmp/x', noExists))
  const appdata = flat(wc.resolveCredentialsPath({ APPDATA: 'C:/Users/<user>/AppData/Roaming' }, 'C:/work', noExists))
  const cwdData = flat(wc.resolveCredentialsPath({}, '/work', (p) => flat(p) === '/work/dsh-data'))
  check(home === '/srv/dsh-home/.credentials.yaml', '② -b writing-coach：DSH_HOME 派生', home, '/srv/dsh-home/.credentials.yaml')
  check(over === '/etc/dsh/cred.yaml', '② -b writing-coach：DSH_CREDENTIALS_FILE 可整体覆盖', over, '/etc/dsh/cred.yaml')
  check(appdata === 'C:/Users/<user>/AppData/Roaming/dsh/dsh-data/.credentials.yaml',
    '② -b writing-coach：Windows 不设 DSH_HOME 时＝APPDATA 派生（行为与历史一致）',
    appdata, 'C:/Users/<user>/AppData/Roaming/dsh/dsh-data/.credentials.yaml')
  check(cwdData === '/work/dsh-data/.credentials.yaml', '② -b writing-coach：<cwd>/dsh-data 存在时优先', cwdData, '/work/dsh-data/.credentials.yaml')
} catch (e) {
  check(false, '② -b writing-coach 路径推导可 import 并断言', String(e && e.message || e), 'ok')
}

// ---------------------------------------------------------------------------
console.log('')
console.log('LINUX_READY failures=' + failures + ' windowsDeps=' + findings.length)
process.exitCode = failures === 0 ? 0 : 1
