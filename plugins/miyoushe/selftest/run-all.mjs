// @local/miyoushe —— 离线核心切片 自测总入口
// 运行：node selftest/run-all.mjs      （退出码 0 = 全过）
// 说明：全部用 `node` 直调库函数，**不加载插件、不接线、不联网、不碰真实 全局数据/miyoushe/**。
//
// t11（**F1 修复**）：套件输出改为「父进程捕获后再回显」，并在汇总里对失败套件打印**原因尾部**。
//   修复前用 stdio:'inherit' ⇒ 套件崩溃（未捕获异常 / 语法错误）时汇总只有 `exit=1`，看不到原因。
//   受限环境若禁止管道捕获（EPERM），自动退回 inherit 并在汇总里**显式说明**"原因需回看上方输出"。

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAIL_LINES = 12

// **显式注册表**：新套件必须登记在此，否则视为异常（防"写了自测却忘了注册 ⇒ 静默不跑"）
const SUITES = [
  'ds.vectors.mjs',
  'store.degraded.mjs',
  'exit.lossless.mjs',
  'gate.mjs',
  'version.mjs',
  'scheduler.mjs',
  'actions.mjs',
  'assert-source-discipline.mjs',
  'mys-http.mjs',
  'sign_path.mjs',
]

const found = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs').sort()
const unregistered = found.filter((f) => !SUITES.includes(f))
const missing = SUITES.filter((f) => !found.includes(f))

const tailOf = (lines, n) => lines.slice(Math.max(0, lines.length - n))

console.log('miyoushe offline-core-1 selftest: ' + SUITES.length + ' suites（注册表）')
console.log('node ' + process.version + ' / cwd ' + process.cwd())
if (unregistered.length) console.log('WARN 目录中存在**未登记**套件（不会运行）：' + unregistered.join(', '))
if (missing.length) console.log('WARN 登记表中有**缺失**套件：' + missing.join(', '))

const results = []
for (const f of SUITES) {
  if (!found.includes(f)) {
    results.push({ file: f, code: -1, signal: null, tail: ['(登记套件文件缺失)'], tailUnavailable: false, captureNote: null })
    continue
  }
  console.log('\n=== ' + f + ' ===')
  let r = spawnSync(process.execPath, [join(HERE, f)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let tailUnavailable = false
  let captureNote = null
  let combined = []
  if (r.error) {
    // 受限环境可能禁止"管道捕获子进程输出"（EPERM）：退回继承式 stdio，输出仍可见但汇总拿不到尾因
    captureNote = 'capture failed: ' + (r.error.code || r.error.message)
    r = spawnSync(process.execPath, [join(HERE, f)], { stdio: 'inherit' })
    tailUnavailable = true
  } else {
    const out = r.stdout || ''
    const err = r.stderr || ''
    if (out) process.stdout.write(out)
    if (err) process.stdout.write('--- stderr ---\n' + err)
    combined = (out + (err ? '\n--- stderr ---\n' + err : '')).split(/\r?\n/).filter((l) => l.length > 0)
  }
  results.push({
    file: f,
    code: r.status === null ? -1 : r.status,
    signal: r.signal || null,
    tail: tailOf(combined, TAIL_LINES),
    tailUnavailable,
    captureNote,
  })
}

console.log('\n== 汇总 ==')
let failed = 0
for (const r of results) {
  const ok = r.code === 0
  console.log((ok ? 'PASS ' : 'FAIL ') + r.file + ' exit=' + r.code + (r.signal ? ' signal=' + r.signal : '') + (r.captureNote ? ' [' + r.captureNote + ']' : ''))
  if (ok) continue
  failed++
  if (r.tailUnavailable) {
    console.log('  原因：本环境禁止管道捕获子进程输出（已退回 inherit）⇒ 请回看上方该套件的原始 stderr')
  } else if (r.tail.length === 0) {
    console.log('  原因：套件无任何 stdout/stderr 输出（仅以退出码 ' + r.code + ' 失败）')
  } else {
    console.log('  原因（尾部 ' + TAIL_LINES + ' 行）：')
    for (const l of r.tail) console.log('    | ' + l)
  }
}
if (unregistered.length || missing.length) failed++
console.log('SUITES total=' + results.length + ' failed=' + failed
  + (unregistered.length ? ' unregistered=' + unregistered.length : '')
  + (missing.length ? ' missing=' + missing.length : ''))
process.exitCode = failed === 0 ? 0 : 1
