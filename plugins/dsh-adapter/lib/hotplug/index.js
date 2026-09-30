// @local/dsh-adapter —— HotplugService：热拔插编排门面
//
// 流水线（A 类：插件操作）
//   [1] 门禁（manifest + enabled） → [2] 底座检查（tree/buster） → [3] 档位判定与放行
//   → [4] 前置体检 + 根登记 → [5] 互斥锁 → [6] 原子切换（link-validate → 替换 → 失败自愈）
//   → [7] 审计 → [8] 释放锁
//
// 与 sandbox 的关键差别（本轮要修的四个结构性缺陷）：
//   ① 档位替代 builtin 布尔      → tiers.classify / assertOpAllowed            （缺陷①）
//   ② 缓存破除下移到模块解析层    → buster.bumpGen + linkValidate 预热           （缺陷②）
//   ③ 先校验后切换 + 旧代次自愈    → _atomicSwitch 的 Phase 0/1/2               （缺陷③）
//   ④ 运行态承接以 moduleRev 自证  → status() 回传 gen/moduleRev/files           （缺陷④）
// 另外：不再有 _backupPlugin 式的文件备份（sandbox 里它其实是恒返回 null 的死代码），
// 回滚源改为"保留的旧代次模块图"（缺陷⑤）。

import { HotplugError, HotplugCode } from './errors.js'
import { AsyncMutex } from './mutex.js'
import { classify, assertOpAllowed, allowedOps, needsSafetyNet } from './tiers.js'
import { forceRemoveAll, isLoaded } from './tree-ops.js'
import { resolveEntryName, resolveEntryFileUrl, resolvePluginRoot } from './plugin-path.js'
import { linkValidate } from './linker.js'
import { preflight } from './preflight.js'

const _msg = (e) => String((e && e.message) || e)
const _nowIso = () => new Date().toISOString()

export class HotplugService {
  /**
   * 依赖全部注入，便于单测用假树/假 manifest 覆盖编排逻辑（真实 loader 不必在场）。
   * @param {object} p
   * @param {object} p.manifest 需实现 get/has/list/add/remove/update（可选 refreshIfChanged）
   * @param {object} p.buster   ModuleGraphBuster
   * @param {object|null} p.tree loader-like：{ store, create(), remove() }
   * @param {object|null} p.ctx  cordis ctx（forceRemoveAll 的兜底策略用）
   * @param {object|null} p.audit { log(rec) }
   * @param {Function} [p.logLine] 写 adapter apply 日志
   * @param {string} [p.baseDir] 包名解析基准目录
   */
  constructor({ manifest, buster, tree, ctx, audit, logLine, baseDir, mutex }) {
    this.manifest = manifest
    this.buster = buster
    this.tree = tree || null
    this.ctx = ctx || null
    this.audit = audit || null
    this.mutex = mutex || new AsyncMutex()
    this.baseDir = baseDir
    this._logLine = typeof logLine === 'function' ? logLine : () => {}
    // baseDir 缺失不是"小瑕疵"：它会让包名解析静默走到 adapter 自身位置。
    // 按本仓纪律（缺能力要 fail-closed、不能报"可用"），这里必须留下明确痕迹。
    if (!baseDir) {
      this._logLine('WARN', 'hotplug.baseDir.missing',
        'HotplugService 未传 baseDir：包名解析将回落到 adapter 自身位置，白名单条目很可能解析失败', {})
    }
    this._gens = new Map()   // id -> 最近一次成功提交的代次（展示/诊断用）
  }

  setTree(tree) { this.tree = tree }

  get treeAvailable() { return !!(this.tree && this.tree.store) }

  // ===== 内部：审计与门禁 =====

  _audit(level, event, message, extra) {
    try {
      if (this.audit && typeof this.audit.log === 'function') {
        this.audit.log({ level, category: 'hotplug', event, message, extra: extra || {}, ts: _nowIso() })
      }
    } catch (_) { /* 审计失败不阻断业务 */ }
    if (level === 'ERROR' || level === 'WARN') this._logLine(`HOTPLUG ${level} ${event} ${message}`)
  }

