// @local/dsh-adapter —— 重启自恢复：会话日志"最后一帧"读取单测（P3 §2B U8）
//
// 为什么值得单测：一级预筛的闸门**必须**套在"最后一帧的最后事件时间"上（真机两次教训，
// 见 lib/resume/tail.js 顶部注释）。读尾帧的每一步都有真实的坑，逐条锁住：
//   1. 一事件一帧 ⇒ 取到的是**最后一帧**的最后事件（不是第一帧的）
//   2. 最后一帧大于 initialTail ⇒ 窗口**自适应放大**后仍能解出
//   3. 压缩数据内部**巧合**出现魔数 ⇒ 从后往前试 + JSONL 校验使其不误判
//   4. 垃圾 / 截断 / 空文件 / 路径不存在 ⇒ ok:false 且**不抛**
//   5. buildSessionFileIndex：按目录结构建索引、忽略 .bak、**同目录多快照取版本最高**（不是 mtime 最大）、home 缺失返回空 Map
//   6. ★U12 lastEventOf：取"最后活跃时间"必须走 `time` → 分片事件的 `time0` 这条链（漏了 time0 就会让 ≈10% 的会话
//      退到 header.createdAt = 会话创建时间，正是 U7b 那类误判），且 lastEventType 永远是**真末条**的类型
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync, readFileSync, statSync, utimesSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { readLastFrame, lastEventOf, buildSessionFileIndex, isSessionSnapshotFileName, snapshotVersionOf, DEFAULT_INITIAL_TAIL, DEFAULT_MAX_TAIL_TAIL, readTailEvents, turnStateFromTail } from '../lib/resume/tail.js'
import { zstdFrame, writeSessionFile, timedEvent, turnStart, turnEnd, otherEvent, mkTempHome } from './_resume-fakes.mjs'

/** zstd 帧魔数（与实现同一常量，独立写一份以便测试自己数候选） */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 独立实现：数一个 Buffer 里魔数出现了几次（用于断言"确实存在一个巧合魔数候选"） */
function countMagic(buf) {
  let n = 0
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) n++
  }
  return n
}

/** 不可压缩载荷（保证"大帧"确实大：zstd 压不掉随机字节的 base64） */
const incompressible = (bytes) => Buffer.from(crypto.randomBytes(bytes)).toString('base64')

/**
 * 手搓一个**合法的 zstd Raw_Block 帧**：载荷字节**原样**留在压缩流里。
 * 为什么必须手搓：`zlib.zstdCompressSync` 会把载荷真的压掉（base64 也能压 25%），
 * 于是"压缩数据内部巧合出现魔数"这个场景**构造不出来**。
 * 帧格式：magic(4) + FHD(0x20：单段 + 1 字节内容长度) + 内容长度(1) + 块头(3) + 原始载荷
 */
function rawBlockFrame(payload) {
  const n = payload.length
  const bh = (n << 3) | 1 // block_size<<3 | block_type(Raw=0)<<1 | last_block
  return Buffer.concat([
    MAGIC, Buffer.from([0x20, n & 0xff]),
    Buffer.from([bh & 0xff, (bh >>> 8) & 0xff, (bh >>> 16) & 0xff]),
    payload,
  ])
}

const cleanup = (home) => rmSync(home, { recursive: true, force: true })

test('一事件一帧（append-only 追加帧）：取到的是**最后一帧**的最后事件，不是第一帧的', () => {
  const home = mkTempHome()
  try {
    const frames = [timedEvent(1000), timedEvent(2000), timedEvent(3000), timedEvent(4000, { type: 'turn/start' })]
    const file = writeSessionFile(home, 'session-a', frames.map((e) => zstdFrame([e])))

    const r = readLastFrame(file)
    assert.equal(r.ok, true)
    assert.equal(r.framesInWindow, 4, '小文件：整个文件都在 initialTail 窗口内 ⇒ 4 个候选帧')
    assert.equal(r.events.length, 1, '只解最后一帧 ⇒ 只 1 条事件')
    assert.equal(r.events[r.events.length - 1].time, 4000)

    const e = lastEventOf(file)
    assert.equal(e.ok, true)
    assert.equal(e.lastEventTime, 4000, '必须是最后一帧的时间（第一帧是 1000 ⇒ 拿那个就等于闸门套错）')
    assert.equal(e.lastEventType, 'turn/start')
    assert.equal(e.lastEventSeq, 4000)
    assert.ok(e.frameBytes > 0 && e.frameBytes < statSync(file).size)
  } finally { cleanup(home) }
})

