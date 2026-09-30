// @local/miyoushe —— A2 单测：§3.3 三条向量逐条复现（node 直调，**不加载插件**）
// 运行：node selftest/ds.vectors.mjs    （退出码 0 = 全过）

import { signDs, dsPayload, md5Hex, randAlnum, nowSec, DS_ERR, R_PATTERN } from '../lib/ds.js'

const VECTORS = [
  {
    id: 'V1',
    salt: 'ZSHlXeQUBis52qD1kEgKt5lUYed4b7Bb',
    t: 1700000000,
    r: 'Xk7Q2m',
    md5: 'f3bc2ed061695cb6d5ab1fe3584e4663',
    ds: '1700000000,Xk7Q2m,f3bc2ed061695cb6d5ab1fe3584e4663',
    note: '真实盐（历史版本 2.35.2，当前有效性未知，§11-1）',
  },
  {
    id: 'V2',
    salt: 'ZSHlXeQUBis52qD1kEgKt5lUYed4b7Bb',
    t: 1700000000,
    r: 'abc123',
    md5: '2e5e32fd6b53a5a282c31911e6eafd8b',
    ds: '1700000000,abc123,2e5e32fd6b53a5a282c31911e6eafd8b',
    note: '同盐换 r',
  },
  {
    id: 'V3',
    salt: 'TEST-SALT-ONLY-FOR-UNIT-TEST',
    t: 1700000000,
    r: '000000',
    md5: 'ceb5357b02dea3b8920405c9db15bde4',
    ds: '1700000000,000000,ceb5357b02dea3b8920405c9db15bde4',
    note: '纯测试盐（非真实），证明实现只依赖 salt 变量',
  },
]

let failures = 0
function check(cond, label, got, want) {
  if (cond) {
    console.log('PASS ' + label)
  } else {
    failures++
    console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))
  }
}

console.log('== §3.1 拼接串独立性核对（本机 md5 重算，不引用向量表结论）==')
for (const v of VECTORS) {
  const payload = dsPayload(v.salt, v.t, v.r)
  const res = signDs(v.salt, v.t, v.r)
  console.log(v.id + ' payload=' + payload)
  console.log(v.id + ' raw=' + JSON.stringify(res))
  check(payload === 'salt=' + v.salt + '&t=' + v.t + '&r=' + v.r, v.id + '.payload', payload, 'salt=…&t=…&r=…')
  check(res.md5 === v.md5, v.id + '.md5', res.md5, v.md5)
  check(res.md5 === md5Hex(payload), v.id + '.md5==md5Hex(payload)', res.md5, md5Hex(payload))
  check(res.ds === v.ds, v.id + '.ds', res.ds, v.ds)
  check(res.t === v.t && res.r === v.r, v.id + '.t/r 回显', { t: res.t, r: res.r }, { t: v.t, r: v.r })
  check(/^[0-9a-f]{32}$/.test(res.md5), v.id + '.md5 形状 32 位小写 hex', res.md5, '<32hex>')
  check(Object.keys(res).sort().join(',') === 'ds,md5,r,t', v.id + '.返回键集合 = {ds,t,r,md5}', Object.keys(res).sort().join(','), 'ds,md5,r,t')
  check(!JSON.stringify(res).includes(v.salt), v.id + '.返回值不含盐明文', '(含盐)', '(不含盐)')
}

console.log('== 前置断言（§3.1：失败抛错，不静默降级）==')
function expectThrow(fn, code, label) {
  try {
    fn()
    check(false, label + ' 应抛 ' + code, '(未抛)', code)
  } catch (e) {
    check(e && e.code === code, label + ' → ' + code, e && e.code, code)
  }
}
expectThrow(() => signDs('', 1700000000, 'Xk7Q2m'), DS_ERR.BAD_SALT, 'salt 空串')
expectThrow(() => signDs(null, 1700000000, 'Xk7Q2m'), DS_ERR.BAD_SALT, 'salt 非字符串')
expectThrow(() => signDs('A'.repeat(32), 0, 'Xk7Q2m'), DS_ERR.BAD_T, 't=0 非正整数')
expectThrow(() => signDs('A'.repeat(32), 1700000000.5, 'Xk7Q2m'), DS_ERR.BAD_T, 't 非整数')
expectThrow(() => signDs('A'.repeat(32), 1700000000, 'abc12'), DS_ERR.BAD_R, 'r 长度 5')
expectThrow(() => signDs('A'.repeat(32), 1700000000, 'abc-12'), DS_ERR.BAD_R, 'r 含非法字符')
expectThrow(() => signDs('A'.repeat(32), 1700000000, null), DS_ERR.BAD_R, 'r 非字符串')

console.log('== 默认参数与随机源 ==')
const d1 = signDs('TEST-SALT-ONLY-FOR-UNIT-TEST')
check(Number.isInteger(d1.t) && d1.t > 0, '默认 t = nowSec()', d1.t, '>0')
check(nowSec() - d1.t <= 2, '默认 t 与 nowSec() 差 ≤2s', nowSec() - d1.t, '<=2')
check(R_PATTERN.test(d1.r), '默认 r 形状', d1.r, '/^[A-Za-z0-9]{6}$/')
check(R_PATTERN.test(randAlnum(6)), 'randAlnum(6) 形状', randAlnum(6), '/^[A-Za-z0-9]{6}$/')
const d2 = signDs('TEST-SALT-ONLY-FOR-UNIT-TEST', 1700000000, '000000')
check(d1.md5 !== d2.md5 || d1.r === '000000', '随机 r 生效（同盐同时不同 r ⇒ 不同 md5，除非撞上 000000）', d1.md5, '≠' + d2.md5)
const v1 = signDs('ZSHlXeQUBis52qD1kEgKt5lUYed4b7Bb', 1700000000, 'Xk7Q2m')
const v3 = signDs('TEST-SALT-ONLY-FOR-UNIT-TEST', 1700000000, 'Xk7Q2m')
check(v1.md5 !== v3.md5, '换盐即换值（V1 与 V3 同 t/r 不同盐）', v1.md5, '≠' + v3.md5)

console.log('')
console.log('DS_VECTORS total=' + VECTORS.length + ' failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
