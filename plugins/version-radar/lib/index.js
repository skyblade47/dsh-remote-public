// ============================================================================
// @local/version-radar —— 版本雷达（Host 侧，**薄接线**）
//
// 目的：把「一次完整的版本检测」做成对话可调用（工具）+ HTTP 可触发，并落审计、按需出 md。
//
// 接线三件套（缺一不可，见 session-janitor/lib/index.js 文件头）：
//   ① package.json 的 dsh.bundle.patch → ./cordis.patch.yml
//   ② cordis.patch.yml 的 - insert（id: version-radar, name: '@local/version-radar'）
//   ③ <DSH_HOME>/hotplug-manifest.yml 条目（**第二阶段**才加）
//
// 纪律（spec §6）：
//   1 禁启动期联网：模块顶层零网络调用；apply() 里也不出网；只有显式调用（工具 / POST /check）才联网
//   2 不派生任何子进程 API   3 不读会话目录   4 不递归扫盘   5 只取 dist-tags（见 registry.js）
//   6 出网失败 ⇒ fail-closed   7 semver 真跑（见 probe.js）   8 **只建议不执行**（本文件无切换/重启/安装代码）
//
// ⚠️ 本文件**不可被本机 import**（dsh-tools 只在宿主机存在）⇒ 它的运行时行为只能在第二阶段装载后
//    冒烟验证；本阶段由 test/wiring.test.mjs 做「源码契约锁」（契约锁 ≠ 行为测试）。
// ============================================================================
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import { runProbe } from './probe.js'
import { appendAudit, EVENTS, defaultAuditPath } from './audit.js'
import { maybeWriteReport } from './report.js'
import { buildResponse, resolveSecret } from './routes.js'

const inject = ['tools', 'webServer', 'fs']
const PLUGIN_ID = 'version-radar'
const TOOL_NAME = 'version_probe'
const HTTP_PREFIX = '/version-radar/api' // 与 routes.js 的 API_PREFIX 同值（test/wiring.test.mjs 会核）
const STALE_NOTE = '进程内缓存（/status 只回它，永不联网）'

// 进程内最近一次结果（启动期为空；**只有**工具调用或 POST /check 才会刷新）
let lastRunAt = null
let lastResult = null

const MSG = (e) => String((e && e.message) || e)
const logWarn = (ctx, msg) => {
  try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(msg); else if (process.stderr) process.stderr.write(msg + '\n') } catch (_) {}
}
const logInfo = (ctx, msg) => {
  try { const lg = ctx.get('logger'); if (lg && typeof lg.info === 'function') lg.info(msg); else if (process.stderr) process.stderr.write(msg + '\n') } catch (_) {}
}

/** 审计写入包装：失败**不阻断**主流程（spec §5.3） */
function appendAuditSafe(o, auditArgs) {
  const r = appendAudit(Object.assign({ fs: (o && o.fs) || fs, file: defaultAuditPath(process.env) }, auditArgs))
  if (!r.ok) logWarn(o && o.ctx, `[${PLUGIN_ID}] 审计写入失败（不阻断主流程）：${r.error}`)
  return r
}

/**
 * 一次检测 + 审计 + （可选）报告 —— **唯一**执行入口（工具路径与 HTTP 路径共用）。
 * 失败**不抛**到 agent 层：一律转成 { ok:false, verdict:'unknown', reasons[] }（spec §5.1）。
 */
async function runCheck(opts) {
  const o = opts || {}
  const via = (o.via === 'http') ? 'http' : 'tool'
  const at = new Date().toISOString()
  appendAuditSafe(o, { event: EVENTS.TRIGGER, payload: { via }, at })
  let result
  try {
    result = await runProbe({ targetVersion: o.targetVersion })
  } catch (e) {
    const reason = 'PROBE_THREW: ' + MSG(e)
    appendAuditSafe(o, { event: EVENTS.ERROR, payload: { reason }, at: new Date().toISOString() })
    return { ok: false, verdict: 'unknown', reasons: [reason] }
  }
  lastRunAt = at
  lastResult = result
  appendAuditSafe(o, { event: EVENTS.DONE, payload: result, at })
  const rep = maybeWriteReport({
    enabled: o.report === true,
    fs: (o.fs || fs),
    workspaceRoot: process.env.DSH_WORKSPACE_ROOT,
    ts: at,
    result,
  })
  if (o.report === true) logInfo(o.ctx, `[${PLUGIN_ID}] 升级建议：${rep.written ? rep.file : '(未写：' + rep.error + ')'}`)
  return result
}

