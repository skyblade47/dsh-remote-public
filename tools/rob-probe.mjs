#!/usr/bin/env node
// 夹具内核探针：不依赖浏览器，直接让内核加载/恢复夹具会话。
//
// 为什么需要它（2026-09-22 真机实测得出，三条都与先前笔记不同）：
//   1. **内核不是零鉴权**：`dsh web` 启动会打印 `http://127.0.0.1:<port>/?token=<token>`，
//      裸 POST /api/* 会 401；必须先 `GET /?token=` 换 `dsh-auth` cookie。
//   2. **信封形状**是 typert 形态：`{type:'client-request',rpcId,method,payload:{args:{_request:{...}}}}`，
//      且**路径与 method 必须同为斜杠形式**（`/api/session/list` + `session/list`）。
//      参数名不是 `args` 而是 `_request`（descriptor 校验会点名报错）。
//   3. **没有 `session/history` 这个端点**（先前的 404 是路径错，不是内核拒绝会话）。
//      内核 `dsh-api-session-controller` 真正导出的有：
//      `list / search / create / selectModel / modelCatalog / rename / fork / prompt /
//       attachment / updateQueue / cancel / page / follow(stream) / control(stream)`。
//
// P3 §2C 的用途：
//   · T3（**R1 判定**）：让内核读回夹具**改过盘**的会话 —— 用 `session/page` 读全量事件，
//     并用 `session/create`（= 恢复/接管同一 sessionId）触发**完整日志装载**。
//     若日志违反 invariant，这两条都会报 `gateway/internal`，而不是静默返回空。
//   · T6/T7（A2/A3）：从 `session/page` 的记录里取 `request/header.tools.length` 与
//     注入的 `user/message`（含 `<resume-notice`）。
//
// 用法：
//   node tools/rob-probe.mjs --port 3091 --token <token>
//   node tools/rob-probe.mjs --port 3091 --token <token> --session <id> [--cwd /srv/rob-fixture-ws]

const args = parseArgs(process.argv.slice(2))
if (!args.port) usage()

const BASE = `http://127.0.0.1:${args.port}`

function parseArgs(argv) {
  const out = { port: null, session: null, token: null, cwd: null, prompt: null, new: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = argv[++i]
    else if (argv[i] === '--session') out.session = argv[++i]
    else if (argv[i] === '--token') out.token = argv[++i]
    else if (argv[i] === '--cwd') out.cwd = argv[++i]
    else if (argv[i] === '--prompt') out.prompt = argv[++i]
    else if (argv[i] === '--new') out.new = true
    else if (argv[i] === '-h' || argv[i] === '--help') out.help = true
  }
  return out
}

function usage() {
  console.log(`用法：
  node tools/rob-probe.mjs --port <内核端口> --token <token>
  node tools/rob-probe.mjs --port <内核端口> --token <token> --session <id> [--cwd <工作区>] [--prompt <文本>]
  node tools/rob-probe.mjs --port <内核端口> --token <token> --session <新 id> --new --cwd <工作区> [--prompt <文本>]
前置：夹具内核已在该端口启动；token 就是它启动时打印的那串。

--new 的用途（A2 的**同源基准**）：在**同一个 home / 同一个 profile** 里正常新建一个会话跑一轮，
用它的 header.tools.length 作基准，再与唤醒会话比较。
⚠️ 跨 profile 的绝对值**不可比**（这个坑栽过三次：真实 home 13 / headless 25 / web 44）——
基准必须与实测**同源**，否则 A2 等于没验。

--prompt 的用途（T6/T7 的前置）：唤醒只把说明投进 inbox（target=next-turn），**不会发动一轮 request**，
因此 request/header 不会新增、说明也还只是 agent/inbox/spliced。
要评估 A2（工具数）与 A3（说明物化成 user/message），**必须先真的跑起一轮** —— 就是这里发一次 prompt。
夹具 home 的 API key 是占位符，模型调用会失败，但 request/header 在调用前就落盘了，判据照样可读。`)
  process.exit(2)
}

/** 用启动 token 换 dsh-auth cookie（不换就 401） */
async function acquireCookie() {
  if (!args.token) return null
  const res = await fetch(`${BASE}/?token=${encodeURIComponent(args.token)}`, { redirect: 'manual' })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  return cookie || null
}

