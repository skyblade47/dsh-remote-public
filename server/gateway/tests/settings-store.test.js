import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore } from '../src/settings-store.js'

function makeDir(prefix = 'settings-store-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('默认关闭公开注册并落盘 settings.json', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  assert.equal(store.isPublicRegistrationAllowed(), false)
  assert.equal(store.getAll().allowPublicRegistration, false)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(onDisk.allowPublicRegistration, false)
  assert.equal(onDisk.version, 1)
})

test('update 持久化并可在新实例中读回', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  const updated = store.update({ allowPublicRegistration: true })
  assert.equal(updated.allowPublicRegistration, true)
  assert.equal(store.isPublicRegistrationAllowed(), true)

  const reopened = createSettingsStore(dir)
  assert.equal(reopened.isPublicRegistrationAllowed(), true)
})

test('getAll 返回副本，外部修改不影响内部状态', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  const snapshot = store.getAll()
  snapshot.allowPublicRegistration = true
  assert.equal(store.isPublicRegistrationAllowed(), false)
})

test('配置文件损坏时回退默认值而不是抛错', () => {
  const dir = makeDir()
  fs.writeFileSync(path.join(dir, 'settings.json'), '{坏 json')
  const store = createSettingsStore(dir)
  assert.equal(store.isPublicRegistrationAllowed(), false)
})

test('仅显式 true 才视为开放注册', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  store.update({ allowPublicRegistration: 'yes' })
  assert.equal(store.isPublicRegistrationAllowed(), false)
  store.update({ allowPublicRegistration: 1 })
  assert.equal(store.isPublicRegistrationAllowed(), false)
})

// ============================================================================
// T-1.b 阶段② 开关 `wsOwnerStrict`（2026-09-27 新增）
// ============================================================================

test('wsOwnerStrict 默认 false，且落盘可见（部署时 = 阶段① 姿态）', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  assert.equal(store.isWsOwnerStrict(), false)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(onDisk.wsOwnerStrict, false)
})

test('仅显式 true 才视为收紧（缺失 / 非布尔一律按 false）', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  for (const v of ['yes', 1, 'true', null, {}]) {
    store.update({ wsOwnerStrict: v })
    assert.equal(store.isWsOwnerStrict(), false, JSON.stringify(v))
  }
  store.update({ wsOwnerStrict: true })
  assert.equal(store.isWsOwnerStrict(), true)
})

test('🔄 直接编辑 settings.json ⇒ 立即生效（无需重启、无需重建实例）', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  assert.equal(store.isWsOwnerStrict(), false)

  // 模拟"运维手改文件"：这是窗口里翻转阶段② 的操作方式
  const f = path.join(dir, 'settings.json')
  const cur = JSON.parse(fs.readFileSync(f, 'utf8'))
  fs.writeFileSync(f, JSON.stringify({ ...cur, wsOwnerStrict: true }, null, 2), 'utf8')

  assert.equal(store.isWsOwnerStrict(), true, '同一实例应立刻读到新值')
  assert.equal(store.getAll().wsOwnerStrict, true)

  // 改回去同样立即生效
  fs.writeFileSync(f, JSON.stringify({ ...cur, wsOwnerStrict: false }, null, 2), 'utf8')
  assert.equal(store.isWsOwnerStrict(), false)
})

test('update() 不会覆盖外部手改的值（两条写路径共用同一个文件）', () => {
  const dir = makeDir()
  const store = createSettingsStore(dir)
  const f = path.join(dir, 'settings.json')
  fs.writeFileSync(f, JSON.stringify({ version: 1, allowPublicRegistration: false, wsOwnerStrict: true }, null, 2), 'utf8')

  store.update({ allowPublicRegistration: true }) // ← 内存里是旧值，若不先重读就会把 wsOwnerStrict 抹掉
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(onDisk.wsOwnerStrict, true, 'wsOwnerStrict 必须保留')
  assert.equal(onDisk.allowPublicRegistration, true)
})
