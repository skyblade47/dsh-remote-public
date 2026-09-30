// Host：写作教练静态化 @local/writing-coach
// 功能：断章判定 / 节奏分析 / 审查规则引擎 / 自一致性检查 / 文风 AI 味检测（三层合并：词典→规则→AI，双轨制离线可用）
//       + 第三批 P1-1~P1-4：文本分析 4 维 /analyze、写作建议 8 类 /suggestions、结构设计 /structure、知识检索 /retrieve
//       + 方向 B（2026-08-30，additive）：B1 /doc-analyze 文档导入语义分析、B2 /review-apply 审查一键修复、B3 /continuity 6 维连续性
// 端点：/writing-coach/api/{ping,breakpoints,pacing,review,consistency,verify,style,analyze,suggestions,structure,retrieve,doc-analyze,review-apply,continuity}
// 工具：writing_coach_ping / writing_coach_breakpoints / writing_coach_pacing / writing_coach_review
//       / writing_coach_consistency / writing_coach_verify / writing_coach_style
//       / writing_coach_analyze / writing_coach_suggestions / writing_coach_structure / writing_coach_retrieve
//       / writing_coach_doc_analyze / writing_coach_review_apply / writing_coach_continuity
// 引擎纯函数在 lib/engines.js（零依赖，node --check 可直测）；本文件只做装配壳。
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  analyzeChapterBreaks,
  analyzeBlockPacing,
  reviewText,
  mergeWithAi,
  normalizeBlocks,
  consistencyBatchCheck,
  verifyWithMultipleSources,
  detectAIWriting,
  applyStyleTransformation,
  getPresetStyles,
  analyzeText,
  analyzeTextStructure,
  analyzeTextRhythm,
  generateSuggestions,
  designStructure,
  retrieveKnowledgeLocal,
  analyzeDocument,
  applyReviewFixes,
  continuity6DCheck
} from './engines.js'
import { resolveCredentialsPath } from './paths.js'

// 2026-09-22 Linux 化：凭据文件路径的推导挪到 ./paths.js（见该文件头注：为了让自检能真断言，
// 而不是"看代码觉得对"）。此处直接复用，并再导出一次以保持对外可见性不变。
export { resolveCredentialsPath }

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer'
]

