// @local/miyoushe —— 插件入口：**调度器接线 + 完整接口面**（HTTP actions §6.1 十二个 / agent 工具 §6.2.1 十四个）
//
// 本切片（offline-interface-1 / t16）范围：
//   - `lib/scheduler.js`（§5）接线：`createCore` 内建 scheduler 实例（state 只经 adapterFs）；
//   - §6.1 十二个 action 与 §6.2.1 十四个工具的实现与注册（`apply()`），路由 `kind:'prefix'` + 前缀 `/miyoushe/api`；
//   - 接 `lib/gate.js`（§6.5）与 `lib/miyoushe-version.js`（§3.5），**服务/端口在调用期惰性解析**；
//   - 出口姿态按路径分级（A8，依据 `F2b_出口姿态裁决_现场与证据.md` §7）：
//     「只进不出」类（凭据类路径）走 **`strict:true`**；其余走 **默认（掩码兜底）**；一律经 `exitPayload`。
//
// **出站现状（t46/J4 更正，此前表述已过时）**：`lib/mys-http.js`（§10.2 API 出站薄封装）与
//   §2.4 账号发现的真实请求**均已落地并接线**；`sign` / `probe` / `accounts` 在 `apply` 生产接线里
//   拿到 `ports.httpPort`（未注入时由 `apply` 自挂 mys-http 默认实现）⇒ **可以真实出站**
//   （t45 现场：`sign{dryRun:false}` 真实签到 `retcode:0`）。仍**未实现**的只有 `run` 的真实提交分支
//   （`A.run{dryRun:false}` 恒返回 `NET_ERROR`，语义＝"该分支未实现"，非"通道未接线"）。
//   `dryRun` 省略即 true 的工具（`sign`/`run`/`probe`）仍**一律不发请求**。
//
// t22 起（§3.5.8 运行期落地）：**版本取回**例外——`apply` 在未注入 `fetchImpl` 时挂
//   `lib/miyoushe-version.js` 的**受控默认出站**（本文件与 `lib/**` 均不含任何全局 fetch 调用；
//   唯一落点＝版本模块，静态断言其 fetch 调用计数=1）。离线自测仍不调 `apply` ⇒ 零真实网络不变。
//
// 设计锚点（**章节号 + grep 模式**，不写行号——设计文档自指行号已漂移）：
//   §6.1 actions 表     锚：`^\\| \\`ping\\` \\| POST`／错误码表 `^\\| \\`NOT_READY\\` \\|`
//   §6.2.1 14 工具      锚：`完整工具清单`；§6.2.2 纪律 锚：`工具实现纪律`
//   §6.4 调度类工具     锚：`对话可调度的`
//   §6.5 门禁           锚：`^\\| \\*\\*G4\\*\\* \\|`
//   §10.1 数据面        锚：`数据读写一律走`
//
// 依赖纪律（§10.1 + t26）：**硬依赖只有 `['tools','webServer']`**（两者都在 apply 期就要用：注册工具 / 注册路由），
//   对齐同 profile 的 4 个已知可用插件（`inject = ['tools','fs','sandboxPolicy','webServer']`，本插件不直接读盘故不注入 fs 系）。
//   `adapterFs`（数据面）/ `httpPort` / `credentialsPort` / `fetchImpl` 一律**可选**，仍 `ctx.get` **惰性**取，
//   缺失时降级在**调用期**显式发生（不静默）；**绝不**把可选服务写进 `inject`（否则缺失即永久挂起激活）。

import { createStore, StoreError, DATA_DIR_HINT, ROOT_NAME, REL, localDate } from './store.js'
import { exitPayload, saltFingerprint, uidTail, accountKey } from './mask.js'
import { toLossless } from './lossless.js'
import { signDs, randAlnum, nowSec, dsPayload, md5Hex, DS_ERR, DsError, R_PATTERN } from './ds.js'
import { evaluateGate, toGateError, collectBlockingCodes, activeSaltInfo } from './gate.js'
import {
  fingerprint, parseSettingPy, buildCandidateEntry, cacheState, shouldFetch, matchVersion, mergeCandidate,
  evaluateVersionStaleness, fetchVersionCandidates, decideVersionOutcome, VERSION_ERR, CACHE_TTL_MS,
  createDefaultVersionFetch, FETCH_TIMEOUT_MS,
} from './miyoushe-version.js'
// ⚠️ **加载顺序纪律（t41 实测教训）**：这里的 import 列表**只允许包含 t39 之前的 scheduler.js 就已经存在的导出**。
// 原因：`sandbox_reload` 只 bust **入口** URL ⇒ 若入口 import 了「非入口模块新增的导出」，运行期仍指向
// **上一次加载的旧 scheduler.js**，ESM 会直接抛 `does not provide an export named …` ⇒ **插件被卸载**（LOAD_FAILED）。
// 因此本文件需要的三个分散项（缺省值 + 读侧口径）在**下方自带一份**，与 scheduler.js 逐字对齐；
// `region 感知键` 用本文件自带的 3 段/4 段规则实现（与 scheduler 的 `dedupeKey` 同口径，自测交叉断言）。
// 真正的**全局生效**仍以 `scheduler.js` 为准，且 `scheduler.js` 的生效需要 `host_restart`（它是非入口模块）。
import {
  createScheduler, DEFAULTS as SCHEDULER_DEFAULTS, TARGETS, dedupeKey, localDateOf, planTick, decideOne, applyResult, LOCK_TTL_MS,
} from './scheduler.js'
// t46/J3：`resolveEndpointSpec` + `HEADER_NAMES` 用于 `probe{dryRun:true}` 的**只构造不发送**预览
//   （两者都是 mys-http 的**长期既有**导出 ⇒ 不触发 t41 的加载顺序纪律；mys-http.js 本任务未改）。
import { createHttpPort, resolveEndpointSpec, HEADER_NAMES } from './mys-http.js'

/**
 * t44/H1：**门禁的 groups 必须与"调度实际会签的组合"同源**。
 *
 * 缺口（第 6 次重启后运行期实测）：`schedule.targets` 让 `dailyPlan.items` 只有 **4** 个目标组合，
 * 但 `evaluateGate` 收到的是 `groupsFromAccounts()` 的**全部**组合 ⇒ `evaluatedGroups:5`、
 * `totalFailingGroups:5`、`failedByGroup` 含 `bbs` 与折叠后的 `bh3` ⇒ **即使 4 个目标全部试签成功，
 * 被排除的 `bbs`/两个副号也会把 `G2` 永远留在失败态**，`mode:'auto'` 无法达成（只能靠双参越权进 `unverified`）。
 *
 * 口径与 `lib/scheduler.js` 的 `targetSelected` **逐字对齐**（自测有交叉断言防漂移）：
 *   - spec 与组合键（`gameKey:region`，bbs 为 `bbs`）**逐字相等** ⇒ 命中；
 *   - spec **带 region** ⇒ 只命中该区服（**不**按游戏前缀放宽 —— `bh3:bb01` 不得命中 `bh3:pc01`）；
 *   - spec **不带 region**（如 `"bh3"`）⇒ 命中该游戏全部区服；
 *   - `targets` 空/缺省 ⇒ **全选**（不过滤）。
 */
export function targetSelected(list, comboKey) {
  const arr = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : []
  if (arr.length === 0) return true
  const key = typeof comboKey === 'string' ? comboKey : ''
  for (const raw of arr) {
    const s = raw.trim()
    if (s === key) return true
    if (s.indexOf(':') === -1) {
      if (key === s || key.indexOf(s + ':') === 0) return true
      continue
    }
    continue // spec 带 region ⇒ 只认逐字相等（上面已判）
  }
  return false
}

/**
 * t44/H1：按 `settings.schedule.targets` 过滤 groups（门禁/展示共用）。
 * 保序、保字段（`accountKey`/`gameKey`/`region`/`comboKey`/`gameUid`），只做"取子集"。
 */
export function filterGroupsForTargets(groups, settings) {
  const list = Array.isArray(groups) ? groups : []
  const sc = settings && settings.schedule && typeof settings.schedule === 'object' ? settings.schedule : {}
  const targets = Array.isArray(sc.targets) ? sc.targets : []
  if (targets.filter((x) => typeof x === 'string' && x.trim()).length === 0) return list.slice()
  return list.filter((g) => {
    if (!g) return false
    const key = typeof g.comboKey === 'string' && g.comboKey ? g.comboKey : (g.gameKey + (g.region ? ':' + g.region : ''))
    return targetSelected(targets, key)
  })
}

/**
 * t50/N1：**legacy 3 段去重键的代码级迁移**（入口侧镜像）。
 *
 * 与 `lib/scheduler.js` 的同名导出**逐字同口径**（同一份规则；自测有交叉断言防漂移）。
 * **为什么这里也留一份**：沿用「加载顺序纪律」（E17）——入口**不得** import 非入口模块的**新增导出**，
 * 否则在任何一次 `sandbox_reload` 里，进程内的旧 `scheduler.js` 会因"没有该导出"而让入口加载失败
 * （t41 实测 `LOAD_FAILED`、插件被卸载）。t44 的 `targetSelected` 同例。
 *
 * 规则（合同 N1）：
 *   - 4 段键（`a:g:d:r`）且 `status ∈ {signed, already}` ⇒ 同前缀 `a:g:d` 的 **3 段键移除**（成功记录不丢：
 *     保留的就是那条 4 段成功键）；
 *   - 只有 3 段键 ⇒ **原样保留**（不误删；`lookupDoneEntry` 仍可回退读到）；
 *   - **`bbs` 例外**：无区服目标的**规范键本就是 3 段** ⇒ 永不视为 legacy；
 *   - 段数 < 3 的畸形键一律保留（不猜）。
 */
export function migrateLegacyDoneKeys(doneKeys, opts) {
  const o = opts || {}
  const supersedeStatuses = Array.isArray(o.supersedeStatuses) && o.supersedeStatuses.length
    ? o.supersedeStatuses
    : ['signed', 'already']
  const src = doneKeys && typeof doneKeys === 'object' && !Array.isArray(doneKeys) ? doneKeys : {}
  const keys = Object.keys(src)
  const winner = {}
  for (const k of keys) {
    const segs = String(k).split(':')
    if (segs.length !== 4) continue
    const v = src[k] && typeof src[k] === 'object' ? src[k] : {}
    if (supersedeStatuses.includes(v.status)) winner[segs.slice(0, 3).join(':')] = k
  }
  const out = {}
  const removed = []
  const kept = []
  for (const k of keys) {
    const segs = String(k).split(':')
    const target = segs.length >= 3 ? segs[segs.length - 2] : null
    if (segs.length === 3 && target !== 'bbs' && winner[k]) {
      const v = src[k] && typeof src[k] === 'object' ? src[k] : {}
      removed.push({ key: k, supersededBy: winner[k], status: v.status === undefined ? null : String(v.status) })
      continue
    }
    out[k] = src[k]
    kept.push(k)
  }
  return { doneKeys: out, removed, kept, changed: removed.length > 0 }
}

/**
 * t50/O1+O2：**提交侧的组合选择器**（`A.sign` / `A.run` 共用）。
 *
 * - **O1（R3 根治）**：默认与 `settings.targets` **同源**（复用 `filterGroupsForTargets`）——
 *   裸 `{dryRun:false}` 在 `targets=4` 时只选 4 个组合（此前是 7：含 `bh3:pc01`/`bh3:android01` 两个
 *   targets 之外的区服与 `bbs`）。显式 `all:true` 才放开为全量（保留能力，但必须是**显式**意图）。
 * - **O2（R1）**：`comboKey` / `region` 支持**精确选中单组合**（`{gameKey:'bh3', region:'bb01'}` ⇒ 1）；
 *   与 `accountKey`/`gameKey` 叠加（AND）。**显式给了 `comboKey`/`region` 就视为显式意图**
 *   ⇒ 与 `all:true` 同类，**不再叠加 targets 过滤**（否则"精确选中一个 targets 之外的组合"永远选不出来）；
 *   未给 `comboKey`/`region` 时才走 targets 同源过滤（这才是 R3 要防的"裸调用误全量"）。
 */
export function selectGroupsForAction(groups, settings, input) {
  const i = input || {}
  const list = Array.isArray(groups) ? groups : []
  const explicitCombo = (i.comboKey !== undefined && i.comboKey !== null && String(i.comboKey) !== '')
  const explicitRegion = (i.region !== undefined && i.region !== null && String(i.region).trim() !== '')
  let out = (i.all === true || explicitCombo || explicitRegion) ? list.slice() : filterGroupsForTargets(list, settings)
  if (explicitCombo) out = out.filter((g) => g && g.comboKey === String(i.comboKey))
  if (explicitRegion) out = out.filter((g) => g && (g.region || '') === String(i.region).trim())
  if (typeof i.accountKey === 'string' && i.accountKey) out = out.filter((g) => g && g.accountKey === i.accountKey)
  if (typeof i.gameKey === 'string' && i.gameKey) out = out.filter((g) => g && g.gameKey === i.gameKey)
  return out
}

/**
 * t52/Q1：从凭据串里**推断 uid**（纯启发式、**绝不回显**）。
 * 规则：扫形如 `<name>=<值>` 的键值对，取**值形如 6–12 位纯数字**的候选；优先键名以 `uid` 结尾者，
 * 否则取第一个候选；都取不到 ⇒ `null`（**不编造**，让 accountKey 保持 null）。
 * 说明：本函数**不**在源码里写任何凭据类键名字面量（避免与 §4.2 的"出口/源码不出现凭据词"纪律冲突），
 * 只按"数字型账号标识"这一形态特征取值；`set` 的调用方也可直接用入参 `uid` 覆盖。
 */
export function uidFromCredentialString(raw) {
  const s = typeof raw === 'string' ? raw : ''
  const out = []
  const re = /(?:^|[;\s])([A-Za-z_][A-Za-z0-9_]{0,31})=([0-9]{6,12})(?=[;\s]|$)/g
  let m = re.exec(s)
  while (m !== null) { out.push({ name: m[1], value: m[2] }); m = re.exec(s) }
  if (out.length === 0) return null
  const byUid = out.filter((x) => x.name.toLowerCase().slice(-3) === 'uid')
  return (byUid.length ? byUid[0] : out[0]).value
}

/**
 * t52/Q1：**凭据写入落盘**（D-3 未尽项）。形状沿用 t31 定形结构。
 * 硬约束：写盘**保留原值**（签名需要），但**返回值/日志只给尾号**；轮换后 `lastOkAt` **归零**
 * （新凭据尚未被服务端证明 ⇒ fail-closed，G1 会等下一次认证成功再转 ok）。
 */
export async function writeCredentialToStore(core, raw, opts) {
  const o = opts || {}
  let prev = null
  try { prev = await core.store.readCredentials() } catch (e) { prev = null }
  const prevPrimary = prev && prev.primary ? prev.primary : null
  const explicit = o.uid === undefined || o.uid === null ? '' : String(o.uid)
  const uid = explicit || (prevPrimary && prevPrimary.uid ? String(prevPrimary.uid) : uidFromCredentialString(raw))
  const nowIso = iso(Date.now())
  const file = {
    version: 1,
    updatedAt: nowIso,
    accounts: [{
      accountKey: uid ? accountKey(uid) : (prevPrimary && prevPrimary.accountKey ? prevPrimary.accountKey : null),
      credential: raw,
      uid: uid === null || uid === '' ? null : uid,
      createdAt: prevPrimary && prevPrimary.createdAt ? prevPrimary.createdAt : nowIso,
      lastOkAt: null,
    }],
  }
  await core.store.writeCredentials(file)
  const st = await core.store.readState()
  const nextState = Object.assign({}, st, {
    credentials: Object.assign({}, st.credentials && typeof st.credentials === 'object' ? st.credentials : {}, {
      configured: true, lastOkAt: null, rotatedAt: nowIso,
    }),
  })
  await core.store.writeState(nextState)
  try { await core.store.appendLog({ event: 'credential_change', action: 'set', uidTail: uid ? uidTail(uid) : null, at: nowIso }) } catch (e) { /* 日志失败不阻断 */ }
  return { configured: true, uidTail: uid ? uidTail(uid) : null, lastOkAt: null }
}

/** t52/Q1：**凭据清除**（空骨架 + 同步 state；**不谎报**文件已删除，见 store.clearCredentials 注释）。 */
export async function clearCredentialInStore(core) {
  const r = await core.store.clearCredentials()
  const st = await core.store.readState()
  const nowIso = iso(Date.now())
  const nextState = Object.assign({}, st, {
    credentials: Object.assign({}, st.credentials && typeof st.credentials === 'object' ? st.credentials : {}, {
      configured: false, lastOkAt: null, clearedAt: nowIso,
    }),
  })
  await core.store.writeState(nextState)
  try { await core.store.appendLog({ event: 'credential_change', action: 'clear', removed: r && r.removed === true, at: nowIso }) } catch (e) { /* 忽略 */ }
  return { configured: false, removed: !!(r && r.removed === true), emptedFile: true }
}

/**
 * t52/G2c：**读侧回填**「已在当前盐下被服务端受理」的**当日**记录到 `lastSignSuccess`（captain 裁决 (i)）。
 * 判据（硬护栏，不许放宽）：`doneKeys` 当日条目 `status ∈ {already, signed}` **且其 `at` ≥ `salts.active.verifiedAt`**
 * ⇒ 该请求确实是在**已验证的当前盐**下发出的 ⇒ 可把 `lastSignSuccess[acct][game]` 的
 * `saltFingerprint`/`appVersion` 补成当前 active 值（只在"现有记录不同源"时补，已同源则原样）。
 * **不改** `doneKeys`（含 `status`）、**不新增**任何计数、**不发**任何请求、缺 `verifiedAt` 时**一律不回填**。
 */
export function backfillSameSaltSuccess(state, salts, opts) {
  const o = opts || {}
  const st = state && typeof state === 'object' ? state : {}
  const all = salts && typeof salts === 'object' ? salts : {}
  const active = all.active && typeof all.active === 'object' ? all.active : null
  const entries = all.entries && typeof all.entries === 'object' ? all.entries : {}
  const ver = active && typeof active.appVersion === 'string' && active.appVersion ? active.appVersion : null
  const ent = ver && entries[ver] && typeof entries[ver] === 'object' ? entries[ver] : null
  const verifiedAt = ent && typeof ent.verifiedAt === 'string' && ent.verifiedAt ? ent.verifiedAt : null
  const fingerprint = ent && typeof ent.saltFingerprint === 'string' && ent.saltFingerprint ? ent.saltFingerprint : null
  const verifiedMs = verifiedAt === null ? NaN : Date.parse(verifiedAt)
  if (ver === null || !Number.isFinite(verifiedMs) || fingerprint === null) return { state: st, filled: [] }
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now()
  const today = localDate(nowMs)
  const dk = st.doneKeys && typeof st.doneKeys === 'object' && !Array.isArray(st.doneKeys) ? st.doneKeys : {}
  const lss = st.lastSignSuccess && typeof st.lastSignSuccess === 'object' && !Array.isArray(st.lastSignSuccess) ? st.lastSignSuccess : {}
  const nextLss = Object.assign({}, lss)
  const filled = []
  let changed = false
  for (const key of Object.keys(dk)) {
    const segs = String(key).split(':')
    if (segs.length !== 3 && segs.length !== 4) continue
    const dateLocal = segs.length === 4 ? segs[2] : segs[2]
    const target = segs.length === 4 ? segs[1] : segs[1]
    const accountId = segs[0]
    if (dateLocal !== today) continue
    const v = dk[key] && typeof dk[key] === 'object' ? dk[key] : {}
    if (v.status !== 'already' && v.status !== 'signed') continue
    const atMs = typeof v.at === 'string' ? Date.parse(v.at) : NaN
    if (!Number.isFinite(atMs) || atMs < verifiedMs) continue // 护栏：早于"当前盐被验证"的时刻 ⇒ 不认
    const per = Object.assign({}, nextLss[accountId] && typeof nextLss[accountId] === 'object' ? nextLss[accountId] : {})
    const cur = per[target] && typeof per[target] === 'object' ? per[target] : null
    if (cur && cur.saltFingerprint === fingerprint && cur.appVersion === ver) continue // 已同源 ⇒ 不动
    per[target] = {
      outcome: v.status === 'signed' ? 'success' : 'already', // 与 G2a 同口径：'already' 保持 'already'
      at: v.at,
      retcode: v.retcode === undefined ? null : v.retcode,
      saltFingerprint: fingerprint,
      appVersion: ver,
      backfilled: true,
      backfillBasis: { doneKey: key, rule: 'doneKey.at >= active.verifiedAt', verifiedAt, activeAppVersion: ver },
    }
    nextLss[accountId] = per
    filled.push({ accountKey: accountId, target, dedupeKey: key, at: v.at, status: v.status, prev: cur ? { saltFingerprint: cur.saltFingerprint === undefined ? null : cur.saltFingerprint, appVersion: cur.appVersion === undefined ? null : cur.appVersion } : null })
    changed = true
  }
  return { state: changed ? Object.assign({}, st, { lastSignSuccess: nextLss }) : st, filled }
}

