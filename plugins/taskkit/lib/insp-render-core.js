// U-49（2026-09-30）：`insp_list` / `insp_search` 的**模型可见渲染**与**标签前缀过滤**
// （从 index.js 抽出的纯函数 ⇒ 可真单测、无宿主依赖）
//
// 为什么必须有这层：
//   工具结果里 `output.render()` 产出的才是**模型可见文本**；`presentationMeta` 是**客户端 UI 的投影**，
//   不进模型上下文（框架侧 dsh-tools 只对 meta 做"投影 + 快照"，消费方是 dsh-client-ui-tool）。
//   而这两个工具原来 `render` 只返回 `summary`（一行计数），`entries` 全走 meta ⇒
//   **agent 看不到任何 id / 标题 / 标签 / 正文**：灵感工坊因此无法执行 persona 卡里
//   「入库后必须回读一次并报出 id」这条硬要求，A3 加的 `includeContent` 开关对 agent 也完全无效（只影响 UI）。
//   实证（2026-09-29 工坊会话 session-9ee72482 原文）：模型收到的正文只有
//     「检索到 31 条（本次返回前 20 条，可调 limit 或收窄条件）（库内 31 条）」
//   —— 31 条明细一条都没有。
//
// token 安全：逐条截断 + 正文块单独上限；`includeContent` 沿用 A3 语义（默认不带正文）。
import { worldviewKeys } from './insp-retire-core.js'

export const INSP_RENDER_META_CAP = 120    // 单行类字段（一句话 / 钩子 / 来源）的字符上限
export const INSP_RENDER_CONTENT_CAP = 600 // 正文块的字符上限

/** 单行字段：换行压平后按字符截断（截断时标注原长度）。 */
export function clipFlat(s, n) {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim()
  const cap = (typeof n === 'number' && n > 0) ? n : INSP_RENDER_META_CAP
  return t.length > cap ? (t.slice(0, cap) + '…（已截断，原 ' + t.length + ' 字）') : t
}

/** 块字段（正文）：保留换行，仅按字符截断。 */
export function clipBlock(s, n) {
  const t = String(s === undefined || s === null ? '' : s).trim()
  const cap = (typeof n === 'number' && n > 0) ? n : INSP_RENDER_CONTENT_CAP
  return t.length > cap ? (t.slice(0, cap) + '\n…（已截断，原 ' + t.length + ' 字）') : t
}

/**
 * 标签**前缀**过滤：`世界观:` ⇒ 全部带世界观键的条目；`世界观:原创/` ⇒ 该大类。
 * 为什么需要：`tags` 是**整值精确匹配** ⇒ `世界观:原创` 查不出 `世界观:原创/<项目>`
 *   （实测：`{tags:"世界观:原创"}` = 0 条、`{tags:"世界观:同人"}` = 0 条），
 *   而 `limit` 上限 50 ⇒ 条目数超过上限时无法枚举键。前缀过滤是"枚举键/按大类收窄"的出口。
 */
export function filterTagsPrefix(list, prefix) {
  const src = Array.isArray(list) ? list : []
  const p = String(prefix === undefined || prefix === null ? '' : prefix).trim()
  if (!p) return src.slice()
  return src.filter(function (e) {
    const ts = (e && Array.isArray(e.tags)) ? e.tags : []
    for (let i = 0; i < ts.length; i++) if (String(ts[i]).indexOf(p) === 0) return true
    return false
  })
}

/**
 * 把 `inspListPage()` 的返回值渲染成**模型可见文本**。
 * 渲染面：id / 标题 / 状态 / 编号 / 类别 / 固定 / 世界观键（单列，可直接复制做 tags 过滤）/ 其他标签 /
 *         一句话 / 钩子 / 设定引用 / 来源；`args.includeContent === 'true'` 时再带正文块。
 */
export function renderInspListText(args, value) {
  if (!value || typeof value !== 'object') return String(value === undefined || value === null ? '' : JSON.stringify(value))
  const head = String(value.summary || '')
  if (value.ok === false) return head || JSON.stringify(value)
  const ents = Array.isArray(value.entries) ? value.entries : []
  if (!ents.length) return head
  const withContent = String((args && args.includeContent) || '') === 'true'
  const out = [head]
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i] || {}
    const tags = Array.isArray(e.tags) ? e.tags.map(String) : []
    const keys = worldviewKeys(tags).map(function (k) { return '世界观:' + k })
    const rest = tags.filter(function (t) { return keys.indexOf(t) < 0 })
    const bits = ['状态=' + (e.status || '未标')]
    if (e.number) bits.push('编号 ' + e.number)
    if (e.category) bits.push('类=' + e.category)
    if (e.fixed) bits.push('★已固定')
    if (e.retired) bits.push('已退役')
    out.push('- ' + (e.id || '(无 id)') + ' ｜ ' + (e.title || '(无标题)') + ' ｜ ' + bits.join(' · '))
    if (keys.length) out.push('    世界观键：' + keys.join('、'))
    if (rest.length) out.push('    其他标签：' + rest.join('、'))
    if (e.oneLiner) out.push('    一句话：' + clipFlat(e.oneLiner, INSP_RENDER_META_CAP))
    if (e.hook) out.push('    钩子：' + clipFlat(e.hook, INSP_RENDER_META_CAP))
    if (e.settingsRef) out.push('    设定引用：' + e.settingsRef)
    if (e.source) out.push('    来源：' + clipFlat(e.source, INSP_RENDER_META_CAP))
    if (withContent) {
      const c = String(e.content === undefined || e.content === null ? '' : e.content).trim()
      out.push('    正文：' + (c ? clipBlock(c, INSP_RENDER_CONTENT_CAP) : '(空)'))
    }
  }
  if (value.truncated) out.push('（本次只渲染 ' + ents.length + ' 条，命中 ' + value.count + ' 条 ⇒ 调 limit、收窄条件，或用 tagsPrefix 取剩余）')
  return out.join('\n')
}
