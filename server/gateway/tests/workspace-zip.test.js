import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Writable } from 'node:stream'
import { crc32, streamWorkspaceZip, ZIP_DEFAULTS } from '../src/workspace-zip.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-zip-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }))
  fs.writeFileSync(path.join(root, 'src', 'index.js'), "console.log('hi')\n")
  fs.writeFileSync(path.join(root, 'src', 'deep', 'notes.txt'), 'deep text')
  fs.writeFileSync(path.join(root, '.dsh-workspace.json'), JSON.stringify({ secret: true }))
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=xyz\n')
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n')
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
  try {
    fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'link.json'))
  } catch {
    // Windows 无权限时跳过符号链接创建
  }
  return root
}

class BufferWritable extends Writable {
  constructor() {
    super()
    this.chunks = []
  }
  _write(chunk, enc, cb) {
    this.chunks.push(chunk)
    cb()
  }
  toBuffer() {
    return Buffer.concat(this.chunks)
  }
}

// 解析所有中央目录条目
function parseCentralDirectory(buf) {
  // EOCD 签名 0x06054b50，从尾部搜索（comment length=0，固定位于末尾 22 字节）
  const eocdOffset = buf.length - 22
  assert.equal(buf.readUInt32LE(eocdOffset), 0x06054b50)
  const count = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  const centralOffset = buf.readUInt32LE(eocdOffset + 16)
  const entries = []
  let p = centralOffset
  const end = centralOffset + centralSize
  while (p < end) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, crc, compSize, uncompSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  assert.equal(entries.length, count)
  return { count, entries }
}

// 按中央目录的 localOffset 读出本地头后的文件数据
function readLocalData(buf, entry) {
  const p = entry.localOffset
  assert.equal(buf.readUInt32LE(p), 0x04034b50)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  return buf.slice(dataStart, dataStart + entry.compSize)
}

test('crc32: 已知向量（空串与 "123456789"）', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000)
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xCBF43926)
})

test('streamWorkspaceZip: 打包全部用户文件且排除元信息/符号链接', async () => {
  const root = makeWorkspace()
  const out = new BufferWritable()
  const result = await streamWorkspaceZip(root, out)
  const buf = out.toBuffer()

  assert.ok(buf.length > 0)
  const { count, entries } = parseCentralDirectory(buf)
  const names = entries.map((e) => e.name).sort()
  assert.deepEqual(names, [
    '.env',
    '.git/config',
    '.gitignore',
    'logo.png',
    'package.json',
    'src/deep/notes.txt',
    'src/index.js',
  ])
  assert.equal(count, 7)
  assert.equal(result.fileCount, 7)
  assert.ok(!names.some((n) => n.includes('.dsh-workspace.json')))
  assert.ok(!names.includes('link.json'))
})

test('streamWorkspaceZip: includeHidden=false 排除点开头文件与目录（WQ3）', async () => {
  const root = makeWorkspace()
  const out = new BufferWritable()
  const result = await streamWorkspaceZip(root, out, { includeHidden: false })
  const { count, entries } = parseCentralDirectory(out.toBuffer())
  const names = entries.map((e) => e.name).sort()
  assert.deepEqual(names, [
    'logo.png',
    'package.json',
    'src/deep/notes.txt',
    'src/index.js',
  ])
  assert.equal(count, 4)
  assert.equal(result.fileCount, 4)
  assert.ok(!names.some((n) => n.startsWith('.') || n.includes('/.')))
})

test('streamWorkspaceZip: CRC32 与解压内容字节级一致（deflate 条目）', async () => {
  const root = makeWorkspace()
  const out = new BufferWritable()
  await streamWorkspaceZip(root, out)
  const buf = out.toBuffer()
  const { entries } = parseCentralDirectory(buf)

  const js = entries.find((e) => e.name === 'src/index.js')
  assert.equal(js.method, 8) // 文本文件 deflate
  const raw = zlib.inflateRawSync(readLocalData(buf, js))
  assert.equal(raw.toString('utf8'), "console.log('hi')\n")
  assert.equal(js.crc, crc32(raw))
  assert.equal(js.uncompSize, raw.length)
})

test('streamWorkspaceZip: 已压缩扩展名单独 store（method=0）', async () => {
  const root = makeWorkspace()
  const out = new BufferWritable()
  await streamWorkspaceZip(root, out)
  const buf = out.toBuffer()
  const { entries } = parseCentralDirectory(buf)

  const png = entries.find((e) => e.name === 'logo.png')
  assert.equal(png.method, 0)
  const data = readLocalData(buf, png)
  assert.deepEqual(Array.from(data), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  assert.equal(png.crc, crc32(data))
})

test('streamWorkspaceZip: 空目录工作区产生 0 条目合法 ZIP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-zip-empty-'))
  fs.writeFileSync(path.join(root, '.dsh-workspace.json'), '{}')
  const out = new BufferWritable()
  const result = await streamWorkspaceZip(root, out)
  const buf = out.toBuffer()
  assert.equal(result.fileCount, 0)
  const { count } = parseCentralDirectory(buf)
  assert.equal(count, 0)
})

test('streamWorkspaceZip: 超文件数上限抛 TOO_MANY_FILES', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-zip-many-'))
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x')
  const out = new BufferWritable()
  await assert.rejects(
    () => streamWorkspaceZip(root, out, { maxFiles: 3 }),
    (e) => e.code === 'TOO_MANY_FILES'
  )
})

test('streamWorkspaceZip: 超总字节上限抛 WORKSPACE_TOO_LARGE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-zip-big-'))
  fs.writeFileSync(path.join(root, 'a.txt'), Buffer.alloc(1000, 0x61))
  const out = new BufferWritable()
  await assert.rejects(
    () => streamWorkspaceZip(root, out, { maxTotalBytes: 100 }),
    (e) => e.code === 'WORKSPACE_TOO_LARGE'
  )
})

test('ZIP_DEFAULTS 暴露设计阈值', () => {
  assert.equal(ZIP_DEFAULTS.MAX_TOTAL_BYTES, 500 * 1024 * 1024)
  assert.equal(ZIP_DEFAULTS.MAX_FILES, 100_000)
})