/**
 * t52/Q3：**受控维护/清理**的入参校验（**纯函数**，fail-closed）。
 * 支持：`{ clearDoneKeys:[{accountKey, gameKey, region?}], reason:'<为什么>', resetLastOkAt?:true }`。
 * 硬约束：**必须给 reason**（写审计日志用）；条目必须**精确匹配** `accountKey`+`gameKey`（region 可选）；
 * **拒绝通配**（`*`、`all`、空串）；条目数 **1..8**（显式、有界，**不做"批量清空"**）；拒绝未知子键。
 */
export function validateMaintenance(raw) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (m === null) return { ok: false, message: 'maintenance 需要对象' }
  const allow = ['clearDoneKeys', 'reason', 'resetLastOkAt', 'clearDailyPlan']
  const unknown = Object.keys(m).filter((k) => !allow.includes(k))
  if (unknown.length) return { ok: false, message: 'maintenance 未知子键：' + unknown.join(', ') }
  const reason = typeof m.reason === 'string' ? m.reason.trim() : ''
  if (reason.length < 4) return { ok: false, message: 'maintenance.reason 必填（≥4 字符，写入审计日志）' }
  // 「禁通配」的**精确口径**：拒绝 `*`/`**`/`all`/`any`/空；`*` **只允许**出现在**脱敏尾号**这一规范形态里
  //   （本插件的 accountKey 天生形如 `acct-***4321` ⇒ 不能用"含 * 即拒"的粗判，否则连正常账号都拒绝不了/或全拒）。
  const WILDCARD_RE = /^(?:\*+|all|any)$/i
  const MASKED_TAIL_RE = /^[A-Za-z0-9_-]+\*+[0-9]+$/
  const bad = (s) => {
    if (typeof s !== 'string') return true
    const t = s.trim()
    if (t === '') return true
    if (WILDCARD_RE.test(t)) return true
    if (t.indexOf('*') >= 0 && !MASKED_TAIL_RE.test(t)) return true
    return false
  }
  let list = []
  if (m.clearDoneKeys !== undefined) {
    if (!Array.isArray(m.clearDoneKeys) || m.clearDoneKeys.length === 0) return { ok: false, message: 'clearDoneKeys 需要非空数组（显式逐条）' }
    if (m.clearDoneKeys.length > 8) return { ok: false, message: 'clearDoneKeys 条目过多（上限 8；本动作**不做批量清空**）' }
    for (const it of m.clearDoneKeys) {
      const e = it && typeof it === 'object' && !Array.isArray(it) ? it : null
      if (e === null) return { ok: false, message: 'clearDoneKeys 条目需要对象' }
      const un = Object.keys(e).filter((k) => !['accountKey', 'gameKey', 'region'].includes(k))
      if (un.length) return { ok: false, message: 'clearDoneKeys 条目未知子键：' + un.join(', ') }
      if (bad(e.accountKey)) return { ok: false, message: 'clearDoneKeys.accountKey 必须是具体账号（禁止 * / all / 空）' }
      if (bad(e.gameKey)) return { ok: false, message: 'clearDoneKeys.gameKey 必须是具体游戏（禁止 * / all / 空）' }
      if (e.region !== undefined && e.region !== '' && (typeof e.region !== 'string' || e.region.indexOf('*') >= 0)) return { ok: false, message: 'clearDoneKeys.region 非法（禁止 *）' }
      list.push({ accountKey: String(e.accountKey), gameKey: String(e.gameKey), region: e.region === undefined ? null : String(e.region) })
    }
  }
  const reset = m.resetLastOkAt === true
  // t80（补丁②b）：新增 `clearDailyPlan` —— **只**清 `state.dailyPlan`（当日时刻表），供下次 tick 按新锚点重生成。
  //   边界（写死）：不碰 doneKeys / credentials.lastOkAt / salts / 任何签到记录；无通配、无批量（单一布尔开关）；
  //   仍沿用既有「必须给 reason」的规则（上面已强制 reason.length >= 4）。
  const clearDailyPlan = m.clearDailyPlan === true
  if (list.length === 0 && !reset && !clearDailyPlan) return { ok: false, message: 'maintenance 至少要有一个动作（clearDoneKeys 或 resetLastOkAt:true 或 clearDailyPlan:true）' }
  return { ok: true, value: { clearDoneKeys: list, reason, resetLastOkAt: reset, clearDailyPlan } }
}

/**
 * t52/Q1：**凭据"已配置"的单一判据**（`A.status` 与 `readWorld` 共用，避免两处口径分叉）。
 * 规则：**state 侧的显式否定优先** —— `{configured:false, clearedAt:<ISO>}` 表示"用户显式清除过凭据"；
 * 因为 `adapterFs` 契约没有删除 API，`clear` 只能把文件写成空骨架（存在性仍为 true），
 * 若仍按"文件在即已配置"，清除**不可观测**。除此之外维持原口径：**文件存在 ∨ state.configured**。
 * （`readCredentialsPresence()` 本身仍**纯存在性、不读内容** —— 该纪律有独立断言保护，t52 未改。）
 */
export function credentialConfiguredOf(presence, stateCred) {
  const p = presence && typeof presence === 'object' ? presence : {}
  const s = stateCred && typeof stateCred === 'object' ? stateCred : {}
  const cleared = typeof s.clearedAt === 'string' && s.clearedAt ? true : false
  if (cleared && s.configured === false) return false
  return p.configured === true || s.configured === true
}

export const name = '@local/miyoushe'
export const SLICE = 'offline-interface-1'
export const PACKAGE_VERSION = '0.1.0'

/**
 * t39/t41：**分散时刻三项的缺省值**（与 `lib/scheduler.js` 的 `SPREAD_DEFAULTS` **逐字对齐**；自测交叉断言）。
 * 为什么在这里也有一份：见上方「加载顺序纪律」——入口不能 import 非入口模块**新增**的导出，
 * 否则 `sandbox_reload` 会因「旧 scheduler.js 没有该导出」而**卸载插件**（t41 实测：LOAD_FAILED）。
 * 两份的口径由 `selftest/sign_path.mjs` 的 F1 段断言（读侧/写侧对同一组值给出同一结论）。
 */
export const SPREAD_DEFAULTS = Object.freeze({
  spreadMinGapMs: 600000,
  spreadJitterMs: Object.freeze([30000, 120000]),
  targets: Object.freeze([]),
})

/**
 * t39/P10：**region 感知去重键**（与 `lib/scheduler.js` 的 `dedupeKey` **同口径**；自测逐字交叉断言）。
 * 有 region ⇒ 4 段 `${accountId}:${target}:${dateLocal}:${region}`；无 region（含 bbs）⇒ 3 段旧格式。
 */
export function bizKey(accountId, target, dateLocal, region) {
  const base = String(accountId) + ':' + String(target) + ':' + String(dateLocal)
  const r = region === undefined || region === null ? '' : String(region).trim()
  return r === '' ? base : base + ':' + r
}

/**
 * t39/P10：读当日记录，**region 键优先、旧 3 段键回退**（与 `scheduler.lookupDoneEntry` 同口径）。
 * 为什么必须回退：升级为 region 键后，若某组合在升级前已留下记录（如 `human_required`），只查新键会"看不见它"
 * ⇒ ① `force` 的人工重试语义被绕过、② 终态组合被当成"从未跑过"而重发。
 */
function lookupDoneEntry(doneKeys, accountKey, gameKey, dateLocal, region) {
  const dk = doneKeys && typeof doneKeys === 'object' ? doneKeys : {}
  const key = bizKey(accountKey, gameKey, dateLocal, region)
  const hit = dk[key]
  if (hit && typeof hit === 'object') return { key, entry: hit, legacy: false }
  const legacyKey = bizKey(accountKey, gameKey, dateLocal, '')
  if (legacyKey !== key) {
    const old = dk[legacyKey]
    if (old && typeof old === 'object') return { key: legacyKey, entry: old, legacy: true }
  }
  return { key, entry: null, legacy: false }
}

/**
 * 硬依赖（§10.1 + t26 修复）：**只声明确实存在、且 apply 期就要用的两个服务**
 *   - `tools`：14 个 agent 工具逐个注册（`tools.register`）
 *   - `webServer`：HTTP actions 路由注册（`webServer.register`）
 * 声明后 cordis 会等服务就绪再激活本插件；**若声明成 `[]`**（t26 前）则 apply 在
 * 「boot graph 激活期」照跑，而那时两者都还是 undefined ⇒ 注册为空、只打警告，
 * 而 sandbox autoload 又因状态里 `loaded=true` 判 `already loaded, skip` ⇒ 无人再注册
 * ⇒ 每次重启后 14 个工具**静默消失**、必须手工 `sandbox_reload`。
 * 对照（同 profile 的 4 个已知可用插件，逐字读码）：`knowledge-base` / `writing-coach` /
 * `prompt-router` / `skill-center` 均为 `const inject = ['tools','fs','sandboxPolicy','webServer']`。
 * 本插件**不**注入 `fs` / `sandboxPolicy`（走 `adapterFs`，可选依赖、绝不进 inject，见 §10.1 与自测 D5），
 * 也**不**注入 `adapterFs` / 端口 / 凭据端口——那些仍 `ctx.get` **惰性**取，缺失时调用期显式降级（不静默）。
 */
export const inject = ['tools', 'webServer']

export const API_PREFIX = '/miyoushe/api'
export const ROUTE_KIND = 'prefix'

const INTERNAL_CODE = 'INTERNAL' // §6.1 表未列的兜底码（已在 t2/t13 登记）

/** §6.1 十二个 action（顺序＝文档表顺序） */
export const ACTIONS = Object.freeze([
  'ping', 'status', 'accounts', 'sign', 'logs', 'config', 'credentials', 'schedule', 'enable', 'disable', 'run', 'version',
])

/** §6.2.1 十四个工具（顺序＝文档表顺序） */
export const TOOL_NAMES = Object.freeze([
  'miyoushe_status', 'miyoushe_accounts', 'miyoushe_logs', 'miyoushe_sign',
  'miyoushe_schedule', 'miyoushe_enable', 'miyoushe_disable', 'miyoushe_run',
  'miyoushe_version', 'miyoushe_salts', 'miyoushe_probe', 'miyoushe_credentials',
  'miyoushe_config', 'miyoushe_help',
])

/** **只进不出**类出口路径（A8）：必须 `strict:true`（依据 F2b §7） */
export const STRICT_EXIT_PATHS = Object.freeze(['credentials', 'miyoushe_credentials'])

/** §6.1 错误码 → 用户可见提示（逐条对齐错误码表的"用户可见提示"列） */
export const ERROR_MESSAGES = Object.freeze({
  NOT_READY: '初始化未完成：请先配置 Cookie', // discipline-exempt: 用户可见文案: §6.1 错误码 NOT_READY 的用户提示原文（初始化未完成：请先配置 Cookie）
  // 2026-09-22 Linux 化：原文案写死 `E:/DSH工作区/全局数据/miyoushe/`，Linux 上会把用户指向一个
  // 不存在的路径。改用**根相对写法**（与 gate.js 的 `全局数据/miyoushe/ 不存在` 同口径）——
  // 绝对位置由 adapter 根表决定（Windows 默认 E:/DSH工作区，Linux 由 DSH_WORKSPACE_ROOT 注入）。
  FS_PARENT_MISSING: '数据目录不存在，请先创建：`全局数据/miyoushe/`（根表登记名，位置随平台）',
  AUTH_REQUIRED: '请粘贴 Cookie（只存本机）', // discipline-exempt: 用户可见文案: §6.1 错误码 AUTH_REQUIRED 的用户提示原文（请粘贴 Cookie，只存本机）
  AUTH_INVALID: 'Cookie 已失效，请重新登录米游社并更新', // discipline-exempt: 用户可见文案: §6.1 错误码 AUTH_INVALID 的用户提示原文（Cookie 已失效请重新登录）
  RETCODE_UNKNOWN: '服务端返回未知错误码（已脱敏展示）',
  GEETEST_REQUIRED: '需要人工完成一次验证码，已暂停自动签到',
  RATE_LIMITED: '触发频率限制，已退避',
  NET_TIMEOUT: '网络超时，稍后自动重试（剩余 n 次）',
  NET_ERROR: '网络错误（传输失败/5xx 重试穷尽；出站薄封装 §10.2 已实现、由 httpPort 承载）',
  SALT_INVALID: '签名盐无效或已失效，请更新盐表（当前版本见 status.salts）',
  SALT_SUSPECT: '签名疑似失效，请更新盐表',
  SALT_MISSING: '已获取米游社版本，但盐表中没有该版本的 salt ⇒ 已降级为只读；请手动填入该版本 salt',
  VERSION_STALE: '版本信息已过期（已回退配置版本）；自动签到暂停，只读查询仍可用',
  VERSION_FETCH_FAILED: '版本获取失败（公网不可达）；已回退配置版本并降级只读',
  SCHEDULE_GATE_BLOCKED: '开启自动签到被门禁拒绝：缺少【与当前盐同源】的逐组合成功试签记录（§9.1 第③步；§6.5.1 G2/G3）。',
  SCHEDULE_ALREADY_ON: '定时任务已是开启状态（幂等：changed=false）',
  SCHEDULE_ALREADY_OFF: '定时任务已是关闭状态（幂等：changed=false）',
  ENDPOINT_DRIFT: '端点疑似变更，请更新 endpoints.json',
  LOCKED: '任务进行中，稍后再试',
  BAD_ARG: '参数非法',
  NOT_IMPLEMENTED: '该能力尚未接线（本切片只做离线可判部分）',
})

/** 错误码 → HTTP 状态（实现期约定；设计只约定"全部 POST + JSON"与错误对象形状） */
export const ERROR_HTTP_STATUS = Object.freeze({
  BAD_ARG: 400, AUTH_REQUIRED: 401, AUTH_INVALID: 401,
  SCHEDULE_GATE_BLOCKED: 409, LOCKED: 409,
  NOT_READY: 503, FS_PARENT_MISSING: 503, NET_ERROR: 503, NET_TIMEOUT: 503,
  SALT_INVALID: 503, SALT_SUSPECT: 503, SALT_MISSING: 503, VERSION_STALE: 503, VERSION_FETCH_FAILED: 503,
  NOT_IMPLEMENTED: 501, INTERNAL: 500,
})

function iso(ms) { return new Date(ms).toISOString() }

/** 错误 → 统一错误对象（§6.1 通用约定 `{ok:false, error:{code, message}}`） */
export function errorPayload(e) {
  if (e && typeof e === 'object' && e.ok === false && e.error) return e // 已是错误对象（如 gate 的 SCHEDULE_GATE_BLOCKED）
  const code = e && e.code ? String(e.code) : INTERNAL_CODE
  const message = (e && e.message ? String(e.message) : String(e)) || ERROR_MESSAGES[code] || code
  const detail = e && e.detail !== undefined && e.detail !== null ? String(e.detail) : null
  return { ok: false, error: { code, message, detail } }
}

/** 具名错误对象（便于 action 层统一） */
export function fail(code, detail, message) {
  return { ok: false, error: { code, message: message || ERROR_MESSAGES[code] || code, detail: detail === undefined ? null : String(detail) } }
}

/** §6.1 status 的 `salts` 段：只给版本/状态/指纹，**绝不给盐明文**（§3.5.7） */
export function summarizeSalts(salts) {
  const s = salts && typeof salts === 'object' ? salts : {}
  const activeRef = s.active && typeof s.active === 'object' ? s.active : null
  const appVersion = activeRef && typeof activeRef.appVersion === 'string' ? activeRef.appVersion : null
  const entries = s.entries && typeof s.entries === 'object' && !Array.isArray(s.entries) ? s.entries : {}
  const entry = appVersion && entries[appVersion] && typeof entries[appVersion] === 'object' ? entries[appVersion] : null
  const salt = entry && typeof entry.salt === 'string' ? entry.salt : null
  const cache = s.versionCache && typeof s.versionCache === 'object' ? s.versionCache : null
  return {
    active: appVersion,
    appVersion,
    clientType: entry && entry.clientType !== undefined && entry.clientType !== null ? String(entry.clientType) : null,
    status: entry ? (entry.status === undefined ? null : String(entry.status)) : 'missing',
    stale: cache && cache.lastFetchOk === false ? true : null,
    saltFingerprint: saltFingerprint(salt),
    entryCount: Object.keys(entries).length,
    lastFetchOk: cache && typeof cache.lastFetchOk === 'boolean' ? cache.lastFetchOk : null,
    fetchedAt: cache && typeof cache.fetchedAt === 'string' ? cache.fetchedAt : null,
    ttlMs: cache && typeof cache.ttlMs === 'number' ? cache.ttlMs : null,
  }
}

/**
 * `schedule` 段（§6.2.1 注③/§6.4.1）：`nextAt` **必须**由窗口/抖动/退避/去重共同解出；
 * 传入 `nextAtMs` 时用它（调度器算出的），否则按窗口起点解（**不用"当前时刻+tickMs"糊弄**）。
 */
export function summarizeSchedule(settings, state, nextAtMs) {
  const st = settings && typeof settings === 'object' ? settings : {}
  const sc = state && state.schedule && typeof state.schedule === 'object' ? state.schedule : {}
  const enabled = sc.enabled === true
  const start = typeof st.windowStart === 'string' ? st.windowStart : SCHEDULER_DEFAULTS.windowStart
  const end = typeof st.windowEnd === 'string' ? st.windowEnd : SCHEDULER_DEFAULTS.windowEnd
  return {
    enabled,
    mode: typeof sc.mode === 'string' ? sc.mode : (enabled ? 'auto' : 'readonly'),
    tickMs: typeof st.tickMs === 'number' ? st.tickMs : SCHEDULER_DEFAULTS.tickMs,
    window: { start, end },
    nextAt: Number.isFinite(nextAtMs) ? iso(nextAtMs) : null,
    lastRunAt: typeof sc.lastRunAt === 'string' ? sc.lastRunAt : null,
    pausedBy: sc.pausedBy === undefined ? null : sc.pausedBy,
  }
}

/** 端口/服务解析（**调用期惰性**，A4）：出站薄封装与版本取回 fetch 都走注入口 */
export function resolvePorts(deps, config, ctx) {
  const d = deps || {}
  const c = config || {}
  const get = (n) => { try { return ctx && typeof ctx.get === 'function' ? ctx.get(n) : undefined } catch (e) { return undefined } }
  const httpPort = (d.httpPort && typeof d.httpPort.request === 'function') ? d.httpPort
    : (c.httpPort && typeof c.httpPort.request === 'function' ? c.httpPort : null)
  const miyousheHttp = (!httpPort && get('miyousheHttp') && typeof get('miyousheHttp').request === 'function') ? get('miyousheHttp') : null
  const fetchImpl = typeof d.fetchImpl === 'function' ? d.fetchImpl : (typeof c.fetchImpl === 'function' ? c.fetchImpl : null)
  const credentialsPort = d.credentialsPort && typeof d.credentialsPort === 'object' ? d.credentialsPort : (c.credentialsPort || null)
  return { httpPort: httpPort || miyousheHttp, fetchImpl, credentialsPort }
}

/** 出站端口**在本次调用上下文里不可用**时的显式降级（生产 `apply` 接线恒自挂端口 ⇒ 不会走到这里） */
export function noHttpPort() {
  return fail('NET_ERROR', '本次上下文未取得 httpPort（未注入 deps.httpPort / config.httpPort / ctx.get("miyousheHttp")，且非 apply 生产接线）：出站薄封装 §10.2 已实现，但需由端口承载', ERROR_MESSAGES.NET_ERROR)
}

/**
 * 账号清单 → 逐组合清单（gate 的 groups 形状：`{accountKey, gameKey}`）；bbs 目标按 `bbsEnabled` 纳入。
 * t39/F3：**带 `region`**（用户核定的 4 个主号里 `bh3` 有 3 个区服 ⇒ 组合/去重键必须按 `gameKey:region` 分开，
 * 否则三个区服共用一个去重键、真实提交只发 1 次）。`schedule.targets` **不在这里**过滤
 * （门禁口径保持"全量组合"；目标筛选发生在调度器 `groupsOf`／`buildDailyPlan`）。
 */
