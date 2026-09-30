// Host：记忆管理系统插件 @local/memory-system
// 分层记忆（对齐《分层记忆系统架构设计_v1.html》）+ 基于任务的上下文加载策略
//   L0 项目事实层 facts.json（工作记忆锚点，半手动维护：Agent 提议 + 用户确认）
//   L1 任务摘要层 longterm/tasks/<taskId>.json（任务闭合生成；内容字段不可修改，pinned/excluded 强调标记可经 memory_pin/memory_exclude additive 写回）
//   L2 原始记录层 raw/<taskId>/<seq>.jsonl（事件流追加，只增不改）
//   IDX 索引层 index/dependency_graph.json + index/fulltext.json（依赖图 + 轻量关键词索引）
//   working/<taskId>.json 工作记忆（活跃任务状态/工具调用记录/加载快照）
// 核心：memory_load 上下文包（白名单式 + 硬预算，输出 JSON 不自动注入，判断权留给 Agent）
// 对接：knowledge-base（kb_search 语义）/ skill-center（route）/ prompt-router（route，只带引用）
// 端点：/memory-system/api/{ping,load,record,close,facts,link,search,weave,stats,conflicts,rebuild-fulltext,retire,retire-dryrun,retire-run,pin,exclude,restore,config,sync-board}
// 工具：memory_load/record/close/facts/link/search/weave/conflicts/stats/retire/retire_dryrun/pin/exclude
// sync-board：记忆接入体系 Phase 1（additive，仅新 action 不新工具）——读任务看板已完成任务 → 内容门+readSummary 幂等 → 直写 L1 草稿（longterm/drafts）+ 批次收尾 rebuildFulltext
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 工具注册失败诊断日志的落点（见下方 register 的 catch 分支）。
// 原实现硬编码 Windows 便携版路径 `E:/DeepSeek-Harness-1.0.0-portable/dsh-data/...`，
// 迁到 Linux 后 appendFileSync 必然失败且被 catch 吞掉 —— 而这段日志的存在意义正是
// "logger 常为 undefined，注册失败会零痕迹"，路径写死等于又把痕迹抹掉。
// 改为按环境推导：DSH_MEMORY_LOG → <DSH_HOME>/memory-tool-register.log → 进程 cwd。
// 本机 Windows 下 DSH_HOME 即 E:\DeepSeek-Harness-1.0.0-portable\dsh-data，与旧行为一致。
// 导出仅为自检脚本可直接断言；插件契约只依赖 apply / inject / name。
export function resolveMemoryLogPath() {
  const explicit = (process.env && process.env.DSH_MEMORY_LOG) || ''
  if (explicit.trim()) return resolve(explicit.trim())
  const home = (process.env && process.env.DSH_HOME) || ''
  if (home.trim()) return join(resolve(home.trim()), 'memory-tool-register.log')
  return join(resolve('.'), 'memory-tool-register.log')
}

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer',
  'sessionQuery'
]

// ============ 常量：数据根 + 根内相对引用（O5 迁移：盘符/根路径不再出现在本插件） ============
// 根名与 profile `cordis.yml` 中 `@local/dsh-adapter.config.adapter.roots` 的登记一致（全局数据 / 记忆归档 / 写作训练）；
// 本插件只持"根内相对引用"，绝对路径一律由 adapterFs 解析（对外 payload 与 node:fs 直用处按需取 displayPath）。
const ROOT_DATA = '全局数据'
const ROOT_ARCHIVE = '记忆归档'
const ROOT_TRAIN = '写作训练'

const MEM_DIR_REL = 'memory-system'
const MEMORY_REL = MEM_DIR_REL + '/memory.json'
const FACTS_REL = MEM_DIR_REL + '/facts.json'
const LONGTERM_REL = MEM_DIR_REL + '/longterm/tasks'
const DRAFTS_REL = MEM_DIR_REL + '/longterm/drafts'
const WORKING_REL = MEM_DIR_REL + '/working'
const RAW_REL = MEM_DIR_REL + '/raw'
const INDEX_GRAPH_REL = MEM_DIR_REL + '/index/dependency_graph.json'
const INDEX_FULLTEXT_REL = MEM_DIR_REL + '/index/fulltext.json'
// B4-2 记忆退役归档（MVP1）：结构化退役文件落盘 <记忆归档>/<project>/<taskId>_<title>.md + 归档清单（原数据不动）
const ARCHIVE_ROOT_REL = ''            // 根 记忆归档 自身（根内相对引用为空串）
const ARCHIVE_MANIFEST_REL = '归档清单.json'
// 跨插件只读数据源（HTTP 通道失败时的回退直读，不复制数据）：经 adapterFs.resolveRef 解析（相对引用 → 登记根）
const KB_REL = 'knowledge-base/knowledge.json'
const SKILLS_REL = 'skills/skills.json'
const PROMPTS_REL = 'prompt-router/prompts.json'
const BOARD_REL = '任务看板.json'      // 根 写作训练（buildContext 与 doSyncBoard 同路径同通道读板，仍为 fs 直读非 taskkit HTTP）

// 预算硬上限（R3 单一口径：L1 主载+依赖回溯合计 ≤20，KB ≤5，raw 片段 ≤3 段，L0 全量≤1）
const BUDGET = {
  l0: 1,
  l1: 20,          // 主载 3-5 + 依赖回溯链，合计上限 20
  kb: 5,
  rawExcerpts: 3,  // 下钻 raw 片段数
  rawLastK: 10,    // 工具调用记录最近 K 次
  depth: 3,        // 依赖回溯深度
  skills: 2,
  prompts: 3
}

const STATUS_WEIGHT = { success: 4, silent_completed: 3, interrupted: 2, failed: 1 }
// 记忆强调（P0 双轨）：pinned 置顶加分。量级：常规候选分上限≈关键词100+状态40+memoryScore~25≈165 < 10000 < taskId 保底 100000（F2）
// → pinned 置顶于一切常规候选之上、当前目标任务之下（人工轨>自动轨，但目标任务仍最高）
const PINNED_BONUS = 10000
const RELS = ['depends_on', 'replaces', 'supplements', 'conflicts_with']
// B4-1 记忆分数排序权重默认配置（可被 memory.json.config.memoryScore 运行时覆盖，不加工具参数，零契约破坏）
// 公式对齐上游 calculateMemoryScore：memoryScore=(importance×w.importance + accessLog×w.accessLog + priority×w.priority + reinforcement×w.reinforcement)×decay
// priority/reinforcement 在 L1 无字段 → 恒 0（权重保留为可配置占位）；importance/accessLog 用现有字段代理（结论质量/决策密度/kb_refs/消息占比），零 schema 改动
const DEFAULT_SCORE_CONFIG = {
  enabled: true,
  weights: { importance: 0.3, accessLog: 0.2, priority: 0.3, reinforcement: 0.2 },
  decayRate: 0.01,
  importantThreshold: 0.7,
  addScale: 50
}
// MVP2 A1 退役看门狗默认配置（memory.json.config.retireWatchdog 运行时覆盖；默认 enabled:false 试验田——T4 dryrun 验收阈值后再置 true）
// 权重/decayRate/importantThreshold 继承 memoryScore 配置形态（retireScan 用 Object.assign({}, resolveScoreConfig(), retireWatchdog) 合并）
const DEFAULT_RETIRE_WATCHDOG = {
  enabled: false,
  intervalMs: 60000,
  maxAgeDays: 90,
  minScore: 0.15,
  excludeImportant: true,
  excludeFailed: true,
  batchSize: 5,
  moveOut: true,
  dryRun: false,
  minCompressBytes: 1024 // A4：归档 md 字节数 ≥ 此值才 gzip（小文件留明文避免解压开销）
}

// 任务类型路由表（与 skill-center 分类语义对齐：写作/插件开发/邮件/分析/审查 + 补充类）
// 每类：type 名称 + 触发关键词 + 工具调用记录筛选族（子串匹配 toolName）
const TASK_TYPES = [
  { type: '插件开发', keywords: ['插件', '实施', '开发', '修复', '调试', '代码', '静态化', 'cordis', '看板任务'], families: ['edit', 'write', 'read', 'glob', 'grep', 'node', 'check', 'sandbox', 'cordis', 'tsk', 'kb_', 'skill', 'prompt', 'pwsh'] },
  { type: '写作', keywords: ['写作', '创作', '小说', '故事', '文案', '润色', '稿', '文', '灵感'], families: ['write', 'edit', 'prompt', 'insp', 'wrpro', 'writing'] },
  { type: '分析', keywords: ['分析', '研究', '评估', '调研', '趋势', '方案'], families: ['kb_', 'read', 'grep', 'search', 'web_search', 'skill'] },
  { type: '审查', keywords: ['审查', '检查', '验收', '审查方案', 'review'], families: ['read', 'grep', 'glob', 'node', 'check'] },
  { type: '测试', keywords: ['测试', '验证', '验收', '自测', '回归'], families: ['check', 'node', 'pwsh', 'job', 'test'] },
  { type: '邮件', keywords: ['邮件', '邮件桥', '回信', '通知'], families: ['eb_', 'email'] },
  { type: '文档', keywords: ['文档', '落盘', 'md', '技术文档'], families: ['write', 'kb_', 'prompt', 'read'] },
  { type: '总结', keywords: ['总结', '复盘', '经验', 'lessons'], families: ['read', 'kb_', 'prompt'] },
  { type: '通用', keywords: [], families: [] }
]

