import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  countFrames,
  decompressAllFrames,
  isSessionSnapshot,
  listSessionFiles,
  migrateSessions,
  normalizeCwd,
  projectKey,
  rewriteHeaderCwd,
  splitFirstFrame,
  verifyMigration,
} from '../../scripts/session-migrate.mjs'

// ---------- 用磁盘上真实的桶名作为基准，确保编码与内核逐字符一致 ----------

test('projectKey 复刻内核编码（真实桶名基准）', () => {
  assert.equal(
    projectKey('C:\\Users\\zhou1\\AppData\\Roaming\\TRAE SOLO CN\\ModularData\\ai-agent\\work-mode-projects\\6aae02685a966e223a673cbe'),
    '--C-Users-zhou1-AppData-Roaming-TRAE~0020SOLO~0020CN-ModularData-ai-agent-work-mode-projects-6aae02685a966e223a673cbe--',
  )
  assert.equal(projectKey('E:\\DSH工作区'), '--E-DSH~5DE5~4F5C~533A--')
  assert.equal(
    projectKey('E:\\DeepSeek-Harness-1.0.0-portable\\resources\\dsh-runtime'),
    '--E-DeepSeek-Harness-1.0.0-portable-resources-dsh-runtime--',
  )
  assert.equal(
    projectKey('D:\\Program Files\\DeepSeek Harness\\resources\\dsh-runtime'),
    '--D-Program~0020Files-DeepSeek~0020Harness-resources-dsh-runtime--',
  )
})

test('projectKey 处理 Linux 路径与连续分隔符', () => {
  assert.equal(projectKey('/srv/dsh-workspace'), '--srv-dsh-workspace--')
  assert.equal(projectKey('/srv//dsh-workspace'), '--srv-dsh-workspace--')
  assert.equal(projectKey('/'), '--root--')
})

test('projectKey 拒绝空路径', () => {
  assert.throws(() => projectKey(''), /不能为空/)
  assert.throws(() => projectKey(undefined), /不能为空/)
})

// ---------- cwd 匹配归一化（真实数据里存在 E:\x 与 E:/x 两种写法）----------

test('normalizeCwd 统一斜杠并去掉尾部斜杠', () => {
  assert.equal(normalizeCwd('E:\\DSH工作区'), 'E:/DSH工作区')
  assert.equal(normalizeCwd('E:/DSH工作区/'), 'E:/DSH工作区')
  assert.equal(normalizeCwd('/srv/dsh-workspace//'), '/srv/dsh-workspace')
  assert.equal(normalizeCwd(undefined), '')
})

test('迁移：正斜杠写法的 cwd 也能命中反斜杠写法的映射', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-slash-'))
  const src = path.join(root, 'sessions')
  const newCwd = '/srv/dsh-workspace'
  // 会话 header 里写的是 E:/DSH工作区（正斜杠）
  const dir = path.join(src, projectKey('E:/DSH工作区'), 'session-fwd')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session.v3.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(headerLine('E:/DSH工作区') + '\n{"x":1}\n', 'utf8')),
  )

  const { stats } = migrateSessions({
    sessionsRoot: src,
    outRoot: src,
    // 映射按反斜杠写法给出
    cwdMap: { 'E:\\DSH工作区': newCwd },
  })
  assert.equal(stats.migrated, 1, '应命中映射而不是被跳过')
  assert.equal(stats.skipped, 0)
  const migrated = readSession(path.join(src, projectKey(newCwd), 'session-fwd', 'session.v3.jsonl.zstd'))
  assert.match(migrated, /"cwd":"\/srv\/dsh-workspace"/)
})

// ---------- 会话文件识别 ----------

test('isSessionSnapshot 只认会话快照，排除 .bak 备份', () => {
  assert.equal(isSessionSnapshot('session.v3.jsonl.zstd'), true)
  assert.equal(isSessionSnapshot('session.jsonl.zstd'), true)
  assert.equal(isSessionSnapshot('session-abc.jsonl.zstd'), true)
  assert.equal(isSessionSnapshot('session.jsonl.zstd.bak-no-surfaceop'), false)
  assert.equal(isSessionSnapshot('session.jsonl.zstd.bak-prefix-2026-09-17T07-02-11'), false)
  assert.equal(isSessionSnapshot('headers-backup.json'), false)
})

// ---------- header 改写 ----------

function headerLine(cwd, extra = '') {
  return `{"type":"session","version":3,"id":"session-1","createdAt":1789979041363,"cwd":${JSON.stringify(cwd)},"isSeeded":false,"delegationDepth":0,"agentPreset":"cordis"}${extra}`
}

