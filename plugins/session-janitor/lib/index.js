// ============================================================================
// @local/session-janitor —— 会话治理插件（Host 侧）
//
// 目的：把 janitor 的动作做成**对话可调用**的工具（自研插件 + hotplug 白名单）。
//
// 执行位置原则（本插件的核心约束）：**重活本地做、远端只做受控窗口内的原子替换**。
//   · janitor_survey —— 服务器端轻量只读：只做 RFC8878 结构性帧解析 + 计数 + 分组 + 双口径预估。
//                       详见 lib/survey.js 文件头的「硬性内存纪律」。
//   · janitor_status —— 服务器端只读：回收区 / 归档清单 / 白名单状态 / sessions 计数 / 最近一次 survey 摘要。
//   · janitor_apply  —— **本轮仍只留骨架**：接收本地成品并原子应用（需停内核窗口）。骨架只注册 action 并明确返回"未实现"。
//   · janitor_restore —— **已实现**：从回收区恢复（需鉴权 + confirm）。
//   · janitor_reap_subagents —— **已实现（新增，R8+J5）**：agent 工作完成后清理**自己派生的**子代理（进回收区）。
//
// 注册三件套（缺一不可，见设计 R6）：
//   ① package.json 的 dsh.bundle.patch  → ② cordis.patch.yml 的 - insert  → ③ <DSH_HOME>/hotplug-manifest.yml 条目
//   （包还需 symlink 进 <profile>/node_modules）
//
// ⚠️ 插件层没有 ACL（自研插件全树无 isAdmin/role 门控）⇒ 破坏性动作靠**两级**把关：
//    ① **不可伪造的调用方身份**：工具路径用 `exec.agent.id`（由 agent loop 注入、模型改不了；见 R8 调查）；
//    ② **插件内二次确认**（沿用 miyoushe_enable 的 confirm:true 约定）；
//    ③ **HTTP 路径**（/janitor/api/*）**在插件内加一道共享 secret** —— 内核侧不带 cookie 也 200（J4 实测），
//       没有这道就等于把写能力暴露给"任何能连到内核端口的本机进程"。**未配 secret ⇒ HTTP 写路径一律拒绝（fail-closed）**。
//       secret 读取：`apply(ctx, config)` 的 `config.httpSecret`（manifest 条目里的 config JSON），或环境变量 DSH_JANITOR_HTTP_SECRET。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runSurvey, defaultSessionsRoot, defaultWorkspaceRoot, isSnapshotName } from './survey.js'
import { runReap, runRestore, inspectSession, authorize } from './reap.js'

// 硬依赖：tools（注册工具）/ fs / sandboxPolicy / webServer（HTTP 数据面）。
// 与 skill-center / knowledge-base / writing-coach / prompt-router 同款（设计 R6）。
// workspaceRegistry：janitor_attach_sessions 需要它拿 WorkspaceEntity（attachSession 挂在 entity 上）；
// 取不到时该工具 fail-closed 报 SERVICE_UNAVAILABLE，不影响其余工具。
const inject = ['tools', 'fs', 'sandboxPolicy', 'webServer', 'workspaceRegistry']

const PLUGIN_ID = 'session-janitor'
const API_PREFIX = '/janitor/api'
const TOOL_NAMES = ['janitor_survey', 'janitor_status', 'janitor_apply', 'janitor_restore', 'janitor_reap_subagents', 'janitor_attach_sessions']
const ARCHIVE_SUBDIR = ['记忆归档', '归档清单.json']
/** 写动作（本次 HTTP 面必须过 secret 的动作名） */
const HTTP_WRITE_ACTIONS = new Set(['apply', 'restore', 'reap', 'reap_subagents', 'attach_sessions'])

/**
 * HTTP 共享 secret 的读取（**只读，绝不回显值**）。
 * 优先级：
 *   ① `config.httpSecretFile` —— **推荐**：文件路径（如 <DSH_HOME>/_janitor/http-secret，权限 0600）
 *      ⇒ manifest 里只留路径、**不留 secret 明文**（manifest 是 0644，写明文等于半公开）
 *   ② `config.httpSecret` / `config.janitorSecret` —— 直接放在 config（manifest 里会存明文，次选）
 *   ③ 环境变量 `DSH_JANITOR_HTTP_SECRET`
 * 都没配 ⇒ 返回 null ⇒ HTTP 写路径一律拒绝（fail-closed）。
 * @returns {{secret: string|null, source: string|null}}
 */
function resolveHttpSecret(config) {
  const c = (config && typeof config === 'object') ? config : {}
  const fp = c.httpSecretFile
  if (typeof fp === 'string' && fp.trim()) {
    try {
      const v = fs.readFileSync(fp.trim(), 'utf8').trim()
      if (v) return { secret: v, source: 'file:' + fp.trim() }
      return { secret: null, source: 'file-empty:' + fp.trim() }
    } catch (e) { return { secret: null, source: 'file-unreadable:' + fp.trim() + '(' + _msg(e) + ')' } }
  }
  for (const k of ['httpSecret', 'janitorSecret']) {
    const v = c[k]
    if (typeof v === 'string' && v.trim()) return { secret: v.trim(), source: 'config:' + k }
  }
  const env = (process.env && process.env.DSH_JANITOR_HTTP_SECRET) || ''
  if (String(env).trim()) return { secret: String(env).trim(), source: 'env:DSH_JANITOR_HTTP_SECRET' }
  return { secret: null, source: null }
}

