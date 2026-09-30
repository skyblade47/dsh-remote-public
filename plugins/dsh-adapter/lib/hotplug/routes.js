// @local/dsh-adapter —— HTTP 数据面：/adapter/api/hotplug
//
// 与工具层共用同一个 HotplugService（避免两套逻辑漂移），供设置界面与运维脚本调用。
// 认证复用宿主既有的 dsh-auth cookie —— 本路由挂在 adapter 已有的 /adapter/api 前缀下，
// 不自己实现鉴权（内核为零入站鉴权，鉴权在网关/内核 token 层完成）。
//
// 端点：
//   GET  /adapter/api/hotplug            → { ok, buster, entries[], inFlight }
//   POST /adapter/api/hotplug            → body { op, id, ... } → 单次操作
//   GET  /adapter/api/hotplug/audit?tail=N&minLevel=&kw=  → { ok, entries[] }

import { HotplugError, httpStatusFor } from './errors.js'

const _msg = (e) => String((e && e.message) || e)
const MAX_BODY = 64 * 1024

// 导出给同包其它数据面复用（如 lib/resume/routes.js 的 /adapter/api/resume/gate）：
// "charset=utf-8 必须显式声明"与"body 读取上限/非法 JSON 的报错口径"这两处教训只该有一份实现。
export function sendJson(res, status, obj) {
  // charset=utf-8 必须显式声明，否则中文错误信息在客户端按 Latin-1 解码成乱码
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(obj, null, 2))
  } catch (_) { /* 响应已断开 */ }
}

export function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        try { req.destroy && req.destroy() } catch (_) {}
        finish({ error: `body 超过 ${MAX_BODY} 字节` })
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return finish({ value: {} })
      try { finish({ value: JSON.parse(raw) }) } catch (e) { finish({ error: 'body 非合法 JSON: ' + _msg(e) }) }
    })
    req.on('error', (e) => finish({ error: 'body 读取失败: ' + _msg(e) }))
  })
}

async function dispatch(service, body) {
  const op = String(body.op || '').trim()
  const id = body.id
  switch (op) {
    case 'list': return { ok: true, entries: await service.list() }
    case 'status': return await service.status(id)
    case 'load': return await service.load(id)
    case 'unload': return await service.unload(id)
    case 'swap': return await service.swap(id, { newPath: body.newPath, newConfig: body.newConfig })
    case 'reload': return await service.reload(id)
    case 'add': return await service.whitelistAdd({ id, path: body.path, config: body.config || {}, builtin: body.builtin === true, enabled: body.enabled !== false })
    case 'remove': return await service.whitelistRemove(id)
    case 'enable': return await service.whitelistEnable(id)
    case 'disable': return await service.whitelistDisable(id)
    default:
      throw new HotplugError('INVALID_ARGS', `未知 op: ${op || '(空)'}；可用: list/status/load/unload/swap/reload/add/remove/enable/disable`)
  }
}

/**
 * 创建 /adapter/api/hotplug 的处理器。
 * @returns {(req, res) => Promise<boolean>} 返回 true 表示已处理该请求
 */
export function createHotplugRoutes({ service, auditTail }) {
  return async function handle(req, res) {
    const url = req.url || ''
    const qIdx = url.indexOf('?')
    const path = qIdx >= 0 ? url.slice(0, qIdx) : url
    const query = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams()

    if (path === '/adapter/api/hotplug/audit') {
      if (typeof auditTail !== 'function') { sendJson(res, 503, { ok: false, code: 'AUDIT_UNAVAILABLE', message: '审计未启用' }); return true }
      sendJson(res, 200, {
        ok: true,
        entries: auditTail({
          tail: parseInt(query.get('tail') || '200', 10) || 200,
          minLevel: query.get('minLevel') || undefined,
          kw: query.get('kw') || undefined,
        }),
      })
      return true
    }

    if (path !== '/adapter/api/hotplug') return false

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const snap = service.snapshot()
        sendJson(res, 200, {
          ok: true,
          buster: snap.buster,
          treeAvailable: snap.treeAvailable,
          inFlight: snap.inFlight,
          unstable: snap.unstable,
          unstableReason: snap.unstableReason,
          gens: snap.gens,
          entries: await service.list(),
        })
        return true
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET/POST' })
        return true
      }
      const parsed = await readJsonBody(req)
      if (parsed.error) {
        sendJson(res, 400, { ok: false, code: 'INVALID_ARGS', message: parsed.error })
        return true
      }
      const result = await dispatch(service, parsed.value || {})
      sendJson(res, 200, { ok: true, result })
      return true
    } catch (e) {
      const code = (e && e.code) || 'INTERNAL_ERROR'
      sendJson(res, httpStatusFor(code), {
        ok: false,
        code,
        message: _msg(e),
        extra: (e && e.extra) || {},
      })
      return true
    }
  }
}
