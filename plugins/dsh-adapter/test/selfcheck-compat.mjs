// @local/dsh-adapter 版本兼容层自检（2026-09-17）
// 运行：node test/selfcheck-compat.mjs（脱离宿主，直接跑探测与判定逻辑）
// 覆盖：宿主版本探测 / 能力探测不抛 / 兼容矩阵加载 / 推荐版本与已装版本比对 / 版本号比较器
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectHost, detectDshHome, installedPluginVersion } from '../lib/version.js'
import { loadMatrix, probeCapabilities, evaluateCompat, evaluate, compareVer, summaryLine, detectProfileRoot, satisfiesEngine, readLocalPluginEngines } from '../lib/compat.js'

let pass = 0, fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')) }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')) }
}

console.log('=== [1] 宿主版本探测 ===')
const host = detectHost({})
ok('探测到宿主版本（非 unknown）', host.version !== 'unknown', '→ ' + host.version + '（来源 ' + host.source + '）')
ok('宿主版本为语义化版本', /^\d+\.\d+\.\d+/.test(host.version), host.version)
const home = detectDshHome({})
ok('定位 DSH_HOME', !!home.path, (home.path || '-') + '（来源 ' + home.source + '）')
const profile = detectProfileRoot({})
ok('定位 profile 根', !!profile.path, (profile.path || '-') + '（来源 ' + profile.source + '）')

console.log('\n=== [2] 能力探测（脱离宿主 → 预期全部缺失且不抛）===')
const emptySvc = () => undefined
let capsThrew = null
let caps = null
try { caps = probeCapabilities(emptySvc) } catch (e) { capsThrew = e }
ok('探测不抛异常', !capsThrew, capsThrew ? String(capsThrew.message) : '')
ok('返回能力清单项', !!(caps && caps.items.length > 0), 'items=' + (caps ? caps.items.length : 0) + ' gaps=' + (caps ? caps.gaps.length : 0))
ok('空服务下语义代次为 unknown', caps && caps.subagentGeneration === 'unknown', caps && caps.subagentGeneration)

console.log('\n=== [3] 能力探测（模拟 rc.1 现代宿主）===')
const rc1Svc = (n) => {
  const table = {
    fs: { resolve() {}, stat() {}, readText() {}, writeText() {}, listDir() {}, sandboxMode: 'workspace-write' },
    sandboxPolicy: { resolve() { return { workspaceRoot: 'X' } } },
    webServer: { register() {} },
    tools: { register() {} },
    agents: { get() {}, resume() {}, create() {} },
    agentPresets: { resolve() {}, mount() {} },
    subagents: { registerProvider() {}, listChildren() {}, listDescendants() {} },  // rc.1 现代契约
    sessionQuery: { readSession() {}, readSurface() {}, listSessions() {} },
    sessionProjections: { register() {} },
    sessionProjectionCache: { cachedSnapshot() {} },
    // 活会话存储：list() 返回空数组 ⇒ 只验服务面（实例成员留待运行期，避免恒定假警报）
    sessions: { list() { return [] }, get() {} },
    workspaceRegistry: {},
  }
  return table[n]
}
const modern = probeCapabilities(rc1Svc)
ok('现代宿主下无能力缺口', modern.gaps.length === 0, 'gaps=' + modern.gaps.length + ' 语义=' + modern.subagentGeneration)
ok('语义代次判定为 modern(rc.1+)', modern.subagentGeneration === 'modern(rc.1+)', modern.subagentGeneration)

console.log('\n=== [4] 能力探测（模拟 alpha.x 旧宿主：只有 registerContinuableSetup）===')
const legacySvc = (n) => (n === 'subagents' ? { registerContinuableSetup() {} } : rc1Svc(n))
const legacy = probeCapabilities(legacySvc)
ok('识别旧语义代次 legacy(alpha.x)', legacy.subagentGeneration === 'legacy(alpha.x)', legacy.subagentGeneration)
const legacyGaps = legacy.gaps.map((g) => g.id)
ok('报告 registerProvider 缺口', legacyGaps.includes('subagents.registerProvider'), legacyGaps.join(','))

