// @local/dsh-adapter —— `adapterWake` 自检（假 ctx，不需要宿主）
//
// 为什么值得单独自检：`adapterWake` 是"唤醒别人会话"的通道，它出错的表现是**静默少工具**
// 或**静默不唤醒**——两者都不会抛错，只会让被唤醒的会话行为异常。所以这里把
// "语义是否与 taskkit 一致"（读 selected 事件而非 header、超时兜底、依赖缺失明说）逐条锁住。

import { createAdapterWake } from '../lib/wake.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

let failures = 0
const check = (cond, label, got, want) => {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label, got, want)

/** 构造带可配置服务的假 ctx；未列入的服务一律返回 undefined（模拟"未就绪"） */
function fakeCtx(services) {
  return { get: (name) => services[name] }
}

const calls = []
const mkSessionQuery = ({ events, header, records }) => ({
  readSession: async (id) => { calls.push(['readSession', id]); return { events: events || [], header } },
  listSessions: async () => { calls.push(['listSessions']); return records || [] },
})
const mkAgentPresets = (opts = {}) => ({
  resolve: async (id) => { calls.push(['presets.resolve', id]); return { id: id === undefined ? 'default' : id } },
  mount: async (agentCtx, id) => {
    calls.push(['presets.mount', id])
    if (opts.mountThrows) throw new Error('mount boom')
  },
})

// ---------------------------------------------------------------------------
console.log('== ① 依赖体检：缺什么要明说 ==')
{
  const w = createAdapterWake({ ctx: fakeCtx({}) })
  const a = w.available()
  eq(a.ok, false, '① -a 三服务全缺 → ok=false')
  eq(a.missing, ['agents', 'sessionQuery', 'agentPresets'], '① -b missing 列出全部缺失项')

  const w2 = createAdapterWake({ ctx: fakeCtx({ agents: {}, sessionQuery: {}, agentPresets: {} }) })
  eq(w2.available().ok, true, '① -c 三服务齐 → ok=true')
}

console.log('\n== ② preset 解析：优先读 agent-preset/selected（而非 header）==')
{
  calls.length = 0
  // header 说 default，但事件里最后选了 coach → 必须取 coach（这正是 taskkit 修过的坑）
  const w = createAdapterWake({
    ctx: fakeCtx({
      sessionQuery: mkSessionQuery({
        header: { id: 's1', agentPreset: 'default' },
        events: [
          { type: 'agent-preset/selected', data: { agentPreset: 'news' } },
          { type: 'user/message', data: {} },
          { type: 'agent-preset/selected', data: { agentPreset: 'coach' } },
        ],
      }),
    }),
  })
  eq(await w.resolveSessionPresetId('s1'), 'coach', '② -a 取最后一条 selected（不是第一条、不是 header）')

  // 无 selected 事件 → 回落 header
  const w2 = createAdapterWake({
    ctx: fakeCtx({ sessionQuery: mkSessionQuery({ header: { id: 's2', agentPreset: 'wrpro' }, events: [{ type: 'user/message' }] }) }),
  })
  eq(await w2.resolveSessionPresetId('s2'), 'wrpro', '② -b 无 selected 事件时回落 header')

  // 两者都无 → 回落 listSessions
  const w3 = createAdapterWake({
    ctx: fakeCtx({ sessionQuery: mkSessionQuery({ header: { id: 's3' }, events: [], records: [{ header: { id: 's3', agentPreset: 'legacy' } }] }) }),
  })
  eq(await w3.resolveSessionPresetId('s3'), 'legacy', '② -c 再回落 listSessions')
}

console.log('\n== ③ preset 解析：缓存行为 ==')
{
  calls.length = 0
  let t = 1000
  const w = createAdapterWake({
    ctx: fakeCtx({ sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'a' }, events: [] }) }),
    now: () => t,
  })
  await w.resolveSessionPresetId('s1')
  await w.resolveSessionPresetId('s1')
  eq(calls.filter((c) => c[0] === 'readSession').length, 1, '③ -a 60s 内命中缓存，只读一次')
  t += 61_000
  await w.resolveSessionPresetId('s1')
  eq(calls.filter((c) => c[0] === 'readSession').length, 2, '③ -b 超过 60s 后重新解析')
}

