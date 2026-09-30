// Host：全能写作工作台 @local/writing-studio
// 统一入口：写作/灵感库/创作资源/训练成果 子模块切换（client 侧）
// 数据自含：host 半用 fs 直接读取工作区文件（写作记录/灵感库/日程/草稿），不依赖 taskkit
//   ⚠️ 例外：relations 的**数据源是 taskkit**（U-7 / T1a，2026-09-28）——
//      读写均走 /taskkit/api/relations/{list,update,delete}，本插件不再自持 写作训练/relations.json。
//   端点：/writing-studio/api/ping | insp | inspUpdate | relations(overview/byInsp/byDraft/byDate/attach/detach) | training | overview
//         + 方向 B（2026-08-30，additive）：upload（B5 对话上传文件落盘）/ flow（B4 心流反馈）/ milestones（B4 里程碑）
//         + U-37（2026-09-27，additive）：draft-save（按相对路径保存草稿，白名单 写作训练/草稿/**.md）
import { defineTool } from '@deepseek-ai/dsh-tools'
// U-37：draft-save 的**纯校验/决策逻辑**独立成无宿主依赖模块（可本地真测试）；
// 本文件只做「读路由参数 → 调纯模块 → 写盘 → 返回 JSON」的薄接线（契约 = 计划 §2）。
import { validateRelPath, decideWrite, checkSize, versionOf } from './draft-save-core.js'
// C11（2026-09-29 additive）：多端文档同步的**纯校验/决策逻辑**（同 draft-save-core 口径：零宿主依赖 ⇒ 可本地真测试）。
// 契约 = docs/superpowers/plans/2026-09-29-multidevice-doc-sync-design.md §4。
import {
  DRAFT_ROOT, TOMBSTONE_FILE_NAME, innerRelOf, wsRelOf, hasDotSegment, trashInnerRelOf,
  normalizeTombstones, putTombstone, getTombstone, tombstoneList, decideDelete,
  buildListItem, wordCount, isoOf,
} from './draft-sync-core.js'
// U-7 / T1a：relations 走 taskkit 后的**形状适配/失败判定/参数映射**纯逻辑（本地可真单测）。
import {
  TASKKIT_RELATIONS_LIST,
  TASKKIT_RELATIONS_UPDATE,
  TASKKIT_RELATIONS_DELETE,
  responseFailed,
  adaptRelationsDoc,
  buildAttachPayload
} from './relations-core.js'
// U-45 / W-B（2026-09-29 additive）：`文档索引.json` 的**纯逻辑**（upsert / 三方对照 / updatedAt 刷新）。
// 端点：/writing-studio/api/{indexUpsert,indexRebuild}。
// 🔴 红线（设计 §3.2 写死）：rebuild **只**补新增候选 / **只报**缺失 / **只重算** updatedAt；
//    已填的 work/type/tags/zone/links/status **绝不覆盖**；missingOnDisk **绝不自动删**；新增默认**只报不建**。
import {
  INDEX_ACTIONS, INDEX_MAX_DEPTH,
  shouldSkipName, scanRootsFromEntries, upsertEntry, diffIndex,
  formatMtime, refreshUpdatedAt, deriveEntry
} from './index-sync-core.js'
// U-41 / P2（2026-09-29 additive）：客户端「提交」的纯逻辑（区域常量 / 目标归一 / 归档同名检测 / 「替代」关联 / 提交记录）。
// 契约：docs/superpowers/plans/2026-09-29-client-zone-and-shared-progress-design.md §2.2 / **§2.4**（已归档同名件 ⇒ 甲案）。
import {
  CLIENT_LOG_REL, CLIENT_ZONE_REL, ARCHIVE_PREFIX,
  normalizeSubmitTarget, findArchivedSiblings, withSupersede, withOriginSource,
  buildSubmitLogRow, decideSubmitWrite, archivePathOf
} from './submit-core.js'
// U-41 / P3 前置（2026-09-29 additive）：**客户端区读写通道**的纯逻辑（路径归一 / 覆盖决策 / 软删落点）。
// 契约：同设计文档 **§2.5**（客户端只能经 HTTP 访问服务器 ⇒ 「在客户端区内任意读写」必须由端点族承载）。
import {
  CZ_ACTIONS,
  normalizeClientZonePath, normalizeClientZonePrefix, recycleRelOf,
  decideClientZoneWrite, czVersion
} from './client-zone-core.js'
// U-41 / P5（2026-09-29 additive）：**规范体检**的纯逻辑（索引/灵感库/归档断链/规范件同源）。
// 🔴 全程只用它做**只读判定**；IO 由 doSpecAudit 薄接线。契约见 evidence/2026-09-29-window-u41-p5/DESIGN.md
import {
  auditIndex, auditInsp, auditSettingsRef, auditArchiveLinks,
  extractBetween, compareSpec, buildReport,
  extractByLineAnchors, extractFindSpec, extractWriteSpec, formatAuditLines
} from './spec-audit-core.js'

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer',
  'sessionQuery'
]

// 工作区数据根（O5 迁移：盘符/根路径不再出现在本插件）
// 根名与 profile `cordis.yml` 中 `@local/dsh-adapter.config.adapter.roots` 的登记一致（写作训练 / 全局数据 / 记忆归档）；
// 本插件只持"根内相对引用"，绝对路径一律由 adapterFs 解析（对外 payload 与 node:fs 直用处按需取 displayPath）。
const ROOT_TRAIN = '写作训练'
const ROOT_DATA = '全局数据'
const ROOT_ARCHIVE = '记忆归档'

const WRITING_RECORD_REL = '写作记录.json'
const SCHEDULE_PLAN_REL = '日程计划.json'
const SCHEDULE_DONE_REL = '日程完成.json'
const DRAFT_DIR_REL = '草稿'
const INSP_LIB_REL = '灵感库/灵感库.json'
// RELATIONS_REL 已删除（U-7 / T1a，2026-09-28）：relations 不再自持 写作训练/relations.json，
// 权威表 = taskkit 的 写作训练/草稿/relations.json（经 /taskkit/api/relations/* 读写）。
// 那份 37 B 空壳按计划改名留档为 relations.json.bak-20260927（不删）。
const UPLOAD_DIR_REL = '上传'

// ============ 记忆工作台（Phase1 2026-09-02，additive）：U1 工程记忆只读投影 + U2 复用标记 sidecar ============
// 投影目标 = memory-system 数据文件（镜像其 readL1/readDraft/doStats/computeImportance/memoryScore 语义，memory-system 零改动）
// cache:false 逐请求读盘：memory_pin/memory_exclude 由 client 直调 /memory-system/api 完成写，本模块感知不到其缓存失效，
//   故镜像读一律不缓存，从根上消除 host 侧 30s 陈旧（T8 R1 定稿）
const MEM_DIR_REL = 'memory-system'                    // 根 全局数据
const MEM_MEMORY_REL = MEM_DIR_REL + '/memory.json'
const MEM_FACTS_REL = MEM_DIR_REL + '/facts.json'
const MEM_LONGTERM_REL = MEM_DIR_REL + '/longterm/tasks'
const MEM_DRAFTS_REL = MEM_DIR_REL + '/longterm/drafts'
const MEM_WORKING_REL = MEM_DIR_REL + '/working'
const MEM_RAW_REL = MEM_DIR_REL + '/raw'
const MEM_ARCHIVE_MANIFEST_REL = '归档清单.json'        // 根 记忆归档
// 镜像 memory-system DEFAULT_SCORE_CONFIG（B4-1）——公式对齐上游 calculateMemoryScore：
// memoryScore=(importance×w.importance + accessLog×w.accessLog + priority×w.priority + reinforcement×w.reinforcement)×decay
const MEM_DEFAULT_SCORE_CONFIG = {
  enabled: true,
  weights: { importance: 0.3, accessLog: 0.2, priority: 0.3, reinforcement: 0.2 },
  decayRate: 0.01,
  importantThreshold: 0.7,
  addScale: 50
}
// U2 作品灵感看板：复用标记（主轴/支线/改造）sidecar —— writing-studio 自持文件，taskkit insp 数据零改动
const INSP_REUSE_REL = '灵感复用.json'
const INSP_REUSE_ROLES = ['主轴', '支线', '改造']

// ============ 记忆工作台 Phase2（2026-09-03，additive）：U4-U8 新增 sidecar 常量（writing-studio 自持，首次写入才创建） ============
// U4 灵感资产库·复用图谱：作品注册表 + 灵感→作品多值使用关系（独立 sidecar，绝不写进灵感库.json——normalizeInspEntry 白名单会丢未知 key，R2）
const WORKS_LIB_REL = '作品库.json'
const INSP_ASSET_REL = '灵感资产.json'
const ASSET_ROLES = ['主轴', '支线', '改造']
const ASSET_STATUS = ['在用', '已完成', '搁置']
// U7 对话记忆·会话提炼台：提炼历史（仅下游落库成功后记录）
const DISTILL_HISTORY_REL = '提炼历史.json'
// U8 用户偏好·编辑化：创作/工程偏好（白名单字段）；创作原点=灵感库 fixed（只读）
const USER_PREFS_REL = '用户偏好.json'
const PREFS_STRICTNESS = ['严格', '标准', '宽松']
const KB_CATEGORIES = ['创作设定', '创作技法', '创作资料', '踩坑经验·写作', '方法论', '通用']
const MEMORY_RECORD_TYPES = ['message', 'thought', 'artifact']

// ============ 记忆工作台 Phase3 批次2（2026-09-06 additive）：① 真退役/复原 host 代理 + ② 记忆策略写 + ⑤ A1 领域召回 + ⑥ 会话回顾/待提炼队列 ============
// ⑤ A1 领域召回只读镜像目标 = knowledge-base 权威数据（knowledge-base 零改动；mirror 读 cache:false 逐请求读盘，R3 ≤30s 窗口不一致可接受）
const KB_MIRROR_REL = 'knowledge-base/knowledge.json'   // 根 全局数据
// ⑥ 待提炼队列 sidecar（累计第 6 个 sidecar，写作训练/ 自持；首写才建，缺失空态）
const QUEUE_REL = '待提炼队列.json'
const QUEUE_GUESS_KINDS = ['灵感', '经验', '结论']
const QUEUE_STATUSES = ['待处理', '已落库', '忽略']
const QUEUE_MAX_TEXT = 500
// ⑥ sessionSearch types 白名单（对齐宿主 dsh-session-query extractSessionEventText 可检索事件族；type filter 值=事件 type）
const SESSION_EVENT_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'todo/write']
// sessionQuery 调用 8s 守卫（taskkit L704/L727/L739 Promise.race 先例；宿主 filterEvents/listEvents 整段 load 无分页游标，长会话限流）
const SQ_TIMEOUT_MS = 8000
// 会话清单持久化全量列读（listSessions → listPersisted 逐段读首帧）实测 >8s（508 段/193MB）——放宽到 20s + host 侧 30s 记录缓存（仿 taskkit titleOf 30s 缓存先例），
// 首次调用拿真实数据、30s 内重复调用即时返回；仍超时则降级返回不可用提示（绝不挂起事件循环——listArtifacts 各文件间有 await 间隙，race 计时器可触发）
const SQ_LIST_TIMEOUT_MS = 60000
// ② memConfigSet host 白名单（对齐 memory-system CONFIG_WHITELIST L1562-1568，双校验同语义；host 白名单先行、memory-system 兜底）
const MEM_SCORE_WHITELIST = { enabled: 'boolean', weights: 'object', decayRate: '0-1', importantThreshold: '0-1', addScale: '0-10000' }
const MEM_SCORE_WEIGHTS = { importance: 1, accessLog: 1, priority: 1, reinforcement: 1 }
// ⑤ A2 distill 历史来源 channel 白名单（talk/coach；新条目可选键，既有字段/消费方零改动）
const DISTILL_CHANNELS = ['talk', 'coach']

