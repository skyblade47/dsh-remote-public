// 工作区写操作 fs 原语单测（设计文档 §4、§8.1）。
// 夹具：临时目录工作区，含 .dsh-workspace.json 与 src/a.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  createTextFile,
  updateTextFile,
  removeEntry,
  moveEntry,
  makeDirectory,
} from '../src/workspace-write.js'
import {
  PROTECTED_META_FILE,
  isProtectedEntry,
  formatVersion,
  parseVersion,
  readFileMeta,
} from '../src/workspace-fs.js'

// Windows 无权限时 symlink 会抛错，跳过相关用例（与 workspace-fs.test.js 同一策略）
const canSymlink = (() => {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-symlink-probe-'))
    const target = path.join(tmp, 'target')
    fs.writeFileSync(target, 'x')
    fs.symlinkSync(target, path.join(tmp, 'link'))
    fs.rmSync(tmp, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
})()
const symlinkTest = canSymlink ? test : test.skip

const A_JS = 'const a = 1\n'

function makeWs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-write-'))
  fs.writeFileSync(path.join(root, PROTECTED_META_FILE), '{}\n')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.js'), A_JS)
  return root
}

function sha256(text) {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}

function catchCode(fn) {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('预期抛错但没有抛出')
}

test('formatVersion / parseVersion 往返（带引号、不带引号、畸形）', () => {
  const v = formatVersion({ mtimeMs: 1758312000123.45, size: 496 })
  assert.equal(v, '"1758312000123.45-496"')
  assert.deepEqual(parseVersion(v), { mtimeMs: 1758312000123.45, size: 496 })
  assert.deepEqual(parseVersion('1758312000123.45-496'), { mtimeMs: 1758312000123.45, size: 496 })
  assert.equal(parseVersion('garbage'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion('"12-"'), null)
  assert.equal(parseVersion('"a-b"'), null)
})

test('isProtectedEntry 仅匹配工作区根级元信息文件', () => {
  const root = makeWs()
  assert.equal(isProtectedEntry(root, path.join(root, PROTECTED_META_FILE)), true)
  assert.equal(isProtectedEntry(root, path.join(root, 'src', PROTECTED_META_FILE)), false)
  assert.equal(isProtectedEntry(root, path.join(root, 'src', 'a.js')), false)
})

test('readFileMeta 返回 mtimeMs（版本协议基础）且既有字段不变', () => {
  const root = makeWs()
  const meta = readFileMeta(root, 'src/a.js')
  assert.equal(meta.name, 'a.js')
  assert.equal(meta.size, Buffer.byteLength(A_JS))
  assert.equal(meta.binary, false)
  assert.equal(typeof meta.mtimeMs, 'number')
  assert.ok(meta.mtimeMs > 0)
})

test('createTextFile：正常落盘并返回 path/size/version/hash/lines，无 .tmp 残留', () => {
  const root = makeWs()
  const content = 'export const x = 1\nexport const y = 2\n'
  const r = createTextFile(root, 'src/new.js', content)
  const abs = path.join(root, 'src', 'new.js')

  assert.equal(r.path, 'src/new.js')
  assert.equal(r.size, Buffer.byteLength(content))
  assert.equal(r.lines, 2)
  assert.equal(r.hash, sha256(content))
  assert.match(r.version, /^"\d+(\.\d+)?-\d+"$/)
  assert.equal(r.version, formatVersion(fs.lstatSync(abs)))
  assert.equal(fs.readFileSync(abs, 'utf8'), content)
  assert.deepEqual(fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.tmp')), [])
})

test('createTextFile：根级无扩展名白名单文件可建，光秃名称拒绝', () => {
  const root = makeWs()
  assert.equal(createTextFile(root, 'README', 'hi\n').path, 'README')
  assert.equal(catchCode(() => createTextFile(root, 'noext', 'x')).code, 'UNSUPPORTED_FILE_TYPE')
  assert.equal(catchCode(() => createTextFile(root, 'logo.png', 'x')).code, 'UNSUPPORTED_FILE_TYPE')
})

test('createTextFile：重复创建 ENTRY_EXISTS，父缺失 PARENT_NOT_FOUND', () => {
  const root = makeWs()
  assert.equal(catchCode(() => createTextFile(root, 'src/a.js', 'x\n')).code, 'ENTRY_EXISTS')
  assert.equal(catchCode(() => createTextFile(root, 'nope/b.js', 'x\n')).code, 'PARENT_NOT_FOUND')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), A_JS)
})