console.log('\n== ④ setup：把"是否真的挂上了 preset"上报出来（taskkit 版会静默 return）==')
{
  calls.length = 0
  const wNoPresets = createAdapterWake({
    ctx: fakeCtx({ sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'coach' }, events: [] }) }),
  })
  const setup1 = await wNoPresets.presetMountSetupFor('s1')
  await setup1({ /* agentCtx */ })
  eq(setup1.result.mounted, false, '④ -a agentPresets 缺失 → mounted=false（不再静默）')
  eq(setup1.result.skipped, 'agentPresets.mount 不可用', '④ -b 并给出跳过原因')

  const wOk = createAdapterWake({
    ctx: fakeCtx({
      sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'coach' }, events: [] }),
      agentPresets: mkAgentPresets(),
    }),
  })
  const setup2 = await wOk.presetMountSetupFor('s1')
  await setup2('AGENTCTX')
  eq(setup2.result.mounted, true, '④ -c 正常挂载 → mounted=true')
  eq(setup2.result.presetId, 'coach', '④ -d 上报实际挂载的 presetId')
  eq(calls.filter((c) => c[0] === 'presets.mount').map((c) => c[1]), ['coach'], '④ -e mount 收到解析出的 presetId')
}

console.log('\n== ⑤ resumeWithPreset：调用形状与返回值 ==')
{
  calls.length = 0
  let resumeArg = null
  const agents = {
    // 真实宿主在"发布 agent 之前"会调用 setup（taskkit 注释：agent 发布前把 preset 组合挂到其 scope）
    resume: async (arg) => {
      resumeArg = arg
      calls.push(['resume'])
      if (typeof arg.setup === 'function') await arg.setup('AGENTCTX')
      return { agent: { id: arg.resumeSessionId, send: async () => {} } }
    },
  }
  const w = createAdapterWake({
    ctx: fakeCtx({
      agents,
      sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'coach' }, events: [] }),
      agentPresets: mkAgentPresets(),
    }),
  })
  const r = await w.resumeWithPreset('s1', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  eq(r.ok, true, '⑤ -a ok=true')
  eq(r.setupMounted, true, '⑤ -b setupMounted=true')
  eq(r.presetId, 'coach', '⑤ -c presetId 透传')
  eq(resumeArg.resumeSessionId, 's1', '⑤ -d 传 resumeSessionId')
  eq(resumeArg.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, '⑤ -e agentOptions 透传')
  eq(typeof resumeArg.setup, 'function', '⑤ -f 传 setup（不是 undefined）')
}

console.log('\n== ⑥ resumeWithPreset：失败与超时都要有明确结论（不能静默成功）==')
{
  // agents.resume 缺失
  const w1 = createAdapterWake({ ctx: fakeCtx({}) })
  const r1 = await w1.resumeWithPreset('s1')
  eq(r1.ok, false, '⑥ -a agents 缺失 → ok=false')
  eq(r1.error, 'agents.resume 不可用', '⑥ -b 错误信息明确')

  // resume 超时（永不 resolve）
  const w2 = createAdapterWake({
    ctx: fakeCtx({
      agents: { resume: () => new Promise(() => {}) },
      sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'a' }, events: [] }),
      agentPresets: mkAgentPresets(),
    }),
  })
  const r2 = await w2.resumeWithPreset('s1', { timeoutMs: 120 })
  eq(r2.ok, false, '⑥ -c 超时 → ok=false（不给内核无限等待）')
  check(/超时/.test(r2.error || ''), '⑥ -d 错误信息说明超时', r2.error, '含"超时"')

  // resume 抛错
  const w3 = createAdapterWake({
    ctx: fakeCtx({
      agents: { resume: async () => { throw new Error('resume boom') } },
      sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'a' }, events: [] }),
      agentPresets: mkAgentPresets(),
    }),
  })
  const r3 = await w3.resumeWithPreset('s1')
  eq(r3.ok, false, '⑥ -e resume 抛错 → ok=false')
  eq(r3.error, 'resume boom', '⑥ -f 错误原因透传')

  // setup 挂载失败要冒到返回值
  const w4 = createAdapterWake({
    ctx: fakeCtx({
      agents: { resume: async (a) => { await a.setup('CTX'); return { agent: { id: 's1' } } } },
      sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'a' }, events: [] }),
      agentPresets: mkAgentPresets({ mountThrows: true }),
    }),
  })
  const r4 = await w4.resumeWithPreset('s1')
  eq(r4.ok, false, '⑥ -g setup 抛错时 resume 整体失败（不返回"成功但缺工具"）')
  eq(r4.error, 'mount boom', '⑥ -h 并带出挂载失败原因')
}

