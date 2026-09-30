// @local/dsh-adapter —— 跨平台路径配置自检
//
// 目的：验证 Windows / Linux 共用同一份 dsh-bundle-patch.yml 的机制——
//   ${VAR} / ${VAR:-默认值} 展开、POSIX 上残留 Windows 根的告警、诊断日志路径推导，
//   以及"登记根 + 相对引用"的拼接（POSIX 前导斜杠必须保留，否则绝对路径会退化成相对路径）。
// 不依赖宿主 runtime 与任何第三方包，两个平台均可直接跑。
// 用法：node test/selfcheck-paths.mjs        退出码 0=全通过

import { expandVars, expandRoots, resolveAdapterLogPath } from '../lib/index.js'
import { AdapterFsImpl } from '../lib/fs.js'
import { resolve, join } from 'node:path'

let pass = 0, fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
function eq(name, actual, expect) {
  ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect))
}

// ---- 环境变量现场保护（本脚本会改写，结束时还原）----
const KEYS = ['DSH_WORKSPACE_ROOT', 'DSH_ADAPTER_LOG', 'DSH_HOME']
const saved = {}
for (const k of KEYS) saved[k] = process.env[k]
function restore() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

// ============ [5] 登记根 + 相对引用的拼接（POSIX 前导斜杠必须保留）============
// 早期实现 split('/') → 丢空串 → join('/')：Windows 盘符首段非空所以没事，
// POSIX 的前导 '/' 会被丢掉 → 绝对路径退化成相对路径 → 宿主按 cwd 解析到别处。
// 这里用一个只记录入参的假 fs，直接断言"交给宿主 fs 的路径字符串"。

console.log('\n=== [5] 根内相对引用拼接 ===')

function spyFs() {
  const calls = []
  return {
    calls,
    fs: { resolve: (p) => { calls.push(p); return { targetKey: p, displayPath: p } } },
  }
}

const implFor = (roots, defaultDataRoot) => {
  const s = spyFs()
  return { s, impl: new AdapterFsImpl({ fs: s.fs, sandboxPolicy: {}, config: { roots, defaultDataRoot } }) }
}

{
  const { s, impl } = implFor({ R: '/srv/dsh-workspace/全局数据' }, 'R')
  eq('5a POSIX 绝对根：前导斜杠必须保留',
    (await impl.resolve('R', 'memory-system/memory.json')).displayPath,
    '/srv/dsh-workspace/全局数据/memory-system/memory.json')

  const { impl: impl2 } = implFor({ R: '/srv/dsh-workspace' }, 'R')
  eq('5b POSIX 深一层',
    (await impl2.resolve('R', 'a/b/c.json')).displayPath,
    '/srv/dsh-workspace/a/b/c.json')

  // 根的尾部斜杠要被吃掉，不能产生 '//'
  const { impl: impl3 } = implFor({ R: '/srv/dsh-workspace/' }, 'R')
  eq('5c 根尾斜杠规范化',
    (await impl3.resolve('R', 'x.json')).displayPath,
    '/srv/dsh-workspace/x.json')
}

{
  const { impl } = implFor({ R: 'E:\\DSH工作区' }, 'R')
  eq('5d Windows 盘符根（行为与改造前一致）',
    (await impl.resolve('R', '全局数据\\x.json')).displayPath,
    'E:/DSH工作区/全局数据/x.json')
}

{
  const { impl } = implFor({ R: '\\\\server\\share' }, 'R')
  eq('5e UNC 根前缀保留',
    (await impl.resolve('R', 'x.json')).displayPath,
    '//server/share/x.json')
}

{
  const { impl } = implFor({ R: '/srv/dsh-workspace' }, 'R')
  const esc = async (rel) => {
    try { await impl.resolve('R', rel); return 'NO-THROW' }
    catch (e) { return e && e.code }
  }
  eq('5f .. 逃逸被拦截', await esc('../outside.json'), 'BAD_ARG')
  eq('5g 深层 .. 逃逸被拦截', await esc('a/../../outside.json'), 'BAD_ARG')
  eq('5h 根内 .. 允许', (await impl.resolve('R', 'a/../b.json')).displayPath, '/srv/dsh-workspace/b.json')
  eq('5i 单点与空段被忽略', (await impl.resolve('R', './a//b.json')).displayPath, '/srv/dsh-workspace/a/b.json')
}

// [5j] 默认根回退链必须认 POSIX 绝对路径（不能只认盘符，否则 Linux 上会错锚到 cwd）
{
  const savedWs = process.env.DSH_WORKSPACE
  process.env.DSH_WORKSPACE = '/srv/dsh-workspace'
  const { impl } = implFor({ R: '/srv/dsh-workspace' }, '')
  eq('5j defaultDataRoot 声明为空 + DSH_WORKSPACE 为 POSIX 绝对路径 → 采用它',
    (await impl.resolveRef('x.json')).displayPath, '/srv/dsh-workspace/x.json')
  if (savedWs === undefined) delete process.env.DSH_WORKSPACE
  else process.env.DSH_WORKSPACE = savedWs
}

// 与 dsh-bundle-patch.yml 里实际书写的字面量保持一致
const WIN_DEFAULT = 'E:/DSH工作区'
const ROOT_TEMPLATE = '${DSH_WORKSPACE_ROOT:-' + WIN_DEFAULT + '}/全局数据'

console.log('\n=== [1] ${VAR:-默认值} 展开 ===')

delete process.env.DSH_WORKSPACE_ROOT
eq('1a 未设环境变量 → 取默认值（Windows 行为与拆分前一致）',
  expandVars(ROOT_TEMPLATE), WIN_DEFAULT + '/全局数据')

