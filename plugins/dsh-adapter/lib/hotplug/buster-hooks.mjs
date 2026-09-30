// @local/dsh-adapter —— ModuleGraphBuster 的【独立 hooks 线程】实现
//
// 仅在 module.register(...) 模式下被加载（Node 20.6+ 的跨线程自定义钩子）。
// 同线程的 module.registerHooks(...) 模式不使用本文件——那条路径直接在 buster.js 里
// 传函数对象，闭包能看到活的内存表，无需端口同步。
//
// 两处跨线程数据同步（用同一个 MessagePort 通道）：
//   1. 根表 roots：主线程 setRoots 推送（代次靠它生效）
//   2. 已加载文件清单 filesByGen：主线程 queryFiles 拉取（算 moduleRev 用；load 钩子顺手记录）
// 显式 ping/pong 用于让主线程确认"根表已生效"，避免自检读到未同步的旧表 —— 这是
// "reload 报成功但行为没变"这类假成功在跨线程模式下的等价风险点。

import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { applyGen, isBustable, urlToFsPath, readGen } from './buster-core.js'

let port = null
let roots = []
// gen(string) -> Map(fsPath -> { path, mtimeMs, size, hash })
const filesByGen = new Map()
// 与主线程侧同口径的上限（代次全局单调，不裁剪会线性增长）
const MAX_GEN_BUCKETS = 16

export function initialize(data) {
  try {
    port = data && data.port ? data.port : null
    if (port) port.on('message', onMessage)
  } catch (_) { port = null }
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  try {
    if (msg.type === 'setRoots') {
      roots = Array.isArray(msg.roots) ? msg.roots : []
      reply({ type: 'rootsSet', reqId: msg.reqId })
      return
    }
    if (msg.type === 'queryFiles') {
      const rec = filesByGen.get(String(msg.gen))
      const files = rec ? Array.from(rec.values()) : []
      reply({ type: 'files', reqId: msg.reqId, files })
      return
    }
    if (msg.type === 'ping') reply({ type: 'pong', reqId: msg.reqId })
  } catch (_) { /* 钩子线程内绝不向外抛 */ }
}

function reply(m) {
  try { if (port) port.postMessage(m) } catch (_) {}
}

// 记录本代次实际读取过的文件（含内容 hash）——moduleRev 的证据来源。
// 内容 hash 而非仅 mtime/size：改一个字节长度相同的子模块也能被感知（缺陷②的验收 A1 依赖此点）。
function recordLoad(url) {
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
  let m = filesByGen.get(gen)
  if (!m) { m = new Map(); filesByGen.set(gen, m) }
  m.set(p, meta)
  const excess = filesByGen.size - MAX_GEN_BUCKETS
  if (excess > 0) {
    let i = 0
    for (const k of filesByGen.keys()) {
      if (i++ >= excess) break
      filesByGen.delete(k)
    }
  }
}

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context)
  try {
    const u = applyGen(r.url, roots)
    if (u !== r.url) return { ...r, url: u, shortCircuit: true }
  } catch (_) { /* 失败即原样放行，绝不让钩子本身成为加载失败源 */ }
  return r
}

export async function load(url, context, nextLoad) {
  try { recordLoad(url) } catch (_) {}
  return nextLoad(url, context)
}
