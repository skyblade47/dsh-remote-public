// writing-studio · U-7 / T1a（2026-09-28）：relations 读写**改走 taskkit** 之后的**纯逻辑层**。
//
// 为什么单独成模块：lib/index.js 依赖宿主包 '@deepseek-ai/dsh-tools'（本机不存在、无法 import），
// 其逻辑本地不可能真实运行。故把「taskkit 响应 → 本插件对外形状」的适配、失败判定、
// attach 参数映射等**可判定的纯逻辑**收敛到这里 —— 零 import、零副作用、纯函数 ⇒ 本地 `node --test` 真跑；
// index.js 只做「HTTP 调 taskkit → 调本模块归一 → 回 JSON」的薄接线。
//
// 🔴 契约：本插件对外的 6 个 relations 端点（overview/byInsp/byDraft/byDate/attach/detach）的
//   URL、请求参数、响应 JSON 形状**全部保持不变**；变的是数据来源（自持 写作训练/relations.json → taskkit 权威表）。

// taskkit relations 组的三个动作端点（T1b 前只有 list/update；delete 由 T1b 补）。
export const TASKKIT_RELATIONS_LIST = '/taskkit/api/relations/list'
export const TASKKIT_RELATIONS_UPDATE = '/taskkit/api/relations/update'
export const TASKKIT_RELATIONS_DELETE = '/taskkit/api/relations/delete'

// 内部调用方与前端一直依赖的 relations 文档形状：{ version: 1, relations: {...} }。
export const RELATIONS_DOC_VERSION = 1

/**
 * 失败判定：adapterHttp.post 的返回形如 { status, ok, data, error }（throwOnError:false）。
 * ok 为 true 才算成功；否则给出**可读的失败原因**（供如实回 500，不静默兜底成空表）。
 * @param {{ok?:boolean, status?:number, error?:string}|null|undefined} resp
 * @param {string} action list|update|delete
 * @returns {string|null} 失败原因；null = 成功
 */
export function responseFailed(resp, action) {
  if (resp && resp.ok === true) return null
  const detail = (resp && resp.error)
    ? String(resp.error)
    : ((resp && resp.status) ? ('HTTP ' + resp.status) : 'taskkit 不可达')
  return 'taskkit relations/' + action + ' 失败: ' + detail
}

/**
 * list 响应 → 本插件对外形状 `{ version: 1, relations }`。
 * taskkit 端 `relations` 缺失/非法 ⇒ 按**空表**处理（权威表为空是合法状态，不是错误）。
 * @param {{data?:{relations?:unknown}}|null|undefined} listResp
 * @returns {{version:number, relations:object}}
 */
export function adaptRelationsDoc(listResp) {
  const rels = listResp && listResp.data && listResp.data.relations
  const relations = (rels && typeof rels === 'object' && !Array.isArray(rels)) ? rels : {}
  return { version: RELATIONS_DOC_VERSION, relations: relations }
}

/**
 * attach 的参数映射：本插件内部 rel（含 `date` 等自持键）→ taskkit update 的 payload。
 * 🔴 taskkit 的 update 只落 `{type, refInspId, refResourceId, note}`（其行为一字不改）⇒
 *    `date` 等表外键**不下发**（下发了也会被 taskkit 丢弃或改写形状）。
 * @param {string} draft
 * @param {object} rel
 * @returns {{draft:string, type:unknown, refInspId:unknown, refResourceId:unknown, note:unknown}}
 */
export function buildAttachPayload(draft, rel) {
  const r = rel || {}
  return {
    draft: draft,
    type: r.type,
    refInspId: r.refInspId,
    refResourceId: r.refResourceId,
    note: r.note
  }
}
