// @local/miyoushe —— 安全门禁**纯函数层**（设计 §6.5；本文件为离线切片，**零 IO / 零网络 / 零状态**）
//
// 设计锚点（**按章节锚点 + grep 模式引用，不写行号**——设计文档自指行号已漂移）：
//   §6.5.1 判据表       锚：grep 模式 `^\| \*\*G1\*\* \|` … `^\| \*\*G5\*\* \|`
//   G4 唯一锚           grep 模式 `^\| \*\*G4\*\* \|`
//   G4 与 §3.5.4 对齐    grep 模式 `只允许 .verified. 进入自动签到`
//   软/硬分级             §6.5.2（锚：grep 模式 `门禁的.软/硬.分级`）
//   id↔reason 映射        §6.5.1（锚：grep 模式 `id ↔ reason 映射`）
//   reasons 粒度与 20 上限 §6.5.1（锚：grep 模式 `reasons\[\] 的粒度`）
//   失败错误对象示例      §6.5.1（锚：grep 模式 `失败时的错误对象`）
//
// 纪律：
//   1) 纯函数：**无 IO、无网络、无模块级可变状态**；`now` 可注入（测试可复跑）。
//   2) **不**读 `ctx`/服务；组合清单、就绪标志、凭据状态一律由调用方注入（门禁不猜）。
//   3) `doneKeys` **只用于当日去重**，**不得**作为门禁证据（§6.5.1 G3）；仅当它与同源 success
//      **互相矛盾**时才产生 G3 的独有 reason `doneKeys_conflict`。
//   4) 指纹一律走 `fingerprint()`（＝ §3.5.7 同一函数：sha256 前 8 位小写），**并只输出指纹**。

import { fingerprint } from './miyoushe-version.js'

export const GATE_IDS = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5'])

/** §6.5.2 硬阻断的五个错误码（G4 的"严格部分"） */
export const HARD_BLOCKING_CODES = Object.freeze([
  'VERSION_STALE', 'SALT_MISSING', 'SALT_INVALID', 'ENDPOINT_DRIFT', 'GEETEST_REQUIRED',
])

/** G4 硬阻断的 active.status 取值（`unverified-current` 属**软**阻断，不进此表） */
export const HARD_SALT_STATUSES = Object.freeze(['stale', 'rejected'])

export const DEFAULT_MAX_SIGN_AGE_DAYS = 7
export const MAX_SIGN_AGE_DAYS_CAP = 30
export const MAX_REASONS = 20
export const REASON_SCOPE = 'per-group'

export class GateError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'GateError'
    this.code = code
    this.detail = detail === undefined || detail === null ? null : String(detail)
  }
}

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

function isoOf(ms) {
  return new Date(ms).toISOString()
}

/** 有效 `maxSignAgeDays`：取 `settings.gate.maxSignAgeDays`（或 `opts.maxSignAgeDays`），上限 30、下限 1，非法值回落 7 */
export function effectiveMaxSignAgeDays(settings, opts) {
  const o = asObject(opts)
  const g = asObject(asObject(settings).gate)
  const raw = o.maxSignAgeDays !== undefined ? o.maxSignAgeDays : g.maxSignAgeDays
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_SIGN_AGE_DAYS
  return Math.min(MAX_SIGN_AGE_DAYS_CAP, Math.max(1, Math.floor(n)))
}

/**
 * 组合清单归一化（逐组合判据的**输入**，门禁不自行发现账号——发现属 §2.4，另立任务）。
 * 接受两种写法并去重排序，保证输出确定：
 *   - `opts.groups = [{ accountKey, gameKey }]`
 *   - `opts.accounts = [{ accountKey, games: ['hk4e', ...] }]`
 * `scope='account'` 时按 `opts.accountKey` 过滤。
 */
