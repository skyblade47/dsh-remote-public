// @local/dsh-adapter —— 重启自恢复：幂等状态单测
//
// 迁入来源：`plugins/resume-on-boot/test/state.test.mjs`（用例语义保持不变，import 路径改到 lib/resume/）。
// 覆盖 P3 §Phase 1C 点名的用例：①同 key 二次不重复 ②同 sessionId 新 key 可再次唤醒（D3 核心）
// ③损坏文件不抛；外加落盘/重载、prune、写失败降级（不阻塞内核启动）、DSH_HOME 派生与配置覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ResumeState, resolveStatePath, statePathForHome } from '../lib/resume/state.js'

function newDir() {
  return mkdtempSync(join(tmpdir(), 'rob-state-'))
}

test('resolveStatePath：由 DSH_HOME 派生 <home>/users/resume-state.json（Windows/Linux 同口径）', () => {
  const flat = (p) => String(p).replace(/\\/g, '/')
  assert.equal(flat(resolveStatePath({ DSH_HOME: '/srv/dsh-home' })), '/srv/dsh-home/users/resume-state.json')
  assert.equal(flat(resolveStatePath({ DSH_HOME: 'C:/dsh-data' })), 'C:/dsh-data/users/resume-state.json')
  // 空白变量视同未设，不拼出 "/users/..." 这种奇怪路径
  assert.ok(!flat(resolveStatePath({ DSH_HOME: '   ' })).startsWith('/users/'))
})

test('statePathForHome：adapter 已推导出 DSH_HOME 时直接用它（不再读一次 env）', () => {
  const flat = (p) => String(p).replace(/\\/g, '/')
  assert.equal(flat(statePathForHome('/srv/dsh-home')), '/srv/dsh-home/users/resume-state.json')
  // 空 home → 退回 resolveStatePath 口径（不抛）
  assert.ok(flat(statePathForHome('')).endsWith('/users/resume-state.json'))
  assert.ok(flat(statePathForHome(undefined)).endsWith('/users/resume-state.json'))
})

test('load：文件不存在 → 空态且 fresh，不抛', () => {
  const dir = newDir()
  try {
    const st = new ResumeState({ path: join(dir, 'users', 'resume-state.json') })
    const r = st.load()
    assert.equal(r.ok, true)
    assert.equal(r.fresh, true)
    assert.equal(r.entries, 0)
    assert.deepEqual(st.summary().entries, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('①同 key 二次不重复：markResumed 后 isResumed 为真；换 key 为假', () => {
  const dir = newDir()
  try {
    const st = new ResumeState({ path: join(dir, 'resume-state.json') })
    st.load()
    assert.equal(st.isResumed('s1', 'turn:4'), false)
    assert.equal(st.markResumed('s1', 'turn:4', { signal: 'turn' }), true)
    assert.equal(st.isResumed('s1', 'turn:4'), true)
    assert.equal(st.isResumed('s1', 'turn:5'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('②D3 核心：同一会话"第二次中断"（新 key）必须能再次唤醒', () => {
  const dir = newDir()
  try {
    const path = join(dir, 'resume-state.json')
    const st = new ResumeState({ path })
    st.load()
    st.markResumed('s1', 'turn:4')
    assert.equal(st.isResumed('s1', 'turn:4'), true, '第一次中断已处理')

    // 重新加载（模拟内核重启）后，新的一次中断仍是"未处理"
    const st2 = new ResumeState({ path })
    st2.load()
    assert.equal(st2.isResumed('s1', 'turn:4'), true)
    assert.equal(st2.isResumed('s1', 'turn:9'), false, '新中断不得被旧记录挡住 —— 否则永不恢复')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('②-b D6：P1 的 `sub:<parent>` 键与 P0 的 `turn:<n>` 键彼此独立', () => {
  const dir = newDir()
  try {
    const st = new ResumeState({ path: join(dir, 'resume-state.json') })
    st.load()
    st.markResumed('session-p', 'sub:session-p', { signal: 'P1' })
    assert.equal(st.isResumed('session-p', 'sub:session-p'), true)
    assert.equal(st.isResumed('session-p', 'turn:7'), false, 'P1 处理过，不等于 P0 处理过')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('落盘与重载：markResumed 后新实例能读到（模拟重启）', () => {
  const dir = newDir()
  try {
    const path = join(dir, 'sub', 'resume-state.json')
    const st = new ResumeState({ path })
    st.load()
    st.markResumed('s1', 'task:t1', { signal: 'task' })
    assert.equal(existsSync(path), true, '目录应被自动创建')

    const st2 = new ResumeState({ path })
    const r = st2.load()
    assert.equal(r.entries, 1)
    assert.equal(st2.isResumed('s1', 'task:t1'), true)
    assert.equal(st2.degraded, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③损坏文件：不抛，按空态继续，并另存 .corrupt 留证', () => {
  const dir = newDir()
  try {
    const path = join(dir, 'resume-state.json')
    writeFileSync(path, '{ this is not json', 'utf8')
    const warns = []
    const st = new ResumeState({ path, log: { warn: (m) => warns.push(m) } })
    const r = st.load()
    assert.equal(r.ok, false)
    assert.equal(r.error, 'PARSE_FAILED')
    assert.equal(r.entries, 0)
    assert.equal(existsSync(path + '.corrupt'), true, '坏文件必须留证，不能静默丢')
    assert.equal(warns.length, 1)
    // 之后仍可正常写入
    assert.equal(st.markResumed('s1', 'turn:1'), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('写失败降级：路径不可写时 markResumed 返回 false、内存态仍生效、degraded 置位、不抛', () => {
  const dir = newDir()
  try {
    // 用"文件"占住父目录名，使 mkdirSync/写入必然失败
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const warns = []
    const st = new ResumeState({ path: join(blocker, 'nested', 'resume-state.json'), log: { warn: (m) => warns.push(m) } })
    st.load()
    const ok = st.markResumed('s1', 'turn:1')
    assert.equal(ok, false, '落盘失败要如实返回 false')
    assert.equal(st.isResumed('s1', 'turn:1'), true, '内存态仍需生效（内核不能因此起不来）')
    assert.equal(st.degraded, true)
    assert.ok(warns.length >= 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('prune：清理过期记录并落盘；未过期保留', () => {
  const dir = newDir()
  try {
    const path = join(dir, 'resume-state.json')
    const st = new ResumeState({ path })
    st.load()
    st.markResumed('old', 'turn:1')
    st.markResumed('new', 'turn:2')
    st.records.old.at = Date.now() - 40 * 24 * 3600 * 1000 // 40 天前
    const removed = st.prune({ maxAgeMs: 30 * 24 * 3600 * 1000 })
    assert.equal(removed, 1)
    assert.equal(st.isResumed('old', 'turn:1'), false)
    assert.equal(st.isResumed('new', 'turn:2'), true)

    const st2 = new ResumeState({ path })
    st2.load()
    assert.equal(st2.summary().entries, 1, '清理结果应已落盘')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('markResumed：缺参数不写、不抛', () => {
  const dir = newDir()
  try {
    mkdirSync(dir, { recursive: true })
    const st = new ResumeState({ path: join(dir, 'resume-state.json') })
    st.load()
    assert.equal(st.markResumed('', 'turn:1'), false)
    assert.equal(st.markResumed('s1', ''), false)
    assert.equal(st.summary().entries, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