/** 常数时间比较（防时序侧信道）；长度不同也走一次 digest 比较 */
function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/** 进程内保留的最近一次 survey 摘要（survey 本体是只读的，不落盘） */
let lastSurveySummary = null
/** 记录本进程真正注册成功的工具（正面证据；只在 register() 返回后写入） */
const registeredTools = new Map() // name -> { at, hasDisposer }
/** 本实例的 HTTP secret（null = 未配置 ⇒ HTTP 写路径 fail-closed）；只存引用，不外泄值 */
let httpSecretRef = null
/** secret 来源描述（形如 file:/path 或 config:httpSecret 或 env:...；**不含值**） */
let httpSecretSource = null

const _msg = (e) => String((e && e.message) || e)
const logWarn = (ctx, msg) => {
  try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(msg); else if (process.stderr) process.stderr.write(msg + '\n') } catch (_) {}
}
const logInfo = (ctx, msg) => {
  try { const lg = ctx.get('logger'); if (lg && typeof lg.info === 'function') lg.info(msg); else if (process.stderr) process.stderr.write(msg + '\n') } catch (_) {}
}

/** dshHome：与 dsh-adapter 的 resolveDshHome 同源 */
function dshHome() {
  return (process.env && process.env.DSH_HOME) || '/srv/dsh-home'
}

/** 极简解析 hotplug-manifest.yml 的条目（本仓自己写、格式稳定），只取成对 id/path/enabled */
function parseManifestEntries(text) {
  const out = []
  let cur = null
  const unquote = (s) => {
    const t = String(s).trim()
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
    return t
  }
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    let m
    if ((m = line.match(/^-\s*id:\s*(.+)$/))) { if (cur) out.push(cur); cur = { id: unquote(m[1]), path: null, enabled: false, builtin: null } }
    else if (cur && (m = line.match(/^path:\s*(.+)$/))) cur.path = unquote(m[1])
    else if (cur && (m = line.match(/^enabled:\s*(.+)$/))) cur.enabled = m[1].trim() === 'true'
    else if (cur && (m = line.match(/^builtin:\s*(.+)$/))) cur.builtin = m[1].trim()
  }
  if (cur) out.push(cur)
  return out
}

/** 目录条目数/字节（一层，统计子目录数与所有文件字节） */
function dirStats(dir) {
  const r = { exists: false, dirs: 0, files: 0, bytes: 0, error: null }
  try {
    if (!fs.existsSync(dir)) return r
    r.exists = true
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) { r.dirs++; try { r.files += countFiles(path.join(dir, d.name), r) } catch (_) {} }
      else if (d.isFile()) { r.files++; try { r.bytes += fs.statSync(path.join(dir, d.name)).size } catch (_) {} }
    }
  } catch (e) { r.error = _msg(e) }
  return r
}
function countFiles(dir, acc) {
  let n = 0
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) n += countFiles(path.join(dir, d.name), acc)
    else if (d.isFile()) { n++; try { acc.bytes += fs.statSync(path.join(dir, d.name)).size } catch (_) {} }
  }
  return n
}

/** sessions/ 计数（只读；不解压）：会话目录数 / 会话文件数 / 字节 / lock 数 */
function countSessions(root) {
  const r = { root, exists: false, error: null, buckets: 0, sessionDirs: 0, files: 0, bytes: 0, locks: 0 }
  try {
    if (!fs.existsSync(root)) return r
    r.exists = true
    for (const b of fs.readdirSync(root, { withFileTypes: true })) {
      if (!b.isDirectory()) continue
      r.buckets++
      const bdir = path.join(root, b.name)
      for (const sd of fs.readdirSync(bdir, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue
        r.sessionDirs++
        const sdir = path.join(bdir, sd.name)
        let entries = []
        try { entries = fs.readdirSync(sdir, { withFileTypes: true }) } catch (_) { continue }
        for (const f of entries) {
          if (!f.isFile()) continue
          if (f.name === 'session.lock') r.locks++
          if (isSnapshotName(f.name)) { r.files++; try { r.bytes += fs.statSync(path.join(sdir, f.name)).size } catch (_) {} }
        }
      }
    }
  } catch (e) { r.error = _msg(e) }
  return r
}

/** 归档清单条目数（只读） */
function archiveManifest() {
  const p = path.join(defaultWorkspaceRoot(), ...ARCHIVE_SUBDIR)
  const r = { path: p, exists: false, error: null, entries: null }
  try {
    if (!fs.existsSync(p)) return r
    r.exists = true
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (Array.isArray(j)) r.entries = j.length
    else if (j && Array.isArray(j.entries)) r.entries = j.entries.length
    else if (j && typeof j === 'object') r.entries = Object.keys(j).length
  } catch (e) { r.error = _msg(e) }
  return r
}

// ---------------------------------------------------------------------------
// janitor_attach_sessions 的纯辅助（模块级；不依赖 ctx，便于单独复核）
// ---------------------------------------------------------------------------

/** 解析 sessionIds 参数：接受「逗号分隔字符串」/「JSON 数组字符串」/「数组」 */
function parseSessionIds(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  const s = String(v == null ? '' : v).trim()
  if (!s) return []
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean)
    } catch (_) { /* 落到逗号解析 */ }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** 在 sessions 根下按 id 定位会话目录（<root>/<bucket>/<id>）；找不到返回 null */