export function normalizeGroups(opts) {
  const o = asObject(opts)
  const out = []
  for (const g of asArray(o.groups)) {
    const accountKey = g && g.accountKey
    const gameKey = g && g.gameKey
    if (typeof accountKey === 'string' && accountKey && typeof gameKey === 'string' && gameKey) {
      out.push({ accountKey, gameKey })
    }
  }
  for (const a of asArray(o.accounts)) {
    if (!a || typeof a.accountKey !== 'string' || !a.accountKey) continue
    for (const gameKey of asArray(a.games)) {
      if (typeof gameKey === 'string' && gameKey) out.push({ accountKey: a.accountKey, gameKey })
    }
  }
  const scope = o.scope === 'account' ? 'account' : 'all'
  const filtered = scope === 'account'
    ? out.filter((x) => x.accountKey === o.accountKey)
    : out
  const seen = new Set()
  const uniq = []
  for (const x of filtered) {
    const k = x.accountKey + '\u0000' + x.gameKey
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(x)
  }
  uniq.sort((a, b) => (a.accountKey < b.accountKey ? -1 : a.accountKey > b.accountKey ? 1 : (a.gameKey < b.gameKey ? -1 : a.gameKey > b.gameKey ? 1 : 0)))
  return uniq
}

/**
 * 收集"未清除的硬阻断错误码"（§6.5.1 G4 / §6.5.2）。
 * 读取口（设计未逐一指定 ⇒ 本实现统一收集，并将结论导出以便评审核对）：
 *   - `state.lastError.code`、`state.schedule.pausedBy`、`state.pausedBy`、`state.blockedBy`
 *   - `salts.versionCache.lastFetchOk === false`（§3.5.6 ⇒ VERSION_STALE）
 * 只返回**白名单内**的码，其它码不参与门禁（避免把未知错误当硬阻断）。
 */
export function collectBlockingCodes(state, salts) {
  const st = asObject(state)
  const sa = asObject(salts)
  const found = new Set()
  const push = (v) => {
    if (typeof v === 'string' && HARD_BLOCKING_CODES.includes(v)) found.add(v)
    else if (Array.isArray(v)) for (const x of v) push(x)
  }
  push(asObject(st.lastError).code)
  push(asObject(st.schedule).pausedBy)
  push(st.pausedBy)
  push(st.blockedBy)
  const vc = asObject(sa.versionCache)
  if (vc.lastFetchOk === false) found.add('VERSION_STALE')
  return HARD_BLOCKING_CODES.filter((c) => found.has(c))
}

/** active 盐记录（§3.5.4「版本为键」）：返回 {appVersion, clientType, salt, status, fingerprint} 或 error */
export function activeSaltInfo(salts) {
  const sa = asObject(salts)
  const active = asObject(sa.active)
  const appVersion = typeof active.appVersion === 'string' && active.appVersion ? active.appVersion : null
  const entries = asObject(sa.entries)
  const entry = appVersion && entries[appVersion] && typeof entries[appVersion] === 'object' ? entries[appVersion] : null
  const salt = entry && typeof entry.salt === 'string' ? entry.salt : null
  let fp = null
  let fpError = null
  if (salt !== null) {
    try { fp = fingerprint(salt) } catch (e) { fpError = e && e.code ? e.code : 'FP_BAD_SALT' }
  }
  return {
    appVersion,
    clientType: entry && entry.clientType !== undefined && entry.clientType !== null ? String(entry.clientType) : null,
    salt,
    status: entry ? (entry.status === undefined ? null : String(entry.status)) : 'missing',
    fingerprint: fp,
    fingerprintError: fpError,
    entryPresent: entry !== null,
  }
}

/** `(accountKey, gameKey)` 的同源成功记录（§6.5.1 G2 的 `S`） */
export function successRecord(state, accountKey, gameKey) {
  const lss = asObject(asObject(state).lastSignSuccess)
  const perAccount = asObject(lss[accountKey])
  const rec = perAccount[gameKey]
  return rec && typeof rec === 'object' ? rec : null
}

