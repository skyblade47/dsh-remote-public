// @local/dsh-adapter —— Phase 0：link-validate（原子 reload 的第一阶段）
//
// 缺陷③（reload 失败 = 把插件卸载掉，而非回滚）的修复第一步。
// 现状流程是 remove old → create new：第二步失败时第一步已经执行 ⇒ 插件没了（E18 现场：
// 入口新增一个非入口模块的导出 ⇒ ESM 链接失败 ⇒ loaded:false / LOAD_FAILED）。
// 本模块把"新代次能不能链接并求值"提到**移除之前**判定：
//   · 失败 ⇒ 直接抛错，旧实例一个字节都没动
//   · 成功 ⇒ 顺带把新代次模块图预热进 moduleMap，Phase 1 的 create 命中同一代次缓存，
//           因此不会重复求值（插件的模块顶层副作用只发生一次）

import { HotplugError, HotplugCode } from './errors.js'

const _msg = (e) => String((e && e.message) || e)

/**
 * @param {object} p
 * @param {string} p.id          插件 id（仅用于错误与审计）
 * @param {string} p.entryUrl    入口的 file URL（见 plugin-path.resolveEntryFileUrl）
 * @param {object} p.buster      ModuleGraphBuster（取 moduleRev / 已加载文件清单）
 * @param {number} p.gen         本次校验使用的代次（必须是刚 bumpGen 出来的新号）
 * @param {string[]} [p.expectExports] 期望存在的导出名（可选，按需收窄）
 * @returns {Promise<{ok:true,id:string,gen:number,entryUrl:string,exports:string[],moduleRev:string|null,files:Array,durationMs:number}>}
 */
export async function linkValidate({ id, entryUrl, buster, gen, expectExports }) {
  const started = Date.now()

  if (!entryUrl) {
    throw new HotplugError(HotplugCode.HOTPLUG_LINK_INVALID,
      `无法解析入口文件 URL（旧实例未受影响）: ${id}`,
      { extra: { id, gen, stage: 'resolve-entry' } })
  }

  let ns
  try {
    ns = await import(entryUrl)
  } catch (e) {
    throw new HotplugError(HotplugCode.HOTPLUG_LINK_INVALID,
      `新代次模块链接/求值失败（旧实例未受影响）: ${_msg(e)}`,
      { cause: e, extra: { id, gen, entryUrl, stage: 'import', error: _msg(e) } })
  }

  // 导出形状：与 sandbox preflight 的静态检查同口径，但这里是**真实模块**的判定
  const hasApply = typeof ns.apply === 'function'
  const hasDefault = ns.default !== undefined &&
    (typeof ns.default === 'function' || (ns.default !== null && typeof ns.default === 'object'))
  if (!hasApply && !hasDefault) {
    throw new HotplugError(HotplugCode.HOTPLUG_LINK_INVALID,
      `入口无 apply/default 导出（旧实例未受影响）: ${entryUrl}`,
      { extra: { id, gen, entryUrl, stage: 'export-shape', exports: Object.keys(ns) } })
  }

  if (Array.isArray(expectExports) && expectExports.length) {
    const missing = expectExports.filter((n) => !(n in ns))
    if (missing.length) {
      throw new HotplugError(HotplugCode.HOTPLUG_LINK_INVALID,
        `入口缺少预期导出: ${missing.join(', ')}（旧实例未受影响）`,
        { extra: { id, gen, entryUrl, stage: 'expect-exports', missing } })
    }
  }

  let moduleRev = null
  let files = []
  try { moduleRev = await buster.moduleRev(gen) } catch (_) { moduleRev = null }
  try { files = await buster.filesForGen(gen) } catch (_) { files = [] }

  return {
    ok: true, id, gen, entryUrl,
    exports: Object.keys(ns),
    moduleRev,
    files,
    durationMs: Date.now() - started,
  }
}
