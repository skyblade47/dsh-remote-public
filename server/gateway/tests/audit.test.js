import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAuditLog } from '../src/audit.js'

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'))
}

test('审计：append-only 写 JSONL，每行一条', () => {
  const dir = makeDir()
  const audit = createAuditLog(dir)
  audit.log('a.one', { x: 1 })
  audit.log('a.two', { y: 2 })
  const lines = fs.readFileSync(audit.file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.event, 'a.one')
  assert.equal(first.x, 1)
  assert.ok(first.ts, '每条都要带时间戳')
  assert.equal(JSON.parse(lines[1]).event, 'a.two')
})

// ---- S4：按大小轮转 ----
//
// 原来只 append 不轮转，长期运行会无限增长；而且它属于"被封禁/被扫描时会加速"的增长。
// 这一组锁住"有上限、旧归档会清、且轮转过程不丢审计"。

test('S4：超过大小上限时轮转，且更早的条目完整保留在归档里', () => {
  const dir = makeDir()
  // keep 刻意放大到 50：本用例只验"轮转本身不丢数据"。
  // 保留清理会**故意**删掉最老的归档（那是 keep 该干的事），
  // 所以若 keep 太小，这条会变成在验证"清理生效"，而不是验证"轮转无损" —— 两回事，分开测。
  const audit = createAuditLog(dir, { maxBytes: 200, keep: 50 })
  for (let i = 0; i < 20; i++) audit.log('e', { i, pad: 'x'.repeat(20) })

  const archives = audit.archives()
  assert.ok(archives.length > 0, `应发生轮转，实际目录: ${JSON.stringify(fs.readdirSync(dir))}`)
  const archived = archives.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('')
  assert.match(archived, /"i":0/, '最早的条目必须还在归档里 —— 轮转不能变成丢数据')
})

test('S4：同毫秒内连续轮转不互相覆盖（归档名不撞车）', () => {
  const dir = makeDir()
  // maxBytes 极小 ⇒ 之后每次写入都触发轮转 ⇒ 必然落在同一毫秒里。
  // 若归档名只用时间戳，renameSync 会互相**覆盖**，归档数会远少于轮转次数。
  const audit = createAuditLog(dir, { maxBytes: 1, keep: 50 })
  for (let i = 0; i < 8; i++) audit.log('e', { i })

  // 第 1 次写入时文件还不存在、不轮转；此后每次写入都轮转一次 ⇒ 7 份归档 + 1 个活文件
  assert.equal(audit.archives().length, 7, `应为 7 份归档，实际 ${audit.archives().length}`)

  const all = [
    ...audit.archives().map((n) => fs.readFileSync(path.join(dir, n), 'utf8')),
    fs.readFileSync(audit.file, 'utf8'),
  ].join('')
  for (let i = 0; i < 8; i++) {
    assert.match(all, new RegExp(`"i":${i}[,}]`), `第 ${i} 条不应因归档重名而丢失`)
  }
})

test('S4：归档数量不超过 keep（磁盘占用有上界）', () => {
  const dir = makeDir()
  const audit = createAuditLog(dir, { maxBytes: 100, keep: 2 })
  for (let i = 0; i < 200; i++) audit.log('e', { i, pad: 'y'.repeat(20) })
  assert.ok(audit.archives().length <= 2, `归档数应 ≤ keep=2，实际 ${audit.archives().length}`)
})

test('S4：目录总占用受 (keep+1)×maxBytes 约束', () => {
  const dir = makeDir()
  const maxBytes = 500
  const keep = 3
  const audit = createAuditLog(dir, { maxBytes, keep })
  for (let i = 0; i < 500; i++) audit.log('e', { i, pad: 'z'.repeat(30) })
  const total = fs.readdirSync(dir).reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0)
  // 放宽一倍余量：归档文件会比 maxBytes 略大一条记录，活文件也可能刚好压线
  assert.ok(total < maxBytes * (keep + 1) * 2, `总占用应受上界约束，实际 ${total} 字节`)
})

test('S4：未达上限时不产生任何归档', () => {
  const dir = makeDir()
  const audit = createAuditLog(dir, { maxBytes: 10_000, keep: 5 })
  audit.log('e', { i: 1 })
  assert.equal(audit.archives().length, 0)
  assert.deepEqual(fs.readdirSync(dir), ['auth-audit.jsonl'])
})

test('S4：轮转后写入的是新文件，活文件从小开始', () => {
  const dir = makeDir()
  const maxBytes = 150
  const audit = createAuditLog(dir, { maxBytes, keep: 5 })
  for (let i = 0; i < 30; i++) audit.log('e', { i, pad: 'w'.repeat(20) })
  const active = fs.statSync(audit.file).size
  // 不变式：轮转发生在 append **之前**，所以活文件最多只会超出上限"一条记录"的量。
  // （别写成 `active < maxBytes` —— 循环恰好在越过上限那一步结束时，它就是会超。）
  assert.ok(active < maxBytes + 100, `活文件应在上限附近，实际 ${active}`)
  // 最后一条必须落在活文件里（不能写进已归档的旧文件）
  assert.match(fs.readFileSync(audit.file, 'utf8'), /"i":29/)
})
