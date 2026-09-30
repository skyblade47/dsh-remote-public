// Host：写作工作台静态化 @local/wrpro（v2：保存→工作区权威存档，暂存→浏览器本地）
// v2 修订（task-616957-83）：host 半新增 fs 保存能力 + /wrpro/api/save 路由
// 数据：写作训练/草稿/<日期>_<时间>.md + 写作训练/写作记录.json（统计）
// 参照 taskkit lib/index.js 已验证模式（export function apply + export inject）
import { defineTool } from '@deepseek-ai/dsh-tools'

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'webServer'
]

// 数据根口径（O5 迁移）：根名由 adapter 部署 config 登记（`dsh-bundle-patch.yml` 的 `roots.写作训练`），
// 插件只持"根内相对引用"，不再硬编码盘符路径、也不再传隐式解析锚（原解析选项传的是 sandboxPolicy.workspaceRoot，
// 只对相对引用生效；本插件原入参全为绝对路径，故该锚当时是惰性的）。
const WRPRO_ROOT = '写作训练'
const RECORD_REL = '写作记录.json'
const DRAFT_DIR_REL = '草稿'

export function apply(ctx) {
  // fs 面统一经 adapterFs（一期标准接口）：相对引用解析到登记根，默认直读盘、写后自动失效。
  const adapterFs = ctx.get('adapterFs')
  if (!adapterFs) {
    const _m = '[wrpro] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写 写作记录.json/草稿（请确认 profile bundles 中 @local/dsh-adapter 已加载）'
    try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
  }
  // 数据根展示值（对外契约字段 `dataRoot`）：由登记根解析，保持与 legacy 同形（前斜杠绝对路径）
  async function dataRootDisplay() {
    try { const r = await adapterFs.resolve(WRPRO_ROOT, ''); return String(r.displayPath).replace(/\\/g, '/') } catch (e) { return null }
  }

  // 读取写作记录.json（统计）
  async function readRecord() {
    if (!adapterFs) return { version: 1, days: {}, totalWords: 0, streak: 0 }
    // fallback:null 保留 legacy“文件缺失/坏 JSON → 默认记录”语义；非 fallback 类错误（权限/IO）改为显式抛出（已登记）
    const parsed = await adapterFs.readJson(WRPRO_ROOT, RECORD_REL, { fallback: null })
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, days: {}, totalWords: 0, streak: 0 }
  }

  async function writeRecord(rec) {
    try { await adapterFs.writeJson(WRPRO_ROOT, RECORD_REL, rec); return true } catch (e) { return false }
  }

  // 保存草稿：写作训练/草稿/<日期>_<时间>.md + 更新写作记录.json
  async function saveDraft(content, title) {
    const now = new Date()
    const p2 = function (n) { return String(n).padStart(2, '0') }
    const dateStr = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate())
    const timeStr = p2(now.getHours()) + '-' + p2(now.getMinutes()) + '-' + p2(now.getSeconds())
    const stamp = dateStr + '_' + timeStr
    const naming = draftNaming(title, stamp)
    const filename = naming.filename
    const fileContent = naming.titleLine + '\n\n> 保存时间：' + now.toISOString() + '\n\n' + (content || '')
    await adapterFs.writeText(WRPRO_ROOT, DRAFT_DIR_REL + '/' + filename, fileContent)
    // 更新统计
    const rec = await readRecord()
    const key = dateStr
    const day = rec.days[key] || { words: 0, entries: 0 }
    const words = (content || '').replace(/\s+/g, '').length
    day.words += words
    day.entries += 1
    rec.days[key] = day
    rec.totalWords = (rec.totalWords || 0) + words
    // streak：连续写作天数（简化：当日+1）
    rec.streak = (rec.streak || 0) + 1
    rec.lastSavedAt = now.toISOString()
    rec.lastFile = filename
    await writeRecord(rec)
    return { filename: filename, words: words, date: dateStr, totalWords: rec.totalWords, streak: rec.streak }
  }

  // 自检工具
  ctx.tools.register(defineTool({
    name: 'wrpro_ping',
    description: '写作工作台自检：返回插件已加载 + fs/API 可用性（保存=工作区，暂存=浏览器本地）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] },
      presentationMeta: function (args, value) { return value || {} }
    },
    execute: async function () {
      return { ok: true, loaded: true, hasFs: !!adapterFs, dataRoot: await dataRootDisplay(), summary: 'wrpro v2 已加载（保存=工作区草稿+写作记录，暂存=浏览器本地）' }
    }
  }))

  // /wrpro/api/save 路由（client 保存按钮调用）
  try {
    const ws = ctx.get('webServer')
    if (ws && typeof ws.register === 'function') {
      const saveHandler = async function (req, res) {
        const send = function (status, obj) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(obj))
        }
        let body = ''
        try { for await (const chunk of req) body += chunk } catch (e) {}
        let args = {}
        if (body) { try { args = JSON.parse(body) } catch (e) { args = {} } }
        try {
          if (!args.content && args.content !== '') return send(400, { ok: false, error: '缺少 content' })
          const result = await saveDraft(String(args.content || ''), String(args.title || ''))
          send(200, { ok: true, saved: result, summary: '已保存到工作区：' + result.filename })
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message || e) })
        }
      }
      ctx.effect(function () { return ws.register({ kind: 'exact', path: '/wrpro/api/save', handler: saveHandler }) })
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