export function groupsFromAccounts(accounts, settings) {
  const st = settings && typeof settings === 'object' ? settings : {}
  const out = []
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!a || typeof a.accountKey !== 'string' || !a.accountKey) continue
    const roles = Array.isArray(a.roles) ? a.roles : (Array.isArray(a.games) ? a.games : [])
    for (const r of roles) {
      const gameKey = r && (r.gameKey || r.target)
      if (typeof gameKey === 'string' && gameKey) {
        const region = r && r.region !== undefined && r.region !== null ? String(r.region) : ''
        // t41/F9：`gameUid` 原值也带下来 —— luna 签到的 POST body 需要 `uid`（外部锚点见 signRequestPlan 头注）
        const gameUid = r && r.gameUid !== undefined && r.gameUid !== null ? String(r.gameUid) : ''
        out.push({ accountKey: a.accountKey, gameKey, region, gameUid, comboKey: gameKey + (region ? ':' + region : '') })
      }
    }
  }
  if (st.bbsEnabled !== false) {
    for (const a of Array.isArray(accounts) ? accounts : []) {
      if (!a || typeof a.accountKey !== 'string' || !a.accountKey) continue
      if (a.bbs === false) continue
      if (!out.some((x) => x.accountKey === a.accountKey && x.gameKey === 'bbs')) out.push({ accountKey: a.accountKey, gameKey: 'bbs', region: '', comboKey: 'bbs' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// t38：`accounts.json` **写入通道**（发现结果本机落盘；出口/日志仍脱敏）
//
// 为什么**落在入口 module** 而不是 `lib/store.js`（t38/A3 的显式理由，可复现）：
//   DSH 的 `sandbox_reload` 只 bust **入口** URL ⇒ 非入口 module（`lib/store.js` 等）在运行期
//   仍是**上一次加载**的那份代码。若本通道依赖「给 store 新加一个 `writeAccounts`」，
//   reload 后新 `index.js` 调旧 `store.js` 上不存在的方法 ⇒ 必然 TypeError
//   ⇒ 要么第 6 次 `host_restart`，要么运行期炸。因此本节**只用**运行期一定存在的三样东西：
//     ① `core.adapterFs`（`apply` 期 `ctx.get('adapterFs')` 注入，早于本次改动即存在）；
//     ② 数据目录断言走 `store.assertDataDir()`（t1 就有的方法，**不新增 store 依赖**）；
//     ③ 其余全部是本节自带的纯函数。⇒ `sandbox_reload` 即生效，**store.js 逐字未动**。
//
// 纪律（与 `lib/store.js` 头注同源，逐条对齐）：
//   - 落盘**只做 `toLossless`、不脱敏**（该文件是本机数据面：签名/门禁需要**完整** uid/region 原值）；
//   - **出口与日志仍必须脱敏**（只给 `uidTail` / `gameUidTail`）；
//   - 凭据值**绝不**进入本文件（`accounts.json` 里没有凭据位；发现请求的凭据只进请求头）；
//   - 相对路径**只用 `REL.accounts`**（不重复字面量）；数据目录不存在 ⇒ 显式 `FS_PARENT_MISSING`（不自动建目录）。
// ---------------------------------------------------------------------------

/** 发现结果 → 落盘账号清单（**纯函数**；保留完整 uid/region，供落盘。出口侧另走脱敏映射，见 actions）
 *  注意：`gameUid` 取 `mapDiscoveredRoles().roles[].gameUid`（**原值**，t38 起由该映射保留；
 *  历史版本只保留 `gameUidTail` ⇒ 落盘会把 uid 写成 null，是本次自测 A2/A4 抓到的真实缺口）。 */
export function accountEntriesFromDiscovery(mapped, identity) {
  const m = mapped && typeof mapped === 'object' ? mapped : {}
  const id = identity && typeof identity === 'object' ? identity : {}
  const roles = Array.isArray(m.roles) ? m.roles : []
  const key = typeof id.accountKey === 'string' && id.accountKey
    ? id.accountKey
    : accountKey(id.uid === undefined || id.uid === null ? null : id.uid)
  if (!key) return []
  return [{
    accountKey: key,
    uid: id.uid === undefined || id.uid === null ? null : String(id.uid),
    roles: roles.map((r) => ({
      gameKey: r && r.gameKey ? String(r.gameKey) : null,
      region: r && r.region !== undefined && r.region !== null ? String(r.region) : null,
      gameUid: r && r.gameUid !== undefined && r.gameUid !== null ? String(r.gameUid) : null,
      nickname: r && r.nickname !== undefined && r.nickname !== null ? String(r.nickname) : null,
      level: r && Number.isFinite(r.level) ? r.level : null,
    })),
  }]
}

/**
 * 发现结果 → **落盘对象**（§4.1 `accounts.json` 形状；**原值**）。
 * `roles` **为空**时：账号键存在 ⇒ 仍然写入该账号（`roles: []`）——**绝不**把已存在的清单覆盖成空文件
 * （覆盖成空 ⇒ 逐组合清单消失 ⇒ 门禁/试签退化为"无待处理组合"）。
 */
export function buildAccountsFile(mapped, identity, nowMs) {
  const accounts = accountEntriesFromDiscovery(mapped, identity)
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now()
  return { version: 1, updatedAt: new Date(ts).toISOString(), accounts }
}

/** 空骨架（缺文件时返回；**不报错**） */
export function emptyAccountsFile() {
  return { version: 1, updatedAt: null, accounts: [] }
}

/** 结构归一化（读回时用；**保留原值**，不做任何脱敏） */
export function normalizeAccountsFile(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (src === null) return emptyAccountsFile()
  const list = Array.isArray(src.accounts) ? src.accounts : []
  const accounts = []
  for (const item of list) {
    const a = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    if (typeof a.accountKey !== 'string' || !a.accountKey) continue
    const roles = Array.isArray(a.roles) ? a.roles : []
    accounts.push({
      accountKey: a.accountKey,
      uid: a.uid === undefined || a.uid === null ? null : String(a.uid),
      roles: roles.map((r) => {
        const x = r && typeof r === 'object' ? r : {}
        return {
          gameKey: x.gameKey === undefined || x.gameKey === null ? null : String(x.gameKey),
          region: x.region === undefined || x.region === null ? null : String(x.region),
          gameUid: x.gameUid === undefined || x.gameUid === null ? null : String(x.gameUid),
          nickname: x.nickname === undefined || x.nickname === null ? null : String(x.nickname),
          level: Number.isFinite(x.level) ? x.level : null,
        }
      }),
    })
  }
  return {
    version: Number.isFinite(src.version) ? src.version : 1,
    updatedAt: src.updatedAt === undefined ? null : src.updatedAt,
    accounts,
  }
}

/**
 * `accounts.json` 只读入口（t38/A2；经 `adapterFs`，**与 store 同根同相对路径**）。
 * 文件缺失 ⇒ 空骨架（不抛）；目录缺失/底座不可用 ⇒ 抛（与 store 同口径，绝不静默）。
 */
export async function readAccountsFile(adapterFs) {
  if (!adapterFs || typeof adapterFs.readJson !== 'function') {
    throw new StoreError('NOT_READY', '数据面未就绪：adapterFs 服务缺失（读取 accounts.json 失败）', 'adapterFs 不可用')
  }
  try {
    return normalizeAccountsFile(await adapterFs.readJson(ROOT_NAME, REL.accounts))
  } catch (e) {
    if (e && e.code === 'FS_NOT_FOUND') return emptyAccountsFile()
    throw e
  }
}

/** `accounts.json` 落盘（t38/A1；**只 `toLossless`、不脱敏**；写前断言目录，不自动建目录） */
export async function writeAccountsFile(core, data) {
  const adapterFs = core && core.adapterFs ? core.adapterFs : null
  if (!adapterFs || typeof adapterFs.writeJson !== 'function') {
    throw new StoreError('NOT_READY', '数据面未就绪：adapterFs 服务缺失（写 accounts.json 失败）', 'adapterFs 不可用')
  }
  if (core.store && typeof core.store.assertDataDir === 'function') await core.store.assertDataDir()
  return adapterFs.writeJson(ROOT_NAME, REL.accounts, toLossless(data))
}

/** 落盘 + 读回（**单一真相源**：回执里的 `accounts` ＝ 磁盘上真实读回的清单） */
export async function persistAccounts(core, mapped, identity, nowMs) {
  const file = buildAccountsFile(mapped, identity, nowMs)
  await writeAccountsFile(core, file)
  return readAccountsFile(core.adapterFs)
}

// ---------------------------------------------------------------------------
// t31：API 通道的业务侧（端点解析 / 结果判定 / 角色映射 / 盐升级）——**纯函数**，便于离线直测
// ---------------------------------------------------------------------------

/** §2.2 账号发现：`data.list[].game_biz` → 内部游戏键 */
const GAME_BIZ_KEYS = Object.freeze({ hk4e_cn: 'hk4e', hkrpg_cn: 'hkrpg', nap_cn: 'zzz', bh3_cn: 'bh3' })

/** `game_biz` → 内部键（未知 ⇒ null；调用方跳过该角色） */
export function gameKeyOfBiz(biz) {
  const s = typeof biz === 'string' ? biz.trim().toLowerCase() : ''
  if (!s) return null
  if (GAME_BIZ_KEYS[s] !== undefined) return GAME_BIZ_KEYS[s]
  for (const p of ['hk4e', 'hkrpg', 'nap', 'bh3']) if (s.indexOf(p) === 0) return p === 'nap' ? 'zzz' : p
  return null
}

/** §2.2 的 `GAME_BIZ_KEYS` **反查**（内部键 → `game_biz`）；未知 ⇒ null（不编造）。
 *  t46/J3：`probe` 的 `/event/luna/info` 需要 `game_biz` 而端点表没有该字段 ⇒ 用同一份 §2.2 表反查，
 *  出处与 `gameKeyOfBiz` 同源（设计 §2.2 L176：`hk4e_cn`/`hkrpg_cn`/`nap_cn`/`bh3_cn`）。 */
export function bizOfGameKey(gameKey) {
  const s = typeof gameKey === 'string' ? gameKey.trim().toLowerCase() : ''
  for (const biz of Object.keys(GAME_BIZ_KEYS)) if (GAME_BIZ_KEYS[biz] === s) return biz
  return null
}

/**
 * t46/J1（F1 裁决的落地）：**已被服务端接受的认证成功**才算「凭据可用」的证据。
 *
 * G1 的语义是"这份凭据**曾被服务端接受过**"；能证明这一点的只有两类成功：
 *   ① `miyoushe_sign{dryRun:false}` 返回 `signed`/`already`（服务端认了这把 Cookie + DS）；
 *   ② `miyoushe_accounts{refresh:true}` 成功取回角色列表（同上）。
 * 失败/风控/`NET_ERROR` **一律不写**（J2）——G1 的证据不能被一次失败的请求污染。
 *
 * 历史缺口：该时间戳只由**凭据写入通道**的回执写，而该通道本切片 `NOT_READY`
 *   ⇒ `lastOkAt` 恒 `null` ⇒ **即便全部目标试签成功，G1 也永远不 ok**（`mode:'auto'` 不可达）。
 * 本函数只做**纯数据变换**（不改状态机、不碰凭据文件内容），由调用方决定何时落盘。
 */
export function withAuthOk(state, nowMsOrIso) {
  const prev = state && state.credentials && typeof state.credentials === 'object' ? state.credentials : {}
  const at = typeof nowMsOrIso === 'string' && nowMsOrIso ? nowMsOrIso : iso(nowMsOrIso === undefined ? Date.now() : nowMsOrIso)
  return Object.assign({}, state, {
    credentials: Object.assign({}, prev, { configured: true, lastOkAt: at }),
  })
}

/**
 * §2.4 账号发现结果 → 角色清单。
 * **两条消费路径，同一份角色数组**：
 *   - `gameUidTail`（尾号）＝**出口**用（actions 只把它放进回执；绝不回显原值）；
 *   - `gameUid`（**原值**）＝仅供 t38 的 **落盘**通道（本机数据面 `accounts.json`）；
 *     **任何出口/日志都不得**取它——`A.accounts` 的出口映射是白名单式重建（只挑尾号），
 *     并有逐字扫描断言（`selftest/sign_path.mjs` A4：5 个 uid 与凭据假值均不得出现在出口文本里）。
 */
export function mapDiscoveredRoles(res) {
  const r = res && typeof res === 'object' ? res : {}
  if (r.ok === false) return { roles: [], reason: String(r.classify === undefined || r.classify === null ? (r.code || 'NET_ERROR') : r.classify) }
  const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {}
  const list = Array.isArray(data.list) ? data.list : []
  const roles = []
  for (const item of list) {
    const it = item && typeof item === 'object' ? item : {}
    const gameKey = gameKeyOfBiz(it.game_biz)
    if (gameKey === null) continue
    const rawUid = it.game_uid === undefined || it.game_uid === null ? it.uid : it.game_uid
    roles.push({
      gameKey,
      region: it.region === undefined || it.region === null ? null : String(it.region),
      gameUid: rawUid === undefined || rawUid === null ? null : String(rawUid), // **原值**：只给落盘
      gameUidTail: uidTail(rawUid), // 出口用
      nickname: it.nickname === undefined || it.nickname === null ? null : String(it.nickname),
      level: Number.isFinite(it.level) ? it.level : null,
    })
  }
  return { roles, reason: roles.length === 0 ? 'EMPTY_LIST' : null }
}

/** 「已签到」语义码族（设计 §11 未验证项：精确码值待试运行期回写；此处只作**启发式**） */
const ALREADY_CODES = Object.freeze([-5003])

/**
 * 提交结果 → §5.2 `outcome`（判定表见 `selftest/sign_path_现场与证据.md`）。
 * 顺序即优先级：先验证码族（人工介入）→ 已签到族 → 成功 → 其余失败。
 */
export function signOutcomeOf(res) {
  const r = res && typeof res === 'object' ? res : {}
  const msg = r.message === undefined || r.message === null ? '' : String(r.message)
  if (r.classify === 'GEETEST_REQUIRED' || /验证|geetest|risk|challenge/i.test(msg)) return 'human_required'
  if (ALREADY_CODES.includes(r.retcode) || /已签到|已经签到|重复签到|已签/.test(msg)) return 'already'
  if (r.ok === true) return 'signed'
  return 'failed'
}

/**
 * 端点解析（§2.1：`act_id` / `host` / `signPath` **一律**来自端点表 `endpoints.json`，**不得写死在逻辑里**）。
 * 返回 `{ ok, requests[], missing[] }`；缺项 ⇒ `ok:false`（调用方报 `ENDPOINT_DRIFT`，不发请求）。
 *
 * **t45（纠正 t43 的误读）：请求形状 = `POST` + `application/json` 的 JSON 请求体**。
 *   锚点两处原文【`gsuid_core/utils/api/mys/`】：
 *   ① `sign_request.py` 的 CN `mys_sign()`（**调用点**）：
 *   ```python
 *   data = { "act_id": _ACT_ID[game_name][server_id], "lang": "zh-cn", "uid": uid, "region": server_id }
 *   data = await self._mys_request(url=end_point, method="POST", header=HEADER, data=data, base_url=base_url, game_name=game_name)
 *   ```
 *   ② 父类 `base_request.py` 的 `_mys_request`（**真正发请求处**，这才是权威）：
 *   ```python
 *   async def _mys_request(self, url, method="GET", header=None, params=None, data=None, …):
 *       """…  data: JSON body（POST 等）；部分 GET 也会带 body。 …"""
 *           async with session.request(method, url, headers=header, params=params, json=data, timeout=…):
 *   ```
 *   ⇒ 锚点把 `data=` 交给 aiohttp 的 **`json=`**（**JSON 请求体**），**不是** form-urlencoded；
 *   对照：同文件的 `get_sign_list`/`get_sign_info` 用 `params=` 走 query（`json=` 与 `params=` 是两回事）。
 *   **t43 按"调用点 `data=` + `requests` 语义"判为 form-urlencoded 是误读** —— 本项目用的是 **aiohttp**，
 *   权威在 `_mys_request` 内部的 `json=data`。本任务据此把编码纠正为 JSON。
 *   ⇒ 参数清单仍由**端点表**声明 `"bodyParams": ["act_id","lang","uid","region"]`（守 §2.1「不得写死在逻辑里」），
 *   代码按清单**填值**；**编码**也由表声明可选 `"bodyFormat"`（`"json"`/`"form"`），未声明时**默认 `json`**（对齐锚点）。
 *   取值映射：`act_id ← cfg.actId` · `lang ← cfg.lang`（缺省 `zh-cn`，**有出处**：同源 body 字面量）·
 *              `uid ← 角色 gameUid` · `region ← 角色 region`。
 *   **向后兼容**：未声明 `bodyParams`（也未声明 t41 的过渡字段 `signParams`）⇒ **退回旧行为**（仅 `act_id` 入 query、无 body）。
 *   t41 的 `signParams`（把参数放 query）只存在过一个中间版本；若表里仍写着它，会被当作"旧行为"处理。
 * t41/F11：**`bbs` 免 `actId`**（其路径 `/apihub/app/api/signIn` 不使用 `act_id`，设计 §2.2 该条亦无此字段）
 *   ⇒ 仅 `bbs` 可缺 `actId`；其余目标保持非空硬校验。bbs 声明 `bodyParams: []` ⇒ 无 body。
 */
export function signRequestPlan(endpoints, groups, today) {
  const table = endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints) ? endpoints : {}
  const map = table.endpoints && typeof table.endpoints === 'object' && !Array.isArray(table.endpoints) ? table.endpoints : table
  const requests = []
  const missing = []
  for (const g of Array.isArray(groups) ? groups : []) {
    const cfg = map[g.gameKey] && typeof map[g.gameKey] === 'object' && !Array.isArray(map[g.gameKey]) ? map[g.gameKey] : null
    const path = cfg && typeof cfg.signPath === 'string' && cfg.signPath ? cfg.signPath : null
    if (!cfg || path === null) { missing.push(g.gameKey + '（缺 signPath）'); continue }
    const act = typeof cfg.actId === 'string' && cfg.actId ? cfg.actId : null
    // t41/F11：`bbs` 的路径不使用 act_id ⇒ 只有非 bbs 目标才硬校验
    if (act === null && g.gameKey !== 'bbs') { missing.push(g.gameKey + '（缺 actId）'); continue }
    const region = g.region === undefined || g.region === null ? '' : String(g.region)
    const roleUid = g.gameUid === undefined || g.gameUid === null ? '' : String(g.gameUid)
    /** 按声明清单填值（bodyParams 与过渡期 signParams 共用同一填值逻辑） */
    const fillParam = (name, out) => {
      if (name === 'act_id') { if (act !== null) out.act_id = act; return }
      if (name === 'lang') { out.lang = typeof cfg.lang === 'string' && cfg.lang ? cfg.lang : 'zh-cn'; return }
      if (name === 'uid') { if (roleUid !== '') out.uid = roleUid; return }
      if (name === 'region') { if (region !== '') out.region = region; return }
    }
    const declaredBody = Array.isArray(cfg.bodyParams) ? cfg.bodyParams.filter((x) => typeof x === 'string' && x) : null
    const legacyQuery = Object.assign({}, cfg.query && typeof cfg.query === 'object' ? cfg.query : {})
    let method = 'POST'
    let query = legacyQuery
    let body = undefined
    let contentType = null
    if (declaredBody !== null) {
      // t45（**单一变量**）：body 编码由**锚点实况**决定 —— 锚点 `sign_request.py` 调
      //   `self._mys_request(..., data=data)`，而父类 `base_request.py` 的 `_mys_request` 在**真正发请求处**是
      //   ```python
      //   async with session.request(method, url, headers=header, params=params, json=data, timeout=…)
      //   ```
      //   其 docstring 亦逐字写明 `data: JSON body（POST 等）` ⇒ **锚点发的是 `application/json` 的 JSON 请求体**，
      //   **不是** form-urlencoded。t43 曾按"调用点 `data=` + requests 语义"判为 form ⇒ **那是误读**，本任务纠正。
      //   仍守 §2.1：编码**由端点表声明**（`cfg.bodyFormat`，可写 `"json"`/`"form"`）；未声明时**默认 `json`**（对齐锚点）。
      const bodyFormat = typeof cfg.bodyFormat === 'string' && cfg.bodyFormat ? cfg.bodyFormat : 'json'
      const fields = {}
      for (const name of declaredBody) fillParam(name, fields)
      if (Object.keys(fields).length > 0) {
        if (bodyFormat === 'form') {
          body = Object.keys(fields).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(fields[k]))).join('&')
          contentType = 'application/x-www-form-urlencoded'
        } else {
          body = JSON.stringify(fields)
          contentType = 'application/json'
        }
      }
    } else if (Array.isArray(cfg.signParams)) {
      // 过渡期字段（t41）：仍在 query 里（**仅为向后兼容**；本仓数据面已改用 bodyParams）
      for (const name of cfg.signParams.filter((x) => typeof x === 'string' && x)) fillParam(name, query)
    } else {
      // 旧行为（G2）：仅 `act_id` 入 query、无 body
      if (act !== null) query.act_id = act
    }
    const qs = Object.keys(query).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k]))).join('&')
    requests.push({
      accountKey: g.accountKey,
      gameKey: g.gameKey,
      target: g.gameKey,
      region,
      comboKey: typeof g.comboKey === 'string' && g.comboKey ? g.comboKey : (g.gameKey + (region ? ':' + region : '')),
      // t39/P10：**region 感知**去重键（bh3 三区服 ⇒ 3 个互不相同的键，绝不折叠成一个）
      dedupeKey: dedupeKey(g.accountKey, g.gameKey, today, region),
      method,
      path: path + (qs ? '?' + qs : ''),
      body,
      contentType,
      host: typeof cfg.host === 'string' && cfg.host ? cfg.host : undefined,
    })
  }
  return { ok: missing.length === 0, requests, missing }
}