/**
 * 逐组合判据（§6.5.1 G2 的 ①②③，判序固定 ①→②→③，取**最先命中**者）：
 *   ① 无任何记录                                   ⇒ reason `no_success`
 *   ② 有记录但早于 N 天窗口（或 `at` 非法）         ⇒ reason `expired`
 *   ③ 有记录但 fingerprint/appVersion 与当前不一致  ⇒ reason `salt_changed`（附 old/new 指纹）
 * 返回 `{ok, reason, detail, hint, record}`。
 */
export function evaluateGroupSuccess(state, salts, group, ctx) {
  const { now, maxSignAgeDays } = ctx
  const rec = successRecord(state, group.accountKey, group.gameKey)
  const active = activeSaltInfo(salts)
  const scopeText = 'accountKey=' + group.accountKey + ' / gameKey=' + group.gameKey
  if (!rec) {
    return {
      ok: false,
      reason: 'no_success',
      detail: scopeText + ' 在 state.json.lastSignSuccess 中无任何记录（doneKeys 若有记录也不作数：doneKeys 只用于当日去重，§6.5.1 G3）⇒ 按判序属 G2① 的否定',
      hint: '对该账号该游戏单独试签一次（miyoushe_sign {accountKey:\'' + group.accountKey + '\', gameKey:\'' + group.gameKey + '\', dryRun:false}），确认 App 里出现奖励后再开启定时',
      record: null,
    }
  }
  const atText = rec.at === undefined || rec.at === null ? null : String(rec.at)
  const atMs = atText === null ? NaN : Date.parse(atText)
  const ageMs = Number.isFinite(atMs) ? now - atMs : NaN
  const windowMs = maxSignAgeDays * 86400 * 1000
  if (!Number.isFinite(ageMs) || ageMs > windowMs) {
    return {
      ok: false,
      reason: 'expired',
      detail: scopeText + ' 有 success 记录但不在 ' + maxSignAgeDays + ' 天窗口内（at=' + (atText === null ? 'null' : atText) + '，now=' + isoOf(now) + '）⇒ G2② 的否定（settings.gate.maxSignAgeDays 上限 ' + MAX_SIGN_AGE_DAYS_CAP + '）',
      hint: '用当前盐对该组合重新试签一次（旧记录只证明"当时能签"，不证明"现在还能签"）',
      record: rec,
    }
  }
  if (rec.outcome !== 'success' && rec.outcome !== 'already') {
    // 记录存在但既非 success 也非 already（failed/human_required…）：仍按 G2① 的否定处理，报告**原始 outcome** 以免误读
    return {
      ok: false,
      reason: 'no_success',
      detail: scopeText + ' 的记录存在但 outcome=' + JSON.stringify(rec.outcome === undefined ? null : rec.outcome) + '（§6.5.1 G2 接受 `outcome ∈ {success, already}`——`already` 证明服务端**用当前这把盐**受理过；其余 outcome 不算）',
      hint: '真实试签一次拿到 `outcome:\'success\'`（或服务端回 `already`）记录后再开启定时',
      record: rec,
    }
  }
  const recFp = rec.saltFingerprint === undefined ? null : rec.saltFingerprint
  const recVer = rec.appVersion === undefined ? null : rec.appVersion
  if (recFp !== active.fingerprint || recVer !== active.appVersion) {
    return {
      ok: false,
      reason: 'salt_changed',
      detail: scopeText + ' 的 success 属旧版：记录 appVersion=' + JSON.stringify(recVer) + ' / saltFingerprint=' + JSON.stringify(recFp) + '，而当前 active 版本 ' + JSON.stringify(active.appVersion) + ' 的 fingerprint=' + JSON.stringify(active.fingerprint) + ' ⇒ 换版换盐，旧记录不满足 G2③（禁止跨盐复用）',
      hint: '用**当前这把盐**对该组合重新试签一次；成功后 active.status 会升 verified（§3.2「更新路径」第 ④ 条），门禁自动转 auto',
      record: rec,
    }
  }
  return { ok: true, reason: null, detail: null, hint: null, record: rec }
}

