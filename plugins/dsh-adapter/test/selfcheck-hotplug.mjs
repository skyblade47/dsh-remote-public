// @local/dsh-adapter —— 热拔插内核（M1）自检
//
// 覆盖 spec §10 里 M1 能覆盖的判据，重点是四个结构性缺陷的**判据本身**：
//   A1  只改非入口子模块 → reload 后行为真的变了（缺陷②）
//   A2  manifest 登记 builtin 的插件 → 档位判为 guarded 且 reload 被放行（缺陷①）
//   A3  注入链接错误 → reload 报 HOTPLUG_LINK_INVALID，且**旧插件仍在跑**（缺陷③，对比 E18）
//   A4  reload 后 moduleRev 随磁盘变化（缺陷④）
//   A5  buster 自检不过 → 明确拒绝并给原因（退让兜底）
//   A6  Phase0 预热 + Phase1 命中缓存 ⇒ 模块不重复求值（设计关键性质，防"假成功"）
//
// 特点：用**真实 ESM 导入**驱动（假 loader 树的 create 就是 import(name)），
// 所以 buster 钩子确实在链路上生效 —— 不是只测纯函数。
//
// 用法：node plugins/dsh-adapter/test/selfcheck-hotplug.mjs      退出码 0=全通过

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ModuleGraphBuster } from '../lib/hotplug/buster.js'
import { applyGen, isBustable, matchRoot, readGen, urlToFsPath } from '../lib/hotplug/buster-core.js'
import { linkValidate } from '../lib/hotplug/linker.js'
import { classify, assertOpAllowed, needsSafetyNet, Tier, allowedOps } from '../lib/hotplug/tiers.js'
import { HotplugService } from '../lib/hotplug/index.js'
import { HotplugCode } from '../lib/hotplug/errors.js'

let pass = 0, fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [PASS] ' + name + (extra !== undefined ? '  → ' + extra : '')) }
  else { fail++; failures.push(name); console.log('  [FAIL] ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
function eq(name, actual, expect) {
  ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect))
}
async function throwsCode(name, fn, code) {
  try { await fn(); ok(name, false, '未抛错') }
  catch (e) {
    ok(name, e && e.code === code, 'code=' + (e && e.code) + (e && e.code !== code ? ' msg=' + e.message : ''))
    return e
  }
}

// ============ 测试夹具：一个真实可 import 的插件目录 ============
const dir = mkdtempSync(join(tmpdir(), 'dsh-hotplug-'))
const pluginDir = join(dir, 'plug')
mkdirSync(join(pluginDir, 'lib'), { recursive: true })
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: '@local/plug', version: '0.0.1', type: 'module', main: 'lib/index.js' }), 'utf8')

const ENTRY = join(pluginDir, 'lib', 'index.js')
const SUB = join(pluginDir, 'lib', 'sub.js')

// 入口：稳定形制（apply 导出 + 一个非入口子模块）；带自增 tick 以检测重复求值
// 特意把子模块的 subTick **再导出**出来：这样入口命名空间就是"这一代实际跑的是哪个子模块实例"的证据
const ENTRY_SRC = `import { V } from './sub.js'
export { subTick } from './sub.js'
export const evalTick = ++globalThis.__hpEntryTick
export function apply() {}
export const value = V
`
// 非入口子模块：改它才是缺陷②的正题
const subSrc = (v) => `export const subTick = ++globalThis.__hpSubTick
export const V = ${v}
`
writeFileSync(ENTRY, ENTRY_SRC, 'utf8')
writeFileSync(SUB, subSrc(1), 'utf8')

globalThis.__hpEntryTick = 0
globalThis.__hpSubTick = 0

const PLUGIN_ID = 'plug'
const pluginPath = pathToFileURL(pluginDir).href

