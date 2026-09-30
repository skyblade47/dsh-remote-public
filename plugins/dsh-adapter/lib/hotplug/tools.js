// @local/dsh-adapter —— hotplug_* 工具注册
//
// 与 sandbox 的 9 工具一一对应，命名一次性切到 hotplug_*（已决：直接迁移，不留沙箱别名）。
// 三条从 sandbox 继承的"踩过坑"约定：
//   1. bootstr 用 **字符串 'true'/'false'**（宿主工具参数 schema 对此更稳），不是 boolean；
//   2. 输出 schema 一律 type:object，且 list 返回 `{ok, entries}` —— sandbox 时期
//      返回裸数组被新宿主严格校验拒过（`tool "sandbox_list" returned invalid output`）；
//   3. `defineTool` 走**惰性动态 import**：adapter 是最小集成员，不能因为宿主没暴露
//      dsh-tools 就整个 apply 失败。拿不到就明确跳过并写审计，而不是崩。

const OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (args, v) => [{ type: 'text', text: (v && typeof v === 'object') ? JSON.stringify(v, null, 2) : String(v == null ? '' : v) }],
  presentationMeta: (args, v) => (v && typeof v === 'object' && v.ok !== undefined) ? { ok: v.ok } : {},
}

const _msg = (e) => String((e && e.message) || e)

function buildDefs(service) {
  return [
    { name: 'hotplug_load', description: '[Hotplug] 热加载白名单插件 id（顶层创建，立即生效，无需重启 dsh）。', parameters: { id: { type: 'string', description: '白名单插件 id', required: true } }, output: OUT, execute: async (a) => await service.load(a.id) },
    { name: 'hotplug_unload', description: '[Hotplug] 热卸载插件 id。guarded 档（bundles 复合层内的插件）同样允许。残留未清干净会抛 UNLOAD_FAILED_BUT_REMAINS。', parameters: { id: { type: 'string', description: '已加载的插件 id', required: true } }, output: OUT, execute: async (a) => await service.unload(a.id) },
    { name: 'hotplug_swap', description: '[Hotplug] 热换插件版本/配置（保留 id）。先做 link-validate 再切换；apply 期失败会用保留的旧代次自愈回滚。newConfig 传 JSON 字符串。', parameters: { id: { type: 'string', required: true }, newPath: { type: 'string', description: '新路径（可省略，沿用 manifest）' }, newConfig: { type: 'string', description: '新 config JSON 字符串（可省略）' } }, output: OUT, execute: async (a) => { let c = a.newConfig; if (typeof c === 'string' && c.trim() !== '') { try { c = JSON.parse(c) } catch (_) { throw new Error('newConfig 非合法 JSON') } } return await service.swap(a.id, { newPath: a.newPath, newConfig: c }) } },
    { name: 'hotplug_reload', description: '[Hotplug] 强制重新加载插件代码（ModuleGraphBuster 按代次破除整条 ESM 子图缓存，含非入口子模块）+ 稳定包名保持 UI graph 完整。失败时旧实例不受影响。', parameters: { id: { type: 'string', description: '白名单插件 id', required: true } }, output: OUT, execute: async (a) => await service.reload(a.id) },
    { name: 'hotplug_list', description: '[Hotplug] 列出白名单条目 + 档位 + 加载态 + 代次 + moduleRev。', parameters: {}, output: OUT, execute: async () => ({ ok: true, entries: await service.list() }) },
    { name: 'hotplug_status', description: '[Hotplug] 查询单插件详细状态：档位/可执行操作集/已加载/代次/moduleRev/已加载文件清单/在途操作。', parameters: { id: { type: 'string', required: true } }, output: OUT, execute: async (a) => await service.status(a.id) },
    { name: 'hotplug_whitelist_add', description: '[Hotplug] 新增白名单条目（持久化到 hotplug-manifest.yml）。之后用 hotplug_load 热加载生效，无需重启。', parameters: { id: { type: 'string', required: true }, path: { type: 'string', description: '包名或 file:/ 绝对路径', required: true }, builtin: { type: 'string', description: 'true/false，加载来源标记（不影响热替门禁），默认 false' }, enabled: { type: 'string', description: 'true/false，默认 true' } }, output: OUT, execute: async (a) => await service.whitelistAdd({ id: a.id, path: a.path, config: {}, builtin: a.builtin === 'true', enabled: a.enabled !== 'false' }) },
    { name: 'hotplug_whitelist_remove', description: '[Hotplug] 移除白名单条目；若已加载先尝试热卸载再移除（卸载失败即中止，避免白名单已删但插件还在跑）。', parameters: { id: { type: 'string', required: true } }, output: OUT, execute: async (a) => await service.whitelistRemove(a.id) },
    { name: 'hotplug_whitelist_enable', description: '[Hotplug] 启用白名单条目（不自动 load，需 hotplug_load）。', parameters: { id: { type: 'string', required: true } }, output: OUT, execute: async (a) => await service.whitelistEnable(a.id) },
    { name: 'hotplug_whitelist_disable', description: '[Hotplug] 禁用白名单条目（不自动 unload，需 hotplug_unload）。', parameters: { id: { type: 'string', required: true } }, output: OUT, execute: async (a) => await service.whitelistDisable(a.id) },
  ]
}

/**
 * @returns {Promise<{ok:number, fail:number, skipped?:string}>}
 */
export async function registerHotplugTools({ toolsService, service, audit }) {
  const log = (level, event, message, extra) => {
    try { if (audit && audit.log) audit.log({ level, category: 'hotplug', event, message, extra: extra || {} }) } catch (_) {}
  }
  if (!toolsService || typeof toolsService.register !== 'function') {
    log('WARN', 'hotplug.tools.skipped', 'tools 服务不可用')
    return { ok: 0, fail: 0, skipped: 'tools service unavailable' }
  }

  let defineTool = null
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    defineTool = mod.defineTool || (mod.default && mod.default.defineTool)
  } catch (e) {
    log('WARN', 'hotplug.tools.skipped', '无法加载 @deepseek-ai/dsh-tools：' + _msg(e))
    return { ok: 0, fail: 0, skipped: 'dsh-tools unavailable: ' + _msg(e) }
  }
  if (typeof defineTool !== 'function') {
    log('WARN', 'hotplug.tools.skipped', '@deepseek-ai/dsh-tools 未导出 defineTool')
    return { ok: 0, fail: 0, skipped: 'defineTool not exported' }
  }

  let ok = 0, fail = 0
  for (const def of buildDefs(service)) {
    try { toolsService.register(defineTool(def)); ok++ } catch (e) {
      fail++
      log('ERROR', 'hotplug.tool.fail', def.name + ': ' + _msg(e))
    }
  }
  log('INFO', 'hotplug.tools.ready', `ok=${ok} fail=${fail}`, { ok, fail })
  return { ok, fail }
}
