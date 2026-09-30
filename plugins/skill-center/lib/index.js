// Host：独立Skill中心 + AgentSkill加载路由 @local/skill-center
// 功能：技能库管理(CRUD/导入导出) + 按任务类型自动路由加载适用 skill + 联动任务中心/多Agent
// 端点：/skill-center/api/ping | list | get | route | add | update | toggle | remove | export | import | stats
import { defineTool } from '@deepseek-ai/dsh-tools'

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer'
]

// 数据根口径（O5 迁移）：根名由 adapter 部署 config 登记（`dsh-bundle-patch.yml` 的 `roots.全局数据`），
// 插件只持"根内相对引用"，不再硬编码盘符路径、不再做根路径字符串拼接。
const SKILLS_ROOT = '全局数据'
const SKILLS_REL = 'skills/skills.json'

export function apply(ctx) {
  // fs 面统一经 adapterFs（一期标准接口）：相对引用由 adapterFs 解析到登记根，默认直读盘（无 TTL 缓存窗口），写后自动失效。
  const adapterFs = ctx.get('adapterFs')
  if (!adapterFs) {
    const _m = '[skill-center] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写 skills.json（请确认 profile bundles 中 @local/dsh-adapter 已加载）'
    try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
  }

  // ============ 数据读写（经 adapterFs：根名 + 根内相对引用） ============
  // 读：默认直读盘（对齐 R1 铁律"全部 cache:false"），fallback 仅在文件缺失/非文本/坏 JSON 时生效；
  // 写：adapterFs 写后自动失效同键缓存，故不再需要手写 invalidate。
  async function readSkills() {
    return adapterFs.readJson(SKILLS_ROOT, SKILLS_REL, { fallback: { version: 1, skills: [] } })
  }
  async function writeSkills(lib) {
    try { await adapterFs.writeJson(SKILLS_ROOT, SKILLS_REL, lib); return true } catch (e) { return false }
  }

  // ============ 内置种子技能库（5 条） ============
  const SEED_SKILLS = [
    { id: 's-writing', name: '写作创作', category: '写作', tags: ['写作', '小说', '创作'], description: '结构化创作指南：角色/情节/语言/自检', scenarios: ['写小说', '写故事', '创作文案', '扩写'], active: true, version: '1.0.0', usage: '适用于创作类任务，提供完整创作框架与质量自检', input: '主题/体裁/字数要求', output: '完成的作品文本', parameters: { role: '作者角色', topic: '主题', genre: '体裁', words: '字数' } },
    { id: 's-plugin', name: '插件开发规范', category: '插件开发', tags: ['插件', '开发', 'cordis'], description: 'DSH 静态插件开发全流程规范', scenarios: ['开发插件', '修改插件', '插件调试'], active: true, version: '1.0.0', usage: '适用于插件开发/修改任务，确保符合规范且可验证', input: '插件需求', output: '符合规范的插件代码', parameters: { task: '任务', constraints: '约束' } },
    { id: 's-email', name: '邮件撰写', category: '邮件', tags: ['邮件', '回复', '商务'], description: '商务邮件结构模板', scenarios: ['写邮件', '回复邮件', '商务沟通'], active: true, version: '1.0.0', usage: '适用于邮件撰写任务，结构清晰语气得体', input: '收件人/主题/要点', output: '完整邮件文本', parameters: { type: '类型', recipient: '收件人', subject: '主题', style: '语气' } },
    { id: 's-analysis', name: '深度分析', category: '分析', tags: ['分析', '研究', '评估'], description: '结构化深度分析方法论', scenarios: ['分析趋势', '研究主题', '评估方案'], active: true, version: '1.0.0', usage: '适用于分析/研究/评估任务，输出结构化结论', input: '分析对象', output: '结构化分析报告', parameters: { subject: '对象' } },
    { id: 's-review', name: '审查验收', category: '审查', tags: ['审查', '检查', '验收'], description: '逐项核验的审查验收流程', scenarios: ['代码审查', '方案检查', '成果验收'], active: true, version: '1.0.0', usage: '适用于审查/检查/验收任务，逐项标注通过与否', input: '审查对象/检查项', output: '审查结论', parameters: { artifact: '对象', type: '类型', items: '检查项' } }
  ]

  // ============ 核心逻辑 ============
  // 路由：按任务标题/要求关键词匹配适用 skill（与 prompt-router routePrompt 同构）
  function routeSkill(title, requirement, allSkills) {
    const text = String(title || '') + ' ' + String(requirement || '')
    const t = text.toLowerCase()
    const rules = [
      { re: /写作|撰写|小说|故事|文案|文章|创作|扩写|篇|短篇/, id: 's-writing' },
      { re: /插件|开发|实现|cordis|client|host|调试/, id: 's-plugin' },
      { re: /邮件|回复|通知|发送/, id: 's-email' },
      { re: /分析|研究|评估|调研|对比/, id: 's-analysis' },
      { re: /检查|测试|验收|审查|review/, id: 's-review' }
    ]
    let matched = null
    for (let i = 0; i < rules.length; i++) {
      if (rules[i].re.test(t)) { matched = allSkills.find(function (s) { return s.id === rules[i].id && s.active !== false }); if (matched) break }
    }
    return matched || null
  }

  // ============ Web API ============
  const apiHandler = function (req, res) {
    const u = new URL(req.url || '/', 'http://x')
    const parts = u.pathname.split('/').filter(Boolean) // [skill-center, api, action, ...]
    const send = function (status, obj) {
      try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) } catch (e) {}
    }
    if (parts[0] !== 'skill-center' || parts[1] !== 'api') return send(404, { ok: false, error: 'not found' })
    const action = parts[2] || ''
    let body = ''
    const done = async function () {
      let args = {}
      if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
      try {
        if (action === 'ping') return send(200, { ok: true, plugin: 'skill-center', ts: Date.now() })
        if (action === 'list') {
          const lib = await readSkills()
          const skills = lib.skills || []
          const cats = {}
          skills.forEach(function (s) { cats[s.category] = (cats[s.category] || 0) + 1 })
          return send(200, { ok: true, total: skills.length, categories: cats, skills: skills })
        }
        if (action === 'get') {
          const lib = await readSkills()
          const s = (lib.skills || []).find(function (x) { return x.id === String(args.id || '') })
          if (!s) return send(404, { ok: false, error: '未找到: ' + args.id })
          return send(200, { ok: true, skill: s })
        }
        if (action === 'route') {
          const lib = await readSkills()
          const title = String(args.title || '')
          const requirement = String(args.requirement || '')
          const explicit = String(args.skillId || '')
          let matched = null
          if (explicit) matched = (lib.skills || []).find(function (s) { return s.id === explicit })
          if (!matched) matched = routeSkill(title, requirement, lib.skills || [])
          return send(200, { ok: true, matched: matched ? { id: matched.id, name: matched.name, category: matched.category, description: matched.description, usage: matched.usage, parameters: matched.parameters } : null, total: (lib.skills || []).length })
        }
        if (action === 'add') {
          const a = args.skill || args
          if (!a || !a.name) return send(400, { ok: false, error: '缺少 name' })
          const lib = await readSkills()
          const skills = lib.skills || []
          const id = 's-' + String(Date.now()).slice(-6)
          skills.unshift({
            id: id, name: String(a.name), category: String(a.category || '通用'),
            tags: Array.isArray(a.tags) ? a.tags : String(a.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean),
            description: String(a.description || ''), scenarios: Array.isArray(a.scenarios) ? a.scenarios : [],
            active: a.active !== false, version: String(a.version || '1.0.0'), usage: String(a.usage || ''),
            input: String(a.input || ''), output: String(a.output || ''), parameters: a.parameters || {},
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
          })
          lib.skills = skills; lib.updatedAt = new Date().toISOString()
          await writeSkills(lib)
          return send(200, { ok: true, id: id })
        }
        if (action === 'update') {
          const id = String(args.id || '')
          const patch = args.patch || {}
          const lib = await readSkills()
          const s = (lib.skills || []).find(function (x) { return x.id === id })
          if (!s) return send(404, { ok: false, error: '未找到: ' + id })
          const editable = ['name', 'category', 'tags', 'description', 'scenarios', 'version', 'usage', 'input', 'output', 'parameters']
          editable.forEach(function (k) { if (patch[k] !== undefined) s[k] = patch[k] })
          s.updatedAt = new Date().toISOString()
          lib.updatedAt = new Date().toISOString()
          await writeSkills(lib)
          return send(200, { ok: true, id: id })
        }
        if (action === 'toggle') {
          const id = String(args.id || '')
          const lib = await readSkills()
          const s = (lib.skills || []).find(function (x) { return x.id === id })
          if (!s) return send(404, { ok: false, error: '未找到: ' + id })
          s.active = !s.active
          s.updatedAt = new Date().toISOString()
          lib.updatedAt = new Date().toISOString()
          await writeSkills(lib)
          return send(200, { ok: true, id: id, active: s.active })
        }
        if (action === 'remove') {
          const id = String(args.id || '')
          const lib = await readSkills()
          const before = (lib.skills || []).length
          lib.skills = (lib.skills || []).filter(function (x) { return x.id !== id })
          if (lib.skills.length === before) return send(404, { ok: false, error: '未找到: ' + id })
          lib.updatedAt = new Date().toISOString()
          await writeSkills(lib)
          return send(200, { ok: true, id: id })
        }
        if (action === 'export') {
          const lib = await readSkills()
          return send(200, { ok: true, export: { version: 1, exportedAt: new Date().toISOString(), skills: lib.skills || [] } })
        }
        if (action === 'import') {
          const data = args.export || args
          if (!data || !Array.isArray(data.skills)) return send(400, { ok: false, error: '缺少 skills 数组' })
          const lib = await readSkills()
          const existing = new Set((lib.skills || []).map(function (s) { return s.id }))
          let added = 0
          data.skills.forEach(function (s) {
            if (!s || !s.id || existing.has(s.id)) return
            existing.add(s.id); lib.skills.unshift(s); added++
          })
          lib.updatedAt = new Date().toISOString()
          await writeSkills(lib)
          return send(200, { ok: true, added: added })
        }
        if (action === 'stats') {
          const lib = await readSkills()
          const skills = lib.skills || []
          const byCat = {}
          skills.forEach(function (s) { byCat[s.category] = (byCat[s.category] || 0) + 1 })
          const active = skills.filter(function (s) { return s.active !== false }).length
          return send(200, { ok: true, skillTotal: skills.length, active: active, categories: byCat })
        }
        return send(404, { ok: false, error: '未知 action: ' + action, actions: ['ping', 'list', 'get', 'route', 'add', 'update', 'toggle', 'remove', 'export', 'import', 'stats'] })
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message || e) })
      }
    }
    req.on('data', function (chunk) { body += chunk })
    req.on('end', done)
    req.on('error', function () { try { res.end('') } catch (e) {} })
  }

  // ============ 注册 ============
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(function () { return webServer.register({ kind: 'prefixes', path: '/skill-center/api', handler: apiHandler }) })
    } catch (e) {
      try { ctx.get('logger') && ctx.get('logger').warn('[skill-center] api register failed: ' + String(e && e.message || e)) } catch (_) {}
    }
  }

  // ============ 工具注册（与 writing-studio 同构） ============
  const toolsSvc = ctx.get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    try {
      const d1 = toolsSvc.register(defineTool({
        name: 'skill_route',
        description: 'AgentSkill 加载路由：按任务类型/上下文匹配适用技能（skill）。入参 title（任务标题）、requirement（任务要求，可选）、skillId（手动指定技能 id，可选）。返回匹配技能定义。',
        // 参数 spec 遵循宿主 dsh-tools 的作者级规则（T40 定论）：
        //  · 可选参数**直接省略**属性上的必填标记；必填参数写明确的必填布尔（唯一合法取值 = 真）。
        //    任何"必填=假"的写法都会被检查器拒绝：dsh-tools/lib/index.js L602
        //    `required must be true when present` → JsonSchemaError（抛点 defineTool L846）。
        //  · 宿主 parameterSchemaSpecToJsonSchema（L801-810）把本属性映射编译为
        //    { type:'object', properties:{…}, required:[…] }——对象级 required 数组即编译产物。
        //  · 注意：该 API 不支持在 parameters 处直接写对象级 required 数组——那是编译结果而非输入
        //    （直接写会被当作名为 type/properties/required 的属性而报错）。
        parameters: {
          title: { type: 'string', description: '任务标题', required: true },
          requirement: { type: 'string', description: '任务要求/目标描述（可选）' },
          skillId: { type: 'string', description: '手动指定技能 id（可选，传空串自动匹配）' }
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) {
          const lib = await readSkills()
          const title = String(args && args.title || '')
          const requirement = String(args && args.requirement || '')
          const explicit = String(args && args.skillId || '')
          let matched = null
          if (explicit) matched = (lib.skills || []).find(function (s) { return s.id === explicit })
          if (!matched) matched = routeSkill(title, requirement, lib.skills || [])
          return { ok: true, matched: matched ? { id: matched.id, name: matched.name, category: matched.category, description: matched.description, usage: matched.usage, parameters: matched.parameters, input: matched.input, output: matched.output } : null, total: (lib.skills || []).length }
        }
      }))
      ctx.effect(function () { return function () { try { d1 && d1() } catch (e) {} } })
    } catch (e) {
      // 注册失败必须可观测（T40 定论：非法参数 spec 会让 defineTool 抛 JsonSchemaError；空 catch 曾使工具长期静默不可见）
      const _m = '[skill-center] skill_route register failed: ' + String(e && e.stack || e && e.message || e)
      try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
    }
    try {
      const d2 = toolsSvc.register(defineTool({
        name: 'skill_list',
        description: '列出技能中心全部技能（分类/名称/描述/激活状态），支持 category 过滤。',
        parameters: {
          category: { type: 'string', description: '分类过滤（可传空串表示不过滤）' }
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) {
          const lib = await readSkills()
          const skills = (lib.skills || []).filter(function (s) { return !args.category || s.category === args.category })
          return { ok: true, total: skills.length, skills: skills.map(function (s) { return { id: s.id, name: s.name, category: s.category, description: s.description, active: s.active !== false, version: s.version } }) }
        }
      }))
      ctx.effect(function () { return function () { try { d2 && d2() } catch (e) {} } })
    } catch (e) {
      // 同 skill_route：失败必须留痕，避免再次静默不可见
      const _m = '[skill-center] skill_list register failed: ' + String(e && e.stack || e && e.message || e)
      try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
    }
  }

  // 启动时确保数据文件存在（首次运行自动创建种子技能库）
  (async function () {
    try {
      const lib = await readSkills()
      if (!lib.skills || !lib.skills.length) {
        const seed = { version: 1, createdAt: new Date().toISOString(), skills: SEED_SKILLS.map(function (s) { return JSON.parse(JSON.stringify(s)) }) }
        await writeSkills(seed)
      }
    } catch (e) {}
  })()
}

// cordis loader reads inject array from named exports
export { inject }
