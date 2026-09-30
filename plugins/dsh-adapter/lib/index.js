// @local/dsh-adapter —— 插件入口（§5.1）
// 形态：ctx 服务 adapterFs / adapterHttp / adapter / hotplug / hotplugAudit / adapterWake / adapterResume（cordis ctx.provide）；
//       不写业务插件的 state；全部副作用走 ctx.effect。
// 2026-09-22 能力扩容：本包从"只做防腐层"升级为**承载热拔插的中间层**——
//   · 热拔插能力内化进 adapter（原在 @local/sandbox，而 sandbox 不在最小集 ⇒ 最小集无热更新）
//   · 破除 ESM 子图缓存改由 ModuleGraphBuster 在模块解析层完成，loader name 保持稳定包名
//   · 三级退让：L1 钩子可用 → L2 插件契约改造 → L3 明确拒绝并说明原因（不静默失败）
//   · 热替失败不再卸载插件：先 link-validate 再切换，失败用保留的旧代次自愈回滚

import { AdapterFsImpl } from './fs.js'
import { AdapterHttpImpl } from './http.js'
import { createAdapterWake } from './wake.js'
import { createAdapterResume } from './resume/index.js'
import { createInflightTable } from './resume/inflight.js'
import { createResumeGate } from './resume/gate.js'
import { createResumeGateRoutes } from './resume/routes.js'
import { Probe } from './probe.js'
import { summaryLine } from './compat.js'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ModuleGraphBuster } from './hotplug/buster.js'
import { HotplugService } from './hotplug/index.js'
import { ManifestStore } from './hotplug/manifest-store.js'
import { HotplugAuditLogger } from './hotplug/audit-logger.js'
import { createHotplugRoutes } from './hotplug/routes.js'
import { registerHotplugTools } from './hotplug/tools.js'
import { installHotplugCommand } from './hotplug/cmd.js'
import { readLegacyManifestEntries, markLegacyMigrated, inspectLegacy, LEGACY_MANIFEST } from './hotplug/migrate.js'

// 诊断日志路径（非业务数据；只追加）。
// 旧实现硬编码 Windows 便携版路径 `E:/DeepSeek-Harness-1.0.0-portable/dsh-data/...`，
// 迁到 Linux 后 appendFileSync 一律失败（被 catch 吞掉），诊断证据静默消失。
// 改为按环境推导：DSH_ADAPTER_LOG → <DSH_HOME>/dsh-adapter-apply.log → 进程 cwd。
// 本机 Windows 下 DSH_HOME 即 E:\DeepSeek-Harness-1.0.0-portable\dsh-data，路径与旧行为一致。
// 以下三个助手导出仅为自检脚本（test/selfcheck-paths.mjs）可直接断言；
// 插件契约只依赖 apply / inject / name，额外具名导出不影响宿主加载。
export function resolveAdapterLogPath() {
  const explicit = (process.env && process.env.DSH_ADAPTER_LOG) || ''
  if (explicit.trim()) return resolve(explicit.trim())
  const home = (process.env && process.env.DSH_HOME) || ''
  if (home.trim()) return join(resolve(home.trim()), 'dsh-adapter-apply.log')
  return join(resolve('.'), 'dsh-adapter-apply.log')
}

// 配置中的路径支持 ${VAR} 与 ${VAR:-默认值} 占位。
// 目的：同一份 dsh-bundle-patch.yml 在 Windows 与 Linux 共用——Linux 由
// deploy/linux/setup.sh 注入 DSH_WORKSPACE_ROOT，避免两平台各维护一份根表而漂移。
// 同时提供平台体检：POSIX 上若某个根仍是 Windows 绝对路径，宿主会把它当相对路径
// 解析到 cwd 下并静默产生错目录（不报错、只写错地方），因此显式告警。
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

export function expandVars(value) {
  if (typeof value !== 'string' || value.indexOf('${') === -1) return value
  return value.replace(VAR_PATTERN, (whole, name, fallback) => {
    const v = process.env && process.env[name]
    if (v !== undefined && v !== '') return v
    return fallback !== undefined ? fallback : whole
  })
}

