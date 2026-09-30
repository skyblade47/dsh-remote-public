// tools/rob-fixture.mjs 的单测（合成多帧会话，不需要宿主）
//
// 为什么必须有：`splitFrames` / `makeUnclosed` 一旦判错帧边界或 seq，
// 后果是**内核拒绝加载该会话**（表现为"会话不见了"），而夹具本身会以为成功。
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { splitFrames, parseLines, makeUnclosed, inspect, lastTurnBoundary, lastHeaderTools } from './rob-fixture.mjs'
import { decompressAllFrames } from '../server/scripts/session-migrate.mjs'

/**
 * 造一个多帧会话：第 0 帧装 header，其后每个事件各一帧（复刻内核的 append-only 写法）。
 *
 * ⚠️ 格式按 2026-09-22 用 554 个**真实会话文件**核实的结果复刻：
 *   首行 header 的 `type` 是 `"session"` 且**没有 `seq`**；其后事件 seq 从 **0** 起严格递增。
 *   （先前误以为 header 也带 seq、且 seq 等于行索引，已被真实数据证伪。）
 */
function buildSession(events, { headerTools } = {}) {
  const header = { type: 'session', cwd: '/srv/ws' }
  if (headerTools !== undefined) header.tools = headerTools
  const lines = [JSON.stringify(header)]
  const evs = events.map((e, i) => ({ ...e, seq: i }))
  for (const e of evs) lines.push(JSON.stringify(e))
  // 每行各成一帧
  const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')))
  return Buffer.concat(frames)
}