test('createTextFile：内容超限 CONTENT_TOO_LARGE 且不落盘', () => {
  const root = makeWs()
  const e = catchCode(() => createTextFile(root, 'src/big.txt', 'x'.repeat(50), { maxBytes: 10 }))
  assert.equal(e.code, 'CONTENT_TOO_LARGE')
  assert.ok(!fs.existsSync(path.join(root, 'src', 'big.txt')))
})

test('createTextFile：空/根路径 INVALID_PATH、越界 PATH_TRAVERSAL_DETECTED、受保护 PROTECTED_ENTRY', () => {
  const root = makeWs()
  assert.equal(catchCode(() => createTextFile(root, '', 'x')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => createTextFile(root, '.', 'x')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => createTextFile(root, '../escape.js', 'x')).code, 'PATH_TRAVERSAL_DETECTED')
  assert.equal(catchCode(() => createTextFile(root, '.dsh-workspace.json', '{}')).code, 'PROTECTED_ENTRY')
  assert.ok(fs.existsSync(path.join(root, PROTECTED_META_FILE)))
})

symlinkTest('createTextFile：父目录是符号链接 SYMLINK_NOT_FOLLOWED', () => {
  const root = makeWs()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-out-'))
  fs.symlinkSync(outside, path.join(root, 'linkdir'), 'dir')
  assert.equal(catchCode(() => createTextFile(root, 'linkdir/x.js', 'x')).code, 'SYMLINK_NOT_FOLLOWED')
  assert.ok(!fs.existsSync(path.join(outside, 'x.js')))
})

test('updateTextFile：正常更新返回双 hash、版本与行数规模', () => {
  const root = makeWs()
  const abs = path.join(root, 'src', 'a.js')
  const before = formatVersion(fs.lstatSync(abs))
  const newText = 'const a = 2\nconst b = 3\n'
  const r = updateTextFile(root, 'src/a.js', newText, { expectedVersion: before })

  assert.equal(r.path, 'src/a.js')
  assert.equal(r.size, Buffer.byteLength(newText))
  assert.equal(r.oldHash, sha256(A_JS))
  assert.equal(r.newHash, sha256(newText))
  assert.equal(r.linesAdded, 2) // 'const a = 2' 与 'const b = 3' 各 +1
  assert.equal(r.linesRemoved, 1) // 'const a = 1' 消失
  assert.equal(r.version, formatVersion(fs.lstatSync(abs)))
  assert.equal(fs.readFileSync(abs, 'utf8'), newText)
  assert.deepEqual(fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.tmp')), [])
})

test('updateTextFile：版本不符 VERSION_CONFLICT 附 currentVersion 且内容未变', () => {
  const root = makeWs()
  const abs = path.join(root, 'src', 'a.js')
  const e = catchCode(() => updateTextFile(root, 'src/a.js', 'changed\n', { expectedVersion: '"1-1"' }))
  assert.equal(e.code, 'VERSION_CONFLICT')
  assert.equal(e.currentVersion, formatVersion(fs.lstatSync(abs)))
  assert.equal(fs.readFileSync(abs, 'utf8'), A_JS)
  assert.deepEqual(fs.readdirSync(path.join(root, 'src')).filter((n) => n.endsWith('.tmp')), [])
})

test('updateTextFile：force 跳过版本校验并落盘', () => {
  const root = makeWs()
  const r = updateTextFile(root, 'src/a.js', 'forced\n', { expectedVersion: '"1-1"', force: true })
  assert.equal(r.newHash, sha256('forced\n'))
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), 'forced\n')
})

test('updateTextFile：源缺失 PATH_NOT_FOUND、源是目录 NOT_A_FILE（不含扩展名）', () => {
  const root = makeWs()
  assert.equal(catchCode(() => updateTextFile(root, 'src/none.js', 'x')).code, 'PATH_NOT_FOUND')
  assert.equal(catchCode(() => updateTextFile(root, 'src', 'x')).code, 'NOT_A_FILE')
  fs.mkdirSync(path.join(root, 'docs'))
  assert.equal(catchCode(() => updateTextFile(root, 'docs', 'x')).code, 'NOT_A_FILE')
})

test('updateTextFile：同内容重写 hash 相同、行数皆 0', () => {
  const root = makeWs()
  const r = updateTextFile(root, 'src/a.js', A_JS)
  assert.equal(r.oldHash, r.newHash)
  assert.equal(r.linesAdded, 0)
  assert.equal(r.linesRemoved, 0)
})

test('updateTextFile：空路径 INVALID_PATH、受保护 PROTECTED_ENTRY、超限 CONTENT_TOO_LARGE', () => {
  const root = makeWs()
  assert.equal(catchCode(() => updateTextFile(root, '', 'x')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => updateTextFile(root, '.dsh-workspace.json', '{}')).code, 'PROTECTED_ENTRY')
  assert.equal(
    catchCode(() => updateTextFile(root, 'src/a.js', 'x'.repeat(50), { maxBytes: 10 })).code,
    'CONTENT_TOO_LARGE'
  )
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), A_JS)
})