test('最后一帧大于 initialTail ⇒ 窗口自适应放大后仍能解出（单条事件可能远大于 8KB）', () => {
  const home = mkTempHome()
  try {
    const small = zstdFrame([timedEvent(111)])
    const bigFrame = zstdFrame([{ type: 'turn/end', time: 222, seq: 2, data: { pad: incompressible(200 * 1024) } }])
    const file = writeSessionFile(home, 'session-big', [small, bigFrame])
    const size = statSync(file).size

    const tooSmall = readLastFrame(file, { initialTail: 1024 })
    assert.equal(tooSmall.ok, true, '放大窗口后仍应成功')
    assert.ok(tooSmall.window > DEFAULT_INITIAL_TAIL, '窗口必须被放大（实际=' + tooSmall.window + '）')
    assert.equal(tooSmall.window, size, '放大到"整个文件"级别（阶梯会按文件大小截断）')

    const e = lastEventOf(file)
    assert.equal(e.lastEventTime, 222, '拿到的仍是最后一帧的最后事件时间')
    assert.ok(e.frameBytes > 4096, '（前提）最后一帧确实比 initialTail 大：frameBytes=' + e.frameBytes)
  } finally { cleanup(home) }
})

test('压缩数据内部**巧合**出现魔数 ⇒ 不误判（从后往前试 + 每行都要 JSON.parse 的判据）', () => {
  const home = mkTempHome()
  try {
    // 一条 JSON 合法、但**载荷里原样嵌着** zstd 魔数字节的事件
    const payload = Buffer.concat([
      Buffer.from('{"type":"turn/end","time":999,"seq":9,"data":{"pad":"'),
      MAGIC, Buffer.from('"}}\n'),
    ])
    const file = writeSessionFile(home, 'session-evil', [zstdFrame([timedEvent(1000)]), rawBlockFrame(payload)])

    // （前提）压缩流里确实出现了 >=3 次魔数：真帧 2 个 + 载荷里嵌的那个"假候选"
    assert.ok(countMagic(readFileSync(file)) >= 3, '（前提）载荷里的巧合魔数必须原样留在压缩流里，否则本用例没测到东西')

    const r = readLastFrame(file)
    assert.equal(r.ok, true)
    assert.ok(r.framesInWindow >= 3, '（前提）窗口内确实有"更靠后的假候选"，即真的会被从后往前试到')

    const e = lastEventOf(file)
    assert.equal(e.ok, true)
    assert.equal(e.lastEventTime, 999, '必须取到真帧的最后事件时间，绝不能被载荷里的假魔数带偏')
    assert.equal(e.lastEventType, 'turn/end')
  } finally { cleanup(home) }
})

test('垃圾 / 截断 / 空文件 / 路径不存在 ⇒ ok:false 且**不抛**（启动路径上抛错会毁掉整轮恢复）', () => {
  const home = mkTempHome()
  try {
    const junk = join(home, 'junk.bin')
    writeFileSync(junk, Buffer.from('这不是 zstd，连魔数都没有'))
    const empty = join(home, 'empty.bin')
    writeFileSync(empty, Buffer.alloc(0))

    const full = writeSessionFile(home, 'session-c', [zstdFrame([timedEvent(1)])])
    const truncated = join(home, 'truncated.bin')
    const raw = readFileSync(full)
    writeFileSync(truncated, raw.subarray(0, raw.length - 6))

    // 有魔数但后面全是垃圾
    const fake = join(home, 'fake-magic.bin')
    writeFileSync(fake, Buffer.concat([MAGIC, Buffer.from('garbage-right-after-the-magic')]))

    for (const f of [junk, empty, truncated, fake, join(home, 'does-not-exist'), null, undefined, 123]) {
      let r = null, e = null
      assert.doesNotThrow(() => { r = readLastFrame(f) }, 'readLastFrame 不得抛：' + String(f))
      assert.equal(r.ok, false)
      assert.equal(typeof r.reason, 'string')
      assert.doesNotThrow(() => { e = lastEventOf(f) }, 'lastEventOf 不得抛：' + String(f))
      assert.equal(e.ok, false)
    }

    // 截断的单帧文件：绝不能"往前找到别的帧"或假装成功
    assert.match(readLastFrame(truncated).reason, /没有可解的完整帧/)
    assert.equal(lastEventOf(truncated).reason !== undefined, true)
  } finally { cleanup(home) }
})

