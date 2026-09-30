// @local/dsh-adapter —— 宿主能力探测 + 版本兼容判定（2026-09-17 新增）
//
// 设计原则（对应"当前可用 + 未来升级也可用"）：
//   1) 【能力优先，版本为辅】判定以"宿主是否真的提供某 API"为准（capability probe），
//      版本号只用于给出"推荐配套哪个插件版本"。避免把版本号硬编码成 if/else。
//   2) 【只读、零副作用】只做存在性/形态探测，不调用会改状态的宿主方法，不写任何文件。
//   3) 【降级不阻断】探测结果只产出 degraded/warnings，绝不 throw、绝不阻断 apply——
//      适配器自身必须永远能加载（否则它会变成新的单点故障）。
//   4) 【漂移可见】启动时把"缺失能力 + 版本错配"写一行日志，升级前后一眼可查（告别静默失效）。
//
// 历史实证（这些能力项就是从真实事故里长出来的）：
//   - subagents.registerContinuableSetup 缺失 → agent-teams 0.1.15 在 rc.1 加载失败；
//   - agentPresets.mount 未用上 → 被 resume 的会话丢 preset 工具层（94→61），调用报 UNKNOWN_TOOL。

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectHost, detectDshHome, installedPluginVersion } from './version.js'

const MATRIX_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'compat-matrix.json')
const PROFILE_CANDIDATES = ['web', 'node', 'tui', 'headless']

/** 读取兼容矩阵（无则返回 null，不 throw） */
export function loadMatrix() {
  try {
    if (!existsSync(MATRIX_PATH)) return null
    return JSON.parse(readFileSync(MATRIX_PATH, 'utf8'))
  } catch (e) { return null }
}

