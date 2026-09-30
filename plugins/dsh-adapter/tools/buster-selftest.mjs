#!/usr/bin/env node
// @local/dsh-adapter —— ModuleGraphBuster 的**跨版本矩阵自检**（M5 / N6 的交付物）
//
// 为什么需要它：buster 的能力取决于宿主 Node 有没有模块钩子 API，而**这套能力是热拔插的命门**——
// 不可用时必须是"**明确拒绝 + 说清原因**"（L3），绝不能"报成功但代码没换"。
// 本脚本可以在任意 Node 版本下直接跑（无依赖、只 import 本包 lib）：
//
//   node plugins/dsh-adapter/tools/buster-selftest.mjs            # 人读格式
//   node plugins/dsh-adapter/tools/buster-selftest.mjs --json     # 机器格式
//
// 退出码：0 = 结论与该版本**应有的结论**一致；1 = 不一致（真问题）；2 = 脚本自身出错。
//
// ⚠️ **判据不是硬编码版本号**，而是"宿主能力 ⇒ 应有结论"的推导 + 自洽性：
//    硬编码 `if (major >= 22)` 这种写法在 Node 24/26 上会立刻失效（本项目吃过"版本号写死"的亏）。
//    故这里断言三条与版本无关的性质：
//      ① `mode` 必须等于"按可用 API 推导出的那一种"
//      ② `level === L1` **当且仅当** 自检项全过（不许出现"全过却报 L3"或"没过却报 L1"）
//      ③ 只要落到 L3，`reason` 必须非空**且**不是那句 `self-test ok`
//    另外 `mode === none`（两个 API 都没有）时，reason 必须点明"两个 API 都不可用"，
//    并说明该升级到哪个版本 —— 这正是 M5 要求的"不可用版本走 L3 且**诊断明确**"。

import * as nodeModule from 'node:module'
import { ModuleGraphBuster, BusterLevel, BusterMode } from '../lib/hotplug/buster.js'

const WANT_JSON = process.argv.includes('--json')

/** 按宿主**能力**推导该有的结论（不写版本号，避免将来失效） */
function expectedMode() {
  if (typeof nodeModule.registerHooks === 'function') {
    return { mode: BusterMode.REGISTER_HOOKS, why: '有 registerHooks（同线程同步钩子，Node 22.15+）' }
  }
  if (typeof nodeModule.register === 'function') {
    return { mode: BusterMode.REGISTER_PORT, why: '只有 register（跨线程钩子，Node 20.6–22.14）' }
  }
  return { mode: BusterMode.NONE, why: '两个模块钩子 API 都没有（Node < 20.6）' }
}

/** 自检项全集（与 buster.selftest() 里的 checks 一一对应；少写一个就会让判据②失真） */
const CHECK_KEYS = [
  'sameGenCached', 'bumpNewInstance', 'bumpAgainNewInstance', 'genDistinct',
  'outsideUntouched', 'nodeModulesUntouched', 'loadRecorded', 'revComputed',
]

/** 统一的收尾：**不能用 `process.exit()` 立刻退** ——
 *  管道（非 TTY）下 stdout 是**异步写**，立刻 exit 会把还没 flush 的输出吞掉
 *  （真机矩阵上实测：Node 18/20 的结论行整段消失，只剩退出码）。
 *  做法：设 `exitCode` 让进程自然退出；再挂一个 **unref 的**安全定时器 ——
 *  若 register+port 模式有未 unref 的端口/钩子线程把事件循环吊住，才由它兜底强退。
 */
function finish(code) {
  if (keepAlive) clearInterval(keepAlive)
  process.exitCode = code
  setTimeout(() => process.exit(code), 1500).unref()
}

/** ★撑住事件循环：register+port 模式的 `_request` 超时定时器是 `unref()` 的
 *  （见 lib/hotplug/buster.js `_request`）。在没有别的活的进程里（比如本脚本），
 *  事件循环会在超时**之前**就空掉 ⇒ **进程直接退出，await 链被抛弃** ——
 *  表现为"退出码 0、却一行输出都没有"（真机矩阵上实测：Node 18/20 整段结论消失）。
 *  生产内核里另有大量任务撑着循环，所以那里表现为"3 秒超时后继续"。 */
