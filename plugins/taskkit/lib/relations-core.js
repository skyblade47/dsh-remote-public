// taskkit · relations 组的**纯逻辑**（U-7 / T1b，2026-09-28）。
//
// 为什么单独成模块：lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'（本机不存在、import 即 MODULE_NOT_FOUND），
// 其逻辑本地不可能真实运行。故把 relations 路由里**可判定的纯逻辑**收敛到这里 ——
// 零 import、零副作用、纯函数 ⇒ 可被本地 `node --test` 真跑；index.js 只做
// 「读路由参数 → 调本模块 → 读/写盘 → 回 JSON」的薄接线。
//
// 🔴 红线：既有 list / update 的**行为与响应形状一字不改**（外部客户端在直接读 /taskkit/api/relations/list）。
//   本模块只承载 T1b 新增的 delete 动作，以及 404 的 actions 清单真源。

// relations 组已知 action —— 404 的 actions 字段与分支判定共用同一真源，避免两处漂移。
export const RELATIONS_ACTIONS = ['list', 'update', 'delete']

/**
 * 入参 draft 归一：必填、去首尾空白后非空。
 * 缺失 / null / 空串 / 全空白 / 非字符串可表示值 ⇒ 400。
 * @param {unknown} v
 * @returns {{ok:true, draft:string} | {ok:false, error:string}}
 */
export function normalizeDraftArg(v) {
  const draft = (v === undefined || v === null) ? '' : String(v).trim()
  if (!draft) return { ok: false, error: '缺少 draft' }
  return { ok: true, draft: draft }
}

/**
 * 删除语义（**幂等**）：从 relations 表里移除该键。
 *   - 键存在 ⇒ `{ removed: true, relations: 删键后的新表 }`（调用方据此落盘）
 *   - 键不存在 ⇒ `{ removed: false, relations: 原表副本 }`，**不报错**
 * 不改入参：返回**新的**表（入参非法/非对象时按空表处理）。
 * @param {unknown} relationsTable
 * @param {string} draft
 * @returns {{relations:object, removed:boolean}}
 */
export function deleteRelation(relationsTable, draft) {
  const src = (relationsTable && typeof relationsTable === 'object' && !Array.isArray(relationsTable))
    ? relationsTable
    : {}
  const removed = Object.prototype.hasOwnProperty.call(src, draft)
  const next = Object.assign({}, src)
  if (removed) delete next[draft]
  return { relations: next, removed: removed }
}