export function expandRoots(roots, onWarn) {
  const out = {}
  for (const [name, value] of Object.entries(roots || {})) {
    const expanded = expandVars(value)
    out[name] = expanded
    if (process.platform === 'win32') continue
    if (typeof expanded === 'string' && /^[A-Za-z]:[\\/]/.test(expanded)) {
      onWarn('root[' + name + '] 在 ' + process.platform + ' 上仍是 Windows 路径: ' + expanded
        + '（检查 DSH_WORKSPACE_ROOT 是否已设置）')
    }
  }
  return out
}

// 依赖纪律（§5.1 / F5）：只有硬依赖进 inject。
//  - fs / sandboxPolicy：适配器全部方法的底座，缺失时的降级语义见 §5.1 表（不阻塞 apply）。
//  - webServer / loader / agents / tools：**可选**依赖（自检路由、热拔插数据面与命令）——
//    不进 inject，改用 ctx.registry.inject 独立子 fiber 惰性接入
//    （RegistryService.inject 直接创建新 fiber，不受本插件 apply 级 inject 白名单限制；
//     本包 hotplug 的接线即沿用这一模式，先例原在 @local/sandbox，拆除后由本包自持）。
//    为什么不用 apply 内 ctx.get('webServer')：cordis-plugin-loader 创建 loader 条目是 **并发**的
//    （cordis-plugin-loader/lib/index.js `EntryGroup.update` → Promise.allSettled(config.map(create))），
//    同批行之间无先后保证，apply 期 ctx.get 会变成启动竞态；子 fiber 由 cordis 在服务出现时自动激活，无竞态。
export const inject = ['fs', 'sandboxPolicy']

export const name = '@local/dsh-adapter'

