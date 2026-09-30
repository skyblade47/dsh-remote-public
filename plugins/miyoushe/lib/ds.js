// @local/miyoushe —— DS 签名（设计 §3.1 算法规格；本文件为 offline-core-1 切片）
//
// 规格（逐字对齐《米游社签到插件_设计方案.md》§3.1，行号见证据文件）：
//   - 输入：salt（字符串）、t（Unix 秒）、r（6 位随机字母数字）
//   - 拼接：`salt={salt}&t={t}&r={r}`
//   - 摘要：md5(拼接串, UTF-8) 取 32 位小写 hex
//   - 交付：请求头 DS = "{t},{r},{md5}"（三段逗号分隔）
//   前置断言：salt 非空字符串；t 为正整数；/^[A-Za-z0-9]{6}$/.test(r)
//   失败：抛 DS_BAD_SALT / DS_BAD_R（调用方据此报 SALT_INVALID，不静默降级）
//
// 纪律：
//  1) 本模块**零 IO、零网络、零状态**——纯函数，可在单测里直接复现 §3.3 三条向量。
//  2) **不**在此文件写任何真实盐值（盐属签名密钥材料；测试向量里的 V3 是显式声明的"纯测试盐"）。
//  3) 版本号与盐的配对约束（§3.1 成对约束 / §3.5.4 硬约束）由调用方保证：本函数只接受"一条记录
//     解出的 salt"，**不得**为它临时拼一个别的版本头。

import { createHash, randomInt } from 'node:crypto'

/** 错误码（§3.1 只给了两个；t 的断言无码，此处补 DS_BAD_T 并已登记进证据文件） */
export const DS_ERR = Object.freeze({
  BAD_SALT: 'DS_BAD_SALT',
  BAD_R: 'DS_BAD_R',
  BAD_T: 'DS_BAD_T',
})

/** /^[A-Za-z0-9]{6}$/（§3.1 前置断言的 r 形状） */
export const R_PATTERN = /^[A-Za-z0-9]{6}$/

export class DsError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'DsError'
    this.code = code
    this.detail = detail === undefined ? null : detail
  }
}

/** 当前 Unix 秒（正整数） */
export function nowSec() {
  return Math.floor(Date.now() / 1000)
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 6 位随机字母数字（§3.1 的 r）。
 * 用 node:crypto.randomInt（CSPRNG）而非 Math.random；允许注入 rand 以便单测复现。
 */
export function randAlnum(n = 6, rand) {
  const len = Number.isInteger(n) && n > 0 ? n : 6
  const pick = typeof rand === 'function' ? rand : (max) => randomInt(max)
  let out = ''
  for (let i = 0; i < len; i++) out += ALNUM[pick(ALNUM.length)]
  return out
}

/** 拼接串（§3.1；独立导出便于单测/日志核对，注意它含盐明文，**不得**进日志或返回值） */
export function dsPayload(salt, t, r) {
  return 'salt=' + salt + '&t=' + t + '&r=' + r
}

/** md5(UTF-8) → 32 位小写 hex */
export function md5Hex(text) {
  return createHash('md5').update(String(text), 'utf8').digest('hex')
}

/**
 * signDs(salt, t = nowSec(), r = randAlnum(6)) -> { ds, t, r, md5 }
 * 返回值键集合与 §3.1 的函数规格**逐字一致**（不多给 payload，避免盐明文随返回值扩散）。
 */
export function signDs(salt, t = nowSec(), r = randAlnum(6)) {
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new DsError(DS_ERR.BAD_SALT, 'salt 必须是非空字符串（§3.1 前置断言）', { type: typeof salt })
  }
  if (!Number.isInteger(t) || t <= 0) {
    throw new DsError(DS_ERR.BAD_T, 't 必须是正整数 Unix 秒（§3.1 前置断言）', { t })
  }
  if (typeof r !== 'string' || !R_PATTERN.test(r)) {
    throw new DsError(DS_ERR.BAD_R, 'r 必须是 6 位字母数字 /^[A-Za-z0-9]{6}$/（§3.1 前置断言）', { r })
  }
  const md5 = md5Hex(dsPayload(salt, t, r))
  return { ds: t + ',' + r + ',' + md5, t, r, md5 }
}
