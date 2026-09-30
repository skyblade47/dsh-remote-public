// @local/dsh-adapter —— 一期契约冒烟（真实后端，非 mock）
//   A) fs 套件：用宿主真实 fs 后端（dsh-fs-local Loc* 的 SandboxedFileSystem，与宿主同源代码）+ 真实临时文件
//      —— 覆盖 §3 全接口 + §3.3 错误语义 + §3.1 A2 触发表 + §4.4 D1/D2/D3/D9/D10
//   B) adapterHttp：真实 HTTP 往返——受控本地 http 服务（逐条断言 server 端收到的 method/url/body）+ 真实宿主 loopback
//      —— 覆盖 §4 全接口 + §4.4 D4-D8
// 用法：node test/smoke-adapter.mjs      退出码 0=全通过
// 测试数据净零：全部临时文件在 os.tmpdir()/dsh-adapter-smoke-<pid>/ 下，结束时整目录删除。

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const RT = 'file:///E:/DeepSeek-Harness-1.0.0-portable/resources/dsh-runtime/node_modules/@deepseek-ai/'
const { Context } = await import(RT + 'cordis/lib/index.js')
const { SandboxedFileSystem } = await import(RT + 'dsh-fs-sandbox/lib/index.js')
const { AdapterFsImpl } = await import('../lib/fs.js')
const { AdapterHttpImpl } = await import('../lib/http.js')

let pass = 0, fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
async function rejects(name, fn, code, extraCheck) {
  try { await fn(); ok(name, false, '未抛错') }
  catch (e) {
    const codeOk = code ? (e && e.code === code) : true
    const extraOk = extraCheck ? extraCheck(e) === true : true
    ok(name, codeOk && extraOk, 'code=' + (e && e.code) + (extraCheck && !extraOk ? ' extraCheck=false msg=' + (e && e.message) : ''))
  }
}
function eq(name, actual, expect) { ok(name, actual === expect, 'actual=' + JSON.stringify(actual) + ' expect=' + JSON.stringify(expect)) }

// ============================ A) fs 套件 ============================
console.log('\n=== [A] adapterFs（真实宿主 fs 后端 SandboxedFileSystem + 真实文件）===')
const TMP = join(tmpdir(), 'dsh-adapter-smoke-' + process.pid)
const ROOT = join(TMP, '测试根')
mkdirSync(join(ROOT, '子'), { recursive: true })

const policySvc = {
  defaultMode: 'workspace-write',
  resolve: () => ({ mode: 'workspace-write', workspaceRoot: TMP }),
}
const ctxA = new Context()
ctxA.provide('sandboxPolicy', policySvc)
const realFs = new SandboxedFileSystem(ctxA, { cwd: process.cwd(), diffBasisMaxBytes: 8388608 })
ok('A0 真实 fs 后端就绪（sandboxMode capability fact）', realFs.sandboxMode === 'workspace-write', 'sandboxMode=' + realFs.sandboxMode)
ok('A0b 独立 Context 下 ctx.fs 服务可用', typeof ctxA.get('fs').readText === 'function')

const fsx = new AdapterFsImpl({
  fs: realFs,
  sandboxPolicy: policySvc,
  config: { roots: { 测试根: ROOT }, defaultDataRoot: '测试根', writePolicy: { mode: 'danger-full-access' } },
})

// A1 根解析 / 拼接
const tRoot = await fsx.root('测试根')
ok('A1 root(测试根) 命中登记路径', String(tRoot.displayPath).replace(/\\/g, '/').endsWith('/测试根'), tRoot.displayPath)
const tSub = await fsx.resolve('测试根', '子/a.json')
ok('A1b resolve(根, rel) 自动拼 DATA_ROOT', String(tSub.displayPath).replace(/\\/g, '/').endsWith('/测试根/子/a.json'), tSub.displayPath)
await rejects('A1c root(未登记) → ROOT_UNKNOWN', () => fsx.root('不存在的根'), 'ROOT_UNKNOWN')
await rejects('A1d resolve(相对名) → ROOT_UNKNOWN（不锚宿主 cwd）', () => fsx.resolve('灵感库/x.md'), 'ROOT_UNKNOWN')
await rejects('A1e 越根路径 → BAD_ARG', () => fsx.resolve('测试根', '../../etc/passwd'), 'BAD_ARG')