  _gate(id) {
    if (!id) throw new HotplugError(HotplugCode.INVALID_ARGS, 'id 为空')
    if (this.manifest && typeof this.manifest.refreshIfChanged === 'function') {
      try { this.manifest.refreshIfChanged() } catch (_) { /* 外部改动探测失败不阻断 */ }
    }
    const entry = this.manifest && this.manifest.get(id)
    if (!entry) {
      this._audit('WARN', 'hotplug.gate.reject', `gate 拒绝：不在白名单 ${id}`, { id, code: HotplugCode.NOT_WHITELISTED })
      throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    }
    if (entry.enabled === false) {
      this._audit('WARN', 'hotplug.gate.reject', `gate 拒绝：条目已禁用 ${id}`, { id, code: HotplugCode.WHITELIST_DISABLED })
      throw new HotplugError(HotplugCode.WHITELIST_DISABLED, `条目已禁用: ${id}`, { extra: { id } })
    }
    return entry
  }

  _requireTree(op) {
    if (!this.treeAvailable) {
      throw new HotplugError(HotplugCode.TREE_UNAVAILABLE,
        `${op} 中止：loader tree 不可用（loader 服务未在挂载时注入）`,
        { extra: { op } })
    }
  }

  _requireBuster(op) {
    const snap = this.buster.snapshot()
    if (snap.level !== 'L1') {
      throw new HotplugError(HotplugCode.BUSTER_UNAVAILABLE,
        `${op} 被拒绝：ModuleGraphBuster 自检未通过（${snap.reason}）；本 Node(${snap.nodeVersion}) 上无法保证子模块级热替，请重启宿主`,
        { extra: { op, buster: snap, fallback: 'host_restart' } })
    }
    return snap
  }

  /** 登记插件根（幂等）；返回 { rootPath, rootUrl } 或 null */
  async _ensureRoot(id, entry) {
    const root = resolvePluginRoot(entry.path, { baseDir: this.baseDir })
    if (!root) return null
    await this.buster.setRoot({ id, rootUrl: root.rootUrl })
    return root
  }

  /**
   * guarded 档的可观测信号：权限与 free 相同，但操作要记录"走了安全网"，
   * 便于事后从审计里区分"顶层插件的热替"与"bundles 复合层插件的热替"。
   */
  _noteSafetyNet(tierInfo, op) {
    if (!needsSafetyNet(tierInfo.tier)) return
    this._audit('INFO', 'hotplug.safety_net',
      `${op} ${tierInfo.id}: guarded 档（${tierInfo.reason}）——走完整安全网（超时熔断+单飞+前置校验）`,
      { id: tierInfo.id, op, tier: tierInfo.tier, tierPath: tierInfo.path })
  }

  /** 启动时把所有白名单条目的根登记进 buster（这样后续 reload 才有可 bust 的根） */
  async syncRoots() {
    let ok = 0, skipped = 0
    for (const e of (this.manifest.list() || [])) {
      if (!e || !e.id || !e.path) continue
      const root = resolvePluginRoot(e.path, { baseDir: this.baseDir })
      if (!root) { skipped++; continue }
      await this.buster.setRoot({ id: e.id, rootUrl: root.rootUrl })
      ok++
    }
    this._audit('INFO', 'hotplug.roots.synced', `根登记完成 ok=${ok} skipped=${skipped}`, { ok, skipped })
    return { ok, skipped }
  }

  // ===== 查询 =====

  async list() {
    const out = []
    for (const e of (this.manifest.list() || [])) {
      out.push(await this.status(e.id))
    }
    return out
  }

  async status(id) {
    const entry = this.manifest.get(id)
    if (!entry) throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    const tier = classify(id, this.tree)
    const gen = this.buster.getGen(id)
    const loaded = isLoaded(this.tree, id)
    let moduleRev = null
    let files = []
    try {
      // 代次 0 表示从未热替过（URL 未经改写）⇒ 无记录，rev 为 null 属正常，不是错误
      if (gen > 0) { moduleRev = await this.buster.moduleRev(gen); files = await this.buster.filesForGen(gen) }
    } catch (_) { /* rev 只作证据，取不到不影响 status */ }
    return {
      id,
      path: entry.path,
      enabled: entry.enabled !== false,
      builtin: entry.builtin === true,
      tier: tier.tier,
      tierReason: tier.reason,
      tierPath: tier.path,
      allowedOps: allowedOps(tier.tier),
      loaded,
      gen,
      moduleRev,
      files,
      inFlight: this.mutex.getInFlight(),
    }
  }

