// 审计日志：append-only JSONL，写入 $DSH_HOME/logs/auth-audit.jsonl
// 记录：登录成功/失败/封禁、Token 签发/吊销、越权拒绝、账号审批、客户端证书被拒等
//
// **按大小轮转**（S4）：原来只 append 不轮转，长期运行会无限增长；而且它是
// "被封禁 / 被扫描时会加速"的那种增长（每条被拒的请求都要记一笔）。
//
// 轮转是**安全**的，因为网关是这份文件的唯一写入者（单进程）：
// 不存在 dsh-adapter 那套"跨进程写同一个 jsonl"的窗口问题，rename 不会被别的写者踩到。
//
// 磁盘上界 = (keep + 1) × maxBytes。默认 6 × 8MB = 48 MB，封顶且可预期。
//
// ⚠️ 与"日志退役插件"决策的关系（2026-09-23 我们否掉了那个插件）：
//    那次否掉的是"给自研日志做一套可插拔的退役系统"，理由是数据量根本不需要。
//    这里不同 —— 这是**给单个已知文件加一个有界上限**，几行代码，不需要新插件。
//    另外这里是**删除**旧归档，而不是像当时建议的"压缩保留"：
//    审计日志的语义是"近期可查"，8MB ≈ 4 万条，保留 5 份已经远超实际需要。
import fs from 'node:fs'
import path from 'node:path'

export function createAuditLog(logDir, { maxBytes = 8 * 1024 * 1024, keep = 5 } = {}) {
  fs.mkdirSync(logDir, { recursive: true })
  const file = path.join(logDir, 'auth-audit.jsonl')
  const base = path.basename(file) + '.'

  function pruneArchives() {
    let names = []
    try {
      // ISO 时间戳里把 ':' 和 '.' 换成 '-'，字典序即时间序，直接排序即可
      names = fs.readdirSync(logDir).filter((n) => n.startsWith(base)).sort()
    } catch {
      return
    }
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      try {
        fs.unlinkSync(path.join(logDir, name))
      } catch {
        // 删不掉（权限/并发）不该影响写审计本身
      }
    }
  }

  // 归档文件名取"空位"：时间戳精度只有毫秒，**同一毫秒内连续轮转多次会撞名**，
  // 而 renameSync 到已存在的路径是**覆盖** ⇒ 会直接丢一整个归档。
  // 生产上 8MB 一次的轮转撞不上，但一旦把 maxBytes 调小（或将来改成按事件数轮转）就会踩到 ——
  // 这是写单测时抓出来的真 bug，不是假想。
  function uniqueArchivePath(stamp) {
    let candidate = `${file}.${stamp}`
    let n = 1
    while (fs.existsSync(candidate)) {
      candidate = `${file}.${stamp}-${n}`
      n += 1
    }
    return candidate
  }

  function rotateIfNeeded() {
    let size
    try {
      size = fs.statSync(file).size
    } catch {
      return // 文件还不存在，无需轮转
    }
    if (size < maxBytes) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      fs.renameSync(file, uniqueArchivePath(stamp))
    } catch {
      return // rename 失败就继续往原文件写，宁可文件大一点也不丢审计
    }
    pruneArchives()
  }

  return {
    log(event, data = {}) {
      rotateIfNeeded()
      const entry = {
        ts: Date.now(),
        event,
        ...data,
      }
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8')
    },
    file,
    // 供测试与排障：列出当前归档
    archives() {
      try {
        return fs.readdirSync(logDir).filter((n) => n.startsWith(base)).sort()
      } catch {
        return []
      }
    },
  }
}