/**
 * t52/T2：本地日期 `yyyy-mm-dd`（**与 `lib/scheduler.js` 的 `localDateOf` 逐字同口径**：
 * 本地时区的 `getFullYear/getMonth/getDate`）。gate.js 不 import scheduler（门禁不该依赖调度实现），
 * 故此处留一份 6 行镜像；自测有跨文件一致性断言防漂移。
 */
export function localDateOfMs(ms) {
  const p2 = (n) => String(n).padStart(2, '0')
  const d = new Date(ms)
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

/** 从去重键里取"日期段"（3 段 `a:g:d` ⇒ 末段；4 段 `a:g:d:r` ⇒ 倒数第二段；否则 null） */
export function dateSegmentOfKey(key) {
  const segs = String(key).split(':')
  if (segs.length === 3) return /^\d{4}-\d{2}-\d{2}$/.test(segs[2]) ? segs[2] : null
  if (segs.length >= 4) return /^\d{4}-\d{2}-\d{2}$/.test(segs[segs.length - 2]) ? segs[segs.length - 2] : null
  return null
}

/**
 * G3 的**独有** reason：`doneKeys` 里存在与同源 success **互相矛盾**的终态失败标记（§6.5.1 映射表）。
 * 键形状（§5.2）＝ `${accountId}:${target}:${yyyy-mm-dd}`（或 4 段带 region）；但门禁拿到的可能是**脱敏 accountKey**（`acct-***1234`），
 * 故同时支持"值对象携带 accountKey/gameKey 字段"的写法。命中即返回该键，否则 null。
 *
 * **t52/T2 修订（长跑正确性）**：`doneKeys` 是**按日累积**的当日去重表，而原实现**跨日期盲扫**所有键
 * ⇒ 任何**历史某天**的失败键都会让该 `(account, game)` **永久**报 `doneKeys_conflict`（与 G2 的
 * 「同日成功记录」口径不一致）。现在：**给了 `dateLocal` 就只让"当日"键参与冲突判定**；
 * 未给（兼容旧调用）⇒ 保持旧的盲扫语义，并在 detail 里**明示这是未限定当日的调用**。
 */
export function findConflictingDoneKey(doneKeys, accountKey, gameKey, dateLocal) {
  const dk = asObject(doneKeys)
  const conflictStatuses = ['failed', 'human_required', 'skipped_window']
  const tail = String(accountKey).replace(/^acct-/, '').replace(/\*+/g, '')
  const dayFilter = typeof dateLocal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateLocal) ? dateLocal : null
  for (const key of Object.keys(dk)) {
    const val = dk[key]
    const v = val && typeof val === 'object' ? val : {}
    const status = typeof v.status === 'string' ? v.status : (typeof val === 'string' ? val : null)
    if (!status || !conflictStatuses.includes(status)) continue
    if (dayFilter !== null && dateSegmentOfKey(key) !== dayFilter) continue // T2：只看当日
    const keyHasGame = key.split(':').some((seg) => seg === gameKey)
    const keyHasAccount = key.includes(accountKey) || (tail.length > 0 && key.includes(tail))
    const valHasGame = v.gameKey === gameKey || v.target === gameKey
    const valHasAccount = v.accountKey === accountKey
    if ((keyHasGame && keyHasAccount) || (valHasGame && valHasAccount)) return { key, status, value: v }
  }
  return null
}