console.log('\n== ⑦ injectNotice：按 taskkit 先例的 inbox 投递形状（R1/R2 待真机确认）==')
{
  let sent = null
  const agent = { send: async (msg, target, flag) => { sent = { msg, target, flag } } }
  const w = createAdapterWake({ ctx: fakeCtx({}) })
  const ok = await w.injectNotice(agent, '<resume-notice>已续跑</resume-notice>', { plugin: 'resume-on-boot' })
  eq(ok.ok, true, '⑦ -a 投递成功')
  eq(sent.target, 'next-turn', '⑦ -b 目标队列 next-turn')
  eq(sent.flag, false, '⑦ -c 第 3 参数 false（同 taskkit）')
  eq(sent.msg.role, 'user', '⑦ -d role=user（U2b 裁决，非 system）')
  eq(sent.msg.source, { kind: 'plugin', plugin: 'resume-on-boot' }, '⑦ -e source.kind=plugin（内核要求）')
  eq(sent.msg.content[0].type, 'text', '⑦ -f content 为 ContentBlock 数组')
  check(typeof sent.msg.id === 'string' && sent.msg.id.length > 0, '⑦ -g 带非空 id', sent.msg.id, '非空字符串')

  const bad = await w.injectNotice(null, 'x')
  eq(bad.ok, false, '⑦ -h agent 不可用时明确失败')
  const thrower = { send: async () => { throw new Error('send boom') } }
  eq((await w.injectNotice(thrower, 'x')).ok, false, '⑦ -i send 抛错时明确失败')
}

