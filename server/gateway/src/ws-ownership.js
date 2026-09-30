// WebSocket upgrade 的「会话归属」判定 + 鉴权接线（路线图 T-1.b · 阶段①）
//
// 为什么单独一个模块（而不是写在 index.js 里）：
//   1) `index.js` 被 import 时就会 `loadConfig()` 并 `listen` ⇒ **不可在单测里直接 import**
//      （tests/ 下没有 index.test.js）。判定与接线抽出来才可测。
//   2) 判定必须是**纯函数**，才能把「什么情况放行 / 什么情况 403」逐条钉住。
//
// 设计依据：docs/superpowers/specs/2026-09-27-ws-ownership-check-design.md
// 端点清单（对着部署源码读，全量 4 条）：
//   · `/api/remote.mux`                              —— 内核 dsh-api-gateway；**无会话标识**
//     （会话 id 只在升级后的帧里）⇒ 它是**账户级多路复用**通道（一条 socket 服务该用户的
//     全部会话）⇒ 做单会话校验**语义不成立** ⇒ 列白名单。
//   · `/sidebar/ws/agent-opens` / `agent-terminals` / `terminal` —— 第三方
//     `dsh-better-sidebar@0.19.1`；sessionId 在 **query**（该插件 `lib/index.js:5152/5174/5254`）
//     ⇒ 三条都可在 upgrade 那一刻判定。
//
// 🔴 阶段①的姿态（`owner === null` 放行 + 留痕）**不是妥协偷懒**：
//   实测生产 `session-owners.json` 只有 3 条归属、而会话有 398 个（全部无归属）
//   ⇒ 直接 fail-closed 会把**现存** sidebar WS 全部掐断。收紧到 fail-closed 的前置是
//   T-1.d 的 `migrateLegacy` 跑完（见设计 §5.4「两阶段落地」）。
//
// 🎚 **阶段②（收紧为 403）做成了「运行时可翻转的开关」**（2026-09-27）：取值来自
//   `settings.json` 的 `wsOwnerStrict`（`createUpgradeAuthenticator` 的 `isStrictOwnerRequired` provider，
//   **每次 upgrade 现取**）⇒ 部署时按阶段① 上线、观察一阵后**改这一项即生效、无需再重启网关**。
//   这与"攒批窗口只重启一次"的裁定配套；前置仍是 W1（T-1.d）跑完。

import { normalizedPath } from './proxy.js'
import { isAdmin } from './session-interceptor.js'

/** 账户级多路复用通道：**不校验、不记审计**（理由见文件头） */
const ACCOUNT_LEVEL_PATHS = new Set(['/api/remote.mux'])

/** 已知携带 `?sessionId=` 的路径（query 取法已对着 `dsh-better-sidebar` 源码核实） */
const SESSION_SCOPED_PATHS = new Set([
  '/sidebar/ws/agent-opens',
  '/sidebar/ws/agent-terminals',
  '/sidebar/ws/terminal',
])

/**
 * 审计动作名。
 * 前两个**复用 HTTP 侧既有动作名**（`session-interceptor.js:147/263`），口径一致；
 * 后两个是 WS 侧新增（阶段① 的"放行但留痕"）。
 */
export const WS_AUDIT = {
  ACCESS_DENIED: 'session.access_denied',
  NO_SESSION_ID: 'session.operation_no_session_id',
  OWNER_MISSING: 'session.ws_owner_missing',
  UNKNOWN_PATH: 'session.ws_unknown_path',
}