/**
 * S3 盐升级（设计 §3.2「更新路径」④）：**首次成功提交**后，该版本条目 `unverified-current → verified`
 * （`verifiedAt` 非空），`active` 随之非空 ⇒ 门禁 G4 的 `unverified-current` 分支自动消失（自愈）。
 * 返回新 salts（纯函数）；已是 `verified` 或条目不存在/被拒 ⇒ `null`（不写盘）。
 */
export function upgradeSalts(salts, saltInfo, nowMs) {
  const s = salts && typeof salts === 'object' ? salts : {}
  const ver = saltInfo && typeof saltInfo.appVersion === 'string' && saltInfo.appVersion ? saltInfo.appVersion : null
  if (ver === null) return null
  const entries = Object.assign({}, s.entries && typeof s.entries === 'object' ? s.entries : {})
  const prev = entries[ver] && typeof entries[ver] === 'object' ? entries[ver] : null
  if (!prev) return null
  if (prev.status === 'verified' || prev.status === 'rejected') return null
  entries[ver] = Object.assign({}, prev, { status: 'verified', verifiedAt: new Date(nowMs).toISOString(), rejectedAt: null })
  const curActive = s.active && typeof s.active === 'object' ? s.active : null
  const active = curActive && curActive.appVersion && curActive.appVersion !== ver
    ? curActive
    : { appVersion: ver, clientType: prev.clientType === undefined || prev.clientType === null ? '5' : prev.clientType }
  return Object.assign({}, s, { updatedAt: new Date(nowMs).toISOString(), entries, active })
}

/**
 * 只取凭据文件里的**身份字段**（t31/S1）——**不返回**凭据值本身，供 `accounts` 等展示面使用；
 * 凭据值仅由 `apply` 的凭据 provider 取出并直接进请求头（**绝不**进入出口/日志）。
 */
async function readCredentialIdentity(core) {
  try {
    const file = await core.store.readCredentials()
    const p = file && file.primary ? file.primary : null
    if (!p) return null
    return {
      accountKey: p.accountKey || null,
      uid: p.uid === undefined ? null : p.uid,
      createdAt: p.createdAt === undefined ? null : p.createdAt,
      lastOkAt: p.lastOkAt === undefined ? null : p.lastOkAt,
    }
  } catch (e) { return null }
}

/**
 * t50/O3（R4）：门禁 hint 的**可执行性纠偏**。
 *
 * 问题：`lib/gate.js` 的 G2 hint 写「对该账号该游戏单独试签一次（`miyoushe_run {…, dryRun:false}`）…」，
 *   但 `A.run` 的**真实提交分支尚未实现**（恒 `NET_ERROR`）⇒ 用户照做必然失败（指引不可执行）。
 * 做法：在**出口处**把带 `miyoushe_run` 的 hint 改写为可执行的 `miyoushe_sign{dryRun:false}`（保留 scope 里的
 *   `accountKey`/`gameKey`）。**正解是改 `gate.js` 的 hint 文案**（本任务 outOfScope）⇒ 已登记为后续任务；
 *   此处只做出口纠偏，保证"用户照做能成功"。
 */
export function fixGateHints(reasons) {
  const list = Array.isArray(reasons) ? reasons : []
  return list.map((r) => {
    if (!r || typeof r !== 'object') return r
    const h = typeof r.hint === 'string' ? r.hint : ''
    if (h.indexOf('miyoushe_run') === -1) return r
    const sc = r.scope && typeof r.scope === 'object' ? r.scope : {}
    const ak = typeof sc.accountKey === 'string' && sc.accountKey ? sc.accountKey : null
    const gk = typeof sc.gameKey === 'string' && sc.gameKey ? sc.gameKey : null
    const call = 'miyoushe_sign {' + (ak ? "accountKey:'" + ak + "', " : '') + (gk ? "gameKey:'" + gk + "', " : '') + 'dryRun:false}'
    return Object.assign({}, r, {
      hint: '对该账号该游戏单独试签一次（' + call + '）——用 **sign** 而非 run（`miyoushe_run` 的真实提交分支尚未实现，恒 `NET_ERROR`）；确认 App 里出现奖励后再开启定时',
    })
  })
}

/** 门禁对象的**字段形状**（A7：与 lib/gate.js 逐字段一致，绝不改名/自造） */
export function gateShape(g) {
  const x = g && typeof g === 'object' ? g : {}
  return {
    ok: x.ok === true,
    mode: x.mode === undefined ? 'readonly' : x.mode,
    overridden: x.overridden === true,
    hardBlocked: x.hardBlocked === true,
    hardItems: Array.isArray(x.hardItems) ? x.hardItems : [],
    softItems: Array.isArray(x.softItems) ? x.softItems : [],
    reasons: fixGateHints(Array.isArray(x.reasons) ? x.reasons : []),
    failedByGroup: x.failedByGroup && typeof x.failedByGroup === 'object' ? x.failedByGroup : {},
    truncated: x.truncated === true,
    missingGroups: Number.isFinite(x.missingGroups) ? x.missingGroups : 0,
    totalFailingGroups: Number.isFinite(x.totalFailingGroups) ? x.totalFailingGroups : 0,
    evaluatedGroups: Number.isFinite(x.evaluatedGroups) ? x.evaluatedGroups : 0,
    groupsEmpty: x.groupsEmpty === true,
    maxReasonEntries: Number.isFinite(x.maxReasonEntries) ? x.maxReasonEntries : 20,
    reasonScope: x.reasonScope === undefined ? 'per-group' : x.reasonScope,
    effective: x.effective && typeof x.effective === 'object' ? x.effective : {},
    at: typeof x.at === 'string' ? x.at : null,
  }
}

/**
 * createCore({ adapterFs, version, now, execute, httpPort, fetchImpl, credentialsPort, logger, config }) —— 纯本地核心。
 * 保留 t2/t11 的 `ping`/`status`（形参/行为不变），并接入 `scheduler`（§5）与自检用 deps。
 */
export function createCore(deps) {
  const d = deps || {}
  const store = createStore({ adapterFs: d.adapterFs })
  const version = typeof d.version === 'string' ? d.version : PACKAGE_VERSION
  const nowFn = typeof d.now === 'function' ? d.now : () => Date.now()
  const config = d.config && typeof d.config === 'object' ? d.config : {}
  const ports = resolvePorts(d, config, null)

  // t82/P0①：`execute` 改为**惰性解析的引用 + 未接线即显式抛错**。
  //   旧写法 `typeof d.execute === 'function' ? d.execute : undefined` 在生产里恒为 undefined
  //   （`apply` 只从 `config.execute` 取，而 config 从不带它）⇒ `tick()` 走 else 分支把每条结果标成
  //   `would_run` ⇒ 紧接着的 `if (r.outcome === 'would_run') continue` 把结果**整批丢弃**：
  //   不写 doneKeys、不记 lastError、attempts 不增长 ⇒ 无限重试。这正是 2026-09-21 的 P0 故障。
  //   现在：未接线时**抛 EXECUTE_NOT_WIRED** ⇒ 被 tick 的 per-task catch 收成 `failed` 结果 ⇒ 正常落账、
  //   attempts 增长 ⇒ `maxAttemptsPerDay` 上限生效（**不再静默吞掉**）；`apply` 会在下面把真实提交接进来。
  const execRef = { fn: typeof d.execute === 'function' ? d.execute : null }
  const scheduler = createScheduler({
    store,
    clock: nowFn,
    execute: async function (task) {
      if (typeof execRef.fn !== 'function') throw new Error('EXECUTE_NOT_WIRED')
      return await execRef.fn(task)
    },
    logger: d.logger,
    config: { lockTtlMs: LOCK_TTL_MS, pid: d.pid },
    rand: typeof d.rand === 'function' ? d.rand : null, // t39：随机源可注入（离线自测可复现）
  })

  const core = {
    store, scheduler, version, config, ports, now: nowFn, execRef,
    adapterFs: d.adapterFs || null,
    logger: d.logger || null, // t38：落盘告警出口（createActions 读 core.logger；消息不含凭据/完整 uid）
    hasDataFace: () => store.hasDataFace(),
  }

  /** 存活探针：**不依赖数据面**（adapterFs 缺失也返回 ok:true），只报数据面可用性 */
  core.ping = async function ping() {
    return exitPayload({
      ok: true, plugin: 'miyoushe', version, slice: SLICE, ts: iso(nowFn()),
      dataFace: store.hasDataFace(),
      actions: ACTIONS.length, tools: TOOL_NAMES.length,
      route: { kind: ROUTE_KIND, path: API_PREFIX, charset: 'utf-8' },
    }, 'miyoushe_ping')
  }

  /** 状态：全脱敏；只读；两条降级分支 = NOT_READY / FS_PARENT_MISSING（行为与 t2 一致） */
  core.status = async function status() {
    try {
      await store.assertDataDir()
      const [settings, salts, state, credPresence, logsDirPresent] = await Promise.all([
        store.readSettings(), store.readSalts(), store.readState(), store.readCredentialsPresence(), store.logsDirPresent(),
      ])
      let nextAtMs = null
      try {
        const s = await scheduler.schedule({ now: nowFn() })
        nextAtMs = s && s.ok && typeof s.nextAt === 'string' ? Date.parse(s.nextAt) : null
      } catch (e) { nextAtMs = null }
      return exitPayload({
        ok: true, plugin: 'miyoushe', version, slice: SLICE, ts: iso(nowFn()),
        ready: true,
        dataDir: DATA_DIR_HINT,
        todaySummary: null, // 占位：需真实签到链路的当日汇总（后续任务）
        accountsSummary: null, // 占位：需 §2.4 账号发现（后续任务）
        credentials: {
          // 与 action 层同口径：**文件存在**（真凭据落盘处）或 state 缓存的 configured
          configured: credentialConfiguredOf(credPresence, state.credentials),
          lastOkAt: state.credentials && state.credentials.lastOkAt ? state.credentials.lastOkAt : null,
          uidTail: null,
        },
        salts: summarizeSalts(salts),
        schedule: summarizeSchedule(settings, state, nextAtMs),
        logsDirPresent,
        lastError: null,
      }, 'miyoushe_status')
    } catch (e) {
      return exitPayload(errorPayload(e), 'miyoushe_status:error')
    }
  }

  return core
}

// ---------------------------------------------------------------------------
// 数据面读取（统一错误映射；全部经 store → adapterFs）
// ---------------------------------------------------------------------------
async function readWorld(core) {
  const store = core.store
  if (!store.hasDataFace()) return { error: fail('NOT_READY', "ctx.get('adapterFs') 返回 undefined 或不满足契约") }
  try {
    await store.assertDataDir()
  } catch (e) {
    return { error: errorPayload(e) }
  }
  try {
    const settings = await store.readSettings()
    const salts = await store.readSalts()
    const state = await store.readState()
    let accounts = []
    try { const a = await store.readAccounts(); accounts = Array.isArray(a && a.accounts) ? a.accounts : [] } catch (e) { accounts = [] }
    let endpointsReadable = false
    let endpoints = null
    try { const ep = await store.readEndpoints(); endpointsReadable = !!(ep && typeof ep === 'object'); endpoints = ep } catch (e) { endpointsReadable = false; endpoints = null }
    let credPresence = { configured: false }
    try { credPresence = await store.readCredentialsPresence() } catch (e) { credPresence = { configured: false } }
    // 凭据"已配置"的判定＝**文件存在**（真凭据落盘处）或 state 里缓存的 configured（§6.1 status 的口径）
    const stateCred = state && state.credentials && typeof state.credentials === 'object' ? state.credentials : {}
    const credentials = {
      configured: credentialConfiguredOf(credPresence, stateCred),
      lastOkAt: stateCred.lastOkAt === undefined ? null : stateCred.lastOkAt,
      filePresent: credPresence.configured === true,
    }
    // t50/N1：**读侧就地迁移 legacy 3 段键** ⇒ 门禁（G3）、去重、以及随后的写盘（sign/enable）看到的
    //   都是同一份干净 `doneKeys`。**不改**原文件的其它部分；仅在确有移除时构造新对象。
    const migrated = migrateLegacyDoneKeys(state && state.doneKeys)
    const stateClean = migrated.changed ? Object.assign({}, state, { doneKeys: migrated.doneKeys }) : state
    // t52/G2c：**读侧回填**「已在当前盐下被服务端受理」的当日记录到 lastSignSuccess（captain 裁决 (i)）。
    //   只在**确有回填**时写一条审计日志（幂等：回填后再次读入不会再产生 filled）。
    const nowMsRead = typeof core.now === 'function' ? core.now() : Date.now()
    const bf = backfillSameSaltSuccess(stateClean, salts, { now: nowMsRead })
    if (bf.filled.length > 0) {
      try {
        await core.store.appendLog({
          event: 'maintenance', action: 'backfill_same_salt_success', at: iso(nowMsRead),
          basis: 'doneKey.at >= salts.active.verifiedAt', reason: '既有当日记录已证明"服务端用当前盐受理过"',
          filled: bf.filled.map((x) => ({ target: x.target, dedupeKey: x.dedupeKey, at: x.at, status: x.status, prev: x.prev })),
        })
      } catch (e) { /* 日志失败不阻断读路径 */ }
    }
    return { settings, salts, state: bf.state, accounts, endpointsReadable, endpoints, credPresence, credentials, legacyKeysRemoved: migrated.removed, sameSaltBackfilled: bf.filled }
  } catch (e) {
    return { error: errorPayload(e) }
  }
}

/** 读当日（或指定日期）日志行（经 adapterFs.readText；文件不存在 ⇒ 空数组） */
async function readLogLines(core, date, limit) {
  const adapterFs = core.adapterFs
  const rel = REL.logsDir + '/' + date + '.ndjson'
  if (!adapterFs || typeof adapterFs.readText !== 'function') return { lines: [], unreadable: true, detail: 'adapterFs 不可用' }
  let text = ''
  try {
    text = await adapterFs.readText('全局数据', rel)
  } catch (e) {
    if (e && e.code === 'FS_NOT_FOUND') return { lines: [], unreadable: false }
    return { lines: [], unreadable: true, detail: String(e && e.message || e) }
  }
  const all = String(text).split(/\r?\n/).filter((l) => l.length > 0)
  const take = Number.isFinite(limit) && limit > 0 ? all.slice(-Math.floor(limit)) : all
  const lines = []
  for (const l of take) { try { lines.push(JSON.parse(l)) } catch (e) { lines.push({ raw: '(非法 JSON 行，已跳过解析)' }) } }
  return { lines, unreadable: false, total: all.length }
}