function g1Evaluate(state, opts) {
  const o = asObject(opts)
  const cred = o.credentials !== undefined ? asObject(o.credentials) : asObject(asObject(state).credentials)
  const configured = cred.configured === true
  const lastOkAt = cred.lastOkAt === undefined ? null : cred.lastOkAt
  const ok = configured && lastOkAt !== null && lastOkAt !== undefined
  return {
    id: 'G1',
    ok,
    detail: ok
      ? 'credentials.configured=true 且 lastOkAt=' + JSON.stringify(lastOkAt)
      : 'credentials.configured=' + JSON.stringify(configured) + '，credentials.lastOkAt=' + JSON.stringify(lastOkAt === undefined ? null : lastOkAt) + '（§6.5.1 G1：configured 但从未被服务端接受过 ⇒ 不算）',
    hint: ok ? null : '先调用 miyoushe_status 检查凭据状态，再用 miyoushe_accounts 确认角色清单（凭据只存本机、绝不回显）',
  }
}

function g4Evaluate(state, salts) {
  const codes = collectBlockingCodes(state, salts)
  const active = activeSaltInfo(salts)
  if (codes.length > 0) {
    return {
      id: 'G4', ok: false, soft: false, hard: true,
      detail: '存在未清除的硬阻断错误码：' + codes.join(', ') + '（§6.5.2 硬阻断；active.status=' + JSON.stringify(active.status) + '）',
      hint: '按错误码修复根因后再开启：' + codes.join(' / '),
      codes,
    }
  }
  if (active.status === 'verified') {
    return { id: 'G4', ok: true, soft: false, hard: false, detail: 'salts.json.active.status = \'verified\'（appVersion=' + JSON.stringify(active.appVersion) + ' / saltFingerprint=' + JSON.stringify(active.fingerprint) + '）', hint: null, codes }
  }
  if (active.status === 'unverified-current') {
    return {
      id: 'G4', ok: false, soft: true, hard: false,
      detail: 'salts.json.active.status = \'unverified-current\'（未核验盐，不得进入自动签到；依据＝§3.5.4 的 status 值域行「只允许 verified 进入自动签到」，grep 模式 `只允许 .verified. 进入自动签到`）',
      hint: "二选一：① 先用该盐试签成功 ⇒ status 自动升 verified，G4 自动满足（推荐）；② 显式越权：miyoushe_enable {confirm:true, acknowledgeUnverified:true} ⇒ 以 mode:'unverified' 运行（当日首次强制 dryRun）",
      codes,
    }
  }
  return {
    id: 'G4', ok: false, soft: false, hard: true,
    detail: 'salts.json.active.status = ' + JSON.stringify(active.status) + ' ⇒ 硬阻断（§6.5.2 只允许 `verified` 进入自动签到；`stale`/`rejected`/缺失 均为硬项）',
    hint: '更新盐表并重新试签（miyoushe_version action:\'set\' 或直接改 全局数据/miyoushe/salts.json）',
    codes,
  }
}

function g5Evaluate(opts) {
  const o = asObject(opts)
  const r = asObject(o.readiness)
  const groupsEmpty = o.groupsEmpty === true
  const settingsReadable = r.settingsReadable !== undefined ? r.settingsReadable === true : (o.settings !== undefined && o.settings !== null && typeof o.settings === 'object')
  const endpointsReadable = r.endpointsReadable !== undefined ? r.endpointsReadable === true : (typeof o.endpoints === 'object' && o.endpoints !== null)
  const dataDirExists = r.dataDirExists === true
  const ok = !groupsEmpty && settingsReadable && endpointsReadable && dataDirExists
  const missing = []
  if (groupsEmpty) missing.push('待纳入定时的 (accountKey, gameKey) 组合清单为空/不可得 ⇒ 逐组合判据（G2/G3）无从评估，按 **fail-closed** 拒绝（不允许"零组合 ⇒ 直接放行"）')
  if (!settingsReadable) missing.push('settings.json 不可读')
  if (!endpointsReadable) missing.push('endpoints.json 不可读')
  if (!dataDirExists) missing.push('全局数据/miyoushe/ 不存在（§4.1 G6：插件不自动建目录）')
  return {
    id: 'G5', ok,
    detail: ok ? 'settings.json / endpoints.json 可读，全局数据/miyoushe/ 存在' : '数据或配置未就绪：' + missing.join('；'),
    hint: ok ? null : (groupsEmpty
      ? '调用方需注入待纳入的组合清单（opts.groups 或 opts.accounts；真实来源＝§2.4 账号发现的结果）后再评估门禁'
      : '先创建 全局数据/miyoushe/ 并放入 settings.json / endpoints.json（部署或用户手工建目录；根表登记名，位置随平台）'),
  }
}