// ---- 最小版本比较（避免为比较版本号引入依赖）----
function parseVer(v) {
  const s = String(v || '').trim().replace(/^v/, '')
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}
export function compareVer(a, b) {
  const x = parseVer(a); const y = parseVer(b)
  if (!x || !y) return 0
  for (const k of ['major', 'minor', 'patch']) { if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1 }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1   // 正式版 > 预发布
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

// ---- 极简的 engines.dsh 范围匹配 ----
//
// 为什么自己写而不引 semver：本模块刻意零依赖（adapter 是单点，多一个依赖就多一个故障面）。
//
// 只支持我们**实际见到过的**写法，其余一律返回 **null = 「无法判定」**：
//   · 精确          "0.1.5-rc.1"
//   · 下限          ">=0.1.5-rc.1"
//   · 同线向上      "^0.1.5-rc.1"
//   · 枚举 / 或     "A || B || C"（每段按上面三种之一解析）
// 实测来源：dsh-better-sidebar 用 `>=0.1.5-rc.1`；agent-teams 用四段精确枚举；
//           better-locale 用 `^0.1.5-rc.2`；我们自己的 12 个自研插件用精确 `0.1.5-rc.1`。
//
// ⚠️ 两条刻意的保守设计，都是为了避免给出**虚假的兼容结论**：
//   1) 不认识的语法返回 null，**绝不**"当满足"。调用方拿到 null 必须报"无法判定"。
//   2) caret 对**预发布**版本按 tuple 锁定（`^0.1.5-rc.1` 不含 `0.1.6-*`），
//      与 semver 对 prerelease 的规则一致；副作用是"范围内的正式版"（如 0.1.6）也可能被判否
//      —— 方向是**保守**的（宁可报不满足，也不谎报支持）。
export function satisfiesEngine(range, version) {
  const r = String(range == null ? '' : range).trim()
  const v = String(version == null ? '' : version).trim()
  if (!r || !v) return null
  const vs = parseVer(v)
  if (!vs) return null
  const alts = r.split('||').map((s) => s.trim()).filter(Boolean)
  if (!alts.length) return null
  let sawUnknown = false
  for (const alt of alts) {
    const res = satisfiesOne(alt, v, vs)
    if (res === true) return true
    if (res === null) sawUnknown = true
  }
  return sawUnknown ? null : false
}

function satisfiesOne(alt, vRaw, vs) {
  const m = String(alt).match(/^(\^|>=|=)?\s*(.+)$/)
  if (!m) return null
  const op = m[1] || '='
  const boundRaw = m[2].trim()
  const bound = parseVer(boundRaw)
  if (!bound) return null
  const cmp = compareVer(vRaw, boundRaw)
  if (cmp === 0) return true
  if (op === '=') return false
  if (cmp < 0) return false
  if (op === '>=') return true
  // caret：
  //   · 边界是**预发布**（如 ^0.1.5-rc.1）⇒ 按 semver 对 prerelease 的规则**锁定完整 tuple**，
  //     只匹配 0.1.5-*。不这样做会出两个实测踩到的错判：
  //       ^0.1.5-rc.1 误判 0.1.6-rc.1 为满足（按 minor 比，而两者 minor 都是 1）；
  //       ^0.1.0-rc.7 误判 0.1.5-rc.1 为满足（同上）。
  //   · 边界是正式版（如 ^4.0.2）⇒ 常规 caret：major>0 看 major；0.x 看 minor。
  if (bound.pre) {
    return vs.major === bound.major && vs.minor === bound.minor && vs.patch === bound.patch
  }
  if (bound.major > 0) return vs.major === bound.major
  if (bound.minor > 0) return vs.major === 0 && vs.minor === bound.minor
  return vs.major === 0 && vs.minor === 0 && vs.patch === bound.patch
}

// ---- 读出已装 @local/* 插件声明的宿主版本（engines.dsh）----
//
// 为什么要读它：2026-09-23 之前，12 个自研插件的 package.json 里**完全没有**版本声明
// （只有 dsh.bundle / dsh.client.inject，且不带版本），于是"所有插件支持哪个宿主版本"
// 这件事无法机器判定，只能靠人记。现在补上了 engines.dsh（生态已有字段：
// dsh-better-sidebar 在 dsh.plugin.json 里用 `engines.dsh`，dshmarket 的市场卡片也读它）。
//
// 两个候选目录都要看：@local 包有时落在 profile 自己的 node_modules，
// 有时被提升到上层 profiles/node_modules（实测 setup.mjs 的 linkHostPackages 就落后者）。
export function readLocalPluginEngines(profilePath) {
  const out = []
  if (!profilePath) return out
  const roots = [
    join(profilePath, 'node_modules', '@local'),
    join(dirname(profilePath), 'node_modules', '@local'),
  ]
  const seen = new Set()
  for (const dir of roots) {
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names.sort()) {
      let pkg = null
      try { pkg = JSON.parse(readFileSync(join(dir, n, 'package.json'), 'utf8')) } catch { continue }
      const full = pkg.name || '@local/' + n
      if (seen.has(full)) continue
      seen.add(full)
      out.push({ name: full, declared: (pkg.engines && pkg.engines.dsh) || null })
    }
  }
  return out
}


