import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  safeResolve,
  isTextFile,
  buildFileTree,
  readFileMeta,
  readTextContent,
  readFileForDownload,
  DEFAULTS,
} from '../src/workspace-fs.js'

// Windows 默认无符号链接权限时跳过相关测试
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

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-fs-'))
  // 模拟一个插件项目结构
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"test"}')
  fs.writeFileSync(path.join(root, 'README.md'), '# Test')
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export default {}')
  fs.writeFileSync(path.join(root, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), 'guide')
  // 内部元信息（不应出现在树中）
  fs.writeFileSync(path.join(root, '.dsh-workspace.json'), '{"internal":true}')
  return root
}

// ---- safeResolve ----

test('safeResolve: 根目录本身', () => {
  const root = makeTree()
  assert.equal(safeResolve(root, ''), root)
  assert.equal(safeResolve(root, '/'), root)
  assert.equal(safeResolve(root, './'), root)
})

test('safeResolve: 正常子路径', () => {
  const root = makeTree()
  assert.equal(safeResolve(root, 'src/index.js'), path.join(root, 'src', 'index.js'))
  assert.equal(safeResolve(root, 'src'), path.join(root, 'src'))
  // 反斜杠也接受
  assert.equal(safeResolve(root, 'src\\index.js'), path.join(root, 'src', 'index.js'))
})