const COOKIE = await acquireCookie()

/**
 * typert 信封：参数在 `payload.args.<形参名>` 下；路径与 method 同为斜杠形式。
 *
 * ⚠️ **形参名按方法不同**（实测）：`session/list` 要 `_request`，`session/page` 要 `request`。
 * descriptor 校验会点名报错（`missing "request"; unexpected "_request"`），
 * 故这里**从报错里学形参名再重试**，而不是硬编码 —— 免得把"参数名写错"误判成"内核拒绝会话"。
 */
async function rpcOnce(method, request, paramName) {
  const path = `/api/${method.replace('.', '/')}`
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(COOKIE ? { cookie: COOKIE } : {}) },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${Date.now()}`,
      method: method.replace('.', '/'),
      payload: { args: { [paramName]: request } },
    }),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, text, json }
}

const paramNameOf = new Map()   // method -> 学到的形参名

async function rpc(method, request) {
  const known = paramNameOf.get(method) || '_request'
  let r = await rpcOnce(method, request, known)
  if (r.status === 200) {
    const msg = r.json?.result?.error?.message || ''
    const m = /missing "(\w+)"/.exec(msg)
    if (m && m[1] !== known) {
      paramNameOf.set(method, m[1])
      r = await rpcOnce(method, request, m[1])
    }
  }
  return r
}

/** 把"传输失败 / 信封不合法 / 业务错误"分开报，避免把路径错当成内核拒绝会话 */
function unwrap(r) {
  if (r.status !== 200) return { ok: false, why: `HTTP ${r.status}`, raw: r.text.slice(0, 300) }
  const res = r.json && r.json.result
  if (!res) return { ok: false, why: '回复里没有 result 字段', raw: r.text.slice(0, 300) }
  if (res.error) return { ok: false, why: `业务错误 ${res.error.code || ''} ${res.error.message || ''}`.trim() }
  return { ok: true, value: res.value }
}

/** 从历史记录里取判据（A2 工具数 / A3 注入痕迹 / 末条 turn 状态） */
function summarize(records) {
  const list = (Array.isArray(records) ? records : []).map((r) => (r && r.event) ? r.event : r)
  let headerTools = null
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    if (ev && ev.type === 'request/header' && ev.data && ev.data.header && Array.isArray(ev.data.header.tools)) {
      headerTools = { seq: ev.seq, count: ev.data.header.tools.length }
      break
    }
  }
  let boundary = null
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    if (ev && (ev.type === 'turn/start' || ev.type === 'turn/end')) { boundary = ev.type; break }
  }
  const notices = list.filter((ev) => ev && ev.type === 'user/message'
    && JSON.stringify(ev).includes('<resume-notice')).length
  return {
    events: list.length,
    seqRange: list.length ? [list[0].seq ?? null, list[list.length - 1].seq ?? null] : null,
    lastEventType: list.length ? list[list.length - 1].type : null,
    lastBoundary: boundary,
    headerTools,
    resumeNotices: notices,
  }
}

// ---- 1) 会话列表（返回形状是 { items: [...] }，不是裸数组）----
console.log('== session/list ==')
const listed = unwrap(await rpc('session.list', {}))
if (!listed.ok) { console.log(`  ✘ ${listed.why}`); if (listed.raw) console.log(`  raw: ${listed.raw}`) }
else {
  const items = (listed.value && listed.value.items) || []
  console.log(`  会话数: ${items.length}`)
  for (const s of items) console.log(`  · ${s.sessionId}  cwd=${s.cwd ?? '?'}  updatedAt=${s.updatedAt}`)
}

if (!args.session) process.exit(listed.ok ? 0 : 4)

/**
 * 发起一轮（T6/T7 的前置）。
 * 入参形状取自内核客户端本体（`types/client/sessions/session.js` 的 `prompt(content, mode, ...)`）：
 *   { requestId, sessionId, mode: 'queue'|'steer', content: PromptContentPart[], clientTimeZone }
 * 形参名由 rpc() 从 descriptor 报错里自学（不硬编码）。
 */
async function runPrompt() {
  console.log(`\n== session/prompt（发起一轮，用来物化 inbox 说明 + 写出 request/header）==`)
  const sent = await rpc('session.prompt', {
    requestId: (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : `probe-${Date.now()}`,
    sessionId: args.session,
    mode: 'queue',
    content: [{ type: 'text', text: args.prompt }],
    clientTimeZone: 'Asia/Shanghai',
  })
  const out = unwrap(sent)
  if (out.ok) console.log(`  ✔ 已受理：${JSON.stringify(out.value)}`)
  else {
    console.log(`  ✘ ${out.why}`)
    if (sent.text) console.log(`  raw: ${sent.text.slice(0, 500)}`)
  }
  // 给它一点时间把 header/说明落盘（模型调用会失败，但落盘在调用之前）
  await new Promise((r) => setTimeout(r, 3000))
  console.log('  （等 3s 让落盘完成）')
}

// ---- 1b) --new：**新建**一个会话，跳过 page ----
// 用途（A2 的**同源基准**）：在同一个 home / 同一个 profile 里正常新建会话跑一轮，
// 取它的 `header.tools.length` 作基准，再与唤醒会话比较。
// 跨 profile 的绝对值不可比 —— 这个坑已经栽过三次（真实 home 13 / headless 25 / web 44）。
// 注意：**必须跳过 page**，否则会先在"还不存在的会话"上失败并 exit(5)，根本走不到 create。
if (args.new) {
  if (!args.cwd) { console.log('✘ --new 需要同时给 --cwd'); process.exit(2) }
  console.log(`\n== session/create（新建会话 ${args.session}，cwd=${args.cwd}）==`)
  const made = unwrap(await rpc('session.create', { sessionId: args.session, cwd: args.cwd }))
  if (made.ok) console.log(`  ✔ 已新建/接管：${JSON.stringify(made.value)}`)
  else console.log(`  ✘ ${made.why}`)
  if (args.prompt) await runPrompt()
  process.exit(made.ok ? 0 : 6)
}

// ---- 2) session/page：读全量事件（R1 的核心：内核必须能解出整条日志）----
// throughSeq 必须是真实游标；先用一个超大值探出 "past cursor N"，再按 N 重取。
console.log(`\n== session/page ${args.session} ==`)
const address = { kind: 'session', sessionId: args.session }
let cursor = null
const probe = unwrap(await rpc('session.page', { address, throughSeq: Number.MAX_SAFE_INTEGER, maxMessages: 100 }))
if (!probe.ok) {
  const m = /past cursor (\d+)/.exec(probe.why)
  if (m) cursor = Number(m[1])
  else { console.log(`  ✘ 未能读取：${probe.why}`); if (probe.raw) console.log(`  raw: ${probe.raw}`); process.exit(5) }
}
const paged = cursor === null ? probe : unwrap(await rpc('session.page', { address, throughSeq: cursor, maxMessages: 100 }))
if (!paged.ok) {
  console.log(`  ✘ 内核拒绝读取该会话：${paged.why}`)
  if (paged.raw) console.log(`  raw: ${paged.raw}`)
  process.exit(5)
}
console.log(`  ✔ 内核成功解出该会话日志（游标 ${cursor}）`)
console.log(`  ${JSON.stringify(summarize(paged.value && paged.value.records))}`)
if (paged.value && paged.value.hasMore) console.log('  ⚠ hasMore=true：本次只取到部分页（加大 maxMessages 或向前翻页）')

// ---- 3) session/create 同一 id：触发"完整装载 / 恢复"，比只读更强 ----
// 这是 P3 的 `agents.resume` 同一条路径；日志若有 invariant 违规，会在这里报 gateway/internal。
if (args.cwd) {
  console.log(`\n== session/create（接管/恢复同一 id，cwd=${args.cwd}）==`)
  const adopted = unwrap(await rpc('session.create', { sessionId: args.session, cwd: args.cwd }))
  if (adopted.ok) console.log(`  ✔ 内核完成装载/恢复：${JSON.stringify(adopted.value)}`)
  else console.log(`  ✘ ${adopted.why}`)
}

// ---- 4) session/prompt：真的发起一轮（T6/T7 的前置）----
if (args.prompt) await runPrompt()
