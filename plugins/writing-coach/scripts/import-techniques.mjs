#!/usr/bin/env node
// 一次性导入脚本：739 条创作技法 CSV + 6 题材 35 md → knowledge-base「创作技法」分类
// 走新增 /knowledge-base/api/import-batch 端点（按 title 去重幂等，分块 200 条/次）
// 解析语义对齐 default-knowledge.ts：引号转义、关键词 | 拆分、正反例 , 拆分（本脚本以通用 CSV 解析为准）
// 用法：node scripts/import-techniques.mjs [--dry-run]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const API = 'http://127.0.0.1:3080/knowledge-base/api/import-batch'
const CSV_DIR = 'C:/Users/<user>/CodeBuddy/ai-writing-coach/default-knowledge/csv'
const GENRES_DIR = 'C:/Users/<user>/CodeBuddy/ai-writing-coach/default-knowledge/genres'
const DEFAULT_CATEGORY = '创作技法'
const DRY_RUN = process.argv.indexOf('--dry-run') >= 0

// 各文件标题列（无名称列 → 关键词第 1 段）
const NAME_COLS = {
  '人设与关系.csv': '人设类型',
  '写作技法.csv': '技法名称',
  '命名规则.csv': '命名对象',
  '场景写法.csv': '模式名称',
  '桥段套路.csv': '桥段名称',
  '爽点与节奏.csv': null,
  '裁决规则.csv': '题材',
  '金手指与设定.csv': '设定类型',
  '题材与调性推理.csv': '题材/流派'
}
const GENRE_NAMES = {
  'dog-blood-romance': '狗血言情',
  'period-drama': '古装年代',
  'realistic': '现实题材',
  'rules-mystery': '规则流悬疑',
  'xuanhuan': '玄幻',
  'zhihu-short': '知乎体短篇'
}

// ==================== CSV 解析（引号转义/字段内逗号换行） ====================
function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { row.push(field); field = '' }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = [] }
      else if (ch !== '\r') field += ch
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  while (rows.length && rows[rows.length - 1].every(function (c) { return !String(c).trim() })) rows.pop()
  return rows
}

function splitAny(v, seps) {
  return String(v || '').split(new RegExp('[' + seps + ']')).map(function (s) { return s.trim() }).filter(Boolean)
}
function firstKeyword(v) {
  const parts = splitAny(v, '|，,')
  return parts.length ? parts[0] : ''
}

// ==================== 条目构建 ====================
function buildCsvEntries() {
  const entries = []
  const usedTitles = {}
  const files = readdirSync(CSV_DIR).filter(function (f) { return f.endsWith('.csv') })
  for (const file of files) {
    const text = readFileSync(join(CSV_DIR, file), 'utf8')
    const rows = parseCSV(text)
    if (!rows.length) continue
    const header = rows[0].map(function (h) { return String(h).trim() })
    const nameCol = NAME_COLS[file] || null
    const nameIdx = nameCol ? header.indexOf(nameCol) : -1
    const idx = function (col) { return header.indexOf(col) }
    const gi = idx('编号'), si = idx('适用技能'), ci = idx('分类'), li = idx('层级'), ki = idx('关键词'),
      yi = idx('意图与同义词'), ti = idx('适用题材'), mi = idx('大模型指令'), xi = idx('核心摘要'), di = idx('详细展开'), di2 = idx('毒点')
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      const get = function (i) { return i >= 0 && i < row.length ? String(row[i] || '').trim() : '' }
      const no = get(gi), skill = get(si), cat = get(ci), lvl = get(li), kw = get(ki), intent = get(yi),
        theme = get(ti), inst = get(mi), summary = get(xi), detail = get(di), poison = get(di2)
      if (!no && !summary && !detail && !kw) continue // 空行
      // title：名称列优先 → 关键词第1段 → 编号
      let title = nameIdx >= 0 && nameIdx < row.length ? String(row[nameIdx] || '').trim() : ''
      if (!title) title = firstKeyword(kw)
      if (!title) title = no
      if (!title) continue
      // 批内去重（保证 739 唯一 title）
      if (usedTitles[title]) { title = title + '（' + no + '）' }
      usedTitles[title] = true
      // tags：关键词全段 + 适用题材（过滤「全部」/空）+ 分类
      const tags = splitAny(kw, '|，,')
        .concat(splitAny(theme, '|，,').filter(function (s) { return s !== '全部' }))
        .concat(cat ? [cat] : [])
      const aliases = splitAny(intent, '|，,，')
      // extra：全部原始列（四用字段全保留：大模型指令/毒点/正反例/文件特有列）
      const extra = {}
      header.forEach(function (h, i) {
        if (h && i < row.length && String(row[i] || '').trim()) extra[h] = String(row[i]).trim()
      })
      entries.push({
        title: title,
        description: summary.slice(0, 120) || (kw ? kw.slice(0, 120) : ''),
        content: (summary ? summary + '\n\n' : '') + detail,
        tags: Array.from(new Set(tags)).slice(0, 30),
        aliases: Array.from(new Set(aliases)).slice(0, 30),
        extra: extra
      })
    }
  }
  return entries
}