/**
 * 门禁主函数（§6.5 全量）。
 * @param state    state.json 内容（`lastSignSuccess` / `doneKeys` / `credentials` / `schedule` / `lastError`）
 * @param salts    salts.json 内容（**版本为键**）：`active:{appVersion,clientType}` + `entries[appVersion]`
 * @param settings settings.json 内容（读 `gate.maxSignAgeDays`）
 * @param opts     { scope:'all'|'account', accountKey?, groups?, accounts?, credentials?, readiness?,
 *                   confirm?, acknowledgeUnverified?, now?, maxSignAgeDays?, endpoints? }
 * @returns 门禁结论对象（见下方注释；严格对齐 §6.5.1 的 `gate` 与 `reasons[]` 形状）
 * 形状说明（与 §6.5.1「失败时的错误对象」示例一致）：
 *   { ok, mode:'auto'|'unverified'|'readonly', overridden, hardBlocked:boolean, hardItems[], softItems[],
 *     reasons[], failedByGroup, truncated, missingGroups, reasonScope:'per-group',
 *     evaluatedGroups, totalFailingGroups, effective{}, at }
 *   注：设计示例里 `gate.hardBlocked` 是**布尔**；本实现另给 `hardItems[]`（硬项 id 数组）以便机器消费
 *   （契约里写的 `hardBlocked[]` 之下标口径＝`hardItems`）。
 */