console.log('\n=== [4b] 活会话存储 / 子代理枚举探针（2026-09-22 新增，对应「不修改原生主体」硬约束）===')
const idsOf = (r) => r.items.map((i) => i.id)
const gapIdsOf = (r) => r.gaps.map((g) => g.id)
ok('能力清单已登记 sessions.live', idsOf(modern).includes('sessions.live'))
ok('能力清单已登记 sessionProjectionCache.cachedSnapshot', idsOf(modern).includes('sessionProjectionCache.cachedSnapshot'))
ok('能力清单已登记 subagents.listChildren', idsOf(modern).includes('subagents.listChildren'))
ok('能力清单已登记 subagents.listDescendants', idsOf(modern).includes('subagents.listDescendants'))

// 无样本（空闲宿主）⇒ 只验服务面，**不得**报缺口（否则就是恒定假警报）
const idleSessions = probeCapabilities((n) => (n === 'sessions' ? { list() { return [] }, get() {} } : undefined))
ok('空闲宿主（无活会话）不报 sessions.live 缺口', !gapIdsOf(idleSessions).includes('sessions.live'))

// 有样本但实例成员缺失 ⇒ 必须报缺口（真断链要被抓住）
const badMembers = probeCapabilities((n) => (n === 'sessions' ? { list() { return [{ id: 's' }] }, get() {} } : undefined))
ok('活会话对象缺 snapshotEvents/eventAt ⇒ 报 sessions.live 缺口', gapIdsOf(badMembers).includes('sessions.live'))

// 样本完整 ⇒ 不报缺口
const goodMembers = probeCapabilities((n) => (n === 'sessions'
  ? { list() { return [{ id: 's', snapshotEvents() { return [] }, eventAt() {} }] }, get() {} }
  : undefined))
ok('活会话对象成员完整 ⇒ 不报缺口', !gapIdsOf(goodMembers).includes('sessions.live'))

// list() 抛错 ⇒ 报缺口（服务在但坏了）
const throwingSessions = probeCapabilities((n) => (n === 'sessions' ? { list() { throw new Error('boom') }, get() {} } : undefined))
ok('sessions.list() 抛错 ⇒ 报 sessions.live 缺口', gapIdsOf(throwingSessions).includes('sessions.live'))

// 缺失时的 remedy 必须明确 fail-closed（门闸不许把"没查到"当"安全"）
const liveGap = (() => {
  const r = probeCapabilities(emptySvc)
  return r.gaps.find((g) => g.id === 'sessions.live')
})()
ok('sessions.live 缺失时 remedy 指明 fail-closed', !!(liveGap && /fail-closed/.test(liveGap.remedy)), liveGap ? liveGap.remedy.slice(0, 60) + '…' : '-')

// 子代理枚举：listChildren 缺失是 high 缺口；listDescendants 缺失**不计**（可选增强）
const noList = probeCapabilities((n) => (n === 'subagents' ? { registerProvider() {} } : rc1Svc(n)))
ok('缺 subagents.listChildren ⇒ 计入 high 缺口', noList.gaps.some((g) => g.id === 'subagents.listChildren' && g.severity === 'high'))
ok('缺 subagents.listDescendants ⇒ 不计入缺口（informational）', !gapIdsOf(noList).includes('subagents.listDescendants'))

console.log('\n=== [5] 兼容矩阵与推荐版本 ===')
const matrix = loadMatrix()
ok('矩阵可加载', !!matrix, matrix ? ('hosts=' + matrix.hosts.map((h) => h.host).join('/')) : '缺失')
const compat = evaluateCompat({ hostVersion: host.version })
ok('给出当前宿主的推荐配套', !!(compat.recommended && compat.recommended.plugins), compat.recommended ? compat.recommended.host + ' track=' + compat.recommended.track : '-')
console.log('     推荐: ' + (compat.recommended ? Object.entries(compat.recommended.plugins).map(([k, v]) => k + '@' + v).join('  ') : '-'))
console.log('     已装: ' + Object.entries(compat.installed).map(([k, v]) => k + '@' + (v || '未安装')).join('  '))
if (compat.versionWarnings.length) console.log('     版本提示:\n       - ' + compat.versionWarnings.join('\n       - '))
ok('推荐版本判定不抛且结构完整', !!(compat.host && compat.recommended && compat.installed), 'warnings=' + compat.versionWarnings.length)
// 交叉验证：0.1.5-rc.1 档应推荐 agent-teams 0.1.20（矩阵数据正确性；2026-09-23 由 0.1.19 升上来）
const c515 = evaluateCompat({ hostVersion: '0.1.5-rc.1', dshHome: detectDshHome({}).path })
ok('0.1.5-rc.1 档推荐 agent-teams=0.1.20', c515.recommended && c515.recommended.plugins['@nanmicoder/dsh-agent-teams'] === '0.1.20', c515.recommended && c515.recommended.plugins['@nanmicoder/dsh-agent-teams'])
// 同一档的 better-locale 必须仍是 0.4.1（0.4.2+ 的 peer 要求 ^0.1.5-rc.2，不含 rc.1）
ok('0.1.5-rc.1 档 better-locale 必须停在 0.4.1（最新版要 >=rc.2）',
  c515.recommended && c515.recommended.plugins['@huanlin/dsh-plugin-better-locale'] === '0.4.1',
  c515.recommended && c515.recommended.plugins['@huanlin/dsh-plugin-better-locale'])
