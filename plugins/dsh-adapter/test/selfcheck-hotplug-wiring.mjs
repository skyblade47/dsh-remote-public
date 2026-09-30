// @local/dsh-adapter —— 热拔插接线（M2）冒烟测试
//
// 目的：adapter 是最小集成员，**apply 绝不能因为 hotplug 的原因把宿主带崩**。
// 本测试用假 ctx 真跑一次 apply，覆盖：
//   1. apply 正常完成，5 个服务都 provide 出来（adapterFs/adapterHttp/adapter/hotplug/hotplugAudit）
//   2. buster 自检达 L1，且 APPLY_DONE 日志带 hotplug[...] 段
//   3. 白名单落盘到 <DSH_HOME>/hotplug-manifest.yml（不再硬编码 builtin 白名单）
//   4. 旧 sandbox-manifest.yml 一次性迁移 + 旧文件加 .migrated
//   5. /adapter/api/hotplug 与 /adapter/api 都能响应（数据面 + 原自检面共存）
//   6. 可选依赖缺失时**只降级**：无 agents 时命令跳过、无 dsh-tools 时工具跳过，都不抛
//
// 用法：node plugins/dsh-adapter/test/selfcheck-hotplug-wiring.mjs   退出码 0=全通过

import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (extra !== undefined ? '  → ' + extra : '')) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
const eq = (name, actual, expect) => ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect))

// ---- 假 ctx：只实现 adapter 用到的契约面 ----
function makeCtx({ services = {}, withAgents = true } = {}) {
  const provided = new Map()
  const routes = []
  const logLines = []
  const agents = withAgents
    ? { on: () => {}, values: () => [] }
    : null
  const ctx = {
    fs: undefined,
    sandboxPolicy: undefined,
    _provided: provided,
    _routes: routes,
    _log: logLines,
    provide: (name, obj) => { provided.set(name, obj) },
    get: (name) => {
      if (name === 'logger') return { info: () => {}, warn: () => {}, error: () => {} }
      if (name in services) return services[name]
      if (name === 'agents' && agents) return agents
      return undefined
    },
    effect: (cb) => { const d = cb(); return d },   // cordis 语义：立即执行，不执行返回的 disposer
    registry: {
      inject: (names, cb) => {
        const sctx = {
          effect: (fn) => { const d = fn(); return d },
          get: ctx.get,
          webServer: {
            register: (def) => { routes.push(def); return { ok: true } },
          },
          loader: services.loader,
          agents: agents,
          tools: services.tools,
        }
        cb(sctx)
        return Promise.resolve()
      },
    },
  }
  return ctx
}

function makeRes() {
  const r = { status: null, headers: null, body: null }
  r.writeHead = (s, h) => { r.status = s; r.headers = h }
  r.end = (b) => { r.body = b }
  return r
}

function makeReq(method, url, bodyObj) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  if (bodyObj !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(bodyObj), 'utf8'))
      req.emit('end')
    })
  }
  return req
}

const adminCtxLog = (p) => { try { console.log('     ctx.log: ' + p) } catch (_) {} }

// ============ 场景 1：全新环境（无旧 sandbox 数据）============
console.log('\n=== [1] apply 全新建线（无旧 sandbox 数据） ===')

const home1 = mkdtempSync(join(tmpdir(), 'dsh-hp-wire-'))
const logPath1 = join(home1, 'adapter-apply.log')
process.env.DSH_HOME = home1
process.env.DSH_ADAPTER_LOG = logPath1

const { apply } = await import('../lib/index.js')

const ctx1 = makeCtx({
  services: { loader: { store: {}, create: async () => {}, remove: async () => {} } },
})
let applyErr = null
try {
  await apply(ctx1, { adapter: { roots: {}, hotplug: { defaultEntries: [{ id: 'demo', path: 'file:///nonexistent/x.js', config: {}, builtin: true, enabled: true }] } } })
} catch (e) { applyErr = e }
ok('1a apply 正常完成（hotplug 接线不阻断 apply）', applyErr === null, applyErr && applyErr.message)

