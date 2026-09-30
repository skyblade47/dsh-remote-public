// Host：知识库整理插件 @local/knowledge-base
// 吸收 partyfly/texo 范式：分层存储(raw/inbox 采集层 + knowledge.json 整理层)、aliases+description 检索、
// 观点演变追溯(evolution 数组)、Agent 召回(recall API + SessionStart 骨架建议)
// 功能：import(入 inbox) / list / search(主题/关键词/关联) / add(整理条目) / update / link(关联) / stats
// 端点：/knowledge-base/api/ping | inbox | list | search | add | update | link | stats
import { defineTool } from '@deepseek-ai/dsh-tools'

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer'
]

// 数据根口径（O5 迁移）：根名由 adapter 部署 config 登记（`dsh-bundle-patch.yml` 的 `roots.全局数据`），
// 插件只持"根内相对引用"，不再硬编码盘符路径、不再做根路径字符串拼接。
const KB_ROOT = '全局数据'
const KNOWLEDGE_REL = 'knowledge-base/knowledge.json'
// MVP2 A3：KB 归档区（独立文件，物理分仓）——冷条目摘要保留 + 全文标记冷（coldFullContent 无损备份），可 cold-restore 复原
const KB_COLD_REL = 'knowledge-base/knowledge_cold.json'
const INBOX_REL = 'knowledge-base/inbox'
// MVP2 A3 冷化默认配置（knowledge.json.config.kbCold 运行时覆盖；默认 enabled:false 试验田——先手动 cold 验证阈值再开自动）
const DEFAULT_KB_COLD = {
  enabled: false,
  maxAgeDays: 180,
  intervalMs: 60000,
  batchSize: 20,
  exemptDomains: ['记忆归档'], // 豁免域：退役记忆检索层必须常驻，永不冷化
  keepSummaryChars: 600,
  lowActivity: { minLinks: 0, minEvolution: 0 }, // 低活跃代理：links 空 && evolution 空（index 条目可冷）
  dryRun: false
}

// 工具输出统一消毒（O5 惯例，同 t49 writing-coach / t54 prompt-router）：宿主对 agent 工具返回值做「无损 JSON」校验——
// 对象里出现 `undefined`/函数/非纯对象字段即报 `invalid output: value is not lossless JSON`（HTTP 路径因 JSON.stringify 丢弃 undefined 而不受影响）。
// 统一在**唯一注册循环**出口做一次 JSON 往返，覆盖本插件全部工具。
function toLossless(v) {
  if (v === undefined || typeof v === 'function') return null
  const s = JSON.stringify(v)
  return s === undefined ? null : JSON.parse(s)
}

