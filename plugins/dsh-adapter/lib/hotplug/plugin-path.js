// @local/dsh-adapter —— 插件路径解析（loader name 与 bust 根目录）
//
// 本文件承担 spec §1.4 的关键解耦：
//   · resolveEntryName()  → 交给 cordis loader 的 name，**永远是稳定标识**
//     （包名原样 / file: 解析到主文件 URL），**绝不带 ?v= 之类的 bust 参数**。
//     理由：ClientModuleRegistry 要靠它 require.resolve(pkg/package.json) 生成 UI graph row；
//     一旦 name 带上 query，graph row 就丢，这正是现状要手写 _restoreClientGraph 补丁的根因。
//   · resolvePluginRoot() → 给 ModuleGraphBuster 用的"可 bust 根目录"，
//     缓存破除改由模块解析层完成，与 loader name 彻底无关。

import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { statSync, existsSync, readFileSync } from 'node:fs'

// 用 adapter 自身位置解析包名（与 sandbox 的 _require 口径一致）；
// 也允许调用方传 baseDir 覆盖，便于单测与非常规装配。
function requireFrom(baseDir) {
  if (baseDir) {
    try { return createRequire(pathToFileURL(join(baseDir, '__resolve__.js')).href) } catch (_) {}
  }
  return createRequire(import.meta.url)
}

/**
 * pluginPath → 文件系统路径
 * 支持：file: URL、npm 包名（@local/xxx）、普通相对/绝对路径
 */
export function fsPathOf(pluginPath, { baseDir } = {}) {
  if (!pluginPath || typeof pluginPath !== 'string') return null
  if (pluginPath.startsWith('file:')) {
    try { return fileURLToPath(pluginPath) } catch (_) { return null }
  }
  const req = requireFrom(baseDir)
  // 优先 package.json：先拿到 **package.json 文件**，再取 dirname 得到**包根目录**。
  // ⚠️ 这里必须 dirname：解析出来的是文件路径，不是目录。
  //    漏掉它会让 resolveEntryFileUrl 把 package.json 当成入口文件（下游 preflight/linkValidate 全错）。
  //    注：自家插件的 exports 里显式导出了 "./package.json"，所以这句 req.resolve 一定会成功 ——
  //    也就是说"包名/绝对目录"这条输入形态**必然**命中这个分支，不是边缘情况。
  try { return dirname(req.resolve(pluginPath + '/package.json')) } catch (_) {}
  try { return req.resolve(pluginPath) } catch (_) {}
  return null
}

// 读 package.json 的 main（读不到就沿用 cordis 约定默认值）
function mainOf(dir) {
  const pkgPath = join(dir, 'package.json')
  let main = 'lib/index.js'
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg && typeof pkg.main === 'string' && pkg.main) main = pkg.main
    } catch (_) { /* 保持默认 */ }
  }
  return main
}

/**
 * 可 bust 根目录（ModuleGraphBuster 的前缀匹配基准）
 * @returns {{ rootPath: string, rootUrl: string }|null}
 */
export function resolvePluginRoot(pluginPath, { baseDir } = {}) {
  const p = fsPathOf(pluginPath, { baseDir })
  if (!p) return null
  let st
  try { st = statSync(p) } catch (_) { return null }
  const rootPath = st.isDirectory() ? p : dirname(p)
  return { rootPath, rootUrl: pathToFileURL(rootPath).href }
}

/**
 * 交给 cordis loader 的 name：稳定标识，**绝不带 bust 参数**。
 *   - 包名：原样返回（让 loader / ClientModuleRegistry 走标准解析）
 *   - file: 目录：解析到 <dir>/<main> 的 file URL
 *   - file: 文件：原样返回
 *   - 其它（含**绝对目录路径**）：**明确报错**。
 *     理由：绝对目录会被 loader 直接 import，而 ESM 不支持目录导入
 *     （实测报 `Directory import ... is not supported`）。静默放行等于把故障推到很远的地方。
 *     契约：白名单的 path 必须是**可从 profile 解析的包名**（或 file: URL）。
 */
export function resolveEntryName(pluginPath, { baseDir } = {}) {
  if (!pluginPath || typeof pluginPath !== 'string') return pluginPath
  if (!pluginPath.startsWith('file:')) {
    if (pluginPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pluginPath)) {
      throw new Error(
        `白名单 path 不应是文件系统路径（收到: ${pluginPath}）。` +
        `请改写成可从 profile 解析的包名（如 @local/writing-coach），` +
        `或 file: URL；绝对目录会被 loader 直接 import，而 ESM 不支持目录导入。`,
      )
    }
    return pluginPath
  }
  const p = fsPathOf(pluginPath, { baseDir })
  if (!p) return pluginPath
  let st
  try { st = statSync(p) } catch (_) { return pluginPath }
  if (!st.isDirectory()) return pathToFileURL(p).href
  return pathToFileURL(join(p, mainOf(p))).href
}

/**
 * 入口的**具体 file URL**（包名也解析到主文件）。
 * 与 resolveEntryName 的分工：
 *   · resolveEntryName     → 交给 cordis loader 的稳定标识（包名原样），负责 UI graph
 *   · resolveEntryFileUrl  → 交给 link-validate 去真正 import 的 URL，负责链接校验
 * 二者指向同一文件；validate 阶段按新代次 import 会把它预热进 moduleMap，
 * 之后 loader 用稳定包名 import 时命中的正是同一代次的缓存条目 —— 因此**不会重复求值**，
 * 插件的模块顶层副作用只会发生一次（这是 Phase 0 敢在旧实例还活着时预加载的前提）。
 */
export function resolveEntryFileUrl(pluginPath, { baseDir } = {}) {
  if (!pluginPath || typeof pluginPath !== 'string') return null
  const p = fsPathOf(pluginPath, { baseDir })
  if (!p) return null
  let st
  try { st = statSync(p) } catch (_) { return null }
  if (!st.isDirectory()) return pathToFileURL(p).href
  const main = join(p, mainOf(p))
  if (!existsSync(main)) return null
  return pathToFileURL(main).href
}

export { fileURLToPath }