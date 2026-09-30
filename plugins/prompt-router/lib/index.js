// Host：元提示词路由 + 参考库 + 评估迭代体系 @local/prompt-router
// 功能：
//   1) 提示词参考库：分类/用途/质量标注/来源/评分，落盘工作区 JSON
//   2) 元提示词路由：按任务类型关键词匹配优质模板 → 生成优化提示词（模板+变量填充）
//   3) 评估体系：五维打分（效果/清晰度/稳定性/通用性/成本，各 1-5）+ 总分
//   4) 尝试迭代：应用后反馈结果 → 优胜劣汰/参数调整 → 闭环
// 端点：/prompt-router/api/ping | list | route | add | update | rate | trial | stats | import-batch
import { defineTool } from '@deepseek-ai/dsh-tools'

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer'
]

// 数据根口径（O5 迁移）：根名由 adapter 部署 config 登记（`dsh-bundle-patch.yml` 的 `roots.全局数据`），
// 插件只持"根内相对引用"，不再硬编码盘符路径、不再做根路径字符串拼接。
const PROMPTS_ROOT = '全局数据'
const PROMPTS_REL = 'prompt-router/prompts.json'
const TRIALS_REL = 'prompt-router/trials.json'

// 工具输出统一消毒（O5 惯例，同 t49 writing-coach）：宿主对 agent 工具返回值做「无损 JSON」校验——
// 对象里出现 `undefined`/函数/非纯对象字段即报 `invalid output: value is not lossless JSON`（HTTP 路径因 JSON.stringify 丢弃 undefined 而不受影响）。
// 统一在**唯一注册循环**出口做一次 JSON 往返，防止同类边缘情况再犯。
function toLossless(v) {
  if (v === undefined || typeof v === 'function') return null
  const s = JSON.stringify(v)
  return s === undefined ? null : JSON.parse(s)
}

