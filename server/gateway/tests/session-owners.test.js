import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionOwnerStore, scanSessionIds } from '../src/session-owners.js'

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-owners-'))
  const store = createSessionOwnerStore(dir)
  const file = path.join(dir, 'session-owners.json')
  return { dir, store, file }
}

test('getOwner: 不存在的会话返回 null', () => {
  const { store } = makeCtx()
  assert.equal(store.getOwner('sess_none'), null)
})

test('setOwner: 写入后 getOwner 命中，且文件已落盘、JSON 结构正确', () => {
  const { store, file } = makeCtx()
  const ret = store.setOwner('sess_1', 'u_1')
  assert.deepEqual(ret, { sessionId: 'sess_1', userId: 'u_1' })
  assert.equal(store.getOwner('sess_1'), 'u_1')

  assert.ok(fs.existsSync(file))
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.deepEqual(onDisk.owners, { sess_1: 'u_1' })
})

test('setOwner: 覆盖已有归属后落盘为新值', () => {
  const { store, file } = makeCtx()
  store.setOwner('sess_2', 'u_A')
  const ret = store.setOwner('sess_2', 'u_B')
  assert.deepEqual(ret, { sessionId: 'sess_2', userId: 'u_B' })
  assert.equal(store.getOwner('sess_2'), 'u_B')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.owners.sess_2, 'u_B')
})

test('setOwner: 非法 sessionId / userId 抛 TypeError', () => {
  const { store } = makeCtx()
  assert.throws(() => store.setOwner('', 'u_1'), TypeError)
  assert.throws(() => store.setOwner(null, 'u_1'), TypeError)
  assert.throws(() => store.setOwner(undefined, 'u_1'), TypeError)
  assert.throws(() => store.setOwner(42, 'u_1'), TypeError)
  assert.throws(() => store.setOwner('   ', 'u_1'), TypeError)
  assert.throws(() => store.setOwner('sess_x', ''), TypeError)
  assert.throws(() => store.setOwner('sess_x', null), TypeError)
  assert.throws(() => store.setOwner('sess_x', 7), TypeError)
  assert.throws(() => store.setOwner('sess_x', '   '), TypeError)
})

test('listByOwner: 只返回该用户会话，多用户互不串', () => {
  const { store } = makeCtx()
  store.setOwner('s_a1', 'u_A')
  store.setOwner('s_a2', 'u_A')
  store.setOwner('s_b1', 'u_B')

  const a = store.listByOwner('u_A')
  const b = store.listByOwner('u_B')
  const none = store.listByOwner('u_nobody')

  assert.equal(a.length, 2)
  assert.ok(a.includes('s_a1'))
  assert.ok(a.includes('s_a2'))
  assert.ok(!a.includes('s_b1'))
  assert.deepEqual(b, ['s_b1'])
  assert.deepEqual(none, [])
})

test('listByOwner: 返回新数组，修改不影响内部', () => {
  const { store } = makeCtx()
  store.setOwner('s_x', 'u_X')
  const first = store.listByOwner('u_X')
  first.push('hacked')
  const second = store.listByOwner('u_X')
  assert.deepEqual(second, ['s_x'])
})

test('getAll: 返回 owners 浅拷贝，改返回值不影响内部', () => {
  const { store } = makeCtx()
  store.setOwner('s_1', 'u_1')
  const all = store.getAll()
  all.s_1 = 'hacked'
  all.s_2 = 'u_2'
  assert.equal(store.getOwner('s_1'), 'u_1')
  assert.equal(store.getOwner('s_2'), null)
  assert.deepEqual(store.getAll(), { s_1: 'u_1' })
})

test('migrateLegacy: 无主会话归 admin，已有归属跳过并计入 skipped', () => {
  const { store } = makeCtx()
  store.setOwner('s_owned', 'u_real')
  const result = store.migrateLegacy('u_admin', ['s_owned', 's_legacy_1', 's_legacy_2'])
  assert.equal(result.skipped, 1)
  assert.equal(result.migrated.length, 2)
  assert.ok(result.migrated.includes('s_legacy_1'))
  assert.ok(result.migrated.includes('s_legacy_2'))
  assert.equal(store.getOwner('s_owned'), 'u_real')
  assert.equal(store.getOwner('s_legacy_1'), 'u_admin')
  assert.equal(store.getOwner('s_legacy_2'), 'u_admin')
})