function findSessionDir(sessionsRoot, sessionId) {
  try {
    for (const d of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const cand = path.join(sessionsRoot, d.name, sessionId)
      try { if (fs.statSync(cand).isDirectory()) return cand } catch (_) { /* 下一个 bucket */ }
    }
  } catch (_) { /* 根不可读 ⇒ null */ }
  return null
}

/**
 * dryRun 只读预检：**照抄 attachSession 的校验顺序**
 * （读 header cwd → realpath → stat 是目录 → === workspace.path）。
 * header 优先走 registry.readSessionHeader（与 attachSession 同源）；
 * 不可用时退到本地解首帧 header（inspectSession）。**绝不写盘。**
 * @returns {Promise<{ok:true,cwd:string}|{ok:false,reason:string}>}
 */
async function precheckAttach(registry, wsPath, sessionId) {
  let cwd
  try {
    const header = await registry.readSessionHeader(sessionId)
    if (!header || header.cwd === undefined) return { ok: false, reason: 'header-cwd-missing(无 cwd 可校验)' }
    cwd = header.cwd
  } catch (e) {
    const dir = findSessionDir(defaultSessionsRoot(), sessionId)
    if (!dir) return { ok: false, reason: 'session-not-found: ' + _msg(e) }
    const info = inspectSession(dir)
    if (info.readError || info.headerError || !info.header) return { ok: false, reason: 'header-unreadable: ' + _msg(info.readError || info.headerError || 'no header') }
    if (info.header.cwd === undefined) return { ok: false, reason: 'header-cwd-missing(无 cwd 可校验)' }
    cwd = info.header.cwd
  }
  let real
  try { real = fs.realpathSync(cwd) } catch (e) { return { ok: false, reason: 'cwd-unresolvable: ' + _msg(e) } }
  let st
  try { st = fs.statSync(real) } catch (e) { return { ok: false, reason: 'cwd-stat-failed: ' + _msg(e) } }
  if (!st.isDirectory()) return { ok: false, reason: 'cwd-not-a-directory' }
  if (real !== wsPath) return { ok: false, reason: 'cwd-mismatch(resolves=' + real + ' workspace=' + wsPath + ')' }
  return { ok: true, cwd: real }
}

function statusPayload() {
  const home = dshHome()
  const sessions = countSessions(defaultSessionsRoot())
  const recycle = dirStats(path.join(home, '_janitor-recycle'))
  const archive = archiveManifest()
  let whitelist = { path: path.join(home, 'hotplug-manifest.yml'), exists: false, error: null, total: 0, enabled: 0, self: null }
  try {
    const wp = whitelist.path
    if (fs.existsSync(wp)) {
      whitelist.exists = true
      const entries = parseManifestEntries(fs.readFileSync(wp, 'utf8'))
      whitelist.total = entries.length
      whitelist.enabled = entries.filter((e) => e.enabled).length
      const self = entries.find((e) => e.id === PLUGIN_ID)
      whitelist.self = self ? { id: self.id, path: self.path, enabled: self.enabled, builtin: self.builtin } : null
    } else { whitelist.error = 'not found' }
  } catch (e) { whitelist.error = _msg(e) }

  // 最近一次 survey 摘要：优先进程内；否则读只读候选落盘文件
  let lastSurvey = { source: 'none', summary: null }
  if (lastSurveySummary) lastSurvey = { source: 'in-process', summary: lastSurveySummary }
  else {
    for (const p of [path.join(home, '_janitor', 'last-survey.json'), '/root/_janitor/survey-report.json']) {
      try {
        if (fs.existsSync(p)) {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'))
          const m = (j && (j.meta || j.meta === undefined)) ? (j.meta || {}) : {}
          lastSurvey = {
            source: 'on-disk:' + p,
            summary: {
              runAt: m.runAt || j.runAt || null, scanner: m.scanner || j.scanner || null,
              sessions: (j.totals && j.totals.sessions) || null,
              groups: j.groups ? Object.fromEntries(Object.entries(j.groups).map(([k, v]) => [k, v && v.sessions])) : null,
              cleanupCandidates: (j.cleanupCandidates && j.cleanupCandidates.count) ?? null,
            },
          }
          break
        }
      } catch (_) { /* 下一个候选 */ }
    }
  }

  const toolsSnap = toolRegistrySnapshot()
  // 写路径鉴权姿态（**只报布尔，不回显 secret 值**）
  const writeAuth = {
    httpSecretConfigured: !!httpSecretRef,
    httpSecretSource: httpSecretSource, // 只报来源（路径/键名），**不含值**
    httpWriteActions: [...HTTP_WRITE_ACTIONS],
    httpWriteEnabled: !!httpSecretRef,
    toolPathIdentity: 'exec.agent.id（不可伪造；见 R8）',
    failClosed: true,
    note: httpSecretRef
      ? 'HTTP 写路径已启用（需 x-janitor-token 头或 body.token，且需 confirm:true 才真做）'
      : 'HTTP 写路径**未配置 secret ⇒ 一律拒绝**（fail-closed）；请设置 manifest config.httpSecretFile 或 config.httpSecret',
  }
  return {
    ok: true, plugin: PLUGIN_ID, ts: Date.now(),
    sessions,
    recycle: { path: path.join(home, '_janitor-recycle'), ...recycle },
    archive,
    whitelist,
    lastSurvey,
    writeAuth,
    registeredTools: [...registeredTools.entries()].map(([name, v]) => ({ name, ...v })),
    toolRegistrySnapshot: toolsSnap,
    note: 'janitor_apply 本轮仍为骨架（未实现危险逻辑）；janitor_restore / janitor_reap_subagents 已实现。',
  }
}

