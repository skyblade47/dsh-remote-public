// @local/dsh-adapter —— ModuleGraphBuster 主线程侧
//
// 目的（spec §4）：把"绕 ESM 缓存"从 loader name 上摘下来，改为在模块解析层按"代次"破除，
// 从而同时修好缺陷②（只 bust 入口、子模块仍命中缓存）与 UI graph 丢失（loader name 带 query）。
//
// 两条注册路径，按能力择一（spec §4.3 跨版本兜底的第一级）：
//   A. registerHooks —— Node 22.15+ 的同线程同步钩子：钩子是普通函数，直接闭包看到活的内存表，
//      无需端口同步。**本仓库 engines 要求 >=22.19.0，故这是常规路径。**
//   B. register + MessagePort —— Node 20.6+ 的跨线程钩子：根表要靠端口推送，且有同步延迟，
//      故 setRoots 走请求/应答，确保"根表已生效"再继续（否则会重现假成功）。
//      ⚠️ 实测该 API 自 **Node 18.19 起也有**（backport）⇒ 18 也会走这条路径，
//         且 M5 矩阵证明这条路在 18/20 上**自检 8/8 全过**（不是"理论兜底"）。
//   两者都不可用 → init 后 level=L3，reload 走"退让兜底"（明确拒绝并给出原因，不静默失败）。
//
// 自检（selftest）不是可选装饰：它用一个临时探针模块真实验证"换代次后 import() 得到新实例"，
// 任一自检项不过即降 L3。宁可明确说"这个 Node 上不支持热替"，也不接受"报成功但行为没变"。

import * as nodeModule from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { applyGen, isBustable, urlToFsPath, readGen } from './buster-core.js'

export const BusterLevel = Object.freeze({ L1: 'L1', L3: 'L3' })
export const BusterMode = Object.freeze({
  REGISTER_HOOKS: 'registerHooks',
  REGISTER_PORT: 'register+port',
  NONE: 'none',
})

const _msg = (e) => String((e && e.message) || e)
const _norm = (p) => String(p).replace(/\\/g, '/').toLowerCase()
// 每个代次的文件记录桶保留上限：代次是全局单调递增的，不设上限会随每次 reload 线性增长。
const MAX_GEN_BUCKETS = 16

export class ModuleGraphBuster {
  constructor({ log } = {}) {
    this._roots = new Map()        // id -> { id, rootUrl, gen }
    this._filesByGen = new Map()   // gen(string) -> Map(fsPath -> { path, mtimeMs, size, hash })，仅 registerHooks 模式本地记录
    this._seq = 0                  // 全局代次序列（见 bumpGen 的说明）
    this._mode = BusterMode.NONE
    this._port = null
    this._reqSeq = 0
    this._pending = new Map()
    this._selftest = {
      level: BusterLevel.L3, mode: BusterMode.NONE,
      nodeVersion: process.versions.node, reason: 'not-run', checks: {},
    }
    this._log = typeof log === 'function' ? log : () => {}
  }

  // ===== 初始化 =====

