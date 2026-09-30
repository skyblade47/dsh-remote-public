import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceStore, resolveWorkspacesRoot, isValidWorkspaceId } from '../src/workspace-store.js'

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-store-'))
  const root = path.join(dir, 'workspaces')
  const store = createWorkspaceStore(root)
  return { dir, root, store }
}

test('resolveWorkspacesRoot: 优先 DSH_GATEWAY_DATA_DIR', () => {
  const env = { DSH_GATEWAY_DATA_DIR: '/data', DSH_HOME: '/home' }
  assert.equal(resolveWorkspacesRoot(env), path.join('/data', 'workspaces'))
})

test('resolveWorkspacesRoot: 回退到 DSH_HOME', () => {
  const env = { DSH_HOME: '/home' }
  assert.equal(resolveWorkspacesRoot(env), path.join('/home', 'workspaces'))
})

test('resolveWorkspacesRoot: 最终回退到 ./dsh-data', () => {
  assert.equal(resolveWorkspacesRoot({}), path.join('./dsh-data', 'workspaces'))
})

test('createWorkspace: 创建工作区目录与元信息文件', () => {
  const { store, root } = makeCtx()
  const meta = store.createWorkspace({ userId: 'u_1', name: 'my-plugin' })
  assert.ok(meta.id.startsWith('ws_'))
  assert.equal(meta.ownerId, 'u_1')
  assert.equal(meta.name, 'my-plugin')
  assert.equal(meta.version, 1)
  assert.equal(meta.cwd, '/')
  assert.deepEqual(meta.tags, [])
  assert.ok(meta.createdAt > 0)
  assert.ok(meta.createdAtIso)

  // 物理目录存在
  const dir = path.join(root, 'u_1', meta.id)
  assert.ok(fs.existsSync(dir))
  // 元信息文件存在且内容正确
  const metaFile = path.join(dir, '.dsh-workspace.json')
  assert.ok(fs.existsSync(metaFile))
  const onDisk = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
  assert.equal(onDisk.id, meta.id)
})

test('createWorkspace: name 缺省为 untitled', () => {
  const { store } = makeCtx()
  const meta = store.createWorkspace({ userId: 'u_2' })
  assert.equal(meta.name, 'untitled')
})

test('createWorkspace: name 超过 128 字符被截断', () => {
  const { store } = makeCtx()
  const longName = 'a'.repeat(200)
  const meta = store.createWorkspace({ userId: 'u_3', name: longName })
  assert.equal(meta.name.length, 128)
})

test('createWorkspace: ID 几乎不碰撞（连续创建 50 个不重复）', () => {
  const { store } = makeCtx()
  const ids = new Set()
  for (let i = 0; i < 50; i++) {
    const m = store.createWorkspace({ userId: 'u_4', name: `ws-${i}` })
    assert.ok(!ids.has(m.id), `碰撞于 ${m.id}`)
    ids.add(m.id)
  }
})

test('createWorkspace: 超过上限抛 WORKSPACE_LIMIT_REACHED', () => {
  const { store } = makeCtx()
  // MAX_WORKSPACES_PER_USER = 50
  for (let i = 0; i < 50; i++) {
    store.createWorkspace({ userId: 'u_5', name: `ws-${i}` })
  }
  assert.throws(
    () => store.createWorkspace({ userId: 'u_5', name: 'overflow' }),
    (e) => e.code === 'WORKSPACE_LIMIT_REACHED'
  )
})

test('getWorkspaceMeta: 存在的工作区返回 meta', () => {
  const { store } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_6', name: 'foo' })
  const got = store.getWorkspaceMeta('u_6', m.id)
  assert.ok(got)
  assert.equal(got.id, m.id)
  assert.equal(got.name, 'foo')
})

test('getWorkspaceMeta: 不存在的工作区返回 null', () => {
  const { store } = makeCtx()
  assert.equal(store.getWorkspaceMeta('u_x', 'ws_nope'), null)
})

test('getWorkspaceMeta: 跨用户隔离（A 无法读到 B 的工作区）', () => {
  const { store } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_A', name: 'alice-ws' })
  // A 自己可以读
  assert.ok(store.getWorkspaceMeta('u_A', m.id))
  // B 用相同 workspaceId 读自己的目录，返回 null（不存在）
  assert.equal(store.getWorkspaceMeta('u_B', m.id), null)
})