function buildMdEntries() {
  const entries = []
  const genres = readdirSync(GENRES_DIR).filter(function (d) {
    try { return statSync(join(GENRES_DIR, d)).isDirectory() } catch (e) { return false }
  })
  for (const genre of genres) {
    const cn = GENRE_NAMES[genre] || genre
    const files = readdirSync(join(GENRES_DIR, genre)).filter(function (f) { return f.endsWith('.md') })
    for (const file of files) {
      const absPath = 'C:/Users/<user>/CodeBuddy/ai-writing-coach/default-knowledge/genres/' + genre + '/' + file
      const text = readFileSync(absPath, 'utf8')
      const lines = text.split('\n')
      let h1 = ''
      for (const line of lines) {
        const m = /^#\s+(.+)/.exec(line)
        if (m) { h1 = m[1].trim(); break }
      }
      const slug = file.replace(/\.md$/, '').replace(/-/g, ' ')
      const chapterName = h1 || slug
      const title = '【题材指南】' + cn + '·' + chapterName
      entries.push({
        title: title,
        description: chapterName.slice(0, 120),
        content: text,
        tags: [cn, '题材指南'],
        aliases: [genre, file.replace(/\.md$/, '')],
        sourcePath: absPath
      })
    }
  }
  return entries
}

// ==================== 提交（分块 200，幂等验证重跑） ====================
async function postBatch(entries) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: entries, defaultCategory: DEFAULT_CATEGORY })
  })
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text())
  return res.json()
}

async function run() {
  const csvEntries = buildCsvEntries()
  const mdEntries = buildMdEntries()
  const all = csvEntries.concat(mdEntries)
  console.log('CSV 条目: ' + csvEntries.length + '（文件' + Object.keys(NAME_COLS).length + '）')
  console.log('MD 条目: ' + mdEntries.length + '（题材' + new Set(mdEntries.map(function (e) { return (e.tags[0] || '') })).size + '）')
  console.log('合计: ' + all.length)
  const titleSet = new Set(all.map(function (e) { return e.title }))
  console.log('title 唯一性: ' + titleSet.size + ' / ' + all.length)
  if (DRY_RUN) { console.log('DRY-RUN：未提交'); return }
  // 分块 200
  let imported = 0, skipped = 0, errors = []
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200)
    const r = await postBatch(chunk)
    imported += r.imported || 0
    skipped += r.skipped || 0
    errors = errors.concat(r.errors || [])
    console.log('chunk ' + (i / 200 + 1) + ': imported=' + r.imported + ' skipped=' + r.skipped + ' errors=' + (r.errors || []).length)
  }
  console.log('=== 首轮: imported=' + imported + ' skipped=' + skipped + ' errors=' + errors.length + (errors.length ? JSON.stringify(errors.slice(0, 5)) : '') + ' ===')
  // 幂等验证：重跑全量 → 应全 skipped
  let imp2 = 0, skip2 = 0
  for (let i = 0; i < all.length; i += 200) {
    const r = await postBatch(all.slice(i, i + 200))
    imp2 += r.imported || 0
    skip2 += r.skipped || 0
  }
  console.log('=== 幂等重跑: imported=' + imp2 + ' skipped=' + skip2 + '（期望 0/' + all.length + '） ===')
}

run().catch(function (e) { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1) })