test('buildSessionFileIndex：按目录结构建索引、忽略 .bak、同目录多快照取**版本最高**、home 缺失返回空 Map', () => {
  const home = mkTempHome()
  const emptyHome = mkdtempSync(join(home, 'empty-'))
  try {
    const a = writeSessionFile(home, 'session-a', [zstdFrame([timedEvent(1)])], { name: 'session.jsonl.zstd' })
    const aV3 = writeSessionFile(home, 'session-a', [zstdFrame([timedEvent(2)])], { name: 'session.v3.jsonl.zstd' })
    writeSessionFile(home, 'session-a', [zstdFrame([timedEvent(3)])], { name: 'session.jsonl.zstd.bak-2026-09-17' })
    const b = writeSessionFile(home, 'session-b', [zstdFrame([timedEvent(4)])], { bucket: '--other-ws--' })
    writeFileSync(join(home, 'sessions', 'stray-file.txt'), 'x', 'utf8') // 桶层的散文件必须被忽略

    // ★ 真机回归（2026-09-22）：把**旧格式**文件的 mtime 设得**更大**。
    // 旧规则"取 mtime 最大"会在这里选中旧快照，于是整个会话被一个**看起来合理但过期 5 天**的时间
    // 判出时间窗，连带名下未闭合的子会话一起被漏掉，而日志里毫无异常（详见 tail.js 里的实测记录）。
    utimesSync(a, 9000, 9000)
    utimesSync(aV3, 5000, 5000)
    utimesSync(b, 3000, 3000)

    const idx = buildSessionFileIndex(home)
    assert.equal(idx.size, 2, '两个会话目录 = 两条索引（.bak 与散文件都不算）')
    assert.equal(idx.get('session-a'), aV3, '同一目录多个快照 ⇒ 取**版本最高**的（mtime 更大也不能翻盘）')
    assert.equal(idx.get('session-b'), b, '不同 bucket 下的会话都要索引到（不按 cwd 反推桶名）')

    // 版本解析口径
    assert.equal(snapshotVersionOf('session.jsonl.zstd'), 0, '无版本号 = v0')
    assert.equal(snapshotVersionOf('session.v3.jsonl.zstd'), 3)
    assert.equal(snapshotVersionOf('session.v12.jsonl.zstd'), 12, '两位数版本不能被截断')
    assert.equal(snapshotVersionOf(''), 0)
    assert.equal(snapshotVersionOf(null), 0)

    assert.equal(buildSessionFileIndex(emptyHome).size, 0, 'sessions 目录不存在 ⇒ 空 Map')
    assert.equal(buildSessionFileIndex(join(home, 'nope')).size, 0, 'home 不存在 ⇒ 空 Map')
    assert.equal(buildSessionFileIndex('').size, 0)
    assert.equal(buildSessionFileIndex(undefined).size, 0)
    assert.doesNotThrow(() => buildSessionFileIndex(null))

    // 文件名判据（与内核/迁移脚本同口径）
    assert.equal(isSessionSnapshotFileName('session.jsonl.zstd'), true)
    assert.equal(isSessionSnapshotFileName('session.v3.jsonl.zstd'), true)
    assert.equal(isSessionSnapshotFileName('session-a.jsonl.zstd'), true)
    assert.equal(isSessionSnapshotFileName('session.jsonl.zstd.bak-old'), false)
    assert.equal(isSessionSnapshotFileName('other.jsonl.zstd'), false)
  } finally {
    rmSync(emptyHome, { recursive: true, force: true })
    cleanup(home)
  }
})