test('rewriteHeaderCwd 只改 cwd，其余逐字节不变', () => {
  const body = '\n{"type":"message","text":"hello 世界"}\n'
  const raw = headerLine('E:\\DSH工作区') + body
  const r = rewriteHeaderCwd(raw, '/srv/dsh-workspace')
  assert.equal(r.changed, true)
  assert.equal(r.oldCwd, 'E:\\DSH工作区')
  const expected =
    `{"type":"session","version":3,"id":"session-1","createdAt":1789979041363,"cwd":"/srv/dsh-workspace","isSeeded":false,"delegationDepth":0,"agentPreset":"cordis"}` + body
  assert.equal(r.text, expected)
})

test('rewriteHeaderCwd 目标一致时标记未变更', () => {
  const raw = headerLine('/srv/dsh-workspace') + '\n{"x":1}\n'
  const r = rewriteHeaderCwd(raw, '/srv/dsh-workspace')
  assert.equal(r.changed, false)
  assert.equal(r.text, raw)
})

test('rewriteHeaderCwd 对非会话 header 返回 null', () => {
  assert.equal(rewriteHeaderCwd('{"type":"other"}\n', '/srv/x'), null)
  assert.equal(rewriteHeaderCwd('不是 JSON\n', '/srv/x'), null)
  assert.equal(rewriteHeaderCwd('{"type":"session","version":3}\n', '/srv/x'), null)
})

// ---------- 端到端迁移 ----------

function makeSessionsTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-migrate-'))
  const src = path.join(root, 'sessions')
  const oldCwd = 'E:\\DSH工作区'
  const bucket = projectKey(oldCwd)

  const add = (session, body, fileName = 'session.v3.jsonl.zstd') => {
    const dir = path.join(src, bucket, session)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, fileName), zlib.zstdCompressSync(Buffer.from(headerLine(oldCwd) + '\n' + body, 'utf8')))
  }
  add('session-a', '{"type":"message","text":"A"}')
  add('session-b', '{"type":"message","text":"B"}')
  // 备份文件不应被迁移
  const bakDir = path.join(src, bucket, 'session-c')
  fs.mkdirSync(bakDir, { recursive: true })
  fs.writeFileSync(path.join(bakDir, 'session.jsonl.zstd.bak-old'), 'not-zstd-junk')

  // 一个 cwd 不在映射里的会话
  const otherBucket = projectKey('D:\\Other')
  const otherDir = path.join(src, otherBucket, 'session-d')
  fs.mkdirSync(otherDir, { recursive: true })
  fs.writeFileSync(
    path.join(otherDir, 'session.v3.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(headerLine('D:\\Other') + '\n{"x":1}\n', 'utf8')),
  )
  return { root, src, oldCwd, bucket }
}

function readSession(dir) {
  return decompressAllFrames(fs.readFileSync(dir)).toString('utf8')
}

// ---------- 多帧 zstd（内核 append-only 的真实形态）----------
// 内核的会话文件是「第一帧=header，之后每次追加各成一帧」。下面用多帧夹具覆盖——
// 单帧夹具无法暴露「整文件重压缩会把正文清空」这个缺陷。

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function multiFrameSession(cwd, bodies = []) {
  const frames = [zlib.zstdCompressSync(Buffer.from(headerLine(cwd) + '\n', 'utf8'))]
  for (const b of bodies) frames.push(zlib.zstdCompressSync(Buffer.from(b + '\n', 'utf8')))
  return Buffer.concat(frames)
}

test('多帧会话：zstdDecompressSync 只解第一帧（这正是不能整文件重压缩的原因）', () => {
  const buf = multiFrameSession('E:\\DSH工作区', [
    '{"type":"message","text":"正文一"}',
    '{"type":"message","text":"正文二"}',
  ])
  const firstOnly = zlib.zstdDecompressSync(buf).toString('utf8')
  assert.match(firstOnly, /"type":"session"/)
  assert.ok(!firstOnly.includes('正文一'), '单帧解码器看不到正文——所以必须先按帧切分')
  const all = decompressAllFrames(buf).toString('utf8')
  assert.ok(all.includes('正文一') && all.includes('正文二'), '逐帧解压应拿到全部正文')
})

