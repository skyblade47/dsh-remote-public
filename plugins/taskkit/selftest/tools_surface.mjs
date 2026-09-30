// @local/taskkit —— t81/C 启动期工具面自检 + t81/B 动态包 timer 判据 单测
// 运行：node selftest/tools_surface.mjs      （退出码 0 = 全过）
// 说明：全部为**纯函数口径**（注入 registered/declared/prefixes），不加载插件、不接线、不联网、不写任何数据。

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  checkToolSurface, collectDeclaredToolNames,
  TOOL_SURFACE_PREFIXES, DYNAMIC_PLUGIN_TIMER_RULE,
  convergeToolSurface, toolSurfaceVerdict, TOOL_SURFACE_CONVERGENCE, RETIRED_TOOL_PREFIXES,
} from '../lib/index.js'

let failures = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
const show = (l, o) => console.log('  ' + l + ' => ' + JSON.stringify(o))
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

console.log('== C1 checkToolSurface：纯函数语义 ==')
{
  const r = checkToolSurface({ registered: ['a', 'b', 'c'], declared: ['a', 'b', 'c'], prefixes: ['a', 'b'] })
  check(r.ok === true && r.missing.length === 0 && r.emptyGroups.length === 0, 'C1 齐全 ⇒ ok:true / missing 空 / emptyGroups 空', r, '<ok>')
  check(r.registeredCount === 3 && r.declaredCount === 3, 'C1 计数正确', [r.registeredCount, r.declaredCount], [3, 3])

  const r2 = checkToolSurface({ registered: ['a', 'c'], declared: ['a', 'b', 'c'], prefixes: ['a'] })
  check(r2.ok === false && JSON.stringify(r2.missing) === '["b"]', 'C1 声明了但未注册 ⇒ ok:false 且 missing 点名', r2.missing, ['b'])

  const r3 = checkToolSurface({ registered: ['x_1'], declared: [], prefixes: ['x_', 'y_'] })
  check(r3.ok === false && JSON.stringify(r3.emptyGroups) === '["y_"]', 'C1 前缀组为空 ⇒ emptyGroups 点名', r3.emptyGroups, ['y_'])

  const r4 = checkToolSurface({ registered: ['a', 'a', 'a'], declared: ['a', 'a'], prefixes: [] })
  check(r4.registeredCount === 1 && r4.declaredCount === 1, 'C1 去重（同一名字重复出现只算一次）', [r4.registeredCount, r4.declaredCount], [1, 1])

  const r5 = checkToolSurface({})
  check(r5.ok === true && r5.registeredCount === 0, 'C1 空入参不抛错（fail-safe：不误报）', r5.ok, true)

  const r6 = checkToolSurface({ registered: ['tsk_list'], declared: ['tsk_list'], prefixes: ['tsk_'] })
  check(r6.ok === true, 'C1 前缀匹配按 startsWith（tsk_ 组被 tsk_list 满足）', r6.emptyGroups, [])
}

console.log('\n== C2 期望集合来源①：静态扫描兄弟插件源码（可复核、自维护） ==')
{
  const declared = collectDeclaredToolNames(PLUGIN_ROOT)
  show('declared 数量', declared.length)
  check(declared.length >= 50, 'C2 扫描到 >=50 个工具名（宽口径；窄口径实测仅 7）', declared.length, '>=50')
  for (const n of ['tsk_list', 'tsk_dispatch', 'miyoushe_sign', 'memory_load', 'kb_search', 'prompt_route', 'skill_list', 'wrpro_ping', 'writing_studio_ping']) {
    check(declared.includes(n), 'C2 期望集合含 ' + n, declared.includes(n), true)
  }
  check(new Set(declared).size === declared.length, 'C2 已去重', new Set(declared).size, declared.length)
  check(declared.every((n) => /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(n)), 'C2 全部符合工具名形状（含下划线；证明不是随手抓的普通字符串）', declared.filter((n) => !/^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(n)), '[]')
}