// ---------------------------------------------------------------------------
// §6.1 十二个 action 的实现（每个都返回**已经过 exitPayload**的对象）
// ---------------------------------------------------------------------------
export function createActions(core) {
  const ports = core.ports || {}
  const nowFn = core.now || (() => Date.now())
  /** 告警出口（与 `apply` 的 warn 同语义）：只报错误码与文件相对路径，**消息里绝不带凭据/完整 uid** */
  const warn = (m) => {
    try {
      const logger = core.logger || null
      if (logger && typeof logger.warn === 'function') logger.warn(m)
      else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(m + '\n')
    } catch (e) { /* 日志失败不阻断 */ }
  }

  async function worldOr(actionLabel, fn) {
    const w = await readWorld(core)
    if (w.error) return exitPayload(w.error, actionLabel + ':error')
    return fn(w)
  }

  const A = {}

  A.ping = async () => core.ping()

  A.status = async () => core.status()

  /**
   * §6.1 accounts：`refresh:true` 才发出站请求（经 `ports.httpPort`；默认实现＝`lib/mys-http.js`）。
   * t38：**刷新成功后把发现结果落盘** `全局数据/miyoushe/accounts.json`（本机数据面**保留原值**；
   * 回执与日志仍只给尾号），使后续 `sign`/`run`/`enable` 读到非空组合清单。
   */
  A.accounts = async (input) => {
    const i = input || {}
    return worldOr('accounts', async (w) => {
      const refresh = i.refresh === true
      const cached = (w.accounts || []).map((a) => ({
        accountKey: a.accountKey,
        uidTail: a.uid === undefined || a.uid === null ? null : uidTail(a.uid),
        roles: (Array.isArray(a.roles) ? a.roles : (Array.isArray(a.games) ? a.games : [])).map((r) => ({
          gameKey: r && (r.gameKey || r.target) ? String(r.gameKey || r.target) : null,
          region: r && r.region ? String(r.region) : null,
          gameUidTail: r && (r.gameUid !== undefined || r.uid !== undefined) ? uidTail(r.gameUid === undefined ? r.uid : r.gameUid) : null,
          nickname: r && r.nickname ? String(r.nickname) : null,
          level: Number.isFinite(r && r.level) ? r.level : null,
        })),
      }))
      if (!refresh) return exitPayload({ ok: true, source: 'cache', accounts: cached, count: cached.length }, 'miyoushe_accounts')
      if (!w.credentials.configured) return exitPayload(fail('AUTH_REQUIRED'), 'miyoushe_accounts:error')
      if (!ports.httpPort) return exitPayload(noHttpPort(), 'miyoushe_accounts:error')
      const res = await ports.httpPort.request({ path: '/binding/api/getUserGameRolesByCookie', method: 'GET' }) // discipline-exempt: 官方端点路径: /binding/api/getUserGameRolesByCookie（§2.4 账号发现的官方路径原文）
      // t46/J1：**认证成功**（服务端认下这把凭据并返回角色列表，`res.ok===true` 即 retcode 0）⇒ 写
      //   `credentials.lastOkAt`（G1 的唯一证据源）。失败（`AUTH_INVALID`/`NET_ERROR`/非 0 retcode）
      //   **一律不写**（J2）。写盘失败**不回滚**本次发现，但要如实回执（不谎报 authOk）。
      let authOk = !!(res && res.ok === true)
      let authOkAt = null
      if (authOk) {
        try {
          const authState = withAuthOk(w.state, nowFn())
          await core.store.writeState(authState)
          authOkAt = authState.credentials.lastOkAt
        } catch (e) {
          authOk = false
          warn('[miyoushe] accounts 认证时间戳（credentials.lastOkAt）落盘失败：' + String(e && e.message ? e.message : e))
        }
      }
      // t31/S4：把薄封装归一化的 `data.list[]` 映射为角色清单；t38：同一结果**落盘**（原值）后再回执
      const mapped = mapDiscoveredRoles(res)
      const credFile = await readCredentialIdentity(core)
      const credKey = credFile && typeof credFile.accountKey === 'string' && credFile.accountKey ? credFile.accountKey : null
      const firstUid = credFile && credFile.uid !== undefined && credFile.uid !== null ? credFile.uid : null
      const accKey = credKey || accountKey(firstUid)
      const roleList = (mapped.roles || []).map((r) => ({
        gameKey: r && r.gameKey ? String(r.gameKey) : null,
        region: r && r.region !== undefined && r.region !== null ? String(r.region) : null,
        gameUidTail: r && r.gameUid !== undefined && r.gameUid !== null ? uidTail(r.gameUid) : null,
        nickname: r && r.nickname !== undefined && r.nickname !== null ? String(r.nickname) : null,
        level: r && Number.isFinite(r.level) ? r.level : null,
      }))
      // t38/A1：**落盘通道**。`identity.uid` 优先取凭据文件里的**原值 uid**，缺失时回落到官方角色列表同源字段；
      //   两者都缺 ⇒ 该位 `null`（不编造）。
      const listUidRaw = (() => {
        const data = res && res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {}
        const lst = Array.isArray(data.list) ? data.list : []
        for (const it of lst) { if (it && it.uid !== undefined && it.uid !== null && String(it.uid)) return String(it.uid) }
        return null
      })()
      const identity = { accountKey: accKey, uid: firstUid === null ? listUidRaw : firstUid }
      let persisted = false
      let persistedReason = null
      let fileAccounts = []
      try {
        const saved = await persistAccounts(core, mapped, identity, nowFn())
        fileAccounts = Array.isArray(saved && saved.accounts) ? saved.accounts : []
        persisted = true
      } catch (e) {
        const code = e && e.code ? String(e.code) : 'FS_IO_ERROR'
        persistedReason = code + '：' + String(e && e.message ? e.message : e)
        // 落盘失败**不回滚**本次发现（内存值仍如实回执），但**绝不**谎报 persisted
        warn('[miyoushe] accounts 落盘失败（' + persistedReason + '）：本次仅返回新鲜清单，persisted:false')
      }
      const readBack = persisted && fileAccounts.length ? fileAccounts : null
      const fromFile = persisted
        ? fileAccounts.map((a) => ({
          accountKey: a.accountKey,
          uidTail: uidTail(a.uid),
          roles: (Array.isArray(a.roles) ? a.roles : []).map((r) => ({
            gameKey: r && r.gameKey ? String(r.gameKey) : null,
            region: r && r.region !== undefined && r.region !== null ? String(r.region) : null,
            gameUidTail: uidTail(r && r.gameUid),
            nickname: r && r.nickname !== undefined && r.nickname !== null ? String(r.nickname) : null,
            level: r && Number.isFinite(r.level) ? r.level : null,
          })),
        }))
        : null
      return exitPayload({
        ok: true, source: 'refresh', persisted,
        // t46/J1：认证成功 ⇒ 同时回执 `lastOkAt`（G1 的证据；**时间戳**，不含凭据任何片段）
        authOk, lastOkAt: authOkAt,
        path: REL.accounts,
        note: persisted
          ? '发现结果已落盘 ' + REL.accounts + '（本机数据面**保留原值**、不脱敏；出口/日志仍只给尾号）'
          : '落盘未成功（' + String(persistedReason) + '）：本次仅返回新鲜清单，persisted:false（未静默丢掉失败原因）',
        accounts: fromFile || (roleList.length || accKey ? [{ accountKey: accKey, uidTail: uidTail(firstUid), roles: roleList }] : []),
        count: roleList.length,
        persistedCount: readBack ? readBack.length : 0,
        reason: mapped.reason,
      }, 'miyoushe_accounts')
    })
  }

  /**
   * §6.1 sign：`dryRun` 省略 ⇒ 按 **true**（保守：见证据登记）。`dryRun` ⇒ 只做本地判定、**零出站**；
   * `dryRun:false` ⇒ 走真实提交（需 `ports.httpPort` 与已配置凭据；`apply` 生产接线里恒已就绪）。
   * `force:true` 只在当日该组合处于 `human_required` 时合法（§8.1）。
   * t46/J1：提交结果里出现 `signed`/`already` ⇒ 写 `credentials.lastOkAt`（G1 的证据源）。
   */
  A.sign = async (input) => {
    const i = input || {}
    return worldOr('sign', async (w) => {
      const groupsAll = groupsFromAccounts(w.accounts, w.settings)
      // t50/O1+O2：与门禁侧同源（`settings.targets`）+ 支持 `region`/`comboKey` 精确选中单组合。
      // 被 targets 排除的组合**不提交**，但**如实列出**（`excludedByTargets`）供审计 —— 不再静默 7 连发。
      const selected = selectGroupsForAction(groupsAll, w.settings, i)
      const scTargets = w.settings && w.settings.schedule && Array.isArray(w.settings.schedule.targets) ? w.settings.schedule.targets : []
      const selectedKeys = {}
      for (const g of selected) selectedKeys[(g.accountKey || '') + '\u0000' + (g.comboKey || '')] = true
      const excludedByTargets = groupsAll
        .filter((g) => !selectedKeys[(g.accountKey || '') + '\u0000' + (g.comboKey || '')])
        .filter((g) => !targetSelected(scTargets, g.comboKey || (g.gameKey + (g.region ? ':' + g.region : ''))))
        .map((g) => ({ comboKey: g.comboKey || null, accountKey: g.accountKey, reason: 'not_in_schedule_targets' }))
      const dryRun = i.dryRun !== false // 省略 ⇒ true（保守）
      const today = localDateOf(nowFn())
      const results = []
      const pending = [] // t31/S2：只有**未终态**的组合才进入提交计划（终态 ⇒ skipped_done，绝不重复提交，§5.2）
      for (const g of selected) {
        // t39/P10：**region 感知**去重键（同账号 bh3 三区服 ⇒ 三个不同键，绝不折叠成一个）；
        // 读旧记录时新键优先、旧 3 段键回退（升级前留下的 human_required/signed 不会被"看不见"）
        const key = dedupeKey(g.accountKey, g.gameKey, today, g.region)
        const found = lookupDoneEntry(w.state.doneKeys, g.accountKey, g.gameKey, today, g.region)
        const entry = found.entry
        if (entry && ['signed', 'already'].includes(entry.status)) { results.push({ accountKey: g.accountKey, target: g.gameKey, region: g.region || '', comboKey: g.comboKey || null, outcome: 'skipped_done', dedupeKey: key, entryKey: found.key, legacyKey: found.legacy === true, retcode: entry.retcode === undefined ? null : entry.retcode }); continue }
        if (i.force === true && (!entry || entry.status !== 'human_required')) {
          return exitPayload(fail('BAD_ARG', 'force:true 只在当日该组合处于 human_required 时合法（§8.1）；当前 status=' + JSON.stringify(entry ? entry.status : null), 'force 参数非法'), 'miyoushe_sign:error')
        }
        if (dryRun) { results.push({ accountKey: g.accountKey, target: g.gameKey, region: g.region || '', comboKey: g.comboKey || null, outcome: 'would_run', dedupeKey: key, entryKey: found.key, legacyKey: found.legacy === true, dryRun: true }); continue }
        // t31/S2：**非 dryRun 不再预置占位结果**——真实 outcome 由下面的提交循环按服务端响应逐条 push
        // （历史上这里预置 `failed`+NET_ERROR，会让 results[0] 变成占位行、掩盖真实结论）
        pending.push(g)
      }
      // t50/O1：回执新增 `targetsUsed` + `excludedByTargets`（被 `settings.targets` 排除、因此**不会**提交的组合）
      const base = { ok: true, dryRun, selected: selected.length, targetsUsed: scTargets.slice(), excludedByTargets, results, at: iso(nowFn()) }
      if (!dryRun && selected.length > 0) {
        if (!w.credentials.configured) return exitPayload(fail('AUTH_REQUIRED'), 'miyoushe_sign:error')
        if (!ports.httpPort) return exitPayload(noHttpPort(), 'miyoushe_sign:error')
        // t31/S2：真实提交。端点（act_id/host/signPath）一律取端点表（§2.1），缺项 ⇒ 结构化拒绝且不发请求
        const plan = signRequestPlan(w.endpoints, pending, today)
        if (!plan.ok) {
          return exitPayload(fail('ENDPOINT_DRIFT', '端点表缺项（§2.1：act_id/host/signPath 一律来自 `全局数据/miyoushe/endpoints.json`，不得写死在逻辑里）：' + plan.missing.join('；')), 'miyoushe_sign:error')
        }
        const saltInfo = activeSaltInfo(w.salts)
        // t41/F10：**实际签名上下文**（与 `lib/mys-http.js` 的 resolveSigningContext **同口径**）。
        // 现状缺口：`activeSaltInfo` 只读 `active` ⇒ 当 `active` 为空（D-8）时它报 `status:"missing"`，
        // 但端口实际**回退用了最新的 `unverified-current`** 条目完成了签名 ⇒ 回执显示"没盐"，与事实不符。
        // 这里补一层"回退溯源"：active 不可用 ⇒ 取最新 unverified-current（fetchedAt 最新优先、缺失则版本键字典序最大）。
        const effectiveSalt = (() => {
          if (saltInfo.appVersion && saltInfo.entryPresent) return { appVersion: saltInfo.appVersion, status: saltInfo.status, source: 'active', fingerprint: saltInfo.fingerprint }
          const entries = w.salts && typeof w.salts.entries === 'object' && !Array.isArray(w.salts.entries) ? w.salts.entries : {}
          const usable = Object.keys(entries)
            .filter((v) => entries[v] && typeof entries[v] === 'object' && entries[v].status === 'unverified-current' && typeof entries[v].salt === 'string')
            .sort((a, b) => {
              const fa = typeof entries[a].fetchedAt === 'string' ? entries[a].fetchedAt : ''
              const fb = typeof entries[b].fetchedAt === 'string' ? entries[b].fetchedAt : ''
              if (fa !== fb) return fa < fb ? 1 : -1
              return a < b ? 1 : -1
            })
          if (usable.length === 0) return { appVersion: null, status: 'missing', source: 'none', fingerprint: null }
          const v = usable[0]
          return { appVersion: v, status: 'unverified-current', source: 'latest_unverified', fingerprint: saltFingerprint(entries[v].salt) }
        })()
        const isTrial = effectiveSalt.status === 'unverified-current'
        let nextState = w.state
        let upgraded = null
        const pauseCodes = []
        for (const reqSpec of plan.requests) {
          // t45：形状与锚点同形 —— POST + **JSON body**（`body`/`contentType` 由计划给出；t43 曾误判为 form-urlencoded）
          const r = await ports.httpPort.request({
            path: reqSpec.path, method: reqSpec.method || 'POST', target: reqSpec.target,
            accountKey: reqSpec.accountKey, signGame: reqSpec.gameKey, host: reqSpec.host,
            body: reqSpec.body, contentType: reqSpec.contentType,
          })
          const outcome = signOutcomeOf(r)
          nextState = applyResult(nextState, {
            dedupeKey: reqSpec.dedupeKey, outcome,
            retcode: r && r.retcode, message: r && r.message, now: nowFn(),
            accountKey: reqSpec.accountKey, target: reqSpec.gameKey,
            // t45：成功证据必须记在「实际用于签名的盐」上，而不是 `activeSaltInfo`。
            //   缺口（t45 首次真实试签成功后现场暴露）：`active` 为空时 `saltInfo.fingerprint/appVersion` 均为 null
            //   ⇒ `lastSignSuccess.saltFingerprint=null` ⇒ 门禁 G2③「与当前盐同源」证据为空。
            saltFingerprint: effectiveSalt.fingerprint, appVersion: effectiveSalt.appVersion,
          })
          if (outcome === 'human_required') pauseCodes.push('GEETEST_REQUIRED')
          if (r && r.classify === 'AUTH_INVALID') pauseCodes.push('AUTH_INVALID')
          // t45：盐升级（§3.2 更新路径 ④）同样必须用「实际盐」。旧写法传 `saltInfo`：`unverified-current`
          //   回退期 `active` 为 null ⇒ `upgradeSalts` 直接返回 null ⇒ **真实签到已成功也不自愈**、G4 永久硬阻断。
          if (outcome === 'signed' && upgraded === null) upgraded = upgradeSalts(w.salts, { appVersion: effectiveSalt.appVersion, status: effectiveSalt.status, fingerprint: effectiveSalt.fingerprint }, nowFn())
          results.push({
            accountKey: reqSpec.accountKey, target: reqSpec.gameKey, outcome, dedupeKey: reqSpec.dedupeKey,
            httpStatus: r && r.httpStatus, retcode: r && r.retcode, classify: r && r.classify,
            messageMasked: r && r.message ? String(r.message) : null,
          })
        }
        const lastOutcome = results.length ? results[results.length - 1].outcome : 'idle'
        // t46/J1+J2：**只有"已被服务端接受的认证成功"**（`signed`/`already`）才更新 `credentials.lastOkAt`
        //   （G1 的唯一证据源）；`failed`/`human_required`/风控/`NET_ERROR`/`AUTH_INVALID` **一律不写**。
        //   注意：`skipped_done`（当日去重跳过）**不算**认证成功 —— 它没有向服务端证明过任何东西。
        const authOkAt = results.filter((r) => r.outcome === 'signed' || r.outcome === 'already')
        const prevSched = nextState.schedule && typeof nextState.schedule === 'object' ? nextState.schedule : {}
        nextState = Object.assign({}, nextState, {
          schedule: Object.assign({}, prevSched, {
            lastRunAt: iso(nowFn()), lastOutcome,
            pausedBy: pauseCodes.length ? pauseCodes[0] : (prevSched.pausedBy === undefined ? null : prevSched.pausedBy),
          }),
        })
        if (authOkAt.length > 0) nextState = withAuthOk(nextState, nowFn())
        await core.store.writeState(nextState)
        if (upgraded) await core.store.writeSalts(upgraded)
        return exitPayload(Object.assign(base, {
          dryRun: false, results, lastOutcome,
          // t46/J1：**已被服务端接受的认证成功**（`signed`/`already`）⇒ 写 `credentials.lastOkAt`（G1 的证据源）
          authOk: authOkAt.length > 0,
          lastOkAt: authOkAt.length > 0 ? nextState.credentials.lastOkAt : null,
          // t41/F10：**反映实际签名上下文**（不再是只读 active 的 "missing"）
          saltStatus: upgraded ? 'verified' : effectiveSalt.status,
          saltSource: upgraded ? 'active' : effectiveSalt.source,
          saltAppVersion: effectiveSalt.appVersion,
          saltFingerprint: effectiveSalt.fingerprint,
          trial: upgraded ? false : isTrial,
          verified: !!upgraded,
          pausedBy: pauseCodes.length ? pauseCodes[0] : null,
          note: upgraded
            ? '首次成功提交 ⇒ 该版本条目已升级为 verified 且 active 已设置（设计 §3.2 更新路径 ④；G4 的 unverified-current 分支自愈）'
            : (isTrial
              ? '试签：使用**回退的 unverified-current** 盐完成签名（active 仍为空 ⇒ 无人值守仍被门禁 G4 正确硬阻断；成功后本字段会升级为 verified）'
              : '提交完成（未发生盐升级）'),
        }), 'miyoushe_sign')
      }
      return exitPayload(Object.assign(base, { note: dryRun ? 'dryRun：只做本地判定（**未提交任何请求**）。真实提交需显式传 dryRun:false（API 出站通道已接线）；当日已 signed/already 的组合会显示 skipped_done 而不再提交' : '无待处理组合' }), 'miyoushe_sign')
    })
  }

  /** §6.1 logs：读当日/指定日期 ndjson（已脱敏；message 走默认掩码出口） */
  A.logs = async (input) => {
    const i = input || {}
    return worldOr('logs', async () => {
      const date = typeof i.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.date) ? i.date : localDate(nowFn())
      const r = await readLogLines(core, date, Number.isFinite(i.limit) ? i.limit : undefined)
      if (r.unreadable) return exitPayload(fail('FS_PARENT_MISSING', '日志目录/文件不可读：' + (r.detail || REL.logsDir)), 'miyoushe_logs:error')
      return exitPayload({ ok: true, date, count: r.lines.length, total: r.total === undefined ? r.lines.length : r.total, lines: r.lines }, 'miyoushe_logs')
    })
  }

  /**
   * §6.1 config：白名单键（未知键拒绝）；`salts` 写入只回指纹。
   * t39/P1：`schedule` 段新增三个键的**形状校验 + 非法值拒绝**（`spreadMinGapMs` / `spreadJitterMs` / `targets`）。
   * **fail-closed 原则**（与 `lib/scheduler.js` 读侧同口径）：非法值一律 `BAD_ARG` 拒绝、**不静默夹取**
   * —— 静默把颠倒区间 `[120000,30000]` 夹成 `[120000,120000]` 会把一次笔误放大成"每次必然 +2 分钟"。
   */
  const CONFIG_KEYS = ['tickMs', 'windowStart', 'windowEnd', 'dailyJitterMs', 'accountGapMs', 'maxAttemptsPerDay', 'backoffMs', 'bbsEnabled', 'autoFetchVersion', 'allowLateSign', 'schedule']
  /** `schedule` 段允许写入的键（其余**显式拒绝**，不静默丢弃） */
  const SCHEDULE_KEYS = ['enabled', 'mode', 'spreadMinGapMs', 'spreadJitterMs', 'targets']
  /** `schedule` 补丁校验（**纯函数**）：`{ok:true, value}` 或 `{ok:false, message}` */
  function validateSchedulePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, message: 'schedule 必须是对象' }
    const unknown = Object.keys(patch).filter((k) => !SCHEDULE_KEYS.includes(k))
    if (unknown.length) return { ok: false, message: 'schedule 内未知键（白名单外：' + SCHEDULE_KEYS.join(', ') + '）：' + unknown.join(', ') }
    const out = {}
    for (const k of Object.keys(patch)) {
      const v = patch[k]
      if (k === 'spreadMinGapMs') {
        if (!Number.isFinite(v) || v < 0 || Math.floor(v) !== v) return { ok: false, message: 'schedule.spreadMinGapMs 必须是非负整数毫秒（默认 ' + SPREAD_DEFAULTS.spreadMinGapMs + '＝10 分钟）' }
        out[k] = v
        continue
      }
      if (k === 'spreadJitterMs') {
        if (!Array.isArray(v) || v.length !== 2) return { ok: false, message: 'schedule.spreadJitterMs 必须是 [lo, hi] 两元素数组（默认 [' + SPREAD_DEFAULTS.spreadJitterMs.join(', ') + ']＝30 秒–2 分钟）' }
        const lo = v[0]
        const hi = v[1]
        // 颠倒（lo > hi）/ 负数 / 小数 / 非数 ⇒ **拒绝**（不夹取）
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo || Math.floor(lo) !== lo || Math.floor(hi) !== hi) {
          return { ok: false, message: 'schedule.spreadJitterMs 必须是 [lo, hi] 且 0 ≤ lo ≤ hi 的整数毫秒区间（**不夹取**：请显式给出正确区间）' }
        }
        out[k] = [lo, hi]
        continue
      }
      if (k === 'targets') {
        if (!Array.isArray(v)) return { ok: false, message: 'schedule.targets 必须是数组（元素形如 "hk4e:cn_gf01"；空数组 ⇒ 全部组合）' }
        for (const item of v) {
          if (typeof item !== 'string' || !/^[a-z0-9]+(:[A-Za-z0-9_]+)?$/.test(item.trim())) {
            return { ok: false, message: 'schedule.targets 元素非法：' + JSON.stringify(item) + '（应形如 "hk4e:cn_gf01" 或 "bh3"）' }
          }
        }
        out[k] = v.map((x) => x.trim())
        continue
      }
      if (k === 'enabled') {
        if (typeof v !== 'boolean') return { ok: false, message: 'schedule.enabled 必须是布尔（开启请用 miyoushe_enable 以过门禁）' }
        out[k] = v
        continue
      }
      out[k] = v
    }
    return { ok: true, value: out }
  }
  /**
   * 写入前补齐 `schedule` 段三项的**缺省值**（t39/P1 的"默认值"落地处；**干净安装**也必须有缺省）。
   * 只补缺省/非法项、不覆盖用户已设值；显式关掉（`0` + `[0,0]`）会被尊重（不会被改回缺省）。
   */
  function normalizeScheduleDefaults(sched) {
    const s = sched && typeof sched === 'object' && !Array.isArray(sched) ? Object.assign({}, sched) : {}
    if (!Number.isFinite(s.spreadMinGapMs) || s.spreadMinGapMs < 0 || Math.floor(s.spreadMinGapMs) !== s.spreadMinGapMs) s.spreadMinGapMs = SPREAD_DEFAULTS.spreadMinGapMs
    const j = s.spreadJitterMs
    if (!Array.isArray(j) || j.length !== 2 || !Number.isFinite(j[0]) || !Number.isFinite(j[1]) || j[0] < 0 || j[1] < j[0]) s.spreadJitterMs = SPREAD_DEFAULTS.spreadJitterMs.slice()
    if (!Array.isArray(s.targets)) s.targets = SPREAD_DEFAULTS.targets.slice()
    return s
  }
  A.config = async (input) => {
    const i = input || {}
    return worldOr('config', async (w) => {
      const patch = i.patch && typeof i.patch === 'object' ? i.patch : null
      if (!patch) return exitPayload(fail('BAD_ARG', '缺少 patch 对象'), 'miyoushe_config:error')
      // t52/Q3：**受控维护/清理**（与配置补丁**互斥**，避免"顺手改配置"与"顺手清数据"混在一批里）。
      //   硬约束：精确匹配（禁通配）、必须给 reason（写审计日志）、上限 8 条、**绝不发任何请求**。
      if (patch.maintenance !== undefined) {
        if (Object.keys(patch).length !== 1) return exitPayload(fail('BAD_ARG', 'maintenance 必须单独使用（不得与其它配置键同批）'), 'miyoushe_config:error')
        const v = validateMaintenance(patch.maintenance)
        if (!v.ok) return exitPayload(fail('BAD_ARG', v.message, 'maintenance 参数非法'), 'miyoushe_config:error')
        const mv = v.value
        const todayLocal = localDate(nowFn())
        const dk = w.state && w.state.doneKeys && typeof w.state.doneKeys === 'object' ? w.state.doneKeys : {}
        const nextDone = Object.assign({}, dk)
        const cleared = []
        const notFound = []
        for (const req of mv.clearDoneKeys) {
          let hit = 0
          for (const key of Object.keys(dk)) {
            const segs = String(key).split(':')
            if (segs.length !== 3 && segs.length !== 4) continue
            const dateLocal = segs[2]
            const target = segs[1]
            const accountId = segs[0]
            const region = segs.length === 4 ? segs[3] : ''
            if (dateLocal !== todayLocal) continue          // 只清**当日**（历史键由 T2 的当日限定处理，不该被顺手删）
            if (accountId !== req.accountKey) continue
            if (target !== req.gameKey) continue
            if (req.region !== null && req.region !== '' && region !== req.region) continue
            delete nextDone[key]
            cleared.push(key)
            hit++
          }
          if (hit === 0) notFound.push({ accountKey: req.accountKey, gameKey: req.gameKey, region: req.region })
        }
        let lastOkAtReset = false
        const cred = w.state && w.state.credentials && typeof w.state.credentials === 'object' ? w.state.credentials : {}
        const nextCred = mv.resetLastOkAt ? Object.assign({}, cred, { lastOkAt: null, lastOkAtResetAt: iso(nowFn()) }) : cred
        lastOkAtReset = mv.resetLastOkAt === true
        const nextState = Object.assign({}, w.state, { doneKeys: nextDone, credentials: nextCred })
        // t80（补丁②b）：`clearDailyPlan` ⇒ **只**删 `state.dailyPlan` 这一项（其余键逐一按原样带入 nextState）。
        //   不碰 doneKeys（其上仅按 mv.clearDoneKeys 逐条精确清理）/ credentials.lastOkAt / salts / 签到记录。
        if (mv.clearDailyPlan === true) delete nextState.dailyPlan
        await core.store.writeState(nextState)
        // 审计日志（**必须**写；含 what/why，**不含凭据**）
        // t80 注：`hasLegacyAction` 对**所有往日合法调用恒为 true**（旧校验要求 clearDoneKeys 非空 或 resetLastOkAt:true）
        //   ⇒ 该守卫对既有语义**零影响**；它只是避免「仅 clearDailyPlan」时多出一条空的 clear_done_keys 记录。
        const hasLegacyAction = cleared.length > 0 || mv.clearDoneKeys.length > 0 || mv.resetLastOkAt === true
        if (hasLegacyAction) {
          try {
            await core.store.appendLog({
              event: 'maintenance', action: 'clear_done_keys', at: iso(nowFn()), reason: mv.reason,
              clearedKeys: cleared, clearedCount: cleared.length, notFound,
              resetLastOkAt: lastOkAtReset, noRequest: true,
            })
          } catch (e) { warn('[miyoushe] maintenance 审计日志写入失败：' + String(e && e.message ? e.message : e)) }
        }
        // t80：`clearDailyPlan` 的审计**单独成条**（action 互不混淆，便于日后按 action 检索）
        if (mv.clearDailyPlan === true) {
          try {
            await core.store.appendLog({
              event: 'maintenance', action: 'clear_daily_plan', at: iso(nowFn()), reason: mv.reason,
              clearedDailyPlan: true, clearedKeys: cleared, clearedCount: cleared.length,
              resetLastOkAt: lastOkAtReset, noRequest: true,
            })
          } catch (e) { warn('[miyoushe] maintenance 审计日志写入失败：' + String(e && e.message ? e.message : e)) }
        }
        return exitPayload({
          ok: true, action: 'maintenance', clearedKeys: cleared, clearedCount: cleared.length, notFound,
          resetLastOkAt: lastOkAtReset, clearedDailyPlan: mv.clearDailyPlan === true, reason: mv.reason,
          note: '受控清理：**只删当日、逐条精确匹配**的 doneKeys 键（未发任何请求、未改 doneKeys 的其它键）；审计日志已写入 logs（event:maintenance）',
        }, 'miyoushe_config')
      }
      const unknown = Object.keys(patch).filter((k) => !CONFIG_KEYS.includes(k) && k !== 'salts')
      if (unknown.length) return exitPayload(fail('BAD_ARG', '未知配置键（白名单外）：' + unknown.join(', ')), 'miyoushe_config:error')
      let schedulePatch = null
      if (patch.schedule !== undefined) {
        const v = validateSchedulePatch(patch.schedule)
        if (!v.ok) return exitPayload(fail('BAD_ARG', v.message, 'schedule 参数非法'), 'miyoushe_config:error')
        schedulePatch = v.value
      }
      const settingsPatch = {}
      for (const k of Object.keys(patch)) if (k !== 'salts' && k !== 'schedule') settingsPatch[k] = patch[k]
      const nextSettings = Object.assign({}, w.settings, settingsPatch)
      if (schedulePatch) nextSettings.schedule = normalizeScheduleDefaults(Object.assign({}, w.settings.schedule || {}, schedulePatch))
      await core.store.writeSettings(nextSettings)
      let saltSummary = summarizeSalts(w.salts)
      if (patch.salts && typeof patch.salts === 'object') {
        const entries = Object.assign({}, (w.salts && w.salts.entries) || {})
        const added = []
        const addedEntries = []
        for (const [ver, v] of Object.entries(patch.salts)) {
          const salt = v && typeof v.salt === 'string' ? v.salt : null
          if (typeof ver !== 'string' || !/^\d+\.\d+\.\d+$/.test(ver) || !salt) return exitPayload(fail('BAD_ARG', 'salts patch 形状非法：需要 { "<x.y.z>": { salt: "…" } }'), 'miyoushe_config:error')
          const fp = saltFingerprint(salt)
          entries[ver] = { clientType: (v.clientType || '5'), salt, saltFingerprint: fp, status: 'unverified-current', sourceKind: 'manual', source: 'config patch（用户手填）', fetchedAt: null, verifiedAt: null, rejectedAt: null }
          added.push(ver)
          addedEntries.push({ appVersion: ver, saltFingerprint: fp, saltStatus: 'unverified-current', sourceKind: 'manual' })
        }
        const nextSalts = Object.assign({}, w.salts, { version: (w.salts && w.salts.version) || 2, updatedAt: iso(nowFn()), entries })
        await core.store.writeSalts(nextSalts)
        saltSummary = summarizeSalts(nextSalts)
        return exitPayload({ ok: true, changedKeys: Object.keys(patch), saltsAdded: added, saltsAddedEntries: addedEntries, salts: saltSummary }, 'miyoushe_config')
      }
      return exitPayload({ ok: true, changedKeys: Object.keys(patch), salts: saltSummary }, 'miyoushe_config')
    })
  }

  /**
   * §6.1 credentials：**只进不出**（A8 ⇒ `strict:true` 出口）。
   * 凭据写入通道本切片未接线（store.js 只提供"存在性探测"）⇒ 无注入端口时显式 `NOT_READY`；有端口则调用它，**永不回显**。
   */
  A.credentials = async (input) => {
    const i = input || {}
    return worldOr('credentials', async (w) => {
      const action = i.action
      if (action !== 'set' && action !== 'clear') return exitPayload(fail('BAD_ARG', 'action 必须是 set 或 clear'), 'credentials:error', { strict: true })
      if (action === 'set' && (typeof i.cookie !== 'string' || i.cookie.length === 0)) return exitPayload(fail('BAD_ARG', 'set 需要非空 cookie 字符串'), 'credentials:error', { strict: true }) // discipline-exempt: 设计规定的入参名: miyoushe_credentials.cookie（§6.2.1 第 12 行的入参名，非值）
      const out = { ok: true, action, configured: w.credentials.configured, uidTail: null, lastOkAt: null, warning: '凭据只存本机、绝不回显；本响应不含 cookie 任何片段' } // discipline-exempt: 用户可见文案: 凭据回执 warning 原文（凭据只存本机、绝不回显；§4.2 只进不出）
      if (!ports.credentialsPort || typeof ports.credentialsPort[action] !== 'function') {
        return exitPayload(fail('NOT_READY', '凭据写入通道不可用（既未注入 credentialsPort，也未接线 store 落盘通道）', ERROR_MESSAGES.NOT_READY), 'credentials:error', { strict: true })
      }
      let res = null
      try {
        // t52/Q1：`set` 多带一个 `{uid}`（可选，覆盖启发式推断）；端口实现可忽略第二参（向后兼容旧注入端口）
        res = await ports.credentialsPort[action === 'set' ? 'set' : 'clear'](action === 'set' ? i.cookie : undefined, action === 'set' ? { uid: i.uid } : undefined) // discipline-exempt: 设计规定的入参名: 凭据端口入参 cookie（§6.2.1 第 12 行 action=set 分支）
      } catch (e) {
        // 错误分支**同样**走 strict 出口；只回稳定错误码与原因类别，**不回**任何入参/凭据片段
        const code = e && e.code ? String(e.code) : 'FS_IO_ERROR'
        return exitPayload(fail(code, '凭据写入失败（原因类别：' + code + '；为"只进不出"，不回报任何入参或凭据片段）'), 'credentials:error', { strict: true })
      }
      if (res && res.ok === false && res.code) {
        return exitPayload(fail(String(res.code), '凭据写入被拒绝（原因类别：' + String(res.code) + '）'), 'credentials:error', { strict: true })
      }
      out.configured = !!(res && res.configured !== undefined ? res.configured : (action === 'set'))
      out.uidTail = res && res.uidTail ? String(res.uidTail) : null
      out.lastOkAt = res && res.lastOkAt ? String(res.lastOkAt) : null
      if (action === 'clear') out.removed = !!(res && res.removed === true)
      return exitPayload(out, 'miyoushe_credentials', { strict: true })
    })
  }

  /** §6.4.1 schedule：只读；含 `gate`（字段形状＝gate.js，A7）与调度器解出的 `nextAt` */
  A.schedule = async () => {
    return worldOr('schedule', async (w) => {
      const s = await core.scheduler.schedule({ now: nowFn() })
      const groupsAll = groupsFromAccounts(w.accounts, w.settings)
      // t44/H1：门禁只看**调度实际会签**的组合（与 `dailyPlan.items` 同源）；展示面 `groups` 仍给全量+过滤结果
      const groups = filterGroupsForTargets(groupsAll, w.settings)
      const gate = gateShape(evaluateGate(w.state, w.salts, w.settings, {
        groups, scope: 'all',
        credentials: w.credentials,
        readiness: { settingsReadable: true, endpointsReadable: w.endpointsReadable, dataDirExists: true },
        now: nowFn(),
      }))
      const ok = s.ok ? s : { enabled: false, mode: 'readonly', tickMs: SCHEDULER_DEFAULTS.tickMs, window: { start: SCHEDULER_DEFAULTS.windowStart, end: SCHEDULER_DEFAULTS.windowEnd }, nextAt: null, nextTargets: [], lastRunAt: null, lastOutcome: null, pausedBy: null, spread: null, dailyPlan: null, dailyPlanPersisted: false, dailyPlanSource: 'candidate' }
      // t50/N2：**计划来源显式标注**（读侧不写盘 ⇒ `persisted:false` 时给的是候选计划，不是权威时刻表）。
      //   `persisted:true`（= `scheduler.schedule()` 判定 `state.dailyPlan` 可复用）时 `dailyPlan` 与
      //   `state.dailyPlan` **同一个对象** ⇒ 逐字一致。`nextAt` 的口径：由 `planTick` 基于当日计划
      //   （若未落盘则是**候选**计划）解出的"下次可能执行的时刻"，因此 `persisted:false` 时它同样只是候选值。
      const dpPersisted = ok.dailyPlanPersisted === true
      const dpSource = dpPersisted ? 'persisted' : 'candidate'
      const planNote = dpPersisted
        ? 'dailyPlan 来自 state.dailyPlan（权威、已落盘；次日/组合或设置变化时重掷）'
        : 'dailyPlan 为**候选**（读侧不写盘：`state.dailyPlan` 缺失或已失效 ⇒ 现场现算）。**权威计划**在该日首次 `tick` 落盘后才存在；`nextAt` 亦基于此候选计划解出 ⇒ 仅供预览'
      return exitPayload({
        ok: true,
        enabled: ok.enabled, mode: ok.mode, tickMs: ok.tickMs, window: ok.window,
        nextAt: ok.nextAt, nextTargets: ok.nextTargets, lastRunAt: ok.lastRunAt, lastOutcome: ok.lastOutcome,
        pausedBy: ok.pausedBy,
        // t39：分散时刻（P2/P3/P8）——每个组合的计划时刻都可见，便于审计"是否真的分散"；**不含 uid**
        spread: ok.spread || null,
        dailyPlan: ok.dailyPlan || null,
        // t50/N2：计划来源（避免把候选计划误当成权威时刻表 —— captain 曾据此误报"今晚 22:26/22:38/…"）
        dailyPlanPersisted: dpPersisted,
        dailyPlanSource: dpSource,
        dailyPlanNote: planNote,
        legacyKeysRemoved: Array.isArray(w.legacyKeysRemoved) ? w.legacyKeysRemoved : [], // t50/N1：本次读侧迁移掉的 legacy 3 段键
        gate, groups,
        groupsAll, // t44：全量组合（不过滤）便于对照审计；`groups` 才是门禁/实际会签的集合
      }, 'miyoushe_schedule')
    })
  }

  /**
   * §6.4.2 enable：**先过门禁**（§6.5）；不满足 ⇒ `SCHEDULE_GATE_BLOCKED`（错误对象里带 `reasons[]` + `gate`，形状＝gate.js）。
   * 空组合清单 ⇒ `groupsEmpty:true` ⇒ G5 硬阻断（A7：双参越权也无效）。
   */
  A.enable = async (input) => {
    const i = input || {}
    return worldOr('enable', async (w) => {
      const scope = i.scope === 'account' ? 'account' : 'all'
      // t44/H1：门禁 groups 与调度目标同源（同 `A.schedule`，避免"被排除的组合永久挡住 G2"）
      const groups = filterGroupsForTargets(groupsFromAccounts(w.accounts, w.settings), w.settings)
      const gate = gateShape(evaluateGate(w.state, w.salts, w.settings, {
        groups, scope, accountKey: i.accountKey,
        credentials: w.credentials,
        readiness: { settingsReadable: true, endpointsReadable: w.endpointsReadable, dataDirExists: true },
        confirm: i.confirm === true, acknowledgeUnverified: i.acknowledgeUnverified === true,
        now: nowFn(),
      }))
      const sched = await core.scheduler.schedule({ now: nowFn() })
      if (!gate.ok) {
        const err = toGateError(gate, ERROR_MESSAGES.SCHEDULE_GATE_BLOCKED)
        return exitPayload({ ok: false, error: { code: err.code, message: err.message, reasons: err.reasons, gate: gateShape(err.gate) } }, 'miyoushe_enable:error')
      }
      const alreadyEnabled = sched.ok && sched.enabled === true
      if (alreadyEnabled) {
        return exitPayload({ ok: true, changed: false, enabled: true, mode: sched.mode, nextAt: sched.nextAt, gate, note: ERROR_MESSAGES.SCHEDULE_ALREADY_ON }, 'miyoushe_enable')
      }
      const nextSettings = Object.assign({}, w.settings, { schedule: Object.assign({}, w.settings.schedule || {}, { enabled: true, mode: gate.mode }) })
      await core.store.writeSettings(nextSettings)
      const nextState = Object.assign({}, w.state, {
        schedule: Object.assign({}, w.state.schedule || {}, { enabled: true, mode: gate.mode, pausedBy: null, enabledAt: iso(nowFn()), gateSnapshot: { hardBlocked: gate.hardBlocked, hardItems: gate.hardItems, softItems: gate.softItems, overridden: gate.overridden } }),
      })
      await core.store.writeState(nextState)
      try { await core.store.appendLog({ event: 'config_change', field: 'schedule.enabled', from: false, to: true, mode: gate.mode, overridden: gate.overridden, gateSnapshot: { softItems: gate.softItems, hardItems: gate.hardItems } }) } catch (e) { /* 日志失败不阻断 */ }
      return exitPayload({ ok: true, changed: true, enabled: true, mode: gate.mode, nextAt: sched.ok ? sched.nextAt : null, gate }, 'miyoushe_enable')
    })
  }

  /** §6.4.3 disable：降风险方向，**不设二次确认**；幂等 |
   *  注意：不得清除"只读降级"根因（仅保证"不再自动发请求"） */
  A.disable = async (input) => {
    const i = input || {}
    return worldOr('disable', async (w) => {
      const sched = await core.scheduler.schedule({ now: nowFn() })
      if (sched.ok && sched.enabled !== true) {
        return exitPayload({ ok: true, changed: false, enabled: false, note: ERROR_MESSAGES.SCHEDULE_ALREADY_OFF }, 'miyoushe_disable')
      }
      const nextSettings = Object.assign({}, w.settings, { schedule: Object.assign({}, w.settings.schedule || {}, { enabled: false }) })
      await core.store.writeSettings(nextSettings)
      const nextState = Object.assign({}, w.state, { schedule: Object.assign({}, w.state.schedule || {}, { enabled: false, mode: 'readonly' }) })
      await core.store.writeState(nextState)
      try { await core.store.appendLog({ event: 'config_change', field: 'schedule.enabled', from: true, to: false, scope: i.scope === 'account' ? 'account' : 'all' }) } catch (e) { /* 日志忽略 */ }
      return exitPayload({ ok: true, changed: true, enabled: false, note: '已暂停：不再自动提交任何签到请求；手动 miyoushe_run 仍可用（默认 dryRun:true）' }, 'miyoushe_disable')
    })
  }

  /** §6.4.4 run：手动触发一次；**`dryRun` 省略 ⇒ true** |
   *  `enabled` 开关不变；`force:true` 仅用于 human_required 后人工重试一次 */
  A.run = async (input) => {
    const i = input || {}
    return worldOr('run', async (w) => {
      const dryRun = i.dryRun !== false
      // t50/O1+O2：与 `A.sign` **同一套**选择器（targets 同源 + region/comboKey 精确选中）
      const groups = selectGroupsForAction(groupsFromAccounts(w.accounts, w.settings), w.settings, i)
      const now = nowFn()
      const today = localDateOf(now)
      const dry = await core.scheduler.tick({ now, dryRun: true, force: true }).catch((e) => ({ ok: false, error: errorPayload(e) }))
      const results = groups.map((g) => {
        // t39/P10：与 `dedupeKey` 一致的 region 感知键（新键优先、旧 3 段键回退读）
        const key = dedupeKey(g.accountKey, g.gameKey, today, g.region)
        const found = lookupDoneEntry(w.state.doneKeys, g.accountKey, g.gameKey, today, g.region)
        const entry = found.entry
        const d = decideOne({ now, settings: w.settings, entry, dedupeKey: key, dateLocal: today, enabled: true })
        return { accountKey: g.accountKey, target: g.gameKey, region: g.region || '', comboKey: g.comboKey || null, dedupeKey: key, entryKey: found.key, legacyKey: found.legacy === true, outcome: entry && ['signed', 'already'].includes(entry.status) ? 'skipped_done' : (d.decision === 'run' ? 'would_run' : d.reason), reason: d.reason }
      })
      if (!dryRun) {
        if (!w.credentials.configured) return exitPayload(fail('AUTH_REQUIRED'), 'miyoushe_run:error')
        if (!ports.httpPort) return exitPayload(noHttpPort(), 'miyoushe_run:error')
        return exitPayload(fail('NET_ERROR', 'miyoushe_run 的真实提交分支**尚未实现**（出站通道本身已接线：真实提交请用 miyoushe_sign{dryRun:false}）'), 'miyoushe_run:error')
      }
      return exitPayload({
        ok: true, dryRun: true, triggeredAt: iso(now), results,
        plan: dry && dry.plan ? dry.plan : null,
        note: 'dryRun：只做本地判定（未提交任何请求）。**本工具的真实提交分支尚未实现**（显式 dryRun:false 恒返回 `NET_ERROR`）——真实提交请用 `miyoushe_sign{dryRun:false}`；enabled 开关不受影响',
      }, 'miyoushe_run')
    })
  }

  /** §6.1/§3.5 version：get 只读；refresh 需注入 fetchImpl；set 只回指纹；verify 需出站 */
  A.version = async (input) => {
    const i = input || {}
    const action = ['get', 'refresh', 'set', 'verify'].includes(i.action) ? i.action : 'get'
    return worldOr('version', async (w) => {
      const now = nowFn()
      const info = activeSaltInfo(w.salts)
      const cache = cacheState(w.salts.versionCache, now, { ttlMs: (w.salts.versionCache && w.salts.versionCache.ttlMs) || CACHE_TTL_MS })
      const stale = evaluateVersionStaleness(w.salts, now, {})
      const base = {
        ok: true, action,
        appVersion: info.appVersion,
        clientType: info.clientType,
        saltStatus: info.status,
        saltFingerprint: info.fingerprint,
        stale: stale.stale === true,
        staleCode: stale.code,
        fetchedAt: w.salts.versionCache && w.salts.versionCache.fetchedAt ? w.salts.versionCache.fetchedAt : null,
        ttlMs: (w.salts.versionCache && w.salts.versionCache.ttlMs) || CACHE_TTL_MS,
        nextFetchAt: cache.fresh ? iso(Date.parse(w.salts.versionCache.fetchedAt) + ((w.salts.versionCache.ttlMs) || CACHE_TTL_MS)) : null,
        matchResult: matchVersion(w.salts, info.appVersion),
        source: cache.fresh ? 'cache' : 'none',
        entryCount: info.entryCount === undefined ? Object.keys((w.salts && w.salts.entries) || {}).length : info.entryCount,
      }
      if (action === 'set') {
        const appVersion = typeof i.appVersion === 'string' ? i.appVersion : null
        const salt = typeof i.salt === 'string' ? i.salt : null
        if (!appVersion || !/^\d+\.\d+\.\d+$/.test(appVersion) || !salt) return exitPayload(fail('BAD_ARG', 'set 需要 appVersion（x.y.z）与非空 salt'), 'miyoushe_version:error')
        if (!/^[0-9a-fA-F]{32}$/.test(salt)) return exitPayload(fail('SALT_INVALID', 'salt 形状非法（要求 32 位 hex）⇒ 拒绝、不落盘（§3.5.4）'), 'miyoushe_version:error')
        const candidate = buildCandidateEntry({ appVersion, appSalt: salt, webSalt: salt }, { clientType: i.clientType || '5', source: 'miyoushe_version set（用户手填）', sourceUrl: null, fetchedAt: iso(now) })
        const merged = mergeCandidate(w.salts, candidate, { nowIso: iso(now), now })
        const nextSalts = Object.assign({}, merged.salts, { active: { appVersion, clientType: candidate.entry.clientType } })
        await core.store.writeSalts(nextSalts)
        return exitPayload(Object.assign({}, base, {
          appVersion, clientType: candidate.entry.clientType, saltStatus: merged.salts.entries[appVersion].status,
          saltFingerprint: fingerprint(salt), written: true, mergeAction: merged.action,
          audit: { event: 'version.manual_set', saltFingerprint: fingerprint(salt), sourceKind: 'manual' },
        }), 'miyoushe_version')
      }
      if (action === 'refresh') {
        if (!ports.fetchImpl) {
          return exitPayload(fail('VERSION_FETCH_FAILED', '本次上下文未取得 fetchImpl（生产 apply 接线在未注入时会自挂 §3.5.8 受控默认出站；离线自测不挂 ⇒ 显式失败，不静默回落直连）'), 'miyoushe_version:error')
        }
        // §3.5.8 固定 UA 的版本段：已配置 active 版本 → 用之；否则回退 versionCache 里**上次成功取回的版本**；
        // 都没有（首取）→ 'unknown'（保留 buildVersionRequest 的既有口径）。
        const uaVersion = info.appVersion || (w.salts.versionCache && w.salts.versionCache.appVersion) || 'unknown'
        const r = await fetchVersionCandidates({ fetchImpl: ports.fetchImpl, now, appVersion: uaVersion })
        if (!r.ok) {
          const code = r.code === VERSION_ERR.SALT_SHAPE_INVALID ? 'SALT_INVALID' : (r.code === VERSION_ERR.SALT_MISSING ? 'SALT_MISSING' : 'VERSION_FETCH_FAILED')
          return exitPayload(fail(code, (r.detail || '') + '；attempts=' + (r.attempts || []).map((a) => a.sourceId + ':' + (a.httpStatus === null ? a.error : a.httpStatus)).join(',')), 'miyoushe_version:error')
        }
        const merged = mergeCandidate(w.salts, r.candidate, { nowIso: iso(now), now, fetchHttpStatus: r.httpStatus })
        const withCache = Object.assign({}, merged.salts, {
          versionCache: { appVersion: r.appVersion, clientType: (r.candidate && r.candidate.entry && r.candidate.entry.clientType) || '5', fetchedAt: iso(now), ttlMs: (w.salts.versionCache && w.salts.versionCache.ttlMs) || CACHE_TTL_MS, sourceUrl: r.sourceUrl, sourceEtag: null, lastFetchOk: true, lastFetchError: null },
        })
        await core.store.writeSalts(withCache)
        const decision = decideVersionOutcome({ salts: withCache, fetchResult: r, now })
        return exitPayload(Object.assign({}, base, {
          appVersion: r.appVersion, matchResult: decision.matchResult, source: 'network',
          saltFingerprint: r.candidate ? r.candidate.entry.saltFingerprint : null,
          mergeAction: merged.action, downgrade: decision.mode, code: decision.code,
          audit: Object.assign({ event: merged.audit.event }, merged.audit),
        }), 'miyoushe_version')
      }
      if (action === 'verify') {
        if (!ports.httpPort) return exitPayload(noHttpPort(), 'miyoushe_version:error')
        return exitPayload(fail('NET_ERROR', 'verify 需真实探测（注入端口下才可用）'), 'miyoushe_version:error')
      }
      return exitPayload(base, 'miyoushe_version')
    })
  }

  // §6.2.1 第 10 行：salts（只给指纹，绝不给盐明文）
  A._salts = A.miyoushe_salts = async () => {
    return worldOr('salts', async (w) => {
      const entries = (w.salts && w.salts.entries) || {}
      const list = Object.keys(entries).map((ver) => {
        const e = entries[ver] && typeof entries[ver] === 'object' ? entries[ver] : {}
        return {
          appVersion: ver,
          clientType: e.clientType === undefined || e.clientType === null ? null : String(e.clientType),
          saltStatus: e.status === undefined ? null : String(e.status),
          sourceKind: e.sourceKind === undefined ? null : String(e.sourceKind),
          fetchedAt: e.fetchedAt === undefined ? null : e.fetchedAt,
          verifiedAt: e.verifiedAt === undefined ? null : e.verifiedAt,
          saltFingerprint: e.saltFingerprint ? String(e.saltFingerprint) : saltFingerprint(e.salt),
        }
      })
      return exitPayload({ ok: true, active: (w.salts && w.salts.active) || null, entries: list, count: list.length }, 'miyoushe_salts')
    })
  }

  /**
   * §6.2.1 第 11 行：probe（写·网络）。
   *
   * **t46/J3 修复**：旧实现**忽略 `dryRun`**、恒发真实请求，而工具描述写「省略即 true：只构造请求不发送」
   *   ⇒ 描述与实现不一致（安全门禁口径问题：用户以为只构造、实际已出站）。现在：
   *     - `dryRun` 省略或 `true` ⇒ **只构造请求、不发送**（`ports.httpPort.request` **一次都不调**，
   *       transport 调用数 = 0）；请求预览由**与真实发送同一套**解析函数 `resolveEndpointSpec` 产出
   *       （⇒ 预览即真实形状，且白名单校验在此已生效）。
   *     - `dryRun:false` ⇒ 才真实发送一次。
   *   **前置顺序保持不变**（凭据 → 端口 → 发送）：因此"无 `httpPort` ⇒ `NET_ERROR`"这条既有契约逐字不变
   *     （生产 `apply` 恒自挂端口，故 `dryRun` 预览在生产里总能算出来）。
   *
   * **入参契约**（该端点 `/event/luna/info` 需 `act_id` + `game_biz`，二者都是 **query** 参数）：
   *     - `target`：省略即 `hk4e`；
   *     - `actId`：省略 ⇒ 取端点表 `endpoints[target].actId`（§2.1：不写死在逻辑里）；
   *     - `gameBiz`：省略 ⇒ 由 §2.2 的 `GAME_BIZ_KEYS` 反查（`hk4e→hk4e_cn` 等）；
   *     - 两项任一缺失 ⇒ **不编造**，如实回执 `missingParams[]`（`bbs` 无 `actId` ⇒ 必然列出）。
   */
  A._probe = A.miyoushe_probe = async (input) => {
    const i = input || {}
    return worldOr('probe', async (w) => {
      if (!w.credentials.configured) return exitPayload(fail('AUTH_REQUIRED'), 'miyoushe_probe:error')
      if (!ports.httpPort) return exitPayload(noHttpPort(), 'miyoushe_probe:error')
      const target = typeof i.target === 'string' && i.target ? i.target : 'hk4e'
      const dryRun = i.dryRun === undefined ? true : i.dryRun === true
      const eps = w.endpoints && w.endpoints.endpoints && typeof w.endpoints.endpoints === 'object' ? w.endpoints.endpoints : {}
      const ep = eps[target] && typeof eps[target] === 'object' ? eps[target] : {}
      const actId = typeof i.actId === 'string' && i.actId ? i.actId : (typeof ep.actId === 'string' && ep.actId ? ep.actId : null)
      const gameBiz = typeof i.gameBiz === 'string' && i.gameBiz ? i.gameBiz : bizOfGameKey(target)
      const query = {}
      if (actId) query.act_id = actId
      if (gameBiz) query.game_biz = gameBiz
      const missingParams = []
      if (!actId) missingParams.push('act_id')
      if (!gameBiz) missingParams.push('game_biz')
      const preview = {
        ok: true, target, dryRun,
        method: 'GET', path: '/event/luna/info',
        headersPlanned: Object.keys(HEADER_NAMES).map((k) => HEADER_NAMES[k]),
        missingParams,
        drift: { suspect: false, reasonCodes: [], unadjudicated: true },
      }
      if (dryRun) {
        let spec = null
        try {
          spec = resolveEndpointSpec({ path: preview.path, method: preview.method, target, query })
        } catch (e) {
          return exitPayload(fail('BAD_ARG', '请求构造失败：' + String(e && e.message ? e.message : e)), 'miyoushe_probe:error')
        }
        return exitPayload(Object.assign(preview, {
          sent: false, url: spec.url, host: spec.host, query: spec.query,
          note: 'dryRun（省略即 true）：**只构造请求、未发送**（transport 调用数 = 0）；URL 由与真实发送同一套 resolveEndpointSpec 解析'
            + (missingParams.length ? '。缺参 ' + JSON.stringify(missingParams) + ' ⇒ 真实发送前先补齐（本端点为 query 参数）' : ''),
        }), 'miyoushe_probe')
      }
      const res = await ports.httpPort.request({ path: preview.path, method: preview.method, target, query })
      return exitPayload(Object.assign(preview, {
        sent: true, dryRun: false,
        url: (res && res.url) || null, host: (res && res.host) || null,
        endpoint: (res && res.endpoint) || preview.path, httpStatus: res && res.httpStatus, retcode: res && res.retcode,
        messageMasked: res && res.message ? String(res.message) : null,
        classify: res && res.classify ? String(res.classify) : null,
        note: '已真实发送一次（dryRun:false）；漂移判据在 §11-3/§11-10 收口前**只登记不判**（§3.5.10）',
      }), 'miyoushe_probe')
    })
  }

  // §6.1 第 12/13 行：credentials / config 的工具别名
  A._credentials = A.miyoushe_credentials = A.credentials
  A._config = A.miyoushe_config = A.config

  // §6.2.1 第 14 行：help（只读；含安全声明）
  A.help = A.miyoushe_help = async () => exitPayload({
    ok: true,
    actions: ACTIONS.slice(),
    tools: TOOL_NAMES.map((n) => {
      const meta = TOOL_META[n] || {}
      return { name: n, cls: meta.cls || 'readonly', triggersNetwork: meta.network === true, sideEffect: meta.sideEffect || null, params: meta.params || [] }
    }),
    safety: {
      enableGate: '§6.5 G1–G5：逐组合要求"与当前盐同源"的成功记录；硬项（G1/G4-strict/G5/空组合清单）任何参数都不能越权',
      dryRunDefault: 'miyoushe_run / miyoushe_sign / miyoushe_probe 的 dryRun 省略即 true（只做本地判定/只构造请求，**零出站**）',
      credentialsPolicy: '凭据只存本机、绝不回显；凭据类路径走 strict 出口（任何凭据片段出现即抛 CREDENTIAL_ECHO_BLOCKED）',
      outbound: 'API 出站（sign / probe / accounts）**已实现**：`lib/mys-http.js` 官方域白名单（api-takumi.mihoyo.com / act-nap-api.mihoyo.com / bbs-api.mihoyo.com / bbs-api.miyoushe.com / api-takumi.miyoushe.com）+ 10s + 最多 2 次重试（2s·5s）+ 限速（同账号 ≥1s、账号间 5–25s）+ 归一化；凭据**只进请求头**、绝不回显。`miyoushe_run` 的真实提交分支**尚未实现**（恒 `NET_ERROR`；真实提交请用 `miyoushe_sign{dryRun:false}`）。版本取回走另一条独立通道（第三方源 raw.githubusercontent.com / raw.gitcode.com / api.github.com；8s + 最多 1 次换源 + **零凭据头**）。',
    },
  }, 'miyoushe_help')

  return A
}