// ============ 假 loader 树：create 即真实 import(name) ============
// group=true 时条目落在 include.subtree.store 里 —— 即 bundles 复合层的形状，
// 用来真实覆盖 guarded 档（而不是手工把对象搬来搬去，那样 remove 语义会失真）。
class FakeTree {
  constructor({ group = false } = {}) {
    this.store = {}
    this._group = group
    if (group) this.store.include = { subtree: { store: {} } }
  }
  _home() { return this._group ? this.store.include.subtree.store : this.store }
  async create({ id, name, config }) {
    const key = 'local-' + id
    const home = this._home()
    if (home[key]) {
      // 模拟宿主"tool already registered" —— Phase1 泄漏到 Phase2 的典型触发点
      throw new Error(`tool "${id}" is already registered`)
    }
    if (this.failCreateTimes > 0) {   // 计数器：置 2 可让 Phase1 + Phase2 回滚都失败
      this.failCreateTimes--
      throw new Error('注入的 apply 期失败')
    }
    const ns = await import(name)   // ← buster 钩子在此生效
    const entry = {
      id: key,
      name,
      options: { id: key, name, config: config || {} },
      fiber: { state: 2, runtime: { callback: () => {}, effects: [] } },
      __ns: ns,
      remove: async () => { delete home[key] },
    }
    home[key] = entry
    return entry
  }
  async remove(key) { delete this._home()[key] }
  nsOf(id) { const e = this._home()['local-' + id]; return e ? e.__ns : null }
  has(id) { return !!this._home()['local-' + id] }
}

class FakeManifest {
  constructor(entries) { this._m = new Map(entries.map((e) => [e.id, e])) }
  get(id) { return this._m.get(id) }
  has(id) { return this._m.has(id) }
  list() { return Array.from(this._m.values()) }
  add(e) { this._m.set(e.id, e); return e }
  remove(id) { this._m.delete(id) }
  update(id, patch) { const e = this._m.get(id); if (e) Object.assign(e, patch); return e }
}

const auditRecs = []
const audit = { log: (r) => auditRecs.push(r) }

// ============ [1] buster-core 纯逻辑（缺陷②的规则边界）============
console.log('\n=== [1] buster-core：可 bust 范围与最长前缀 ===')

const ROOT_A = pathToFileURL(join(dir, 'plug')).href
const ROOT_AB = pathToFileURL(join(dir, 'plug', 'lib')).href
const roots = [
  { id: 'a', rootUrl: ROOT_A, gen: 7 },
  { id: 'ab', rootUrl: ROOT_AB, gen: 9 },
]

eq('1a file: URL 可 bust', isBustable(pathToFileURL(SUB).href), true)
eq('1b 非 file: 不可 bust', isBustable('node:fs'), false)
eq('1c node_modules 内不可 bust（规则2）',
  isBustable(pathToFileURL(join(dir, 'node_modules', 'x', 'i.js')).href), false)
eq('1d 最长前缀胜出（子根 gen=9 覆盖父根 gen=7）',
  matchRoot(pathToFileURL(SUB).href, roots).id, 'ab')
eq('1e 同级不同名不误匹配（/pluga 不被 /plug 命中）',
  matchRoot(pathToFileURL(join(dir, 'pluga', 'x.js')).href, roots), null)
eq('1f applyGen 用子根代次', readGen(applyGen(pathToFileURL(SUB).href, roots)), '9')
eq('1g applyGen 幂等：同代次原样返回',
  applyGen(applyGen(pathToFileURL(SUB).href, roots), roots), applyGen(pathToFileURL(SUB).href, roots))
eq('1h 根表为空 → 不改写', applyGen(pathToFileURL(SUB).href, []), pathToFileURL(SUB).href)
eq('1i gen=0 → 清掉残留代次',
  readGen(applyGen(pathToFileURL(SUB).href + '?dshgen=5', [{ id: 'a', rootUrl: ROOT_A, gen: 0 }])), null)
eq('1j 保留其它 query 参数',
  applyGen(pathToFileURL(SUB).href + '?foo=1', roots).includes('foo=1'), true)
ok('1k urlToFsPath 是平台路径（不是 ///C:/ 这种）',
  (() => { const p = urlToFsPath(pathToFileURL(SUB).href); return p && !p.startsWith('///') })(),
  urlToFsPath(pathToFileURL(SUB).href))

// ============ [2] buster 初始化与自检 ============
console.log('\n=== [2] ModuleGraphBuster 初始化与自检 ===')

const buster = new ModuleGraphBuster({ log: () => {} })
const selftest = await buster.init()
eq('2a 自检档位为 L1（本机 Node 具备模块钩子）', selftest.level, 'L1')
eq('2b 钩子注册方式', selftest.mode, 'registerHooks')
ok('2c 自检明细各项通过', Object.values(selftest.checks).every(Boolean), JSON.stringify(selftest.checks))
ok('2d 快照暴露 roots', Array.isArray(buster.snapshot().roots), true)

// ============ [3] linker：链接错误必须在 Phase0 被拦下 ============
console.log('\n=== [3] linkValidate（缺陷③的第一道闸） ===')

