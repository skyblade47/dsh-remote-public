// @local/dsh-adapter —— HTTP 数据面：/adapter/api/resume/gate（重启门闸）
//
// 给**运维/更新脚本**用：重启内核**之前**先问一句"现在能不能安全重启"。
// 端点（挂在 adapter 已有的 /adapter/api 前缀下，不自己实现鉴权 —— 鉴权在网关/内核 token 层完成）：
//
//   GET  /adapter/api/resume/gate            → 判一次，返回 { ok, safe, reason, blockers, counts, unjudgeable, table }
//   POST /adapter/api/resume/gate { op:'force', reason, by, blockers } → 把"--force 跳过门闸"写进**审计**
//
// 为什么 force 的留痕要走这里而不是由脚本自己写文件：审计的落点只能有一处
//   （adapter 的 resume-audit.jsonl），脚本另写一份就会漂移、也进不了设置界面的审计面板。
//
// ⚠️ 设计约束：**门闸关掉 ≠ 报安全**。禁用某一类判据只会让那一类不再 fail-closed；
//    `safe` 永远只代表"三类都判成功了且都为空"。想跳过门闸必须显式 `--force`（并留痕）。

import { sendJson, readJsonBody } from '../hotplug/routes.js'

const _msg = (e) => String((e && e.message) || e)

/**
 * 创建 /adapter/api/resume/gate 的处理器。
 * @param {object} opts
 * @param {object} opts.gate createResumeGate(...) 的返回值
 * @param {Function} [opts.auditTail] 审计 tail（供运维脚本排查时顺带看一眼）
 * @returns {(req, res) => Promise<boolean>} 返回 true 表示已处理该请求
 */
export function createResumeGateRoutes({ gate, auditTail }) {
  return async function handle(req, res) {
    const url = req.url || ''
    const qIdx = url.indexOf('?')
    const path = qIdx >= 0 ? url.slice(0, qIdx) : url
    if (path !== '/adapter/api/resume/gate') return false

    // 门闸服务本身不存在（provider 失败）⇒ 明确 503，**绝不**静默返回"安全"
    if (!gate || typeof gate.evaluate !== 'function') {
      sendJson(res, 503, {
        ok: false, safe: false, code: 'GATE_UNAVAILABLE',
        message: '门闸服务不可用（adapterGate 未提供）——按 fail-closed 处理：不得视为可安全重启',
      })
      return true
    }

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { ok: true, ...gate.evaluate() })
        return true
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, safe: false, code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET/POST' })
        return true
      }
      const parsed = await readJsonBody(req)
      if (parsed.error) {
        sendJson(res, 400, { ok: false, safe: false, code: 'INVALID_ARGS', message: parsed.error })
        return true
      }
      const body = parsed.value || {}
      const op = String(body.op || '').trim()
      if (op === 'force') {
        // 先把当时的事实抓下来一起留痕（脚本可能是在超时后才决定 --force 的）
        let blockers = body.blockers && typeof body.blockers === 'object' ? body.blockers : null
        if (!blockers) { try { blockers = gate.evaluate().counts } catch (_) { blockers = null } }
        const r = gate.noteForce({ reason: body.reason, by: body.by, blockers })
        sendJson(res, 200, { ok: true, result: r, blockers })
        return true
      }
      if (op === 'audit' && typeof auditTail === 'function') {
        sendJson(res, 200, { ok: true, entries: auditTail({ tail: Number(body.tail) || 50 }) })
        return true
      }
      sendJson(res, 400, {
        ok: false, safe: false, code: 'INVALID_ARGS',
        message: `未知 op: ${op || '(空)'}；可用: force/audit（只读判定请用 GET）`,
      })
      return true
    } catch (e) {
      // 门闸求值时抛错 ⇒ 同样 fail-closed（HTTP 层也不许把"出错"当"安全"）
      sendJson(res, 500, { ok: false, safe: false, code: 'INTERNAL_ERROR', message: _msg(e) })
      return true
    }
  }
}
