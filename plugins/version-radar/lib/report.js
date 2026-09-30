// @local/version-radar —— report.js：升级建议 md（**只在 report=1 时**写）
//
// 纪律落地：
//   · 默认**不写盘**：唯一写入口 maybeWriteReport() 在 enabled !== true 时直接返回「未写」。
//   · 路径冻结（spec §5.2 / §8-6）：<DSH_WORKSPACE_ROOT>/DSH工具/升级建议_<ts>.md
//   · 只写**一份 md**：不改任何系统配置、不翻软链、不重启（spec §6-8「只建议不执行」）。

import fsDefault from 'node:fs'
import { join, dirname } from 'node:path'

const SUBDIR = 'DSH工具'
const FILE_PREFIX = '升级建议_'

/** <DSH_WORKSPACE_ROOT>（环境变量口径与 session-janitor/lib/survey.js 的 defaultWorkspaceRoot 一致） */
export function defaultWorkspaceRoot(env) {
  const e = env || process.env || {}
  return String(e.DSH_WORKSPACE_ROOT || e.DSH_WORKSPACE || e.DSH_WS_ROOT || '').trim() || '/srv/dsh-workspace'
}

/** 文件名安全的时间戳（ISO 的 ':' 换 '-'，保留 Z 表 UTC） */
export function reportStamp(iso) {
  return String(iso || new Date().toISOString()).replace(/:/g, '-')
}

export function reportFileName(iso) {
  return FILE_PREFIX + reportStamp(iso) + '.md'
}

/** 报告内容 = spec §4.2 的「待办清单骨架」 */
export function buildReportMarkdown(result, opts) {
  const o = opts || {}
  const r = result || {}
  const ts = String(o.ts || '')
  const host = r.host || {}
  const up = r.upstream || {}
  const tps = Array.isArray(r.thirdParty) ? r.thirdParty : []
  const todo = Array.isArray(r.ledgerTodo) ? r.ledgerTodo : []
  const reasons = Array.isArray(r.reasons) ? r.reasons : []
  const rb = r.rollback || {}
  const lines = []
  lines.push('# 升级建议（version-radar）')
  lines.push('')
  lines.push('- 生成时间：' + ts)
  lines.push('- 结论：**' + String(r.verdict || 'unknown') + '**')
  lines.push('- 目标版本：' + String(r.target || '(未知)') + '（省略 targetVersion 时 = dist-tags.latest）')
  lines.push('- 本插件**只建议、不执行**：切换 / 重启 / 安装永远由人工触发的 kernel-release.sh 完成。')
  lines.push('')
  lines.push('## 一、事实')
  lines.push('')
  lines.push('| # | 事实 | 值 |')
  lines.push('|---|---|---|')
  lines.push('| 1 | 当前内核版本 | ' + String(host.version || 'unknown') + '（来源 ' + String(host.source || 'none') + '） |')
  lines.push('| 2 | 上游 dist-tags | latest=' + String(up.latest || '-')
    + ' / next=' + String(up.next || '-')
    + ' / alpha=' + String(up.alpha || '-')
    + (up.ok === true ? '' : '（取不到：' + String(up.error || '?') + '）') + ' |')
  lines.push('| 3 | 第三方 peer 判定 | ' + (tps.length
    ? tps.map((t) => String(t.name) + '=' + (t.supported === true ? '支持' : (t.supported === false ? '不支持' : '无法判定'))).join('；')
    : '(未读到 profile 依赖)') + ' |')
  lines.push('| 4 | 本地改动待办 | ' + String(todo.length) + ' 条（见第三节） |')
  lines.push('| 5 | 回滚目标 | ' + String(rb.target || '-')
    + '（exists=' + String(rb.exists === true)
    + '，manifestOk=' + String(rb.manifestOk === true) + '） |')
  lines.push('')
  lines.push('## 二、判定理由')
  lines.push('')
  for (const s of reasons) lines.push('- ' + String(s))
  lines.push('')
  lines.push('## 三、待办清单（升级前逐条人工核）')
  lines.push('')
  for (const t of todo) lines.push('- [ ] `' + String(t.id) + '` ' + String(t.ask))
  lines.push('')
  lines.push('## 四、第三方 peer 明细')
  lines.push('')
  lines.push('| 插件 | 已装 | peer | 范围 | 满足 |')
  lines.push('|---|---|---|---|---|')
  for (const t of tps) {
    const peers = (Array.isArray(t.peers) && t.peers.length) ? t.peers : [{ pkg: '-', range: '-', satisfies: null }]
    for (const p of peers) {
      lines.push('| ' + String(t.name) + ' | ' + String(t.installed || '-')
        + ' | ' + String(p.pkg || '-')
        + ' | `' + String(p.range || '-') + '`'
        + ' | ' + (p.satisfies === true ? '✅' : (p.satisfies === false ? '❌' : '❔(null)')) + ' |')
    }
  }
  lines.push('')
  return lines.join('\n') + '\n'
}

/** 真写盘（全插件**只此一处**写 md） */
export function writeReport(opts) {
  const o = opts || {}
  const fs = o.fs || fsDefault
  const ts = String(o.ts || new Date().toISOString())
  const root = String(o.workspaceRoot || defaultWorkspaceRoot(o.env))
  const file = join(root, SUBDIR, reportFileName(ts))
  const md = buildReportMarkdown(o.result, { ts })
  try {
    if (typeof fs.mkdirSync === 'function') fs.mkdirSync(dirname(file), { recursive: true })
    fs.writeFileSync(file, md, 'utf8')
    return { ok: true, written: true, file, bytes: Buffer.byteLength(md, 'utf8'), error: null }
  } catch (e) {
    return { ok: false, written: false, file, bytes: 0, error: 'WRITE_FAIL: ' + String((e && e.message) || e) }
  }
}

/** 唯一入口：**enabled !== true ⇒ 不写**（spec §8-6） */
export function maybeWriteReport(opts) {
  const o = opts || {}
  if (o.enabled !== true) return { ok: true, written: false, file: null, bytes: 0, error: null }
  return writeReport(o)
}
