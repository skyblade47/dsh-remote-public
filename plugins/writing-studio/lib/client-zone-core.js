// U-41 / P3 前置（2026-09-29）：**客户端区读写通道**的纯逻辑（零宿主依赖 ⇒ 本地 node --test 真跑）。
//
// 契约权威：docs/superpowers/plans/2026-09-29-client-zone-and-shared-progress-design.md **§2.5**
// 背景：客户端**只能经 HTTP 访问服务器**（不是文件系统）⇒ §2.3 的「在 客户端区/ 内任意读写」必须由端点族承载。
//   本模块只做「路径归一 + 覆盖决策 + 回收路径」，IO 由 lib/index.js 薄接线。
//
// 🔴 红线：
//   ① 只允许落在 `客户端区/` 的**允许子域**（正文 / 进度 / 回收）内；不得越出、不得点开头段；
//   ② 覆盖语义**复用** draft-save 的既有闸（不另立第二套）；
//   ③ 删除是**软删**（移到 `回收/<原路径>`），不是真删。

import { CLIENT_ZONE_REL, CLIENT_BODY_REL, CLIENT_PROGRESS_REL, CLIENT_RECYCLE_REL } from './submit-core.js'
import { decideWrite, versionOf, SIZE_LIMIT } from './draft-save-core.js'

/** 端点族名真源（404 的 actions 与分支判定共用）。 */
export const CZ_ACTIONS = ['clientZoneSave', 'clientZoneList', 'clientZoneRead', 'clientZoneDelete']

/** 允许的子域（第一段必须命中其一）—— 与 §2.1 的区域划分一致。 */
export const CZ_ALLOWED_SUBDIRS = ['正文', '进度', '回收']

/** 子域 → 后缀要求（`正文` 只收 .md；`进度` 只收 .json；`回收` 不限，因为它是原件的镜像）。 */
export const CZ_SUBDIR_EXT = { '正文': '.md', '进度': '.json' }

const BAD_CHARS = /[\\]|[\u0000-\u001f\u007f]/

/**
 * 归一「相对 `客户端区/`」的路径。
 * 规则：非空 · 不得以 `/` 开头 · 不得含 `\` 与控制字符 · 段不得为空 / `.` / `..` / **点开头**
 *      · 第一段必须是允许子域 · 按子域校验后缀。
 * @param {unknown} relPath
 * @returns {{ok:true, rel:string, wsRel:string, sub:string} | {ok:false, code:string, message:string}}
 */
export function normalizeClientZonePath(relPath) {
  const raw = (relPath === undefined || relPath === null) ? '' : String(relPath).trim()
  if (!raw) return { ok: false, code: 'BAD_PATH', message: '缺少 relPath（相对 客户端区/ 的路径）' }
  const p = raw.replace(/\/{2,}/g, '/')
  if (p.charAt(0) === '/') return { ok: false, code: 'BAD_PATH', message: 'relPath 不得以 / 开头（它是相对 客户端区/ 的路径）' }
  if (/^[A-Za-z]:/.test(p)) return { ok: false, code: 'BAD_PATH', message: 'relPath 不得是绝对路径' }
  if (BAD_CHARS.test(p)) return { ok: false, code: 'BAD_PATH', message: 'relPath 不得含 \\ 或控制字符' }
  if (p.indexOf(CLIENT_ZONE_REL + '/') === 0) return { ok: false, code: 'BAD_PATH', message: 'relPath 应相对 客户端区/（不要带 客户端区/ 前缀）' }
  const segs = p.split('/').filter(function (s) { return s !== '' })
  if (!segs.length) return { ok: false, code: 'BAD_PATH', message: 'relPath 为空' }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s === '.' || s === '..') return { ok: false, code: 'BAD_PATH', message: 'relPath 不得含 . 或 .. 段' }
    if (s.charAt(0) === '.') return { ok: false, code: 'BAD_PATH', message: 'relPath 段不得以点开头: ' + s }
  }
  const sub = segs[0]
  if (CZ_ALLOWED_SUBDIRS.indexOf(sub) < 0) {
    return { ok: false, code: 'BAD_SUBDIR', message: 'relPath 第一段必须是 ' + CZ_ALLOWED_SUBDIRS.join(' / ') + '：' + sub }
  }
  if (segs.length < 2) return { ok: false, code: 'BAD_PATH', message: 'relPath 必须指向 ' + sub + '/ 下的具体文件' }
  const wantExt = CZ_SUBDIR_EXT[sub]
  if (wantExt && !new RegExp(wantExt.replace('.', '\\.') + '$', 'i').test(segs[segs.length - 1])) {
    return { ok: false, code: 'BAD_PATH', message: sub + '/ 下只接受 ' + wantExt + ' 文件' }
  }
  if (segs.length > 6) return { ok: false, code: 'BAD_PATH', message: 'relPath 层数过深' }
  const rel = segs.join('/')
  return { ok: true, rel: rel, wsRel: CLIENT_ZONE_REL + '/' + rel, sub: sub }
}

/** 软删的落点：`回收/<原路径>`（相对 `客户端区/`）。 */
export function recycleRelOf(rel) {
  const segs = String(rel === undefined || rel === null ? '' : rel).split('/').filter(function (s) { return s !== '' })
  return '回收/' + segs.join('/')
}

/** 覆盖决策（**不另立口径**，直接转发 draft-save 的既有闸）。 */
export function decideClientZoneWrite(input) { return decideWrite(input) }

/** 内容版本串（同 draft-save / C11 的 `versionOf`）。 */
export function czVersion(content) { return versionOf(content) }

/** 体积上限（同 draft-save 的 2 MiB）。 */
export const CZ_SIZE_LIMIT = SIZE_LIMIT

/** 允许列目录的前缀（相对 `客户端区/`）—— 空串 = 整个客户端区；否则必须是允许子域或其子路径。 */
export function normalizeClientZonePrefix(prefix) {
  const raw = (prefix === undefined || prefix === null) ? '' : String(prefix).trim()
  if (!raw) return { ok: true, prefix: '' }
  const segs = raw.replace(/\/{2,}/g, '/').replace(/\/$/, '').split('/').filter(function (s) { return s !== '' })
  if (segs.length && CZ_ALLOWED_SUBDIRS.indexOf(segs[0]) < 0) {
    return { ok: false, code: 'BAD_SUBDIR', message: 'prefix 第一段必须是 ' + CZ_ALLOWED_SUBDIRS.join(' / ') }
  }
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === '.' || segs[i] === '..' || segs[i].charAt(0) === '.') {
      return { ok: false, code: 'BAD_PATH', message: 'prefix 含非法段: ' + segs[i] }
    }
  }
  return { ok: true, prefix: segs.join('/') }
}

/** 供参考：三个子域的常量（与 §2.1 一致）。 */
export const CZ_SUBDIR_RELS = { 正文: CLIENT_BODY_REL, 进度: CLIENT_PROGRESS_REL, 回收: CLIENT_RECYCLE_REL }