test('safeResolve: L1 .. 段拒绝', () => {
  const root = makeTree()
  assert.throws(
    () => safeResolve(root, '../etc/passwd'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
  assert.throws(
    () => safeResolve(root, 'src/../../etc'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
  assert.throws(
    () => safeResolve(root, 'src/..'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
  // 🔴 反斜杠变体也必须被 L1 拦住：归一化分隔符**不能**开出"用 `\` 绕过 `..` 检查"的缝
  assert.throws(
    () => safeResolve(root, '..\\etc\\passwd'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
  assert.throws(
    () => safeResolve(root, 'src\\..\\..\\etc'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
})

test('safeResolve: L2 规范化后越界拒绝', () => {
  const root = makeTree()
  // 编码绕过尝试：使用绝对路径
  assert.throws(
    () => safeResolve(root, '/etc/passwd'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
  // 🔴 反斜杠形式的绝对路径同样必须越界拒绝：归一化只换分隔符，**不得**把前导分隔符吃掉
  //    （否则会从"拒绝"退化成"当成 root 下的 etc/passwd 而放行"）
  assert.throws(
    () => safeResolve(root, '\\etc\\passwd'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
})

test('safeResolve: 非字符串输入视为根', () => {
  const root = makeTree()
  assert.equal(safeResolve(root, null), root)
  assert.equal(safeResolve(root, undefined), root)
})

// ---- isTextFile ----

test('isTextFile: 常见文本扩展名', () => {
  assert.equal(isTextFile('index.js'), true)
  assert.equal(isTextFile('app.ts'), true)
  assert.equal(isTextFile('config.json'), true)
  assert.equal(isTextFile('README.md'), true)
  assert.equal(isTextFile('styles.css'), true)
  assert.equal(isTextFile('Dockerfile'), true)
  assert.equal(isTextFile('Makefile'), true)
  assert.equal(isTextFile('README'), true)
})

test('isTextFile: 二进制扩展名', () => {
  assert.equal(isTextFile('logo.png'), false)
  assert.equal(isTextFile('archive.zip'), false)
  assert.equal(isTextFile('binary.exe'), false)
  assert.equal(isTextFile('image.jpg'), false)
})

test('isTextFile: 大小写不敏感', () => {
  assert.equal(isTextFile('INDEX.JS'), true)
  assert.equal(isTextFile('README.MD'), true)
  assert.equal(isTextFile('LOGO.PNG'), false)
})

// ---- buildFileTree ----

test('buildFileTree: 默认深度 5', () => {
  const root = makeTree()
  const tree = buildFileTree(root)
  assert.equal(tree.type, 'dir')
  assert.ok(tree.children.length >= 3) // package.json, README.md, src, docs
  // 内部元信息文件不应出现
  const names = tree.children.map((c) => c.name)
  assert.ok(!names.includes('.dsh-workspace.json'))
})

test('buildFileTree: depth=0 只返回根目录', () => {
  const root = makeTree()
  const tree = buildFileTree(root, '', 0)
  assert.equal(tree.type, 'dir')
  assert.equal(tree.children, undefined) // 不递归
})

test('buildFileTree: 子目录内容', () => {
  const root = makeTree()
  const tree = buildFileTree(root)
  const srcNode = tree.children.find((c) => c.name === 'src')
  assert.ok(srcNode)
  assert.equal(srcNode.type, 'dir')
  const srcNames = srcNode.children.map((c) => c.name)
  assert.ok(srcNames.includes('index.js'))
  assert.ok(srcNames.includes('logo.png'))
})

test('buildFileTree: file 节点带 size', () => {
  const root = makeTree()
  const tree = buildFileTree(root)
  const pkg = tree.children.find((c) => c.name === 'package.json')
  assert.ok(pkg)
  assert.equal(pkg.type, 'file')
  assert.equal(pkg.size, fs.statSync(path.join(root, 'package.json')).size)
})

test('buildFileTree: 目录节点不带 size', () => {
  const root = makeTree()
  const tree = buildFileTree(root)
  const srcNode = tree.children.find((c) => c.name === 'src')
  assert.equal(srcNode.type, 'dir')
  assert.equal(srcNode.size, undefined)
})

symlinkTest('buildFileTree: 符号链接不跟随', () => {
  const root = makeTree()
  // 创建一个指向外部的符号链接
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-target-'))
  fs.symlinkSync(target, path.join(root, 'link-to-target'))
  const tree = buildFileTree(root)
  const linkNode = tree.children.find((c) => c.name === 'link-to-target')
  assert.ok(linkNode)
  assert.equal(linkNode.type, 'symlink')
  assert.equal(linkNode.children, undefined) // 不递归
})

test('buildFileTree: 深度超过 maxDepth 抛 PATH_TOO_DEEP', () => {
  const root = makeTree()
  assert.throws(
    () => buildFileTree(root, '', 20),
    (e) => e.code === 'PATH_TOO_DEEP'
  )
})

test('buildFileTree: 负数深度抛 INVALID_DEPTH', () => {
  const root = makeTree()
  assert.throws(
    () => buildFileTree(root, '', -1),
    (e) => e.code === 'INVALID_DEPTH'
  )
})

test('buildFileTree: 文件数超过 maxFiles 抛 TOO_MANY_FILES', () => {
  const root = makeTree()
  // 制造超多文件
  const sub = path.join(root, 'many')
  fs.mkdirSync(sub, { recursive: true })
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(sub, `f${i}.txt`), 'x')
  }
  assert.throws(
    () => buildFileTree(root, '', 5, { maxFiles: 5 }),
    (e) => e.code === 'TOO_MANY_FILES'
  )
})

test('buildFileTree: 子路径正常返回该子目录的树', () => {
  const root = makeTree()
  const subTree = buildFileTree(root, 'src')
  assert.equal(subTree.type, 'dir')
  assert.equal(subTree.name, 'src')
  const names = subTree.children.map((c) => c.name)
  assert.ok(names.includes('index.js'))
})

test('buildFileTree: 不存在的子路径返回 other 节点', () => {
  const root = makeTree()
  const node = buildFileTree(root, 'no-such-path')
  assert.equal(node.type, 'other')
})

// ---- readFileMeta ----

test('readFileMeta: 文本文件元信息', () => {
  const root = makeTree()
  const meta = readFileMeta(root, 'package.json')
  assert.equal(meta.name, 'package.json')
  assert.equal(meta.size, fs.statSync(path.join(root, 'package.json')).size)
  assert.equal(meta.binary, false)
})

test('readFileMeta: 二进制文件元信息', () => {
  const root = makeTree()
  const meta = readFileMeta(root, 'src/logo.png')
  assert.equal(meta.name, 'logo.png')
  assert.equal(meta.binary, true)
})

test('readFileMeta: 路径不存在抛 PATH_NOT_FOUND', () => {
  const root = makeTree()
  assert.throws(
    () => readFileMeta(root, 'no-such-file.txt'),
    (e) => e.code === 'PATH_NOT_FOUND'
  )
})

test('readFileMeta: 目录抛 NOT_A_FILE', () => {
  const root = makeTree()
  assert.throws(
    () => readFileMeta(root, 'src'),
    (e) => e.code === 'NOT_A_FILE'
  )
})

test('readFileMeta: 路径遍历拒绝', () => {
  const root = makeTree()
  assert.throws(
    () => readFileMeta(root, '../etc/passwd'),
    (e) => e.code === 'PATH_TRAVERSAL_DETECTED'
  )
})

symlinkTest('readFileMeta: 符号链接拒绝', () => {
  const root = makeTree()
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-target-'))
  fs.writeFileSync(path.join(target, 'linked.txt'), 'hello')
  fs.symlinkSync(path.join(target, 'linked.txt'), path.join(root, 'link.txt'))
  assert.throws(
    () => readFileMeta(root, 'link.txt'),
    (e) => e.code === 'SYMLINK_NOT_FOLLOWED'
  )
})

// ---- readTextContent ----

test('readTextContent: 文本文件原样返回', () => {
  const root = makeTree()
  const content = readTextContent(root, 'package.json')
  assert.equal(content, '{"name":"test"}')
})

test('readTextContent: 二进制文件抛 BINARY_FILE', () => {
  const root = makeTree()
  assert.throws(
    () => readTextContent(root, 'src/logo.png'),
    (e) => e.code === 'BINARY_FILE'
  )
})

test('readTextContent: 超过 maxBytes 抛 FILE_TOO_LARGE', () => {
  const root = makeTree()
  // 制造一个大文本文件
  const big = path.join(root, 'big.txt')
  fs.writeFileSync(big, 'x'.repeat(1024))
  assert.throws(
    () => readTextContent(root, 'big.txt', 512),
    (e) => e.code === 'FILE_TOO_LARGE'
  )
})

// ---- readFileForDownload ----

test('readFileForDownload: 返回 buffer + name + size', () => {
  const root = makeTree()
  const result = readFileForDownload(root, 'src/index.js')
  assert.equal(result.name, 'index.js')
  assert.equal(result.size, fs.statSync(path.join(root, 'src', 'index.js')).size)
  assert.ok(Buffer.isBuffer(result.buffer))
  assert.equal(result.buffer.toString('utf8'), 'export default {}')
})

test('readFileForDownload: 二进制文件可下载', () => {
  const root = makeTree()
  const result = readFileForDownload(root, 'src/logo.png')
  assert.equal(result.name, 'logo.png')
  assert.deepEqual(Array.from(result.buffer), [0x89, 0x50, 0x4e, 0x47])
})

test('readFileForDownload: 超过 maxBytes 拒绝', () => {
  const root = makeTree()
  const big = path.join(root, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(2048))
  assert.throws(
    () => readFileForDownload(root, 'big.bin', 1024),
    (e) => e.code === 'FILE_TOO_LARGE'
  )
})

symlinkTest('readFileForDownload: 符号链接拒绝', () => {
  const root = makeTree()
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-target-'))
  fs.writeFileSync(path.join(target, 'linked.txt'), 'hello')
  fs.symlinkSync(path.join(target, 'linked.txt'), path.join(root, 'link.txt'))
  assert.throws(
    () => readFileForDownload(root, 'link.txt'),
    (e) => e.code === 'SYMLINK_NOT_FOLLOWED'
  )
})

// ---- DEFAULTS 导出 ----

test('DEFAULTS: 暴露关键常量', () => {
  assert.equal(DEFAULTS.MAX_DEPTH, 10)
  assert.equal(DEFAULTS.MAX_FILES, 100_000)
  assert.equal(DEFAULTS.PREVIEW_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(DEFAULTS.FILE_MAX_BYTES, 100 * 1024 * 1024)
  assert.ok(Array.isArray(DEFAULTS.TEXT_EXTENSIONS))
  assert.ok(DEFAULTS.TEXT_EXTENSIONS.includes('.js'))
})