await buster.setRoot({ id: 'probe3', rootUrl: ROOT_A })
const g3 = await buster.bumpGen('probe3')
const good = await linkValidate({ id: 'probe3', entryUrl: pathToFileURL(ENTRY).href, buster, gen: g3 })
ok('3a 合法入口通过校验', good.ok === true, 'exports=' + good.exports.join(','))
ok('3b 校验产出 moduleRev（证据链）', !!good.moduleRev, good.moduleRev)
ok('3c 校验记录了加载过的文件', good.files.some((f) => f.path.endsWith('sub.js')), good.files.map((f) => f.path.split(/[\\/]/).pop()).join(','))

// E18 形状的破坏：入口 import 一个不存在的具名导出 ⇒ ESM 链接期失败
writeFileSync(ENTRY, `import { NOPE } from './sub.js'\nexport function apply() {}\n`, 'utf8')
const g3bad = await buster.bumpGen('probe3')
const errLink = await throwsCode('3d 链接失败被拦下并归为 HOTPLUG_LINK_INVALID',
  () => linkValidate({ id: 'probe3', entryUrl: pathToFileURL(ENTRY).href, buster, gen: g3bad }),
  HotplugCode.HOTPLUG_LINK_INVALID)
ok('3e 错误里带 stage=import（便于定位是链接期还是形状期）',
  errLink && errLink.extra && errLink.extra.stage === 'import', errLink && errLink.extra && errLink.extra.stage)

writeFileSync(ENTRY, `export const notAPlugin = 1\n`, 'utf8')
const g3shape = await buster.bumpGen('probe3')
const errShape = await throwsCode('3f 无 apply/default 导出被判形状错',
  () => linkValidate({ id: 'probe3', entryUrl: pathToFileURL(ENTRY).href, buster, gen: g3shape }),
  HotplugCode.HOTPLUG_LINK_INVALID)
eq('3g shape 错 stage=export-shape', errShape && errShape.extra && errShape.extra.stage, 'export-shape')

// 复原入口
writeFileSync(ENTRY, ENTRY_SRC, 'utf8')
await buster.removeRoot('probe3')

// ============ [4] 三档判定（缺陷①）============
console.log('\n=== [4] 三档可热替性 ===')

const freeEntry = { id: 'local-free', name: '@local/free', options: { id: 'local-free', name: '@local/free' }, fiber: { state: 2, runtime: {} }, remove: async () => {} }
const guardedEntry = { id: 'local-guarded', name: '@local/guarded', options: { id: 'local-guarded', name: '@local/guarded' }, fiber: { state: 2, runtime: {} }, remove: async () => {} }
const lockedEntry = { id: 'local-locked', name: '@local/locked', options: { id: 'local-locked', name: '@local/locked' }, fiber: { state: 2, runtime: {} }, store: { child: {} }, remove: async () => {} }

const treeFree = { store: { 'local-free': freeEntry } }
const treeGuarded = { store: { include: { subtree: { store: { 'local-guarded': guardedEntry } } } } }
const treeLocked = { store: { 'local-locked': lockedEntry } }

eq('4a 顶层条目 → free', classify('free', treeFree).tier, Tier.FREE)
eq('4b 复合层子树内 → guarded', classify('guarded', treeGuarded).tier, Tier.GUARDED)
eq('4c 自身是容器 → locked', classify('locked', treeLocked).tier, Tier.LOCKED)
eq('4d 不在树中 → free（load 将在顶层创建）', classify('nope', treeFree).tier, Tier.FREE)
eq('4e tree 不可用 → locked（保守）', classify('x', null).tier, Tier.LOCKED)
eq('4f free 的允许操作集', allowedOps(Tier.FREE).join(','), 'load,unload,swap,reload')
eq('4g guarded 与 free 同权（2026-09-22 决策：允许 unload）',
  allowedOps(Tier.GUARDED).join(','), 'load,unload,swap,reload')
eq('4h locked 允许操作集为空', allowedOps(Tier.LOCKED).length, 0)
ok('4h2 guarded 需要安全网（与 free 的差别在此，而非权限）',
  needsSafetyNet(Tier.GUARDED) === true && needsSafetyNet(Tier.FREE) === false)

ok('4i guarded 允许 reload', (() => { try { assertOpAllowed(classify('guarded', treeGuarded), 'reload'); return true } catch (_) { return false } })())
ok('4j guarded 允许 unload（不再有 HOTPLUG_UNLOAD_FORBIDDEN）',
  (() => { try { assertOpAllowed(classify('guarded', treeGuarded), 'unload'); return true } catch (_) { return false } })())