console.log('\n== C3 告警演示：注入"期望集合缺项" ⇒ 真的判 WARN（而不是"如果缺就会告警"） ==')
{
  const declared = collectDeclaredToolNames(PLUGIN_ROOT)
  // ⚠️ `declared` 只来自 `静态化/*/lib` ⇒ **不含**宿主内建（read/write/…）与 `cordis_*`/`agent_teams_*`；
  //    所以"registered＝declared"并不是"齐全场景"（那会让这些前缀组判空）。要构造齐全基线，
  //    必须为**未被声明覆盖的前缀组**各补一个代表项 —— 这正好演示了为什么前缀组检查是必需的。
  const reps = TOOL_SURFACE_PREFIXES
    .filter((p) => !declared.some((n) => n === p || n.indexOf(p) === 0))
    .map((p) => p + '__probe')
  const full = declared.concat(reps)
  show('未被「声明源」覆盖的前缀组（由前缀组检查兜住）', reps)
  check(reps.length >= 3 && reps.some((x) => x.indexOf('read') === 0) && reps.some((x) => x.indexOf('cordis_') === 0), 'C3 声明源不覆盖内建/cordis_/agent_teams_ ⇒ 必须靠前缀组检查兜住', reps, '<含 read__probe / cordis___probe 等>')
  const base = checkToolSurface({ registered: full, declared, prefixes: TOOL_SURFACE_PREFIXES })
  check(base.ok === true, 'C3 基线（补齐所有前缀组）⇒ ok:true，不误报', base.ok, true)

  // 演示 1：摘掉两个已声明的工具（模拟某插件注册失败）
  const drop = ['tsk_list', 'memory_search']
  const s1 = checkToolSurface({ registered: full.filter((n) => !drop.includes(n)), declared, prefixes: TOOL_SURFACE_PREFIXES })
  show('去掉 ' + JSON.stringify(drop) + ' 后', { ok: s1.ok, missing: s1.missing })
  check(s1.ok === false && JSON.stringify(s1.missing) === JSON.stringify(['memory_search', 'tsk_list']), 'C3 演示1 ⇒ ok:false 且 missing 精确点名两个工具（告警真的出现）', s1.missing, drop.slice().sort())

  // 演示 2：整个 tsk_ 前缀组消失（模拟 taskkit 未注册任何工具）
  const s2 = checkToolSurface({ registered: full.filter((n) => !n.startsWith('tsk_')), declared, prefixes: TOOL_SURFACE_PREFIXES })
  show('去掉全部 tsk_ 后', { ok: s2.ok, emptyGroups: s2.emptyGroups, missingN: s2.missing.length })
  check(s2.ok === false && JSON.stringify(s2.emptyGroups) === '["tsk_"]', 'C3 演示2 ⇒ emptyGroups 恰为 tsk_（整组消失可被发现）', s2.emptyGroups, ['tsk_'])
  check(s2.missing.length === declared.filter((n) => n.startsWith('tsk_')).length, 'C3 演示2 ⇒ missing 列出该组全部工具名', s2.missing.length, declared.filter((n) => n.startsWith('tsk_')).length)
}

console.log('\n== C4 boot 钩子实际会写的那条审计行（WARN 文案） ==')
{
  const declared = collectDeclaredToolNames(PLUGIN_ROOT)
  const full = declared.concat(TOOL_SURFACE_PREFIXES.filter((p) => !declared.some((n) => n === p || n.indexOf(p) === 0)).map((p) => p + '__probe'))
  const s = checkToolSurface({ registered: full.filter((n) => n !== 'tsk_list'), declared, prefixes: TOOL_SURFACE_PREFIXES })
  const line = 'WARN | tool surface INCOMPLETE: registered=' + s.registeredCount + ' declared=' + s.declaredCount + ' missing=[' + s.missing.join(',') + '] emptyGroups=[' + s.emptyGroups.join(',') + ']'
  show('审计行（event=tools.surface.check）', line)
  check(line.indexOf('missing=[tsk_list]') >= 0, 'C4 WARN 文案含具体缺项名（可据此立即定位）', line.indexOf('missing=[tsk_list]') >= 0, true)
}