// rc.3 是**现役宿主**（2026-09-27 首次真升级后实测通过：verify 全绿 / 白名单 15/15 / 冒烟 loaded=15 failed=0）
// 🔴 2026-09-27 断言反转：原用例断言 track==='avoid'，依据是"rc.3 依赖树嵌套 ⇒ 启动即 crash-loop"。
//    实测澄清：那是**混搭安装**（npm i -g rc.1 却解析到 rc.3 传递包）的失败模式；整包装配 rc.3 + 钉 npm-before 后实测可用 ⇒ 旧结论作废。
const m2 = loadMatrix()
const rc3 = m2 && m2.hosts.find((h) => h.host === '0.1.5-rc.3')
ok('矩阵已登记 0.1.5-rc.3 且标为 recommended-verified（现役宿主）', !!(rc3 && rc3.track === 'recommended-verified'), rc3 && rc3.track)
ok('rc.1 已不再是推荐档（被 rc.3 取代 ⇒ legacy-verified）',
  !!(m2 && m2.hosts.find((h) => h.host === '0.1.5-rc.1' && h.track === 'legacy-verified')))
ok('rc.3 档登记的是"已实测在跑"的第三方配套（不是最高可用）',
  !!(rc3 && rc3.plugins['@nanmicoder/dsh-agent-teams'] === '0.1.21' && rc3.plugins['@huanlin/dsh-plugin-better-locale'] === '0.4.3'
     && rc3.plugins['dsh-better-sidebar'] === '0.19.1'))
// 🔴 2026-09-27 晚：这两条从「可升级的更高版本」（写在 notes 里）变成「已实测在跑的那一组」——
//    WSL2 装配+冒烟全过 + 服务器上服务器重钉 + 内核重启后 loaded=14 failed=0 实测通过 ⇒ 矩阵随之更新。
ok('rc.3 档 agent-teams 已是 0.1.21（声明支持 rc.3 的版本）',
  !!(rc3 && rc3.plugins['@nanmicoder/dsh-agent-teams'] === '0.1.21'), rc3 && rc3.plugins['@nanmicoder/dsh-agent-teams'])
ok('rc.3 档 better-locale 已是 0.4.3（^0.1.5-rc.2 覆盖 rc.3）',
  !!(rc3 && rc3.plugins['@huanlin/dsh-plugin-better-locale'] === '0.4.3'), rc3 && rc3.plugins['@huanlin/dsh-plugin-better-locale'])
ok('rc.3 档 enginesDeclaredBy 记的是 0.1.21/0.4.3 的真实声明',
  !!(rc3 && rc3.enginesDeclaredBy['@nanmicoder/dsh-agent-teams'].includes('0.1.5-rc.3')
     && rc3.enginesDeclaredBy['@huanlin/dsh-plugin-better-locale'] === '^0.1.5-rc.2'))