  async init() {
    const tried = []

    if (typeof nodeModule.registerHooks === 'function') {
      try {
        nodeModule.registerHooks({
          resolve: (specifier, context, nextResolve) => {
            const r = nextResolve(specifier, context)
            const u = applyGen(r.url, this.rootsArray())
            return u === r.url ? r : { ...r, url: u, shortCircuit: true }
          },
          load: (url, context, nextLoad) => {
            this._recordLoad(url)
            return nextLoad(url, context)
          },
        })
        this._mode = BusterMode.REGISTER_HOOKS
        tried.push('registerHooks=ok')
      } catch (e) { tried.push('registerHooks=' + _msg(e)) }
    } else {
      tried.push('registerHooks=absent')
    }

    if (this._mode === BusterMode.NONE && typeof nodeModule.register === 'function') {
      try {
        const { MessageChannel } = await import('node:worker_threads')
        const ch = new MessageChannel()
        this._port = ch.port1
        this._port.on('message', (m) => this._onPortMessage(m))
        try { if (typeof this._port.unref === 'function') this._port.unref() } catch (_) {}
        nodeModule.register('./buster-hooks.mjs', import.meta.url, {
          data: { port: ch.port2 },
          transferList: [ch.port2],
        })
        this._mode = BusterMode.REGISTER_PORT
        tried.push('register+port=ok')
      } catch (e) { tried.push('register+port=' + _msg(e)) }
    } else if (this._mode === BusterMode.NONE) {
      tried.push('register=absent')
    }

    this._log('BUSTER_INIT mode=' + this._mode + ' node=' + process.versions.node + ' tried=[' + tried.join(' ') + ']')

    if (this._mode === BusterMode.NONE) {
      this._selftest = {
        level: BusterLevel.L3, mode: this._mode, nodeVersion: process.versions.node,
        reason: '本 Node 版本没有可用的模块钩子 API（registerHooks 需 Node 22.15+、register 需 Node 20.6+，'
          + '该 backport 亦见于 Node 18.19+；两者均不可用）⇒ 热替退让为 L3：**只能用重启**'
          + '（或按 M5 的 L2「插件契约改造」路线改造插件，使其不需要热替）',
        checks: {},
      }
      return this._selftest
    }

    // 补推根表：init 之前登记的根（典型场景是 adapter 先建服务、后做自检）在 register+port
    // 模式下还没送达钩子线程；不补推的话这些根永远不生效 ⇒ reload 会"报成功但代码没换"。
    if (this._roots.size) await this._pushRoots()

    return await this.selftest()
  }

  // ===== 端口通道（仅 register+port 模式）=====

  _onPortMessage(m) {
    if (!m || typeof m !== 'object') return
    const p = this._pending.get(m.reqId)
    if (p) { this._pending.delete(m.reqId); p(m) }
  }