console.log('\n== C5 收敛检查（t83 修复时序假警报）：假警报必须消失，真缺失仍须 WARN ==')
{
  const prefixes = ['read', 'tsk_', 'mem_', 'cordis_']
  const declared = ['tsk_a', 'tsk_b', 'mem_c']
  const FULL = ['read_file', 'tsk_a', 'tsk_b', 'mem_c', 'cordis_x']

  // 假 tools 服务：按**采样次序**推进的"启动时间序"，复刻实测到的中间态
  const mkTools = (schedule) => {
    let i = 0
    return { view: () => ({ knownNames: new Set(schedule[Math.min(i, schedule.length - 1)]) }), tick: () => { i++ } }
  }
  const run = (schedule, tuned) => {
    const tools = mkTools(schedule)
    let t = 0
    return convergeToolSurface({
      toolsSvc: tools, declared, prefixes,
      tuning: Object.assign({ startDelayMs: 0, intervalMs: 10, stableSamples: 2, maxWaitMs: 1000 }, tuned || {}),
      now: () => t,
      sleep: async () => { t += 10; tools.tick() },
    })
  }

  // (1) 真实启动形状：早期只有部分工具、连内建组都还空 → 随后补齐并稳定
  const growThenSettle = [
    ['tsk_a', 'tsk_b'],                       // 早期：别的插件/内建层尚未挂完
    ['tsk_a', 'tsk_b', 'mem_c'],
    ['read_file', 'tsk_a', 'tsk_b', 'mem_c'],
    FULL, FULL, FULL, FULL,
  ]
  const r1 = await run(growThenSettle)
  const v1 = toolSurfaceVerdict(r1)
  check(r1.ok === true && r1.converged === true, 'C5-a 起步缺项、随后补齐 ⇒ 收敛后 ok:true', { ok: r1.ok, converged: r1.converged }, { ok: true, converged: true })
  check(v1.level === 'INFO' && v1.kind === 'ok', 'C5-a 判 INFO（时序假警报消失：不再每启动一条 WARN）', v1, { level: 'INFO', kind: 'ok' })
  check(r1.trajectory.length >= 3, 'C5-b 留下收敛轨迹（多次采样）', r1.trajectory.length, '>=3')
  check(r1.trajectory[0].reg < r1.trajectory[r1.trajectory.length - 1].reg,
    'C5-b 轨迹首尾 registered 递增 ⇒ 可证"当时确实还在挂载"（时间序因果支撑）',
    r1.trajectory.map((x) => x.reg), '<首<尾>')
  check(r1.trajectory[0].empty > 0, 'C5-b 首采样记录了空组（与现场一致：read/tsk_ 当时为空）', r1.trajectory[0].empty, '>0')
  show('C5 轨迹(t, reg, miss, empty)', r1.trajectory)

  // (2) 真缺失：声明了 tsk_b 但它**始终**不出现 ⇒ 收敛后必须 WARN
  const r2 = await run(growThenSettle.map((s) => s.filter((n) => n !== 'tsk_b')))
  const v2 = toolSurfaceVerdict(r2)
  check(r2.ok === false && r2.converged === true, 'C5-c 收敛后仍缺 ⇒ ok:false 且 converged:true', { ok: r2.ok, converged: r2.converged }, { ok: false, converged: true })
  check(v2.level === 'WARN' && v2.kind === 'incomplete', 'C5-c 判 WARN（真警报仍能触发，而非"如果缺就会告警"）', v2, { level: 'WARN', kind: 'incomplete' })
  check(JSON.stringify(r2.missing) === '["tsk_b"]', 'C5-c missing 精确点名缺项', r2.missing, ['tsk_b'])

  // (3) 持续增长且**仍缺** ⇒ 未收敛：拒绝在"无法区分"时喊狼来了
  //     注意必须同时"缺一项"：若一直增长但已经齐全（ok:true），那本就该判 INFO/ok，与收敛无关。
  const everGrowing = Array.from({ length: 300 }, (_, i) =>
    FULL.filter((n) => n !== 'tsk_b').concat(Array.from({ length: i }, (_, k) => 'x_' + k)))
  const r3 = await run(everGrowing)
  const v3 = toolSurfaceVerdict(r3)
  check(r3.converged === false, 'C5-d 持续增长 ⇒ converged:false', r3.converged, false)
  check(v3.level === 'INFO' && v3.kind === 'not-converged', 'C5-d 未收敛判 INFO + not-converged（不 WARN）', v3, { level: 'INFO', kind: 'not-converged' })
  check(r3.waitedMs >= 1000, 'C5-d 到硬上限即出结论（有界，不无限等）', r3.waitedMs, '>=1000')

  // (4) tools 一直为空 ⇒ 不得把"服务没就绪"误判成"收敛且干净"（否则是拿假绿灯换假警报）
  const r4 = await run([[]])
  check(r4.converged === false, 'C5-e tools 一直为空 ⇒ 不判收敛', r4.converged, false)

  // (5) tools 服务缺失：不抛错，且如实把声明项全报为缺（fail-safe：宁可报缺，不静默通过）
  const r5 = await convergeToolSurface({
    toolsSvc: null, declared, prefixes,
    tuning: { startDelayMs: 0, intervalMs: 1, stableSamples: 1, maxWaitMs: 1 },
    now: (() => { let t = 0; return () => (t += 5) })(), sleep: async () => {},
  })
  check(r5.missing.length === declared.length && r5.ok === false, 'C5-f tools 服务为 null：不抛错、如实报缺', { missing: r5.missing.length, ok: r5.ok }, { missing: 3, ok: false })
  check(TOOL_SURFACE_CONVERGENCE.stableSamples >= 2 && TOOL_SURFACE_CONVERGENCE.maxWaitMs > 0,
    'C5-g 默认参数形状（stableSamples>=2 且 maxWaitMs 有界）',
    { s: TOOL_SURFACE_CONVERGENCE.stableSamples, m: TOOL_SURFACE_CONVERGENCE.maxWaitMs }, { s: '>=2', m: '>0' })
}