// ---- 能力清单：每项 = 存在性探测 + 缺失时的补救建议 ----
// detect(svc) → true/false；svc(name) 为惰性 ctx.get 包装（拿不到返回 undefined）
//
// ⚠️ 有两类内核依赖**无法用存在性探测覆盖**，不要假装它们能（2026-09-22 记，对应
//    「不修改 DSH 原生主体 / 依赖内部形状同样要付重写成本」硬约束）：
//   1) **宿主事件**（如 `subagent/start` / `subagent/end`）。cordis 没有"枚举已注册事件名"的接口，
//      探针无从下手。缓解：事件名**集中在一处常量**（升级时一处改），并在运行期用
//      "首次订阅后是否真的观察到边沿"来佐证，另配交叉校验告警（见 P3 计划 U11 一节）。
//   2) **`ctx` 上的非服务属性**（如 `ctx.loader.store`）。`super(ctx, "loader")` 并不存在，
//      它不是 cordis 服务，探针拿不到。缓解：沿用既有**多路兜底**（子 fiber 注入 → `ctx.loader`
//      → `ctx.get('loader')`），并在缺陷时按"缺陷"处理而不是"未知"。
//    另注意：`svc()` 是**裸 `ctx.get`**，而 adapter 的 apply 级 `inject` 只有 fs/sandboxPolicy；
//    取不到既可能是"宿主没有"也可能是"不在本插件 scope"。故 remedy 文案必须把两种可能都写出来，
//    避免又一个恒定假警报（N8/N9 两次教训）。
export const CAPABILITIES = [
  {
    id: 'fs.core', group: '平台', severity: 'high',
    detect: (svc) => { const fs = svc('fs'); return !!fs && ['resolve', 'stat', 'readText', 'writeText', 'listDir'].every((m) => typeof fs[m] === 'function') },
    usedBy: '全部 @local 业务插件（adapterFs）',
    remedy: 'ctx.fs 不完整：adapterFs 全部方法将返回 ADAPTER_UNAVAILABLE；检查宿主 fs 插件行是否被禁用。',
  },
  {
    id: 'fs.sandboxMode', group: '平台', severity: 'low',
    detect: (svc) => { const fs = svc('fs'); return !!fs && fs.sandboxMode !== undefined },
    usedBy: 'adapterFs 写闸',
    remedy: '无写闸语义（本地 fs）：写路径不传第 5 参；属预期降级，非故障。',
  },
  {
    id: 'sandboxPolicy.resolve', group: '平台', severity: 'medium',
    detect: (svc) => { const sp = svc('sandboxPolicy'); return !!sp && typeof sp.resolve === 'function' },
    usedBy: 'adapterFs 默认根解析',
    remedy: '缺少 sandboxPolicy.resolve：默认数据根解析回退到显式 roots 配置。',
  },
  {
    id: 'webServer.register', group: '传输', severity: 'medium',
    detect: (svc) => { const ws = svc('webServer'); return !!ws && typeof ws.register === 'function' },
    usedBy: '@local 全部 HTTP 路由（taskkit/writing/insp/kb/email-bridge/adapter 自身）',
    remedy: '缺少 webServer：仅 headless 类 profile 属预期；Web 形态下缺失则所有 /taskkit/api/* 路由不可用。',
  },
  {
    id: 'tools.register', group: '工具面', severity: 'high',
    detect: (svc) => { const t = svc('tools'); return !!t && typeof t.register === 'function' },
    usedBy: '所有注册 agent 工具的插件（taskkit/memory/kb/insp/writing/sandbox/email-bridge/agent-teams）',
    remedy: '缺少 tools.register：插件工具无法注册，agent 工具面会整体缺失。',
  },
  {
    id: 'agents.get/resume/create', group: '会话', severity: 'high',
    detect: (svc) => { const a = svc('agents'); return !!a && typeof a.get === 'function' && typeof a.resume === 'function' && typeof a.create === 'function' },
    usedBy: 'taskkit 唤醒/派发、email-bridge 投递、agent-teams',
    remedy: '缺少 agents 服务：跨会话唤醒与派发链路失效。',
  },
  {
    // 2026-09-22 新增（对应「不修改 DSH 原生主体 / 依赖内部形状同样要付重写成本」硬约束）：
    // 定级依据 —— `Session` 与 `SessionStore` 都是 `@deepseek-ai/dsh-session` **主入口**（正式导出的 `.`）
    // 类型声明里的 `export declare class`（lib/types/index.d.ts），`snapshotEvents()` / `eventAt()` /
    // `ownEvents()` 均为其**声明成员** ⇒ 属**类型发布面**，不是内部形状。
    // ⚠️ 曾一度误判为"内部形状"：因为它没有独立 export 子路径。判据是"类是否在主入口类型里声明"，
    //    不是"方法有没有自己的 exports 键"——后者对实例成员永远为假。
    id: 'sessions.live', group: '会话', severity: 'medium',
    detect: (svc) => {
      const s = svc('sessions')
      if (!s || typeof s.list !== 'function' || typeof s.get !== 'function') return false
      // 活会话对象（Session 实例）的成员：能拿到样本就抽验，拿不到**不判失败**——
      // 空闲宿主上没有任何驻留会话是常态，把"没样本"当缺口就是在造恒定假警报（N8/N9 的坑）。
      let sample = null
      try { const arr = s.list(); if (Array.isArray(arr) && arr.length) sample = arr[0] } catch (_) { return false }
      if (!sample) return true
      return typeof sample.snapshotEvents === 'function' && typeof sample.eventAt === 'function'
    },
    usedBy: '重启门闸（P3-U11）的 openTurns / delegations 判据：只统计**进程内驻留**的会话，零磁盘读',
    remedy: '缺少 sessions.list/get（或活会话对象缺 snapshotEvents/eventAt）：门闸第三类判据无法进行 ⇒ 必须 **fail-closed**（gate 报 safe:false + reason=live-sessions-unavailable），绝不可当作"安全"。',
  },
  {
    id: 'agentPresets.resolve/mount', group: '会话', severity: 'high',
    detect: (svc) => { const p = svc('agentPresets'); return !!p && typeof p.resolve === 'function' && typeof p.mount === 'function' },
    usedBy: 'taskkit presetMountSetupFor（自建 resume 必须自行挂 preset）',
    remedy: '缺少 agentPresets.mount：任何自行 resume 会话的插件都会创建出「只有宿主全局工具层」的 agent（工具数骤减、web_search 等调用报 UNKNOWN_TOOL）。',
  },
  {
    id: 'subagents.registerProvider', group: '子代理', severity: 'medium',
    detect: (svc) => { const s = svc('subagents'); return !!s && typeof s.registerProvider === 'function' },
    usedBy: '宿主子代理后端（spawn/fork）',
    remedy: '缺少 registerProvider：宿主为 alpha.x 旧语义，第三方插件可能按新契约编写而失效。',
  },
  {
    id: 'subagents.registerContinuableSetup', group: '子代理', severity: 'low', informational: true,
    detect: (svc) => { const s = svc('subagents'); return !!s && typeof s.registerContinuableSetup === 'function' },
    usedBy: 'alpha.x 旧契约（rc.1 已移除）——其缺失属预期，仅用于判定宿主语义代次',
    remedy: '本项存在=宿主为旧语义；不存在=rc.1 现代语义（预期）。按旧契约编写的第三方插件需升级到其 rc.1 适配版。',
  },
  {
    // 2026-09-22 新增。severity=high 的理由是**有真实事故**：服务名写成单数 `subagent` 时
    // `ctx.get` 恒为 null ⇒ P1（父已闭合 + 子未闭合）**整层静默跳过**，而日志里只留一条 WARN，
    // 字面完全看不出是"名字写错"。探针的取值口径必须与 scan.js 一致（复数优先、单数兜底）。
    id: 'subagents.listChildren', group: '子代理', severity: 'high',
    detect: (svc) => { const s = svc('subagents') || svc('subagent'); return !!s && typeof s.listChildren === 'function' },
    usedBy: 'resume P1 的子会话枚举（P1 是当前唯一有实证的"有活没干完"信号：真数据命中 8 例）',
    remedy: '缺少 listChildren：P1 退到 header 派生的 childrenByParent 兜底；两条都不通则 P1 整层跳过（P0 不受影响，但"父已闭合 + 子被掐断"这类会话将无人接管）。',
  },
  {
    // 可选增强：仅用于 P1 子会话枚举的**对照审计**（两条路径都跑、差异入审计，再决定是否升级）。
    // 定级 informational ⇒ 缺失不计入缺口，与"它只是可选能力"的语义一致。
    id: 'subagents.listDescendants', group: '子代理', severity: 'low', informational: true,
    detect: (svc) => { const s = svc('subagents') || svc('subagent'); return !!s && typeof s.listDescendants === 'function' },
    usedBy: 'P1 子会话枚举的对照审计（内核原生返回带 parentId/depth 的整棵后代树）',
    remedy: '缺少 listDescendants：对照审计退化为单路径（listChildren + header 兜底），P1 功能不受影响。',
  },
  {
    id: 'sessionQuery.readSession', group: '会话', severity: 'medium',
    detect: (svc) => { const q = svc('sessionQuery'); return !!q && typeof q.readSession === 'function' },
    usedBy: 'taskkit 判定「会话当前 preset」（读 agent-preset/selected 事件）',
    remedy: '缺少 readSession：preset 判定会退化为只读 header，跨 preset 切换的会话恢复时可能挂错组合。',
  },
  {
    id: 'sessionQuery.readSurface', group: '会话', severity: 'low',
    detect: (svc) => { const q = svc('sessionQuery'); return !!q && typeof q.readSurface === 'function' },
    usedBy: 'email-bridge 取教练当日计划、taskkit 回执扫描',
    remedy: '缺少 readSurface：回执/内容抽取能力退化。',
  },
  {
    id: 'sessionQuery.listSessions', group: '会话', severity: 'medium',
    detect: (svc) => { const q = svc('sessionQuery'); return !!q && typeof q.listSessions === 'function' },
    usedBy: 'taskkit 目标会话解析/唤醒',
    remedy: '缺少 listSessions：按标题解析目标会话失效。',
  },
  {
    id: 'sessionProjections.register', group: '会话', severity: 'low',
    detect: (svc) => { const p = svc('sessionProjections'); return !!p && typeof p.register === 'function' },
    usedBy: 'agent preset 投影（agentPreset 键）',
    remedy: '缺少 sessionProjections：会话投影类能力不可用（不影响核心任务链路）。',
  },
  {
    // 2026-09-22 新增：resume 一级预筛降级链的**第 2 级**（尾帧 → lastPromptAt → createdAt）。
    // 真机实测 lastPromptAt 在 539 个会话上**一次都没命中**（全部退化成 createdAt），故它只是兜底，
    // 缺失影响很小 ⇒ severity 定 low。
    id: 'sessionProjectionCache.cachedSnapshot', group: '会话', severity: 'low',
    detect: (svc) => { const c = svc('sessionProjectionCache'); return !!c && typeof c.cachedSnapshot === 'function' },
    usedBy: 'resume 一级预筛降级链第 2 级（读 lastPromptAt）；主路径是尾帧，故非必需',
    remedy: '缺少 cachedSnapshot：降级链少一级（尾帧 → createdAt），因真机实测该级从未命中，实际影响可忽略。',
  },
  {
    id: 'workspaceRegistry', group: '会话', severity: 'low',
    detect: (svc) => { const w = svc('workspaceRegistry'); return !!w },
    usedBy: 'taskkit 归档/会话归属',
    remedy: 'adapter 作用域取不到 workspaceRegistry。提示性为主（低severity）：可能是「该服务不在 adapter scope」而非「宿主缺失」——以 inject 声明它的插件仍能正常取到。',
  },
]