await throwsCode('4k locked 拒绝一切操作',
  async () => assertOpAllowed(classify('locked', treeLocked), 'reload'), HotplugCode.HOTPLUG_TIER_LOCKED)
ok('4l locked 错误里给了 fallback=host_restart（不静默失败）',
  (() => { try { assertOpAllowed(classify('locked', treeLocked), 'reload') } catch (e) { return e.extra.fallback === 'host_restart' } })())
// 缺陷①的反例固化：builtin 登记不再决定档位 —— free 树 + builtin:true 仍应放行
ok('4m builtin:true 但位于顶层 → 仍判 free（不再一刀切拒绝）',
  classify('free', treeFree).tier === Tier.FREE)

// ============ [5] HotplugService 端到端（缺陷②③④）============
console.log('\n=== [5] HotplugService：原子切换 ===')

const tree = new FakeTree()
const manifest = new FakeManifest([{ id: PLUGIN_ID, path: pluginPath, config: {}, builtin: true, enabled: true }])
const svc = new HotplugService({
  manifest, buster, tree, ctx: null, audit, logLine: () => {}, baseDir: dir,
})
await svc.syncRoots()

// 首次加载（代次 0：URL 不改写，即 loader 的正常解析）
const loaded = await svc.load(PLUGIN_ID)
eq('5a 首次加载成功', loaded.status, 'loaded')
eq('5b 首次加载后 gen=0（未热替过）', loaded.gen, 0)
eq('5c 加载后行为 V=1', tree.nsOf(PLUGIN_ID).value, 1)
const subTickAfterLoad = tree.nsOf(PLUGIN_ID).subTick
const evalTickAfterLoad = tree.nsOf(PLUGIN_ID).evalTick
ok('5d 登记 builtin 的条目仍被判为可热替档位（缺陷①）',
  ['free', 'guarded'].includes((await svc.status(PLUGIN_ID)).tier), (await svc.status(PLUGIN_ID)).tier)

// ---- A1/A4：只改非入口子模块 → reload ----
const st1 = await svc.status(PLUGIN_ID)
writeFileSync(SUB, subSrc(2), 'utf8')
const r1 = await svc.reload(PLUGIN_ID)
eq('5e reload 成功', r1.status, 'reloaded')
eq('5f 子模块改动已生效（缺陷②：V 1→2）', tree.nsOf(PLUGIN_ID).value, 2)
ok('5g moduleRev 随子模块变化（缺陷④）', r1.moduleRev !== st1.moduleRev, st1.moduleRev + ' → ' + r1.moduleRev)
ok('5h gen 前进且全局唯一', r1.gen > st1.gen, st1.gen + ' → ' + r1.gen)
ok('5i reload 的返回里能看到 sub.js（证据可查）',
  r1.files.some((f) => f.path.endsWith('sub.js')), r1.files.map((f) => f.path.split(/[\\/]/).pop()).join(','))
// A6：Phase0 预热 + Phase1 命中缓存 ⇒ 每代只求值一次
eq('5j 子模块未重复求值（Phase0 预热被 Phase1 复用）',
  tree.nsOf(PLUGIN_ID).subTick, subTickAfterLoad + 1)
eq('5k 入口也未重复求值', tree.nsOf(PLUGIN_ID).evalTick, evalTickAfterLoad + 1)
eq('5l reload 后树上恰好一个 entry（无重复注册）', Object.keys(tree.store).length, 1)

// ---- A3：注入链接错误 → 旧插件必须还在跑 ----
const before = { value: tree.nsOf(PLUGIN_ID).value, gen: (await svc.status(PLUGIN_ID)).gen }
writeFileSync(ENTRY, `import { NOPE } from './sub.js'\nexport function apply() {}\n`, 'utf8')
const e18 = await throwsCode('5m 链接错误 → HOTPLUG_LINK_INVALID',
  () => svc.reload(PLUGIN_ID), HotplugCode.HOTPLUG_LINK_INVALID)
ok('5n 旧插件仍在树上（对比 E18：现状会 loaded:false）', tree.has(PLUGIN_ID), true)
eq('5o 旧行为未被破坏', tree.nsOf(PLUGIN_ID).value, before.value)
const stAfterFail = await svc.status(PLUGIN_ID)
eq('5p 失败后代次已回退到原值（不留下"半新半旧"的 URL）', stAfterFail.gen, before.gen)
ok('5q 审计留有 link_invalid 记录', auditRecs.some((r) => r.event === 'hotplug.switch.link_invalid'), auditRecs.length)
ok('5r 错误信息点明"旧实例未受影响"', /旧实例未受影响/.test(e18.message), e18.message.slice(0, 40))