export function apply(ctx, config) {
  const secret = resolveSecret({ config, fs, env: process.env })
  logInfo(ctx, `[${PLUGIN_ID}] HTTP secret：${secret.secret
    ? '已配（来源 ' + secret.source + '，值不外泄）'
    : '未配 ⇒ /check 一律 403（fail-closed）'}；${STALE_NOTE}`)

  // ============ 1) 工具注册（与 session-janitor 同构） ============
  const toolsSvc = ctx.get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    try {
      const disposer = toolsSvc.register(defineTool({
        name: TOOL_NAME,
        description: '版本雷达：只读汇总「当前内核版本 / 上游 npm dist-tags / 第三方插件 peerDependencies 的 semver 求交 / 本地改动台账待办 / 回滚目标是否在盘」⇒ 给「可升 / 需人工判定 / 不建议升 / unknown」结论 + 理由。**只建议、不执行**（不切换、不重启、不安装）。report:true 才额外写一份 md 到 <DSH_WORKSPACE_ROOT>/DSH工具/。',
        parameters: {
          targetVersion: { type: 'string', description: '目标版本；省略 = 上游 dist-tags.latest' },
          report: { type: 'boolean', description: '省略即 false；true ⇒ 额外写升级建议 md' },
        },
        // 🔴 `output` 是宿主 `defineTool` 的**硬要求**：它直接读 `options.output.render`
        //    与 `options.output.schema`（缺整个 output ⇒ 抛 "Cannot read properties of undefined
        //    (reading 'render')"，**注册失败但模块仍算加载成功** ⇒ 只在日志里可见）。
        //    形状照本仓既有的可用参考 session-janitor 的 register()；2026-09-26 真机踩到过。
        output: {
          schema: { type: 'object', additionalProperties: true },
          // ⚠️ 2026-09-26 真机教训：**必须把完整 JSON 放进返回文本** —— 只回一行摘要时，
          //    对话里的模型看不到那 8 个冻结字段（实测只能绕道 /version-radar/api/status 才拿到）。
          //    所以 = 一行摘要（便于 UI 卡片）+ 完整 pretty JSON（供模型与人工核对）。
          render: (_args, value) => {
            const head = (value && typeof value.verdict === 'string')
              ? (value.verdict + (Array.isArray(value.reasons) && value.reasons.length ? '｜' + value.reasons[0] : ''))
              : '版本雷达结果'
            return [{ type: 'text', text: head + '\n\n' + JSON.stringify(value, null, 2) }]
          },
          presentationMeta: (_args, value) => (value && typeof value === 'object' ? value : {}),
        },
        execute: async (args) => {
          const a = args || {}
          return await runCheck({
            via: 'tool',
            targetVersion: a.targetVersion ? String(a.targetVersion) : undefined,
            report: a.report === true,
            ctx,
            fs,
          })
        },
      }))
      const cleanup = ctx.effect(() => function __versionRadarToolCleanup() {
        try { if (typeof disposer === 'function') disposer() } catch (_) { /* ignore */ }
      })
      void cleanup
      logInfo(ctx, `[${PLUGIN_ID}] tools registered: ${TOOL_NAME}`)
    } catch (e) {
      logWarn(ctx, `[${PLUGIN_ID}] ${TOOL_NAME} register failed: ${MSG(e)}`)
    }
  } else {
    logWarn(ctx, `[${PLUGIN_ID}] tools 服务不可用：${TOOL_NAME} 未注册`)
  }

  // ============ 2) HTTP 数据面 /version-radar/api ============
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    const handler = (req, res) => {
      const send = (status, obj) => {
        try {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify(obj))
        } catch (_) {}
      }
      let u
      try { u = new URL(req.url || '/', 'http://x') } catch (_) { return send(400, { ok: false, error: 'BAD_URL' }) }
      const query = {}
      for (const [k, v] of u.searchParams.entries()) query[k] = v
      Promise.resolve(buildResponse({
        method: req.method,
        path: u.pathname,
        query,
        headers: req.headers,
        config: config || {},
        deps: {
          getLastResult: () => ({ lastRunAt, result: lastResult }),
          runCheck: (a) => runCheck({ via: (a && a.via) || 'http', report: Boolean(a && a.report), ctx, fs }),
          resolveSecret: () => resolveSecret({ config, fs, env: process.env }),
          now: () => Date.now(),
          fs,
          env: process.env,
        },
      })).then((r) => send(r.status, r.body)).catch((e) => send(500, { ok: false, error: MSG(e) }))
    }
    try {
      ctx.effect(() => webServer.register({ kind: 'prefix', path: HTTP_PREFIX, handler }))
    } catch (e) {
      logWarn(ctx, `[${PLUGIN_ID}] api register failed: ${MSG(e)}`)
    }
  } else {
    logWarn(ctx, `[${PLUGIN_ID}] webServer 服务不可用：${HTTP_PREFIX} 未注册`)
  }
}

export { inject, HTTP_PREFIX, PLUGIN_ID, TOOL_NAME }