export function apply(ctx) {
  // O5 迁移：fs 面统一经 adapterFs、loopback HTTP 统一经 adapterHttp——
  // 原 ctx.get('fs') / sandboxPolicy / cwd / writePolicy 四项已不再使用（写策略由 adapter 部署 config 的
  // writePolicy 承接，默认 {mode:'danger-full-access'} 与迁移前本插件本地 writePolicy 同值）；inject 数组保持契约零破坏、不动。
  const adapterFs = ctx.get('adapterFs')
  const adapterHttp = ctx.get('adapterHttp')
  if (!adapterFs) {
    const _m = '[writing-studio] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写写作训练数据（请确认 profile 中 @local/dsh-adapter 已加载）'
    try {
      const lg = ctx.get('logger')
      if (lg && typeof lg.warn === 'function') lg.warn(_m)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n')
    } catch (_) {}
  }
  if (!adapterHttp) {
    const _m2 = '[writing-studio] adapterHttp 不可用：loopback HTTP（distill/记忆代理）将返回 no-adapterHttp'
    try {
      const lg = ctx.get('logger')
      if (lg && typeof lg.warn === 'function') lg.warn(_m2)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m2 + '\n')
    } catch (_) {}
  }

  // ============ 数据读写（O5：统一经 adapterFs —— 根名 + 根内相对引用；默认直读盘、写后自动失效） ============
  // 原模块级 30s 读缓存（含其失效函数）整体删除：adapterFs.readJson 默认 cache:false，
  // 从根上消除「写/外部改后 30s 内读到旧值」窗口（T8 R1 口径）；需要 TTL 的调用方才能显式传 cacheMs。
  // 对外 payload / node:fs 直用所需的绝对路径：由 adapterFs 解析登记根后取 displayPath（盘符不在本插件硬编码）
  function absPath(t) {
    const v = (t && t.displayPath !== undefined) ? t.displayPath : t
    return String(v === undefined || v === null ? '' : v).replace(/\\/g, '/')
  }
  async function absOf(root, rel) { return absPath(await adapterFs.resolve(root, rel)) }              // 抛错版
  async function absOfRef(ref, root) { return absPath(await adapterFs.resolveRef(ref, root ? { root: root } : undefined)) } // 抛错版
  // 读（默认 cache:false 直读盘；fallback 口径与迁移前一致：任何错误都回 fallback）
  async function readJson(root, rel, fallback) {
    try { return await adapterFs.readJson(root, rel, { fallback: fallback }) } catch (e) { return fallback }
  }
  // 跨插件只读源 / 自持 sidecar 统一经此读（resolveRef：相对引用 → 显式根，绝对引用直解）；镜像读一律 cache:false（R1：禁 30s 陈旧）
  async function memReadRef(ref, fallback, root) {
    try {
      const t = await adapterFs.resolveRef(ref, root ? { root: root } : undefined)
      return await adapterFs.readJson(absPath(t), null, { fallback: fallback })
    } catch (e) { return fallback }
  }
  async function memRead(root, rel, fallback) { return memReadRef(rel, fallback, root) }   // 根显式传入（记忆/知识库=全局数据；自持 sidecar=写作训练）
  // 写（抛错版：adapterFs 写后自动失效同键缓存；调用方自带 try/catch，语义与迁移前 fs.writeText/writeJson 直调一致）
  async function writeJsonRaw(root, rel, obj) { await adapterFs.writeJson(root, rel, obj) }
  async function writeTextRaw(root, rel, content) { await adapterFs.writeText(root, rel, content) }

  // U-37（2026-09-27 additive）：按相对路径保存草稿 —— **原子写**（临时文件 + rename，避免半截文件）。
  // 父目录不存在 ⇒ 逐级创建（mkdir recursive）；口径对齐 B5 uploadFile（宿主 ESM 约束下 node 内置模块用 await import；
  // OS 绝对路径由 adapterFs.resolve 的 displayPath 提供）；node:fs 不可用时回退 adapterFs.writeText（放弃原子性但有兜底）。
  async function writeDraftAtomic(rel, content) {
    // 🔴 adapterFs 的 (rootRef, rel) 语义 = `joinUnderRoot(roots[rootRef], rel)`（dsh-adapter/lib/fs.js:32 `_resolveTarget`）
    //    ⇒ 若把**工作区相对**的完整路径（`写作训练/草稿/…`）直接喂进去，会拼成 `写作训练/写作训练/草稿/…`：
    //      读取恒失败（exists 恒 false ⇒ "默认不覆盖"失效）、写入落到多余的嵌套目录。
    //    ⇒ 这里统一剥掉 `写作训练/` 前缀；调用方已剥过则不重复剥（幂等）。
    const inner = String(rel).indexOf(ROOT_TRAIN + '/') === 0 ? String(rel).slice(ROOT_TRAIN.length + 1) : String(rel)
    let nfs = null
    try { nfs = await import('node:fs') } catch (e) { nfs = null }
    if (!nfs) { await writeTextRaw(ROOT_TRAIN, inner, content); return }
    const abs = await absOf(ROOT_TRAIN, inner)
    const dir = abs.slice(0, abs.lastIndexOf('/'))
    if (dir) nfs.mkdirSync(dir, { recursive: true })
    const tmp = abs + '.tmp-' + process.pid + '-' + Date.now().toString(36)
    nfs.writeFileSync(tmp, content, 'utf8')
    try {
      nfs.renameSync(tmp, abs)
    } catch (e) {
      // 跨设备/占用时 rename 可能失败 → 清理临时文件后回退直接覆盖（同 adapter resume/state.js 口径）
      try { nfs.unlinkSync(tmp) } catch (_) {}
      nfs.writeFileSync(abs, content, 'utf8')
    }
  }

  // U-37 审计（计划 §2.2）：落一条 draft-save（relPath / bytes / created / 是否覆盖），供事后追查。
  // 本插件无 AuditLogger；沿用本文件既有的 ctx.get('logger') 通道（同 L99-111 写法），审计失败不阻断主流程。
  function auditDraftSave(e) {
    const x = e || {}
    const line = '[writing-studio:audit] draft-save relPath=' + String(x.relPath || '') +
      ' bytes=' + Number(x.bytes || 0) + ' created=' + (x.created === true) + ' overwrote=' + (x.overwrote === true)
    try {
      const lg = ctx.get('logger')
      if (lg && typeof lg.info === 'function') lg.info(line)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(line + '\n')
    } catch (_) {}
  }

  // ============ U-41 / P4 收口（2026-09-29 additive）：`draft-*` **写动作**的总开关 ============
  // 契约与切换判据：docs/superpowers/plans/2026-09-29-u41-p4-closure-design.md
  // 🔴 取值：'open'（**默认**，行为与收口前**完全一致**）| 'closed'（只封**写** ⇒ draft-save / draft-delete 一律 403，**先判后写、盘上零变化**）
  //    · `draft-list` / `draft-read` 在**任何取值下都保留**：只读无副作用，且用户已拍「老件不搬」
  //      ⇒ 旧客户端必须还能看见并拉回 `草稿/` 里的旧稿，否则表现为"云端稿全没了"。
  //    · `submit` / `clientZone*` **不受本开关影响**。
  // 🔴 **切换前提**（设计 §2.3 / §8）：客户端装机升级完成 ＋ 审计里 `draft-save relPath=` 计数**连续 7 天为 0**。
  //    切法：改此处为 'closed' → install → hotplug reload（**不重启内核**）；回滚即改回 'open'。
  const DRAFT_WRITE_MODE = 'open'

  // P4 审计：**被拒**的写请求也留痕（"还有旧客户端在敲"看得见）。
  // ⚠️ 刻意**不动** auditDraftSave 的既有拼接串 —— 它已被 draft-save-wiring.test.mjs 逐字锁定，
  //    且判据只需 `grep -c 'draft-save relPath='` 即可数出"近期还有谁在写"。
  function auditDraftWriteRejected(action, relPath) {
    const line = '[writing-studio:audit] draft-write-rejected action=' + String(action || '') +
      ' mode=' + DRAFT_WRITE_MODE + ' relPath=' + String(relPath || '')
    try {
      const lg = ctx.get('logger')
      if (lg && typeof lg.info === 'function') lg.info(line)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(line + '\n')
    } catch (_) {}
  }

  /**
   * P4 收口闸：`closed` 时对**写**动作统一 403（**先判后写** ⇒ 本次请求不产生任何盘上变化）。
   * @returns {boolean} true = 已拒（调用方应立即 return）；false = 放行
   */
  function draftWriteClosed(action, relPath) {
    if (DRAFT_WRITE_MODE !== 'closed') return false
    auditDraftWriteRejected(action, relPath)
    return true
  }

  // ============ C11（2026-09-29 additive）：多端文档同步的 host 侧薄接线 ============
  // 纯逻辑全在 ./draft-sync-core.js（可本地真测试）；这里只做「读参数 → 调纯函数 → 读写盘 → 返回」。
  //   GET  draft-list    列远端草稿（元数据，无正文）+ 墓碑
  //   GET  draft-read    按 relPath 读回正文
  //   POST draft-delete  **软删**：rename 搬进 `草稿/.deleted/` + 写 `草稿/.tombstones.json`（**永不真删**）
  // 🔴 三个都不改任何既有 action 的行为；回收站/墓碑都以 `.` 开头 ⇒ 被既有 listDraftRelPaths 天然跳过 ⇒
  //    对 collectDrafts / draftCount / training.drafts **零污染**。

  /** 墓碑文件在**写作训练根内**的相对路径（adapterFs 的 (rootRef, rel) 语义 ⇒ 相对 ROOT_TRAIN） */
  const TOMBSTONE_INNER = DRAFT_DIR_REL + '/' + TOMBSTONE_FILE_NAME

  /**
   * 取 relPath：**body 优先，其次查询串**。
   * 🔴 必须这么取：`args` 只装 **JSON body**（见 index.js 的 `let args = {}; if (body) args = JSON.parse(body)`）
   *    ⇒ **GET 请求的 args 恒为空对象**，查询串里的 `relPath` 根本不在里面。
   *    （2026-09-29 首次部署时正是这里出的错：`draft-read` 三次探针全回"relPath 必填"。）
   */
  function relArgOf(argsIn, u) {
    const a = argsIn || {}
    if (a.relPath !== undefined && a.relPath !== null && String(a.relPath) !== '') return String(a.relPath)
    try { return String(u.searchParams.get('relPath') || '') } catch (e) { return '' }
  }

  async function readTombstones() {
    const raw = await readJson(ROOT_TRAIN, TOMBSTONE_INNER, null)
    return normalizeTombstones(raw)
  }

  /**
   * 草稿根内的相对路径 + 绝对路径一起算出来（node:fs 直用所需的绝对路径由 adapterFs.resolve 提供）。
   * @returns {Promise<{abs:string, inner:string}>} `inner` 是相对 `写作训练/草稿/` 的路径
   */
  async function draftAbs(inner) {
    return { abs: await absOf(ROOT_TRAIN, DRAFT_DIR_REL + '/' + inner), inner: inner }
  }

  /** 取 mtime（毫秒）。拿不到 ⇒ null（列表里就这一项没时间，不影响其余） */
  async function draftMtime(root, relInTrain) {
    try {
      const st = await adapterFs.stat(root, relInTrain)
      if (!st) return null
      if (st.mtimeMs !== undefined) return st.mtimeMs
      if (st.mtime !== undefined) return st.mtime
      return null
    } catch (e) { return null }
  }

  /**
   * **软删**：把稿件 rename 到 `草稿/.deleted/<原相对路径>`。**不删除任何字节**。
   * 🔴 目标已存在时**加时间戳后缀**，绝不覆盖回收站里的旧件（否则"删两次"会吃掉第一份）。
   * ⚠️ 用 node:fs（与 writeDraftAtomic 同口径：宿主 ESM 约束下 await import；绝对路径来自 adapterFs.resolve）。
   * @param {string} wsRel 工作区相对 relPath（`写作训练/草稿/…`）
   * @returns {Promise<string>} 回收站里的**工作区相对**路径
   */
  async function softDeleteDraft(wsRel) {
    const inner = innerRelOf(wsRel)
    if (!inner) throw new Error('非草稿根下的路径: ' + String(wsRel))
    const nfs = await import('node:fs')
    const src = await draftAbs(inner)
    const dstInnerNoStamp = trashInnerRelOf(inner)
    let dst = await draftAbs(dstInnerNoStamp)
    const dir = dst.abs.slice(0, dst.abs.lastIndexOf('/'))
    if (dir) nfs.mkdirSync(dir, { recursive: true })
    let usedInner = dstInnerNoStamp
    if (nfs.existsSync(dst.abs)) {
      // 回收站里已有同名 ⇒ 带时间戳，绝不覆盖
      const stem = inner.slice(0, inner.length - (inner.split('/').pop() || '').length)
      const base = inner.split('/').pop() || 'draft'
      const stamped = stem + base + '.deleted-' + new Date().toISOString().replace(/[:.]/g, '-')
      usedInner = trashInnerRelOf(stamped)
      dst = await draftAbs(usedInner)
      const dir2 = dst.abs.slice(0, dst.abs.lastIndexOf('/'))
      if (dir2) nfs.mkdirSync(dir2, { recursive: true })
    }
    nfs.renameSync(src.abs, dst.abs)
    return wsRelOf(usedInner)
  }

  /** C11 审计：落一条 draft-sync（op / relPath / bytes / 结果），供事后追查。失败不阻断主流程。 */
  function auditDraftSync(op, e) {
    const x = e || {}
    const line = '[writing-studio:audit] draft-sync op=' + String(op || '') +
      ' relPath=' + String(x.relPath || '') +
      ' bytes=' + Number(x.bytes || 0) +
      ' result=' + String(x.result || '')
    try {
      const lg = ctx.get('logger')
      if (lg && typeof lg.info === 'function') lg.info(line)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(line + '\n')
    } catch (_) {}
  }

  // ============ 记忆工作台 host 侧工具（U1 只读投影 + U2 sidecar，2026-09-02 additive） ============
  // 目录枚举镜像 memory-system doStats（L1341-1349）：一律排除 '.' 前缀占位（.gitkeep.json），raw 记录另加 .jsonl 过滤
  const memNotDot = function (e) { return !String(e && e.name || '').startsWith('.') }
  async function memDirNames(root, rel) {
    try {
      const names = await adapterFs.listDir(root, rel)
      return (Array.isArray(names) ? names : []).filter(memNotDot).map(function (e) { return String(e.name || '').replace(/\.json$/, '') }).filter(Boolean)
    } catch (e) { return [] }
  }
  // —— 镜像 memory-system computeImportance（L513-524：结论质量 + 决策密度 + kb_refs，封顶 1）——
  function memImportance(s) {
    const conclusion = String((s && s.conclusion) || '').trim()
    const decisions = Array.isArray(s && s.decisions) ? s.decisions : []
    const kbRefs = Array.isArray(s && s.kb_refs) ? s.kb_refs : []
    let importance = 0
    if (conclusion.length >= 40) importance += 0.5
    else if (conclusion.length > 0) importance += 0.3
    importance += Math.min(0.3, decisions.length * 0.1)
    if (kbRefs.length) importance += 0.2
    return Math.min(1, importance)
  }
  // —— 镜像 memory-system memoryScore（L525-552：B4-1 公式，priority/reinforcement 无字段恒 0，pinned 不衰减）——
  function memScore(s, cfg) {
    cfg = cfg || MEM_DEFAULT_SCORE_CONFIG
    const w = cfg.weights || {}
    const importance = memImportance(s)
    const rc = Math.max(((s && s.raw_span && s.raw_span.count) || 0), 1)
    const mc = Number(s && s.message_count) || 0
    const accessLog = Math.log(mc / rc + 1) / Math.log(101)
    let decay = 1
    const closedAt = s && (s.closed_at || s.closedAt || s.created_at)
    if (closedAt) {
      const t = new Date(closedAt).getTime()
      if (!isNaN(t) && t > 0) {
        const days = (Date.now() - t) / 86400000
        if (days > 0) {
          const important = s.status === 'success' && importance >= (cfg.importantThreshold || 0.7)
          decay = (important || s.pinned) ? 1 : Math.exp(-((cfg.decayRate || 0.01)) * days)
        }
      }
    }
    const raw = (importance * (w.importance || 0)) + (accessLog * (w.accessLog || 0)) + (0 * (w.priority || 0)) + (0 * (w.reinforcement || 0))
    return raw * decay
  }
  // —— 镜像 memory-system resolveScoreConfig（L553-561：memory.json.config.memoryScore 运行时覆盖）——
  async function memScoreConfig() {
    const m = await memRead(ROOT_DATA, MEM_MEMORY_REL, null)
    const over = (m && m.config && m.config.memoryScore) || {}
    return Object.assign({}, MEM_DEFAULT_SCORE_CONFIG, over, { weights: Object.assign({}, MEM_DEFAULT_SCORE_CONFIG.weights, over.weights || {}) })
  }
  // —— memSummary：L0 facts + L1（已确认→草稿，同 id 前者优先）+ L2 raw 计数 + working + 归档 + 分数配置（U1 面板数据源）——
  async function memSummary() {
    const [scoreCfg, memory, facts, confirmedNames, draftNames, workNames, rawNames] = await Promise.all([
      memScoreConfig(),
      memRead(ROOT_DATA, MEM_MEMORY_REL, null),
      memRead(ROOT_DATA, MEM_FACTS_REL, { version: 1, facts: [], pending: [] }),
      memDirNames(ROOT_DATA, MEM_LONGTERM_REL),
      memDirNames(ROOT_DATA, MEM_DRAFTS_REL),
      memDirNames(ROOT_DATA, MEM_WORKING_REL),
      memDirNames(ROOT_DATA, MEM_RAW_REL)
    ])
    // L2 raw：每任务目录 .jsonl 记录数（镜像 doStats L1346-1349）
    const rawPerTask = {}
    let rawRecords = 0
    for (const t of rawNames) {
      let n = 0
      try {
        const files = await adapterFs.listDir(ROOT_DATA, MEM_RAW_REL + '/' + t)
        n = (Array.isArray(files) ? files : []).filter(function (e) { return /\.jsonl$/.test(String(e && e.name || '')) }).length
      } catch (e) { n = 0 }
      rawPerTask[t] = n
      rawRecords += n
    }
    const toL1 = function (s, id, source) {
      const importance = memImportance(s)
      return {
        task_id: String(s.task_id || id || ''),
        title: s.title || id || '',
        status: s.status || 'unknown',
        project: s.project || '',
        domain: Array.isArray(s.domain) ? s.domain : [],
        tags: Array.isArray(s.tags) ? s.tags : [],
        source: source, // 'confirmed' | 'draft'
        pinned: s.pinned === true,
        excluded: s.excluded === true,
        closed_at: s.closed_at || s.closedAt || s.created_at || null,
        goal: String(s.goal || '').slice(0, 180),
        conclusion: String(s.conclusion || '').slice(0, 300),
        decisionCount: Array.isArray(s.decisions) ? s.decisions.length : 0,
        openQuestionCount: Array.isArray(s.open_questions) ? s.open_questions.length : 0,
        messageCount: Number(s.message_count) || 0,
        rawRecords: rawPerTask[id] || 0,
        importance: Math.round(importance * 1000) / 1000,
        score: Math.round(memScore(s, scoreCfg) * 1000) / 1000
      }
    }
    // L1：镜像 readSummary 前两级（longterm/tasks 已确认优先于 drafts；退役归档不回退展示，面板聚焦活跃记忆）
    const l1Out = []
    const done = {}
    for (const id of confirmedNames) {
      const s = await memRead(ROOT_DATA, MEM_LONGTERM_REL + '/' + id + '.json', null)
      if (!s) continue
      done[id] = 1
      l1Out.push(toL1(s, id, 'confirmed'))
    }
    for (const id of draftNames) {
      if (done[id]) continue
      const s = await memRead(ROOT_DATA, MEM_DRAFTS_REL + '/' + id + '.json', null)
      if (!s) continue
      l1Out.push(toL1(s, id, 'draft'))
    }
    // 面板排序：记忆分数降序（同分置顶优先，再按 task_id 稳定）
    l1Out.sort(function (a, b) {
      return (b.score - a.score) || ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (a.task_id < b.task_id ? -1 : 1)
    })
    const factsArr = Array.isArray(facts && facts.facts) ? facts.facts : []
    const pendingArr = Array.isArray(facts && facts.pending) ? facts.pending : []
    const l0 = factsArr.slice(0, 100).map(function (f) {
      return { id: f.id || '', project: f.project || '', content: String(f.content || '').slice(0, 300), source: f.source || '', updated_at: f.updated_at || null }
    })
    const pending = pendingArr.slice(0, 30).map(function (p) {
      const body = typeof p === 'string' ? p : (p && (p.content || p.text)) || ''
      return { id: (p && p.id) || '', project: (p && p.project) || '', content: String(body || '').slice(0, 300), source: (p && p.source) || '' }
    })
    let archived = 0
    try {
      const am = await memReadRef(MEM_ARCHIVE_MANIFEST_REL, { archived: {} }, ROOT_ARCHIVE)
      archived = Object.keys((am && am.archived) || {}).length
    } catch (e) { archived = 0 }
    return {
      ok: true,
      ts: Date.now(),
      dir: await absOf(ROOT_DATA, MEM_DIR_REL),
      stats: {
        facts: factsArr.length, factsPending: pendingArr.length,
        confirmed: confirmedNames.length, drafts: draftNames.length,
        working: workNames.length, rawTasks: rawNames.length,
        rawRecords: rawRecords, archived: archived
      },
      l0: l0,
      pending: pending,
      l1: l1Out,
      workingIds: workNames,
      rawPerTask: rawPerTask,
      config: { memoryScore: scoreCfg, rawPolicy: (memory && memory.config && memory.config.rawPolicy) || 'append-only' },
      counters: (memory && memory.stats) || {}
    }
  }

  async function readRecord() {
    return readJson(ROOT_TRAIN, WRITING_RECORD_REL, { version: 1, days: {}, totalWords: 0, streak: 0, lastFile: '' })
  }

  // U-7 / T1a（2026-09-28）：relations 的**数据源 = taskkit**（权威表 写作训练/草稿/relations.json）。
  // 本插件不再读/写自己的 写作训练/relations.json（那份 37 B 空壳在**本窗口部署时**改名留档 relations.json.bak-20260928）。
  // 返回形状保持不变（{version:1, relations:{...}}）—— 内部调用方与前端都依赖它（形状适配见 relations-core）。
  // 🔴 失败语义：taskkit 不可达/报错 ⇒ **抛错**（由 action 外层 catch 如实回 500），不再静默兜底成空表。
  async function readRelations() {
    const r = await loopPost(TASKKIT_RELATIONS_LIST, {})
    const err = responseFailed(r, 'list')
    if (err) throw new Error(err)
    return adaptRelationsDoc(r)
  }

  // U-7 / T1a：attach ⇒ taskkit update（字段映射见 relations-core.buildAttachPayload）；失败抛错，不静默。
  async function attachRelation(draft, rel) {
    const r = await loopPost(TASKKIT_RELATIONS_UPDATE, buildAttachPayload(draft, rel))
    const err = responseFailed(r, 'update')
    if (err) throw new Error(err)
    return r.data
  }

  // U-7 / T1a：detach ⇒ taskkit delete（T1b 新增动作；幂等 —— 键不存在时 taskkit 也回 ok/removed:false）。
  async function detachRelation(draft) {
    const r = await loopPost(TASKKIT_RELATIONS_DELETE, { draft: draft })
    const err = responseFailed(r, 'delete')
    if (err) throw new Error(err)
    return r.data
  }

  async function readInspLib() {
    return readJson(ROOT_TRAIN, INSP_LIB_REL, { version: 1, entries: [] })
  }

  // 灵感判定过滤：只展示真正的创作灵感，排除误混入的技术文档/流水线产物（数据分离规范）
  // 规则细化：灵感会议纪要（source 含"灵感会议"）是创作活动，排除在外；技术标记聚焦明确技术文档特征
  function isInspiration(e) {
    if (!e || typeof e !== 'object') return false
    const source = String(e.source || '')
    const title = String(e.title || '')
    const oneLiner = String(e.oneLiner || '')
    const tags = (e.tags || []).join(' ')
    const text = (title + ' ' + source + ' ' + oneLiner + ' ' + tags).toLowerCase()
    const content = String(e.content || '')
    // 灵感会议/灵感整理是创作活动，不是技术文档
    if (source.indexOf('灵感会议') >= 0 || source.indexOf('灵感整理') >= 0 || title.indexOf('灵感会议纪要') >= 0) return true
    // 技术文档特征标记（排除"任务中心"单独匹配——灵感会议也带此前缀；用组合特征）
    const techMarkers = [
      '技术文档', '文档更新', '检查测试', '设计阶段', '方案检查', '实施与',
      '邮件桥', '静态化', 'email-bridge', 'taskkit', 'writing-studio', '@local/',
      '流水线', '阶段回执', '整改'
    ]
    for (const m of techMarkers) if (text.indexOf(m.toLowerCase()) >= 0) return false
    // 任务中心派发但非灵感的（技术流程类）：source 含「任务中心」且 title 含技术关键词
    if (source.indexOf('任务中心') >= 0 && /(设计|检查|测试|文档|实施|回执|技术)/.test(title)) return false
    if (/^#\s*.{0,20}(技术文档|设计|检查|测试|文档).*$/m.test(content)) return false
    return true
  }
  function filterInspirations(entries) {
    return (Array.isArray(entries) ? entries : []).filter(isInspiration)
  }

  // B5 对话上传文件落盘（2026-08-30 用户需求，additive）：
  // input {filename, content, isBase64?, mime?} → {path, filename, size}
  // 文件名清洗（同 saveDraft L106 规则）+ 时间戳防重名；文本走 fs.writeText，二进制走 node:fs 直写；
  // 目录 <根 写作训练>/上传/ 首次 mkdir recursive（当前不存在，实测）。
  const UPLOAD_MAX_BYTES = 20 * 1024 * 1024
  function sanitizeFilename(name) {
    return String(name || '文件').replace(/[\\/:*?"<>|]/g, '_').trim() || '文件'
  }
  async function uploadFile(input) {
    const filename = String(input.filename || '')
    const content = String(input.content || '')
    const isBase64 = input.isBase64 === true
    if (!content) throw new Error('缺少 content')
    const safeBase = sanitizeFilename(filename)
    const p2 = function (n) { return String(n).padStart(2, '0') }
    const now = new Date()
    const stamp = '' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '_' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds())
    const dot = safeBase.lastIndexOf('.')
    const stem = dot > 0 ? safeBase.slice(0, dot) : safeBase
    const ext = dot > 0 ? safeBase.slice(dot) : ''
    const safeName = stem + '_' + stamp + ext
    const uploadInner = UPLOAD_DIR_REL + '/' + safeName   // 根内相对引用（根 写作训练）
    // 首次建目录（node:fs mkdir recursive；宿主 ESM 约束：node 内置模块用 await import）
    // 目录/文件的 OS 绝对路径由 adapterFs.resolve 的 displayPath 提供（不再用 fs.processPath；U-6 实测数据根无 junction ⇒ 同一实路径）
    try {
      const { mkdirSync, writeFileSync, existsSync } = await import('node:fs')
      const dir = await absOf(ROOT_TRAIN, UPLOAD_DIR_REL)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      if (isBase64) {
        writeFileSync(await absOf(ROOT_TRAIN, uploadInner), Buffer.from(content, 'base64'))
      } else {
        await writeTextRaw(ROOT_TRAIN, uploadInner, content)
      }
    } catch (e) {
      // node:fs 不可用（受限环境）时文本回退 adapterFs.writeText（幂等）；二进制无回退
      if (!isBase64) await writeTextRaw(ROOT_TRAIN, uploadInner, content)
      else throw e
    }
    return { path: await absOf(ROOT_TRAIN, uploadInner), filename: safeName, size: isBase64 ? Math.floor(content.length * 0.75) : content.length }
  }

  // B4 心流反馈：调 /writing-coach/api/analyze（本地规则 4 维）→ 心流评分映射（additive，2026-08-30）
  // 双轨制：writing-coach 不可达时用本地字数/标点启发式兜底，不阻塞
  async function flowScoreOf(text) {
    const content = String(text || '')
    let analysis = null
    try {
      // O5 归一（t106，设计 §3.1「待归一形态」收口）：直连 globalThis.fetch → adapterHttp.post（apiBase 解析 / POST 必达 /
      // 默认 8s 超时 / 非 2xx 透传 body.error）；调用面形状 { status, ok, data, error } 映射：
      //   resp.ok(2xx)              → r.ok（2xx 且信封 ok≠false 且响应体可解析 JSON）
      //   await resp.json() → data  → r.data（adapter 内 res.text()+JSON.parse；非 JSON → ok:false,error='invalid json'）
      //   data && data.ok           → r.data && r.data.ok
      //   非 2xx（不读 body）        → { ok:false, data:<body>, error:<body.error||message||'HTTP n'> }（透传优于改前）
      //   网络异常（旧 catch）        → { status:0, ok:false, error:'network: …' }（以返回值承载，不再抛）
      //   ⇒ 以上「一律不进 if」⇒ analysis 保持 null，本地启发式兜底与改前逐字一致（source='local-heuristic'）。
      const r = adapterHttp
        ? await adapterHttp.post('/writing-coach/api/analyze', { text: content.slice(0, 5000) }, { throwOnError: false })
        : null
      if (r && r.ok && r.data && r.data.ok) analysis = r.data
    } catch (e) { analysis = null }
    let flowScore = 50
    let state = '平稳'
    let suggestion = ''
    if (analysis && analysis.sentiment && analysis.pacing) {
      const intensity = Number(analysis.sentiment.intensity || 0)
      const speed = analysis.pacing.speed || 'medium'
      const type = analysis.intent && analysis.intent.type || ''
      const structure = analysis.structure && analysis.structure.type || ''
      flowScore = 40 + Math.round(intensity * 30)
      if (speed === 'fast') flowScore += 15
      if (speed === 'slow') flowScore -= 10
      if (type === 'conflict') flowScore += 10
      if (type === 'resolution') flowScore += 5
      if (structure === 'dialogue') flowScore += 5
      flowScore = Math.max(0, Math.min(100, flowScore))
      if (flowScore >= 80) state = '沉浸'
      else if (flowScore >= 60) state = '亢奋'
      else if (flowScore >= 40) state = '平稳'
      else state = '卡顿'
      if (state === '沉浸') suggestion = '状态极佳，继续保持当前节奏'
      else if (state === '亢奋') suggestion = '情绪饱满，注意控制节奏避免透支'
      else if (state === '平稳') suggestion = speed === 'slow' ? '节奏偏慢，可加入对话或动作提升节奏' : '节奏平稳，可尝试加入冲突或转折'
      else suggestion = '当前卡顿，建议拆分目标、先写片段或休息片刻'
    } else {
      // 本地启发式兜底（离线可用，双轨制）
      const len = content.length
      const sentences = (content.match(/[。！？!?]/g) || []).length
      if (len === 0) { flowScore = 0; state = '卡顿'; suggestion = '尚未输入内容' }
      else if (len > 800) { flowScore = 75; state = '沉浸'; suggestion = '内容充足，保持节奏' }
      else if (len > 300) { flowScore = 60; state = '亢奋'; suggestion = '渐入佳境，继续推进' }
      else { flowScore = 45; state = '平稳'; suggestion = '刚起步，建议先写 300 字热身' }
      if (sentences > 0 && len / sentences < 15) flowScore = Math.min(95, flowScore + 10)
    }
    return { flowScore: flowScore, state: state, suggestion: suggestion, source: analysis ? 'writing-coach' : 'local-heuristic' }
  }

  // B4 里程碑：从 写作记录.json 计算累计/连续/当日里程碑 + 下一目标 + 进度（additive，2026-08-30）
  // 里程碑档位：累计 1万/5万/10万/20万 字；连续 7/30/100 天；单日 3000/5000/10000 字
  const MILESTONES = {
    totalWords: [10000, 50000, 100000, 200000],
    streak: [7, 30, 100],
    dayWords: [3000, 5000, 10000]
  }
  function milestoneProgress(value, tiers) {
    let current = 0
    let next = tiers[0] || 0
    for (const t of tiers) { if (value >= t) { current = t; next = tiers[tiers.indexOf(t) + 1] || 0 } }
    const progress = next > 0 ? Math.min(100, Math.round((value / next) * 100)) : 100
    return { current: current, next: next, progress: progress, done: next === 0 }
  }
  function milestonesOf(record) {
    const rec = record && typeof record === 'object' ? record : {}
    const days = (rec.days && typeof rec.days === 'object') ? rec.days : {}
    const today = new Date()
    const p2 = function (n) { return String(n).padStart(2, '0') }
    const todayStr = today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate())
    const totalWords = Number(rec.totalWords || 0)
    const streak = Number(rec.streak || 0)
    const dayWords = Number((days[todayStr] && days[todayStr].words) || 0)
    return {
      totalWords: milestoneProgress(totalWords, MILESTONES.totalWords),
      streak: milestoneProgress(streak, MILESTONES.streak),
      dayWords: milestoneProgress(dayWords, MILESTONES.dayWords),
      todayWords: dayWords,
      totalWordsNow: totalWords,
      streakNow: streak
    }
  }

  // 保存草稿：草稿/<日期>_<时间>.md + 更新 写作记录.json（复用 wrpro saveDraft 逻辑，工作台统一入口）
  async function saveDraft(content, title) {
    const now = new Date()
    const p2 = function (n) { return String(n).padStart(2, '0') }
    const dateStr = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate())
    const timeStr = p2(now.getHours()) + '-' + p2(now.getMinutes()) + '-' + p2(now.getSeconds())
    const stamp = dateStr + '_' + timeStr
    const naming = draftNaming(title, stamp)
    const filename = naming.filename
    const fileContent = naming.titleLine + '\n\n> 保存时间：' + now.toISOString() + '\n\n' + (content || '')
    // 保存草稿：草稿/<日期>_<时间>.md（根内相对引用；草稿 md 为文本通道，不经 JSON 缓存）
    const draftInner = DRAFT_DIR_REL + '/' + filename
    await writeTextRaw(ROOT_TRAIN, draftInner, fileContent)
    // 更新统计（写作记录.json，strip BOM 后解析）
    const recRaw = await readJson(ROOT_TRAIN, WRITING_RECORD_REL, null)
    const rec = (recRaw && typeof recRaw === 'object') ? recRaw : { version: 1, days: {}, totalWords: 0, streak: 0 }
    rec.days = rec.days || {}
    const day = rec.days[dateStr] || { words: 0, entries: 0 }
    const words = (content || '').replace(/\s+/g, '').length
    day.words = (day.words || 0) + words
    day.entries = (day.entries || 0) + 1
    rec.days[dateStr] = day
    rec.totalWords = (rec.totalWords || 0) + words
    rec.streak = (rec.streak || 0) + 1
    rec.lastSavedAt = now.toISOString()
    rec.lastFile = filename
    await writeJsonRaw(ROOT_TRAIN, WRITING_RECORD_REL, rec)
    // B4 additive：返回只增 milestoneHits（本次保存新达成的里程碑），既有字段不动
    const prevTotal = rec.totalWords - words
    const prevStreak = rec.streak - 1
    const prevDayWords = (day.words || 0) - words
    const hits = []
    for (const t of MILESTONES.totalWords) if (prevTotal < t && rec.totalWords >= t) hits.push({ kind: 'totalWords', tier: t, label: '累计 ' + (t / 10000) + ' 万字' })
    for (const t of MILESTONES.streak) if (prevStreak < t && rec.streak >= t) hits.push({ kind: 'streak', tier: t, label: '连续 ' + t + ' 天' })
    for (const t of MILESTONES.dayWords) if (prevDayWords < t && (day.words || 0) >= t) hits.push({ kind: 'dayWords', tier: t, label: '单日 ' + t + ' 字' })
    return { filename: filename, words: words, date: dateStr, totalWords: rec.totalWords, streak: rec.streak, milestoneHits: hits }
  }

  // 草稿清单（T3 / U-36，2026-09-27）：改为**真实列举** 写作训练/草稿/（含子目录）。
  // 背景：归档把 草稿/ 改成「按作品分目录」（README.md · _版本前照片/ · _阶段习作/ · 心渊纪元/ · 绝区零同人/ · 超光速末日/），
  //   原「硬编码 15 个文件名」与「单层 listDir」都不再成立（adapterFs.listDir 是**单层**的 ⇒ 顶层只看得到 README.md）。
  // 口径：返回**相对 草稿/ 的路径**（顶层文件仍是裸文件名 ⇒ 与 写作记录.json.lastFile、relations 的键一致）；
  //   只收 type==='file' 且扩展名 .md —— ⚠️ relations.json 就躺在同一目录里，不过滤会被当成草稿。
  const DRAFT_LIST_MAX_DEPTH = 4
  const DRAFT_LIST_SKIP_DIRS = ['node_modules', '_backup']
  async function listDraftRelPaths(root, rel, prefix, depth) {
    const out = []
    let entries = []
    try { entries = await adapterFs.listDir(root, rel) } catch (e) { return out }
    for (const e of (Array.isArray(entries) ? entries : [])) {
      const name = String((e && e.name) || '')
      if (!name || name.charAt(0) === '.' || DRAFT_LIST_SKIP_DIRS.indexOf(name) >= 0) continue
      const childRel = rel + '/' + name
      const childPrefix = prefix ? (prefix + '/' + name) : name
      if (e && e.type === 'directory') {
        if (depth < DRAFT_LIST_MAX_DEPTH) {
          const sub = await listDraftRelPaths(root, childRel, childPrefix, depth + 1)
          for (let i = 0; i < sub.length; i++) out.push(sub[i])
        }
      } else if (e && e.type === 'file' && /\.md$/i.test(name)) {
        out.push(childPrefix)
      }
    }
    return out
  }

  async function collectDrafts() {
    const out = []
    const seen = {}
    const push = function (n) { if (n && !seen[n]) { seen[n] = 1; out.push(n) } }
    const listed = await listDraftRelPaths(ROOT_TRAIN, DRAFT_DIR_REL, '', 0)
    listed.forEach(push)
    // 兜底：写作记录.json.lastFile 记的是某个草稿名（顶层 ⇒ 裸文件名）；幂等去重，文件已不存在时也无副作用
    const rec = await readRecord()
    if (rec && rec.lastFile) push(rec.lastFile)
    return out
  }

  // 训练/当日成果聚合：写作记录 + 日程 + 草稿 + 关联
  async function trainingOverview() {
    // 性能优化(2026-08-26)：Promise.all 并行读 4 个文件替代串行 await（原串行=4×RTT，并行=1×RTT）
    const [record, relations, drafts, lib] = await Promise.all([
      readRecord(), readRelations(), collectDrafts(), readInspLib()
    ])
    const days = (record && record.days && typeof record.days === 'object') ? record.days : {}
    const dayKeys = Object.keys(days).sort()
    const daily = dayKeys.map(function (k) {
      return { date: k, words: Number(days[k].words || 0), entries: Number(days[k].entries || 0) }
    })
    // 草稿→关联（relations.relations[draftName]）
    const draftInfo = drafts.map(function (dn) {
      const rel = (relations.relations || {})[dn] || null
      let inspTitle = ''
      if (rel && rel.refInspId) {
        const insp = lib.entries.find(function (e) { return e.id === rel.refInspId })
        if (insp) inspTitle = insp.title
      }
      return { name: dn, relation: rel, inspTitle: inspTitle }
    })
    // 按灵感聚合：每个灵感关联的草稿
    const byInsp = {}
    lib.entries.forEach(function (e) {
      const related = draftInfo.filter(function (d) { return d.relation && d.relation.refInspId === e.id }).map(function (d) { return d.name })
      if (related.length) byInsp[e.id] = { title: e.title, drafts: related }
    })
    return {
      record: record ? { totalWords: record.totalWords || 0, streak: record.streak || 0, days: dayKeys.length, lastFile: record.lastFile || '' } : { totalWords: 0, streak: 0, days: 0, lastFile: '' },
      daily: daily,
      draftCount: drafts.length,
      drafts: draftInfo,
      byInsp: byInsp,
      relationsCount: Object.keys(relations.relations || {}).length
    }
  }

  // ============ 记忆工作台 Phase2（2026-09-03 additive）：U4-U8 host 侧实现 ============
  // 铁律：所有新 sidecar 落根 写作训练（writing-studio 自持）；跨插件写/算一律 host 内 loopback HTTP 既有端点；不直写三插件数据文件。
  function assetId(prefix) {
    const tail = Date.now().toString(36).slice(-6)
    const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')
    return prefix + '-' + tail + '-' + rand
  }
  function normTags(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x || '').trim() }).filter(Boolean)
    return String(v || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
  }
  // ---- U4 sidecar 读写（作品库.json / 灵感资产.json；读一律 cache:false）----
  async function readWorks() {
    const d = await memRead(ROOT_TRAIN, WORKS_LIB_REL, { version: 1, works: [], updatedAt: null })
    return { works: (d && Array.isArray(d.works)) ? d.works : [], updatedAt: (d && d.updatedAt) || null }
  }
  async function readUses() {
    const d = await memRead(ROOT_TRAIN, INSP_ASSET_REL, { version: 1, uses: {}, updatedAt: null })
    return { uses: (d && d.uses && typeof d.uses === 'object') ? d.uses : {}, updatedAt: (d && d.updatedAt) || null }
  }
  async function writeWorks(works) {
    const data = { version: 1, works: works, updatedAt: new Date().toISOString() }
    await writeJsonRaw(ROOT_TRAIN, WORKS_LIB_REL, data)
    return data
  }
  async function writeUses(uses) {
    const data = { version: 1, uses: uses, updatedAt: new Date().toISOString() }
    await writeJsonRaw(ROOT_TRAIN, INSP_ASSET_REL, data)
    return data
  }
  // U4 聚合图谱：作品（含灵感数）+ 使用关系（补 workTitle，丢弃孤儿）+ 灵感标题映射
  async function assetGraph() {
    const [w, u, lib] = await Promise.all([readWorks(), readUses(), readInspLib()])
    const works = w.works
    const uses = u.uses
    const entries = (lib && Array.isArray(lib.entries)) ? lib.entries : []
    const inspTitles = {}
    entries.forEach(function (e) { inspTitles[e.id] = e.title })
    const workById = {}
    works.forEach(function (wk) { workById[wk.id] = wk })
    const cleanUses = {}
    const countByWork = {}
    Object.keys(uses).forEach(function (inspId) {
      const kept = []
      ;(Array.isArray(uses[inspId]) ? uses[inspId] : []).forEach(function (r) {
        if (!workById[r.workId]) return // 孤儿关系（作品已删）丢弃
        kept.push({ workId: r.workId, role: r.role, adapt: r.adapt || '', status: r.status || '在用', updatedAt: r.updatedAt || null, workTitle: (workById[r.workId] && workById[r.workId].title) || '' })
        countByWork[r.workId] = (countByWork[r.workId] || 0) + 1
      })
      if (kept.length) cleanUses[inspId] = kept
    })
    const worksOut = works.map(function (wk) {
      return { id: wk.id, title: wk.title, note: wk.note || '', createdAt: wk.createdAt || null, updatedAt: wk.updatedAt || null, inspCount: countByWork[wk.id] || 0 }
    })
    return { ok: true, works: worksOut, uses: cleanUses, inspTitles: inspTitles, updatedAt: new Date().toISOString() }
  }
  // U5 作品档案聚合：作品→使用的灵感（角色/改造说明）+ 关联草稿（标题关键词/relations 命中，host 补字数）+ 关联设定（settingsRef stat 校验）；只读
  async function workArchive(workId) {
    const [w, u, lib, relations, draftNames] = await Promise.all([readWorks(), readUses(), readInspLib(), readRelations(), collectDrafts()])
    const work = w.works.find(function (x) { return x.id === workId })
    if (!work) return null
    const entries = (lib && Array.isArray(lib.entries)) ? lib.entries : []
    const inspById = {}
    entries.forEach(function (e) { inspById[e.id] = e })
    const inspirations = []
    const inspIdSet = {}
    Object.keys(u.uses).forEach(function (inspId) {
      ;(Array.isArray(u.uses[inspId]) ? u.uses[inspId] : []).forEach(function (r) {
        if (r.workId !== workId) return
        const e = inspById[inspId] || {}
        inspirations.push({ inspId: inspId, title: e.title || inspId, role: r.role, adapt: r.adapt || '', status: r.status || '在用', oneLiner: e.oneLiner || '', tags: Array.isArray(e.tags) ? e.tags : [] })
        inspIdSet[inspId] = 1
      })
    })
    const kw = String(work.title || '').trim().toLowerCase()
    const kwNorm = String(work.title || '').replace(/[《》#0123456789\s]/g, '') // 去书名号/数字/空白后按标题词匹配（仿 taskkit overview L2015）
    const relMap = (relations && relations.relations) || {}
    const drafts = []
    const seenDraft = {}
    for (const dn of draftNames) {
      const low = String(dn).toLowerCase()
      const stem = String(dn).replace(/\.md$/i, '')
      const rel = relMap[dn]
      const relHit = !!(rel && (inspIdSet[rel.refInspId] || inspIdSet[rel.refResourceId]))
      // settingsRef 指向的灵感库文件也算草稿/设定命中（refBasename 命中草稿名）
      let refBaseHit = false
      if (rel && rel.refInspId && inspIdSet[rel.refInspId]) refBaseHit = true
      const kwHit = !!(kw && low.indexOf(kw) >= 0) || (kwNorm && kwNorm.length >= 2 && String(dn).indexOf(kwNorm) >= 0)
      if (!kwHit && !relHit && !refBaseHit) continue
      if (seenDraft[dn]) continue
      seenDraft[dn] = 1
      let words = null
      try {
        const txt = await adapterFs.readText(await absOf(ROOT_TRAIN, DRAFT_DIR_REL + '/' + dn))
        words = String(txt || '').replace(/\s+/g, '').length
      } catch (e) { words = null }   // 缺失/读取失败 → null（与迁移前 fs.resolve+fs.readText 的 catch 口径一致）
      let viaTitle = ''
      if (relHit || refBaseHit) { const e = inspById[rel && (rel.refInspId || rel.refResourceId)] || {}; viaTitle = e.title || '' }
      drafts.push({ name: dn, inspTitle: viaTitle, words: words })
    }
    const settings = []
    for (const inspId of Object.keys(inspIdSet)) {
      const e = inspById[inspId]
      const ref = e && e.settingsRef ? String(e.settingsRef) : ''
      if (!ref) continue
      // settingsRef 双形状解析唯一入口 = adapterFs.resolveRef（相对引用 → 登记根 写作训练；盘符/斜杠开头绝对路径直解）：
      // 迁移前为 /^([a-zA-Z]:[\\/]|[\\/])/.test(ref) ? ref : (旧 DATA_ROOT 常量 + '/' + ref) 的等价实现（O5 §2.2 行 29）
      const refPath = await absOfRef(ref, ROOT_TRAIN)
      let exists = false
      try { const info = await adapterFs.stat(refPath); exists = !!info } catch (e2) { exists = false }
      settings.push({ inspId: inspId, title: e.title || inspId, settingsRef: ref, exists: exists })
    }
    return {
      ok: true,
      work: { id: work.id, title: work.title, note: work.note || '', updatedAt: work.updatedAt || null },
      inspirations: inspirations,
      drafts: drafts,
      settings: settings,
      updatedAt: new Date().toISOString()
    }
  }
  // ---- U7 loopback 助手（O5 迁移：统一经 adapterHttp —— apiBase 解析 / POST 避缓存 / 8s 超时 / 非2xx 透传 body.error）----
  // memApiBase 保留为薄委派（diagnostics + 降级提示用），实际解析在 adapterHttp.apiBase()（env DSH_WEB_URL 回退 127.0.0.1:3080）
  function memApiBase() {
    if (adapterHttp && typeof adapterHttp.apiBase === 'function') return adapterHttp.apiBase()
    return 'http://127.0.0.1:3080'
  }
  // 调用面形状保持 { status, ok, data, error } 不变（adapterHttp.post(...,{throwOnError:false}) 逐一对应）
  async function loopPost(path, payload) {
    if (!adapterHttp) return { status: 0, ok: false, data: null, error: 'no-adapterHttp（@local/dsh-adapter 未加载；apiBase=' + memApiBase() + '）' }
    return adapterHttp.post(path, payload || {}, { throwOnError: false })
  }
  async function readDistillHistory() {
    const d = await memRead(ROOT_TRAIN, DISTILL_HISTORY_REL, { version: 1, history: [], updatedAt: null })
    return { history: (d && Array.isArray(d.history)) ? d.history : [], updatedAt: (d && d.updatedAt) || null }
  }
  async function appendDistill(entry) {
    const h = await readDistillHistory()
    const history = [entry].concat(h.history).slice(0, 200)
    const data = { version: 1, history: history, updatedAt: new Date().toISOString() }
    await writeJsonRaw(ROOT_TRAIN, DISTILL_HISTORY_REL, data)
    return history
  }
  // U7 三路落库（仅下游成功后写提炼历史；失败透传不写历史）。downstreamId 取下游 data.id（r1：insp/kb/memory 均返回 id）
  async function distillInsp(input) {
    const payload = { title: String(input.title || '').trim(), oneLiner: String(input.oneLiner || ''), content: String(input.content || ''), tags: normTags(input.tags), hook: String(input.hook || ''), source: '对话提炼' }
    const r = await loopPost('/taskkit/api/insp/create', payload)
    if (!r.ok) return { ok: false, target: 'insp', error: r.error || '灵感落库失败' }
    const downstreamId = (r.data && (r.data.id || (r.data.entry && r.data.entry.id))) || ''
    const history = await appendDistill(Object.assign({ id: assetId('distill'), at: new Date().toISOString(), target: 'insp', title: payload.title, contentPreview: payload.content.slice(0, 80), source: '对话提炼', downstreamId: downstreamId, ok: true }, distillSourceFields(input)))
    return { ok: true, target: 'insp', downstreamId: downstreamId, history: history }
  }
  async function distillKb(input) {
    let category = String(input.category || '').trim()
    if (KB_CATEGORIES.indexOf(category) < 0) category = '通用' // 白名单兜底，避免建杂类
    const payload = { title: String(input.title || '').trim(), description: String(input.description || ''), content: String(input.content || ''), category: category, tags: normTags(input.tags), aliases: normTags(input.aliases), source: '对话提炼' }
    const r = await loopPost('/knowledge-base/api/add', payload)
    if (!r.ok) return { ok: false, target: 'kb', error: r.error || '知识库落库失败' }
    const downstreamId = (r.data && r.data.id) || ''
    const history = await appendDistill(Object.assign({ id: assetId('distill'), at: new Date().toISOString(), target: 'kb', title: payload.title, contentPreview: payload.content.slice(0, 80), source: '对话提炼', downstreamId: downstreamId, ok: true }, distillSourceFields(input)))
    return { ok: true, target: 'kb', downstreamId: downstreamId, history: history }
  }
  async function distillMemory(input) {
    const now = new Date()
    const p2 = function (n) { return String(n).padStart(2, '0') }
    const autoTask = 'distill-' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate())
    let type = String(input.type || 'message').trim()
    if (MEMORY_RECORD_TYPES.indexOf(type) < 0) type = 'message'
    const payload = { taskId: String(input.taskId || '').trim() || autoTask, type: type, content: String(input.content || ''), title: String(input.title || ''), project: String(input.project || ''), tags: normTags(input.tags), source: 'distill' }
    const r = await loopPost('/memory-system/api/record', payload)
    if (!r.ok) return { ok: false, target: 'memory', error: r.error || '工程记忆落库失败' }
    const downstreamId = (r.data && r.data.id) || ''
    const history = await appendDistill(Object.assign({ id: assetId('distill'), at: new Date().toISOString(), target: 'memory', title: payload.title || payload.taskId, contentPreview: payload.content.slice(0, 80), source: '对话提炼', taskId: payload.taskId, downstreamId: downstreamId, ok: true }, distillSourceFields(input)))
    return { ok: true, target: 'memory', taskId: payload.taskId, downstreamId: downstreamId, history: history }
  }
  // ---- U8 用户偏好（用户偏好.json；白名单 merge；创作原点=灵感库 fixed 只读；记忆策略不写 memory.json）----
  function defaultPrefs() {
    return { writing: { genre: '', writingTime: '', remindersNote: '', goalWords: 0, goalStreak: 0, style: '' }, engineering: { techTendency: '', strictness: '标准', toolPrefs: [] } }
  }
  async function readPrefs() {
    const d = await memRead(ROOT_TRAIN, USER_PREFS_REL, null)
    const base = defaultPrefs()
    if (d && d.writing && typeof d.writing === 'object') Object.assign(base.writing, d.writing)
    if (d && d.engineering && typeof d.engineering === 'object') Object.assign(base.engineering, d.engineering)
    base.writing.goalWords = Math.max(0, Number(base.writing.goalWords) || 0)
    base.writing.goalStreak = Math.max(0, Number(base.writing.goalStreak) || 0)
    base.writing.genre = String(base.writing.genre || '')
    base.writing.writingTime = String(base.writing.writingTime || '')
    base.writing.remindersNote = String(base.writing.remindersNote || '')
    base.writing.style = String(base.writing.style || '')
    base.engineering.techTendency = String(base.engineering.techTendency || '')
    if (PREFS_STRICTNESS.indexOf(base.engineering.strictness) < 0) base.engineering.strictness = '标准'
    if (!Array.isArray(base.engineering.toolPrefs)) base.engineering.toolPrefs = normTags(base.engineering.toolPrefs)
    return { prefs: base, updatedAt: (d && d.updatedAt) || null }
  }
  async function prefsGet() {
    const [p, lib, rec] = await Promise.all([readPrefs(), readInspLib(), readRecord()])
    const entries = (lib && Array.isArray(lib.entries)) ? lib.entries : []
    const origins = entries.filter(function (e) { return e.fixed === true }).map(function (e) {
      return { id: e.id, title: e.title || '', oneLiner: e.oneLiner || '', tags: Array.isArray(e.tags) ? e.tags : [] }
    })
    return { ok: true, writing: p.prefs.writing, engineering: p.prefs.engineering, origins: origins, reminders: (rec && rec.reminders) || [], updatedAt: p.updatedAt }
  }
  async function prefsSet(input) {
    const cur = await readPrefs()
    const w = cur.prefs.writing
    const en = cur.prefs.engineering
    const iw = (input && input.writing && typeof input.writing === 'object') ? input.writing : {}
    const ie = (input && input.engineering && typeof input.engineering === 'object') ? input.engineering : {}
    if (iw.genre !== undefined) w.genre = String(iw.genre || '')
    if (iw.writingTime !== undefined) w.writingTime = String(iw.writingTime || '')
    if (iw.remindersNote !== undefined) w.remindersNote = String(iw.remindersNote || '')
    if (iw.style !== undefined) w.style = String(iw.style || '')
    if (iw.goalWords !== undefined) w.goalWords = Math.max(0, Number(iw.goalWords) || 0)
    if (iw.goalStreak !== undefined) w.goalStreak = Math.max(0, Number(iw.goalStreak) || 0)
    if (ie.techTendency !== undefined) en.techTendency = String(ie.techTendency || '')
    if (ie.strictness !== undefined) en.strictness = PREFS_STRICTNESS.indexOf(String(ie.strictness)) >= 0 ? String(ie.strictness) : '标准'
    if (ie.toolPrefs !== undefined) en.toolPrefs = normTags(ie.toolPrefs)
    const data = { version: 1, writing: w, engineering: en, updatedAt: new Date().toISOString() }
    await writeJsonRaw(ROOT_TRAIN, USER_PREFS_REL, data)
    return { ok: true, writing: w, engineering: en, updatedAt: data.updatedAt }
  }

  // ============ U2 复用标记 sidecar 读写核心（2026-09-05 additive：从 HTTP handler 抽出，HTTP action 与 agent 工具共用同一实现，行为一致） ============
  // 读：镜像原 reuseList handler —— memRead(cache:false) 读盘（sidecar 极小且可能被外部编辑/删除，禁 30s 陈旧）
  async function readReuseMarks() {
    const d = await memRead(ROOT_TRAIN, INSP_REUSE_REL, { version: 1, marks: {} })
    return { marks: (d && d.marks) || {}, updatedAt: (d && d.updatedAt) || null }
  }
  // 设/清：镜像原 reuseSet handler 语义 —— id 必填；role 可选 主轴/支线/改造，role='' 清除；非法 role/缺 id 返回 { status:400, error }
  // 落盘与失效语义与原 action 完全一致（adapterFs 写后自动失效同键缓存）；写失败返回 { status:500, error }；成功返回 { status:200, id, role, marks }
  async function applyReuseMark(id, role) {
    const cleanId = String(id || '').trim()
    if (!cleanId) return { status: 400, error: '缺少 id' }
    const cleanRole = String(role || '').trim()
    if (cleanRole && INSP_REUSE_ROLES.indexOf(cleanRole) < 0) return { status: 400, error: '非法复用标记: ' + cleanRole + '（可选 主轴/支线/改造）' }
    try {
      const data = Object.assign({ version: 1, marks: {} }, await readJson(ROOT_TRAIN, INSP_REUSE_REL, { version: 1, marks: {} }))
      data.marks = data.marks || {}
      if (cleanRole) data.marks[cleanId] = { role: cleanRole, updatedAt: new Date().toISOString() }
      else delete data.marks[cleanId]
      data.updatedAt = new Date().toISOString()
      await writeJsonRaw(ROOT_TRAIN, INSP_REUSE_REL, data)
      return { status: 200, id: cleanId, role: cleanRole, marks: data.marks }
    } catch (e) {
      return { status: 500, error: '写入失败: ' + String(e && e.message || e) }
    }
  }

  // ============ 记忆工作台 Phase3 批次2 host 实现（2026-09-06 additive）============
  // 铁律沿用 Phase2 §11/§12：跨插件写/算一律 host loopback（复用 memApiBase/loopPost：env DSH_WEB_URL 回退 3080、8s 超时、非2xx 透传 body.error）；
  // 新 sidecar 只落根 写作训练 且首写才建（缺失=空态）；sessionQuery 宿主服务只读引用（ctx.get 惰性取用，缺失/超时一律降级返回不可用提示，绝不崩溃）。
  // ---- ① loopback 透传助手：下游 4xx/5xx 原状态透传 body（保留 code/taskId 等字段），网络不可达/非 JSON → 502 ----
  async function memProxyPassthrough(path, payload) {
    const r = await loopPost(path, payload)
    if (r.ok && r.data && r.data.ok !== false) return { status: 200, body: r.data }
    const st = (r.status >= 400 && r.status < 600) ? r.status : 502
    const data = (r.data && typeof r.data === 'object') ? r.data : null
    const body = Object.assign({ ok: false }, data || {}, { error: (data && data.error) || r.error || ('下游不可达: ' + path) })
    return { status: st, body: body }
  }
  // ---- ① memArchiveList：归档清单只读投影（cache:false 镜像；字段截断——不投影 md 摘要/原文路径/raw 聚合）----
  async function memArchiveListFn() {
    let manifest = null
    try { manifest = await memReadRef(MEM_ARCHIVE_MANIFEST_REL, null, ROOT_ARCHIVE) } catch (e) { manifest = null }
    const am = (manifest && manifest.archived && typeof manifest.archived === 'object') ? manifest.archived : {}
    const entries = []
    let restored = 0
    Object.keys(am).forEach(function (taskId) {
      const e = am[taskId] || {}
      if (e.restored === true) restored++
      entries.push({
        task_id: String(e.task_id || taskId || ''),
        title: String(e.title || taskId || ''),
        project: String(e.project || ''),
        archived_at: e.archived_at || null,
        readCount: Number(e.readCount) || 0,
        lastReadAt: e.lastReadAt || null,
        compressed: e.compressed === true,
        kb_indexed: e.kb_indexed === true,
        original_moved: e.original_moved === true,
        restored: e.restored === true,
        restored_at: e.restored_at || null
      })
    })
    // 排序：未复原在前、按 archived_at 倒序（最近归档置顶）
    entries.sort(function (a, b) {
      return ((a.restored ? 1 : 0) - (b.restored ? 1 : 0)) || String(b.archived_at || '').localeCompare(String(a.archived_at || ''))
    })
    return { status: 200, body: { ok: true, ts: Date.now(), count: entries.length, restored: restored, entries: entries } }
  }
  // ---- ② memConfigSet host 白名单校验（对齐 memory-system CONFIG_WHITELIST L1562-1568；仅 memoryScore 命名空间，其余键 400；{} → 读模式透传）----
  function memConfigPayloadError(input) {
    input = input || {}
    const topKeys = Object.keys(input)
    const extra = topKeys.filter(function (k) { return k !== 'memoryScore' })
    if (extra.length) return '非法配置键: ' + extra[0] + '（config 写白名单仅 memoryScore；rawPolicy/migration/retireWatchdog 等只读）'
    if (!topKeys.length) return null
    const ms = input.memoryScore
    if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return 'memoryScore 必须是对象'
    for (const k of Object.keys(ms)) {
      const rule = MEM_SCORE_WHITELIST[k]
      if (!rule) return '非法配置键: memoryScore.' + k + '（白名单: ' + Object.keys(MEM_SCORE_WHITELIST).join(', ') + '）'
      const v = ms[k]
      if (k === 'enabled') {
        if (typeof v !== 'boolean') return 'memoryScore.enabled 必须是布尔值 true/false'
      } else if (k === 'weights') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return 'memoryScore.weights 必须是对象 {importance,accessLog,priority,reinforcement}（每项 0-1）'
        for (const wk of Object.keys(v)) {
          if (!MEM_SCORE_WEIGHTS[wk]) return '非法权重键: memoryScore.weights.' + wk + '（白名单: ' + Object.keys(MEM_SCORE_WEIGHTS).join(', ') + '）'
          const wv = v[wk]
          if (typeof wv !== 'number' || !isFinite(wv) || wv < 0 || wv > 1) return 'memoryScore.weights.' + wk + ' 必须是 0-1 数值'
        }
      } else {
        const max = rule === '0-10000' ? 10000 : 1
        if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > max) return 'memoryScore.' + k + ' 必须是 0-' + max + ' 数值'
      }
    }
    return null
  }
  // ---- ⑤ A1 kbDomainSearch：写作侧 category 白名单直读镜像（主口径，现网 domain=写作 为 0）+ 已落 domain 领域 HTTP /search 直传（§6.2/V1 定稿）----
  async function kbReadMirror() {
    try {
      const raw = await memRead(ROOT_DATA, KB_MIRROR_REL, null)
      return (raw && Array.isArray(raw.entries)) ? raw.entries : null
    } catch (e) { return null }
  }
  function kbEntrySearchText(e) {
    return [e && e.title, e && e.description, e && e.content, Array.isArray(e && e.tags) ? e.tags.join(' ') : '', Array.isArray(e && e.aliases) ? e.aliases.join(' ') : '', e && e.category, e && e.domain].join(' ').toLowerCase()
  }
  function kbProject(e) {
    return {
      id: (e && e.id) || '',
      title: String((e && e.title) || ''),
      description: String((e && e.description) || '').slice(0, 200),
      category: String((e && e.category) || ''),
      domain: String((e && e.domain) || ''),
      tags: Array.isArray(e && e.tags) ? e.tags : [],
      updatedAt: (e && e.updatedAt) || null
    }
  }
  async function kbDomainSearchFn(input) {
    input = input || {}
    const q = String(input.q || '').trim()
    const domain = String(input.domain || '').trim()
    const ql = q.toLowerCase()
    // ① 已落 domain 领域（任意非「写作」domain 值）：knowledge-base /search 原生 domain 过滤直传（V1 核实：action L240-251 透传 domain，searchEntries 按 e.domain===domain 精确过滤）
    if (domain && domain !== '写作') {
      const r = await loopPost('/knowledge-base/api/search', { q: q, domain: domain })
      if (r.ok && r.data) {
        const d = r.data || {}
        const entries = Array.isArray(d.entries) ? d.entries : []
        return { status: 200, body: { ok: true, mode: 'http-search', channel: 'kb-http', q: q, domain: domain, total: Number(d.total) || entries.length, count: entries.length, entries: entries } }
      }
      // 降级：直读镜像按 entry.domain 过滤（best-effort；镜像不可读则标注 file-unfiltered 返回空，不崩溃）
      const all = await kbReadMirror()
      if (!all) return { status: 200, body: { ok: true, mode: 'mirror', channel: 'file-unfiltered', q: q, domain: domain, total: 0, count: 0, entries: [], note: '知识库 HTTP 与直读镜像均不可用（未过滤，返回空）' } }
      const matched = all.filter(function (e) { return String(e.domain || '') === domain && (!q || kbEntrySearchText(e).indexOf(ql) >= 0) })
      return { status: 200, body: { ok: true, mode: 'mirror', channel: 'mirror-domain', q: q, domain: domain, total: matched.length, count: matched.length, entries: matched.map(kbProject) } }
    }
    // ② 写作 = category 白名单直读镜像；领域空 = 全量（不限制 domain/category）
    const all = await kbReadMirror()
    if (!all) return { status: 200, body: { ok: true, mode: 'mirror', channel: 'file-unfiltered', q: q, domain: domain || null, total: 0, count: 0, entries: [], note: '直读 knowledge.json 不可用（文件缺失/解析失败），返回空' } }
    const categoryOnly = domain === '写作'
    const matched = all.filter(function (e) {
      if (categoryOnly && KB_CATEGORIES.indexOf(String(e.category || '')) < 0) return false
      if (!q) return true
      return kbEntrySearchText(e).indexOf(ql) >= 0
    })
    const byCategory = {}
    matched.forEach(function (e) { const c = String(e.category || ''); byCategory[c] = (byCategory[c] || 0) + 1 })
    return { status: 200, body: { ok: true, mode: 'mirror', channel: categoryOnly ? 'mirror-category' : 'mirror-full', q: q, domain: domain || null, total: matched.length, count: matched.length, byCategory: byCategory, entries: matched.map(kbProject) } }
  }
  // sessionQuery 只读辅助（缺失/超时降级；宿主服务不注入上下文、不写会话）
  function sqAvailable() {
    const sq = ctx.get('sessionQuery')
    return !!(sq && typeof sq.listSessions === 'function' && typeof sq.listEvents === 'function' && typeof sq.filterEvents === 'function')
  }
  function sqRace(promiseFactory, fallback) {
    return Promise.race([Promise.resolve().then(promiseFactory), new Promise(function (resolve) { setTimeout(function () { resolve(fallback) }, SQ_TIMEOUT_MS) })])
  }
  // 会话清单记录缓存：listSessions 持久化全量列读实测 >8s（508 段/193MB），模块级 30s 缓存避免 UI 轮询反复全量列读（仿 taskkit titleOf 30s 缓存先例）
  let sessionRecordsMemo = null // { ts, recs }
  async function sqListRecords() {
    const sq = ctx.get('sessionQuery')
    if (!sq || typeof sq.listSessions !== 'function') return null
    if (sessionRecordsMemo && (Date.now() - sessionRecordsMemo.ts) < 120000) return sessionRecordsMemo.recs
    try {
      const recs = await Promise.race([Promise.resolve().then(function () { return sq.listSessions() }), new Promise(function (resolve) { setTimeout(function () { resolve(null) }, SQ_LIST_TIMEOUT_MS) })])
      if (Array.isArray(recs)) {
        sessionRecordsMemo = { ts: Date.now(), recs: recs }
        return recs
      }
      return null
    } catch (e) { return null }
  }
  async function sqSessionTitle(sessionId) {
    const sq = ctx.get('sessionQuery')
    if (!sq || !sessionId) return ''
    try {
      if (typeof sq.readTitleSnapshot === 'function') {
        const sn = await sqRace(function () { return sq.readTitleSnapshot(sessionId) }, undefined)
        const val = (sn && typeof sn === 'object' && sn.value !== undefined) ? sn.value : sn
        if (val && typeof val.title === 'string' && val.title) return val.title
      }
    } catch (e) { /* 标题降级为空串 */ }
    return ''
  }
  function sqEventMeta(ev) {
    return { seq: Number(ev && ev.seq) || 0, type: String((ev && ev.type) || ''), time: (ev && ev.time) || null, surface: String((ev && ev.surface) || 'log-only'), text: '' }
  }
  function sqNormHit(h) {
    return { seq: Number(h && h.seq) || 0, type: String((h && h.type) || ''), time: (h && h.time) || null, surface: String((h && h.surface) || 'log-only'), text: String((h && h.text) || '').slice(0, 300) }
  }
  // 会话事件→消息文本（镜像宿主 extractSessionEventText 语义的宽容版：只取 message/todo 可读文本，未知结构安全返回空串）
  function sqBlocksText(blocks) {
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'tool-result') parts.push(sqBlocksText(b.content))
    }
    return parts.filter(Boolean).join(' ')
  }
  function sqMessageText(ev) {
    if (!ev || typeof ev !== 'object') return ''
    const type = ev.type
    const data = ev.data || {}
    if (type === 'user/message') return sqBlocksText(data.content)
    if (type === 'assistant/message' || type === 'tool/result') return sqBlocksText(data.message && data.message.content)
    if (type === 'todo/write') {
      const todos = Array.isArray(data.todos) ? data.todos : []
      return todos.map(function (t) { return String((t && (t.status || '')) + ' ' + (t && t.content || '')).trim() }).filter(Boolean).join(' ')
    }
    return ''
  }
  function sqMapThrown(e, sessionId) {
    const msg = String((e && e.message) || e)
    if (/not found|SESSION_QUERY_SESSION_NOT_FOUND|no session|no such session/i.test(msg)) return { status: 404, body: { ok: false, error: '会话不存在: ' + sessionId } }
    return { status: 200, body: { ok: false, degraded: true, error: '会话读取失败: ' + msg } }
  }
  async function sessionListFn() {
    if (!sqAvailable()) return { status: 200, body: { ok: false, degraded: true, error: '会话回顾检索暂不可用（sessionQuery 服务未挂载）' } }
    const recs = await sqListRecords()
    if (!Array.isArray(recs)) return { status: 200, body: { ok: false, degraded: true, error: '会话列表读取超时或失败（8s 守卫）' } }
    // 实测（2026-09-05，508 段/193MB 会话日志）：persisted 会话标题折叠需整段解码其 .zstd 日志（同步阻塞事件循环，无分页/部分读 API），
    // 批量折叠 = 数十秒挂起 → 依 §7.2a/R2（8s 兜底 + 标题缺失回退 header.id）：只对 live 会话折叠标题（内存快照零解码），
    // persisted-only 会话 title 置 ''（client 显示 header.id 兜底，检索/单会话标题在 sessionSearch/Recent 内按需取）
    const pairs = recs.slice(0, 100).map(function (rec) {
      const h = (rec && rec.header && typeof rec.header === 'object') ? rec.header : {}
      return { rec: rec, row: { id: String(h.id || ''), title: '', cwd: h.cwd || null, createdAt: h.createdAt || null } }
    })
    const sq = ctx.get('sessionQuery')
    const liveIds = pairs.filter(function (p) { return p.rec.live === true }).map(function (p) { return p.row.id }).filter(Boolean)
    if (liveIds.length && sq && typeof sq.readTitleSnapshots === 'function') {
      try {
        const snaps = await sqRace(function () { return sq.readTitleSnapshots(liveIds) }, undefined)
        if (Array.isArray(snaps)) {
          pairs.forEach(function (p) {
            const j = liveIds.indexOf(p.row.id)
            if (j < 0) return
            const sn = snaps[j]
            const val = (sn && sn.status === 'fulfilled' && sn.value) ? sn.value : null
            if (val && typeof val.title === 'string' && val.title) p.row.title = val.title
          })
        }
      } catch (e) { /* 标题折叠失败不阻断列表 */ }
    }
    return { status: 200, body: { ok: true, total: recs.length, count: pairs.length, sessions: pairs.map(function (p) { return p.row }) } }
  }
  async function sessionSearchFn(input) {
    input = input || {}
    const sessionId = String(input.sessionId || '').trim()
    if (!sessionId) return { status: 400, body: { ok: false, error: '缺少 sessionId' } }
    if (!sqAvailable()) return { status: 200, body: { ok: false, degraded: true, error: '会话回顾检索暂不可用（sessionQuery 服务未挂载）' } }
    const sq = ctx.get('sessionQuery')
    const q = String(input.q || '').trim()
    const types = []
    if (input.types !== undefined && input.types !== null && String(input.types).trim() !== '') {
      const arr = Array.isArray(input.types) ? input.types : String(input.types).split(',')
      arr.map(function (s) { return String(s).trim() }).filter(Boolean).forEach(function (t) { if (SESSION_EVENT_TYPES.indexOf(t) >= 0 && types.indexOf(t) < 0) types.push(t) })
      const bad = arr.map(function (s) { return String(s).trim() }).filter(Boolean).filter(function (t) { return SESSION_EVENT_TYPES.indexOf(t) < 0 })
      if (bad.length) return { status: 400, body: { ok: false, error: '非法事件类型: ' + bad[0] + '（可选 ' + SESSION_EVENT_TYPES.join('|') + '）' } }
    }
    let limit = Math.floor(Number(input.limit)) || 0
    if (limit < 1) limit = 50
    if (limit > 50) limit = 50
    const recentN = Math.floor(Number(input.recentN)) || 0
    const recentOnly = input.recentOnly === true || String(input.recentOnly) === 'true'
    let mode = 'list'
    let events = null
    try {
      if (q) {
        mode = 'filter'
        const filters = [{ kind: 'text', text: q }]
        if (types.length) filters.push({ kind: 'type', values: types })
        if (recentOnly) filters.push({ kind: 'surface', values: ['current'] })
        events = await sqRace(function () { return sq.filterEvents(sessionId, filters) }, undefined)
      } else if (recentOnly) {
        mode = 'surface'
        const surf = await sqRace(function () { return sq.readSurface(sessionId) }, undefined)
        events = (surf && Array.isArray(surf.events)) ? surf.events.map(function (ev) {
          return { seq: ev && ev.seq, type: ev && ev.type, time: ev && ev.time, surface: 'current', text: sqMessageText(ev) }
        }) : undefined
      } else {
        mode = 'list'
        events = await sqRace(function () { return sq.listEvents(sessionId) }, undefined)
        if (Array.isArray(events)) events = events.map(sqEventMeta)
      }
    } catch (e) {
      return sqMapThrown(e, sessionId)
    }
    if (!Array.isArray(events)) return { status: 200, body: { ok: false, degraded: true, error: '会话事件读取超时（8s 守卫），请稍后重试' } }
    let hits = events
    if (!q && types.length) hits = hits.filter(function (h) { return types.indexOf(h.type) >= 0 })
    let tailN = limit
    if (!q && recentN > 0) tailN = Math.min(recentN, 50)
    const total = hits.length
    const tail = hits.slice(-tailN).map(sqNormHit)
    const title = await sqSessionTitle(sessionId)
    return { status: 200, body: { ok: true, session: { id: sessionId, title: title }, mode: mode, total: total, count: tail.length, hits: tail } }
  }
  async function sessionRecentFn(input) {
    input = input || {}
    const sessionId = String(input.sessionId || '').trim()
    if (!sessionId) return { status: 400, body: { ok: false, error: '缺少 sessionId' } }
    if (!sqAvailable()) return { status: 200, body: { ok: false, degraded: true, error: '会话回顾检索暂不可用（sessionQuery 服务未挂载）' } }
    const sq = ctx.get('sessionQuery')
    let n = Math.floor(Number(input.n)) || 10
    if (n < 1) n = 10
    if (n > 50) n = 50
    let events = null
    try {
      events = await sqRace(function () { return sq.listEvents(sessionId) }, undefined)
    } catch (e) {
      return sqMapThrown(e, sessionId)
    }
    if (!Array.isArray(events)) return { status: 200, body: { ok: false, degraded: true, error: '会话事件读取超时（8s 守卫），请稍后重试' } }
    const total = events.length
    const recent = events.slice(-n).map(sqEventMeta)
    const title = await sqSessionTitle(sessionId)
    return { status: 200, body: { ok: true, session: { id: sessionId, title: title }, total: total, count: recent.length, recent: recent } }
  }
  // ---- ⑥ 待提炼队列：启发式猜判（本地规则纯函数，不做 LLM；灵感句式/方案/教训/结论触发词 + 长度阈值，透明可解释）----
  function queueGuessKind(text) {
    const t = String(text || '')
    const rules = {
      '灵感': ['灵感', '点子', '脑洞', '桥段', '人设', '世界观', '剧情', '番外', '构思', '想写', '可以写', '写成', '如果写', '如果我是', '设定'],
      '经验': ['踩坑', '教训', '报错', '失败', '注意', '坑', '经验', '方案', '做法', '解决', '原来', '记得', '遇到', '修复'],
      '结论': ['结论', '决定', '确定', '拍板', '最终', '采用', '采纳', '定稿', '选择', '建议', '就这么办', '敲定']
    }
    const hitWords = { '灵感': [], '经验': [], '结论': [] }
    Object.keys(rules).forEach(function (k) {
      hitWords[k] = rules[k].filter(function (w) { return t.indexOf(w) >= 0 })
    })
    const scores = { '灵感': hitWords['灵感'].length, '经验': hitWords['经验'].length, '结论': hitWords['结论'].length }
    const order = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a] })
    const top = order[0]
    const topHits = scores[top]
    let kind = top
    let note = ''
    let matched = false
    if (topHits > 0) {
      matched = true
      const words = hitWords[top].slice(0, 4).join('、')
      note = '命中' + top + '触发词 ' + topHits + ' 个（' + words + '）'
    } else {
      // 无触发词按长度兜底：≥30 字片段大概率含做法/过程，归经验；短片段归结论（待人工确认）
      kind = t.trim().length >= 30 ? '经验' : '结论'
      note = '无触发词命中，按长度兜底（' + t.trim().length + ' 字），待人工确认'
    }
    return { kind: kind, by: 'heuristic', note: note, matched: matched }
  }
  async function readQueue() {
    const d = await memRead(ROOT_TRAIN, QUEUE_REL, null)
    if (!d || !Array.isArray(d.items)) return { items: [], updatedAt: null }
    return { items: d.items, updatedAt: (d && d.updatedAt) || null }
  }
  async function writeQueue(items) {
    const data = { version: 1, items: items, updatedAt: new Date().toISOString() }
    await writeJsonRaw(ROOT_TRAIN, QUEUE_REL, data)
    return data
  }
  async function queueSuggestFn(input) {
    input = input || {}
    const text = String(input.text || '').trim()
    const sessionId = String(input.sessionId || '').trim()
    if (!text && !sessionId) return { status: 400, body: { ok: false, error: '缺少 text 或 sessionId（至少一个输入源）' } }
    const candidates = []
    let note = ''
    if (text) {
      const trimmed = (text.length > QUEUE_MAX_TEXT ? text.slice(0, QUEUE_MAX_TEXT) : text).trim()
      if (trimmed.length >= 12) {
        const g = queueGuessKind(trimmed)
        const cand = { text: trimmed, guess: { kind: g.kind, by: g.by, note: g.note, matched: g.matched } }
        if (sessionId) cand.sessionId = sessionId
        candidates.push(cand)
      } else {
        note = '文本过短（<' + 12 + ' 字），不构成候选'
      }
    } else if (sessionId) {
      // 会话当前模型面扫描启发式候选（只读；8s 守卫；规则初筛仅供提醒，最终决策在用户）
      const sq = ctx.get('sessionQuery')
      if (sq && typeof sq.readSurface === 'function') {
        let surf = undefined
        try { surf = await sqRace(function () { return sq.readSurface(sessionId) }, undefined) } catch (e) { surf = undefined }
        if (surf && Array.isArray(surf.events)) {
          let picked = 0
          for (let i = surf.events.length - 1; i >= 0 && picked < 8; i--) {
            const ev = surf.events[i]
            if (!ev) continue
            const t = sqMessageText(ev).trim()
            if (t.length < 12) continue
            const trimmed = t.length > QUEUE_MAX_TEXT ? t.slice(0, QUEUE_MAX_TEXT) : t
            const g = queueGuessKind(trimmed)
            candidates.push({ sessionId: sessionId, text: trimmed, guess: { kind: g.kind, by: g.by, note: g.note, matched: g.matched }, sourceEvent: String(ev.seq || '') })
            picked++
          }
          if (!candidates.length) note = '本会话当前面无 ≥12 字的候选片段'
        } else {
          note = '会话事件读取不可用（超时/服务缺失），未生成候选'
        }
      } else {
        note = 'sessionQuery 服务未挂载，未生成候选'
      }
    }
    return { status: 200, body: { ok: true, candidates: candidates, note: note || (candidates.length ? '' : '本会话暂无候选（规则初筛，仅供提醒）') } }
  }
  async function queueAddFn(input) {
    input = input || {}
    const text = String(input.text || '').trim()
    if (!text) return { status: 400, body: { ok: false, error: '缺少 text（候选内容必填）' } }
    const cleanText = text.length > QUEUE_MAX_TEXT ? text.slice(0, QUEUE_MAX_TEXT) : text
    if (!cleanText.trim()) return { status: 400, body: { ok: false, error: 'text 内容为空' } }
    const sessionId = String(input.sessionId || '').trim() || undefined
    let kind = String(((input.guess && typeof input.guess === 'object') ? input.guess.kind : '') || '').trim()
    let by = String(((input.guess && typeof input.guess === 'object') ? input.guess.by : '') || '').trim()
    let gnote = String(((input.guess && typeof input.guess === 'object') ? input.guess.note : '') || '').trim()
    if (kind && QUEUE_GUESS_KINDS.indexOf(kind) < 0) return { status: 400, body: { ok: false, error: '非法 guess.kind: ' + kind + '（可选 ' + QUEUE_GUESS_KINDS.join('/') + '）' } }
    if (!kind) { const g = queueGuessKind(cleanText); kind = g.kind; by = g.by; gnote = g.note } // 未带 guess 自动启发式补全
    if (by && ['heuristic', 'agent'].indexOf(by) < 0) by = 'heuristic'
    const q = await readQueue()
    const item = { id: 'queue-' + Date.now(), at: new Date().toISOString(), guess: { kind: kind, by: by || 'heuristic', note: gnote || '' }, status: '待处理', text: cleanText }
    if (sessionId) item.sessionId = sessionId
    q.items.unshift(item)
    await writeQueue(q.items)
    return { status: 200, body: { ok: true, id: item.id, item: item } }
  }
  async function queueUpdateFn(input) {
    input = input || {}
    const id = String(input.id || '').trim()
    if (!id) return { status: 400, body: { ok: false, error: '缺少 id' } }
    const q = await readQueue()
    const item = q.items.find(function (it) { return it.id === id })
    if (!item) return { status: 404, body: { ok: false, error: '队列无此条目: ' + id } }
    if (input.status !== undefined && input.status !== null) {
      const st = String(input.status).trim()
      if (QUEUE_STATUSES.indexOf(st) < 0) return { status: 400, body: { ok: false, error: '非法 status: ' + st + '（可选 ' + QUEUE_STATUSES.join('/') + '）' } }
      item.status = st
    }
    if (input.text !== undefined && input.text !== null) {
      const t = String(input.text).trim()
      if (!t) return { status: 400, body: { ok: false, error: 'text 不能为空' } }
      item.text = t.length > QUEUE_MAX_TEXT ? t.slice(0, QUEUE_MAX_TEXT) : t
    }
    if (input.sessionId !== undefined && input.sessionId !== null) {
      const sid = String(input.sessionId).trim()
      if (sid) item.sessionId = sid; else delete item.sessionId
    }
    if (input.guess !== undefined && input.guess !== null) {
      const g = input.guess
      const kind = String(g && g.kind || '').trim()
      if (!kind || QUEUE_GUESS_KINDS.indexOf(kind) < 0) return { status: 400, body: { ok: false, error: '非法 guess.kind（可选 ' + QUEUE_GUESS_KINDS.join('/') + '）' } }
      const by = String(g && g.by || '').trim()
      item.guess = { kind: kind, by: (by && ['heuristic', 'agent'].indexOf(by) >= 0) ? by : 'heuristic', note: String(g && g.note || '').slice(0, 120) }
    }
    if (input.distill !== undefined) {
      if (input.distill === null || (typeof input.distill === 'object' && Object.keys(input.distill).length === 0)) { delete item.distill }
      else {
        const dl = input.distill || {}
        const target = String(dl.target || '').trim()
        if (['insp', 'kb', 'memory'].indexOf(target) < 0) return { status: 400, body: { ok: false, error: '非法 distill.target: ' + target + '（可选 insp/kb/memory）' } }
        const downstreamId = String(dl.downstreamId || '').trim()
        if (!downstreamId) return { status: 400, body: { ok: false, error: 'distill.downstreamId 必填' } }
        item.distill = { target: target, downstreamId: downstreamId, at: String(dl.at || new Date().toISOString()) }
      }
    }
    await writeQueue(q.items)
    return { status: 200, body: { ok: true, id: id, item: item } }
  }
  async function queueListFn(input) {
    // ⑥ 待提炼队列·只读列表（批次3 补缺 action：readQueue → memRead cache:false 读盘，缺失空态；可选 status 过滤，白名单校验与 queueUpdate 同款）
    input = input || {}
    const status = String(input.status || '').trim()
    if (status && QUEUE_STATUSES.indexOf(status) < 0) return { status: 400, body: { ok: false, error: '非法 status: ' + status + '（可选 ' + QUEUE_STATUSES.join('/') + '）' } }
    const q = await readQueue()
    const items = status ? q.items.filter(function (it) { return it.status === status }) : q.items
    return { status: 200, body: { ok: true, count: items.length, items: items } }
  }
  // ---- ⑤ A2 distill 历史来源可选字段（sessionId?/workTitle?/channel?；仅新条目带可选键，既有字段结构/消费方零改动）----
  function distillSourceFields(input) {
    const out = {}
    const sid = String((input && input.sessionId) || '').trim()
    const wt = String((input && input.workTitle) || '').trim()
    const ch = String((input && input.channel) || '').trim()
    if (sid) out.sessionId = sid
    if (wt) out.workTitle = wt
    if (ch && DISTILL_CHANNELS.indexOf(ch) >= 0) out.channel = ch
    return out
  }

  // 自检工具
  ctx.tools.register(defineTool({
    name: 'writing_studio_ping',
    description: '全能写作工作台自检：返回插件已加载 + API 可用性。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      return { ok: true, loaded: true, hasFs: !!adapterFs, dataRoot: await absOf(ROOT_TRAIN, ''), summary: 'writing-studio v0.1 已加载（写作工作台统一入口）' }
    }
  }))

  // U2 灵感复用标记 agent 工具（2026-09-05 additive：薄包装 HTTP action reuseList/reuseSet，纯 additive、契约零破坏）
  // 与 HTTP action 共用 readReuseMarks()/applyReuseMark() 同一实现，读写行为完全一致（无 require、纯 JS；宿主 defineTool 要求 output.render 已满足）
  ctx.tools.register(defineTool({
    name: 'writing_studio_reuseList',
    description: '读写作侧灵感复用标记（主轴/支线/改造）：无入参，返回 marks（灵感 id → {role, updatedAt}）与 sidecar updatedAt。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        const marks = (value && value.marks && typeof value.marks === 'object') ? value.marks : {}
        const text = '灵感复用标记 ' + Object.keys(marks).length + ' 个' + ((value && value.updatedAt) ? '（sidecar updatedAt ' + value.updatedAt + '）' : '') + '：' + JSON.stringify(marks)
        return [{ type: 'text', text: text }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      const r = await readReuseMarks()
      return { ok: true, marks: r.marks, updatedAt: r.updatedAt }
    }
  }))
  ctx.tools.register(defineTool({
    name: 'writing_studio_reuseSet',
    description: '设/清写作侧灵感复用标记：id（灵感条目 id，必填）；role 必填，可选 主轴/支线/改造，role="" 表示清除该 id 的标记；非法 role 返回错误。',
    parameters: {
      id: { type: 'string', required: true, description: '灵感条目 id（必填）' },
      role: { type: 'string', required: true, description: '复用角色：主轴/支线/改造；role="" 表示清除该 id 的标记' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '设置失败：' + ((value && value.error) || '未知错误') }]
        const marks = (value && value.marks && typeof value.marks === 'object') ? value.marks : {}
        const text = '复用标记已设/清：id=' + value.id + ' role=' + (value.role === '' ? '（清除）' : value.role) + '，当前 ' + Object.keys(marks).length + ' 个：' + JSON.stringify(marks)
        return [{ type: 'text', text: text }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const r = await applyReuseMark(args && args.id, args && args.role)
      if (r.status !== 200) return { ok: false, error: r.error }
      return { ok: true, id: r.id, role: r.role, marks: r.marks }
    }
  }))

  // T7（2026-09-27 additive）：把「保存」暴露成 agent 工具 —— 与 HTTP action `save` 共用同一 saveDraft()
  // 存在理由：目标流程「客户端 → 用户点发送到 agent（可附提示词）→ 任务中心 → 创作教练 → 调工具落盘」里，
  //   落盘这一步原先只有 HTTP 端点 /writing-studio/api/save，**agent 的工具面里没有它** ⇒ 补这一个工具即可。
  // 契约：落点/命名/统计与 UI 保存**完全一致**（同一 saveDraft）⇒ 不会有第二套落盘口径。
  ctx.tools.register(defineTool({
    name: 'writing_studio_save',
    description: '把正文保存为写作草稿（写作工作台是草稿的唯一写者）：写入 写作训练/草稿/<标题>_<日期>_<时间>.md，并更新 写作记录.json（字数 / 连续天数 / 里程碑）。title 省略则记「未命名」；title 中的 \\ / : * ? " < > | 会被替换为下划线。',
    parameters: {
      title: { type: 'string', description: '稿件标题（进入文件名；可选 —— 省略则记「未命名」）' },
      content: { type: 'string', required: true, description: '正文内容（必填，不含标题行与保存时间戳，由本工具自动补）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '保存失败：' + ((value && value.error) || '未知错误') }]
        const s = value.saved || {}
        const hits = (s.milestoneHits && s.milestoneHits.length)
          ? '；新达成里程碑：' + s.milestoneHits.map(function (h) { return h.label }).join('、')
          : ''
        return [{ type: 'text', text: '已保存草稿 ' + s.filename + '（' + s.words + ' 字，累计 ' + s.totalWords + ' 字，连续 ' + s.streak + ' 天）' + hits }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const content = args && args.content
      if (content === undefined || content === null) return { ok: false, error: '缺少 content' }
      try {
        const saved = await saveDraft(String(content), String((args && args.title) || ''))
        return { ok: true, saved: saved }
      } catch (e) { return { ok: false, error: '写入失败: ' + String(e && e.message || e) } }
    }
  }))

  // ============ U-45 / W-B（2026-09-29 additive）：把索引动作暴露成 **agent 工具** ============
  // 存在理由（同 T7 `writing_studio_save` 的先例）：原先"维护索引"只有 agent 用文件写工具手改一条路，
  //   **agent 的工具面里没有它** ⇒ 补这两个工具，让 agent 不必手改 JSON、且有机械对账可用。
  // 契约：与 HTTP action `indexUpsert` / `indexRebuild` **共用同一 doIndex\* 实现**（不会有第二套口径）。
  ctx.tools.register(defineTool({
    name: 'writing_studio_indexUpsert',
    description: '按 path 增/改 `写作训练/规范/文档索引.json` 的**一条**条目（path 同时是主键）。path 必填，须是根内相对路径。已存在 ⇒ **只覆盖你显式给出的字段**（未给的 work/type/tags/zone/links 一字不动）；不存在 ⇒ 新建，未给字段留空。',
    parameters: {
      path: { type: 'string', required: true, description: '根内相对路径（如 设定/心渊纪元/人物.md）；不得以 / 开头、不得含 ..、不得带 写作训练/ 前缀' },
      zone: { type: 'string', description: 'Z1…Z9 或 其他' },
      type: { type: 'string', description: '文档类型（见附录 B）' },
      work: { type: 'string', description: '所属作品' },
      title: { type: 'string', description: '标题' },
      status: { type: 'string', description: '活文档 / 快照 / 归档' },
      owner: { type: 'string', description: '维护者会话名' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '索引写入失败：' + ((value && value.error) || '未知错误') }]
        return [{ type: 'text', text: (value.created ? '已新建' : '已更新') + '索引条目 ' + value.path + '（当前 ' + value.entries + ' 条）' }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const r = await doIndexUpsert(args)
      return (r.status === 200) ? r.body : Object.assign({ ok: false }, r.body)
    }
  }))
  ctx.tools.register(defineTool({
    name: 'writing_studio_indexRebuild',
    description: '重扫文档并**对账**索引（只报不改）：列出新增候选 / 盘上缺失 / excluded 消失 / 未索引顶层目录 / 同名路径漂移，并按 mtime 重算 updatedAt。🔴 **默认 dry-run（不写盘）**，要真写须传 dryRun="false"。它**只补新增与 updatedAt，绝不覆盖已填字段、绝不自动删缺失项**。',
    parameters: {
      dryRun: { type: 'string', description: 'true（默认：只报）/ false（真写）' },
      createMissing: { type: 'string', description: 'true 时把"能机械推导出"的新增候选建进索引；默认 false ⇒ 只报不建' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '索引重建失败：' + ((value && value.error) || '未知错误') }]
        return [{ type: 'text', text: value.summary }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const r = await doIndexRebuild(args)
      return (r.status === 200) ? r.body : Object.assign({ ok: false }, r.body)
    }
  }))
  // ============ U-41 / P5（2026-09-29 additive）：规范体检（**只读**） ============
  // 🔴 教训留痕（W-B 批）：上一批只挂了 HTTP action、**忘了注册 agent 工具** ⇒ agent 根本调不到。
  //    故工具面与 HTTP 面**成对**提供：/writing-studio/api/specAudit ↔ writing_studio_specAudit。
  ctx.tools.register(defineTool({
    name: 'writing_studio_specAudit',
    description: '**只读**规范体检（一次调用出报告）：索引缺 type/zone/work · 盘上新增候选/缺失/路径漂移/未索引顶层目录 · 灵感库缺或多世界观键与 `settingsRef` 失效 · **归档断链**（有同名活文档却无「替代」关联）· **规范件是否同源**（`写作规范.md` / `查找规范.md` 与 `执行手册.md` 逐字节比对）。⚠️ 归档件（历史快照）不套现行规范、下划线练习/模板目录不要求 `work` ⇒ 不刷噪音。🔴 **只报不改**：不动任何文件，报出来的问题由人/agent 判断怎么处理。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '规范体检失败：' + ((value && value.error) || '未知错误') }]
        // 🔴 2026-09-29 修：首版这里只遍历 specs ⇒ 索引/灵感库/归档/客户端区**只出现在 summary 计数里**，
        //    一条明细都不给（用户在会话里跑完当场指出"summary 说索引 1，明细里没有那 1 条"）。
        //    ⇒ 改为统一走 core 的 formatAuditLines：**凡计入 counts 的组，必须逐条列出**。
        return [{ type: 'text', text: formatAuditLines(value).join('\n') }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const r = await doSpecAudit()
      return (r.status === 200) ? r.body : Object.assign({ ok: false }, r.body)
    }
  }))

  // ============ U-45 / W-B（2026-09-29 additive）：`文档索引.json` 动作 ============
  // 端点：/writing-studio/api/{indexUpsert,indexRebuild}（`INDEX_ACTIONS`）。
  const DOC_INDEX_REL = '规范/文档索引.json'
  const INDEX_TZ_OFFSET_MIN = 480                                    // 索引既有口径 = +08:00
  function nowStamp() { return formatMtime(Date.now(), INDEX_TZ_OFFSET_MIN) }
  async function readDocIndex() {
    const raw = await memReadRef(DOC_INDEX_REL, null, ROOT_TRAIN)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { indexVersion: 1, generatedAt: '', scope: '写作训练', entries: [], excluded: [] }
    return {
      indexVersion: typeof raw.indexVersion === 'number' ? raw.indexVersion : 1,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      scope: typeof raw.scope === 'string' ? raw.scope : '写作训练',
      // 己（2026-09-29）：**已登记**"已知且有意不索引"的顶层目录 ⇒ indexRebuild 不再把它们当"新目录"报
      excludedTopLevel: Array.isArray(raw.excludedTopLevel) ? raw.excludedTopLevel : [],
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      excluded: Array.isArray(raw.excluded) ? raw.excluded : []
    }
  }
  // 写回：**与既有文件同格式**（2 空格缩进 + 末尾换行）＋ 原子写（复用 writeDraftAtomic：临时文件 + rename）
  async function writeDocIndex(doc) { await writeDraftAtomic(DOC_INDEX_REL, JSON.stringify(doc, null, 2) + '\n'); return true }
  async function nodeFs() { try { return await import('node:fs') } catch (e) { return null } }
  // 递归列举（node:fs 直用：需 mtime，且须能覆盖点开头目录的存在性判断）
  function walkIndexable(nfs, rootAbs, rel, depth, out) {
    let names = []
    try { names = nfs.readdirSync(rel ? rootAbs + '/' + rel : rootAbs) } catch (e) { return }
    for (const name of names) {
      if (shouldSkipName(name)) continue
      const childRel = rel ? (rel + '/' + name) : name
      let st = null
      try { st = nfs.statSync(rootAbs + '/' + childRel) } catch (e) { continue }
      if (st.isDirectory()) { if (depth < INDEX_MAX_DEPTH) walkIndexable(nfs, rootAbs, childRel, depth + 1, out) }
      else if (/\.md$/i.test(name)) out.push({ rel: childRel, mtimeMs: st.mtimeMs })
    }
  }
  // ---- ① indexUpsert：按 path 增/改一条（字段白名单 = 附录 C 十字段，未知字段被忽略）----
  async function doIndexUpsert(args) {
    const a = args || {}
    const patch = (a.entry && typeof a.entry === 'object') ? a.entry : a
    const doc = await readDocIndex()
    const at = nowStamp()
    const r = upsertEntry(doc.entries, patch, at)
    if (!r.ok) return { status: 400, body: { ok: false, error: r.error, summary: '失败：' + r.error } }
    try { await writeDocIndex(Object.assign({}, doc, { generatedAt: at, entries: r.entries })) } catch (e) {
      return { status: 500, body: { ok: false, error: '索引写入失败：' + String(e && e.message || e), summary: '失败：索引写入失败' } }
    }
    return {
      status: 200,
      body: { ok: true, path: r.path, created: r.created, entries: r.entries.length, summary: (r.created ? '已新建' : '已更新') + '索引条目：' + r.path }
    }
  }
  // ---- ② indexRebuild：重扫 → 三方对照（**只报不改**）+ updatedAt 刷新（唯一允许重算的字段）----
  /** 收集索引三方对照所需的**全部只读**输入（`indexRebuild` 与 `specAudit` 共用 ⇒ 杜绝两处漂移）。 */
  async function collectIndexDiff() {
    const nfs = await nodeFs()
    const doc = await readDocIndex()
    const idxAbs = await absOf(ROOT_TRAIN, DOC_INDEX_REL)
    const rootAbs = idxAbs.slice(0, idxAbs.length - DOC_INDEX_REL.length - 1)   // = .../写作训练
    // ① 扫描范围 = entries 已覆盖的顶层目录 ⇒ 天然不碰 日志/邮件桥/prompt-router 等基础设施
    const roots = scanRootsFromEntries(doc.entries)
    const found = []
    for (const t of roots) walkIndexable(nfs, rootAbs, t, 0, found)
    const diskFiles = found.map(function (f) { return f.rel }).sort()
    const mtimeMap = {}
    for (const f of found) mtimeMap[f.rel] = f.mtimeMs
    // ② 存在性**直判**（覆盖点开头目录——列举口径看不见它们，否则会假报缺失）
    const existsMap = {}
    for (const e of doc.entries) { const p = String((e && e.path) || ''); if (p) existsMap[p] = nfs.existsSync(rootAbs + '/' + p) }
    for (const x of doc.excluded) { const p = String((x && x.path) || ''); if (p && p.charAt(p.length - 1) !== '/') existsMap[p] = nfs.existsSync(rootAbs + '/' + p) }
    // ③ 顶层目录（发现"未被索引提及"的新目录，只报）
    let tops = []
    try {
      tops = nfs.readdirSync(rootAbs).filter(function (n) {
        if (shouldSkipName(n)) return false
        try { return nfs.statSync(rootAbs + '/' + n).isDirectory() } catch (e) { return false }
      })
    } catch (e) { tops = [] }
    // ④ 三方对照（只报不改）
    const diff = diffIndex({ diskFiles: diskFiles, entries: doc.entries, excluded: doc.excluded, existsMap: existsMap, topLevelDirs: tops, excludedTopLevel: doc.excludedTopLevel })
    return { nfs: nfs, doc: doc, rootAbs: rootAbs, roots: roots, diskFiles: diskFiles, mtimeMap: mtimeMap, existsMap: existsMap, diff: diff }
  }

  async function doIndexRebuild(args) {
    const a = args || {}
    const dryRun = !(a.dryRun === false || a.dryRun === 'false')       // 🔴 默认 dry-run：不写任何东西
    const createMissing = (a.createMissing === true || a.createMissing === 'true')
    const nfs = await nodeFs()
    if (!nfs) return { status: 500, body: { ok: false, error: 'node:fs 不可用，无法重扫' } }
    const doc = await readDocIndex()
    // ①–④ 全部交给共用 helper（**只读**；与 specAudit 同口径，杜绝两处漂移）
    const st = await collectIndexDiff()
    const rootAbs = st.rootAbs
    const roots = st.roots
    const diskFiles = st.diskFiles
    const mtimeMap = st.mtimeMap
    const diff = st.diff
    // ⑤ updatedAt 刷新（索引里唯一允许被重算的字段；只列确有变化的）
    const refreshed = refreshUpdatedAt(doc.entries, mtimeMap, INDEX_TZ_OFFSET_MIN)
    // ⑥ 新增候选：**默认只报不建**；createMissing 时才建，且**推不出的一律进 needsJudgement**
    const created = []
    const needsJudgement = []
    for (const p of diff.newCandidates) {
      if (!createMissing) { needsJudgement.push({ path: p, unresolved: ['未启用 createMissing ⇒ 只报不建'] }); continue }
      const d = deriveEntry(p)
      if (d.unresolved.length) needsJudgement.push({ path: p, unresolved: d.unresolved })
      else created.push(d.entry)
    }
    let wrote = false
    if (!dryRun) {
      await writeDocIndex(Object.assign({}, doc, { generatedAt: nowStamp(), entries: refreshed.entries.concat(created) }))
      wrote = true
    }
    return {
      status: 200,
      body: {
        ok: true, dryRun: dryRun, wrote: wrote, createMissing: createMissing,
        scannedRoots: roots, scannedFiles: diskFiles.length,
        newCandidates: diff.newCandidates, missingOnDisk: diff.missingOnDisk,
        excludedGone: diff.excludedGone, newTopLevelDirs: diff.newTopLevelDirs,
        pathDrift: diff.pathDrift, updatedAtChanged: refreshed.changed,
        created: created.length, needsJudgement: needsJudgement,
        summary: (dryRun ? '[dry-run] ' : '') + '索引重建：新增候选 ' + diff.newCandidates.length +
          ' · 缺失 ' + diff.missingOnDisk.length + ' · updatedAt 待更新 ' + refreshed.changed.length +
          ' · 新建 ' + created.length + ' · 待判 ' + needsJudgement.length +
          (diff.newTopLevelDirs.length ? ' · 未索引顶层目录 ' + diff.newTopLevelDirs.join('、') : '')
      }
    }
  }

  // ---- ③ submit（U-41/P2）：客户端把 `客户端区/正文/<作品>/<文档>.md` **复制**进 `写作训练/草稿/` ----
  // 唯一跨界入口：此后件归 agent 拥有（审阅 → 按手册落位/改名 → 归档）。
  // 🔴 §2.4 甲案：命中**已归档的同名件**时 ⇒ 新旧并留、归档件**原样不动**，只在新条目上补**单向**「替代」关联。
  async function doSubmit(args) {
    const a = args || {}
    const t = normalizeSubmitTarget(a.work, a.doc)
    if (!t.ok) return { status: 400, body: { ok: false, code: t.code, error: t.message, summary: '失败：' + t.message } }
    const nfs = await nodeFs()
    if (!nfs) return { status: 500, body: { ok: false, error: 'node:fs 不可用（提交需要读客户端区）' } }
    const trainAbs = await absOf(ROOT_TRAIN, '')
    const wsAbs = trainAbs.replace(/\/写作训练\/?$/, '')        // 工作区根（客户端区与 写作训练 平级）
    const srcAbs = wsAbs + '/' + t.bodyWsRel
    if (!nfs.existsSync(srcAbs)) {
      return { status: 404, body: { ok: false, code: 'SOURCE_MISSING', error: '客户端区没有该件：' + t.bodyWsRel, summary: '失败：客户端区无此件（提交＝复制，源须在 客户端区/正文/ 下）' } }
    }
    let content = ''
    try { content = nfs.readFileSync(srcAbs, 'utf8') } catch (e) { return { status: 500, body: { ok: false, error: '读取源失败：' + String(e && e.message || e) } } }
    const bytes = Buffer.byteLength(content, 'utf8')
    const sizeChk = checkSize(bytes)
    if (!sizeChk.ok) return { status: 413, body: { ok: false, code: sizeChk.code, error: sizeChk.message } }
    const newVersion = versionOf(content)
    // 目标存在性 / 当前版本（走 adapterFs；relPath 是工作区相对 ⇒ 先剥 `写作训练/`）
    const relInTrain = t.wsRel.slice(ROOT_TRAIN.length + 1)
    let exists = false
    let currentVersion = null
    try { const prev = await adapterFs.readText(ROOT_TRAIN, relInTrain); exists = true; currentVersion = versionOf(prev) } catch (e) { exists = false }
    const decision = decideSubmitWrite({ exists: exists, baseVersion: a.baseVersion, force: a.force === true, currentVersion: currentVersion })
    if (decision.action === 'conflict') {
      // 409 必须带 currentVersion：客户端据此走既有 C5 三选（覆盖 / 另存为 / 放弃，U-22 已交付）。
      // 「更新已上传过的稿」是常态路径（§2.5 的过渡方式）⇒ 这条不可省。
      return {
        status: 409,
        body: {
          ok: false, code: decision.code || 'VERSION_CONFLICT', error: decision.message,
          path: t.wsRel, currentVersion: currentVersion, version: newVersion,
          summary: '失败：' + decision.message
        }
      }
    }
    // 归档同名检测（**只读**）：索引里的归档条目 ∪ 实扫 `草稿/.archive/**`（点开头目录不在枚举口径内）
    const doc0 = await readDocIndex()
    const fromIdx = doc0.entries
      .filter(function (e) { return String((e && e.status) || '') === '归档' || String((e && e.path) || '').indexOf(ARCHIVE_PREFIX) === 0 })
      .map(function (e) { return String(e.path || '') })
    const fromDisk = []
    const ARCHIVE_ROOT_REL = ARCHIVE_PREFIX.replace(/\/$/, '')          // '草稿/.archive'
    ;(function walk(d, rel) {
      let names = []
      try { names = nfs.readdirSync(d) } catch (e) { return }
      for (let i = 0; i < names.length; i++) {
        const p = d + '/' + names[i]
        let st = null
        try { st = nfs.statSync(p) } catch (e) { continue }
        const childRel = rel ? (rel + '/' + names[i]) : names[i]
        if (st.isDirectory()) walk(p, childRel)
        else if (/\.md$/i.test(names[i])) fromDisk.push(archivePathOf(childRel))   // 🔴 走纯函数拼，避免双斜杠
      }
    })(wsAbs + '/写作训练/' + ARCHIVE_ROOT_REL, '')
    const archivePaths = Array.from(new Set(fromIdx.concat(fromDisk)))
    const hits = findArchivedSiblings(archivePaths, t.doc)
    // 落点（原子写；writeDraftAtomic 会剥 `写作训练/` 前缀）
    try { await writeDraftAtomic(t.wsRel, content) } catch (e) { return { status: 500, body: { ok: false, error: '写入失败：' + String(e && e.message || e) } } }
    // 索引：**已存在 ⇒ 只动 links**（不覆盖 agent 已填的 zone/type/work/status）；不存在 ⇒ 建条目
    const at = nowStamp()
    const dateStr = at.slice(0, 10)
    const cur = doc0.entries.filter(function (e) { return String((e && e.path) || '') === t.indexPath })[0] || null
    const sup = withSupersede((cur && cur.links) || [], hits, dateStr)
    // 甲（2026-09-29）：再**幂等**追加一条「来源」（谁把件送进来的）—— 与「替代」共存，不动十字段
    const src = withOriginSource(sup.links, t.bodyWsRel, dateStr, a.deviceId)
    const patch = cur
      ? { path: t.indexPath, links: src.links }
      : { path: t.indexPath, zone: 'Z1', type: '章节正文', work: t.work, status: '活文档', owner: '创作教练', links: src.links }
    const up = upsertEntry(doc0.entries, patch, at)
    let indexWritten = false
    if (up.ok) {
      try { await writeDocIndex(Object.assign({}, doc0, { generatedAt: at, entries: up.entries })); indexWritten = true } catch (e) { /* 索引失败不阻断提交：件已落盘，可事后 indexUpsert 补 */ }
    }
    // 提交记录（追加型 JSONL；客户端区**不在 adapterFs 登记根内** ⇒ node:fs 直用）
    try {
      const row = buildSubmitLogRow({
        ts: at, deviceId: String(a.deviceId || ''), work: t.work, doc: t.doc,
        path: t.wsRel, from: t.bodyWsRel, version: newVersion, action: decision.action, supersedes: hits
      })
      nfs.appendFileSync(wsAbs + '/' + CLIENT_LOG_REL, JSON.stringify(row) + '\n', 'utf8')
    } catch (e) { /* 留痕失败不阻断 */ }
    return {
      status: 200,
      body: {
        ok: true, path: t.wsRel, indexPath: t.indexPath, version: newVersion, bytes: bytes,
        created: !exists, action: decision.action,
        supersedes: hits, linksAdded: sup.added.length, originAdded: (src.added !== null),
        indexWritten: indexWritten, indexCreated: up.ok ? up.created : null,
        summary: (exists ? '已覆盖' : '已新建') + ' 写作训练/草稿/' + t.work + '/' + t.doc + '（' + bytes + ' B）' +
          (hits.length
            ? '；检测到**同名归档件** ' + hits.length + ' 份 ⇒ 已在条目上补 ' + sup.added.length + ' 条「替代」关联（**归档件未动**）'
            : '')
      }
    }
  }

  // ---- ④ 客户端区读写通道（U-41 §2.5）：save / list / read / delete ----
  // 🔴 `客户端区/` **不在 adapterFs 的登记根内** ⇒ 一律 node:fs + 工作区根绝对路径（内核以 dsh 用户运行 ⇒ 落盘 owner 正确）。
  // 端点纯 additive：不碰 `写作训练/`（那是 `submit` 的职责），也不改既有 `draft-*`。
  async function wsRootAbs() {
    const trainAbs = await absOf(ROOT_TRAIN, '')
    return trainAbs.replace(/\/写作训练\/?$/, '')
  }
  function czAbs(wsAbs, rel) { return wsAbs + '/' + CLIENT_ZONE_REL + '/' + rel }

  async function doClientZoneSave(args) {
    const a = args || {}
    const p = normalizeClientZonePath(a.relPath)
    if (!p.ok) return { status: 400, body: { ok: false, code: p.code, error: p.message, summary: '失败：' + p.message } }
    if (a.content === undefined || a.content === null) return { status: 400, body: { ok: false, error: '缺少 content', summary: '失败：缺少 content' } }
    const content = String(a.content)
    const bytes = Buffer.byteLength(content, 'utf8')
    const sizeChk = checkSize(bytes)
    if (!sizeChk.ok) return { status: 413, body: { ok: false, code: sizeChk.code, error: sizeChk.message } }
    const nfs = await nodeFs()
    if (!nfs) return { status: 500, body: { ok: false, error: 'node:fs 不可用' } }
    const abs = czAbs(await wsRootAbs(), p.rel)
    let exists = false
    let cur = null
    try { const prev = nfs.readFileSync(abs, 'utf8'); exists = true; cur = czVersion(prev) } catch (e) { exists = false }
    const d = decideClientZoneWrite({ exists: exists, baseVersion: a.baseVersion, force: a.force === true, currentVersion: cur })
    const nv = czVersion(content)
    if (d.action === 'conflict') {
      return { status: 409, body: { ok: false, code: d.code || 'VERSION_CONFLICT', error: d.message, relPath: p.rel, currentVersion: cur, version: nv, summary: '失败：' + d.message } }
    }
    try {
      const dir = abs.slice(0, abs.lastIndexOf('/'))
      if (dir) nfs.mkdirSync(dir, { recursive: true })
      const tmp = abs + '.tmp-' + process.pid
      nfs.writeFileSync(tmp, content, 'utf8')
      nfs.renameSync(tmp, abs)
    } catch (e) { return { status: 500, body: { ok: false, error: '写入失败：' + String(e && e.message || e) } } }
    return {
      status: 200,
      body: { ok: true, relPath: p.rel, path: p.wsRel, version: nv, bytes: bytes, created: !exists, action: d.action, summary: (exists ? '已覆盖' : '已新建') + ' 客户端区/' + p.rel }
    }
  }

  async function doClientZoneList(args) {
    const a = args || {}
    const pf = normalizeClientZonePrefix(a.prefix)
    if (!pf.ok) return { status: 400, body: { ok: false, code: pf.code, error: pf.message } }
    const nfs = await nodeFs()
    if (!nfs) return { status: 500, body: { ok: false, error: 'node:fs 不可用' } }
    const wsAbs = await wsRootAbs()
    const baseRel = pf.prefix || ''
    const baseAbs = baseRel ? czAbs(wsAbs, baseRel) : wsAbs + '/' + CLIENT_ZONE_REL
    const out = []
    ;(function walk(d, rel, depth) {
      let names = []
      try { names = nfs.readdirSync(d) } catch (e) { return }
      for (let i = 0; i < names.length; i++) {
        const n = names[i]
        if (n.charAt(0) === '.' || n.indexOf('.tmp-') >= 0) continue
        const childRel = rel ? (rel + '/' + n) : n
        const abs = d + '/' + n
        let st = null
        try { st = nfs.statSync(abs) } catch (e) { continue }
        if (st.isDirectory()) { if (depth < 4) walk(abs, childRel, depth + 1) }
        else {
          let v = ''
          try { v = czVersion(nfs.readFileSync(abs, 'utf8')) } catch (e) { v = '' }
          out.push({ relPath: childRel, path: CLIENT_ZONE_REL + '/' + childRel, version: v, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() })
        }
      }
    })(baseAbs, baseRel, 0)
    out.sort(function (x, y) { return x.relPath.localeCompare(y.relPath) })
    return { status: 200, body: { ok: true, prefix: baseRel, count: out.length, entries: out, summary: '客户端区 ' + (baseRel || '全部') + '：' + out.length + ' 件' } }
  }

  async function doClientZoneRead(args) {
    const a = args || {}
    const p = normalizeClientZonePath(a.relPath)
    if (!p.ok) return { status: 400, body: { ok: false, code: p.code, error: p.message } }
    const nfs = await nodeFs()
    if (!nfs) return { status: 500, body: { ok: false, error: 'node:fs 不可用' } }
    const abs = czAbs(await wsRootAbs(), p.rel)
    let content = ''
    let st = null
    try { content = nfs.readFileSync(abs, 'utf8'); st = nfs.statSync(abs) } catch (e) {
      return { status: 404, body: { ok: false, code: 'NOT_FOUND', error: '客户端区没有该件：' + p.rel, summary: '失败：客户端区无此件' } }
    }
    return {
      status: 200,
      body: { ok: true, relPath: p.rel, path: p.wsRel, version: czVersion(content), bytes: Buffer.byteLength(content, 'utf8'), content: content, mtime: new Date(st.mtimeMs).toISOString() }
    }
  }

  async function doClientZoneDelete(args) {
    const a = args || {}
    const p = normalizeClientZonePath(a.relPath)
    if (!p.ok) return { status: 400, body: { ok: false, code: p.code, error: p.message } }
    if (p.sub === '回收') return { status: 400, body: { ok: false, code: 'BAD_PATH', error: '回收/ 下的件不支持再删除' } }
    const nfs = await nodeFs()
    if (!nfs) return { status: 500, body: { ok: false, error: 'node:fs 不可用' } }
    const wsAbs = await wsRootAbs()
    const abs = czAbs(wsAbs, p.rel)
    if (!nfs.existsSync(abs)) return { status: 404, body: { ok: false, code: 'NOT_FOUND', error: '客户端区没有该件：' + p.rel } }
    let toRel = recycleRelOf(p.rel)
    let toAbs = czAbs(wsAbs, toRel)
    if (nfs.existsSync(toAbs)) {                 // 回收里已有同路径 ⇒ 在扩展名前插时间戳，防覆盖、不丢件
      const stamp = nowStamp().replace(/[^0-9]/g, '').slice(0, 14)
      const i = toRel.lastIndexOf('.')
      toRel = (i > toRel.lastIndexOf('/')) ? (toRel.slice(0, i) + '-' + stamp + toRel.slice(i)) : (toRel + '-' + stamp)
      toAbs = czAbs(wsAbs, toRel)
    }
    try {
      const dir = toAbs.slice(0, toAbs.lastIndexOf('/'))
      if (dir) nfs.mkdirSync(dir, { recursive: true })
      nfs.renameSync(abs, toAbs)                 // 同盘 rename ⇒ 原子
    } catch (e) { return { status: 500, body: { ok: false, error: '移入回收失败：' + String(e && e.message || e) } } }
    return { status: 200, body: { ok: true, relPath: p.rel, recycledTo: toRel, deleted: true, summary: '已移入回收：客户端区/' + toRel + '（软删，不是真删）' } }
  }

  // ---- ⑤ specAudit（U-41 / P5）：**只读**规范体检 —— 把"人对账"变成"一条命令" ----
  // 🔴 边界：全程**不写任何文件**；灵感库 owner 是 taskkit ⇒ 这里只做**只读快照**。
  async function doSpecAudit() {
    const st = await collectIndexDiff()
    const nfs = st.nfs
    const doc = st.doc
    const rootAbs = st.rootAbs
    const wsAbs = await wsRootAbs()

    // ① 索引组（与 indexRebuild 同口径）
    const idx = auditIndex({
      entries: doc.entries,
      newCandidates: st.diff.newCandidates, missingOnDisk: st.diff.missingOnDisk,
      pathDrift: st.diff.pathDrift, newTopLevelDirs: st.diff.newTopLevelDirs, excludedGone: st.diff.excludedGone
    })

    // ② 灵感库组（**只读快照**）
    let inspEntries = []
    try {
      const raw = JSON.parse(nfs.readFileSync(rootAbs + '/灵感库/灵感库.json', 'utf8'))
      inspEntries = Array.isArray(raw && raw.entries) ? raw.entries : []
    } catch (e) { inspEntries = [] }
    const insp = auditInsp({ entries: inspEntries })
    const refMap = {}
    for (const e of inspEntries) {
      const ref = String((e && e.settingsRef) || '').trim()
      if (!ref || ref.indexOf('/') < 0 || !/\.md$/i.test(ref)) continue
      if (ref.charAt(0) === '/' || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) continue
      if (!(ref in refMap)) refMap[ref] = nfs.existsSync(rootAbs + '/' + ref)
    }
    insp.brokenSettingsRef = auditSettingsRef(inspEntries, refMap)

    // ③ 归档断链（有同名活文档却无「替代」关联）
    const archiveLinks = auditArchiveLinks(doc.entries)

    // ④ 客户端区（提交记录 → 落点是否仍在）
    const submitLogMissingTarget = []
    let submitLogLines = 0
    try {
      const txt = nfs.readFileSync(wsAbs + '/' + CLIENT_LOG_REL, 'utf8')
      const lines = txt.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim()
        if (!s) continue
        submitLogLines++
        let row = null
        try { row = JSON.parse(s) } catch (e) { continue }
        const p = String((row && row.path) || '')
        if (p && !nfs.existsSync(wsAbs + '/' + p)) submitLogMissingTarget.push({ path: p, ts: String(row.ts || '') })
      }
    } catch (e) { /* 日志不存在 ⇒ 空 */ }

    // ⑤ 规范件同源（丙）：附录**从在役手册抽**，与在役派生件比对（⚠️ 只比附录 B；A.4↔查找规范 的抽取口径待定）
    const specs = []
    let manualText = ''
    try { manualText = nfs.readFileSync(rootAbs + '/规范/执行手册.md', 'utf8') } catch (e) { manualText = '' }
    // 🔴 口径 2026-09-29 定：两份都用**行级锚点**抽，锚点须**恰好命中 1 次**（awk 是静默取最后一次 ⇒ 不照搬那点）
    const SPEC_PAIRS = [
      { file: '写作规范.md', how: '附录 B 全段（`# 附录 B`→`# 附录 C` 前）', fn: extractWriteSpec },
      { file: '查找规范.md', how: 'A.4 段 + 空行 + 标签段（`## A.4`→`## A.5` 前，`标签用…受控前缀`→`# 附录 C` 前）', fn: extractFindSpec }
    ]
    for (const pair of SPEC_PAIRS) {
      const ex = pair.fn(manualText)
      let actual = ''
      try { actual = nfs.readFileSync(rootAbs + '/规范/' + pair.file, 'utf8') } catch (e) { actual = '' }
      if (!ex.ok) specs.push({ file: pair.file, how: pair.how, same: false, error: ex.error })
      else specs.push(Object.assign({ file: pair.file, how: pair.how }, compareSpec(ex.text, actual)))
    }

    const rep = buildReport({
      index: idx, insp: insp, archiveLinks: archiveLinks,
      clientZone: { submitLogMissingTarget: submitLogMissingTarget, missingOnDisk: [] },
      specs: specs
    })
    return {
      status: 200,
      body: {
        ok: true, ts: Date.now(), readOnly: true,
        note: '灵感库为**只读快照**（owner 是 taskkit，本动作只读不写）；规范件比对：写作规范.md（附录 B 全段）+ 查找规范.md（A.4 段＋标签段）',
        counts: rep.counts, total: rep.total,
        index: idx, insp: insp, archiveLinks: archiveLinks,
        clientZone: { submitLogLines: submitLogLines, submitLogMissingTarget: submitLogMissingTarget },
        specs: specs,
        summary: '规范体检：共 ' + rep.total + ' 项（索引 ' + rep.counts.index + ' · 灵感库 ' + rep.counts.insp +
          ' · 归档断链 ' + rep.counts.archive + ' · 客户端区 ' + rep.counts.clientZone + ' · 规范件 ' + rep.counts.specs + '）'
      }
    }
  }

  // HTTP API
  try {
    const ws = ctx.get('webServer')
    if (ws && typeof ws.register === 'function') {
      const handler = async function (req, res) {
        const u = new URL(req.url || '/', 'http://x')
        const parts = u.pathname.split('/').filter(Boolean)
        const action = parts.length >= 3 ? parts[2] : ''
        const send = function (status, obj) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(obj))
        }
        let body = ''
        let bodyTooLarge = false
        try {
          for await (const chunk of req) {
            body += chunk
            // B5 上传防护：单请求体 ≤20MB（对齐 knowledge-base 5MB 模式，上传放宽）
            if (body.length > UPLOAD_MAX_BYTES) { bodyTooLarge = true; try { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false, error: 'body too large (>20MB)' })) } catch (e) {} }
          }
        } catch (e) {}
        if (bodyTooLarge) return
        let args = {}
        if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
        try {
          if (action === 'ping') {
            send(200, { ok: true, plugin: 'writing-studio', ts: new Date().toISOString() })
          } else if (action === 'upload') {
            // B5 对话上传文件：{filename, content, isBase64?, mime?} → 落盘 <根 写作训练>/上传/（additive）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            if (args.filename === undefined || args.content === undefined) return send(400, { ok: false, error: '缺少 filename 或 content' })
            try {
              const result = await uploadFile({ filename: String(args.filename), content: String(args.content), isBase64: args.isBase64 === true, mime: String(args.mime || '') })
              send(200, Object.assign({ ok: true }, result, { summary: '已上传到工作区：' + result.path }))
            } catch (e) { send(500, { ok: false, error: '上传失败: ' + String(e && e.message || e) }) }
          } else if (action === 'flow') {
            // B4 心流反馈：{text} → {flowScore, state, suggestion, source}（additive）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const text = String(args.text || '')
            if (!text.trim()) return send(400, { ok: false, error: '缺少 text' })
            const flow = await flowScoreOf(text)
            send(200, Object.assign({ ok: true }, flow))
          } else if (action === 'milestones') {
            // B4 里程碑：GET → 累计/连续/当日 里程碑 + 下一目标 + 进度（additive）
            const rec = await readRecord()
            const m = milestonesOf(rec)
            send(200, Object.assign({ ok: true }, m))
          } else if (action === 'save') {
            // 写作保存：草稿/<日期>_<时间>.md + 更新 写作记录.json（权威落盘）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            if (args.content === undefined || args.content === null) return send(400, { ok: false, error: '缺少 content' })
            try {
              const result = await saveDraft(String(args.content || ''), String(args.title || ''))
              send(200, { ok: true, saved: result, summary: '已保存到工作区：' + result.filename })
            } catch (e) { send(500, { ok: false, error: '写入失败: ' + String(e && e.message || e) }) }
          } else if (action === 'draft-save') {
            // U-37（2026-09-27 additive）：按相对路径保存草稿。契约 = docs/superpowers/plans/2026-09-27-writing-studio-draft-save-route-plan.md §2。
            // 白名单只允许 写作训练/草稿/**.md；默认不覆盖（需 baseVersion 或 force）；原子写；≤2MiB。
            // 纯校验/决策逻辑在 ./draft-save-core.js（本文件只做薄接线）；**不改** saveDraft 的既有行为。
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            // 🔴 U-41 / P4 收口闸：closed 时**先判后写** ⇒ 本次请求不产生任何盘上变化（见 DRAFT_WRITE_MODE 注释）
            if (draftWriteClosed('draft-save', args && args.relPath)) {
              return send(403, { ok: false, code: 'DRAFT_WRITE_CLOSED', error: '该写入口已收口：客户端请升级到已分离版本（改走 /writing-studio/api/clientZoneSave，agent 侧用 submit）' })
            }
            if (!body) return send(400, { ok: false, error: '空请求体（需要 JSON 对象）' })
            const vPath = validateRelPath(args && args.relPath)
            if (!vPath.ok) return send(400, { ok: false, code: vPath.code || 'BAD_PATH', error: vPath.message })
            // 🔴 U-41/D-3（2026-09-29 补缺）：与 draft-read:1845 / draft-delete:1873 **同法**挡隐藏段。
            //    事实：validateRelPath 只拒「整段 == . / ..」⇒ `草稿/.archive/x.md` 是**放行**的
            //    （该宽松是刻意的、已被 draft-sync-core.test.mjs 锁定）⇒ 挡点目录必须在**调用点**做。
            //    本条原先漏了 ⇒ 客户端理论上可把件写进**归档区**（附录 B「只移动不改内容」）⇒ 现补上。
            if (hasDotSegment(innerRelOf(vPath.rel))) return send(400, { ok: false, code: 'BAD_PATH', error: '路径含隐藏段（`.` 开头），拒绝（归档区等点目录不接受写入）' })
            if (args.content === undefined || args.content === null) return send(400, { ok: false, error: '缺少 content' })
            const content = String(args.content)
            const bytes = Buffer.byteLength(content, 'utf8')
            const sizeChk = checkSize(bytes)
            if (!sizeChk.ok) return send(413, { ok: false, code: sizeChk.code || 'TOO_LARGE', error: sizeChk.message })
            const newVersion = versionOf(content)
            // 读既有文件判定 exists + 当前版本（adapterFs.readText 默认不缓存 ⇒ 无陈旧窗口）
            // 🔴 relPath 是**相对工作区根**（`写作训练/草稿/…`），而 adapterFs 的 (rootRef, rel) 会做
            //    `joinUnderRoot(roots[rootRef], rel)` ⇒ 直接传完整路径会双前缀（`写作训练/写作训练/…`），
            //    读取必抛错 ⇒ exists 恒 false ⇒ **"默认不覆盖"失效**。故先剥掉 `写作训练/`。
            const relInTrain = vPath.rel.slice(ROOT_TRAIN.length + 1)
            let exists = false
            let currentVersion = null
            try { const prev = await adapterFs.readText(ROOT_TRAIN, relInTrain); exists = true; currentVersion = versionOf(prev) } catch (e) { exists = false }
            const decision = decideWrite({ exists: exists, baseVersion: args.baseVersion, force: args.force === true, currentVersion: currentVersion })
            if (decision.action === 'conflict') return send(409, { ok: false, code: decision.code || 'VERSION_CONFLICT', error: decision.message })
            try {
              await writeDraftAtomic(vPath.rel, content)
            } catch (e) { return send(500, { ok: false, error: '写入失败: ' + String(e && e.message || e) }) }
            auditDraftSave({ relPath: vPath.rel, bytes: bytes, created: !exists, overwrote: decision.action === 'overwrite' })
            send(200, {
              ok: true,
              path: vPath.rel,
              filename: vPath.rel.slice(vPath.rel.lastIndexOf('/') + 1),
              version: newVersion,
              words: content.replace(/\s+/g, '').length,
              created: !exists
            })
          } else if (action === 'draft-list') {
            // C11（2026-09-29 additive）：列远端草稿（**只有元数据、不回正文**）+ 墓碑。契约 = 设计 §4.1。
            // 走既有 listDraftRelPaths ⇒ 自动跳过 `.` 开头的条目（回收站 / 墓碑）与 _backup。
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, error: '需要 GET' })
            const innerRels = await listDraftRelPaths(ROOT_TRAIN, DRAFT_DIR_REL, '', 0)
            const items = []
            for (const inner of innerRels) {
              const relInTrain = DRAFT_DIR_REL + '/' + inner
              let content = ''
              // 读不到的条目**跳过而不是让整表失败**（并发改名/删除是正常事）
              try { content = await adapterFs.readText(ROOT_TRAIN, relInTrain) } catch (e) { continue }
              items.push(buildListItem(wsRelOf(inner), content, await draftMtime(ROOT_TRAIN, relInTrain)))
            }
            send(200, {
              ok: true,
              root: DRAFT_ROOT,
              items: items,
              tombstones: tombstoneList(await readTombstones()),
              generatedAt: new Date().toISOString(),
            })
          } else if (action === 'draft-read') {
            // C11：按 relPath 读回正文。**404 = 远端确实没有**（客户端据此走"本地独有 / 远端已删"分支）；
            // 与"拉不到"（网络/500）必须分开 —— 那是客户端 `known:false` 的事，不在这里。
            if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, error: '需要 GET' })
            const vPath = validateRelPath(relArgOf(args, u))
            if (!vPath.ok) return send(400, { ok: false, code: vPath.code || 'BAD_PATH', error: vPath.message })
            const inner = innerRelOf(vPath.rel)
            // 🔴 必须挡隐藏段：validateRelPath 只拒「整段 == . / ..」，而 `.deleted/x.md` 是**放行**的
            if (hasDotSegment(inner)) return send(400, { ok: false, code: 'BAD_PATH', error: '路径含隐藏段（`.` 开头），拒绝' })
            if (getTombstone(await readTombstones(), vPath.rel)) {
              return send(404, { ok: false, code: 'NOT_FOUND', error: '远端不存在该草稿（已删除）' })
            }
            const relInTrain = DRAFT_DIR_REL + '/' + inner
            let content = ''
            try { content = await adapterFs.readText(ROOT_TRAIN, relInTrain) } catch (e) {
              return send(404, { ok: false, code: 'NOT_FOUND', error: '远端不存在该草稿' })
            }
            const bytes = Buffer.byteLength(content, 'utf8')
            const sizeChk = checkSize(bytes)
            if (!sizeChk.ok) return send(413, { ok: false, code: sizeChk.code || 'TOO_LARGE', error: sizeChk.message })
            send(200, {
              ok: true,
              relPath: vPath.rel,
              version: versionOf(content),
              content: content,
              bytes: bytes,
              words: wordCount(content),
              mtime: isoOf(await draftMtime(ROOT_TRAIN, relInTrain)),
            })
          } else if (action === 'draft-delete') {
            // C11：**软删** —— rename 搬进 `草稿/.deleted/` + 记墓碑。**永不真删任何字节**。契约 = 设计 §4.3。
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            // 🔴 U-41 / P4 收口闸：**删除也是写**（搬 `.deleted/` + 写墓碑）⇒ 与 draft-save 同闸、一起关
            if (draftWriteClosed('draft-delete', relArgOf(args, u))) {
              return send(403, { ok: false, code: 'DRAFT_WRITE_CLOSED', error: '该写入口已收口：客户端请升级到已分离版本（改走 /writing-studio/api/clientZoneDelete）' })
            }
            if (!body) return send(400, { ok: false, error: '空请求体（需要 JSON 对象）' })
            const vPath = validateRelPath(relArgOf(args, u))
            if (!vPath.ok) return send(400, { ok: false, code: vPath.code || 'BAD_PATH', error: vPath.message })
            const inner = innerRelOf(vPath.rel)
            if (hasDotSegment(inner)) return send(400, { ok: false, code: 'BAD_PATH', error: '路径含隐藏段（`.` 开头），拒绝' })
            const relInTrain = DRAFT_DIR_REL + '/' + inner
            let content = null
            let exists = false
            try { content = await adapterFs.readText(ROOT_TRAIN, relInTrain); exists = true } catch (e) { exists = false }
            const tombR = await readTombstones()
            const tombHit = getTombstone(tombR, vPath.rel)
            const decision = decideDelete({
              exists: exists,
              tombstoned: !!tombHit,
              baseVersion: args && args.baseVersion,
              currentVersion: exists ? versionOf(content) : '',
            })
            if (decision.action === 'notfound') return send(404, { ok: false, code: 'NOT_FOUND', error: '远端不存在该草稿' })
            if (decision.action === 'conflict') return send(409, { ok: false, code: decision.code || 'VERSION_CONFLICT', error: decision.message })
            if (decision.action === 'already') {
              return send(200, { ok: true, alreadyDeleted: true, relPath: vPath.rel, tombstone: Object.assign({ relPath: vPath.rel }, tombHit || {}) })
            }
            const lastVersion = versionOf(content)
            let trashedTo = ''
            try { trashedTo = await softDeleteDraft(vPath.rel) } catch (e) {
              return send(500, { ok: false, code: 'IO_ERROR', error: '软删失败（**文件未动**）: ' + String(e && e.message || e) })
            }
            // 🔴 顺序：**先搬家成功、再写墓碑**。墓碑写失败 ⇒ 文件已在回收站（可人工恢复）⇒ **不丢**。
            const nextTomb = putTombstone(tombR, vPath.rel, {
              deletedBy: (args && args.device) ? String(args.device) : '',
              lastVersion: lastVersion,
            })
            let tombSaved = true
            try { await writeJsonRaw(ROOT_TRAIN, TOMBSTONE_INNER, nextTomb) } catch (e) { tombSaved = false }
            auditDraftSync('draft-delete', {
              relPath: vPath.rel,
              bytes: Buffer.byteLength(String(content === null ? '' : content), 'utf8'),
              result: tombSaved ? 'trashed' : 'trashed-tombstone-failed',
            })
            send(200, {
              ok: true,
              relPath: vPath.rel,
              trashedTo: trashedTo,
              tombstone: Object.assign({ relPath: vPath.rel }, nextTomb.items[vPath.rel] || {}),
              tombstoneSaved: tombSaved,
            })
          } else if (action === 'insp') {
            // 灵感列表（自含读取，不依赖 taskkit）——过滤非灵感条目（技术文档等）
            const lib = await readInspLib()
            const entries = filterInspirations(lib.entries)
            send(200, { ok: true, count: entries.length, total: lib.entries.length, filtered: lib.entries.length - entries.length, entries: entries })
          } else if (action === 'inspUpdate') {
            // 灵感内联编辑（复用灵感库.json 写入）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const id = String(args.id || '').trim()
            const patch = args.patch || {}
            if (!id) return send(400, { ok: false, error: '缺少 id' })
            const lib = await readInspLib()
            const entry = lib.entries.find(function (e) { return e.id === id })
            if (!entry) return send(404, { ok: false, error: '灵感不存在: ' + id })
            const now = new Date().toISOString()
            const editable = ['title', 'content', 'source', 'oneLiner', 'hook', 'settingsRef', 'status', 'category', 'annotations']
            editable.forEach(function (k) { if (patch[k] !== undefined && entry[k] !== patch[k]) { entry.history = entry.history || []; entry.history.push({ at: now, by: '写作工作台', field: k, before: entry[k], after: patch[k] }); entry[k] = patch[k] } })
            if (patch.tags !== undefined) { const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); entry.tags = tags }
            entry.updatedAt = now
            try {
              await writeJsonRaw(ROOT_TRAIN, INSP_LIB_REL, lib)
              send(200, { ok: true, id: id, entry: entry })
            } catch (e) { send(500, { ok: false, error: '写入失败: ' + String(e && e.message || e) }) }
          } else if (action === 'relations') {
            // relations API：byInsp/byDraft/byDate/attach/detach/overview
            const sub = parts.length >= 4 ? parts[3] : ''
            const relData = await readRelations()
            const lib = await readInspLib()
            const drafts = await collectDrafts()
            const draftNames = drafts
            if (sub === 'overview') {
              const byInsp = {}
              const byDraft = {}
              const byDate = {}
              lib.entries.forEach(function (e) {
                const related = draftNames.filter(function (dn) {
                  const rel = (relData.relations || {})[dn]
                  return rel && (rel.refInspId === e.id || rel.refResourceId === e.id)
                })
                if (related.length) byInsp[e.id] = { title: e.title, drafts: related }
              })
              Object.keys(relData.relations || {}).forEach(function (dn) {
                const rel = relData.relations[dn]
                byDraft[dn] = rel
                if (rel && rel.date) {
                  if (!byDate[rel.date]) byDate[rel.date] = []
                  byDate[rel.date].push(dn)
                }
              })
              send(200, { ok: true, relations: relData.relations, byInsp: byInsp, byDraft: byDraft, byDate: byDate, total: Object.keys(relData.relations || {}).length })
            } else if (sub === 'byInsp') {
              const id = (u.searchParams.get('id') || '').trim()
              const related = draftNames.filter(function (dn) {
                const rel = (relData.relations || {})[dn]
                return rel && (rel.refInspId === id || rel.refResourceId === id)
              })
              send(200, { ok: true, inspId: id, drafts: related })
            } else if (sub === 'byDraft') {
              const name = (u.searchParams.get('name') || '').trim()
              send(200, { ok: true, draft: name, relation: (relData.relations || {})[name] || null })
            } else if (sub === 'byDate') {
              const date = (u.searchParams.get('date') || '').trim()
              const items = []
              Object.keys(relData.relations || {}).forEach(function (dn) {
                const rel = relData.relations[dn]
                if (rel && rel.date === date) items.push(dn)
              })
              send(200, { ok: true, date: date, drafts: items })
            } else if (sub === 'attach') {
              if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
              const draft = String(args.draft || '').trim()
              if (!draft) return send(400, { ok: false, error: '缺少 draft' })
              const rel = (relData.relations || {})[draft] || { type: '自由写作', refInspId: '', refResourceId: '', note: '', date: '' }
              if (args.type !== undefined) rel.type = ['灵感衍生', '训练产出', '自由写作'].indexOf(args.type) >= 0 ? args.type : rel.type
              if (args.refInspId !== undefined) rel.refInspId = String(args.refInspId || '')
              if (args.refResourceId !== undefined) rel.refResourceId = String(args.refResourceId || '')
              if (args.note !== undefined) rel.note = String(args.note || '')
              if (args.date !== undefined) rel.date = String(args.date || '')
              // U-7 / T1a：落库改走 taskkit update（幂等 upsert）；失败抛错 ⇒ 外层 catch 回 500（不再静默"成功"）。
              await attachRelation(draft, rel)
              send(200, { ok: true, draft: draft, relation: rel })
            } else if (sub === 'detach') {
              if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
              const draft = String(args.draft || '').trim()
              if (!draft) return send(400, { ok: false, error: '缺少 draft' })
              // U-7 / T1a：删除改走 taskkit delete（T1b 新增；幂等：键不存在也不报错，响应形状不变）。
              await detachRelation(draft)
              send(200, { ok: true, draft: draft, detached: true })
            } else {
              send(404, { ok: false, error: '未知 relations action: ' + sub, actions: ['overview', 'byInsp', 'byDraft', 'byDate', 'attach', 'detach'] })
            }
          } else if (action === 'training') {
            const data = await trainingOverview()
            send(200, { ok: true, training: data })
          } else if (action === 'overview') {
            const training = await trainingOverview()
            const lib = await readInspLib()
            const cats = { '主攻': 0, '备选': 0, '冻结': 0, '待启动': 0 }
            lib.entries.forEach(function (e) { const c = e.category || '待启动'; cats[c] = (cats[c] || 0) + 1 })
            // 创作资源库 groups：按 category 分组返回条目数组（含 id/title/oneLiner/tags/drafts 关联），
            // 供 client ResourceModule 展示（修复「undefined条灵感」+0条——client 读 groups[k]，此前 API 只有计数）
            const relData = await readRelations()
            const drafts = (training && training.drafts) || []
            const groups = { '主攻': [], '备选': [], '冻结': [], '待启动': [] }
            lib.entries.forEach(function (e) {
              const c = e.category || '待启动'
              if (!groups[c]) groups[c] = []
              const related = drafts.filter(function (d) {
                const rel = (relData.relations || {})[d.name]
                return rel && (rel.refInspId === e.id || rel.refResourceId === e.id)
              }).map(function (d) { return d.name })
              groups[c].push({
                id: e.id, title: e.title, oneLiner: e.oneLiner || '', category: c,
                tags: e.tags || [], fixed: !!e.fixed, status: e.status || '',
                drafts: related
              })
            })
            send(200, {
              ok: true,
              inspTotal: lib.entries.length,
              inspByCategory: cats,
              groups: groups,
              draftCount: training.draftCount,
              relationsCount: training.relationsCount,
              record: training.record,
              byInsp: training.byInsp
            })
          } else if (action === 'memSummary') {
            // U1 工程记忆面板（2026-09-02 additive）：只读投影 memory-system（镜像 readL1/readDraft/doStats/memoryScore），
            // 全部 cache:false 读盘；client 统一 POST {} 调用（R1 定稿：POST 分支必达 host，成功后清本 base GET 缓存）
            send(200, await memSummary())
          } else if (action === 'reuseList') {
            // U2 灵感看板：读取复用标记 sidecar（主轴/支线/改造）——cache:false 读盘（sidecar 极小且可能被外部编辑/删除，禁 30s 陈旧）
            // 2026-09-05 additive：读核心抽到 readReuseMarks()（agent 工具 writing_studio_reuseList 复用同一实现），本 action 语义不变
            const r = await readReuseMarks()
            send(200, { ok: true, marks: r.marks, updatedAt: r.updatedAt })
          } else if (action === 'reuseSet') {
            // U2 灵感看板：设置/清除某灵感复用标记（role='' 即清除；sidecar 自持，taskkit insp 数据零改动）
            // 2026-09-05 additive：写核心抽到 applyReuseMark()（agent 工具 writing_studio_reuseSet 复用同一实现，校验/落盘/缓存失效一致），本 action 语义不变
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r = await applyReuseMark(args.id, args.role)
            if (r.status !== 200) return send(r.status, { ok: false, error: r.error })
            send(200, { ok: true, id: r.id, role: r.role, marks: r.marks })
            // ============ Phase2（2026-09-03 additive）：U4 灵感资产库·复用图谱 ============
          } else if (action === 'assetGraph') {
            // U4 聚合读：作品（含灵感数）+ 使用关系（补 workTitle）+ 灵感标题映射；cache:false 读两 sidecar + 灵感库
            send(200, await assetGraph())
          } else if (action === 'workSave') {
            // U4 新建/更新作品：{id?(空=新建), title*, note?}
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const title = String(args.title || '').trim()
            if (!title) return send(400, { ok: false, error: '缺少 title（作品标题必填）' })
            const note = String(args.note || '').slice(0, 500)
            const w = await readWorks()
            let work
            const id = String(args.id || '').trim()
            const nowIso = new Date().toISOString()
            if (id) {
              work = w.works.find(function (x) { return x.id === id })
              if (!work) return send(404, { ok: false, error: '作品不存在: ' + id })
              work.title = title; work.note = note; work.updatedAt = nowIso
            } else {
              work = { id: assetId('work'), title: title, note: note, createdAt: nowIso, updatedAt: nowIso }
              w.works.push(work)
            }
            await writeWorks(w.works)
            send(200, { ok: true, id: work.id, work: work })
          } else if (action === 'workDelete') {
            // U4 删除作品 + 级联清 灵感资产.json 中引用该作品的关系
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const id = String(args.id || '').trim()
            if (!id) return send(400, { ok: false, error: '缺少 id' })
            const w = await readWorks()
            const before = w.works.length
            w.works = w.works.filter(function (x) { return x.id !== id })
            if (w.works.length === before) return send(404, { ok: false, error: '作品不存在: ' + id })
            const u = await readUses()
            let removed = 0
            Object.keys(u.uses).forEach(function (inspId) {
              const kept = (Array.isArray(u.uses[inspId]) ? u.uses[inspId] : []).filter(function (r) { if (r.workId === id) { removed++; return false } return true })
              if (kept.length) u.uses[inspId] = kept; else delete u.uses[inspId]
            })
            await writeWorks(w.works)
            await writeUses(u.uses)
            send(200, { ok: true, id: id, removedUses: removed })
          } else if (action === 'assetLink') {
            // U4 关联灵感→作品（同 inspId+workId upsert）：{inspId*, workId*, role*(主轴|支线|改造), adapt?, status?}
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const inspId = String(args.inspId || '').trim()
            const workId = String(args.workId || '').trim()
            const role = String(args.role || '').trim()
            if (!inspId) return send(400, { ok: false, error: '缺少 inspId' })
            if (!workId) return send(400, { ok: false, error: '缺少 workId' })
            if (ASSET_ROLES.indexOf(role) < 0) return send(400, { ok: false, error: '非法角色 role: ' + role + '（可选 主轴/支线/改造）' })
            let status = String(args.status || '在用').trim()
            if (ASSET_STATUS.indexOf(status) < 0) status = '在用'
            const adapt = String(args.adapt || '').slice(0, 200)
            const w = await readWorks()
            if (!w.works.some(function (x) { return x.id === workId })) return send(400, { ok: false, error: '关联的作品不存在: ' + workId })
            const u = await readUses()
            const list = Array.isArray(u.uses[inspId]) ? u.uses[inspId] : []
            const nowIso = new Date().toISOString()
            const idx = list.findIndex(function (r) { return r.workId === workId })
            const rec = { workId: workId, role: role, adapt: adapt, status: status, updatedAt: nowIso }
            if (idx >= 0) list[idx] = rec; else list.push(rec)
            u.uses[inspId] = list
            await writeUses(u.uses)
            send(200, { ok: true, uses: u.uses[inspId] })
          } else if (action === 'assetUnlink') {
            // U4 移除灵感→作品关系：{inspId*, workId*}（无匹配幂等返回 ok）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const inspId = String(args.inspId || '').trim()
            const workId = String(args.workId || '').trim()
            if (!inspId) return send(400, { ok: false, error: '缺少 inspId' })
            if (!workId) return send(400, { ok: false, error: '缺少 workId' })
            const u = await readUses()
            const list = Array.isArray(u.uses[inspId]) ? u.uses[inspId] : []
            const kept = list.filter(function (r) { return r.workId !== workId })
            if (kept.length) u.uses[inspId] = kept; else delete u.uses[inspId]
            await writeUses(u.uses)
            send(200, { ok: true, uses: u.uses[inspId] || [] })
            // ============ U5 作品档案·聚合视图（只读聚合：灵感/草稿/设定） ============
          } else if (action === 'workArchive') {
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const id = String(args.id || '').trim()
            if (!id) return send(400, { ok: false, error: '缺少 id' })
            const arch = await workArchive(id)
            if (!arch) return send(404, { ok: false, error: '作品不存在: ' + id })
            send(200, arch)
            // ============ U7 对话记忆·会话提炼台（host loopback 落库 + 提炼历史 sidecar） ============
          } else if (action === 'distillList') {
            // 读取提炼历史（倒序，cache:false）
            const h = await readDistillHistory()
            send(200, { ok: true, history: h.history })
          } else if (action === 'distillInsp') {
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const content = String(args.content || '').trim()
            const title = String(args.title || '').trim()
            if (!content) return send(400, { ok: false, error: '缺少 content（提炼内容必填）' })
            if (!title) return send(400, { ok: false, error: '缺少 title（灵感标题必填）' })
            if (content.length > 2000) return send(400, { ok: false, error: '内容超过 2000 字（当前 ' + content.length + '），请精简后再落库' })
            const r = await distillInsp(args)
            send(r.ok ? 200 : 502, r)
          } else if (action === 'distillKb') {
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const content = String(args.content || '').trim()
            const title = String(args.title || '').trim()
            if (!content) return send(400, { ok: false, error: '缺少 content（提炼内容必填）' })
            if (!title) return send(400, { ok: false, error: '缺少 title（条目标题必填）' })
            if (content.length > 2000) return send(400, { ok: false, error: '内容超过 2000 字（当前 ' + content.length + '），请精简后再落库' })
            const r = await distillKb(args)
            send(r.ok ? 200 : 502, r)
          } else if (action === 'distillMemory') {
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const content = String(args.content || '').trim()
            if (!content) return send(400, { ok: false, error: '缺少 content（提炼内容必填）' })
            if (content.length > 2000) return send(400, { ok: false, error: '内容超过 2000 字（当前 ' + content.length + '），请精简后再落库' })
            const r = await distillMemory(args)
            send(r.ok ? 200 : 502, r)
            // ============ U8 用户偏好·编辑化（用户偏好.json sidecar；创作原点=fixed 灵感只读） ============
          } else if (action === 'prefsGet') {
            send(200, await prefsGet())
          } else if (action === 'prefsSet') {
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            try {
              send(200, await prefsSet(args))
            } catch (e) { send(500, { ok: false, error: '偏好保存失败: ' + String(e && e.message || e) }) }
            // ============ 记忆工作台 Phase3 批次2（2026-09-06 additive）：① 真退役/复原 host 代理 + ② 记忆策略写 + ⑤ A1 领域召回 + ⑥ 会话回顾/待提炼队列 ============
          } else if (action === 'memRetire') {
            // ① U6 单候选真退役（有副作用，host loopback 收口）：POST {taskId} → memory-system /retire（doRetire 归档+KB 索引，mvp1 语义；成功才可能被 UI 写提炼历史等副作用）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const taskId = String(args.taskId || '').trim()
            if (!taskId) return send(400, { ok: false, error: '缺少 taskId' })
            const r1 = await memProxyPassthrough('/memory-system/api/retire', { taskId: taskId })
            send(r1.status, r1.body)
          } else if (action === 'memRetireRun') {
            // ① U6 看门狗手动一轮：POST {force?} → memory-system /retire-run（retireScan 一轮；UI 标注「手动一轮扫描」）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const force = args.force === true || String(args.force) === 'true'
            const r2 = await memProxyPassthrough('/memory-system/api/retire-run', { force: force })
            send(r2.status, r2.body)
          } else if (action === 'memRestore') {
            // ① U6 已归档复原（批次1 新端点 /restore 的唯一 host 调用方=本 action）：POST {taskId}
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const taskId = String(args.taskId || '').trim()
            if (!taskId) return send(400, { ok: false, error: '缺少 taskId' })
            const r3 = await memProxyPassthrough('/memory-system/api/restore', { taskId: taskId })
            send(r3.status, r3.body)
          } else if (action === 'memArchiveList') {
            // ① U6 归档清单只读投影：直读 记忆归档/归档清单.json（cache:false 镜像整表投影 + restored 计数）
            const r4 = await memArchiveListFn()
            send(r4.status, r4.body)
          } else if (action === 'memConfigSet') {
            // ② U8 记忆策略调参写回（host 白名单 JS 校验先行，memory-system /config 兜底双校验）：POST {memoryScore:{...}}；{} → 读模式透传
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const cfgErr = memConfigPayloadError(args)
            if (cfgErr) return send(400, { ok: false, code: 'invalid-config', error: cfgErr })
            const r5 = await memProxyPassthrough('/memory-system/api/config', args)
            send(r5.status, r5.body)
          } else if (action === 'kbDomainSearch') {
            // ⑤ A1 领域召回：POST {q?, domain?} —— 写作=category 白名单直读镜像（现网 domain=写作 为 0，§6.2/V1 口径）；已落 domain 领域走 /search domain 直传
            const r6 = await kbDomainSearchFn(args)
            send(r6.status, r6.body)
          } else if (action === 'sessionList') {
            // ⑥ 对话回顾·会话清单（只读；live 会话标题内存快照折叠；persisted 标题缺失回退 header.id——整段日志折叠会同步阻塞，实测 508 段/193MB）
            const r7 = await sessionListFn()
            send(r7.status, r7.body)
          } else if (action === 'sessionSearch') {
            // ⑥ 对话回顾检索（只读不注入上下文）：POST {sessionId*, q?, types?, limit?, recentN?, recentOnly?}
            const r8 = await sessionSearchFn(args)
            send(r8.status, r8.body)
          } else if (action === 'sessionRecent') {
            // ⑥ 「最近说了什么」（只读）：POST {sessionId, n?≤50}
            const r9 = await sessionRecentFn(args)
            send(r9.status, r9.body)
          } else if (action === 'queueSuggest') {
            // ⑥ 待提炼队列·候选启发式（本地规则，不落盘）：POST {sessionId?, text?} → {candidates}
            const r10 = await queueSuggestFn(args)
            send(r10.status, r10.body)
          } else if (action === 'queueAdd') {
            // ⑥ 待提炼队列·入队（sidecar 待提炼队列.json，首写才建/缺失空态）：POST {text*, sessionId?, guess?{kind,by,note}}
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r11 = await queueAddFn(args)
            send(r11.status, r11.body)
          } else if (action === 'queueUpdate') {
            // ⑥ 待提炼队列·置状态/打 distill 落库标（落库闭环：client 调 distill* 成功后调用本 action）：POST {id*, status?, text?, guess?, sessionId?, distill?{target,downstreamId,at}}
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r12 = await queueUpdateFn(args)
            send(r12.status, r12.body)
          } else if (action === 'queueList') {
            // ⑥ 待提炼队列·只读回显（批次3 补缺：readQueue → cache:false 读盘，缺失空态；POST/GET 皆可，{status?} 过滤）
            const r13 = await queueListFn(args)
            send(r13.status, r13.body)
          } else if (action === 'indexUpsert') {
            // U-45 / W-B（2026-09-29 additive）：按 path 增/改一条索引条目（写类 ⇒ 需 POST）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r14 = await doIndexUpsert(args)
            send(r14.status, r14.body)
          } else if (action === 'indexRebuild') {
            // U-45 / W-B：重扫 → 三方对照 + updatedAt 刷新（🔴 **默认 dry-run**，不写任何东西；写类 ⇒ 需 POST）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r15 = await doIndexRebuild(args)
            send(r15.status, r15.body)
          } else if (action === 'submit') {
            // U-41 / P2（2026-09-29 additive）：客户端**唯一跨界动作** —— 把 客户端区/正文/<作品>/<文档>.md
            // **复制**进 写作训练/草稿/（此后归 agent）；命中已归档同名件时走 §2.4 甲案（并留 + 自动补「替代」）。
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r16 = await doSubmit(args)
            send(r16.status, r16.body)
          } else if (action === 'clientZoneSave') {
            // U-41 / §2.5：写/改 `客户端区/<relPath>`（默认不覆盖，复用 draft-save 的闸）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r17 = await doClientZoneSave(args)
            send(r17.status, r17.body)
          } else if (action === 'clientZoneList') {
            const r18 = await doClientZoneList(args)
            send(r18.status, r18.body)
          } else if (action === 'clientZoneRead') {
            const r19 = await doClientZoneRead(args)
            send(r19.status, r19.body)
          } else if (action === 'clientZoneDelete') {
            // U-41 / §2.5：**软删** —— 移到 `客户端区/回收/<原路径>`
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r20 = await doClientZoneDelete(args)
            send(r20.status, r20.body)
          } else if (action === 'specAudit') {
            // U-41 / P5（2026-09-29 additive）：**只读**规范体检（不写任何文件；POST/GET 皆可）
            const r21 = await doSpecAudit()
            send(r21.status, r21.body)
          } else {
            send(404, { ok: false, error: '未知 action: ' + action, actions: ['ping', 'upload', 'flow', 'milestones', 'save', 'insp', 'inspUpdate', 'relations', 'training', 'overview', 'memSummary', 'reuseList', 'reuseSet', 'assetGraph', 'workSave', 'workDelete', 'assetLink', 'assetUnlink', 'workArchive', 'distillList', 'distillInsp', 'distillKb', 'distillMemory', 'prefsGet', 'prefsSet', 'memRetire', 'memRetireRun', 'memRestore', 'memArchiveList', 'memConfigSet', 'kbDomainSearch', 'sessionList', 'sessionSearch', 'sessionRecent', 'queueSuggest', 'queueAdd', 'queueUpdate', 'queueList'].concat(INDEX_ACTIONS, ['submit'], CZ_ACTIONS, ['specAudit']) })
          }
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message || e) })
        }
      }
      ctx.effect(function () { return ws.register({ kind: 'prefix', path: '/writing-studio/api', handler: handler }) })
    }
  } catch (e) {}
}

export { inject }

// 草稿命名（补丁① 2026-08-30，wrpro 与 writing-studio 两处逐字一致）：
// 空/null/全空白标题兜底为「未命名」；非空取 String(title).trim() 后把非法字符 [\\/:*?"<>|] 清洗为 `_`。
// 文件名 = name + '_' + stamp + '.md'（不再出现裸时间戳）；标题行 = '# ' + name（清洗后的 base）。
export function draftNaming(title, stamp) {
  const raw = title === null || title === undefined ? '' : String(title)
  const cleaned = raw.trim().replace(/[\\/:*?"<>|]/g, '_')
  const name = cleaned || '未命名'
  return { name: name, filename: name + '_' + stamp + '.md', titleLine: '# ' + name }
}