test('removeEntry：删文件 removedCount=1 且 oldHash 正确', () => {
  const root = makeWs()
  const abs = path.join(root, 'src', 'a.js')
  const r = removeEntry(root, 'src/a.js')
  assert.equal(r.path, 'src/a.js')
  assert.equal(r.removedCount, 1)
  assert.equal(r.oldHash, sha256(A_JS))
  assert.ok(!fs.existsSync(abs))
})

test('removeEntry：非空目录无 recursive → DIRECTORY_NOT_EMPTY 且目录仍在', () => {
  const root = makeWs()
  const e = catchCode(() => removeEntry(root, 'src'))
  assert.equal(e.code, 'DIRECTORY_NOT_EMPTY')
  assert.ok(fs.existsSync(path.join(root, 'src', 'a.js')))
})

test('removeEntry：空目录直接删成功 removedCount=1、oldHash 为 null', () => {
  const root = makeWs()
  fs.mkdirSync(path.join(root, 'empty'))
  const r = removeEntry(root, 'empty')
  assert.equal(r.removedCount, 1)
  assert.equal(r.oldHash, null)
  assert.ok(!fs.existsSync(path.join(root, 'empty')))
})

test('removeEntry：recursive 计数正确（3 文件 + 2 子目录 + 目录自身）且树消失', () => {
  const root = makeWs()
  fs.mkdirSync(path.join(root, 'src', 'deep', 'deeper'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'deep', 'x.txt'), 'x\n')
  fs.writeFileSync(path.join(root, 'src', 'deep', 'deeper', 'y.txt'), 'y\n')
  const r = removeEntry(root, 'src', { recursive: true })
  assert.equal(r.removedCount, 6)
  assert.equal(r.oldHash, null)
  assert.ok(!fs.existsSync(path.join(root, 'src')))
})

test('removeEntry：超限 TOO_MANY_FILES 且未删除任何条目', () => {
  const root = makeWs()
  fs.mkdirSync(path.join(root, 'many'))
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, 'many', `f${i}.txt`), 'x')
  const e = catchCode(() => removeEntry(root, 'many', { recursive: true, maxEntries: 5 }))
  assert.equal(e.code, 'TOO_MANY_FILES')
  assert.equal(fs.readdirSync(path.join(root, 'many')).length, 6)
})

test('removeEntry：版本不符 VERSION_CONFLICT 未删；目录携带版本 BAD_REQUEST；正确版本可删', () => {
  const root = makeWs()
  const abs = path.join(root, 'src', 'a.js')

  const bad = catchCode(() => removeEntry(root, 'src/a.js', { expectedVersion: '"1-1"' }))
  assert.equal(bad.code, 'VERSION_CONFLICT')
  assert.ok(fs.existsSync(abs))

  const onDir = catchCode(() => removeEntry(root, 'src', { recursive: true, expectedVersion: '"1-1"' }))
  assert.equal(onDir.code, 'BAD_REQUEST')
  assert.ok(fs.existsSync(abs))

  const ok = removeEntry(root, 'src/a.js', { expectedVersion: formatVersion(fs.lstatSync(abs)) })
  assert.equal(ok.removedCount, 1)
})

test('removeEntry：受保护条目与根路径拒绝', () => {
  const root = makeWs()
  assert.equal(catchCode(() => removeEntry(root, '.dsh-workspace.json')).code, 'PROTECTED_ENTRY')
  assert.equal(catchCode(() => removeEntry(root, '')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => removeEntry(root, 'src/none.js')).code, 'PATH_NOT_FOUND')
  assert.ok(fs.existsSync(path.join(root, PROTECTED_META_FILE)))
})

test('moveEntry：同目录改名与跨目录移动，文件 hash 不变', () => {
  const root = makeWs()
  fs.mkdirSync(path.join(root, 'docs'))
  const r = moveEntry(root, 'src/a.js', 'src/b.js')
  assert.equal(r.from, 'src/a.js')
  assert.equal(r.path, 'src/b.js')
  assert.equal(r.size, Buffer.byteLength(A_JS))
  assert.equal(r.hash, sha256(A_JS))
  assert.match(r.version, /^"\d+(\.\d+)?-\d+"$/)
  assert.ok(!fs.existsSync(path.join(root, 'src', 'a.js')))

  const r2 = moveEntry(root, 'src/b.js', 'docs/b.js')
  assert.equal(r2.path, 'docs/b.js')
  assert.equal(r2.hash, sha256(A_JS))
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'b.js'), 'utf8'), A_JS)
})