test('lastEventOf：窗口内**都没有**可用时间 ⇒ ok:true + lastEventTime=null + source=null（调用方据此降级）', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-noTime', [zstdFrame([otherEvent(), { type: 'request/context', data: {} }])])
    const e = lastEventOf(file)
    assert.equal(e.ok, true, '帧本身解得开 ⇒ 不是读取失败（ok:false 专表文件读不出）')
    assert.equal(e.lastEventTime, null)
    assert.equal(e.lastEventTimeSource, null)
    assert.equal(e.lastEventType, 'request/context')
  } finally { cleanup(home) }
})

// ---------------------------------------------------------------------------
// ★U12：取"最后活跃时间"的判据漏了流式分片事件的 `time0`（末条 `text-chunks`/`reasoning-chunks`/`assistant/chunk`
//   只有 `time0` 没有 `time`）⇒ 真机 539 会话里有 56 个（≈10%）被迫降级到 `header.createdAt`（=会话**创建**时间），
//   于是"创建很早、最近才活跃"的会话被误判过期（U7b 那类误判）。以下用例逐条锁住新判据：
//     1. 末条只有 time0 ⇒ 认它
//     2. 末条与前面若干条都只有 time0 ⇒ 取**最近**的那条（不是最早的）
//     3. 优先级 time 先于 time0（单条两者都有 ⇒ 取 time）
//     4. 末条没有可用时间、更早一条有 ⇒ 取更早那条的 time，而 lastEventType **仍是真末条的类型**（语义分离）
//     5. 窗口内都没有 ⇒ ok:true + null（降级路径不变）
//     6. 更早的时间比初始窗口深 ⇒ 靠窗口阶梯放大后仍要取到

/** 流式分片事件：**只有 time0**（真机 `{"type":"text-chunks","seq0":498049,"time0":1787826396479,...}`） */
const chunkEvent = (time0, extra = {}) => ({ type: 'text-chunks', seq0: time0, time0, data: {}, ...extra })

test('★U12 末条是分片事件（只有 time0，没有 time）⇒ lastEventTime=time0 且 source=time0', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-chunk', [zstdFrame([timedEvent(1000), chunkEvent(2000)])])
    const e = lastEventOf(file)
    assert.equal(e.ok, true)
    assert.equal(e.lastEventTime, 2000, '时间在分片事件的 time0 里（真机实录：末条只有 time0）')
    assert.equal(e.lastEventTimeSource, 'time0')
    assert.equal(e.lastEventType, 'text-chunks', 'lastEventType 仍是真末条的类型')
  } finally { cleanup(home) }
})

test('★U12 末条与前面若干条都只有 time0 ⇒ 取**最近**的那条（不是最早的）', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-chunks', [zstdFrame([chunkEvent(1000), chunkEvent(2000), chunkEvent(3000)])])
    const e = lastEventOf(file)
    assert.equal(e.ok, true)
    assert.equal(e.lastEventTime, 3000, '从尾往前找 ⇒ 拿到最近的，不是最早的')
    assert.equal(e.lastEventTimeSource, 'time0')
  } finally { cleanup(home) }
})

test('★U12 优先级：单条事件 time 与 time0 都有 ⇒ 取 time', () => {
  const home = mkTempHome()
  try {
    const both = { type: 'assistant/chunk', time: 9000, time0: 8000, seq: 9, data: {} }
    const file = writeSessionFile(home, 'session-both', [zstdFrame([timedEvent(1000), both])])
    const e = lastEventOf(file)
    assert.equal(e.lastEventTime, 9000, 'time 优先于 time0')
    assert.equal(e.lastEventTimeSource, 'time')
    assert.equal(e.lastEventType, 'assistant/chunk')
  } finally { cleanup(home) }
})

test('★U12 末条没有可用时间、更早一条有 time ⇒ 取更早那条的 time，lastEventType 仍是真末条的类型', () => {
  const home = mkTempHome()
  try {
    // 末条：分片事件，既无 time 也无 time0（delta 条目本身可能没有起点时间）
    const file = writeSessionFile(home, 'session-late', [
      zstdFrame([timedEvent(6000, { type: 'turn/end' }), { type: 'reasoning-chunks', seq0: 7, data: {} }]),
    ])
    const e = lastEventOf(file)
    assert.equal(e.ok, true)
    assert.equal(e.lastEventTime, 6000, '末条没有可用时间 ⇒ 往前找最近的一条')
    assert.equal(e.lastEventTimeSource, 'time')
    assert.equal(e.lastEventType, 'reasoning-chunks', '★语义分离：audit 的类型必须仍是真末条的类型')
  } finally { cleanup(home) }
})