ok('0.1.7-rc.2 前瞻档已登记（preview-unverified）', !!(m2 && m2.hosts.find((h) => h.host === '0.1.7-rc.2')))
ok('evidence.distTags.latest 与现役一致 = 0.1.5-rc.3', !!(m2 && m2.evidence && m2.evidence.hostDistTags.latest === '0.1.5-rc.3'))
ok('自研插件声明与矩阵口径一致 = 0.1.5-rc.3', !!(m2 && m2.localPlugins && m2.localPlugins.declared === '0.1.5-rc.3'))
// 传递依赖钉子必须登记在矩阵里（否则部署脚本的 --before 取值就没了依据来源）
ok('矩阵登记了 transitivePin.npmBefore', !!(m2 && m2.transitivePin && m2.transitivePin.npmBefore))
ok('矩阵登记了自研插件声明策略', !!(m2 && m2.localPlugins && m2.localPlugins.declared))
// 未知宿主 → 回退最近一档 + 告警
const cFuture = evaluateCompat({ hostVersion: '0.1.9-rc.1' })
ok('未知（未来）宿主版本回退最近档并告警', cFuture.versionWarnings.some((w) => w.indexOf('不在矩阵中') >= 0), cFuture.recommended && cFuture.recommended.host)

console.log('\n=== [6] 版本比较器 ===')
const cases = [['0.1.2-rc.1', '0.1.5-rc.1', -1], ['0.1.5-rc.2', '0.1.5-rc.1', 1], ['0.1.19', '0.1.15', 1], ['0.1.0', '0.1.0', 0], ['1.47.0', '1.41.0', 1]]
let cmpOk = true
for (const [a, b, want] of cases) { const got = compareVer(a, b); if (Math.sign(got) !== want) { cmpOk = false; console.log('     反例: compareVer(' + a + ',' + b + ')=' + got + ' 期望 ' + want) } }
ok('版本比较器用例全通过', cmpOk, cases.length + ' 例')

console.log('\n=== [7] 汇总入口（供 HTTP /adapter/api 使用）===')
const full = evaluate(rc1Svc, { hostVersion: host.version })
console.log('     ' + summaryLine(full))
ok('汇总结构完整', !!(full.capabilities && full.compat && full.status), 'status=' + full.status)

console.log('\n=== [8] engines.dsh 范围匹配器（2026-09-23 新增）===')
// 用例全部取自**真实**声明（不是编的）：
//   dsh-better-sidebar → ">=0.1.5-rc.1"；agent-teams → 四段精确枚举；
//   better-locale 0.4.1 → "^0.1.5-rc.1"、0.4.3 → "^0.1.5-rc.2"；dshmarket → 不含 0.1.5 线
const engCases = [
  ['0.1.5-rc.1', '0.1.5-rc.1', true, '精确命中'],
  ['0.1.5-rc.1', '0.1.5-rc.2', false, '精确不匹配'],
  ['>=0.1.5-rc.1', '0.1.5-rc.1', true, '下限命中（sidebar 的写法）'],
  ['>=0.1.5-rc.1', '0.1.5-rc.3', true, '下限覆盖更高版本'],
  ['>=0.1.5-rc.1', '0.1.4-rc.1', false, '低于下限'],
  ['^0.1.5-rc.1', '0.1.5-rc.1', true, '同线起点'],
  ['^0.1.5-rc.1', '0.1.5-rc.2', true, '同线向上'],
  ['^0.1.5-rc.2', '0.1.5-rc.1', false, '**关键**：better-locale 0.4.3 要 >=rc.2 ⇒ rc.1 不满足'],
  ['^0.1.5-rc.1', '0.1.6-rc.1', false, '跨 patch 线（prerelease 按 tuple 锁定）'],
  ['0.1.5-rc.1 || 0.1.2-rc.1 || 0.1.2-alpha.5 || 0.1.2-alpha.2', '0.1.5-rc.1', true, 'agent-teams 枚举：命中 rc.1'],
  ['0.1.5-rc.1 || 0.1.2-rc.1 || 0.1.2-alpha.5 || 0.1.2-alpha.2', '0.1.5-rc.2', false, '**关键**：agent-teams 枚举**不含** rc.2'],
  ['^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2', '0.1.5-rc.1', false, '**关键**：dshmarket 的声明不含 0.1.5 线'],
  ['~1.2.3', '1.2.4', null, '不支持的语法 ⇒ 必须返回 null（不得当满足）'],
  ['', '0.1.5-rc.1', null, '空声明 ⇒ null（不是"通过"）'],
]
let engOk = true
for (const [range, ver, want, why] of engCases) {
  const got = satisfiesEngine(range, ver)
  if (got !== want) { engOk = false; console.log('     反例: satisfiesEngine("' + range + '","' + ver + '")=' + got + ' 期望 ' + want + '（' + why + '）') }
}
ok('engines.dsh 范围匹配用例全通过', engOk, engCases.length + ' 例')
ok('不认识的语法返回 null 而不是 true', satisfiesEngine('??', '0.1.5-rc.1') === null)

