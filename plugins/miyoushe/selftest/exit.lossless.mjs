// @local/miyoushe —— A4/A5 单测：无损 JSON 出口 + 脱敏出口护栏 + F2 自撞回归（node 直调，**不加载插件**）
// 运行：node selftest/exit.lossless.mjs    （退出码 0 = 全过）
//
// t11 追加（F3 覆盖补齐）：F2 回归 5 例（已打码形态必须 OK）+ 真值/尖括号藏明文反例（当时默认 fail-closed ⇒ 必拒）。
// t14 改（captain 裁决落地）：**默认姿态＝掩码兜底**（不抛且无明文）／`strict:true`＝显式 fail-closed；
//     已打码形态**两姿态皆 OK**；补三参签名自证 + 「脱敏后复查」两姿态都在跑的不变式。

import { exitPayload, maskValue, maskText, uidTail, accountKey, saltFingerprint, REDACTED, MaskError, findSecrets, assertNoSecrets, SECRET_KEYS, TAIL_KEYS, scanTextSecrets, isPlaceholder } from '../lib/mask.js'
import { toLossless, findLosslessViolations, LosslessError, CIRCULAR } from '../lib/lossless.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let failures = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
function expectThrow(fn, code, label) {
  try { const r = fn(); check(false, label + ' 应抛 ' + code, r, code) }
  catch (e) { check(e && e.code === code, label + ' → ' + code, e && e.code, code) }
}

console.log('== A5-① 含 undefined 的内部对象：出口前是"非法输出"，出口后无损 ==')
const circular = { name: 'loop' }
circular.self = circular
const internal = {
  ok: true,
  a: undefined, // 宿主工具输出会报 invalid output（HTTP 路径侥幸通过）
  b: () => 1,
  c: NaN,
  d: Infinity,
  e: new Date('2026-09-20T01:45:32Z'),
  f: { g: undefined, h: 'x' },
  i: [1, undefined, 3],
  j: 10n,
  k: new Map([['x', undefined]]),
  l: Symbol('s'),
  m: circular,
  n: null,
}
const before = findLosslessViolations(internal)
console.log('BEFORE violations=' + JSON.stringify(before.map((v) => v.path + ':' + v.reason)))
check(before.length >= 8, '出口前检出多处非无损成分（含 undefined/function/NaN/Date/BigInt/Map/circular）', before.length, '>=8')
check(before.some((v) => v.reason === 'undefined'), '出口前检出 undefined（本项目 invalid output 事故的根因）', before.map((v) => v.reason).join(','), '<含 undefined>')

const out = exitPayload(internal, 'unit')
console.log('AFTER  raw=' + JSON.stringify(out))
check(findLosslessViolations(out).length === 0, '出口后零非无损成分', findLosslessViolations(out), '[]')
check(!Object.prototype.hasOwnProperty.call(out, 'a'), 'undefined 键被剔除（a）', Object.keys(out).join(','), '<无 a>')
check(!Object.prototype.hasOwnProperty.call(out, 'b'), 'function 键被剔除（b）', Object.keys(out).join(','), '<无 b>')
check(!Object.prototype.hasOwnProperty.call(out, 'l'), 'symbol 键被剔除（l）', Object.keys(out).join(','), '<无 l>')
check(!Object.prototype.hasOwnProperty.call(out.f, 'g'), '嵌套 undefined 键被剔除（f.g）', out.f, '<无 g>')
check(out.i.length === 3 && out.i[1] === null, '数组内 undefined → null（保持下标）', out.i, [1, null, 3])
check(out.c === null && out.d === null, 'NaN/Infinity → null', { c: out.c, d: out.d }, { c: null, d: null })
check(out.e === '2026-09-20T01:45:32.000Z', 'Date → ISO 字符串', out.e, '2026-09-20T01:45:32.000Z')
check(out.j === '10', 'BigInt → 十进制字符串', out.j, '10')
check(JSON.stringify(out.k) === '{}', 'Map → 普通对象（undefined 值剔除）', out.k, {})
check(out.m.self === CIRCULAR, '循环引用被剪断为 ' + CIRCULAR, out.m.self, CIRCULAR)
check(out.n === null, 'null 原样保留', out.n, null)
const roundTrip = JSON.parse(JSON.stringify(out))
check(JSON.stringify(roundTrip) === JSON.stringify(out), 'JSON 往返完全一致（真无损）', 'ok', 'ok')
let controlErr = null
try { JSON.stringify(internal) } catch (e) { controlErr = e.message }
check(controlErr !== null, '对照：原始内部对象**连 JSON.stringify 都做不到**（BigInt 直接抛）——正是必须经出口消毒的原因', controlErr, '<抛错>')
const rawDropped = Object.keys(JSON.parse(JSON.stringify({ ok: true, a: undefined, b: undefined, keep: 1 }))).join(',')
check(rawDropped === 'ok,keep', '对照：裸 JSON.stringify 会**静默丢键**（undefined 消失，宿主校验因此只报"非法"而看不出原因）', rawDropped, 'ok,keep')