console.log('\n== ⑧ preset 解析的「退化读法」必须留痕且不得缓存（P3-PRESET-FALLBACK，2026-09-22）==')
{
  // 背景：readSession 读不到时只能退到 header，而 header 是**创建时冻结**值 ——
  // 中途切过 preset 的会话会被按创建时的 preset 恢复。此前这件事是**静默**发生的。
  const audits = []
  const mkAudit = () => (level, event, message, extra) => audits.push({ level, event, message, extra })

  // 假会话：readSession 抛错（模拟服务异常/超时/旧格式读不动）
  const mkFailing = (records) => ({
    readSession: async () => { throw new Error('readSession boom') },
    listSessions: async () => records || [],
  })
  const mkNullRead = (records) => ({
    readSession: async () => null,       // 超时兜底就是 null（withTimeout 的 fallback）
    listSessions: async () => records || [],
  })

  // ⑧-a 「读到日志但没有 selected 事件」⇒ via=header，**不算退化、不该告警**（防假警报）
  {
    audits.length = 0
    const w = createAdapterWake({
      ctx: fakeCtx({ sessionQuery: mkSessionQuery({ header: { id: 's1', agentPreset: 'wrpro' }, events: [{ type: 'user/message' }] }) }),
      audit: mkAudit(),
    })
    const setup = await w.presetMountSetupFor('s1')
    eq(setup.result.presetId, 'wrpro', '⑧ -a 无 selected 事件时仍回落 header')
    eq(setup.result.presetSource, 'header', '⑧ -a2 来源标为 header（读到过日志 ⇒ 无风险）')
    eq(audits.length, 0, '⑧ -a3 **不告警**（header 这时就是生效值，告警会变噪音）')
  }

  // ⑧-b 「压根读不到日志」⇒ via=header-no-read，**必须告警 + 日志**
  {
    audits.length = 0
    const logs = []
    const w = createAdapterWake({
      ctx: fakeCtx({ sessionQuery: mkFailing([{ header: { id: 's2', agentPreset: 'legacy' } }]) }),
      audit: mkAudit(),
      log: (m) => logs.push(m),
    })
    const setup = await w.presetMountSetupFor('s2')
    eq(setup.result.presetId, 'legacy', '⑧ -b 读不到时行为兼容：仍取 header 的 preset')
    eq(setup.result.presetSource, 'header-no-read', '⑧ -b2 来源如实标为 header-no-read（退化）')
    eq(audits.length, 1, '⑧ -b3 恰好告警一次')
    eq(audits[0].event, 'wake.preset_degraded', '⑧ -b4 事件名固定，便于检索')
    eq(audits[0].level, 'WARN', '⑧ -b5 级别 WARN')
    check(/创建时/.test(audits[0].message), '⑧ -b6 说明里点明"按创建时的 preset 恢复"这一风险', audits[0].message, '含"创建时"')
    check(logs.some((m) => /退化/.test(m)), '⑧ -b7 同时进 apply 日志（不全靠审计文件）', logs, '含"退化"')
  }

  // ⑧-c **退化结果不进缓存**：下次调用必须重新读（可能就读到了）；非退化才缓存
  {
    let calls = 0
    let mode = 'fail'
    const sq = {
      readSession: async () => { calls++; if (mode === 'fail') throw new Error('boom'); return { events: [{ type: 'agent-preset/selected', data: { agentPreset: 'coach' } }], header: { id: 's3' } } },
      listSessions: async () => [{ header: { id: 's3', agentPreset: 'legacy' } }],
    }
    const w = createAdapterWake({ ctx: fakeCtx({ sessionQuery: sq }), audit: mkAudit() })
    eq((await w.presetMountSetupFor('s3')).result.presetId, 'legacy', '⑧ -c 首次退化 → legacy')
    eq(calls, 1, '⑧ -c2 读了一次')
    mode = 'ok'   // 服务恢复
    eq((await w.presetMountSetupFor('s3')).result.presetId, 'coach', '⑧ -c3 **服务恢复后能读到真值**（退化结果没被缓存住）')
    eq(calls, 2, '⑧ -c4 因此又读了一次（若缓存了这里就还是 legacy）')
    await w.presetMountSetupFor('s3')
    eq(calls, 2, '⑧ -c5 非退化结果才进缓存 ⇒ 第三次不再读')
  }

  // ⑧-d 两条来源都拿不到 ⇒ via=none，**同样要告警**（它会退到 default preset，比 header 退化更危险）
  {
    audits.length = 0
    const w = createAdapterWake({ ctx: fakeCtx({ sessionQuery: mkNullRead([]) }), audit: mkAudit() })
    const setup = await w.presetMountSetupFor('s4')
    eq(setup.result.presetId, null, '⑧ -d 解析不出 preset ⇒ presetId=null')
    eq(setup.result.presetSource, 'none', '⑧ -d2 来源标为 none')
    eq(audits.length, 1, '⑧ -d3 也要告警（会让唤醒退回 default preset，属静默挂错的来源）')
    check(/default/.test(audits[0].message), '⑧ -d4 _message 点明会退回 default', audits[0].message, '含 default')
  }

  // ⑧-d5 readSession **抛错**时不得让异常冒出（否则调用方记 exception 且不写幂等状态 ⇒ 每次重启都重试）
  {
    audits.length = 0
    const w = createAdapterWake({
      ctx: fakeCtx({ sessionQuery: mkFailing([{ header: { id: 's4b', agentPreset: 'legacy' } }]) }),
      audit: mkAudit(),
    })
    const setup = await w.presetMountSetupFor('s4b')   // 不抛 = 通过
    eq(setup.result.presetId, 'legacy', '⑧ -d5 抛错也收敛到 header 兜底（不再冒成 exception）')
    eq(audits[0] && audits[0].extra && audits[0].extra.readError, 'readSession boom', '⑧ -d6 原因如实带进审计 readError')
  }

  // ⑧-g ★假警报防线：**读到了日志、只是会话本身没记 preset** ⇒ via=none 但**不该告警**
  //     （真机夹具实测踩到：rob-probe 造的会话没有任何 preset 记录，退 default 才是对的）
  {
    audits.length = 0
    const w = createAdapterWake({
      ctx: fakeCtx({
        sessionQuery: mkSessionQuery({
          header: { id: 's7' },              // 无 agentPreset 字段
          events: [{ type: 'user/message' }], // 读过、无 selected 事件
          records: [{ header: { id: 's7' } }], // listSessions 里也没有 agentPreset
        }),
      }),
      audit: mkAudit(),
    })
    const setup = await w.presetMountSetupFor('s7')
    eq(setup.result.presetId, null, '⑧ -g 会话没记 preset ⇒ presetId=null（调用方走 default）')
    eq(setup.result.presetSource, 'none', '⑧ -g2 来源标为 none')
    eq(audits.length, 0, '⑧ -g3 **不告警**：读到了日志 ⇒ 这不是退化，是"本来就该用 default"')
  }

  // ⑧-h 读到日志但 preset 只在 listSessions 里 ⇒ 属 `header`（安全），不是 header-no-read
  {
    audits.length = 0
    const w = createAdapterWake({
      ctx: fakeCtx({
        sessionQuery: mkSessionQuery({ header: { id: 's8' }, events: [], records: [{ header: { id: 's8', agentPreset: 'coach' } }] }),
      }),
      audit: mkAudit(),
    })
    const setup = await w.presetMountSetupFor('s8')
    eq(setup.result.presetId, 'coach', '⑧ -h 仍能从 listSessions 取到 preset')
    eq(setup.result.presetSource, 'header', '⑧ -h2 读到过日志 ⇒ 标 header（不是 header-no-read）')
    eq(audits.length, 0, '⑧ -h3 不告警（告警判据是"没读到日志"，不是"数据来自哪一层"）')
  }
  // ⑧-e 退化来源要能上浮到 resumeWithPreset 的返回值（再往上就是 resume.ok 审计）
  {
    const w = createAdapterWake({
      ctx: fakeCtx({
        agents: { resume: async (a) => { if (typeof a.setup === 'function') await a.setup('CTX'); return { agent: { id: 's5' } } } },
        sessionQuery: mkFailing([{ header: { id: 's5', agentPreset: 'legacy' } }]),
        agentPresets: mkAgentPresets(),
      }),
      audit: mkAudit(),
    })
    const r = await w.resumeWithPreset('s5')
    eq(r.ok, true, '⑧ -e 退化不影响唤醒成败（header 值仍可挂载）')
    eq(r.presetSource, 'header-no-read', '⑧ -e2 presetSource 一路上浮到 resumeWithPreset（供 resume.ok 审计）')
  }

  // ⑧-f test-only 注入时来源标为 forced（别把它误读成"从会话里读出来的"）
  {
    const w = createAdapterWake({ ctx: fakeCtx({ sessionQuery: mkSessionQuery({ header: { id: 's6', agentPreset: 'x' }, events: [] }) }), audit: mkAudit() })
    const setup = await w.presetMountSetupFor('s6', { testForceMissingPresetId: 'no-such-preset' })
    eq(setup.result.presetSource, 'forced', '⑧ -f 注入来源标为 forced')
    eq(setup.result.presetId, 'no-such-preset', '⑧ -f2 用的是注入值')
  }
}