test('migrateLegacy: 重复调用幂等（第二次全部跳过）', () => {
  const { store } = makeCtx()
  const ids = ['s_m1', 's_m2', 's_m3']
  const first = store.migrateLegacy('u_admin', ids)
  assert.deepEqual(first.migrated.sort(), ['s_m1', 's_m2', 's_m3'])
  assert.equal(first.skipped, 0)

  const second = store.migrateLegacy('u_admin', ids)
  assert.deepEqual(second.migrated, [])
  assert.equal(second.skipped, 3)

  for (const id of ids) assert.equal(store.getOwner(id), 'u_admin')
})

test('migrateLegacy: 有迁移时只触发一次原子落盘', () => {
  const { store } = makeCtx()
  const rename = fs.renameSync
  let writes = 0
  fs.renameSync = function (tmp, target) {
    writes += 1
    return rename.call(fs, tmp, target)
  }
  try {
    store.setOwner('s_owned', 'u_real')
    writes = 0
    const result = store.migrateLegacy('u_admin', ['s_owned', 's_l1', 's_l2', 's_l3'])
    assert.equal(result.skipped, 1)
    assert.equal(result.migrated.length, 3)
    assert.equal(writes, 1)
  } finally {
    fs.renameSync = rename
  }
})

test('migrateLegacy: 全部已归属时不落盘', () => {
  const { store } = makeCtx()
  store.setOwner('s_1', 'u_real')
  const rename = fs.renameSync
  let writes = 0
  fs.renameSync = function (tmp, target) {
    writes += 1
    return rename.call(fs, tmp, target)
  }
  try {
    const result = store.migrateLegacy('u_admin', ['s_1'])
    assert.deepEqual(result.migrated, [])
    assert.equal(result.skipped, 1)
    assert.equal(writes, 0)
  } finally {
    fs.renameSync = rename
  }
})

test('原子写：连续 setOwner 后文件始终是合法 JSON 且无 tmp 残留', () => {
  const { dir, store, file } = makeCtx()
  for (let i = 0; i < 50; i++) {
    store.setOwner(`sess_${i}`, `u_${i % 3}`)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(Object.keys(parsed.owners).length, i + 1)
  }
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'))
  assert.equal(leftovers.length, 0)
  assert.equal(store.getOwner('sess_49'), 'u_1')
})

test('损坏文件不致命：回退到空结构并可继续写入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-owners-broken-'))
  const file = path.join(dir, 'session-owners.json')
  fs.writeFileSync(file, '{ not valid json', 'utf8')
  const store = createSessionOwnerStore(dir)
  assert.equal(store.getOwner('s_old'), null)
  store.setOwner('s_new', 'u_new')
  assert.equal(store.getOwner('s_new'), 'u_new')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.deepEqual(onDisk.owners, { s_new: 'u_new' })
})

function makeSessionLeaf(root, bucket, sessionId) {
  const dir = path.join(root, bucket, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'x', 'utf8')
}

test('scanSessionIds: 枚举各桶内带标记文件的会话目录并排序去重', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-scan-'))
  makeSessionLeaf(root, '--bucket-a--', 'session-zzz')
  makeSessionLeaf(root, '--bucket-a--', 'session-aaa')
  makeSessionLeaf(root, '--bucket-b--', 'session-aaa')
  makeSessionLeaf(root, '--bucket-b--', 'bare-uuid')
  const ids = scanSessionIds(root)
  assert.deepEqual(ids, ['bare-uuid', 'session-aaa', 'session-zzz'])
})

test('scanSessionIds: 排除扁平备份桶、无标记目录与文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-scan-excl-'))
  fs.mkdirSync(path.join(root, '_header-rewrite-backups'), { recursive: true })
  fs.writeFileSync(path.join(root, '_header-rewrite-backups', 'session-dead.session.jsonl.zstd.bak'), 'x', 'utf8')
  fs.mkdirSync(path.join(root, '--real--', 'no-marker'), { recursive: true })
  fs.writeFileSync(path.join(root, '--real--', 'flat.jsonl.zstd'), 'x', 'utf8')
  makeSessionLeaf(root, '--real--', 'session-keep')
  assert.deepEqual(scanSessionIds(root), ['session-keep'])
})

test('scanSessionIds: 根目录不存在时返回空数组', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-missing-')), 'nope')
  assert.deepEqual(scanSessionIds(root), [])
})