/** 逐个探测并汇总 */
export function probeCapabilities(svc) {
  const items = []
  const gaps = []
  for (const cap of CAPABILITIES) {
    let ok = false
    let err = null
    try { ok = cap.detect(svc) === true } catch (e) { err = String(e && e.message || e) }
    const item = { id: cap.id, group: cap.group, ok, severity: cap.severity, usedBy: cap.usedBy }
    if (cap.informational) item.informational = true
    if (err) item.detectError = err
    if (!ok && !cap.informational) {   // informational 项缺失属预期，不计入缺口
      item.remedy = cap.remedy
      gaps.push(item)
    }
    items.push(item)
  }
  // 语义代次推导：现代子代理契约 vs 旧契约
  const hasModern = items.find((i) => i.id === 'subagents.registerProvider').ok
  const hasLegacy = items.find((i) => i.id === 'subagents.registerContinuableSetup').ok
  const subagentGeneration = hasModern && !hasLegacy ? 'modern(rc.1+)' : (hasLegacy ? 'legacy(alpha.x)' : 'unknown')
  return { items, gaps, subagentGeneration }
}

/** 定位 profile 根目录（用于读已装插件版本） */
export function detectProfileRoot(opts) {
  const o = opts || {}
  const home = detectDshHome({ dshHome: o.dshHome })
  if (!home.path) return { path: null, source: 'none' }
  const wanted = o.profile ? [String(o.profile)] : PROFILE_CANDIDATES
  for (const p of wanted) {
    const c = join(home.path, 'profiles', p)
    if (existsSync(c)) return { path: c, source: home.source + ':profiles/' + p }
  }
  return { path: null, source: home.source + ':no-profile' }
}