// A3 读写
const w1 = await fsx.writeJson('测试根', '子/a.json', { v: 1, 中文: '值' })
eq('A3a writeJson operation=create', w1.operation, 'create')
ok('A3a2 writeJson 落盘真实副作用', existsSync(join(ROOT, '子', 'a.json')), join(ROOT, '子', 'a.json'))
eq('A3b 落盘内容真实一致', JSON.parse(readFileSync(join(ROOT, '子', 'a.json'), 'utf8')).v, 1)
const r1 = await fsx.readJson('测试根', '子/a.json')
eq('A3c readJson 读回值', r1.中文, '值')
// cache:false 证据：绕过 adapter 直接改盘，再读即为新值
writeFileSync(join(ROOT, '子', 'a.json'), JSON.stringify({ v: 2 }), 'utf8')
const r2 = await fsx.readJson('测试根', '子/a.json')
eq('A3d 默认 cache:false 直读（外部改盘立即可见）', r2.v, 2)
const w2 = await fsx.writeJson('测试根', '子/a.json', { v: 3 })
eq('A3e writeJson operation=update', w2.operation, 'update')
ok('A3f 写后 version 变化（宿主原子写）', typeof w2.version === 'string' && w2.version.length > 0, w2.version)

// A4 文本
await fsx.writeText('测试根', '子/b.txt', 'hello 中文')
eq('A4a readText 读回', await fsx.readText('测试根', '子/b.txt'), 'hello 中文')

// A5 目录/存在/元信息
const ls = await fsx.listDir('测试根', '子')
eq('A5a listDir 项数', ls.length, 2)
eq('A5b listDir 稳定序（a.json 在前）', ls[0].name, 'a.json')
ok('A5c listDir 带 type/version/size', ls[0].type === 'file' && typeof ls[0].size === 'number', JSON.stringify(ls[0]))
eq('A5d exists 存在=true', await fsx.exists('测试根', '子/a.json'), true)
eq('A5e exists 缺失=false', await fsx.exists('测试根', '子/none.json'), false)
eq('A5f stat 缺失=undefined', await fsx.stat('测试根', '子/none.json'), undefined)
ok('A5g stat 存在返回版本', !!(await fsx.stat('测试根', '子/a.json')).version)