  // ===== A 类：插件操作 =====

  async load(id) {
    const entry = this._gate(id)
    this._requireTree('load')
    const tier = classify(id, this.tree)
    assertOpAllowed(tier, 'load')
    await preflight({ id, path: entry.path, baseDir: this.baseDir })
    await this._ensureRoot(id, entry)

    return this.mutex.runExclusive(async () => {
      const started = Date.now()
      if (isLoaded(this.tree, id)) {
        throw new HotplugError(HotplugCode.ALREADY_LOADED, `已加载: ${id}`, { extra: { id } })
      }
      try {
        await this.tree.create({ id, name: resolveEntryName(entry.path, { baseDir: this.baseDir }), config: entry.config })
      } catch (e) {
        this._audit('ERROR', 'hotplug.load.err', `加载失败: ${_msg(e)}`, { id, error: _msg(e) })
        throw new HotplugError(HotplugCode.LOAD_FAILED, `apply 失败: ${_msg(e)}`, { cause: e, extra: { id } })
      }
      this._audit('INFO', 'hotplug.load.ok', `已加载 ${id}（tier=${tier.tier}）`,
        { id, path: entry.path, tier: tier.tier, durationMs: Date.now() - started })
      return { id, status: 'loaded', tier: tier.tier, gen: this.buster.getGen(id), durationMs: Date.now() - started }
    }, { id, action: 'load' })
  }

  /**
   * 开机自动加载：白名单里 enabled 且不在 tree 的条目，逐个 load。
   * 依据：设计文档 §2.2「新实现只做『白名单 enabled 且不在 tree → 排队自动加载』这一条有效职责」
   *      与 §5.3「builtin 作为加载来源标记，用于 recoveryScan 判断要不要排队自动加载」。
   *
   * 四条硬性语义（都有测试钉住，别改）：
   *   1. 只处理 enabled 且不在 tree 的条目
   *   2. 幂等：已加载的条目不会被重复创建（load 本身也会抛 ALREADY_LOADED，这里先跳过）
   *   3. **逐条隔离**：单条失败只记 failed，绝不中断整批、绝不向外抛
   *      —— 否则一个坏插件会连累整台机器启动（这正是 bundles 路线的老问题）
   *   4. 结果写审计，保证"谁上了、谁没上、为什么"可观测
   */
  async autoLoad() {
    const out = { loaded: [], failed: [], skipped: [] }
    if (!this.tree) {
      this._audit('WARN', 'hotplug.autoload.skipped', 'tree 未就绪，跳过自动加载', {})
      return out
    }
    const entries = (this.manifest && typeof this.manifest.list === 'function') ? this.manifest.list() : []
    for (const e of entries) {
      if (!e || !e.id) continue
      if (e.enabled === false) { out.skipped.push({ id: e.id, why: 'disabled' }); continue }
      if (isLoaded(this.tree, e.id)) { out.skipped.push({ id: e.id, why: 'already-loaded' }); continue }
      try {
        await this.load(e.id)
        out.loaded.push(e.id)
      } catch (err) {
        out.failed.push({ id: e.id, code: (err && err.code) || '?', message: String((err && err.message) || err) })
        this._audit('WARN', 'hotplug.autoload.item_failed', `${e.id} 自动加载失败（不影响其它条目）: ${(err && err.message) || err}`, { id: e.id })
      }
    }
    // 必须走 _audit 而不是 _logLine：_logLine 只进 apply 日志，INFO 级的完成事件在
    // hotplug-audit.jsonl / GET /adapter/api/hotplug/audit 里就完全看不见了（实测踩过）。
    this._audit('INFO', 'hotplug.autoload.done',
      `自动加载完成 loaded=${out.loaded.length} failed=${out.failed.length} skipped=${out.skipped.length}`, out)
    return out
  }