console.log('== A5-② toLossless 幂等 / 断言器行为 ==')
check(JSON.stringify(toLossless(toLossless(internal))) === JSON.stringify(out), 'toLossless 幂等', 'ok', 'ok')
expectThrow(() => { throw new LosslessError([{ path: '$', reason: 'x' }], 't') }, 'NOT_LOSSLESS', 'LosslessError 携带 code=NOT_LOSSLESS')

console.log('== A4-① 出口护栏：Cookie/令牌**绝不回显**（声明式保证）==')
// 姿态（t14 / captain 裁决）：**默认＝掩码兜底**；`strict:true`＝显式 fail-closed
expectThrow(() => assertNoSecrets({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'guard'), 'CREDENTIAL_ECHO_BLOCKED', '护栏 assertNoSecrets 对未脱敏输入直接阻断（独立于 exitPayload 姿态）')
expectThrow(() => exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'strict', { strict: true }), 'CREDENTIAL_ECHO_BLOCKED', 'strict（只进不出类工具）碰到凭据键即阻断')
const echoed = exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL', ltoken_v2: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'default')
console.log('  默认兜底 raw=' + JSON.stringify(echoed))
check(echoed.cookie === REDACTED && echoed.ltoken_v2 === REDACTED, '默认出口＝掩码兜底（先脱敏再复查，不抛）', echoed, '<redacted>')
check(!JSON.stringify(echoed).includes('SYNTHETIC-NOT-A-REAL-CREDENTIAL'), '默认出口无凭据值残留', '(含)', '(不含)')
const aliasOut = exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'alias', { maskOnly: true })
check(JSON.stringify(aliasOut) === JSON.stringify(exitPayload({ ok: true, cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' })), 'maskOnly 为兼容别名 ≡ 默认（输出逐字相同）', aliasOut, '<等价默认>')
const masked = exitPayload({ ok: true, credentials: { cookieRaw: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL', uid: '123456789', lastOkAt: null } }, 'masked')
console.log('  masked raw=' + JSON.stringify(masked))
check(masked.credentials.cookieRaw === REDACTED, '敏感键被替换为 ' + REDACTED, masked.credentials.cookieRaw, REDACTED)
check(masked.credentials.uid === '***6789', 'uid 只显尾 4 位（§4.2 规则 1）', masked.credentials.uid, '***6789')
check(!JSON.stringify(masked).includes('SYNTHETIC-NOT-A-REAL-CREDENTIAL'), '出口串中无凭据值残留', '(含)', '(不含)')
check(findSecrets(masked).length === 0, 'findSecrets 复查为空', findSecrets(masked), '[]')

console.log('== F2 回归（t11）：脱敏产物 `<redacted>` 不得被判成明文 —— 两种姿态都必须 OK（A2-③，幂等）==')
const F2_MASKED = [
  ['note ds=<redacted>', { note: 'ds=<redacted>' }],
  ['message 上游已打码回显', { message: '上游回显：x ds=<redacted>' }],
  ['URL 里的 ds=', { note: 'https://example.invalid/api?ds=<redacted>&t=1700000000' }],
  ['已打码文本（多 token）', { message: 'cookie=<redacted>; ltoken_v2=<redacted>' }],
  ['已打码的敏感键', { cookie: '<redacted>' }],
]
for (const [name, input] of F2_MASKED) {
  const perMode = {}
  for (const mode of ['default', 'strict']) {
    try {
      const r = mode === 'strict' ? exitPayload(input, 'p', { strict: true }) : exitPayload(input, 'p')
      perMode[mode] = JSON.stringify(r)
    } catch (e) {
      perMode[mode] = 'THROW ' + e.code
    }
  }
  console.log('  OK-CASE ' + name + ' => default=' + perMode.default + ' | strict=' + perMode.strict)
  check(perMode.default.startsWith('{') && perMode.strict.startsWith('{'), 'F2 已打码形态两姿态皆 OK：' + name, perMode, '<两姿态均成功>')
  check(perMode.default === perMode.strict, '两姿态对已打码形态输出一致（幂等）：' + name, perMode.default, perMode.strict)
}

console.log('== A2（t14 语义）：默认＝掩码兜底（不抛且无明文）／strict＝必须 THROW CREDENTIAL_ECHO_BLOCKED ==')
const A2_PLAINTEXT = [
  ['真值 ds=', { note: 'ds=realvalue123' }, 'realvalue123'],
  ['敏感键带真值', { cookie: 'ltoken_v2=abc123' }, 'abc123'],
  ['message 里混入真值', { message: '上游回显：cookie=abcdef' }, 'abcdef'],
  ['URL 里带真值 ds=', { url: 'https://example.invalid/api?ds=abc&k=v' }, 'ds=abc'],
]
for (const [name, input, rawMarker] of A2_PLAINTEXT) {
  let dOut = null
  let dErr = null
  try { dOut = exitPayload(input, 'p') } catch (e) { dErr = e }
  const dJson = dErr ? 'THROW ' + dErr.code : JSON.stringify(dOut)
  console.log('  DEFAULT ' + name + ' => ' + dJson)
  check(dErr === null, '默认姿态不抛：' + name, dErr && dErr.code, 'null')
  check(!dJson.includes(rawMarker) && !dJson.includes('realvalue123') && !dJson.includes('ltoken_v2=abc123') && !dJson.includes('cookie=abcdef'), '默认姿态输出**不含明文**（值为 <redacted> 形态）：' + name, dJson, '<无明文>')
  check(dJson.includes('<redacted>'), '默认姿态确实打码为 <redacted>：' + name, dJson, '<含 <redacted>>')
  let sCode = null
  let sMsg = null
  try { sCode = 'NO-THROW ' + JSON.stringify(exitPayload(input, 'p', { strict: true })) } catch (e) { sCode = e.code; sMsg = e.message }
  console.log('  STRICT  ' + name + ' => ' + sCode + (sMsg ? ' | ' + sMsg.slice(0, 64) : ''))
  check(sCode === 'CREDENTIAL_ECHO_BLOCKED', 'strict 姿态必须 THROW：' + name, sCode, 'CREDENTIAL_ECHO_BLOCKED')
}
// 尖括号"藏"明文：默认被打码（不抛，因为掩码器能识别非占位尖括号值），strict 必拒
const angleDefault = exitPayload({ note: 'ds=<realvalue123>' }, 'p')
console.log('  DEFAULT 尖括号藏明文 ds=<realvalue123> => ' + JSON.stringify(angleDefault))
check(angleDefault.note === 'ds=<redacted>', '默认姿态把非占位尖括号值也打码', angleDefault.note, 'ds=<redacted>')
let angleStrict = null
try { angleStrict = 'NO-THROW ' + JSON.stringify(exitPayload({ note: 'ds=<realvalue123>' }, 'p', { strict: true })) } catch (e) { angleStrict = e.code }
console.log('  STRICT  尖括号藏明文 => ' + angleStrict)
check(angleStrict === 'CREDENTIAL_ECHO_BLOCKED', 'strict 姿态拒绝尖括号藏明文', angleStrict, 'CREDENTIAL_ECHO_BLOCKED')
// §6.1② 落点：URL 真值默认打码后**可回显**（maskOnly 别名与默认同）
const urlMasked = exitPayload({ url: 'https://example.invalid/api?ds=abc&k=v' }, 'url-default')
console.log('  URL-default => ' + JSON.stringify(urlMasked))
check(urlMasked.url === 'https://example.invalid/api?ds=<redacted>&k=v', '§6.1② 默认姿态下 URL 真值被打码、可回显', urlMasked.url, '…?ds=<redacted>&k=v')
check(JSON.stringify(exitPayload({ url: 'https://example.invalid/api?ds=abc&k=v' }, 'url-alias', { maskOnly: true })) === JSON.stringify(urlMasked), 'maskOnly 别名与默认对 URL 同结果', 'ok', 'same')

console.log('== 护栏不变式：「脱敏后复查」在**两种姿态**下都必须执行（防掩码器漏检）==')
{
  // 行为面：maskValue 的产物必须自身干净（这就是"脱敏后复查"要断言的契约）
  for (const [, input] of F2_MASKED.concat(A2_PLAINTEXT.map((x) => [x[0], x[1]]))) {
    const maskedOnce = maskValue(input)
    const hits = findSecrets(maskedOnce)
    check(hits.length === 0, 'maskValue 产物经 findSecrets 复查为空（输入含真值也不残留）', hits, '[]')
  }
  // 源码面：exitPayload 体内的 `assertNoSecrets(masked` 不在任何姿态分支里（无条件执行）
  const SRC = readFileSync(join(ROOT, 'lib', 'mask.js'), 'utf8')
  const body = SRC.slice(SRC.indexOf('export function exitPayload('))
  const postMaskLine = body.split(/\r?\n/).find((l) => l.includes('assertNoSecrets(masked'))
  const postMaskIsConditional = /if\s*\(.*\)\s*assertNoSecrets\(masked/.test(body) || /(strict|maskOnly)[^\n]*\n?[^\n]*assertNoSecrets\(masked/.test(body)
  console.log('  源码面 post-mask 复查行 => ' + (postMaskLine || '').trim())
  check(!!postMaskLine, 'exitPayload 体内存在「脱敏后复查」调用', postMaskLine, '<存在>')
  check(postMaskIsConditional === false, '「脱敏后复查」不受 strict/maskOnly 分支控制（两姿态都跑）', postMaskIsConditional, false)
}

console.log('== A3 签名自证：exitPayload(value, label, opts) 三参 ==')
{
  let lblCode = null
  let lblMsg = ''
  try { exitPayload({ cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, 'miyoushe_credentials', { strict: true }) } catch (e) { lblCode = e.code; lblMsg = e.message }
  console.log('  label 生效 => ' + lblCode + ' | ' + lblMsg.slice(0, 70))
  check(lblCode === 'CREDENTIAL_ECHO_BLOCKED' && lblMsg.includes('[miyoushe_credentials]'), 'label 生效（MaskError 消息含 [label]）', lblMsg.slice(0, 70), '<含 [miyoushe_credentials]>')
  check(lblMsg.includes('[object Object]') === false, 'label 位不出现 [[object Object]]', lblMsg.includes('[object Object]'), false)
  // 2×2 矩阵：同一输入 {strict} × {真值/已打码}
  const TRUTHY = { note: 'ds=realvalue123' }
  const MASKEDY = { note: 'ds=<redacted>' }
  const m = {}
  for (const [k, v] of [['truthy', TRUTHY], ['masked', MASKEDY]]) {
    for (const mode of ['default', 'strict']) {
      try { m[k + '/' + mode] = JSON.stringify(mode === 'strict' ? exitPayload(v, 'p', { strict: true }) : exitPayload(v, 'p')) }
      catch (e) { m[k + '/' + mode] = 'THROW ' + e.code }
    }
  }
  console.log('  2×2 矩阵 => ' + JSON.stringify(m))
  check(m['truthy/default'].includes('<redacted>') && m['truthy/strict'] === 'THROW CREDENTIAL_ECHO_BLOCKED', 'strict 生效：真值默认打码 / strict 抛错', m, '<2×2 期望>')
  check(m['masked/default'].startsWith('{') && m['masked/strict'].startsWith('{'), '已打码形态两姿态皆正常', m, '<两姿态成功>')
  // 历史误用纠错（captain 曾把 opts 传到第 2 参 ⇒ 报 [[object Object]]）
  let misuseStrict = null
  try { exitPayload({ cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, { strict: true }) } catch (e) { misuseStrict = e.code }
  console.log('  误用纠错 exitPayload(v, {strict:true}) => ' + misuseStrict)
  check(misuseStrict === 'CREDENTIAL_ECHO_BLOCKED', '防御性纠错：第 2 参传 opts 时 strict 仍生效（不静默丢语义）', misuseStrict, 'CREDENTIAL_ECHO_BLOCKED')
  const misuseDefault = exitPayload({ cookie: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }, { maskOnly: true })
  check(misuseDefault.cookie === REDACTED, '防御性纠错：默认姿态下输出仍已掩码', misuseDefault.cookie, REDACTED)
  let misuseMsg = ''
  try { exitPayload({ ok: true }, 'ok-label') } catch (e) { misuseMsg = e.message }
  check(misuseMsg === '' && typeof exitPayload({ ok: true }, 'ok-label').ok === 'boolean', '正常三参调用不受纠错逻辑影响', 'ok', 'ok')
}

console.log('== F2 判据探针：scanTextSecrets / isPlaceholder / maskText 幂等 ==')
console.log('  scanTextSecrets(ds=<redacted>)     => ' + JSON.stringify(scanTextSecrets('ds=<redacted>')))
console.log('  scanTextSecrets(ds=realvalue123)   => ' + JSON.stringify(scanTextSecrets('ds=realvalue123')))
console.log('  scanTextSecrets(ds=<realvalue123>) => ' + JSON.stringify(scanTextSecrets('ds=<realvalue123>')))
check(scanTextSecrets('ds=<redacted>').every((h) => h.placeholder === true), '占位形态判为 placeholder=true', scanTextSecrets('ds=<redacted>'), '全部 true')
check(scanTextSecrets('ds=realvalue123').every((h) => h.placeholder === false), '真值判为 placeholder=false', scanTextSecrets('ds=realvalue123'), '全部 false')
check(scanTextSecrets('ds=<realvalue123>').every((h) => h.placeholder === false), '尖括号非占位同样判 false', scanTextSecrets('ds=<realvalue123>'), '全部 false')
check(isPlaceholder('<redacted>') === true && isPlaceholder('<redacted:uid>') === true, 'isPlaceholder 认占位（含后缀化）', 'ok', 'true')
check(isPlaceholder('<realvalue>') === false && isPlaceholder('realvalue') === false, 'isPlaceholder 拒非占位', 'ok', 'false')
check(maskText(maskText('x cookie=abc123 y')) === maskText('x cookie=abc123 y'), 'maskText 幂等（二次打码不再改动）', maskText(maskText('x cookie=abc123 y')), 'x cookie=<redacted> y')
check(maskText('ds=<redacted>') === 'ds=<redacted>', 'maskText 对占位原样保留（F2 根因点）', maskText('ds=<redacted>'), 'ds=<redacted>')
const f2Fallback = exitPayload({ message: 'x cookie=abc123 y' }, 'maskOnly', { maskOnly: true })
check(f2Fallback.message === 'x cookie=<redacted> y', 'maskOnly 兜底仍能打码真值（显式 opt-in）', f2Fallback.message, 'x cookie=<redacted> y')

console.log('== A4-② 尾号/账号键/文本打码/盐指纹 ==')
check(uidTail('123456789') === '***6789', "uidTail('123456789')", uidTail('123456789'), '***6789')
check(uidTail(123) === '***123', 'uidTail 短号不越界', uidTail(123), '***123')
check(uidTail(null) === null, 'uidTail(null)=null', uidTail(null), null)
check(accountKey('123456789') === 'acct-***6789', 'accountKey（§5.4）', accountKey('123456789'), 'acct-***6789')
check(maskText('cookie=ABC123; ltuid=999') === 'cookie=<redacted>; ltuid=<redacted>', 'maskText 打码 key=value 凭据串', maskText('cookie=ABC123; ltuid=999'), 'cookie=<redacted>; ltuid=<redacted>')
check(maskText('words: hello') === 'words: hello', 'maskText 不误伤普通文本（词边界）', maskText('words: hello'), 'words: hello')
check(maskValue({ uid: '987654321', nickname: 'n', gameUid: '456789' }).uid === '***4321', 'maskValue 递归尾号化', maskValue({ uid: '987654321' }).uid, '***4321')
check(maskValue({ salt: 'A'.repeat(32) }).salt === REDACTED, 'maskValue 把 salt 视为密钥材料（只出指纹）', maskValue({ salt: 'A'.repeat(32) }).salt, REDACTED)
check(SECRET_KEYS.includes('cookie') && TAIL_KEYS.includes('uid'), '键表自描述（SECRET/TAIL）', 'ok', 'ok')
const wantFp = createHash('sha256').update('TEST-SALT-ONLY-FOR-UNIT-TEST', 'utf8').digest('hex').slice(0, 8)
check(saltFingerprint('TEST-SALT-ONLY-FOR-UNIT-TEST') === wantFp, 'saltFingerprint = SHA-256 前 8 位（§3.5.7）', saltFingerprint('TEST-SALT-ONLY-FOR-UNIT-TEST'), wantFp)
check(saltFingerprint(null) === null && saltFingerprint('') === null, 'saltFingerprint 空输入 → null', 'ok', 'null')
check(MaskError !== undefined, 'MaskError 已导出（供上层区分阻断类型）', 'ok', 'ok')

console.log('')
console.log('EXIT_LOSSLESS failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
