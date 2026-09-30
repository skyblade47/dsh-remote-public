// @local/dsh-adapter —— /#hotplug 聊天命令
//
// 从 sandbox/lib/index.js 的 _installChatCommand 迁移，语义相同、命名切到 hotplug
// （已决：不留 /#sandbox 别名）。
//
// 需要 agents 服务；在 adapter 里是**可选依赖**，走 ctx.registry.inject(['loader','agents'])
// 子 fiber 惰性接入（理由见 lib/index.js L57-64：apply 级 inject 会变成启动竞态）。
// agents 不可用时只写审计跳过，绝不影响 adapter 其余能力。

const _msg = (e) => String((e && e.message) || e)

function tokenize(line) {
  const out = []
  let cur = ''
  let inQ = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === inQ) { inQ = null; out.push(cur); cur = '' } else { cur += ch }
      continue
    }
    if (ch === '"' || ch === "'") { inQ = ch; continue }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur !== '') { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

export function helpText() {
  return [
    'Hotplug 聊天命令（所有操作立即生效，无需重启 dsh）：',
    '  /#hotplug list                       列出白名单、档位与加载状态',
    '  /#hotplug load <id>                 热加载插件（顶层创建）',
    '  /#hotplug unload <id>               热卸载插件',
    '  /#hotplug swap <id> [newPath]       热换版本/路径（先校验后切换，失败自愈回滚）',
    '  /#hotplug reload <id>               强制重载代码（整条 ESM 子图按代次破除）',
    '  /#hotplug status <id>               查询档位/代次/moduleRev/已加载文件',
    '  /#hotplug add id=<id> path=<path> [builtin=true] [enabled=false]   新增白名单',
    '  /#hotplug remove <id>               移除白名单（已加载先热卸载）',
    '  /#hotplug enable <id>               启用白名单条目',
    '  /#hotplug disable <id>              禁用白名单条目',
    '  /#hotplug help                      显示本帮助',
  ].join('\n')
}

async function runSub(sub, parts, service) {
  const needId = (name) => {
    const id = parts[1]
    if (!id) throw new Error(`usage: /#hotplug ${name} <id>`)
    return id
  }
  switch (sub) {
    case 'list': return await service.list()
    case 'load': return await service.load(needId('load'))
    case 'unload': return await service.unload(needId('unload'))
    case 'swap': return await service.swap(needId('swap'), { newPath: parts[2] || undefined })
    case 'reload': return await service.reload(needId('reload'))
    case 'status': return await service.status(needId('status'))
    case 'add': {
      if (parts.length < 3) throw new Error('usage: /#hotplug add id=<id> path=<path> [builtin=true] [enabled=true|false]')
      const entry = { config: {} }
      for (let i = 1; i < parts.length; i++) {
        const kv = parts[i]
        const eq = kv.indexOf('=')
        if (eq <= 0) throw new Error('参数格式应为 key=value: ' + kv)
        const k = kv.slice(0, eq).trim()
        const v = kv.slice(eq + 1).trim()
        if (k === 'id') entry.id = v
        else if (k === 'path') entry.path = v
        else if (k === 'builtin') entry.builtin = v === 'true' || v === '1'
        else if (k === 'enabled') entry.enabled = !(v === 'false' || v === '0')
      }
      if (!entry.id) throw new Error('缺少 id=')
      if (!entry.path) throw new Error('缺少 path=')
      if (entry.enabled === undefined) entry.enabled = true
      if (entry.builtin === undefined) entry.builtin = false
      return await service.whitelistAdd(entry)
    }
    case 'remove':
    case 'rm': return await service.whitelistRemove(needId('remove'))
    case 'enable': return await service.whitelistEnable(needId('enable'))
    case 'disable': return await service.whitelistDisable(needId('disable'))
    default: return { ok: true, help: helpText() }
  }
}

/**
 * install 聊天命令钩子。
 * @returns {{installed:boolean, reason?:string}}
 */
export function installHotplugCommand({ ctx, service, audit, agents }) {
  const log = (level, event, message, extra) => {
    try { if (audit && audit.log) audit.log({ level, category: 'hotplug', event, message, extra: extra || {} }) } catch (_) {}
  }

  let ag = agents || null
  if (!ag) { try { ag = ctx.get('agents') } catch (_) { ag = null } }
  if (!ag) { try { ag = ctx.agents } catch (_) { ag = null } }
  if (!ag || typeof ag.on !== 'function') {
    log('WARN', 'hotplug.cmd.skipped', 'agents 服务不可用，/#hotplug 未安装', { agents: !!ag })
    return { installed: false, reason: 'agents unavailable' }
  }

  const handle = async (text, reply) => {
    if (!text || typeof text !== 'string') return false
    let line = text.trim()
    if (!line.startsWith('/#hotplug')) return false
    let tail = line.slice('/#hotplug'.length).trim()
    if (tail.startsWith('```')) tail = tail.replace(/^```(?:\w+)?\s*/, '').replace(/```$/, '').trim()
    const parts = tokenize(tail)
    const sub = (parts[0] || '').toLowerCase()
    try {
      const result = await runSub(sub, parts, service)
      log('INFO', 'hotplug.cmd.exec', '/#hotplug ' + sub, { cmd: sub, args: parts.slice(1) })
      try { reply('[Hotplug] /#hotplug ' + sub + '\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```') } catch (_) {}
    } catch (err) {
      log('ERROR', 'hotplug.cmd.err', `/#hotplug ${sub} 失败: ${_msg(err)}`, { cmd: sub, args: parts.slice(1), code: err && err.code })
      try { reply('[Hotplug Error] /#hotplug ' + sub + '\n\n' + _msg(err)) } catch (_) {}
    }
    return true
  }

  const attach = (agent) => {
    if (!agent || agent.__hotplugWrapped) return
    try {
      if (typeof agent.on === 'function') {
        agent.on('message', async (evt) => {
          try {
            const t = evt && (evt.content || evt.text || (evt.message && evt.message.content) || (typeof evt === 'string' ? evt : null))
            if (!t) return
            const reply = (outText) => {
              if (agent && typeof agent.send === 'function') {
                agent.send({ id: 'hotplug-cmd-' + Date.now(), role: 'assistant', content: [{ type: 'text', text: outText }], source: { kind: 'plugin', plugin: '@local/dsh-adapter' } }, 'notification', true)
              }
            }
            await handle(t, reply)
          } catch (_) { /* 单条消息处理失败不拖垮 agent */ }
        })
      }
    } catch (_) {}
    try { agent.__hotplugWrapped = true } catch (_) {}
  }

  try {
    if (typeof ag.values === 'function') { for (const a of ag.values()) attach(a) }
    else if (typeof ag.forEach === 'function') { ag.forEach((a) => attach(a)) }
    else if (Array.isArray(ag)) { for (const a of ag) attach(a) }
  } catch (_) {}
  try { ag.on('create', attach) } catch (_) {}
  try { ag.on('agent:create', attach) } catch (_) {}

  log('INFO', 'hotplug.cmd.installed', '/#hotplug 命令钩子已安装')
  return { installed: true }
}