  async unload(id) {
    const entry = this._gate(id)
    this._requireTree('unload')
    const tier = classify(id, this.tree)
    assertOpAllowed(tier, 'unload')
    this._noteSafetyNet(tier, 'unload')

    return this.mutex.runExclusive(async () => {
      const started = Date.now()
      if (!isLoaded(this.tree, id)) {
        throw new HotplugError(HotplugCode.NOT_LOADED, `未加载: ${id}`, { extra: { id } })
      }
      const rm = await forceRemoveAll({ tree: this.tree, ctx: this.ctx, id })
      if (rm.remains || rm.failed.length) {
        const code = rm.remains ? HotplugCode.UNLOAD_FAILED_BUT_REMAINS : HotplugCode.UNLOAD_FAILED
        this._audit('ERROR', 'hotplug.unload.err',
          `卸载失败：matched=${rm.matchedCount} removed=${rm.removedCount} failed=${rm.failed.length} remains=${rm.remains}`,
          { id, code, removed: rm.removed, failed: rm.failed, residuals: rm.residuals })
        throw new HotplugError(code,
          `dispose 失败（仍有条目残留）: ${rm.failed.map((f) => f.k + '=' + f.err).join(',') || '残影=' + rm.residuals.join(';')}`,
          { extra: { id, removed: rm.removed, failed: rm.failed, remainsInTree: rm.remains } })
      }
      this._audit('INFO', 'hotplug.unload.ok', `已卸载 ${id}：removed=${rm.removedCount}`,
        { id, removed: rm.removed, durationMs: Date.now() - started })
      return { id, status: 'unloaded', removedEntries: rm.removed, removedCount: rm.removedCount, durationMs: Date.now() - started }
    }, { id, action: 'unload', timeoutMs: 60000 })
  }

  /**
   * reload：同路径同 config，仅换代码代次。
   * swap：换 path/config，代码代次同步前进。
   * 二者共用 _atomicSwitch，保证"失败不卸载"的语义只有一份实现。
   */
  async reload(id) {
    const entry = this._gate(id)
    return this._atomicSwitch({ id, nextEntry: entry, op: 'reload' })
  }

  async swap(id, opts = {}) {
    const entry = this._gate(id)
    const newPath = opts.newPath || entry.path
    const newConfig = opts.newConfig !== undefined ? opts.newConfig : entry.config
    if (opts.newPath && opts.newPath !== entry.path) {
      await preflight({ id, path: newPath, baseDir: this.baseDir })
    }
    return this._atomicSwitch({
      id,
      op: 'swap',
      nextEntry: { ...entry, path: newPath, config: newConfig },
      onCommitted: async () => {
        // 只有切换成功后才回写 manifest；失败则 manifest 原样 ⇒ 不需要 manifest 回滚
        if (newPath !== entry.path || newConfig !== entry.config) {
          if (this.manifest && typeof this.manifest.update === 'function') {
            this.manifest.update(id, { path: newPath, config: newConfig })
          }
        }
      },
    })
  }

