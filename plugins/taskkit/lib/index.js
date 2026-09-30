// Host：任务插件静态化 v2（修正版）—— 采用 dsh-better-sidebar 成功模式
// 关键修正：不声明 inject 属性访问，全程 ctx.get() 惰性读取；export function apply(ctx, config)
// 范本：profiles/web/node_modules/dsh-better-sidebar/lib/index.js（已验证可加载）
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AuditLogger } from './audit.js'
// U-7 / T1b（2026-09-28）：relations 组的纯逻辑（draft 归一 / 幂等删除语义 / actions 真源）抽到无宿主依赖模块，
// 本地可真单测；本文件只做薄接线。list / update 的既有行为与响应形状**一字不改**。
import { RELATIONS_ACTIONS, normalizeDraftArg, deleteRelation } from './relations-core.js'
// U-44 / W-A（2026-09-29）：灵感退役（软删）/ 复原 / 退役清单的**纯逻辑**（同 relations-core 法，本地可真单测）。
// 形状对齐 memory-system 的 doRetire/doRestore 与 memArchiveList：见
//   docs/superpowers/evidence/2026-09-29-window-w-a/A-0-shape-alignment.md
import {
  INSP_RETIRE_DIR_REL, INSP_RETIRE_MANIFEST_REL, INSP_RETIRE_STATUS,
  INSP_EDITABLE_FIELDS, INSP_LIST_DEFAULT_LIMIT, INSP_LIST_MAX_LIMIT, INSP_HTTP_ACTIONS,
  normalizeInspIdArg, retireFileName, extractEntry, insertEntry,
  emptyManifest, normalizeManifest, buildRetireRow, findRetireRow,
  upsertRetireRow, markRetireRowRestored, resolveListLimit, stripContent, worldviewWarn
} from './insp-retire-core.js'
// U-49（2026-09-30）：`render` 补明细 + `tagsPrefix` 前缀过滤（纯函数，可真单测）
import { renderInspListText, filterTagsPrefix } from './insp-render-core.js'
import { createHmac } from 'node:crypto'
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 模块物理目录（ESM 无 __dirname/require；import.meta.url 是唯一可靠的自定位方式——cfgV3 配置定位依赖它）
const __moduleDir = typeof import.meta !== 'undefined' && import.meta.url
  ? dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
  : ''
// 从 .../dsh-data/profiles/web/node_modules/@local/taskkit/lib → 上溯到 dsh-data
const __dshDataGuess = __moduleDir
  .replace(/\/profiles\/web\/node_modules\/@local\/taskkit\/lib$/, '')
  .replace(/\/node_modules\/@local\/taskkit\/lib$/, '')
  .replace(/\/node_modules\/taskkit\/lib$/, '')

// 数据根：S11 软编码改造（优先运行时 cwd，FALLBACK 仅为向后兼容）；可用 DSH_TASKKIT_BOARD 覆盖看板路径
// O5 迁移（W2）：
//  - 根名 `写作训练` 与 profile `cordis.yml` 中 `@local/dsh-adapter.config.adapter.roots` 的登记一致；
//    下列文件常量一律改为「根内相对引用」，绝对路径由 adapterFs 解析（resolveRef / resolve）。
//  - **不迁**（业务键链，显式声明）：`computeDataRoot(cwd)` + `DATA_ROOT` 的运行时优先级链（apply 内 L477-485）
//    —— 依据设计 §2.1 第 32 行裁定「业务键链不进 adapter」+ §8 铁律 6（adapter 极薄，不做业务规则）。
//    `DATA_ROOT` 仍以绝对路径形态服务于归档/execSync 等非根表路径（其 fs 调用同样经 adapterFs，按绝对路径直解）。
const ROOT_TRAIN = '写作训练'
// G11①（t111）：新增两个登记根（根表在 `@local/dsh-adapter` 的 dsh-bundle-patch.yml 声明）——
//   工具根（技术文档库.json 所在）与领域模板根；kb_sync_docs 原两处硬编码绝对路径改经此二根。
const ROOT_TOOLS = 'DSH工具'
const ROOT_TPL = '插件开发体系模板'
// 2026-09-22 Linux 化：兜底数据根不再写死盘符。
// 只改「兜底值」的来源，**不动**既有优先级链（computeDataRoot(cwd) + DATA_ROOT 仍保留绝对路径形态，
// 因为它要喂给 execSync / 归档路径；依据 O5 迁移 W2 的裁定：业务键链不进 adapter）。
// Windows 不设 DSH_WORKSPACE_ROOT 时结果与改造前逐字一致。
const FALLBACK_WIN_ROOT = 'E:/DSH工作区' // linux-ready-exempt: 有意保留的 Windows 历史默认值（仅在未设 DSH_WORKSPACE_ROOT 时生效；Linux 由 setup.sh 注入）
const FALLBACK_WORKSPACE_ROOT = (typeof process !== 'undefined' && process.env && process.env.DSH_WORKSPACE_ROOT
  && String(process.env.DSH_WORKSPACE_ROOT).trim())
  || FALLBACK_WIN_ROOT
const FALLBACK_DATA_ROOT = String(FALLBACK_WORKSPACE_ROOT).replace(/[\\/]+$/, '') + '/写作训练'

// 凭据文件（.credentials.yaml）路径（2026-09-22 Linux 化）：
// 原写死 'E:/DeepSeek-Harness-1.0.0-portable/dsh-data/.credentials.yaml'，Linux 上必然读不到
// ⇒ typo-ai 语义层与 writing-coach 同款**静默退化**（无报错，只是效果变差，很难被发现）。
// 回退链与 adapter 的 resolveDshHome / writing-coach 的 paths.js 同口径。
const CREDENTIALS_FILE = (function () {
  const env = (typeof process !== 'undefined' && process.env) || {}
  const explicit = String(env.DSH_CREDENTIALS_FILE || '').trim()
  if (explicit) return explicit
  let home = String(env.DSH_HOME || '').trim()
  if (!home) {
    try {
      const p = resolve(process.cwd(), 'dsh-data')
      if (existsSync(p)) home = p
    } catch (_) { /* 取 cwd 失败则继续往下推 */ }
  }
  if (!home) {
    const appdata = String(env.APPDATA || '').trim()
    home = appdata ? resolve(appdata, 'dsh', 'dsh-data') : resolve(process.cwd(), 'dsh-data')
  }
  return resolve(home, '.credentials.yaml')
})()

// 「工具资料根」（DSH工具）——供工具描述 / 默认扫描目录 / 提示词引用，随平台派生（勿再写死盘符）。
// 注意：Windows 下渲染为 `E:/DSH工作区/DSH工具`（正斜杠）；Node/fs 在 Windows 上同样接受正斜杠。
const TOOLS_DIR_ABS = String(FALLBACK_WORKSPACE_ROOT).replace(/[\\/]+$/, '') + '/DSH工具'

// 提示词里「同步权威源 / 运行副本」那段（2026-09-22 按平台派生，不再写死 Windows 绝对路径）：
//   Windows —— 静态化源与 profile 运行副本是**两份实体**，确实需要两步同步；
//   Linux   —— profile 用**软链**指向仓库 ⇒ 源码目录同时就是运行副本，两步同步无意义。
const PLUGIN_SYNC_HINT = (function () {
  try {
    if (process.platform !== 'win32') {
      return '改动即生效：本平台 profile 以软链指向仓库，源码目录同时就是运行副本（' + __moduleDir + '），无需两步同步'
    }
    return '改动须同步权威源（' + FALLBACK_WORKSPACE_ROOT + '/DSH工具/静态化/taskkit/lib/index.js）与运行副本（'
      + String(__dshDataGuess || '') + '/profiles/web/node_modules/@local/taskkit/lib/index.js）'
  } catch (_) { return '改动须同步权威源与运行副本' }
})()

/**
 * 提示词里"用什么工具落盘文档"（2026-09-22）：**按平台 + 能力探测生成**，不再写死 pwsh。
 * 原提示词让 agent 用 `pwsh Set-Content`，而 Linux 上根本没有 pwsh 工具（实测最小集该前缀组为空）。
 * 探测顺序：已注册工具里先认 `write*`，再认 `pwsh*`；都拿不到就按平台给保守答案。
 */
function describeWriteTool(toolsSvc) {
  try {
    const names = collectRegisteredToolNames(toolsSvc)
    if (names.length) {
      if (names.some(function (n) { return n === 'write' || n.indexOf('write') === 0 })) return '用宿主 write 工具'
      if (names.some(function (n) { return n.indexOf('pwsh') === 0 })) return '用 pwsh Set-Content / [IO.File]::WriteAllText'
    }
  } catch (_) { /* 探测失败按平台兜底 */ }
  return process.platform === 'win32' ? '用 pwsh Set-Content / [IO.File]::WriteAllText' : '用当前会话可用的文件写入工具'
}
function computeDataRoot(cwd) {
  const base = (typeof cwd === 'string' && cwd) ? cwd : FALLBACK_DATA_ROOT.replace(/[\\/][^\\/]+$/, '')
  // 去掉末尾分隔符
  const b = String(base).replace(/[\\/]+$/, '')
  return b + '/写作训练'
}
let DATA_ROOT = FALLBACK_DATA_ROOT
// DSH_TASKKIT_BOARD 环境覆盖优先级**逐字保持**：env 非空则取 env（绝对路径 → resolveRef 直解），否则为根内相对引用（→ 根 写作训练）
const BOARD_REL = (typeof process !== 'undefined' && process.env && process.env.DSH_TASKKIT_BOARD) ? process.env.DSH_TASKKIT_BOARD : '任务看板.json'
const INSP_POOL_REL = '灵感待整理.json'
const APPROVAL_LOG_REL = '审批记录.json'
const LIBRARY_REL = '灵感素材库.md'
const MEETING_DRAFT_REL = '灵感整理大会_会议纪要_草稿.md'
const WRITING_RECORD_REL = '写作记录.json'
const DRAFT_DIR_REL = '草稿'
const SCHEDULE_PLAN_REL = '日程计划.json'
const SCHEDULE_DONE_REL = '日程完成.json'
const TRAINING_PLAN_REL = '训练计划.md'
const TECH_HANDBOOK_REL = '写作技巧速查手册.md'
const SAVE_LOG_REL = '日志/保存日志.jsonl'
const REVIEW_TEMPLATE_REL = '周复盘模板.md'
const WRITING_RELATIONS_REL = '草稿/relations.json'
// 启动唤醒配置（2026-08-27 需求：DSH 启动后自动唤醒任务中心/插件开发工坊/创作教练，清单可管理面板增删持久化）
const WAKE_CONF_REL = '唤醒配置.json'
const WAKE_DEFAULT_ENTRIES = [
  { id: 'session-0e4ee8e5-afd1-4197-9290-f31dfc87a680', title: '任务中心', enabled: true },
  { id: 'session-53c34b02-5ee1-4b23-bf44-e714a964d9d6', title: '插件开发工坊', enabled: true },
  { id: 'session-1e2cf8b6-31f8-4784-ae48-9c64cbd92da3', title: '创作教练', enabled: true }
]
const WAKE_DEFAULT_DEFAULTS = { provider: 'deepseek-official', model: 'deepseek-v4-flash', delayMs: 3000 }
const WAKE_DEFAULT_MESSAGE = '📮 已启动，会话就绪（启动唤醒通知，无需回复）'

// 派发并发与超时豁免（2026-08-27 队列化改造）：
// - 守卫从「同一会话只能 1 个执行中」改为「队列上限」：会话消息队列本身可缓存任务，允许排队派发
// - 看门狗对排队任务（非最早派发）不判超时；最早派发任务超时判定结合会话活跃度（避免排队/慢执行误杀）
const MAX_QUEUE_PER_SESSION = 3              // 同一目标会话允许排队执行中的任务上限（会话消息队列作缓存）
const SESSION_ACTIVE_GRACE_MS = 6 * 60 * 60 * 1000 // 会话最近活跃豁免阈值：6h 内有活动视为仍在推进，不判超时

const defaultBoard = () => ({
  version: 1,
  revision: 1,
  '说明': '任务看板：状态取值为 待执行 / 执行中 / 需审批 / 已完成。预约时间 due 格式 ISO 字符串；重复任务 repeat 如 "每周一 09:00"。requirement 为任务要求/提示词；assignedSession 为 v3 目标会话预留。',
  tasks: []
})

const VALID_STATUS = ['待执行', '执行中', '需审批', '已完成', '中止', '已取消']

function normalizeTask(raw, index) {
  if (raw === null || typeof raw !== 'object') raw = {}
  const now = new Date().toISOString()
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'task-' + String(index + 1).padStart(3, '0'),
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : '未命名任务',
    requirement: typeof raw.requirement === 'string' ? raw.requirement : '',
    project: typeof raw.project === 'string' ? raw.project : '',
    status: VALID_STATUS.indexOf(raw.status) >= 0 ? raw.status : '待执行',
    due: typeof raw.due === 'string' && raw.due !== '' ? raw.due : null,
    repeat: typeof raw.repeat === 'string' && raw.repeat !== '' ? raw.repeat : null,
    owner: typeof raw.owner === 'string' ? raw.owner : '',
    assignedSession: typeof raw.assignedSession === 'string' && raw.assignedSession !== '' ? raw.assignedSession : null,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter(function (d) { return typeof d === 'string' }) : [],
    startAfter: typeof raw.startAfter === 'string' && raw.startAfter !== '' ? raw.startAfter : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    queuedAt: typeof raw.queuedAt === 'string' ? raw.queuedAt : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    held: !!raw.held,
    heldAt: typeof raw.heldAt === 'string' ? raw.heldAt : null,
    holdReason: typeof raw.holdReason === 'string' ? raw.holdReason : '',
    pipeline: (raw.pipeline && typeof raw.pipeline === 'object') ? { phase: typeof raw.pipeline.phase === 'string' ? raw.pipeline.phase : '', gate: typeof raw.pipeline.gate === 'string' ? raw.pipeline.gate : null, rootTaskId: typeof raw.pipeline.rootTaskId === 'string' ? raw.pipeline.rootTaskId : '' } : null,
    ackPolicy: typeof raw.ackPolicy === 'string' ? raw.ackPolicy : 'auto',
      dispatch: (raw.dispatch && typeof raw.dispatch === 'object') ? raw.dispatch : null,
    lessons: Array.isArray(raw.lessons) ? raw.lessons.slice(-30) : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.slice(-30) : [],
    receiptHashes: Array.isArray(raw.receiptHashes) ? raw.receiptHashes.slice(-20) : [],
    nextTryAt: typeof raw.nextTryAt === 'string' && raw.nextTryAt !== '' ? raw.nextTryAt : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  }
}

function normalizeBoard(raw) {
  if (raw === null || typeof raw !== 'object') return defaultBoard()
  const src = Array.isArray(raw.tasks) ? raw.tasks : []
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    // revision：Host 权威账本版本号（借鉴 task-board）——每次写盘递增，供派发/同步前校验防并发覆盖
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    '说明': typeof raw['说明'] === 'string' && raw['说明'] !== '' ? raw['说明'] : defaultBoard()['说明'],
    tasks: src.map(function (t, i) { return normalizeTask(t, i) })
  }
}

const defaultPool = () => ({ version: 1, items: [] })
// ====== 灵感库（结构化 JSON，设计文档《灵感库可视化_设计方案.md》§三）======
const INSP_LIB_REL = '灵感库/灵感库.json'      // 根内相对引用（根 写作训练）
const TD_LIB_REL = '技术文档库.json'           // 根内相对引用（根 DSH工具）—— G11①（t111）
const defaultInspLib = () => ({ version: 1, entries: [] })

// 创作资源库 v1：按灵感状态与内容推断默认创作归类（无教练归类时使用；教练可随时覆盖）
  const CATEGORY_ORDER = ['主攻', '备选', '冻结', '待启动']
  function inferCategory(raw) {
    if (raw === null || typeof raw !== 'object') return '待启动'
    const st = raw.status || ''
    const title = String(raw.title || '') + String(raw.oneLiner || '') + (Array.isArray(raw.tags) ? raw.tags.join(' ') : '')
    // 会议决议关键词：主攻/备选/冻结
    if (/主攻|现在.*写|优先/.test(title)) return '主攻'
    if (/备选|候选|考虑/.test(title)) return '备选'
    if (/冻结|暂不|练习场|只进库/.test(title)) return '冻结'
    if (st === '已固定' || raw.fixed) return '主攻'
    if (st === '已整理') return '待启动'
    return '待启动'
  }

  function normalizeInspEntry(raw, i) {
  if (raw === null || typeof raw !== 'object') raw = {}
  const now = new Date().toISOString()
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'insp-' + String(Date.now()).slice(-6) + '-' + Math.floor(Math.random() * 90 + 10),
    number: typeof raw.number === 'string' ? raw.number : '',
    title: typeof raw.title === 'string' ? raw.title : ('灵感 ' + (i + 1)),
    oneLiner: typeof raw.oneLiner === 'string' ? raw.oneLiner : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    settingsRef: typeof raw.settingsRef === 'string' ? raw.settingsRef : '',
    hook: typeof raw.hook === 'string' ? raw.hook : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter(function (t) { return typeof t === 'string' }) : [],
    status: ['预存','待讨论','已整理','已固定'].indexOf(raw.status) >= 0 ? raw.status : '预存',
    // 创作资源库 v1：创作归类（主攻/备选/冻结/待启动），来自创作教练会议决议/训练计划；无归类时按状态推断
    category: ['主攻','备选','冻结','待启动'].indexOf(raw.category) >= 0 ? raw.category : inferCategory(raw),
    fixed: !!raw.fixed,
    meeting: (raw.meeting && typeof raw.meeting === 'object') ? { taskId: typeof raw.meeting.taskId === 'string' ? raw.meeting.taskId : '', date: typeof raw.meeting.date === 'string' ? raw.meeting.date : '', output: typeof raw.meeting.output === 'string' ? raw.meeting.output : '', decisions: typeof raw.meeting.decisions === 'string' ? raw.meeting.decisions : '' } : { taskId: '', date: '', output: '', decisions: '' },
    annotations: typeof raw.annotations === 'string' ? raw.annotations : '',
    history: Array.isArray(raw.history) ? raw.history : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  }
}

function normalizeInspLib(raw) {
  if (raw === null || typeof raw !== 'object') return defaultInspLib()
  return { version: typeof raw.version === 'number' ? raw.version : 1, entries: Array.isArray(raw.entries) ? raw.entries.map(function (e, i) { return normalizeInspEntry(e, i) }) : [] }
}
const defaultApprovals = () => ({ version: 1, records: [] })

function normalizePool(raw) {
  if (raw === null || typeof raw !== 'object') return defaultPool()
  const src = Array.isArray(raw.items) ? raw.items : []
  return { version: 1, items: src.map(function (it, i) {
    return {
      id: typeof it.id === 'string' && it.id !== '' ? it.id : 'insp-' + String(i + 1).padStart(3, '0'),
      raw: typeof it.raw === 'string' ? it.raw : '',
      source: typeof it.source === 'string' ? it.source : '',
      createdAt: typeof it.createdAt === 'string' ? it.createdAt : new Date().toISOString(),
      status: typeof it.status === 'string' && it.status !== '' ? it.status : '待整理'
    }
  }) }
}

function normalizeApprovals(raw) {
  if (raw === null || typeof raw !== 'object') return defaultApprovals()
  return { version: 1, records: Array.isArray(raw.records) ? raw.records : [] }
}

function lastLibraryNumber(text) {
  let max = 0
  const re = /^###\s+#(\d{3})/gm
  let m
  while ((m = re.exec(text)) !== null) { const n = Number(m[1]); if (n > max) max = n }
  return max
}

function titleFromRaw(raw) {
  const seg = raw.split(/[，。；、\n]/)[0] || raw
  const t = seg.trim().slice(0, 24)
  return t !== '' ? t : '灵感'
}

function pad3(n) { return String(n).padStart(3, '0') }
function pad2(n) { return String(n).padStart(2, '0') }

function fmtDue(iso) {
  if (!iso) return '无'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

// ====== 修复：显式声明 cordis inject 依赖（配合属性访问 ctx.tools / ctx.get 双重保险）======
// cordis loader apply() 调用前会注入这些服务，未声明的属性访问会抛 "cannot get property X without inject"
const inject = [
  'tools',       // L163 注册工具到 ctx.tools（cordis 核心）
  'fs',          // 读任务看板/灵感库
  'sandboxPolicy',
  'sessionQuery',
  'agents',
  'workspaceRegistry',
  'sessionTitle',
  'webServer'
]

// ---------------------------------------------------------------------------
// t81/C：**启动期工具面自检**（boot 后核对已注册工具集是否齐全；缺失即告警）
//
// 为什么必须加这段码：症状「工具间歇性 unknown tool」此前**无任何日志证据**——t81 实测
//   `logs/dsh.log` 仅 2 条且都是**重启原因文案**（08-27）、`logs/errors.log` 0 条 ⇒ 工具掉线
//   只能靠人察觉。本检查把「工具面缺项」变成一条**带具体名字的 WARN 审计行**。
//
// 期望集合的**可复核来源**（不是手抄清单）：
//   ① `collectDeclaredToolNames()` —— **静态扫描兄弟插件自身的源码**（工具名字面量）：
//      `静态化/<plugin>/lib/*.js` 里形如 `name: '<前缀>_<名>'` 的字符串字面量（要求含下划线＝工具名形状）。
//      宽口径是**有意的**：各插件的工具名散在 `toolDefs` 数组/spec 对象里，窄口径（紧贴 `defineTool({`）
//      会大量漏检（实测 7 vs 86）；宽口径的代价只是可能多报一个假阳性（假阳性只多出一条 WARN，不误停）。
//      各插件源码就是「它声明了哪些工具」的权威来源 ⇒ 插件新增/改名工具时期望集合**自动跟随**。
//   ② `TOOL_SURFACE_PREFIXES` —— 前缀组覆盖检查，兜住声明**不在** `静态化/` 下的工具
//      （宿主内建 `read/write/edit/glob/grep/pwsh`、`cordis_*`、`agent_teams_*` 等，其声明在运行时包里）。
//      每组只判「至少有一个已注册工具」，不锁定具体名字 ⇒ 同样不随插件演进失真。
//
// 观测集合口径：`tools.view()` ⇒ `{ visible:Map, knownNames:Set, restrictableNames:Set }`
//   （`@deepseek-ai/dsh-tools` 的 ToolRuntime.view(scope)，scope 省略＝全局视图；见其 `get()` 的 JSDoc）。
//   用 `knownNames` 而非 `visible`：restricted-away 的全局工具仍算「已注册」。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// t81/B：**动态包（sandbox）内禁用 Node timer**（预防判据；落点理由见 t81 证据文件 §B）
//
// 判据条文（逐字）：动态包（sandbox）内**禁用 Node timer**；需要定时须 `inject:['timer']`
//   并调用 `ctx.timeout/ctx.interval`（fiber effect 自动清理）。
//
// 为什么落在这里：本仓**已有**同族条目但**不是**同义条目——`任务插件_重启恢复清单.md:80`
//   「host 用 `ctx.interval` 必须 `inject: ['timer']`」讲的是**静态插件**的 inject 义务；
//   本条讲的是**动态包内不得直接用 Node 全局 timer**（`setTimeout`/`setInterval` 在沙箱内无宿主
//   fiber 归属 ⇒ 既不会被 `ctx.effect` 自动清理，也可能像 2026-09-18/19 那样直接致命失败）。
//   ⇒ 按「有则加固不新增」，本条**只登记为可在启动检查面被 grep 到的常量**，并在 t81 证据里
//   交叉引用上述既有条目；**不复制**其条文，避免同一规则出现两处权威。
//   权威升格（写进 `插件体系_纪律与判据规范.md` 或 skill 文档）不在 t81 可写范围 ⇒ 已作为
//   交接项登记，由持有那些文件的角色执行。
// ---------------------------------------------------------------------------
export const DYNAMIC_PLUGIN_TIMER_RULE = Object.freeze({
  rule: "动态包（sandbox）内禁用 Node timer；需要定时须 inject:['timer'] 并调用 ctx.timeout/ctx.interval（fiber effect 自动清理）",
  bannedGlobals: Object.freeze(['setTimeout', 'setInterval', 'setImmediate']),
  requiredInject: 'timer',
  allowedApi: Object.freeze(['ctx.timeout', 'ctx.interval']),
  seeAlso: Object.freeze(['DSH工具/任务插件_重启恢复清单.md:80', 'DSH工具/静态化_taskkit_v2_安装与撤销.md:27']),
})

/** 期望覆盖的前缀组（每组至少 1 个已注册工具；逐条对应 t81 契约点名的前缀） */
export const TOOL_SURFACE_PREFIXES = [
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh',
  'tsk_', 'memory_', 'miyoushe_', 'agent_teams_', 'cordis_',
  'writing_', 'wrpro_', 'writing_studio_', 'kb_', 'insp_', 'prompt_', 'skill_',
]
// 2026-09-22：**移除 `'sandbox_'` 前缀组**。原组是为 `@local/sandbox` 提供的 9 个
// `sandbox_*` 工具兜的；该插件已拆除（热拔插内化进 `@local/dsh-adapter`，工具改名
// `hotplug_*`）。若继续保留该组，它会**永远为空** ⇒ 每次启动都 WARN ——
// 与本次要修的"时序假警报"同属一类：一个恒定触发的告警会训练人忽略告警。
// 注意：这里**刻意不加** `hotplug_` 组。`hotplug_*` 由 adapter 注册，其声明不在
// `静态化/*/lib`（adapter 是宿主侧插件，声明在自身包里）⇒ 加进来会引入新的时序依赖；
// 而 adapter 的启动审计已自带 `hotplug.tools.ready ok=10 fail=0`，观测点不重叠、不必重复。
//
// 已退役前缀组：仅登记"为什么从覆盖清单里消失"，**不参与** checkToolSurface 的门禁
// （否则就是把退役组重新变成恒定告警）。留痕是为了让日后读代码的人知道 sandbox_ 不是漏了。
export const RETIRED_TOOL_PREFIXES = Object.freeze([
  { prefix: 'sandbox_', retiredAt: '2026-09-22', reason: '@local/sandbox 拆除，热拔插内化进 @local/dsh-adapter（工具改名 hotplug_*）' },
])

/** 本插件所在目录 `…/静态化/<plugin>`（用于定位同级插件源码） */
const __PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 纯函数：核对工具面。`registered`/`declared`/`prefixes` 全部**由入参注入** ⇒ 不读任何外部状态，
 * 可单测、可复算、可在演示里注入「缺一项」的集合。
 * @param opts { registered:string[], declared:string[], prefixes:string[] }
 * @returns { ok, registeredCount, declaredCount, missing:[…], emptyGroups:[…] }
 */
export function checkToolSurface(opts) {
  const o = opts || {}
  const uniq = (a) => Array.from(new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && x)))
  const registered = uniq(o.registered)
  const declared = uniq(o.declared)
  const prefixes = uniq(o.prefixes)
  const reg = new Set(registered)
  const missing = declared.filter((n) => !reg.has(n)).sort()
  const emptyGroups = prefixes.filter((p) => !registered.some((n) => n === p || n.indexOf(p) === 0)).sort()
  return { ok: missing.length === 0 && emptyGroups.length === 0, registeredCount: registered.length, declaredCount: declared.length, missing, emptyGroups }
}

/**
 * 期望集合来源①：静态扫描兄弟插件源码里的 `defineTool({ name: '…' })` 声明（只读）。
 * @param pluginRootDir 本插件目录（`…/静态化/<plugin>`）
 */
export function collectDeclaredToolNames(pluginRootDir) {
  const out = []
  try {
    const home = dirname(pluginRootDir)
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.charAt(0) === '_') continue
      const libDir = resolve(home, ent.name, 'lib')
      if (!existsSync(libDir)) continue
      for (const f of readdirSync(libDir)) {
        if (!f.endsWith('.js') || f.indexOf('.bak') >= 0) continue
        let s = ''
        try { s = readFileSync(resolve(libDir, f), 'utf8') } catch (_) { continue }
        for (const m of s.matchAll(/name:\s*'([a-z][a-z0-9]*_[a-z0-9_]+)'/g)) out.push(m[1])
      }
    }
  } catch (_) {}
  return Array.from(new Set(out)).sort()
}

/** 观测集合：从宿主 `tools` 服务读**当前已注册**的工具名（口径见上方注释） */
export function collectRegisteredToolNames(toolsSvc) {
  try {
    if (!toolsSvc || typeof toolsSvc.view !== 'function') return []
    const v = toolsSvc.view()
    if (v && v.knownNames && typeof v.knownNames[Symbol.iterator] === 'function') return Array.from(v.knownNames)
    if (v && v.visible && typeof v.visible.keys === 'function') return Array.from(v.visible.keys())
  } catch (_) {}
  return []
}

// ---------------------------------------------------------------------------
// t83：启动期工具面**收敛检查**（替换原"apply 末尾同步查一次"的时序假警报）
//
// 【现场】原实现在 taskkit 自己的 apply 末尾同步查一次，于是每次启动都 WARN：
//   registered=90 declared=86 missing=[] ← 声明项一个不缺
//   emptyGroups=[edit,glob,grep,pwsh,read,write,agent_teams_,cordis_]
// 而**同一函数、同一观测口径**（`tools.view().knownNames`）在运行稳定后是
//   registered=128 emptyGroups=[]；用 Tool.listTools 实测 138、19 组全非空。
// ⇒ 同代码同查询、两个时刻两个结果 ⇒ 差异在「何时」，不在「怎么看」。
//
// 【因果】cordis-plugin-loader 创建同批 loader 条目是**并发**的
//   （EntryGroup.update → Promise.allSettled(config.map(create))），
//   所以"taskkit 自己 apply 完" ≠ "整棵树挂载完"：自检触发时 boot 还没走完
//   （实测同一次启动里 taskkit 的另一个启动钩子 wake.all.start 还在 6s 后才跑）。
//   连 read/write/edit/glob/grep/pwsh 这些内建文件工具也算空组，同因：它们的挂载
//   与 taskkit 的 apply 之间没有先后保证 —— 不是为了显得完备而"多等一会儿"。
//
// 【为什么必须修】每次启动都 WARN ⇒ ①狼来了，监控者学会忽略；②更糟：真出故障时与
//   这个时序假象在日志里长得一样，等于毁掉"工具掉线可被立即定位"这个目标。
//
// 【修法：两件一起做，只把时间往后挪不算完成】
//   (a) **有界轮询**直到 registered 不再增长 —— 刻意做成**信号无关**：
//       不依赖任何插件提供的 settle 事件。原因有二：①`sandbox.loader.tree.async_settled`
//       / `sandbox.autoload.done` 是 sandbox 插件写进审计的行，**不可订阅**（taskkit 拿不到）；
//       ②该插件已在 2026-09-22 拆除（热拔插内化进 @local/dsh-adapter），信号不复存在。
//       轮询自行判定收敛，两个版本上都成立。
//   (b) 只有**收敛后仍缺**才判 WARN；未收敛单独一档（INFO + 显式 NOT-CONVERGED 标记），
//       并把收敛轨迹写进审计 —— 这样"尚未注册"与"注册失败"才可区分。
// ---------------------------------------------------------------------------

/** 收敛检查的默认参数（单测与 host 共用，避免两处漂移） */
export const TOOL_SURFACE_CONVERGENCE = Object.freeze({
  startDelayMs: 1000,   // 首采样前的等待（减少无谓采样；真正的保证在收敛判定，不在这里）
  intervalMs: 750,      // 采样间隔
  stableSamples: 3,     // 连续 N 次 registered 不增长 ⇒ 判定收敛
  maxWaitMs: 90000,     // 硬上限：到点即出结论并写日志，不无限等
})

/**
 * 有界轮询直到工具面收敛（registered 连续 N 次不再增长）。
 * 依赖全部可注入（toolsSvc / now / sleep / tuning）⇒ 可确定性单测，不需要真实启动。
 *
 * 收敛判据含 `registeredCount > 0`：否则"tools 服务尚未就绪 ⇒ 一直是 0"会被误判成收敛，
 * 那等于把假警报换成假绿灯。
 *
 * @param opts { toolsSvc, declared, prefixes, tuning?, now?, sleep? }
 * @returns { ok, converged, registeredCount, declaredCount, missing, emptyGroups, waitedMs, samples, trajectory }
 */
export async function convergeToolSurface(opts) {
  const o = opts || {}
  const declared = Array.isArray(o.declared) ? o.declared : []
  const prefixes = Array.isArray(o.prefixes) ? o.prefixes : []
  const cfg = Object.assign({}, TOOL_SURFACE_CONVERGENCE, o.tuning || {})
  const now = typeof o.now === 'function' ? o.now : () => Date.now()
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  const t0 = now()
  const trajectory = []

  if (cfg.startDelayMs > 0) await sleep(cfg.startDelayMs)

  let last = -1
  let stable = 0
  for (;;) {
    const snap = checkToolSurface({
      registered: collectRegisteredToolNames(o.toolsSvc),
      declared,
      prefixes,
    })
    const elapsed = now() - t0
    // 短键以压缩审计体积（一轮最多 maxWaitMs/intervalMs ≈ 120 条）
    trajectory.push({ t: elapsed, reg: snap.registeredCount, miss: snap.missing.length, empty: snap.emptyGroups.length })
    if (snap.registeredCount === last) stable += 1
    else { stable = 0; last = snap.registeredCount }
    const converged = snap.registeredCount > 0 && stable >= cfg.stableSamples
    if (converged || elapsed >= cfg.maxWaitMs) {
      return Object.assign({}, snap, { converged, waitedMs: elapsed, samples: trajectory.length, trajectory })
    }
    await sleep(cfg.intervalMs)
  }
}

/**
 * 由收敛结果决定审计级别（纯函数 ⇒ "假警报消失/真警报触发"这条判据可被单测直接锁定）。
 *   ok                → INFO（正常）
 *   收敛后仍缺         → WARN（**真**缺失，非时序）
 *   未收敛            → INFO + NOT-CONVERGED 标记（拒绝在"无法区分"时喊狼来了）
 */
export function toolSurfaceVerdict(r) {
  if (!r || r.ok) return { level: 'INFO', kind: 'ok' }
  if (r.converged) return { level: 'WARN', kind: 'incomplete' }
  return { level: 'INFO', kind: 'not-converged' }
}