test('splitFirstFrame 定位第一帧边界', () => {
  const buf = multiFrameSession('E:\\DSH工作区', ['{"x":1}', '{"y":2}'])
  const s = splitFirstFrame(buf)
  assert.equal(s.singleFrame, false)
  assert.match(s.firstText, /"type":"session"/)
  assert.ok(buf.subarray(s.firstFrameEnd, s.firstFrameEnd + 4).equals(ZSTD_MAGIC), '边界必须落在下一帧起点')
  // 从边界切下去，后面两帧应完整可解（证明没有把正文切掉或切多）
  assert.equal(decompressAllFrames(buf.subarray(s.firstFrameEnd)).toString('utf8'), '{"x":1}\n{"y":2}\n')
})

test('splitFirstFrame：单帧文件返回整个长度', () => {
  const one = zlib.zstdCompressSync(Buffer.from(headerLine('E:\\DSH工作区') + '\n{"x":1}\n', 'utf8'))
  const s = splitFirstFrame(one)
  assert.equal(s.singleFrame, true)
  assert.equal(s.firstFrameEnd, one.length)
})

test('countFrames 统计帧数', () => {
  assert.equal(countFrames(multiFrameSession('E:\\DSH工作区', [])), 1)
  assert.equal(countFrames(multiFrameSession('E:\\DSH工作区', ['{"a":1}', '{"b":2}'])), 3)
})

test('回归：迁移多帧会话必须保住正文帧（曾把大体会话清成只剩 header）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-multiframe-'))
  const src = path.join(root, 'sessions')
  const out = path.join(root, 'out')
  const backup = path.join(root, 'backup')
  const oldCwd = 'E:\\DSH工作区'
  const newCwd = '/srv/dsh-workspace'
  const bodies = ['{"type":"message","text":"正文一"}', '{"type":"message","text":"正文二"}', '{"type":"message","text":"正文三"}']
  const original = multiFrameSession(oldCwd, bodies)

  const dir = path.join(src, projectKey(oldCwd), 'session-big')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), original)

  const { stats } = migrateSessions({
    sessionsRoot: src,
    outRoot: out,
    backupDir: backup,
    cwdMap: { [oldCwd]: newCwd },
  })
  assert.equal(stats.migrated, 1)
  assert.equal(stats.failed, 0)

  const target = path.join(out, projectKey(newCwd), 'session-big', 'session.jsonl.zstd')
  const afterBuf = fs.readFileSync(target)

  // 1) 帧数不变（正文帧没被合并/丢弃）
  assert.equal(countFrames(afterBuf), countFrames(original), '帧数应保持不变')
  // 2) 全文除 cwd 外逐字符一致
  const before = decompressAllFrames(original).toString('utf8')
  const after = decompressAllFrames(afterBuf).toString('utf8')
  assert.equal(after, before.replace('E:\\\\DSH工作区', newCwd))
  for (const b of bodies) assert.ok(after.includes(b), `正文应保留：${b}`)
  // 3) 第一帧之后的所有字节逐字节相同
  const s = splitFirstFrame(original)
  const s2 = splitFirstFrame(afterBuf)
  assert.ok(afterBuf.subarray(s2.firstFrameEnd).equals(original.subarray(s.firstFrameEnd)), '正文帧应逐字节保留')
  // 4) 自校验通过
  assert.deepEqual(
    verifyMigration({
      backups: { a: path.join(backup, projectKey(oldCwd), 'session-big', 'session.jsonl.zstd') },
      targets: { a: target },
      newCwd,
    }),
    [],
  )
})

test('verifyMigration 能检出正文帧丢失（旧实现的产物会被判为问题）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-verify-'))
  const oldCwd = 'E:\\DSH工作区'
  const newCwd = '/srv/dsh-workspace'
  const original = multiFrameSession(oldCwd, ['{"type":"message","text":"正文一"}', '{"type":"message","text":"正文二"}'])

  const bak = path.join(root, 'bak.zstd')
  fs.writeFileSync(bak, original)

  // 复现旧实现：整文件解压（只拿到 header）→ 改写 → 单帧重压缩
  const brokenText = rewriteHeaderCwd(zlib.zstdDecompressSync(original).toString('utf8'), newCwd).text
  const broken = path.join(root, 'broken.zstd')
  fs.writeFileSync(broken, zlib.zstdCompressSync(Buffer.from(brokenText, 'utf8')))

  const problems = verifyMigration({ backups: { a: bak }, targets: { a: broken }, newCwd })
  assert.ok(problems.length > 0, '必须检出问题')
  assert.match(problems[0], /帧数变化|内容与预期不一致/)
})