// ---------------------------------------------------------------------------
// §6.2.1 十四个工具的元数据 + **author spec**（参数只用「省略」或 `required:true`；绝不写 `required:false`）
// ---------------------------------------------------------------------------
export const TOOL_META = Object.freeze({
  miyoushe_status: { cls: 'readonly', network: false, params: [] },
  miyoushe_accounts: { cls: 'readonly', network: true, sideEffect: 'refresh:true 时向米游社读角色列表（只读语义）并把发现结果落盘 `全局数据/miyoushe/accounts.json`（本机数据面保留原值；出口仍只给尾号）', params: ['refresh(省略=false)'] },
  miyoushe_logs: { cls: 'readonly', network: false, params: ['date(省略=今日)', 'limit(省略=全部)'] },
  miyoushe_sign: { cls: 'write-network', network: true, sideEffect: '真实提交签到（dryRun 省略即 true＝不提交）；默认范围＝settings.targets', params: ['accountKey', 'gameKey', 'region', 'comboKey', 'all(省略=false)', 'dryRun(省略=true)', 'force(省略=false)'] },
  miyoushe_schedule: { cls: 'readonly', network: false, params: [] },
  miyoushe_enable: { cls: 'write', network: false, sideEffect: '开启自动签到定时任务（需过 §6.5 门禁）', params: ['scope(省略=all)', 'accountKey', 'confirm(省略=false)', 'acknowledgeUnverified(省略=false)'] },
  miyoushe_disable: { cls: 'write', network: false, sideEffect: '暂停自动签到定时任务（不设二次确认）', params: ['scope(省略=all)', 'accountKey'] },
  miyoushe_run: { cls: 'write-network', network: true, sideEffect: '立即触发一次执行（dryRun 省略即 true＝只做本地判定）；默认范围＝settings.targets', params: ['accountKey', 'gameKey', 'region', 'comboKey', 'all(省略=false)', 'dryRun(省略=true)', 'force(省略=false)'] },
  miyoushe_version: { cls: 'mixed', network: true, sideEffect: 'refresh 走公网取版本与盐；set 写 salts.json', params: ['action(省略=get)', 'refresh', 'appVersion', 'salt', 'clientType'] },
  miyoushe_salts: { cls: 'readonly', network: false, params: [] },
  miyoushe_probe: { cls: 'write-network', network: true, sideEffect: '向米游社打一次带签名探测（dryRun 省略即 true＝只构造不发送，零出站）', params: ['target', 'dryRun(省略=true)', 'actId', 'gameBiz'] },
  miyoushe_credentials: { cls: 'write-only-in', network: false, sideEffect: '写入/清除凭据（只进不出：响应绝不含凭据片段）', params: ['action(必填)', 'cookie'] }, // discipline-exempt: 设计规定的入参名: TOOL_META.params 清单里的 cookie 项（§6.2.1 参数清单）
  miyoushe_config: { cls: 'write', network: false, sideEffect: '改 settings.json / salts.json（白名单键）', params: ['patch(必填)'] },
  miyoushe_help: { cls: 'readonly', network: false, params: [] },
})