console.log('\n== ⑨ T1-1（2026-09-25）：preset 解析改走"会话文件尾窗"，**不物化整份会话** ==')
{
  const home = mkdtempSync(join(tmpdir(), 'rob-wake-'))
  try {
    const frame = (events) => zlib.zstdCompressSync(
      Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'),
    )
    const put = (id, frames, name = 'session.v3.jsonl.zstd') => {
      const dir = join(home, 'sessions', '--ws--', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), Buffer.concat(frames))
    }
    put('s-tail', [
      frame([{ type: 'agent-preset/selected', seq: 1, time: 1, data: { agentPreset: 'news' } }]),
      frame([{ type: 'user/message', seq: 2, time: 2, data: {} }]),
      frame([{ type: 'agent-preset/selected', seq: 3, time: 3, data: { agentPreset: 'coach' } }]),
    ])

    // ⑨-a 尾窗里能找到最后一条 selected ⇒ 取它；且**一次 readSession 都不许调**（T1-1 的成本主张）
    let reads = 0
    const w1 = createAdapterWake({
      ctx: fakeCtx({
        sessionQuery: {
          readSession: async () => { reads++; throw new Error('T1-1 主路径不该调 readSession') },
          listSessions: async () => [],
        },
      }),
      dshHome: home,
    })
    eq(await w1.resolveSessionPresetId('s-tail'), 'coach', '⑨ -a 从**尾窗**读到最后一条 selected（不是 header、不是第一条）')
    eq(reads, 0, '⑨ -a2 尾窗读可用 ⇒ **绝不**调用 readSession')

    // ⑨-b 文件超过体积闸门 ⇒ **完全不读日志**（连尾窗都不读），退 header + 保留 wake.preset_degraded
    const audits = []
    const w2 = createAdapterWake({
      ctx: fakeCtx({
        sessionQuery: {
          readSession: async () => { reads++; throw new Error('闸门生效后不该调 readSession') },
          listSessions: async () => [{ header: { id: 's-tail', agentPreset: 'legacy' } }],
        },
      }),
      dshHome: home,
      audit: (level, event, message, extra) => audits.push({ level, event, message, extra }),
    })
    eq(await w2.resolveSessionPresetId('s-tail', { presetTailMaxBytes: 8 }), 'legacy', '⑨ -b 超闸门 ⇒ 退 header 取 preset（行为兼容）')
    eq(reads, 0, '⑨ -b2 超闸门 ⇒ 一次日志都不读（孤儿读从构造上消失）')
    eq(audits.length, 1, '⑨ -b3 必须告警一次（不静默）')
    eq(audits[0].event, 'wake.preset_degraded', '⑨ -b4 沿用既有事件名，便于检索')
    eq(audits[0].extra && audits[0].extra.readPath, 'tail-skip', '⑨ -b5 审计如实标读路径 = tail-skip')
    eq(String(audits[0].extra && audits[0].extra.readError).indexOf('file-too-large') === 0, true, '⑨ -b6 原因如实写 file-too-large')

    // ⑨-c 会话**不在索引里** ⇒ 同样不读全量（退 header + 告警，且原因写 no-session-file）
    audits.length = 0
    const w3 = createAdapterWake({
      ctx: fakeCtx({
        sessionQuery: {
          readSession: async () => { reads++; throw new Error('不在索引里也不该调 readSession') },
          listSessions: async () => [],
        },
      }),
      dshHome: home,
      audit: (level, event, message, extra) => audits.push({ level, event, message, extra }),
    })
    eq(await w3.resolveSessionPresetId('s-missing'), undefined, '⑨ -c 索引里没有 ⇒ 拿不到 preset（退 default）')
    eq(reads, 0, '⑨ -c2 同样**不读**全量')
    eq(audits.length, 1, '⑨ -c3 同样要告警（不静默）')
    eq(String(audits[0].extra && audits[0].extra.readError), 'no-session-file', '⑨ -c4 原因如实写 no-session-file')

    // ⑨-d 未配 dshHome（未接线/单测场景）⇒ **保持改造前的 readSession 路径不变**（不引入回归）
    reads = 0
    const w4 = createAdapterWake({
      ctx: fakeCtx({
        sessionQuery: {
          readSession: async () => { reads++; return { events: [{ type: 'agent-preset/selected', data: { agentPreset: 'wrpro' } }], header: { id: 's-x' } } },
          listSessions: async () => [],
        },
      }),
    })
    eq(await w4.resolveSessionPresetId('s-x'), 'wrpro', '⑨ -d 未配 dshHome ⇒ 退回既有 readSession 路径（行为不变）')
    eq(reads, 1, '⑨ -d2 该路径确实读了全量（这是"能力不可用"时的既定行为）')
  } finally { rmSync(home, { recursive: true, force: true }) }
}

console.log('\n' + '='.repeat(64))
console.log('pass=' + (failures === 0 ? 'all' : 'partial') + ' fail=' + failures)
if (failures) process.exit(1)
console.log('adapterWake 自检全部通过')