const T = (turn) => ({ type: 'turn/start', data: { turn } })
const TE = (turn, kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const S = (turn, step) => ({ type: 'step/start', data: { turn, step } })
const SE = (turn, step) => ({ type: 'step/end', data: { turn, step } })
const RH = (tools) => ({ type: 'request/header', data: { header: { tools } } })

test('splitFrames：多帧各切一刀，且拼接后与 decompressAllFrames 一致', () => {
  const buf = buildSession([T(1), S(1, 0), SE(1, 0), TE(1, 'completed')])
  const frames = splitFrames(buf)
  assert.equal(frames.length, 5, '每行一帧：header + 4 事件')
  assert.equal(frames[0].start, 0)
  assert.equal(frames[frames.length - 1].end, buf.length, '最后一帧吃到文件末尾')
  // 相邻帧首尾相接，无缝隙无重叠
  for (let i = 1; i < frames.length; i++) assert.equal(frames[i].start, frames[i - 1].end)
  // 各帧文本拼接 == 整条流解压结果
  // ⚠️ 必须用 decompressAllFrames：`zstdDecompressSync(buf)` **只解第一帧**，
  // 用它当期望值会拿"只有 header 的前缀"去比全文（本用例首轮就是这么写错的）。
  const joined = frames.map((f) => f.text).join('')
  assert.equal(joined, new TextDecoder().decode(decompressAllFrames(buf)))
})

test('parseLines：跳过空行，非法 JSON 要抛出（不能静默跳过）', () => {
  const { events } = parseLines('{"seq":0}\n\n{"seq":1}\n')
  assert.equal(events.length, 2)
  assert.throws(() => parseLines('{"seq":0}\n{oops}\n'), /不是合法 JSON/)
})

test('inspect：真实格式假设 —— header 无 seq、其后 seq 从 0 严格递增', () => {
  const buf = buildSession([T(1), S(1, 0), RH([{ name: 'a' }, { name: 'b' }]), SE(1, 0), TE(1, 'completed')])
  const r = inspect(buf, 'x')
  assert.equal(r.frames, 6)
  assert.equal(r.events, 6)
  assert.equal(r.unfinished, false)
  assert.equal(r.lastBoundaryType, 'turn/end')
  assert.equal(r.headerHasSeq, false, '首行 header 不带 seq（真实数据口径）')
  assert.equal(r.seqStrict, true, '排除 header 后 seq 严格递增')
  assert.deepEqual(r.seqSample, [null, 0, 1, 2, 3, 4], 'seq 是不含 header 的事件序号')
  assert.equal(r.headerTools.found, true)
  assert.equal(r.headerTools.count, 2)
})

test('makeUnclosed：删掉最后一条 turn/end → 未闭合、事件数 -1、seq 仍严格递增', () => {
  const buf = buildSession([T(1), S(1, 0), SE(1, 0), TE(1, 'completed')])
  const before = inspect(buf, 'b')
  const r = makeUnclosed(buf)
  assert.equal(r.reason, 'ok')
  assert.ok(r.buf, '应产出新 buf')
  const after = inspect(r.buf, 'a')
  assert.equal(after.unfinished, true, '末态必须是未闭合')
  assert.equal(after.events, before.events - 1)
  assert.equal(after.seqStrict, true, '改后 seq 必须仍严格递增')
  assert.equal(after.headerHasSeq, false, 'header 不得被塞进 seq')
  assert.equal(after.lastBoundaryType, 'turn/start')
  // 前 4 帧（header + T + S + SE）应逐字节保留
  const f0 = splitFrames(buf)
  const f1 = splitFrames(r.buf)
  for (let i = 0; i < f1.length - 1; i++) {
    assert.ok(f1[i].text === f0[i].text, `第 ${i} 帧内容应原样保留`)
  }
})

test('makeUnclosed：被删项之后还有事件时，seq 应"递减 1"补空洞（而不是按行索引硬写）', () => {
  // 形态：turn 结束后还有非 turn 事件落在后面的帧里（真实内核会写 session/title 这类）
  const buf = buildSession([T(1), S(1, 0), SE(1, 0), TE(1, 'completed'), { type: 'session/title', data: {} }])
  const before = inspect(buf, 'b')
  assert.deepEqual(before.seqSample, [null, 0, 1, 2, 3, 4], '前置：seq 0..4')

  const r = makeUnclosed(buf)
  assert.equal(r.reason, 'ok')
  assert.equal(r.removedSeq, 3, '被删的是 seq=3 的 turn/end')
  const after = inspect(r.buf, 'a')
  assert.equal(after.seqStrict, true)
  assert.deepEqual(after.seqSample, [null, 0, 1, 2, 3], 'seq=4 的 session/title 应递减为 3')
  assert.equal(after.unfinished, true)
  assert.equal(after.lastEventType, 'session/title', 'turn 之后的事件仍在（只删了 turn/end）')
})

test('makeUnclosed：幂等与边界（已是未闭合 / 已是 interrupted / 无 turn）', () => {
  const alreadyOpen = buildSession([T(1), S(1, 0)])
  assert.match(makeUnclosed(alreadyOpen).reason, /已经是未闭合/)

  const interrupted = buildSession([T(1), S(1, 0), SE(1, 0), TE(1, 'interrupted')])
  assert.match(makeUnclosed(interrupted).reason, /已是 interrupted/)

  const noTurn = buildSession([{ type: 'user/message', data: {} }])
  assert.match(makeUnclosed(noTurn).reason, /不存在/)
})

test('inspect：违反"严格递增"的 seq 必须被识别（用于拒绝改动非内核写入的文件）', () => {
  const z = (s) => zlib.zstdCompressSync(Buffer.from(s + '\n', 'utf8'))
  // 重复 seq
  const dup = Buffer.concat([z('{"type":"session"}'), z('{"type":"turn/start","seq":5,"data":{"turn":1}}'), z('{"type":"turn/end","seq":5,"data":{"turn":1,"reason":{"kind":"completed"}}}')])
  assert.equal(inspect(dup, 'dup').seqStrict, false)
  // 递减 seq
  const dec = Buffer.concat([z('{"type":"session"}'), z('{"type":"turn/start","seq":9,"data":{"turn":1}}'), z('{"type":"turn/end","seq":3,"data":{"turn":1,"reason":{"kind":"completed"}}}')])
  assert.equal(inspect(dec, 'dec').seqStrict, false)
  // 正常递增（且 header 无 seq）→ 通过
  const ok = Buffer.concat([z('{"type":"session"}'), z('{"type":"turn/start","seq":0,"data":{"turn":1}}'), z('{"type":"turn/end","seq":1,"data":{"turn":1,"reason":{"kind":"completed"}}}')])
  assert.equal(inspect(ok, 'ok').seqStrict, true)
})

test('lastTurnBoundary / lastHeaderTools：取"最后一条"而不是第一条', () => {
  const events = [T(1), TE(1, 'completed'), T(2), RH([{ name: 'x' }]), RH([{ name: 'y' }, { name: 'z' }])]
  assert.equal(lastTurnBoundary(events).event.type, 'turn/start')
  assert.equal(lastHeaderTools(events).count, 2, '取最后一个 header 的 tools')
  assert.equal(lastHeaderTools([T(1)]).found, false)
})

test('makeUnclosed：turn/end 不在最后一帧时也能处理（跨帧找边界）', () => {
  // 复刻真实形态：header 无 seq；turn/end 后面还有非 turn 事件落在更后的帧里
  const f0 = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8'))
  const f1 = zlib.zstdCompressSync(Buffer.from(
    '{"type":"turn/start","seq":0,"data":{"turn":1}}\n{"type":"step/start","seq":1,"data":{"turn":1,"step":0}}\n', 'utf8'))
  const f2 = zlib.zstdCompressSync(Buffer.from('{"type":"turn/end","seq":2,"data":{"turn":1,"reason":{"kind":"completed"}}}\n', 'utf8'))
  const f3 = zlib.zstdCompressSync(Buffer.from('{"type":"session/title","seq":3,"data":{}}\n', 'utf8'))
  const buf = Buffer.concat([f0, f1, f2, f3])
  const r = makeUnclosed(buf)
  assert.equal(r.reason, 'ok')
  assert.equal(r.removedSeq, 2, '删的是 f2 里的 turn/end')
  const after = inspect(r.buf, 'a')
  assert.equal(after.unfinished, true)
  assert.equal(after.events, 4, 'header + T + S + title')
  assert.equal(after.seqStrict, true)
  assert.deepEqual(after.seqSample, [null, 0, 1, 2], 'title 的 seq 应由 3 递减为 2')
  // f0/f1 逐字节不变（边界帧之前的帧原样保留）
  const fs2 = splitFrames(r.buf)
  assert.equal(fs2[0].text, new TextDecoder().decode(zlib.zstdDecompressSync(f0)))
  assert.equal(fs2[1].text, new TextDecoder().decode(zlib.zstdDecompressSync(f1)))
})

test('makeUnclosed：产物必须以换行收尾且每条记录都完整（内核的 torn JSONL 判据）', () => {
  // 真机踩到的坑（2026-09-22 T3/R1）：新写的尾巴帧若省略结尾 '\n'，
  // 内核的读取器会判 `complete frame contains a torn JSONL record` ⇒ 整个会话显示为"损坏"。
  // 单测原先只数事件条数，锁不住这条约定，所以漏到了真机。
  const buf = buildSession([T(1), S(1, 0), SE(1, 0), TE(1, 'completed')])
  const r = makeUnclosed(buf)
  assert.equal(r.reason, 'ok')
  const text = new TextDecoder().decode(decompressAllFrames(r.buf))
  assert.ok(text.endsWith('\n'), '产物必须以换行收尾')
  const lines = text.split('\n')
  assert.equal(lines.at(-1), '', '结尾换行后应有一个空尾元素')
  for (const line of lines) {
    if (!line.trim()) continue
    assert.doesNotThrow(() => JSON.parse(line), `每条记录都必须是完整 JSON：${line.slice(0, 40)}`)
  }
  // 且帧内不能出现"半条记录"：逐帧解出的文本同样必须以换行收尾
  for (const f of splitFrames(r.buf)) {
    if (!f.text) continue
    assert.ok(f.text.endsWith('\n'), '每一帧都应以换行收尾（否则跨帧拼接会撕裂记录）')
  }
})