export function apply(ctx) {
  // fs 面统一经 adapterFs（一期标准接口）：相对引用解析到登记根，默认直读盘（无 30s TTL 陈旧窗口），写后自动失效。
  const adapterFs = ctx.get('adapterFs')
  if (!adapterFs) {
    const _m = '[prompt-router] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写 prompts/trials（请确认 profile bundles 中 @local/dsh-adapter 已加载）'
    try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
  }

  // ============ 数据读写（经 adapterFs：根名 + 根内相对引用；默认直读，写后自动失效） ============
  async function readPrompts() {
    return adapterFs.readJson(PROMPTS_ROOT, PROMPTS_REL, { fallback: { version: 1, prompts: [] } })
  }
  async function readTrials() {
    return adapterFs.readJson(PROMPTS_ROOT, TRIALS_REL, { fallback: { version: 1, trials: [] } })
  }
  async function writePrompts(lib) {
    try { await adapterFs.writeJson(PROMPTS_ROOT, PROMPTS_REL, lib); return true } catch (e) { return false }
  }
  async function writeTrials(trials) {
    try { await adapterFs.writeJson(PROMPTS_ROOT, TRIALS_REL, trials); return true } catch (e) { return false }
  }

  // ============ 内置初始提示词库（10 条高质量通用模板） ============
  const SEED_PROMPTS = [
    { id: 'p-writing', category: '写作', tags: ['写作', '小说', '创作'], title: '写作创作模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 3, cost: 4 }, template: '你是一位专业{role}。请围绕主题「{topic}」创作{genre}作品。要求：1) 结构清晰（开头-发展-高潮-结尾）；2) 人物立体有动机；3) 语言有画面感；4) 字数约{words}字。完成后自检：情节完整性/人物一致性/语言质量。', vars: ['role', 'topic', 'genre', 'words'] },
    { id: 'p-plugin', category: '插件开发', tags: ['插件', '开发', 'cordis'], title: '插件开发任务模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 4, cost: 3 }, template: '实现任务「{task}」。遵循《插件开发规范》：1) 先读相关文档；2) 产出真实代码变更（禁止纸面完成）；3) 同步权威源与运行副本；4) 用 sandbox_reload 或宿主重启验证；5) 回执注明产物路径。约束：{constraints}。', vars: ['task', 'constraints'] },
    { id: 'p-analysis', category: '分析', tags: ['分析', '研究', '评估'], title: '深度分析模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 4, cost: 3 }, template: '请对「{subject}」做深度分析：1) 现状与背景；2) 关键因素拆解；3) 优势与风险；4) 结论与建议。输出结构化 Markdown，附数据/证据支持。', vars: ['subject'] },
    { id: 'p-email', category: '邮件', tags: ['邮件', '回复', '商务'], title: '邮件撰写模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 5, generality: 3, cost: 5 }, template: '撰写一封{type}邮件给{recipient}。主题「{subject}」。要点：1) 开头礼貌问候；2) 正文简洁分点（核心信息先行）；3) 明确行动请求/回复期限；4) 结尾致谢。语气{style}，长度适中。', vars: ['type', 'recipient', 'subject', 'style'] },
    { id: 'p-review', category: '审查', tags: ['审查', '检查', '验收'], title: '审查验收模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 4, cost: 4 }, template: '对「{artifact}」执行{type}审查。逐项核验：{items}。每项标注 通过/不通过 + 依据。不通过项给出具体失败清单与修改建议。最终输出审查结论（通过/驳回）。', vars: ['artifact', 'type', 'items'] },
    { id: 'p-idea', category: '灵感', tags: ['灵感', '创意', '构思'], title: '灵感发散模板', source: '内置', quality: 3, score: { effect: 4, clarity: 4, stability: 3, generality: 4, cost: 5 }, template: '基于「{seed}」进行创意发散：1) 3 个不同方向的构想；2) 每个方向给出钩子/设定/潜在展开；3) 评估可行性与独特性；4) 推荐最优方向并说明理由。', vars: ['seed'] },
    { id: 'p-todo', category: '任务规划', tags: ['任务', '规划', '拆解'], title: '任务拆解模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 4, cost: 5 }, template: '将目标「{goal}」拆解为可执行任务：1) 按依赖关系排序；2) 每任务含明确产出与验收标准；3) 标注负责人/优先级/预估耗时；4) 识别风险与前置条件。输出结构化清单。', vars: ['goal'] },
    { id: 'p-summary', category: '总结', tags: ['总结', '复盘', '提炼'], title: '经验总结模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 4, cost: 5 }, template: '对「{subject}」做经验总结：1) 背景与目标；2) 关键决策及理由；3) 踩坑与教训；4) 可复用模式/流程改进；5) 待办事项。分条列出，附具体事例。', vars: ['subject'] },
    { id: 'p-debug', category: '调试', tags: ['调试', 'bug', '修复'], title: '问题排查模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 4, generality: 4, cost: 3 }, template: '排查并修复问题「{problem}」。步骤：1) 复现并收集错误信息；2) 定位根因（分析代码/日志/数据）；3) 提出修复方案（含影响面评估）；4) 实施并验证；5) 记录经验。附关键证据。', vars: ['problem'] },
    { id: 'p-doc', category: '文档', tags: ['文档', '写作', '规范'], title: '技术文档模板', source: '内置', quality: 4, score: { effect: 4, clarity: 5, stability: 5, generality: 4, cost: 5 }, template: '撰写「{topic}」的技术文档：1) 需求背景；2) 设计决策（关键取舍）；3) 实现说明（代码路径/配置）；4) 验收结果（实测数据）；5) 经验教训；6) 文档变更清单。用 Markdown，含表格与具体路径。', vars: ['topic'] }
  ]

  // ============ 写作域路由扩展（B2-1：库内模板参与路由，契约零破坏） ============
  // 写作域强信号（22 词，全部写作域特异性；「审查」为通用词已移除，防非写作请求误触发）
  const WRITING_SIGNALS = /小说|章节|文本|文章|大纲|断章|节奏|世界观|错别字|润色|人设|情节|对话|描写|创意|故事|剧本|轻小说|网文|文风|正文|段落/
  // 写作对象词（审查/检查/校对 条目的限定条件：必须同时命中写作对象才走 wc-text-review）
  const WRITING_OBJECTS = /小说|文本|章节|文稿|正文|段落|作品|草稿|文章/
  // 写作域规则表（置于种子规则之前，写作意图优先；首个命中即返回 wc-* 库内模板）
  // 注意：RULES_WC 与 WRITING_SIGNALS 配合——仅当文本命中写作域强信号才进入本表
  const RULES_WC = [
    { re: /审查|检查|校对/, obj: WRITING_OBJECTS, id: 'wc-text-review' },
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
  const WC_CATEGORIES = ['analysis', 'suggestion', 'review', 'structure']
  const WRITING_SIGNAL_WORDS = ['小说', '章节', '文本', '文章', '大纲', '断章', '节奏', '世界观', '错别字', '润色', '人设', '情节', '对话', '描写', '创意', '故事', '剧本', '轻小说', '网文', '文风', '正文', '段落']
  // 库内模板关键词打分兜底：RULES_WC 未命中时，对库内条目按 title/tags/category 与写作域命中词交集打分
  function scoreMatchWc(t, prompts) {
    const hits = WRITING_SIGNAL_WORDS.filter(function (w) { return t.indexOf(w) >= 0 })
    if (!hits.length) return null
    let best = null
    let bestScore = 0
    for (const p of (prompts || [])) {
      if (!p || !p.id || p.id.indexOf('wc-') !== 0) continue // 仅库内 wc-* 条目参与打分兜底
      const tags = Array.isArray(p.tags) ? p.tags : []
      const catOk = WC_CATEGORIES.indexOf(p.category) >= 0
      const tagOk = tags.some(function (tag) { return hits.indexOf(tag) >= 0 || hits.some(function (h) { return String(tag).indexOf(h) >= 0 }) })
      if (!catOk && !tagOk) continue
      const hay = String(p.title || '') + ' ' + tags.join(' ') + ' ' + String(p.category || '')
      let score = 0
      for (const h of hits) { if (hay.indexOf(h) >= 0) score += 2 }
      if (score > bestScore) { bestScore = score; best = p }
    }
    return bestScore > 0 ? best : null
  }

  // ============ 核心逻辑 ============
  // 路由：按任务标题/要求关键词匹配最合适的模板，填充变量生成优化提示词
  // B2-1 扩展：routePrompt(title, requirement, lib?) —— lib 可选（缺省种子库）；
  //   写作域强信号命中 → RULES_WC 前置（写作意图优先）→ 库内打分兜底 → 回落原种子规则 → p-analysis fallback
  //   非写作请求 → 原种子规则表原样执行（10 条 rules 顺序/id/template 零改动）
  function routePrompt(title, requirement, lib) {
    const prompts = (lib && lib.prompts && lib.prompts.length ? lib.prompts : SEED_PROMPTS)
    const text = String(title || '') + ' ' + String(requirement || '')
    const t = text.toLowerCase()
    const rules = [
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
    let matched = null
    let source = 'seed'
    // 写作域强信号门控（B2-1）：命中才走写作域路由，否则原种子规则原样执行
    if (WRITING_SIGNALS.test(t)) {
      // RULES_WC 前置（写作意图优先，首个命中即返回）
      for (let i = 0; i < RULES_WC.length; i++) {
        const r = RULES_WC[i]
        if (r.re.test(t) && (!r.obj || r.obj.test(t))) {
          const p = prompts.find(function (x) { return x.id === r.id })
          if (p) { matched = p; source = 'file'; break }
        }
      }
      // 库内模板关键词打分兜底（仅 wc-* 库内条目）
      if (!matched) {
        matched = scoreMatchWc(t, prompts)
        if (matched) source = 'file'
      }
    }
    // 回落原种子规则（写作域未命中 或 写作域路由无匹配）
    if (!matched) {
      for (let i = 0; i < rules.length; i++) {
        if (rules[i].re.test(t)) { matched = prompts.find(function (p) { return p.id === rules[i].id }) || null; if (matched) { source = 'seed'; break } }
      }
    }
    if (!matched) matched = prompts.find(function (p) { return p.id === 'p-analysis' }) || SEED_PROMPTS.find(function (p) { return p.id === 'p-analysis' })
    // 变量填充：提取关键词作为变量值（简化：标题关键词 + 要求摘要；body.args.vars 可覆盖）
    const vars = {}
    vars.task = (String(title || '').split('·')[0] || String(title || '')).trim()
    vars.topic = vars.task
    vars.subject = vars.task
    vars.goal = vars.task
    vars.problem = vars.task
    vars.artifact = vars.task
    vars.seed = vars.task
    vars.t = vars.task
    // 组装优化提示词：按模板原占位符语法（种子 {var} / 导入 {{var}}）分别替换，仅替换已提供变量；未提供保持原占位符
    let optimized = matched.template
    for (const v of (matched.vars || [])) {
      const val = vars[v] || ('{{' + v + '}}')
      optimized = optimized.replace(new RegExp('\\{\\{' + v + '\\}\\}', 'g'), val)
      optimized = optimized.replace(new RegExp('\\{' + v + '\\}', 'g'), val)
    }
    return { matchedId: matched.id, matchedTitle: matched.title, category: matched.category, optimized: optimized, score: matched.score, templateId: matched.id, source: source }
  }

  // 五维评估：输入各维 1-5 分 → 计算总分与质量等级
  function evaluateScore(s) {
    s = s || {}
    const dims = ['effect', 'clarity', 'stability', 'generality', 'cost']
    let total = 0
    let count = 0
    for (const d of dims) {
      const v = Number(s[d]) || 0
      if (v >= 1 && v <= 5) { total += v; count++ }
    }
    const avg = count ? total / count : 0
    const level = avg >= 4.5 ? '优' : (avg >= 3.5 ? '良' : (avg >= 2.5 ? '中' : '差'))
    return { total: Math.round(total * 10) / 10, avg: Math.round(avg * 10) / 10, level: level }
  }

  // ============ Web API（async handler；body 用事件读取，兼容 webServer 前缀路由） ============
  const apiHandler = function (req, res) {
    const u = new URL(req.url || '/', 'http://x')
    const parts = u.pathname.split('/').filter(Boolean) // [prompt-router, api, action, ...]
    const send = function (status, obj) {
      try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) } catch (e) {}
    }
    if (parts[0] !== 'prompt-router' || parts[1] !== 'api') return send(404, { ok: false, error: 'not found' })
    const action = parts[2] || ''
    let body = ''
    const done = async function () {
      let args = {}
      if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
      try {
        if (action === 'ping') return send(200, { ok: true, plugin: 'prompt-router', ts: Date.now() })
            if (action === 'list') {
              const lib = await readPrompts()
              const items = (lib.prompts || []).map(function (p) {
                const es = evaluateScore(p.score)
                return { id: p.id, category: p.category, tags: p.tags, title: p.title, source: p.source, quality: p.quality, score: p.score, eval: es, template: p.template, vars: p.vars }
              })
              const cats = {}
              items.forEach(function (p) { cats[p.category] = (cats[p.category] || 0) + 1 })
              return send(200, { ok: true, total: items.length, categories: cats, prompts: items })
            }
            if (action === 'route') {
              // B2-1 健壮性（组长验证反馈 2026-08-28）：支持 GET query 参数（title/requirement）——
              //   部分调用方（如 PowerShell Invoke-RestMethod 默认 ANSI 编码）POST 中文 body 会乱码导致 fallback，
              //   GET ?title=…&requirement=… 可绕过编码问题；args（body）优先，query 兜底
              const qTitle = u.searchParams.get('title')
              const qReq = u.searchParams.get('requirement')
              const title = String(args.title || qTitle || '')
              const requirement = String(args.requirement || qReq || '')
              const lib = await readPrompts()
              const result = routePrompt(title, requirement, lib)
              // B2-1：optimized 直接来自命中模板正文（库内 wc-* 模板可被路由命中）
              if (args.vars && typeof args.vars === 'object') {
                // body.args.vars 覆盖变量填充
                const vars = args.vars
                let optimized = result.optimized
                for (const v of Object.keys(vars)) {
                  if (vars[v] === undefined || vars[v] === null) continue
                  optimized = optimized.replace(new RegExp('\\{\\{' + v + '\\}\\}', 'g'), String(vars[v]))
                  optimized = optimized.replace(new RegExp('\\{' + v + '\\}', 'g'), String(vars[v]))
                }
                result.optimized = optimized
              }
              return send(200, { ok: true, ...result })
            }
            if (action === 'add') {
              const p = args.prompt
              if (!p || !p.title || !p.template) return send(400, { ok: false, error: '缺少 title/template' })
              const lib = await readPrompts()
              const prompts = lib.prompts || []
              const id = 'p-' + String(Date.now()).slice(-6)
              prompts.unshift({
                id: id, category: String(p.category || '通用'), tags: Array.isArray(p.tags) ? p.tags : [], title: String(p.title),
                source: String(p.source || '人工补充'), quality: Number(p.quality) || 3,
                score: p.score || { effect: 3, clarity: 3, stability: 3, generality: 3, cost: 3 },
                template: String(p.template), vars: Array.isArray(p.vars) ? p.vars : []
              })
              lib.prompts = prompts; lib.updatedAt = new Date().toISOString()
              await writePrompts(lib)
              return send(200, { ok: true, id: id })
            }
            if (action === 'update') {
              const id = String(args.id || '')
              const patch = args.patch || {}
              const lib = await readPrompts()
              const p = (lib.prompts || []).find(function (x) { return x.id === id })
              if (!p) return send(404, { ok: false, error: '未找到: ' + id })
              const editable = ['title', 'category', 'tags', 'template', 'vars', 'source', 'quality']
              editable.forEach(function (k) { if (patch[k] !== undefined) p[k] = patch[k] })
              lib.updatedAt = new Date().toISOString()
              await writePrompts(lib)
              return send(200, { ok: true, id: id })
            }
            if (action === 'rate') {
              // 评分：{ id, score: {effect,clarity,stability,generality,cost} }
              const id = String(args.id || '')
              const lib = await readPrompts()
              const p = (lib.prompts || []).find(function (x) { return x.id === id })
              if (!p) return send(404, { ok: false, error: '未找到: ' + id })
              p.score = args.score || {}
              p.ratedAt = new Date().toISOString()
              lib.updatedAt = new Date().toISOString()
              await writePrompts(lib)
              const es = evaluateScore(p.score)
              return send(200, { ok: true, id: id, eval: es })
            }
            if (action === 'trial') {
              // 尝试记录：{ promptId, taskTitle, appliedAt?, feedback?, result? }
              const trials = await readTrials()
              const list = trials.trials || []
              const id = 'tr-' + String(Date.now()).slice(-6)
              list.unshift({
                id: id, promptId: String(args.promptId || ''), taskTitle: String(args.taskTitle || ''),
                appliedAt: new Date().toISOString(), feedback: args.feedback || null, result: args.result || 'pending'
              })
              trials.trials = list.slice(0, 100); trials.updatedAt = new Date().toISOString()
              await writeTrials(trials)
              return send(200, { ok: true, id: id })
            }
            if (action === 'stats') {
              const lib = await readPrompts()
              const trials = await readTrials()
              const prompts = lib.prompts || []
              const byCat = {}
              prompts.forEach(function (p) { byCat[p.category] = (byCat[p.category] || 0) + 1 })
              const scored = prompts.filter(function (p) { return p.score && p.score.effect })
              const avg = scored.length ? scored.reduce(function (a, p) { return a + evaluateScore(p.score).avg }, 0) / scored.length : 0
              return send(200, {
                ok: true,
                promptTotal: prompts.length,
                categories: byCat,
                avgScore: Math.round(avg * 10) / 10,
                trialTotal: (trials.trials || []).length,
                trials: (trials.trials || []).slice(0, 20)
              })
            }
            if (action === 'import-batch') {
              // B2-1 批量导入（对齐 knowledge-base import-batch 同构，只增不改）
              // body：{templates:[{id?,name?,category,systemPrompt,userPromptTemplate,inputVariables,vars?,tags?,source?,quality?,score?,template?}], defaultCategory?}
              // 幂等：按 id（无 id 按 title trim 生成稳定 id）去重；已存在 → skipped
              const templates = Array.isArray(args.templates) ? args.templates : []
              if (!templates.length) return send(400, { ok: false, error: '缺少 templates' })
              if (templates.length > 200) return send(400, { ok: false, error: 'templates 超过 200 条上限' })
              const lib = await readPrompts()
              const prompts = lib.prompts || []
              let imported = 0
              let skipped = 0
              const errors = []
              for (const t of templates) {
                try {
                  if (!t || (!t.id && !t.title && !t.name)) { errors.push({ title: (t && (t.title || t.name)) || '', error: '缺少 id/title' }); continue }
                  const rawTitle = String(t.title || t.name || '').trim()
                  const systemPrompt = String(t.systemPrompt || '')
                  const userPromptTemplate = String(t.userPromptTemplate || '')
                  // 稳定 id：显式 id 优先；无 id 由 title 生成（wc-seed-<slug>），幂等重跑可去重
                  let id = String(t.id || '')
                  if (!id) {
                    const slug = rawTitle.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
                    id = 'wc-seed-' + (slug || String(Date.now()).slice(-6))
                  }
                  // 幂等去重：按 id；无显式 id 时再按 title 查重
                  if (prompts.some(function (p) { return p.id === id })) { skipped++; continue }
                  if (!t.id && rawTitle && prompts.some(function (p) { return (p.title || '').trim() === rawTitle })) { skipped++; continue }
                  const category = String(t.category || args.defaultCategory || '写作')
                  const tags = Array.isArray(t.tags) ? t.tags : []
                  const vars = Array.isArray(t.inputVariables) ? t.inputVariables : (Array.isArray(t.vars) ? t.vars : [])
                  const template = String(t.template || (systemPrompt + '\n\n' + userPromptTemplate))
                  prompts.push({
                    id: id,
                    category: category,
                    tags: tags,
                    title: rawTitle || id,
                    source: String(t.source || 'ai-writing-coach'),
                    quality: Number(t.quality) || 4,
                    score: t.score || { effect: 4, clarity: 4, stability: 4, generality: 4, cost: 4 },
                    template: template,
                    vars: vars,
                    systemPrompt: systemPrompt,
                    userPromptTemplate: userPromptTemplate,
                    importedAt: new Date().toISOString()
                  })
                  imported++
                } catch (e) { errors.push({ title: (t && (t.title || t.name)) || '', error: String(e && e.message || e) }) }
              }
              if (imported) { lib.prompts = prompts; lib.updatedAt = new Date().toISOString(); await writePrompts(lib) }
              return send(200, { ok: true, imported: imported, skipped: skipped, errors: errors, total: prompts.length })
            }
      return send(404, { ok: false, error: '未知 action: ' + action, actions: ['ping', 'list', 'route', 'add', 'update', 'rate', 'trial', 'stats', 'import-batch'] })
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message || e) })
      }
    }
    // body 事件读取（兼容 webServer 前缀路由；GET 无 body 立即触发 end）
    req.on('data', function (chunk) { body += chunk })
    req.on('end', done)
    req.on('error', function () { try { res.end('') } catch (e) {} })
  }

  // ============ 注册（路由 kind 取宿主规范值 'prefix'；宿主对非 'exact' 一律送前缀表，行为等价） ============
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(function () { return webServer.register({ kind: 'prefix', path: '/prompt-router/api', handler: apiHandler }) })
    } catch (e) {
      try { ctx.get('logger') && ctx.get('logger').warn('[prompt-router] api register failed: ' + String(e && e.message || e)) } catch (_) {}
    }
  }

  // ============ 工具注册（唯一循环 + 统一无损 JSON 消毒；与 t49 writing-coach 同款惯例） ============
  const toolsSvc = ctx.get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    const toolDefs = [
      {
        name: 'prompt_route',
        description: '元提示词路由：按任务类型/目标匹配参考库优质模板，生成优化后的任务提示词。入参 title（任务标题）、requirement（任务要求/目标）。返回匹配模板与优化提示词。',
        parameters: {
          title: { type: 'string', description: '任务标题', required: true },
          requirement: { type: 'string', description: '任务要求/目标描述（可选）' }
        },
        execute: async function (args) {
          const lib = await readPrompts()
          return routePrompt(String(args && args.title || ''), String(args && args.requirement || ''), lib)
        }
      },
      {
        name: 'prompt_list',
        description: '列出提示词参考库全部条目（分类/标题/评分/模板），支持 category 过滤。',
        parameters: {
          category: { type: 'string', description: '分类过滤（可选：写作/插件开发/分析/邮件/审查/灵感/任务规划/总结/调试/文档，可传空串表示不过滤）' }
        },
        execute: async function (args) {
          const lib = await readPrompts()
          const items = (lib.prompts || []).filter(function (p) { return !args.category || p.category === args.category })
          return { ok: true, total: items.length, prompts: items }
        }
      }
    ]
    for (const def of toolDefs) {
      try {
        const d = toolsSvc.register(defineTool(Object.assign({}, def, {
          // 统一消毒：注册循环出口做一次 JSON 往返，防 undefined 触发 invalid output（O5/t49 惯例）
          execute: async function (args) { return toLossless(await def.execute(args)) },
          output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } }
        })))
        ctx.effect(function () { return function () { try { d && d() } catch (e) {} } })
      } catch (e) {
        // 注册失败可观测（T40 定论：非法参数 spec 会让 defineTool 抛错，空 catch 曾导致工具静默不可见）
        const _m = '[prompt-router] tool register failed (' + def.name + '): ' + String(e && e.stack || e && e.message || e)
        try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
      }
    }
  }

  // 启动时确保数据文件存在（首次运行自动创建种子库）
  (async function () {
    try {
      const lib = await readPrompts()
      if (!lib.prompts || !lib.prompts.length) {
        const seed = { version: 1, createdAt: new Date().toISOString(), prompts: SEED_PROMPTS.map(function (p) { return JSON.parse(JSON.stringify(p)) }) }
        await writePrompts(seed)
        const trials = { version: 1, createdAt: new Date().toISOString(), trials: [] }
        await writeTrials(trials)
      }
    } catch (e) {}
  })()
}

// cordis loader reads inject array from named exports
export { inject }