  /**
   * 原子切换（缺陷③的核心修复）。
   *   Phase 0  link-validate：旧实例仍在跑时预 import 新代次；失败 ⇒ 旧实例零影响
   *   Phase 1  forceRemoveAll(old) → tree.create(新代次)；成功 ⇒ 提交
   *   Phase 2  apply 期失败 ⇒ 代次回退到 prevGen 重挂旧模块图（旧 URL 仍在 moduleCache 里）
   * 注意 loader name 始终是 resolveEntryName 的稳定标识，**绝不带 bust 参数**（spec §1.4）。
   */
  async _atomicSwitch({ id, nextEntry, op, onCommitted }) {
    this._requireTree(op)
    const busterSnap = this._requireBuster(op)
    const tier = classify(id, this.tree)
    assertOpAllowed(tier, op)
    this._noteSafetyNet(tier, op)
    await preflight({ id, path: nextEntry.path, baseDir: this.baseDir })
    const root = await this._ensureRoot(id, nextEntry)
    if (!root) {
      throw new HotplugError(HotplugCode.HOTPLUG_LINK_INVALID,
        `无法解析插件根目录（旧实例未受影响）: ${nextEntry.path}`,
        { extra: { id, path: nextEntry.path, stage: 'resolve-root' } })
    }
    const entryUrl = resolveEntryFileUrl(nextEntry.path, { baseDir: this.baseDir })

    return this.mutex.runExclusive(async () => {
      const started = Date.now()
      const prevGen = this.buster.getGen(id)
      const nextGen = await this.buster.bumpGen(id)

      // ---- Phase 0：link-validate（旧实例仍在跑）----
      let validated
      try {
        validated = await linkValidate({ id, entryUrl, buster: this.buster, gen: nextGen })
      } catch (e) {
        await this.buster.setGen(id, prevGen)
        const code = (e && e.code) || HotplugCode.HOTPLUG_LINK_INVALID
        this._audit('ERROR', 'hotplug.switch.link_invalid',
          `Phase0 校验失败，旧实例未受影响：${_msg(e)}`,
          { id, op, prevGen, nextGen: null, code, error: _msg(e), stage: (e && e.extra && e.extra.stage) || null })
        throw e
      }
      this._audit('INFO', 'hotplug.switch.validated',
        `Phase0 通过：exports=${validated.exports.length} files=${validated.files.length} rev=${validated.moduleRev}`,
        { id, op, prevGen, nextGen, exports: validated.exports, fileCount: validated.files.length,
          moduleRev: validated.moduleRev, validateMs: validated.durationMs })

      // ---- Phase 1：替换 ----
      const wasLoaded = isLoaded(this.tree, id)
      if (wasLoaded) {
        const rm = await forceRemoveAll({ tree: this.tree, ctx: this.ctx, id })
        if (rm.remains || rm.failed.length) {
          await this.buster.setGen(id, prevGen)
          const code = rm.remains ? HotplugCode.UNLOAD_FAILED_BUT_REMAINS : HotplugCode.UNLOAD_FAILED
          this._audit('ERROR', 'hotplug.switch.phase1.err',
            `Phase1 卸载旧实例失败，已回退代次：remains=${rm.remains} failed=${rm.failed.length}`,
            { id, op, prevGen, code, removed: rm.removed, failed: rm.failed, remainsInTree: rm.remains })
          throw new HotplugError(code,
            `${op} 中止：旧实例未能完全卸下（继续 create 会导致重复注册）。removed=${rm.removedCount} failed=${rm.failed.length} 残影=${rm.residuals.join(';')}`,
            { extra: { id, removed: rm.removed, failed: rm.failed, remainsInTree: rm.remains } })
        }
      }

      try {
        await this.tree.create({ id, name: resolveEntryName(nextEntry.path, { baseDir: this.baseDir }), config: nextEntry.config })
      } catch (e) {
        // ---- Phase 2：自愈（回退到旧代次，重挂已知可用的旧模块图）----
        await this.buster.setGen(id, prevGen)
        let rollbackOk = false
        let rollbackErr = null
        try {
          await forceRemoveAll({ tree: this.tree, ctx: this.ctx, id })
          await this.tree.create({ id, name: resolveEntryName(nextEntry.path, { baseDir: this.baseDir }), config: nextEntry.config })
          rollbackOk = true
        } catch (e2) { rollbackErr = e2 }

        if (rollbackOk) {
          this._gens.set(id, prevGen)
          this._audit('WARN', 'hotplug.switch.rollback.ok',
            `${op} apply 失败，已回退到旧代次并恢复运行（prevGen=${prevGen}）`,
            { id, op, prevGen, originalError: _msg(e) })
          throw new HotplugError(HotplugCode.HOTPLUG_ROLLBACK_OK,
            `${op} 未成功但服务未中断：已回退到旧代次(gen=${prevGen})并重新挂载成功。原因: ${_msg(e)}`,
            { cause: e, extra: { id, op, prevGen, rolledBackTo: prevGen, originalError: _msg(e) } })
        }

        // 回滚也失败：先判断"树到底脏不脏"，再决定是全局熔断还是只报本插件失败。
        // 判据：该条目是否仍留在树里。若 Phase 2 的卸载已成功、只是重建失败，树是**干净**的
        // （该插件处于未加载态），此时把整个 loader 标成 unstable 会无谓地封锁其它所有插件 ——
        // 实测在真实宿主上踩到过（EACCES 导致新旧代码都 apply 失败，结果连 unload 都被拒）。
        const dirty = isLoaded(this.tree, id) || this.mutex.isUnstable()
        if (dirty) this.mutex.markUnstable(`${op}_rollback_failed`)
        this._audit('ERROR', 'hotplug.switch.rollback.failed',
          `${op} apply 失败且回滚失败：${_msg(e)} / 回滚: ${_msg(rollbackErr)}（树${dirty ? '不干净 → 已熔断' : '干净 → 仅本插件受影响'}）`,
          { id, op, prevGen, originalError: _msg(e), rollbackError: _msg(rollbackErr), treeClean: !dirty })
        throw new HotplugError(HotplugCode.HOTPLUG_ROLLBACK_FAILED,
          `${op} 失败且回滚失败。原因: ${_msg(e)}；回滚: ${_msg(rollbackErr)}`
          + (dirty
            ? '（loader 树不干净，需重启宿主）'
            : `（树干净：${id} 现处未加载态，修好后可重试，无需重启）`),
          { cause: e, extra: { id, op, prevGen, rollbackError: _msg(rollbackErr), treeClean: !dirty } })
      }

      // ---- 提交 ----
      this._gens.set(id, nextGen)
      if (typeof onCommitted === 'function') {
        try { await onCommitted() } catch (e) {
          this._audit('WARN', 'hotplug.switch.commit_hook_failed', `提交钩子失败（不影响已生效的切换）: ${_msg(e)}`, { id, op, error: _msg(e) })
        }
      }
      const durationMs = Date.now() - started
      this._audit('INFO', 'hotplug.switch.ok',
        `${op} 成功：gen ${prevGen} → ${nextGen}，rev=${validated.moduleRev}`,
        { id, op, tier: tier.tier, prevGen, nextGen, moduleRev: validated.moduleRev,
          exports: validated.exports, fileCount: validated.files.length, durationMs,
          buster: { level: busterSnap.level, mode: busterSnap.mode } })
      return {
        id, status: op === 'swap' ? 'swapped' : 'reloaded',
        tier: tier.tier, gen: nextGen, prevGen,
        moduleRev: validated.moduleRev,
        exports: validated.exports,
        files: validated.files.map((f) => ({ path: f.path, size: f.size, hash: f.hash })),
        durationMs,
      }
    }, { id, action: op, timeoutMs: 60000 })
  }