export function apply(ctx, config) {

  // MARKER-CAPTAIN-VERIFY: 20260827222539
  // 热拔插清理：registerTool 登记的 disposer 表，保证 reload 去重 + 幂等
  // 注：toolsSvc.register() 内部用 layers.effect(this.ctx=tools服务ctx) 登记，
  //     tools 服务 ctx 是全局 ctx，插件卸载时不会 dispose。因此必须通过 taskkit 插件 ctx.effect
  //     再包一层 dispose，显式调用 toolsSvc.register 返回的 disposer 来真正解注册。
  const __toolDisposers = new Map()  // toolName -> disposer
  const __regFinalizers = []        // 全部工具的 dispose cleanup（批量）
  const audit = new AuditLogger(ctx)

  // ============================================================
  // S12 P1-B2 基础骨架：Orchestrator V3 配置读取 + 审计事件占位
  // （仅注入配置层 & 事件注册表，不改动现有控制流，热加载兼容）
  // ============================================================
  // 1) 集中化默认值（单一来源；硬约束：MAX_RESUME 硬上限 5）
  const ORCHESTRATOR_V3_DEFAULTS = {
    // §2 扫描与阈值
    MAX_RESUME: 3,
    ORCHESTRATOR_INTERVAL_MIN: 10,
    COLD_SCAN_DELAY_SEC: 120,
    PROBE_COOLDOWN_MIN: 30,
    LONG_RUNNING_HOUR: 2,
    SESSION_IDLE_MIN: 15,
    // §3 探针
    PROBE_TIMEOUT_MS: 15000,
    PROBE_MECHANISM_A_FALLBACK_TO_B: true,
    PROBE_B_KEYWORD: '探针响应·存活',
    // §4 唤醒
    BOOT_WINDOW_SEC: 300,
    RESUME_TRANSIENT_RETRY_DELAY_MS: 3000,
    // §6 修复开关（默认 A/B 开启，按 §6.1~§6.3 闭环后生效）
    FIX_A_BACKOFF_QUEUE: true,
    FIX_B_SAFE_RESUME: true,
    FIX_C_SESSION_CHECK: false,
    // §5 防御
    ID_COLLISION_REPAIR_ENABLED: true,
  }
  const __V3_MAX_RESUME_HARD_CAP = 5
  // 2) 惰性加载 taskkit-config.json；单一读取函数 cfgV3(key, fallback)
  let __taskkitConfig = null
  function __loadTaskkitConfigOnce() {
    if (__taskkitConfig !== null) return __taskkitConfig
    try {
      // DSH_HOME 优先；否则从模块位置上溯推断 dsh-data（ESM 下无 __dirname，用 import.meta.url 推导；
      // 修复(2026-09-05)：taskkit 进程内 process.env.DSH_HOME 可能为空（宿主不注入插件模块 env）+ 旧代码用 __dirname（ESM 恒空）→ 配置永读不到）
      const dshHome = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || ''
      const candidates = []
      if (dshHome) candidates.push(dshHome + '/taskkit-config.json')
      if (!dshHome && __dshDataGuess && existsSync(__dshDataGuess + '/taskkit-config.json')) candidates.push(__dshDataGuess + '/taskkit-config.json')
      // 兜底：cwd 与常见部署根
      try {
        if (!candidates.length) {
          const cwdGuess = (typeof process !== 'undefined' && process.cwd ? process.cwd() : '').replace(/\\/g, '/')
          // 2026-09-22 Linux 化：原第三项写死 'E:/DeepSeek-Harness-1.0.0-portable/dsh-data'（Windows 便携版）。
          // 改为按 APPDATA 派生（Windows 仍能命中），Linux 上则由前两项 + DSH_HOME 覆盖。
          const roots = [cwdGuess + '/dsh-data', cwdGuess]
          try {
            const appdata = String((process.env && process.env.APPDATA) || '').trim()
            if (appdata) roots.push(appdata.replace(/\\/g, '/') + '/dsh/dsh-data')
          } catch (_) {}
          for (const root of roots) {
            if (root && existsSync(root + '/taskkit-config.json')) { candidates.push(root + '/taskkit-config.json'); break }
          }
        }
      } catch (_) {}
      for (const cand of candidates) {
        try {
          // 修复(2026-09-05)：原裸 require('node:fs') 在宿主 ESM 下 ReferenceError → catch 吞 → cfgV3 永远走 no_file
          // （taskkit-config.json 从未被真正读取；memoryIntegration/orchestratorV3 开关全部失效）。改用手部已 import 的 readFileSync/existsSync。
          if (existsSync(cand)) {
            const raw = readFileSync(cand, 'utf8')
            const parsed = JSON.parse(raw)
            __taskkitConfig = parsed && typeof parsed === 'object' ? parsed : {}
            try { audit.log({ level: 'INFO', category: 'config', event: 'config.loaded', message: 'taskkit-config.json loaded (orchestratorV3 present=' + String(!!(__taskkitConfig && __taskkitConfig.orchestratorV3)) + ')', extra: { path: cand } }) } catch (_) {}
            return __taskkitConfig
          }
        } catch (_) {}
      }
    } catch (_) {}
    if (__taskkitConfig === null) {
      __taskkitConfig = {}
      try { audit.log({ level: 'DEBUG', category: 'config', event: 'config.no_file', message: 'taskkit-config.json not found; using ORCHESTRATOR_V3_DEFAULTS for all keys' }) } catch (_) {}
    }
    return __taskkitConfig
  }
  function cfgV3(key, fallback) {
    try {
      const conf = __loadTaskkitConfigOnce()
      const v3 = conf && conf.orchestratorV3
      if (v3 && typeof v3 === 'object' && Object.prototype.hasOwnProperty.call(v3, key)) {
        let val = v3[key]
        if (key === 'MAX_RESUME' && typeof val === 'number' && val > __V3_MAX_RESUME_HARD_CAP) val = __V3_MAX_RESUME_HARD_CAP
        return val
      }
      if (Object.prototype.hasOwnProperty.call(ORCHESTRATOR_V3_DEFAULTS, key)) {
        const val = ORCHESTRATOR_V3_DEFAULTS[key]
        try { audit.log({ level: 'DEBUG', category: 'config', event: 'config.fallback_defaults', extra: { key: key, used: typeof val === 'string' ? val : JSON.stringify(val) } }) } catch (_) {}
        return val
      }
      try { audit.log({ level: 'DEBUG', category: 'config', event: 'config.fallback_call', extra: { key: key, used: typeof fallback === 'string' ? fallback : JSON.stringify(fallback) } }) } catch (_) {}
      return fallback
    } catch (e) {
      try { audit.log({ level: 'WARN', category: 'config', event: 'config.cfgv3_error', message: String(e && e.message || e), extra: { key: String(key) } }) } catch (_) {}
      return fallback
    }
  }
  // ============================================================
  // 记忆接入体系 Phase 2：三处实时化钩子（additive 独立段，可整体 revert）
  // 设计锚点：《记忆接入体系_设计方案.md》v1.2 §5.2（选项1）/§7/§10/§12；orchestratorV3.memoryIntegration 门控，默认关。
  // 双轨铁律：board 权威写盘成功后才 fire；HTTP 短超时(≤2s)；try/catch 全包裹失败仅 audit；绝不 throw 回上游、不阻塞任务链路。
  // 生效条件：taskkit-config.json 模块级缓存进程内只读一次（__loadTaskkitConfigOnce）→ 改配置需 taskkit 重载/宿主重启，非热切换。
  // ============================================================
  let __memGate = null
  function memoryGate() {
    if (__memGate !== null) return __memGate
    let o = {}
    try {
      const raw = cfgV3('memoryIntegration', null)
      if (raw && typeof raw === 'object') o = raw
    } catch (e) {}
    __memGate = {
      autoDraftOnComplete: o.autoDraftOnComplete === true || o.autoDraftOnComplete === 'true',
      injectOnDispatch: o.injectOnDispatch === true || o.injectOnDispatch === 'true'
    }
    try { audit.log({ level: 'INFO', category: 'memory', event: 'memory.gate_init', message: 'memoryIntegration gate init (Phase 2 hooks)', extra: { autoDraftOnComplete: __memGate.autoDraftOnComplete, injectOnDispatch: __memGate.injectOnDispatch } }) } catch (_) {}
    return __memGate
  }
  const MEMORY_API = 'http://127.0.0.1:3080/memory-system/api'
  // memory HTTP POST（loopback，短超时；任何失败返回 {ok:false}，绝不 throw——memory 尽力而为）
  async function memoryPost(action, payload, timeoutMs) {
    try {
      const res = await globalThis.fetch(MEMORY_API + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(timeoutMs || 2000)
      })
      const txt = await res.text()
      let body = null
      try { body = JSON.parse(txt) } catch (e) { body = null }
      return { ok: res.status === 200 && body && body.ok !== false, body: body, http: res.status }
    } catch (e) {
      try { audit.log({ level: 'WARN', category: 'memory', event: 'memory.http_failed', message: 'memory HTTP ' + action + ' failed (harmless): ' + String(e && e.message || e), extra: { action: action } }) } catch (_) {}
      return { ok: false, body: null, http: 0 }
    }
  }
  // 完成钩子（tsk_complete / receiptScanner 共用）：sync-board {mode:'run', taskIds:[taskId]} 单任务同步（memory-system doSyncBoard
  //   Phase 2 additive taskIds 过滤），只同步刚完成的任务；内容门/存在性幂等由 memory-system 侧判定；绝不 throw。
  async function fireAutoDraft(taskId, source) {
    try {
      if (!memoryGate().autoDraftOnComplete) return { fired: false, reason: 'gate-off' }
      if (!taskId) return { fired: false, reason: 'no-taskId' }
      const r = await memoryPost('sync-board', { mode: 'run', taskIds: [String(taskId)] }, 2000)
      const b = r.body || {}
      audit.log({ level: r.ok ? 'INFO' : 'WARN', category: 'memory', event: 'memory.autoDraft', message: 'autoDraft fired for ' + taskId + ' via ' + source, extra: { taskId: taskId, source: source, ok: r.ok, http: r.http, scanned: b.scanned, created: (b.created || []).length, skipped: (b.skipped || []).length, errors: (b.errors || []).length } })
      return { fired: true, ok: r.ok }
    } catch (e) {
      try { audit.log({ level: 'WARN', category: 'memory', event: 'memory.autoDraft_error', message: 'autoDraft error (harmless): ' + String(e && e.message || e), extra: { taskId: taskId, source: source } }) } catch (_) {}
      return { fired: true, ok: false }
    }
  }
  // 派发注入钩子：memory_load 语义（/load，taskId=派发任务）→ l1.top3 标题+结论 + kb.top3 标题，拼【相关记忆】块；
  // 只读；无命中/不可用返回 ''（整块省略，消息照发）；绝不 throw（dispatchTask 外层 catch 会误判派发失败，故内部全包裹）。
  async function buildMemoryInjectBlock(task) {
    try {
      if (!memoryGate().injectOnDispatch) return ''
      if (!task || !task.id) return ''
      const r = await memoryPost('load', { taskId: task.id, explain: false }, 2000)
      if (!r.ok || !r.body || !r.body.context) return ''
      const ctx = r.body.context
      const l1Hits = ctx.l1 && Array.isArray(ctx.l1.hits) ? ctx.l1.hits : []
      const kbHits = ctx.kb && Array.isArray(ctx.kb.hits) ? ctx.kb.hits : []
      const lines = []
      let l1N = 0
      for (let i = 0; i < l1Hits.length && l1N < 3; i++) {
        const h = l1Hits[i]
        if (!h || !h.task_id) continue
        if (h.task_id === task.id) continue // 任务自身不入注入范围
        const concl = h.conclusion ? String(h.conclusion).slice(0, 80) : ''
        lines.push('- 【L1】' + String(h.title || h.task_id).slice(0, 60) + (concl ? '：' + concl : ''))
        l1N++
      }
      let kbN = 0
      for (let i = 0; i < kbHits.length && kbN < 3; i++) {
        const h = kbHits[i]
        if (!h || !h.id) continue
        lines.push('- 【知识】' + String(h.title || h.id).slice(0, 60) + (h.description ? '：' + String(h.description).slice(0, 60) : ''))
        kbN++
      }
      if (!lines.length) return ''
      audit.log({ level: 'INFO', category: 'memory', event: 'memory.inject', message: 'memory inject block attached to dispatch ' + task.id, extra: { taskId: task.id, l1: l1N, kb: kbN } })
      return '\n\n【相关记忆】（自动关联既往 L1 与知识，供执行参考）\n' + lines.join('\n')
    } catch (e) {
      try { audit.log({ level: 'WARN', category: 'memory', event: 'memory.inject_error', message: 'memory inject skipped (harmless): ' + String(e && e.message || e), extra: { taskId: task && task.id } }) } catch (_) {}
      return ''
    }
  }
  // 3) 39 审计事件占位注册表（严格按 §S8 类别×事件名×级别；仅占位 + 暴露，不改变控制流）
  const ORCHESTRATOR_V3_AUDIT_REGISTRY = [
    { category: 'lifecycle',       event: 'scheduler.swap',                 level: 'INFO' },
    { category: 'lifecycle',       event: 'orchestrator.scan_start',        level: 'INFO' },
    { category: 'lifecycle',       event: 'orchestrator.scan_end',          level: 'INFO' },
    { category: 'scan',            event: 'scan.filtered_out',              level: 'DEBUG' },
    { category: 'scan',            event: 'scan.to_probe',                  level: 'DEBUG' },
    { category: 'probe',           event: 'probe.start',                    level: 'DEBUG' },
    { category: 'probe',           event: 'probe.mech_a',                   level: 'DEBUG' },
    { category: 'probe',           event: 'probe.mech_b',                   level: 'DEBUG' },
    { category: 'probe',           event: 'probe.result',                   level: 'INFO' },
    { category: 'wake',            event: 'wake.entry',                     level: 'DEBUG' },
    { category: 'wake',            event: 'wake.pre_resume_probe',          level: 'DEBUG' },
    { category: 'wake',            event: 'wake.failed',                    level: 'WARN' },
    { category: 'wake',            event: 'wake.resume_error',              level: 'WARN' },
    { category: 'wake',            event: 'wake.resume_stack',              level: 'WARN' },
    { category: 'wake',            event: 'wake.provider_fallback',         level: 'WARN' },
    { category: 'wake',            event: 'wake.dispatch_target',           level: 'INFO' },
    { category: 'wake',            event: 'wake.l3_create_start',           level: 'INFO' },
    { category: 'wake',            event: 'wake.l3_create_ok',              level: 'INFO' },
    { category: 'wake',            event: 'wake.l3_create_failed',          level: 'ERROR' },
    { category: 'wake',            event: 'wake.all_levels_failed',         level: 'ERROR' },
    { category: 'wake',            event: 'wake.queued_due_boot',           level: 'INFO' },
    { category: 'wake',            event: 'wake.dequeued_exec',             level: 'INFO' },
    { category: 'wake',            event: 'wake.backoff_timeout_l3',        level: 'WARN' },
    { category: 'wake',            event: 'wake.session_precheck_bad',      level: 'WARN' },
    { category: 'resume',          event: 'task.redispatched',              level: 'INFO' },
    { category: 'resume',          event: 'task.progress_snapshot',         level: 'DEBUG' },
    { category: 'resume',          event: 'task.redispatched_halted',       level: 'WARN' },
    { category: 'resume',          event: 'task.redispatched_abort',        level: 'WARN' },
    { category: 'id',              event: 'id.generate',                    level: 'DEBUG' },
    { category: 'id',              event: 'id.collision_retry',             level: 'WARN' },
    { category: 'id',              event: 'id.collision_detected',          level: 'ERROR' },
    { category: 'id',              event: 'id.collision_repaired',          level: 'WARN' },
    { category: 'id',              event: 'id.fallback_exhausted',          level: 'ERROR' },
    { category: 'diag',            event: 'diag.agents_probe',              level: 'INFO' },
    { category: 'state_transition',event: 'task.resumed',                   level: 'INFO' },
    { category: 'state_transition',event: 'task.halted_auto',               level: 'WARN' },
    { category: 'error',           event: 'error.caught',                   level: 'ERROR' },
    // config (骨架自举事件 4：保持 §S8 ERROR 桥接完整)
    { category: 'config',          event: 'config.loaded',                  level: 'INFO' },
    { category: 'config',          event: 'config.no_file',                 level: 'DEBUG' },
    { category: 'config',          event: 'config.fallback_defaults',       level: 'DEBUG' },
    { category: 'config',          event: 'config.cfgv3_error',             level: 'WARN' },
  ]
  try {
    audit.V3_REGISTRY = ORCHESTRATOR_V3_AUDIT_REGISTRY
    audit.log({ level: 'DEBUG', category: 'lifecycle', event: 'orchestrator.v3_skeleton_ready', message: 'cfgV3 + 39-event registry skeleton injected (no control flow touched)', extra: { registrySize: ORCHESTRATOR_V3_AUDIT_REGISTRY.length, defaultsKeys: Object.keys(ORCHESTRATOR_V3_DEFAULTS).length } })
  } catch (_) {}
  // ============================================================
  // 基础骨架注入结束；以下保持原 apply() 控制流不变
  // ============================================================

  audit.log({
    level: 'INFO',
    category: 'lifecycle',
    event: 'plugin.apply',
    message: 'taskkit apply() started',
    extra: { injects: inject }
  })
  // O5 迁移（W2）：fs 面统一经 adapterFs —— 原 `ctx.get('fs')` 绑定删除（全部读写改走下方适配层）；
  // 写策略由 adapter 部署 config 承接（默认 {mode:'danger-full-access'}，与迁移前本地 writePolicy 同值）。
  const _adapterFs0 = ctx.get('adapterFs')
  // ⚠️ builtin 启动时序竞态规避（本插件是唯一 builtin 目标）：taskkit 由 coexist/takeover 路径挂载，其 apply 与 loader 条目
  //    （`@local/dsh-adapter`）的创建**无先后保证**（adapter 自身注释亦记录「loader 创建条目是并发的」）。故 adapterFs 以
  //    **调用期惰性解析的门面**持有：门面方法每次调用都重新解析服务（apply 期尚未 provide 也能在首次读写时拿到），零启动竞态。
  const afs = function () { return _adapterFs0 || ctx.get('adapterFs') }
  const adapterFs = {
    resolve: function (a, b) { return afs().resolve(a, b) },
    resolveRef: function (a, b) { return afs().resolveRef(a, b) },
    readJson: function (a, b, c) { return afs().readJson(a, b, c) },
    readText: function (a, b) { return afs().readText(a, b) },
    writeText: function (a, b, c) { return afs().writeText(a, b, c) },
    stat: function (a, b) { return afs().stat(a, b) },
    listDir: function (a, b) { return afs().listDir(a, b) }
  }
  if (!afs()) {
    try { audit.log({ level: 'WARN', category: 'config', event: 'adapter.fs_missing', message: 'adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，taskkit 将无法读写写作训练数据（请确认 profile 中 @local/dsh-adapter 已加载）', extra: {} }) } catch (_) {}
  }
  // G11④（t111）：HTTP 面统一经 adapterHttp —— 与上方 adapterFs 同款「调用期惰性解析门面」（同样规避 builtin 启动时序竞态）。
  //   仅暴露本插件实际用到的 post（loopback 业务面 3080；apiBase 由部署 env DSH_WEB_URL 决定，缺省回退 127.0.0.1:3080）。
  const _adapterHttp0 = ctx.get('adapterHttp')
  const ahp = function () { return _adapterHttp0 || ctx.get('adapterHttp') }
  const adapterHttp = {
    post: function (a, b, c) { return ahp().post(a, b, c) }
  }
  if (!ahp()) {
    try { audit.log({ level: 'WARN', category: 'config', event: 'adapter.http_missing', message: 'adapterHttp 不可用：kb_sync_docs 的 KB 导入 HTTP 面已按 G11④ 迁移到 adapterHttp（失败语义同迁移前：全部计 failed），请确认 profile 中 @local/dsh-adapter 已加载', extra: {} }) } catch (_) {}
  }
  const sp = ctx.get('sandboxPolicy')
  const sessionQuery = ctx.get('sessionQuery')
  // 路径口径：根内相对引用一律经 resolveRef（相对 → 登记根；绝对 → 直解），对外/诊断处取 displayPath 绝对形态
  function absPath(t) {
    const v = (t && t.displayPath !== undefined) ? t.displayPath : t
    return String(v === undefined || v === null ? '' : v).replace(/\\/g, '/')
  }
  async function absOfRef(ref, root) { return absPath(await adapterFs.resolveRef(ref, root ? { root: root } : undefined)) }
  // 数据根优先级：config.dataRoot（显式配置，最优先）> workspaceRegistry.list()[0].path > sandboxPolicy.workspaceRoot
  const wr = ctx.get('workspaceRegistry')
  let cwd = ''
  if (config && typeof config.dataRoot === 'string' && config.dataRoot) cwd = config.dataRoot
  if (!cwd && wr) { try { const l = wr.list(); if (l && l.length && l[0].path) cwd = l[0].path } catch (e) {} }
  if (!cwd && sp) cwd = sp.workspaceRoot || undefined
  // S11: 同步 DATA_ROOT 到运行时 cwd（避免 D 盘硬编码写入路径）
  try { DATA_ROOT = computeDataRoot(cwd) } catch (_) {}
  audit.log({ level: 'INFO', category: 'config', event: 'config.data_root_resolved', message: 'DATA_ROOT resolved via computeDataRoot(cwd)', extra: { cwd: String(cwd || ''), dataRoot: DATA_ROOT } })

  // 诊断：fs 缺失时仍注册工具（工具 execute 时再判空），避免 apply 静默返回导致工具全无
  async function readBoard() {
    try {
      if (!afs()) return { board: defaultBoard(), missing: true }
      // O5 迁移：唯一读板入口经 adapterFs.readJson（根名 + 根内相对引用；DSH_TASKKIT_BOARD 覆盖为绝对路径时直解）
      // fallback 语义逐条对齐：仅 FS_NOT_FOUND / FS_NOT_TEXT / JSON 解析失败三类才回 fallback（其余错误仍抛 → 下方 catch）
      // 且 fallback 用**唯一哨兵对象**（绝不用「像看板的默认值」当 fallback，避免把 fallback 命中当期望值）
      const MISSING_SENTINEL = readBoard._sentinel || (readBoard._sentinel = { __taskkit_board_missing__: true })
      const t = await absOfRef(BOARD_REL, ROOT_TRAIN)
      const parsed = await adapterFs.readJson(t, null, { fallback: MISSING_SENTINEL })
      if (parsed === MISSING_SENTINEL) return { board: defaultBoard(), missing: true }
      return { board: normalizeBoard(parsed), missing: false }
    } catch (e) { return { board: defaultBoard(), missing: true } }
  }
  // 通用降级写入：dsh 写通道失败（常见 EPERM mkdir tmpdir）时，用 child_process.execSync 调外部 node 原生 fs.writeFileSync 绕过沙箱
  // （G4 裁定：该绕过能力不进 adapter；本函数只把**主写入路径**迁到 adapterFs，降级路径保持原样）
  async function writeTextSafe(filePath, content, _relForLog) {
    try {
      await adapterFs.writeText(filePath, undefined, content)
    } catch (eWrite) {
      audit.log({ level: 'WARN', category: 'error', event: 'writeTextSafe.fallback', message: 'dsh fs.writeText failed, falling back to node fs.writeFileSync: ' + String(eWrite && eWrite.message || eWrite), extra: { code: String(eWrite && eWrite.code || ''), rel: filePath } })
      const { execSync } = await import('node:child_process')
      const nativePath = typeof filePath === 'string' ? filePath : _relForLog
      const script = 'require("fs").writeFileSync(' + JSON.stringify(nativePath) + ',' + JSON.stringify(content) + ',"utf8")'
      execSync('node --input-type=commonjs -', { input: script, cwd: DATA_ROOT.slice(0, -'/写作训练'.length) || FALLBACK_WORKSPACE_ROOT, timeout: 10000, encoding: 'utf8' })
      audit.log({ level: 'INFO', category: 'error', event: 'writeTextSafe.fallback_ok', message: 'child_process.execSync writeFileSync succeeded', extra: { rel: filePath, bytes: content.length } })
    }
  }
  // SSE 订阅者（实时同步，借鉴 task-board：revision 变更推送，浏览器异步视图）
  const boardSubscribers = new Set()
  function broadcastBoard() {
    const snapshot = { revision: 0, ts: new Date().toISOString() }
    boardSubscribers.forEach(function (fn) { try { fn(snapshot) } catch (e) {} })
  }

  async function writeBoard(board) {
    try {
      board = await autoCompactIfNeeded(board)
      // revision 递增（Host 权威账本版本号，借鉴 task-board）：每次写盘 +1
      board.revision = (typeof board.revision === 'number' ? board.revision : 0) + 1
      const filePath = await absOfRef(BOARD_REL, ROOT_TRAIN)
      const content = JSON.stringify(board, null, 2)
      await writeTextSafe(filePath, content, BOARD_REL)
      // 写盘成功后广播 revision 变更（SSE）
      broadcastBoard()
      return true
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'error', event: 'writeBoard.diag', message: 'writeBoard error: ' + String(e && e.message || e), extra: { code: String(e && e.code || ''), cwd: cwd, boardRel: BOARD_REL } })
      throw e
    }
  }
  // ======================== 启动唤醒配置（写作训练/唤醒配置.json）====================
  // 2026-08-27 需求：启动自动唤醒会话 + 唤醒管理面板。清单持久化到 写作训练/唤醒配置.json；
  // 文件缺失/损坏 → 内置默认三会话（任务中心/插件开发工坊/创作教练）降级，不丢原任务中心保障。
  function normalizeWakeConfig(raw) {
    const now = new Date().toISOString()
    const src = (raw && Array.isArray(raw.entries)) ? raw.entries : WAKE_DEFAULT_ENTRIES
    const seen = {}
    const entries = []
    src.forEach(function (e) {
      if (!e || typeof e !== 'object') return
      const id = String(e.id || '').trim()
      if (!/^session-[\w-]+$/.test(id)) return // 过滤非法 id
      if (seen[id]) return // 按 id 去重
      seen[id] = 1
      entries.push({
        id: id,
        title: String(e.title || id),
        enabled: e.enabled !== false
      })
    })
    // 空清单（含全被过滤）→ 回退默认三会话
    if (entries.length === 0) {
      WAKE_DEFAULT_ENTRIES.forEach(function (e) { entries.push({ id: e.id, title: e.title, enabled: true }) })
    }
    return {
      version: 1,
      '说明': '启动自动唤醒清单：DSH 启动后遍历 entries 唤醒；agents.get 命中(live)跳过；enabled=false 跳过',
      defaults: Object.assign({}, WAKE_DEFAULT_DEFAULTS, (raw && raw.defaults && typeof raw.defaults === 'object') ? raw.defaults : {}),
      message: (raw && typeof raw.message === 'string' && raw.message !== '') ? raw.message : WAKE_DEFAULT_MESSAGE,
      sendMessage: !raw || raw.sendMessage !== false,
      entries: entries,
      updatedAt: (raw && typeof raw.updatedAt === 'string') ? raw.updatedAt : now
    }
  }
  async function readWakeConfig() {
    try {
      if (!afs()) return { cfg: normalizeWakeConfig(null), missing: true }
      const target = await absOfRef(WAKE_CONF_REL, ROOT_TRAIN)
      const info = await adapterFs.stat(target)
      if (!info) {
        audit.log({ level: 'WARN', category: 'wake', event: 'wake.config_fallback', message: '唤醒配置不存在，使用内置默认三会话清单', extra: { rel: WAKE_CONF_REL } })
        return { cfg: normalizeWakeConfig(null), missing: true }
      }
      return { cfg: normalizeWakeConfig(JSON.parse(await adapterFs.readText(target))), missing: false }
    } catch (e) {
      audit.log({ level: 'WARN', category: 'wake', event: 'wake.config_fallback', message: '唤醒配置读取失败，使用内置默认三会话清单: ' + String(e && e.message || e), extra: { rel: WAKE_CONF_REL } })
      return { cfg: normalizeWakeConfig(null), missing: true }
    }
  }
  async function writeWakeConfig(cfg) {
    try {
      if (!afs()) return false
      const filePath = await absOfRef(WAKE_CONF_REL, ROOT_TRAIN)
      await writeTextSafe(filePath, JSON.stringify(cfg, null, 2), WAKE_CONF_REL)
      return true
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'wake', event: 'wake.config_write_error', message: '唤醒配置写入失败: ' + String(e && e.message || e), extra: { rel: WAKE_CONF_REL } })
      return false
    }
  }
  // 自动压缩：看板任务数超过阈值时，在写入前先归档已完成/已取消/中止任务，防止膨胀阻塞写入
  async function autoCompactIfNeeded(board) {
    if (!board || !Array.isArray(board.tasks) || board.tasks.length < COMPACT_THRESHOLD) return board
    try {
      audit.log({ level: 'WARN', category: 'compact', event: 'compact.auto_trigger', message: 'auto-compact triggered: ' + board.tasks.length + ' tasks >= threshold ' + COMPACT_THRESHOLD, extra: { taskCount: board.tasks.length, threshold: COMPACT_THRESHOLD } })
      const now = new Date()
      const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
      const archiveFile = DATA_ROOT + '/任务看板_归档_' + monthKey + '.json'
      const keepTasks = []
      const doneToArchive = []
      let deletedCount = 0
      for (let i = 0; i < board.tasks.length; i++) {
        const t = board.tasks[i]
        if (t.status === '已完成') {
          doneToArchive.push({ id: t.id, title: t.title, status: t.status, project: t.project || '', owner: t.owner || '', finishedAt: t.finishedAt || t.updatedAt || now.toISOString(), note: t.note || '' })
        } else if (t.status === '已取消' || t.status === '中止') {
          deletedCount++
        } else {
          keepTasks.push(t)
        }
      }
      if (doneToArchive.length > 0) {
        let existing = { version: 1, month: monthKey, tasks: [] }
        try { const target = await absOfRef(archiveFile, ROOT_TRAIN); const info = await adapterFs.stat(target); if (info) { existing = JSON.parse(await adapterFs.readText(target)) } } catch (_) {}
        existing.tasks = (existing.tasks || []).concat(doneToArchive)
        try { await writeTextSafe(await absOfRef(archiveFile, ROOT_TRAIN), JSON.stringify(existing, null, 2), archiveFile) } catch (_) {}
      }
      board.tasks = keepTasks
      audit.log({ level: 'INFO', category: 'compact', event: 'compact.auto_done', message: 'auto-compact: archived ' + doneToArchive.length + ' done, deleted ' + deletedCount + ' cancelled/stopped, kept ' + keepTasks.length + ' active', extra: { archived: doneToArchive.length, deleted: deletedCount, kept: keepTasks.length } })
    } catch (e) { audit.log({ level: 'ERROR', category: 'compact', event: 'compact.auto_error', message: 'auto-compact error: ' + String(e && e.message || e) }) }
    return board
  }
  async function readPool() {
    try {
      const target = await absOfRef(INSP_POOL_REL, ROOT_TRAIN)
      const info = await adapterFs.stat(target)
      if (!info) return { pool: defaultPool(), missing: true }
      return { pool: normalizePool(JSON.parse(await adapterFs.readText(target))), missing: false }
    } catch (e) { return { pool: defaultPool(), missing: true } }
  }
  async function writePool(pool) { await writeTextSafe(await absOfRef(INSP_POOL_REL, ROOT_TRAIN), JSON.stringify(pool, null, 2), INSP_POOL_REL); return true }
  async function readInspLib() {
    try {
      if (!afs()) return { lib: defaultInspLib(), missing: true }
      const target = await absOfRef(INSP_LIB_REL, ROOT_TRAIN)
      const info = await adapterFs.stat(target)
      if (!info) return { lib: defaultInspLib(), missing: true }
      return { lib: normalizeInspLib(JSON.parse(await adapterFs.readText(target))), missing: false }
    } catch (e) { return { lib: defaultInspLib(), missing: true } }
  }
  async function writeInspLib(lib) { await writeTextSafe(await absOfRef(INSP_LIB_REL, ROOT_TRAIN), JSON.stringify(lib, null, 2), INSP_LIB_REL); return true }

  // ====== U-44 / W-A·A1（2026-09-29）：灵感退役（软删）的落点与清单 ======
  // 退役 ＝ 把条目从 灵感库.json **摘出** → 逐字节存到 灵感库/灵感退役/<id>.json → 清单追加/更新一行。
  // 全程**不销毁数据**（对齐 memory doRetire 的 original_data:'intact' 语义）。
  // 🔴 node:fs 只认真实绝对路径 ⇒ 一律先用 absOfRef() 取绝对口径（先例：memory-system:1291 注明"对齐 taskkit 直读先例"）。
  function inspRetireAbs(rel) { return absOfRef(rel, ROOT_TRAIN) }
  async function readRetireManifest() {
    try {
      const t = await inspRetireAbs(INSP_RETIRE_MANIFEST_REL)
      const info = await adapterFs.stat(t)
      if (!info) return emptyManifest()
      return normalizeManifest(JSON.parse(await adapterFs.readText(t)))
    } catch (e) { return emptyManifest() }
  }
  async function writeRetireManifest(mf) {
    const next = { version: mf.version, rows: mf.rows, updatedAt: new Date().toISOString() }
    await writeTextSafe(await inspRetireAbs(INSP_RETIRE_MANIFEST_REL), JSON.stringify(next, null, 2), INSP_RETIRE_MANIFEST_REL)
    return next
  }
  async function readRetiredEntry(id) {
    try {
      const p = await inspRetireAbs(INSP_RETIRE_DIR_REL + '/' + retireFileName(id))
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch (e) { return null }
  }
  async function writeRetiredEntry(id, entry) {
    const dir = await inspRetireAbs(INSP_RETIRE_DIR_REL)
    const p = await inspRetireAbs(INSP_RETIRE_DIR_REL + '/' + retireFileName(id))
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify(entry, null, 2), 'utf8')
    return p
  }
  async function removeRetiredEntry(id) {
    const p = await inspRetireAbs(INSP_RETIRE_DIR_REL + '/' + retireFileName(id))
    rmSync(p, { force: true })
    return true
  }
  // 列退役目录（adapterFs.listDir 是**单层**）→ 逐个读回：出口是**结构化条目**而非文件名
  async function listRetiredEntries() {
    const out = []
    let entries = []
    try { entries = await adapterFs.listDir(ROOT_TRAIN, INSP_RETIRE_DIR_REL) } catch (e) { return out }
    for (const ent of (Array.isArray(entries) ? entries : [])) {
      const name = String((ent && ent.name) || '')
      if (!name || name.charAt(0) === '.' || !/\.json$/i.test(name)) continue
      const one = await readRetiredEntry(name.replace(/\.json$/i, ''))
      if (one) out.push(one)
    }
    return out
  }
  // 退役条目按与活跃条目**同样的条件**过滤（供 includeRetired 合并用；同时认 q / query 两种关键词参数）
  async function inspRetiredFiltered(args) {
    let extra = await listRetiredEntries()
    if (args && args.status) extra = extra.filter(function (e) { return e.status === String(args.status).trim() })
    if (args && args.fixedOnly === 'true') extra = extra.filter(function (e) { return e.fixed })
    if (args && args.tags) { const ts = String(args.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); if (ts.length) extra = extra.filter(function (e) { return ts.every(function (t) { return e.tags.indexOf(t) >= 0 }) }) }
    // U-49（2026-09-30）：与活跃集同口径 —— 否则 includeRetired:true + tagsPrefix 会把无关退役件一起带出来
    if (args && args.tagsPrefix) extra = filterTagsPrefix(extra, args.tagsPrefix)
    const kw = String((args && (args.q || args.query)) || '').toLowerCase()
    if (kw) extra = extra.filter(function (e) { return (e.title + ' ' + e.oneLiner + ' ' + e.content + ' ' + (e.tags || []).join(' ')).toLowerCase().indexOf(kw) >= 0 })
    return extra
  }
  // A3（2026-09-29）：分页 + 体积。`count` 报**筛后总数**（非返回数）⇒ 调用方可从 count≠returned 察觉被截断。
  function inspListPage(list, libTotal, args, label) {
    const matched = list.length
    const limit = resolveListLimit(args && args.limit)
    const truncated = matched > limit
    let out = list.slice(0, limit)
    if (!(args && args.includeContent === 'true')) out = stripContent(out)
    return {
      ok: true, count: matched, returned: out.length, truncated: truncated, limit: limit,
      entries: out,
      summary: (label || '灵感库') + ' ' + matched + ' 条' + (truncated ? '（本次返回前 ' + out.length + ' 条，可调 limit 或收窄条件）' : '') + '（库内 ' + libTotal + ' 条）'
    }
  }
  // ====== U-44（W-A·A1）：退役 / 复原 / 退役清单的**单一实现** ======
  // 工具侧与 HTTP 侧**同调本函数**（返回 `{status, body}`，结构对齐 memory-system 的 doRetire/doRestore）
  // ⇒ 两路径行为天然一致，杜绝 A2 那类"两处漂移"。
  async function doInspRetire(args) {
    const a = args || {}
    const idr = normalizeInspIdArg(a.id)
    if (!idr.ok) return { status: 400, body: { ok: false, error: idr.error, summary: '失败：' + idr.error } }
    const id = idr.id
    // 幂等闸：已退役 ⇒ 不重复处理、不报错（判定序对齐 memory doRestore 的"先查已处理"）
    const already = await readRetiredEntry(id)
    if (already) return { status: 200, body: { ok: true, retired: false, reason: 'already-retired', id: id, summary: '「' + already.title + '」此前已退役（' + id + '），未重复处理' } }
    const { lib } = await readInspLib()
    const out = extractEntry(lib.entries, id)
    if (!out.found) return { status: 200, body: { ok: true, retired: false, reason: 'not-found', id: id, summary: '灵感库中无此条目（' + id + '）：可能已退役或 id 有误，**未做任何变更**' } }
    // 写入顺序：① 退役文件（逐字节）→ ② 活跃库写回 → ③ 清单。任一步失败都不丢数据
    let path = ''
    try { path = await writeRetiredEntry(id, out.entry) } catch (e) { return { status: 500, body: { ok: false, error: '退役文件写入失败：' + String(e && e.message || e), summary: '失败：退役文件写入失败（灵感库未改动）' } } }
    lib.entries = out.rest
    try { await writeInspLib(lib) } catch (e) { return { status: 500, body: { ok: false, error: '灵感库写回失败：' + String(e && e.message || e), summary: '失败：灵感库写回失败（退役文件已存：' + path + '，可用 insp_restore 复原）' } } }
    const mf = await readRetireManifest()
    const row = buildRetireRow(out.entry, { at: new Date().toISOString(), reason: String(a.reason || '') })
    const mf2 = await writeRetireManifest({ version: mf.version, rows: upsertRetireRow(mf.rows, row) })
    audit.log({ level: 'INFO', category: 'insp', event: 'insp.retire', message: 'insp retired: ' + out.entry.title, extra: { id: id, path: path } })
    return {
      status: 200,
      body: {
        ok: true, retired: true, id: id, path: path, entries: lib.entries.length,
        retiredCount: mf2.rows.filter(function (r) { return r.restored !== true }).length,
        summary: '已退役「' + out.entry.title + '」（' + id + '）→ ' + path + '（可用 insp_restore 复原）'
      }
    }
  }
  async function doInspRestore(args) {
    const a = args || {}
    const idr = normalizeInspIdArg(a.id)
    if (!idr.ok) return { status: 400, body: { ok: false, error: idr.error, summary: '失败：' + idr.error } }
    const id = idr.id
    // ① 幂等闸**必须最先**（对齐 memory doRestore:1367 注释：成功复原会复位标记，晚判将落入 ② 的"库中已有 ⇒ 409"）
    const mf0 = await readRetireManifest()
    const row0 = findRetireRow(mf0.rows, id)
    if (row0 && row0.restored === true) return { status: 200, body: { ok: true, restored: false, reason: 'already-restored', id: id, summary: '「' + String(row0.title || id) + '」此前已复原（' + id + '），未重复处理' } }
    const { lib } = await readInspLib()
    // ② 防覆盖（对齐 memory doRestore:1375）
    const dup = lib.entries.some(function (e) { return e && String(e.id || '').trim() === id })
    if (dup) return { status: 409, body: { ok: false, code: 'conflict', error: '库中已存在同 id 条目：' + id + '（禁止覆盖）', summary: '失败：库中已存在同 id 条目（' + id + '），禁止覆盖' } }
    // ③ 源缺失（对齐 memory doRestore:1376）
    const entry = await readRetiredEntry(id)
    if (!entry) return { status: 404, body: { ok: false, code: 'original-missing', error: '退役目录无此条目：' + id + '（可能从未退役，或 id 有误）', summary: '失败：退役目录无此条目（' + id + '）' } }
    // ⑤ 执行回迁：先写回活跃库，成功后才删退役文件（不留半程，失败可重试）
    const ins = insertEntry(lib.entries, entry)
    if (!ins.ok) return { status: 409, body: { ok: false, code: 'bad-entry', error: ins.error, summary: '失败：' + ins.error } }
    lib.entries = ins.entries
    try { await writeInspLib(lib) } catch (e) { return { status: 500, body: { ok: false, error: '灵感库写回失败：' + String(e && e.message || e), summary: '失败：灵感库写回失败（退役文件未删，可重试）' } } }
    try { await removeRetiredEntry(id) } catch (e) { /* 删不掉不致命：条目已回库，下次退役按 id upsert 整行替换 */ }
    const mf = await readRetireManifest()
    const rows2 = markRetireRowRestored(mf.rows, id, new Date().toISOString())
    await writeRetireManifest({ version: mf.version, rows: rows2 })
    audit.log({ level: 'INFO', category: 'insp', event: 'insp.restore', message: 'insp restored: ' + entry.title, extra: { id: id } })
    return {
      status: 200,
      body: {
        ok: true, restored: true, id: id, entries: lib.entries.length,
        retiredCount: rows2.filter(function (r) { return r.restored !== true }).length,
        summary: '已复原「' + entry.title + '」（' + id + '）到灵感库'
      }
    }
  }
  async function doInspRetiredList(args) {
    const a = args || {}
    const mf = await readRetireManifest()
    const all = mf.rows.slice()
    const restored = all.filter(function (r) { return r && r.restored === true }).length
    const active = all.length - restored
    let rows = all
    if (a.includeRestored === 'false' || a.includeRestored === false) rows = all.filter(function (r) { return !(r && r.restored === true) })
    // 排序口径对齐 memArchiveListFn：未复原在前、按退役时间倒序
    rows = rows.slice().sort(function (x, y) {
      return ((x && x.restored ? 1 : 0) - (y && y.restored ? 1 : 0)) ||
        String((y && y.退役时间) || '').localeCompare(String((x && x.退役时间) || ''))
    })
    return { status: 200, body: { ok: true, ts: Date.now(), count: rows.length, active: active, restored: restored, entries: rows, summary: '退役清单 ' + all.length + ' 行（当前退役 ' + active + ' · 已复原 ' + restored + '）' } }
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
  async function readApprovals() {
    try {
      const target = await absOfRef(APPROVAL_LOG_REL, ROOT_TRAIN)
      const info = await adapterFs.stat(target)
      if (!info) return { log: defaultApprovals(), missing: true }
      return { log: normalizeApprovals(JSON.parse(await adapterFs.readText(target))), missing: false }
    } catch (e) { return { log: defaultApprovals(), missing: true } }
  }
  async function writeApprovals(log) { await writeTextSafe(await absOfRef(APPROVAL_LOG_REL, ROOT_TRAIN), JSON.stringify(log, null, 2), APPROVAL_LOG_REL); return true }
  async function readTextFile(rel, fallback) {
    try { const t = await absOfRef(rel, ROOT_TRAIN); return await adapterFs.readText(t) } catch (e) { return fallback }
  }
  async function writeTextFile(rel, text) { await writeTextSafe(await absOfRef(rel, ROOT_TRAIN), text, rel); return true }

    // ======================== 写作成果数据读取辅助 ========================
    async function readJsonFile(rel, fallback) {
      try { const t = await absOfRef(rel, ROOT_TRAIN); return await adapterFs.readJson(t, null, { fallback: fallback }) } catch (e) { return fallback }
    }
    function countWords(text) {
      const s = String(text || '')
      const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
      const latin = (s.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length
      return cjk + latin
    }
    function dateFromDraftName(name) {
      const m = String(name || '').match(/(\d{4})-(\d{2})-(\d{2})/)
      return m ? m[1] + '-' + m[2] + '-' + m[3] : ''
    }
    function titleFromDraftName(name) {
      const base = String(name || '').replace(/\.md$/i, '')
      return base.replace(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_?)/, '').replace(/[_\-]+/g, ' ').trim() || base
    }
    // 创作资源库 v1：草稿关联数据源 —— 「真实列举 写作训练/草稿/ + 写作记录 lastFile」两源
  // T3 / U-36（2026-09-27）：草稿/ 已被归档改成**按作品分目录**（README.md · _版本前照片/ · _阶段习作/ · 心渊纪元/ …），
  //   而 adapterFs.listDir 是**单层**的 ⇒ 原「单层列举 + KNOWN_DRAFT_NAMES 静态清单」在归档后只能得到 README.md
  //   （清单里的文件也都已移入子目录）⇒ 改为**递归列举**并删除硬编码清单。
  // 返回**相对 草稿/ 的路径**（顶层文件仍是裸文件名 ⇒ 与 写作记录.json.lastFile、relations 的键一致）；只收 .md 文件。
  const DRAFT_LIST_MAX_DEPTH = 4
  const DRAFT_LIST_SKIP_DIRS = ['node_modules', '_backup']
  async function listDraftPathsDeep(root, rel, prefix, depth) {
    const out = []
    if (!afs()) return out
    let entries = []
    try { entries = await adapterFs.listDir(root, rel) } catch (e) { return out }
    for (const entry of (Array.isArray(entries) ? entries : [])) {
      const name = String((entry && entry.name) || '')
      if (!name || name.charAt(0) === '.' || DRAFT_LIST_SKIP_DIRS.indexOf(name) >= 0) continue
      const childRel = rel + '/' + name
      const childPrefix = prefix ? (prefix + '/' + name) : name
      if (entry.type === 'directory') {
        if (depth < DRAFT_LIST_MAX_DEPTH) {
          const sub = await listDraftPathsDeep(root, childRel, childPrefix, depth + 1)
          for (let i = 0; i < sub.length; i++) out.push(sub[i])
        }
      } else if (entry.type === 'file' && /\.md$/i.test(name)) {
        out.push(childPrefix)
      }
    }
    return out
  }
  async function collectDrafts() {
    const out = []
    const seen = {}
    const push = function (name) { if (name && !seen[name]) { seen[name] = 1; out.push(name) } }
    const listed = await listDraftPathsDeep(ROOT_TRAIN, DRAFT_DIR_REL, '', 0)
    listed.forEach(push)
    // 兜底：写作记录.json.lastFile 记的是某个草稿名（顶层 ⇒ 裸文件名）；幂等去重
    try {
      const rec = await readJsonFile(WRITING_RECORD_REL, { lastFile: '' })
      if (rec && rec.lastFile) push(rec.lastFile)
    } catch (e) {}
    return out
  }

  async function listDraftFiles() {
      if (!afs()) return []
      try {
        const dir = await absOfRef(DRAFT_DIR_REL, ROOT_TRAIN)
        const info = await adapterFs.stat(dir)
        if (!info) return []
        // T3 / U-36（2026-09-27）：草稿/ 已按作品分层 ⇒ 单层 listDir 只能看到顶层 README.md。
        // 改为递归列举（返回相对 草稿/ 的路径；顶层仍是裸文件名）⇒ 删除原 KNOWN_DRAFT_NAMES 回退清单（其文件已移位）。
        const entries = (await listDraftPathsDeep(ROOT_TRAIN, DRAFT_DIR_REL, '', 0)).map(function (n) { return { name: n, type: 'file' } })
        const out = []
        for (const entry of entries) {
          const name = (typeof entry === 'string') ? entry : (entry && entry.name)
          if (!name || !/\.md$/i.test(name)) continue
          try {
            const target = (entry && entry.target) ? entry.target : await absOfRef(DRAFT_DIR_REL + '/' + name, ROOT_TRAIN)
            const text = await adapterFs.readText(target)
            out.push({
              name: name,
              title: titleFromDraftName(name),
              date: dateFromDraftName(name),
              words: countWords(text),
              preview: String(text).replace(/\s+/g, ' ').trim().slice(0, 140)
            })
          } catch (e) {}
        }
        out.sort(function (a, b) { return String(b.name).localeCompare(String(a.name)) })
        return out
      } catch (e) { return [] }
    }
    async function readDraftFile(name) {
      // T3 / U-36（2026-09-27）：草稿名现在可能是**相对 草稿/ 的路径**（如 `心渊纪元/xxx.md`）⇒ 原 `replace(/[\\/]/g,'')`
      // 会把子目录名黏进来、导致分层后的稿**打不开**。改为：反斜杠归一 + 去前导 / + 拒绝空段/`.`/`..`（防越界）。
      const safe = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '')
      if (!safe) return null
      const segs = safe.split('/')
      for (let i = 0; i < segs.length; i++) {
        if (segs[i] === '' || segs[i] === '.' || segs[i] === '..') return null
      }
      try {
        const target = await absOfRef(DRAFT_DIR_REL + '/' + safe, ROOT_TRAIN)
        const info = await adapterFs.stat(target)
        if (!info) return null
        return { name: safe, text: await adapterFs.readText(target) }
      } catch (e) { return null }
    }
      async function readRelations() {
        const fallback = { version: 1, relations: {} }
        const raw = await readJsonFile(WRITING_RELATIONS_REL, fallback)
        if (!raw || typeof raw !== 'object' || !raw.relations || typeof raw.relations !== 'object') return fallback
        return raw
      }
      async function writeRelations(data) {
        const target = await absOfRef(WRITING_RELATIONS_REL, ROOT_TRAIN)
        await writeTextSafe(target, JSON.stringify(data, null, 2), WRITING_RELATIONS_REL)
        return true
      }

    function isoWeekKey(iso) {
      const d = new Date(iso + 'T00:00:00')
      if (isNaN(d.getTime())) return iso
      const day = (d.getDay() + 6) % 7
      d.setDate(d.getDate() - day + 3)
      const firstThursday = new Date(d.getFullYear(), 0, 4)
      firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3)
      const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000))
      return d.getFullYear() + '-W' + String(week).padStart(2, '0')
    }


  // 修复：任务 id 生成改用全局递增计数器（消除同链/同秒随机后缀碰撞，碰撞概率 ~21%）
  let __taskIdSeq = 0
  function nextTaskId() {
    return 'task-' + String(Date.now()).slice(-6) + '-' + String(1000 + (__taskIdSeq++))
  }
  const titleCache = {} // sessionId -> { title, ts }，30s TTL：避免调度器每 tick 强制刷新所有会话标题（dsh session 服务风暴 → CPU 高）
  async function titleOf(sessionId, forceRefresh) {
    const cached = titleCache[sessionId]
    if (!forceRefresh && cached && Date.now() - cached.ts < 30000) return cached.title
    let title = ''
    if (sessionQuery) { try { const snap = await Promise.race([sessionQuery.readTitle(sessionId), new Promise(function (r) { setTimeout(function () { r(null) }, 8000) })]); if (snap && typeof snap.title === 'string') title = snap.title } catch (e) {} }
    // 修复：缓存到空串会永久导致 pipeline 会话匹配失败（stale cache），空结果不缓存，下次重查
    if (title !== '') titleCache[sessionId] = { title: title, ts: Date.now() }
    return title
  }

  // ---- 唤醒通道：**已收归 adapter**（P3 §2D D5，用户裁定 2026-09-22）----
  // 历史：2026-08-27 taskkit 自带过一份 resolveSessionPresetId / presetMountSetupFor，用来在 agents.resume
  // 时补挂 preset —— 不挂 preset 的被唤醒会话只有全局层工具、缺约 32 个 preset 工具，模型一调用就 unknown tool。
  // 现在那份实现**已删除**：唤醒（resume + 挂 preset + 注入说明）的唯一实现在 `@local/dsh-adapter`：
  //   ctx.get('adapterWake') → resolveSessionPresetId / presetMountSetupFor / resumeWithPreset / injectNotice
  // 依赖方向：adapter 提供能力 → taskkit 调用（adapter **不读** taskkit 的任何文件）。
  // 纪律：**取不到 adapterWake 就明确留痕，不静默降级** —— 静默降级正是 2026-08-27 那次
  // "看起来唤醒成功、实则缺 preset 工具"事故的形态；同理，"resume 成功但 preset 没挂上"也必须留痕。
  function adapterWake() {
    try { return ctx.get('adapterWake') || null } catch (e) { return null }
  }
  async function resumeSessionViaAdapter(sessionId, opts) {
    const o = opts || {}
    const wake = adapterWake()
    if (!wake || typeof wake.resumeWithPreset !== 'function') {
      audit.log({ level: 'ERROR', category: 'wake', event: 'wake.adapter_unavailable', message: 'adapterWake 不可用：拒绝唤醒（唤醒能力已收归 @local/dsh-adapter，不静默降级）', extra: { sessionId: sessionId, reason: 'adapterWake-unavailable' } })
      return { ok: false, agent: null, error: 'adapterWake 不可用' }
    }
    try {
      const r = await wake.resumeWithPreset(sessionId, { provider: o.provider, model: o.model, timeoutMs: o.timeoutMs })
      if (r && r.ok && r.agent) {
        // 这里原本还有一个 `if (!r.setupMounted)` 的 WARN（2026-08-27 事故形态：resume 成功但 preset 没挂上）。
        // 2026-09-22 已删除，理由是它**变成了不可达代码**：
        //   adapter 侧的 `resumeWithPreset` 现在只有在 `setupMounted === true` 时才返回 `ok:true`
        //   （判据集中在 wake.js 的 classifyPresetSetup，未知 skip 原因一律 fail-closed）。
        // 所以"preset 没挂上"现在表现为 **`ok:false` + error**（走下面那条 return），
        // 并且在 adapter 审计里留 `resume.fail{setupSkipped, setupMounted:false, stateWritten:false}`。
        // ⇒ 判据只有一处，taskkit 不再需要重复检查；**别再把这个检查加回来**。
        return { ok: true, agent: r.agent, presetId: r.presetId || null, setupMounted: !!r.setupMounted, skipped: r.skipped || null, error: null }
      }
      return { ok: false, agent: null, error: (r && r.error) || 'resume 未返回 agent 句柄', presetId: (r && r.presetId) || null, setupMounted: !!(r && r.setupMounted) }
    } catch (e) {
      return { ok: false, agent: null, error: String(e && e.message || e) }
    }
  }
  // 唤醒前置机制：目标会话不在 live agents 时，从持久化会话查找并 resume 唤醒
  // 用户要求：任务传递前先检查对话是否唤醒；未唤醒则执行唤醒机制，确认唤醒后再发送任务
  async function wakeTarget(q) {
    const sessionQuery = ctx.get('sessionQuery')
    if (!q || !sessionQuery) return null
    const qs = String(q).trim()
    if (qs === '') return null
    // 1. 按 id 精确匹配持久化会话
    if (qs.indexOf('session-') === 0) {
      try {
        const rec = await sessionQuery.listSessions()
        const found = Array.isArray(rec) ? rec.find(function (r) { return r.header && r.header.id === qs }) : null
        if (found) {
          // 唤醒统一走 adapterWake（preset 由 adapter 负责挂载；取不到 adapterWake 时会在 audit 里留 ERROR）
          const woke = await resumeSessionViaAdapter(qs, { timeoutMs: 6000 })
          if (woke.ok && woke.agent) {
            return { id: String(woke.agent.id), title: await titleOf(woke.agent.id), woke: true }
          }
        }
      } catch (e) { audit.log({ level: 'WARN', category: 'wake', event: 'wake.failed', message: 'resume by id failed: ' + String(e && e.message || e), extra: { sessionId: qs } }) }
      return null
    }
    // 2. 按标题匹配持久化会话
    try {
      const rec = await sessionQuery.listSessions()
      const list = Array.isArray(rec) ? rec : []
      for (let i = 0; i < list.length; i++) {
        const h = list[i] && list[i].header
        if (!h || !h.id) continue
        let title = h.title || ''
        if (!title) { try { const snap = await sessionQuery.readTitle(h.id); if (snap && typeof snap.title === 'string') title = snap.title } catch (e) {} }
        if (title === qs || (qs.length >= 2 && title.indexOf(qs) >= 0)) {
          try {
            const woke = await resumeSessionViaAdapter(h.id, { timeoutMs: 6000 })
            if (woke.ok && woke.agent) {
              return { id: String(woke.agent.id), title: await titleOf(woke.agent.id), woke: true }
            }
          } catch (e) { audit.log({ level: 'WARN', category: 'wake', event: 'wake.failed', message: 'resume by title failed: ' + String(e && e.message || e), extra: { title: qs, sessionId: h.id } }) }
        }
      }
    } catch (e) {}
    return null
  }

  // ====== U-50（2026-09-30）：归档态读取（F-1 / F-2 的修法基础）======
  // 权威来源是宿主 `workspaceRegistry.archivedSessionIds`（dsh-api-workspace-controller 全程
  //   `archivedSessionIds.map(String)` / `[...archivedSessionIds]` ⇒ 该属性是**完整归档集**），
  //   且 `archiveSession()` 也回传它 ⇒ 可用它做**真验证**，不再"promise 没抛就当成功"。
  // 口径依据（**本插件自己声明的硬约束**）：`tsk_archive` 的描述写着「移出侧栏/**不可被派发**」
  //   ⇒ 归档 = 不可作为派发目标。而原 `tsk_sessions` 直接列出全部 live agent、完全不看归档集，
  //   同一插件内两处口径自相矛盾（F-1，2026-09-30 由 agent 排查报出）。
  function archivedIds() {
    try {
      const wr = ctx.get('workspaceRegistry')
      if (!wr || !wr.archivedSessionIds) return { ok: false, ids: [], reason: 'workspaceRegistry.archivedSessionIds 不可用' }
      return { ok: true, ids: Array.from(wr.archivedSessionIds).map(function (x) { return String(x) }), reason: '' }
    } catch (e) { return { ok: false, ids: [], reason: String(e && e.message || e) } }
  }
  /** 派发前的归档守卫：命中 ⇒ 返回 {reason}；未命中 / 归档集读不到 ⇒ null（**读不到不阻断派发**，只丢过滤能力，不误伤） */
  function archivedRefusal(id, title) {
    const a = archivedIds()
    if (!a.ok) return null
    if (a.ids.indexOf(String(id)) < 0) return null
    return { reason: '目标会话「' + (title || id) + '」（' + id + '）**已归档**：tsk_archive 的口径是「移出侧栏/不可被派发」⇒ 拒绝派发；请改用其他目标，或先取消归档' }
  }

  async function resolveTarget(q, agents) {
    if (!q) return null
    const qs = String(q).trim()
    if (qs === '') return null
    if (agents.get(qs)) return { id: qs, title: qs }
    const list = agents.list()
    for (let i = 0; i < list.length; i++) { const a = list[i]; const title = await titleOf(a.id); if (a.id === qs || title === qs) return { id: a.id, title: title }
      for (let i = 0; i < list.length; i++) { const a = list[i]; const title = await titleOf(a.id); if (title === qs) return { id: a.id, title: title } } }
    for (let i = 0; i < list.length; i++) { const a = list[i]; const title = await titleOf(a.id); if (qs.length >= 2 && title.indexOf(qs) >= 0) return { id: a.id, title: title } }
    // 唤醒前置：live 未命中 → 从持久化查找并 resume 唤醒
    const woke = await wakeTarget(qs)
    if (woke) return woke
    return null
  }

  function registerTool(toolDef) {
    const tool = defineTool(toolDef)
    const toolName = toolDef && toolDef.name || (tool && tool.name)
    // 严格遵守本文件 L2 注释：全程使用 ctx.get(serviceName) 惰性读取，避免直接属性访问抛 inject 错误
    let toolsSvc = (ctx.tools && typeof ctx.tools.register === "function") ? ctx.tools : null
    if (!toolsSvc) try {
      toolsSvc = ctx.get("tools")
      audit.log({ level: 'DEBUG', category: 'registration', event: 'service.resolved', message: 'tools service resolved via ctx.get', extra: { service: 'tools', via: 'ctx.get' } })
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'registration', event: 'service.unavailable', message: 'tools service unavailable: ' + String(e && e.message || e), extra: { service: 'tools', error: String(e && e.message || e) } })
    }
    if (!toolsSvc || typeof toolsSvc.register !== "function") {
      audit.log({ level: 'ERROR', category: 'registration', event: 'tool.register_failed', message: 'tools service not callable, tool ' + (toolName || '?') + ' registration failed', extra: { tool: toolName, reason: 'tools service unavailable' } })
      throw new Error("[taskkit.disabled:registerTool] tools 服务不可用（cordis 加载顺序异常）：工具 " + (toolName || '?') + " 注册失败")
    }
    // === 幂等与清理关键：先解注册同名旧工具（常见于 reload 竞态） ===
    if (toolName && __toolDisposers.has(toolName)) {
      try {
        const prev = __toolDisposers.get(toolName)
        if (typeof prev === 'function') prev()
      } catch (ePrev) {
        audit.log({ level: 'WARN', category: 'registration', event: 'tool.rereg_dispose_warn',
          message: 'unregister previous ' + toolName + ' failed: ' + String(ePrev && ePrev.message || ePrev),
          extra: { tool: toolName, error: String(ePrev && ePrev.stack || ePrev) } })
      }
      __toolDisposers.delete(toolName)
    }
    // === 注册工具并保存 disposer ===
    let disposer = null
    try {
      disposer = toolsSvc.register(tool)
    } catch (eReg) {
      // 若仍报 "already registered" 则是全局 layer 中有残留（bundles 静态加载 未卸载），
      // 尝试通过 services 内部状态探测清除；否则直接重抛，交由 sandbox 处理
      if (eReg && typeof eReg.message === 'string' && eReg.message.indexOf('already registered') >= 0 && toolName) {
        audit.log({ level: 'WARN', category: 'registration', event: 'tool.register_conflict',
          message: 'tool ' + toolName + ' already registered in global layer; forcing cleanup',
          extra: { tool: toolName, error: String(eReg.message) } })
        // 尝试从 layers.global.tools 中直接删除条目（非公开 API，尽量防御调用）
        try {
          const layer = toolsSvc.layers && toolsSvc.layers.global
          if (layer && layer.tools && typeof layer.tools.remove === 'function') layer.tools.remove(toolName)
          else if (layer && layer.tools && layer.tools._map && layer.tools._map instanceof Map) layer.tools._map.delete(toolName)
          else if (layer && layer.tools && layer.tools._entries && layer.tools._entries instanceof Map) layer.tools._entries.delete(toolName)
          disposer = toolsSvc.register(tool)
          audit.log({ level: 'INFO', category: 'registration', event: 'tool.register_conflict_resolved',
            message: 'resolved conflict, registered ' + toolName, extra: { tool: toolName } })
        } catch (eRetry) {
          audit.log({ level: 'ERROR', category: 'registration', event: 'tool.register_conflict_failed',
            message: 'resolve conflict failed for ' + toolName + ': ' + String(eRetry && eRetry.message || eRetry),
            extra: { tool: toolName, error: String(eRetry && eRetry.stack || eRetry) } })
          throw eRetry
        }
      } else {
        throw eReg
      }
    }
    // === 把 disposer 绑定到 taskkit 插件自己的 ctx.effect：插件 dispose 时自动调用清理 ===
    //    双重保险：1) 写入 __toolDisposers 表供 rereg 手动清；2) ctx.effect() 返回 cleanup，fiber 销毁时自动执行
    const cleanup = ctx.effect(() => function __taskkitToolCleanup() {
      if (toolName && __toolDisposers.get(toolName) === curDisposerRef) __toolDisposers.delete(toolName)
      try { if (typeof disposer === 'function') disposer() } catch (_) { /* ignore */ }
      const i = __regFinalizers.indexOf(curDisposerRef)
      if (i >= 0) __regFinalizers.splice(i, 1)
    })
    const curDisposerRef = { tool: toolName, cleanup: cleanup, disposer: disposer }
    if (toolName) __toolDisposers.set(toolName, disposer)
    __regFinalizers.push(curDisposerRef)
    audit.toolCount = (audit.toolCount || 0) + 1
    audit.log({ level: 'INFO', category: 'registration', event: 'tool.registered', message: "registered tool '" + (toolName || '?') + "' (idempotent cleanup attached)", extra: { tool: toolName, toolCount: audit.toolCount } })
  }

  // ---- 诊断工具：taskkit_ping（验证 host 半加载 + 工具注册） ----
  registerTool({
    name: 'taskkit_ping',
    description: 'taskkit 静态插件自检：返回插件已加载、fs/sandboxPolicy/sessionQuery 服务可用性。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      return {
        ok: true,
        loaded: true,
        hasFs: !!afs(),
        hasSandboxPolicy: !!sp,
        hasSessionQuery: !!sessionQuery,
        cwd: cwd || null,
        summary: 'taskkit 已加载' + (afs() ? '，fs 可用' : '，⚠️ fs 缺失') + (sp ? '，sandboxPolicy 可用' : '') + (sessionQuery ? '，sessionQuery 可用' : '')
      }
    }
  })

  // ---- 工具：tsk_dispatch ----
  registerTool({
    name: 'tsk_dispatch',
    description: '把任务写入任务看板（runtime checkout 数据源）并投递给目标会话：发送「📮 任务中心派发」消息并唤醒它。负责人 owner 缺省「学员」（用户本人）。目标会话可用 tsk_sessions 查询。',
    parameters: {
      title: { type: 'string', description: '任务标题（单任务必填；many 批量时忽略）' },
      requirement: { type: 'string', description: '任务要求/提示词：执行者需要知道的具体说明' },
      owner: { type: 'string', description: '负责人显示名（学员=用户本人 / 教练 / 插件工坊会话），缺省学员' },
      targetSession: { type: 'string', description: '目标会话：会话 id 或会话标题（单任务必填；many 批量时忽略）' },
      due: { type: 'string', description: '截止时间（ISO 8601 字符串，可省略）' },
      project: { type: 'string', description: '项目名，可省略' },
      note: { type: 'string', description: '备注，可省略' },
      startAfter: { type: 'string', description: '最早启动时间（ISO 8601），到点由调度器自动派发到目标会话，可省略' },
      dependsOn: { type: 'string', description: '前置任务 id 列表（逗号分隔或 JSON 数组字符串）；指定后任务初始为「待执行」但带依赖，前置全部「已完成」后调度器自动派发' },
      tasks: { type: 'string', description: '批量派发：任务数组 JSON（每个含 title/requirement/owner/targetSession/due/project），省略则单任务' },
      ackPolicy: { type: 'string', description: '回执策略：all（全部回执）/ any（任一回执）/ auto（默认），记录到任务供回执推进参考' },
      autoCreate: { type: 'boolean', description: '目标会话不存在时自动建对话（true 时派发对话工厂新建）' },
      domain: { type: 'string', description: '新对话领域（autoCreate 时用）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, error: 'agents 服务不可用', summary: '失败：agents 服务不可用' }
      // 增强1：many 批量派发（tasks 数组，schema 为字符串需解析）
      let manyTasks = null
      if (args && args.tasks) { try { const parsed = JSON.parse(String(args.tasks)); if (Array.isArray(parsed)) manyTasks = parsed } catch (e) {} }
      if (manyTasks && manyTasks.length) {
          const batchId = 'batch-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 10000)
          const ackPolicy = ['all', 'any', 'auto'].indexOf(String(args && args.ackPolicy || 'auto').trim()) >= 0 ? String(args && args.ackPolicy || 'auto').trim() : 'auto'
        const results = []
        let okCount = 0
        for (let mi = 0; mi < manyTasks.length; mi++) {
          const sub = manyTasks[mi] || {}
          try {
            const subTitle = String(sub.title || '').trim()
            if (!subTitle) { results.push({ ok: false, error: '缺少 title' }); continue }
            const target = await resolveTarget(sub.targetSession, agents)
            if (!target) { results.push({ ok: false, error: '目标不存在: ' + sub.targetSession, title: subTitle }); continue }
            const g0 = archivedRefusal(target.id, target.title)   // U-50（F-1）：批量路径同样拒派已归档
            if (g0) { results.push({ ok: false, error: 'TARGET_ARCHIVED: ' + g0.reason, title: subTitle }); continue }
            const now = new Date().toISOString()
            const { board } = await readBoard()
            const task = normalizeTask({ id: nextTaskId(), title: subTitle, requirement: String(sub.requirement || '').trim(), project: String(sub.project || args.project || '').trim(), status: '待执行', due: sub.due || null, repeat: null, owner: String(sub.owner || args.owner || '学员').trim(), assignedSession: target.id, note: String(sub.note || '').trim(), ackPolicy: String(sub.ackPolicy || ackPolicy).trim(), startAfter: sub.startAfter || null, dependsOn: Array.isArray(sub.dependsOn) ? sub.dependsOn : [], dispatch: { strategy: 'batch', ackPolicy: ackPolicy, batchId: batchId, batchIndex: mi, batchTotal: manyTasks.length, boundSessions: [target.id] }, createdAt: now, updatedAt: now }, board.tasks.length)
            board.tasks.unshift(task)
            try { await writeBoard(board) } catch (e) { results.push({ ok: false, error: '写入失败', title: subTitle }); continue }
            okCount++
            results.push({ ok: true, taskId: task.id, title: subTitle, targetSession: target.id })
          } catch (e) { results.push({ ok: false, error: String(e && e.message || e) }) }
        }
        audit.log({ level: 'INFO', category: 'dispatch', event: 'task.dispatch_many', message: 'batch dispatch ' + okCount + '/' + manyTasks.length, extra: { total: manyTasks.length, ok: okCount } })
        return { ok: true, total: manyTasks.length, ok: okCount, batchId: batchId, ackPolicy: ackPolicy, taskIds: results.filter(function (r) { return r.ok }).map(function (r) { return r.taskId }), results: results, summary: '批量派发 ' + okCount + '/' + manyTasks.length + ' 个任务（batch=' + batchId + ', ackPolicy=' + ackPolicy + '）' }
      }
      const title = String(args && args.title || '').trim()
      if (!title) return { ok: false, error: '缺少任务标题', summary: '失败：缺少任务标题' }
      const target = await resolveTarget(args && args.targetSession, agents)
      // U-50（F-1）：把「归档 = 不可派发」这条**已写在 tsk_archive 描述里的硬约束**真正落地（原来只在列表层没有，派发口完全不查）
      if (target) { const g = archivedRefusal(target.id, target.title); if (g) return { ok: false, error: 'TARGET_ARCHIVED', summary: '失败：' + g.reason } }
      // 增强3：autoCreate=true 且目标不存在 → 派发给对话工厂新建对话
        // 增强3续跑：autoCreate 完整闭环（等待回执 → 绑定 sessionId → 续派发原任务）
        if (!target && args && args.autoCreate === true) {
          const domain = String(args && args.domain || title).slice(0, 40)
          const dialogFactoryId = 'session-dffc-366400-74'
          const now = new Date().toISOString()
          const originalId = nextTaskId()
          const fcId = nextTaskId()
          const fcReq = '【对话工厂闭环】请为领域「' + domain + '」新建一个对话并回执 sessionId。\n任务标题：' + title + '\n负责人：' + String(args && args.owner || '学员') + '\n预设：minimal\n要求：1) 用 tsk_newconversation 创建（title=' + title + '，domain=' + domain + '，owner=' + String(args && args.owner || '学员') + '，preset=minimal，promptText 为该领域系统提示）；2) 创建成功后发送「📮 任务回执」：\ntaskId: ' + fcId + '\nresult: completed\nsummary: 新建对话成功：session-xxx。'
          const { board } = await readBoard()
          const task = normalizeTask({ id: originalId, title: title, requirement: String(args && args.requirement || '').trim(), project: String(args && args.project || '').trim(), status: '待执行', due: null, repeat: null, owner: String(args && args.owner || '学员').trim() || '学员', assignedSession: null, note: String(args && args.note || '').trim(), ackPolicy: String(args && args.ackPolicy || 'auto').trim(), startAfter: null, dependsOn: [], dispatch: { autoCreate: true, boundSessions: [], factoryTaskId: fcId, autoCreateForTaskId: null }, createdAt: now, updatedAt: now }, board.tasks.length)
          const fcTask = normalizeTask({ id: fcId, title: '新建对话·' + domain, requirement: fcReq, project: '对话工厂', status: '待执行', due: null, repeat: null, owner: '对话工厂', assignedSession: dialogFactoryId, note: 'autoCreate=true | originTaskId=' + originalId + ' | originRequirement=' + String(args && args.requirement || '').slice(0, 40), startAfter: null, dependsOn: [], dispatch: { kind: 'dialog-factory-request', autoCreateForTaskId: originalId }, createdAt: now, updatedAt: now }, board.tasks.length)
          board.tasks.unshift(fcTask)
          board.tasks.unshift(task)
          try { await writeBoard(board) } catch (e) { return { ok: false, error: '写入失败', summary: '失败：写入失败' } }
          const fcAgent = agents.get(dialogFactoryId)
          if (fcAgent && typeof fcAgent.send === 'function') {
            const text = '📮 [任务中心] 新任务：新建对话·' + domain + '\n要求：' + fcReq + '\n请打开「任务」页签查看，并按要求开始处理。'
            try { fcAgent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true) } catch (e) {}
          }
          const sleep = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
          const extractSessionId = async function (r) {
            if (!r) return null
            const raw = r.summary || ''
            const m = raw.match(/session-[A-Za-z0-9_-]+/)
            if (m && m[0] !== 'session-xxx') return m[0]
              try {
                const { board: b3 } = await readBoard()
                const fc = b3.tasks.find(function (t) { return t.id === fcId })
                const note = fc && fc.note || ''
                const m2 = note.match(/session-[A-Za-z0-9_-]+/)
                if (m2 && m2[0] !== 'session-xxx') return m2[0]
              } catch (e) {}
              try {
                  const sq = ctx.get('sessionQuery')
                  if (sq) {
                    const snap = await sq.readSurface(dialogFactoryId)
                    const events = snap && Array.isArray(snap.events) ? snap.events : []
                    let allText = ''
                    for (let i = 0; i < events.length; i++) {
                      const ev = events[i]
                      if (!ev || !ev.data || !ev.data.content) continue
                      const content = ev.data.content
                      if (Array.isArray(content)) { for (let c = 0; c < content.length; c++) { const b = content[c]; if (b && b.type === 'text' && typeof b.text === 'string') allText += b.text + '\n' } }
                      else if (typeof content === 'string') allText += content + '\n'
                    }
                    const m3 = allText.match(/session-[A-Za-z0-9_-]+/g)
                    if (m3) { const real = m3.find(function (s) { return s !== 'session-xxx' }); if (real) return real }
                  }
                } catch (e) {}
                return m ? m[0] : null
          }
          const waitForFactoryReceipt = async function () {
            const deadline = Date.now() + 30000
            while (Date.now() < deadline) {
              try {
                const sq = ctx.get('sessionQuery')
                if (sq) {
                  const snap = await sq.readSurface(dialogFactoryId)
                  const events = snap && Array.isArray(snap.events) ? snap.events : []
                  for (let i = events.length - 1; i >= 0; i--) {
                    const ev = events[i]
                    if (!ev || ev.type !== 'user/message') continue
                    const content = ev.data && ev.data.content
                    let text = ''
                    if (Array.isArray(content)) { for (let c = 0; c < content.length; c++) { const b = content[c]; if (b && b.type === 'text' && typeof b.text === 'string') text += b.text + '\n' } }
                    else if (typeof content === 'string') text = content
                    if (text.indexOf('📮 任务回执') >= 0) {
                      const r = parseTaskReceipt(text)
                      if (r && r.taskId === fcId) {
                          const sid = await extractSessionId(r)
                          if (sid && sid !== 'session-xxx') return r
                        }
                    }
                  }
                }
              } catch (e) {}
              await sleep(500)
            }
            return null
          }
          const receipt = await waitForFactoryReceipt()
          if (!receipt) {
            audit.log({ level: 'WARN', category: 'dispatch', event: 'task.auto_create_timeout', message: 'autoCreate timeout for ' + title, extra: { fcTaskId: fcId } })
            return { ok: false, error: 'DIALOG_FACTORY_TIMEOUT', message: '等待对话工厂建会话回执超时', factoryTaskId: fcId, summary: '失败：等待对话工厂建会话回执超时（' + fcId + '）' }
          }
          const sessionId = await extractSessionId(receipt)
          if (!sessionId) {
            return { ok: false, error: 'DIALOG_FACTORY_RECEIPT_INVALID', message: '对话工厂回执中缺少 sessionId', factoryTaskId: fcId, receipt: receipt, summary: '失败：对话工厂回执缺少 sessionId' }
          }
          let newTarget = null
          const resolveDeadline = Date.now() + 15000
          while (!newTarget && Date.now() < resolveDeadline) {
            newTarget = await resolveTarget(sessionId, agents)
            if (!newTarget) await sleep(300)
          }
          if (!newTarget) newTarget = { id: sessionId, title: sessionId }
            if (false) {
          }
          const { board: board2 } = await readBoard()
          const savedTask = board2.tasks.find(function (t) { return t.id === originalId })
          if (savedTask) {
            savedTask.assignedSession = sessionId
            savedTask.dispatch = savedTask.dispatch || {}
            savedTask.dispatch.boundSessions = (savedTask.dispatch.boundSessions || []).concat([sessionId])
            savedTask.dispatch.autoCreatedSession = true
            savedTask.dispatch.factoryTaskId = fcId
            savedTask.updatedAt = new Date().toISOString()
            try { await writeBoard(board2) } catch (e) {}
          }
          const agent = agents.get(sessionId)
          let delivered = false, deliverError = ''
          if (agent && typeof agent.send === 'function') {
            try {
              const text = '📮 [任务中心] 新任务：' + title + '\n要求：' + (String(args && args.requirement || '').trim() || '—') + '\n截止：' + fmtDue(args && args.due || null) + '\n项目：' + (String(args && args.project || '').trim() || '—') + '\n负责人：' + String(args && args.owner || '学员') + '\n请打开「任务」页签查看，并按要求开始处理。'
              agent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true)
              delivered = true
            } catch (e) { deliverError = String(e && e.message || e) }
          } else { deliverError = '新会话不是活跃 agent' }
          audit.log({ level: 'INFO', category: 'dispatch', event: 'task.auto_create_completed', message: 'autoCreate completed for ' + title, extra: { taskId: originalId, sessionId: sessionId, fcTaskId: fcId, delivered: delivered } })
          return { ok: true, taskId: originalId, sessionId: sessionId, autoCreated: true, factoryTaskId: fcId, delivered: delivered, deliverError: deliverError || '', summary: '已自动建对话并派发「' + title + '」到 ' + sessionId + '（' + fcId + '）' }
        }

      if (!target && args && args.autoCreate === true) {
        const domain = String(args && args.domain || title).slice(0, 40)
        const dialogFactoryId = 'session-dffc-366400-74'
        const fcReq = '【对话工厂闭环】请为领域「' + domain + '」新建一个对话并回执 sessionId。\n任务标题：' + title + '\n负责人：' + String(args && args.owner || '学员') + '\n预设：minimal\n要求：1) 用 tsk_newconversation 创建（title=' + title + '，domain=' + domain + '，owner=' + String(args && args.owner || '学员') + '，preset=minimal，promptText 为该领域系统提示）；2) 创建成功后发送「📮 任务回执」：result=completed，summary 含新会话 id（格式：新建对话成功：session-xxx）。'
        const now = new Date().toISOString()
        const { board } = await readBoard()
        const fcTask = normalizeTask({ id: nextTaskId(), title: '新建对话·' + domain, requirement: fcReq, project: '对话工厂', status: '待执行', due: null, repeat: null, owner: '对话工厂', assignedSession: dialogFactoryId, note: 'autoCreate=true | originTaskId=' + title + ' | originRequirement=' + String(args && args.requirement || '').slice(0, 40), startAfter: null, dependsOn: [], createdAt: now, updatedAt: now }, board.tasks.length)
        board.tasks.unshift(fcTask)
        try { await writeBoard(board) } catch (e) { return { ok: false, error: '写入失败', summary: '失败：写入失败' } }
        const fcAgent = agents.get(dialogFactoryId)
        if (fcAgent && typeof fcAgent.send === 'function') {
          const text = '📮 [任务中心] 新任务：新建对话·' + domain + '\n要求：' + fcReq + '\n请打开「任务」页签查看，并按要求开始处理。'
          try { fcAgent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true) } catch (e) {}
        }
        audit.log({ level: 'INFO', category: 'dispatch', event: 'task.auto_create_started', message: 'autoCreate: dispatched to dialog factory for ' + title, extra: { domain: domain, fcTaskId: fcTask.id } })
        return { ok: true, autoCreate: true, fcTaskId: fcTask.id, summary: '目标会话不存在，已派发「新建对话·' + domain + '」给对话工厂（' + fcTask.id + '），等待回执后续派发' }
      }
      if (!target) return { ok: false, error: '目标会话不存在', summary: '失败：目标会话不存在，请先用 tsk_sessions 查询' }
      const requirement = String(args && args.requirement || '').trim()
      const project = String(args && args.project || '').trim()
      const owner = String(args && args.owner || '').trim() || '学员'
      const note = String(args && args.note || '').trim()
      let startAfter = null
      if (args && typeof args.startAfter === 'string' && args.startAfter !== '') { if (!isNaN(Date.parse(args.startAfter))) startAfter = new Date(args.startAfter).toISOString() }
      let due = null
      if (args && typeof args.due === 'string' && args.due !== '') { if (!isNaN(Date.parse(args.due))) due = new Date(args.due).toISOString() }
      // dependsOn 解析：逗号分隔或 JSON 数组字符串
      let dependsOn = []
      if (args && typeof args.dependsOn === 'string' && args.dependsOn.trim() !== '') {
        const ds = args.dependsOn.trim()
        if (ds.startsWith('[')) { try { const arr = JSON.parse(ds); if (Array.isArray(arr)) dependsOn = arr.filter(function (d) { return typeof d === 'string' }) } catch (e) {} }
        else dependsOn = ds.split(',').map(function (s) { return s.trim() }).filter(function (s) { return s !== '' })
      }
      const now = new Date().toISOString()
      const { board } = await readBoard()
      const task = normalizeTask({ id: nextTaskId(), title: title, requirement: requirement, project: project, status: '待执行', due: due, repeat: null, owner: owner, assignedSession: target.id, note: note, ackPolicy: String(args && args.ackPolicy || 'auto').trim(), startAfter: startAfter, dependsOn: dependsOn, dispatch: { strategy: 'single', ackPolicy: String(args && args.ackPolicy || 'auto').trim(), boundSessions: [target.id] }, createdAt: now, updatedAt: now }, board.tasks.length)
      board.tasks.unshift(task)
      try { await writeBoard(board) } catch (e) {
        audit.log({ level: 'ERROR', category: 'error', event: 'error.caught', message: 'writeBoard failed in tsk_dispatch: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), context: 'tsk_dispatch.writeBoard' } })
        return { ok: false, error: '看板写入失败：' + String(e && e.message || e), summary: '失败：看板写入失败' }
      }
      // 有依赖：仅登记，不投递（等调度器前置完成后自动派发）
      if (dependsOn.length > 0) {
        return { ok: true, taskId: task.id, title: title, targetSession: target.id, targetTitle: target.title, dependsOn: dependsOn, delivered: false, pendingDeps: true, summary: '已创建任务「' + title + '」（' + task.id + '）并登记依赖 ' + dependsOn.length + ' 个前置；前置「已完成」后调度器自动派发给「' + target.title + '」' }
      }
      const agent = agents.get(target.id)
      let delivered = false, deliverError = ''
      if (agent && typeof agent.send === 'function') {
        try {
          const text = '📮 [任务中心] 新任务：' + title + '\n要求：' + (requirement || '—') + '\n截止：' + fmtDue(due) + '\n项目：' + (project || '—') + '\n负责人：' + owner + '\n请打开「任务」页签查看，并按要求开始处理。'
          agent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true)
          delivered = true
        } catch (e) { deliverError = String(e && e.message || e) }
      } else { deliverError = '目标会话不是活跃 agent' }
      return { ok: true, taskId: task.id, title: title, targetSession: target.id, targetTitle: target.title, delivered: delivered, deliverError: deliverError || '', summary: '已创建任务「' + title + '」并' + (delivered ? '投递给会话「' + target.title + '」' : '写入看板（投递失败：' + deliverError + '）') }
    }
  })

  // ---- 工具：tsk_sessions ----
  registerTool({
    name: 'tsk_sessions',
    description: '列出当前**活跃且未归档**的会话（id + 标题 + 状态），供任务分配（tsk_dispatch）选择目标会话。🔴 口径：已归档会话**不作为派发目标**（tsk_archive 的语义是"移出侧栏/不可被派发"）⇒ 本工具默认排除它们，并在 summary 里报出被排除的数量与 id；归档集读不到时会显式告警（不会静默放行）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, error: 'agents 服务不可用', summary: '失败：agents 服务不可用' }
      // U-50（F-1）：归档 = 不可派发 ⇒ 过滤掉，并**显式报出**被排除的（原版完全不看归档集）
      const arch = archivedIds()
      const sessions = [], excluded = []
      const list = agents.list()
      for (let i = 0; i < list.length; i++) {
        const a = list[i]
        if (arch.ok && arch.ids.indexOf(String(a.id)) >= 0) { excluded.push({ id: a.id, title: await titleOf(a.id) }); continue }
        sessions.push({ id: a.id, title: await titleOf(a.id), status: a.status })
      }
      const excMsg = excluded.length ? '（已排除 ' + excluded.length + ' 个已归档会话：' + excluded.map(function (s) { return s.title + '(' + s.id + ')' }).join('、') + '）' : ''
      const warn = arch.ok ? '' : '｜⚠ 归档集读不到（' + arch.reason + '）⇒ 本次**未过滤**已归档会话，派发前请自行确认'
      return {
        ok: true, sessions: sessions, excludedArchived: excluded.length, excluded: excluded, archivedFilterOk: arch.ok,
        summary: '活跃会话 ' + sessions.length + ' 个' + excMsg + warn + '：' + sessions.map(function (s) { return s.title + '(' + s.id + ')' }).join('、')
      }
    }
  })

  // ---- 工具：tsk_taskcenter ----
  registerTool({
    name: 'tsk_taskcenter',
    description: '确保存在一个「任务中心」会话（任务入口与分配器合一）：不存在则自动新建（minimal 预设，全局 tsk 工具可用），存在则返回其会话 id 与标题。教练布置/拆解/分配任务时使用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, error: 'agents 服务不可用', summary: '失败：agents 服务不可用' }
      const TC_MARK = '任务中心'
      const TC_ID = 'session-0e4ee8e5-afd1-4197-9290-f31dfc87a680'
      const TC_MODEL = 'deepseek-v4-flash'
      const TC_PROVIDER = 'deepseek-official'
      const wr = ctx.get('workspaceRegistry')
      let wsPath = ''
      if (wr) { try { const l = wr.list(); if (l && l.length && l[0].path) wsPath = l[0].path } catch (e) {} }
      if (!wsPath && sp) wsPath = sp.workspaceRoot
      const existing = agents.get(TC_ID)
      if (existing) return { ok: true, created: false, sessionId: TC_ID, title: TC_MARK, cwd: wsPath, summary: '任务中心会话已存在：任务中心（' + TC_ID + '）' }
      try {
        let handle
        try {
          // 唤醒走 adapterWake（preset 由 adapter 挂）；失败/不可用则退回 create（行为与改造前一致）
          const woke = await resumeSessionViaAdapter(TC_ID, { provider: TC_PROVIDER, model: TC_MODEL, timeoutMs: 8000 })
          if (!woke.ok || !woke.agent) throw new Error(woke.error || 'adapterWake resume 未返回 agent')
          handle = { agent: woke.agent }
        } catch (e) {
          handle = await agents.create({ sessionId: TC_ID, meta: { cwd: wsPath, agentPreset: 'minimal' }, agentOptions: { provider: TC_PROVIDER, model: TC_MODEL } })
          if (wr) { try { const l = wr.list(); if (l && l.length) await l[0].attachSession(TC_ID) } catch (e2) {} }
        }
        if (handle && handle.agent && typeof handle.agent.send === 'function') {
          try { await handle.agent.send({ id: 'seed-' + Date.now(), role: 'user', content: [{ type: 'text', text: '📮 [任务中心] 已就绪。' }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', false) } catch (e) {}
        }
        const sessionTitle = ctx.get('sessionTitle')
        if (sessionTitle && typeof sessionTitle.rename === 'function' && handle && handle.agent && handle.agent.session) {
          try { sessionTitle.rename(handle.agent.session, TC_MARK) } catch (e) {}
        }
        return { ok: true, created: true, sessionId: String(handle.agent.id), title: TC_MARK, cwd: wsPath, summary: '已就绪任务中心会话：任务中心（' + handle.agent.id + '）' }
      } catch (e) {
        return { ok: false, error: '创建失败：' + String(e && e.message || e), summary: '失败：创建任务中心会话失败' }
      }
    }
  })

  // ---- 工具：tsk_newconversation（对话工厂调用） ----
  registerTool({
    name: 'tsk_newconversation',
    description: '新建一个会话并使其在侧边栏可见（6 步流程：create/resume → attach → seed → rename）。对话工厂设计好 prompt 后调用此工具执行创建。',
    parameters: {
      title: { type: 'string', description: '新对话显示名称', required: true },
      domain: { type: 'string', description: '领域标识（如 插件设计 / 写作辅导）', required: true },
      owner: { type: 'string', description: '负责人显示名', required: true },
      preset: { type: 'string', description: 'agent 预设 id（默认 minimal）' },
      promptText: { type: 'string', description: '新对话的系统提示全文（由对话工厂设计）', required: true },
      seedMessage: { type: 'string', description: 'seed 首条消息内容（缺省 = promptText）' },
      sessionId: { type: 'string', description: '指定会话 id（缺省系统生成）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, error: 'agents 服务不可用', summary: '失败：agents 服务不可用' }
      const title = String(args && args.title || '').trim()
      const domain = String(args && args.domain || '').trim()
      const owner = String(args && args.owner || '').trim()
      const promptText = String(args && args.promptText || '').trim()
      if (!title || !domain || !owner || !promptText) return { ok: false, error: '缺少必填参数（title/domain/owner/promptText）', summary: '失败：缺少必填参数' }
      const preset = String(args && args.preset || '').trim() || 'minimal'
      const seedMessage = String(args && args.seedMessage || '').trim() || promptText
      const wr = ctx.get('workspaceRegistry')
      let wsPath = ''
      if (wr) { try { const l = wr.list(); if (l && l.length && l[0].path) wsPath = l[0].path } catch (e) {} }
      if (!wsPath && sp) wsPath = sp.workspaceRoot
      const sessionTitle = ctx.get('sessionTitle')
      try {
        const requestedId = args && typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : null
        let id = requestedId
        if (!id) id = 'session-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.floor(Math.random() * 90 + 10))
        let handle
        try {
          // 唤醒走 adapterWake（preset 由 adapter 挂）；失败/不可用则退回 create（行为与改造前一致）
          const woke = await resumeSessionViaAdapter(id, { provider: 'deepseek-official', model: 'deepseek-v4-flash', timeoutMs: 8000 })
          if (!woke.ok || !woke.agent) throw new Error(woke.error || 'adapterWake resume 未返回 agent')
          handle = { agent: woke.agent }
        } catch (e) {
          handle = await agents.create({ sessionId: id, meta: { cwd: wsPath, agentPreset: preset }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
          if (wr) { try { const l = wr.list(); if (l && l.length) await l[0].attachSession(id) } catch (e2) {} }
        }
        if (!handle || !handle.agent) return { ok: false, error: '创建失败：无 agent 句柄' }
        try { await handle.agent.send({ id: 'seed-' + Date.now(), role: 'user', content: [{ type: 'text', text: seedMessage }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', false) } catch (e) {}
        if (sessionTitle && typeof sessionTitle.rename === 'function' && handle.agent.session) {
          try { sessionTitle.rename(handle.agent.session, title) } catch (e) {}
        }
        return { ok: true, sessionId: String(handle.agent.id), title: title, domain: domain, owner: owner, preset: preset, promptChars: promptText.length, summary: '已创建会话「' + title + '」（' + handle.agent.id + '），领域=' + domain + '，预设=' + preset }
      } catch (e) {
        return { ok: false, error: String(e && e.message || e), summary: '失败：' + String(e && e.message || e) }
      }
    }
  })

  // ---- 工具：tsk_list（看板任务列表，按状态/项目/负责人筛选） ----
  registerTool({
    name: 'tsk_list',
    description: '列出任务看板中的任务，可按状态/项目/负责人筛选，默认列出最近更新的 20 个。看板管理用。',
    parameters: {
      status: { type: 'string', description: '状态筛选（待执行/执行中/需审批/已完成/已取消，可逗号分隔多选）' },
      project: { type: 'string', description: '项目名筛选（模糊匹配）' },
      owner: { type: 'string', description: '负责人筛选（模糊匹配）' },
      limit: { type: 'string', description: '返回数量上限（默认 20，最大 100）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const { board } = await readBoard()
      if (!board || !Array.isArray(board.tasks)) return { ok: false, error: '看板不可读', summary: '失败：看板不可读' }
      let tasks = board.tasks.slice()
      const statusFilter = String(args && args.status || '').trim()
      if (statusFilter) {
        const statuses = statusFilter.split(',').map(function (s) { return s.trim() }).filter(function (s) { return s !== '' })
        tasks = tasks.filter(function (t) { return statuses.indexOf(t.status) >= 0 })
      }
      const projectFilter = String(args && args.project || '').trim()
      if (projectFilter) tasks = tasks.filter(function (t) { return (t.project || '').indexOf(projectFilter) >= 0 })
      const ownerFilter = String(args && args.owner || '').trim()
      if (ownerFilter) tasks = tasks.filter(function (t) { return (t.owner || '').indexOf(ownerFilter) >= 0 })
      // 按更新时间倒序
      tasks.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) })
      const limit = parseInt(String(args && args.limit || '20'), 10) || 20
      const shown = tasks.slice(0, Math.min(limit, 100))
      const sessions = ctx.get('agents')
      const rows = []
      for (let i = 0; i < shown.length; i++) {
        const t = shown[i]
        let assignedTitle = t.assignedSession || ''
        if (sessions && t.assignedSession) {
          const a = sessions.get(t.assignedSession)
          if (a) assignedTitle = await titleOf(a.id)
        }
        rows.push({ id: t.id, title: t.title, status: t.status, project: t.project || '', owner: t.owner || '', assignedSession: assignedTitle, updatedAt: t.updatedAt || '' })
      }
      return {
        ok: true, total: tasks.length, shown: rows.length, filtered: tasks.length !== board.tasks.length, tasks: rows,
        summary: '任务 ' + tasks.length + ' 个（显示 ' + rows.length + '）：' + rows.map(function (r) { return '[' + r.status + '] ' + r.id + ' ' + r.title.slice(0, 20) }).join('、')
      }
    }
  })

  // ---- 工具：tsk_stats（看板统计） ----
  registerTool({
    name: 'tsk_stats',
    description: '任务看板统计：各状态数量、项目分布、负责人分布、最近更新时间。看板管理用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      const { board } = await readBoard()
      if (!board || !Array.isArray(board.tasks)) return { ok: false, error: '看板不可读', summary: '失败：看板不可读' }
      const tasks = board.tasks
      const byStatus = {}
      const byProject = {}
      const byOwner = {}
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]
        byStatus[t.status] = (byStatus[t.status] || 0) + 1
        const p = t.project || '（无项目）'
        byProject[p] = (byProject[p] || 0) + 1
        const o = t.owner || '（无负责人）'
        byOwner[o] = (byOwner[o] || 0) + 1
      }
      // 最近更新的 5 个
      const recent = tasks.slice().sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) }).slice(0, 5).map(function (t) { return { id: t.id, title: t.title.slice(0, 30), status: t.status, updatedAt: t.updatedAt } })
      return {
        ok: true, total: tasks.length, byStatus: byStatus, byProject: byProject, byOwner: byOwner, recent: recent,
        summary: '看板共 ' + tasks.length + ' 任务。状态：' + Object.keys(byStatus).map(function (k) { return k + '=' + byStatus[k] }).join('，') + '。最近更新：' + recent.map(function (r) { return r.title }).join('、')
      }
    }
  })

  // ---- 工具：tsk_complete（显式标记任务完成） ----
  // 经验闭环 v2.1：支持 lessons（分号分隔）/artifacts（逗号分隔）落库 task.lessons/task.artifacts，
  // 与 receiptScanner 语义一致（lessons 分号拆分、artifacts 逗号拆分），使经验可被后续派发素材引用
  registerTool({
    name: 'tsk_complete',
    description: '显式标记一个任务为「已完成」。需 taskId；可选 summary 记录完成说明；可选 lessons（分号分隔的经验/踩坑要点，写入 task.lessons 供后续阶段素材引用）；可选 artifacts（逗号分隔的交付物路径，写入 task.artifacts）。状态会写入看板（任务须为 待执行/执行中/需审批）。',
    parameters: {
      taskId: { type: 'string', description: '任务 id（如 task-xxx）', required: true },
      summary: { type: 'string', description: '完成说明（可选，写入 note）' },
      lessons: { type: 'string', description: '经验/踩坑要点，分号分隔（可选，写入 task.lessons）' },
      artifacts: { type: 'string', description: '交付物文件绝对路径，逗号分隔（可选，写入 task.artifacts）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const taskId = String(args && args.taskId || '').trim()
      if (!taskId) return { ok: false, error: '缺少 taskId', summary: '失败：缺少 taskId' }
      const summary = String(args && args.summary || '').trim()
      const lessonsRaw = String(args && args.lessons || '').trim()
      const artifactsRaw = String(args && args.artifacts || '').trim()
      const { board } = await readBoard()
      const task = board.tasks.find(function (t) { return t.id === taskId })
      if (!task) return { ok: false, error: '任务不存在：' + taskId, summary: '失败：任务不存在' }
      if (task.status === '已完成') return { ok: true, taskId: taskId, status: '已完成', alreadyDone: true, summary: '任务已是已完成状态' }
      const from = task.status
      task.status = '已完成'
      task.finishedAt = new Date().toISOString()
      if (summary) task.note = (task.note ? task.note + ' | ' : '') + '完成说明: ' + summary.slice(0, 100)
      // 经验闭环 v2.1：lessons（分号分隔）落库 task.lessons，去重合并 slice(-30)
      // 修复：拆分正则用 [；;\n]（分号或真实换行），避免 [；;\\n] 误匹配字母 n（如 mail-attachments.js 被错误拆分）
      if (lessonsRaw) {
        const lessons = lessonsRaw.split(/[；;\n]+/).map(function (s) { return s.trim() }).filter(Boolean).slice(0, 10)
        if (lessons.length) {
          task.lessons = Array.from(new Set((task.lessons || []).concat(lessons))).slice(-30)
          try { audit.log({ level: 'INFO', category: 'state_transition', event: 'task.completed_lessons', message: 'lessons attached to ' + taskId, extra: { count: lessons.length, taskId: taskId } }) } catch (_) {}
        }
      }
      // artifacts（逗号分隔）落库 task.artifacts
      if (artifactsRaw) {
        const artifacts = artifactsRaw.split(/[,，]+/).map(function (s) { return s.trim() }).filter(Boolean).slice(0, 10)
        if (artifacts.length) {
          task.artifacts = Array.from(new Set((task.artifacts || []).concat(artifacts))).slice(-30)
        }
      }
      try { await writeBoard(board) } catch (e) { return { ok: false, error: '看板写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.completed_tool', message: "task '" + task.title + "' marked 已完成 via tsk_complete", extra: { taskId: taskId, from: from, to: '已完成' } })
      // 记忆接入 Phase 2（additive，autoDraftOnComplete 门控默认关）：board 已写盘成功 → fire-and-forget 单任务同步 L1 草稿；
      //   失败仅 audit、绝不 throw、不阻塞任务返回（memory 尽力而为；关开关=零行为）
      try { fireAutoDraft(taskId, 'tsk_complete').catch(function () {}) } catch (e) {}
      return { ok: true, taskId: taskId, status: '已完成', from: from, lessons: (task.lessons || []).length, artifacts: (task.artifacts || []).length, summary: '任务「' + task.title + '」已标记完成（' + from + ' → 已完成），lessons ' + (task.lessons || []).length + ' 条' }
    }
  })


  // ---- 工具：tsk_cancel（取消任务：中止/待执行/执行中/需审批 → 已取消） ----
  registerTool({
    name: 'tsk_cancel',
    description: '取消一个任务（中止/待执行/执行中/需审批 → 已取消）。需 taskId；可选 reason 记录取消原因。',
    parameters: {
      taskId: { type: 'string', description: '任务 id（如 task-xxx）', required: true },
      reason: { type: 'string', description: '取消原因（可选，写入 note）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const taskId = String(args && args.taskId || '').trim()
      if (!taskId) return { ok: false, error: '缺少 taskId', summary: '失败：缺少 taskId' }
      const reason = String(args && args.reason || '').trim()
      const { board } = await readBoard()
      const task = board.tasks.find(function (t) { return t.id === taskId })
      if (!task) return { ok: false, error: '任务不存在：' + taskId, summary: '失败：任务不存在' }
      if (task.status === '已取消') return { ok: true, taskId: taskId, status: '已取消', alreadyDone: true, summary: '任务已是已取消状态' }
      if (task.status === '已完成') return { ok: false, error: '已完成任务不可取消', summary: '失败：已完成任务不可取消' }
      const from = task.status
      task.status = '已取消'
      task.finishedAt = new Date().toISOString()
      if (reason) task.note = (task.note ? task.note + ' | ' : '') + '取消原因: ' + reason.slice(0, 100)
      try { await writeBoard(board) } catch (e) { return { ok: false, error: '看板写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.cancelled_tool', message: "task '" + task.title + "' cancelled via tsk_cancel", extra: { taskId: taskId, from: from, to: '已取消' } })
      // 级联：前置取消 → 后置中止（传递）
      await applyCascade(board, task, from, '已取消')
      return { ok: true, taskId: taskId, status: '已取消', from: from, summary: '任务「' + task.title + '」已取消（' + from + ' → 已取消）' }
    }
  })

  // ---- 工具：tsk_redispatch（重派任务：中止 → 待执行重新进入调度） ----
  registerTool({
    name: 'tsk_redispatch',
    description: '重派一个「中止」任务（中止 → 待执行，重新进入调度器派发）。需 taskId；可选 note 记录重派原因。',
    parameters: {
      taskId: { type: 'string', description: '任务 id（如 task-xxx）', required: true },
      note: { type: 'string', description: '重派说明（可选）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const taskId = String(args && args.taskId || '').trim()
      if (!taskId) return { ok: false, error: '缺少 taskId', summary: '失败：缺少 taskId' }
      const note = String(args && args.note || '').trim()
      const { board } = await readBoard()
      const task = board.tasks.find(function (t) { return t.id === taskId })
      if (!task) return { ok: false, error: '任务不存在：' + taskId, summary: '失败：任务不存在' }
      if (task.status !== '中止') return { ok: false, error: '仅「中止」任务可重派，当前：' + task.status, summary: '失败：仅中止任务可重派' }
      const from = task.status
      task.status = '待执行'
      task.startedAt = null
      task.finishedAt = null
      task.attempt = (task.attempt || 0) + 1
      if (note) task.note = (task.note ? task.note + ' | ' : '') + '重派: ' + note.slice(0, 100)
      try { await writeBoard(board) } catch (e) { return { ok: false, error: '看板写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.redispatch_tool', message: "task '" + task.title + "' redispatch via tsk_redispatch", extra: { taskId: taskId, from: from, to: '待执行' } })
      // 级联：前置重派(中止→待执行) → 后置重派（传递）
      await applyCascade(board, task, '中止', '待执行')
      return { ok: true, taskId: taskId, status: '待执行', from: from, attempt: task.attempt, summary: '任务「' + task.title + '」已重派（' + from + ' → 待执行，第 ' + task.attempt + ' 次）' }
    }
  })
  // ---- 工具：tsk_force_dispatch（手动重派：任意状态强制重新派发；Agent 主动触发） ----
  registerTool({
    name: 'tsk_force_dispatch',
    description: '手动重派一个任务：立即按门禁/依赖判定（force=false）或跳过检查（force=true）派发到目标会话并唤醒。与 60s 自动调度器互补：任务卡在「待执行」「中止」「已取消」时由 Agent 主动触发，避免依赖下轮 tick。参数：taskId（必填）、force（默认 false）、note（原因）。「已完成」任务不可重派；held 任务需先 tsk_resume。',
    parameters: {
      taskId: { type: 'string', description: '任务 id（如 task-xxx）', required: true },
      force: { type: 'boolean', description: '强制模式：跳过依赖/预约时间/目标忙检查直接派发（默认 false）' },
      note: { type: 'string', description: '重派说明（可选）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const taskId = String(args && args.taskId || '').trim()
      if (!taskId) return { ok: false, error: '缺少 taskId', summary: '失败：缺少 taskId' }
      const force = !!(args && args.force === true)
      const note = String(args && args.note || '').trim()
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, error: 'agents 服务不可用', summary: '失败：agents 服务不可用' }
      const { board } = await readBoard()
      const task = board.tasks.find(function (t) { return t.id === taskId })
      if (!task) return { ok: false, error: '任务不存在：' + taskId, summary: '失败：任务不存在' }
      if (task.status === '已完成') return { ok: false, error: '「已完成」任务不可重派', summary: '失败：已完成任务不可重派' }
      if (task.held) return { ok: false, error: '任务被挂起（held），请先 tsk_resume 解除', summary: '失败：任务被挂起' }
      const from = task.status
      // 状态修正：中止/已取消 → 待执行（重新进入派发）；待执行/执行中 → 直接重派
      if (from === '中止' || from === '已取消') { task.status = '待执行'; task.startedAt = null; task.finishedAt = null }
      if (!force) {
        const now = Date.now()
        if (task.startAfter && Date.parse(task.startAfter) > now) return { ok: false, error: '未到预约时间 startAfter=' + task.startAfter, summary: '失败：未到预约时间' }
        const hasDepends = Array.isArray(task.dependsOn) && task.dependsOn.length > 0
        if (hasDepends) {
          const missed = []
          for (let i = 0; i < task.dependsOn.length; i++) { const dep = board.tasks.find(function (x) { return x.id === task.dependsOn[i] }); if (!dep || dep.status !== '已完成') missed.push(task.dependsOn[i] + (dep ? '(' + dep.status + ')' : '(不存在)')) }
          if (missed.length) return { ok: false, error: '依赖未满足：' + missed.join(', '), summary: '失败：依赖未满足 ' + missed.join(', ') }
        }
        if (!hasDepends && !task.startAfter) return { ok: false, error: '任务无依赖/无预约时间，创建时已直接派发，无需重派（如需强制可用 force=true）', summary: '失败：无依赖任务无需重派' }
      }
      if (note) task.note = (task.note ? task.note + ' | ' : '') + '手动重派(' + (force ? 'force' : 'auto') + '): ' + note.slice(0, 100)
      if (!task.orchestratorV3) task.orchestratorV3 = {}
      task.orchestratorV3.manualRedispatchCount = (task.orchestratorV3.manualRedispatchCount || 0) + 1
      task.orchestratorV3.lastManualRedispatchAt = new Date().toISOString()
      const r = await dispatchTask(task, 'tsk_force_dispatch', board, { guardRunning: false })
      if (!r.ok) return { ok: false, error: r.reason, summary: '派发失败：' + r.reason }
      return { ok: true, taskId: taskId, status: '执行中', from: from, force: force, target: (r.target && r.target.id) || null, summary: '任务「' + task.title + '」已手动重派（' + from + ' → 执行中，force=' + force + (r.target && r.target.title ? '，目标=' + r.target.title : '') + '）' }
    }
  })
  // ---- 工具：host_restart（外壳重启：请求 Harness 宿主安全重启 dsh 后端） ----
  // 外壳（Electron 主进程）启动时在 127.0.0.1:3081 开放 /api/restart：要求 HMAC-SHA256 签名
  // （salt 存于 DSH_HOME/restart-salt.txt，外壳自动生成），30s 时间戳窗口防重放；验签通过后
  // kill dsh → 800ms 后自动拉起。崩溃时外壳本身也指数退避自动拉起（5s→60s），本工具提供
  // Agent/任务插件主动受控重启的通道。taskkit 仅作为桥，不参与宿主逻辑。
  registerTool({
    name: 'host_restart',
    description: '请求外壳（Harness 宿主）重启 dsh 后端：读取 DSH_HOME/restart-salt.txt 计算 HMAC-SHA256 签名并 POST 到 127.0.0.1:3081/api/restart。当任务看板/插件状态异常、需要干净重启恢复时使用。参数：reason（重启原因，必填，记录到外壳日志）。成功后 dsh 将短暂断连并自动恢复（约 1-2s）。',
    parameters: {
      reason: { type: 'string', description: '重启原因（必填，会记录到外壳日志）', required: true }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const reason = String(args && args.reason || '').trim()
      if (!reason) return { ok: false, error: '缺少 reason', summary: '失败：缺少 reason' }
      // 1) 定位 salt 文件（与外壳 resolveDshHome 一致：DSH_HOME 优先，否则安装目录/dsh-data）
      const dshHome = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || ''
      const candidates = []
      if (dshHome) candidates.push(dshHome + '/restart-salt.txt')
      try {
        // 打包模式：dsh 运行在 <安装目录>/resources/dsh-runtime/node.exe → 上两级即安装目录
        candidates.push(resolve(dirname(process.execPath), '..', '..', 'dsh-data', 'restart-salt.txt'))
      } catch (_) {}
      let salt = null
      for (const cand of candidates) {
        try {
          if (existsSync(cand)) { salt = readFileSync(cand, 'utf8').trim(); break }
        } catch (_) {}
      }
      if (!salt) return { ok: false, error: '找不到外壳重启 salt（restart-salt.txt），请确认外壳已带重启守护启动且 DSH_HOME 正确', summary: '失败：找不到重启 salt' }
      // 2) HMAC-SHA256 签名（对齐外壳 main.js 验签算法：reason + ":" + ts）
      const ts = Date.now()
      const sig = createHmac('sha256', salt).update(reason + ':' + ts).digest('hex')
      // 3) 延迟触发：先返回确认，避免 dsh 在本工具结果送达前被杀导致对话卡在工具调用
      //    （host_restart 运行于 dsh 进程内，直接同步触发会让自身进程先被外壳 taskkill）
      const delayMs = 2500
      setTimeout(function () {
        globalThis.fetch('http://127.0.0.1:3081/api/restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ts: ts, reason: reason, sig: sig })
        }).then(function (r) { return r.text() }).then(function (t) {
          try { audit.log({ level: 'INFO', category: 'lifecycle', event: 'host.restart_requested', message: 'host restart fired after delayed trigger (tool returned first)', extra: { reason: reason, ts: ts, http: t } }) } catch (_) {}
        }).catch(function (e) {
          try { audit.log({ level: 'ERROR', category: 'lifecycle', event: 'host.restart_failed', message: 'delayed restart POST failed: ' + String(e && e.message || e), extra: { reason: reason } }) } catch (_) {}
        })
      }, delayMs)
      return { ok: true, reason: reason, summary: '已安排外壳重启 dsh（约 ' + (delayMs / 1000) + ' 秒后生效）：' + reason + '。重启将短暂断连并自动恢复，当前对话的执行会在此次重启后中断。' }
    }
  })
  // ---- 工具：tsk_newpipeline（一键创建插件开发 5 阶段子任务链） ----
  // Gate A §5/§6：设计→方案检查→实施→检查测试→经验总结，dependsOn 串联门禁；阶段 Agent 会话固定映射
  // 组长模式（leaderMode=true，仅插件开发）：只创建「根任务」派给组长（插件工坊），由组长统筹分派各阶段——
  //   任务中心不直接派发给单个阶段 Agent；组长职责=分派/确认完成/争议解决/进度控制/兜底实施。
  //   创建阶段任务的权限归组长（用 tsk_dispatch 按需创建），根任务 requirement 内嵌各阶段职责说明。
  const LEADER_ID = 'session-53c34b02-5ee1-4b23-bf44-e714a964d9d6' // 插件工坊
  registerTool({
    name: 'tsk_newpipeline',
    description: '一键创建「插件开发多Agent体系」7 阶段子任务链：设计→方案检查→实施→成果测试→检查测试→经验总结→文档更新。每个阶段一个任务，dependsOn 前置阶段（门禁强制）；阶段1 立即派发。参数：title（任务标题）、requirement（需求）、owner（默认插件工坊）、project（默认插件开发体系）、leaderMode（true=组长模式，只建根任务派给组长统筹分派，仅插件开发类使用）。',
    parameters: {
      title: { type: 'string', description: '任务标题', required: true },
      requirement: { type: 'string', description: '需求说明', required: true },
      owner: { type: 'string', description: '负责人显示名，默认插件工坊' },
      project: { type: 'string', description: '项目名，默认插件开发体系' },
      leaderMode: { type: 'boolean', description: '组长模式：true=只建根任务派给组长（插件工坊）统筹分派，false=默认全链自动派发' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, error: 'agents 服务不可用', summary: '失败：agents 服务不可用' }
      const title = String(args && args.title || '').trim()
      if (!title) return { ok: false, error: '缺少任务标题', summary: '失败：缺少任务标题' }
      const requirement = String(args && args.requirement || '').trim()
      if (!requirement) return { ok: false, error: '缺少需求说明', summary: '失败：缺少需求说明' }
      const owner = String(args && args.owner || '').trim() || '插件工坊'
      const project = String(args && args.project || '').trim() || '插件开发体系'
      const leaderMode = !!(args && args.leaderMode)
      // ============ 组长模式：只建根任务，由组长统筹分派 ============
      if (leaderMode) {
        const now = new Date().toISOString()
        const rootId = nextTaskId()
        const leaderReq = '【组长模式·插件开发工作流】你是开发工作流小组组长（插件工坊），总体负责本插件开发任务：\n' +
          '需求：' + requirement + '\n\n' +
          '【组长职责】\n' +
          '1) 分派：用 tsk_dispatch 按阶段创建并派发子任务（设计→方案检查→实施→成果测试→检查测试→经验总结→文档更新），分派给对应专用会话（插件开发·设计/方案检查/实施/成果测试/检查测试/经验总结/开发文档更新）；\n' +
          '2) 确认完成：各阶段回执后核实完成情况（看板状态/artifacts/lessons），不通过则整改或重派；\n' +
          '3) 争议解决：阶段间分歧/驳回/工具受限时裁决（如测试会话无权限实测→由你补齐运行验证）；\n' +
          '4) 进度控制：跟踪各阶段状态，卡住时诊断（调度器/会话/看板），必要时 tsk_hold/tsk_cancel/tsk_redispatch 调整；\n' +
          '5) 兜底实施：仅当专用会话无法执行（工具/权限受限）时由你亲自实施，否则不代替阶段 Agent 干活；\n' +
          '6) 收尾：经验总结+文档更新完成后，确认技术文档已落盘 ' + TOOLS_DIR_ABS + '/，标记本根任务完成。\n\n' +
          '【阶段指引】（供分派时参考，各阶段要求见《插件开发流水线_开发规则.md》）\n' +
          '- 设计：方向B 不落盘，要点写回执 lessons；\n' +
          '- 方案检查：审查通过/驳回写回执；\n' +
          '- 实施：真实代码变更，同步权威源+运行副本，语法/API/数据验证；\n' +
          '- 成果测试/检查测试：实测验证（加载/功能/持久化/幂等/无回归），不通过列失败项；\n' +
          '- 经验总结：全链 lessons 汇总写回执，注明转交文档更新；\n' +
          '- 文档更新：唯一落盘出口，技术文档写入 ' + TOOLS_DIR_ABS + '/（无文件工具的会话产出留痕由组长落盘）。\n\n' +
          '【禁止拆链】你是组长，分派用 tsk_dispatch 创建子任务即可，严禁再调用 tsk_newpipeline 拆新流水线。\n' +
          '完成后发送「📮 阶段回执」给任务中心：taskId/phase=组长统筹/result/summary。'
        const rootTask = normalizeTask({
          id: rootId,
          title: title + ' · 组长统筹',
          requirement: leaderReq,
          project: project,
          status: '待执行',
          due: null,
          repeat: null,
          owner: owner,
          assignedSession: LEADER_ID,
          note: '组长模式：由组长统筹分派各阶段（仅插件开发类）',
          startAfter: now,
          dependsOn: [],
          createdAt: now,
          updatedAt: now
        }, 0)
        rootTask.pipeline = { phase: '组长统筹', gate: null, rootTaskId: rootId, leaderMode: true }
        const { board: leaderBoard } = await readBoard()
        leaderBoard.tasks.unshift(rootTask)
        try { await writeBoard(leaderBoard) } catch (e) { return { ok: false, error: '看板写入失败：' + String(e && e.message || e), summary: '失败：看板写入失败' } }
        audit.log({ level: 'INFO', category: 'lifecycle', event: 'pipeline.leader_created', message: 'leader-mode pipeline created: ' + title, extra: { project: project, rootTaskId: rootId, leader: LEADER_ID } })
        return { ok: true, title: title, project: project, leaderMode: true, rootTaskId: rootId, summary: '已创建组长模式流水线「' + title + '」（根任务 ' + rootId + ' 派给插件工坊组长统筹分派）' }
      }
      // 阶段定义：Agent 会话 + 门禁（§5）
      const STAGES = [
        { phase: '设计',       session: '插件开发·设计',         gate: null,            hint: '\n【产出方式·方向B】本阶段不落盘 md 文档：把设计要点/关键取舍/待办写进回执 lessons（分号分隔），引用既有输入文档（artifacts 填路径，如灵感库 id 或既有设计文档）即可。' },
        { phase: '方案检查',   session: '插件开发·方案检查',     gate: 'designReviewed', hint: '\n【产出方式·方向B】本阶段不落盘 md 文档：审查结论（通过/驳回）、风险、意见写进回执 lessons；引用设计产出（artifacts 填引用）。' },
        { phase: '实施',       session: '插件开发·实施',         gate: 'designReviewed', hint: '\n【开发规则指引】实现=可验证变更，禁止纸面完成：必须产出真实代码变更（源码/配置），改动路径写入回执 artifacts；' + PLUGIN_SYNC_HINT + '，并按《插件开发流水线_开发规则.md》验证（语法/API/数据）。注：如你无插件热替工具（hotplug_reload/hotplug_status），产出代码变更草案+验证说明，由插件工坊落地热重载。\n【整改逻辑】若后续「成果测试」「检查测试」阶段回执 result=不通过，调度器会重派本阶段：先读看板任务 note 与测试回执中的失败项清单，逐项修复→同步→验证→再发「📮 阶段回执」result=completed。' },
        { phase: '成果测试',   session: '插件开发·成果测试',     gate: 'implemented',   hint: '\n【验收职责】对实施产物做真实验收，7 项强制验收项逐项核验：1加载成功 2功能可用 3热拔插验证 4持久化验证 5幂等验证 6无回归 7文档就绪。任一项不通过→回执 result=不通过 + 失败项清单（lessons，触发实施阶段整改）；全部通过→result=completed 且注明 testsPassed。本阶段不落盘测试报告，结果写回执 lessons。\n【工具使用约束·重要】插件热替请用 hotplug_* 系列工具（hotplug_reload / hotplug_status / hotplug_list / hotplug_load / hotplug_whitelist_*）——2026-09-22 由 sandbox_* 更名（sandbox 插件已拆除，能力内化进 @local/dsh-adapter）；新实现失败时会明确回报原因，且失败不会把旧插件卸掉，可直接调用。若调用异常，再把事项写进回执 lessons「待插件工坊执行」由插件工坊代为执行。涉及「热拔插验证」时：用 taskkit_ping / HTTP API（curl 或本平台等价命令）验证插件已加载与功能可用。' },
        { phase: '检查测试',   session: '插件开发·检查测试',     gate: 'testsPassed',   hint: '\n【产出方式·方向B】不落盘测试报告：语法/API/数据验证结果（含具体数字）写进回执 lessons/artifacts。' },
        { phase: '经验总结',   session: '插件开发·经验总结',     gate: 'testsPassed',   hint: '\n【输入来源】派发消息中已附【流水线经验素材】（任务中心自动汇总全链各阶段 lessons/artifacts/回执摘要）。\n【产出方式·方向B】不落盘总结文档：关键决策/踩坑/复用模式/流程改进写进回执 lessons（分号分隔，供文档更新 Agent 汇总），并在回执注明「已转交文档更新」。' },
        { phase: '文档更新',   session: '插件开发·开发文档更新', gate: 'summaryDone',   hint: '\n【输入来源】派发消息中已附【流水线经验素材】（任务中心自动汇总全链 lessons/artifacts/回执摘要/代码变更路径）。\n【文档职责·唯一落盘出口】你是流水线唯一的技术文档出口：' + describeWriteTool(typeof ctx !== 'undefined' && ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null) + ' 将最终技术文档落盘到 ' + TOOLS_DIR_ABS + '/（文件名《xxx_技术文档.md》）。内容依据全链素材汇总：需求背景/设计决策/实现说明（代码路径）/验收结果/经验教训/文档变更清单。落盘后把文件路径写进回执 artifacts。' }
      ]
      const { board } = await readBoard()
      const created = []
      let prevId = null
      const now = new Date().toISOString()
      for (let i = 0; i < STAGES.length; i++) {
        const st = STAGES[i]
        const task = normalizeTask({
          id: nextTaskId(),
          title: title + ' · ' + st.phase,
          requirement: requirement + '\n\n【阶段】' + st.phase + '\n【门禁】' + (st.gate ? '前置：' + st.gate : '无（起始阶段）') + '\n【规则0】开始前必读《插件开发规范_开发者手册.md》《插件开发流水线_开发规则.md》《工作区文件树索引.md》——源码路径/同步/热拔插/验证/防纸面完成规则都在其中。\n【禁止拆链】你收到的任务是流水线中的【' + st.phase + '】阶段任务，直接执行本阶段职责即可；严禁再次调用 tsk_newpipeline/tsk_dispatch 拆新链或派发新任务，否则视为违规。' + (st.hint || '') + '\n完成后发送「📮 阶段回执」给任务中心：taskId/phase/result/summary；回执强烈建议附 lessons（本阶段试错/踩坑/关键经验要点，分号分隔，经验总结阶段会汇总你的经验）与 artifacts（交付物文件绝对路径，逗号分隔）。',
          project: project,
          status: '待执行',
          due: null,
          repeat: null,
          owner: owner,
          assignedSession: null,
          note: 'pipeline 阶段: ' + st.phase,
          startAfter: i === 0 ? now : null, // 阶段1（设计）立即派发；后续阶段由 dependsOn 门禁触发
          dependsOn: prevId ? [prevId] : [],
          createdAt: now,
          updatedAt: now
        }, board.tasks.length)
        task.pipeline = { phase: st.phase, gate: st.gate, rootTaskId: i === 0 ? task.id : '' }
        board.tasks.unshift(task)
        created.push({ id: task.id, phase: st.phase, dependsOn: task.dependsOn })
        prevId = task.id
      }
      try { await writeBoard(board) } catch (e) {
        audit.log({ level: 'ERROR', category: 'error', event: 'error.caught', message: 'writeBoard failed in tsk_newpipeline: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), context: 'tsk_newpipeline.writeBoard' } })
        return { ok: false, error: '看板写入失败：' + String(e && e.message || e), summary: '失败：看板写入失败' }
      }
      audit.log({ level: 'INFO', category: 'lifecycle', event: 'pipeline.created', message: 'pipeline created: ' + title, extra: { project: project, stages: created.length, firstTask: created[0] && created[0].id } })
      return { ok: true, title: title, project: project, stages: created, summary: '已创建 7 阶段流水线「' + title + '」：' + created.map(function (c) { return c.phase + '(' + c.id + ')' }).join(' → ') }
    }
  })
  // ======================== 灵感库工具（S1：结构化数据模型 + host 工具）====================
  // 设计文档《灵感库可视化_设计方案.md》§五：insp_create/list/update/toggleFixed/search/saveMeeting
  /**
   * A7（2026-09-29）：`settingsRef` **写入时**存在性软告警。
   * 为什么：本库实测曾出现 **12 条 settingsRef 100% 失效**（B3 归位时把目标设定件搬走了），
   *        全靠人逐个对账才发现 ⇒ 应该在**写进库的那一刻**就提醒，而不是等有人去查。
   * 🔴 **只告警、不拒绝**（口径同 A5 的世界观键 warn）：路径可能指向"将来才建"的设定件，
   *    也可能是自由文本 ⇒ 不硬判死刑。
   * 判定口径与既有**读侧**（`insp_overview` 的 stat 验证）一致：`absOfRef(DATA_ROOT + '/' + ref, ROOT_TRAIN)` + `stat`。
   */
  async function settingsRefWarn(ref) {
    const r = String(ref === undefined || ref === null ? '' : ref).trim()
    if (!r) return ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) return ''          // URL ⇒ 不判（不是根内路径，报了就是误报）
    const miss = 'settingsRef 指向的设定文件当前不存在：' + r + '（已照常入库；若路径写错或文件已搬走，请用 insp_update 修正）'
    try {
      const target = await absOfRef(DATA_ROOT + '/' + r, ROOT_TRAIN)
      const info = await adapterFs.stat(target)
      return info ? '' : miss
    } catch (e) { return miss }
  }

  registerTool({
    name: 'insp_create',
    description: '预存灵感条目到灵感库（结构化 JSON）。参数：title（必填）、content、source、tags（逗号分隔）、oneLiner、hook、settingsRef。返回新条目。',
    parameters: {
      title: { type: 'string', description: '灵感标题', required: true },
      content: { type: 'string', description: '灵感内容/详细设定' },
      source: { type: 'string', description: '来源' },
      tags: { type: 'string', description: '标签，逗号分隔' },
      oneLiner: { type: 'string', description: '一句话灵感' },
      hook: { type: 'string', description: '钩子' },
      settingsRef: { type: 'string', description: '设定文档引用路径' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const title = String(args && args.title || '').trim()
      if (!title) return { ok: false, error: '缺少 title', summary: '失败：缺少标题' }
      // 导入类型判定（数据分离规范）：技术文档特征 → 拒绝入库，提示走技术文档库
      const probe = { title: title, source: String(args && args.source || ''), oneLiner: String(args && args.oneLiner || ''), tags: String(args && args.tags || '').split(',') }
      if (!isInspiration(probe)) {
        return { ok: false, error: '疑似技术文档/流水线产物，非创作灵感', summary: '失败：技术文档请存入 ' + TOOLS_DIR_ABS + '/技术文档库.json（灵感库仅存创作灵感）' }
      }
      const { lib } = await readInspLib()
      const tags = String(args && args.tags || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
      // W-A·A5（2026-09-29）：世界观键（U-42）缺失 / 多于一个 ⇒ **软告警、仍入库**（不硬拒；口径见手册附录 B）
      const worldWarn = worldviewWarn(tags)
      // A7（2026-09-29）：`settingsRef` 存在性**写入时**软告警（口径同 A5：只告警、不拒绝）
      const refWarn = await settingsRefWarn(String(args && args.settingsRef || '').trim())
      const warnMsg = [worldWarn, refWarn].filter(Boolean).join('；')
      const entry = normalizeInspEntry({
        title: title,
        content: String(args && args.content || '').trim(),
        source: String(args && args.source || '').trim(),
        tags: tags,
        oneLiner: String(args && args.oneLiner || '').trim(),
        hook: String(args && args.hook || '').trim(),
        settingsRef: String(args && args.settingsRef || '').trim()
      }, lib.entries.length)
      lib.entries.unshift(entry)
      try { await writeInspLib(lib) } catch (e) { return { ok: false, error: '写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'insp', event: 'insp.create', message: 'insp created: ' + title, extra: { id: entry.id, warn: warnMsg || undefined } })
      const created = { ok: true, id: entry.id, entry: entry, summary: '已预存灵感「' + title + '」（' + entry.id + '）' + (warnMsg ? '｜⚠ ' + warnMsg : '') }
      if (warnMsg) created.warn = warnMsg
      return created
    }
  })
  registerTool({
    name: 'insp_list',
    description: '查询灵感库条目（返回**逐条明细**：id / 标题 / 状态 / 世界观键 / 其他标签 / 一句话 / 钩子 / 设定引用 / 来源）。参数可选：status（预存/待讨论/已整理/已固定）、tags（逗号分隔，**整值精确** AND 语义；查灵感请先带完整世界观键，如 `世界观:原创/心渊纪元`）、tagsPrefix（**前缀**匹配；`世界观:` 可列出全部带键条目、`世界观:原创/` 可列出该大类 ⇒ 用它枚举键，因 tags 是整值匹配）、fixedOnly、q（标题/内容/标签模糊匹配）、limit（默认 ' + INSP_LIST_DEFAULT_LIMIT + '、上限 ' + INSP_LIST_MAX_LIMIT + '）、includeContent（默认 false：**只影响正文**，id/标题/标签始终返回）、includeRetired（默认 false：不含已退役条目）。固定优先排序。⚠️ 本工具只反映**库里已用的键**；合法键的取值口径见规范（作品库作品名 / 设定项目名），不确定先问、不要自造。',
    parameters: {
      status: { type: 'string', description: '状态筛选' },
      tags: { type: 'string', description: '标签筛选，逗号分隔（AND 语义，**整值精确**）；查灵感请先带完整世界观键，如 世界观:原创/心渊纪元' },
      tagsPrefix: { type: 'string', description: '标签**前缀**筛选（任意一个标签以它开头即命中）；枚举键用 世界观: ，按大类收窄用 世界观:原创/ 或 世界观:同人/ ' },
      fixedOnly: { type: 'string', description: '仅固定：true/false' },
      q: { type: 'string', description: '搜索关键词' },
      limit: { type: 'string', description: '返回条数上限，默认 ' + INSP_LIST_DEFAULT_LIMIT + '、最大 ' + INSP_LIST_MAX_LIMIT },
      includeContent: { type: 'string', description: '是否返回正文 content：true/false（默认 false；**只影响正文**，id/标题/标签始终返回）' },
      includeRetired: { type: 'string', description: '是否包含已退役条目：true/false（默认 false）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      // U-49（2026-09-30）：原来是 `(value && value.summary) ? value.summary : …` ⇒ **模型只看得到一行计数**
      //   （entries 走 presentationMeta = UI 投影，不进模型上下文）⇒ agent 拿不到 id/标题/标签。
      render: function (args, value) { return [{ type: 'text', text: renderInspListText(args, value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const { lib } = await readInspLib()
      // A4（2026-09-29）：工具侧与 HTTP 侧**可见集统一** —— 两侧均先经 isInspiration 过滤（HTTP 侧一直如此）
      let list = lib.entries.filter(isInspiration)
      if (args && args.status) { const st = String(args.status).trim(); list = list.filter(function (e) { return e.status === st }) }
      if (args && args.fixedOnly === 'true') list = list.filter(function (e) { return e.fixed })
      if (args && args.tags) { const ts = String(args.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); if (ts.length) list = list.filter(function (e) { return ts.every(function (t) { return e.tags.indexOf(t) >= 0 }) }) }
      // U-49：前缀过滤（枚举键的出口；`tags` 是整值匹配，`世界观:原创` 查不出 `世界观:原创/<项目>`）
      if (args && args.tagsPrefix) list = filterTagsPrefix(list, args.tagsPrefix)
      if (args && args.q) { const q = String(args.q).toLowerCase(); list = list.filter(function (e) { return (e.title + ' ' + e.oneLiner + ' ' + e.content + ' ' + e.tags.join(' ')).toLowerCase().indexOf(q) >= 0 }) }
      // U-44：退役条目不在 灵感库.json 内，须从 灵感库/灵感退役/ 读回并**按同样条件**过滤（默认不并）
      if (args && args.includeRetired === 'true') list = list.concat(await inspRetiredFiltered(args))
      list.sort(function (a, b) { return (b.fixed ? 1 : 0) - (a.fixed ? 1 : 0) || (a.number || '').localeCompare(b.number || '') })
      return inspListPage(list, lib.entries.length, args)
    }
  })
  registerTool({
    name: 'insp_update',
    description: '编辑灵感条目字段（title/content/source/tags/oneLiner/hook/settingsRef/status/annotations）。写 history 留痕。参数：id（必填）、patch（JSON 字符串）。',
    parameters: {
      id: { type: 'string', description: '灵感条目 id', required: true },
      patch: { type: 'string', description: 'JSON 补丁对象字符串', required: true }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const id = String(args && args.id || '').trim()
      if (!id) return { ok: false, error: '缺少 id', summary: '失败：缺少 id' }
      let patch = {}
      try { patch = JSON.parse(String(args && args.patch || '{}')) } catch (e) { return { ok: false, error: 'patch 非合法 JSON', summary: '失败：patch 非合法 JSON' } }
      const { lib } = await readInspLib()
      const entry = lib.entries.find(function (e) { return e.id === id })
      if (!entry) return { ok: false, error: '条目不存在：' + id, summary: '失败：条目不存在' }
      const now = new Date().toISOString()
      // A2（2026-09-29）：可编辑字段改用**并集真源**（原工具侧缺 category、HTTP 侧有 ⇒ 取并集后两路径同源，杜绝漂移）
      const editable = INSP_EDITABLE_FIELDS
      for (const k of editable) { if (patch[k] !== undefined) { if (entry[k] !== patch[k]) { entry.history.push({ at: now, by: '学员', field: k, before: entry[k], after: patch[k] }); entry[k] = patch[k] } } }
      if (patch.tags !== undefined) { const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); entry.history.push({ at: now, by: '学员', field: 'tags', before: entry.tags, after: tags }); entry.tags = tags }
      entry.updatedAt = now
      try { await writeInspLib(lib) } catch (e) { return { ok: false, error: '写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      // A7（2026-09-29）：patch 改了 `settingsRef` ⇒ 顺带做一次存在性**软告警**（只提醒，不回滚已写入的改动）
      const uWarn = (patch.settingsRef !== undefined) ? await settingsRefWarn(entry.settingsRef) : ''
      audit.log({ level: 'INFO', category: 'insp', event: 'insp.update', message: 'insp updated: ' + entry.title, extra: { id: id, warn: uWarn || undefined } })
      // U-53（2026-09-30）：🔴 **工具返回值绝不能带 `undefined` 值属性** —— 宿主 `snapshotToolValue()`
      //   （`dsh-tools/lib/types/index.js:106-118`）会对返回值做"**无损 JSON**"快照，任何 `undefined` 值属性
      //   都会让它失败并报：`tool "insp_update" returned invalid output: value is not lossless JSON`。
      //   原写法 `warn: uWarn || undefined` 在**无告警**（绝大多数情况）时正好产生 `warn: undefined`
      //   ⇒ **每一次 insp_update 调用都失败**（真机报错即此）。
      //   `insp_create` 用的是条件赋值 ⇒ 它一直没事 ⇒ 本条按同一写法对齐。
      const updated = { ok: true, id: id, entry: entry, summary: '已更新灵感「' + entry.title + '」' + (uWarn ? '｜⚠ ' + uWarn : '') }
      if (uWarn) updated.warn = uWarn
      return updated
    }
  })
  registerTool({
    name: 'insp_toggleFixed',
    description: '固定/取消固定灵感条目。固定后列表置顶、检索优先，状态可同步置「已固定」。参数：id（必填）。',
    parameters: {
      id: { type: 'string', description: '灵感条目 id', required: true }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const id = String(args && args.id || '').trim()
      if (!id) return { ok: false, error: '缺少 id', summary: '失败：缺少 id' }
      const { lib } = await readInspLib()
      const entry = lib.entries.find(function (e) { return e.id === id })
      if (!entry) return { ok: false, error: '条目不存在：' + id, summary: '失败：条目不存在' }
      entry.fixed = !entry.fixed
      if (entry.fixed) entry.status = '已固定'
      entry.updatedAt = new Date().toISOString()
      entry.history.push({ at: entry.updatedAt, by: '学员', field: 'fixed', before: !entry.fixed, after: entry.fixed })
      try { await writeInspLib(lib) } catch (e) { return { ok: false, error: '写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'insp', event: 'insp.fixed', message: 'insp fixed=' + entry.fixed + ': ' + entry.title, extra: { id: id } })
      return { ok: true, id: id, fixed: entry.fixed, summary: (entry.fixed ? '已固定' : '已取消固定') + '「' + entry.title + '」' }
    }
  })
  registerTool({
    name: 'insp_search',
    description: '检索灵感条目（供创作教练调取；返回**逐条明细**：id / 标题 / 状态 / 世界观键 / 其他标签 / 一句话 / 钩子 / 设定引用 / 来源）。参数：query、tags（逗号分隔，**整值精确** AND 语义；查灵感请先带完整世界观键）、tagsPrefix（**前缀**匹配；`世界观:` 列出全部带键条目 ⇒ 用它枚举键）、fixedOnly、status、limit（默认 ' + INSP_LIST_DEFAULT_LIMIT + '、上限 ' + INSP_LIST_MAX_LIMIT + '）、includeContent（默认 false：**只影响正文**，id/标题/标签始终返回）、includeRetired（默认 false）。固定优先、已整理优先排序。',
    parameters: {
      query: { type: 'string', description: '关键词（标题/内容/标签）' },
      tags: { type: 'string', description: '标签筛选，逗号分隔（AND 语义，**整值精确**）；查灵感请先带完整世界观键，如 世界观:同人/星穹铁道' },
      tagsPrefix: { type: 'string', description: '标签**前缀**筛选（任意一个标签以它开头即命中）；枚举键用 世界观: ，按大类收窄用 世界观:原创/ 或 世界观:同人/ ' },
      fixedOnly: { type: 'string', description: '仅固定：true/false' },
      status: { type: 'string', description: '状态筛选' },
      limit: { type: 'string', description: '返回条数上限，默认 ' + INSP_LIST_DEFAULT_LIMIT + '、最大 ' + INSP_LIST_MAX_LIMIT },
      includeContent: { type: 'string', description: '是否返回正文 content：true/false（默认 false；**只影响正文**，id/标题/标签始终返回）' },
      includeRetired: { type: 'string', description: '是否包含已退役条目：true/false（默认 false）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      // U-49（2026-09-30）：同 insp_list —— 原 `summary`-only 渲染让模型看不到明细
      render: function (args, value) { return [{ type: 'text', text: renderInspListText(args, value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const { lib } = await readInspLib()
      // A4（2026-09-29）：与 HTTP 侧可见集统一（同 insp_list）
      let list = lib.entries.filter(isInspiration)
      if (args && args.fixedOnly === 'true') list = list.filter(function (e) { return e.fixed })
      if (args && args.status) list = list.filter(function (e) { return e.status === String(args.status).trim() })
      if (args && args.tags) { const ts = String(args.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); if (ts.length) list = list.filter(function (e) { return ts.every(function (t) { return e.tags.indexOf(t) >= 0 }) }) }
      // U-49：前缀过滤（同 insp_list；`query` 也认 tags 文本，但只有前缀过滤能"按大类/按键枚举"）
      if (args && args.tagsPrefix) list = filterTagsPrefix(list, args.tagsPrefix)
      if (args && args.query) { const q = String(args.query).toLowerCase(); list = list.filter(function (e) { return (e.title + ' ' + e.oneLiner + ' ' + e.content + ' ' + e.tags.join(' ')).toLowerCase().indexOf(q) >= 0 }) }
      if (args && args.includeRetired === 'true') list = list.concat(await inspRetiredFiltered(args))
      list.sort(function (a, b) { return (b.fixed ? 2 : 0) + (b.status === '已整理' ? 1 : 0) - ((a.fixed ? 2 : 0) + (a.status === '已整理' ? 1 : 0)) })
      return inspListPage(list, lib.entries.length, args, '检索到')
    }
  })
  registerTool({
    name: 'insp_saveMeeting',
    description: '保存灵感会议成果到条目（meeting.output/decisions/date/taskId），状态「待讨论→已整理」。参数：entryIds（逗号分隔）、output、decisions、taskId、date。',
    parameters: {
      entryIds: { type: 'string', description: '灵感条目 id 列表，逗号分隔', required: true },
      output: { type: 'string', description: '会议成果/纪要', required: true },
      decisions: { type: 'string', description: '决议（主攻/备选/冻结）' },
      taskId: { type: 'string', description: '关联任务 id' },
      date: { type: 'string', description: '会议日期' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const ids = String(args && args.entryIds || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
      if (!ids.length) return { ok: false, error: '缺少 entryIds', summary: '失败：缺少 entryIds' }
      const output = String(args && args.output || '').trim()
      if (!output) return { ok: false, error: '缺少 output', summary: '失败：缺少会议成果' }
      const { lib } = await readInspLib()
      const now = new Date().toISOString()
      let updated = 0
      for (const id of ids) {
        const entry = lib.entries.find(function (e) { return e.id === id })
        if (!entry) continue
        entry.meeting = { taskId: String(args && args.taskId || '').trim(), date: String(args && args.date || new Date().toISOString().slice(0, 10)), output: output, decisions: String(args && args.decisions || '').trim() }
        if (entry.status === '待讨论') { entry.status = '已整理' }
        entry.updatedAt = now
        entry.history.push({ at: now, by: '教练', field: 'meeting.output', before: '', after: output.slice(0, 80) })
        updated++
      }
      try { await writeInspLib(lib) } catch (e) { return { ok: false, error: '写入失败：' + String(e && e.message || e), summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'insp', event: 'insp.meeting_saved', message: 'meeting saved for ' + updated + ' entries', extra: { ids: ids, taskId: String(args && args.taskId || '') } })
      return { ok: true, updated: updated, summary: '已保存会议成果到 ' + updated + ' 条灵感' }
    }
  })
  // ============ U-44 / W-A·A1（2026-09-29）：灵感退役 / 复原 / 退役清单（对齐 memory-system 形状）============
  registerTool({
    name: 'insp_retire',
    description: '退役（**软删**，不销毁数据）灵感条目：条目移入 灵感库/灵感退役/<id>.json（与退役前逐字节一致），并在 灵感库/退役清单.json 记一行。退役后 insp_list/insp_search **默认不再返回**它，可用 insp_restore 复原。参数：id（必填）、reason（可选）。',
    parameters: {
      id: { type: 'string', description: '灵感条目 id', required: true },
      reason: { type: 'string', description: '退役原因（可选，记入清单）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    // 薄接线：与 HTTP 侧 /taskkit/api/insp/retire 同调 doInspRetire（单一实现，杜绝两处漂移）
    execute: async function (args) { const r = await doInspRetire(args); return r.body }
  })
  registerTool({
    name: 'insp_restore',
    description: '复原（撤销退役）灵感条目：把 灵感库/灵感退役/<id>.json 搬回灵感库，`tags`/`history`/`settingsRef` 逐字段不变。库中已有同 id ⇒ 拒绝（禁止覆盖）。参数：id（必填）。',
    parameters: {
      id: { type: 'string', description: '灵感条目 id', required: true }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    // 薄接线：与 HTTP 侧 /taskkit/api/insp/restore 同调 doInspRestore（单一实现）
    execute: async function (args) { const r = await doInspRestore(args); return r.body }
  })
  registerTool({
    name: 'insp_retiredList',
    description: '已退役灵感清单（**只读**投影；形状对齐 memory-system 的归档清单）。参数：includeRestored（默认 true：含已复原的行）。返回 count/active/restored/entries。',
    parameters: {
      includeRestored: { type: 'string', description: '是否包含已复原的行：true/false（默认 true）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    // 薄接线：与 HTTP 侧 /taskkit/api/insp/retiredList 同调 doInspRetiredList（单一实现）
    execute: async function (args) { const r = await doInspRetiredList(args); return r.body }
  })
  // ======================== 灵感库 HTTP API（client UI 调用，设计文档 §五）====================
  // webServer.register({ kind: 'prefix', path: '/taskkit/api/insp', handler }) — JSON 响应（O5 §2.2 行 47：kind 已归一到宿主规范值）
  try {
    const ws = ctx.get('webServer')
    if (ws && typeof ws.register === 'function') {
      const apiHandler = async function (req, res) {
        const u = new URL(req.url || '/', 'http://x')
        const parts = u.pathname.split('/').filter(Boolean)
        // /taskkit/api/insp/<action>
        const action = parts.length >= 4 ? parts[3] : ''
        const send = function (status, obj) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(obj))
        }
        let body = ''
        try { for await (const chunk of req) body += chunk } catch (e) {}
        let args = {}
        if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
        try {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const q = u.searchParams
            args = { query: q.get('query') || '', tags: q.get('tags') || '', fixedOnly: q.get('fixedOnly') || '', status: q.get('status') || '', q: q.get('q') || '' }
          }
          if (action === 'list' || action === 'search') {
            const { lib } = await readInspLib()
            // 过滤非灵感条目（技术文档等混入），只展示真正灵感
            let list = lib.entries.filter(isInspiration)
            if (args.status) list = list.filter(function (e) { return e.status === String(args.status) })
            if (args.fixedOnly === 'true') list = list.filter(function (e) { return e.fixed })
            if (args.tags) { const ts = String(args.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); if (ts.length) list = list.filter(function (e) { return ts.every(function (t) { return e.tags.indexOf(t) >= 0 }) }) }
            const kw = String(args.query || args.q || '').toLowerCase()
            if (kw) list = list.filter(function (e) { return (e.title + ' ' + e.oneLiner + ' ' + e.content + ' ' + e.tags.join(' ')).toLowerCase().indexOf(kw) >= 0 })
            list.sort(function (a, b) { return (b.fixed ? 2 : 0) + (b.status === '已整理' ? 1 : 0) - ((a.fixed ? 2 : 0) + (a.status === '已整理' ? 1 : 0)) })
            send(200, { ok: true, count: list.length, total: lib.entries.length, filtered: lib.entries.length - list.length, entries: list })
          } else if (action === 'create') {
            if (!args.title) return send(400, { ok: false, error: '缺少 title' })
            const { lib } = await readInspLib()
            const tagList = Array.isArray(args.tags) ? args.tags : String(args.tags || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
            // A5（2026-09-29）：与工具侧 insp_create 同口径 —— 世界观键缺失/多于一个 ⇒ 软告警（仍入库）
            const worldWarn = worldviewWarn(tagList)
            // A7（2026-09-29）：HTTP 侧**也要**做 settingsRef 存在性软告警（与工具侧 insp_create 同口径；
            //   本批首次验收正是漏了这处、由"① create 应同时报两条 warn"抓出来的）
            const refWarn = await settingsRefWarn(String(args.settingsRef || '').trim())
            const warnMsg = [worldWarn, refWarn].filter(Boolean).join('；')
            const entry = normalizeInspEntry({ title: args.title, content: args.content || '', source: args.source || '', tags: tagList, oneLiner: args.oneLiner || '', hook: args.hook || '', settingsRef: args.settingsRef || '', category: args.category || '' }, lib.entries.length)
            lib.entries.unshift(entry)
            await writeInspLib(lib)
            send(200, { ok: true, id: entry.id, entry: entry, warn: warnMsg || undefined })
          } else if (action === 'update') {
            if (!args.id) return send(400, { ok: false, error: '缺少 id' })
            const patch = args.patch || {}
            const { lib } = await readInspLib()
            const entry = lib.entries.find(function (e) { return e.id === args.id })
            if (!entry) return send(404, { ok: false, error: '条目不存在' })
            const now = new Date().toISOString()
            // A2（2026-09-29）：与工具侧同用**并集真源**（原两处各写一份 ⇒ 工具侧漏了 category；现同源）
            const editable = INSP_EDITABLE_FIELDS
            for (const k of editable) { if (patch[k] !== undefined && entry[k] !== patch[k]) { entry.history.push({ at: now, by: '学员', field: k, before: entry[k], after: patch[k] }); entry[k] = patch[k] } }
            if (patch.tags !== undefined) { const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(',').map(function (s) { return s.trim() }).filter(Boolean); entry.history.push({ at: now, by: '学员', field: 'tags', before: entry.tags, after: tags }); entry.tags = tags }
            entry.updatedAt = now
            await writeInspLib(lib)
            // A7（2026-09-29）：patch 改了 `settingsRef` ⇒ 存在性**软告警**（与工具侧同口径）
            const uWarn2 = (patch.settingsRef !== undefined) ? await settingsRefWarn(entry.settingsRef) : ''
            send(200, { ok: true, id: args.id, entry: entry, warn: uWarn2 || undefined })
          } else if (action === 'toggleFixed') {
            if (!args.id) return send(400, { ok: false, error: '缺少 id' })
            const { lib } = await readInspLib()
            const entry = lib.entries.find(function (e) { return e.id === args.id })
            if (!entry) return send(404, { ok: false, error: '条目不存在' })
            entry.fixed = !entry.fixed
            if (entry.fixed) entry.status = '已固定'
            entry.updatedAt = new Date().toISOString()
            entry.history.push({ at: entry.updatedAt, by: '学员', field: 'fixed', before: !entry.fixed, after: entry.fixed })
            await writeInspLib(lib)
            send(200, { ok: true, id: args.id, fixed: entry.fixed })
          } else if (action === 'saveMeeting') {
            const ids = String(args.entryIds || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
            if (!ids.length) return send(400, { ok: false, error: '缺少 entryIds' })
            if (!args.output) return send(400, { ok: false, error: '缺少 output' })
            const { lib } = await readInspLib()
            const now = new Date().toISOString()
            let updated = 0
            for (const id of ids) {
              const entry = lib.entries.find(function (e) { return e.id === id })
              if (!entry) continue
              entry.meeting = { taskId: String(args.taskId || ''), date: String(args.date || now.slice(0, 10)), output: args.output, decisions: String(args.decisions || '') }
              if (entry.status === '待讨论') entry.status = '已整理'
              entry.updatedAt = now
              entry.history.push({ at: now, by: '教练', field: 'meeting.output', before: '', after: String(args.output).slice(0, 80) })
              updated++
            }
            await writeInspLib(lib)
            send(200, { ok: true, updated: updated })
          } else if (action === 'category') {
            // 创作资源库 v1：设置/清除灵感归类（主攻/备选/冻结/待启动）
            if (!args.id) return send(400, { ok: false, error: '缺少 id' })
            const cat = String(args.category || '')
            if (cat && ['主攻','备选','冻结','待启动'].indexOf(cat) < 0) return send(400, { ok: false, error: '非法归类: ' + cat })
            const { lib } = await readInspLib()
            const entry = lib.entries.find(function (e) { return e.id === args.id })
            if (!entry) return send(404, { ok: false, error: '灵感不存在: ' + args.id })
            entry.category = cat || '待启动'
            entry.updatedAt = new Date().toISOString()
            await writeInspLib(lib)
            send(200, { ok: true, id: entry.id, category: entry.category })
          } else if (action === 'overview') {
            // 创作资源库 v1：总览 = 归类分组 + 灵感↔草稿↔状态关联
            // 注：dsh-fs 无目录列举 API，草稿关联改用「写作记录 lastFile + settingsRef 设定文件 stat 验证 + 工作区草稿目录已知文件」三源
            const { lib } = await readInspLib()
            const record = await readJsonFile(WRITING_RECORD_REL, { lastFile: '' })
            const draftNames = await collectDrafts()
            const lastFile = (record && record.lastFile) ? record.lastFile : ''
            const groups = { '主攻': [], '备选': [], '冻结': [], '待启动': [] }
            // 预先异步验证各灵感的 settingsRef 设定文件存在性（dsh-fs 无目录列举，改用 stat 验证）
            const refExists = {}
            for (let ri = 0; ri < lib.entries.length; ri++) {
              const ref = lib.entries[ri].settingsRef
              if (!ref) continue
              try {
                const refTarget = await absOfRef(DATA_ROOT + '/' + ref, ROOT_TRAIN)
                const refInfo = await adapterFs.stat(refTarget)
                refExists[ref] = !!refInfo
              } catch (e2) { refExists[ref] = false }
            }
            lib.entries.forEach(function (e) {
              const cat = e.category || '待启动'
              const related = []
              // 关联草稿：文件名含灵感标题关键词 或 settingsRef 指向灵感库文件
              const kw = (e.title || '').replace(/[《》#0123456789\s]/g, '')
              const refBase = String(e.settingsRef || '').split('/').pop().replace(/\.md$/i, '')
              for (let di = 0; di < draftNames.length; di++) {
                const dn = draftNames[di]
                const hit = (kw && kw.length >= 2 && dn.indexOf(kw) >= 0) || (refBase && refBase.length >= 2 && dn.indexOf(refBase) >= 0)
                if (hit) related.push(dn)
              }
              if (e.settingsRef && refExists[e.settingsRef]) related.push('ref:' + e.settingsRef)
              groups[cat].push({ id: e.id, title: e.title, status: e.status, fixed: e.fixed, oneLiner: e.oneLiner, hook: e.hook, settingsRef: e.settingsRef, tags: e.tags, category: cat, drafts: related, updatedAt: e.updatedAt })
            })
            send(200, { ok: true, total: lib.entries.length, groups: groups, draftCount: draftNames.length, updatedAt: new Date().toISOString() })
          } else if (action === 'retire') {
            // U-44（W-A·A1）：退役（软删）—— 与工具侧 insp_retire **同调 doInspRetire**（写类 ⇒ 需 POST）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r1 = await doInspRetire(args)
            send(r1.status, r1.body)
          } else if (action === 'restore') {
            // U-44：复原 —— 与工具侧 insp_restore **同调 doInspRestore**（写类 ⇒ 需 POST）
            if (req.method !== 'POST') return send(405, { ok: false, error: '需要 POST' })
            const r2 = await doInspRestore(args)
            send(r2.status, r2.body)
          } else if (action === 'retiredList') {
            // U-44：退役清单只读投影 —— 与工具侧 insp_retiredList **同调 doInspRetiredList**
            const r3 = await doInspRetiredList(args)
            send(r3.status, r3.body)
          } else {
            send(404, { ok: false, error: '未知 action: ' + action, actions: INSP_HTTP_ACTIONS })
          }
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message || e) })
        }
      }
      ctx.effect(function () {
        // O5 §2.2 行 47 路由归一（③④ 之处）：kind 取宿主规范值 'prefix'（WebRouteKind='exact'|'prefix'；
        // 宿主 register() 对非 'exact' 一律送前缀表 ⇒ 与本插件此前 as-built 的类型外取值注册结果等价）；path/handler 不变。
        const dInsp = ws.register({ kind: 'prefix', path: '/taskkit/api/insp', handler: apiHandler })
        const dCre = ws.register({ kind: 'prefix', path: '/taskkit/api/crelib', handler: apiHandler })
        return function () { try { dInsp() } catch (e) {} try { dCre() } catch (e) {} }
      })
      audit.log({ level: 'INFO', category: 'insp', event: 'insp.api.ready', message: '/taskkit/api/insp/* + /taskkit/api/crelib/* registered', extra: {} })
    }
  } catch (e) {
    audit.log({ level: 'WARN', category: 'insp', event: 'insp.api.failed', message: 'insp api register failed: ' + String(e && e.message || e), extra: {} })
  }

    // ======================== 写作成果可视化 HTTP API ========================
    // 端点：/taskkit/api/writing/overview | /drafts | /draft?name=xxx | /schedule
    try {
      const ws = ctx.get('webServer')
      if (ws && typeof ws.register === 'function') {
        const writingHandler = async function (req, res) {
          const u = new URL(req.url || '/', 'http://x')
          const parts = u.pathname.split('/').filter(Boolean)
          const action = parts.length >= 4 ? parts[3] : ''
          const send = function (status, obj) {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify(obj))
          }
          try {
            if (action === 'overview') {
              const record = await readJsonFile(WRITING_RECORD_REL, { version: 1, days: {}, totalWords: 0, streak: 0, reminders: [], lastSavedAt: '', lastFile: '' })
              const days = (record && record.days && typeof record.days === 'object') ? record.days : {}
              const dayKeys = Object.keys(days).sort()
              const daily = dayKeys.map(function (k) { return { date: k, words: Number(days[k].words || 0), entries: Number(days[k].entries || 0) } })
              const weeklyMap = {}
              for (const d of daily) { const wk = isoWeekKey(d.date); weeklyMap[wk] = (weeklyMap[wk] || 0) + d.words }
              const weekly = Object.keys(weeklyMap).sort().map(function (k) { return { week: k, words: weeklyMap[k] } })
              const drafts = await listDraftFiles()
              const saveLogText = await readTextFile(SAVE_LOG_REL, '')
              let saveCount = 0
              let saveWords = 0
              if (saveLogText) {
                const lines = saveLogText.split('\n')
                for (const line of lines) {
                  try {
                    const obj = JSON.parse(line)
                    if (obj && obj.event === 'save-result' && obj.ok) { saveCount++; saveWords += Number(obj.words || 0) }
                  } catch (e) {}
                }
              }
              const plan = await readJsonFile(SCHEDULE_PLAN_REL, { weeks: [] })
              const done = await readJsonFile(SCHEDULE_DONE_REL, { startDate: '', done: {} })
              const totalPlanDays = (plan && Array.isArray(plan.weeks) ? plan.weeks : []).reduce(function (acc, w) { return acc + (Array.isArray(w.days) ? w.days.length : 0) }, 0)
              const doneMap = (done && done.done && typeof done.done === 'object') ? done.done : {}
              const doneCount = Object.keys(doneMap).filter(function (k) { return doneMap[k] === true }).length
              send(200, {
                ok: true,
                record: { totalWords: Number(record.totalWords || 0), streak: Number(record.streak || 0), checkins: dayKeys.length, lastSavedAt: record.lastSavedAt || '', lastFile: record.lastFile || '' },
                daily: daily,
                weekly: weekly,
                drafts: { total: drafts.length, recent: drafts.slice(0, 5) },
                saveLog: { count: saveCount, words: saveWords },
                schedule: { totalDays: totalPlanDays, doneDays: doneCount, percent: totalPlanDays ? Math.round(doneCount / totalPlanDays * 100) : 0 },
                summary: '写作数据：总字数 ' + (record.totalWords || 0) + '，连续 ' + (record.streak || 0) + ' 天，打卡 ' + dayKeys.length + ' 天，草稿 ' + drafts.length + ' 篇'
              })
            } else if (action === 'drafts') {
              const drafts = await listDraftFiles()
              send(200, { ok: true, count: drafts.length, drafts: drafts })
            } else if (action === 'draft') {
              const name = u.searchParams.get('name') || ''
              const draft = await readDraftFile(name)
              if (!draft) return send(404, { ok: false, error: '草稿不存在' })
              send(200, { ok: true, name: draft.name, text: draft.text, words: countWords(draft.text) })
            } else if (action === 'schedule') {
              const plan = await readJsonFile(SCHEDULE_PLAN_REL, { weeks: [] })
              const done = await readJsonFile(SCHEDULE_DONE_REL, { startDate: '', done: {} })
              const doneMap = (done && done.done && typeof done.done === 'object') ? done.done : {}
              const weeks = (plan && Array.isArray(plan.weeks) ? plan.weeks : []).map(function (w, wi) {
                const days = Array.isArray(w.days) ? w.days.map(function (d, di) {
                  const key = 'w' + wi + 'd' + di
                  return { key: key, label: d.label || '', done: doneMap[key] === true }
                }) : []
                const doneCount = days.filter(function (d) { return d.done }).length
                return { title: w.title || '', days: days, doneCount: doneCount, totalCount: days.length }
              })
              const total = weeks.reduce(function (acc, w) { return acc + w.totalCount }, 0)
              const doneTotal = weeks.reduce(function (acc, w) { return acc + w.doneCount }, 0)
              send(200, { ok: true, startDate: done.startDate || '', weeks: weeks, totalDays: total, doneDays: doneTotal, percent: total ? Math.round(doneTotal / total * 100) : 0 })
            } else if (action === 'plan') {
              const planText = await readTextFile(TRAINING_PLAN_REL, '')
              const handbookText = await readTextFile(TECH_HANDBOOK_REL, '')
              const reviewText = await readTextFile(REVIEW_TEMPLATE_REL, '')
              send(200, { ok: true, trainingPlan: planText, handbook: handbookText, reviewTemplate: reviewText })
            } else {
              send(404, { ok: false, error: '未知 action: ' + action, actions: ['overview', 'drafts', 'draft', 'schedule', 'plan'] })
            }
          } catch (e) {
            send(500, { ok: false, error: String(e && e.message || e) })
          }
        }
        ctx.effect(function () { return ws.register({ kind: 'prefix', path: '/taskkit/api/writing', handler: writingHandler }) })
        audit.log({ level: 'INFO', category: 'writing', event: 'writing.api.ready', message: '/taskkit/api/writing/* registered', extra: {} })
      }
    } catch (e) {
      audit.log({ level: 'WARN', category: 'writing', event: 'writing.api.failed', message: 'writing api register failed: ' + String(e && e.message || e), extra: {} })
    }

    // ======================== 全能写作工作台：草稿↔灵感/资源关联 API ========================
    // 端点：/taskkit/api/relations/list | /taskkit/api/relations/update | /taskkit/api/relations/delete
    //   （delete 为 U-7 / T1b 新增：为 writing-studio 的 detach 迁移提供删除动作；list/update 形状不变）
    try {
      const ws = ctx.get('webServer')
      if (ws && typeof ws.register === 'function') {
        const relationsHandler = async function (req, res) {
          const u = new URL(req.url || '/', 'http://x')
          const parts = u.pathname.split('/').filter(Boolean)
          const action = parts.length >= 4 ? parts[3] : ''
          const send = function (status, obj) {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify(obj))
          }
          let body = ''
          try { for await (const chunk of req) body += chunk } catch (e) {}
          let args = {}
          if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
          try {
            if (action === 'list') {
              const relations = await readRelations()
              const drafts = await listDraftFiles()
              const { lib } = await readInspLib()
              const draftNames = drafts.map(function (d) { return d.name })
              const byInsp = {}
              for (const e of lib.entries) {
                const related = []
                for (const dn of draftNames) {
                  const rel = relations.relations[dn]
                  if (rel && (rel.refInspId === e.id || rel.refResourceId === e.id)) related.push(dn)
                }
                if (related.length) byInsp[e.id] = related
              }
              send(200, { ok: true, relations: relations.relations, drafts: drafts, byInsp: byInsp, total: Object.keys(relations.relations || {}).length })
            } else if (action === 'update') {
              const draft = String(args.draft || '').trim()
              if (!draft) return send(400, { ok: false, error: '缺少 draft' })
              const relations = await readRelations()
              relations.relations[draft] = {
                type: ['灵感衍生', '训练产出', '自由写作'].indexOf(args.type) >= 0 ? args.type : '自由写作',
                refInspId: String(args.refInspId || ''),
                refResourceId: String(args.refResourceId || ''),
                note: String(args.note || '')
              }
              await writeRelations(relations)
              send(200, { ok: true, draft: draft, relation: relations.relations[draft] })
            } else if (action === 'delete') {
              // U-7 / T1b（2026-09-28 新增）：删除某草稿的关联（幂等 —— 键不存在时 removed:false 且不报错）。
              // 入参 {draft}（必填，非空字符串）；缺 draft ⇒ 400。语义 = 纯模块 deleteRelation（本地真单测）。
              const d = normalizeDraftArg(args.draft)
              if (!d.ok) return send(400, { ok: false, error: d.error })
              const relations = await readRelations()
              const out = deleteRelation(relations.relations, d.draft)
              if (out.removed) {
                relations.relations = out.relations
                await writeRelations(relations)
              }
              send(200, { ok: true, draft: d.draft, removed: out.removed })
            } else {
              send(404, { ok: false, error: '未知 action: ' + action, actions: RELATIONS_ACTIONS })
            }
          } catch (e) {
            send(500, { ok: false, error: String(e && e.message || e) })
          }
        }
        ctx.effect(function () { return ws.register({ kind: 'prefix', path: '/taskkit/api/relations', handler: relationsHandler }) })
        audit.log({ level: 'INFO', category: 'writing-studio', event: 'relations.api.ready', message: '/taskkit/api/relations/* registered', extra: {} })
      }
    } catch (e) {
      audit.log({ level: 'WARN', category: 'writing-studio', event: 'relations.api.failed', message: 'relations api register failed: ' + String(e && e.message || e), extra: {} })
    }



  // ---- 工具：tsk_archive（归档会话：workspaceRegistry.archiveSession + 标题[已归档]前缀）----
  registerTool({
    name: 'tsk_archive',
    description: '归档会话（移出侧栏/不可被派发）：调用 workspaceRegistry.archiveSession + sessionTitle 重命名「[已归档]」前缀。入参 sessionIds（逗号分隔或 JSON 数组）、rename（默认 true）。返回处理结果列表。🔴 U-50（2026-09-30）三项口径更正：① **归档态以 workspaceRegistry.archivedSessionIds 为权威**，标题前缀只是**视觉提示**，判断"是否已归档"一律读归档集、不要猜标题；② 成功判定改为用该归档集**复核**，不再"promise 没抛就算成功"；③ 🔴 **改名只对 live 会话可行**（宿主 `sessionTitle.rename(session, title)` 要求传入 live 会话对象，非 live 抛 `is not live in this store`）⇒ **冷会话改不了名**，此时会如实报"跳过（非 live）"而不是假装成功。归档失败 / 改名被跳过**一律给出原因**；`ok` 表示"**无失败项**"，不再恒 true。',
    parameters: {
      sessionIds: { type: 'string', description: '会话 id 列表（逗号分隔或 JSON 数组字符串）', required: true },
      rename: { type: 'string', description: '是否重命名加前缀：true/false，默认 true' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      let ids = []
      const raw = String(args && args.sessionIds || '').trim()
      if (!raw) return { ok: false, error: '缺少 sessionIds', summary: '失败：缺少 sessionIds' }
      if (raw.startsWith('[')) { try { const arr = JSON.parse(raw); if (Array.isArray(arr)) ids = arr.filter(function (s) { return typeof s === 'string' }) } catch (e) {} }
      else ids = raw.split(',').map(function (s) { return s.trim() }).filter(Boolean)
      if (!ids.length) return { ok: false, error: '无有效 sessionId', summary: '失败：无有效 sessionId' }
      const doRename = !(args && args.rename === 'false')
      const wr = ctx.get('workspaceRegistry')
      const st = ctx.get('sessionTitle')
      const agents = ctx.get('agents')
      const results = []
      const note = function (rec, msg) { rec.skipped = rec.skipped ? rec.skipped + '；' + msg : msg }
      for (let i = 0; i < ids.length; i++) {
        const sid = ids[i]
        const rec = { sessionId: sid, archived: false, renamed: false, skipped: '', error: '' }
        // ① 归档 —— U-50（F-2）：原版三处静默（wr 缺失 / 无 archiveSession 接口 / 无效 id 全无声），
        //    且以"promise 没抛"当成功 ⇒ 会报"成功"却什么都没做。现改为：留痕 + 用宿主归档集**真验证**。
        try {
          if (!wr) { rec.error = 'workspaceRegistry 服务不可用 ⇒ 未归档' }
          else {
            let fn = null
            const list = typeof wr.list === 'function' ? wr.list() : []
            for (let w = 0; w < list.length; w++) {
              const wsRec = list[w]
              if (wsRec && typeof wsRec.archiveSession === 'function') { fn = function () { return wsRec.archiveSession(sid) }; break }
            }
            if (!fn && typeof wr.archiveSession === 'function') fn = function () { return wr.archiveSession(sid) }
            if (!fn) { rec.error = '未找到 archiveSession 接口（服务形状不符）⇒ 未归档' }
            else {
              await fn()
              const after = archivedIds()
              if (after.ok) {
                rec.archived = after.ids.indexOf(String(sid)) >= 0
                if (!rec.archived) rec.error = 'archiveSession 已返回，但该 id **不在**宿主归档集中（未生效 / 无此会话）'
              } else { rec.archived = true; note(rec, '归档集不可读 ⇒ 未能复核：' + after.reason) }
            }
          }
        } catch (e) { rec.error = String(e && e.message || e) }
        // ② 改名 —— U-50b（2026-09-30，真机查证后修正根因）：
        //   原实现**双重错**，所以改名**从未生效过一次**（实测：405 条归档会话里带 `[已归档]` 前缀的 = **0**）：
        //     · 读：调用 `sessionTitle.readTitle` —— 该服务**没有这个方法**（宿主 dsh-session-title 里 `readTitle` 出现 0 次）
        //           ⇒ 每次抛错被吞 ⇒ title 恒空 ⇒ 静默跳过（这才是 agent 报的"空标题静默跳过"的真根因）
        //     · 写：`rename(sid, …)` 传的是**字符串 id**，而宿主签名是 `rename(session, title)`，且校验
        //           `ctx.sessions.get(session.id) === session` ⇒ 非 live 必抛 `is not live in this store`
        //   正确口径（本文件已有先例：`tsk_newconversation` 用 `sessionTitle.rename(agent.session, title)`）：
        //     · 读 ⇒ `sessionQuery.readTitle(id)`（即本文件的 `titleOf()`，全插件同口径）
        //     · 写 ⇒ `sessionTitle.rename(liveSession, title)`
        //   ⚠️ 由此推出一条**架构性事实**：**冷会话改不了名**（rename 只接受 live 会话对象）
        //     ⇒ 「归档态」的权威判据永远是 `workspaceRegistry.archivedSessionIds`，**不是标题前缀**；
        //        前缀只是 live 时的视觉提示（见 tsk_sessions 读归档集的做法）。
        try {
          if (!doRename) note(rec, 'rename=false ⇒ 未改名')
          else if (!st || typeof st.rename !== 'function') note(rec, 'sessionTitle 服务不可用 ⇒ 未改名')
          else {
            const liveAg = agents ? agents.get(sid) : null
            const sess = liveAg && liveAg.session
            if (!sess) note(rec, '会话非 live ⇒ 跳过改名（宿主约束：rename 只接受 live 会话对象；归档态请以 archivedSessionIds 为准，不依赖标题前缀）')
            else {
              const cur = await titleOf(sid, true)
              if (!cur) note(rec, '读不到标题（sessionQuery.readTitle 为空）⇒ 跳过改名')
              else if (cur.indexOf('[已归档]') >= 0) note(rec, '标题已有 [已归档] 前缀（幂等跳过）')
              else { await st.rename(sess, '[已归档] ' + cur); rec.renamed = true }
            }
          }
        } catch (e) { rec.error = (rec.error ? rec.error + '; ' : '') + String(e && e.message || e) }
        results.push(rec)
        audit.log({ level: rec.error ? 'WARN' : 'INFO', category: 'archive', event: 'session.archive', message: 'archived ' + sid + (rec.error ? ' (error: ' + rec.error + ')' : ''), extra: { sessionId: sid, archived: rec.archived, renamed: rec.renamed, skipped: rec.skipped, error: rec.error } })
      }
      // U-50（F-2）：原版 okCount = archived || renamed ⇒ **改名成功也算"归档成功"**，掩盖"归档压根没做"；现按项分列。
      const okCount = results.filter(function (r) { return r.archived }).length
      const renamedCount = results.filter(function (r) { return r.renamed }).length
      const fail = results.filter(function (r) { return r.error })
      const skippedRows = results.filter(function (r) { return !r.error && r.skipped })
      const detail = [
        fail.length ? '失败 ' + fail.length + ' 个：' + fail.map(function (r) { return r.sessionId + '（' + r.error + '）' }).join('；') : '',
        skippedRows.length ? '跳过 ' + skippedRows.length + ' 个：' + skippedRows.map(function (r) { return r.sessionId + '（' + r.skipped + '）' }).join('；') : ''
      ].filter(Boolean).join('；')
      return {
        ok: fail.length === 0, total: results.length, archived: okCount, renamed: renamedCount,
        failed: fail.length, skippedCount: skippedRows.length, results: results,
        summary: '归档处理 ' + results.length + ' 个会话：归档成功 ' + okCount + ' 个、改名 ' + renamedCount + ' 个、跳过 ' + skippedRows.length + ' 个、失败 ' + fail.length + ' 个' + (detail ? '｜' + detail : '')
      }
    }
  })

  // ======================== 任务面板筛选 API（S1：/taskkit/api/read + sessions）====================
  // 设计文档《任务面板筛选功能·细化设计 v1.0》§S1：read 支持 owner/project/status(多值)/session/keyword 筛选
  try {
    const ws = ctx.get('webServer')
    if (ws && typeof ws.register === 'function') {
      // /taskkit/api/read — 任务列表（带筛选参数，无参=全量）
      const readHandler = async function (req, res) {
        const send = function (status, obj) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(obj))
        }
        try {
          const u = new URL(req.url || '/', 'http://x')
          const q = u.searchParams
          const owner = q.get('owner') || ''
          const project = q.get('project') || ''
          const statusRaw = q.get('status') || ''
          const session = q.get('session') || ''
          const keyword = q.get('keyword') || ''
          const statuses = statusRaw.split(',').map(function (s) { return s.trim() }).filter(Boolean)
          const { board } = await readBoard()
          let list = board.tasks || []
          if (owner) list = list.filter(function (t) { return t.owner === owner })
          if (project) list = list.filter(function (t) { return t.project === project })
          if (statuses.length) list = list.filter(function (t) { return statuses.indexOf(t.status) >= 0 })
          if (session) list = list.filter(function (t) { return t.assignedSession === session })
          if (keyword) {
            const kw = keyword.toLowerCase()
            list = list.filter(function (t) { return ((t.title || '') + ' ' + (t.requirement || '')).toLowerCase().indexOf(kw) >= 0 })
          }
          send(200, { ok: true, count: list.length, tasks: list, revision: typeof board.revision === 'number' ? board.revision : 1, filters: { owner: owner || null, project: project || null, status: statuses.length ? statuses : null, session: session || null, keyword: keyword || null } })
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message || e) })
        }
      }
      // /taskkit/api/sessions — 活跃会话列表（含标题映射）
      const sessionsHandler = async function (req, res) {
        const send = function (status, obj) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(obj))
        }
        try {
          const agents = ctx.get('agents')
          if (!agents) return send(500, { ok: false, error: 'agents 不可用' })
          const list = agents.list()
          const sessions = []
          for (let i = 0; i < list.length; i++) {
            const a = list[i]
            sessions.push({ id: a.id, title: await titleOf(a.id) })
          }
          send(200, { ok: true, sessions: sessions })
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message || e) })
        }
      }
      // /taskkit/api/board/events — SSE 实时同步（看板 revision 变更推送）
      const boardEventsHandler = async function (req, res) {
        try {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          })
          res.write('retry: 30000\n\n')
          const { board } = await readBoard()
          res.write('event: init\ndata: ' + JSON.stringify({ revision: typeof board.revision === 'number' ? board.revision : 1, ts: new Date().toISOString() }) + '\n\n')
          const listener = function () { res.write('event: change\ndata: ' + JSON.stringify({ ts: new Date().toISOString() }) + '\n\n') }
          boardSubscribers.add(listener)
          req.on('close', function () { boardSubscribers.delete(listener) })
        } catch (e) {
          try { res.writeHead(500); res.end() } catch (e2) {}
        }
      }
      ctx.effect(function () {
        const d1 = ws.register({ kind: 'exact', path: '/taskkit/api/read', handler: readHandler })
        const d2 = ws.register({ kind: 'exact', path: '/taskkit/api/sessions', handler: sessionsHandler })
        const d4 = ws.register({ kind: 'exact', path: '/taskkit/api/board/events', handler: boardEventsHandler })
        // /taskkit/api/notify-taskcenter — 对话队列投递（2026-08-26 修复邮件调度）：
        // mailbridge 独立进程生成任务后调用本端点，把任务消息投递到任务中心会话队列（agent.send），
        // 任务中心作为分配器收到消息自行转派；避免依赖调度器 guardRunning 串行化导致邮件任务排队。
        const notifyHandler = async function (req, res) {
          const send = function (status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
          try {
            let body = ''; try { for await (const c of req) body += c } catch (e) {}
            let payload = {}; try { payload = body ? JSON.parse(body) : {} } catch (e) { return send(400, { ok: false, error: 'bad json' }) }
            const taskId = String(payload.taskId || '')
            const title = String(payload.title || '')
            const requirement = String(payload.requirement || '')
            const from = String(payload.from || '')
            const targetTitle = String(payload.target || '')
            if (!taskId) return send(400, { ok: false, error: '缺少 taskId' })
            const agents = ctx.get('agents')
            if (!agents) return send(500, { ok: false, error: 'agents 不可用' })
            const taskcenterId = 'session-0e4ee8e5-afd1-4197-9290-f31dfc87a680'
            let agent = agents.get(taskcenterId)
            if (!agent) {
              // 唤醒走 adapterWake（preset 由 adapter 挂；adapterWake 不可用时会留 ERROR 审计）
              const woke = await resumeSessionViaAdapter(taskcenterId, { timeoutMs: 8000 })
              if (woke.ok && woke.agent) agent = woke.agent
            }
            if (!agent || typeof agent.send !== 'function') return send(500, { ok: false, error: '任务中心不可达' })
            const text = '📮 [任务中心] 邮件任务开始执行：' + (title || '邮件任务') + '\n来源：' + from + '\n类型：' + targetTitle + '\n任务ID：' + taskId + '\n\n【任务内容】\n' + (requirement || '（无正文）') + '\n\n请识别任务类型并转派给合适执行者（写作→创作教练 / 插件开发→流水线 / 邮件任务→邮件任务执行 / 杂项→插件工坊）。'
            agent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true)
            // 标记任务已进入分配队列（置执行中+assignedSession=任务中心，receiptScanner 可闭环）
            try {
              const { board } = await readBoard()
              const t = board.tasks.find(function (x) { return x.id === taskId })
              if (t && t.status === '待执行') { t.status = '执行中'; t.assignedSession = taskcenterId; t.startedAt = new Date().toISOString(); t.note = (t.note ? t.note + ' | ' : '') + '对话队列投递任务中心' }
              await writeBoard(board)
            } catch (e) {}
            audit.log({ level: 'INFO', category: 'dispatch', event: 'task.notify_taskcenter', message: 'task notified to taskcenter queue: ' + title, extra: { taskId: taskId } })
            send(200, { ok: true, taskId: taskId, delivered: true })
          } catch (e) { send(500, { ok: false, error: String(e && e.message || e) }) }
        }
        const d5 = ws.register({ kind: 'exact', path: '/taskkit/api/notify-taskcenter', handler: notifyHandler })
        // /taskkit/api/typo-ai — AI 语义级错别字审查（2026-08-28 学员实测漏检升级）
        // 静态字库无法覆盖「留着鲜血→流着鲜血」「约下→跃下」等语义级错字，
        // 本端点调用 DeepSeek 按上下文语义判断用字，返回疑似错字清单（含置信度等级）。
        const typoAiHandler = async function (req, res) {
          const send = function (status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
          try {
            let body = ''; try { for await (const c of req) body += c } catch (e) {}
            let payload = {}; try { payload = body ? JSON.parse(body) : {} } catch (e) { return send(400, { ok: false, error: 'bad json' }) }
            const text = String(payload.text || '')
            if (!text || text.length < 10) return send(400, { ok: false, error: '文本过短（至少10字）' })
            if (text.length > 5000) return send(400, { ok: false, error: '文本过长（最多5000字）' })
            // 读取 DeepSeek API Key（credentials.yaml）
            let apiKey = ''
            try {
              const { readFileSync, existsSync: existsSyncLocal } = await import('node:fs')
              const credPath = CREDENTIALS_FILE
              if (existsSyncLocal(credPath)) {
                const yaml = readFileSync(credPath, 'utf8')
                const m = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\r\n]+)/)
                if (m) apiKey = m[1].trim()
              }
            } catch (e) {}
            if (!apiKey) return send(500, { ok: false, error: 'DEEPSEEK_API_KEY 未配置' })
            const prompt = '你是中文错别字审查专家。请审查以下小说片段，找出其中的错别字和用字错误（包括语义级错误如"留着鲜血"应为"流着鲜血"、"约下"应为"跃下"、"寒蝉"应为"寒噤"、的/地/得误用等）。\n\n【规则】\n1. 基于上下文语义判断，不要只做静态字面匹配；\n2. 对每处输出：原文位置(从0开始的字符偏移)、原文词、建议词、类型(形近/音近/语义/搭配/的地得)、置信度(high/medium/low)、理由；\n3. 低置信度或不确定的标注 medium/low（疑似，供用户确认）；\n4. 严格按 JSON 数组输出，不要多余文字；\n5. 没有错别字则输出空数组 []。\n\n【文本】\n' + text
            const resp = await globalThis.fetch('https://api.deepseek.com/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
              body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                max_tokens: 2000
              }),
              signal: AbortSignal.timeout(30000)
            })
            const data = await resp.json()
            const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || ''
            // 解析 JSON（可能包裹在 ```json 中）
            let findings = []
            try {
              const m = content.match(/\{[\s\S]*\}/) || content.match(/\[[\s\S]*\]/)
              if (m) findings = JSON.parse(m[0])
              if (!Array.isArray(findings)) findings = findings.findings || []
            } catch (e) { findings = [] }
            if (!Array.isArray(findings)) findings = []
            send(200, { ok: true, count: findings.length, findings: findings.slice(0, 50), provider: 'deepseek' })
          } catch (e) {
            send(500, { ok: false, error: String(e && e.message || e) })
          }
        }
        const d6b = ws.register({ kind: 'exact', path: '/taskkit/api/typo-ai', handler: typoAiHandler })
        // /taskkit/api/compact — 手动触发看板压缩（归档已完成+清理已取消/中止）
        const compactHandler = async (req, res) => {
          try {
            const result = await compactBoard('manual')
            await writeBoard(result.board)
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: true, archived: result.archived, deleted: result.deleted, kept: result.kept, archiveFile: result.archiveFile, summary: '压缩完成：归档' + result.archived + '，清理' + result.deleted + '，保留' + result.kept }))
          } catch (e) {
            audit.log({ level: 'ERROR', category: 'compact', event: 'compact.api.error', message: '/taskkit/api/compact error: ' + String(e && e.message || e) })
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
          }
        }
        const d3 = ws.register({ kind: 'exact', path: '/taskkit/api/compact', handler: compactHandler })
        // ======================== 唤醒管理 API（/taskkit/api/wake/*，2026-08-27）====================
        // 管理面板数据源：读清单（含 live 实时状态）/ 增删 / 启停 / 手动立即唤醒；增删写 写作训练/唤醒配置.json 持久化
        const wakeSend = function (res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
        const wakeReadBody = async function (req) { let body = ''; try { for await (const c of req) body += c } catch (e) {}; try { return body ? JSON.parse(body) : {} } catch (e) { return null } }
        // GET /taskkit/api/wake/list — 清单 + live 实时状态
        const wakeListHandler = async function (req, res) {
          try {
            const { cfg } = await readWakeConfig()
            const agents = ctx.get('agents')
            const entries = cfg.entries.map(function (e) {
              let live = false
              if (agents) { try { live = !!agents.get(e.id) } catch (e2) {} }
              return { id: e.id, title: e.title, enabled: e.enabled !== false, live: live }
            })
            wakeSend(res, 200, { ok: true, entries: entries, message: cfg.message, sendMessage: cfg.sendMessage !== false, defaults: cfg.defaults, updatedAt: cfg.updatedAt })
          } catch (e) { wakeSend(res, 500, { ok: false, error: String(e && e.message || e) }) }
        }
        // POST /taskkit/api/wake/add {id, title} — 新增清单项（按 id 去重；title 空时反查 sessionQuery）
        const wakeAddHandler = async function (req, res) {
          try {
            const payload = await wakeReadBody(req)
            if (!payload) return wakeSend(res, 400, { ok: false, error: 'bad json' })
            const id = String(payload.id || '').trim()
            if (!/^session-[\w-]+$/.test(id)) return wakeSend(res, 400, { ok: false, error: 'id 需为 session-xxx 格式' })
            const { cfg } = await readWakeConfig()
            if (cfg.entries.some(function (e) { return e.id === id })) return wakeSend(res, 400, { ok: false, error: '该会话已在清单中' })
            let title = String(payload.title || '').trim()
            if (!title) { try { title = await titleOf(id) } catch (e) {} }
            if (!title) title = id
            cfg.entries.push({ id: id, title: title, enabled: true })
            cfg.updatedAt = new Date().toISOString()
            const ok = await writeWakeConfig(cfg)
            if (!ok) return wakeSend(res, 500, { ok: false, error: '配置写入失败' })
            audit.log({ level: 'INFO', category: 'wake', event: 'wake.api_add', message: 'wake entry added: ' + title, extra: { id: id, title: title } })
            wakeSend(res, 200, { ok: true, entries: cfg.entries, id: id, title: title })
          } catch (e) { wakeSend(res, 500, { ok: false, error: String(e && e.message || e) }) }
        }
        // POST /taskkit/api/wake/remove {id} — 从清单移除
        const wakeRemoveHandler = async function (req, res) {
          try {
            const payload = await wakeReadBody(req)
            if (!payload) return wakeSend(res, 400, { ok: false, error: 'bad json' })
            const id = String(payload.id || '').trim()
            const { cfg } = await readWakeConfig()
            const idx = cfg.entries.findIndex(function (e) { return e.id === id })
            if (idx < 0) return wakeSend(res, 404, { ok: false, error: '清单中不存在该会话' })
            const removed = cfg.entries.splice(idx, 1)[0]
            cfg.updatedAt = new Date().toISOString()
            const ok = await writeWakeConfig(cfg)
            if (!ok) return wakeSend(res, 500, { ok: false, error: '配置写入失败' })
            audit.log({ level: 'INFO', category: 'wake', event: 'wake.api_remove', message: 'wake entry removed: ' + (removed && removed.title || id), extra: { id: id } })
            wakeSend(res, 200, { ok: true, entries: cfg.entries, removed: id })
          } catch (e) { wakeSend(res, 500, { ok: false, error: String(e && e.message || e) }) }
        }
        // POST /taskkit/api/wake/toggle {id, enabled} — 启停单条
        const wakeToggleHandler = async function (req, res) {
          try {
            const payload = await wakeReadBody(req)
            if (!payload) return wakeSend(res, 400, { ok: false, error: 'bad json' })
            const id = String(payload.id || '').trim()
            const { cfg } = await readWakeConfig()
            const entry = cfg.entries.find(function (e) { return e.id === id })
            if (!entry) return wakeSend(res, 404, { ok: false, error: '清单中不存在该会话' })
            entry.enabled = payload.enabled !== false
            cfg.updatedAt = new Date().toISOString()
            const ok = await writeWakeConfig(cfg)
            if (!ok) return wakeSend(res, 500, { ok: false, error: '配置写入失败' })
            audit.log({ level: 'INFO', category: 'wake', event: 'wake.api_toggle', message: 'wake entry toggled: ' + entry.title + ' → ' + entry.enabled, extra: { id: id, enabled: entry.enabled } })
            wakeSend(res, 200, { ok: true, entries: cfg.entries, id: id, enabled: entry.enabled })
          } catch (e) { wakeSend(res, 500, { ok: false, error: String(e && e.message || e) }) }
        }
        // POST /taskkit/api/wake/run — 立即触发 runWakeAll()（手动验证/测试用，异步不等待完成）
        const wakeRunHandler = async function (req, res) {
          try {
            audit.log({ level: 'INFO', category: 'wake', event: 'wake.manual_run', message: 'manual wake run triggered via API', extra: {} })
            runWakeAll().catch(function (e) { audit.log({ level: 'ERROR', category: 'wake', event: 'wake.manual_run_error', message: 'manual wake run error: ' + String(e && e.message || e), extra: {} }) })
            wakeSend(res, 200, { ok: true, message: '唤醒已触发（异步执行）' })
          } catch (e) { wakeSend(res, 500, { ok: false, error: String(e && e.message || e) }) }
        }
        const d6 = ws.register({ kind: 'exact', path: '/taskkit/api/wake/list', handler: wakeListHandler })
        const d7 = ws.register({ kind: 'exact', path: '/taskkit/api/wake/add', handler: wakeAddHandler })
        const d8 = ws.register({ kind: 'exact', path: '/taskkit/api/wake/remove', handler: wakeRemoveHandler })
        const d9 = ws.register({ kind: 'exact', path: '/taskkit/api/wake/toggle', handler: wakeToggleHandler })
        const d10 = ws.register({ kind: 'exact', path: '/taskkit/api/wake/run', handler: wakeRunHandler })
        return function () { try { d1() } catch (e) {} try { d2() } catch (e) {} try { d3() } catch (e) {} try { d4() } catch (e) {} try { d5() } catch (e) {} try { d6b() } catch (e) {} try { d6() } catch (e) {} try { d7() } catch (e) {} try { d8() } catch (e) {} try { d9() } catch (e) {} try { d10() } catch (e) {} }
      })
      audit.log({ level: 'INFO', category: 'api', event: 'api.read_ready', message: '/taskkit/api/read + sessions + compact + notify-taskcenter + wake/* registered', extra: {} })
    }
  } catch (e) {
    audit.log({ level: 'WARN', category: 'api', event: 'api.read_failed', message: 'api register failed: ' + String(e && e.message || e), extra: {} })
  }

  // ======================== 调度优化工具（S1-S4：hold/resume/pull/mine + 唤醒）====================
  // 设计《任务调度优化：重启感知+拉取模式设计 v1.0》
  registerTool({
    name: 'tsk_hold',
    description: '挂起任务（需重启/暂缓）。入参 taskId、reason（可选）。挂起后调度器/看门狗不再触碰；重启扫描时自动唤醒。',
    parameters: {
      taskId: { type: 'string', description: '任务 id', required: true },
      reason: { type: 'string', description: '挂起原因（如 restart-required）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const taskId = String(args && args.taskId || '').trim()
      if (!taskId) return { ok: false, error: '缺少 taskId', summary: '失败：缺少 taskId' }
      const reason = String(args && args.reason || '').trim() || 'restart-required'
      const { board } = await readBoard()
      const task = board.tasks.find(function (t) { return t.id === taskId })
      if (!task) return { ok: false, error: '任务不存在', summary: '失败：任务不存在' }
      const from = task.status
      task.held = true
      task.heldAt = new Date().toISOString()
      task.holdReason = reason
      task.note = (task.note ? task.note + ' | ' : '') + '挂起: ' + reason
      try { await writeBoard(board) } catch (e) { return { ok: false, error: '写入失败', summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.held', message: "task '" + task.title + "' held", extra: { taskId: taskId, reason: reason, from: from } })
      return { ok: true, taskId: taskId, held: true, summary: '任务「' + task.title + '」已挂起（' + reason + '）' }
    }
  })
  registerTool({
    name: 'tsk_resume',
    description: '恢复挂起任务（held→待执行，重新进入调度）。入参 taskId、note（可选）。',
    parameters: {
      taskId: { type: 'string', description: '任务 id', required: true },
      note: { type: 'string', description: '恢复说明' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const taskId = String(args && args.taskId || '').trim()
      if (!taskId) return { ok: false, error: '缺少 taskId', summary: '失败：缺少 taskId' }
      const { board } = await readBoard()
      const task = board.tasks.find(function (t) { return t.id === taskId })
      if (!task) return { ok: false, error: '任务不存在', summary: '失败：任务不存在' }
      if (!task.held) return { ok: false, error: '任务未挂起', summary: '失败：任务未挂起' }
      task.held = false
      task.heldAt = null
      task.status = '待执行'
      task.startedAt = null
      task.note = (task.note ? task.note + ' | ' : '') + '恢复: ' + String(args && args.note || '')
      try { await writeBoard(board) } catch (e) { return { ok: false, error: '写入失败', summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.resumed', message: "task '" + task.title + "' resumed", extra: { taskId: taskId } })
      return { ok: true, taskId: taskId, held: false, status: '待执行', summary: '任务「' + task.title + '」已恢复' }
    }
  })
  registerTool({
    name: 'tsk_pull',
    description: '拉取一个待执行任务（pull 模式：不被自动派发，由 agent 主动捞取）。入参 sessionId（当前会话）、owner（可选，限定负责人）。返回捞取的任务并置执行中。',
    parameters: {
      sessionId: { type: 'string', description: '当前会话 id', required: true },
      owner: { type: 'string', description: '限定负责人' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const sessionId = String(args && args.sessionId || '').trim()
      if (!sessionId) return { ok: false, error: '缺少 sessionId', summary: '失败：缺少 sessionId' }
      const owner = String(args && args.owner || '').trim()
      const { board } = await readBoard()
      // 找候选：待执行、未挂起、非自动派发（无 startAfter/dependsOn 或已满足）、目标会话匹配
      const now = Date.now()
      const candidate = board.tasks.find(function (t) {
        if (t.status !== '待执行' || t.held) return false
        if (t.assignedSession && t.assignedSession !== sessionId) return false
        if (owner && t.owner !== owner) return false
        if (t.startAfter && Date.parse(t.startAfter) > now) return false
        if (Array.isArray(t.dependsOn) && t.dependsOn.length) { for (let i = 0; i < t.dependsOn.length; i++) { const dep = board.tasks.find(function (x) { return x.id === t.dependsOn[i] }); if (!dep || dep.status !== '已完成') return false } }
        return true
      })
      if (!candidate) return { ok: true, pulled: false, summary: '没有可拉取的任务' }
      candidate.status = '执行中'
      candidate.startedAt = new Date().toISOString()
      candidate.assignedSession = sessionId
      candidate.note = (candidate.note ? candidate.note + ' | ' : '') + '拉取: ' + sessionId
      try { await writeBoard(board) } catch (e) { return { ok: false, error: '写入失败', summary: '失败：写入失败' } }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.pulled', message: "task '" + candidate.title + "' pulled by " + sessionId, extra: { taskId: candidate.id, sessionId: sessionId } })
      return { ok: true, pulled: true, task: candidate, summary: '已拉取任务「' + candidate.title + '」（' + candidate.id + '）' }
    }
  })
  registerTool({
    name: 'tsk_mine',
    description: '查询我的任务（当前会话/负责人的待执行与执行中任务）。入参 sessionId、owner（可选）。',
    parameters: {
      sessionId: { type: 'string', description: '当前会话 id', required: true },
      owner: { type: 'string', description: '负责人（可选，默认按会话匹配）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const sessionId = String(args && args.sessionId || '').trim()
      const owner = String(args && args.owner || '').trim()
      const { board } = await readBoard()
      const mine = board.tasks.filter(function (t) {
        const ownerHit = owner ? t.owner === owner : true
        const sessionHit = sessionId ? (t.assignedSession === sessionId) : true
        return (t.status === '待执行' || t.status === '执行中' || t.status === '需审批') && ownerHit && sessionHit
      })
      return { ok: true, count: mine.length, tasks: mine, summary: '我的任务 ' + mine.length + ' 个' }
    }
  })

  // ---- 知识库自动索引（2026-08-26）：扫描工作区文档目录，新文档自动索引进知识库 ----
  // Agent 落盘技术文档(md)后调用本工具，扫描 DSH工具/ 目录，把新增/变更的 .md 索引进 knowledge-base
  // （knowledge-base 索引模式：存摘要 + sourcePath 指向原始文件，原始文件为唯一事实源）
  registerTool({
    name: 'kb_sync_docs',
    description: '知识库自动索引：扫描工作区文档目录(' + TOOLS_DIR_ABS + '/*.md)与技术文档库，把新增/变更文档自动索引进知识库（按标题去重，已存在则更新摘要+sourcePath）。Agent 落盘技术文档后调用，实现文档→知识库自动索引闭环。覆盖领域：技术文档 / 作品草稿 / 创作设定（含 设定/<作品>/，递归）/ 创作规划（含 规划/<作品>/，递归）/ 创作灵感 / 训练资料 / 记忆归档。',
    parameters: {
      dir: { type: 'string', description: '扫描目录（可选，缺省 ' + TOOLS_DIR_ABS + '）' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function (args) {
      const dir = String(args && args.dir || TOOLS_DIR_ABS).replace(/\\/g, '/')
      let indexed = 0, updated = 0, skipped = 0, failed = 0
      const detail = []
      // G11④（t111）：本工具自身的 HTTP 调用归一为 adapterHttp（原为 globalThis 上的 fetch 直连 127.0.0.1:3080）
      //   逐项保持：端点/方法/payload 不变（POST + JSON 字符串，路径 '/knowledge-base/api/import'）；
      //   超时显式传 timeoutMs:15000 ⇒ 与迁移前 `AbortSignal.timeout(15000)` 同值（不继承适配器默认 8000）；
      //   失败路径等价：由 adapterHttp 以 throwOnError:false 承载（非 2xx / 2xx 但信封 ok:false / 响应非 JSON /
      //   网络错误），code 取 HTTP 状态（网络错误与缺服务时为 0，与迁移前同一档），body 为信封 JSON 文本；
      //   调用方只 `JSON.parse(body)` 后读 skipped/ok，故逐分支结果（indexed/skipped/failed）与迁移前一致。
      const httpPost = async function (pathname, payload) {
        try {
          const r = await adapterHttp.post(pathname, payload, { timeoutMs: 15000, throwOnError: false })
          const status = (r && r.status) || 0
          const envelope = (r && r.data !== null && r.data !== undefined) ? r.data : { error: (r && r.error) || ('HTTP ' + status) }
          return { code: status, body: JSON.stringify(envelope) }
        } catch (e) { return { code: 0, body: String(e && e.message || e) } }
      }
      const importOne = async function (title, description, content, category, tags, aliases, sourcePath, domain) {
        try {
          const payload = JSON.stringify({
            title: title, description: (description || '').slice(0, 100),
            content: (content || '').slice(0, 600) + ((content || '').length > 600 ? '\n…(全文见 sourcePath)' : ''),
            category: category || '文档', tags: tags || '', aliases: aliases || '', sourcePath: sourcePath || '', domain: domain || ''
          })
          const r = await httpPost('/knowledge-base/api/import', payload)
          if (r.code === 200) { const j = JSON.parse(r.body || '{}'); if (j.skipped) { skipped++; return 'skip' } else if (j.ok) { indexed++; return 'add' } else { failed++; return 'fail' } }
          else { failed++; return 'fail' }
        } catch (e) { failed++; return 'fail' }
      }
      // ---- G10（t108）：KB 导入区 fs 面统一经 adapterFs（根表 + 根内相对引用）----
      // listMdIn(ref, root)：ref 可为「根内相对引用」（经 resolveRef 解析到登记根）或「绝对路径」（直解，
      // G11①（t111）后：根表已覆盖 写作训练（草稿/灵感库/根）· 全局数据 · 记忆归档 · DSH工具（技术文档库.json）· 插件开发体系模板；
      //   ref 仍可为绝对路径（直解）—— 供工具参数 dir（用户显式指定）与其它未登记目标。
      //   adapterFs.listDir 单层返回 { name, type, version?, size? } ⇒ 目录/文件判定统一用 type，递归在业务侧实现。
      const listMdIn = async function (ref, root) {
        const out = []
        try {
          const dir = await absOfRef(ref, root)
          const entries = await adapterFs.listDir(dir)
          for (const entry of (Array.isArray(entries) ? entries : [])) {
            if (entry && entry.type === 'file' && /\.md$/i.test(String(entry.name || ''))) out.push(String(entry.name))
          }
        } catch (e) {}
        return out
      }
      // 绝对路径读文本（路径一律由根表派生/直解；缺失或不可读 → ''，与迁移前 readFileSync 的 catch 口径一致）
      const readTextAt = async function (absPath) {
        try { return await adapterFs.readText(absPath) } catch (e) { return '' }
      }
      try {
        // 1. DSH工具/*.md（技术文档 domain=技术文档）—— dir 为工具参数：绝对路径直解；相对值按迁移前口径解析到宿主 cwd（node:fs 语义）
        const dirAbs = /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('/') ? dir : (String(process.cwd()).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + dir)
        const files = await listMdIn(dirAbs, ROOT_TRAIN)
        for (const f of files) {
          try {
            const fullPath = dirAbs.replace(/\/+$/, '') + '/' + f
            const content = await readTextAt(fullPath)
            if (!content) { failed++; continue }
            const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
            const r = await importOne('[文档] ' + f.replace(/\.md$/, ''), firstLine, content, '技术文档', '文档 技术 自动索引', f.replace(/\.md$/, ''), fullPath, '技术文档')
            if (r === 'add') detail.push(f)
          } catch (e) { failed++ }
        }
        // 2. 写作训练 草稿/*.md（创作教练落盘作品 domain=作品草稿）—— G10：根名 写作训练 + 根内相对引用（原硬编码绝对路径）
        try {
          const drafts = await listDraftPathsDeep(ROOT_TRAIN, DRAFT_DIR_REL, '', 0)
          for (const f of drafts) {
            try {
              const fullPath = await absOfRef(DRAFT_DIR_REL + '/' + f, ROOT_TRAIN)
              const content = await readTextAt(fullPath)
              if (!content) { failed++; continue }
              const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
              const r = await importOne('[草稿] ' + f.replace(/\.md$/, ''), firstLine || '写作草稿', content, '创作', '草稿 作品 创作', f.replace(/\.md$/, ''), fullPath, '作品草稿')
              if (r === 'add') detail.push('草稿/' + f)
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 2b. 灵感库/*.md（创作设定文件：世界观/角色/故事设定 domain=创作设定）—— G10：根 写作训练 + 相对 '灵感库'
        const INSP_DIR_REL = '灵感库'
        try {
          const inspFiles = await listMdIn(INSP_DIR_REL, ROOT_TRAIN)
          for (const f of inspFiles) {
            try {
              const fullPath = await absOfRef(INSP_DIR_REL + '/' + f, ROOT_TRAIN)
              const content = await readTextAt(fullPath)
              if (!content) { failed++; continue }
              const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
              const r = await importOne('[设定] ' + f.replace(/\.md$/, ''), firstLine, content, '创作设定', '设定 世界观 角色 故事', f.replace(/\.md$/, ''), fullPath, '创作设定')
              if (r === 'add') detail.push('设定/' + f)
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 3. 写作训练 根目录 *.md（训练计划/技巧手册等 domain=训练资料）—— G10：根自身（rel='.'，adapterFs.resolveRef 不接受空串）
        try {
          const rootMds = await listMdIn('.', ROOT_TRAIN)
          for (const f of rootMds) {
            try {
              const fullPath = await absOfRef(f, ROOT_TRAIN)
              const content = await readTextAt(fullPath)
              if (!content) { failed++; continue }
              const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
              const r = await importOne('[资料] ' + f.replace(/\.md$/, ''), firstLine, content, '创作资料', '资料 训练 写作', f.replace(/\.md$/, ''), fullPath, '训练资料')
              if (r === 'add') detail.push('训练/' + f)
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 4. 灵感库.json（灵感条目 domain=创作灵感）—— G10：跨根内相对引用 INSP_LIB_REL（'灵感库/灵感库.json'，根 写作训练）
        try {
          const inspRaw = await readTextAt(await absOfRef(INSP_LIB_REL, ROOT_TRAIN))
          const insp = JSON.parse(inspRaw.replace(/^\uFEFF/, ''))
          for (const e of insp.entries || []) {
            try {
              const et = (e.title || '').trim()
              const ec = (e.content || '').trim()
              if (!et || !ec) { skipped++; continue }
              const r = await importOne('[灵感] ' + et, (e.oneLiner || ''), ec.slice(0, 600), '灵感', (Array.isArray(e.tags) ? e.tags.join(',') : (e.tags || '')), et, '', '创作灵感')
              if (r === 'add') detail.push('灵感/' + et)
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 5. 技术文档库.json（domain=技术文档）—— G11①（t111）：根名 DSH工具 + 根内相对引用（原硬编码绝对路径）
        try {
          const tdRaw = await readTextAt(await absOfRef(TD_LIB_REL, ROOT_TOOLS))
          const td = JSON.parse(tdRaw.replace(/^\uFEFF/, ''))
          for (const e of td.entries || []) {
            try {
              const et = (e.title || '').trim()
              const ec = (e.content || '').trim()
              if (!et || !ec) { skipped++; continue }
              const r = await importOne('[技术文档] ' + et, (e.oneLiner || ''), ec, '技术文档', (Array.isArray(e.tags) ? e.tags.join(',') : (e.tags || '')), et, '', '技术文档')
              if (r === 'add') detail.push('技术文档/' + et)
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 6. 插件开发体系模板/*.md（领域模板 domain=技术文档）—— G11①（t111）：根名 插件开发体系模板 + 根内相对引用（原硬编码绝对路径）
        try {
          const tplFiles = await listMdIn('.', ROOT_TPL)
          for (const f of tplFiles) {
            try {
              const fullPath = await absOfRef(f, ROOT_TPL)
              const content = await readTextAt(fullPath)
              if (!content) { failed++; continue }
              const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
              const r = await importOne('[模板] ' + f.replace(/\.md$/, ''), firstLine, content, '技术文档', '模板 规范 插件开发', f.replace(/\.md$/, ''), fullPath, '技术文档')
              if (r === 'add') detail.push('模板/' + f)
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 7. 记忆归档/ 递归扫描（MVP2 A2：批量索引退役归档文件，幂等按 title；.md 与 .md.gz 均支持；
        //    title 必须与 memory_retire 的 import title 完全一致（'任务结论·<taskId>_<title>'，frontmatter title 字段自带），禁止用文件名推断；
        //    递归遍历 + frontmatter 解析 + gz 解码均为内部新增实现，kb_sync_docs 签名（dir 可选参数）不动）
        // G10（t108）：归档根改经根表（根名 记忆归档，profile 已登记）——原硬编码的 记忆归档 绝对路径已取消
        const ROOT_ARCHIVE_NAME = '记忆归档'
        const parseFrontmatter = function (text) {
          const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''))
          if (!m) return null
          const out = {}
          for (const line of m[1].split(/\r?\n/)) {
            const t = line.trim()
            if (!t || t.indexOf(':') <= 0) continue
            const idx = t.indexOf(':')
            const key = t.slice(0, idx).trim()
            let val = t.slice(idx + 1).trim()
            if (!val) { out[key] = ''; continue }
            try { out[key] = JSON.parse(val) } catch (e) { out[key] = val.replace(/^["']|["']$/g, '') }
          }
          return out
        }
        // G10：递归在业务侧实现（adapterFs.listDir 为单层枚举，返回 { name, type, version?, size? }）；
        //      返回**根内相对引用**列表，调用方按需以 absOfRef 取绝对口径（读取与 sourcePath 用）
        const listMdRecursive = async function (root, rel) {
          const out = []
          const walk = async function (r) {
            let entries = []
            try { entries = await adapterFs.listDir(root, r) } catch (e) { return }
            for (const entry of (Array.isArray(entries) ? entries : [])) {
              const name = String(entry && entry.name || '')
              if (!name) continue
              const child = r ? (r + '/' + name) : name
              if (entry.type === 'directory') await walk(child)
              else if (entry.type === 'file' && (/\.md$/i.test(name) || /\.md\.gz$/i.test(name))) out.push(child)
            }
          }
          await walk(rel)
          return out
        }
        const readArchiveMd = async function (absPath) {
          try {
            const text = await adapterFs.readText(absPath)
            if (/\.md\.gz$/i.test(absPath)) {
              const nodeZlib = await import('node:zlib')
              return nodeZlib.gunzipSync(Buffer.from(String(text).trim(), 'base64')).toString('utf8')
            }
            return text
          } catch (e) { return '' }
        }
        try {
          const archiveFiles = await listMdRecursive(ROOT_ARCHIVE_NAME, '')
          for (const rel of archiveFiles) {
            try {
              const fullPath = await absOfRef(rel, ROOT_ARCHIVE_NAME)
              const content = await readArchiveMd(fullPath)
              if (!content) { failed++; continue }
              const fm = parseFrontmatter(content)
              if (!fm || !fm.title) { failed++; continue }
              const title = String(fm.title)
              const description = String(fm.description || '').slice(0, 100)
              const parts = []
              if (fm.goal) parts.push('目标: ' + fm.goal)
              if (fm.conclusion) parts.push('结论: ' + fm.conclusion)
              if (Array.isArray(fm.decisions) && fm.decisions.length) parts.push('关键决策: ' + fm.decisions.join('；'))
              if (Array.isArray(fm.open_questions) && fm.open_questions.length) parts.push('未决问题: ' + fm.open_questions.join('；'))
              const body = parts.join('\n') || ('记忆退役归档（无摘要正文，见归档文件原文引用）·' + title + ' · ' + String(fm.task_id || ''))
              const tags = Array.isArray(fm.tags) ? fm.tags.join(',') : String(fm.tags || '')
              const r = await importOne(title, description, body, '记忆归档', tags || '记忆归档 记忆退役', String(fm.task_id || ''), fullPath, '记忆归档')
              if (r === 'add') detail.push('归档/' + (fullPath.split('/').pop() || fullPath))
            } catch (e) { failed++ }
          }
        } catch (e) {}
        // 8. 设定/<作品>/*.md 与 9. 规划/<作品>/*.md（2026-09-29 步骤20 新增；编号按**代码位置**，逻辑上属既有的目录领域扩展）
        //   🔴 为什么放在这里而不是紧挨 2b：`listMdRecursive` 是 **const**（定义在下方 :3564 附近）⇒ 在它之前调用会
        //      抛 `ReferenceError: Cannot access ... before initialization`，而本工具外层是 `catch (e) {}` ⇒
        //      **会静默变成"这段没在跑"**（不是报错，是悄悄少索引）。⇒ 必须定义之后才调用。
        //   ✅ 递归 helper 复用现成的 `listMdRecursive`（支持 .md 与 .md.gz，返回根内相对引用），不新写递归。
        //   ✅ KB 侧 `category` 是**自由字符串、无白名单**（`knowledge-base/lib/index.js:321/382/566`）⇒ 新设「创作规划」不必改 knowledge-base。
        //   🔴 标题必须带作品名：这两个目录里的文件几乎都叫《世界观.md》《大纲.md》，只用文件名会大量撞名（KB 按 title 去重）。
        const titleOfWorkFile = function (label, rel) {
          const segs = String(rel).replace(/\.md$/i, '').split('/').filter(function (s) { return s !== '' })
          return '[' + label + '] ' + segs.slice(-2).map(function (s) { return s.replace(/^_+/, '') }).join(' · ')
        }
        const importWorkFileDir = async function (relDir, label, category, domain, tagStr) {
          try {
            const rels = await listMdRecursive(ROOT_TRAIN, relDir)
            for (const rel of rels) {
              try {
                const fullPath = await absOfRef(rel, ROOT_TRAIN)
                const content = await readTextAt(fullPath)
                if (!content) { failed++; continue }
                const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
                const segs = String(rel).replace(/\.md$/i, '').split('/').filter(function (s) { return s !== '' })
                const workName = (segs.length >= 2 ? segs[segs.length - 2] : (segs[0] || '')).replace(/^_+/, '')
                const r = await importOne(titleOfWorkFile(label, rel), firstLine, content, category, tagStr, workName, fullPath, domain)
                if (r === 'add') detail.push(label + '/' + rel)
              } catch (e) { failed++ }
            }
          } catch (e) {}
        }
        await importWorkFileDir('设定', '设定', '创作设定', '创作设定', '设定 世界观 角色 故事')
        await importWorkFileDir('规划', '规划', '创作规划', '创作规划', '规划 大纲 细纲 结构')
        return { ok: true, indexed: indexed, updated: updated, skipped: skipped, failed: failed, total: detail.length, detail: detail.slice(0, 15), summary: '知识库索引同步完成：新增 ' + indexed + '，跳过 ' + skipped + '，失败 ' + failed + '（覆盖 技术文档/创作设定/创作规划/创作灵感/作品草稿/训练资料/记忆归档 七领域）' }
      } catch (e) {
        return { ok: false, error: String(e && e.message || e), summary: '知识库索引同步失败：' + String(e && e.message || e) }
      }
    }
  })

  // ---- 调度器 ----
  // 编排器（体系S3）：pipeline 阶段任务 → 对应 Agent 会话；否则按 assignedSession/owner
  const PIPELINE_SESSIONS = {
    '邮件任务': '邮件任务执行',
    '设计': '插件开发·设计',
    '方案检查': '插件开发·方案检查',
    '实施': '插件开发·实施',
    '成果测试': '插件开发·成果测试',
    '检查测试': '插件开发·检查测试',
    '经验总结': '插件开发·经验总结',
    '文档更新': '插件开发·开发文档更新'
  }
  async function resolveDispatchTarget(task, agents) {
    // 防挂起：dsh session 服务异常时 20s 超时返回 null，调度器继续下一轮而非永久挂起堆积
    return Promise.race([_resolveDispatchTargetInner(task, agents), new Promise(function (r) { setTimeout(function () { r(null) }, 20000) })])
  }
  async function _resolveDispatchTargetInner(task, agents) {
    // pipeline 阶段 → 专用 Agent 会话（按标题匹配 live 会话；非 live 时唤醒持久化会话）
    if (task && task.pipeline && task.pipeline.phase && PIPELINE_SESSIONS[task.pipeline.phase]) {
      const want = PIPELINE_SESSIONS[task.pipeline.phase]
      const list = agents.list()
      // 修复：live 会话匹配用「精确 或 包含」+ 强制刷新标题，避免 titleCache stale 空缓存导致匹配失败
      for (let i = 0; i < list.length; i++) {
        const t = await titleOf(list[i].id)
        if (t === want || (t && want && t.indexOf(want) >= 0)) return { id: list[i].id, title: t }
      }
      // live 会话中无匹配 → 从持久化会话按标题唤醒（成果测试/文档更新等非 live 专用会话）
      // 修复(2026-08-26)：wakeTarget 内部 sessionQuery.listSessions 可能挂起（宿主重启后服务慢），
      // 外层 20s 超时截断会跳过后续组长兜底；此处给 wakeTarget 单独包 8s 超时，保证能走到 fallback 链
      const woke = await Promise.race([wakeTarget(want), new Promise(function (r) { setTimeout(function () { r(null) }, 8000) })])
      if (woke && woke.id) { audit.log({ level: 'INFO', category: 'wake', event: 'wake.dispatch_target', message: 'woke persisted session for pipeline phase: ' + want, sessionId: woke.id, extra: { phase: task.pipeline.phase, targetTitle: woke.title || '' } }); return { id: woke.id, title: woke.title || want } }
      // 修复：专用会话不可达（非 live 且唤醒失败）→ 回退组长统筹唤醒/分派，避免任务永久堵塞
      const leader = agents.get(LEADER_ID)
      if (leader) {
        audit.log({ level: 'WARN', category: 'dispatch', event: 'dispatch.fallback_leader', message: 'pipeline target unreachable, fallback to leader: ' + want, extra: { phase: task.pipeline.phase, taskId: task.id } })
        return { id: LEADER_ID, title: '插件工坊' }
      }
      // 组长不在 live → 按 id 精确唤醒持久化组长会话（组长统筹兜底；同样包 8s 超时防挂起）
      const wokeLeader = await Promise.race([wakeTarget(LEADER_ID), new Promise(function (r) { setTimeout(function () { r(null) }, 8000) })])
      if (wokeLeader && wokeLeader.id) {
        audit.log({ level: 'WARN', category: 'dispatch', event: 'dispatch.fallback_leader', message: 'pipeline target unreachable, woke leader for: ' + want, extra: { phase: task.pipeline.phase, taskId: task.id, leader: wokeLeader.id } })
        return { id: wokeLeader.id, title: '插件工坊' }
      }
      // 组长唤醒也失败（agents 服务异常）→ sessionQuery 直接定位组长会话 id（不依赖 agents.resume）
      try {
        const sq = ctx.get('sessionQuery')
        const rec = sq ? await sq.listSessions() : []
        for (let i = 0; i < rec.length; i++) {
          const h = rec[i] && rec[i].header
          if (h && h.id === LEADER_ID) {
            audit.log({ level: 'WARN', category: 'dispatch', event: 'dispatch.fallback_leader_sq', message: 'pipeline target unreachable, leader via sessionQuery: ' + want, extra: { phase: task.pipeline.phase, taskId: task.id, leader: LEADER_ID } })
            return { id: LEADER_ID, title: '插件工坊' }
          }
        }
      } catch (e) {}
    }
    // assignedSession 匹配：优先 agents.get（live），空时用 sessionQuery.listSessions 兜底
    if (task.assignedSession) {
      if (agents.get(task.assignedSession)) return { id: task.assignedSession, title: await titleOf(task.assignedSession) }
      try {
        const sq = ctx.get('sessionQuery')
        const rec = sq ? await sq.listSessions() : []
        for (let i = 0; i < rec.length; i++) {
          const h = rec[i] && rec[i].header
          if (h && h.id === task.assignedSession) return { id: h.id, title: await titleOf(h.id) }
        }
      } catch (e) {}
    }
    // owner 匹配：优先 agents.list()（live registry），空时用 sessionQuery.listSessions() 兜底
    // （修复：宿主重启后 agents registry 可能为空，但 sessionQuery 正常，任务派发不能依赖单一数据源）
    if (task.owner) {
      let list = agents.list()
      let matched = null
      for (let i = 0; i < list.length; i++) { const title = await titleOf(list[i].id); if (title === task.owner) { matched = list[i]; break } }
      if (!matched) {
        try {
          const sq = ctx.get('sessionQuery')
          const rec = sq ? await sq.listSessions() : []
          for (let i = 0; i < rec.length; i++) {
            const h = rec[i] && rec[i].header
            if (!h || !h.id) continue
            let title = h.title || ''
            if (!title) { try { const snap = await sq.readTitle(h.id); if (snap && typeof snap.title === 'string') title = snap.title } catch (e) {} }
            if (title === task.owner) { matched = { id: h.id }; break }
          }
        } catch (e) {}
      }
      if (matched) return { id: matched.id, title: await titleOf(matched.id) }
    }
    return null
  }

  // ---- 派发核心：schedulerTick 与 tsk_force_dispatch 共用 ----
  // 职责：解析目标会话 → （可选）目标忙检查 → 置「执行中」→ 写看板 → 发送派发消息并唤醒
  async function dispatchTask(task, trigger, board, opts) {
    opts = opts || {}
    try {
      const agents = ctx.get('agents')
      if (!agents) return { ok: false, reason: 'agents 服务不可用' }
      // 防重复派发守卫（修复「已完成任务被重新派发」顽疾，借鉴 task-board revision 校验）：
      // 置为执行中之前，重新从磁盘读该任务最新状态——若已被他人完成/取消/中止，放弃派发
      try {
        const fresh = await readBoard()
        const latest = fresh && fresh.board && fresh.board.tasks ? fresh.board.tasks.find(function (x) { return x.id === task.id }) : null
        if (latest && latest.status !== '待执行') {
          audit.log({ level: 'INFO', category: 'state_transition', event: 'task.dispatch_guard', message: "dispatch aborted: task already " + latest.status, extra: { taskId: task.id, trigger: trigger, current: latest.status, expected: '待执行' } })
          return { ok: false, reason: '任务当前状态为 ' + latest.status + '（非待执行），跳过重复派发' }
        }
      } catch (e) {}
      const target = await resolveDispatchTarget(task, agents)
      if (!target) return { ok: false, reason: '无法解析目标会话（assignedSession/owner 无匹配）' }
      // U-50（F-1）：调度器自动派发也守同一口径 —— 否则任务被静默投进已归档（侧栏不可见）的会话
      const gArch = archivedRefusal(target.id, target.title)
      if (gArch) { audit.log({ level: 'WARN', category: 'dispatch', event: 'task.dispatch_archived_target', message: 'dispatch aborted: target archived', extra: { taskId: task.id, trigger: trigger, target: target.id } }); return { ok: false, reason: gArch.reason } }
      if (opts.guardRunning !== false) {
        // 队列化守卫（2026-08-27）：允许同一会话排队派发（会话消息队列作缓存），仅限队列上限
        const queueCount = board.tasks.filter(function (x) { return x.status === '执行中' && (x.assignedSession === target.id || (x.owner && x.owner === target.title)) }).length
        if (queueCount >= MAX_QUEUE_PER_SESSION) return { ok: false, reason: '目标会话排队任务已达上限(' + MAX_QUEUE_PER_SESSION + ')' }
      }
      const _prevStatus = task.status
      task.status = '执行中'; task.startedAt = new Date().toISOString(); if (!task.queuedAt) task.queuedAt = task.startedAt
      // 修复：派发时写入 assignedSession（receiptScanner 依赖它扫描回执；此前缺失导致回执机制失效）
      task.assignedSession = target.id
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.transitioned', message: "task '" + task.title + "' transitioned to 执行中", sessionId: target.id, extra: { taskId: task.id, from: _prevStatus, to: '执行中', trigger: trigger, assignedSession: target.id } })
      try { await writeBoard(board) } catch (e) { return { ok: false, reason: '看板写入失败：' + String(e && e.message || e) } }
      // 修复(2026-08-26)：宿主重启后 agents registry 可能为空，agents.get 返回 undefined →
      // 消息无法送达导致任务「执行中」假死；target 解析成功但 get 为空时，尝试按 id resume 唤醒再发送
      let agent = agents.get(target.id)
      if (!agent) {
        try {
          // 唤醒走 adapterWake（preset 由 adapter 挂；adapterWake 不可用时会留 ERROR 审计）
          const woke = await resumeSessionViaAdapter(target.id, { timeoutMs: 8000 })
          if (woke.ok && woke.agent) agent = woke.agent
        } catch (e) { audit.log({ level: 'WARN', category: 'wake', event: 'wake.dispatch_resume_failed', message: 'resume target for dispatch failed: ' + String(e && e.message || e), extra: { taskId: task.id, target: target.id } }) }
      }
      if (agent && typeof agent.send === 'function') {
        let extra = ''
        // 经验闭环 v2：经验总结/文档更新阶段自动附带同流水线全部前置已完成任务的经验素材（lessons/artifacts/回执摘要/代码变更路径）
        // 方向B：文档更新是唯一文档出口，须拿到全链素材（含经验总结的 lessons）
        if (task.pipeline && (task.pipeline.phase === '经验总结' || task.pipeline.phase === '文档更新')) {
          const rootId = task.pipeline.rootTaskId || task.id
          const chain = board.tasks.filter(function (x) { return x.pipeline && (x.pipeline.rootTaskId === rootId || (x.pipeline.rootTaskId === '' && x.id !== task.id && Array.isArray(x.dependsOn))) && x.id !== task.id && x.status === '已完成' })
          const ordered = chain.sort(function (a, b) { return String(a.pipeline.phase).localeCompare(String(b.pipeline.phase), 'zh-CN') })
          const lines = ['\n\n【流水线经验素材】（任务中心自动汇总全链各阶段经验/产出，供经验总结与文档更新参考）']
          if (!ordered.length) lines.push('（暂无已完成的前置阶段记录）')
          for (let ci = 0; ci < ordered.length; ci++) {
            const t2 = ordered[ci]
            lines.push('- 【' + (t2.pipeline.phase || '阶段') + '】' + t2.title)
            const sumM = t2.note && String(t2.note).match(/回执完成: (.+?)(?: \| |$)/)
            if (sumM) lines.push('  回执摘要：' + sumM[1])
            if (t2.lessons && t2.lessons.length) { lines.push('  经验要点：'); for (let li = 0; li < t2.lessons.length; li++) lines.push('    · ' + t2.lessons[li]) }
            if (t2.artifacts && t2.artifacts.length) lines.push('  交付物：' + t2.artifacts.join('、'))
          }
          extra = lines.join('\n')
          audit.log({ level: 'INFO', category: 'pipeline', event: 'pipeline.lessons_attached', message: 'lessons attached to ' + task.pipeline.phase + ' dispatch for ' + task.id, sessionId: target.id, extra: { taskId: task.id, phases: ordered.map(function (x) { return x.pipeline.phase }) } })
        }
        // 记忆接入 Phase 2（additive，injectOnDispatch 门控默认关）：派发消息 text 前注入【相关记忆】块（memory_load 语义，
        //   HTTP /load 只读）；无命中/不可用 → '' 整块省略，消息照发；绝不 throw（否则外层 catch 会误判派发失败）
        let memoryInject = ''
        try { memoryInject = await buildMemoryInjectBlock(task) } catch (e) { memoryInject = '' }
        const text = '📮 [任务中心] 任务开始执行：' + task.title + '\n要求：' + (task.requirement || '—') + '\n负责人：' + (task.owner || '—') + extra + memoryInject + '\n请按要求执行，完成后在「任务」页签标记完成。'
        try { agent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true) } catch (e) {}
      }
      return { ok: true, target: target }
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'error', event: 'error.caught', message: 'dispatchTask error: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), context: 'dispatchTask.' + trigger } })
      return { ok: false, reason: '异常：' + String(e && e.message || e) }
    }
  }

  async function schedulerTick() {
    try {
      const agents = ctx.get('agents')
      if (!agents) return
      const { board } = await readBoard()
      if (!board || !Array.isArray(board.tasks)) return
      const now = Date.now()
      const candidates = board.tasks.filter(function (t) {
        if (t.status !== '待执行') return false
        if (t.held) return false
        if (t.nextTryAt && Date.parse(t.nextTryAt) > now) return false
        const hasDepends = Array.isArray(t.dependsOn) && t.dependsOn.length > 0
        const hasStart = !!t.startAfter
        if (!hasDepends && !hasStart) return false
        if (t.startAfter && Date.parse(t.startAfter) > now) return false
        if (hasDepends) { for (let i = 0; i < t.dependsOn.length; i++) { const dep = board.tasks.find(function (x) { return x.id === t.dependsOn[i] }); if (!dep || dep.status !== '已完成') return false } }
        return true
      })
      let dispatchDirty = false
      for (let i = 0; i < candidates.length; i++) {
        const task = candidates[i]
        const _r = await dispatchTask(task, 'schedulerTick', board, { guardRunning: true })
        if (!_r.ok) {
          const _reason = String(_r && _r.reason || '')
          // 退避：目标会话无法解析（唤醒风暴来源）→ 5 分钟内不再重试；目标忙/重复派发守卫不退避
          if (_reason.indexOf('无法解析目标') >= 0 && !task.nextTryAt) {
            task.nextTryAt = new Date(Date.now() + 10 * 60000).toISOString()
            dispatchDirty = true
          }
          audit.log({ level: 'WARN', category: 'dispatch', event: 'dispatch.skipped', message: 'schedulerTick skip: ' + _reason, extra: { taskId: task.id, title: task.title, phase: task.pipeline && task.pipeline.phase || '', backoff: task.nextTryAt || null } })
          continue
        }
      }
      if (dispatchDirty) { try { await writeBoard(board) } catch (e) {} }
      // 重复任务调度（借鉴 task-board cron）：已完成任务若带 repeat 规则且到期，克隆新任务
      // repeat 格式示例："每周一 09:00" / "每天 08:00" / "每30分钟"（简化解析，精确 cron 后续增强）
      const nowD = new Date()
      for (let i = 0; i < board.tasks.length; i++) {
        const t = board.tasks[i]
        if (!t.repeat || t.status !== '已完成') continue
        const lastAt = t.finishedAt ? new Date(t.finishedAt).getTime() : 0
        const rule = String(t.repeat).trim()
        let due = false
        let nextLabel = rule
        try {
          if (rule.indexOf('每天') >= 0) {
            const hm = rule.match(/(\d{1,2}):(\d{2})/)
            const targetMin = (hm ? parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10) : 8 * 60)
            const curMin = nowD.getHours() * 60 + nowD.getMinutes()
            // 今日已过目标时间且距上次完成 > 12h → 触发
            if (curMin >= targetMin && (nowD.getTime() - lastAt) > 12 * 3600000) { due = true; nextLabel = '每天 ' + (hm ? hm[0] + ':' + hm[2] : '08:00') }
          } else if (rule.indexOf('每周') >= 0) {
            const m = rule.match(/周([一二三四五六日天])\s*(\d{1,2}):(\d{2})/)
            if (m) {
              const wd = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }[m[1]]
              const targetMin = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
              const curWd = nowD.getDay()
              const curMin = nowD.getHours() * 60 + nowD.getMinutes()
              // 今天匹配 + 已过时间 + 距上次完成 > 6 天 → 触发（避免同一天重复）
              if (curWd === wd && curMin >= targetMin && (nowD.getTime() - lastAt) > 6 * 24 * 3600000) { due = true; nextLabel = rule }
            }
          } else if (rule.indexOf('每') >= 0 && rule.indexOf('分钟') >= 0) {
            const n = parseInt(rule.match(/每(\d+)/)[1], 10) || 30
            if ((nowD.getTime() - lastAt) > n * 60000) { due = true; nextLabel = '每' + n + '分钟' }
          }
        } catch (e) {}
        if (!due) continue
        // 克隆新任务（同标题/要求/负责人/项目，重置状态与时间）
        const now2 = new Date().toISOString()
        const clone = normalizeTask({
          id: nextTaskId(),
          title: t.title, requirement: t.requirement, project: t.project,
          status: '待执行', due: null, repeat: t.repeat, owner: t.owner,
          assignedSession: null, note: 'repeat 自动创建: ' + nextLabel,
          startAfter: now2, dependsOn: [], ackPolicy: t.ackPolicy,
          createdAt: now2, updatedAt: now2
        }, board.tasks.length)
        board.tasks.unshift(clone)
        audit.log({ level: 'INFO', category: 'state_transition', event: 'task.repeat_clone', message: 'repeat task cloned: ' + t.title, extra: { source: t.id, clone: clone.id, rule: nextLabel } })
      }
      if (board.tasks.some(function (x) { return x.repeat && x.status === '已完成' })) { try { await writeBoard(board) } catch (e) {} }
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'error', event: 'error.caught', message: 'schedulerTick error: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), stack: String(e && e.stack || '').slice(0, 500), context: 'schedulerTick' } })
    }
  }

  // ======================== 启动唤醒（配置化清单：任务中心/插件开发工坊/创作教练）====================
  // 2026-08-27 需求：DSH 启动后遍历 写作训练/唤醒配置.json 清单，顺序唤醒未活跃会话并发送「📮 已启动，会话就绪」。
  // 幂等双保险：① agents.get 命中(live)→跳过；② resume 返回 handle.agent 才算成功；同一轮启动仅执行一次（单 setTimeout）。
  // 替换原硬编码 WAKE_TC_ID 单会话定时器：任务中心为清单首项，同 3s 延迟/同 resume 参数/同幂等检查 → 原行为等价覆盖。
  async function wakeSession(id, title, cfg) {
    try {
      const agents = ctx.get('agents')
      if (!agents) return { id: id, title: title, result: 'skipped' }
      const existing = agents.get(id)
      if (existing) {
        audit.log({ level: 'INFO', category: 'wake', event: 'wake.skipped_already_live', message: 'wake skipped (already live): ' + title, extra: { id: id, title: title } })
        return { id: id, title: title, result: 'already_live' }
      }
      if (!cfg) cfg = (await readWakeConfig()).cfg
      const d = cfg.defaults || WAKE_DEFAULT_DEFAULTS
      let handle = null
      try {
        // 唤醒走 adapterWake（resume + preset 挂载的唯一实现；参数与改造前一致）
        const woke = await resumeSessionViaAdapter(id, { provider: d.provider, model: d.model, timeoutMs: 8000 })
        handle = (woke.ok && woke.agent) ? { agent: woke.agent } : null
      } catch (eResume) {
        audit.log({ level: 'WARN', category: 'wake', event: 'wake.resume_error', message: 'wake resume error: ' + String(eResume && eResume.message || eResume), extra: { id: id, title: title } })
        return { id: id, title: title, result: 'failed' }
      }
      if (!handle || !handle.agent) {
        audit.log({ level: 'WARN', category: 'wake', event: 'wake.failed', message: 'wake failed (no agent): ' + title, extra: { id: id, title: title } })
        return { id: id, title: title, result: 'failed' }
      }
      const agent = handle.agent
      // 唤醒成功后发送通知消息（sendMessage 开关；send 失败不影响唤醒结果）
      if (cfg.sendMessage !== false && agent && typeof agent.send === 'function') {
        try {
          agent.send({ id: 'wake-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: cfg.message || WAKE_DEFAULT_MESSAGE }], source: { kind: 'plugin', plugin: 'taskkit', wake: true } }, 'next-turn', true)
        } catch (eSend) {
          audit.log({ level: 'WARN', category: 'wake', event: 'wake.send_error', message: 'wake message send failed: ' + String(eSend && eSend.message || eSend), extra: { id: id, title: title } })
        }
      }
      audit.log({ level: 'INFO', category: 'wake', event: 'wake.ok', message: 'session woken on startup: ' + title, extra: { id: id, title: title } })
      return { id: id, title: title, result: 'ok' }
    } catch (e) {
      audit.log({ level: 'WARN', category: 'wake', event: 'wake.error', message: 'wake error: ' + String(e && e.message || e), extra: { id: id, title: title } })
      return { id: id, title: title, result: 'error' }
    }
  }
  // 启动遍历：读取清单 → 顺序唤醒（顺序而非并发：避免同时 resume 冲击宿主 agents 并发；3 项×8s 上限≈24s 可接受，逐条可审计）
  async function runWakeAll() {
    try {
      const { cfg } = await readWakeConfig()
      audit.log({ level: 'INFO', category: 'wake', event: 'wake.all.start', message: 'startup wake all start: ' + cfg.entries.length + ' entries', extra: { count: cfg.entries.length } })
      const results = []
      for (let i = 0; i < cfg.entries.length; i++) {
        const e = cfg.entries[i]
        if (!e || !e.id || e.enabled === false) { results.push({ id: e && e.id, title: e && e.title, result: 'disabled' }); continue }
        const r = await wakeSession(e.id, e.title, cfg)
        results.push(r)
      }
      audit.log({ level: 'INFO', category: 'wake', event: 'wake.all.done', message: 'startup wake all done', extra: { results: results } })
      return results
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'wake', event: 'wake.all.error', message: 'runWakeAll error: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), stack: String(e && e.stack || '').slice(0, 500), context: 'runWakeAll' } })
      return []
    }
  }
  // apply 时延迟 3s 后遍历清单唤醒（保留原基线让 agents 服务就绪）；ctx.effect 清理 timer
  const wakeTimer = setTimeout(function () { runWakeAll().catch(function () {}) }, WAKE_DEFAULT_DEFAULTS.delayMs || 3000)
  ctx.effect(function () { return function () { clearTimeout(wakeTimer) } })

  // 周期调度：原生 setInterval + ctx.effect 清理（不依赖 timer 服务名，host 静态环境最稳）
  const handle = setInterval(schedulerTick, 60000)
  ctx.effect(() => () => { clearInterval(handle); audit.close() })

  // ======================== 完成凭条回传（S3 回执协议）====================
  // 执行者回复「📮 任务回执」文本 → host 扫描 assignedSession 表面 → 解析 → 状态回写
  // 格式：📮 任务回执\ntaskId: <id>\nresult: completed|failed\nsummary: <一句话>
  function parseTaskReceipt(text) {
    if (typeof text !== 'string' || text.indexOf('📮 任务回执') < 0) return null
    const grab = function (key) {
      // 兼容 \r\n 与 \n：^key\s*:\s*(.+)$（key 后可有空格，然后冒号，再取剩余行）
      const re = new RegExp('^' + key + '\\s*:\\s*(.+)$', 'm')
      const m = text.match(re)
      return m ? m[1].trim() : ''
    }
    const taskId = grab('taskId')
    const resultRaw = grab('result')
    const result = resultRaw === 'failed' ? 'failed' : (resultRaw === 'needs_review' ? 'needs_review' : 'completed')
    if (!taskId) return null
    // 经验闭环 v2：回执可附 lessons（经验/踩坑要点）与 artifacts（交付物路径，逗号分隔）
    const lessonsRaw = grab('lessons')
    const artifactsRaw = grab('artifacts')
    const lessons = lessonsRaw ? lessonsRaw.split(/[；;\n]+/).map(function (s) { return s.trim() }).filter(Boolean).slice(0, 10) : []
    const artifacts = artifactsRaw ? artifactsRaw.split(/[,，]+/).map(function (s) { return s.trim() }).filter(Boolean).slice(0, 10) : []
    return { taskId: taskId, result: result, summary: grab('summary') || '', lessons: lessons, artifacts: artifacts }
  }

    // 增强1：批量 ackPolicy 聚合（all/any/auto）
    // all/auto：所有批次任务需各自回执完成；any：首个成功回执后取消其余未完成任务（竞争胜出）
    function applyBatchAckPolicy(board, task) {
      if (!task || !task.dispatch || !task.dispatch.batchId) return false
      const batchId = task.dispatch.batchId
      const ack = task.dispatch.ackPolicy || 'auto'
      const batch = board.tasks.filter(function (t) { return t.dispatch && t.dispatch.batchId === batchId })
      const done = batch.filter(function (t) { return t.status === '已完成' }).length
      let modified = false
      if ((ack === 'any') && task.status === '已完成' && done === 1) {
        for (let i = 0; i < batch.length; i++) {
          const other = batch[i]
          if (other.id === task.id || other.status === '已完成' || other.status === '已取消') continue
          other.status = '已取消'
          other.finishedAt = new Date().toISOString()
          other.note = (other.note ? other.note + ' | ' : '') + '批量any: 兄弟任务已完成，取消'
          modified = true
        }
      }
      for (let i = 0; i < batch.length; i++) {
        const t = batch[i]
        if (!t.dispatch) continue
        const next = done
        if (t.dispatch.batchDoneCount !== next) { t.dispatch.batchDoneCount = next; modified = true }
      }
      return modified
    }


  async function receiptScanner() {
    try {
      const sessionQuery = ctx.get('sessionQuery')
      const agents = ctx.get('agents')
      if (!sessionQuery || !agents) return
      const { board } = await readBoard()
      if (!board || !Array.isArray(board.tasks)) return
      // 收集所有「执行中/需审批」任务的 assignedSession
      const running = board.tasks.filter(function (t) {
        return (t.status === '执行中' || t.status === '需审批') && t.assignedSession
      })
      let changed = false
      // 记忆接入 Phase 2（additive）：collect 本 tick 完成 taskId —— writeBoard 成功后逐任务 fire（守卫「board 先落盘」铁律）
      const completedThisTick = []
      for (let i = 0; i < running.length; i++) {
        const task = running[i]
        const sid = task.assignedSession
        // 只扫 live 会话表面
        const agent = agents.get(sid)
        if (!agent) continue
        try {
          const snap = await sessionQuery.readSurface(sid)
          const events = snap && Array.isArray(snap.events) ? snap.events : []
          let found = null
          for (let e = events.length - 1; e >= 0; e--) {
            const ev = events[e]
            if (ev.type !== 'user/message') continue
            const content = ev.data && ev.data.content
            let text = ''
            if (Array.isArray(content)) {
              for (let c = 0; c < content.length; c++) {
                const block = content[c]
                if (block && block.type === 'text' && typeof block.text === 'string') text += block.text + '\n'
              }
            } else if (typeof content === 'string') text = content
            if (text.indexOf('📮 任务回执') >= 0) { found = text; break }
          }
          if (!found) continue
          const r = parseTaskReceipt(found)
          if (!r || r.taskId !== task.id) continue
          // 增强2：回执幂等（receiptHash 去重）——四元组 (taskId, sessionId, result, summary)
          // 对齐需求：同任务同会话同结果同摘要的回执只处理一次，避免跨会话/跨结果误判重复
          const receiptKey = task.id + '|' + String(sid || '') + '|' + String(r.result || '') + '|' + (r.summary || '').slice(0, 40)
          if (task.receiptHashes && task.receiptHashes.indexOf(receiptKey) >= 0) {
            audit.log({ level: 'INFO', category: 'state_transition', event: 'task.receipt_duplicate', message: 'duplicate receipt ignored for ' + task.id, sessionId: sid, extra: { taskId: task.id, receiptKey: receiptKey } })
            continue
          }
          if (r.result === 'completed') {
            task.receiptHashes = (task.receiptHashes || []).concat([receiptKey]).slice(-20)
            task.status = '已完成'
            task.finishedAt = new Date().toISOString()
            // 经验闭环 v2：累计经验要点与交付物路径（供经验总结阶段采集）
            if (r.lessons && r.lessons.length) task.lessons = (task.lessons || []).concat(r.lessons).slice(-30)
            if (r.artifacts && r.artifacts.length) task.artifacts = Array.from(new Set((task.artifacts || []).concat(r.artifacts))).slice(-30)
            task.note = (task.note ? task.note + ' | ' : '') + '回执完成: ' + r.summary.slice(0, 80) + (r.lessons && r.lessons.length ? ' | 经验' + r.lessons.length + '条' : '')
            audit.log({ level: 'INFO', category: 'state_transition', event: 'task.receipt_completed', message: "task '" + task.title + "' marked 已完成 by receipt", sessionId: sid, extra: { taskId: task.id, summary: r.summary.slice(0, 100) } })
            changed = true
            completedThisTick.push(task.id) // Phase 2：collect 本 tick 完成 taskId（writeBoard 成功后统一 fire）
            // S3: 灵感会议任务回执完成 → 自动保存会议成果到关联灵感条目（设计文档 §5.3）
            if (task.title && String(task.title).indexOf('灵感会议') >= 0) {
              try {
                const { lib } = await readInspLib()
                let saved = 0
                for (let ei = 0; ei < lib.entries.length; ei++) {
                  const entry = lib.entries[ei]
                  if (entry.meeting && entry.meeting.taskId === task.id) {
                    entry.meeting.output = (entry.meeting.output || '') + (entry.meeting.output ? '\n' : '') + (r.summary || '')
                    entry.meeting.date = new Date().toISOString().slice(0, 10)
                    if (entry.status === '待讨论') entry.status = '已整理'
                    entry.updatedAt = new Date().toISOString()
                    entry.history.push({ at: entry.updatedAt, by: '教练', field: 'meeting.output', before: '', after: (r.summary || '').slice(0, 80) })
                    saved++
                  }
                }
                if (saved) { try { await writeInspLib(lib) } catch (e) {} }
                if (saved) audit.log({ level: 'INFO', category: 'insp', event: 'insp.meeting_receipt_saved', message: 'meeting output auto-saved for ' + saved + ' entries from receipt', sessionId: sid, extra: { taskId: task.id, saved: saved } })
              } catch (e) {}
            }
          } else if (r.result === 'failed') {
            task.note = (task.note ? task.note + ' | ' : '') + '回执失败: ' + r.summary.slice(0, 80)
            task.status = '中止'
            task.finishedAt = new Date().toISOString()
            // 级联：前置失败(回执) → 后置中止（传递）
            await applyCascade(board, task, '执行中', '中止')
            audit.log({ level: 'WARN', category: 'state_transition', event: 'task.receipt_failed', message: "task '" + task.title + "' receipt failed", sessionId: sid, extra: { taskId: task.id, summary: r.summary.slice(0, 100) } })
            changed = true
          } else if (r.result === 'needs_review') {
            task.status = '需审批'
            task.note = (task.note ? task.note + ' | ' : '') + '回执待审批: ' + r.summary.slice(0, 80)
            audit.log({ level: 'INFO', category: 'state_transition', event: 'task.receipt_review', message: "task '" + task.title + "' → 需审批 by receipt", sessionId: sid, extra: { taskId: task.id, summary: r.summary.slice(0, 100) } })
            changed = true
          }
            if (applyBatchAckPolicy(board, task)) changed = true
        } catch (e) {}
      }
      let boardSaved = false
      if (changed) { try { await writeBoard(board); boardSaved = true } catch (e) {} }
      // 记忆接入 Phase 2（additive，autoDraftOnComplete 门控默认关）：board 已成功落盘才逐任务 fire（守卫「board 先落盘」铁律——
      //   防 board 写失败却已建 memory 草稿）；失败仅 audit、绝不 throw、不阻塞 tick（memory 尽力而为）
      if (boardSaved && completedThisTick.length) {
        for (let fi = 0; fi < completedThisTick.length; fi++) {
          try { fireAutoDraft(completedThisTick[fi], 'receiptScanner').catch(function () {}) } catch (e) {}
        }
      }
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'error', event: 'error.caught', message: 'receiptScanner error: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), context: 'receiptScanner' } })
    }
  }

  // 回执扫描定时器（30s，独立于 60s schedulerTick）
  const receiptHandle = setInterval(function () { receiptScanner().catch(function () {}) }, 30000)
  ctx.effect(() => () => { clearInterval(receiptHandle) })


  // ======================== 依赖链级联传播 ====================
  // 前置中止/取消 → 后置中止（传递）；前置重派(中止→待执行) → 后置重派（传递）
  // 规则：changedTask 状态变化 → 所有 dependsOn 含它的任务跟随
  function cascadeDependency(board, changedTask, fromStatus, toStatus) {
    const changed = []
    if (!changedTask || !changedTask.id) return changed
    const changedId = changedTask.id
    const dependents = board.tasks.filter(function (t) {
      return t.id !== changedId && Array.isArray(t.dependsOn) && t.dependsOn.indexOf(changedId) >= 0
    })
    for (let i = 0; i < dependents.length; i++) {
      const dep = dependents[i]
      // 守卫：中止级联 → 后置须为 待执行/执行中/需审批；重派级联 → 后置须为 中止（恢复）
      if (toStatus === '待执行' && fromStatus === '中止') {
        if (dep.status !== '中止') continue
      } else {
        if (dep.status !== '待执行' && dep.status !== '执行中' && dep.status !== '需审批') continue
      }
      const depPrev = dep.status
      if (toStatus === '中止' || toStatus === '已取消') {
        // 前置中止/取消 → 后置中止（无法执行）
        dep.status = '中止'
        dep.finishedAt = new Date().toISOString()
        dep.note = (dep.note ? dep.note + ' | ' : '') + '级联中止: 前置「' + (changedTask.title || changedId) + '」' + fromStatus
      } else if (toStatus === '待执行' && fromStatus === '中止') {
        // 前置重派(中止→待执行) → 后置也重派
        dep.status = '待执行'
        dep.startedAt = null
        dep.finishedAt = null
        dep.attempt = (dep.attempt || 0) + 1
        dep.note = (dep.note ? dep.note + ' | ' : '') + '级联重派: 前置「' + (changedTask.title || changedId) + '」重派'
      }
      audit.log({ level: 'INFO', category: 'state_transition', event: 'task.cascade', message: "task '" + dep.title + "' cascade " + depPrev + "→" + dep.status, extra: { taskId: dep.id, from: depPrev, to: dep.status, causedBy: changedId } })
      changed.push(dep.id)
      // 传递：后置状态变化继续传播到它的后置
      const sub = cascadeDependency(board, dep, depPrev, dep.status)
      for (let s = 0; s < sub.length; s++) if (changed.indexOf(sub[s]) < 0) changed.push(sub[s])
    }
    return changed
  }

  // 便捷：变更后写回（带级联）
  async function applyCascade(board, task, fromStatus, toStatus) {
    const cascaded = cascadeDependency(board, task, fromStatus, toStatus)
    if (cascaded.length) { try { await writeBoard(board) } catch (e) {} }
    return cascaded
  }
  // ======================== 看门狗（执行中超时 → 标记超时 + 通知）====================
  // Loop 设计 §六 S4：executingTimeout 默认 24h（或 due），超时 → 「超时」+ 通知负责人
  async function watchdogScan() {
    try {
      const agents = ctx.get('agents')
      if (!agents) return
      const { board } = await readBoard()
      if (!board || !Array.isArray(board.tasks)) return
      const nowMs = Date.now()
      let changed = false
      // 队列化看门狗（2026-08-27）：同一会话允许多个执行中任务排队（会话消息队列作缓存），
      // 只有最早派发的任务参与超时判定（排队任务不判超时，避免排队误杀与后续重发重复执行）；
      // 最早任务超时判定结合会话活跃度：目标会话最近 SESSION_ACTIVE_GRACE_MS 内有活动 → 视为仍在推进，豁免超时
      const runningTasks = board.tasks.filter(function (t) { return t.status === '执行中' })
      const groups = new Map()
      for (let i = 0; i < runningTasks.length; i++) {
        const t = runningTasks[i]
        const key = t.assignedSession || (t.owner ? 'owner:' + t.owner : t.id)
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(t)
      }
      const activeCache = new Map()
      const graceMs = 60 * 60 * 1000
      for (const [, tasks] of groups) {
        // 最早派发者（startedAt/queuedAt 最早）为队列头，参与超时判定
        const head = tasks.slice().sort(function (a, b) { return String(a.startedAt || a.queuedAt || '').localeCompare(String(b.startedAt || b.queuedAt || '')) })[0]
        const base = head.startedAt ? new Date(head.startedAt).getTime() : (head.queuedAt ? new Date(head.queuedAt).getTime() : nowMs)
        const executedMs = nowMs - base
        let timedOut = false
        if (head.due) {
          const dueMs = new Date(head.due).getTime()
          if (!isNaN(dueMs) && dueMs < nowMs && executedMs >= graceMs) timedOut = true
        }
        if (!timedOut && executedMs > 24 * 60 * 60 * 1000) {
          // 会话活跃豁免：目标会话最近有活动 → 仍在推进队列，不判超时
          let sessionActive = false
          const sid = head.assignedSession
          if (sid) {
            if (!activeCache.has(sid)) {
              let active = false
              try {
                const sq = ctx.get('sessionQuery')
                if (sq && typeof sq.readSurface === 'function') {
                  const snap = await Promise.race([sq.readSurface(sid), new Promise(function (r) { setTimeout(function () { r(null) }, 8000) })])
                  const events = snap && Array.isArray(snap.events) ? snap.events : []
                  const last = events.length > 0 ? events[events.length - 1] : null
                  const lastT = last && last.time ? new Date(last.time).getTime() : 0
                  active = lastT > 0 && (nowMs - lastT) < SESSION_ACTIVE_GRACE_MS
                }
              } catch (e) {}
              activeCache.set(sid, active)
            }
            sessionActive = activeCache.get(sid)
          }
          if (!sessionActive) timedOut = true
        }
        if (!timedOut) continue
        const task = head
        task.status = '中止'
        task.finishedAt = new Date().toISOString()
        task.note = (task.note ? task.note + ' | ' : '') + '看门狗: 执行超时(' + Math.round((nowMs - base) / 3600000) + 'h)'
        audit.log({ level: 'WARN', category: 'state_transition', event: 'task.watchdog_suspend', message: "task '" + task.title + "' timed out", extra: { taskId: task.id, elapsedH: Math.round((nowMs - base) / 3600000) } })
        // 级联：前置中止 → 后置中止（传递）
        await applyCascade(board, task, '执行中', '中止')
        // 通知负责人（若有 live 会话）
        if (task.assignedSession) {
          const a = agents.get(task.assignedSession)
          if (a && typeof a.send === 'function') {
            try { a.send({ id: 'tsk-wd-' + Date.now(), role: 'user', content: [{ type: 'text', text: '⏰ [任务中心] 任务超时：' + task.title + '\n执行超过 ' + Math.round((nowMs - base) / 3600000) + ' 小时未完成，已标记「中止」，可用 tsk_cancel 取消或 tsk_redispatch 重派。' }], source: { kind: 'plugin', plugin: 'taskkit' } }, 'next-turn', true) } catch (e) {}
          }
        }
        changed = true
      }
      if (changed) { try { await writeBoard(board) } catch (e) {} }
    } catch (e) {
      audit.log({ level: 'ERROR', category: 'error', event: 'error.caught', message: 'watchdogScan error: ' + String(e && e.message || e), extra: { errorType: String(e && e.constructor && e.constructor.name || 'Error'), context: 'watchdogScan' } })
    }
  }

  // ---- 工具：tsk_compact（归档压缩看板：已完成移入月度归档文件，已取消/中止直接清理）----
  const ARCHIVE_REL = DATA_ROOT + '/任务看板_归档'
  const COMPACT_THRESHOLD = 200
  async function compactBoard(mode) {
    const { board } = await readBoard()
    const now = new Date()
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    const archiveFile = ARCHIVE_REL + '_' + monthKey + '.json'
    const keepTasks = []
    const doneToArchive = []
    const cancelToDelete = []
    for (let i = 0; i < board.tasks.length; i++) {
      const t = board.tasks[i]
      if (t.status === '已完成') {
        doneToArchive.push({
          id: t.id, title: t.title, status: t.status,
          project: t.project || '', owner: t.owner || '',
          finishedAt: t.finishedAt || t.updatedAt || now.toISOString(),
          note: t.note || ''
        })
      } else if (t.status === '已取消' || t.status === '中止') {
        cancelToDelete.push({ id: t.id, title: t.title, status: t.status })
      } else {
        keepTasks.push(t)
      }
    }
    if (doneToArchive.length > 0) {
      let existing = { version: 1, month: monthKey, tasks: [] }
      try {
        const target = await absOfRef(archiveFile, ROOT_TRAIN)
        const info = await adapterFs.stat(target)
        if (info) { existing = JSON.parse(await adapterFs.readText(target)) }
      } catch (_) {}
      existing.tasks = (existing.tasks || []).concat(doneToArchive)
      try { await writeTextSafe(await absOfRef(archiveFile, ROOT_TRAIN), JSON.stringify(existing, null, 2), archiveFile) }
      catch (e) { audit.log({ level: 'WARN', category: 'compact', event: 'compact.archive_write_failed', message: 'archive write failed (degraded, continuing): ' + String(e && e.message || e), extra: { archiveFile: archiveFile, error: String(e && e.code || '') } }) }
    }
    board.tasks = keepTasks
    audit.log({ level: 'INFO', category: 'compact', event: 'compact.done', message: 'compact: archived ' + doneToArchive.length + ' done, deleted ' + cancelToDelete.length + ' cancelled/stopped, kept ' + keepTasks.length + ' active', extra: { archived: doneToArchive.length, deleted: cancelToDelete.length, kept: keepTasks.length, archiveFile: archiveFile, mode: mode } })
    return { archived: doneToArchive.length, deleted: cancelToDelete.length, kept: keepTasks.length, archiveFile: archiveFile, board: board }
  }

  registerTool({
    name: 'tsk_compact',
    description: '归档压缩看板：已完成任务移入月度归档文件（任务看板_归档_YYYY-MM.json），已取消/中止任务直接清理。无入参。返回归档/删除/保留数量。建议在看板任务超过 200 时调用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) {
        if (!value || !value.ok) return [{ type: 'text', text: '压缩失败：' + (value && value.error || '未知错误') }]
        return [{ type: 'text', text: '看板压缩完成：归档 ' + value.archived + ' 个已完成任务到 ' + value.archiveFile + '，清理 ' + value.deleted + ' 个已取消/中止任务，保留 ' + value.kept + ' 个活跃任务。' }]
      },
      presentationMeta: function (args, value) { return value || {} }
    },
    handler: async function () {
      try {
        const result = await compactBoard('manual')
        await writeBoard(result.board)
        return { ok: true, archived: result.archived, deleted: result.deleted, kept: result.kept, archiveFile: result.archiveFile, summary: '压缩完成：归档' + result.archived + '，清理' + result.deleted + '，保留' + result.kept }
      } catch (e) {
        audit.log({ level: 'ERROR', category: 'compact', event: 'compact.error', message: 'tsk_compact error: ' + String(e && e.message || e) })
        return { ok: false, error: String(e && e.message || e), summary: '压缩失败：' + String(e && e.message || e) }
      }
    }
  })

  // 看门狗定时器（60s，与 schedulerTick 同频）
  const watchdogHandle = setInterval(function () { watchdogScan().catch(function () {}) }, 60000)
  ctx.effect(() => () => { clearInterval(watchdogHandle) })

  audit.log({
    level: 'INFO',
    category: 'lifecycle',
    event: 'plugin.ready',
    message: 'taskkit plugin ready, ' + audit.toolCount + ' tools registered',
    extra: { toolCount: audit.toolCount }
  })

  // t83：启动期工具面**收敛检查**（挂在既有启动钩子上，不新增插件清单项、不改任何 action/工具计数）
  // 与原 t81/C 的差别：**异步、收敛式**。原实现在此处同步查一次 ⇒ 每次启动都 WARN（时序假警报），
  // 修法与理由见上方 convergeToolSurface 的注释块。此处只负责调度 + 写审计，判定逻辑全在纯函数里。
  try {
    const _toolsSvc = (ctx.tools && typeof ctx.tools.view === 'function') ? ctx.tools : (typeof ctx.get === 'function' ? ctx.get('tools') : null)
    const _declared = collectDeclaredToolNames(__PLUGIN_ROOT)
    let _disposed = false
    ctx.effect(() => () => { _disposed = true })   // 插件卸载后不再写审计（同 watchdog 的清理口径）
    convergeToolSurface({ toolsSvc: _toolsSvc, declared: _declared, prefixes: TOOL_SURFACE_PREFIXES })
      .then((_surf) => {
        if (_disposed) return
        const _v = toolSurfaceVerdict(_surf)
        audit.log({
          level: _v.level,
          category: 'registration',
          event: 'tools.surface.check',
          message: _v.kind === 'ok'
            ? 'tool surface OK: registered=' + _surf.registeredCount + ' declared=' + _surf.declaredCount
              + '（已收敛：' + _surf.waitedMs + 'ms / ' + _surf.samples + ' 次采样；'
              + TOOL_SURFACE_PREFIXES.length + ' 个前缀组全非空）'
            : (_v.kind === 'incomplete'
              ? 'tool surface INCOMPLETE: registered=' + _surf.registeredCount + ' declared=' + _surf.declaredCount
                + ' missing=[' + _surf.missing.join(',') + '] emptyGroups=[' + _surf.emptyGroups.join(',') + ']'
                + '（已收敛：连续 ' + TOOL_SURFACE_CONVERGENCE.stableSamples + ' 次采样 registered 不再增长'
                + ' ⇒ 判定为真缺失，非时序假象）'
              : 'tool surface NOT-CONVERGED（不判 WARN，避免时序假警报）: registered=' + _surf.registeredCount
                + ' declared=' + _surf.declaredCount + ' missing=[' + _surf.missing.join(',') + ']'
                + ' emptyGroups=[' + _surf.emptyGroups.join(',') + '] after ' + _surf.waitedMs + 'ms'),
          extra: {
            registeredCount: _surf.registeredCount, declaredCount: _surf.declaredCount,
            missing: _surf.missing, emptyGroups: _surf.emptyGroups,
            converged: _surf.converged, kind: _v.kind, waitedMs: _surf.waitedMs, samples: _surf.samples,
            // 收敛轨迹：把"尚未注册"与"注册失败"变成可读的时间序证据（t=ms 起算于首次采样前）
            trajectory: _surf.trajectory,
          }
        })
      })
      .catch((e) => {
        if (_disposed) return
        audit.log({ level: 'WARN', category: 'registration', event: 'tools.surface.check_failed', message: 'tool surface self-check threw: ' + String(e && e.message || e) })
      })
  } catch (e) {
    audit.log({ level: 'WARN', category: 'registration', event: 'tools.surface.check_failed', message: 'tool surface self-check threw: ' + String(e && e.message || e) })
  }
}

// cordis loader reads inject array from named exports
export { inject }