let keepAlive = null
const holdLoop = () => { keepAlive = setInterval(() => {}, 250) }

async function main() {
  holdLoop()
  const exp = expectedMode()
  const buster = new ModuleGraphBuster({ log: () => {} })
  const st = await buster.init()

  const checks = st.checks || {}
  const noHooks = st.mode === BusterMode.NONE
  // 没有钩子 API 时自检根本不会跑，`checks` 天然是空的 —— 这时**不该**要求 8 个自检项
  // （否则会把"正确地走了 L3"误报成"脚本与实现不同步"；真机矩阵上踩到过）。
  const missing = noHooks ? [] : CHECK_KEYS.filter((k) => !(k in checks))
  const allChecksTrue = !noHooks && CHECK_KEYS.every((k) => checks[k] === true)
  const anyCheckFalse = !noHooks && CHECK_KEYS.some((k) => checks[k] !== true)

  const problems = []
  // ① mode 与能力推导一致
  if (st.mode !== exp.mode) problems.push('mode 应为 ' + exp.mode + '，实际 ' + st.mode)
  // ② level 与自检项自洽
  if (st.level === BusterLevel.L1 && !allChecksTrue) {
    problems.push('报了 L1 但自检项没全过（"报成功却可能没换码"，最危险的一种）: ' + JSON.stringify(checks))
  }
  if (st.level === BusterLevel.L3 && !anyCheckFalse && st.mode !== BusterMode.NONE) {
    problems.push('自检项全过却报 L3（判据过严，会白白禁用热替）: ' + JSON.stringify(checks))
  }
  // ③ 落 L3 必须给了原因，且不许是那句成功文案
  if (st.level === BusterLevel.L3) {
    if (!st.reason || st.reason === 'self-test ok') problems.push('L3 却没有可用的 reason')
  }
  // ④ 无任何钩子 API 时，诊断必须**说清怎么办**（M5 的"诊断明确"）
  if (st.mode === BusterMode.NONE) {
    const r = st.reason || ''
    if (!/registerHooks/.test(r) || !/register/.test(r)) {
      problems.push('mode=none 的 reason 没有同时点名 registerHooks 与 register: ' + JSON.stringify(st.reason))
    }
    // 只说"不支持"没用，得说清该升到哪个版本（否则运维不知道下一步做什么）
    if (!/2[02]\.\d+/.test(r)) {
      problems.push('mode=none 的 reason 没有给出所需的 Node 版本（诊断不够明确）: ' + JSON.stringify(st.reason))
    }
  }
  if (missing.length) problems.push('自检项缺失（脚本与实现不同步）: ' + missing.join(','))

  const ok = problems.length === 0
  const out = {
    ok,
    node: process.versions.node,
    expected: { mode: exp.mode, why: exp.why },
    actual: { mode: st.mode, level: st.level, reason: st.reason, checks, missing },
    problems,
  }

  if (WANT_JSON) {
    console.log(JSON.stringify(out, null, 2))
    return finish(ok ? 0 : 1)
  }

  const mark = (b) => (b ? '✅' : '❌')
  console.log('Node ' + process.versions.node)
  console.log('  期望：mode=' + exp.mode + '   （依据：' + exp.why + '）')
  console.log('  实测：mode=' + st.mode + '  level=' + st.level)
  console.log('  原因：' + st.reason)
  if (st.mode !== BusterMode.NONE) {
    const line = CHECK_KEYS.map((k) => (checks[k] ? '+' : '-') + k.replace(/[A-Z]/g, (m) => m.toLowerCase())).join(' ')
    console.log('  自检：' + line)
  }
  console.log('  ' + mark(ok) + (ok ? ' 结论正确' : ' 结论异常：' + problems.join(' | ')))
  return finish(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('自检脚本自身出错: ' + String((e && e.stack) || e))
  finish(2)
})