  // ===== B 类：白名单操作 =====

  async whitelistAdd(entry) {
    if (!entry || !entry.id) throw new HotplugError(HotplugCode.INVALID_ARGS, 'id 为空')
    if (!entry.path) throw new HotplugError(HotplugCode.INVALID_ARGS, 'path 为空')
    if (this.manifest.has(entry.id)) {
      throw new HotplugError(HotplugCode.DUPLICATE_ID, `id 已存在: ${entry.id}`, { extra: { id: entry.id } })
    }
    const added = this.manifest.add({
      id: entry.id,
      path: entry.path,
      config: entry.config || {},
      builtin: entry.builtin === true,
      enabled: entry.enabled !== false,
    })
    await this._ensureRoot(added.id, added)
    this._audit('INFO', 'hotplug.whitelist.add', `白名单新增: ${added.id}`,
      { id: added.id, path: added.path, builtin: added.builtin === true, enabled: added.enabled !== false })
    return { id: added.id, status: 'added' }
  }

  async whitelistRemove(id) {
    if (!this.manifest.has(id)) {
      throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    }
    const wasLoaded = isLoaded(this.tree, id)
    if (wasLoaded) {
      // 已加载则先热卸载；卸载失败即中止（避免"白名单已删但插件还在跑"的裂脑状态）
      await this.unload(id)
    }
    this.manifest.remove(id)
    await this.buster.removeRoot(id)
    this._audit('INFO', 'hotplug.whitelist.remove', `白名单移除: ${id}`, { id, wasLoaded })
    return { id, status: 'removed', wasLoaded }
  }

  async whitelistEnable(id) {
    if (!this.manifest.has(id)) {
      throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    }
    this.manifest.update(id, { enabled: true })
    this._audit('INFO', 'hotplug.whitelist.enable', `白名单启用: ${id}`, { id })
    return { id, enabled: true }
  }

  async whitelistDisable(id) {
    if (!this.manifest.has(id)) {
      throw new HotplugError(HotplugCode.NOT_WHITELISTED, `id 不在白名单: ${id}`, { extra: { id } })
    }
    this.manifest.update(id, { enabled: false })
    this._audit('INFO', 'hotplug.whitelist.disable', `白名单禁用: ${id}`, { id })
    return { id, enabled: false }
  }

  // ===== 诊断快照 =====

  snapshot() {
    return {
      buster: this.buster.snapshot(),
      treeAvailable: this.treeAvailable,
      inFlight: this.mutex.getInFlight(),
      unstable: this.mutex.isUnstable(),
      unstableReason: this.mutex.unstableReason,
      gens: Object.fromEntries(this._gens),
    }
  }
}
