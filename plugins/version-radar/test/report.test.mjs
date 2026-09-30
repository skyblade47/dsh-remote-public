// report.js 单测：默认不写 / report=1 才写 / 路径与内容断言（spec §8-6）
// 用法（仓库根目录）：node --test plugins/version-radar/test/report.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { maybeWriteReport, writeReport, buildReportMarkdown, reportFileName, defaultWorkspaceRoot } from '../lib/report.js'

const WS = join('sandbox', 'ws')
const TS = '2026-09-26T09:40:00Z'
const EXPECT = join(WS, 'DSH工具', '升级建议_2026-09-26T09-40-00Z.md')

const RESULT = {
  ok: true,
  target: '0.1.5-rc.3',
  verdict: '需人工判定',
  host: { version: '0.1.5-rc.1', source: 'argv[1]' },
  upstream: { ok: true, latest: '0.1.5-rc.3', next: '0.1.7-rc.2', alpha: null, error: null },
  thirdParty: [{ name: 'dshmarket', installed: '1.47.0', peers: [{ pkg: '@deepseek-ai/dsh', range: '^0.1.0-rc.7', satisfies: false }], supported: false }],
  ledgerTodo: [{ id: 'C-*', ask: '逐条核对代码级改动' }],
  rollback: { target: '/usr/local/dsh-release/0.1.5-rc.1', exists: true, manifestOk: true },
  reasons: ['存在第三方声明不支持'],
}

function makeStubFs() {
  const writes = []
  const dirs = []
  return {
    writes,
    dirs,
    mkdirSync(p) { dirs.push(p) },
    writeFileSync(p, d) { writes.push([p, String(d)]) },
  }
}

test('默认（enabled !== true）**绝不写盘**', () => {
  const fs = makeStubFs()
  const r = maybeWriteReport({ enabled: false, fs, workspaceRoot: WS, ts: TS, result: RESULT })
  assert.equal(r.written, false)
  assert.equal(r.file, null)
  assert.equal(fs.writes.length, 0)
  assert.equal(fs.dirs.length, 0)
})

test('report=1：写到 <DSH_WORKSPACE_ROOT>/DSH工具/升级建议_<ts>.md', () => {
  const fs = makeStubFs()
  const r = maybeWriteReport({ enabled: true, fs, workspaceRoot: WS, ts: TS, result: RESULT })
  assert.equal(r.written, true)
  assert.equal(r.ok, true)
  assert.equal(r.file, EXPECT)
  assert.deepEqual(fs.dirs, [join(WS, 'DSH工具')])
  assert.equal(fs.writes.length, 1)
  assert.equal(fs.writes[0][0], EXPECT)
})

test('报告内容 = 待办清单骨架（结论 / 事实 / 待办 / 第三方明细 / 只建议不执行）', () => {
  const md = buildReportMarkdown(RESULT, { ts: TS })
  assert.match(md, /待办清单/)
  assert.match(md, /需人工判定/)
  assert.match(md, /0\.1\.5-rc\.3/)
  assert.match(md, /- \[ \] `C-\*`/)
  assert.match(md, /dshmarket/)
  assert.match(md, /❌/)
  assert.match(md, /只建议、不执行/)
})

test('文件名与根目录口径', () => {
  assert.equal(reportFileName(TS), '升级建议_2026-09-26T09-40-00Z.md')
  assert.equal(defaultWorkspaceRoot({ DSH_WORKSPACE_ROOT: '/srv/ws' }), '/srv/ws')
  assert.equal(defaultWorkspaceRoot({}), '/srv/dsh-workspace')
})

test('写失败：返回 ok:false 且不抛（不阻断主流程）', () => {
  const fs = { mkdirSync() {}, writeFileSync() { throw new Error('EACCES') } }
  let r
  assert.doesNotThrow(() => { r = writeReport({ fs, workspaceRoot: WS, ts: TS, result: RESULT }) })
  assert.equal(r.ok, false)
  assert.equal(r.written, false)
  assert.match(r.error, /WRITE_FAIL/)
})