// 工具输出统一消毒（t49）：宿主对 agent 工具的返回值做「无损 JSON」校验——对象里只要出现
// `undefined`/函数/非纯对象字段，就报 `invalid output: value is not lossless JSON`。
// 本插件引擎的 check 对象带 `suggestion: undefined`（consistencyBatchCheck 1 处、continuity6DCheck 4 处），
// HTTP 路径因 `JSON.stringify` 丢弃 undefined 而正常，工具路径直传则报错——故在**工具层**统一做一次 JSON 往返。
// 覆盖范围：14 个工具全部（注册循环统一包裹，见 apply 内 toolDefs 循环），引擎与 HTTP 面均不动。
function toLossless(v) {
  if (v === undefined || typeof v === 'function') return null
  const s = JSON.stringify(v)
  return s === undefined ? null : JSON.parse(s)
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const toolsSvc = ctx.get('tools')
  // HTTP 面统一经 adapterHttp（一期标准接口：apiBase 解析 + 默认 8s 超时 + 非2xx 透传 body.error）；
  // fs 面统一经 adapterFs（根名 + 根内相对引用），消灭硬编码绝对路径。
  const adapterHttp = ctx.get('adapterHttp')
  const adapterFs = ctx.get('adapterFs')
  if (!adapterHttp || !adapterFs) {
    const _m = '[writing-coach] adapter 服务不可用（' + (!adapterHttp ? 'adapterHttp ' : '') + (!adapterFs ? 'adapterFs' : '') + ' 缺失）：HTTP/fs 面已按 O5 迁移，相关调用将降级'
    try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
  }

  // ============ AI 深审层（第 3 层，可选叠加；复用 taskkit typo-ai 的 DeepSeek 直连模式） ============
  // 无 key / 网络失败 → 返回 null，三层合并退化为两层，不阻塞主流程
  async function aiReviewLayer(text) {
    try {
      let apiKey = ''
      try {
        const { readFileSync, existsSync: existsSyncLocal } = await import('node:fs')
        const credPath = resolveCredentialsPath(process.env, process.cwd(), existsSyncLocal)
        if (existsSyncLocal(credPath)) {
          const yaml = readFileSync(credPath, 'utf8')
          const m = yaml.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\r\n]+)/)
          if (m) apiKey = m[1].trim()
        }
      } catch (e) {}
      if (!apiKey) return null
      const prompt = '你是中文错别字审查专家。请审查以下小说片段，找出其中的错别字和用字错误（包括语义级错误如"约下"应为"跃下"、"留着鲜血"应为"流着鲜血"、"打了寒蝉"应为"打了个寒噤"、"留下"（液体语境）应为"流下"、的/地/得误用等）。\n\n【规则】\n1. 基于上下文语义判断，不要只做静态字面匹配；\n2. 对每处输出：position(从0开始的字符偏移)、originalText、suggestion、type(形近/音近/语义/搭配/的地得)、confidence(high/medium/low)、reason；\n3. 低置信度或不确定的标注 medium/low（疑似，供用户确认）；\n4. 严格按 JSON 数组输出，不要多余文字；\n5. 没有错别字则输出空数组 []。\n\n【文本】\n' + text
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
      let findings = []
      try {
        const m = content.match(/\{[\s\S]*\}/) || content.match(/\[[\s\S]*\]/)
        if (m) findings = JSON.parse(m[0])
        if (!Array.isArray(findings)) findings = findings.findings || []
      } catch (e) { findings = [] }
      if (!Array.isArray(findings)) findings = []
      return findings.slice(0, 50)
    } catch (e) { return null }
  }

  // AI findings → 统一 schema（review_results 四段式 + 置信度 + 来源）
  function normalizeAiFindings(ai) {
    return (ai || []).map(function (f, i) {
      const pos = f && f.position
      const orig = String((f && (f.originalText || f.original)) || '')
      const start = typeof pos === 'number' ? pos : (pos && typeof pos.start === 'number' ? pos.start : 0)
      const end = typeof pos === 'number' ? start + orig.length : (pos && typeof pos.end === 'number' ? pos.end : start + orig.length)
      const conf = String((f && f.confidence) || 'medium').toLowerCase()
      const confNorm = conf === 'high' ? 'high' : (conf === 'low' ? 'low' : 'medium')
      const sev = confNorm === 'high' ? 'warning' : (confNorm === 'low' ? 'info' : 'warning')
      return {
        id: 'ai_' + i,
        type: 'typo',
        category: 'ai审查',
        originalText: orig,
        position: { start: start, end: end },
        suggestion: String((f && f.suggestion) || ''),
        severity: sev,
        confidence: confNorm,
        source: 'ai',
        description: String((f && (f.reason || f.reasoning)) || '') + (confNorm !== 'high' ? '（疑似，待确认）' : '')
      }
    })
  }

  // ============ P1-4 知识检索编排：POST knowledge-base /search（query 模式）或 /list（无 query 模式） ============
  // 契约：kb apiHandler 只解析 POST JSON body（不解析 GET query）——必须 charset=utf-8 JSON body（审查约束 F1 / t8 §B.1）；
  // /search 返回纯条目数组（score 不跨 HTTP）——本地 retrieveKnowledgeLocal 重打分是必需（审查约束 F2）；
  // HTTP 失败 → 经 adapterFs 读 knowledge.json 兜底（双轨制），返回 source:'kb-http'|'kb-fs'
  // O5 迁移：① 自建 loopback 直连（无超时）→ adapterHttp.post（默认 8s 超时；throwOnError:false 兼容位保持"不抛、落兜底"的既有调用面）；
  //          ② 兜底直读的硬编码绝对路径 → adapterFs 根名 + 根内相对引用。
  const KB_ROOT = '全局数据'
  const KB_REL = 'knowledge-base/knowledge.json'
  async function kbFetchEntries(query) {
    const q = String(query || '').trim()
    try {
      const res = await adapterHttp.post('/knowledge-base/api/' + (q ? 'search' : 'list'), q ? { q: q } : {}, { throwOnError: false })
      if (res && res.ok && res.data && Array.isArray(res.data.entries)) return { entries: res.data.entries, source: 'kb-http' }
      try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn('[writing-coach] kb HTTP 未取到 entries（status=' + (res && res.status) + ' error=' + (res && res.error) + '）→ 走 fs 兜底') } catch (_) {}
    } catch (e) {
      try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn('[writing-coach] kb HTTP 异常(' + String(e && e.message || e) + ') → 走 fs 兜底') } catch (_) {}
    }
    try {
      const kb = await adapterFs.readJson(KB_ROOT, KB_REL, { fallback: null })
      if (kb && Array.isArray(kb.entries)) return { entries: kb.entries, source: 'kb-fs' }
    } catch (e2) {}
    return { entries: [], source: 'kb-fs' }
  }

  // ============ Web API ============
  const apiHandler = function (req, res) {
    const u = new URL(req.url || '/', 'http://x')
    const parts = u.pathname.split('/').filter(Boolean) // [writing-coach, api, action, ...]
    const send = function (status, obj) {
      try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) } catch (e) {}
    }
    if (parts[0] !== 'writing-coach' || parts[1] !== 'api') return send(404, { ok: false, error: 'not found' })
    const action = parts[2] || ''
    if (action === 'ping') {
      return send(200, { ok: true, plugin: 'writing-coach', ts: Date.now(), engines: ['chapterBreaks', 'pacing', 'review', 'consistency', 'style', 'analyze', 'suggestions', 'structure', 'retrieve', 'docAnalyze', 'reviewApply', 'continuity'] })
    }
    let body = ''
    const done = async function () {
      let args = {}
      if (body) { try { args = JSON.parse(body) } catch (e) { return send(400, { ok: false, error: 'bad json' }) } }
      try {
        if (action === 'breakpoints') {
          const blocks = normalizeBlocks(args)
          if (!blocks.length) return send(400, { ok: false, error: '缺少 blocks 或 text' })
          return send(200, Object.assign({ ok: true }, analyzeChapterBreaks(args)))
        }
        if (action === 'pacing') {
          const blocks = normalizeBlocks(args)
          if (!blocks.length) return send(400, { ok: false, error: '缺少 blocks 或 text' })
          return send(200, Object.assign({ ok: true }, analyzeBlockPacing(args)))
        }
        if (action === 'review') {
          const text = String(args.text || '')
          if (!text) return send(400, { ok: false, error: '缺少 text' })
          const withAi = args.withAi === true
          const includeForbidden = args.includeForbidden === true
          let r = reviewText(text, { includeForbidden })
          let aiLayer = 'skipped'
          let aiCount = 0
          if (withAi) {
            const ai = await aiReviewLayer(String(text).slice(0, 5000))
            if (ai && ai.length) {
              const merged = mergeWithAi(r.findings, normalizeAiFindings(ai), 50)
              r = {
                findings: merged,
                layerCounts: Object.assign({}, r.layerCounts, { ai: ai.length }),
                total: merged.length,
                summary: merged.length
                  ? '发现 ' + merged.length + ' 处可疑（词典 ' + r.layerCounts.dict + ' + 规则 ' + r.layerCounts.rule + ' + AI ' + ai.length + '）'
                  : '未发现可疑点'
              }
              aiLayer = 'merged'
              aiCount = ai.length
            }
          }
          return send(200, Object.assign({ ok: true }, r, { aiLayer: aiLayer, aiCount: aiCount }))
        }
        if (action === 'consistency') {
          // B2-3 自一致性检查器：角色/世界观/时间线/逻辑 4 维 + 多源表决
          const text = String(args.text || '')
          if (!text) return send(400, { ok: false, error: '缺少 text' })
          const r = consistencyBatchCheck({
            content: text,
            characters: args.characters,
            worldRules: args.worldRules,
            facts: args.facts,
            events: args.events,
            newEvent: args.newEvent
          })
          return send(200, Object.assign({ ok: true }, r))
        }
        if (action === 'verify') {
          // B2-3 多源表决（可选）：{claim, sources:[{source, verify?|result}]}
          const claim = String(args.claim || '')
          if (!claim) return send(400, { ok: false, error: '缺少 claim' })
          const r = await verifyWithMultipleSources(claim, args.sources)
          return send(200, Object.assign({ ok: true }, r))
        }
        if (action === 'style') {
          // B2-4 文风 AI 味检测 + 风格预置
          const text = String(args.text || '')
          if (!text) return send(400, { ok: false, error: '缺少 text' })
          const detection = detectAIWriting(text)
          const targetStyle = String(args.targetStyle || '')
          const presetSuggestions = targetStyle ? applyStyleTransformation(text, targetStyle) : null
          return send(200, {
            ok: true,
            detection: { isAI: detection.isAI, confidence: detection.confidence, indicators: detection.indicators, suggestions: detection.suggestions },
            findings: detection.findings,
            presetSuggestions: presetSuggestions,
            presets: getPresetStyles()
          })
        }
        if (action === 'analyze') {
          // P1-1 文本分析规则引擎：{text} → 4 维 {structure, sentiment, intent, pacing}
          // engine:'local' 只增字段（本地规则模式，无 LLM 层——审查约束 F4 / t8 §D.1）
          const text = String(args.text || '')
          if (!text) return send(400, { ok: false, error: '缺少 text' })
          return send(200, Object.assign({ ok: true }, analyzeText({ text }), {
            engine: 'local',
            isFallback: true,
            summary: '本地规则文本分析（结构/情感/意图/节奏 4 维）'
          }))
        }
        if (action === 'suggestions') {
          // P1-2 写作建议生成：{text, analysis?, types?, includeCrossEngine?}
          // types 默认 ['writing_tip','pacing_note','transition']（源 L26）；analysis 缺省本地自动计算
          const text = String(args.text || '')
          if (!text) return send(400, { ok: false, error: '缺少 text' })
          let analysis = args.analysis && typeof args.analysis === 'object' ? args.analysis : null
          if (!analysis) {
            analysis = { structure: analyzeTextStructure(text), pacing: analyzeTextRhythm(text) }
          }
          const types = Array.isArray(args.types) ? args.types : undefined
          const includeCrossEngine = args.includeCrossEngine === true
          return send(200, Object.assign({ ok: true }, generateSuggestions({ text, analysis, types, includeCrossEngine }), { engine: 'local' }))
        }
        if (action === 'structure') {
          // P1-3 结构设计规则：{chapters?} → {chapters, pacingPlan, summary}
          const r = designStructure({ chapters: args.chapters })
          return send(200, Object.assign({ ok: true }, r, { engine: 'local' }))
        }
        if (action === 'retrieve') {
          // P1-4 知识检索：{query?, types?[], limit?(默认20 cap50), projectScope?}
          // → {ok, items:[{id,type,title,content,relevance}], totalCount, summary, source, engine:'local'}
          const query = String(args.query || '').trim()
          const types = Array.isArray(args.types) ? args.types : undefined
          const limit = (args.limit !== undefined && args.limit !== null) ? Number(args.limit) : 20
          const projectScope = String(args.projectScope || '').trim() || undefined
          const fetched = await kbFetchEntries(query)
          const r = retrieveKnowledgeLocal(fetched.entries, { query, types, limit, projectScope })
          return send(200, Object.assign({ ok: true }, r, { source: fetched.source, engine: 'local' }))
        }
        if (action === 'doc-analyze') {
          // B1 文档导入语义分析（方向 B，additive）：{title?, content, sourcePath?}
          // → {ok, kind, structure, sentiment, intent, pacing, keyElements, summary, suggestedCategory, suggestedTags, suggestedAliases, engine:'local'}
          const content = String(args.content || '')
          if (!content.trim()) return send(400, { ok: false, error: '缺少 content' })
          return send(200, Object.assign({ ok: true }, analyzeDocument({
            title: String(args.title || ''),
            content: content,
            sourcePath: String(args.sourcePath || '')
          })))
        }
        if (action === 'review-apply') {
          // B2 审查结果一键修复（方向 B，additive）：{text, findings:[{position,originalText,suggestion}]}
          // → {ok, text, applied[], skipped[], summary}（按 position.start 升序批量应用 + offset 修正）
          const text = String(args.text || '')
          if (!text) return send(400, { ok: false, error: '缺少 text' })
          if (!Array.isArray(args.findings)) return send(400, { ok: false, error: '缺少 findings 数组' })
          return send(200, Object.assign({ ok: true }, applyReviewFixes(text, args.findings)))
        }
        if (action === 'continuity') {
          // B3 章节连续性 6 维检测（方向 B，additive）：{content(必填), characters?, worldRules?, facts?, events?, newEvent?, blocks?, detailFacts?}
          // → {ok, checks(6 类), summary, passedCount, failedCount, warningCount, dimensions}
          const content = String(args.content || '')
          if (!content.trim()) return send(400, { ok: false, error: '缺少 content' })
          const r = continuity6DCheck({
            content: content,
            characters: args.characters,
            worldRules: args.worldRules,
            facts: args.facts,
            events: args.events,
            newEvent: args.newEvent,
            blocks: args.blocks,
            detailFacts: args.detailFacts
          })
          return send(200, Object.assign({ ok: true }, r))
        }
        return send(404, { ok: false, error: '未知 action: ' + action, actions: ['ping', 'breakpoints', 'pacing', 'review', 'consistency', 'verify', 'style', 'analyze', 'suggestions', 'structure', 'retrieve', 'doc-analyze', 'review-apply', 'continuity'] })
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message || e) })
      }
    }
    req.on('data', function (chunk) { body += chunk })
    req.on('end', done)
    req.on('error', function () { try { res.end('') } catch (e) {} })
  }

  if (webServer && typeof webServer.register === 'function') {
    try {
      // disposer 包进 ctx.effect，reload/卸载时自动清理，防 duplicate route
      ctx.effect(function () { return webServer.register({ kind: 'prefixes', path: '/writing-coach/api', handler: apiHandler }) })
    } catch (e) {
      try { ctx.get('logger') && ctx.get('logger').warn('[writing-coach] api register failed: ' + String(e && e.message || e)) } catch (_) {}
    }
  }

  // ============ 工具注册 ============
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    const toolDefs = [
      {
        name: 'writing_coach_ping',
        description: '写作教练引擎自检：返回插件与引擎可用状态。',
        parameters: {},
        execute: async function () { return { ok: true, plugin: 'writing-coach', ts: Date.now(), engines: ['chapterBreaks', 'pacing', 'review', 'consistency', 'style', 'analyze', 'suggestions', 'structure', 'retrieve', 'docAnalyze', 'reviewApply', 'continuity'] } }
      },
      {
        name: 'writing_coach_breakpoints',
        description: '断章判定：按文本特征打分（长度>500/句末标点/对话收尾/悬念词/动作词），返回候选断章点（位置/类型/置信度/理由/建议）。入参 blocks（数组，[{id?,content}]）或 text（字符串，按空行分块）。',
        parameters: {
          blocks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '文本块数组 [{id?, content}]（与 text 二选一）' },
          text: { type: 'string', description: '全文（按空行分块；与 blocks 二选一）' }
        },
        execute: async function (args) { return Object.assign({ ok: true }, analyzeChapterBreaks(args || {})) }
      },
      {
        name: 'writing_coach_pacing',
        description: '节奏分析：场景四分类（dialogue/action/description/transition）+ 双评分（pacingScore 节奏分、intensity 强度）+ 阅读时长（字数/200），含汇总（平均节奏/场景分布/总评）与建议（节奏突变/连续描述/连续对话）。入参 blocks（数组）或 text（字符串）。',
        parameters: {
          blocks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '文本块数组 [{id?, content}]（与 text 二选一）' },
          text: { type: 'string', description: '全文（按空行分块；与 blocks 二选一）' }
        },
        execute: async function (args) { return Object.assign({ ok: true }, analyzeBlockPacing(args || {})) }
      },
      {
        name: 'writing_coach_review',
        description: '审查规则引擎：三层合并（①静态词典→②11+5 正则+形近/音近词典→③AI 深审可选）。输出 review_results 四段式 findings（type/category/originalText/position/suggestion/severity/confidence/source/description）。学员实例全覆盖：约下→跃下、仍→扔、跳动→转动(疑似)、留下→流下、寒蝉→寒噤、的/地/得。入参 text（必填）、includeForbidden（可选，默认 false 关闭政治/暴恐敏感规则）、withAi（可选，默认 false 不调 AI 层）。',
        parameters: {
          text: { type: 'string', description: '待审查文本', required: true },
          includeForbidden: { type: 'string', description: '是否启用 forbidden 敏感规则（true/false，默认 false）' },
          withAi: { type: 'string', description: '是否叠加 AI 深审层（true/false，默认 false；无凭据时自动跳过）' }
        },
        execute: async function (args) {
          const text = String(args && args.text || '')
          if (!text) return { ok: false, error: '缺少 text' }
          const includeForbidden = String(args.includeForbidden) === 'true'
          const r = reviewText(text, { includeForbidden })
          return Object.assign({ ok: true }, r, { aiLayer: 'skipped' })
        }
      },
      {
        name: 'writing_coach_consistency',
        description: '自一致性检查器：角色（外貌互斥矛盾/性格/背景关键词匹配）、世界观（no_ 前缀禁止规则）、时间线（数字/ISO 归一比较）、逻辑（facts 正向/反向）4 维 + 汇总。入参 text（必填，待检查正文）、characters（[{name, attributes:{appearance?,personality?,background?}}]）、worldRules（[{rule:\'no_xxx\',description?}] 或 {no_xxx:描述}）、facts（[\'xxx\' 或 {fact:\'xxx\',negation?}]）、events（[{time,description}]）、newEvent（{time,description}）。返回 {checks, summary, passedCount, failedCount, warningCount}。',
        parameters: {
          text: { type: 'string', description: '待检查正文（必填）', required: true },
          characters: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '角色设定数组 [{name, attributes:{appearance?,personality?,background?}}]' },
          worldRules: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '世界观规则 [{rule:"no_xxx",description?}] 或 {no_xxx:描述}' },
          facts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '逻辑事实 ["xxx" 或 {fact:"xxx",negation?}]' },
          events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '已有时间线事件 [{time,description}]' },
          newEvent: { type: 'object', additionalProperties: true, description: '新事件 {time,description}' }
        },
        execute: async function (args) {
          const text = String(args && args.text || '')
          if (!text) return { ok: false, error: '缺少 text' }
          const r = consistencyBatchCheck({
            content: text,
            characters: args.characters,
            worldRules: args.worldRules,
            facts: args.facts,
            events: args.events,
            newEvent: args.newEvent
          })
          return Object.assign({ ok: true }, r)
        }
      },
      {
        name: 'writing_coach_verify',
        description: '多源表决：对 claim 由多个来源投票（sources 每项 {source, verify?: (text)=>boolean|Promise<boolean>, result?: boolean}），consensus=正例/总数，≥0.5 → verified。返回 {claim, verified, consensus, results}。',
        parameters: {
          claim: { type: 'string', description: '待表决声明（必填）', required: true },
          sources: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '来源数组 [{source, result?}]（预置结果）或 [{source, verify}]（函数，web 工具场景用 result）', required: true }
        },
        execute: async function (args) {
          const claim = String(args && args.claim || '')
          if (!claim) return { ok: false, error: '缺少 claim' }
          const r = await verifyWithMultipleSources(claim, args.sources)
          return Object.assign({ ok: true }, r)
        }
      },
      {
        name: 'writing_coach_style',
        description: '文风 AI 味检测：10 条 AI 特征正则（连接词/填充词/总结/概括/主语/句式/递进/条件/背景/介词短语）+ 长句/逗号特征，confidence=min(1,count*0.15)、isAI>0.5；输出结构化 findings（带位置）与去 AI 化建议；可选 targetStyle 返回 4 风格预置（网文/传统文学/剧本/轻小说）转换建议。入参 text（必填）、targetStyle（可选）。返回 {detection:{isAI,confidence,indicators,suggestions}, findings, presetSuggestions, presets}。',
        parameters: {
          text: { type: 'string', description: '待检测文本（必填）', required: true },
          targetStyle: { type: 'string', description: '目标风格（可选：网文/传统文学/剧本/轻小说）' }
        },
        execute: async function (args) {
          const text = String(args && args.text || '')
          if (!text) return { ok: false, error: '缺少 text' }
          const detection = detectAIWriting(text)
          const targetStyle = String(args.targetStyle || '')
          const presetSuggestions = targetStyle ? applyStyleTransformation(text, targetStyle) : null
          return {
            ok: true,
            detection: { isAI: detection.isAI, confidence: detection.confidence, indicators: detection.indicators, suggestions: detection.suggestions },
            findings: detection.findings,
            presetSuggestions: presetSuggestions,
            presets: getPresetStyles()
          }
        }
      },
      {
        name: 'writing_coach_analyze',
        description: '文本分析规则引擎（P1-1）：4 维本地规则——结构（dialogue/description/narration/mixed + hierarchy 层级 1-3 + 字数 + 段落数）、情感（正负词表各 10 词 → tone positive/negative/neutral + intensity）、意图（冲突/解决/开始词 → conflict/resolution/setup/transition + 关键元素）、节奏（句均长 → speed fast/medium/slow + 逗号密度 → density）。入参 text（必填）。返回 {structure, sentiment, intent, pacing, engine:\'local\'}。',
        parameters: {
          text: { type: 'string', description: '待分析文本（必填）', required: true }
        },
        execute: async function (args) {
          const text = String(args && args.text || '')
          if (!text) return { ok: false, error: '缺少 text' }
          return Object.assign({ ok: true }, analyzeText({ text }), { engine: 'local', isFallback: true })
        }
      },
      {
        name: 'writing_coach_suggestions',
        description: '写作建议生成（P1-2）：6 类本地规则建议直移 suggestionGenerator（writing_tip 节奏/字数、pacing_note 段落长短、transition 场景过渡、word_replace 5 组词替换、sentence_optimize 代词开头、detail_enhance 感官/叙述细节）+ includeCrossEngine 附加 tension_point（断章引擎）/redundancy_fix（文风 AI 味）。入参 text（必填）、types（可选数组，默认 [\'writing_tip\',\'pacing_note\',\'transition\']）、analysis（可选，缺省本地自动计算）、includeCrossEngine（可选 true/false，默认 false）。返回 {suggestions, totalCount, types, summary, engine:\'local\'}。',
        parameters: {
          text: { type: 'string', description: '待分析文本（必填）', required: true },
          types: { type: 'array', items: { type: 'string' }, description: '建议类型列表（可选；8 类：writing_tip/pacing_note/transition/tension_point/word_replace/sentence_optimize/detail_enhance/redundancy_fix）' },
          analysis: { type: 'object', additionalProperties: true, description: '文本分析结果（可选，缺省自动用本地规则计算 structure+pacing）' },
          includeCrossEngine: { type: 'string', description: '是否附加跨引擎建议 tension_point/redundancy_fix（true/false，默认 false）' }
        },
        execute: async function (args) {
          const text = String(args && args.text || '')
          if (!text) return { ok: false, error: '缺少 text' }
          let analysis = args && args.analysis && typeof args.analysis === 'object' ? args.analysis : null
          if (!analysis) {
            analysis = { structure: analyzeTextStructure(text), pacing: analyzeTextRhythm(text) }
          }
          const types = Array.isArray(args && args.types) ? args.types : undefined
          const includeCrossEngine = String(args && args.includeCrossEngine) === 'true'
          return Object.assign({ ok: true }, generateSuggestions({ text, analysis, types, includeCrossEngine }), { engine: 'local' })
        }
      },
      {
        name: 'writing_coach_structure',
        description: '结构设计规则（P1-3）：章节位置（opening/rising/climax/falling/ending，阈值 0.2/0.7/0.9/1.0）+ 断点类型（setup/suspense/crisis/decision/resolution + hook 建议，position 0.8）+ 节奏计划（slow/medium/fast）+ 字数目标（1500/2500/4000）。入参 chapters（可选，已有章节数组，缺省按最少 3 章规划）。返回 {chapters, pacingPlan, summary, engine:\'local\'}。',
        parameters: {
          chapters: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '已有章节数组（可选，缺省 []）' }
        },
        execute: async function (args) {
          return Object.assign({ ok: true }, designStructure({ chapters: args && args.chapters }), { engine: 'local' })
        }
      },
      {
        name: 'writing_coach_retrieve',
        description: '知识检索（P1-4）：编排 knowledge-base /search（POST JSON {q}，charset=utf-8）或 /list（无 query），本地类型识别（character/setting/worldview/event/other，category 主表 + tags/aliases/title 兜底）+ 重打分（scoreKnowledge 源公式）+ 排序 slice；HTTP 失败 fs 直读 knowledge.json 兜底（source:\'kb-fs\'）。入参 query（可选）、types（可选数组）、limit（可选默认 20 上限 50）、projectScope（可选；KB 无 project 字段，按 title/description/content/sourcePath 包含匹配弱约束）。返回 {items:[{id,type,title,content,relevance}], totalCount, summary, source, engine:\'local\'}。',
        parameters: {
          query: { type: 'string', description: '检索关键词（可选；无 query 走 /list 全量）' },
          types: { type: 'array', items: { type: 'string' }, description: '类型过滤（可选：character/setting/worldview/event/other）' },
          limit: { type: 'string', description: '返回条数（可选，默认 20，上限 50）' },
          projectScope: { type: 'string', description: '项目范围弱约束（可选）' }
        },
        execute: async function (args) {
          const query = String(args && args.query || '').trim()
          const types = Array.isArray(args && args.types) ? args.types : undefined
          const limit = (args && args.limit !== undefined && args.limit !== null) ? Number(args.limit) : 20
          const projectScope = String(args && args.projectScope || '').trim() || undefined
          const fetched = await kbFetchEntries(query)
          const r = retrieveKnowledgeLocal(fetched.entries, { query, types, limit, projectScope })
          return Object.assign({ ok: true }, r, { source: fetched.source, engine: 'local' })
        }
      },
      {
        name: 'writing_coach_doc_analyze',
        description: '文档导入语义分析（方向 B B1）：对导入文档自动分类/结构化——类型识别（character/setting/worldview/event/other）+ 4 维分析（structure/sentiment/intent/pacing）+ 建议导入字段（suggestedCategory/suggestedTags/suggestedAliases/summary），喂给既有 kb_import/knowledge-base /import 零改动。入参 content（必填）、title（可选）、sourcePath（可选）。返回 {kind, structure, sentiment, intent, pacing, keyElements, summary, suggestedCategory, suggestedTags, suggestedAliases, engine:\'local\'}。',
        parameters: {
          content: { type: 'string', description: '文档内容全文（必填）', required: true },
          title: { type: 'string', description: '文档标题（可选，用于类型识别与别名建议）' },
          sourcePath: { type: 'string', description: '原始文件路径（可选，走 kb 索引模式时传入）' }
        },
        execute: async function (args) {
          const content = String(args && args.content || '')
          if (!content.trim()) return { ok: false, error: '缺少 content' }
          return Object.assign({ ok: true }, analyzeDocument({
            title: String(args && args.title || ''),
            content: content,
            sourcePath: String(args && args.sourcePath || '')
          }))
        }
      },
      {
        name: 'writing_coach_review_apply',
        description: '审查结果一键修复（方向 B B2）：把审查 findings（四段式 position/originalText/suggestion）批量应用到正文——按 position.start 升序、跳过无 suggestion/无 position/区间重叠/原文漂移项、offset 修正。入参 text（必填，原文）、findings（必填，数组 [{position:{start,end}, originalText, suggestion}]）。返回 {text(修复后), applied[], skipped[], summary}。',
        parameters: {
          text: { type: 'string', description: '待修复正文（必填）', required: true },
          findings: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '审查结果数组 [{position:{start,end}, originalText, suggestion}]（必填）', required: true }
        },
        execute: async function (args) {
          const text = String(args && args.text || '')
          if (!text) return { ok: false, error: '缺少 text' }
          if (!Array.isArray(args && args.findings)) return { ok: false, error: '缺少 findings 数组' }
          return Object.assign({ ok: true }, applyReviewFixes(text, args.findings))
        }
      },
      {
        name: 'writing_coach_continuity',
        description: '章节连续性 6 维检测（方向 B B3）：既有 4 维（角色/世界观/时间线/逻辑，复用原检查器）+ 新 2 维（场景连续性 consistencyCheckScene：相邻块地点/时间/场景类型突变；细节回呼 consistencyCheckDetail：detailFacts 道具/称呼/数字回呼缺失 warning、矛盾 failed）。入参 content（必填）、characters/worldRules/facts/events/newEvent（同 writing_coach_consistency）、blocks（可选数组，缺省按空行分块）、detailFacts（可选 [{fact, occurrences?, negation?}]）。返回 {checks(6 类), summary, passedCount, failedCount, warningCount, dimensions}。',
        parameters: {
          content: { type: 'string', description: '待检查正文（必填）', required: true },
          characters: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '角色设定数组 [{name, attributes:{appearance?,personality?,background?}}]' },
          worldRules: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '世界观规则 [{rule:"no_xxx",description?}] 或 {no_xxx:描述}' },
          facts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '逻辑事实 ["xxx" 或 {fact:"xxx",negation?}]' },
          events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '已有时间线事件 [{time,description}]' },
          newEvent: { type: 'object', additionalProperties: true, description: '新事件 {time,description}' },
          blocks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '文本块数组 [{id?,content}]（可选，缺省按空行分块）' },
          detailFacts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '细节回呼设定 [{fact, occurrences?, negation?}]（可选）' }
        },
        execute: async function (args) {
          const content = String(args && args.content || '')
          if (!content.trim()) return { ok: false, error: '缺少 content' }
          const r = continuity6DCheck({
            content: content,
            characters: args && args.characters,
            worldRules: args && args.worldRules,
            facts: args && args.facts,
            events: args && args.events,
            newEvent: args && args.newEvent,
            blocks: args && args.blocks,
            detailFacts: args && args.detailFacts
          })
          return Object.assign({ ok: true }, r)
        }
      }
    ]
    for (const def of toolDefs) {
      try {
        const d = toolsSvc.register(defineTool(Object.assign({}, def, {
          // 统一消毒：所有工具（14 个）都经 toLossless 出口，防止同类 undefined/非纯对象边缘情况再犯（t49）
          execute: async function (args) { return toLossless(await def.execute(args)) },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
            presentationMeta: function (args, value) { return value || {} }
          }
        })))
        ctx.effect(function () { return function () { try { d && d() } catch (e) {} } })
      } catch (e) {
        try { ctx.get('logger') && ctx.get('logger').warn('[writing-coach] tool register failed: ' + String(e && e.message || e)) } catch (_) {}
      }
    }
  }
}

// cordis loader reads inject array from named exports
export { inject }
