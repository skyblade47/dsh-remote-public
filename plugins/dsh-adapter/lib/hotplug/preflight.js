// @local/dsh-adapter —— 热替前置体检
//
// 从 sandbox/lib/preflight.js 迁移（删掉与本设计无关的分支，改为 HotplugError）。
// 保留那些"为真实故障加过"的检查，尤其 OneDrive 云占位符：占位符文件只有几字节 BOM，
// 直接 import 会得到诡异的解析错误，而报错现场离真因很远。
//
// 与 link-validate 的分工：
//   preflight     —— 文件系统层面（存在性 / 结构 / 占位符），**不需要 import**
//   linkValidate  —— 模块层面（能否链接与求值、导出形状），按新代次真实 import

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HotplugError, HotplugCode } from './errors.js'
import { fsPathOf } from './plugin-path.js'

const _msg = (e) => String((e && e.message) || e)

const _fail = (message, extra) => new HotplugError(HotplugCode.INVALID_PATH, message, { extra })

// OneDrive / 云盘占位符：只有 BOM 或极短内容 ⇒ 磁盘上"存在"但内容不在本地
function isPlaceholderBytes(bytes) {
  if (!bytes) return true
  if (bytes.length === 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return true
  if (bytes.length <= 4) return true
  return false
}

function readOrFail(p, what) {
  let bytes
  try { bytes = readFileSync(p) } catch (e) { throw _fail(`无法读取${what}: ${p} — ${_msg(e)}`, { path: p }) }
  if (isPlaceholderBytes(bytes)) {
    throw _fail(`${what}疑似云盘占位符（${bytes.length} 字节），请先下载到本地再热替: ${p}`, { path: p, size: bytes.length })
  }
  return bytes
}

function mainFileOf(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    const fallback = join(dir, 'lib/index.js')
    if (existsSync(fallback)) return fallback
    throw _fail(`目录插件既无 package.json 也无默认 lib/index.js: ${dir}`, { dir })
  }
  const raw = readOrFail(pkgPath, 'package.json')
  let pkg = null
  try { pkg = JSON.parse(raw.toString('utf8')) } catch (_) { /* 下面统一兜底 */ }
  const mainRel = (pkg && typeof pkg.main === 'string' && pkg.main) ? pkg.main : 'lib/index.js'
  const main = join(dir, mainRel)
  if (!existsSync(main)) {
    const fallback = join(dir, 'lib/index.js')
    if (existsSync(fallback)) return fallback
    throw _fail(`main 文件不存在: ${main}`, { dir, main })
  }
  return main
}

/**
 * @param {{id?:string, path:string, baseDir?:string}} entry
 * @returns {Promise<{ok:true, fsPath:string, mainPath:string|null, kind:'file'|'dir'}>}
 */
export async function preflight(entry) {
  const { id, path: pluginPath } = entry || {}
  if (!pluginPath) throw _fail('path 为空', { id })

  const fsPath = fsPathOf(pluginPath, { baseDir: entry.baseDir })
  if (!fsPath) throw _fail(`无法解析插件路径（既非 file: 也不是可解析的包名）: ${pluginPath}`, { id, path: pluginPath })
  if (!existsSync(fsPath)) throw _fail(`路径不存在: ${fsPath}`, { id, path: fsPath })

  let st
  try { st = statSync(fsPath) } catch (e) { throw _fail(`无法 stat 路径: ${_msg(e)}`, { id, path: fsPath }) }

  if (st.isDirectory()) {
    const mainPath = mainFileOf(fsPath)
    // 只做文件系统层检查：存在性 + 非云盘占位符（readOrFail）。
    // ⚠️ 这里**不再**做"前 1KB 含 export"的形状启发式：模块形状归 linkValidate（真实 import 后判定），
    //    那条启发式是它的更弱重复实现，且会误杀注释头较长的合法插件
    //    （本仓 memory-system / dsh-adapter 的入口都是这样）。
    readOrFail(mainPath, '入口文件')
    return { ok: true, fsPath, mainPath, kind: 'dir' }
  }

  // 非目录：直接当文件入口，同样只做文件系统层检查
  readOrFail(fsPath, '插件文件')
  return { ok: true, fsPath, mainPath: fsPath, kind: 'file' }
}
