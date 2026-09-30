// 网关级设置：持久化到 dataDir/settings.json。
// 当前承载：① “公开注册开关”（团队未开放前默认关闭，仅管理员可在后台打开）；
//           ② `wsOwnerStrict`（T-1.b 阶段② 的**运行时可翻转开关**，见下）。
import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  version: 1,
  allowPublicRegistration: false,
  // T-1.b：WS upgrade 遇到"会话无归属"时 —— false=放行并留痕（阶段①）；true=拒绝（阶段②）。
  // 🔴 做成**设置项**而不是硬编码，是为了满足"攒批窗口只重启一次"：
  //    部署时随代码一起上（值为 false = 阶段① 姿态），观察无误后**改这一项即生效、无需再重启**。
  //    前置：先跑完 T-1.d（`POST /api/sessions/migrate-legacy`）—— 否则现存无归属会话会集体 403。
  wsOwnerStrict: false,
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

export function createSettingsStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'settings.json')

  let settings = { ...DEFAULTS }
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    settings = { ...DEFAULTS }
  }
  if (!fs.existsSync(file)) {
    try { atomicWrite(file, settings) } catch { /* 落盘失败时保持内存默认值，不阻断启动 */ }
  }

  // 🔄 磁盘优先（2026-09-27）：**每次访问都重读磁盘**。为什么不用 mtime 缓存：
  //   ① 需求是"运维**直接编辑 settings.json** 立即生效"（否则改了文件没反应、只能重启）；
  //   ② `mtimeMs` 有**同 tick 不变**的坑（本仓 U-34 已实测过），用它做变更检测会**偶发漏更新**；
  //   ③ 这些开关**不在热路径**上（WS upgrade 每分钟个位数；管理页按需打开）⇒ 一次 `readFileSync` 的代价可忽略。
  // 文件暂不可读/坏 JSON ⇒ **保持内存值**（我们自己写入一律是原子的，正常不会读到半个文件）。
  function readDisk() {
    try {
      settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch { /* 保持内存值 */ }
    return settings
  }

  return {
    getAll() {
      return { ...readDisk() }
    },
    isPublicRegistrationAllowed() {
      return readDisk().allowPublicRegistration === true
    },
    /** T-1.b 阶段② 开关（仅显式 true 生效；缺失/非布尔一律按 false = 阶段① 姿态） */
    isWsOwnerStrict() {
      return readDisk().wsOwnerStrict === true
    },
    update(patch) {
      // 先重读再合并：避免用**陈旧内存**覆盖掉外部刚手改的值
      const next = { ...readDisk(), ...patch }
      settings = next
      atomicWrite(file, next)
      return { ...next }
    },
  }
}
