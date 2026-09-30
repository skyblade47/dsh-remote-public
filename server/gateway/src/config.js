// 网关配置：本模块是唯一读取 process.env 的地方，便于测试与集中校验。

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function parsePort(raw, label) {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} 非法端口: ${raw}`)
  }
  return port
}

function parseBool(raw, def = false) {
  if (raw === undefined) return def
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

// 逗号分隔列表，用于证书 SAN 等可叠加配置。
function parseList(raw) {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env = process.env) {
  const port = parsePort(env.DSH_GATEWAY_PORT ?? 8080, 'DSH_GATEWAY_PORT')

  const rawUpstream = env.DSH_GATEWAY_UPSTREAM ?? 'http://127.0.0.1:3080'
  const url = new URL(rawUpstream)
  if (url.protocol !== 'http:') {
    throw new Error(`只支持 http 上游，收到: ${url.protocol}`)
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(`上游必须是回环地址（本阶段仅支持本机实例），收到: ${url.hostname}`)
  }

  // TLS：开启后 HTTPS 由 httpsPort 提供，port 退化为 HTTP→HTTPS 跳转端口。
  const tls = parseBool(env.DSH_GATEWAY_TLS, false)
  const httpsPort = tls
    ? parsePort(env.DSH_GATEWAY_HTTPS_PORT ?? 8443, 'DSH_GATEWAY_HTTPS_PORT')
    : port
  if (tls && httpsPort === port) {
    throw new Error('启用 TLS 时 DSH_GATEWAY_PORT（HTTP 跳转）不能与 DSH_GATEWAY_HTTPS_PORT 相同')
  }

  // 客户端证书（mTLS）白名单：开启后只接受持有已授权客户端证书的连接。
  // 用于替代 IP 锁——设备在家庭/出差等网络下地址不固定时依然可用。
  const mtls = tls && parseBool(env.DSH_GATEWAY_MTLS, false)

  // 明文口是否**保留**（仅与 TLS 同时有效）：默认 false = 沿用原行为（明文口只做 301 跳转）。
  // 置 1 后明文口继续提供**完整服务**（不跳转）—— 用于"同一网关同时对外提供两种入口"：
  //   · 明文口给 Funnel `--https` 用（tailscaled 终止 TLS ⇒ 后端必须收明文）
  //   · TLS 口给 Funnel `--tcp` + mTLS 用（网关自己终止 TLS，才拿得到客户端证书）
  // 为什么需要这个开关：TLS 一旦开启，原设计会把明文口降级成跳转口 ⇒ 两种入口无法并存。
  const plainKeep = tls && parseBool(env.DSH_GATEWAY_PLAIN_KEEP, false)

  return {
    port,
    httpsPort,
    tls,
    mtls,
    plainKeep,
    // 网关自身只绑回环；对外暴露由反代/隧道负责（主设计 §9.2）。
    // 云上固定 IP 直连时置 0.0.0.0，并把公网 IP 写进 tlsSan。
    host: env.DSH_GATEWAY_HOST ?? '127.0.0.1',
    // 追加到自签证书 SAN 的额外条目（IP 或 DNS 名），逗号分隔。
    // 用于固定 IP / 域名访问时避免浏览器证书不匹配告警。
    tlsSan: parseList(env.DSH_GATEWAY_TLS_SAN),
    // Web 客户端静态资源目录。客户端已拆分为独立仓库（dsh-remote-client），
    // 因此允许通过环境变量指到 clone 出来的位置；留空则用仓库内默认 client/web。
    webDir: env.DSH_GATEWAY_WEB_DIR || '',
    upstream: {
      hostname: url.hostname,
      port: parsePort(url.port || 80, 'DSH_GATEWAY_UPSTREAM 端口'),
    },
  }
}
