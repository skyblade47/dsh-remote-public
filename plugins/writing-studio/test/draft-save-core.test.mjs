// U-37：draft-save 纯模块真单测（无宿主依赖 ⇒ 本地可真跑）。
// 覆盖计划 §5 验收判据 1–4 的**纯逻辑**部分（HTTP 层由 draft-save-wiring.test.mjs 静态锁）。
// 用法（仓库根目录）：node --test plugins/writing-studio/test/draft-save-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRelPath,
  decideWrite,
  checkSize,
  versionOf,
  SIZE_LIMIT,
  DRAFT_SAVE_PREFIX
} from '../lib/draft-save-core.js'

// ---------- validateRelPath：白名单放行 ----------
test('① 白名单放行：写作训练/草稿/**.md（顶层 + 子目录）', () => {
  for (const p of [
    '写作训练/草稿/第三章.md',
    '写作训练/草稿/心渊纪元/第三章.md',
    '写作训练/草稿/心渊纪元/第一卷/第三章.md',
    '写作训练/草稿/README.MD' // 后缀大小写不敏感（对齐列举口径 /\.md$/i）
  ]) {
    const r = validateRelPath(p)
    assert.equal(r.ok, true, p)
    assert.equal(r.rel, p)
  }
  assert.equal(DRAFT_SAVE_PREFIX, '写作训练/草稿/')
})

// ---------- validateRelPath：白名单拒绝（§5-1 各种形态） ----------
test('② 越界/非法形态一律 400 BAD_PATH', () => {
  const bad = [
    ['../x.md', '相对上跳'],
    ['写作训练/草稿/../x.md', '越界子目录'],
    ['/etc/x.md', '绝对路径'],
    ['/写作训练/草稿/x.md', '绝对路径（前缀同形也不行）'],
    ['C:/写作训练/草稿/x.md', '盘符'],
    ['C:\\写作训练\\草稿\\x.md', '盘符 + 反斜杠'],
    ['a\\b.md', '含反斜杠（不静默转换）'],
    ['写作训练\\草稿\\x.md', '反斜杠分隔'],
    ['写作训练/草稿/x.txt', '非 .md 后缀'],
    ['写作训练/草稿/x.md.bak', '伪后缀'],
    ['写作训练/作品库.json', '越出草稿子树'],
    ['写作训练/草稿', '目录本身'],
    ['写作训练/草稿/', '目录本身（尾斜杠）'],
    ['写作训练/草稿//x.md', '空路径段'],
    ['写作训练/草稿/./x.md', '. 路径段'],
    ['灵感库/灵感库.json', '完全不相干'],
    ['', '空串'],
    [undefined, '缺失'],
    [null, 'null'],
    [123, '非字符串'],
    ['写作训练/草稿/坏\u0000名.md', '控制字符']
  ]
  for (const [p, why] of bad) {
    const r = validateRelPath(p)
    assert.equal(r.ok, false, why + ' 应被拒: ' + String(p))
    assert.equal(r.code, 'BAD_PATH', why)
    assert.ok(r.message, why + ' 需带 message')
  }
  // 反斜杠是**直接拒绝**，不得被规范化成 `/` 后放行
  assert.equal(validateRelPath('写作训练/草稿/a\\b.md').ok, false)
})

// ---------- decideWrite：默认不覆盖（§5-4 两种 409 + force 覆盖 + 首次写） ----------
test('③ 不存在 ⇒ create（首次保存 created:true 的决策侧）', () => {
  assert.deepEqual(decideWrite({ exists: false }), { action: 'create' })
  assert.deepEqual(decideWrite({ exists: false, baseVersion: 'whatever', force: false }), { action: 'create' })
})

test('④ 存在但未给 baseVersion/force ⇒ 409 VERSION_CONFLICT（第 1 种）', () => {
  const r = decideWrite({ exists: true, baseVersion: undefined, force: false, currentVersion: 'v1-aaaa' })
  assert.equal(r.action, 'conflict')
  assert.equal(r.code, 'VERSION_CONFLICT')
  assert.ok(r.message)
  // 空串同样视为"未给"
  assert.equal(decideWrite({ exists: true, baseVersion: '', currentVersion: 'v1-aaaa' }).action, 'conflict')
})

test('⑤ 存在 + baseVersion 不匹配 ⇒ 409 VERSION_CONFLICT（第 2 种）', () => {
  const r = decideWrite({ exists: true, baseVersion: 'v1-wrong', currentVersion: 'v1-right' })
  assert.equal(r.action, 'conflict')
  assert.equal(r.code, 'VERSION_CONFLICT')
  const r2 = decideWrite({ exists: true, baseVersion: 'v1-x', currentVersion: null })
  assert.equal(r2.action, 'conflict')
})

test('⑥ 存在 + baseVersion 匹配 ⇒ overwrite（版本一致的覆盖；同内容即幂等）', () => {
  const r = decideWrite({ exists: true, baseVersion: 'v1-same', currentVersion: 'v1-same' })
  assert.deepEqual(r, { action: 'overwrite' })
})

test('⑦ force:true ⇒ 无条件覆盖（含未给 baseVersion）', () => {
  assert.deepEqual(decideWrite({ exists: true, force: true }), { action: 'overwrite' })
  assert.deepEqual(decideWrite({ exists: true, force: true, baseVersion: 'v1-wrong', currentVersion: 'v1-right' }), { action: 'overwrite' })
})

// ---------- versionOf：稳定 + 可比较相等（幂等判定） ----------
test('⑧ versionOf 稳定且可比较相等（同内容 ⇒ 同串；异内容 ⇒ 异串）', () => {
  const a = versionOf('第三章正文\n内容')
  const b = versionOf('第三章正文\n内容')
  assert.equal(a, b)
  assert.notEqual(a, versionOf('第三章正文\n内容 '))
  assert.notEqual(a, versionOf(''))
  assert.equal(versionOf(''), versionOf('')) // 空内容也稳定
  assert.equal(typeof a, 'string')
  assert.ok(a.startsWith('v1-'))
})

test('⑨ 幂等语义：同路径再保存同内容 ⇒ 版本一致 ⇒ 走 overwrite（不新建文件）', () => {
  // 模拟：首次 create 拿到 versionOf(content)；再次提交同一 content + 该 version
  const content = '心渊纪元 第三章 正文……'
  const v1 = versionOf(content)
  const first = decideWrite({ exists: false })
  assert.equal(first.action, 'create')
  // 第二次：文件已存在，当前版本 = v1，客户端回传 baseVersion = v1
  const second = decideWrite({ exists: true, baseVersion: v1, currentVersion: versionOf(content) })
  assert.deepEqual(second, { action: 'overwrite' }) // 覆盖同一路径，不产生新文件
})

// ---------- checkSize：413（§5 超限） ----------
test('⑩ 大小闸：≤ 2 MiB 放行；超出 ⇒ 413 TOO_LARGE', () => {
  assert.equal(SIZE_LIMIT, 2 * 1024 * 1024)
  assert.equal(checkSize(0).ok, true)
  assert.equal(checkSize(SIZE_LIMIT).ok, true)       // 边界（等于上限）放行
  assert.equal(checkSize(SIZE_LIMIT + 1).ok, false)  // 超 1 字节即拒
  const r = checkSize(SIZE_LIMIT + 1)
  assert.equal(r.code, 'TOO_LARGE')
  assert.ok(r.message)
  assert.equal(checkSize(2 * 1024 * 1024 + 999).code, 'TOO_LARGE')
})