test('listWorkspaces: 返回某用户所有工作区，按创建时间倒序', async () => {
  const { store } = makeCtx()
  const m1 = store.createWorkspace({ userId: 'u_7', name: 'first' })
  // 🔴 这里**必须真的等**（U-35）：`createWorkspace` 的 `createdAt` 取 `Date.now()`（**ms**），
  //    而 `listWorkspaces` 的 `sort` 只比 `createdAt`、**没有次级键** ⇒ 两次创建落在同一毫秒
  //    就是**平局**，顺序由引擎决定（实测约 1/3 概率失败）。
  //    ⚠️ 本行上方原先只有一句注释"等一小段时间确保时间戳不同"，**但代码里并没有等** ——
  //       测的是"排序"，不该依赖运气。下面让出事件循环直到毫秒真的推进（毫秒分辨率 ⇒ 至多几轮）。
  const t0 = Date.now()
  while (Date.now() === t0) await new Promise((r) => setImmediate(r))
  const m2 = store.createWorkspace({ userId: 'u_7', name: 'second' })
  assert.notEqual(m2.createdAt, m1.createdAt, '两次创建的 createdAt 必须不同，否则排序断言无意义')
  const list = store.listWorkspaces('u_7')
  assert.equal(list.length, 2)
  // 倒序：second 在前
  assert.equal(list[0].id, m2.id)
  assert.equal(list[1].id, m1.id)
})

test('listWorkspaces: createdAt **并列**时按 id 倒序（顺序恒定，不再依赖引擎）', () => {
  // 见 roadmap §8 U-35：`createdAt` 是 ms 级，同毫秒创建的两个工作区会平局。
  // 上面那条用例靠"等到毫秒推进"避开平局；这条**故意制造平局**，钉住次级键的行为。
  const { root, store } = makeCtx()
  const a = store.createWorkspace({ userId: 'u_tie', name: 'a' })
  const b = store.createWorkspace({ userId: 'u_tie', name: 'b' })
  assert.notEqual(a.id, b.id)

  const SAME = 1750000000000
  for (const m of [a, b]) {
    const p = path.join(root, 'u_tie', m.id, '.dsh-workspace.json')
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'))
    meta.createdAt = SAME
    fs.writeFileSync(p, JSON.stringify(meta))
  }

  const ids = store.listWorkspaces('u_tie').map((m) => m.id)
  assert.equal(ids.length, 2)
  // 期望 = 按 id 倒序（与实现同一套纯码点比较，不引入 locale 依赖）
  const expect = [...ids].sort((x, y) => (y > x ? 1 : y < x ? -1 : 0))
  assert.deepEqual(ids, expect, '平局时必须按 id 倒序')
  // 多次调用顺序一致
  assert.deepEqual(store.listWorkspaces('u_tie').map((m) => m.id), ids)
})

test('listWorkspaces: 无工作区返回空数组', () => {
  const { store } = makeCtx()
  const list = store.listWorkspaces('u_empty')
  assert.deepEqual(list, [])
})

test('listWorkspaces: 跳过临时文件与隐藏目录', () => {
  const { store, root } = makeCtx()
  store.createWorkspace({ userId: 'u_8', name: 'real' })
  // 手动制造一些噪声
  const userDir = path.join(root, 'u_8')
  fs.mkdirSync(path.join(userDir, '.hidden-dir'), { recursive: true })
  fs.writeFileSync(path.join(userDir, 'stray.tmp'), 'x')
  fs.writeFileSync(path.join(userDir, 'loose.json'), '{}')
  const list = store.listWorkspaces('u_8')
  // 只看到真实工作区
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'real')
})

test('deleteWorkspace: 删除已存在工作区', () => {
  const { store, root } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_9', name: 'todelete' })
  const dir = path.join(root, 'u_9', m.id)
  assert.ok(fs.existsSync(dir))
  const ok = store.deleteWorkspace('u_9', m.id)
  assert.equal(ok, true)
  assert.ok(!fs.existsSync(dir))
})

test('deleteWorkspace: 删除不存在的工作区返回 false', () => {
  const { store } = makeCtx()
  const ok = store.deleteWorkspace('u_10', 'ws_nope')
  assert.equal(ok, false)
})

test('deleteWorkspace: 非法工作区 ID 拒绝', () => {
  const { store } = makeCtx()
  // 防止路径注入：尝试路径分隔符或 .. 注入
  assert.throws(
    () => store.deleteWorkspace('u_11', '../../etc'),
    (e) => e.code === 'INVALID_WORKSPACE_ID'
  )
  assert.throws(
    () => store.deleteWorkspace('u_11', 'ws_x/y'),
    (e) => e.code === 'INVALID_WORKSPACE_ID'
  )
  assert.throws(
    () => store.deleteWorkspace('u_11', 'not_ws_prefix'),
    (e) => e.code === 'INVALID_WORKSPACE_ID'
  )
})

