// @local/dsh-adapter —— 契约探测/版本自检/结构化诊断（§7 一期最小面）
// 探测键为宿主既有 capability fact（fs.sandboxMode），零副作用零写盘；apply 时执行一次 + status() 可重跑。
// 2026-09-17 扩展：加入「宿主版本感知 + 能力清单 + 兼容矩阵判定」（lib/compat.js），
// 用于确认宿主升级前后 adapter 自身与配套第三方插件是否仍匹配；全部只读、失败不抛。

import { evaluate, summaryLine } from './compat.js'

const NEEDED_FS_METHODS = ['resolve', 'stat', 'readText', 'writeText', 'listDir']

export class Probe {
  constructor(deps) {
    this._deps = deps // { fs, sandboxPolicy, getWebServer, getService, config, packageVersion }
  }

  // 返回 { probes: [], degraded: [], status }
  run() {
    const d = this._deps
    const probes = []
    const degraded = []
    // 1. ctx.fs 与方法集
    const fsOk = !!(d.fs && NEEDED_FS_METHODS.every((m) => typeof d.fs[m] === 'function'))
    probes.push({ api: 'fs', ok: fsOk, detail: fsOk ? undefined : (d.fs ? 'method set incomplete' : 'missing') })
    if (!fsOk) degraded.push('adapterFs: ctx.fs missing/incomplete（全部方法 ADAPTER_UNAVAILABLE）')
    // 2. fs.sandboxMode（写闸 capability fact）
    const sm = d.fs && d.fs.sandboxMode
    probes.push({ api: 'fs.sandboxMode', ok: sm !== undefined, detail: sm !== undefined ? '写闸存在（sandboxMode=' + sm + '）' : '无写闸语义（本地 fs：写不传第5参）' })
    if (sm === undefined && fsOk) degraded.push('adapterFs: 写路径无 sandbox 闸（sandboxMode undefined，policy 降级）')
    // 3. sandboxPolicy
    const spOk = !!(d.sandboxPolicy && typeof d.sandboxPolicy.resolve === 'function')
    probes.push({ api: 'sandboxPolicy', ok: spOk, detail: spOk ? 'workspaceRoot=' + (safeGetWorkspaceRoot(d.sandboxPolicy)) : 'missing（默认根回退跳过此源）' })
    // 4. env
    const envUrl = process.env.DSH_WEB_URL
    probes.push({ api: 'env.DSH_WEB_URL', ok: !!(envUrl && envUrl.trim()), detail: envUrl || '未设置（回退 127.0.0.1:3080）' })
    if (!(envUrl && envUrl.trim())) degraded.push('adapterHttp.apiBase 无 DSH_WEB_URL（回退 127.0.0.1:3080）')
    // 5. webServer（可选自检路由）
    let ws = null
    try { ws = d.getWebServer ? d.getWebServer() : undefined } catch (e) {}
    const wsOk = !!(ws && typeof ws.register === 'function')
    if (wsOk) probes.push({ api: 'webServer(optional)', ok: true, detail: 'status 路由可注册（registry.inject 子 fiber）' })
    else probes.push({ api: 'webServer(optional)', ok: false, detail: '缺失（不注册 /adapter/api/status，adapter.status() 仍可直读）' })
    if (!wsOk) degraded.push('adapter: webServer 缺失（不注册 /adapter/api/status）')
    return {
      adapter: {
        id: 'local-dsh-adapter',
        version: d.packageVersion || '0.0.0',
        build: d.build || undefined,
        packageName: '@local/dsh-adapter',
      },
      probes,
      degraded,
      status: degraded.length ? 'degraded' : 'ok',
    }
  }

  // ---- 版本感知兼容判定（2026-09-17 新增；只读、失败不抛、绝不影响 status 主结构）----
  runCompat() {
    try {
      const svc = (this._deps && typeof this._deps.getService === 'function')
        ? this._deps.getService
        : function () { return undefined }
      const cfg = (this._deps && this._deps.config) || {}
      const compatCfg = cfg.compat || {}
      return evaluate(svc, {
        hostVersion: compatCfg.hostVersion,
        dshHome: compatCfg.dshHome,
        profile: compatCfg.profile,
      })
    } catch (e) {
      return { status: 'unknown', error: String(e && e.message || e), capabilities: [], capabilityGaps: [], compat: {} }
    }
  }

  statusJson(hostExtra) {
    const r = this.run()
    if (hostExtra) r.host = hostExtra
    // 兼容块：宿主版本 / 能力清单 / 推荐插件版本 / 版本错配告警
    try {
      r.compatReport = this.runCompat()
      r.compatSummary = summaryLine(r.compatReport)
    } catch (e) {
      r.compatReport = { status: 'unknown', error: String(e && e.message || e) }
    }
    return r
  }
}

function safeGetWorkspaceRoot(sp) {
  try {
    const r = sp.resolve()
    return r && r.workspaceRoot ? r.workspaceRoot : null
  } catch (e) { return null }
}