export function apply(ctx) {
  // O5 迁移：fs 面统一经 adapterFs（见下方 readJson/writeJson/readTextFile/listDir 包装）——
  // 原 ctx.get('fs') / cwd / writePolicy 三项已不再使用（写策略由 adapter 部署 config 的 writePolicy 承接，
  // 默认 {mode:'danger-full-access'} 与迁移前本插件本地 writePolicy 同值）；inject 数组保持契约零破坏、不动。
  const logger = ctx.get('logger')
  const sessionQuery = ctx.get('sessionQuery')

  // ============ 数据读写（O5：统一经 adapterFs —— 根名 + 根内相对引用；默认直读盘、写后自动失效） ============
  // adapterFs 不可用时的口径（同 prompt-router / skill-center / knowledge-base 先例）：告警一次、不抛，
  // 各读写包装自行回 fallback / false，语义与迁移前一致。
  const adapterFs = ctx.get('adapterFs')
  if (!adapterFs) {
    const _m = '[memory-system] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写记忆数据（请确认 profile 中 @local/dsh-adapter 已加载）'
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(_m)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n')
    } catch (_) {}
  }
  // MVP2 A1/A4：看门狗与 gzip 解码的运行时状态（重入锁 / 最近扫描时间 / 恢复延迟样本）
  let retireScanRunning = false
  let retireLastScanAt = null
  const decodeSamples = []
  // 对外 payload / node:fs 直用所需的绝对路径：由 adapterFs 解析登记根后取 displayPath（盘符不在本插件硬编码）
  function absPath(t) {
    const v = (t && t.displayPath !== undefined) ? t.displayPath : t
    return String(v === undefined || v === null ? '' : v).replace(/\\/g, '/')
  }
  async function absOf(root, rel) { return absPath(await adapterFs.resolve(root, rel)) }
  // 读（adapterFs 默认 cache:false 直读盘 → 消灭原 30s TTL 陈旧窗口；fallback 口径与迁移前一致：任何错误都回 fallback）
  async function readJson(root, rel, fallback) {
    try { return await adapterFs.readJson(root, rel, { fallback: fallback }) } catch (e) { return fallback }
  }
  // 跨插件只读源：先 resolveRef（相对引用 → 部署登记的根；默认 全局数据），再经 adapterFs 按绝对路径读
  async function readJsonRef(ref, fallback, root) {
    try {
      const t = await adapterFs.resolveRef(ref, root ? { root: root } : undefined)
      return await adapterFs.readJson(absPath(t), null, { fallback: fallback })
    } catch (e) { return fallback }
  }
  // 写（adapterFs 写后自动失效同键缓存）
  async function writeJson(root, rel, obj) {
    try { await adapterFs.writeJson(root, rel, obj); return true } catch (e) { return false }
  }
  // 文本通道写（归档 md/gz 等）：同样写后自动失效
  async function writeTextFile(root, rel, content) {
    try { await adapterFs.writeText(root, rel, content); return true } catch (e) { return false }
  }
  // 文本通道写（抛错版：调用方自带 try/catch 并需要原始错误消息时用，语义与迁移前 fs.writeText 直调一致）
  function writeTextRaw(root, rel, content) { return adapterFs.writeText(root, rel, content) }
  // 显式失效（node:fs 直写绕过 adapter 通道后 / 写失败丢弃缓存对象时）：rel 省略 = 全清
  function invalidateRef(root, rel) {
    try { if (rel === undefined) adapterFs.invalidate(); else adapterFs.invalidate(root + ':' + rel) } catch (e) {}
  }
  async function readTextFile(root, rel) {
    try { return await adapterFs.readText(root, rel) } catch (e) { return '' }
  }
  // 绝对路径读文本（归档清单 entry.path 已是绝对路径；与迁移前同口径）
  async function readTextAbs(absPathStr) {
    try { return await adapterFs.readText(absPathStr) } catch (e) { return '' }
  }
  async function listDir(root, rel) {
    try { return await adapterFs.listDir(root, rel) } catch (e) { return [] }
  }

  // ============ 领域模型读写 ============
  async function readMemory() {
    return readJson(ROOT_DATA, MEMORY_REL, { version: '0.1.0', createdAt: null, updatedAt: null, stats: {}, config: {} })
  }
  async function bumpCounter(key) {
    const m = await readMemory()
    m.stats = m.stats || {}
    m.stats[key] = (m.stats[key] || 0) + 1
    m.updatedAt = new Date().toISOString()
    await writeJson(ROOT_DATA, MEMORY_REL, m)
  }
  async function readFacts() {
    return readJson(ROOT_DATA, FACTS_REL, { version: 1, facts: [], pending: [], last_updated: null })
  }
  async function readGraph() {
    return readJson(ROOT_DATA, INDEX_GRAPH_REL, { graph: {}, updatedAt: null })
  }
  async function readFulltext() {
    return readJson(ROOT_DATA, INDEX_FULLTEXT_REL, { entries: [], updatedAt: null })
  }
  // F4：fulltext 轻量关键词索引真实写路径——close（L1 变更）与 facts confirm（L0 变更）后重建。
  // 索引范围：L1（已确认+草稿）+ L0 事实 + KB 引用（只取标题/描述/标签，raw 不入全文索引，对齐设计）
  async function rebuildFulltext() {
    try {
      const entries = []
      const notDot = function (e) { return !String(e.name || '').startsWith('.') }
      const dirs = (await listDir(ROOT_DATA, LONGTERM_REL)).filter(notDot).concat((await listDir(ROOT_DATA, DRAFTS_REL)).filter(notDot))
      for (const n of dirs) {
        const id = (n.name || '').replace(/\.json$/, '')
        if (!id) continue
        const s = await readSummary(id)
        if (!s) continue
        entries.push({ layer: 'l1', id: s.task_id, title: s.title || id, desc: String(s.goal + ' ' + s.conclusion).slice(0, 200), tags: (s.domain || []).concat(s.project ? [s.project] : []) })
      }
      const facts = await readFacts()
      for (const f of (facts.facts || [])) {
        entries.push({ layer: 'l0', id: f.id, title: f.project || '项目事实', desc: String(f.content || '').slice(0, 200), tags: f.project ? [f.project] : [] })
      }
      const kb = await readJsonRef(KB_REL, { entries: [] })
      for (const e of (kb.entries || []).slice(0, 2000)) {
        entries.push({ layer: 'kb', id: e.id, title: e.title || e.id, desc: String(e.description || '').slice(0, 200), tags: (e.tags || []).concat(e.category ? [e.category] : []) })
      }
      await writeJson(ROOT_DATA, INDEX_FULLTEXT_REL, { entries: entries, updatedAt: new Date().toISOString() })
      return entries.length
    } catch (e) { return -1 }
  }
  async function readWorking(taskId) {
    return readJson(ROOT_DATA, WORKING_REL + '/' + taskId + '.json', null)
  }
  async function writeWorking(taskId, w) {
    await writeJson(ROOT_DATA, WORKING_REL + '/' + taskId + '.json', w)
  }
  async function readL1(taskId) {
    return readJson(ROOT_DATA, LONGTERM_REL + '/' + taskId + '.json', null)
  }
  async function readDraft(taskId) {
    return readJson(ROOT_DATA, DRAFTS_REL + '/' + taskId + '.json', null)
  }
  // 读摘要：先已确认 L1，再草稿，再退役 digest（B4-2 三级回退 L1→draft→cold，防依赖回溯/conflicts 悬挂）
  async function readSummary(taskId) {
    const l1 = await readL1(taskId)
    if (l1) return Object.assign({}, l1, { layer: 'l1', source: 'confirmed' })
    const d = await readDraft(taskId)
    if (d) return Object.assign({}, d, { layer: 'l1', source: 'draft' })
    const cold = await readColdDigest(taskId)
    if (cold) return cold
    return null
  }
  // B4-2 三级回退 L3：从 记忆归档/归档清单.json 定位退役文件，解析 frontmatter 重建 digest（按 id 回退，不复活目录枚举命中）
  // MVP2 A4：支持 gzip 压缩归档（manifest.compressed===true 或路径 .gz 结尾 → base64 文本 → gunzipSync）；明文旧档向后兼容；
  //          成功命中即递增 readCount/lastReadAt（冷区读取计数，写放大边界=仅 readSummary 冷回退低频触发）+ bumpCounter('retireReadCount')
  async function readColdDigest(taskId) {
    try {
      const manifest = await readJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, { archived: {} })
      const entry = (manifest.archived || {})[taskId]
      if (!entry || !entry.path) return null
      const text = await readTextAbs(entry.path)
      if (!text) return null
      let mdText = text
      if (entry.compressed === true || /\.gz$/i.test(String(entry.path || ''))) {
        try {
          const t0 = Date.now()
          const nodeZlib = await import('node:zlib')
          const buf = Buffer.from(String(text).trim(), 'base64')
          mdText = nodeZlib.gunzipSync(buf).toString('utf8')
          decodeSamples.push(Date.now() - t0)
          if (decodeSamples.length > 200) decodeSamples = decodeSamples.slice(-200)
        } catch (e) { return null }
      }
      const fm = parseFrontmatter(mdText)
      if (!fm || !fm.task_id) return null
      // 复原统计：冷区读取计数（readCount/lastReadAt 语义=冷区读取，非回迁；manifest 走 30s TTL 缓存，低频冷读可接受）
      entry.readCount = (entry.readCount || 0) + 1
      entry.lastReadAt = new Date().toISOString()
      manifest.updatedAt = new Date().toISOString()
      await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
      await bumpCounter('retireReadCount')
      return {
        task_id: String(fm.task_id || taskId),
        title: String(fm.title_raw || fm.title || taskId),
        status: String(fm.status || 'silent_completed'),
        project: String(fm.project || ''),
        domain: Array.isArray(fm.domain) ? fm.domain.map(String) : [],
        closed_at: fm.archived_at || fm.closed_at || null,
        goal: String(fm.goal || ''),
        conclusion: String(fm.conclusion || ''),
        decisions: Array.isArray(fm.decisions) ? fm.decisions.map(String) : [],
        open_questions: Array.isArray(fm.open_questions) ? fm.open_questions.map(String) : [],
        layer: 'l1',
        source: 'cold'
      }
    } catch (e) { return null }
  }
  // frontmatter 解析（R3 健壮）：JSON 值优先（数组/对象/带引号字符串），失败回退去引号
  function parseFrontmatter(text) {
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
      try { out[key] = JSON.parse(val) } catch (e) {
        out[key] = val.replace(/^["']|["']$/g, '')
      }
    }
    return out
  }
  // raw 追加（只增不改）：读旧内容 + 追加一行（JSONL 走文本写，不走 JSON 缓存通道）
  // raw 追加（只增不改）：读旧内容 + 追加一行（JSONL 走文本通道，不走 JSON 通道；保持"读-改-写"三步，不新增 append API）
  async function appendRaw(taskId, record) {
    const rel = RAW_REL + '/' + taskId + '/' + String(record.seq).padStart(6, '0') + '.jsonl'
    const prev = await readTextFile(ROOT_DATA, rel)
    const line = JSON.stringify(record)
    const content = prev ? (prev.endsWith('\n') ? prev + line + '\n' : prev + '\n' + line + '\n') : line + '\n'
    const ok = await writeTextFile(ROOT_DATA, rel, content)
    if (ok) invalidateRef(ROOT_DATA, rel)
    return ok
  }
  async function readRawRecords(taskId) {
    // 按文件名排序（000001.jsonl...），逐行解析
    const entries = await listDir(ROOT_DATA, RAW_REL + '/' + taskId)
    const names = entries.map(function (e) { return e.name }).filter(function (n) { return /^\d+\.jsonl$/.test(n) }).sort()
    const records = []
    for (const n of names) {
      const text = await readTextFile(ROOT_DATA, RAW_REL + '/' + taskId + '/' + n)
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try { records.push(JSON.parse(t)) } catch (e) { /* skip broken line */ }
      }
    }
    return records
  }
  async function rawSeqFor(taskId) {
    const entries = await listDir(ROOT_DATA, RAW_REL + '/' + taskId)
    let max = 0
    for (const e of entries) {
      const m = /^(\d+)\.jsonl$/.exec(e.name || '')
      if (m) max = Math.max(max, parseInt(m[1], 10))
    }
    return max + 1
  }

  // ============ 检索评分（复用 kb 语义：精确100/包含80/描述60/标签50/内容30） ============
  function scoreEntry(fields, q) {
    const name = String(fields.name || '').toLowerCase()
    const aliases = String(fields.aliases || '').toLowerCase()
    const desc = String(fields.desc || '').toLowerCase()
    const tags = String(fields.tags || '').toLowerCase()
    const content = String(fields.content || '').toLowerCase()
    if (name === q || aliases.split(' ').indexOf(q) >= 0) return 100
    if (name.indexOf(q) >= 0 || aliases.indexOf(q) >= 0) return 80
    if (desc.indexOf(q) >= 0) return 60
    if (tags.indexOf(q) >= 0) return 50
    if (content.indexOf(q) >= 0) return 30
    return 0
  }
  function scoreAndSort(items, q, keyFn) {
    const out = []
    for (const it of items) {
      const s = scoreEntry(keyFn(it), q)
      if (s > 0) out.push({ item: it, score: s })
    }
    out.sort(function (a, b) { return b.score - a.score })
    return out
  }

  // ============ 跨插件通道：HTTP 优先（同源 web 服务），失败回退直读数据文件 ============
  function apiBase() {
    let e
    try { e = typeof process !== 'undefined' && process.env ? process.env.DSH_WEB_URL : undefined } catch (_) { e = undefined }
    return (e && String(e).replace(/\/+$/, '')) || 'http://127.0.0.1:3080'
  }
  async function httpJson(path, args) {
    if (typeof fetch !== 'function') return null
    let ctrl = null
    let timer = null
    try {
      if (typeof AbortController !== 'undefined') { ctrl = new AbortController(); timer = setTimeout(function () { try { ctrl && ctrl.abort() } catch (e) {} }, 3000) }
      const res = await fetch(apiBase() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
        signal: ctrl ? ctrl.signal : undefined
      })
      if (timer) clearTimeout(timer)
      if (!res.ok) return null
      const data = await res.json()
      return data && data.ok !== false ? data : null
    } catch (e) {
      if (timer) clearTimeout(timer)
      return null
    }
  }

  // kb 检索：HTTP /knowledge-base/api/search → 回退直读 knowledge.json + 同评分；返回 {hits, channel}
  async function kbSearch(q, limit) {
    limit = limit || BUDGET.kb
    const viaHttp = await httpJson('/knowledge-base/api/search', { q: q })
    if (viaHttp && Array.isArray(viaHttp.entries) && viaHttp.entries.length) {
      return { hits: viaHttp.entries.slice(0, limit).map(normalizeKbEntry), channel: 'http' }
    }
    const kb = await readJsonRef(KB_REL, { entries: [] })
    const hits = scoreAndSort(kb.entries || [], String(q).trim().toLowerCase(), function (e) {
      return { name: e.title, aliases: (e.aliases || []).join(' '), desc: e.description, tags: (e.tags || []).join(' '), content: e.content }
    })
    return { hits: hits.slice(0, limit).map(function (h) { return normalizeKbEntry(h.item) }), channel: hits.length ? 'file' : 'none' }
  }
  function normalizeKbEntry(e) {
    return { id: e.id, title: e.title, description: e.description, category: e.category, tags: e.tags, kbMode: e.kbMode || 'fulltext', sourcePath: e.sourcePath || null, content: e.kbMode === 'index' ? (e.content || '').slice(0, 200) : (e.content || '').slice(0, 400) }
  }
  // F1（t110，**用户批准的业务语义变更**）：让回退通道与 HTTP 通道**同语义**
  //   基准 = HTTP `/skill-center/api/route` 的真实实现（skill-center/lib/index.js `routeSkill()`）：
  //     text = (title + ' ' + requirement).toLowerCase()，**按序规则表**，首个「正则命中且 active !== false」者胜。
  //   改前：整串 q 的子串评分 ⇒ 多词查询（如 q='写作创作 写小说'）全字段 0 命中 ⇒ 静默 channel:'none'。
  //   改后：① 先按基准规则表判定（⇒ HTTP 能命中时，回退必然给出同一 id）；② 规则未命中才走原评分兜底（纯加法，不删既有能力）。
  const SKILL_ROUTE_RULES = [
    { re: /写作|撰写|小说|故事|文案|文章|创作|扩写|篇|短篇/, id: 's-writing' },
    { re: /插件|开发|实现|cordis|client|host|调试/, id: 's-plugin' },
    { re: /邮件|回复|通知|发送/, id: 's-email' },
    { re: /分析|研究|评估|调研|对比/, id: 's-analysis' },
    { re: /检查|测试|验收|审查|review/, id: 's-review' }
  ]
  // skill 路由：HTTP /skill-center/api/route → 回退直读 skills.json 关键词匹配；返回 {skill, channel}
  async function skillRoute(title, requirement) {
    const viaHttp = await httpJson('/skill-center/api/route', { title: title, requirement: requirement })
    if (viaHttp && viaHttp.matched) {
      const m = viaHttp.matched
      return { skill: { id: m.id, name: m.name, category: m.category, description: m.description, usage: m.usage, parameters: m.parameters || {} }, channel: 'http' }
    }
    const lib = await readJsonRef(SKILLS_REL, { skills: [] })
    const q = (String(title) + ' ' + String(requirement)).toLowerCase()
    const active = (lib.skills || []).filter(function (s) { return s.active !== false })
    // ① F1：与 HTTP 基准同语义（按序规则表；首个命中且 active 者胜；正则无 /g 故 test 无状态）
    let routed = null
    for (const rule of SKILL_ROUTE_RULES) {
      if (rule.re.test(q)) { routed = active.find(function (s) { return s.id === rule.id }) || null; if (routed) break }
    }
    if (routed) return { skill: { id: routed.id, name: routed.name, category: routed.category, description: routed.description, usage: routed.usage, parameters: routed.parameters || {} }, channel: 'file' }
    // ② 规则未命中：保留改前的整串评分兜底（不改既有行为）
    const hits = scoreAndSort(active, q, function (s) {
      return { name: s.name, aliases: (s.scenarios || []).join(' ') + ' ' + (s.tags || []).join(' '), desc: s.description, tags: (s.category || '') + ' ' + (s.tags || []).join(' '), content: s.usage + ' ' + (s.input || '') }
    })
    if (!hits.length) return { skill: null, channel: 'none' }
    const s = hits[0].item
    return { skill: { id: s.id, name: s.name, category: s.category, description: s.description, usage: s.usage, parameters: s.parameters || {} }, channel: 'file' }
  }
  // ============ F2（t113，**用户批准的业务语义变更**）：prompt 回退与 HTTP 基准同语义 ============
  // 基准 = `prompt-router/lib/index.js` `routePrompt()` 的**完整判定链**（逐字镜像规则内容/顺序/id 映射）：
  //   ① 写作域强信号门控 WRITING_SIGNALS → ② RULES_WC（含 obj 联合门：如「审查/检查/校对」须同时命中写作对象）
  //   → ③ scoreMatchWc 库内 wc-* 条目关键词打分兜底 → ④ 种子 10 规则表 → ⑤ **p-analysis 最终兜底**（基准永不为 null）。
  //   A1 实测差异（与 F1 不同，如实记录）：基准**没有** active 过滤（`prompts.find(p => p.id === …)`），
  //   而有「写作域门控 + obj 联合门 + 兜底 p-analysis」三重额外语义 —— 故本轮镜像的是**整条链**而非仅 10 条规则表。
  //   数据源同一：两侧都读 <全局数据>/prompt-router/prompts.json（prompt-router: PROMPTS_ROOT='全局数据' + PROMPTS_REL）。
  const PROMPT_WRITING_SIGNALS = /小说|章节|文本|文章|大纲|断章|节奏|世界观|错别字|润色|人设|情节|对话|描写|创意|故事|剧本|轻小说|网文|文风|正文|段落/
  const PROMPT_WRITING_OBJECTS = /小说|文本|章节|文稿|正文|段落|作品|草稿|文章/
  const PROMPT_RULES_WC = [
    { re: /审查|检查|校对/, obj: PROMPT_WRITING_OBJECTS, id: 'wc-text-review' },
    { re: /错别字|语病|用字/, id: 'wc-text-review' },
    { re: /断章/, id: 'wc-chapter-break' },
    { re: /节奏/, id: 'wc-pacing-analysis' },
    { re: /大纲|细纲/, id: 'wc-outline-generate' },
    { re: /世界观/, id: 'wc-worldsetting-consistency' },
    { re: /分析/, id: 'wc-text-analyzer' },
    { re: /建议/, id: 'wc-writing-suggestion' },
    { re: /结构|章构/, id: 'wc-structure-design' },
    { re: /润色|对话/, id: 'wc-seed-dialogue' },
    { re: /策划|科幻/, id: 'wc-seed-scifi' },
    { re: /悬疑|推理/, id: 'wc-seed-suspense' }
  ]
  const PROMPT_WC_CATEGORIES = ['analysis', 'suggestion', 'review', 'structure']
  const PROMPT_WRITING_SIGNAL_WORDS = ['小说', '章节', '文本', '文章', '大纲', '断章', '节奏', '世界观', '错别字', '润色', '人设', '情节', '对话', '描写', '创意', '故事', '剧本', '轻小说', '网文', '文风', '正文', '段落']
  const PROMPT_SEED_RULES = [
    { re: /写作|小说|故事|文案|文章|创作/, id: 'p-writing' },
    { re: /插件|开发|实现|cordis|client|host/, id: 'p-plugin' },
    { re: /分析|研究|评估|调研|对比/, id: 'p-analysis' },
    { re: /邮件|回复|通知|发送/, id: 'p-email' },
    { re: /检查|测试|验收|审查|review/, id: 'p-review' },
    { re: /灵感|创意|构思|点子/, id: 'p-idea' },
    { re: /任务|拆解|规划|计划/, id: 'p-todo' },
    { re: /总结|复盘|提炼|经验/, id: 'p-summary' },
    { re: /调试|修复|bug|报错|排查/, id: 'p-debug' },
    { re: /文档|手册|说明|规范/, id: 'p-doc' }
  ]
  // 镜像 scoreMatchWc（逐字语义：仅 wc-* 条目参与；类别或标签需与写作命中词相交；命中词各计 2 分取最高）
  function promptScoreMatchWc(t, prompts) {
    const hits = PROMPT_WRITING_SIGNAL_WORDS.filter(function (w) { return t.indexOf(w) >= 0 })
    if (!hits.length) return null
    let best = null
    let bestScore = 0
    for (const p of (prompts || [])) {
      if (!p || !p.id || p.id.indexOf('wc-') !== 0) continue
      const tags = Array.isArray(p.tags) ? p.tags : []
      const catOk = PROMPT_WC_CATEGORIES.indexOf(p.category) >= 0
      const tagOk = tags.some(function (tag) { return hits.indexOf(tag) >= 0 || hits.some(function (h) { return String(tag).indexOf(h) >= 0 }) })
      if (!catOk && !tagOk) continue
      const hay = String(p.title || '') + ' ' + tags.join(' ') + ' ' + String(p.category || '')
      let score = 0
      for (const h of hits) { if (hay.indexOf(h) >= 0) score += 2 }
      if (score > bestScore) { bestScore = score; best = p }
    }
    return bestScore > 0 ? best : null
  }
  // 镜像 routePrompt 的判定链（同序；返回库内条目或 null）
  function promptRouteMirror(title, requirement, prompts) {
    const t = (String(title || '') + ' ' + String(requirement || '')).toLowerCase()
    const list = prompts || []
    let matched = null
    if (PROMPT_WRITING_SIGNALS.test(t)) {
      for (const r of PROMPT_RULES_WC) {
        if (r.re.test(t) && (!r.obj || r.obj.test(t))) {
          const p = list.find(function (x) { return x.id === r.id })
          if (p) { matched = p; break }
        }
      }
      if (!matched) matched = promptScoreMatchWc(t, list)
    }
    if (!matched) {
      for (const r of PROMPT_SEED_RULES) {
        if (r.re.test(t)) { matched = list.find(function (p) { return p.id === r.id }) || null; if (matched) break }
      }
    }
    if (!matched) matched = list.find(function (p) { return p.id === 'p-analysis' }) || null
    return matched
  }
  // prompt 路由：HTTP /prompt-router/api/route → 回退直读 prompts.json；只带引用不展开全文；返回 {prompt, channel}
  async function promptRoute(title, requirement) {
    const viaHttp = await httpJson('/prompt-router/api/route', { title: title, requirement: requirement })
    if (viaHttp && (viaHttp.matchedId || viaHttp.matched)) {
      const m = viaHttp.matched || {}
      return { prompt: { id: viaHttp.matchedId || m.id, title: viaHttp.matchedTitle || m.title || viaHttp.matchedId, category: m.category || null }, channel: 'http' }
    }
    const lib = await readJsonRef(PROMPTS_REL, { prompts: [] })
    // ① F2：与 HTTP 基准同语义（按 routePrompt 判定链镜像 ⇒ 基准命中时回退必得同 id）
    const mirrored = promptRouteMirror(title, requirement, lib.prompts || [])
    if (mirrored) return { prompt: { id: mirrored.id, title: mirrored.title, category: mirrored.category }, channel: 'file' }
    // ② 规则未命中（仅当本地库为空/缺 p-analysis 时可达）：保留改前的整串评分兜底（纯加法）
    const q = (String(title) + ' ' + String(requirement)).toLowerCase()
    const hits = scoreAndSort(lib.prompts || [], q, function (p) {
      return { name: p.title, aliases: (p.tags || []).join(' '), desc: '', tags: p.category || '', content: p.template || '' }
    })
    if (!hits.length) return { prompt: null, channel: 'none' }
    const p = hits[0].item
    return { prompt: { id: p.id, title: p.title, category: p.category }, channel: 'file' }
  }

  // ============ 任务类型路由（复用 skill 规则语义 + 工具族筛选） ============
  function classifyTask(title, requirement, project) {
    const text = (String(title || '') + ' ' + String(requirement || '') + ' ' + String(project || '')).toLowerCase()
    for (const t of TASK_TYPES) {
      if (!t.keywords.length) continue
      for (const k of t.keywords) {
        if (text.indexOf(k.toLowerCase()) >= 0) return t
      }
    }
    return TASK_TYPES[TASK_TYPES.length - 1] // 通用
  }

  // 工具调用记录：weave 登记（working.tool_stats）优先 + raw tool_call 扫描兜底（R4 双通道）
  async function collectToolRecords(taskId, taskType, lastK) {
    lastK = lastK || BUDGET.rawLastK
    const fam = (taskType && taskType.families) || []
    const w = await readWorking(taskId)
    let records = []
    let source = 'weave'
    if (w && w.tool_stats) {
      for (const tn of Object.keys(w.tool_stats)) {
        const st = w.tool_stats[tn]
        if (!fam.length || fam.some(function (f) { return tn.toLowerCase().indexOf(f) >= 0 })) {
          for (const r of (st.lastK || [])) records.push({ toolName: tn, ok: r.ok, at: r.at, content: r.content })
        }
      }
    }
    if (!records.length) {
      // 兜底：raw 扫描 tool_call
      const raws = await readRawRecords(taskId)
      records = raws.filter(function (r) { return r.type === 'tool_call' && r.tool_name && (!fam.length || fam.some(function (f) { return String(r.tool_name).toLowerCase().indexOf(f) >= 0 })) })
        .map(function (r) { return { toolName: r.tool_name, ok: r.ok !== false, at: r.timestamp, content: r.content } })
      source = 'raw-scan'
    }
    // 失败/重试优先（ok=false 置顶），再按时间倒序，截取最近 K 次
    records.sort(function (a, b) {
      if (a.ok !== b.ok) return a.ok ? 1 : -1
      return String(b.at || '').localeCompare(String(a.at || ''))
    })
    return { records: records.slice(0, lastK), source: source, failedFirst: true }
  }

  // raw 下钻片段（≤3 段）：摘要不足时取最近 N 行
  async function rawExcerpts(taskId, maxSegments) {
    maxSegments = maxSegments || BUDGET.rawExcerpts
    const raws = await readRawRecords(taskId)
    const tail = raws.slice(-12)
    return tail.slice(-maxSegments).map(function (r) {
      return { seq: r.seq, type: r.type, source: r.source, timestamp: r.timestamp, content: String(r.content || '').slice(0, 500), tool_name: r.tool_name || null, ok: r.ok }
    })
  }

  // 依赖回溯：BFS，深度 ≤3，合计 ≤20（R3），visited 防环
  async function backtrackSummaries(seedIds, cap) {
    cap = cap || BUDGET.l1
    const graph = (await readGraph()).graph || {}
    const visited = {}
    const queue = []
    const depthMap = {}
    for (const id of seedIds) { if (id && !visited[id]) { visited[id] = true; depthMap[id] = 0; queue.push(id) } }
    const out = []
    while (queue.length && out.length < cap) {
      const id = queue.shift()
      const d = depthMap[id] || 0
      const s = await readSummary(id)
      // 记忆强调：excluded 不进入依赖回溯（主载已覆盖目标任务；排除=不自动注入≠删除，memory_search 仍可检索）
      // Phase3 ④ additive：回溯条目带出 depth（explain 只标注深度不分解分数——回溯非打分入选而是 BFS 依赖图）
      // 深度源自本函数内部 depthMap；唯一调用点 buildContext 并入——给返回摘要附加 depth 字段，主流程既有语义零变化（l1Out 白名单字段不透出）
      if (s && !s.excluded) {
        s.depth = d
        out.push(s)
      }
      if (d >= 3) continue
      const node = graph[id] || {}
      const rels = (node.depends_on || []).concat(node.replaces || [], node.supplements || [])
      for (const t of rels) {
        if (!visited[t] && out.length + queue.length < cap) { visited[t] = true; depthMap[t] = d + 1; queue.push(t) }
      }
    }
    return out
  }

  // 冲突提示：命中条目含 conflicts_with → warnings（不自动消解）
  async function collectConflicts(ids) {
    const graph = (await readGraph()).graph || {}
    const warnings = []
    for (const id of ids) {
      const node = graph[id] || {}
      for (const t of (node.conflicts_with || [])) {
        const other = await readSummary(t)
        warnings.push({ id: id, targetId: t, rel: 'conflicts_with', targetTitle: other ? other.title : t, note: '冲突双方均保留，待用户/主 Agent 判断' })
      }
    }
    return warnings
  }

  // ============ B4-1 记忆分数公式（排序权重增强，上游 calculateMemoryScore 对齐 + 字段代理） ============
  // MVP2 提取：importance 代理纯函数（结论质量 + 决策密度 + kb_refs，封顶 1），memoryScore 与退役看门狗共用（行为等价，调用方零改动）
  function computeImportance(s) {
    const conclusion = String(s.conclusion || '').trim()
    const decisions = Array.isArray(s.decisions) ? s.decisions : []
    const kbRefs = Array.isArray(s.kb_refs) ? s.kb_refs : []
    // importance 代理（L1 无 importance 字段）：结论质量(≥40字0.5/非空0.3) + 决策密度(min(0.3,n×0.1)) + kb_refs(0.2)，封顶 1
    let importance = 0
    if (conclusion.length >= 40) importance += 0.5
    else if (conclusion.length > 0) importance += 0.3
    importance += Math.min(0.3, decisions.length * 0.1)
    if (kbRefs.length) importance += 0.2
    return Math.min(1, importance)
  }
  function memoryScore(s, cfg) {
    cfg = cfg || DEFAULT_SCORE_CONFIG
    const w = cfg.weights || {}
    const importance = computeImportance(s)
    // accessLog 代理（无 access_count 字段）：消息占比对数刻度 log(mc/rc+1)/log(101)
    const rc = Math.max(((s.raw_span && s.raw_span.count) || 0), 1)
    const mc = Number(s.message_count) || 0
    const accessLog = Math.log(mc / rc + 1) / Math.log(101)
    // priority/reinforcement：L1 无字段 → 0（权重保留为可配置占位）
    const priority = 0
    const reinforcement = 0
    // decay：exp(-decayRate×days)；success 且 importance≥阈值 不衰减；closed_at 缺失用 created_at，再缺 decay=1
    let decay = 1
    const closedAt = s.closed_at || s.closedAt || s.created_at
    if (closedAt) {
      const t = new Date(closedAt).getTime()
      if (!isNaN(t) && t > 0) {
        const days = (Date.now() - t) / 86400000
        if (days > 0) {
          const important = s.status === 'success' && importance >= (cfg.importantThreshold || 0.7)
          // 记忆强调：pinned 不衰减（与 important 同权，decay=1）；memoryScore 被 buildContext 与 retireScan 共用 → 双路径天然高分
          decay = (important || s.pinned) ? 1 : Math.exp(-((cfg.decayRate || 0.01)) * days)
        }
      }
    }
    const raw = (importance * (w.importance || 0)) + (accessLog * (w.accessLog || 0)) + (priority * (w.priority || 0)) + (reinforcement * (w.reinforcement || 0))
    return raw * decay
  }
  // B4-1 排序权重配置：memory.json.config.memoryScore 运行时覆盖（enabled/weights/decayRate/importantThreshold/addScale），不加工具参数
  async function resolveScoreConfig() {
    try {
      const m = await readMemory()
      const over = (m.config && m.config.memoryScore) || {}
      const weights = Object.assign({}, DEFAULT_SCORE_CONFIG.weights, over.weights || {})
      return Object.assign({}, DEFAULT_SCORE_CONFIG, over, { weights: weights })
    } catch (e) { return DEFAULT_SCORE_CONFIG }
  }

  // ============ 核心：memory_load 上下文包 ============
  async function buildContext(args) {
    const now = new Date().toISOString()
    const scoreCfg = await resolveScoreConfig() // B4-1：记忆分数排序权重配置（memory.json.config.memoryScore 可覆盖）
    let taskId = String(args.taskId || '')
    let title = String(args.title || '')
    let requirement = String(args.requirement || '')
    let project = String(args.project || '')
    const includeFailed = args.includeFailed !== false
    // Phase3 ④（explain 注入可视化，additive）：args.explain truthy 时在 context 附加 explain（打分分解+回溯深度+skip 原因）
    // 只读预览无副作用：跳过 loadCount bump；falsy/缺省时与旧行为完全一致（零契约破坏，默认输出不新增任何字段）
    const explain = args.explain === true || String(args.explain) === 'true'
    // 看板只读解析（不修改看板）：taskId 给定时始终尝试补全 title/requirement/project（F2）
    if (!taskId && !title) {
      return { status: 400, body: { ok: false, error: '缺少 taskId 或 title' } }
    }
    let boardTask = null
    if (taskId) {
      try {
        const board = await readJsonRef(BOARD_REL, { tasks: [] }, ROOT_TRAIN)
        boardTask = (board.tasks || []).find(function (x) { return x.id === taskId }) || null
        if (boardTask) {
          if (!title) title = String(boardTask.title || '')
          if (!requirement) requirement = String(boardTask.requirement || '')
          if (!project) project = String(boardTask.project || '')
        }
      } catch (e) { /* 看板不可读则用调用方传入 */ }
    }
    // 目标任务摘要（F1/F2）：taskId 精确匹配的目标摘要，raw 下钻与保底入载的判定基准
    const targetSummary = taskId ? await readSummary(taskId) : null
    // 生效项目（F2）：显式 project > 看板 > 工作记忆 > 目标任务摘要；主载同项目过滤与排序基准
    const workingT = taskId ? await readWorking(taskId) : null
    const effectiveProject = project || (boardTask && boardTask.project) || (workingT && workingT.project) || (targetSummary && targetSummary.project) || ''
    const typeRule = classifyTask(title, requirement, project)
    const taskType = typeRule.type
    const channels = { kb: 'none', skill: 'none', prompt: 'none' }

    // 1) L0 项目事实（短小全量）
    let l0 = { project: project, facts: [], total: 0 }
    const facts = await readFacts()
    const factList = project ? (facts.facts || []).filter(function (f) { return !f.project || f.project === project }) : (facts.facts || [])
    l0 = { project: project, facts: factList.slice(0, BUDGET.l0 * 50).map(function (f) { return { id: f.id, project: f.project, content: f.content, source: f.source, updated_at: f.updated_at } }), total: factList.length }
    const pendingCount = (facts.pending || []).length

    // 2) 主载 L1：同 project 候选 + 关键词命中，状态权重排序，默认排除 failed；
    //    F2：目标任务（taskId 精确匹配）强制最高分保底入载；生效项目已知时排除跨项目摘要
    const l1Dir = await listDir(ROOT_DATA, LONGTERM_REL)
    const draftDir = await listDir(ROOT_DATA, DRAFTS_REL)
    const candidates = []
    const q = String((title + ' ' + requirement).trim()).toLowerCase() // F3：先 trim，全空串为 falsy
    const ids = []
    // Phase3 ④（explain 收集，仅 explain truthy 时填充，默认零开销）：打分分解行 / 回溯深度行 / skip 原因行
    // skip 收集预算上限 20（对齐 BUDGET.l1 量级；设计 R1：explain 输出 ≤20 条可控）
    const explainRows = []
    const backtrackExplain = []
    const skippedExplain = []
    for (const n of l1Dir.concat(draftDir)) {
      const id = (n.name || '').replace(/\.json$/, '')
      if (!id) continue
      const s = await readSummary(id)
      if (!s) continue
      if (effectiveProject && s.project && s.project !== effectiveProject && !s.pinned) {
        // Phase3 ④（explain）：skip 原因（被过滤 L616 跨项目非 pinned）
        if (explain && skippedExplain.length < 20) skippedExplain.push({ task_id: id, reason: '跨项目且非 pinned（project 与生效项目不符）' })
        continue
      }
      if (s.status === 'failed' && !includeFailed) {
        // Phase3 ④（explain）：skip 原因（被过滤 L617 failed 且 includeFailed=false）
        if (explain && skippedExplain.length < 20) skippedExplain.push({ task_id: id, reason: 'failed 状态且 includeFailed=false' })
        continue
      }
      // 记忆强调：excluded 跳过主载（目标任务自身除外——正在加载的上下文必须含自身摘要）
      if (s.excluded && s.task_id !== taskId) {
        // Phase3 ④（explain）：skip 原因（被过滤 L619 excluded 排除）
        if (explain && skippedExplain.length < 20) skippedExplain.push({ task_id: id, reason: 'excluded 排除（非目标任务自身）' })
        continue
      }
      let score = 0
      // Phase3 ④（explain）打分分解：origin=本条命中路径；keywordScore 直接引用循环内已算 hit[0].score（R2 零重算零漂移）
      let origin = '常规候选' // 空 q 且非同项目/无项目上下文（含 pinned 跨项目豁免入载）：仅状态/记忆分/置顶贡献
      let keywordScore = null
      const statusW = (STATUS_WEIGHT[s.status] || 0) * 10
      let memRaw = 0
      let memAdd = 0
      let pinnedBonus = 0
      if (s.task_id === taskId) {
        score = 100000 // F2：目标任务保底，任何情况下强制最高分入主载
        origin = 'taskId 保底'
      } else if (q) {
        const hit = scoreAndSort([s], q, function (x) { return { name: x.title, aliases: (x.domain || []).join(' ') + ' ' + (x.tags || []).join(' '), desc: x.goal + ' ' + x.conclusion, tags: x.project || '', content: x.decisions + ' ' + (x.open_questions || '') } })
        score = hit.length ? hit[0].score : 0
        keywordScore = score
        origin = hit.length ? '关键词命中' : '关键词 0-状态/记忆分达阈'
      } else if (effectiveProject && s.project === effectiveProject) {
        score = 40
        origin = '同项目兜底'
      }
      score += statusW
      // B4-1：记忆分数排序权重（0..~25，与状态权重同量级、低于关键词命中 → 相关性仍主导；taskId 保底 100000 不受影响）
      if (scoreCfg.enabled !== false) {
        memRaw = memoryScore(s, scoreCfg)
        memAdd = Math.round(memRaw * (scoreCfg.addScale || 0))
        score += memAdd
      }
      // 记忆强调：pinned 置顶加分（人工轨>自动轨；目标任务 100000 保底仍最高；超出主载 5 条按分数截断，预算不扩容）
      if (s.pinned) {
        pinnedBonus = PINNED_BONUS
        score += PINNED_BONUS
      }
      let row = null
      // Phase3 ④（explain）：逐候选打分分解收集（无 task_id 的占位条目（如 .gitkeep）不进主载 → 不进 explain 行）
      // rank 需排序后回填（L638 之后按序），循环内不可定 → 先 null，row 挂到候选上供回填
      if (explain && s.task_id) {
        row = { task_id: s.task_id, origin: origin, keywordScore: keywordScore, statusWeight: statusW, memScore: memRaw, memAdd: memAdd, pinnedBonus: pinnedBonus, total: score, rank: null }
        explainRows.push(row)
      }
      candidates.push({ s: s, score: score, row: row })
    }
    candidates.sort(function (a, b) { return b.score - a.score })
    // Phase3 ④（explain）：rank 排序后按序回填（1 基全候选名次；rank≤5 = 主载 top5 注入，>5 = 未入前 5）
    if (explain) {
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        if (c && c.row) c.row.rank = i + 1
      }
    }
    const mainHits = candidates.slice(0, 5).map(function (c) { return c.s })
    // F2：目标任务即使无摘要也进入回溯 seed（其依赖图关系可拉取相关前置摘要）
    const seedIds = Array.from(new Set(mainHits.map(function (s) { return s.task_id }).filter(Boolean).concat(taskId ? [taskId] : [])))

    // 3) 依赖回溯（深度≤3，总量≤20 含主载）
    const backtracked = await backtrackSummaries(seedIds, BUDGET.l1)
    const l1All = []
    const seenL1 = {}
    for (const s of mainHits.concat(backtracked)) {
      if (!s || !s.task_id || seenL1[s.task_id]) continue
      seenL1[s.task_id] = true
      l1All.push(s)
      ids.push(s.task_id)
      // Phase3 ④（explain）：回溯条目 additive 深度标注（只对实际并入 l1All 的条目记；depth 由 backtrackSummaries 带出）
      if (explain && s.depth !== undefined) {
        backtrackExplain.push({ task_id: s.task_id, origin: 'backtrack', depth: s.depth })
      }
    }
    const l1Out = l1All.slice(0, BUDGET.l1).map(function (s) {
      return { task_id: s.task_id, title: s.title, status: s.status, project: s.project, domain: s.domain || [], closed_at: s.closed_at || s.closedAt, goal: s.goal, conclusion: s.conclusion, decisions: s.decisions || [], open_questions: s.open_questions || [], source: s.source, pinned: s.pinned === true, excluded: s.excluded === true }
    })

    // 4) 知识加载（KB ≤5）
    const kbRes = q ? await kbSearch(q, BUDGET.kb) : { hits: [], channel: 'none' }
    const kbHits = kbRes.hits
    channels.kb = kbRes.channel

    // 5) 方法记忆：skill 路由 + prompt 引用（不展开全文）
    const skillRes = await skillRoute(title, requirement)
    channels.skill = skillRes.channel
    const skills = skillRes.skill ? [skillRes.skill] : []
    const promptRes = await promptRoute(title, requirement)
    channels.prompt = promptRes.channel
    const prompts = promptRes.prompt ? [promptRes.prompt] : []

    // 6) 工具调用记录选择性加载（weave 优先 + raw 兜底，失败优先，最近 K 次）
    const toolRec = await collectToolRecords(taskId || (seedIds[0] || ''), typeRule, BUDGET.rawLastK)

    // 7) raw 下钻片段（≤3 段）：F1 基于目标任务自身判定——目标任务无摘要或 status∈{failed,interrupted} 时下钻
    const needRaw = !targetSummary || targetSummary.status === 'failed' || targetSummary.status === 'interrupted'
    const rawTaskId = taskId || (seedIds[0] || '')
    const excerpts = needRaw && rawTaskId ? await rawExcerpts(rawTaskId, BUDGET.rawExcerpts) : []

    // 8) 冲突提示（不自动消解）
    const conflicts = await collectConflicts(ids)

    // Phase3 ④（explain）：只读预览不 bump loadCount（防把"预览"计进真实 load 统计）；explain falsy 时与旧行为逐字节同构
    if (!explain) await bumpCounter('loadCount')
    return {
      status: 200,
      body: {
        ok: true,
        context: {
          meta: { taskId: taskId || null, title: title, requirement: requirement, project: project, taskType: taskType, generatedAt: now, channels: channels },
          l0: l0,
          l1: { hits: l1Out, total: l1Out.length, cap: BUDGET.l1 },
          kb: { hits: kbHits, total: kbHits.length, cap: BUDGET.kb },
          methods: { skills: skills, prompts: prompts },
          toolRecords: toolRec,
          rawExcerpts: excerpts,
          conflicts: conflicts,
          factsPending: pendingCount,
          budgets: BUDGET,
          note: '上下文包为 JSON 输出，不自动注入会话正文；由 Agent 整合判断（写入侧不做内容判断）。',
          ...(explain ? {
            // Phase3 ④（注入可视化，结构对齐设计 §5.3）：l1=主循环候选逐条打分分解（rank≤5=主载注入）；backtrack=回溯条目深度标注（不分解分数）；
            // skipped=被主循环过滤的候选原因（可选收集，上限 20）；kb 通道沿用既有 context.kb/meta.channels，不新增逐条分（normalizeKbEntry 已丢弃）
            explain: {
              l1: explainRows,
              backtrack: backtrackExplain,
              skipped: skippedExplain
            }
          } : {})
        }
      }
    }
  }

  // ============ memory_record：写 working + raw ============
  async function doRecord(args) {
    const taskId = String(args.taskId || '')
    if (!taskId) return { status: 400, body: { ok: false, error: '缺少 taskId' } }
    const type = ['message', 'thought', 'artifact'].indexOf(String(args.type || '')) >= 0 ? String(args.type) : 'message'
    const now = new Date().toISOString()
    const w = (await readWorking(taskId)) || {
      task_id: taskId, title: String(args.title || taskId), project: String(args.project || ''), status: 'active',
      created_at: now, last_activity: now, message_count: 0, tool_stats: {}, deps: { depends_on: [], replaces: [], supplements: [], conflicts_with: [] }, kb_used: [], goal: String(args.goal || ''), raw_seq: 0
    }
    w.last_activity = now
    w.message_count = (w.message_count || 0) + 1
    if (args.title) w.title = String(args.title)
    if (args.project) w.project = String(args.project)
    if (args.goal) w.goal = String(args.goal)
    const seq = Math.max(w.raw_seq || 0, await rawSeqFor(taskId))
    const record = {
      id: 'mem-' + String(Date.now()).slice(-8),
      task_id: taskId, seq: seq, type: type,
      source: String(args.source || 'agent'), timestamp: now,
      content: String(args.content || ''),
      tags: Array.isArray(args.tags) ? args.tags : String(args.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
      reply_to: args.reply_to || null
    }
    w.raw_seq = seq
    await writeWorking(taskId, w)
    const ok = await appendRaw(taskId, record)
    await bumpCounter('recordCount')
    return { status: ok ? 200 : 500, body: { ok: ok, id: record.id, seq: seq, taskId: taskId } }
  }

  // ============ memory_weave：工具调用记录选择性登记 ============
  async function doWeave(args) {
    const taskId = String(args.taskId || '')
    const toolName = String(args.toolName || '')
    if (!taskId || !toolName) return { status: 400, body: { ok: false, error: '缺少 taskId/toolName' } }
    const now = new Date().toISOString()
    const w = (await readWorking(taskId)) || {
      task_id: taskId, title: String(args.title || taskId), project: String(args.project || ''), status: 'active',
      created_at: now, last_activity: now, message_count: 0, tool_stats: {}, deps: { depends_on: [], replaces: [], supplements: [], conflicts_with: [] }, kb_used: [], goal: '', raw_seq: 0
    }
    w.last_activity = now
    const st = w.tool_stats[toolName] || { calls: 0, fails: 0, lastK: [] }
    st.calls = (st.calls || 0) + 1
    if (args.ok === false) st.fails = (st.fails || 0) + 1
    st.lastK = (st.lastK || []).concat([{ at: now, ok: args.ok !== false, content: String(args.content || '').slice(0, 300) }]).slice(-10)
    w.tool_stats[toolName] = st
    if (args.kbUsed) {
      const ids = Array.isArray(args.kbUsed) ? args.kbUsed : String(args.kbUsed).split(/[,，]/)
      w.kb_used = Array.from(new Set((w.kb_used || []).concat(ids))).slice(-50)
    }
    await writeWorking(taskId, w)
    // 同步写 raw（type=tool_call，供 R4 兜底扫描）
    const seq = Math.max(w.raw_seq || 0, await rawSeqFor(taskId))
    const record = {
      id: 'mem-' + String(Date.now()).slice(-8),
      task_id: taskId, seq: seq, type: 'tool_call', source: String(args.source || 'agent'), timestamp: now,
      content: String(args.content || '').slice(0, 500),
      tags: ['tool_call'], reply_to: null,
      tool_name: toolName, ok: args.ok !== false
    }
    w.raw_seq = seq
    await writeWorking(taskId, w)
    const ok = await appendRaw(taskId, record)
    await bumpCounter('weaveCount')
    return { status: ok ? 200 : 500, body: { ok: ok, toolName: toolName, calls: st.calls, fails: st.fails, taskId: taskId } }
  }

  // ============ memory_close：闭合 → L1 摘要草稿（待确认）；已确认 L1 不可变（R2 幂等） ============
  async function doClose(args) {
    const taskId = String(args.taskId || '')
    if (!taskId) return { status: 400, body: { ok: false, error: '缺少 taskId' } }
    const status = ['success', 'failed', 'silent_completed', 'interrupted'].indexOf(String(args.status || '')) >= 0 ? String(args.status) : 'silent_completed'
    const now = new Date().toISOString()
    const existing = await readL1(taskId)
    if (existing && !args.force) {
      return { status: 200, body: { ok: true, alreadyClosed: true, id: taskId, existing: { status: existing.status, closed_at: existing.closed_at, title: existing.title }, hint: 'L1 摘要已确认且不可修改；如需修订请用 memory_facts(op=propose) 提议顶层事实，或 force 生成新草稿（不覆盖已确认版）' } }
    }
    const confirm = args.confirm === true || String(args.confirm) === 'true'
    const w = (await readWorking(taskId)) || {}
    const raws = await readRawRecords(taskId)
    const kbRefs = w.kb_used || []
    const draft = {
      task_id: taskId,
      title: String(args.title || w.title || taskId),
      status: status,
      domain: Array.isArray(args.domain) ? args.domain : (String(args.domain || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)),
      project: String(args.project || w.project || ''),
      created_at: w.created_at || now,
      closed_at: now,
      message_count: w.message_count || raws.length || 0,
      artifacts: Array.isArray(args.artifacts) ? args.artifacts : (String(args.artifacts || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)),
      depends_on: (args.depends_on || w.deps && w.deps.depends_on || []),
      replaces: (args.replaces || w.deps && w.deps.replaces || []),
      supplements: (args.supplements || w.deps && w.deps.supplements || []),
      conflicts_with: (args.conflicts_with || w.deps && w.deps.conflicts_with || []),
      goal: String(args.goal || w.goal || ''),
      conclusion: String(args.conclusion || ''),
      decisions: Array.isArray(args.decisions) ? args.decisions : (String(args.decisions || '').split(/\n/).map(function (s) { return s.trim() }).filter(Boolean)),
      open_questions: Array.isArray(args.open_questions) ? args.open_questions : (String(args.open_questions || '').split(/\n/).map(function (s) { return s.trim() }).filter(Boolean)),
      failed_alternatives: Array.isArray(args.failed_alternatives) ? args.failed_alternatives : (String(args.failed_alternatives || '').split(/\n/).map(function (s) { return s.trim() }).filter(Boolean)),
      raw_span: { count: raws.length, first: raws.length ? raws[0].timestamp : null, last: raws.length ? raws[raws.length - 1].timestamp : null },
      kb_refs: kbRefs,
      tool_summary: (function () { const s = {}; for (const k of Object.keys(w.tool_stats || {})) s[k] = { calls: w.tool_stats[k].calls, fails: w.tool_stats[k].fails }; return s })(),
      // 修复(2026-09-06)：原 draft:true 硬编码——confirm 写入 tasks/ 的 L1 仍标 draft:true（语义脏）。draft 标记随 confirm 反转（confirm→false），并删除 drafts/ 同名副本防双存储。
      draft: !confirm,
      confirmed: confirm,
      proposed_at: now,
      closed_by: String(args.closed_by || 'agent')
    }
    if (existing && args.force) draft.supersedes = existing.closed_at
    const targetRel = confirm ? LONGTERM_REL + '/' + taskId + '.json' : DRAFTS_REL + '/' + taskId + '.json'
    const ok = await writeJson(ROOT_DATA, targetRel, draft)
    // confirm 成功 → 清理 drafts/ 同名副本（防同任务双存储；幂等——draft 已不在即跳过）
    if (confirm && ok) {
      try {
        const draftRel = DRAFTS_REL + '/' + taskId + '.json'
        const draftExists = await readJson(ROOT_DATA, draftRel, null).then(function (d) { return !!d }).catch(function () { return false })
        if (draftExists) {
          const { rm } = await import('node:fs/promises')
          const absDraft = await absOf(ROOT_DATA, draftRel)
          try {
            if (absDraft) await rm(absDraft, { force: true })
          } catch (e) {}
          invalidateRef(ROOT_DATA, draftRel)
        }
      } catch (e) {}
    }
    // 同步依赖图
    await doLinkRaw(taskId, 'depends_on', draft.depends_on)
    await doLinkRaw(taskId, 'replaces', draft.replaces)
    await doLinkRaw(taskId, 'supplements', draft.supplements)
    await doLinkRaw(taskId, 'conflicts_with', draft.conflicts_with)
    // 更新 working 状态
    const w2 = (await readWorking(taskId)) || {}
    w2.status = confirm ? 'closed_confirmed' : 'closed_draft'
    w2.closed_at = now
    await writeWorking(taskId, w2)
    await bumpCounter('closeCount')
    // F4：L1 变更后重建 fulltext 轻量关键词索引
    await rebuildFulltext()
    // 可复用结论 → kb 提案（不自动写入 kb，待用户确认；仅当有 conclusion 且非 failed）
    const kbProposal = (status !== 'failed' && draft.conclusion) ? {
      title: '任务结论·' + draft.title,
      description: draft.conclusion.slice(0, 80),
      content: draft.conclusion,
      category: draft.project || '通用',
      tags: draft.domain.concat(['任务摘要', taskId]).slice(0, 6),
      source: 'memory-system:' + taskId
    } : null
    return { status: ok ? 200 : 500, body: { ok: ok, id: taskId, status: status, confirmed: confirm, draft: !confirm, path: await absOf(ROOT_DATA, targetRel), confirmHint: confirm ? 'L1 已确认入库（longterm/tasks/，不可修改）' : 'L1 草稿已生成（drafts/），审核后调用 memory_close(taskId, confirm=true) 确认入库（不可修改）；可复用结论已随 kbProposal 返回，采纳请调 kb_add（不自动写入 kb）', kbProposal: kbProposal } }
  }

  // ============ memory_retire：记忆退役 MVP1（只读数据+写归档+KB 索引，原 L1/raw 不动） ============
  function sanitizeName(name) {
    return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '未命名'
  }
  // raw 聚合（不复制全文）：类型分布 + 工具调用统计 + 时间跨度
  function aggregateRaw(raws) {
    const byType = {}
    const tools = {}
    let first = null
    let last = null
    for (const r of raws) {
      const t = r.type || 'message'
      byType[t] = (byType[t] || 0) + 1
      if (r.tool_name) tools[r.tool_name] = (tools[r.tool_name] || 0) + 1
      if (r.timestamp) {
        if (!first || r.timestamp < first) first = r.timestamp
        if (!last || r.timestamp > last) last = r.timestamp
      }
    }
    return { total: raws.length, byType: byType, tools: tools, first: first, last: last }
  }
  // 结构化退役文件（frontmatter JSON 值 + 摘要正文 + raw 聚合 + 原文引用；frontmatter 供 readSummary L3 回退消费）
  function buildRetireMarkdown(s, rawAgg, fileRel, taskId, title, project) {
    const now = new Date().toISOString()
    const domain = Array.isArray(s.domain) ? s.domain : []
    const tags = Array.from(new Set(domain.concat([project, taskId, '记忆退役']).filter(Boolean)))
    const j = function (v) { return JSON.stringify(v) }
    const listMd = function (arr) { return (Array.isArray(arr) && arr.length) ? arr.map(function (x) { return '- ' + x }).join('\n') : '（无）' }
    const toolSummary = s.tool_summary || {}
    const toolMd = Object.keys(toolSummary).length ? Object.keys(toolSummary).map(function (k) { return k + '×' + toolSummary[k].calls + (toolSummary[k].fails ? '(失败' + toolSummary[k].fails + ')' : '') }).join('、') : '（无）'
    const lines = []
    lines.push('---')
    lines.push('title: ' + j('任务结论·' + taskId + '_' + title))
    lines.push('description: ' + j(String(s.conclusion || s.goal || '').slice(0, 80)))
    lines.push('category: ' + j('记忆归档'))
    lines.push('domain: ' + j(domain))
    lines.push('tags: ' + j(tags))
    lines.push('source: ' + j('memory-system:' + taskId))
    lines.push('sourcePath: ' + j(fileRel))
    lines.push('archived_at: ' + j(now))
    lines.push('task_id: ' + j(taskId))
    lines.push('title_raw: ' + j(title))
    lines.push('project: ' + j(project))
    lines.push('status: ' + j(s.status || 'silent_completed'))
    lines.push('closed_at: ' + j(s.closed_at || s.closedAt || s.created_at || null))
    lines.push('goal: ' + j(String(s.goal || '')))
    lines.push('conclusion: ' + j(String(s.conclusion || '')))
    lines.push('decisions: ' + j(Array.isArray(s.decisions) ? s.decisions : []))
    lines.push('open_questions: ' + j(Array.isArray(s.open_questions) ? s.open_questions : []))
    lines.push('failed_alternatives: ' + j(Array.isArray(s.failed_alternatives) ? s.failed_alternatives : []))
    lines.push('depends_on: ' + j(Array.isArray(s.depends_on) ? s.depends_on : []))
    lines.push('replaces: ' + j(Array.isArray(s.replaces) ? s.replaces : []))
    lines.push('supplements: ' + j(Array.isArray(s.supplements) ? s.supplements : []))
    lines.push('conflicts_with: ' + j(Array.isArray(s.conflicts_with) ? s.conflicts_with : []))
    lines.push('message_count: ' + j(Number(s.message_count) || rawAgg.total || 0))
    lines.push('raw_count: ' + j(rawAgg.total))
    lines.push('raw_first: ' + j(rawAgg.first))
    lines.push('raw_last: ' + j(rawAgg.last))
    lines.push('kb_refs: ' + j(Array.isArray(s.kb_refs) ? s.kb_refs : []))
    lines.push('tool_summary: ' + j(toolSummary))
    lines.push('---')
    lines.push('')
    lines.push('# ' + title + '（记忆退役归档）')
    lines.push('')
    lines.push('## 目标')
    lines.push(String(s.goal || '（无）'))
    lines.push('')
    lines.push('## 结论')
    lines.push(String(s.conclusion || '（无）'))
    lines.push('')
    lines.push('## 关键决策')
    lines.push(listMd(s.decisions))
    lines.push('')
    lines.push('## 未决问题')
    lines.push(listMd(s.open_questions))
    lines.push('')
    lines.push('## 失败尝试')
    lines.push(listMd(s.failed_alternatives))
    lines.push('')
    lines.push('## 原始记录摘要（raw 聚合，不复制全文）')
    lines.push('- 消息数: ' + rawAgg.total + ' | 类型分布: ' + JSON.stringify(rawAgg.byType) + ' | 时间跨度: ' + (rawAgg.first || '—') + ' → ' + (rawAgg.last || '—'))
    lines.push('- 工具调用统计: ' + toolMd)
    lines.push('- 引用知识库: ' + ((s.kb_refs && s.kb_refs.length) ? s.kb_refs.join('、') : '（无）'))
    lines.push('')
    lines.push('## 依赖关系')
    lines.push('- depends_on: ' + JSON.stringify(s.depends_on || []))
    lines.push('- replaces: ' + JSON.stringify(s.replaces || []))
    lines.push('- supplements: ' + JSON.stringify(s.supplements || []))
    lines.push('- conflicts_with: ' + JSON.stringify(s.conflicts_with || []))
    lines.push('')
    lines.push('## 原文位置（无损保留）')
    lines.push('- L1 摘要: 全局数据/memory-system/longterm/tasks/' + taskId + '.json')
    lines.push('- raw 记录: 全局数据/memory-system/raw/' + taskId + '/*.jsonl')
    lines.push('')
    return lines.join('\n')
  }
  // KB 索引（跨插件 HTTP import：sourcePath→kbMode=index+600 截断；title 内嵌 taskId → 天然幂等去重；不旁路直写 KB）
  async function kbIndexRetired(taskId, s, fileRel, title, project) {
    const domain = Array.isArray(s.domain) ? s.domain : []
    const tags = Array.from(new Set(domain.concat([project, taskId, '记忆退役']).filter(Boolean)))
    const parts = []
    if (s.goal) parts.push('目标: ' + s.goal)
    if (s.conclusion) parts.push('结论: ' + s.conclusion)
    if (s.decisions && s.decisions.length) parts.push('关键决策: ' + s.decisions.join('；'))
    if (s.open_questions && s.open_questions.length) parts.push('未决问题: ' + s.open_questions.join('；'))
    let content = parts.join('\n')
    if (!content.trim()) content = '记忆退役归档（无摘要正文，见归档文件原文引用）·' + title + ' · ' + taskId // R1：全空任务 content 兜底，保证 KB 条目必生成
    try {
      const viaHttp = await httpJson('/knowledge-base/api/import', {
        title: '任务结论·' + taskId + '_' + title,
        description: String(s.conclusion || s.goal || '').slice(0, 80),
        content: content,
        category: '记忆归档',
        domain: '记忆归档',
        tags: tags,
        aliases: [title, project].filter(Boolean),
        sourcePath: fileRel
      })
      if (viaHttp && viaHttp.ok) return { indexed: true, skipped: viaHttp.skipped === true, id: viaHttp.id || null, channel: 'http', kbMode: 'index', sourcePath: fileRel }
      return { indexed: false, skipped: false, id: null, channel: viaHttp ? 'http' : 'none', note: 'import 未成功（幂等可重试）' }
    } catch (e) {
      return { indexed: false, skipped: false, id: null, channel: 'none', note: String(e && e.message || e) }
    }
  }
  // MVP2 A4：KB 条目按 title 直读（重退役 sourcePath 核验 / kb_id 补记；回退直读文件，不依赖 HTTP 通道）
  async function kbEntryByTitle(title) {
    try {
      const kb = await readJsonRef(KB_REL, { entries: [] })
      return (kb.entries || []).find(function (e) { return e.title === title }) || null
    } catch (e) { return null }
  }
  // MVP2 A4：重退役路径变更 → 正规 HTTP /knowledge-base/api/update 同步 sourcePath（knowledge-base update editable 白名单已追加 'sourcePath'）
  async function kbUpdateSourcePath(id, sourcePath) {
    const viaHttp = await httpJson('/knowledge-base/api/update', { id: id, patch: { sourcePath: sourcePath } })
    return !!(viaHttp && viaHttp.ok)
  }
  // MVP2 A1+A4：doRetire 内部选项 {moveOut}（仅看门狗调用，memory_retire 工具参数 taskId 不动）——MVP1 步骤 + 移出 L1 活跃域 + gzip 压缩
  async function doRetire(args) {
    const taskId = String(args.taskId || '')
    if (!taskId) return { status: 400, body: { ok: false, error: '缺少 taskId' } }
    const s = await readSummary(taskId)
    if (!s) return { status: 404, body: { ok: false, error: '未找到任务摘要: ' + taskId + '（longterm/tasks 与 drafts 均无，无法退役）' } }
    const title = String(s.title || taskId)
    const project = String(s.project || '通用') || '通用'
    // 归档路径：根内相对（写通道用）+ 绝对口径（manifest.path / KB sourcePath / md frontmatter / node:fs 直用，与迁移前逐字节一致）
    const fileRelInner = sanitizeName(project) + '/' + taskId + '_' + sanitizeName(title) + '.md'
    const fileRel = await absOf(ROOT_ARCHIVE, fileRelInner)
    const raws = await readRawRecords(taskId)
    const rawAgg = aggregateRaw(raws)
    const md = buildRetireMarkdown(s, rawAgg, fileRel, taskId, title, project)
    const wrote = await writeTextFile(ROOT_ARCHIVE, fileRelInner, md)
    if (!wrote) return { status: 500, body: { ok: false, error: '归档文件写入失败: ' + fileRel } }
    // A4 压缩（仅新归档）：md ≥ minCompressBytes → gzipSync + base64 文本封装写 .md.gz；先留 .md（KB sourcePath 核验后才删，防悬挂）
    let compressed = false
    let gzRel = null
    let gzRelInner = null
    let finalPath = fileRel
    let rawSize = 0
    let gzSize = 0
    let sha256 = ''
    let compressError = null
    try {
      const m0 = await readMemory()
      const wd0 = Object.assign({}, DEFAULT_RETIRE_WATCHDOG, (m0.config && m0.config.retireWatchdog) || {})
      const minCompressBytes = Number(wd0.minCompressBytes) > 0 ? Number(wd0.minCompressBytes) : 1024
      if (Buffer.byteLength(md, 'utf8') >= minCompressBytes) {
        const nodeZlib = await import('node:zlib')
        const nodeCrypto = await import('node:crypto')
        const buf = Buffer.from(md, 'utf8')
        rawSize = Buffer.byteLength(md, 'utf8')
        const gz = nodeZlib.gzipSync(buf)
        gzSize = gz.length
        sha256 = nodeCrypto.createHash('sha256').update(buf).digest('hex')
        gzRelInner = fileRelInner + '.gz'
        gzRel = await absOf(ROOT_ARCHIVE, gzRelInner)
        await writeTextRaw(ROOT_ARCHIVE, gzRelInner, gz.toString('base64'))
        compressed = true
        finalPath = gzRel
      }
    } catch (e) { compressed = false; compressError = String(e && e.message || e) }
    const manifest = await readJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, { version: 1, archived: {}, updatedAt: null })
    manifest.archived = manifest.archived || {}
    const now = new Date().toISOString()
    const prev = manifest.archived[taskId] || {}
    manifest.archived[taskId] = {
      task_id: taskId, title: title, project: project, path: finalPath,
      archived_at: now, original_data: 'intact',
      kb_indexed: prev.kb_indexed === true ? true : false,
      compressed: compressed,
      encoding: compressed ? 'base64' : undefined,
      rawSize: compressed ? rawSize : undefined,
      gzSize: compressed ? gzSize : undefined,
      sha256: compressed ? sha256 : undefined,
      kb_id: prev.kb_id || null,
      original_moved: prev.original_moved === true ? true : false,
      original_path: prev.original_path || null,
      readCount: prev.readCount || 0,
      lastReadAt: prev.lastReadAt || null,
      sourcePathSync: prev.sourcePathSync || undefined,
      compressError: compressError || prev.compressError || undefined
    }
    manifest.updatedAt = now
    await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
    // KB 索引（新归档直接以 finalPath 作 sourcePath，无需事后 update）
    const kb = await kbIndexRetired(taskId, s, finalPath, title, project)
    let sourcePathVerified = false
    if (kb.indexed && kb.id) {
      manifest.archived[taskId].kb_indexed = true
      manifest.archived[taskId].kb_id = kb.id
      manifest.updatedAt = new Date().toISOString()
      await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
      sourcePathVerified = true // 本次 import 的 sourcePath 即 finalPath
    } else {
      // 重复退役（import skipped）或 import 未成功：核验/同步 KB 现有条目 sourcePath
      const existing = await kbEntryByTitle('任务结论·' + taskId + '_' + title)
      if (existing) {
        if (!manifest.archived[taskId].kb_id && existing.id) manifest.archived[taskId].kb_id = existing.id
        if (String(existing.sourcePath || '') === finalPath) {
          sourcePathVerified = true
          manifest.archived[taskId].kb_indexed = true
        } else if (existing.id) {
          // 重退役路径变更（明文→gz / project/title 变更）：正规 HTTP update 同步，失败回退明文防悬挂
          const upd = await kbUpdateSourcePath(existing.id, finalPath)
          if (upd) { sourcePathVerified = true; manifest.archived[taskId].kb_indexed = true }
          else manifest.archived[taskId].sourcePathSync = 'failed'
        }
        manifest.updatedAt = new Date().toISOString()
        await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
      }
    }
    // A4 删除时机：仅当 KB sourcePath 已确认指向 finalPath 才 rm .md；否则 manifest 回退明文 + sourcePathSync:'failed'（禁止静默悬挂）
    // 注意：node:fs 只能操作真实绝对路径（沙箱虚拟路径 node:fs 不可见）——此处用 adapterFs 解析出的绝对口径 fileRel/gzRel（对齐 taskkit 直读先例）
    if (compressed) {
      if (sourcePathVerified) {
        try {
          const nodeFs = await import('node:fs')
          nodeFs.rmSync(fileRel, { force: true })
        } catch (e) { /* 删不掉也无碍：manifest 指向 gz，.md 残留不影响读路径 */ }
      } else {
        manifest.archived[taskId].path = fileRel
        manifest.archived[taskId].compressed = false
        manifest.archived[taskId].encoding = undefined
        manifest.archived[taskId].gzSize = undefined
        manifest.archived[taskId].sha256 = undefined
        manifest.archived[taskId].sourcePathSync = 'failed'
        manifest.updatedAt = new Date().toISOString()
        await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
      }
    }
    // A1 移出活跃域（仅内部 {moveOut:true}）：L1 文件 → 记忆归档/原文/<taskId>.json（mkdirSync recursive + copy + rm；raw/working 原位不动）
    let movedOut = false
    let moveOutError = null
    if (args.moveOut === true) {
      try {
        const nodeFs = await import('node:fs')
        const original = await absOf(ROOT_DATA, LONGTERM_REL + '/' + taskId + '.json') // 真实绝对路径（node:fs 直用）
        if (nodeFs.existsSync(original)) {
          const originalDir = await absOf(ROOT_ARCHIVE, '原文')
          nodeFs.mkdirSync(originalDir, { recursive: true })
          nodeFs.copyFileSync(original, originalDir + '/' + taskId + '.json')
          nodeFs.rmSync(original, { force: true })
          manifest.archived[taskId].original_moved = true
          manifest.archived[taskId].original_path = originalDir + '/' + taskId + '.json'
          manifest.updatedAt = new Date().toISOString()
          await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
          movedOut = true
        } else {
          movedOut = prev.original_moved === true // 已移出过则视为成功（幂等，重退役场景）
        }
        // 移出后重建 fulltext（F1 四消费方自动排除；批量时由 retireScan 收尾统一重建一次）
        if (movedOut && args.deferRebuild !== true) await rebuildFulltext()
      } catch (e) {
        movedOut = false
        moveOutError = String(e && e.message || e)
      }
    }
    await bumpCounter('retireCount')
    return {
      status: 200,
      body: {
        ok: true, taskId: taskId, archived: true, path: finalPath,
        compressed: compressed, rawSize: rawSize, gzSize: gzSize, sha256: sha256,
        moveOut: args.moveOut === true ? movedOut : false,
        moveOutError: moveOutError || undefined,
        sourcePathVerified: sourcePathVerified,
        manifest: await absOf(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL), kb: kb,
        note: 'MVP1 退役=归档+KB 可检索；原 L1/raw 数据未动（无真删除）；移出活跃域归 MVP2 看门狗'
      }
    }
  }

  // ============ MVP2 A1 退役「复原」（additive：Phase3 ① memory-system 唯一新端点 /restore） ============
  // 判定优先级（自上而下命中即返回）：前置校验（taskId 空 400 / 归档清单无此任务 404）→ ① entry.restored===true → 200 skipped:already-restored（须先于 ②）
  // → ② entry.original_moved!==true || !entry.original_path → 200 skipped:never-moved（MVP1 归档 L1 原在，"复原"无意义）
  // → ③ 回迁目标 longterm/tasks/<taskId>.json 已存在 → 409（防覆盖：含被打标前已回迁/新草稿同一语义）→ ④ 归档原文缺失 → 404（人工介入）
  // → ⑤ 执行回迁：copyFileSync 原文→L1 目标 + rmSync 原文（先 copy 后删防半程）；manifest 打标 restored:true/restored_at + 复位 original_moved:false/original_path:null（条目保留供审计与 doStats）
  // + rebuildFulltext（复纳入 L1，与 doRetire 移出重建对称）+ bumpCounter('restoreCount')——memory.json 顶层 stats.restoreCount
  // ⚠️ restoreCount 同名异义：doStats 另输出 retire.restoreCount = 归档清单各条 readCount（冷读计数）求和，纯只读统计与复原动作无关；本端点读数一律以 stats.restoreCount 为准
  // KB 档案条目只打标不删（knowledge-base 无 delete）；归档 md/gz 保留（L1 回迁后读路径三级回退 L1 优先，不再命中冷读）；raw/working 从未被移出不动
  async function doRestore(args) {
    const taskId = String(args.taskId || '')
    if (!taskId) return { status: 400, body: { ok: false, code: 'bad-request', error: '缺少 taskId' } }
    const manifest = await readJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, { version: 1, archived: {}, updatedAt: null })
    manifest.archived = manifest.archived || {}
    const entry = manifest.archived[taskId]
    if (!entry) return { status: 404, body: { ok: false, code: 'not-found', error: '归档清单无此任务: ' + taskId } }
    // ① 幂等闸（成功复原会复位 original_moved/original_path，晚判将落入 ②——必须置于 ② 之前）
    if (entry.restored === true) return { status: 200, body: { ok: true, skipped: true, reason: 'already-restored', taskId: taskId, note: '该任务上次复原已打标（restored:true），无需重复复原' } }
    // ② 非 moveOut（MVP1 归档、L1 原在活跃域——"复原"无意义；UI 复原按钮禁用态原因）
    if (entry.original_moved !== true || !entry.original_path) return { status: 200, body: { ok: true, skipped: true, reason: 'never-moved', taskId: taskId, note: '该任务退役时未移出活跃域（original_moved!=true），L1 一直在 longterm/tasks，无需复原' } }
    const targetRelInner = LONGTERM_REL + '/' + taskId + '.json' // 根内相对引用（L1 回迁目标）
    const target = await absOf(ROOT_DATA, targetRelInner) // 真实绝对路径（node:fs 直用；同 doRetire moveOut 先例）
    // ③ 防覆盖 + ④ 原文缺失 + ⑤ 执行回迁（先 copy 后 rm 防半程）
    try {
      const nodeFs = await import('node:fs')
      if (nodeFs.existsSync(target)) return { status: 409, body: { ok: false, code: 'conflict', error: '回迁目标已存在: ' + target + '（禁止覆盖已确认 L1/草稿）', taskId: taskId } }
      if (!nodeFs.existsSync(entry.original_path)) return { status: 404, body: { ok: false, code: 'original-missing', error: '归档原文缺失（人工检查 记忆归档/原文/）: ' + entry.original_path, taskId: taskId } }
      nodeFs.copyFileSync(entry.original_path, target)
      nodeFs.rmSync(entry.original_path, { force: true })
    } catch (e) {
      return { status: 500, body: { ok: false, code: 'restore-failed', error: '回迁失败: ' + String(e && e.message || e), taskId: taskId } }
    }
    invalidateRef(ROOT_DATA, targetRelInner) // node:fs 直写绕过 adapter 写通道 → 显式失效同键缓存（默认 cache:false 下为无害空操作）
    // 回迁成功 → 打标 + 复位（保留清单条目供审计与 doStats；归档 md/gz 与 KB 档案条目保留不动）
    const now = new Date().toISOString()
    entry.restored = true
    entry.restored_at = now
    entry.original_moved = false
    entry.original_path = null
    manifest.updatedAt = now
    await writeJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, manifest)
    await rebuildFulltext() // L1 复纳入（F1 四消费方 load/search/stats/fulltext 自动恢复命中）
    await bumpCounter('restoreCount')
    return {
      status: 200,
      body: {
        ok: true, taskId: taskId, restored: true, path: target,
        note: 'L1 已回迁 longterm/tasks；归档 md/KB 档案条目保留不动（KB 无删除能力），重退役按 title 幂等刷新'
      }
    }
  }

  // ============ MVP2 A1 退役看门狗（TTL 自动退役候选：超龄+低活跃 L1 → memory_retire + moveOut 移出活跃域） ============
  // 候选规则：ageDays(closed_at||created_at) ≥ maxAgeDays 且 memoryScore < minScore 且排除重要(excludeImportant)/failed(excludeFailed)
  // 配置：retireCfg = Object.assign({}, await resolveScoreConfig(), memory.json.config.retireWatchdog) —— 权重/衰减/重要阈值继承 memoryScore 配置形态
  // 幂等三层：移出后不在 longterm 天然不命中 / doRetire 清单按 task_id 刷新+KB title 去重 / retireScanRunning 重入锁 + batchSize 单轮上限
  // 门控自洽：important 任务（success+importance≥0.7）decay=1 → score≥0.21>minScore(0.15) 天然不退役，excludeImportant 双保险
  async function retireScan(opts) {
    opts = opts || {}
    if (retireScanRunning) return { ok: false, skipped: true, reason: 'scan-running' }
    retireScanRunning = true
    try {
      const m = await readMemory()
      const wd = Object.assign({}, DEFAULT_RETIRE_WATCHDOG, (m.config && m.config.retireWatchdog) || {})
      const cfg = Object.assign({}, await resolveScoreConfig(), wd)
      const force = opts.force === true
      const dryRun = opts.dryRun === true || cfg.dryRun === true
      if (cfg.enabled !== true && !force && !dryRun) return { ok: true, skipped: true, reason: 'disabled', candidates: [], count: 0 }
      retireLastScanAt = new Date().toISOString()
      if (!dryRun) await bumpCounter('watchdogRuns')
      const dirs = (await listDir(ROOT_DATA, LONGTERM_REL)).filter(function (e) { return !String(e.name || '').startsWith('.') })
      const candidates = []
      const now = Date.now()
      for (const n of dirs) {
        if (candidates.length >= cfg.batchSize) break
        const id = (n.name || '').replace(/\.json$/, '')
        if (!id) continue
        const s = await readSummary(id)
        if (!s) continue
        // 记忆强调：pinned 显式跳过退役候选（decay=1 单保险不足——低内容 pinned 的 memoryScore 仍可能 < minScore，双保险）
        if (s.pinned) continue
        const ts = s.closed_at || s.closedAt || s.created_at
        if (!ts) continue // 缺失时间戳 → 跳过（不误杀旧格式）
        const t = new Date(ts).getTime()
        if (isNaN(t) || t <= 0) continue
        const ageDays = (now - t) / 86400000
        if (ageDays < cfg.maxAgeDays) continue
        const score = memoryScore(s, cfg)
        if (score >= cfg.minScore) continue
        const importance = computeImportance(s)
        if (cfg.excludeImportant !== false && s.status === 'success' && importance >= (cfg.importantThreshold || 0.7)) continue
        if (cfg.excludeFailed !== false && s.status === 'failed') continue
        candidates.push({
          taskId: id, title: s.title || id, status: s.status || 'unknown',
          ageDays: Math.round(ageDays * 10) / 10,
          score: Math.round(score * 1000) / 1000,
          importance: Math.round(importance * 1000) / 1000,
          reason: '超龄(' + Math.round(ageDays) + '天) + 低活跃(score=' + Math.round(score * 1000) / 1000 + '<' + cfg.minScore + ')'
        })
      }
      if (dryRun) return { ok: true, dryRun: true, candidates: candidates, count: candidates.length, scanned: dirs.length, lastScanAt: retireLastScanAt }
      let retired = 0
      let errors = 0
      const errs = []
      for (const c of candidates) {
        try {
          const r = await doRetire({ taskId: c.taskId, moveOut: cfg.moveOut === true, deferRebuild: true })
          if (r.status === 200) { retired++; await bumpCounter('watchdogRetired') }
          else { errors++; await bumpCounter('watchdogErrors'); errs.push({ taskId: c.taskId, error: (r.body && r.body.error) || 'retire failed' }) }
        } catch (e) { errors++; await bumpCounter('watchdogErrors'); errs.push({ taskId: c.taskId, error: String(e && e.message || e) }) }
      }
      if (retired) await rebuildFulltext() // 批次收尾统一重建一次（移出文件从 fulltext 消失，F1 四消费方自动排除）
      return { ok: true, run: true, retired: retired, errors: errors, count: candidates.length, candidates: candidates, errs: errs, lastScanAt: retireLastScanAt }
    } finally {
      retireScanRunning = false
    }
  }

  async function doLinkRaw(taskId, rel, targets) {
    if (!Array.isArray(targets) || !targets.length) return
    const graph = await readGraph()
    graph.graph = graph.graph || {}
    graph.graph[taskId] = graph.graph[taskId] || { depends_on: [], replaces: [], supplements: [], conflicts_with: [] }
    for (const t of targets) {
      const arr = graph.graph[taskId][rel] || (graph.graph[taskId][rel] = [])
      if (arr.indexOf(t) < 0) arr.push(t)
    }
    graph.updatedAt = new Date().toISOString()
    await writeJson(ROOT_DATA, INDEX_GRAPH_REL, graph)
  }

  // ============ memory_link：依赖图 ============
  async function doLink(args) {
    const id = String(args.id || '')
    const rel = String(args.rel || '')
    const targetId = String(args.targetId || '')
    if (!id || !targetId) return { status: 400, body: { ok: false, error: '缺少 id/targetId' } }
    if (RELS.indexOf(rel) < 0) return { status: 400, body: { ok: false, error: 'rel 必须为 ' + RELS.join('|') } }
    const graph = await readGraph()
    graph.graph = graph.graph || {}
    graph.graph[id] = graph.graph[id] || { depends_on: [], replaces: [], supplements: [], conflicts_with: [] }
    const arr = graph.graph[id][rel] || (graph.graph[id][rel] = [])
    if (arr.indexOf(targetId) < 0) arr.push(targetId)
    graph.updatedAt = new Date().toISOString()
    const ok = await writeJson(ROOT_DATA, INDEX_GRAPH_REL, graph)
    // 同步 working deps
    const w = await readWorking(id)
    if (w) {
      w.deps = w.deps || { depends_on: [], replaces: [], supplements: [], conflicts_with: [] }
      const warr = w.deps[rel] || (w.deps[rel] = [])
      if (warr.indexOf(targetId) < 0) warr.push(targetId)
      await writeWorking(id, w)
    }
    await bumpCounter('linkCount')
    return { status: ok ? 200 : 500, body: { ok: ok, id: id, rel: rel, targetId: targetId, graph: graph.graph[id] } }
  }

  // ============ memory_facts：L0 读 / 提议 / 确认 / 拒绝 ============
  async function doFacts(args) {
    const op = String(args.op || 'get')
    const facts = await readFacts()
    if (op === 'get') {
      const project = String(args.project || '')
      const list = project ? (facts.facts || []).filter(function (f) { return !f.project || f.project === project }) : (facts.facts || [])
      return { status: 200, body: { ok: true, op: 'get', project: project || null, facts: list, pending: (facts.pending || []).slice(0, 50), last_updated: facts.last_updated } }
    }
    if (op === 'propose') {
      const content = String(args.content || '')
      const project = String(args.project || '')
      const source = String(args.source || 'agent')
      if (!content) return { status: 400, body: { ok: false, error: '缺少 content' } }
      facts.pending = facts.pending || []
      const dup = facts.pending.some(function (p) { return p.content === content && p.project === project })
      const dupActive = (facts.facts || []).some(function (f) { return f.content === content })
      if (dup || dupActive) return { status: 200, body: { ok: true, op: 'propose', skipped: true, reason: '已存在待确认或已生效' } }
      facts.pending.push({ id: 'fp-' + String(Date.now()).slice(-8), project: project, content: content, source: source, proposed_at: new Date().toISOString() })
      facts.last_updated = new Date().toISOString()
      const ok = await writeJson(ROOT_DATA, FACTS_REL, facts)
      await bumpCounter('factProposals')
      return { status: ok ? 200 : 500, body: { ok: ok, op: 'propose', pending: facts.pending.length, hint: '已入待确认区；确认用 memory_facts(op=confirm, factId=...)' } }
    }
    if (op === 'confirm') {
      const factId = String(args.factId || '')
      const idx = (facts.pending || []).findIndex(function (p) { return p.id === factId })
      if (idx < 0) return { status: 404, body: { ok: false, error: '未找到待确认事实: ' + factId } }
      const p = facts.pending[idx]
      facts.pending.splice(idx, 1)
      facts.facts = facts.facts || []
      const fv = (facts.version || 1)
      facts.facts.unshift({ id: 'f-' + String(Date.now()).slice(-8), project: p.project, content: p.content, source: p.source, created_at: p.proposed_at, updated_at: new Date().toISOString(), version: fv })
      facts.version = fv + 1
      facts.last_updated = new Date().toISOString()
      const ok = await writeJson(ROOT_DATA, FACTS_REL, facts)
      // F4：L0 变更后重建 fulltext 轻量关键词索引
      await rebuildFulltext()
      return { status: ok ? 200 : 500, body: { ok: ok, op: 'confirm', factId: factId, facts: facts.facts.length } }
    }
    if (op === 'reject') {
      const factId = String(args.factId || '')
      const before = (facts.pending || []).length
      facts.pending = (facts.pending || []).filter(function (p) { return p.id !== factId })
      if (facts.pending.length === before) return { status: 404, body: { ok: false, error: '未找到待确认事实: ' + factId } }
      facts.last_updated = new Date().toISOString()
      const ok = await writeJson(ROOT_DATA, FACTS_REL, facts)
      return { status: ok ? 200 : 500, body: { ok: ok, op: 'reject', factId: factId } }
    }
    return { status: 400, body: { ok: false, error: 'op 必须为 get|propose|confirm|reject' } }
  }

  // ============ memory_search：跨层检索（默认 L0+L1+KB，raw 排除） ============
  async function doSearch(args) {
    const q = String(args.q || '').trim().toLowerCase()
    const layer = String(args.layer || 'all')
    if (!q) return { status: 400, body: { ok: false, error: '缺少 q' } }
    const out = []
    const layers = layer === 'all' ? ['l0', 'l1', 'kb'] : [layer]
    if (layers.indexOf('l0') >= 0) {
      const facts = await readFacts()
      const hits = scoreAndSort(facts.facts || [], q, function (f) { return { name: f.project || '', aliases: '', desc: f.content, tags: '', content: f.content } })
      for (const h of hits) out.push({ layer: 'l0', id: h.item.id, title: (h.item.project || '项目事实') + ' #' + h.item.id, description: String(h.item.content).slice(0, 120), score: h.score })
    }
    if (layers.indexOf('l1') >= 0) {
      const dirs = await listDir(ROOT_DATA, LONGTERM_REL).catch(function () { return [] })
      const drafts = await listDir(ROOT_DATA, DRAFTS_REL).catch(function () { return [] })
      for (const n of dirs.concat(drafts)) {
        const id = (n.name || '').replace(/\.json$/, '')
        if (!id) continue
        const s = await readSummary(id)
        if (!s) continue
        const hit = scoreAndSort([s], q, function (x) { return { name: x.title, aliases: (x.domain || []).join(' ') + (x.tags || []).join(' '), desc: x.goal + ' ' + x.conclusion, tags: x.project || '', content: x.decisions } })
        if (hit.length) out.push({ layer: 'l1', id: s.task_id, title: s.title, description: String(s.conclusion || s.goal || '').slice(0, 120), score: hit[0].score, status: s.status })
      }
    }
    if (layers.indexOf('kb') >= 0) {
      const kbRes = await kbSearch(q, 20)
      for (const h of kbRes.hits) out.push({ layer: 'kb', id: h.id, title: h.title, description: h.description, score: 50 })
    }
    out.sort(function (a, b) { return b.score - a.score })
    await bumpCounter('searchCount')
    return { status: 200, body: { ok: true, q: q, layer: layer, total: out.length, entries: out.slice(0, 30) } }
  }

  // ============ memory_conflicts：冲突列表（R5：补齐工具，与 API 对齐） ============
  async function doConflicts(args) {
    const graph = (await readGraph()).graph || {}
    const taskId = String(args.taskId || '')
    const out = []
    for (const id of Object.keys(graph)) {
      if (taskId && id !== taskId) continue
      const node = graph[id] || {}
      for (const t of (node.conflicts_with || [])) {
        const s = await readSummary(id)
        const o = await readSummary(t)
        out.push({ id: id, title: s ? s.title : id, targetId: t, targetTitle: o ? o.title : t, rel: 'conflicts_with', unresolved: true })
      }
    }
    return { status: 200, body: { ok: true, taskId: taskId || null, total: out.length, conflicts: out } }
  }

  // ============ memory_stats：自检/统计 ============
  async function doStats() {
    const facts = await readFacts()
    const l1Dir = (await listDir(ROOT_DATA, LONGTERM_REL)).filter(function (e) { return !String(e.name || '').startsWith('.') })
    const draftDir = (await listDir(ROOT_DATA, DRAFTS_REL)).filter(function (e) { return !String(e.name || '').startsWith('.') })
    const workDir = (await listDir(ROOT_DATA, WORKING_REL)).filter(function (e) { return !String(e.name || '').startsWith('.') })
    const rawDir = (await listDir(ROOT_DATA, RAW_REL)).filter(function (e) { return !String(e.name || '').startsWith('.') })
    let rawRecords = 0
    for (const d of rawDir) {
      const names = (await listDir(ROOT_DATA, RAW_REL + '/' + d.name)).filter(function (e) { return /\.jsonl$/.test(e.name || '') })
      rawRecords += names.length
    }
    const graph = await readGraph()
    const fulltext = await readFulltext()
    const m = await readMemory()
    const kb = await readJsonRef(KB_REL, { entries: [] })
    const skills = await readJsonRef(SKILLS_REL, { skills: [] })
    const prompts = await readJsonRef(PROMPTS_REL, { prompts: [] })
    // MVP2 A4：退役质量评估（additive 段，工具签名不变）
    const manifest = await readJson(ROOT_ARCHIVE, ARCHIVE_MANIFEST_REL, { archived: {} })
    const archivedEntries = Object.keys(manifest.archived || {}).map(function (k) { return manifest.archived[k] })
    const compressedEntries = archivedEntries.filter(function (e) { return e.compressed === true })
    const kbIndexedEntries = archivedEntries.filter(function (e) { return e.kb_indexed === true })
    let totalRawBytes = 0
    let totalGzBytes = 0
    for (const e of compressedEntries) { totalRawBytes += Number(e.rawSize) || 0; totalGzBytes += Number(e.gzSize) || 0 }
    const ratio = totalRawBytes > 0 ? Math.round((totalGzBytes / totalRawBytes) * 1000) / 1000 : 0
    const decodeAvgMs = decodeSamples.length ? Math.round(decodeSamples.reduce(function (a, b) { return a + b }, 0) / decodeSamples.length * 10) / 10 : 0
    const decodeMaxMs = decodeSamples.length ? Math.max.apply(null, decodeSamples) : 0
    const restoreCount = archivedEntries.reduce(function (a, e) { return a + (Number(e.readCount) || 0) }, 0)
    const archivedDomainHits = (kb.entries || []).filter(function (e) { return e.domain === '记忆归档' }).length
    const activeKbEntries = (kb.entries || []).filter(function (e) { return e.kbStatus !== 'cold' }).length
    return {
      status: 200,
      body: {
        ok: true, plugin: 'memory-system', version: '0.1.0', dataDir: await absOf(ROOT_DATA, MEM_DIR_REL), ts: Date.now(),
        layers: {
          facts: (facts.facts || []).length, factsPending: (facts.pending || []).length,
          longterm: l1Dir.length, drafts: draftDir.length, working: workDir.length,
          rawTasks: rawDir.length, rawRecords: rawRecords,
          graphEntries: Object.keys((graph.graph || {})).length, fulltextEntries: (fulltext.entries || []).length
        },
        external: { kbEntries: (kb.entries || []).length, skills: (skills.skills || []).length, prompts: (prompts.prompts || []).length },
        counters: m.stats || {},
        retire: {
          archived: archivedEntries.length,
          compressed: compressedEntries.length,
          kbIndexed: kbIndexedEntries.length,
          totalRawBytes: totalRawBytes, totalGzBytes: totalGzBytes, ratio: ratio,
          decodeStats: { samples: decodeSamples.length, avgMs: decodeAvgMs, maxMs: decodeMaxMs },
          restoreReads: (m.stats && m.stats.retireReadCount) || 0,
          restoreCount: restoreCount,
          watchdog: { runs: (m.stats && m.stats.watchdogRuns) || 0, retired: (m.stats && m.stats.watchdogRetired) || 0, errors: (m.stats && m.stats.watchdogErrors) || 0, lastScanAt: retireLastScanAt },
          kbQuality: { archivedDomainHits: archivedDomainHits, activeKbEntries: activeKbEntries }
        },
        budgets: BUDGET,
        config: Object.assign({ migration: 'from-new-tasks（存量不迁移，从新任务开始积累）', rawPolicy: 'append-only' }, m.config || {})
      }
    }
  }

  // ============ 记忆强调（P0 双轨）：memory_pin / memory_exclude（additive 标记写回 L1 摘要文件） ============
  // 语义：pinned=置顶（排序置顶+不衰减+看门狗跳过）、excluded=排除（主载/回溯跳过，显式检索仍命中）；二者互斥（pin 清 exclude，exclude 清 pin）
  // 写路径按 readSummary 优先级（已确认 L1 优先，草稿次之）；只写强调标记字段，L1 内容字段仍不可修改；退役归档（cold）不可强调
  async function patchSummaryFlag(taskId, patch) {
    const l1 = await readL1(taskId)
    if (l1) {
      const merged = Object.assign({}, l1, patch)
      const rel = LONGTERM_REL + '/' + taskId + '.json'
      const ok = await writeJson(ROOT_DATA, rel, merged)
      return { ok: ok, path: await absOf(ROOT_DATA, rel), source: 'confirmed' }
    }
    const d = await readDraft(taskId)
    if (d) {
      const merged = Object.assign({}, d, patch)
      const rel = DRAFTS_REL + '/' + taskId + '.json'
      const ok = await writeJson(ROOT_DATA, rel, merged)
      return { ok: ok, path: await absOf(ROOT_DATA, rel), source: 'draft' }
    }
    return { ok: false, path: null, source: null }
  }
  async function doPin(args) {
    const taskId = String(args.taskId || '')
    if (!taskId) return { status: 400, body: { ok: false, error: '缺少 taskId' } }
    const pinned = !(args.pinned === false || String(args.pinned) === 'false') // 缺省/true → 置顶；false → 取消置顶（memory_unpin 语义）
    const patch = pinned ? { pinned: true, excluded: false } : { pinned: false } // 置顶与排除互斥
    const r = await patchSummaryFlag(taskId, patch)
    if (!r.ok) return { status: 404, body: { ok: false, error: '未找到任务摘要: ' + taskId + '（longterm/tasks 与 drafts 均无；退役归档不可强调）' } }
    await bumpCounter(pinned ? 'pinCount' : 'unpinCount')
    return { status: 200, body: { ok: true, taskId: taskId, pinned: pinned, source: r.source, path: r.path, note: pinned ? '已置顶：memory_load 排序置顶（跨项目豁免）+ 不衰减 + 退役看门狗显式跳过' : '已取消置顶' } }
  }
  async function doExclude(args) {
    const taskId = String(args.taskId || '')
    if (!taskId) return { status: 400, body: { ok: false, error: '缺少 taskId' } }
    const excluded = !(args.excluded === false || String(args.excluded) === 'false') // 缺省/true → 排除；false → 取消排除（memory_unexclude 语义）
    const patch = excluded ? { excluded: true, pinned: false } : { excluded: false } // 排除与置顶互斥
    const r = await patchSummaryFlag(taskId, patch)
    if (!r.ok) return { status: 404, body: { ok: false, error: '未找到任务摘要: ' + taskId + '（longterm/tasks 与 drafts 均无；退役归档不可强调）' } }
    await bumpCounter(excluded ? 'excludeCount' : 'unexcludeCount')
    return { status: 200, body: { ok: true, taskId: taskId, excluded: excluded, source: r.source, path: r.path, note: excluded ? '已排除：memory_load 主载与依赖回溯跳过（不自动注入≠删除，memory_search 仍可检索；排除不豁免退役）' : '已取消排除' } }
  }

  // ============ Phase3 ② 记忆策略调参写回（additive：/config 端点，白名单深合并+双校验） ============
  // 范围：只读写 memory.json.config.memoryScore（enabled/weights×4/decayRate/importantThreshold/addScale，键名对齐 DEFAULT_SCORE_CONFIG 与 resolveScoreConfig L554-561）；
  //       config.rawPolicy/migration 与 retireWatchdog 等其余键一律只读（未知键 400）；不新增数据文件、不改 resolveScoreConfig/retireScan/buildContext（写端点只是让运行时覆盖第一次可达 HTTP）
  // 读（GET 或 POST 无 memoryScore 键）：返回生效配置 = resolveScoreConfig 结果（DEFAULT 合并 memory.json 现值，同 load/retireScan 打分所用 scoreCfg 同键）
  // 写（POST {memoryScore:{...}}）：白名单字段校验（未知键 400 / 类型错 400 / 越界 400，结构化 {ok:false, code, error}）→ 深合并（保留未提交字段现值，weights 子键级合并防丢其它权重）→ writeJson 落盘（自动 invalidate 缓存）→ resolveScoreConfig 读回生效
  const CONFIG_WHITELIST = {
    enabled: 'boolean',
    weights: { importance: 'number01', accessLog: 'number01', priority: 'number01', reinforcement: 'number01' },
    decayRate: 'number01',
    importantThreshold: 'number01',
    addScale: 'number0010000'
  }
  const CONFIG_WHITELIST_KEYS = Object.keys(CONFIG_WHITELIST)
  const CONFIG_WEIGHT_KEYS = Object.keys(CONFIG_WHITELIST.weights)
  async function doConfig(args) {
    args = args || {}
    const topKeys = Object.keys(args)
    // —— 读模式：无任何入参键（GET / POST 空 body {}）→ 返回当前生效 memoryScore 配置（默认值合并实际值） ——
    if (topKeys.length === 0) {
      const eff = await resolveScoreConfig()
      return { status: 200, body: { ok: true, mode: 'read', config: { memoryScore: eff } } }
    }
    // —— 写模式：只允许 memoryScore 一个命名空间（其余 config 键只读，POST 携带即视为写意图 → 未知键 400 列白名单） ——
    const extra = topKeys.filter(function (k) { return k !== 'memoryScore' })
    if (extra.length) return { status: 400, body: { ok: false, code: 'invalid-key', error: '非法配置键: ' + extra[0] + '（config 写白名单仅 memoryScore；rawPolicy/migration/retireWatchdog 等只读）' } }
    const patch = args.memoryScore
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { status: 400, body: { ok: false, code: 'invalid-type', error: 'memoryScore 必须是对象' } }
    const valErr = function (code, msg) { return { status: 400, body: { ok: false, code: code, error: msg } } }
    const isNum = function (v) { return typeof v === 'number' && isFinite(v) }
    // 白名单/类型/范围校验（memory-system 层兜底；host 层白名单先行属 writing-studio 侧，双校验同语义）
    for (const k of Object.keys(patch)) {
      if (CONFIG_WHITELIST_KEYS.indexOf(k) < 0) return valErr('invalid-key', '非法配置键: memoryScore.' + k + '（白名单: ' + CONFIG_WHITELIST_KEYS.join(', ') + '）')
      const v = patch[k]
      if (k === 'enabled') {
        if (typeof v !== 'boolean') return valErr('invalid-value', 'memoryScore.enabled 必须是布尔值 true/false（收到: ' + JSON.stringify(v) + '）')
      } else if (k === 'weights') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return valErr('invalid-value', 'memoryScore.weights 必须是对象 {importance,accessLog,priority,reinforcement}（每项 0-1）')
        for (const wk of Object.keys(v)) {
          if (CONFIG_WEIGHT_KEYS.indexOf(wk) < 0) return valErr('invalid-key', '非法权重键: memoryScore.weights.' + wk + '（白名单: ' + CONFIG_WEIGHT_KEYS.join(', ') + '）')
          const wv = v[wk]
          if (!isNum(wv) || wv < 0 || wv > 1) return valErr('invalid-value', 'memoryScore.weights.' + wk + ' 必须是 0-1 数值（收到: ' + JSON.stringify(wv) + '）')
        }
      } else {
        const max = CONFIG_WHITELIST[k] === 'number0010000' ? 10000 : 1
        if (!isNum(v) || v < 0 || v > max) return valErr('invalid-value', 'memoryScore.' + k + ' 必须是 0-' + max + ' 数值（收到: ' + JSON.stringify(v) + '）')
      }
    }
    // 深合并：以现有 stored memoryScore 为基础，仅覆盖提交字段；weights 子键级合并（保留现值防丢）
    const m = await readMemory()
    m.config = m.config || {}
    const cur = (m.config.memoryScore && typeof m.config.memoryScore === 'object' && !Array.isArray(m.config.memoryScore)) ? m.config.memoryScore : {}
    const merged = Object.assign({}, cur)
    for (const k of Object.keys(patch)) {
      if (k === 'weights') {
        const curW = (cur.weights && typeof cur.weights === 'object' && !Array.isArray(cur.weights)) ? cur.weights : {}
        merged.weights = Object.assign({}, curW, patch.weights)
      } else {
        merged[k] = patch[k]
      }
    }
    m.config.memoryScore = merged
    m.updatedAt = new Date().toISOString()
    const okWrite = await writeJson(ROOT_DATA, MEMORY_REL, m)
    if (!okWrite) {
      invalidateRef(ROOT_DATA, MEMORY_REL) // 写失败：丢弃缓存对象（默认 cache:false 下为无害空操作），回源磁盘
      return { status: 500, body: { ok: false, code: 'write-failed', error: 'memory.json 写入失败（config 未落盘）' } }
    }
    const eff = await resolveScoreConfig() // 写后读回：writeJson 已失效同键缓存 → resolveScoreConfig 从磁盘读新值即生效
    return { status: 200, body: { ok: true, mode: 'write', config: { memoryScore: eff }, persisted: { memoryScore: merged }, appliedAt: m.updatedAt } }
  }

  // ============ 记忆接入体系 Phase 1：memory_sync_board（additive：唯一新 action 'sync-board'） ============
  // 设计锚点：《记忆接入体系_设计方案.md》v1.2 §4.4/§6/§7.3（修订 2-a 批次收尾 rebuildFulltext、2-b 目录自建+时间注入、
  //   2-c 存在性探测=readSummary、2-d 样板剥离、3 内容门定稿）。扫描源=写作训练/任务看板.json（BOARD_REL，同 buildContext L587 读板通道）。
  // 双轨单向管道「权威→memory 可重建」：只读看板 → 判定内容门 + readSummary 幂等 → run 直写 longterm/drafts/<taskId>.json 草稿
  //   （draft:true / confirmed:false，绝不自动 confirm——L1 质量闸门留给 agent/人）；看板/KB 等权威侧零写入。
  // 零契约破坏：不改既有 13 工具注册与 18 action，只 append 本函数 + 1 case + actions 清单 1 项。
  const RECEIPT_MARK = '📮'
  function isReceiptLine(text) { // 修订 2-d：含「📮」或 taskId=/phase=/result=/summary= 键值样板 → 判为回执格式行
    const t = String(text || '')
    return t.indexOf(RECEIPT_MARK) >= 0 || /(?:taskId|phase|result|summary)=/.test(t)
  }
  function stripReceiptResidue(text) { // 修订 2-d：剔除 📮/阶段回执/键= 样板残片与字段分隔竖线（全部出现，非仅首个）
    return String(text || '')
      .replace(/📮/g, '')
      .replace(/阶段回执/g, '')
      .replace(/(?:taskId|phase|result|summary)=[^\s|｜，,;；]*/g, '')
      .replace(/[｜|]/g, '，')
      .replace(/[ \t]+/g, ' ').replace(/^[，,\s]+|[，,\s]+$/g, '')
      .trim()
  }
  // conclusion 提取（§6 映射表）：①note 中「完成说明:」/「回执完成:」段（截 ≤300 字）→ ②无则留空（宁缺毋滥，待 agent confirm 补）；
  //   该段即「📮 阶段回执｜taskId=…｜phase=…｜result=…｜summary=…」键值包裹 → 提取顺序=取 summary= 之后的值 → 无 summary= 才取段文本并剔除样板残片
  function extractConclusion(note) {
    const raw = String(note || '')
    let seg = ''
    for (const mark of ['完成说明:', '回执完成:']) {
      const idx = raw.lastIndexOf(mark)
      if (idx >= 0) { seg = raw.slice(idx + mark.length); break }
    }
    if (!seg.trim()) return ''
    let out = ''
    const sm = /summary=([\s\S]*)$/.exec(seg)
    if (sm && sm[1] && sm[1].trim()) out = sm[1] // 取 summary= 之后的值（真实结论正文，样板残片剔除兜底）
    else out = seg // 无 summary= 才取段文本 → 正则剔除样板残片
    return stripReceiptResidue(out).slice(0, 300)
  }
  function splitLessonsList(v) { // 看板 lessons：数组直用；字符串按 分号/换行 拆分（对齐 tsk_complete C12 拆分语义，勿按逗号——正文可含逗号）
    if (Array.isArray(v)) return v.map(function (s) { return String(s).trim() }).filter(Boolean)
    if (v === null || v === undefined || v === '') return []
    return String(v).split(/[;；\n]/).map(function (s) { return s.trim() }).filter(Boolean)
  }
  function splitArtifactsList(v) { // artifacts：数组直用；字符串按 逗号 拆分（对齐 tsk_complete C12）
    if (Array.isArray(v)) return v.map(function (s) { return String(s).trim() }).filter(Boolean)
    if (v === null || v === undefined || v === '') return []
    return String(v).split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
  }
  function extractKbRefs(texts) { // kb_refs：lessons/requirement 内「kb-xxxxx」正则提取并入（task-583687「经验入库 kb-933941」先例）
    const refs = []
    const re = /kb-[0-9a-zA-Z]+/g
    for (const t of texts) {
      if (t === null || t === undefined) continue
      let m = null
      while ((m = re.exec(String(t))) !== null) refs.push(m[0])
    }
    return Array.from(new Set(refs))
  }
  // doSyncBoard：权威→memory 单向重建端点（dryrun 预览零写入；run 直写 L1 草稿 + 批次收尾 rebuildFulltext）
  // 入参：mode='dryrun'|'run'（缺省 dryrun，兼容 dryrun=true/run=true 布尔入参）；includeBare=true 放行仅 note 任务（缺省 false）
  //   taskIds=单任务过滤（Phase 2 实时化 additive）：数组或逗号分隔字符串；给定时只扫描这些已完成任务（taskkit 完成钩子用），缺省=全量（Phase 1 行为不变）
  // 返回：{ok, dryrun|run, scanned, candidates|created, skipped:[{taskId,reason}], taskIds}
  async function doSyncBoard(args) {
    args = args || {}
    const mode = String(args.mode || '')
    const run = mode === 'run' || args.run === true || String(args.run) === 'true'
    const dryRun = !run || mode === 'dryrun' || args.dryrun === true || String(args.dryrun) === 'true'
    const includeBare = args.includeBare === true || String(args.includeBare) === 'true' // §7.3 修订 3：缺省内容门
    const cap = Number(args.limit) > 0 ? Math.min(Number(args.limit), 500) : 200 // §7.4：总数上限防一次性海量写入
    const now = new Date().toISOString()
    // 读看板：与 buildContext（L587）同路径同 readJson 通道，BOARD_REL 常量为唯一读板来源（fs 直读，非 taskkit HTTP）
    const board = await readJsonRef(BOARD_REL, { tasks: [] }, ROOT_TRAIN)
    const all = Array.isArray(board.tasks) ? board.tasks : []
    const doneTasks = all.filter(function (t) { return String(t.status || '') === '已完成' })
    // Phase 2 实时化（additive）：taskIds 单任务过滤——taskkit 完成钩子（tsk_complete/receiptScanner，autoDraftOnComplete 门控开时）
    //   传 [刚完成任务Id] 只同步该任务，避免每次完成都全量重扫历史已完成任务；缺省 = 全量（Phase 1 行为零变化）
    const _rawIds = args && args.taskIds
    let _wantIds = null
    if (_rawIds !== undefined && _rawIds !== null && String(_rawIds).trim() !== '') {
      const list = Array.isArray(_rawIds) ? _rawIds : String(_rawIds).split(/[,，]/).map(function (s) { return String(s).trim() }).filter(Boolean)
      if (list.length) _wantIds = list
    }
    const scanPool = _wantIds ? doneTasks.filter(function (t) { return _wantIds.indexOf(String(t.id || '')) >= 0 }) : doneTasks
    const skipped = []
    const candidates = []
    for (const t of scanPool) {
      const taskId = String(t.id || '')
      if (!taskId) continue
      const lessons = splitLessonsList(t.lessons)
      const artifacts = splitArtifactsList(t.artifacts)
      // ① 内容门（修订 3 定稿）：默认 = 已完成且（lessons 或 artifacts 非空）——lessons/artifacts 双空的仅 note 任务默认跳过（729640 0/4 仅 artifacts → 命中）
      if (!includeBare && !lessons.length && !artifacts.length) {
        skipped.push({ taskId: taskId, reason: '内容门未过：lessons 与 artifacts 双空（仅 note；includeBare:true 才纳入）' })
        continue
      }
      // ② 存在性幂等（修订 2-c）：readSummary 三级回退（confirmed L1 → draft → cold）任一命中即 skip——天然幂等，绝不覆盖已确认 L1
      const existing = await readSummary(taskId)
      if (existing) {
        skipped.push({ taskId: taskId, reason: '已存在（readSummary 命中 source=' + existing.source + '，跳过防重复/防覆盖）' })
        continue
      }
      const title = String(t.title || taskId)
      const requirement = String(t.requirement || '')
      const rawProject = String(t.project || '')
      const typeRule = classifyTask(title, requirement, rawProject)
      const project = rawProject || typeRule.type // §6：project 直接；空则按 TASK_TYPES 从 title/requirement 归类兜底
      const decisions = lessons.filter(function (l) { return !isReceiptLine(l) }) // lessons→decisions 逐条，入映射前剔除回执样板行（防御性，实测零样板）
      const kbRefs = extractKbRefs(lessons.concat([requirement]))
      const candidate = {
        taskId: taskId, title: title, project: project, domain: typeRule.type,
        status: 'success', // §6：board 无失败语义，'已完成' → success（failed/interrupted 由 agent close 另写）
        goal: requirement.slice(0, 500), // §6：goal=task.requirement，截 ≤500 字
        conclusion: extractConclusion(t.note),
        decisions: decisions, artifacts: artifacts, kb_refs: kbRefs,
        created_at: t.createdAt || null, // 修订 2-b：显式注入 board 真源，不借 doClose 的 now 硬编码
        closed_at: t.finishedAt || null
      }
      candidates.push(candidate)
      if (!dryRun && candidates.length >= cap) break
    }
    if (dryRun) {
      // dryrun：预览候选 + 跳过原因，零写入
      return {
        status: 200,
        body: {
          ok: true, dryrun: true, scanned: scanPool.length, candidates: candidates.slice(0, cap), skipped: skipped,
          includeBare: includeBare, taskIds: _wantIds, note: 'dryrun 零写入；run=true 将直写 longterm/drafts/<taskId>.json 草稿（draft:true 待 confirm）并批次收尾 rebuildFulltext'
        }
      }
    }
    // run：对通过门 + 尚无 L1 的任务直写草稿（不借 doClose——其 closed_at/created_at 硬编码 now（M:860-861）无注入参数，此处显式注入 board 真源）
    // 修订 2-b：longterm/drafts 目录存在性兜底（正常由启动 ensureSeedFile 保证；此处防目录被删后 writeJson 直写失败）
    try {
      const nodeFs = await import('node:fs')
      nodeFs.mkdirSync(await absOf(ROOT_DATA, DRAFTS_REL), { recursive: true })
    } catch (e) { /* 目录建不成则各写入会进 errors，不中断批次 */ }
    const created = []
    const errors = []
    for (const c of candidates.slice(0, cap)) {
      try {
        const draft = {
          task_id: c.taskId,
          title: c.title,
          status: c.status,
          domain: [c.domain],
          project: c.project,
          created_at: c.created_at, // = task.createdAt（board 真源）
          closed_at: c.closed_at, // = task.finishedAt（board 真源）
          message_count: 0,
          artifacts: c.artifacts, // 直映
          depends_on: [], replaces: [], supplements: [], conflicts_with: [],
          goal: c.goal,
          conclusion: c.conclusion,
          decisions: c.decisions, // lessons 逐条（样板已剥）
          open_questions: [], failed_alternatives: [],
          raw_span: { count: 0, first: null, last: null }, // 回填无 raw
          kb_refs: c.kb_refs,
          tool_summary: {},
          draft: true,
          proposed_at: now,
          closed_by: 'memory_sync_board',
          confirmed: false // 绝不自动 confirm
        }
        const rel = DRAFTS_REL + '/' + c.taskId + '.json'
        const ok = await writeJson(ROOT_DATA, rel, draft) // 走 writeJson（adapterFs 写后自动失效缓存），不旁路直写（§7.2）
        if (ok) created.push({ taskId: c.taskId, title: c.title, path: await absOf(ROOT_DATA, rel), decisions: c.decisions.length, artifacts: c.artifacts.length })
        else errors.push({ taskId: c.taskId, error: 'draft 写入失败: ' + await absOf(ROOT_DATA, rel) })
      } catch (e) {
        errors.push({ taskId: c.taskId, error: String(e && e.message || e) })
      }
    }
    // 修订 2-a：批次收尾统一 rebuildFulltext 一次（对齐退役批次先例 L1309）——回填草稿立即可被 load/search 命中
    let fulltextEntries = null
    if (created.length) fulltextEntries = await rebuildFulltext()
    return {
      status: 200,
      body: {
        ok: true, run: true, scanned: scanPool.length, created: created, skipped: skipped, errors: errors,
        includeBare: includeBare, taskIds: _wantIds, fulltextEntries: fulltextEntries,
        note: '已完成任务 L1 草稿投影落库（draft:true 待 agent confirm 升 confirmed；权威 board 未动——单向管道可重建）'
      }
    }
  }

  // ============ 统一 action 分发（API 与工具共用） ============
  async function doRebuildFulltext() {
    const n = await rebuildFulltext()
    if (n < 0) return { status: 500, body: { ok: false, error: 'rebuildFulltext 失败' } }
    return { status: 200, body: { ok: true, entries: n, ts: Date.now() } }
  }
  async function handleAction(action, args) {
    switch (action) {
      case 'ping': return { status: 200, body: { ok: true, plugin: 'memory-system', ts: Date.now() } }
      case 'load': return buildContext(args)
      case 'record': return doRecord(args)
      case 'close': return doClose(args)
      case 'facts': return doFacts(args)
      case 'link': return doLink(args)
      case 'search': return doSearch(args)
      case 'weave': return doWeave(args)
      case 'conflicts': return doConflicts(args)
      case 'stats': return doStats()
      case 'rebuild-fulltext': return doRebuildFulltext()
      case 'retire': return doRetire(args)
      case 'retire-dryrun': return { status: 200, body: await retireScan({ dryRun: true, force: true }) }
      case 'retire-run': return { status: 200, body: await retireScan({ force: args.force === true || String(args.force) === 'true' }) }
      case 'pin': return doPin(args)
      case 'exclude': return doExclude(args)
      case 'restore': return doRestore(args)
      case 'config': return doConfig(args)
      case 'sync-board': return doSyncBoard(args)
      default: return { status: 404, body: { ok: false, error: '未知 action: ' + action, actions: ['ping', 'load', 'record', 'close', 'facts', 'link', 'search', 'weave', 'stats', 'conflicts', 'rebuild-fulltext', 'retire', 'retire-dryrun', 'retire-run', 'pin', 'exclude', 'restore', 'config', 'sync-board'] } }
    }
  }

  // ============ Web API 注册 ============
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      // kind 取宿主规范值 'prefix'（WebRouteKind='exact'|'prefix'；宿主 register() 对非 'exact' 一律送前缀表，
      // 故与本插件此前 as-built 的类型外取值（前缀形式的旧写法）注册结果等价——O5 §2.2 行 44 路由归一）
      ctx.effect(function () { return webServer.register({ kind: 'prefix', path: '/memory-system/api', handler: apiHandler }) })
    } catch (e) {
      try { logger && logger.warn('[memory-system] api register failed: ' + String(e && e.message || e)) } catch (_) {}
    }
  }
  function apiHandler(req, res) {
    const u = new URL(req.url || '/', 'http://x')
    const parts = u.pathname.split('/').filter(Boolean) // [memory-system, api, action, ...]
    const send = function (status, obj) {
      try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) } catch (e) {}
    }
    if (parts[0] !== 'memory-system' || parts[1] !== 'api') return send(404, { ok: false, error: 'not found' })
    const action = parts[2] || ''
    let body = ''
    const done = async function () {
      let args = {}
      if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
      try {
        const r = await handleAction(action, args)
        return send(r.status, r.body)
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message || e) })
      }
    }
    req.on('data', function (chunk) { body += chunk })
    req.on('end', done)
    req.on('error', function () { try { res.end('') } catch (e) {} })
  }

  // ============ MVP2 A1 退役看门狗定时器（原生 setInterval + ctx.effect 清理，仿 taskkit 先例；默认 enabled:false，tick 内再读配置判定） ============
  const retireTimer = setInterval(function () { retireScan({}).catch(function () {}) }, 60000)
  ctx.effect(function () { return function () { clearInterval(retireTimer) } })

  // ============ 工具注册（13 个） ============
  const toolsSvc = ctx.get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    const toolDefs = [
      {
        name: 'memory_load',
        description: '记忆上下文加载（核心）：按 taskId 或 {title, requirement, project} 生成「记忆上下文包」（JSON 输出，不自动注入）：L0 项目事实 + L1 任务摘要（状态权重 success>silent_completed>interrupted>failed，含依赖回溯≤3层≤20条）+ 知识库命中≤5条 + 技能/提示词引用 + 工具调用记录（失败优先最近10次）+ raw 下钻片段≤3段 + 冲突提示（不自动消解）。入参 taskId（可选）、title、requirement、project（可选）、includeFailed（可选，默认 true）。',
        parameters: {
          taskId: { type: 'string', description: '任务 id（可选；提供则自动从看板读取 title/requirement/project）' },
          title: { type: 'string', description: '任务标题' },
          requirement: { type: 'string', description: '任务要求/目标' },
          project: { type: 'string', description: '项目名' },
          includeFailed: { type: 'string', description: '是否包含 failed 状态摘要（默认 true）' }
        },
        execute: async function (args) { const r = await buildContext(args || {}); return r.body }
      },
      {
        name: 'memory_record',
        description: '记忆写入：把一条消息/思考/产物写入工作记忆(working)与原始记录层(raw，只追加)。入参 taskId（必填）、type（message|thought|artifact，默认 message）、content、tags、reply_to、title/goal/project（可选，顺带更新 working 元信息）。',
        parameters: {
          taskId: { type: 'string', description: '任务 id', required: true },
          type: { type: 'string', description: '记录类型 message|thought|artifact', required: true },
          content: { type: 'string', description: '记录内容', required: true },
          tags: { type: 'string', description: '标签（逗号分隔，可选）', required: true },
          reply_to: { type: 'string', description: '回复的上一记录 id（可选）', required: true },
          goal: { type: 'string', description: '任务目标（可选）', required: true },
          project: { type: 'string', description: '项目名（可选）', required: true }
        },
        execute: async function (args) { const r = await doRecord(args || {}); return r.body }
      },
      {
        name: 'memory_close',
        description: '任务闭合：聚合 working+raw 生成 L1 任务摘要（confirm=true 时直接确认入库 longterm/tasks/ 不可修改；缺省生成草稿 drafts/ 待确认，再以 confirm=true 调同工具确认入库）。已确认 L1 不可修改，重复闭合幂等返回 alreadyClosed；force=true 生成新草稿不覆盖。入参 taskId（必填）、status（success|failed|silent_completed|interrupted）、conclusion（最终结论）、goal/decisions/open_questions/failed_alternatives/artifacts/domain/project/depends_on/replaces/supplements/conflicts_with（可选）、confirm（true/false，可选）、force（可选）。可复用结论随返回值 kbProposal 给出（不自动写入 kb）。',
        parameters: {
          taskId: { type: 'string', description: '任务 id', required: true },
          status: { type: 'string', description: '闭合状态 success|failed|silent_completed|interrupted', required: true },
          conclusion: { type: 'string', description: '最终结论', required: true },
          goal: { type: 'string', description: '任务目标（可选）', required: true },
          decisions: { type: 'string', description: '关键决策（换行分隔，可选）', required: true },
          open_questions: { type: 'string', description: '未决问题（换行分隔，可选）', required: true },
          failed_alternatives: { type: 'string', description: '失败备选方案（换行分隔，可选）', required: true },
          project: { type: 'string', description: '项目名（可选）', required: true },
          force: { type: 'string', description: '已闭合时是否强制生成新草稿（true/false，可选）', required: true }
        },
        execute: async function (args) { const r = await doClose(args || {}); return r.body }
      },
      {
        name: 'memory_facts',
        description: 'L0 项目事实层：op=get 读取（可按 project 过滤）；op=propose 提议新事实入待确认区（Agent 提议+用户确认，半手动维护）；op=confirm/reject 确认/拒绝待确认事实（需 factId）。入参 op（必填）、project、content、source、factId。',
        parameters: {
          op: { type: 'string', description: 'get|propose|confirm|reject', required: true },
          project: { type: 'string', description: '项目名', required: true },
          content: { type: 'string', description: '事实内容（propose 必填）', required: true },
          source: { type: 'string', description: '来源（如任务 id，propose 时用）', required: true },
          factId: { type: 'string', description: '待确认事实 id（confirm/reject 必填）', required: true }
        },
        execute: async function (args) { const r = await doFacts(args || {}); return r.body }
      },
      {
        name: 'memory_link',
        description: '依赖图登记：为任务 id 声明关系 rel（depends_on|replaces|supplements|conflicts_with）指向 targetId。依赖宁少勿错（错标代价>漏标）；conflicts_with 只登记不消解。',
        parameters: {
          id: { type: 'string', description: '任务 id', required: true },
          rel: { type: 'string', description: '关系类型 depends_on|replaces|supplements|conflicts_with', required: true },
          targetId: { type: 'string', description: '目标任务 id', required: true }
        },
        execute: async function (args) { const r = await doLink(args || {}); return r.body }
      },
      {
        name: 'memory_search',
        description: '跨层检索：默认 L0 项目事实 + L1 任务摘要 + 知识库（raw 原始层排除，不作为检索入口）；可按 layer=l0|l1|kb 限定。复用 kb 评分语义（精确100/包含80/描述60/标签50/内容30）。',
        parameters: {
          q: { type: 'string', description: '检索关键词', required: true },
          layer: { type: 'string', description: '限定层 l0|l1|kb|all（默认 all）', required: true }
        },
        execute: async function (args) { const r = await doSearch(args || {}); return r.body }
      },
      {
        name: 'memory_weave',
        description: '工具调用记录选择性登记：任务执行中调用某工具后登记（taskId+toolName+ok+content），供上下文加载按「任务类型工具族 + 失败优先 + 最近K次」筛选；同时写入 raw（type=tool_call，供扫描兜底）。kbUsed 可附知识条目 id 列表。',
        parameters: {
          taskId: { type: 'string', description: '任务 id', required: true },
          toolName: { type: 'string', description: '工具名', required: true },
          ok: { type: 'string', description: '是否成功 true/false', required: true },
          content: { type: 'string', description: '调用摘要（简短）', required: true },
          kbUsed: { type: 'string', description: '本次调用消费的知识条目 id（逗号分隔，可选）', required: true }
        },
        execute: async function (args) { const r = await doWeave(args || {}); return r.body }
      },
      {
        name: 'memory_conflicts',
        description: '冲突列表：返回依赖图中所有 conflicts_with 关系（双方摘要标题 + 未消解标记），可按 taskId 过滤。冲突只暴露不自动消解。',
        parameters: {
          taskId: { type: 'string', description: '任务 id（可选，缺省全部）', required: true }
        },
        execute: async function (args) { const r = await doConflicts(args || {}); return r.body }
      },
      {
        name: 'memory_stats',
        description: '记忆系统自检/统计：各层数量（facts/longterm/drafts/working/raw/index）+ 外部对接（kb/skills/prompts 条目数）+ 计数器 + 预算配置。',
        parameters: {},
        execute: async function () { const r = await doStats(); return r.body }
      },
      {
        name: 'memory_retire',
        description: '记忆退役（MVP1）：把已闭合任务的 L1 摘要+raw 记录聚合导出为结构化退役文件（frontmatter+摘要+raw 聚合摘要+原文引用），落盘 记忆归档/<project>/<taskId>_<title>.md，更新归档清单（归档清单.json），并调 knowledge-base import 索引进 KB（kbMode=index+sourcePath，category/domain=记忆归档）。原 L1/raw 数据不动（无真删除）；移出活跃域归 MVP2 看门狗。入参 taskId（必填）。重复退役按 task_id 刷新归档（KB 按 title 幂等去重）。',
        parameters: {
          taskId: { type: 'string', description: '任务 id', required: true }
        },
        execute: async function (args) { const r = await doRetire(args || {}); return r.body }
      },
      {
        name: 'memory_retire_dryrun',
        description: '退役看门狗预览/手动触发（MVP2 A1，第 11 工具，纯加法）：dryRun=true 只返回候选任务列表（超龄+低活跃，阈值取 memory.json.config.retireWatchdog，默认 enabled=false 不自动跑）不动任何数据；run=true 手动执行一轮看门狗扫描（等价一次定时器 tick，受 enabled 门控；force=true 可无视 enabled 强制扫描）。候选=ageDays≥maxAgeDays 且 memoryScore<minScore 且非重要（success+importance≥0.7，decay=1 天然不退役）/非 failed。入参 dryRun、run、force（均 true/false）。',
        parameters: {
          dryRun: { type: 'string', description: 'true=只预览候选（不动数据）', required: true },
          run: { type: 'string', description: 'true=手动执行一轮看门狗扫描', required: true },
          force: { type: 'string', description: 'run 时无视 enabled=false 门控强制扫描（可选）', required: true }
        },
        execute: async function (args) {
          const a = args || {}
          if (a.dryRun === true || String(a.dryRun) === 'true') {
            const r = await retireScan({ dryRun: true, force: true })
            return { ok: r.ok, dryRun: true, count: (r.candidates || []).length, scanned: r.scanned || 0, candidates: r.candidates || [], lastScanAt: r.lastScanAt || null }
          }
          if (a.run === true || String(a.run) === 'true') {
            const r = await retireScan({ force: a.force === true || String(a.force) === 'true' })
            return { ok: r.ok, run: true, retired: r.retired || 0, errors: r.errors || 0, count: (r.candidates || []).length, candidates: r.candidates || [], reason: r.reason || null, lastScanAt: r.lastScanAt || null }
          }
          return { ok: false, error: '需 dryRun=true 或 run=true' }
        }
      },
      {
        name: 'memory_pin',
        description: '记忆强调·置顶（additive，第 12 工具）：把 L1 任务摘要标记 pinned=true（缺省），memory_load 排序时置顶（PINNED_BONUS 加分）、跨项目自动过滤豁免（人工强调优先于自动项目隔离）、不参与时间衰减（decay=1）、退役看门狗显式跳过。pinned=false 即取消置顶（memory_unpin 语义）。置顶与排除互斥（pin 自动清除 excluded）。只写强调标记字段，L1 内容字段仍不可修改。入参 taskId（必填）、pinned（true/false，可选，缺省 true）。',
        parameters: {
          taskId: { type: 'string', description: '任务 id', required: true },
          pinned: { type: 'string', description: 'true=置顶 / false=取消置顶（缺省 true）', required: true }
        },
        execute: async function (args) { const r = await doPin(args || {}); return r.body }
      },
      {
        name: 'memory_exclude',
        description: '记忆强调·排除（additive，第 13 工具）：把 L1 任务摘要标记 excluded=true（缺省），memory_load 主载候选与依赖回溯跳过（不自动注入上下文包）；显式 memory_search 仍可检索（排除=不注入≠删除，对齐 mobius session_excluded_memories 语义）。excluded=false 即取消排除（memory_unexclude 语义）。排除与置顶互斥（exclude 自动清除 pinned）；排除不豁免退役（超龄+低活跃仍可被看门狗退役，属有意决策）。只写强调标记字段，L1 内容字段仍不可修改。入参 taskId（必填）、excluded（true/false，可选，缺省 true）。',
        parameters: {
          taskId: { type: 'string', description: '任务 id', required: true },
          excluded: { type: 'string', description: 'true=排除 / false=取消排除（缺省 true）', required: true }
        },
        execute: async function (args) { const r = await doExclude(args || {}); return r.body }
      }
    ]
    for (const def of toolDefs) {
      try {
        // 修复(2026-09-06)：13 个 def 原无 output 字段 → defineTool 无防护读 options.output.render（dsh-tools L840）抛 TypeError →
        // 注册循环全进 catch → memory_* 工具注册数=0 → agent 会话不可见（tsk_*/kb_* 均带 output 故可见）。
        // 统一补 output（复用 kb 风格 JSON 渲染；纯 additive，execute 返回 r.body 本就是 JSON 对象）。
        if (!def.output) {
          def.output = {
            schema: { type: 'object', additionalProperties: true },
            render: function (_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
            presentationMeta: function (_args, value) { return value || {} }
          }
        }
        const d = toolsSvc.register(defineTool(def))
        ctx.effect(function () { return function () { try { d && d() } catch (e) {} } })
      } catch (e) {
        // 修复(2026-09-06)：logger=ctx.get('logger') 常为 undefined → 原 warn 静默吞错（memory_load 注册失败零痕迹）。
        // 改独立文件必现输出，任何注册失败都可见。落点由 resolveMemoryLogPath() 按环境推导（不写死盘符）。
        try {
          appendFileSync(resolveMemoryLogPath(),
            new Date().toISOString() + ' tool register failed: ' + def.name + ' | ' + String((e && (e.stack || e.message)) || e) + '\n', 'utf8')
        } catch (_) {}
        try { logger && logger.warn('[memory-system] tool register failed: ' + def.name + ' ' + String(e && e.message || e)) } catch (_) {}
      }
    }
  }

  // ============ 启动：确保数据目录/种子文件存在（stat 判存在，幂等；全部经 adapterFs） ============
  async function ensureSeedFile(root, rel, obj) {
    try {
      const info = await adapterFs.stat(root, rel)
      if (!info) await writeJson(root, rel, obj)
    } catch (e) {
      try { await writeJson(root, rel, obj) } catch (_) {}
    }
  }
  (async function () {
    try {
      const now = new Date().toISOString()
      const m = await readMemory()
      await ensureSeedFile(ROOT_DATA, MEMORY_REL, { version: '0.1.0', createdAt: m.createdAt || now, updatedAt: now, stats: m.stats || {}, config: { migration: 'from-new-tasks', rawPolicy: 'append-only' } })
      await ensureSeedFile(ROOT_DATA, FACTS_REL, { version: 1, facts: [], pending: [], last_updated: now })
      await ensureSeedFile(ROOT_DATA, INDEX_GRAPH_REL, { graph: {}, updatedAt: now })
      await ensureSeedFile(ROOT_DATA, INDEX_FULLTEXT_REL, { entries: [], updatedAt: now })
      // 空目录占位（避免空目录丢失）
      await ensureSeedFile(ROOT_DATA, WORKING_REL + '/.gitkeep.json', { keep: true })
      await ensureSeedFile(ROOT_DATA, RAW_REL + '/.gitkeep.json', { keep: true })
      await ensureSeedFile(ROOT_DATA, LONGTERM_REL + '/.gitkeep.json', { keep: true })
      await ensureSeedFile(ROOT_DATA, DRAFTS_REL + '/.gitkeep.json', { keep: true })
      invalidateRef(ROOT_DATA)
    } catch (e) {
      try { logger && logger.warn('[memory-system] init failed: ' + String(e && e.message || e)) } catch (_) {}
    }
  })()
}

// cordis loader reads inject array from named exports
export { inject }