test('updateMeta: 更新名称', () => {
  const { store } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_12', name: 'old' })
  const updated = store.updateMeta('u_12', m.id, { name: 'new-name' })
  assert.equal(updated.name, 'new-name')
  // 落盘
  const reread = store.getWorkspaceMeta('u_12', m.id)
  assert.equal(reread.name, 'new-name')
})

test('updateMeta: tags 更新', () => {
  const { store } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_13', name: 'tagged' })
  const updated = store.updateMeta('u_13', m.id, { tags: ['plugin', 'test'] })
  assert.deepEqual(updated.tags, ['plugin', 'test'])
})

test('updateMeta: 工作区不存在返回 null', () => {
  const { store } = makeCtx()
  assert.equal(store.updateMeta('u_14', 'ws_nope', { name: 'x' }), null)
})

test('workspaceDir: 返回物理路径', () => {
  const { store, root } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_15', name: 'p' })
  const dir = store.workspaceDir('u_15', m.id)
  assert.equal(dir, path.join(root, 'u_15', m.id))
})

test('原子写：元信息文件不会半写（删除 tmp 文件后 rename 成功）', () => {
  const { store, root } = makeCtx()
  const m = store.createWorkspace({ userId: 'u_16', name: 'atomic' })
  const metaFile = path.join(root, 'u_16', m.id, '.dsh-workspace.json')
  // 检查没有 .tmp 文件残留
  const dir = path.dirname(metaFile)
  const tmps = fs.readdirSync(dir).filter((n) => n.includes('.tmp'))
  assert.equal(tmps.length, 0)
})

test('并发创建：多用户独立目录', () => {
  const { store, root } = makeCtx()
  const a = store.createWorkspace({ userId: 'u_A', name: 'a1' })
  const b = store.createWorkspace({ userId: 'u_B', name: 'b1' })
  assert.notEqual(a.id, b.id)
  // 物理目录隔离
  assert.ok(fs.existsSync(path.join(root, 'u_A', a.id)))
  assert.ok(fs.existsSync(path.join(root, 'u_B', b.id)))
  assert.ok(!fs.existsSync(path.join(root, 'u_A', b.id)))
})

test('isValidWorkspaceId 白名单', () => {
  assert.equal(isValidWorkspaceId('ws_2f9c1a8e'), true)
  assert.equal(isValidWorkspaceId('WS_ABC'), true)
  assert.equal(isValidWorkspaceId('ws_x'), true)
  assert.equal(isValidWorkspaceId('../etc'), false)
  assert.equal(isValidWorkspaceId('ws_x/y'), false)
  assert.equal(isValidWorkspaceId('ws_..'), false)
  assert.equal(isValidWorkspaceId('notprefix'), false)
  assert.equal(isValidWorkspaceId(''), false)
  assert.equal(isValidWorkspaceId(null), false)
  assert.equal(isValidWorkspaceId(42), false)
})

test('findWorkspaceOwner: 定位到属主并返回 meta', () => {
  const { store } = makeCtx()
  const a = store.createWorkspace({ userId: 'u_A', name: 'alice' })
  const found = store.findWorkspaceOwner(a.id)
  assert.ok(found)
  assert.equal(found.userId, 'u_A')
  assert.equal(found.meta.id, a.id)
  assert.equal(found.meta.name, 'alice')
})

test('findWorkspaceOwner: B 的同名分桶不影响定位 A', () => {
  const { store } = makeCtx()
  const a = store.createWorkspace({ userId: 'u_A', name: 'a' })
  store.createWorkspace({ userId: 'u_B', name: 'b' })
  const found = store.findWorkspaceOwner(a.id)
  assert.equal(found.userId, 'u_A')
})

test('findWorkspaceOwner: 不存在 / 非法 ID / 空根目录返回 null', () => {
  const { store } = makeCtx()
  assert.equal(store.findWorkspaceOwner('ws_deadbeef'), null)
  assert.equal(store.findWorkspaceOwner('../../etc'), null)
})

test('findWorkspaceOwner: 根目录尚不存在时安全返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-emptyroot-'))
  const root = path.join(dir, 'never-created-workspaces')
  const store = createWorkspaceStore(root) // createWorkspaceStore 会 mkdir，故改用删除后场景
  fs.rmSync(root, { recursive: true, force: true })
  assert.equal(store.findWorkspaceOwner('ws_abcd1234'), null)
})