/**
 * 十四个工具的**注册定义**（author spec）。参数规范纪律（§6.2.2 纪律 1）：
 * 可选参数**只出现在 properties 里**（不写 required:false）；必填参数写 `required: true`。
 * 可选参数的默认值写进 **description**（不靠 spec 表达）。
 */
export function toolDefinitions(core) {
  const A = createActions(core)
  const call = (fn) => async (args) => toLossless(await fn(args || {}))
  return [
    {
      name: 'miyoushe_status',
      description: '米游社签到插件状态（只读、不触发网络）：返回 ready / 凭据是否已配置 / 盐表版本与指纹 / 定时开关与下次运行时间 / 最近错误。所有账号标识只显示尾号，凭据绝不回显。',
      parameters: {},
      execute: call(() => A.status()),
    },
    {
      name: 'miyoushe_accounts',
      description: '列出已发现的账号与角色（只读；默认读本地缓存不联网）。传 refresh:true 时会向米游社读取角色列表（只读语义、需已配置凭据）并把结果落盘；该次读取**服务端接受**时同时写 `credentials.lastOkAt`（门禁 G1 的证据），失败一律不写。',
      parameters: { refresh: { type: 'boolean', description: '是否重新读取官方角色列表；省略即 false（只读本地缓存）' } },
      execute: call((a) => A.accounts(a)),
    },
    {
      name: 'miyoushe_logs',
      description: '读取运行日志（只读，已脱敏）：date 省略＝今天（本地时区），limit 省略＝返回当天全部行。日志里的凭据类文本一律以 <redacted> 形式出现。',
      parameters: {
        date: { type: 'string', description: '日期 yyyy-mm-dd；省略即今天' },
        limit: { type: 'number', description: '最多返回多少行（取尾部）；省略即全部' },
      },
      execute: call((a) => A.logs(a)),
    },
    {
      name: 'miyoushe_sign',
      description: '【写·可能提交真实请求】对某个账号+游戏手动签到一次。**默认范围＝`settings.schedule.targets`**（与定时任务同源；targets=4 时裸调用只选 4 个组合，不会误签 targets 之外的区服）；要全量需显式 `all:true`。**dryRun 省略即 true＝只做本地判定、绝不提交**；只有显式传 dryRun:false 才会真实提交。可用 `region`/`comboKey` **精确选中单组合**（如 {gameKey:"bh3", region:"bb01"}）。force:true 仅用于当日该组合处于 human_required 之后的人工重试一次；今日已 signed/already 的组合不会再提交第二次。',
      parameters: {
        accountKey: { type: 'string', description: '目标账号（省略即全部账号）' },
        gameKey: { type: 'string', description: '目标游戏/社区（hk4e/hkrpg/zzz/bh3/bbs；省略即 targets 内全部）' },
        region: { type: 'string', description: '精确到区服（如 cn_gf01 / bb01）；省略即该游戏全部已选组合' },
        comboKey: { type: 'string', description: '精确到组合键（如 "bh3:bb01"、bbs 为 "bbs"）；与 region 等效，二者叠加为 AND' },
        all: { type: 'boolean', description: '省略即 false：只签 `settings.schedule.targets` 内的组合；true ⇒ 放开为全部已发现组合（谨慎）' },
        dryRun: { type: 'boolean', description: '省略即 true：只做本地判定不提交' },
        force: { type: 'boolean', description: '省略即 false：仅在 human_required 后允许人工重试一次' },
      },
      execute: call((a) => A.sign(a)),
    },
    {
      name: 'miyoushe_schedule',
      description: '查看定时任务状态（只读、不触发网络、不写盘）：enabled / mode（auto|unverified|readonly）/ tickMs / 每日窗口 / nextAt（下次真正可能提交的时刻，由窗口+抖动+退避+当日去重共同解出）/ nextTargets / 上次运行 / 门禁明细 gate.reasons[]。',
      parameters: {},
      execute: call(() => A.schedule()),
    },
    {
      name: 'miyoushe_enable',
      description: '【写】开启自动签到定时任务：开启后插件会在每日窗口内自动向米游社提交签到请求（写类网络操作，会真实产生签到记录）。本工具不提交任何请求，只改开关。开启前必须先过安全门禁（尤其 G2：该账号+游戏必须已经有一条"用当前这把盐真实签到成功"的记录）；不满足时返回 SCHEDULE_GATE_BLOCKED 并逐条说明缺什么。只有在用户知情前提下同时传 confirm:true 与 acknowledgeUnverified:true，才可越过软项（G2/G3 与 G4 的 unverified-current），此时以 mode:"unverified" 运行；硬项（G1 / G4 的 stale|rejected|五个错误码 / G5 / 空组合清单）无论传什么都不能越过。',
      parameters: {
        scope: { type: 'string', enum: ['all', 'account'], description: '范围；省略即 all' },
        accountKey: { type: 'string', description: 'scope=account 时的目标账号' },
        confirm: { type: 'boolean', description: '省略即 false；软项越权需与 acknowledgeUnverified 同时为 true' },
        acknowledgeUnverified: { type: 'boolean', description: '省略即 false；确认已知情"未验证的自动签到"风险' },
      },
      execute: call((a) => A.enable(a)),
    },
    {
      name: 'miyoushe_disable',
      description: '【写】暂停自动签到定时任务：暂停后不再自动向米游社提交任何签到请求（手动 miyoushe_run 仍可用且默认 dryRun:true）。已在途的一次请求不会被取消。暂停＝降低风险方向的动作，因此不设二次确认；重复暂停返回 changed:false（幂等，不报错）。',
      parameters: {
        scope: { type: 'string', enum: ['all', 'account'], description: '范围；省略即 all' },
        accountKey: { type: 'string', description: 'scope=account 时的目标账号' },
      },
      execute: call((a) => A.disable(a)),
    },
    {
      name: 'miyoushe_run',
      description: '【写·可能提交真实请求】立即触发一次定时任务的执行（不等下一个 tick），**不改变定时开关**。**默认范围＝`settings.schedule.targets`**（与 sign/定时同源）。**dryRun 省略即 true＝只查状态、不提交**；只有显式传 dryRun:false 才会真实提交。注意：**本工具的真实提交分支尚未实现**（显式 dryRun:false 恒返回 NET_ERROR）——真实提交请用 `miyoushe_sign{dryRun:false}`。是否真的提交还受当日去重约束：今日已 signed/already 的目标不会再发第二次（outcome:"skipped_done"）。可用 region/comboKey 精确选中单组合；force:true 仅用于 human_required 之后的人工重试一次。',
      parameters: {
        accountKey: { type: 'string', description: '目标账号（省略即全部）' },
        gameKey: { type: 'string', description: '目标游戏/社区（省略即 targets 内全部）' },
        region: { type: 'string', description: '精确到区服（如 cn_gf01 / bb01）；省略即该游戏全部已选组合' },
        comboKey: { type: 'string', description: '精确到组合键（如 "bh3:bb01"）；与 region 等效，二者叠加为 AND' },
        all: { type: 'boolean', description: '省略即 false：只含 `settings.schedule.targets` 内的组合；true ⇒ 放开为全部已发现组合' },
        dryRun: { type: 'boolean', description: '省略即 true：只做本地判定不提交' },
        force: { type: 'boolean', description: '省略即 false：仅在 human_required 后允许一次' },
      },
      execute: call((a) => A.run(a)),
    },
    {
      name: 'miyoushe_version',
      description: '版本↔盐表（get 只读 / refresh 走公网取最新版本与盐 / set 手动覆盖 / verify 需出站）。get 与 set 不联网；refresh 需要出站通道（生产接线已挂 §3.5.8 受控默认出站；离线上下文未注入 fetchImpl 时显式 VERSION_FETCH_FAILED，不静默回落）；set 只回 saltFingerprint，**绝不回显盐明文**。action 省略即 get。',
      parameters: {
        action: { type: 'string', enum: ['get', 'refresh', 'set', 'verify'], description: '省略即 get' },
        refresh: { type: 'boolean', description: '等价于 action:refresh（兼容写法）' },
        appVersion: { type: 'string', description: 'set 时的版本号 x.y.z' },
        salt: { type: 'string', description: 'set 时的 salt（32 位 hex；不会回显）' },
        clientType: { type: 'string', description: 'set 时的 client_type；省略即 5' },
      },
      execute: call((a) => A.version(a)),
    },
    {
      name: 'miyoushe_salts',
      description: '列出盐表条目（只读）：每条只给版本/状态/来源/时间戳与 saltFingerprint（SHA-256 前 8 位），**绝不给盐明文**。',
      parameters: {},
      execute: call(() => A.miyoushe_salts()),
    },
    {
      name: 'miyoushe_probe',
      description: '【写·网络】对某个端点做一次带签名的探测：**dryRun 省略即 true ⇒ 只构造请求、不发送**（零出站，回执给出 URL/参数/计划头名，缺参会列在 missingParams）；只有显式 dryRun:false 才真实发送一次（需已配置凭据与实际出站通道）。该端点 `/event/luna/info` 需 `act_id`+`game_biz`（query）：act_id 缺省取端点表、game_biz 缺省由 §2.2 反查，均可入参覆盖。漂移判据在 §11-3/§11-10 收口前只登记不判。',
      parameters: {
        target: { type: 'string', description: '目标（hk4e/hkrpg/zzz/bh3/bbs）；省略即 hk4e' },
        dryRun: { type: 'boolean', description: '省略即 true：只构造请求不发送（零出站）；false 才真实发送' },
        actId: { type: 'string', description: '覆盖 act_id（省略即取端点表 endpoints[target].actId；bbs 无该项 ⇒ 列入 missingParams）' },
        gameBiz: { type: 'string', description: '覆盖 game_biz（省略即由 §2.2 表反查：hk4e→hk4e_cn / zzz→nap_cn 等）' },
      },
      execute: call((a) => A.miyoushe_probe(a)),
    },
    {
      name: 'miyoushe_credentials',
      description: '【只进不出】写入或清除凭据（Cookie）。响应**绝不含** cookie/token 任何片段（只回 configured / uid 尾号 / lastOkAt）——该路径走 strict 出口，一旦响应里出现凭据片段会直接失败。action 必填：set（需同时给 cookie）或 clear。本切片凭据写入通道未接线 ⇒ 返回 NOT_READY（除非注入凭据端口）。', // discipline-exempt: 工具 description: miyoushe_credentials 的 description 原文（§6.2.1 第 12 行）
      parameters: {
        action: { type: 'string', enum: ['set', 'clear'], description: '必填：set 或 clear', required: true },
        cookie: { type: 'string', description: 'action=set 时的 Cookie 原文（只存本机，绝不回显）' }, // discipline-exempt: 设计规定的入参名: miyoushe_credentials 参数 spec 的 cookie 键（§6.2.1）
      },
      execute: call((a) => A.miyoushe_credentials(a)),
    },
    {
      name: 'miyoushe_config',
      description: '【写】修改配置（白名单键：窗口/抖动/上限/退避/社区开关/allowLateSign 等，或 salts 手动覆盖）。未知键一律拒绝；salts 写入只回指纹、不回显盐明文。patch 必填。',
      parameters: { patch: { type: 'object', additionalProperties: true, description: '必填：要写入的配置补丁（白名单键）', required: true } },
      execute: call((a) => A.miyoushe_config(a)),
    },
    {
      name: 'miyoushe_help',
      description: '列出本插件全部 action 与工具（只读）：名称/类别/是否触发网络/副作用/参数，以及安全声明（门禁、dryRun 默认、凭据策略、出站缺口）。',
      parameters: {},
      execute: call(() => A.miyoushe_help()),
    },
  ]
}