/**
 * 正面证据（尽力而为，**绝不把"枚举不到"当成"没注册"**）：
 * 宿主 tools 服务**没有**公开的 list()/names() —— skill-center 只能 register()，
 * 上游 taskkit 也只好用内部 layers 兜底（版本相关、非公开 API）。这里只在**真的看到 janitor_*** 时
 * 才报 reliable:true；否则明确报 reliable:false + 原因，让调用方以「journal 注册行」与
 * `registeredTools`（由 register() 真实返回值记录）为准。
 */
function toolRegistrySnapshot() {
  try {
    const svc = registryToolsSvc
    if (!svc) return { reliable: false, reason: 'tools 服务不可用（无法 enumerate）' }
    const names = new Set()
    const layers = svc.layers
    if (layers && typeof layers === 'object') {
      for (const lk of Object.keys(layers)) {
        const layer = layers[lk]
        const t = layer && layer.tools
        if (!t) continue
        const bag = (t._map instanceof Map && t._map) || (t._entries instanceof Map && t._entries) || (t instanceof Map && t) || null
        if (bag) { for (const k of bag.keys()) names.add(String(k)); continue }
        if (typeof t === 'object') for (const k of Object.keys(t)) names.add(k)
      }
    }
    const all = [...names]
    const janitor = all.filter((n) => n.indexOf('janitor_') === 0).sort()
    if (janitor.length) return { reliable: true, total: all.length, janitor }
    return {
      reliable: false,
      reason: '宿主 tools 未公开 list()；内部 layers 枚举未反映注册表（probedTotal 不代表真实工具数，不能据此判断"未注册"）',
      probedTotal: all.length,
    }
  } catch (e) { return { reliable: false, reason: 'enumerate failed: ' + _msg(e) } }
}

/** 注册期把 tools 服务存下来供 toolRegistrySnapshot 用（惰性、防御式） */
let registryToolsSvc = null