/**
 * 版本兼容判定：宿主版本 → 推荐插件版本 → 与已装版本比对
 */
export function evaluateCompat(opts) {
  const o = opts || {}
  const host = detectHost({ hostVersion: o.hostVersion })
  const matrix = o.matrix || loadMatrix()
  const profile = detectProfileRoot({ dshHome: o.dshHome, profile: o.profile })
  const out = {
    host: { version: host.version, source: host.source, dshPkgPath: host.dshPkgPath },
    profile: { path: profile.path, source: profile.source },
    matrix: matrix ? { schemaVersion: matrix.schemaVersion, updatedAt: matrix.updatedAt, hosts: matrix.hosts.map((h) => h.host) } : null,
    recommended: null,
    installed: {},
    versionWarnings: [],
    notes: [],
  }
  if (!matrix) {
    out.versionWarnings.push('兼容矩阵缺失（compat-matrix.json 未随包分发）→ 无法给出推荐插件版本')
    return out
  }
  // 宿主版本未知时不做推荐（避免用错误档位误导），只明确报告
  if (!host.version || host.version === 'unknown') {
    out.versionWarnings.push('宿主版本未能探测（source=' + host.source + '）→ 跳过推荐版本比对；可用 config.compat.hostVersion 显式指定')
    return out
  }
  // 1) 精确匹配宿主；否则取不高于当前版本的最近一档（避免用未来版本的建议误导）
  let entry = matrix.hosts.find((h) => h.host === host.version)
  if (!entry) {
    const lower = matrix.hosts.filter((h) => compareVer(h.host, host.version) <= 0).sort((a, b) => compareVer(b.host, a.host))[0]
    entry = lower || matrix.hosts[0]
    out.versionWarnings.push('宿主版本 ' + host.version + ' 不在矩阵中，已回退参考最近一档 ' + (entry && entry.host))
  }
  if (entry) {
    out.recommended = { host: entry.host, track: entry.track, notes: entry.notes || null, plugins: entry.plugins }
    // 2) 与已装版本比对
    for (const [pkg, want] of Object.entries(entry.plugins || {})) {
      const have = installedPluginVersion(profile.path, pkg)
      out.installed[pkg] = have
      if (!have) {
        out.versionWarnings.push(pkg + '：未安装（该宿主线推荐 ' + want + '）')
      } else if (compareVer(have, want) < 0) {
        out.versionWarnings.push(pkg + '：已装 ' + have + ' < 该宿主线推荐 ' + want + '（可升级）')
      } else if (compareVer(have, want) > 0) {
        out.versionWarnings.push(pkg + '：已装 ' + have + ' > 矩阵推荐 ' + want + '（该版本可能面向更新的宿主，注意核验）')
      }
    }
  }
  // 3) 宿主升级提示：存在更高 track=recommended-next 的档位时提示
  const next = matrix.hosts.find((h) => h.track === 'recommended-next')
  if (next && compareVer(next.host, host.version) > 0) {
    out.notes.push('存在推荐升级目标宿主 ' + next.host + '（配套插件：' + Object.entries(next.plugins).map(([k, v]) => k + '@' + v).join(', ') + '）')
  }

  // 4) **自研插件**的 engines.dsh 声明 vs 当前宿主版本
  //
  // 上面第 1~2 步只覆盖了 compat-matrix 里的**第三方**插件。自研插件（@local/*）
  // 在 2026-09-23 之前没有任何版本声明，所以这一整类从未被纳入判定 —— 补上声明后，
  // 这里把它们读出来逐一对齐宿主版本。
  //
  // ⚠️ 判定口径：本节只产出"声明是否匹配"这一**输入**，**不下最终结论**。
  //    最终结论在 evaluate() 里结合能力探针合成 —— 因为 adapter 存在的意义正是
  //    "宿主改 API 时业务插件零改动"，声明不匹配 ≠ 一定不可用。
  out.localPlugins = []
  if (profile.path) {
    for (const item of readLocalPluginEngines(profile.path)) {
      const sat = item.declared ? satisfiesEngine(item.declared, host.version) : null
      out.localPlugins.push({ name: item.name, declared: item.declared, satisfied: sat })
      if (sat === false) {
        out.versionWarnings.push(item.name + '：声明支持的宿主 "' + item.declared + '" 不含当前 ' + host.version + '（探针结论见 localPluginCompat）')
      } else if (sat === null) {
        out.versionWarnings.push(item.name + '：宿主声明 "' + (item.declared || '(缺失)') + '" 无法判定（不支持的版本语法，或没写 engines.dsh）')
      }
    }
    if (out.localPlugins.length === 0) {
      out.notes.push('profile 里没读到 @local/* 插件声明（可能尚未挂载，或该 profile 不含自研插件）')
    }
  }

  return out
}