/** 从 query 取 sessionId；取不到/空串 → null。坏 URL 一律 null（由调用方按"缺 id"处理）。 */
function readSessionId(url) {
  try {
    const v = new URL(url, 'http://gw.internal').searchParams.get('sessionId')
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

/**
 * 纯判定：给定 upgrade 请求的 url / 已认证用户 / 归属存储，回答"放不放行"。
 *
 * @returns {{
 *   allow: boolean,
 *   status?: number,          // 不允许时为 403
 *   reason: string,           // 机器可读的判定理由（单测直接断言它）
 *   action?: string,          // 需要留痕时的审计动作名
 *   sessionId?: string|null,
 *   path?: string             // 归一化后的 pathname（排障用）
 * }}
 *
 * `strictOwnerRequired`（**阶段② 开关**，默认 false = 阶段① 姿态）：
 *   false ⇒ 无归属放行 + 留痕（`OWNER_MISSING_ALLOWED`）
 *   true  ⇒ 无归属**拒绝** 403 + `session.access_denied`（`OWNER_MISSING_DENIED`）
 * 它的**取值来源**在接线层（`createUpgradeAuthenticator` 的 `isStrictOwnerRequired` provider，
 * 生产上读 `settings.json` 的 `wsOwnerStrict`）⇒ 本函数保持**纯函数**、单测可直接传参钉死。
 */
export function decideWsUpgrade({ url, user, ownerStore, strictOwnerRequired = false } = {}) {
  const path = normalizedPath(typeof url === 'string' ? url : '')
  const rawPath = typeof url === 'string' ? url.split('?')[0] : ''

  // 归一化失败（例如坏百分号编码）⇒ **fail-closed**（与 HTTP 侧 `isSessionRpc` 的保守取向一致：
  // 那里的注释写着"无法解码时保守按会话 RPC 处理，交给拦截器按 fail-closed 判定"）。
  if (path === null) {
    return { allow: false, status: 403, reason: 'BAD_PATH_ENCODING', action: WS_AUDIT.NO_SESSION_ID, sessionId: null, path: rawPath }
  }

  // ① 白名单：账户级通道 ⇒ 不校验、**不记审计**（避免每连接一条噪声）
  if (ACCOUNT_LEVEL_PATHS.has(path)) {
    return { allow: true, reason: 'ACCOUNT_LEVEL_WHITELIST', sessionId: null, path }
  }

  // ② 未知路径 ⇒ **放行 + 留痕**。
  //    为什么不是"未知即拒绝"：内核/插件升级会新增端点，拒绝会**随升级静默打断用户**；
  //    为什么不是"静默放行"：那正是 T-1 缺口的成因。⇒ 留痕是唯一可运营的中间态。
  if (!SESSION_SCOPED_PATHS.has(path)) {
    return { allow: true, reason: 'UNKNOWN_PATH_ALLOWED', action: WS_AUDIT.UNKNOWN_PATH, sessionId: null, path }
  }

  // ③ 带会话标识的已知路径
  //    admin **最先**豁免 —— 与 `session-interceptor.js:112-114/:143` 的 `isAdmin` 口径一致。
  if (isAdmin(user)) {
    return { allow: true, reason: 'ADMIN_BYPASS', sessionId: readSessionId(url), path }
  }

  const sessionId = readSessionId(url)
  if (!sessionId) {
    // 缺 id 时**不查归属**直接拒：请求本身不可用（该插件自己也会 `ws.close(1008)`）
    return { allow: false, status: 403, reason: 'SESSION_ID_REQUIRED', action: WS_AUDIT.NO_SESSION_ID, sessionId: null, path }
  }

  const owner = ownerStore && typeof ownerStore.getOwner === 'function' ? ownerStore.getOwner(sessionId) : null

  // ④ 无归属：
  //   · 阶段①（`strictOwnerRequired=false` 默认）：**放行 + 留痕**（理由见文件头；收紧的前置是 T-1.d）
  //   · 阶段②（`strictOwnerRequired=true`）：**拒绝** —— 审计动作与 HTTP 侧越权同名（`session.access_denied`），
  //     `reason` 用 `OWNER_MISSING_DENIED` 与"他人有归属"的 `OWNER_MISMATCH` 区分开（排障/统计都用得上）
  if (owner === null || owner === undefined) {
    if (strictOwnerRequired) {
      return { allow: false, status: 403, reason: 'OWNER_MISSING_DENIED', action: WS_AUDIT.ACCESS_DENIED, sessionId, path }
    }
    return { allow: true, reason: 'OWNER_MISSING_ALLOWED', action: WS_AUDIT.OWNER_MISSING, sessionId, path }
  }

  if (owner === (user && user.id)) {
    return { allow: true, reason: 'OWNER_MATCH', sessionId, path }
  }

  // ⑤ 有归属、且不是本人、且非 admin ⇒ 拒绝（这就是阶段① 真正挡下的那一类：
  //    "越权订阅**他人有归属**的会话流"）
  return { allow: false, status: 403, reason: 'OWNER_MISMATCH', action: WS_AUDIT.ACCESS_DENIED, sessionId, path }
}

/** 拒绝时写在 socket 上的裸 HTTP 响应（与 `index.js` 现有 401 的形态同族） */
export function forbiddenResponse() {
  return (
    'HTTP/1.1 403 Forbidden\r\n' +
    'Connection: close\r\n' +
    'content-type: application/json\r\n' +
    '\r\n' +
    JSON.stringify({ ok: false, error: { code: 'SESSION_ACCESS_DENIED', message: '无权访问该会话' } })
  )
}

/**
 * 鉴权接线工厂（把原 `index.js` 里的 `upgradeAuthenticator` 搬出来，使其可单测）。
 *
 * 顺序：认证 → 归属判定 → （拒绝）写裸 403 并关闭 /（放行）转交 `upgradeHandler`。
 * 🔴 **拒绝必须发生在 `upgradeHandler` 之前** —— 那才是 `net.connect` 之前，
 *    否则已升级的连接会在上游留下残留（与 U-32 同源问题）。
 */
export function createUpgradeAuthenticator({
  authService,
  getToken,
  ownerStore = null,
  isStrictOwnerRequired = null,
  audit = null,
  upgradeHandler,
  log = () => {},
}) {
  const record = (action, details) => {
    if (!action) return
    try {
      if (audit && typeof audit.log === 'function') audit.log(action, details)
    } catch {
      // 审计失败不该影响鉴权结论
    }
  }

  return function upgradeAuthenticator(req, socket, head) {
    const token = getToken ? getToken(req) : null
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const result = authService.authenticateToken(token)
    if (!result || !result.user || result.user.role === 'pending') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // 阶段② 开关：**每次 upgrade 现取**（provider 读 settings.json）⇒ 运行时可翻转、**无需重启**。
    // provider 抛错/未接线一律按 false（= 阶段① 姿态）—— 收紧只能是显式选择，绝不因异常而"变得更严"。
    let strictOwnerRequired = false
    try {
      strictOwnerRequired = typeof isStrictOwnerRequired === 'function' && isStrictOwnerRequired() === true
    } catch {
      strictOwnerRequired = false
    }

    const decision = decideWsUpgrade({ url: req.url, user: result.user, ownerStore, strictOwnerRequired })
    record(decision.action, {
      channel: 'ws',
      path: decision.path,
      sessionId: decision.sessionId == null ? null : decision.sessionId,
      userId: result.user.id,
      reason: decision.reason,
    })

    if (!decision.allow) {
      log(`ws upgrade denied: reason=${decision.reason} path=${decision.path} user=${result.user.id}`)
      // `end()` 而不是 `write()+destroy()`：后者可能把响应截断
      // （握手前的裸响应必须完整送达，否则对端看到的是空连接而不是 403）
      socket.end(forbiddenResponse())
      return
    }

    upgradeHandler(req, socket, head)
  }
}