// ---- 修复代码后再 reload 应恢复正常 ----
writeFileSync(ENTRY, ENTRY_SRC, 'utf8')
const r2 = await svc.reload(PLUGIN_ID)
eq('5s 修好后再 reload 成功', r2.status, 'reloaded')
eq('5t 行为仍为新值', tree.nsOf(PLUGIN_ID).value, 2)

// rev 必须**依赖内容**（不是只看路径/代次）：改一个等长的子模块也要变，改回去要复原。
// 这条是"moduleRev 能当运行态证据"的根：否则 rev 变化可能只是代次抖动，无法证明跑的是新代码。
const revV2 = (await svc.status(PLUGIN_ID)).moduleRev
writeFileSync(SUB, subSrc(3), 'utf8')
const rr3 = await svc.reload(PLUGIN_ID)
writeFileSync(SUB, subSrc(2), 'utf8')
const rr4 = await svc.reload(PLUGIN_ID)
ok('5u moduleRev 依赖子模块内容（V=2 与 V=3 不同）', rr3.moduleRev !== revV2, revV2 + ' vs ' + rr3.moduleRev)
ok('5v 内容改回后 moduleRev 复原（确定性的）', rr4.moduleRev === revV2, revV2 + ' vs ' + rr4.moduleRev)

// ---- A5：apply 期失败 → Phase2 自愈 ----
console.log('\n=== [6] Phase2 自愈（apply 期失败回滚） ===')
const genBeforeP2 = (await svc.status(PLUGIN_ID)).gen
tree.failCreateTimes = 1
const rollbackErr = await throwsCode('6a apply 期失败 → HOTPLUG_ROLLBACK_OK',
  () => svc.reload(PLUGIN_ID), HotplugCode.HOTPLUG_ROLLBACK_OK)
ok('6b 回滚后插件仍在树上且可服务', tree.has(PLUGIN_ID) && tree.nsOf(PLUGIN_ID).value === 2,
  'has=' + tree.has(PLUGIN_ID) + ' value=' + (tree.nsOf(PLUGIN_ID) && tree.nsOf(PLUGIN_ID).value))
const stAfterP2 = await svc.status(PLUGIN_ID)
eq('6c 代次回退到回滚目标', stAfterP2.gen, genBeforeP2)
ok('6d 错误信息说明"服务未中断"', /服务未中断/.test(rollbackErr.message), rollbackErr.message.slice(0, 40))
ok('6e 审计留有 rollback.ok 记录', auditRecs.some((r) => r.event === 'hotplug.switch.rollback.ok'))
ok('6f 未误标 loaderUnstable', svc.mutex.isUnstable() === false)

// ---- 回滚也失败：树干净时不得全局熔断（真实宿主上踩到的爆炸半径问题）----
// 置 2 让连续两次 create 都失败（Phase 1 一次 + Phase 2 回滚一次）⇒ 触发 ROLLBACK_FAILED
tree.failCreateTimes = 2
let both = null
try { await svc.reload(PLUGIN_ID) } catch (e) { both = e }
ok('6g 两次都失败 → HOTPLUG_ROLLBACK_FAILED', both && both.code === HotplugCode.HOTPLUG_ROLLBACK_FAILED,
  both && both.code)
ok('6h 树干净 ⇒ 不全局熔断（其它插件不被连带封锁）',
  svc.mutex.isUnstable() === false && both && both.extra && both.extra.treeClean === true,
  'unstable=' + svc.mutex.isUnstable() + ' treeClean=' + (both && both.extra && both.extra.treeClean))
ok('6i 错误信息告知无需重启', both && /无需重启/.test(both.message), both && both.message.slice(0, 60))
const restored = await svc.reload(PLUGIN_ID)
eq('6j 双失败后仍可正常 reload（未被熔断封锁）', restored.status, 'reloaded')