/** 汇总入口：能力 + 版本，供 probe/HTTP/服务调用 */
export function evaluate(svc, opts) {
  const o = opts || {}
  const caps = probeCapabilities(svc)
  const compat = evaluateCompat(o)
  const highGaps = caps.gaps.filter((g) => g.severity === 'high')

  // adapter 的**跨版本兜底**判定：把"声明"与"探针实测"合起来看。
  //
  // 为什么不能只看声明：adapter 存在的意义就是"宿主改 API 时业务插件零改动"。
  // 所以插件声明 `0.1.5-rc.1` 而宿主是 `0.1.5-rc.2`，**可能仍然完全可用** ——
  // 只要它依赖的那些宿主能力在探针里都还在。反过来，若探针发现 high 级缺口，
  // 那就是真不可用，不能靠"声明写得宽"糊过去。
  //
  // 四种结论（措辞刻意区分"验证过"与"没验证过"，避免读的人把后者当前者）：
  //   declared-ok       声明与当前宿主匹配
  //   capabilities-ok   声明不匹配，但探针未发现 high 级缺口 ⇒ 可能可用（**未经实测**）
  //   capability-gaps   声明不匹配，且探针发现 high 级缺口 ⇒ 判定不可用
  //   undeclared        没有 engines.dsh 或语法不认识 ⇒ 无法判定（不是"通过"）
  const localPluginCompat = (compat.localPlugins || []).map((p) => {
    if (p.satisfied === true) return { ...p, verdict: 'declared-ok' }
    if (p.satisfied === null) return { ...p, verdict: 'undeclared' }
    return {
      ...p,
      verdict: highGaps.length ? 'capability-gaps' : 'capabilities-ok',
      note: highGaps.length
        ? '声明不匹配，且探针发现 high 级缺口：' + highGaps.map((g) => g.id).join(', ')
        : '声明不匹配，但探针未发现 high 级缺口 ⇒ 可能可用（未经实测，升级前必须冒烟）',
    }
  })

  return {
    capabilities: caps.items,
    capabilityGaps: caps.gaps,
    subagentGeneration: caps.subagentGeneration,
    compat,
    localPluginCompat,
    status: highGaps.length ? 'degraded' : (caps.gaps.length ? 'ok-with-notes' : 'ok'),
    highSeverityGaps: highGaps.map((g) => g.id),
  }
}

/** 启动/查询时的一行摘要（写日志用，便于升级前后对比） */
export function summaryLine(result) {
  const c = result.compat || {}
  const host = (c.host && c.host.version) || 'unknown'
  const track = (c.recommended && c.recommended.track) || '-'
  const gaps = (result.capabilityGaps || []).map((g) => g.id + '(' + g.severity + ')')
  const warns = (c.versionWarnings || []).length
  // 自研插件的声明比对结果也进摘要：不匹配的数量比具体是哪几个更重要（一眼看出漂移）
  const lp = result.localPluginCompat || []
  const lpBad = lp.filter((p) => p.verdict === 'capability-gaps' || p.verdict === 'undeclared').length
  const lpSoft = lp.filter((p) => p.verdict === 'capabilities-ok').length
  return 'host=' + host + ' track=' + track + ' subagents=' + result.subagentGeneration +
    ' gaps=' + (gaps.length ? gaps.join(',') : 'none') + ' versionWarnings=' + warns +
    ' localPlugins=' + lp.length + '(硬不匹配' + lpBad + '/探针兜底' + lpSoft + ')' +
    ' status=' + result.status
}
