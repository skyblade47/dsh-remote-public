// @local/memory-system —— 诊断日志路径自检（不依赖宿主 runtime，Windows/Linux 均可跑）
//
// 背景：工具注册失败日志的落点原本硬编码 Windows 便携版路径，迁到 Linux 后
// appendFileSync 必然失败且被 catch 吞掉 —— 而这段日志存在的意义正是
// "logger 常为 undefined，注册失败会零痕迹"，路径写死等于把痕迹又抹掉。
// 本自检守住三件事：不改本机行为、Linux 上落到 DSH_HOME、显式变量优先。
// 用法：node test/selfcheck-log-path.mjs        退出码 0=全通过

import { resolve, join } from 'node:path'
import { resolveMemoryLogPath } from '../lib/index.js'

let pass = 0, fail = 0
const failures = []
function eq(name, actual, expect) {
  if (actual === expect) { pass++; console.log('  ✅ ' + name + '  → ' + actual) }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + '\n      actual=' + actual + '\n      expect=' + expect) }
}

// 断言走 path.resolve/join 计算期望值：'/srv/...' 这类 POSIX 字面量在 win32 上会被解析成
// C:\srv\...，硬写字符串会让用例只在 Linux 通过。这里断言的是"推导规则"。
const flat = (p) => p.replace(/\\/g, '/')

const KEYS = ['DSH_MEMORY_LOG', 'DSH_HOME']
const saved = {}
for (const k of KEYS) saved[k] = process.env[k]
const restore = () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

console.log('\n=== memory-system 工具注册失败日志的落点 ===')

// 1) Windows 本机：应与修复前的硬编码路径逐字一致（无行为回归）
const WIN_HOME = 'E:/DeepSeek-Harness-1.0.0-portable/dsh-data'
process.env.DSH_HOME = WIN_HOME
delete process.env.DSH_MEMORY_LOG
eq('1 无显式变量 → <DSH_HOME>/memory-tool-register.log',
  flat(resolveMemoryLogPath()),
  flat(join(resolve(WIN_HOME), 'memory-tool-register.log')))
eq('1b 本机（win32）与修复前的硬编码路径一致',
  flat(resolveMemoryLogPath()).endsWith('/dsh-data/memory-tool-register.log'), true)

// 2) Linux：落在 DSH_HOME 下（旧实现在此必然写失败）
process.env.DSH_HOME = '/srv/dsh-home'
eq('2 Linux 风格 DSH_HOME → 落在 DSH_HOME 下',
  flat(resolveMemoryLogPath()),
  flat(join(resolve('/srv/dsh-home'), 'memory-tool-register.log')))

// 3) 显式变量优先
process.env.DSH_MEMORY_LOG = '/var/log/mem.log'
eq('3 DSH_MEMORY_LOG 优先', flat(resolveMemoryLogPath()), flat(resolve('/var/log/mem.log')))

// 4) 都没有 → 落 cwd，仍不抛错
delete process.env.DSH_MEMORY_LOG
delete process.env.DSH_HOME
eq('4 两者都缺 → 落到 cwd（不抛错）',
  flat(resolveMemoryLogPath()).endsWith('/memory-tool-register.log'), true)

// 5) 环境变量为空串视同未设置（避免落到空路径）
process.env.DSH_MEMORY_LOG = ''
process.env.DSH_HOME = '/srv/dsh-home'
eq('5 空串视同未设置，回退 DSH_HOME',
  flat(resolveMemoryLogPath()),
  flat(join(resolve('/srv/dsh-home'), 'memory-tool-register.log')))

restore()

console.log('\n' + '='.repeat(60))
console.log('pass=' + pass + ' fail=' + fail)
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1) }
console.log('全部通过')