process.env.DSH_WORKSPACE_ROOT = '/srv/dsh-workspace'
eq('1b 设了环境变量 → 用环境变量（Linux 由 setup.sh 注入）',
  expandVars(ROOT_TEMPLATE), '/srv/dsh-workspace/全局数据')

process.env.DSH_WORKSPACE_ROOT = '/srv/dsh-workspace/'
eq('1c 环境变量带尾斜杠 → 原样使用（由 fs 层做路径规范化）',
  expandVars(ROOT_TEMPLATE), '/srv/dsh-workspace//全局数据')

process.env.DSH_WORKSPACE_ROOT = ''
eq('1d 环境变量为空串 → 视同未设置，回退默认值（避免拼出 "/全局数据"）',
  expandVars(ROOT_TEMPLATE), WIN_DEFAULT + '/全局数据')

process.env.DSH_WORKSPACE_ROOT = 'relative-root'
eq('1e 相对路径也照样代入（不在此处做绝对性校验）',
  expandVars(ROOT_TEMPLATE), 'relative-root/全局数据')

console.log('\n=== [2] 无默认值的占位与边界 ===')

delete process.env.DSH_NOT_SET_XYZ
eq('2a ${VAR} 无默认且未设 → 原样保留（宁可显式可见，不静默清空成 "/a"）',
  expandVars('${DSH_NOT_SET_XYZ}/a'), '${DSH_NOT_SET_XYZ}/a')

process.env.DSH_NOT_SET_XYZ = 'X'
eq('2b ${VAR} 无默认且已设 → 代入', expandVars('${DSH_NOT_SET_XYZ}/a'), 'X/a')
delete process.env.DSH_NOT_SET_XYZ

eq('2c 无占位符的字符串原样返回', expandVars('E:/DSH工作区/全局数据'), 'E:/DSH工作区/全局数据')
eq('2d 非字符串原样返回（数字）', expandVars(123), 123)
eq('2e 非字符串原样返回（undefined）', expandVars(undefined), undefined)
eq('2f 一段里多个占位符全部展开',
  (() => { process.env.A_A = '1'; process.env.B_B = '2'; const r = expandVars('${A_A}-${B_B}-${C_C:-3}'); delete process.env.A_A; delete process.env.B_B; return r })(),
  '1-2-3')

console.log('\n=== [3] expandRoots：平台体检告警 ===')

const PATHS = {
  写作训练: '${DSH_WORKSPACE_ROOT:-' + WIN_DEFAULT + '}/写作训练',
  全局数据: ROOT_TEMPLATE,
}

// 3a: 未设 DSH_WORKSPACE_ROOT → 根落到 Windows 路径
delete process.env.DSH_WORKSPACE_ROOT
let warns = []
let out = expandRoots(PATHS, (m) => warns.push(m))
eq('3a-1 根表值完成展开（未设变量 → Windows 默认）', out.全局数据, WIN_DEFAULT + '/全局数据')
if (process.platform === 'win32') {
  eq('3a-2 win32：Windows 路径属正常，不告警', warns.length, 0)
} else {
  eq('3a-2 posix：残留 Windows 路径 → 每个根各告警一条', warns.length, 2)
  ok('3a-3 告警文案点明变量名与根名', warns.every((m) => m.includes('DSH_WORKSPACE_ROOT') && m.includes('root[')), warns[0])
  eq('3a-4 告警不改变根表（仍保留原值，不丢根）', Object.keys(out).length, 2)
}

// 3b: 设了 DSH_WORKSPACE_ROOT → 不再有 Windows 路径告警
process.env.DSH_WORKSPACE_ROOT = '/srv/dsh-workspace'
warns = []
out = expandRoots(PATHS, (m) => warns.push(m))
eq('3b-1 根表值换成 POSIX 根', out.写作训练, '/srv/dsh-workspace/写作训练')
eq('3b-2 无告警', warns.length, 0)

// 3c: 边界输入不应抛错
warns = []
eq('3c-1 空根表 → 返回空对象', Object.keys(expandRoots({}, (m) => warns.push(m))).length, 0)
eq('3c-2 根表为 undefined → 返回空对象', Object.keys(expandRoots(undefined, () => {})).length, 0)
eq('3c-3 根值为非字符串 → 原样保留且不抛错', expandRoots({ a: 7 }, () => {}).a, 7)

console.log('\n=== [4] 诊断日志路径推导 ===')
// 断言走 path.resolve/join 计算期望值：'/srv/...' 这类 POSIX 字面量在 win32 上会被
// 解析成 C:\srv\...，硬写字符串会让本用例只在 Linux 通过。这里断言的是"推导规则"。
const flat = (p) => p.replace(/\\/g, '/')

process.env.DSH_ADAPTER_LOG = '/var/log/adapter.log'
eq('4a DSH_ADAPTER_LOG 优先', flat(resolveAdapterLogPath()), flat(resolve('/var/log/adapter.log')))

delete process.env.DSH_ADAPTER_LOG
process.env.DSH_HOME = '/srv/dsh-home'
eq('4b 无显式变量 → <DSH_HOME>/dsh-adapter-apply.log',
  flat(resolveAdapterLogPath()), flat(join(resolve('/srv/dsh-home'), 'dsh-adapter-apply.log')))

delete process.env.DSH_HOME
ok('4c 两者都缺 → 落在 cwd 下（不抛错）',
  /dsh-adapter-apply\.log$/.test(resolveAdapterLogPath().replace(/\\/g, '/')), resolveAdapterLogPath())
ok('4d 返回值始终是绝对路径', resolveAdapterLogPath().length > 'dsh-adapter-apply.log'.length)

restore()

console.log('\n' + '='.repeat(60))
console.log('pass=' + pass + ' fail=' + fail)
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1) }
console.log('全部通过')