// apply 为 async：ModuleGraphBuster 的启动自检需要 await（它用一个临时探针模块真实验证
// "换代次后 import() 得到新实例"）。自检失败只降级不抛，见下方 try/catch。
export async function apply(ctx, config) {
  const cfg = (config && config.adapter) || config || {}
  const packageVersion = readOwnVersion()
  const BUILD = 'as-built.2026-09-22.t6'
  const logPath = resolveAdapterLogPath()

  const logApply = function (line) {
    // 诊断日志目标路径由环境推导（非业务数据；只追加，不参与任何业务语义），见 resolveAdapterLogPath()
    try {
      appendFileSync(logPath, new Date().toISOString() + ' ' + line + '\n', 'utf8')
    } catch (e) { /* 日志写失败不阻断 */ }
  }

  // 合并 loader entry config（roots/defaultDataRoot/timeoutMs 等）
  // 注意（§3.1 A2 / §11 R5）：defaultDataRoot **不设硬编码业务默认**——未声明 = undefined（≠ 空值），
  // fs 层按触发表处理（未声明 = 无默认根 → 裸 resolveRef 抛 BAD_ARG）；根表/默认根一律由部署 config 声明。
  const adapterCfg = {
    roots: expandRoots(cfg.roots || {}, (m) => logApply('CONFIG_WARN ' + m)),
    defaultDataRoot: cfg.defaultDataRoot,
    timeoutMs: cfg.timeoutMs !== undefined ? cfg.timeoutMs : 8000,
    writePolicy: cfg.writePolicy !== undefined ? cfg.writePolicy : { mode: 'danger-full-access' },
  }

  // ---- 实现实例（惰性：方法调用时才真正碰 ctx.fs，apply 本身零 fs 操作）----
  const fsImpl = new AdapterFsImpl({ fs: ctx.fs, sandboxPolicy: ctx.sandboxPolicy, config: adapterCfg })
  const httpImpl = new AdapterHttpImpl({ config: adapterCfg })

  // ---- 契约探测（apply 一次 + status() 可重跑）----
  // getService：惰性取宿主服务（拿不到返回 undefined），供能力探测使用；绝不在 apply 期强取，避免时序竞态
  const getService = (name) => { try { return ctx.get(name) } catch (e) { return undefined } }
  const probe = new Probe({
    fs: ctx.fs,
    sandboxPolicy: ctx.sandboxPolicy,
    getWebServer: () => getService('webServer'),
    getService,
    config: adapterCfg,
    packageVersion,
    build: BUILD,
  })

  // ---- provide 服务（cordis 自动随 fiber dispose 注销，无需手动清理）----
  try { ctx.provide('adapterFs', fsImpl) } catch (e) {
    try { ctx.get('logger') && ctx.get('logger').warn('[dsh-adapter] provide adapterFs failed: ' + (e && e.message || e)) } catch (_) {}
  }
  try { ctx.provide('adapterHttp', httpImpl) } catch (e) {
    try { ctx.get('logger') && ctx.get('logger').warn('[dsh-adapter] provide adapterHttp failed: ' + (e && e.message || e)) } catch (_) {}
  }

  // ================= 热拔插（hotplug）：能力内化 =================
  // 归属变更：这套能力原先全在 @local/sandbox 内，而 sandbox 不在最小集 ⇒ 最小集没有热更新。
  // 内化后最小集（adapter + memory-system）自带热更新能力。
  const hotplugCfg = cfg.hotplug || {}
  const dshHome = resolveDshHome(logApply)
  const hotplugAudit = new HotplugAuditLogger({ dshHome })
  const hpLog = (level, event, message, extra) =>
    hotplugAudit.log({ level, category: 'hotplug', event, message, extra: extra || {} })

  // 白名单：优先搬旧 sandbox-manifest.yml（一次性），否则用部署 config 的 defaultEntries。
  // 注意**不再在代码里硬编码 builtin 白名单**（sandbox 曾把 taskkit/wrpro/lanr 写死）。
  const manifestPath = join(dshHome, 'hotplug-manifest.yml')
  const manifestStore = new ManifestStore(manifestPath)
  let legacyInfo = null
  try {
    legacyInfo = readLegacyManifestEntries(dshHome, manifestPath)
    manifestStore.load(legacyInfo ? legacyInfo.entries : (hotplugCfg.defaultEntries || []))
  } catch (e) {
    hpLog('ERROR', 'hotplug.manifest.load_failed', String((e && e.message) || e))
  }
  if (legacyInfo) {
    const renamed = markLegacyMigrated(legacyInfo.legacyPath)
    hpLog('WARN', 'hotplug.manifest.migrated',
      `已从 ${LEGACY_MANIFEST} 迁移 ${legacyInfo.entries.length} 条到 hotplug-manifest.yml；旧文件${renamed ? '已加 .migrated 后缀' : '保留原样'}`,
      { count: legacyInfo.entries.length, renamed, legacy: inspectLegacy(dshHome) })
  }
  const mDegraded = manifestStore.degradedInfo()
  if (mDegraded.degraded) {
    hpLog('WARN', 'hotplug.persistence.degraded',
      '白名单仅内存态，重启后丢失：' + (mDegraded.lastWriteErr || '未知写入错误'), mDegraded)
  }

  const buster = new ModuleGraphBuster({ log: (m) => logApply('HOTPLUG ' + m) })
  // 自检占位：真正的 `await buster.init()` 放在本函数**末尾**执行（见下方"最后执行 buster 自检"）。
  // 理由：本包既有纪律是"apply 期不做阻塞性异步、服务尽早 provide"——cordis-plugin-loader 会
  // **并发**创建同批 loader 条目，apply 里多一个长 await 就多一段"别的插件看不到 adapter 服务"的窗口。
  let busterInit = {
    level: 'L3', mode: 'none', nodeVersion: process.versions.node,
    reason: '自检尚未执行（apply 末尾统一执行）', checks: {},
  }

  const hotplug = new HotplugService({
    manifest: manifestStore, buster, tree: null, ctx, audit: hotplugAudit, logLine: logApply,
    // 包名/相对路径的解析基准 = profile 根目录。**必须传**：不传时 requireFrom 会回落到
    // adapter 自身位置，于是 profile 里的 @local/* 全部解析不到，报 INVALID_PATH 却看不出真因。
    // 用本文件已有的 dshHome（lib/index.js:142，来自 resolveDshHome）拼出来，不另起来源。
    baseDir: join(dshHome, 'profiles', 'web'),
  })
  const hotplugRoutes = createHotplugRoutes({ service: hotplug, auditTail: (o) => hotplugAudit.tail(o) })
  try { ctx.provide('hotplug', hotplug) } catch (e) { hpLog('WARN', 'hotplug.provide_failed', 'provide hotplug: ' + ((e && e.message) || e)) }
  try { ctx.provide('hotplugAudit', hotplugAudit) } catch (_) {}

  // ---- 热拔插可选依赖（loader / agents / tools）：独立子 fiber 惰性接入（理由见上方 inject 注释）----
  const wiring = { mechanism: 'registry.inject(loader,agents,tools)', tree: false, cmd: false, tools: null, error: null }
  try {
    const registry = (ctx.registry && typeof ctx.registry.inject === 'function') ? ctx.registry : null
    if (!registry) {
      wiring.error = 'ctx.registry.inject unavailable'
      logApply('HOTPLUG_WIRING_SKIP: ' + wiring.error)
    } else {
      const fiber = registry.inject(['loader', 'agents', 'tools'], function (sctx) {
        sctx.effect(function () {
          // 取 loader tree：优先子 fiber 注入，其次 ctx.loader / ctx.get('loader')（并行 create 的兜底）
          let loader = null
          try { loader = sctx.loader || null } catch (_) {}
          if (!loader || !loader.store) { try { loader = ctx.loader || null } catch (_) {} }
          if (!loader || !loader.store) { try { loader = ctx.get('loader') || null } catch (_) {} }
          if (loader && loader.store) {
            hotplug.setTree(loader)
            wiring.tree = true
            // 开机自动加载（设计 §2.2/§5.3）：tree 刚就绪，把白名单里 enabled 且不在 tree 的条目load 上来。
            // ⚠️ 三点注意：
            //   1. 必须在 tree 就绪之后调用 —— 构造时 tree 还是 null；
            //   2. **不 await**：本包纪律是"apply 期不做阻塞性异步"，await 会推迟 adapter 服务对外可见的时间；
            //   3. 自带逐条隔离（见 autoLoad 注释），单条失败不会连累整核。
            hotplug.autoLoad().catch((e) => hpLog('WARN', 'hotplug.autoload.threw', '自动加载整体异常（已吞，不影响启动）: ' + ((e && e.message) || e)))
          }
          try {
            const r = installHotplugCommand({ ctx: sctx, service: hotplug, audit: hotplugAudit, agents: sctx.agents })
            wiring.cmd = !!(r && r.installed)
          } catch (e) { hpLog('ERROR', 'hotplug.cmd.install_failed', String((e && e.message) || e)) }
          // 工具注册是 async（defineTool 走惰性动态 import）；失败只记账，不影响其它能力
          Promise.resolve(registerHotplugTools({ toolsService: sctx.tools, service: hotplug, audit: hotplugAudit }))
            .then((r) => { wiring.tools = r })
            .catch((e) => { wiring.tools = { error: String((e && e.message) || e) } })
          // 把白名单里的插件根登记进 buster（后续 reload 才有可 bust 的根）
          Promise.resolve(hotplug.syncRoots())
            .catch((e) => hpLog('WARN', 'hotplug.roots.sync_failed', String((e && e.message) || e)))
          logApply('HOTPLUG_WIRING_DONE tree=' + wiring.tree + ' cmd=' + wiring.cmd)
          return function () { logApply('HOTPLUG_WIRING_DISPOSED') }
        })
      })
      if (fiber && typeof fiber.then === 'function') {
        Promise.resolve(fiber).catch(function (e) {
          wiring.error = String((e && e.message) || e)
          logApply('HOTPLUG_WIRING_FAILED: ' + wiring.error)
        })
      }
    }
  } catch (e) {
    wiring.error = String((e && e.message) || e)
    logApply('HOTPLUG_WIRING_FAILED: ' + wiring.error)
  }
  // ================= 热拔插接线结束 =================

  // ---- 审计落盘器（resume 系列事件共用一处）----
  // ⚠️ 必须在 adapterWake 之前建：唤醒通道现在也要写审计（preset 解析退化的留痕），
  //    而它原先只拿到 log。审计文件仍是 resume-audit.jsonl（唤醒与自恢复同属一族）。
  const resumeAudit = new HotplugAuditLogger({ dshHome, fileName: 'resume-audit.jsonl' })

  // ---- adapterWake：唤醒通道（宿主 API 胶水的单一来源）----
  // 消费方：本包的 adapterResume（重启自恢复，见下）与 `@local/taskkit`（P3 §2D D5 后 taskkit 的自带实现已删）。
  // 依赖纪律：不进 inject，全部惰性 `ctx.get`（缺什么由 available() 明说）。
  // apply 期**只建对象、不调宿主服务**，故不引入启动期阻塞。
  const wake = createAdapterWake({
    ctx,
    log: (m) => logApply('WAKE ' + m),
    audit: (level, event, message, extra) =>
      resumeAudit.log({ level, category: 'resume', event, message, extra: extra || {} }),
    // T1-1（2026-09-25）：preset 解析改为"只读会话文件尾窗"，需要 DSH_HOME 去定位
    // `<home>/sessions/<bucket>/<id>/<file>`。这里复用本文件已解析出来的 dshHome（**不另起来源**）；
    // 不传 ⇒ 该能力不可用、退回改造前的 readSession 路径（wake.js 会打印一次说明）。
    dshHome,
  })
  try {
    ctx.provide('adapterWake', wake)
  } catch (e) {
    logApply('WAKE_PROVIDE_FAILED: ' + String((e && e.message) || e))
  }

  // ---- adapterResume：重启自恢复（P3 §2D D5：扫描与唤醒收归 adapter，不再单开插件）----
  // 依赖纪律与 adapterWake 完全一致：**不进 inject**，全部惰性 ctx.get
  //   （sessionQuery / sessionProjectionCache / subagents（复数，内核服务名）/ adapterWake 一律在 run() 里现取）。
  // apply 期只建对象 + 落一个定时器：**不做扫描、不做阻塞异步、绝不抛**——
  //   扫描（554 个会话、单个日志可达 30MB）若放在 apply 里会直接拖死内核启动。
  // 审计复用 adapter 既有落盘器，落 `logs/resume-audit.jsonl`，事件名 `resume.*`（形状同 hotplug-audit）。
  // 为什么不再注册独立插件：往 profile 的 dsh.bundle / bundles 里加新包有 crash-loop 风险（本项目踩过），
  //   而 adapter 已在最小集里。
  // 注：`resumeAudit` 实例在上面（adapterWake 之前）已建 —— 唤醒通道也要写审计，故提前。
  const resume = createAdapterResume({
    ctx,
    dshHome,
    wake,
    config: cfg.resume || cfg.resumeOnBoot,
    log: (m) => logApply('RESUME ' + m),
    audit: (level, event, message, extra) =>
      resumeAudit.log({ level, category: 'resume', event, message, extra: extra || {} }),
  })
  try {
    ctx.provide('adapterResume', resume)
  } catch (e) {
    logApply('RESUME_PROVIDE_FAILED: ' + String((e && e.message) || e))
  }
  // 到点才扫描（startDelayMs 默认 0 = 立即）；用定时器而非阻塞等待，给内核其余部分留出就绪时间。
  // 定时器挂在 ctx.effect 上：fiber dispose 时 cancel（不留下野定时器）。
  try {
    ctx.effect(function () {
      resume.schedule()
      return function () { try { resume.cancel() } catch (_) {} }
    })
  } catch (e) {
    // ctx.effect 不可用（非常规 ctx）→ 直接排定时器；排不上也不阻断 apply
    try { resume.schedule() } catch (e2) {
      logApply('RESUME_SCHEDULE_FAILED: ' + String((e2 && e2.message) || e2))
    }
  }

  // ---- adapterGate：重启门闸（P3-U11）----
  // 定位（用户裁定）：优雅重启**前**拦住重启，等在飞工作收敛 —— 服务的是「不中断更新」，
  //   **不是**崩溃检测（所以查询时进程还活着，判定权威是活会话存储，见 lib/resume/gate.js 文件头）。
  // 依赖纪律同上：**不进 inject**，`sessions` 惰性 ctx.get；apply 期只建对象 + 一次 ctx.on 订阅。
  // 在飞表只是**快路径 + 交叉校验**：adapter 被热拔插 reload 时内存表会清零，
  //   只依赖它的门闸会在 reload 后**假报安全** —— 故判定权威在活会话存储，本表只补字段、只告警。
  const inflight = createInflightTable({
    ctx,
    log: (m) => logApply('INFLIGHT ' + m),
    audit: (level, event, message, extra) =>
      resumeAudit.log({ level, category: 'resume', event, message, extra: extra || {} }),
  })
  const gate = createResumeGate({
    ctx,
    hotplug,
    inflight,
    config: (cfg.resume && cfg.resume.gate) || (cfg.resumeOnBoot && cfg.resumeOnBoot.gate) || {},
    log: (m) => logApply('GATE ' + m),
    audit: (level, event, message, extra) =>
      resumeAudit.log({ level, category: 'resume', event, message, extra: extra || {} }),
  })
  try {
    ctx.provide('adapterGate', gate)
  } catch (e) {
    logApply('GATE_PROVIDE_FAILED: ' + String((e && e.message) || e))
  }
  // /adapter/api/resume/gate 复用同一个 gate 实例（避免"两套判定逻辑"漂移）；
  // force 留痕也走这条路由 ⇒ 审计只落在 resume-audit.jsonl 一处
  const gateRoutes = createResumeGateRoutes({ gate, auditTail: (o) => resumeAudit.tail(o) })
  // 订阅子代理生命周期事件（**必须 { global: true }**：内核把父 Agent 作为 scope target，
  // 不绕过 scope 过滤就会漏掉一部分甚至全部边沿 —— 详见 lib/resume/inflight.js 文件头）。
  // 订阅失败只降级不抛：门闸判定不依赖它，缺的只是交叉校验来源。
  try {
    ctx.effect(function () {
      const r = inflight.start()
      logApply('INFLIGHT_SUBSCRIBE subscribed=' + r.subscribed + ' global=' + r.global
        + (r.error ? ' error=' + r.error : ''))
      return function () { try { inflight.stop() } catch (_) {} }
    })
  } catch (e) {
    try {
      const r = inflight.start()
      logApply('INFLIGHT_SUBSCRIBE(no-effect) subscribed=' + r.subscribed + (r.error ? ' error=' + r.error : ''))
    } catch (e2) {
      logApply('INFLIGHT_SUBSCRIBE_FAILED: ' + String((e2 && e2.message) || e2))
    }
  }
  try {
    const gc = gate.config()
    // 把三类开关与 test-only 开关如实打出来：生产巡检时"某类被关掉"或"注入被遗留"要一眼可见
    logApply('GATE_READY categories=delegations:' + !!gc.categories.delegations
      + ',hotplugOps:' + !!gc.categories.hotplugOps
      + ',openTurns:' + !!gc.categories.openTurns
      + ' testForceInflight=' + (gc.testForceInflight || 'null'))
  } catch (e) {
    logApply('GATE_CONFIG_READ_FAILED: ' + String((e && e.message) || e))
  }

  // ---- 自检路由（可选依赖 webServer）：独立子 fiber 惰性接入 ----
  // 与 writing-studio 同款 effect 语义：ctx.effect(cb) 立即执行 cb（register 在此发生），cb 返回值作 fiber dispose 时的 disposer。
  // ⚠️ 切勿把"清理函数"传进 ctx.effect（它会立即执行清掉刚注册的路由/服务）
  const route = { mechanism: 'registry.inject(webServer)', registered: false, error: null }
  try {
    const registry = (ctx.registry && typeof ctx.registry.inject === 'function') ? ctx.registry : null
    if (!registry) {
      route.error = 'ctx.registry.inject unavailable'
      logApply('ROUTE_SKIP /adapter/api: ' + route.error)
    } else {
      const fiber = registry.inject(['webServer'], function (sctx) {
        sctx.effect(function () {
          route.registered = true
          logApply('ROUTE_REGISTERED /adapter/api via ' + route.mechanism)
          return sctx.webServer.register({
            // kind 取宿主规范值 'prefix'（WebRouteKind='exact'|'prefix'，见 dsh-host-webserver lib/types/index.d.ts L30-31）；
            // 宿主 register() 对非 'exact' 一律送前缀表（lib/index.js L177），故本值与此前 as-built 的类型外取值注册结果一致
            kind: 'prefix',
            path: '/adapter/api',
            handler: async (req, res) => {
              // /adapter/api/hotplug* 先交给热拔插数据面（在同一前缀下再分发，避免再注册一条路由）
              try {
                if (await hotplugRoutes(req, res)) return
              } catch (e) {
                try {
                  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: String((e && e.message) || e) }))
                } catch (_) {}
                return
              }
              // /adapter/api/resume/gate 再交给门闸数据面（同样返回 false 即让位给下面的 status）
              try {
                if (await gateRoutes(req, res)) return
              } catch (e) {
                try {
                  // 门闸这条**必须 fail-closed**：出错时明确说"不安全"，绝不落到下面的 status 200
                  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                  res.end(JSON.stringify({ ok: false, safe: false, code: 'INTERNAL_ERROR', message: String((e && e.message) || e) }))
                } catch (_) {}
                return
              }
              const body = JSON.stringify(probe.statusJson({
                dshVersion: process.env.DSH_VERSION || 'unknown',
                nodeMajor: (process.versions && process.versions.node ? process.versions.node.split('.')[0] : '?'),
                webUrl: httpImpl.apiBase(),
                hostVersionDetected: probe.runCompat().compat.host.version,
                hotplug: hotplug.snapshot(),
              }), null, 2)
              // charset=utf-8 必须显式声明：否则客户端按 Latin-1 解码，中文备注显示为乱码
              try { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(body) } catch (e) {}
            },
          })
        })
      })
      if (fiber && typeof fiber.then === 'function') {
        Promise.resolve(fiber).catch(function (e) {
          route.error = String(e && e.message || e)
          logApply('ROUTE_REGISTER_FAILED /adapter/api: ' + route.error)
        })
      }
    }
  } catch (e) {
    route.error = String(e && e.message || e)
    logApply('ROUTE_REGISTER_FAILED /adapter/api: ' + route.error)
  }

  // ---- 暴露 status()（供消费方/诊断直读，勿写业务文件）----
  // compat()：宿主版本 + 能力清单 + 兼容矩阵判定（只读），用于升级前后一键体检
  try { ctx.provide('adapter', {
    status: function (extra) { return probe.statusJson(extra) },
    compat: function () { return probe.runCompat() },
    fs: fsImpl,
    http: httpImpl,
    hotplug: hotplug,
    hotplugAudit: hotplugAudit,
  }) } catch (e) {}

  // ---- 最后执行 buster 自检（本函数唯一一处 await；放在所有 provide / 路由注册之后）----
  // 自检失败只降级不抛：hotplug 写操作会以 BUSTER_UNAVAILABLE 明确拒绝并说明原因（退让兜底），
  // 但**绝不阻断 apply** —— adapter 在最小集里，它的启动失败会直接让宿主起不来。
  try {
    busterInit = await buster.init()
  } catch (e) {
    busterInit = {
      level: 'L3', mode: 'none', nodeVersion: process.versions.node,
      reason: 'init 抛错: ' + ((e && e.message) || e), checks: {},
    }
    hpLog('ERROR', 'hotplug.buster.init_failed', busterInit.reason)
  }
  hpLog(busterInit.level === 'L1' ? 'INFO' : 'WARN', 'hotplug.buster.ready',
    `ModuleGraphBuster level=${busterInit.level} mode=${busterInit.mode} node=${busterInit.nodeVersion}`,
    { level: busterInit.level, mode: busterInit.mode, reason: busterInit.reason, checks: busterInit.checks })

  // ---- apply 完成诊断日志（确定性证据：验证 apply 执行到末尾 + 服务/路由就绪）----
  // 追加一行兼容摘要：宿主版本 / 子代理语义代次 / 缺失能力 / 版本错配数（升级前后一眼可比）
  let compatLine = ''
  try {
    const rep = probe.runCompat()
    compatLine = ' compat[' + summaryLine(rep) + ']'
    if (rep && rep.capabilityGaps && rep.capabilityGaps.length) {
      try { ctx.get('logger') && ctx.get('logger').warn('[dsh-adapter] 宿主能力缺口: ' + rep.capabilityGaps.map((g) => g.id + '(' + g.severity + ')').join(', ') + ' | ' + summaryLine(rep)) } catch (_) {}
    } else {
      try { ctx.get('logger') && ctx.get('logger').info('[dsh-adapter] 兼容自检通过 | ' + summaryLine(rep)) } catch (_) {}
    }
  } catch (e) { compatLine = ' compat[error:' + (e && e.message || e) + ']' }
  // apply 期副作用归 fiber（评审要求）：诊断日志的写入经 ctx.effect 执行——
  // cordis 的 ctx.effect(cb) 立即执行 cb，cb 返回值作为 fiber dispose 时的 disposer；此处 disposer 只补一行收尾日志。
  const applyLine = 'APPLY_DONE build=' + BUILD +
    ' provides=adapterFs+adapterHttp+adapter+hotplug+hotplugAudit+adapterWake+adapterResume+adapterGate' +
    ' route=' + (route.registered ? 'registered' : (route.error ? 'error:' + route.error : 'lazy-pending(' + route.mechanism + ')')) +
    ' inject=[' + inject.join(',') + ']' +
    ' hotplug[level=' + busterInit.level + ' mode=' + busterInit.mode +
    ' manifest=' + manifestStore.list().length + 'entries' +
    ' tree=' + (wiring.tree ? 'yes' : (wiring.error ? 'error' : 'pending')) +
    ' cmd=' + (wiring.cmd ? 'yes' : 'no') + ']' +
    ' cfg.defaultRoot=' + (adapterCfg.defaultDataRoot === undefined ? '(undeclared)' : adapterCfg.defaultDataRoot) + compatLine
  try {
    ctx.effect(function () {
      logApply(applyLine)
      return function () { logApply('DISPOSED build=' + BUILD) }
    })
  } catch (e) {
    // ctx.effect 不可用（非常规 ctx）→ 回退为直接写日志，不阻断 apply
    logApply(applyLine)
  }
}

