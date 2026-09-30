// @local/dsh-adapter —— 重启自恢复：候选识别（纯函数，无宿主依赖 ⇒ 可单测）
//
// 迁入来源：`plugins/resume-on-boot/lib/detect.js`（P3 Phase 1 骨架，逻辑与语义保持不变）。
// 归属变更（P3 计划 §2D D5）：唤醒与扫描一并收归 adapter，`plugins/resume-on-boot/` 作废。
// 实现计划：docs/superpowers/plans/2026-09-22-dsh-remote-p3-resume-on-boot.md
//
// 本文件刻意**不碰**宿主服务与文件系统：判定逻辑一旦与 I/O 混在一起，
// 就只能靠"真机试一次"验证，而这正是本项目反复吃亏的地方。
// 扫描与分层（P1/P0、D6）在 ./scan.js；编排在 ./index.js。

/**
 * 会话尾部 turn 状态。
 *
 * 事件形状来自 `@deepseek-ai/dsh-session`（见 docs/spikes/2026-09-19-z2-uq1-drain-and-sandbox.md 的源码确认）：
 *   `turn/start` → data.turn 为 turn 编号
 *   `turn/end`   → data.turn 为 turn 编号，data.reason.kind 为结束原因（completed / interrupted / …）
 *
 * 判定（设计 §8.1"日志尾部有未闭合 turn（**含自动补的 interrupted**）"）：
 *   · 最后一条边界是 `turn/start`                    → `open`（未闭合）
 *   · 最后一条边界是 `turn/end` 且 reason=interrupted → `interrupted`（内核重启时自动补的收尾，仍是"没做完"的信号）
 *   · 其它 `turn/end`（如 completed）                 → `closed`
 *   · 完全没有 turn 边界事件                          → `none`
 *
 * ⚠️ 真机发现 F1（P3 §2C）：内核**不会**自动把未闭合 turn 落盘收尾（只读 API 会合成呈现），
 * 但一旦发生恢复就会落盘 `turn/end(reason=interrupted)` ⇒ 恢复之后磁盘上依然是"未闭合"形态，
 * 所以本函数把 `interrupted` 也算未完成信号（否则恢复过一次的会话就再也不算候选）。
 *
 * @param {Array} events
 * @returns {{ kind: 'open'|'interrupted'|'closed'|'none', unfinished: boolean, turn: number|null, reasonKind: string|null }}
 */
export function lastTurnState(events) {
  const list = Array.isArray(events) ? events : []
  let last = null
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    if (!ev || (ev.type !== 'turn/start' && ev.type !== 'turn/end')) continue
    last = ev
    break
  }
  if (!last) return { kind: 'none', unfinished: false, turn: null, reasonKind: null }

  const data = last.data || {}
  const turn = Number.isFinite(data.turn) ? data.turn : null
  if (last.type === 'turn/start') {
    return { kind: 'open', unfinished: true, turn, reasonKind: null }
  }
  const reasonKind = (data.reason && data.reason.kind) || null
  if (reasonKind === 'interrupted') {
    return { kind: 'interrupted', unfinished: true, turn, reasonKind }
  }
  return { kind: 'closed', unfinished: false, turn, reasonKind }
}

/** 三个信号源（设计 §8.1），以及它们的强弱（D2：S3 任务级最强） */
export const SIGNAL = {
  TASK: 'task', // S3 taskkit 看板存在"执行中/排队中"任务
  GOAL: 'goal', // S2 存在 GoalPhase === 'active' 的 goal
  TURN: 'turn', // S1 日志尾部有未闭合 turn
  // D6 新增：子会话被掐断（`subagent` 维度）。P1 层的判据即"父会话已闭合、名下有未闭合子会话"，
  // 命中的是**父会话**，不是子会话本身（子会话没有用户来源，自己跑不起来）。
  SUBAGENT: 'subagent',
}

/** 合并候选：同一 sessionId 可能命中多个信号，合成为一条 */
export function collectCandidates({ turnSignals, goals, tasks } = {}) {
  const byId = new Map()
  const ensure = (sessionId) => {
    if (!sessionId) return null
    let rec = byId.get(sessionId)
    if (!rec) {
      rec = { sessionId, signals: [], turn: null, goalId: null, taskId: null }
      byId.set(sessionId, rec)
    }
    return rec
  }

  for (const s of Array.isArray(turnSignals) ? turnSignals : []) {
    const rec = ensure(s && s.sessionId)
    if (rec) {
      rec.signals.push(SIGNAL.TURN)
      rec.turn = s.turn == null ? null : s.turn
    }
  }
  for (const g of Array.isArray(goals) ? goals : []) {
    const id = typeof g === 'string' ? g : g && g.sessionId
    const rec = ensure(id)
    if (rec) {
      rec.signals.push(SIGNAL.GOAL)
      rec.goalId = (g && g.goalId) || null
    }
  }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const id = typeof t === 'string' ? t : t && t.sessionId
    const rec = ensure(id)
    if (rec) {
      rec.signals.push(SIGNAL.TASK)
      rec.taskId = (t && t.taskId) || null
    }
  }

  // primary：S3 > S2 > S1（D2 的冲突处理）
  const out = []
  for (const rec of byId.values()) {
    const primary = rec.signals.includes(SIGNAL.TASK) ? SIGNAL.TASK
      : rec.signals.includes(SIGNAL.GOAL) ? SIGNAL.GOAL
        : SIGNAL.TURN
    out.push({ ...rec, primary })
  }
  return out
}