// A3.3 错误语义 + fallback 触发集合（§4.4 D1）
await rejects('A6a readJson 缺失 → FS_NOT_FOUND', () => fsx.readJson('测试根', '子/none.json'), 'FS_NOT_FOUND')
eq('A6b readJson 缺失 + fallback → fallback', JSON.stringify(await fsx.readJson('测试根', '子/none.json', { fallback: { empty: true } })), '{"empty":true}')
writeFileSync(join(ROOT, '子', 'bad.json'), 'not-json{', 'utf8')
await rejects('A6c JSON.parse 失败 → EBADJSON', () => fsx.readJson('测试根', '子/bad.json'), 'EBADJSON')
eq('A6d EBADJSON + fallback → fallback', JSON.stringify(await fsx.readJson('测试根', '子/bad.json', { fallback: [] })), '[]')
writeFileSync(join(ROOT, '子', 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
await rejects('A6e 二进制 → FS_NOT_TEXT', () => fsx.readText('测试根', '子/bin.dat'), 'FS_NOT_TEXT')
eq('A6f FS_NOT_TEXT + fallback → fallback', JSON.stringify(await fsx.readJson('测试根', '子/bin.dat', { fallback: 'FB' })), '"FB"')

// A6 缓存 + invalidate
await fsx.writeJson('测试根', '子/cache.json', { n: 1 })
const c1 = await fsx.readJson('测试根', '子/cache.json', { cacheMs: 60000 })
eq('A7a cacheMs 缓存首读', c1.n, 1)
writeFileSync(join(ROOT, '子', 'cache.json'), JSON.stringify({ n: 2 }), 'utf8')
eq('A7b 命中 TTL 缓存（返回旧值）', (await fsx.readJson('测试根', '子/cache.json', { cacheMs: 60000 })).n, 1)
fsx.invalidate('测试根:子/cache.json')
eq('A7c invalidate("root:rel") 后读到新值（§3.2 key 语义）', (await fsx.readJson('测试根', '子/cache.json', { cacheMs: 60000 })).n, 2)
await fsx.writeJson('测试根', '子/cache.json', { n: 3 })
eq('A7d 写后自动 invalidate', (await fsx.readJson('测试根', '子/cache.json', { cacheMs: 60000 })).n, 3)

// A8 resolveRef（settingsRef 坑回归）
const ref = await fsx.resolveRef('灵感库/某项.md')
ok('A8a resolveRef 相对引用锚 defaultDataRoot（非宿主 cwd）',
  String(ref.displayPath).replace(/\\/g, '/').startsWith(String(ROOT).replace(/\\/g, '/')) && !String(ref.displayPath).replace(/\\/g, '/').startsWith(String(process.cwd()).replace(/\\/g, '/')),
  ref.displayPath)
const bare = await realFs.resolve('灵感库/某项.md', { cwd: process.cwd() })
ok('A8b 对照：裸 fs.resolve 锚到宿主 cwd（旧坑形态，正是 resolveRef 要消灭的）',
  !String(bare.displayPath).replace(/\\/g, '/').startsWith(String(ROOT).replace(/\\/g, '/')),
  bare.displayPath)
const abs = await fsx.resolveRef('E:/DSH工作区/全局数据/x.json')
ok('A8c resolveRef 绝对路径直解', String(abs.displayPath).replace(/\\/g, '/').includes('/全局数据/x.json'), abs.displayPath)
// A2 触发表：未声明 defaultDataRoot = 无默认根 → 裸 resolveRef BAD_ARG（不隐式推导）
const fsNoDefault = new AdapterFsImpl({ fs: realFs, sandboxPolicy: policySvc, config: { roots: { 测试根: ROOT } } })
await rejects('A8d 未声明 defaultDataRoot → 裸 resolveRef 抛 BAD_ARG（A2 触发表）', () => fsNoDefault.resolveRef('x.md'), 'BAD_ARG')
const fsEmptyDefault = new AdapterFsImpl({ fs: realFs, sandboxPolicy: policySvc, config: { roots: { 测试根: ROOT }, defaultDataRoot: '' } })
const inf = await fsEmptyDefault.resolveRef('x.md')
ok('A8e 声明且为空 → 触发极薄回退链（sandboxPolicy.workspaceRoot）',
  String(inf.displayPath).replace(/\\/g, '/').startsWith(String(TMP).replace(/\\/g, '/')), inf.displayPath)

// A7/D2 写策略
const fsRo = new AdapterFsImpl({ fs: realFs, sandboxPolicy: policySvc, config: { roots: { 测试根: ROOT }, defaultDataRoot: '测试根', writePolicy: { mode: 'read-only' } } })
await rejects('A9a read-only policy → 透传 FS_SANDBOX_DENIED', () => fsRo.writeJson('测试根', '子/deny.json', { x: 1 }), 'FS_SANDBOX_DENIED')
const fsDefPolicy = new AdapterFsImpl({ fs: realFs, sandboxPolicy: policySvc, config: { roots: { 测试根: ROOT }, defaultDataRoot: '测试根' } })
const wd = await fsDefPolicy.writeJson('测试根', '子/def.json', { x: 1 })
eq('A9b 未配 writePolicy → 默认 danger-full-access（§3.1 A7）', wd.ok, true)
// D3 adapter 不可用
const fsNone = new AdapterFsImpl({ fs: null, sandboxPolicy: policySvc, config: { roots: {} } })
await rejects('A9c ctx.fs 缺失 → ADAPTER_UNAVAILABLE', () => fsNone.readJson('测试根', 'x.json'), 'ADAPTER_UNAVAILABLE')

// ============================ B) adapterHttp ============================
console.log('\n=== [B] adapterHttp（受控本地 http 服务 + 真实宿主 loopback）===')
const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, ct: req.headers['content-type'] || null, body })
    const send = (code, obj, raw) => {
      const payload = raw !== undefined ? raw : JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(payload)
    }
    if (req.url.startsWith('/ok')) return send(200, { ok: true, value: 1 })
    if (req.url.startsWith('/biz-fail')) return send(200, { ok: false, error: '业务校验失败: 中文错误' })
    if (req.url.startsWith('/err400')) return send(400, { ok: false, error: 'bad param' })
    if (req.url.startsWith('/err500')) return send(500, { ok: false, error: 'boom' })
    if (req.url.startsWith('/html404')) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html>not found</html>') }
    if (req.url.startsWith('/badjson')) return send(200, null, 'not-json{')
    if (req.url.startsWith('/slow')) return setTimeout(() => send(200, { ok: true, slow: true }), 400)
    return send(404, { ok: false, error: 'no route' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:' + server.address().port
const savedUrl = process.env.DSH_WEB_URL

process.env.DSH_WEB_URL = BASE + '/'
const http = new AdapterHttpImpl({ config: {} })
eq('B1a apiBase 去尾斜杠', http.apiBase(), BASE)
delete process.env.DSH_WEB_URL
eq('B1b 无 DSH_WEB_URL → 回退 127.0.0.1:3080（§4.4 D8，非错误）', http.apiBase(), 'http://127.0.0.1:3080')
ok('B1c 回退进 degraded 报告', new AdapterHttpImpl({ config: {} }).degraded.some((x) => x.includes('DSH_WEB_URL')), 'degraded=' + JSON.stringify(new AdapterHttpImpl({ config: {} }).degraded))
process.env.DSH_WEB_URL = BASE

const rOk = await http.post('/ok', { a: 1 })
eq('B2a post 成功 status=200 ok=true', rOk.status + '/' + rOk.ok, '200/true')
eq('B2b 成功 data 完整（不剥 ok 字段）', rOk.data.value, 1)
const p1 = seen[seen.length - 1]
ok('B2c 服务端真实收到 POST + JSON body', p1.method === 'POST' && p1.body === '{"a":1}' && String(p1.ct).includes('application/json'), JSON.stringify(p1))
await http.post('/ok', { a: 2 })
const postCount = seen.filter((s) => s.method === 'POST').length
ok('B2d POST 两次均必达 host（无缓存）+ 无 __t 参数', postCount === 2 && seen.filter((s) => s.method === 'POST').every((s) => !s.url.includes('__t=')), 'postCount=' + postCount)
await http.post('/ok')
ok('B2e post 空 payload 仍发 POST + content-type', seen[seen.length - 1].method === 'POST' && String(seen[seen.length - 1].ct).includes('application/json'), JSON.stringify(seen[seen.length - 1]))

const g1 = await http.get('/ok')
ok('B3a get 成功 200', g1.ok === true && g1.status === 200)
const g2 = await http.get('/ok')
ok('B3b get 自动 cache bust（__t=<ts>）', seen.filter((s) => s.method === 'GET').every((s) => /__t=\d+/.test(s.url)), seen[seen.length - 1].url)
await http.get('/ok', { cacheBust: false })
ok('B3c cacheBust:false 时不加 __t', !seen[seen.length - 1].url.includes('__t='), seen[seen.length - 1].url)

await rejects('B4a 非2xx(400) → HTTP_ERROR + status + body.error 透传',
  () => http.get('/err400'), 'HTTP_ERROR', (e) => e.status === 400 && e.remoteError === 'bad param' && e.body && e.body.ok === false)
await rejects('B4b 非2xx(500) → 透传 body.error',
  () => http.post('/err500', {}), 'HTTP_ERROR', (e) => e.status === 500 && e.remoteError === 'boom')
await rejects('B4c 2xx 但信封 ok:false → 同失败路径（D4）',
  () => http.post('/biz-fail', {}), 'HTTP_ERROR', (e) => e.status === 200 && String(e.remoteError).includes('业务校验失败'))
await rejects('B4d 非 2xx 且非 JSON body → HTTP_ERROR（remoteError=HTTP 404）',
  () => http.get('/html404'), 'HTTP_ERROR', (e) => e.status === 404 && e.remoteError === 'HTTP 404')
await rejects('B4e 2xx 非 JSON → EBADJSON（D7）', () => http.get('/badjson'), 'EBADJSON', (e) => e.status === 200)
await rejects('B4f 超时 → ETIMEOUT（D5）', () => http.get('/slow', { timeoutMs: 60 }), 'ETIMEOUT', (e) => e.status === 0)
await rejects('B4g 网络失败(端口未监听) → ENETWORK（D6）',
  () => new AdapterHttpImpl({ config: {} }).get('http://127.0.0.1:1/x'), null, null)
await rejects('B4g2 ENETWORK code 校验', () => new AdapterHttpImpl({ config: {} }).get('http://127.0.0.1:1/x'), 'ENETWORK')

const nc1 = await http.get('/err400', { throwOnError: false })
eq('B7a throwOnError:false 非2xx → {ok:false,error}', nc1.status + '/' + nc1.ok + '/' + nc1.error, '400/false/bad param')
const nc2 = await http.get('/slow', { timeoutMs: 60, throwOnError: false })
eq('B7b throwOnError:false 超时 → {status:0,error:timeout}', nc2.status + '/' + nc2.ok + '/' + nc2.error, '0/false/timeout')
const nc3 = await http.get('/badjson', { throwOnError: false })
eq('B7c throwOnError:false 非 JSON → invalid json', nc3.ok + '/' + nc3.error, 'false/invalid json')
const nc4 = await http.request('GET', '/ok')
eq('B7d request() 底层入口可用', nc4.ok, true)

process.env.DSH_WEB_URL = savedUrl === undefined ? 'http://127.0.0.1:3080' : savedUrl
const live = new AdapterHttpImpl({ config: {} })
console.log('  --- 真实宿主 loopback 往返（' + live.apiBase() + '）---')
const st = await live.get('/adapter/api/status')
ok('B8a 真实宿主 GET /adapter/api/status → 200 JSON', st.status === 200 && st.data && st.data.adapter, 'version=' + (st.data && st.data.adapter && st.data.adapter.version) + ' build=' + (st.data && st.data.adapter && st.data.adapter.build))
const stP = await live.post('/adapter/api/status', {})
ok('B8b 真实宿主 POST 同一前缀路由 → 200（POST 必达）', stP.status === 200 && stP.ok === true)
await rejects('B8c 真实宿主 不存在端点 → HTTP_ERROR 404（真实非2xx）', () => live.get('/definitely-missing-xyz'), 'HTTP_ERROR', (e) => e.status === 404)
// 真实业务插件端点的 body.error 透传（知识库未知 action → 404 + {ok:false,error:"未知 action: …"}）
await rejects('B8e 真实业务端点 404 → 透传 body.error（kb 未知 action）',
  () => live.post('/knowledge-base/api/nope', {}), 'HTTP_ERROR', (e) => e.status === 404 && typeof e.remoteError === 'string' && e.remoteError.length > 0)
// 跨插件只读端点（标准客户端驱动既有业务插件）
try {
  const tk = await live.post('/taskkit/api/read', {})
  ok('B8d 跨插件只读端点 /taskkit/api/read → 200', tk.status === 200, 'ok=' + tk.ok)
} catch (e) {
  ok('B8d 跨插件只读端点 /taskkit/api/read 可达（异常按 HTTP 语义抛出即可）', e && e.status !== undefined, 'code=' + (e && e.code) + ' status=' + (e && e.status))
}

server.close()
// ---- 净零 ----
rmSync(TMP, { recursive: true, force: true })
ok('Z1 测试数据净零（临时根已删除）', !existsSync(TMP), TMP)

console.log('\n=== 结果: 通过 ' + pass + ' / 失败 ' + fail + ' ===')
if (fail) { console.log('失败项:\n  - ' + failures.join('\n  - ')); process.exit(1) }