test('★U12 更早的时间比初始窗口深 ⇒ 窗口阶梯放大后仍要取到', () => {
  const home = mkTempHome()
  try {
    // 尾帧是个 200KB+ 的"无时间"大事件（长 turn 里的大工具结果很常见）⇒ 初始窗口里根本看不到那个有时间的事件
    const file = writeSessionFile(home, 'session-deep-time', [
      zstdFrame([timedEvent(4242, { type: 'turn/end' })]),
      zstdFrame([{ type: 'request/context', seq: 2, data: { pad: incompressible(200 * 1024) } }]),
    ])
    const e = lastEventOf(file)
    assert.equal(e.ok, true)
    assert.equal(e.lastEventTime, 4242, '必须靠放大窗口找回那条有时间的事件')
    assert.equal(e.lastEventTimeSource, 'time')
    assert.equal(e.lastEventType, 'request/context', '真末条仍是大事件')
    assert.ok(e.window > DEFAULT_INITIAL_TAIL, '（前提）窗口确实被放大了：window=' + e.window)

    // 反向对照：初始窗口那一次读**确实**拿不到任何事件（否则本用例没测到"放大"这件事）
    const small = readTailEvents(file, { initialTail: DEFAULT_INITIAL_TAIL, maxTail: DEFAULT_INITIAL_TAIL })
    assert.equal(small.ok, false, '（前提）初始窗口内连一个完整帧都解不出')
  } finally { cleanup(home) }
})

// ---------------------------------------------------------------------------
// ★U10：从尾帧直接判"末态"（二级判定的主路径）—— 真机 190 秒那轮的瓶颈就是"逐个读全量子会话日志"。
//   锁住的语义：
//     1. 窗口**贴着文件尾**（解到 EOF）⇒ 窗口内最后一条 turn 边界 = 整条日志的最后一条 ⇒ 不会判错
//     2. 边界比初始窗口深 ⇒ 窗口**放大**后仍要取到（长 turn + 大工具结果很常见）
//     3. 放大到上限仍没有边界 ⇒ ok:false + reason='no-turn-boundary-in-window'（由调用方回退读全量）
//     4. 垃圾 / 不存在 / 非法入参 ⇒ ok:false 且**不抛**（二级判定也在启动路径上）

test('★U10 turnStateFromTail：尾帧就是 turn 边界（turn/end）⇒ closed', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-closed', [
      zstdFrame([turnStart(1)]),
      zstdFrame([turnEnd(1, 'completed')]),
    ])
    const r = turnStateFromTail(file)
    assert.equal(r.ok, true)
    assert.equal(r.source, 'tail')
    assert.equal(r.state.kind, 'closed', '最后一条边界是 turn/end(completed) ⇒ 已闭合')
    assert.equal(r.state.unfinished, false)
    assert.equal(r.state.turn, 1)
    assert.equal(r.state.reasonKind, 'completed')
    assert.equal(r.window, statSync(file).size, '小文件：窗口就是整个文件')

    // readTailEvents 拿的是"窗口内最早边界→EOF"的全部事件（这里两帧都在），且**不抛**
    const t = readTailEvents(file)
    assert.equal(t.ok, true)
    assert.equal(t.events.length, 2)
    assert.deepEqual(t.events.map((e) => e.type), ['turn/start', 'turn/end'])
    assert.equal(t.window, statSync(file).size)
    assert.ok(t.framesInWindow >= 2)
  } finally { cleanup(home) }
})

test('★U10 turnStateFromTail：尾帧是 turn/start ⇒ open', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-open', [
      zstdFrame([turnEnd(1, 'completed')]),
      zstdFrame([turnStart(2)]),
    ])
    const r = turnStateFromTail(file)
    assert.equal(r.ok, true)
    assert.equal(r.state.kind, 'open')
    assert.equal(r.state.unfinished, true)
    assert.equal(r.state.turn, 2)
  } finally { cleanup(home) }
})