export function evaluateGate(state, salts, settings, opts) {
  const o = asObject(opts)
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const maxSignAgeDays = effectiveMaxSignAgeDays(settings, o)
  const groups = normalizeGroups(o)
  const confirm = o.confirm === true
  const acknowledgeUnverified = o.acknowledgeUnverified === true
  const active = activeSaltInfo(salts)

  const groupEntries = []
  const failedByGroup = {}
  const groupFailingIds = []
  for (const g of groups) {
    const g2 = evaluateGroupSuccess(state, salts, g, { now, maxSignAgeDays })
    if (!g2.ok) {
      groupEntries.push({
        id: 'G2', ok: false, scope: { accountKey: g.accountKey, gameKey: g.gameKey },
        reason: g2.reason, detail: g2.detail, hint: g2.hint, soft: true,
      })
      groupFailingIds.push({ accountKey: g.accountKey, gameKey: g.gameKey, id: 'G2' })
      const per = failedByGroup[g.accountKey] || (failedByGroup[g.accountKey] = {})
      per[g.gameKey] = ['G2']
      continue
    }
    // t52/T2：**限定当日**再判冲突（`doneKeys` 按日累积 ⇒ 不加限定的历史失败键会永久挡住 auto）
    const conflict = findConflictingDoneKey(asObject(state).doneKeys, g.accountKey, g.gameKey, localDateOfMs(now))
    if (conflict) {
      groupEntries.push({
        id: 'G3', ok: false, scope: { accountKey: g.accountKey, gameKey: g.gameKey },
        reason: 'doneKeys_conflict',
        detail: '该组合**当日**确有同源 success，但 doneKeys[' + JSON.stringify(conflict.key) + '].status=' + JSON.stringify(conflict.status) + ' 是终态失败标记，与 success 互相矛盾（§6.5.1 G3 独有 reason；t52/T2 起**只判当日**）⇒ 需人工核对 state.json',
        hint: '确认后走**受控清理**（不必手工改文件）：miyoushe_config {patch:{maintenance:{clearDoneKeys:[{accountKey:\'' + g.accountKey + '\', gameKey:\'' + g.gameKey + '\'}], reason:\'<为什么清>\'}}}，再重新开启定时',
        soft: true,
      })
      groupFailingIds.push({ accountKey: g.accountKey, gameKey: g.gameKey, id: 'G3' })
      const per = failedByGroup[g.accountKey] || (failedByGroup[g.accountKey] = {})
      per[g.gameKey] = ['G3']
      continue
    }
    groupEntries.push({ id: 'G2', ok: true, scope: { accountKey: g.accountKey, gameKey: g.gameKey }, reason: null, detail: null, hint: null, soft: false })
  }

  const g1 = g1Evaluate(state, o)
  const g4 = g4Evaluate(state, salts)
  const g5 = g5Evaluate(Object.assign({}, o, { settings, groupsEmpty: groups.length === 0 }))

  const globals = [g1, g4, g5].map((x) => ({
    id: x.id, ok: x.ok, detail: x.detail, hint: x.hint,
    ...(x.soft ? { soft: true } : {}),
  }))

  // 组装与截断：顺序＝G1 → 逐组合 → G4 → G5（与 §6.5.1 示例一致）；**全局项永远保留**
  const totalGroupEntries = groupEntries.length
  const budget = Math.max(0, MAX_REASONS - globals.length)
  const keptGroups = groupEntries.slice(0, budget)
  const truncated = totalGroupEntries > keptGroups.length
  const missingGroups = truncated ? totalGroupEntries - keptGroups.length : 0
  const reasons = [globals[0], ...keptGroups, globals[1], globals[2]]

  const hardEntries = [g1, g4, g5].filter((x) => x.ok === false && (x.soft !== true))
  const softEntries = [g1, g4, g5].filter((x) => x.ok === false && x.soft === true)
  for (const e of groupEntries) if (e.ok === false) softEntries.push(e)
  const uniqIds = (arr) => GATE_IDS.filter((id) => arr.some((x) => x.id === id))
  const hardItems = uniqIds(hardEntries)
  const softItems = uniqIds(softEntries)
  const hardBlocked = hardItems.length > 0
  const overridden = !hardBlocked && softItems.length > 0 && confirm && acknowledgeUnverified
  const ok = !hardBlocked && (softItems.length === 0 || overridden)
  const mode = ok ? (softItems.length > 0 ? 'unverified' : 'auto') : 'readonly'

  return {
    ok,
    mode,
    overridden,
    hardBlocked,
    hardItems,
    softItems,
    reasons,
    failedByGroup,
    truncated,
    missingGroups,
    reasonScope: REASON_SCOPE,
    evaluatedGroups: groups.length,
    groupsEmpty: groups.length === 0,
    totalFailingGroups: groupFailingIds.length,
    maxReasonEntries: MAX_REASONS,
    effective: {
      maxSignAgeDays,
      activeAppVersion: active.appVersion,
      activeClientType: active.clientType,
      activeSaltStatus: active.status,
      activeSaltFingerprint: active.fingerprint,
      confirm,
      acknowledgeUnverified,
      scope: o.scope === 'account' ? 'account' : 'all',
    },
    at: isoOf(now),
  }
}

/** 供上层组 `SCHEDULE_GATE_BLOCKED` 错误对象用（§6.5.1「失败时的错误对象」） */
export function toGateError(gate, message) {
  const msg = typeof message === 'string' && message.length
    ? message
    : '开启自动签到被门禁拒绝：缺少【与当前盐同源】的逐组合成功试签记录（§9.1 第③步；§6.5.1 G2/G3）。'
  return {
    code: 'SCHEDULE_GATE_BLOCKED',
    message: msg,
    reasons: gate && Array.isArray(gate.reasons) ? gate.reasons : [],
    gate,
  }
}