// ---------------------------------------------------------------------------
// 参数 spec 合法性（**镜像宿主规则**；宿主 `defineTool` 的规则见 dsh-tools 的
//   `authorError(\`${path}.required must be true when present\`)`）
// ---------------------------------------------------------------------------
export function validateToolDefinition(def) {
  const violations = []
  const d = def || {}
  if (typeof d.name !== 'string' || !d.name) violations.push('name 必须是字符串')
  if (typeof d.description !== 'string' || !d.description) violations.push('description 必须是字符串')
  if (typeof d.execute !== 'function') violations.push('execute 必须是函数')
  const params = d.parameters
  if (params === undefined || params === null || typeof params !== 'object' || Array.isArray(params)) {
    violations.push('parameters 必须是属性映射对象（可为空对象）')
    return violations
  }
  for (const [key, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { violations.push('parameters.' + key + ' 必须是值 schema 对象'); continue }
    if (Object.prototype.hasOwnProperty.call(spec, 'required') && spec.required !== true) {
      violations.push('parameters.' + key + '.required must be true when present')
    }
    if (spec.type === 'object' && !Object.prototype.hasOwnProperty.call(spec, 'additionalProperties')) {
      violations.push('parameters.' + key + '.additionalProperties must be explicitly true or false')
    }
    if (typeof spec.description !== 'string' || !spec.description) violations.push('parameters.' + key + ' 缺少 description（默认值/语义要写在这里）')
  }
  return violations
}

/** author spec → 宿主参数 JSON Schema（本地镜像；宿主环境优先用真实 `defineTool` 编译） */
export function parametersToJsonSchema(params) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(params || {})) {
    const p = {}
    for (const k of ['type', 'description', 'enum']) if (spec[k] !== undefined) p[k] = spec[k]
    if (spec.type === 'object') p.additionalProperties = spec.additionalProperties === undefined ? true : spec.additionalProperties
    if (spec.type === 'array') p.items = spec.items === undefined ? { type: 'string' } : spec.items
    properties[key] = p
    if (spec.required === true) required.push(key)
  }
  const out = { type: 'object', properties }
  if (required.length) out.required = required
  return out
}

/**
 * 编译注册定义：**优先**用宿主真实的 `defineTool`（动态 import；宿主环境可解析 `@deepseek-ai/dsh-tools`），
 * 不可解析时（如仓库内单测）退回**本地镜像编译**（同一 spec 规则 + 同一 output 形状）。
 * 返回 `{ defs:[{name, definition, viaReal, violations}], viaReal, importError }` —— **绝不因编译失败静默丢工具**。
 */
export async function compileToolDefinitions(defs) {
  let defineTool = null
  let importError = null
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
  } catch (e) {
    importError = String(e && e.code ? e.code : e && e.message || e)
  }
  const out = []
  for (const def of defs) {
    const violations = validateToolDefinition(def)
    const output = {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: value && typeof value.summary === 'string' ? value.summary : JSON.stringify(value) }],
      presentationMeta: (args, value) => (value && typeof value === 'object' ? value : {}),
    }
    let definition = null
    let viaReal = false
    if (defineTool) {
      try { definition = defineTool(Object.assign({}, def, { output })); viaReal = true } catch (e) { definition = null; violations.push('宿主 defineTool 拒绝：' + String(e && e.message || e)) }
    }
    if (!definition) {
      definition = {
        name: def.name,
        description: def.description,
        parameters: parametersToJsonSchema(def.parameters),
        output: { schema: output.schema, render: output.render },
        execute: def.execute,
      }
    }
    out.push({ name: def.name, definition, viaReal, violations })
  }
  return { defs: out, viaReal: !!defineTool, importError }
}

/** HTTP handler（§6.1：全部 POST + JSON；响应 `content-type` 显式带 `charset=utf-8`） */
export function makeHttpHandler(core) {
  const A = createActions(core)
  return function handler(req, res) {
    const send = (status, obj) => {
      try {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify(toLossless(obj)))
      } catch (e) { /* 客户端已断开 */ }
    }
    let u
    try { u = new URL(req.url || '/', 'http://x') } catch (e) { return send(400, fail('BAD_ARG', 'URL 非法')) }
    const parts = u.pathname.split('/').filter(Boolean) // [miyoushe, api, action]
    if (parts[0] !== 'miyoushe' || parts[1] !== 'api') return send(404, fail('BAD_ARG', '未知路由：' + u.pathname))
    const action = parts[2] || ''
    if (!Object.prototype.hasOwnProperty.call(A, action) || action.startsWith('_')) {
      return send(404, fail('BAD_ARG', '未知 action：' + JSON.stringify(action) + '；可用：' + ACTIONS.join(', ')))
    }
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) body = body.slice(0, 1024 * 1024) })
    req.on('error', () => { try { res.end('') } catch (e) { /* noop */ } })
    req.on('end', async () => {
      let args = {}
      if (body) { try { args = JSON.parse(body) } catch (e) { return send(400, fail('BAD_ARG', '请求体不是合法 JSON')) } }
      try {
        const out = await A[action](args)
        const code = out && out.ok === false && out.error ? out.error.code : null
        return send(out && out.ok === false ? (ERROR_HTTP_STATUS[code] || 500) : 200, out)
      } catch (e) {
        const p = errorPayload(e)
        return send(ERROR_HTTP_STATUS[p.error.code] || 500, p)
      }
    })
    return undefined
  }
}

/**
 * 注册（**只在插件被真正加载时执行**；本切片不接线不加载 ⇒ apply 不被调用）。
 * - HTTP：`webServer.register({ kind:'prefix', path:'/miyoushe/api', handler })`，归 fiber（`ctx.effect`）
 * - 工具：14 个逐个注册（真实 `defineTool` 优先），**每个失败都留痕**（不空 catch）
 * - 定时器：`tickMs` 默认 60000，起于 `ctx.effect`（`config.startTicker === false` 可关；测试不加载 ⇒ 不启动）
 */
export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const get = (n) => { try { return ctx && typeof ctx.get === 'function' ? ctx.get(n) : undefined } catch (e) { return undefined } }
  const logger = get('logger')
  const warn = (m) => { try { if (logger && typeof logger.warn === 'function') logger.warn(m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(m + '\n') } catch (e) { /* 日志失败不阻断 */ } }
  const info = (m) => { try { if (logger && typeof logger.info === 'function') logger.info(m); else if (typeof process !== 'undefined' && process.stderr) process.stderr.write(m + '\n') } catch (e) { /* 同上 */ } }

  const deps = {
    adapterFs: get('adapterFs'),
    httpPort: cfg.httpPort || null,
    fetchImpl: cfg.fetchImpl || null,
    credentialsPort: cfg.credentialsPort || null,
    logger,
    config: cfg,
    execute: typeof cfg.execute === 'function' ? cfg.execute : undefined,
  }
  // ---- §3.5.8 运行期受控出站（t22 / A2）-----------------------------------------------------
  // 注入点**只在 `apply`（生产接线）**：`resolvePorts` 未取得 `fetchImpl` 时，改用
  // `lib/miyoushe-version.js` 的受控默认出站（唯一落点：域名白名单 + 8s + 最多 1 次换源 + 固定 UA + 零凭据）。
  // `createCore` / `createActions` 的默认行为**不变** ⇒ 离线自测（不调 `apply`）未注入时仍是
  // `VERSION_FETCH_FAILED`，且全程不触碰全局 fetch（`selftest/actions.mjs` 哨兵调用数=0）。
  // 作用域：本注入只填 `ports.fetchImpl`（版本取回）；`sign` / `probe` / `accounts` 走 `ports.httpPort`
  //   （t46/J4 更正：该 API 通道由**下方** t29 块在未注入时自挂 mys-http 默认实现 ⇒ **已接线**，
  //   不再有"恒未接线/只登记不实现"的说法；真实签到成功（t45）即证）。
  if (!deps.fetchImpl) {
    const defaultFetch = createDefaultVersionFetch({ timeoutMs: FETCH_TIMEOUT_MS })
    if (defaultFetch) {
      deps.fetchImpl = defaultFetch
      info('[miyoushe] 受控出站就绪：版本取回走 §3.5.8 默认实现（白名单 / 8s / 最多 1 次换源 / 固定 UA / 零凭据）')
    } else {
      warn('[miyoushe] 受控出站不可用：运行环境无全局 fetch ⇒ 版本 refresh 将显式 VERSION_FETCH_FAILED（不静默回落）')
    }
  } else {
    info('[miyoushe] 版本取回使用注入的 fetchImpl（不再挂默认出站）')
  }

  // ---- §10.2 API 出站通道（t29 / A4；t31/S1 补凭据 provider）---------------------------------
  // 注入点**只在 `apply`（生产接线）**：`resolvePorts` 的解析顺序（`deps.httpPort` → `config.httpPort`
  // → `ctx.get('miyousheHttp')`）**保持不变**——本块只在**三者都没有**时，把 `lib/mys-http.js` 的
  // 默认实现装到 `deps.httpPort`（即顺序里最后的那一级），因此既不遮蔽注入端口、也不改顺序语义。
  // 通道隔离：本注入**只**服务 API 通道（`sign` / `probe` / `accounts` / `run`）；版本取回仍走
  // `lib/miyoushe-version.js` 的独立实现，两通道**互不复用**凭据/传输（版本通道绝不携带凭据）。
  // 凭据（t31/S1）：默认 provider ＝ `store.readCredentials().primary.credential`（**只读路径**）；
  //   凭据值只进请求头，**不进**出口/日志/status；缺凭据 ⇒ 端口返回 `AUTH_REQUIRED` 且不发请求。
  //   生产亦可经 `config.credentialProvider` 覆盖（例如由宿主凭据服务提供）。
  let coreRef = null
  const readCredentialValue = async () => {
    try {
      const file = coreRef ? await coreRef.store.readCredentials() : null
      return file && file.primary ? file.primary.credential : null
    } catch (e) { return null }
  }
  const credentialProvider = typeof cfg.credentialProvider === 'function' ? cfg.credentialProvider : readCredentialValue
  {
    const ctxHttp = get('miyousheHttp')
    const injected = (deps.httpPort && typeof deps.httpPort.request === 'function')
      ? deps.httpPort
      : ((ctxHttp && typeof ctxHttp.request === 'function') ? ctxHttp : null)
    if (!injected) {
      const apiPort = createHttpPort({
        transport: typeof cfg.httpTransport === 'function' ? cfg.httpTransport : null,
        store: null,
        credentialProvider,
        endpoints: cfg.endpoints || null,
      })
      deps.httpPort = apiPort
      info('[miyoushe] API 出站通道就绪：mys-http 默认实现（官方域白名单 / 10s / 最多 2 次重试 2s·5s / 限速 1s 与 5–25s / 归一化）')
    } else {
      info('[miyoushe] API 出站使用注入的 httpPort（不挂 mys-http 默认实现）')
    }
  }
  // S1：凭据端口补只读 `get()`；
  // t52/Q1：**并把写入通道接上**（D-3 未尽项）——默认实现落在 `store`（经 `coreRef` 延迟绑定，apply 期 core 尚未构造）；
  //   若调用方已注入 `set`/`clear`，**不覆盖**注入实现（可替换性保持）⇒ 顺序：默认 → 注入 → get 固定为 provider。
  const storeCredPort = {
    set: async (raw, opts) => {
      const core0 = coreRef
      if (!core0) return { ok: false, code: 'NOT_READY' }
      return writeCredentialToStore(core0, raw, opts)
    },
    clear: async () => {
      const core0 = coreRef
      if (!core0) return { ok: false, code: 'NOT_READY' }
      return clearCredentialInStore(core0)
    },
  }
  deps.credentialsPort = Object.assign({}, storeCredPort, deps.credentialsPort || null, { get: credentialProvider })
  const core = createCore(deps)
  core.ctx = ctx
  coreRef = core
  // t82/P0①（接线）：把 ticker 的 execute 接到**真实提交路径** —— 复用 `sign` action 的单组合口径，
  //   不另写一份提交逻辑（避免两处真相）。`persisted:true` 告知 tick：本次结果已由 action 自行落账
  //   （含 doneKeys / lastOkAt / 盐升级）⇒ ticker 不得再用过期 state 覆盖。
  try {
    const A0 = createActions(core)
    core.execRef.fn = async function (task) {
      const r = await A0.sign({ accountKey: task.accountKey, gameKey: task.target, region: task.region ? String(task.region) : '', dryRun: false })
      if (!r || r.ok !== true) {
        const err = (r && r.error) || {}
        return { outcome: 'failed', message: String(err.message || err.code || 'SIGN_ACTION_FAILED'), persisted: false }
      }
      const items = Array.isArray(r.results) ? r.results : []
      const hit = items.filter((x) => x && x.dedupeKey === task.dedupeKey)[0] || items[0] || null
      if (!hit) return { outcome: 'failed', message: 'SIGN_NO_RESULT', persisted: false }
      return {
        outcome: hit.outcome, retcode: hit.retcode, httpStatus: hit.httpStatus, classify: hit.classify,
        message: hit.messageMasked, persisted: true,
      }
    }
    info('[miyoushe] ticker execute 已接线到 sign action（单组合真实提交）')
  } catch (e) {
    warn('[miyoushe] ticker execute 接线失败（自动签到将落 failed + EXECUTE_NOT_WIRED，受 maxAttemptsPerDay 保护）：' + String(e && e.message || e))
  }
  // 默认端口的 salts 读取点：**延迟**绑定到 core（apply 期 core 尚未构造），不读凭据文件内容
  if (deps.httpPort && typeof deps.httpPort.bindStore === 'function') deps.httpPort.bindStore(core.store)

  // ---- HTTP actions ----
  const webServer = get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      const handler = makeHttpHandler(core)
      const disposer = webServer.register({ kind: ROUTE_KIND, path: API_PREFIX, handler })
      if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { if (typeof disposer === 'function') disposer() } catch (e) { /* 卸载失败留痕 */ warn('[miyoushe] route dispose failed: ' + String(e && e.message || e)) } })
      info('[miyoushe] HTTP actions ready: ' + ACTIONS.length + ' @ ' + API_PREFIX + ' (' + ROUTE_KIND + ')')
    } catch (e) {
      warn('[miyoushe] route register failed: ' + String(e && e.stack || e))
    }
  } else {
    warn('[miyoushe] webServer 不可用（可选依赖）：HTTP actions 未注册，' + ACTIONS.length + ' 个 action 仍可被自测直调')
  }

  // ---- agent 工具（14）----
  const toolsSvc = get('tools')
  if (toolsSvc && typeof toolsSvc.register === 'function') {
    const defs = toolDefinitions(core)
    ;(async () => {
      const compiled = await compileToolDefinitions(defs)
      if (!compiled.viaReal) warn('[miyoushe] 宿主 defineTool 不可解析（' + compiled.importError + '）：改用本地镜像编译注册（spec 规则一致）')
      let ok = 0
      for (const item of compiled.defs) {
        if (item.violations.length) { warn('[miyoushe] tool spec 违规 (' + item.name + '): ' + item.violations.join('; ')); continue }
        try {
          const disposer = toolsSvc.register(item.definition)
          ok++
          if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { if (typeof disposer === 'function') disposer() } catch (e) { /* noop */ } })
        } catch (e) {
          warn('[miyoushe] tool register failed (' + item.name + '): ' + String(e && e.stack || e.message || e))
        }
      }
      info('[miyoushe] agent tools ready: ' + ok + '/' + TOOL_NAMES.length)
    })().catch((e) => warn('[miyoushe] tool 注册流程异常：' + String(e && e.stack || e)))
  } else {
    warn('[miyoushe] tools 服务不可用（可选依赖）：' + TOOL_NAMES.length + ' 个工具未注册（自测仍可直调）')
  }

  // ---- tick（§5.1；起于 ctx.effect，随 fiber dispose 自动清）----
  if (cfg.startTicker !== false && typeof ctx.effect === 'function') {
    const tickMs = Number.isFinite(cfg.tickMs) ? cfg.tickMs : SCHEDULER_DEFAULTS.tickMs
    ctx.effect(() => {
      const timer = setInterval(() => { core.scheduler.tick({}).catch((e) => warn('[miyoushe] tick failed: ' + String(e && e.message || e))) }, tickMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    })
    info('[miyoushe] ticker started: ' + tickMs + 'ms')
  }
}

export { signDs, randAlnum, nowSec, dsPayload, md5Hex, DS_ERR, DsError, R_PATTERN, saltFingerprint, uidTail, accountKey, TARGETS, dedupeKey, planTick, decideOne, activeSaltInfo, collectBlockingCodes, evaluateGate }