  _request(msg, timeoutMs = 3000) {
    if (this._mode !== BusterMode.REGISTER_PORT || !this._port) return Promise.resolve(null)
    const reqId = ++this._reqSeq
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this._pending.delete(reqId)
        resolve(null)
      }, timeoutMs)
      // ⚠️ 这个超时定时器是 **unref 的**，代价是：**调用方必须自己撑住事件循环**。
      //    在没有别的活的进程里（脚本 / 一次性 CLI），事件循环会在超时**之前**空掉
      //    ⇒ 进程直接退出、这个 await 被**抛弃**，表现为"退出码 0 但什么都没做"
      //    （M5 矩阵上实测踩到：Node 18/20 的自检整段输出消失、只留退出码）。
      //    生产内核里另有大把任务撑着循环，故那里表现为"3 秒超时后继续"。
      try { if (typeof timer.unref === 'function') timer.unref() } catch (_) {}
      this._pending.set(reqId, (m) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(m)
      })
      try { this._port.postMessage({ ...msg, reqId }) } catch (_) {
        clearTimeout(timer)
        this._pending.delete(reqId)
        resolve(null)
      }
    })
  }

  // ===== 根表 =====

  rootsArray() {
    return Array.from(this._roots.values()).map((r) => ({ id: r.id, rootUrl: r.rootUrl, gen: r.gen }))
  }

  async _pushRoots() {
    if (this._mode === BusterMode.REGISTER_PORT) {
      await this._request({ type: 'setRoots', roots: this.rootsArray() })
    }
  }

  /**
   * 登记（或更新）一个可 bust 根，代次从 0 起（= 不改写 URL，即 loader 的正常解析）。
   * 故意**不暴露裸代次参数**：代次只能经 bumpGen（全局唯一取号）或 setGen（回滚到已发放值）
   * 变更。曾经留过这个口子，实测立刻被误用成"两个插件都写 gen:1"，于是共享记录桶、
   * moduleRev 互相污染 —— 这类 footgun 直接删掉比写文档更可靠。
   */
  async setRoot({ id, rootUrl }) {
    if (!id || typeof rootUrl !== 'string' || !rootUrl) return false
    const prev = this._roots.get(id)
    this._roots.set(id, { id, rootUrl, gen: prev ? prev.gen : 0 })
    await this._pushRoots()
    return !!prev
  }

  async removeRoot(id) {
    const had = this._roots.delete(id)
    if (had) await this._pushRoots()
    return had
  }

  hasRoot(id) { return this._roots.has(id) }
  getRoot(id) { return this._roots.get(id) || null }
  getGen(id) { const r = this._roots.get(id); return r ? r.gen : 0 }

  /**
   * 取下一个**全局唯一**代次并绑定到该根；返回新代次。
   *
   * 为什么必须全局唯一（实测踩到过）：若按插件各自从 1 计数，两个插件的"代次 1"会共享
   * 同一个文件记录桶，A 插件的 moduleRev 里会混进 B 插件的模块，rev 便失去意义。
   * 全局单调还顺带保证"回滚到旧代次"能精确命中旧 URL（旧模块仍在 moduleCache 里，
   * 这正是 spec §6.2 用"保留旧代次"替代磁盘备份的前提）。
   */
  async bumpGen(id) {
    const r = this._roots.get(id)
    if (!r) return 0
    r.gen = ++this._seq
    await this._pushRoots()
    return r.gen
  }

  /** 指定代次（回滚用）：只回到此前已发放过的全局代次，不推进序列 */
  async setGen(id, gen) {
    const r = this._roots.get(id)
    if (!r) return 0
    r.gen = Number(gen) || 0
    await this._pushRoots()
    return r.gen
  }

  // ===== 已加载文件记录（moduleRev 的证据链）=====

  /** registerHooks 模式下由 load 钩子直接调用 */
  _recordLoad(url) {
    try {
      if (!isBustable(url)) return
      const gen = readGen(url)
      if (gen === null) return
      const p = urlToFsPath(url)
      if (!p) return
      let meta
      try {
        const st = statSync(p)
        let hash = ''
        try { hash = createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12) } catch (_) { hash = '' }
        meta = { path: p, mtimeMs: st.mtimeMs, size: st.size, hash }
      } catch (_) {
        meta = { path: p, mtimeMs: 0, size: 0, hash: '' }
      }
      let m = this._filesByGen.get(gen)
      if (!m) { m = new Map(); this._filesByGen.set(gen, m) }
      m.set(p, meta)
      this._pruneGenBuckets()
    } catch (_) { /* 记录失败绝不影响加载 */ }
  }

  // 代次桶按插入序裁剪：Map 保序，超上限即丢最旧的（回滚只用到相邻一代，16 足够）
  _pruneGenBuckets() {
    const excess = this._filesByGen.size - MAX_GEN_BUCKETS
    if (excess <= 0) return
    let i = 0
    for (const k of this._filesByGen.keys()) {
      if (i++ >= excess) break
      this._filesByGen.delete(k)
    }
  }

  /** 某一代次实际读取过的文件清单 */
  async filesForGen(gen) {
    const key = String(gen)
    if (this._mode === BusterMode.REGISTER_PORT) {
      const r = await this._request({ type: 'queryFiles', gen: key })
      return r && Array.isArray(r.files) ? r.files : []
    }
    const m = this._filesByGen.get(key)
    return m ? Array.from(m.values()) : []
  }

  /**
   * 该代次的模块指纹：对"实际加载的每个文件的内容 hash"取摘要。
   * 用内容 hash 而非仅 mtime/size —— 改一个等长的子模块也能被感知（验收 A1 依赖此点）。
   */
  async moduleRev(gen) {
    const files = await this.filesForGen(gen)
    if (!files.length) return null
    const h = createHash('sha1')
    for (const f of files.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
      h.update(String(f.path)); h.update('|'); h.update(String(f.hash || '')); h.update('|'); h.update(String(f.size))
    }
    return h.digest('hex').slice(0, 12)
  }

  // ===== 自检 =====

  async selftest() {
    const checks = {}
    let reason = ''
    let dir = null
    const PROBE_ID = '__dsh_buster_selftest__'

    try {
      dir = mkdtempSync(join(tmpdir(), 'dsh-buster-'))
      const probeFile = join(dir, 'probe.mjs')
      writeFileSync(probeFile, 'export const marker = "probe"\nexport default { marker: "probe" }\n', 'utf8')
      const probeUrl = pathToFileURL(probeFile).href
      const rootUrl = pathToFileURL(dir).href

      // 代次必须"全局唯一"：这里用 bumpGen 取号，而不是写死 1/2/3。
      // 写死会在多插件场景下让不同插件的同代号共用记录桶（实测踩到），自检也就测不出真问题。
      await this.setRoot({ id: PROBE_ID, rootUrl })

      // 代次一：同一代次重复 import 必须命中缓存（幂等；否则说明缓存根本没在起作用）
      const g1 = await this.bumpGen(PROBE_ID)
      const a = await import(probeUrl)
      const a2 = await import(probeUrl)
      checks.sameGenCached = a === a2 && a2.marker === 'probe'

      // 代次二：换代次必须拿到**新实例** —— 这是缺陷②修复的判据本身
      const g2 = await this.bumpGen(PROBE_ID)
      const b = await import(probeUrl)
      checks.bumpNewInstance = a !== b

      // 代次三：再换一次，确认可反复且互不相同
      const g3 = await this.bumpGen(PROBE_ID)
      const c = await import(probeUrl)
      checks.bumpAgainNewInstance = b !== c && a !== c
      checks.genDistinct = g1 !== g2 && g2 !== g3

      // 边界规则 1：根目录之外不得改写
      const outside = pathToFileURL(join(dir, '..', 'dsh-buster-outside-probe.mjs')).href
      checks.outsideUntouched = applyGen(outside, this.rootsArray()) === outside

      // 边界规则 2：node_modules 内不得改写（否则依赖会多副本、单例会破）
      const nm = pathToFileURL(join(dir, 'node_modules', 'dep', 'index.js')).href
      checks.nodeModulesUntouched = applyGen(nm, this.rootsArray()) === nm

      // 证据链：load 钩子必须记到文件，且能算出 rev
      const files = await this.filesForGen(g3)
      checks.loadRecorded = files.some((f) => _norm(f.path) === _norm(probeFile))
      checks.revComputed = !!(await this.moduleRev(g3))
    } catch (e) {
      reason = _msg(e)
    } finally {
      try { await this.removeRoot(PROBE_ID) } catch (_) {}
      try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch (_) {}
    }

    const ok = !!(checks.sameGenCached && checks.bumpNewInstance && checks.bumpAgainNewInstance &&
      checks.genDistinct && checks.outsideUntouched && checks.nodeModulesUntouched &&
      checks.loadRecorded && checks.revComputed)
    const level = ok ? BusterLevel.L1 : BusterLevel.L3
    if (!ok && !reason) reason = '自检项未全通过: ' + JSON.stringify(checks)
    this._selftest = {
      level, mode: this._mode, nodeVersion: process.versions.node,
      reason: ok ? 'self-test ok' : reason, checks,
    }
    this._log('BUSTER_SELFTEST level=' + level + ' mode=' + this._mode + ' checks=' + JSON.stringify(checks)
      + (ok ? '' : ' reason=' + reason))
    return this._selftest
  }

  // ===== 对外快照（供 adapter.status() / GET /adapter/api 使用）=====

  snapshot() {
    return {
      level: this._selftest.level,
      mode: this._selftest.mode,
      nodeVersion: this._selftest.nodeVersion,
      reason: this._selftest.reason,
      checks: this._selftest.checks,
      roots: this.rootsArray(),
    }
  }

  get level() { return this._selftest.level }
  get mode() { return this._mode }
}