// ---- 退让兜底：buster 非 L1 时明确拒绝 ----
console.log('\n=== [7] 退让兜底（buster 不可用） ===')
const stubBuster = {
  snapshot: () => ({ level: 'L3', mode: 'none', nodeVersion: '20.11.0', reason: '注入：本版本无钩子', checks: {} }),
  getGen: () => 0, bumpGen: async () => 1, setGen: async () => 0,
  setRoot: async () => true, removeRoot: async () => {}, moduleRev: async () => null, filesForGen: async () => [],
}
const svcL3 = new HotplugService({ manifest, buster: stubBuster, tree, ctx: null, audit, baseDir: dir })
const l3err = await throwsCode('7a buster 自检不过 → BUSTER_UNAVAILABLE',
  () => svcL3.reload(PLUGIN_ID), HotplugCode.BUSTER_UNAVAILABLE)
ok('7b 拒绝理由里带 Node 版本与自检原因（不静默失败）',
  /20\.11\.0/.test(l3err.message) && /注入/.test(l3err.message), l3err.message.slice(0, 60))
eq('7c 明确给出 fallback=host_restart', l3err.extra && l3err.extra.fallback, 'host_restart')

// ---- 门禁与白名单 ----
console.log('\n=== [8] 门禁与白名单 ===')
await throwsCode('8a 不在白名单 → NOT_WHITELISTED', () => svc.reload('nope'), HotplugCode.NOT_WHITELISTED)
await throwsCode('8b 不在白名单就 unload → 门禁先于状态判定',
  () => svc.unload('nope'), HotplugCode.NOT_WHITELISTED)
manifest.update(PLUGIN_ID, { enabled: false })
await throwsCode('8c 已禁用 → WHITELIST_DISABLED', () => svc.reload(PLUGIN_ID), HotplugCode.WHITELIST_DISABLED)
manifest.update(PLUGIN_ID, { enabled: true })
await throwsCode('8d load 已加载的 → ALREADY_LOADED', () => svc.load(PLUGIN_ID), HotplugCode.ALREADY_LOADED)

const addRes = await svc.whitelistAdd({ id: 'plug2', path: pluginPath })
eq('8e 白名单新增', addRes.status, 'added')
ok('8f 新增后 buster 里已有该根', buster.getRoot('plug2') !== null)
// 白名单内但未加载 → 真正的 NOT_LOADED（与 8b 的门禁拒绝区分开）
await throwsCode('8g 白名单内但未加载 → NOT_LOADED', () => svc.unload('plug2'), HotplugCode.NOT_LOADED)
const listBefore = (await svc.list()).length
const rmRes = await svc.whitelistRemove('plug2')
eq('8h 白名单移除', rmRes.status, 'removed')
eq('8i list 数量回落', (await svc.list()).length, listBefore - 1)
ok('8j 移除后 buster 根也清掉', buster.getRoot('plug2') === null)
await throwsCode('8k 重复新增 → DUPLICATE_ID',
  () => svc.whitelistAdd({ id: PLUGIN_ID, path: pluginPath }), HotplugCode.DUPLICATE_ID)

// ---- guarded 档在服务层的实际拦截（用真嵌套树，不做对象搬运） ----
console.log('\n=== [9] 档位在服务层的实际拦截 ===')
const guardedTree = new FakeTree({ group: true })
const guardedManifest = new FakeManifest([{ id: 'g', path: pluginPath, config: {}, enabled: true }])
const svcG = new HotplugService({ manifest: guardedManifest, buster, tree: guardedTree, ctx: null, audit, baseDir: dir })
await svcG.load('g')
eq('9a 条目落在复合层子树内 → guarded', (await svcG.status('g')).tier, Tier.GUARDED)
// A2b：guarded 与 free 同权，unload 必须被放行（2026-09-22 决策）
const gunload = await svcG.unload('g')
eq('9b guarded 档 unload 被放行且成功（A2b）', gunload.status, 'unloaded')
ok('9b2 卸下后条目确实已从复合层子树消失', guardedTree.has('g') === false)
ok('9b3 审计记录了 guarded 走安全网（档位仍是有用信号）',
  auditRecs.some((r) => r.event === 'hotplug.safety_net' && r.extra && r.extra.id === 'g'))
await svcG.load('g')
const greload = await svcG.reload('g')
eq('9c guarded 档 reload 被放行且成功', greload.status, 'reloaded')
eq('9d guarded reload 后无重复注册', Object.keys(guardedTree.store.include.subtree.store).length, 1)

// ---- 收尾 ----
try { rmSync(dir, { recursive: true, force: true }) } catch (_) {}

console.log('\n' + '='.repeat(64))
console.log('pass=' + pass + ' fail=' + fail)
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1) }
console.log('全部通过')
