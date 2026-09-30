// Host：邮件桥静态化 @local/email-bridge
// 功能：接收邮件任务（白名单校验）→ 类型映射转派（插件开发→流水线 / 写作→创作教练 / 邮件任务→邮件任务执行 / 杂项→插件工坊）
//       + 重启窗口补扫补派（收件先落盘 inbox.json status=pending，启动 scanPending 补扫；按 from|subject 去重）
// 模式：参照 @local/taskkit 已验证静态插件（export function apply(ctx, config) + export { inject }）
import { defineTool } from '@deepseek-ai/dsh-tools'

const inject = [
  'tools',
  'fs',
  'sandboxPolicy',
  'sessionQuery',
  'agents',
  'workspaceRegistry',
  'webServer'
]

// 数据根口径（O5 迁移）：根名由 adapter 部署 config 登记（`dsh-bundle-patch.yml` 的 `roots.写作训练`），
// 插件只持"根内相对引用"，不再硬编码盘符路径、不再做根路径字符串拼接，也不再传隐式 cwd（G2 消除）。
const EB_ROOT = '写作训练'
const BOARD_REL = '任务看板.json'
const INBOX_REL = '邮件桥/inbox.json'
const STATE_REL = '邮件桥/邮件桥状态.json'

const DEFAULT_CONFIG = {
  whitelist: ['dev@example.com'],
  // 附件目录：**不再硬编码盘符**——缺省由 adapter 登记根解析（`写作训练` + `邮件附件`，见 attachmentRootPath()）；
  // 部署如需覆写，在 config 里显式给 attachmentRoot（绝对路径）
  mapping: {
    '插件开发': '插件开发·实施',
    '写作': '创作教练',
    '邮件任务': '邮件任务执行',
    default: '插件工坊'
  },
  dedupe: true,
  dedupeTtlMs: 3600000,
  // 每日任务邮件提醒（创作教练每日任务自动发送）
  dailyReminder: {
    enabled: true, // 已修复防重复+解析+SMTP，正式启用
    recipient: 'dev@example.com',
    // sendAfterMinutes: 启动后多少分钟首发（0=立即）；每日定时用每日时间 HH:MM（本地）
    startDelayMinutes: 0,
    dailyTime: '08:00',
    checkIntervalMinutes: 60,
    coachSession: 'session-1e2cf8b6-31f8-4784-ae48-9c64cbd92da3',
    // 2026-09-22：SMTP 凭据改为**环境变量注入**（原为明文硬编码在源码里，见迁移计划安全待办）。
    // 取值：EMAIL_BRIDGE_SMTP_{HOST,PORT,SECURE,USER,PASS}。
    // 未设 user/pass ⇒ sendMail 明确拒绝并报错（fail-closed），不再退回硬编码凭据。
    smtp: {
      host: process.env.EMAIL_BRIDGE_SMTP_HOST || 'smtp.126.com',
      port: Number(process.env.EMAIL_BRIDGE_SMTP_PORT || 465),
      secure: String(process.env.EMAIL_BRIDGE_SMTP_SECURE || 'true') !== 'false',
      auth: {
        user: process.env.EMAIL_BRIDGE_SMTP_USER || '',
        pass: process.env.EMAIL_BRIDGE_SMTP_PASS || '',
      },
    }
  }
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config || {})
  // fs 面统一经 adapterFs（一期标准接口）：相对引用解析到登记根，默认直读盘、写后自动失效；
  // 同时消除 legacy 的隐式 cwd 锚点（G2：空字符串 cwd 会退化为宿主 process.cwd() 的相对解析，与业务数据根无关）。
  const adapterFs = ctx.get('adapterFs')
  if (!adapterFs) {
    const _m = '[email-bridge] adapterFs 不可用：fs 面已按 O5 迁移到 adapterFs，本插件将无法读写看板/inbox/状态（请确认 profile bundles 中 @local/dsh-adapter 已加载）'
    try { const lg = ctx.get('logger'); if (lg && typeof lg.warn === 'function') lg.warn(_m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(_m + '\n') } catch (_) {}
  }
  const agents = ctx.get('agents')
  const webServer = ctx.get('webServer')

  // ============ 数据读写（经 adapterFs：根名 + 根内相对引用；默认直读，写后自动失效） ============
  async function readJson(rel, fallback) {
    return adapterFs.readJson(EB_ROOT, rel, { fallback })
  }
  async function writeJson(rel, data) {
    await adapterFs.writeJson(EB_ROOT, rel, data)
  }
  async function readBoard() { return readJson(BOARD_REL, { tasks: [] }) }
  async function writeBoard(b) { return writeJson(BOARD_REL, b) }
  async function readInbox() { return readJson(INBOX_REL, { version: 1, items: [] }) }
  async function writeInbox(x) { return writeJson(INBOX_REL, x) }
  // 共享状态（与补扫/每日提醒共用持久化）：lastScanTime / lastReminderDate / processedKeys
  async function readState() { return readJson(STATE_REL, { version: 1, lastScanTime: null, lastReminderDate: null, processedKeys: [] }) }
  async function writeState(s) { return writeJson(STATE_REL, s) }

  function mapTarget(subject, body) {
    const text = (subject || '') + ' ' + (body || '')
    const mapping = cfg.mapping || {}
    for (const k of Object.keys(mapping)) {
      if (k !== 'default' && text.indexOf(k) >= 0) return mapping[k]
    }
    return mapping.default || '插件工坊'
  }
  function keyOf(from, subject) { return from + '|' + (subject || '').trim() }

  // 目录前置（G6：adapterFs 无 ensureDir/mkdir 能力）——沿用 legacy 语义：幂等建目录（recursive）；
  // 路径本身经 adapterFs 解析到登记根（不再硬编码盘符/不再传 cwd）
  async function ensureDirs() {
    try {
      const { mkdir } = await import('node:fs/promises')
      const dir = await adapterFs.resolve(EB_ROOT, '邮件桥')
      await mkdir(dir.displayPath, { recursive: true })
    } catch (e) {}
  }

  // ============ resume 带 preset setup（2026-09-07 根治：裸 resume 丢 preset 工具层）============
  // 现象：宿主每次启动后创作教练的 web_search/read/pwsh 等 preset 层工具消失，调用报
  // UNKNOWN_TOOL unknown tool "web_search"。根因：email-bridge 每日提醒用 agents.resume 唤醒会话
  // 时未传 setup → agent 只挂宿主全局层工具（~61 个 @local 插件工具），agent preset（cordis/
  // standard/minimal）的 scope 层从未 mount；该坏 agent 创建后常驻 live，后续所有请求（含用户
  // 对话）都挂在它上面。宿主 api-proxy 正规路径（ensureSession/composeAgent）与 taskkit
  // （presetMountSetupFor，见 taskkit lib L829-878 同款修复注释）都会在 resume 时 mount preset。
  // 修复：resume 前解析会话当前 preset（selected 事件优先、header 兜底，与官方
  // dsh-agent-presets resolveSessionPreset 语义一致），把 preset mount 进 setup 回调。
  async function resumeAgentWithPreset(sessionId) {
    const agentsSvc = ctx.get('agents')
    if (!agentsSvc || typeof agentsSvc.resume !== 'function') return { agent: null }
    // 1) 解析该会话当前 preset id
    let presetId = null
    try {
      const sq = ctx.get('sessionQuery')
      if (sq && typeof sq.readSession === 'function') {
        const snap = await Promise.race([sq.readSession(sessionId), new Promise(function (r) { setTimeout(function () { r(null) }, 6000) })])
        const evs = snap && Array.isArray(snap.events) ? snap.events : []
        for (let i = evs.length - 1; i >= 0; i--) {
          const ev = evs[i]
          if (ev && ev.type === 'agent-preset/selected' && ev.data && typeof ev.data.agentPreset === 'string' && ev.data.agentPreset) { presetId = ev.data.agentPreset; break }
        }
        if (!presetId && snap && snap.header && typeof snap.header.agentPreset === 'string') presetId = snap.header.agentPreset
      }
    } catch (e) {}
    // 2) 构造 setup：agent 发布前把 preset 组合 mount 到其 scope（与 api-proxy composeAgent 等价）
    let setup
    try {
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.mount === 'function' && presetId) {
        setup = async function (agentCtx) {
          const resolved = await presets.resolve(presetId)
          await presets.mount(agentCtx, resolved.id)
        }
      }
    } catch (e) { setup = undefined }
    // 3) resume（带 setup 时挂 preset；不带时行为与裸 resume 一致）
    const opts = { resumeSessionId: sessionId, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
    if (setup) opts.setup = setup
    try {
      const handle = await Promise.race([agentsSvc.resume(opts), new Promise(function (r) { setTimeout(function () { r(null) }, 8000) })])
      return { agent: handle && handle.agent ? handle.agent : null }
    } catch (e) { return { agent: null } }
  }

  async function dispatchTask(item) {
    const from = String(item.from || '').trim()
    const subject = String(item.subject || '').trim()
    const body = String(item.body || '')
    const whitelist = cfg.whitelist || []
    if (whitelist.length && whitelist.indexOf(from) < 0) return { ok: false, error: '不在白名单', from }

    const targetTitle = mapTarget(subject, body)
    const now = new Date().toISOString()
    const board = await readBoard()
    const taskId = 'task-mail-' + String(Date.now()).slice(-6) + '-' + Math.floor(Math.random() * 90 + 10)
    const task = {
      id: taskId,
      title: '📧 ' + (subject || '邮件任务'),
      requirement: body || '（无正文）',
      project: '邮件桥',
      status: '待执行',
      owner: targetTitle,
      assignedSession: null,
      note: '来源=' + from + ' | 类型=' + targetTitle,
      ackPolicy: 'auto',
      createdAt: now,
      updatedAt: now
    }
    board.tasks = board.tasks || []
    board.tasks.unshift(task)
    await writeBoard(board)
    // ============ 对话队列投递（2026-08-26 修复邮件调度） ============
    // 问题根因：邮件任务只写看板(待执行)依赖调度器派发，但调度器 guardRunning 会因任务中心
    // 有执行中任务而 skip（任务中心是分配器，不应被单任务执行中串行化阻塞）。
    // 修复：直接 agent.send 投递到任务中心会话（对话队列天然支持多消息排队），
    // 任务中心作为分配器收到消息后自行转派；任务标记 assignedSession=任务中心+执行中，
    // 表示已进入分配队列（receiptScanner 可扫回执闭环）。
    let delivered = false
    try {
      const agents = ctx.get('agents')
      const taskcenterId = 'session-0e4ee8e5-afd1-4197-9290-f31dfc87a680'
      let agent = agents ? agents.get(taskcenterId) : null
      if (!agent && agents && typeof agents.resume === 'function') {
        const woke = await resumeAgentWithPreset(taskcenterId)
        if (woke && woke.agent) agent = woke.agent
      }
      if (agent && typeof agent.send === 'function') {
        const text = '📮 [任务中心] 邮件任务开始执行：' + (subject || '邮件任务') + '\n来源：' + from + '\n类型：' + targetTitle + '\n任务ID：' + taskId + '\n\n【任务内容】\n' + (body || '（无正文）') + '\n\n请识别任务类型并转派给合适执行者（写作→创作教练 / 插件开发→流水线 / 邮件任务→邮件任务执行 / 杂项→插件工坊）。'
        agent.send({ id: 'tsk-msg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'plugin', plugin: 'email-bridge' } }, 'next-turn', true)
        delivered = true
      }
    } catch (e) { delivered = false }
    if (delivered) {
      // 已投递分配器 → 置执行中+assignedSession=任务中心（receiptScanner 可闭环）
      const fresh = await readBoard()
      const t = fresh.tasks.find(function (x) { return x.id === taskId })
      if (t) { t.status = '执行中'; t.assignedSession = 'session-0e4ee8e5-afd1-4197-9290-f31dfc87a680'; t.startedAt = now; t.note = t.note + ' | 对话队列投递任务中心' }
      await writeBoard(fresh)
    }
    return { ok: true, taskId: taskId, target: targetTitle, delivered: delivered }
  }

  async function processItem(item) {
    if (!item || item.status === 'processed') return { ok: true, skipped: true }
    const key = keyOf(item.from, item.subject)
    // 去重：同主题已处理过则跳过
    if (cfg.dedupe) {
      const inbox = await readInbox()
      const dup = inbox.items.some(function (x) { return x.status === 'processed' && keyOf(x.from, x.subject) === key })
      if (dup) {
        // 修复 F5：dedupe 分支必须把 processed+skipped 状态写回 inbox，
        // 否则该 item 在 inbox.json 中悬挂 pending，反复补扫且无副作用记录
        item.status = 'processed'
        item.processedAt = new Date().toISOString()
        item.skipped = true
        item.result = { ok: true, skipped: true, reason: 'dedupe' }
        const inbox2 = await readInbox()
        const idx2 = inbox2.items.findIndex(function (x) { return x.id === item.id })
        if (idx2 >= 0) inbox2.items[idx2] = item; else inbox2.items.unshift(item)
        await writeInbox(inbox2)
        return { ok: true, skipped: true, reason: 'dedupe' }
      }
    }
    const r = await dispatchTask(item)
    item.status = r.ok ? 'processed' : 'failed'
    item.processedAt = new Date().toISOString()
    item.result = r
    // 写回 inbox
    const inbox = await readInbox()
    const idx = inbox.items.findIndex(function (x) { return x.id === item.id })
    if (idx >= 0) inbox.items[idx] = item; else inbox.items.unshift(item)
    await writeInbox(inbox)
    return r
  }

  // 补扫：插件启动时处理关闭窗口积压的 pending 邮件
  async function scanPending() {
    const inbox = await readInbox()
    for (const item of inbox.items) {
      if (item.status !== 'pending') continue
      try { await processItem(item) } catch (e) {}
    }
  }

  async function handleIncoming(payload) {
    await ensureDirs()
    const atts = Array.isArray(payload && payload.attachments)
      ? payload.attachments.map(function (a) {
        return { name: String(a && a.name || ''), type: String(a && (a.type || a.contentType) || ''), path: String(a && a.path || ''), size: Number(a && (a.size || a.sizeBytes) || 0) }
      })
      : []
    const item = {
      id: 'mail-' + String(Date.now()).slice(-6) + '-' + Math.floor(Math.random() * 1e4),
      from: String(payload.from || '').trim(),
      subject: String(payload.subject || '').trim(),
      body: String(payload.body || ''),
      mailId: String(payload.mailId || '').trim(),
      attachments: atts,
      receivedAt: new Date().toISOString(),
      status: 'pending'
    }
    const inbox = await readInbox()
    inbox.items.unshift(item)
    await writeInbox(inbox)
    return processItem(item)
  }

  // ============ 创作教练每日任务邮件提醒（含防重复） ============
  // 触发：DSH 启动后（startDelayMinutes）或每日定时（dailyTime）
  // 防重复：state.lastReminderDate=YYYY-MM-DD，当日已发则跳过（不唤醒、不发信）
  function localDateKey(d) {
    const x = d || new Date()
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
  }

  async function sendMail(to, subject, text) {
    // 2026-09-22：原为**绝对路径**动态 import（`file:///C:/Users/<user>/AppData/Local/Temp/...`，
    // 连用户名都写死 ⇒ 换机器即断）。改为**常规依赖解析**：在 profile 里正常安装 nodemailer 即可。
    // 过渡期保留 MAILBRIDGE_NODEMAILER 显式覆盖，便于本机已有该包时直接指向其入口。
    let nodemailer = null
    const explicitNodemailer = String(process.env.MAILBRIDGE_NODEMAILER || '').trim()
    try { nodemailer = (await import(explicitNodemailer || 'nodemailer')).default } catch (e) { nodemailer = null }
    if (!nodemailer) return { ok: false, error: 'nodemailer 不可用（请在本 profile 安装 nodemailer，或用 MAILBRIDGE_NODEMAILER 指向其入口）' }
    const smtp = (cfg.dailyReminder && cfg.dailyReminder.smtp) || {}
    const auth = smtp.auth || {}
    if (!auth.user || !auth.pass) {
      return { ok: false, error: 'SMTP 凭据未配置：请设 EMAIL_BRIDGE_SMTP_USER / EMAIL_BRIDGE_SMTP_PASS 环境变量' }
    }
    try {
      const transporter = nodemailer.createTransport({ host: smtp.host || 'smtp.126.com', port: smtp.port || 465, secure: smtp.secure !== false, auth: { user: auth.user, pass: auth.pass } })
      await transporter.sendMail({ from: auth.user, to: to, subject: subject, text: text })
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  }

  // 唤醒创作教练并取「今日写作任务」（复用其查询能力：看板+日程/训练计划）
  async function fetchCoachTodayPlan() {
    const dr = cfg.dailyReminder || {}
    const coachId = dr.coachSession || 'session-1e2cf8b6-31f8-4784-ae48-9c64cbd92da3'
    const agentsSvc = ctx.get('agents')
    if (!agentsSvc) return { ok: false, error: 'agents 服务不可用', plan: '' }
    try {
      let coach = agentsSvc.get(coachId)
      if (!coach) {
        const woke = await resumeAgentWithPreset(coachId)
        if (woke && woke.agent) coach = woke.agent
      }
      if (!coach || typeof coach.send !== 'function') return { ok: false, error: '创作教练不可用', plan: '' }
      // 请求当日计划（只 send 一次；循环内只读事件不重复唤醒，避免骚扰教练）
      const reqId = 'dr-' + Date.now()
      await coach.send({ id: reqId, role: 'user', content: [{ type: 'text', text: '📮 [邮件提醒] 请输出今天的写作任务/训练计划清单（标题/要求/截止/状态），简短即可，用于自动邮件提醒。' }], source: { kind: 'plugin', plugin: 'email-bridge' } }, 'next-turn', true)
      // 等待后从会话表面取最近 assistant 文本（readSurface 返回 {events:[{type,data:{content:[{type:'text',text}]}}]}，taskkit receiptScanner 同款解析）
      const sessionQuery = ctx.get('sessionQuery')
      let plan = ''
      if (sessionQuery && typeof sessionQuery.readSurface === 'function') {
        for (let i = 0; i < 6; i++) {
          await new Promise(function (r) { setTimeout(r, 10000) })
          try {
            const snap = await sessionQuery.readSurface(coachId)
            const text = extractSurfaceEventsText(snap)
            if (text) { plan = text; break }
          } catch (e) {}
        }
      }
      if (!plan) return { ok: false, error: '创作教练无回复', plan: '' }
      return { ok: true, plan: plan }
    } catch (e) { return { ok: false, error: String(e && e.message || e), plan: '' } }
  }

  function extractSurfaceEventsText(snap) {
    // snap.events[] 每条 {type, data:{content:[{type:'text',text}]}} —— 与 taskkit receiptScanner 解析一致
    try {
      const events = snap && Array.isArray(snap.events) ? snap.events : []
      for (let e = events.length - 1; e >= 0; e--) {
        const ev = events[e]
        if (!ev) continue
        const content = ev.data && (ev.data.content || (ev.data.message && ev.data.message.content))
        let text = ''
        if (Array.isArray(content)) {
          for (let c = 0; c < content.length; c++) {
            const block = content[c]
            if (block && block.type === 'text' && typeof block.text === 'string') text += block.text + '\n'
          }
        } else if (typeof content === 'string') text = content
        if (text && text.trim() && text.indexOf('📮 [邮件提醒]') < 0) return text.trim()
      }
      return ''
    } catch (e) { return '' }
  }

  // 每日提醒主逻辑：防重复 → 唤醒教练 → 发送
  async function dailyReminder() {
    const dr = cfg.dailyReminder || {}
    if (!dr.enabled) return { ok: false, skipped: true, reason: 'dailyReminder 未启用' }
    return dailyReminderForce()
  }

  // 强制版本（诊断/手动触发用；保留防重复 lastReminderDate 检查）
  async function dailyReminderForce(opts) {
    opts = opts || {}
    try {
      await ensureDirs()
      const state = await readState()
      const today = localDateKey()
      if (state.lastReminderDate === today) return { ok: true, skipped: true, reason: '今日已发送（lastReminderDate=' + today + '）' }
      // 每日定时：未到 dailyTime 不发（forceSend=true 诊断可绕过；正常定时路径遵守）
      const dr = cfg.dailyReminder || {}
      if (!(opts.forceSend === true)) {
        const dailyTime = dr.dailyTime || '08:00'
        const hm = String(dailyTime).split(':')
        const nowD = new Date()
        const curMin = nowD.getHours() * 60 + nowD.getMinutes()
        const targetMin = (parseInt(hm[0], 10) || 8) * 60 + (parseInt(hm[1], 10) || 0)
        if (curMin < targetMin) return { ok: true, skipped: true, reason: '未到每日发送时间 ' + dailyTime }
      }
      // 唤醒创作教练取当日计划
      const r = await fetchCoachTodayPlan()
      if (!r.ok || !r.plan) {
        state.lastError = { at: new Date().toISOString(), error: r.error || '无今日任务', planEmpty: true }
        await writeState(state)
        return { ok: false, reason: '无可用计划：' + (r.error || '空'), noSend: true }
      }
      const recipient = dr.recipient || 'dev@example.com'
      const subject = '📮 今日写作任务提醒 ' + today
      const text = '【今日写作任务 · ' + today + '】\n\n' + r.plan
      const s = await sendMail(recipient, subject, text)
      if (s.ok) {
        state.lastReminderDate = today
        state.lastReminderAt = new Date().toISOString()
        state.lastError = null
        await writeState(state)
        return { ok: true, sent: true, date: today }
      } else {
        state.lastError = { at: new Date().toISOString(), error: 'smtp: ' + (s.error || '') }
        await writeState(state)
        return { ok: false, reason: 'smtp 发送失败：' + (s.error || '') }
      }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  }

  // 启动提醒：立即（或延迟）+ 定时检查
  function scheduleDailyReminder() {
    const dr = cfg.dailyReminder || {}
    if (!dr.enabled) return
    const delayMs = (dr.startDelayMinutes || 0) * 60000
    const timer1 = setTimeout(function () { dailyReminder().catch(function () {}) }, Math.max(3000, delayMs))
    const intervalMs = Math.max(10, (dr.checkIntervalMinutes || 60)) * 60000
    const timer2 = setInterval(function () { dailyReminder().catch(function () {}) }, intervalMs)
    ctx.effect(function () { return function () { clearTimeout(timer1); clearInterval(timer2) } })
  }

  // 注册工具（disposer 包进 ctx.effect，reload/卸载时自动解注册）
  const toolsSvc = ctx.get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    ctx.effect(function () {
      return toolsSvc.register(defineTool({
        name: 'eb_incoming',
        description: '邮件桥接收入口：白名单校验 + 类型映射 + 落盘 + 转派；支持补扫；可携带 mailId/attachments（附件清单，供 inbox 记录与后续读取）',
        parameters: { from: { type: 'string', required: true }, subject: { type: 'string' }, body: { type: 'string' }, mailId: { type: 'string' }, attachments: { type: 'array', items: { type: 'object', additionalProperties: true } } },
        output: { schema: { type: 'object', additionalProperties: true }, render: function (args, value) { return [{ type: 'text', text: (value && value.summary) ? value.summary : JSON.stringify(value) }] }, presentationMeta: function (args, value) { return value || {} } },
        execute: async function (args) { return handleIncoming(args || {}) }
      }))
    })
  }

  // HTTP 入口（route 注册返回 disposer，包进 ctx.effect 以便 reload/卸载时自动清理，避免 duplicate route）
  if (webServer && typeof webServer.register === 'function') {
    const handler = async function (req, res) {
      const send = function (status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
      let body = ''; try { for await (const c of req) body += c } catch (e) {}
      let payload = {}; try { payload = body ? JSON.parse(body) : {} } catch (e) { return send(400, { ok: false, error: 'bad json' }) }
      try { const r = await handleIncoming(payload); send(r.ok ? 200 : 403, r) } catch (e) { send(500, { ok: false, error: String(e && e.message || e) }) }
    }
    ctx.effect(function () { return webServer.register({ kind: 'exact', path: '/email-bridge/api/incoming', handler: handler }) })
    // 诊断端点：手动触发每日提醒（验证链路；force=true 绕过 enabled 开关）
    const drHandler = async function (req, res) {
      const send = function (status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
      try {
        let body = ''; try { for await (const c of req) body += c } catch (e) {}
        let payload = {}; try { payload = body ? JSON.parse(body) : {} } catch (e) {}
        const force = !!(payload && payload.force)
        const state = await readState()
        const r = force ? await dailyReminderForce({ forceSend: true }) : await dailyReminder()
        send(200, { result: r, state: state })
      } catch (e) { send(500, { ok: false, error: String(e && e.message || e) }) }
    }
    ctx.effect(function () { return webServer.register({ kind: 'exact', path: '/email-bridge/api/reminder', handler: drHandler }) })
    // ============ 附件读取接口（mailbridge 落盘 附件清单.json 后供后续任务/HTTP 读取） ============
    // 附件目录（node:fs 直读边界：流式回传需 createReadStream，adapterFs 无流 API）：
    // 显式 config.attachmentRoot 优先；缺省经 adapter 登记根解析（替代旧硬编码盘符默认值）
    async function attachmentRootPath() {
      if (cfg.attachmentRoot) return String(cfg.attachmentRoot)
      const r = await adapterFs.resolve(EB_ROOT, '邮件附件')
      return r.displayPath
    }
    // GET /email-bridge/api/attachments?mailId=<id> → 该邮件附件清单；无参 → 全部邮件附件清单
    const attHandler = async function (req, res) {
      const send = function (status, obj) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)) }
      try {
        const u = new URL(req.url, 'http://localhost')
        const mailId = (u.searchParams.get('mailId') || '').trim()
        const attFs = (await import('node:fs')).default
        const attPath = (await import('node:path')).default
        const attachmentRoot = await attachmentRootPath()
        if (!mailId) {
          // 无参：扫描 attachmentRoot 下列出全部 mailId 与各自清单
          const list = []
          try {
            const dirs = await attFs.promises.readdir(attachmentRoot, { withFileTypes: true })
            for (const d of dirs) {
              if (!d.isDirectory()) continue
              const mf = attPath.join(attachmentRoot, d.name, '附件清单.json')
              try {
                const mj = JSON.parse(await attFs.promises.readFile(mf, 'utf8'))
                list.push({ mailId: d.name, path: mf.replace(/\\/g, '/'), attachments: (mj && mj.attachments) || [], manifest: mj })
              } catch (e) {}
            }
          } catch (e) {}
          return send(200, { ok: true, count: list.length, items: list })
        }
        // 防路径穿越：mailId 只允许 mail-xxx 形式
        if (!/^mail-[A-Za-z0-9_.-]+$/.test(mailId)) return send(400, { ok: false, error: 'invalid mailId' })
        const mf = attPath.join(attachmentRoot, mailId, '附件清单.json')
        let manifest = null
        try { manifest = JSON.parse(await attFs.promises.readFile(mf, 'utf8')) } catch (e) {}
        if (!manifest) return send(404, { ok: false, error: 'not found', mailId: mailId })
        return send(200, { ok: true, mailId: mailId, path: mf.replace(/\\/g, '/'), attachments: manifest.attachments || [], manifest: manifest })
      } catch (e) { send(500, { ok: false, error: String(e && e.message || e) }) }
    }
    ctx.effect(function () { return webServer.register({ kind: 'exact', path: '/email-bridge/api/attachments', handler: attHandler }) })
    // GET /email-bridge/api/attachments/file?mailId=<id>&name=<file> → 按清单校验 name（防路径穿越）后流式回传
    const attFileHandler = async function (req, res) {
      try {
        const u = new URL(req.url, 'http://localhost')
        const mailId = (u.searchParams.get('mailId') || '').trim()
        const name = (u.searchParams.get('name') || '').trim()
        if (!/^mail-[A-Za-z0-9_.-]+$/.test(mailId)) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'invalid mailId' })) }
        if (!name) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'missing name' })) }
        const attFs = (await import('node:fs')).default
        const attPath = (await import('node:path')).default
        const attachmentRoot = await attachmentRootPath()
        const mf = attPath.join(attachmentRoot, mailId, '附件清单.json')
        let manifest = null
        try { manifest = JSON.parse(await attFs.promises.readFile(mf, 'utf8')) } catch (e) {}
        if (!manifest) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'not found' })) }
        // 只允许清单内已保存的条目（防路径穿越 + 防未落盘）
        const hit = (manifest.attachments || []).find(function (a) { return a.saved === true && a.name === name })
        if (!hit) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'attachment not in manifest' })) }
        // 再次确保解析后仍在 attachmentRoot 内（belt-and-braces）
        const fileAbs = attPath.resolve(attachmentRoot, mailId, hit.name)
        const rootAbs = attPath.resolve(attachmentRoot)
        if (!fileAbs.startsWith(rootAbs)) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'path traversal denied' })) }
        const ext = attPath.extname(hit.name).toLowerCase()
        const mimeMap = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.zip': 'application/zip' }
        const contentType = mimeMap[ext] || 'application/octet-stream'
        const encoded = encodeURIComponent(hit.name)
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
          'Content-Length': hit.sizeBytes || 0,
          'Access-Control-Allow-Origin': '*'
        })
        attFs.createReadStream(fileAbs).pipe(res)
      } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) })) }
    }
    ctx.effect(function () { return webServer.register({ kind: 'exact', path: '/email-bridge/api/attachments/file', handler: attFileHandler }) })
  }

  // 启动补扫
  setTimeout(function () { scanPending().catch(function () {}) }, 2000)
  ctx.effect(function () { return function () { clearTimeout() } })

  // 启动每日任务邮件提醒（含防重复）
  scheduleDailyReminder()

  // ============ 方案B(2026-08-26)：自动拉起 mailbridge 独立进程 ============
  // mailbridge.js 负责 IMAP 30s 轮询收信 + SMTP 回发（独立进程，宿主重启后不会自动恢复）
  // 本插件启动时检测 mailbridge 进程：未运行则 spawn 拉起；运行中则跳过（防重复）
  // 用 execSync 查询进程 + spawn 启动；失败静默（不阻断插件主流程）
  // 看门狗(2026-09-02)：mailbridge 进程两次消失导致邮件未达（进程崩溃/被杀后无自动恢复）——
  // 提取 detectMailbridgeRunning() + spawnMailbridge()，宿主存活期间每 60s 周期复核，缺失自动拉起
  // 2026-09-22 跨平台化：路径不再写死盘符；进程检测不再调用 PowerShell（详见下方 detectMailbridgePids）。
  const MAILBRIDGE_WIN_ROOT = 'E:/DSH工作区' // linux-ready-exempt: 有意保留的 Windows 历史默认值（仅在未设 DSH_WORKSPACE_ROOT 时生效；Linux 由 setup.sh 注入）
  const MAILBRIDGE_WS_ROOT = String((process.env.DSH_WORKSPACE_ROOT || '').trim() || MAILBRIDGE_WIN_ROOT).replace(/[\\/]+$/, '')
  const MAILBRIDGE_DIR = String((process.env.MAILBRIDGE_DIR || '').trim() || (MAILBRIDGE_WS_ROOT + '/DSH工具/mailbridge')).replace(/[\\/]+$/, '')
  const MAILBRIDGE_SCRIPT = MAILBRIDGE_DIR + '/mailbridge.js'
  const MAILBRIDGE_CWD = MAILBRIDGE_DIR
  // 状态文件：记录"本插件拉起的那个 mailbridge"的 PID。宿主重启后句柄会丢，靠它 + process.kill(pid,0) 认回来。
  const MAILBRIDGE_STATE = MAILBRIDGE_DIR + '/mailbridge.state.json'
  let mailbridgeChild = null

  function pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (e) { return !!(e && e.code === 'EPERM') }
  }
  async function readRecordedPid() {
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      if (!existsSync(MAILBRIDGE_STATE)) return null
      const j = JSON.parse(readFileSync(MAILBRIDGE_STATE, 'utf8'))
      return j && Number.isFinite(j.pid) ? j.pid : null
    } catch (_) { return null }
  }
  async function writeRecordedPid(pid, note) {
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(MAILBRIDGE_STATE, JSON.stringify({ pid, at: new Date().toISOString(), by: 'email-bridge-plugin', note: note || '' }), 'utf8')
    } catch (_) {}
  }
  /**
   * 枚举 mailbridge 进程（**不调用任何 shell**）。
   * Linux：读 /proc/<pid>/cmdline（纯 node:fs）。
   * Windows/macOS：返回 null = **无法枚举**（不看 PowerShell/WMI）。调用方据此明确告警，而不是静默跳过。
   */
  async function enumerateMailbridgePids() {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      try {
        const { readdirSync, readFileSync } = await import('node:fs')
        const out = []
        for (const name of readdirSync('/proc')) {
          if (!/^\d+$/.test(name)) continue
          try {
            const cmd = readFileSync('/proc/' + name + '/cmdline', 'utf8')
            if (cmd.indexOf('mailbridge') >= 0) out.push(parseInt(name, 10))
          } catch (_) { /* 进程刚退出或无权读，跳过 */ }
        }
        return out
      } catch (_) { return null }
    }
    return null
  }
  /**
   * 返回存活 mailbridge PID 数组。判据顺序（从最可靠到最弱）：
   *   ① 本宿主持有的子进程句柄（同一生命周期内最可靠，且**不会误杀同名进程**）
   *   ② 状态文件记录的 PID + process.kill(pid,0)（宿主重启后认回自己拉起的那一个）
   *   ③ 平台枚举（Linux /proc）
   *   ④ 都无法判定 ⇒ 返回 **空数组**（不再用 null 表示"检测失败"：那会让 Windows 上永远不 spawn，
   *      是比误判更糟的静默失效）。调用方在"无证据却要 spawn"时会明确告警。
   * 2026-09-03 根治的背景保留：多实例并发轮询同一 IMAP + 写同一看板 → 竞态丢邮件任务。
   */
  async function detectMailbridgePids() {
    if (mailbridgeChild && mailbridgeChild.exitCode === null && !mailbridgeChild.killed) return [mailbridgeChild.pid]
    const recorded = await readRecordedPid()
    if (recorded && pidAlive(recorded)) return [recorded]
    const enumerated = await enumerateMailbridgePids()
    if (enumerated) return enumerated
    return []
  }
  async function spawnMailbridge() {
    try {
      const { spawn } = await import('node:child_process')
      const nodeBin = process.execPath
      const child = spawn(nodeBin, [MAILBRIDGE_SCRIPT], {
        cwd: MAILBRIDGE_CWD,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      // 持有句柄（宿主存活期间判活/终止都用它，不再查进程表）；同时落状态文件供宿主重启后认回。
      mailbridgeChild = child
      child.on('exit', function () { if (mailbridgeChild === child) mailbridgeChild = null })
      await writeRecordedPid(child.pid, 'spawned')
      return true
    } catch (e) { return false }
  }
  async function ensureMailbridgeProcess() {
    try {
      const { existsSync, writeFileSync } = await import('node:fs')
      if (!existsSync(MAILBRIDGE_SCRIPT)) return false
      const pids = await detectMailbridgePids()
      if (pids.length === 1) return true // 正常单实例
      if (pids.length > 1) {
        // 多实例并发轮询同一 IMAP + 写同一看板 → 竞态丢任务（2026-09-03 现场）。保留一个，终止其余。
        // 2026-09-22：不再用 PowerShell/Stop-Process，改 process.kill（跨平台）；保留对象优先取我们自己记录过的 PID。
        try {
          const recorded = await readRecordedPid()
          const keep = (recorded && pids.indexOf(recorded) >= 0) ? recorded : pids.slice().sort(function (a, b) { return a - b })[0]
          let killed = 0
          for (const p of pids) {
            if (p === keep) continue
            try { process.kill(p, 'SIGTERM'); killed++ } catch (_) {}
          }
          await writeRecordedPid(keep, 'watchdog-converged')
          // 保留 mailbridge 自己的锁文件契约（外部脚本可能读它），内容与改造前一致。
          try { writeFileSync(MAILBRIDGE_DIR + '/mailbridge.lock', JSON.stringify({ pid: keep, startedAt: new Date().toISOString(), note: 'watchdog-converged' }), 'utf8') } catch (_) {}
          try { ctx.get('logger') && ctx.get('logger').warn('[email-bridge] mailbridge 多实例收敛: 保留 PID=' + keep + '，终止 ' + killed + ' 个重复实例') } catch (_) {}
        } catch (e) {
          try { ctx.get('logger') && ctx.get('logger').warn('[email-bridge] mailbridge 多实例收敛失败: ' + (e && e.message || e)) } catch (_) {}
        }
        return true
      }
      // 0 个 → 拉起。但**无法枚举**的平台（Windows/macOS，已不再调 PowerShell）且无记录时，
      // 我们无法排除"已有未知实例" ⇒ 明确告警再 spawn，不静默假设"没有"。
      if (process.platform === 'win32' || process.platform === 'darwin') {
        try { ctx.get('logger') && ctx.get('logger').warn('[email-bridge] 本平台无法枚举 mailbridge 进程（已不再调用外部命令查询进程表）：重复实例检测不可用，仅按「子进程句柄 + 状态文件」判活') } catch (_) {}
      }
      // 0 个 → spawn 拉起（detached 防宿主退出连带终止；stdio 忽略，日志由 mailbridge.js 自持 mailbridge-bridge.log）
      const ok = await spawnMailbridge()
      // 启动后延迟复核一次
      setTimeout(async function () {
        try {
          const after = await detectMailbridgePids()
          if (after && after.length >= 1) {
            try { ctx.get('logger') && ctx.get('logger').info('[email-bridge] mailbridge process auto-started (方案B) PID=' + after.join(',')) } catch (_) {}
          } else {
            try { ctx.get('logger') && ctx.get('logger').warn('[email-bridge] mailbridge spawn failed to stay alive (watchdog will retry)') } catch (_) {}
          }
        } catch (e) {}
      }, 5000)
      return ok
    } catch (e) { return false }
  }
  // 看门狗：宿主存活期间每 60s 复核 mailbridge 进程，缺失自动拉起（防第三次复发）
  const watchdogHandle = setInterval(function () { ensureMailbridgeProcess().catch(function () {}) }, 60000)
  ctx.effect(function () { return function () { try { clearInterval(watchdogHandle) } catch (e) {} } })
  // 插件 apply 后延迟拉起（等宿主就绪，避免启动风暴）
  setTimeout(function () { ensureMailbridgeProcess().catch(function () {}) }, 8000)
}

export { inject }