test('moveEntry：目标已存在 ENTRY_EXISTS；force 原子覆盖文件', () => {
  const root = makeWs()
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'other\n')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', 'src/b.js')).code, 'ENTRY_EXISTS')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'b.js'), 'utf8'), 'other\n')

  const r = moveEntry(root, 'src/a.js', 'src/b.js', { force: true })
  assert.equal(r.path, 'src/b.js')
  assert.equal(fs.readFileSync(path.join(root, 'src', 'b.js'), 'utf8'), A_JS)
  assert.ok(!fs.existsSync(path.join(root, 'src', 'a.js')))
})

test('moveEntry：移入自身子树/同路径 INVALID_MOVE、越界 PATH_TRAVERSAL_DETECTED、空 newPath INVALID_PATH', () => {
  const root = makeWs()
  fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true })
  assert.equal(catchCode(() => moveEntry(root, 'src', 'src/sub/src')).code, 'INVALID_MOVE')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', 'src/a.js')).code, 'INVALID_MOVE')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', '../out.js')).code, 'PATH_TRAVERSAL_DETECTED')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', '')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => moveEntry(root, 'srс/none.js', 'x.js')).code, 'PATH_NOT_FOUND')
})

test('moveEntry：目标父缺失 PARENT_NOT_FOUND；force 目标为已存在目录 TARGET_IS_DIRECTORY', () => {
  const root = makeWs()
  fs.mkdirSync(path.join(root, 'docs'))
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', 'nope/a.js')).code, 'PARENT_NOT_FOUND')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', 'docs')).code, 'ENTRY_EXISTS')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', 'docs', { force: true })).code, 'TARGET_IS_DIRECTORY')
  assert.ok(fs.existsSync(path.join(root, 'src', 'a.js')))
})

test('moveEntry：移动目录返回 version/hash 为 null、size 为 0，内部文件完好', () => {
  const root = makeWs()
  fs.writeFileSync(path.join(root, 'src', 'deep.txt'), 'deep\n')
  const r = moveEntry(root, 'src', 'app')
  assert.equal(r.from, 'src')
  assert.equal(r.path, 'app')
  assert.equal(r.version, null)
  assert.equal(r.hash, null)
  assert.equal(r.size, 0)
  assert.equal(fs.readFileSync(path.join(root, 'app', 'a.js'), 'utf8'), A_JS)
  assert.equal(fs.readFileSync(path.join(root, 'app', 'deep.txt'), 'utf8'), 'deep\n')
  assert.ok(!fs.existsSync(path.join(root, 'src')))
})

test('moveEntry：受保护条目与根路径拒绝', () => {
  const root = makeWs()
  assert.equal(catchCode(() => moveEntry(root, '.dsh-workspace.json', 'x.json')).code, 'PROTECTED_ENTRY')
  assert.equal(catchCode(() => moveEntry(root, '', 'x.js')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => moveEntry(root, 'src/a.js', '.dsh-workspace.json')).code, 'PROTECTED_ENTRY')
  assert.ok(fs.existsSync(path.join(root, PROTECTED_META_FILE)))
})

test('makeDirectory：正常创建、重复 ENTRY_EXISTS、父缺失 PARENT_NOT_FOUND', () => {
  const root = makeWs()
  const r = makeDirectory(root, 'src/features')
  assert.equal(r.path, 'src/features')
  assert.ok(fs.statSync(path.join(root, 'src', 'features')).isDirectory())
  assert.equal(catchCode(() => makeDirectory(root, 'src/features')).code, 'ENTRY_EXISTS')
  assert.equal(catchCode(() => makeDirectory(root, 'nope/deep')).code, 'PARENT_NOT_FOUND')
  assert.equal(catchCode(() => makeDirectory(root, 'a/b/c')).code, 'PARENT_NOT_FOUND')
})

test('makeDirectory：父级是文件 NOT_A_DIRECTORY、空路径 INVALID_PATH、受保护 PROTECTED_ENTRY', () => {
  const root = makeWs()
  fs.writeFileSync(path.join(root, 'src', 'file.txt'), 'x')
  assert.equal(catchCode(() => makeDirectory(root, 'src/file.txt/sub')).code, 'NOT_A_DIRECTORY')
  assert.equal(catchCode(() => makeDirectory(root, '')).code, 'INVALID_PATH')
  assert.equal(catchCode(() => makeDirectory(root, '.dsh-workspace.json')).code, 'PROTECTED_ENTRY')
  assert.equal(catchCode(() => makeDirectory(root, '../outside')).code, 'PATH_TRAVERSAL_DETECTED')
})