export function apply(ctx) {
  // fs 面统一经 adapterFs（一期标准接口）：相对引用解析到登记根，默认直读盘（无 30s TTL 陈旧窗口），写后自动失效。
  const adapterFs = ctx.get('adapterFs')
  if (!adapterFs) {
    const _m = '[knowledge-base] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写 knowledge/knowledge_cold/inbox（请确认 profile bundles 中 @local/dsh-adapter 已加载）'
    try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
  }

  // ============ 数据读写（经 adapterFs：根名 + 根内相对引用；默认直读，写后自动失效） ============
  // MVP2 A3：冷化器运行时状态（重入锁 / 最近扫描时间）
  let kbCoolRunning = false
  let kbCoolLastScanAt = null
  async function readKnowledge() {
    return adapterFs.readJson(KB_ROOT, KNOWLEDGE_REL, { fallback: { version: 1, entries: [] } })
  }
  async function writeKnowledge(kb) {
    try { await adapterFs.writeJson(KB_ROOT, KNOWLEDGE_REL, kb); return true } catch (e) { return false }
  }
  // MVP2 A3：冷区读写（经 adapterFs 直读，同活跃区模式；KB 归档区独立文件，物理分仓）
  async function readColdKnowledge() {
    return adapterFs.readJson(KB_ROOT, KB_COLD_REL, { fallback: { version: 1, entries: [], updatedAt: null } })
  }
  async function writeColdKnowledge(cold) {
    try { await adapterFs.writeJson(KB_ROOT, KB_COLD_REL, cold); return true } catch (e) { return false }
  }
  // MVP2 A3：冷化配置合并（knowledge.json.config.kbCold 覆盖默认；exemptDomains 数组整体替换）
  async function resolveColdConfig() {
    try {
      const kb = await readKnowledge()
      const over = (kb.config && kb.config.kbCold) || {}
      const exempt = Array.isArray(over.exemptDomains) ? over.exemptDomains : DEFAULT_KB_COLD.exemptDomains
      return Object.assign({}, DEFAULT_KB_COLD, over, { exemptDomains: exempt })
    } catch (e) { return DEFAULT_KB_COLD }
  }
  // MVP2 A3：冷却器（手动 cold action 与定时器共用；enabled:false 时仅 force 手动触发；dryRun 只预览不落盘）
  // 阈值：ageDays(createdAt) ≥ maxAgeDays 且 低活跃代理（links 空 && evolution 空）；豁免域永不冷化；幂等按 id（已在冷区跳过）
  async function kbCoolScan(opts) {
    opts = opts || {}
    if (kbCoolRunning) return { ok: false, skipped: true, reason: 'scan-running' }
    kbCoolRunning = true
    try {
      const cfg = Object.assign({}, await resolveColdConfig(), opts.cfg || {})
      const force = opts.force === true
      const dryRun = opts.dryRun === true || cfg.dryRun === true
      if (cfg.enabled !== true && !force && !dryRun) return { ok: true, skipped: true, reason: 'disabled' }
      kbCoolLastScanAt = new Date().toISOString()
      const kb = await readKnowledge()
      const now = Date.now()
      const exemptSet = {}
      ;(cfg.exemptDomains || []).forEach(function (d) { exemptSet[d] = true })
      const ids = Array.isArray(opts.ids) ? opts.ids : []
      const candidates = []
      for (const e of (kb.entries || [])) {
        if (e.kbStatus === 'cold') continue
        if (e.domain && exemptSet[e.domain]) continue // 豁免域（记忆归档）永不冷化
        const t = new Date(e.createdAt || e.updatedAt || now).getTime()
        const ageDays = (isNaN(t) || t <= 0) ? 0 : (now - t) / 86400000
        const lowActivity = !(e.links && e.links.length) && !(e.evolution && e.evolution.length)
        if (ids.length) {
          if (ids.indexOf(e.id) >= 0) candidates.push({ id: e.id, title: e.title, ageDays: Math.round(ageDays * 10) / 10, lowActivity: lowActivity, reason: 'manual' })
          continue
        }
        if (ageDays >= cfg.maxAgeDays && lowActivity) {
          candidates.push({ id: e.id, title: e.title, ageDays: Math.round(ageDays * 10) / 10, lowActivity: lowActivity, reason: 'age' })
        }
      }
      if (dryRun) return { ok: true, dryRun: true, count: candidates.length, candidates: candidates, totalActive: (kb.entries || []).length, lastScanAt: kbCoolLastScanAt }
      const keep = Number(cfg.keepSummaryChars) > 0 ? Number(cfg.keepSummaryChars) : 600
      const batch = candidates.slice(0, Number(cfg.batchSize) > 0 ? Number(cfg.batchSize) : 20)
      const nowIso = new Date().toISOString()
      const cold = await readColdKnowledge()
      cold.entries = cold.entries || []
      let cooled = 0
      let errors = 0
      for (const c of batch) {
        const idx = (kb.entries || []).findIndex(function (e) { return e.id === c.id })
        if (idx < 0) { errors++; continue }
        const e = kb.entries[idx]
        const coldEntry = Object.assign({}, e, { kbStatus: 'cold', cold_at: nowIso, coldReason: c.reason || 'manual' })
        // 无损复原保障：fulltext（无 sourcePath）条目冷化前备份全文 coldFullContent；index 条目 content 已是摘要 + sourcePath 指向原文，无需备份
        if (!e.sourcePath && e.content) coldEntry.coldFullContent = e.content
        if (!e.sourcePath) {
          const content = String(e.content || '')
          coldEntry.content = content.length > keep ? content.slice(0, keep) + '\n…(已冷化，全文见 coldFullContent/sourcePath)' : content
        }
        cold.entries.unshift(coldEntry)
        kb.entries.splice(idx, 1)
        cooled++
      }
      if (cooled) {
        kb.updatedAt = nowIso
        await writeKnowledge(kb)
        cold.updatedAt = nowIso
        await writeColdKnowledge(cold)
      }
      return { ok: true, dryRun: false, cooled: cooled, errors: errors, count: cooled, candidates: candidates.slice(0, 20), lastScanAt: kbCoolLastScanAt }
    } finally {
      kbCoolRunning = false
    }
  }
  // inbox 采集层：写文件入 raw 层（只追加，不可变；经 adapterFs 根内相对引用）
  async function writeInbox(filename, content) {
    try {
      await adapterFs.writeText(KB_ROOT, INBOX_REL + '/' + filename, content)
      return true
    } catch (e) { return false }
  }
  // kb_index 的文件读取（目标通常在数据根之外，故用绝对路径直读；相对路径保持 legacy 语义 = 以 sandboxPolicy.workspaceRoot 解析）
  async function readAnyFile(filePath) {
    const p = String(filePath || '')
    if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return adapterFs.readText(p)
    const sp = ctx.get('sandboxPolicy')
    const wsRoot = sp && sp.workspaceRoot ? sp.workspaceRoot : undefined
    return wsRoot ? adapterFs.readText(wsRoot, p) : adapterFs.readText(p)
  }

  // ============ 核心逻辑 ============
  // 检索：名字/别名/标题 精确 ≫ 描述/标签/内容包含（与 texo recall、tool_search 同构）
  function searchEntries(entries, query, opts) {
    opts = opts || {}
    const q = String(query || '').trim().toLowerCase()
    // MVP2 A3：冷条目默认不出现在活跃检索（includeCold=true 才包含；缺省 false → 现有调用零变化，冷化后检索空间收缩）
    if (opts.includeCold !== true) {
      entries = (entries || []).filter(function (e) { return e.kbStatus !== 'cold' })
    }
    // 领域过滤优先：即使 query 为空, 指定 domain 时也按领域返回（浏览该领域全部）
    if (opts.domain) {
      const filtered = (entries || []).filter(function (e) { return String(e.domain || '') === opts.domain })
      if (!q) return filtered
      entries = filtered
    }
    if (!q) return entries
    const results = []
    for (const e of entries) {
      // 领域过滤（2026-08-27）：domain 元数据区分领域，避免 agent 跨领域检索混乱
      if (opts && opts.domain) {
        const d = String(e.domain || '')
        if (d !== opts.domain) continue
      }
      const name = String(e.title || '').toLowerCase()
      const aliases = (e.aliases || []).join(' ').toLowerCase()
      const desc = String(e.description || '').toLowerCase()
      const tags = (e.tags || []).join(' ').toLowerCase()
      const content = String(e.content || '').toLowerCase()
      let score = 0
      if (name === q || aliases.split(' ').indexOf(q) >= 0) score = 100
      else if (name.indexOf(q) >= 0 || aliases.indexOf(q) >= 0) score = 80
      else if (desc.indexOf(q) >= 0) score = 60
      else if (tags.indexOf(q) >= 0) score = 50
      else if (content.indexOf(q) >= 0) score = 30
      if (score > 0) results.push({ entry: e, score: score })
    }
    results.sort(function (a, b) { return b.score - a.score })
    return results.map(function (r) { return r.entry })
  }

  // ============ Web API ============
  const apiHandler = function (req, res) {
    const u = new URL(req.url || '/', 'http://x')
    const parts = u.pathname.split('/').filter(Boolean) // [knowledge-base, api, action, ...]
    const send = function (status, obj) {
      try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) } catch (e) {}
    }
    if (parts[0] !== 'knowledge-base' || parts[1] !== 'api') return send(404, { ok: false, error: 'not found' })
    const action = parts[2] || ''
    let body = ''
    let bodyTooLarge = false
    const done = async function () {
      if (bodyTooLarge) return
      let args = {}
      if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
      try {
        if (action === 'ping') return send(200, { ok: true, plugin: 'knowledge-base', ts: Date.now() })
        if (action === 'inbox') {
          // 知识采集：{ title, content } → 写入 inbox/时间戳.md（raw 层只追加）
          const title = String(args.title || '知识采集 ' + new Date().toISOString().slice(0, 10))
          const content = String(args.content || '')
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const filename = stamp + '.md'
          const fileContent = '# ' + title + '\n\n> 采集时间：' + new Date().toISOString() + '\n\n' + content
          const ok = await writeInbox(filename, fileContent)
          return send(ok ? 200 : 500, { ok: ok, filename: filename })
        }
        if (action === 'list') {
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const cats = {}
          entries.forEach(function (e) { cats[e.category] = (cats[e.category] || 0) + 1 })
          return send(200, { ok: true, total: entries.length, categories: cats, entries: entries })
        }
        if (action === 'search') {
          const kb = await readKnowledge()
          const q = String(args.q || args.query || '')
          const domain = String(args.domain || '')
          const includeCold = args.includeCold === true || String(args.includeCold) === 'true' // MVP2 A3：additive，缺省 false
          let pool = kb.entries || []
          if (includeCold) { // includeCold=true 时合并冷区（knowledge_cold.json），供冷化质量对账
            const cold = await readColdKnowledge()
            pool = pool.concat(cold.entries || [])
          }
          const matched = searchEntries(pool, q, { domain: domain, includeCold: includeCold })
          return send(200, { ok: true, total: matched.length, domain: domain || null, includeCold: includeCold, entries: matched })
        }
        if (action === 'add') {
          // 整理条目：{ title, description, content, category, tags, aliases, source }
          const a = args.entry || args
          if (!a || !a.title) return send(400, { ok: false, error: '缺少 title' })
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const id = 'kb-' + String(Date.now()).slice(-6)
          entries.unshift({
            id: id, title: String(a.title), description: String(a.description || ''),
            content: String(a.content || ''), category: String(a.category || '通用'),
            tags: Array.isArray(a.tags) ? a.tags : String(a.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            aliases: Array.isArray(a.aliases) ? a.aliases : String(a.aliases || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            source: String(a.source || '手动整理'), links: [], evolution: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          })
          kb.entries = entries; kb.updatedAt = new Date().toISOString()
          await writeKnowledge(kb)
          return send(200, { ok: true, id: id })
        }
        if (action === 'update') {
          // 更新/演变：{ id, patch } → patch 含 evolution.push 追加观点演变（永不删旧）
          const id = String(args.id || '')
          const patch = args.patch || {}
          const kb = await readKnowledge()
          const e = (kb.entries || []).find(function (x) { return x.id === id })
          if (!e) return send(404, { ok: false, error: '未找到: ' + id })
          const editable = ['title', 'description', 'content', 'category', 'tags', 'aliases', 'source', 'sourcePath'] // sourcePath 为 MVP2 A4 additive 一行（重退役路径变更同步）
          editable.forEach(function (k) { if (patch[k] !== undefined) e[k] = patch[k] })
          if (patch.evolution) e.evolution = (e.evolution || []).concat({ at: new Date().toISOString(), text: String(patch.evolution) }).slice(-50)
          if (patch.links && Array.isArray(patch.links)) e.links = Array.from(new Set((e.links || []).concat(patch.links)))
          e.updatedAt = new Date().toISOString()
          kb.updatedAt = new Date().toISOString()
          await writeKnowledge(kb)
          return send(200, { ok: true, id: id })
        }
        if (action === 'link') {
          // 关联：{ id, targetId } → 双向 links
          const id = String(args.id || '')
          const targetId = String(args.targetId || '')
          const kb = await readKnowledge()
          const e = (kb.entries || []).find(function (x) { return x.id === id })
          const t = (kb.entries || []).find(function (x) { return x.id === targetId })
          if (!e || !t) return send(404, { ok: false, error: '未找到条目' })
          e.links = Array.from(new Set((e.links || []).concat([targetId])))
          t.links = Array.from(new Set((t.links || []).concat([id])))
          e.updatedAt = new Date().toISOString(); t.updatedAt = new Date().toISOString()
          kb.updatedAt = new Date().toISOString()
          await writeKnowledge(kb)
          return send(200, { ok: true, id: id, targetId: targetId })
        }
        if (action === 'stats') {
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const byCat = {}
          entries.forEach(function (e) { byCat[e.category] = (byCat[e.category] || 0) + 1 })
          const linked = entries.filter(function (e) { return e.links && e.links.length }).length
          const evolved = entries.filter(function (e) { return e.evolution && e.evolution.length }).length
          // MVP2 A3：cold 段（additive 输出，4 工具签名不动）
          const cold = await readColdKnowledge()
          const coldEntries = cold.entries || []
          const activeEntries = entries.filter(function (e) { return e.kbStatus !== 'cold' })
          return send(200, {
            ok: true, entryTotal: entries.length, activeTotal: activeEntries.length, coldTotal: coldEntries.length,
            categories: byCat, linked: linked, evolved: evolved,
            cold: { total: coldEntries.length, active: activeEntries.length, lastColdAt: coldEntries.length ? (coldEntries[0].cold_at || cold.updatedAt || null) : null, lastScanAt: kbCoolLastScanAt }
          })
        }
        if (action === 'import') {
          // 批量导入：{ source: 'techdoc' | 'md', title, description, content, category, tags, sourcePath }
          // 索引模式(2026-08-26)：文件类条目 content 只存摘要(前600字) + sourcePath 指向原始文件，
          // 原始文件是唯一事实源(消除全文副本冗余/不同步/检索歧义)；无 sourcePath 的手动条目保留全文。
          const a = args || {}
          const title = String(a.title || '')
          const description = String(a.description || '')
          let content = String(a.content || '')
          const category = String(a.category || '文档')
          const tags = Array.isArray(a.tags) ? a.tags : String(a.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
          const aliases = Array.isArray(a.aliases) ? a.aliases : String(a.aliases || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
          const sourcePath = String(a.sourcePath || '')
          const domain = String(a.domain || '')
          if (!title || !content) return send(400, { ok: false, error: '缺少 title/content' })
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const exists = entries.some(function (e) { return e.title === title })
          if (exists) return send(200, { ok: true, skipped: true, reason: '已存在', title: title })
          const id = 'kb-' + String(Date.now()).slice(-6) + '-' + String(entries.length % 90 + 10)
          const isFile = !!sourcePath
          if (isFile && content.length > 600) content = content.slice(0, 600) + '\n…(全文见 sourcePath)'
          entries.unshift({
            id: id, title: title, description: description, content: content, category: category,
            tags: tags, aliases: aliases, source: '批量导入', domain: domain || undefined,
            sourcePath: sourcePath || undefined, contentRef: sourcePath || undefined, kbMode: isFile ? 'index' : 'fulltext',
            links: [], evolution: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          })
          kb.entries = entries; kb.updatedAt = new Date().toISOString()
          await writeKnowledge(kb)
          return send(200, { ok: true, id: id, title: title, kbMode: isFile ? 'index' : 'fulltext' })
        }
        if (action === 'import-batch') {
          // 批量导入（2026-08-28 创作技法知识包 739 CSV + 35 md）：
          // body { entries:[{title, description, content, category?, tags?, aliases?, sourcePath?, extra?}], defaultCategory? }
          // 单次读改写、按 title(trim) 去重幂等、extra 四用字段原样保留；
          // index 模式（有 sourcePath）content>600 截断 + sourcePath 指向原始文件（对齐 import 语义）。
          const a = args || {}
          const arr = Array.isArray(a.entries) ? a.entries : []
          if (!arr.length) return send(400, { ok: false, error: '缺少 entries' })
          if (arr.length > 5000) return send(400, { ok: false, error: 'entries 过多（≤5000）' })
          const defaultCategory = String(a.defaultCategory || '文档')
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const exists = {}
          entries.forEach(function (e) { exists[String(e.title || '').trim()] = true })
          let imported = 0
          let skipped = 0
          const errors = []
          const now = new Date().toISOString()
          const ts = String(Date.now()).slice(-6)
          let seq = 0
          const newEntries = []
          for (let i = 0; i < arr.length; i++) {
            const item = arr[i] || {}
            const title = String(item.title || '').trim()
            const contentRaw = String(item.content || '')
            const sourcePath = String(item.sourcePath || '')
            if (!title) { errors.push({ index: i, reason: '缺少 title' }); continue }
            if (!contentRaw && !sourcePath) { errors.push({ index: i, reason: 'content 与 sourcePath 均空' }); continue }
            if (exists[title]) { skipped++; continue }
            const isFile = !!sourcePath
            let content = contentRaw
            if (isFile && content.length > 600) content = content.slice(0, 600) + '\n…(全文见 sourcePath)'
            const id = 'kb-' + ts + '-' + (100 + seq++)
            newEntries.push({
              id: id, title: title,
              description: String(item.description || ''),
              content: content,
              category: String(item.category || defaultCategory),
              tags: Array.isArray(item.tags) ? item.tags : String(item.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
              aliases: Array.isArray(item.aliases) ? item.aliases : String(item.aliases || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
              source: '批量导入',
              domain: String(item.domain || '') || undefined,
              sourcePath: sourcePath || undefined,
              contentRef: sourcePath || undefined,
              kbMode: isFile ? 'index' : 'fulltext',
              extra: (item.extra !== undefined && item.extra !== null) ? item.extra : undefined,
              links: [], evolution: [],
              createdAt: now, updatedAt: now
            })
            exists[title] = true
            imported++
          }
          if (newEntries.length) kb.entries = newEntries.concat(entries)
          kb.updatedAt = now
          await writeKnowledge(kb)
          return send(200, { ok: true, imported: imported, skipped: skipped, errors: errors, total: kb.entries.length })
        }
        if (action === 'cold') {
          // MVP2 A3 冷化（B 形态）：{ ids?:[], dryRun?:true, maxAgeDays?, force? } → 冷却指定/候选条目（摘要保留 + 全文标记冷，可无损复原）
          const ids = Array.isArray(args.ids) ? args.ids : String(args.ids || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
          const dryRun = args.dryRun === true || String(args.dryRun) === 'true'
          const cfgOverride = {}
          if (args.maxAgeDays !== undefined) cfgOverride.maxAgeDays = Number(args.maxAgeDays)
          const r = await kbCoolScan({ ids: ids, dryRun: dryRun, force: true, cfg: cfgOverride }) // 手动 action 无视 enabled（试验田先验证阈值）
          return send(200, r)
        }
        if (action === 'cold-stats') {
          // MVP2 A3 冷区统计 + 幂等去重对账（active ids ∩ cold ids = ∅；冷/活条目集合与实际文件对账）
          const kb = await readKnowledge()
          const cold = await readColdKnowledge()
          const active = kb.entries || []
          const coldEntries = cold.entries || []
          const cfg = await resolveColdConfig()
          const exemptSet = {}
          ;(cfg.exemptDomains || []).forEach(function (d) { exemptSet[d] = true })
          const exemptCount = active.filter(function (e) { return e.domain && exemptSet[e.domain] }).length
          let totalBytes = 0
          coldEntries.forEach(function (e) { totalBytes += Buffer.byteLength(String(e.content || ''), 'utf8') })
          const coldIds = {}
          coldEntries.forEach(function (e) { coldIds[e.id] = true })
          const overlap = active.filter(function (e) { return coldIds[e.id] }).length // 应恒 0
          const dupCold = coldEntries.length - Object.keys(coldIds).length // 冷区内部重复 id
          return send(200, {
            ok: true, coldTotal: coldEntries.length, activeTotal: active.length, exemptCount: exemptCount,
            totalBytes: totalBytes, lastColdAt: coldEntries.length ? (coldEntries[0].cold_at || cold.updatedAt || null) : null,
            reconciliation: { overlap: overlap, dupCold: dupCold, consistent: overlap === 0 && dupCold === 0 },
            lastScanAt: kbCoolLastScanAt
          })
        }
        if (action === 'cold-restore') {
          // MVP2 A3 复原：{ ids:[] } → 冷条目移回活跃区（content 用 coldFullContent 无损复原；index 条目保留摘要+sourcePath）
          const ids = Array.isArray(args.ids) ? args.ids : String(args.ids || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
          if (!ids.length) return send(400, { ok: false, error: '缺少 ids' })
          const kb = await readKnowledge()
          const cold = await readColdKnowledge()
          const nowIso = new Date().toISOString()
          let restored = 0
          let missing = 0
          for (const id of ids) {
            const ci = (cold.entries || []).findIndex(function (e) { return e.id === id })
            if (ci < 0) { missing++; continue }
            const ce = cold.entries[ci]
            const restoredEntry = Object.assign({}, ce)
            delete restoredEntry.kbStatus
            delete restoredEntry.cold_at
            delete restoredEntry.coldReason
            if (ce.coldFullContent !== undefined) { restoredEntry.content = ce.coldFullContent; delete restoredEntry.coldFullContent }
            restoredEntry.updatedAt = nowIso
            restoredEntry.restoreCount = (restoredEntry.restoreCount || 0) + 1
            restoredEntry.lastRestoreAt = nowIso
            kb.entries = kb.entries || []
            kb.entries.unshift(restoredEntry)
            cold.entries.splice(ci, 1)
            restored++
          }
          if (restored) {
            kb.updatedAt = nowIso
            await writeKnowledge(kb)
            cold.updatedAt = nowIso
            await writeColdKnowledge(cold)
          }
          return send(200, { ok: true, restored: restored, missing: missing })
        }
        return send(404, { ok: false, error: '未知 action: ' + action, actions: ['ping', 'inbox', 'list', 'search', 'add', 'update', 'link', 'stats', 'import', 'import-batch', 'cold', 'cold-stats', 'cold-restore'] })
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message || e) })
      }
    }
    req.on('data', function (chunk) {
      body += chunk
      // 批量导入防护：单请求体 ≤5MB
      if (body.length > 5242880) { bodyTooLarge = true; send(413, { ok: false, error: 'body too large (>5MB)' }) }
    })
    req.on('end', function () { if (!bodyTooLarge) done() })
    req.on('error', function () { try { res.end('') } catch (e) {} })
  }

  // ============ MVP2 A3 冷化器定时器（原生 setInterval + ctx.effect 清理；默认 enabled:false，tick 内再读配置判定） ============
  const coolTimer = setInterval(function () { kbCoolScan({}).catch(function () {}) }, 60000)
  ctx.effect(function () { return function () { clearInterval(coolTimer) } })

  // ============ 注册 ============
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(function () { return webServer.register({ kind: 'prefix', path: '/knowledge-base/api', handler: apiHandler }) })
    } catch (e) {
      try { ctx.get('logger') && ctx.get('logger').warn('[knowledge-base] api register failed: ' + String(e && e.message || e)) } catch (_) {}
    }
  }

  // ============ 工具注册（唯一注册循环：4 个工具；出口统一无损消毒 + 注册失败可观测） ============
  const toolDefs = [
      {
        name: 'kb_search',
        description: '知识库检索：按主题/关键词/关联搜索整理后的知识条目（名字/别名精确优先，描述/标签/内容其次）。入参 q（关键词）。',
        parameters: {
          q: { type: 'string', description: '检索关键词', required: true }
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) {
          const kb = await readKnowledge()
          const matched = searchEntries(kb.entries || [], String(args.q || ''))
          return { ok: true, total: matched.length, entries: matched.map(function (e) { return { id: e.id, title: e.title, description: e.description, category: e.category, tags: e.tags } }) }
        }
      },
      {
        name: 'kb_add',
        description: '知识库新增整理条目：入参 title（标题）、description（一句话句柄）、content（内容）、category（分类）、tags（标签数组）、aliases（别名数组，用户口语叫法，检索友好）。',
        parameters: {
          title: { type: 'string', description: '条目标题', required: true },
          description: { type: 'string', description: '一句话描述（检索句柄）', required: true },
          content: { type: 'string', description: '内容', required: true },
          category: { type: 'string', description: '分类', required: true },
          tags: { type: 'string', description: '标签（逗号分隔）', required: true },
          aliases: { type: 'string', description: '别名（逗号分隔）', required: true }
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) {
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const id = 'kb-' + String(Date.now()).slice(-6)
          entries.unshift({
            id: id, title: String(args.title), description: String(args.description || ''),
            content: String(args.content || ''), category: String(args.category || '通用'),
            tags: String(args.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            aliases: String(args.aliases || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            source: 'Agent 整理', links: [], evolution: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          })
          kb.entries = entries; kb.updatedAt = new Date().toISOString()
          await writeKnowledge(kb)
          return { ok: true, id: id, total: entries.length }
        }
      },
      {
        name: 'kb_import',
        description: '知识库批量导入：把文档/内容导入知识库（按标题去重）。入参 title（标题）、description（一句话句柄）、content（内容全文或摘要）、category（分类，如技术文档/方法论）、tags（标签，逗号分隔）、aliases（别名，逗号分隔）、sourcePath（可选，原始文件路径；提供则走索引模式——content 只存摘要并指向原始文件，消除全文副本冗余）。用于把既有文档积累批量纳入知识库。',
        parameters: {
          title: { type: 'string', description: '条目标题', required: true },
          description: { type: 'string', description: '一句话描述（检索句柄）', required: true },
          content: { type: 'string', description: '内容全文或摘要', required: true },
          category: { type: 'string', description: '分类', required: true },
          tags: { type: 'string', description: '标签（逗号分隔）', required: true },
          aliases: { type: 'string', description: '别名（逗号分隔）', required: true },
          sourcePath: { type: 'string', description: '原始文件路径（可选；提供则索引模式）', required: true }
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) {
          const kb = await readKnowledge()
          const entries = kb.entries || []
          const title = String(args.title || '')
          const exists = entries.some(function (e) { return e.title === title })
          if (exists) return { ok: true, skipped: true, reason: '已存在', title: title }
          const id = 'kb-' + String(Date.now()).slice(-6) + '-' + Math.floor(Math.random() * 80 + 10)
          const sourcePath = String(args.sourcePath || '')
          let content = String(args.content || '')
          const isFile = !!sourcePath
          if (isFile && content.length > 600) content = content.slice(0, 600) + '\n…(全文见 sourcePath)'
          entries.unshift({
            id: id, title: title, description: String(args.description || ''),
            content: content, category: String(args.category || '文档'),
            tags: String(args.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            aliases: String(args.aliases || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            source: '批量导入', sourcePath: sourcePath || undefined, contentRef: sourcePath || undefined, kbMode: isFile ? 'index' : 'fulltext',
            links: [], evolution: [],
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          })
          kb.entries = entries; kb.updatedAt = new Date().toISOString()
          await writeKnowledge(kb)
          return { ok: true, id: id, title: title, kbMode: isFile ? 'index' : 'fulltext', total: entries.length }
        }
      },
      {
        name: 'kb_index',
        description: '知识库索引单个文件：给定文件路径，读取内容建立/更新知识库索引条目（索引模式=存摘要+sourcePath指向原始文件）。落盘文档后调用，实现自动索引。入参 filePath（原始文件的绝对路径，如 <工作区根>/DSH工具/xxx_技术文档.md；工作区根由部署决定——Linux 由 DSH_WORKSPACE_ROOT 注入，Windows 为其默认盘符路径）、title（可选，缺省用文件名）、category（可选，缺省技术文档）、tags/aliases（可选，逗号分隔）。',
        parameters: {
          filePath: { type: 'string', description: '文件绝对路径', required: true },
          title: { type: 'string', description: '条目标题（可选，缺省用文件名）' },
          category: { type: 'string', description: '分类（可选，缺省技术文档）' },
          tags: { type: 'string', description: '标签（可选，逗号分隔）' },
          aliases: { type: 'string', description: '别名（可选，逗号分隔）' }
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) {
          const filePath = String(args.filePath || '')
          if (!filePath) return { ok: false, error: '缺少 filePath' }
          let content = ''
          try {
            content = await readAnyFile(filePath)
          } catch (e) { return { ok: false, error: '文件读取失败: ' + String(e && e.message || e) } }
          const base = String(filePath).split(/[\\/]/).pop() || filePath
          const title = String(args.title || '').trim() || base.replace(/\.md$/, '')
          const firstLine = (content.split('\n')[0] || '').replace(/^#+\s*/, '').trim()
          const kb = await readKnowledge()
          const entries = kb.entries || []
          // 更新或新增：按 sourcePath 匹配（文件变了→更新摘要）
          const idx = entries.findIndex(function (e) { return e.sourcePath === filePath })
          const now = new Date().toISOString()
          const isFile = true
          let summary = content
          if (summary.length > 600) summary = summary.slice(0, 600) + '\n…(全文见 sourcePath)'
          if (idx >= 0) {
            const e = entries[idx]
            e.title = title; e.description = firstLine.slice(0, 100); e.content = summary
            e.category = String(args.category || e.category || '技术文档')
            if (args.tags) e.tags = String(args.tags).split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
            if (args.aliases) e.aliases = String(args.aliases).split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
            e.updatedAt = now; e.kbMode = 'index'
            kb.entries = entries; kb.updatedAt = now
            await writeKnowledge(kb)
            return { ok: true, action: 'updated', id: e.id, title: title, sourcePath: filePath }
          }
          const id = 'kb-' + String(Date.now()).slice(-6) + '-' + Math.floor(Math.random() * 80 + 10)
          entries.unshift({
            id: id, title: title, description: firstLine.slice(0, 100), content: summary, category: String(args.category || '技术文档'),
            tags: String(args.tags || '文档 技术').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            aliases: String(args.aliases || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            source: '自动索引', sourcePath: filePath, contentRef: filePath, kbMode: 'index',
            links: [], evolution: [], createdAt: now, updatedAt: now
          })
          kb.entries = entries; kb.updatedAt = now
          await writeKnowledge(kb)
          return { ok: true, action: 'indexed', id: id, title: title, sourcePath: filePath }
        }
      }
  ]
  const toolsSvc = ctx.get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    for (const def of toolDefs) {
      try {
        const d = toolsSvc.register(defineTool(Object.assign({}, def, {
          // 统一消毒：注册循环出口做一次 JSON 往返，防 undefined 触发 invalid output（O5/t49/t54 惯例）
          execute: async function (args) { return toLossless(await def.execute(args)) }
        })))
        ctx.effect(function () { return function () { try { d && d() } catch (e) {} } })
      } catch (e) {
        // 注册失败可观测（T40 定论：非法参数 spec 会让 defineTool 抛错，空 catch 曾导致工具静默不可见）
        const _m = '[knowledge-base] tool register failed (' + def.name + '): ' + String(e && e.stack || e && e.message || e)
        try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
      }
    }
  }

  // 启动时确保数据文件存在（经 adapterFs；失败可观测——原为裸 `catch (e) {}`，同 t54 惯例）
  (async function () {
    try {
      const kb = await readKnowledge()
      if (!kb.entries || !kb.entries.length) {
        const seed = { version: 1, createdAt: new Date().toISOString(), entries: [] }
        await adapterFs.writeJson(KB_ROOT, KNOWLEDGE_REL, seed)
        await adapterFs.writeText(KB_ROOT, INBOX_REL + '/README.md', '# 知识采集箱（inbox）\n\n原始想法/素材采集层，只追加不可变。整理后移入 knowledge.json。\n')
      }
    } catch (e) {
      const _m = '[knowledge-base] 种子自举失败（数据目录/文件缺失或不可写？）: ' + String(e && e.message || e)
      try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
    }
  })()
}

// cordis loader reads inject array from named exports
export { inject }