console.log('\n== C6 退役前缀组（防止"永远为空 ⇒ 恒定 WARN"） ==')
{
  check(!TOOL_SURFACE_PREFIXES.includes('sandbox_'),
    'C6 sandbox_ 已从覆盖清单移除（该组会永远为空 ⇒ 恒定假警报）',
    TOOL_SURFACE_PREFIXES.includes('sandbox_'), false)
  check(Array.isArray(RETIRED_TOOL_PREFIXES) && RETIRED_TOOL_PREFIXES.some((r) => r.prefix === 'sandbox_'),
    'C6 退役组仍留痕（可查"为什么消失"，而非静默删掉）', RETIRED_TOOL_PREFIXES.length, '>=1')
  check(!TOOL_SURFACE_PREFIXES.includes('hotplug_'),
    'C6 未加 hotplug_ 组（其声明不在 静态化/*/lib，加进来会引入新的时序依赖）',
    TOOL_SURFACE_PREFIXES.includes('hotplug_'), false)
}

console.log('\n== B 动态包 timer 预防判据（常量形状） ==')
{
  const R = DYNAMIC_PLUGIN_TIMER_RULE
  check(typeof R.rule === 'string' && R.rule.indexOf('动态包') >= 0 && R.rule.indexOf('禁用 Node timer') >= 0, 'B 条文含「动态包」+「禁用 Node timer」', R.rule.slice(0, 40), '<含>')
  check(R.requiredInject === 'timer' && JSON.stringify(R.allowedApi) === '["ctx.timeout","ctx.interval"]', 'B 正解＝inject:[\'timer\'] + ctx.timeout/ctx.interval', R.allowedApi, ['ctx.timeout', 'ctx.interval'])
  check(JSON.stringify(R.bannedGlobals) === '["setTimeout","setInterval","setImmediate"]', 'B 禁用清单＝Node 全局 timer 三者', R.bannedGlobals, ['setTimeout', 'setInterval', 'setImmediate'])
  check(Array.isArray(R.seeAlso) && R.seeAlso.length >= 2, 'B 交叉引用既有同族条目（加固不新增）', R.seeAlso, '<>=2>')
}

console.log('\nTOOLS_SURFACE failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
