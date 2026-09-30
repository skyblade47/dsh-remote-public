// U-50（2026-09-30）：归档口径契约锁 —— 由 agent 排查报出的 F-1 / F-2
// 用法（仓库根目录）：node --test plugins/taskkit/test/u50-archived-guard.test.mjs
//
// 背景（两条**实锤**）：
//   F-1：`tsk_archive` 自我声明「移出侧栏/**不可被派发**」，而 `tsk_sessions` 直接 `agents.list()`
//        列出全部 live agent、完全不看归档集 ⇒ 同一插件内两处口径矛盾；派发口也完全不查。
//   F-2：`tsk_archive` 有三处静默（`wr` 缺失 / 无 `archiveSession` 接口 / 空标题跳过改名），
//        且成功判定是 `archived || renamed`、`ok` 恒 true ⇒ **归档压根没做也会报"成功"**（假成功）。
//
// ⚠️ 诚实标注：这两条的主体逻辑写在 `apply()` 闭包里（依赖 `ctx`）⇒ 无法直接 import 做行为单测。
//    本文件锁的是**源码层的语义标记**（函数名/关键表达式），能防"改回去/漏改一处"，
//    但不能替代真机行为验证 —— 真机验证路径见 docs/superpowers/evidence/2026-09-30-u49/。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
/** 取某个 registerTool 段（从 name 到下一个 registerTool） */
function seg(name) {
  const i = SRC.indexOf("name: '" + name + "'")
  assert.ok(i > 0, '未找到工具 ' + name)
  const j = SRC.indexOf('registerTool({', i)
  return SRC.slice(i, j < 0 ? SRC.length : j)
}

test('① 归档集读取入口存在，且**读不到时要给原因**（不得返回"空的成功"）', () => {
  assert.ok(SRC.indexOf('function archivedIds()') > 0, '必须定义 archivedIds()')
  const i = SRC.indexOf('function archivedIds()')
  const body = SRC.slice(i, i + 500)
  assert.ok(body.indexOf('ok: false') > 0 && body.indexOf('reason:') > 0, '读不到归档集必须返回 ok:false + reason（否则就是静默放行）')
  assert.ok(body.indexOf('archivedSessionIds') > 0, '必须读宿主权威属性 workspaceRegistry.archivedSessionIds')
})

test('② archivedRefusal：归档集**读不到时不阻断派发**（只丢过滤能力，不误伤）', () => {
  const i = SRC.indexOf('function archivedRefusal(')
  assert.ok(i > 0, '必须定义 archivedRefusal()')
  const body = SRC.slice(i, i + 420)
  assert.ok(body.indexOf('if (!a.ok) return null') > 0, '读不到归档集 ⇒ 必须 return null（不阻断）')
  assert.ok(body.indexOf('indexOf(String(id)) < 0') > 0, 'id 须按字符串比较（宿主 archivedSessionIds 是 branded id）')
})

test('③ tsk_archive：成功判定必须是**归档集复核**，不得再出现 `archived || renamed`（F-2 的根因）', () => {
  const s = seg('tsk_archive')
  assert.ok(s.indexOf('archivedIds()') > 0, 'archive 后必须用宿主归档集复核')
  assert.ok(s.indexOf('不在**宿主归档集中') > 0, '未生效必须报错（无此会话 / 未生效）')
  assert.equal(s.indexOf('r.archived || r.renamed'), -1, '不得再用 archived||renamed 当成功判定')
  assert.equal(s.indexOf('renamed: rec.renamed, error: rec.error }') , -1, '审计行须带 skipped 字段（旧写法）')
})

test('④ tsk_archive：改名被跳过必须**留原因**（非 live / rename=false / 已有前缀 / 服务不可用）', () => {
  const s = seg('tsk_archive')
  for (const kw of ['会话非 live', 'rename=false', '已有 [已归档] 前缀', 'sessionTitle 服务不可用', '未找到 archiveSession 接口', 'workspaceRegistry 服务不可用']) {
    assert.ok(s.indexOf(kw) > 0, '必须给出原因：' + kw)
  }
  assert.ok(s.indexOf('skipped:') > 0, '结果条目须带 skipped 字段')
})

test('④b 🔴 回归锁：不得再调不存在的 `sessionTitle.readTitle`；改名必须传 **live session 对象**', () => {
  const s = seg('tsk_archive')
  // 根因之一：sessionTitle 服务**没有** readTitle（宿主 dsh-session-title 里 readTitle 出现 0 次）
  assert.equal(s.indexOf('st.readTitle'), -1, '不得再调 st.readTitle（该方法不存在 ⇒ 每次抛错被吞 ⇒ 改名永久静默跳过）')
  // 根因之二：rename 签名是 (session, title)，传字符串 id 会被宿主判 not live
  assert.ok(s.indexOf('st.rename(sess, ') > 0, 'rename 必须传 live session 对象（agents.get(sid).session）')
  assert.equal(s.indexOf('st.rename(sid'), -1, '不得再传字符串 id 给 rename')
  // 读走 tsk 自身同口径的 titleOf（→ sessionQuery.readTitle）
  assert.ok(s.indexOf('await titleOf(sid, true)') > 0, '读标题须走 titleOf（sessionQuery.readTitle 同口径）')
})

test('⑤ tsk_archive：summary 必须分列 归档/改名/跳过/失败；ok 不得恒 true', () => {
  const s = seg('tsk_archive')
  for (const kw of ['归档成功 ', '改名 ', '跳过 ', '失败 ']) assert.ok(s.indexOf(kw) > 0, 'summary 缺字段：' + kw)
  assert.ok(s.indexOf('ok: fail.length === 0') > 0, 'ok 必须表示"无失败项"，不得恒 true（假成功）')
  assert.equal(s.indexOf('ok: true, total: results.length'), -1, '不得再恒 true')
})

test('⑥ tsk_sessions：必须排除已归档并显式报出（F-1）', () => {
  const s = seg('tsk_sessions')
  assert.ok(s.indexOf('archivedIds()') > 0, 'tsk_sessions 必须读归档集')
  assert.ok(s.indexOf('excludedArchived') > 0, '必须回传被排除的数量')
  assert.ok(s.indexOf('已排除 ') > 0, 'summary 必须显式报出被排除的会话')
  assert.ok(s.indexOf('未过滤') > 0, '归档集读不到时必须显式告警（不静默放行）')
  assert.equal(s.indexOf('const sessions = []\n      const list = agents.list()'), -1, '不得退回"直接列全部 live agent"')
})

test('⑦ 三个派发口都必须守归档口径（工具单派 / 工具批派 / 调度器自动派）', () => {
  const hits = SRC.match(/archivedRefusal\(/g) || []
  // 1 处定义 + 3 处调用
  assert.equal(hits.length, 4, 'archivedRefusal 应为「1 定义 + 3 调用」，实际 ' + hits.length)
  assert.ok(SRC.indexOf("error: 'TARGET_ARCHIVED'") > 0, '单派口须给 TARGET_ARCHIVED')
  assert.ok(SRC.indexOf("'TARGET_ARCHIVED: '") > 0, '批派口须给 TARGET_ARCHIVED')
  assert.ok(SRC.indexOf('task.dispatch_archived_target') > 0, '调度器须留审计事件')
})

test('⑧ 口径自洽：归档=不可派发 这条声明同时出现在 tsk_archive 与 tsk_sessions 的描述里', () => {
  assert.ok(seg('tsk_archive').indexOf('不可被派发') > 0, 'tsk_archive 保留原声明')
  assert.ok(seg('tsk_sessions').indexOf('未归档') > 0, 'tsk_sessions 描述须写明"活跃且未归档"')
})