test('★U10 turnStateFromTail：边界比初始窗口深（turn/start 之后有超大事件）⇒ 放大窗口后仍取到 open', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-deep', [
      zstdFrame([turnStart(7)]), // ← 真正的最后一条 turn 边界，离文件尾很远
      zstdFrame([otherEvent(), otherEvent()]),
      zstdFrame([{ type: 'request/context', time: 5, seq: 5, data: { pad: incompressible(200 * 1024) } }]),
    ])
    const size = statSync(file).size

    const r = turnStateFromTail(file)
    assert.equal(r.ok, true)
    assert.equal(r.state.kind, 'open', '必须靠放大窗口找回那条 turn/start（小窗口里根本没有边界事件）')
    assert.equal(r.state.turn, 7)
    assert.ok(r.window > DEFAULT_INITIAL_TAIL, '窗口必须被放大：window=' + r.window)
    assert.equal(r.window, size, '（前提）放大到整个文件级别')

    // 反向对照：初始窗口那一次读**确实**看不到边界（否则本用例没测到"放大"这件事）
    const small = readTailEvents(file, { initialTail: DEFAULT_INITIAL_TAIL, maxTail: DEFAULT_INITIAL_TAIL })
    if (small.ok) assert.equal(lastTurnStateOf(small.events), 'none', '（前提）初始窗口内没有任何 turn 边界')
  } finally { cleanup(home) }
})

test('★U10 turnStateFromTail：窗口上限内一条 turn 边界都没有 ⇒ ok:false + no-turn-boundary-in-window，且**不抛**', () => {
  const home = mkTempHome()
  try {
    const file = writeSessionFile(home, 'session-noturn', [
      zstdFrame([timedEvent(1, { type: 'request/context' })]),
      zstdFrame([timedEvent(2, { type: 'response/context' })]),
    ])
    let r = null
    assert.doesNotThrow(() => { r = turnStateFromTail(file) })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-turn-boundary-in-window')
    assert.equal(typeof r.window, 'number')
    assert.equal(typeof r.detail, 'string', '精确原因放 detail（判据只看 ok）')

    // 上限调小也一样（先把上限夹住，窗口阶梯不会无限放大）
    let tiny = null
    assert.doesNotThrow(() => { tiny = turnStateFromTail(file, { maxTail: 64 }) })
    assert.equal(tiny.ok, false)
    assert.equal(tiny.reason, 'no-turn-boundary-in-window')

    // 窗口上限是具名导出常量（审计里要显示、也便于调参）
    // 2026-09-25 T1-2：由 2 MiB 提到 4 MiB —— 关闭全量回退后它是"能不能判出末态"的唯一杠杆；
    //   真机实测 406 个会话里 >4 MiB 只有 3 个（0.7%）⇒ 99.3% 的会话整份落在窗口内（零漏判）。
    assert.equal(DEFAULT_MAX_TAIL_TAIL, 4 * 1024 * 1024)
  } finally { cleanup(home) }
})

test('★U10 turnStateFromTail / readTailEvents：文件不存在 / 垃圾文件 / 非法入参 ⇒ ok:false 且**不抛**', () => {
  const home = mkTempHome()
  try {
    const junk = join(home, 'junk.bin')
    writeFileSync(junk, Buffer.from('这不是 zstd，连魔数都没有'))
    const empty = join(home, 'empty.bin')
    writeFileSync(empty, Buffer.alloc(0))

    for (const f of [junk, empty, join(home, 'does-not-exist'), null, undefined, 123]) {
      let r = null
      assert.doesNotThrow(() => { r = turnStateFromTail(f) }, 'turnStateFromTail 不得抛：' + String(f))
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'no-turn-boundary-in-window')
      let t = null
      assert.doesNotThrow(() => { t = readTailEvents(f) }, 'readTailEvents 不得抛：' + String(f))
      assert.equal(t.ok, false)
      assert.equal(typeof t.reason, 'string')
    }
  } finally { cleanup(home) }
})

/** 测试内的小助手：数出事件里最后一条 turn 边界（独立于实现，避免"用实现证明实现"） */
function lastTurnStateOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i] && events[i].type
    if (t === 'turn/start' || t === 'turn/end') return t
  }
  return 'none'
}