console.log('\n=== [9] 自研插件的 engines.dsh 声明纳入判定（2026-09-23 新增）===')
// 造一个最小 profile：<tmp>/profiles/web/node_modules/@local/<name>/package.json
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-engines-'))
const localDir = path.join(tmpHome, 'profiles', 'web', 'node_modules', '@local')
for (const [n, e] of [['dsh-adapter', '0.1.5-rc.1'], ['taskkit', '0.1.5-rc.1'], ['no-decl', null]]) {
  const d = path.join(localDir, n)
  fs.mkdirSync(d, { recursive: true })
  const pkg = { name: '@local/' + n }
  if (e) pkg.engines = { dsh: e }
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg))
}
const read = readLocalPluginEngines(path.join(tmpHome, 'profiles', 'web'))
ok('读出 profile 里 @local 插件的引擎声明', read.length === 3, read.map((r) => r.name + '=' + (r.declared || '(无)')).join(' '))

// 宿主 = 声明值 ⇒ declared-ok
const sameVer = evaluateCompat({ hostVersion: '0.1.5-rc.1', dshHome: tmpHome })
const lpSame = sameVer.localPlugins.find((p) => p.name === '@local/dsh-adapter')
ok('宿主与声明一致 ⇒ satisfied=true', lpSame && lpSame.satisfied === true, JSON.stringify(lpSame))
ok('没有 engines.dsh 的插件 ⇒ satisfied=null（无法判定，不是通过）',
  sameVer.localPlugins.some((p) => p.name === '@local/no-decl' && p.satisfied === null))
ok('无法判定时报 warning', sameVer.versionWarnings.some((w) => /无法判定/.test(w)))

// 宿主 = rc.2（声明是 rc.1）⇒ satisfied=false，且给出"探针结论见 localPluginCompat"
const newerHost = evaluateCompat({ hostVersion: '0.1.5-rc.2', dshHome: tmpHome })
ok('宿主更新于声明 ⇒ satisfied=false',
  newerHost.localPlugins.find((p) => p.name === '@local/dsh-adapter').satisfied === false)
ok('声明不匹配时提示去看探针结论', newerHost.versionWarnings.some((w) => /localPluginCompat/.test(w)))

// —— adapter 的跨版本兜底：探针没缺口 ⇒ capabilities-ok（"可能可用，未经实测"）
const soft = evaluate(rc1Svc, { hostVersion: '0.1.5-rc.2', dshHome: tmpHome })
const softOne = soft.localPluginCompat.find((p) => p.name === '@local/dsh-adapter')
ok('探针无 high 缺口 ⇒ 判 capabilities-ok（不是直接判失败）', softOne && softOne.verdict === 'capabilities-ok', JSON.stringify(softOne))
ok('capabilities-ok 会明确标注"未经实测"', !!(softOne && /未经实测/.test(softOne.note || '')))

// —— 探针有 high 缺口 ⇒ capability-gaps（不能靠"声明其实挺宽"糊过去）
const hard = evaluate(emptySvc, { hostVersion: '0.1.5-rc.2', dshHome: tmpHome })
const hardOne = hard.localPluginCompat.find((p) => p.name === '@local/dsh-adapter')
ok('探针有 high 缺口 ⇒ 判 capability-gaps', hardOne && hardOne.verdict === 'capability-gaps', JSON.stringify(hardOne))
ok('capability-gaps 会点出是哪几项缺口', !!(hardOne && /high 级缺口/.test(hardOne.note || '')))

// —— 摘要行要能一眼看出漂移
const sumLine = summaryLine(soft)
ok('摘要行含自研插件的声明比对结果', /localPlugins=/.test(sumLine), sumLine)

console.log('\n=== 结果: 通过 ' + pass + ' / 失败 ' + fail + ' ===')
process.exit(fail === 0 ? 0 : 1)