test('listSessionFiles 只枚举会话快照，跳过 .bak 与 _ 前缀目录', () => {
  const { src, bucket } = makeSessionsTree()
  const files = listSessionFiles(src)
  const names = files.map((f) => `${f.bucket}/${f.session}/${f.file}`).sort()
  assert.deepEqual(names, [
    `${projectKey('D:\\Other')}/session-d/session.v3.jsonl.zstd`,
    `${bucket}/session-a/session.v3.jsonl.zstd`,
    `${bucket}/session-b/session.v3.jsonl.zstd`,
  ])
})

test('dry-run 不写任何文件', () => {
  const { src, root } = makeSessionsTree()
  const before = fs.readdirSync(src).sort()
  const { stats } = migrateSessions({
    sessionsRoot: src,
    outRoot: path.join(root, 'out'),
    cwdMap: { 'E:\\DSH工作区': '/srv/dsh-workspace' },
    dryRun: true,
  })
  assert.equal(stats.total, 3)
  assert.equal(stats.migrated, 2)
  assert.equal(stats.skipped, 1)
  assert.equal(fs.existsSync(path.join(root, 'out')), false)
  assert.deepEqual(fs.readdirSync(src).sort(), before)
})

test('迁移：换桶 + 只改 cwd + 备份可回滚 + 自校验通过', () => {
  const { src, root, oldCwd } = makeSessionsTree()
  const out = path.join(root, 'out')
  const backup = path.join(root, 'backup')
  const newCwd = '/srv/dsh-workspace'

  const { stats, records } = migrateSessions({
    sessionsRoot: src,
    outRoot: out,
    backupDir: backup,
    cwdMap: { [oldCwd]: newCwd },
  })

  assert.equal(stats.total, 3)
  assert.equal(stats.migrated, 2)
  assert.equal(stats.skipped, 1, '未命中映射的会话应被跳过')
  assert.equal(stats.failed, 0)

  const newBucket = projectKey(newCwd)
  assert.equal(newBucket, '--srv-dsh-workspace--')
  const migrated = readSession(path.join(out, newBucket, 'session-a', 'session.v3.jsonl.zstd'))
  assert.match(migrated, /"cwd":"\/srv\/dsh-workspace"/)
  assert.match(migrated, /\{"type":"message","text":"A"\}/)

  // 除 cwd 外内容一致（用备份反推期望值再比对）
  const problems = verifyMigration({
    backups: { a: path.join(backup, projectKey(oldCwd), 'session-a', 'session.v3.jsonl.zstd') },
    targets: { a: path.join(out, newBucket, 'session-a', 'session.v3.jsonl.zstd') },
    newCwd,
  })
  assert.deepEqual(problems, [])

  // 备份映射文件
  const mapping = JSON.parse(fs.readFileSync(path.join(backup, 'headers-backup.json'), 'utf8'))
  assert.equal(mapping.migrated, 2)
  assert.equal(mapping.records.length, 3)
  assert.ok(mapping.buckets.some((b) => b.bucket === newBucket))
})

test('迁移：未命中映射且给了兜底时全部迁移', () => {
  const { src, root } = makeSessionsTree()
  const out = path.join(root, 'out2')
  const { stats } = migrateSessions({
    sessionsRoot: src,
    outRoot: out,
    cwdMap: { 'E:\\DSH工作区': '/srv/dsh-workspace' },
    defaultNewCwd: '/srv/fallback',
  })
  assert.equal(stats.migrated, 3)
  assert.equal(stats.skipped, 0)
  assert.ok(fs.existsSync(path.join(out, projectKey('/srv/fallback'), 'session-d', 'session.v3.jsonl.zstd')))
})

test('迁移：已是目标 cwd 的会话原样搬运（字节不变）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-same-'))
  const src = path.join(root, 'sessions')
  const cwd = '/srv/dsh-workspace'
  const dir = path.join(src, projectKey(cwd), 'session-x')
  fs.mkdirSync(dir, { recursive: true })
  const original = zlib.zstdCompressSync(Buffer.from(headerLine(cwd) + '\n{"x":1}\n', 'utf8'))
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), original)

  const { stats } = migrateSessions({
    sessionsRoot: src,
    outRoot: src,
    cwdMap: { [cwd]: cwd },
  })
  assert.equal(stats.unchanged, 1)
  assert.equal(stats.migrated, 0)
  const after = fs.readFileSync(path.join(src, projectKey(cwd), 'session-x', 'session.v3.jsonl.zstd'))
  assert.ok(after.equals(original), '未变更的会话应逐字节原样')
})