/**
 * 幂等键（D3，经 §2D D6 扩展）。
 *
 * **关键**：不能只用 sessionId —— 否则同一会话**第二次**中断（新 turn）会被判为"已处理"而**永不恢复**。
 * 所以键要带上"这一次未结束"的标识。
 *
 * 扩展（D6）：P1 触发时唤醒目标是**父会话**，与"父会话自身未闭合"（`turn:<n>`）是两件事
 * ⇒ P1 用 `sub:` 前缀，绝不能让 P0 的 `turn:` 键把 P1 挡住（或反之）。
 *
 * ⚠️ **P1 键必须带上子会话 id**（2026-09-22 自查修正，原先只到父会话是**错的**）：
 * `sub:<parentId>` 会让同一父会话**永远只被唤醒一次**——父会话日后再被掐断
 * （另一个子代理在途）时会被幂等状态判为"已处理"，于是**静默不恢复**，而这正是 P1 要防的场景。
 * 带上子会话 id 后，每个"父 + 被掐断的子"各记一条；能拿到子会话 turn 时再叠加 `:t<n>` 进一步细化
 *（子会话为 one-shot 时 turn 常为 null，此时退化为"父 + 子"键）。
 */
export function resumeKeyFor(candidate) {
  if (!candidate) return null
  if (candidate.layer === 'P1' || candidate.primary === SIGNAL.SUBAGENT) {
    const parentId = candidate.sessionId || candidate.parentSessionId || '?'
    const firstChild = Array.isArray(candidate.openChildren) ? candidate.openChildren[0] : null
    const childId = candidate.childId || (firstChild && firstChild.id) || '?'
    // `:t<n>` 取**子会话**的 turn —— 这正是上面文档写的"能拿到子会话 turn 时再叠加"。
    // ⚠️ 2026-09-22 修：**不能**直接用 `candidate.turn`。该字段在两层含义不同：
    //   P1 的 `turn` 是**子会话**的 turn，而 P0+在飞委派（前台委派被掐断）的 `turn` 是**父会话**的
    //   —— 直接用会让"同一份未完成工作（父+子+子代 turn）"在不同层算出**不同的键**，去重失效、
    //   同一件事被唤醒两次。键的语义应当是"**这份未完成工作**"，与它是被哪一层检出的无关。
    const turn = (firstChild && firstChild.turn != null) ? firstChild.turn : candidate.turn
    return 'sub:' + parentId + ':' + childId + (turn == null ? '' : ':t' + turn)
  }
  if (candidate.primary === SIGNAL.TASK) return 'task:' + (candidate.taskId || '?')
  if (candidate.primary === SIGNAL.GOAL) return 'goal:' + (candidate.goalId || '?')
  return 'turn:' + (candidate.turn == null ? '?' : candidate.turn)
}

/**
 * 决定"该唤醒谁"（D4）。
 *
 * `scope: 'tasks-only'`（默认）：只唤醒有任务级信号的会话；仅 S1/S2 命中的只记 skip，不唤醒。
 *   理由：重启后突然在一个只有半句话的会话里继续生成内容，对用户是惊吓而不是帮助。
 * `scope: 'all'`：S1/S2 也唤醒。
 *
 * ⚠️ 与 P3 §2D D5 的关系：adapter **不读** taskkit 的任何文件 ⇒ 当前流程里没有 SIGNAL.TASK 来源，
 * 真正被编排用到的是 ./scan.js 的 `selectByLayer`（P1/P0 分层，语义见该函数注释）。
 * 本函数按 D2/D4 原语义**原样保留**（纯函数、可单测），作为 P3（外部插件注册信号）接入时的复用点。
 *
 * @returns {{ resume: Array, skip: Array<{sessionId, reason, signals}> }}
 */
export function selectResumable(candidates, { scope = 'tasks-only', maxResume = Infinity } = {}) {
  const resume = []
  const skip = []
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (scope !== 'all' && c.primary !== SIGNAL.TASK) {
      skip.push({ sessionId: c.sessionId, reason: 'scope=tasks-only 且无任务级信号', signals: c.signals })
      continue
    }
    if (resume.length >= maxResume) {
      skip.push({ sessionId: c.sessionId, reason: '超出 maxResumePerBoot 上限', signals: c.signals })
      continue
    }
    resume.push(c)
  }
  return { resume, skip }
}