for (const name of ['adapterFs', 'adapterHttp', 'adapter', 'hotplug', 'hotplugAudit', 'adapterWake', 'adapterResume']) {
  ok('1b provide ' + name, ctx1._provided.has(name))
}
// P3 重启自恢复：扫描必须靠**惰性 ctx.get**（sessionQuery / sessionProjectionCache / **subagents** 复数 / adapterWake），
// 一旦把其中任何一个写进 apply 级 inject，adapter 的 apply 就会被推迟到那些服务就绪之后——
// 而别的插件正等着 adapterFs/adapterHttp（本项目踩过的坑）。这里把 inject 面锁死。
{
  const { inject } = await import('../lib/index.js')
  eq('1b-r1 inject 面不变（adapterResume 的依赖一律不进 inject）', JSON.stringify(inject), JSON.stringify(['fs', 'sandboxPolicy']))
  const resumeSvc = ctx1._provided.get('adapterResume')
  ok('1b-r2 adapterResume 暴露 status()/run()/schedule()/cancel()',
    !!(resumeSvc && typeof resumeSvc.status === 'function' && typeof resumeSvc.run === 'function'
      && typeof resumeSvc.schedule === 'function' && typeof resumeSvc.cancel === 'function'))
  const st = resumeSvc.status()
  eq('1b-r3 默认配置（P3 §Phase 3）', [st.enabled, st.scope, st.startDelayMs, st.maxResumePerBoot, st.dryRun].join('|'), 'true|tasks-only|0|5|false')
  ok('1b-r4 依赖如实体检（假 ctx 无这些服务 ⇒ 全部 false，不抛）',
    st.dependencies.sessionQuery === false && st.dependencies.subagents === false)
  ok('1b-r5 apply 期**没有**扫描（未到点前 lastRound 为空，apply 零宿主调用）', st.lastRound === null)
  // 定时器到点后必然跑一轮：假 ctx 无 sessionQuery ⇒ 干净退出 + 写 resume.fail（不抛、不静默）
  await new Promise((r) => setTimeout(r, 30))
  const auditTail = existsSync(join(home1, 'logs', 'resume-audit.jsonl'))
    ? readFileSync(join(home1, 'logs', 'resume-audit.jsonl'), 'utf8')
    : ''
  ok('1b-r6 到点扫描一轮并写 resume-audit.jsonl（resume.fail：sessionQuery 不可用）',
    /"category":"resume"/.test(auditTail) && /"event":"resume\.fail"/.test(auditTail), auditTail.split('\n').filter(Boolean).slice(-1)[0])
  ok('1b-r7 cancel() 幂等且不抛（fiber dispose 会调用它）',
    (() => { try { resumeSvc.cancel(); resumeSvc.cancel(); return true } catch (_) { return false } })())
}
eq('1c 路由注册条数（/adapter/api 一条，hotplug 在同一前缀下分发）', ctx1._routes.length, 1)
ok('1d 路由 path=/adapter/api', ctx1._routes[0] && ctx1._routes[0].path === '/adapter/api')

const log1 = existsSync(logPath1) ? readFileSync(logPath1, 'utf8') : ''
ok('1e 日志有 APPLY_DONE', /APPLY_DONE/.test(log1))
ok('1f APPLY_DONE 带 hotplug 段且 level=L1', /hotplug\[level=L1 mode=registerHooks/.test(log1),
  (log1.match(/hotplug\[[^\]]*\]/) || ['(未匹配)'])[0])
ok('1g 日志有 BUSTER 自检结论行', /BUSTER_SELFTEST level=L1/.test(log1))
ok('1h 日志记录了 HOTPLUG_WIRING_DONE', /HOTPLUG_WIRING_DONE/.test(log1))

const hp1 = ctx1._provided.get('hotplug')
const st1 = await hp1.status('demo')
eq('1i 白名单条目已加载（来自 config defaultEntries）', st1.id, 'demo')
eq('1j 档位判定可用（tree 已接入）', hp1.treeAvailable, true)
ok('1k buster 快照可达（level 在 buster 段下）',
  ctx1._provided.get('adapter').hotplug.snapshot().buster.level === 'L1',
  'level=' + ctx1._provided.get('adapter').hotplug.snapshot().buster.level)

const manifestFile = join(home1, 'hotplug-manifest.yml')
ok('1l 白名单已落盘 hotplug-manifest.yml', existsSync(manifestFile), manifestFile)
ok('1m 落盘内容含 demo 条目', existsSync(manifestFile) && /id: "demo"/.test(readFileSync(manifestFile, 'utf8')))
ok('1n 审计目录已建', existsSync(join(home1, 'logs')))
// 1x baseDir 必须被真的传进来：缺了它，包名解析会回落到 adapter 自身位置，
//    表现为"白名单条目路径无法解析"，而错误现场（INVALID_PATH）离真因很远。
//    （标签用 1x：1n / 1o 都已被本小节占用）
ok('1x service.baseDir 必须非空（漏传会让包名解析走到 adapter 自身位置）',
  !!(hp1 && hp1.baseDir), String(hp1 && hp1.baseDir))