// 版本自检（§7.3）：以自身 package.json 为准，避免双份常量漂移；读失败回退占位值（不抛）
function readOwnVersion() {
  try {
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8'))
    return pkg && pkg.version ? String(pkg.version) : '0.0.0'
  } catch (e) { return '0.0.0' }
}

// DSH_HOME 推导（与 sandbox 同口径，但收掉其"同一逻辑在 index.js 里写三遍"的重复）：
//   DSH_HOME → <cwd>/dsh-data → <APPDATA>/dsh/dsh-data → <cwd>/dsh-data
// 用途：热拔插白名单 hotplug-manifest.yml 与审计 logs/hotplug-audit.jsonl 的落地位置。
function resolveDshHome(log) {
  const explicit = (process.env && process.env.DSH_HOME) || ''
  if (explicit.trim()) return resolve(explicit.trim())
  try {
    const p = join(process.cwd(), 'dsh-data')
    if (existsSync(p)) return p
  } catch (_) { /* 取 cwd 失败则继续往下推 */ }
  const appdata = (process.env && process.env.APPDATA) || ''
  if (appdata.trim()) return join(appdata, 'dsh', 'dsh-data')
  if (typeof log === 'function') {
    log('CONFIG_WARN 无法推导 DSH_HOME（未设 DSH_HOME 且 cwd/dsh-data 不存在）；白名单与审计将落在 cwd 下')
  }
  return join(process.cwd(), 'dsh-data')
}