export function apply(ctx, config) {
  // ============ 0) HTTP secret（config → env；没配 = null ⇒ 写路径 fail-closed） ============
  const secretInfo = resolveHttpSecret(config)
  httpSecretRef = secretInfo.secret
  httpSecretSource = secretInfo.source
  logInfo(ctx, `[session-janitor] http write auth: ${httpSecretRef ? 'ENABLED（secret 来源 ' + httpSecretSource + '，值不外泄）' : 'DISABLED（未配 secret ⇒ HTTP 写路径一律拒绝；来源=' + (httpSecretSource || 'none') + '）'}`)

  // ============ 1) 工具注册（与 skill-center 同构） ============
  const toolsSvc = ctx.get('tools')
  const register = (name, def) => {
    try {
      const t = Object.assign({}, def, {
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => [{ type: 'text', text: (value && typeof value.summary === 'string') ? value.summary : JSON.stringify(value) }],
          presentationMeta: (args, value) => (value && typeof value === 'object' ? value : {}),
        },
      })
      const d = toolsSvc.register(defineTool(t))
      registeredTools.set(name, { at: new Date().toISOString(), hasDisposer: typeof d === 'function' })
      const cleanup = ctx.effect(() => function __janitorToolCleanup() {
        try { if (typeof d === 'function') d() } catch (_) { /* ignore */ }
        registeredTools.delete(name)
      })
      void cleanup
      return true
    } catch (e) {
      // 注册失败必须可观测（空 catch 曾让工具长期静默不可见）
      logWarn(ctx, `[session-janitor] ${name} register failed: ${_msg(e && e.stack ? e : e)}`)
      return false
    }
  }

  /**
   * janitor_attach_sessions：把会话**登记**进某个 workspace 的 `sessionIds`。
   * 🔴 只 attach、**永不 detach**（绝不调 detachSession）；幂等；不唤醒会话、不动 sessions/ 文件。
   *
   * 流程：① authorize() 鉴权 → ② 取 workspaceRegistry（取不到 ⇒ SERVICE_UNAVAILABLE，fail-closed）
   *   → ③ resolve workspace（显式 workspaceId 优先，缺省退 list()[0]；空/找不到 ⇒ WORKSPACE_NOT_FOUND）
   *   → ④ 逐条：已在册 ⇒ skipped 'already-attached'；dryRun ⇒ 只读预检；真做 ⇒ await ws.attachSession(id) 逐条 try/catch。
   */
  async function attachSessions(opts) {
    const o = opts || {}
    const dryRun = o.dryRun !== false
    const confirm = o.confirm === true
    const ids = parseSessionIds(o.sessionIds)
    const rep = {
      ok: false, action: 'attach_sessions',
      workspaceId: (o.workspaceId ? String(o.workspaceId) : null),
      dryRun, confirm, attached: [], skipped: [], wouldAttach: [], wouldReject: [], failed: [],
    }
    const finish = (code, message) => {
      if (code) { rep.code = code; rep.message = message }
      rep.summary = `janitor_attach_sessions(${dryRun ? 'dryRun' : 'REAL'}) workspace=${rep.workspaceId || '?'} requested=${ids.length}` +
        ` attached=${rep.attached.length} skipped=${rep.skipped.length} wouldAttach=${rep.wouldAttach.length} wouldReject=${rep.wouldReject.length} failed=${rep.failed.length}` +
        ` sessionIdsNow=${rep.sessionIdsNow == null ? '?' : rep.sessionIdsNow}` + (code ? ` code=${code}` : '')
      return rep
    }

    if (!ids.length) return finish('IDS_REQUIRED', 'IDS_REQUIRED：必须给 sessionIds（逗号分隔或 JSON 数组）')

    // ① 鉴权（唯一入口 authorize()）
    const auth = authorize({ callerSessionId: o.callerSessionId, httpAuthorized: o.httpAuthorized, parentSessionId: null })
    if (!auth.ok) { rep.authVia = auth.via; return finish(auth.code, auth.message) }
    rep.authVia = auth.via
    // dryRun:false 必须 confirm:true（与 reap/restore 同惯例）
    if (!dryRun && !confirm) return finish('CONFIRM_REQUIRED', 'CONFIRM_REQUIRED：dryRun:false 必须同时 confirm:true')

    // ② 取 registry（取不到 ⇒ fail-closed，不静默当空）
    let registry = null
    try { registry = ctx.get('workspaceRegistry') } catch (_) { registry = null }
    if (!registry || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
      return finish('SERVICE_UNAVAILABLE', 'SERVICE_UNAVAILABLE：workspaceRegistry 服务不可用 ⇒ 拒绝（fail-closed）')
    }

    // ③ resolve workspace
    let ws = null
    if (o.workspaceId) {
      ws = registry.get(String(o.workspaceId))
      if (!ws) return finish('WORKSPACE_NOT_FOUND', 'WORKSPACE_NOT_FOUND：找不到 workspaceId=' + String(o.workspaceId))
    } else {
      let list = []
      try { list = registry.list() || [] } catch (e) { return finish('SERVICE_UNAVAILABLE', 'SERVICE_UNAVAILABLE：workspaceRegistry.list() 失败: ' + _msg(e)) }
      if (!list.length) return finish('WORKSPACE_NOT_FOUND', 'WORKSPACE_NOT_FOUND：registry.list() 为空')
      ws = list[0]
    }
    rep.workspaceId = (ws.id !== undefined && ws.id !== null) ? String(ws.id) : rep.workspaceId
    const wsPath = String(ws.path)
    rep.workspacePath = wsPath
    const rawRecord = (ws.record && Array.isArray(ws.record.sessionIds)) ? ws.record.sessionIds : (Array.isArray(ws.sessionIds) ? ws.sessionIds : [])
    const present = new Set(rawRecord.map((x) => String(x)))

    // ④ 逐条
    for (const id of ids) {
      if (present.has(id)) { rep.skipped.push({ sessionId: id, reason: 'already-attached' }); continue }
      if (dryRun) {
        const pc = await precheckAttach(registry, wsPath, id)
        if (pc.ok) rep.wouldAttach.push({ sessionId: id, cwd: pc.cwd })
        else rep.wouldReject.push({ sessionId: id, reason: pc.reason })
        continue
      }
      try {
        await ws.attachSession(id)
        present.add(id)
        rep.attached.push({ sessionId: id })
      } catch (e) {
        rep.failed.push({ sessionId: id, error: _msg(e) })
      }
    }

    rep.sessionIdsNow = (ws.record && Array.isArray(ws.record.sessionIds)) ? ws.record.sessionIds.length : null
    rep.ok = true
    return finish(null, null)
  }

  if (!toolsSvc || typeof toolsSvc.register !== 'function') {
    logWarn(ctx, '[session-janitor] tools 服务不可用：4 个 action 未能注册')
  } else {
    registryToolsSvc = toolsSvc

    register('janitor_survey', {
      name: 'janitor_survey',
      description: '【只读】会话治理巡检：对 <DSH_HOME>/sessions 做 RFC8878 结构性帧解析 + 计数 + 分组（G-A…G-F）+ 双口径预估（total/indexSize vs sources.tail/帧数）。**服务器端轻量版**：内容信号扫描默认关闭（内容级判定需本地补），仅对 frames<=2 的会话整会话解压（它们很小）；任何解压都受帧级预算与会话级预算约束 —— 这是为了避免"逐帧全量解压"把服务器 RSS 顶爆（J1 实测 1.04 GB）。返回值含本次调用实测的进程 RSS。',
      parameters: {
        ageDays: { type: 'number', description: '算"超期"的天数阈值；省略即 30' },
        limit: { type: 'number', description: '只扫前 N 个会话目录（自检用）；省略即 0=全量' },
        sessionsRoot: { type: 'string', description: 'sessions 根；省略即 <DSH_HOME>/sessions' },
        contentProbe: { type: 'boolean', description: '省略即 false；为 true 时对全部会话做内容扫描（服务端**不建议**，RSS 会显著上升）' },
      },
      execute: async (args) => {
        const a = args || {}
        const rep = await runSurvey({
          sessionsRoot: a.sessionsRoot ? String(a.sessionsRoot) : undefined,
          ageDays: a.ageDays, limit: a.limit, contentProbe: a.contentProbe === true,
        })
        if (!rep.ok) return { ok: false, error: rep.error, sessionsRoot: rep.sessionsRoot, summary: `survey 失败: ${rep.error}` }
        const g = rep.groups
        lastSurveySummary = {
          runAt: rep.meta.runAt, sessions: rep.totals.sessions, frames: rep.totals.framesMerged, bytes: rep.totals.bytes,
          groups: Object.fromEntries(Object.keys(g).map((k) => [k, g[k].sessions])),
          cleanupCandidates: rep.cleanupCandidates.count, contentLevel: rep.contentLevel.status,
          rssPeakMB: rep.process.rssPeakMB, rssDeltaPeakMB: rep.process.rssDeltaPeakMB, durationSec: rep.meta.durationSec,
        }
        const summary = [
          `janitor_survey（只读，结构性）: sessions=${rep.totals.sessions} files=${rep.totals.files} bytes=${rep.totals.bytes} frames=${rep.totals.framesMerged}（活日志口径 ${rep.totals.framesActiveOnly}）`,
          `分组: G_A=${g.G_A.sessions} G_B=${g.G_B.sessions} G_C=${g.G_C.sessions} G_F=${g.G_F.sessions} G_C_or_F=${g.G_C_or_F.sessions} G_D=${g.G_D.sessions} G_E=${g.G_E.sessions}`,
          `可清理纯空壳(G_A)=${rep.cleanupCandidates.count}（bytes=${g.G_A.bytes} frames=${g.G_A.frames}）`,
          `双口径: total ${rep.estimate.beforeRemoveGA.total}→${rep.estimate.afterRemoveGA.total} / sources.tail ${rep.estimate.beforeRemoveGA.sourcesTail}→${rep.estimate.afterRemoveGA.sourcesTail} / frames ${rep.estimate.beforeRemoveGA.frames}→${rep.estimate.afterRemoveGA.frames}`,
          `内容级判定=${rep.contentLevel.status}（needs-local ${rep.contentLevel.needsLocalSessions} 条需本地补）`,
          `本进程 RSS: before=${rep.process.rssBeforeMB}MB peak=${rep.process.rssPeakMB}MB after=${rep.process.rssAfterMB}MB（增量峰值 ${rep.process.rssDeltaPeakMB}MB）dur=${rep.meta.durationSec}s`,
        ].join('\n')
        return Object.assign({ summary }, rep)
      },
    })

    register('janitor_status', {
      name: 'janitor_status',
      description: '【只读】会话治理状态：回收区 _janitor-recycle 的目录数/字节、归档清单（记忆归档/归档清单.json）条目数、白名单里 session-janitor 的 enabled 状态、sessions/ 当前计数（会话目录/文件/字节/lock）、以及最近一次 survey 的结果摘要（进程内或只读落盘候选）。',
      parameters: {},
      execute: async () => {
        const p = statusPayload()
        const wl = p.whitelist
        const summary = [
          `janitor_status: sessions(dir=${p.sessions.sessionDirs} files=${p.sessions.files} bytes=${p.sessions.bytes} locks=${p.sessions.locks})`,
          `whitelist(total=${wl.total} enabled=${wl.enabled}) self=${wl.self ? JSON.stringify(wl.self) : 'not-found'}`,
          `recycle(dir=${p.recycle.dirs} files=${p.recycle.files} bytes=${p.recycle.bytes}) archive(${p.archive.exists ? 'entries=' + p.archive.entries : 'absent'})`,
          `lastSurvey=${p.lastSurvey.source} registeredTools=${p.registeredTools.map((t) => t.name).join(',') || '(none)'} registrySnapshot=${p.toolRegistrySnapshot && p.toolRegistrySnapshot.reliable ? JSON.stringify(p.toolRegistrySnapshot.janitor) : 'unreliable(以 registeredTools/journal 注册行为准)'}`,
        ].join('\n')
        return Object.assign({ summary }, p)
      },
    })

    // ---- 骨架：破坏性动作（本轮不实现危险逻辑）----
    register('janitor_apply', {
      name: 'janitor_apply',
      description: '【写·骨架，本轮未实现】接收本地产出的"待应用成品"（md 归档 + 引用文件 + 清理后的会话集），在**停内核窗口**内做一次原子替换。⚠ 本轮只注册 action：无论传什么，都返回 NOT_IMPLEMENTED（不执行任何写操作）。破坏性动作需显式二次确认。',
      parameters: {
        plan: { type: 'object', additionalProperties: true, description: '本地成品清单（本轮不消费）' },
        dryRun: { type: 'boolean', description: '省略即 true；为 false 才可能进入真实应用（本轮恒未实现）' },
        confirm: { type: 'boolean', description: '省略即 false；破坏性动作需显式二次确认（沿用 miyoushe_enable 的 confirm:true 约定）' },
      },
      execute: async (args) => {
        const a = args || {}
        const base = {
          ok: false, action: 'janitor_apply', implemented: false, code: 'NOT_IMPLEMENTED',
          dryRun: a.dryRun !== false, confirm: a.confirm === true,
          message: '本轮为骨架：janitor_apply 的危险逻辑（停内核窗口内的原子替换）未实现。请先用 janitor_survey 出清单，并等待本地成品链路就绪。',
        }
        base.summary = `janitor_apply: NOT_IMPLEMENTED（骨架）dryRun=${base.dryRun} confirm=${base.confirm}`
        return base
      },
    })

    register('janitor_restore', {
      name: 'janitor_restore',
      description: '【写·已实现】从回收区（_janitor-recycle）把会话搬回 <sessions>/<bucket>/<id>，并逐文件 sha256 与账本比对。鉴权：工具路径要求有 exec.agent（调用方身份），且 dryRun:false 必须 confirm:true；HTTP 路径（/janitor/api/restore）额外要求 x-janitor-token。默认 dryRun:true（只报计划，不动文件）。',
      parameters: {
        sessionIds: { type: 'string', description: '要恢复的会话 id，逗号分隔（必填）' },
        bucket: { type: 'string', description: '目标 bucket 名；省略则用账本里记录的 bucket（且仅当 sessions 下只有一个 bucket 时可省略）' },
        sessionsRoot: { type: 'string', description: 'sessions 根；省略即 <DSH_HOME>/sessions' },
        dryRun: { type: 'boolean', description: '省略即 true（只报计划）' },
        confirm: { type: 'boolean', description: '省略即 false；dryRun:false 时必须为 true' },
      },
      execute: async (args, exec) => {
        const a = args || {}
        const callerSessionId = (exec && exec.agent && exec.agent.id) ? String(exec.agent.id) : ''
        const rep = runRestore({
          sessionIds: a.sessionIds, bucket: a.bucket ? String(a.bucket) : undefined,
          sessionsRoot: a.sessionsRoot ? String(a.sessionsRoot) : undefined,
          dryRun: a.dryRun !== false, confirm: a.confirm === true,
          callerSessionId, httpAuthorized: false,
        })
        return rep
      },
    })

    register('janitor_reap_subagents', {
      name: 'janitor_reap_subagents',
      description: '【写·已实现】agent 工作完成后清理**自己派生的子代理**：只清「调用方自己派生的 ∧ 已闭合（turn/end ∈ {completed,error}）∧ 无 session.lock ∧ 非主会话」的子会话，**rename 进回收区**（不是 rm，可 janitor_restore 复原）。护栏：主会话绝不动；别人的子会话绝不动（parentSession 必须 == 调用方会话 id，工具路径的调用方身份取自 exec.agent.id —— 不可伪造）；证不出"已完成"就不动（fail-closed）。默认 dryRun:true 只报清单；dryRun:false 必须 confirm:true。',
      parameters: {
        parentSessionId: { type: 'string', description: '父会话 id；省略即取调用方自己的 exec.agent.id' },
        sessionsRoot: { type: 'string', description: 'sessions 根；省略即 <DSH_HOME>/sessions（自检可指向隔离目录）' },
        olderThanMinutes: { type: 'number', description: '只清"最后活跃早于 N 分钟前"的子会话；省略即 0=不限' },
        dryRun: { type: 'boolean', description: '省略即 true（只报清单，不动文件）' },
        confirm: { type: 'boolean', description: '省略即 false；dryRun:false 时必须为 true' },
      },
      execute: async (args, exec) => {
        const a = args || {}
        const callerSessionId = (exec && exec.agent && exec.agent.id) ? String(exec.agent.id) : ''
        const parentSessionId = a.parentSessionId ? String(a.parentSessionId) : callerSessionId
        const rep = runReap({
          parentSessionId, sessionsRoot: a.sessionsRoot ? String(a.sessionsRoot) : undefined,
          olderThanMinutes: a.olderThanMinutes, dryRun: a.dryRun !== false, confirm: a.confirm === true,
          callerSessionId, httpAuthorized: false,
        })
        return rep
      },
    })

    register('janitor_attach_sessions', {
      name: 'janitor_attach_sessions',
      description: '【写·已实现·只加不删】把会话**登记**进某个 workspace 的 `sessionIds`（UI 工作区分组），走内核 `WorkspaceEntity.attachSession()`。**只 attach、永不 detach**。逐条前置校验照抄 attachSession（读会话 header 的 cwd → realpath → 是目录 → 必须 === workspace.path），不满足就拒。幂等：已在册 ⇒ skipped already-attached（不落盘不发事件）。默认 dryRun:true（只报 wouldAttach/wouldReject，**绝不写**）；dryRun:false 必须 confirm:true。鉴权：工具路径要求有 exec.agent（调用方身份）；HTTP 路径（/janitor/api/attach_sessions）额外要求共享 secret。⚠ attachSession 会重写 workspace.json 并重过滤整个 sessionIds（cwd 对不上的 id 会被连带剔除）。',
      parameters: {
        sessionIds: { type: 'string', description: '要登记的会话 id：逗号分隔 或 JSON 数组字符串（必填）', required: true },
        workspaceId: { type: 'string', description: '目标 workspace id；省略即 registry.list()[0]' },
        dryRun: { type: 'boolean', description: '省略即 true（只读预检，不写盘）' },
        confirm: { type: 'boolean', description: '省略即 false；dryRun:false 时必须为 true' },
      },
      execute: async (args, exec) => {
        const a = args || {}
        const callerSessionId = (exec && exec.agent && exec.agent.id) ? String(exec.agent.id) : ''
        return await attachSessions({
          sessionIds: a.sessionIds, workspaceId: a.workspaceId ? String(a.workspaceId) : undefined,
          dryRun: a.dryRun !== false, confirm: a.confirm === true,
          callerSessionId, httpAuthorized: false,
        })
      },
    })

    const names = [...registeredTools.keys()]
    logInfo(ctx, `[session-janitor] tools registered: ${names.join(',') || '(none)'}（期望 ${TOOL_NAMES.join(',')}）`)
  }

  // ============ 2) HTTP 数据面 /janitor/api ============
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const apiHandler = (req, res) => {
      const send = (status, obj) => {
        try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) } catch (_) {}
      }
      let u
      try { u = new URL(req.url || '/', 'http://x') } catch (_) { return send(400, { ok: false, error: 'BAD_URL' }) }
      const parts = u.pathname.split('/').filter(Boolean) // [janitor, api, action]
      if (parts[0] !== 'janitor' || parts[1] !== 'api') return send(404, { ok: false, error: 'not found' })
      const action = parts[2] || ''
      /**
       * HTTP 写路径的最后一道闸（内核侧零入站鉴权，J4 实测不带 cookie 也 200）：
       *   · 未配 secret ⇒ 503 fail-closed
       *   · 带了但不对 ⇒ 401
       * 呈现方式：`x-janitor-token` 头 或 body 的 `token` 字段。
       */
      const gateWriteAction = (args) => {
        const presented = (req.headers && (req.headers['x-janitor-token'] || req.headers['X-Janitor-Token'])) || (args && args.token) || ''
        if (!httpSecretRef) return { status: 503, body: { ok: false, code: 'WRITE_DISABLED_NO_SECRET', message: 'HTTP 写路径未配置 secret ⇒ 拒绝（fail-closed）。请在 manifest 的 config.httpSecret 配置。' } }
        if (!presented || !timingSafeEqualStr(presented, httpSecretRef)) return { status: 401, body: { ok: false, code: 'BAD_TOKEN', message: 'x-janitor-token 缺失或不匹配（值不外泄）' } }
        return null
      }
      let body = ''
      const done = async () => {
        let args = {}
        if (body) { try { args = JSON.parse(body) } catch (_) { args = {} } }
        try {
          if (action === 'ping') return send(200, { ok: true, plugin: PLUGIN_ID, ts: Date.now(), registeredTools: [...registeredTools.keys()], toolRegistrySnapshot: toolRegistrySnapshot() })
          if (action === 'status') return send(200, statusPayload())
          if (action === 'survey') {
            const rep = await runSurvey({ sessionsRoot: args.sessionsRoot ? String(args.sessionsRoot) : undefined, ageDays: args.ageDays, limit: args.limit, contentProbe: args.contentProbe === true })
            if (!rep.ok) return send(502, { ok: false, error: rep.error })
            lastSurveySummary = { runAt: rep.meta.runAt, sessions: rep.totals.sessions, frames: rep.totals.framesMerged, bytes: rep.totals.bytes, groups: Object.fromEntries(Object.keys(rep.groups).map((k) => [k, rep.groups[k].sessions])), cleanupCandidates: rep.cleanupCandidates.count, contentLevel: rep.contentLevel.status, rssPeakMB: rep.process.rssPeakMB, rssDeltaPeakMB: rep.process.rssDeltaPeakMB, durationSec: rep.meta.durationSec }
            return send(200, rep)
          }
          // ---- 写动作：先过 secret 闸 ----
          if (HTTP_WRITE_ACTIONS.has(action)) {
            const denied = gateWriteAction(args)
            if (denied) return send(denied.status, denied.body)
            if (action === 'apply') {
              return send(501, { ok: false, action: 'janitor_apply', implemented: false, code: 'NOT_IMPLEMENTED', message: '本轮仍为骨架：janitor_apply 的危险逻辑（停内核窗口内的原子替换）未实现。' })
            }
            if (action === 'restore') {
              return send(200, runRestore({
                sessionIds: args.sessionIds, bucket: args.bucket ? String(args.bucket) : undefined,
                sessionsRoot: args.sessionsRoot ? String(args.sessionsRoot) : undefined,
                dryRun: args.dryRun !== false, confirm: args.confirm === true, httpAuthorized: true,
              }))
            }
            if (action === 'attach_sessions') {
              return send(200, await attachSessions({
                sessionIds: args.sessionIds, workspaceId: args.workspaceId ? String(args.workspaceId) : undefined,
                dryRun: args.dryRun !== false, confirm: args.confirm === true,
                callerSessionId: '', httpAuthorized: true,
              }))
            }
            // reap / reap_subagents
            return send(200, runReap({
              parentSessionId: args.parentSessionId, sessionsRoot: args.sessionsRoot ? String(args.sessionsRoot) : undefined,
              olderThanMinutes: args.olderThanMinutes, dryRun: args.dryRun !== false, confirm: args.confirm === true,
              httpAuthorized: true,
            }))
          }
          return send(404, { ok: false, error: 'unknown action: ' + action, actions: ['ping', 'status', 'survey', 'reap_subagents', 'restore', 'apply', 'attach_sessions'] })
        } catch (e) { send(500, { ok: false, error: _msg(e) }) }
      }
      req.on('data', (c) => { body += c })
      req.on('end', done)
      req.on('error', () => { try { res.end('') } catch (_) {} })
    }
    try {
      ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }))
    } catch (e) {
      logWarn(ctx, '[session-janitor] api register failed: ' + _msg(e))
    }
  } else {
    logWarn(ctx, '[session-janitor] webServer 服务不可用：/janitor/api 路由未注册')
  }
}

export { inject }
export { TOOL_NAMES }