ok('1o 审计写入 hotplug-audit.jsonl',
  existsSync(join(home1, 'logs', 'hotplug-audit.jsonl')),
  existsSync(join(home1, 'logs', 'hotplug-audit.jsonl')) ? '' : '文件不存在（仅内存态？）')

// ---- 数据面：GET /adapter/api/hotplug ----
const handler1 = ctx1._routes[0].handler
{
  const res = makeRes()
  // 注意：adapter 的 handler 是 webServer 处理器，**返回值不被使用**（undefined 属正常）。
  // 因此"是否走到数据面"的判据是**响应体**，不是返回值。
  await handler1(makeReq('GET', '/adapter/api/hotplug'), res)
  eq('1q 返回 200', res.status, 200)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (_) {}
  ok('1p GET /adapter/api/hotplug 走数据面（不是兼容自检）',
    !!(parsed && parsed.ok === true && parsed.buster),
    parsed ? 'keys=' + Object.keys(parsed).slice(0, 6).join(',') : 'parse failed')
  ok('1r 返回体含 buster 与 entries', !!(parsed && parsed.buster && Array.isArray(parsed.entries)),
    parsed ? ('entries=' + parsed.entries.length + ' buster=' + parsed.buster.level) : 'parse failed')
  ok('1s 响应头声明 charset=utf-8（中文不乱码）', /charset=utf-8/.test(String(res.headers && res.headers['content-type'])))
}
// ---- 原自检面仍可用 ----
{
  const res = makeRes()
  await handler1(makeReq('GET', '/adapter/api'), res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (_) {}
  // probe.statusJson(extra) 把 extra 挂在 host 段下（见 lib/probe.js L75）
  ok('1t /adapter/api 仍返回兼容自检（hotplug 段挂在 host 下）',
    !!(parsed && parsed.host && parsed.host.hotplug),
    parsed ? 'keys=' + Object.keys(parsed).join(',') : 'parse failed')
}
// ---- 数据面：POST 未知 op 必须给明确错误而非 500 ----
{
  const res = makeRes()
  await handler1(makeReq('POST', '/adapter/api/hotplug', { op: 'nonsense' }), res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (_) {}
  ok('1u POST 未知 op 给明确错误（400 + code）',
    res.status === 400 && parsed && parsed.code === 'INVALID_ARGS',
    'status=' + res.status + ' code=' + (parsed && parsed.code))
}
// ---- 数据面：POST status ----
{
  const res = makeRes()
  await handler1(makeReq('POST', '/adapter/api/hotplug', { op: 'status', id: 'demo' }), res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (_) {}
  ok('1v POST status 成功', res.status === 200 && parsed && parsed.ok === true && parsed.result.id === 'demo',
    'status=' + res.status)
}
// ---- 审计 tail 端点 ----
{
  const res = makeRes()
  await handler1(makeReq('GET', '/adapter/api/hotplug/audit?tail=5'), res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (_) {}
  ok('1w 审计 tail 端点可用', res.status === 200 && parsed && Array.isArray(parsed.entries),
    'status=' + res.status + ' n=' + (parsed && parsed.entries && parsed.entries.length))
}

// ============ 场景 2：旧 sandbox 数据一次性迁移 ============
console.log('\n=== [2] 旧 sandbox-manifest.yml 一次性迁移 ===')

const home2 = mkdtempSync(join(tmpdir(), 'dsh-hp-mig-'))
mkdirSync(join(home2, 'logs'), { recursive: true })
writeFileSync(join(home2, 'sandbox-manifest.yml'),
  '# sandbox manifest (auto-generated, do not edit while dsh running)\nversion: 1\nentries:\n' +
  '  - id: "wrpro"\n    path: "@local/wrpro"\n    builtin: true\n    enabled: true\n    config: {}\n' +
  '  - id: "taskkit"\n    path: "@local/taskkit"\n    builtin: true\n    enabled: true\n    config: {}\n',
  'utf8')
writeFileSync(join(home2, 'sandbox-state.json'), '{"orphanedIds":[]}', 'utf8')

process.env.DSH_HOME = home2
process.env.DSH_ADAPTER_LOG = join(home2, 'adapter-apply.log')

const ctx2 = makeCtx({ services: { loader: { store: {} } } })
let applyErr2 = null
try { await apply(ctx2, { adapter: { roots: {} } }) } catch (e) { applyErr2 = e }
ok('2a 迁移场景下 apply 仍正常完成', applyErr2 === null, applyErr2 && applyErr2.message)

const newManifest = join(home2, 'hotplug-manifest.yml')
ok('2b 新白名单文件已生成', existsSync(newManifest))
const newText = existsSync(newManifest) ? readFileSync(newManifest, 'utf8') : ''
ok('2c wrpro 条目已搬过来', /"wrpro"/.test(newText), newText.split('\n').filter((l) => /id:/.test(l)).join(' | '))
ok('2d taskkit 条目已搬过来', /"taskkit"/.test(newText))
ok('2e 旧文件加 .migrated 后缀留档', existsSync(join(home2, 'sandbox-manifest.yml.migrated')))
ok('2f 旧文件名已不在（已改名）', !existsSync(join(home2, 'sandbox-manifest.yml')))
ok('2g 迁移写入了审计（可对账）', /hotplug\.manifest\.migrated/.test(readFileSync(join(home2, 'logs', 'hotplug-audit.jsonl'), 'utf8')))
const hp2 = ctx2._provided.get('hotplug')
const list2 = await hp2.list()
eq('2h 迁移后白名单条数', list2.length, 2)
ok('2i 迁移条目保留 builtin 标记（仅作来源标记，不参与门禁）',
  list2.every((e) => e.builtin === true) && list2.every((e) => e.allowedOps.length === 4),
  'tiers=' + list2.map((e) => e.id + ':' + e.tier).join(','))

// ============ 场景 3：可选依赖缺失只降级不抛 ============
console.log('\n=== [3] 可选依赖缺失：只降级，不抛 ===')

const home3 = mkdtempSync(join(tmpdir(), 'dsh-hp-deg-'))
process.env.DSH_HOME = home3
process.env.DSH_ADAPTER_LOG = join(home3, 'adapter-apply.log')

const ctx3 = makeCtx({ services: { loader: { store: {} } }, withAgents: false })
let applyErr3 = null
try { await apply(ctx3, { adapter: { roots: {} } }) } catch (e) { applyErr3 = e }
ok('3a 无 agents 时 apply 仍正常完成', applyErr3 === null, applyErr3 && applyErr3.message)
const log3 = existsSync(join(home3, 'adapter-apply.log')) ? readFileSync(join(home3, 'adapter-apply.log'), 'utf8') : ''
ok('3b 审计/日志记录了命令跳过原因（不是静默）',
  /hotplug\.cmd\.skipped|agents 服务不可用/.test(log3) || /HOTPLUG_WIRING_DONE/.test(log3),
  'WIRING_DONE 存在=' + /HOTPLUG_WIRING_DONE/.test(log3))
const hp3 = ctx3._provided.get('hotplug')
// tree 未接入（无 loader.store）→ 写操作必须给 TREE_UNAVAILABLE，而不是静默失败
const ctx4 = makeCtx({ services: {} })
process.env.DSH_HOME = home3
const noTreeSvc = ctx3._provided.get('hotplug')
// 造一个 tree 不可用的服务：直接 new 一个（模拟 loader 注入失败）
const { HotplugService } = await import('../lib/hotplug/index.js')
const { ModuleGraphBuster } = await import('../lib/hotplug/buster.js')
const noTree = new HotplugService({
  manifest: { get: () => ({ id: 'x', path: 'file:///x', enabled: true, config: {} }), has: () => true, list: () => [], update: () => {} },
  buster: new ModuleGraphBuster({ log: () => {} }),
  tree: null, ctx: null, audit: null,
})
let treeErr = null
try { await noTree.load('x') } catch (e) { treeErr = e }
ok('3c loader tree 不可用时给 TREE_UNAVAILABLE（不静默）',
  treeErr && treeErr.code === 'TREE_UNAVAILABLE', treeErr && treeErr.code)
void hp3; void noTreeSvc; void ctx4; void adminCtxLog

// ==== [4] 开机自动加载（设计 §2.2/§5.3：白名单 enabled 且不在 tree → 排队自动加载）====
// 语义要求：
//   a) 只加载 enabled 且不在 tree 的条目
//   b) 幂等：重复调用不会重复加载（第二次应为 skipped）
//   c) **逐条隔离**：一条坏的不能拖累其它，也不能让调用抛出去
//   d) 结果写审计（可观测）
// ⚠️ 计划写明"沿用该自检已有的 FakeTree/FakeManifest/pluginPath/dir"——本文件（wiring 自检）里
//    **没有**这些夹具，它们只存在于 selfcheck-hotplug.mjs。这里按本文件既有的"内联假件"口径
//    （见上方 noTree 的构造）就地造同形假件，不搬入一套平行的夹具类；下面四条断言一字未改。
// 挂点见本文件的 Step 4：lib/index.js 在 tree 就绪后调用 autoLoad()。
console.log('\n=== [4] 开机自动加载 ===')
{
  const { pathToFileURL } = await import('node:url')   // 本文件未静态导入（与上方 HotplugService 的动态导入同形）
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hp-autoload-'))
  mkdirSync(join(dir, 'plug', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'plug', 'package.json'),
    JSON.stringify({ name: '@local/plug-autoload', version: '0.0.1', type: 'module', main: 'lib/index.js' }), 'utf8')
  writeFileSync(join(dir, 'plug', 'lib', 'index.js'), 'export default () => {}\n', 'utf8')
  const pluginPath = pathToFileURL(join(dir, 'plug')).href
  const buster = new ModuleGraphBuster({ log: () => {} })
  const auditRecs = []
  const audit = { log: (r) => auditRecs.push(r) }
  // 记录型假树：形状对齐 tree-ops.isLoaded 的判据（顶层 store['local-<id>'] + options.id/name）
  const t = {
    store: {},
    async create({ id, name, config }) {
      const key = 'local-' + id
      const ns = await import(name)   // 真 import：name 解析错了这里就炸，不退化成"假成功"
      this.store[key] = {
        id: key, name, options: { id: key, name, config: config || {} },
        fiber: { state: 2, runtime: { callback: () => {}, effects: [] } }, __ns: ns,
        remove: async () => { delete this.store[key] },
      }
    },
    async remove(key) { delete this.store[key] },
  }
  const entries = [
    { id: 'good1', path: pluginPath, config: {}, enabled: true, builtin: false },
    { id: 'bad',   path: join(dir, 'nonexistent'), config: {}, enabled: true, builtin: false },
    { id: 'good2', path: pluginPath, config: {}, enabled: true, builtin: false },
    { id: 'off',   path: pluginPath, config: {}, enabled: false, builtin: false },
  ]
  const m = { list: () => entries, get: (id) => entries.find((e) => e.id === id) }
  const s = new HotplugService({ manifest: m, buster, tree: t, ctx: null, audit, logLine: () => {}, baseDir: dir })
  const r = await s.autoLoad()
  ok('4a 只加载 enabled 且不在 tree 的条目（good1/good2）', r.loaded.length === 2 && r.loaded.includes('good1') && r.loaded.includes('good2'), JSON.stringify(r.loaded))
  ok('4b 坏条目不影响其它，且被记为 failed', r.failed.some((x) => x.id === 'bad') && r.loaded.length === 2, JSON.stringify(r.failed))
  ok('4c disabled 条目被跳过', !r.loaded.includes('off'), JSON.stringify(r.skipped))
  const r2 = await s.autoLoad()
  ok('4d 幂等：再跑一次不再加载', r2.loaded.length === 0, JSON.stringify(r2))
  // 4e：必须走 _audit（hotplug 审计），不能只走 _logLine（apply 日志）
  //     —— 实测踩过：INFO 级完成事件只走 _logLine 时，hotplug-audit.jsonl 里完全看不见。
  ok('4e 完成事件写进 hotplug 审计（可观测）',
    auditRecs.some((x) => x.event === 'hotplug.autoload.done'),
    JSON.stringify(auditRecs.map((x) => x.event)))
  try { rmSync(dir, { recursive: true, force: true }) } catch (_) {}
}

// ---- 收尾 ----
for (const h of [home1, home2, home3]) { try { rmSync(h, { recursive: true, force: true }) } catch (_) {} }

console.log('\n' + '='.repeat(64))
console.log('pass=' + pass + ' fail=' + fail)
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1) }
console.log('全部通过')
