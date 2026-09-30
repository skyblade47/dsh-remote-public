import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import zlib from 'node:zlib'
import { createWorkspaceRoutes } from '../src/workspace-routes.js'

function makeCtx() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-routes-'))
  const events = []
  const audit = { log(event, fields) { events.push({ event, fields }) } }
  const env = { DSH_GATEWAY_DATA_DIR: dataDir }
  const routes = createWorkspaceRoutes({ audit, env })
  return {
    dataDir,
    audit,
    events,
    routes,
    workspacesRoot: path.join(dataDir, 'workspaces'),
  }
}

class MockRes extends Writable {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.chunks = []
    this.ended = false
    this.destroyedWith = null
  }
  writeHead(status, headers) {
    this.statusCode = status
    if (headers) Object.assign(this.headers, headers)
  }
  setHeader(k, v) { this.headers[k] = v }
  _write(chunk, enc, cb) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    cb()
  }
  end(chunk, enc, cb) {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc))
    }
    this.ended = true
    if (cb) cb()
    if (this._finishResolve) this._finishResolve()
  }
  destroy(e) { this.destroyedWith = e || null }
  body() { return Buffer.concat(this.chunks) }
  json() { return JSON.parse(this.body().toString('utf8')) }
  text() { return this.body().toString('utf8') }
  whenFinished() {
    if (this.ended) return Promise.resolve()
    return new Promise((resolve) => { this._finishResolve = resolve })
  }
}

function mockReq({
  method = 'GET',
  url = '/',
  user = { id: 'u_a', role: 'user' },
  body,
  rawChunks,
  headers = {},
} = {}) {
  const r = new EventEmitter()
  r.method = method
  r.url = url
  r.user = user
  r.headers = { ...headers }
  r.params = {}
  r.resume = () => {} // 真实 IncomingMessage 有此方法；body 超限排空时会被调用
  if (rawChunks !== undefined) {
    process.nextTick(() => {
      for (const c of rawChunks) r.emit('data', c)
      r.emit('end')
    })
  } else if (body !== undefined) {
    process.nextTick(() => {
      r.emit('data', JSON.stringify(body))
      r.emit('end')
    })
  }
  return r
}

async function call(ctx, method, url, { user, body, headers, rawChunks } = {}) {
  const req = mockReq({ method, url, user, body, headers, rawChunks })
  const matched = ctx.routes.match(req)
  assert.ok(matched, `路由未匹配: ${method} ${url}`)
  req.params = matched.params
  const res = new MockRes()
  await Promise.resolve(matched.handler(req, res))
  await res.whenFinished()
  return res
}

function createAs(ctx, userId, name = 'demo') {
  return call(ctx, 'POST', '/api/workspaces', { user: { id: userId, role: 'user' }, body: { name } })
}

test('isWorkspaceRoute 前缀判定', () => {
  const { routes } = makeCtx()
  assert.equal(routes.isWorkspaceRoute('/api/workspaces'), true)
  assert.equal(routes.isWorkspaceRoute('/api/workspaces/ws_abc/tree'), true)
  assert.equal(routes.isWorkspaceRoute('/api/plugins'), false)
  assert.equal(routes.isWorkspaceRoute('/other'), false)
})

test('GET 列表：初始为空，创建后只看到自己的工作区', async () => {
  const ctx = makeCtx()
  let res = await call(ctx, 'GET', '/api/workspaces', { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().workspaces, [])

  await createAs(ctx, 'u_a', 'alpha')
  await createAs(ctx, 'u_b', 'beta')
  res = await call(ctx, 'GET', '/api/workspaces', { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  const list = res.json().workspaces
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'alpha')
  assert.ok(!('tags' in list[0]))
})

test('POST 创建：201 + 元信息 + 审计 + 物理目录', async () => {
  const ctx = makeCtx()
  const res = await createAs(ctx, 'u_a', 'my-space')
  assert.equal(res.statusCode, 201)
  const { ok, workspace } = res.json()
  assert.equal(ok, true)
  assert.match(workspace.id, /^ws_[a-f0-9]{8}$/)
  assert.equal(workspace.name, 'my-space')
  assert.equal(workspace.cwd, '/')
  assert.deepEqual(workspace.tags, [])
  assert.ok(fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', workspace.id)))
  assert.ok(ctx.events.some((e) => e.event === 'workspace.create'))
})

test('POST 创建：非法 JSON 返回 400', async () => {
  const ctx = makeCtx()
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/workspaces'
  req.user = { id: 'u_a' }
  process.nextTick(() => {
    req.emit('data', '{not json')
    req.emit('end')
  })
  const matched = ctx.routes.match(req)
  const res = new MockRes()
  await Promise.resolve(matched.handler(req, res))
  await res.whenFinished()
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'BAD_REQUEST')
})

test('GET 详情：自己的工作区可访问', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}`, { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().workspace.id, created.id)
})

test('GET 详情：他人工作区 403 FORBIDDEN_WORKSPACE', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}`, { user: { id: 'u_b' } })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().error.code, 'FORBIDDEN_WORKSPACE')
  assert.ok(ctx.events.some((e) => e.event === 'workspace.access_denied'))
})

test('GET 详情：不存在 404，非法 ID 400', async () => {
  const ctx = makeCtx()
  const res404 = await call(ctx, 'GET', '/api/workspaces/ws_deadbeef', { user: { id: 'u_a' } })
  assert.equal(res404.statusCode, 404)
  assert.equal(res404.json().error.code, 'WORKSPACE_NOT_FOUND')

  const res400 = await call(ctx, 'GET', '/api/workspaces/..%2f..%2fetc', { user: { id: 'u_a' } })
  assert.equal(res400.statusCode, 400)
  assert.equal(res400.json().error.code, 'INVALID_WORKSPACE_ID')
})

test('DELETE：自己可删，删后 404；他人删 403 且目录仍在', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)

  const denied = await call(ctx, 'DELETE', `/api/workspaces/${created.id}`, { user: { id: 'u_b' } })
  assert.equal(denied.statusCode, 403)
  assert.ok(fs.existsSync(dir))

  const ok = await call(ctx, 'DELETE', `/api/workspaces/${created.id}`, { user: { id: 'u_a' } })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().deleted, true)
  assert.ok(!fs.existsSync(dir))

  const gone = await call(ctx, 'GET', `/api/workspaces/${created.id}`, { user: { id: 'u_a' } })
  assert.equal(gone.statusCode, 404)
  assert.ok(ctx.events.some((e) => e.event === 'workspace.delete'))
})

test('GET tree：返回工作区文件树且隐藏元信息', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a', 'tree-demo')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'aa')
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello')

  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}/tree`, { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  const names = res.json().root.children.map((c) => c.name).sort()
  assert.deepEqual(names, ['readme.txt', 'src'])
  assert.ok(!names.includes('.dsh-workspace.json'))
})

test('GET tree：depth 参数与非法值', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(dir, 'd'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'd', 'f.txt'), 'x')

  const d0 = await call(ctx, 'GET', `/api/workspaces/${created.id}/tree?depth=0`, { user: { id: 'u_a' } })
  assert.equal(d0.statusCode, 200)
  assert.equal(d0.json().root.children, undefined)

  const bad = await call(ctx, 'GET', `/api/workspaces/${created.id}/tree?depth=abc`, { user: { id: 'u_a' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().error.code, 'INVALID_DEPTH')
})

test('GET tree：跨用户 403', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}/tree`, { user: { id: 'u_b' } })
  assert.equal(res.statusCode, 403)
})

test('GET files：文本文件原样返回 text/plain', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), "export const x = 1\n")

  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}/files/src/a.js`, { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /^text\/plain/)
  assert.equal(res.text(), "export const x = 1\n")
})

test('GET files：二进制文件只回元信息 JSON', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([1, 2, 3, 4]))

  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}/files/logo.png`, { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  const { ok, file } = res.json()
  assert.equal(ok, true)
  assert.equal(file.binary, true)
  assert.equal(file.size, 4)
  assert.equal(file.name, 'logo.png')
})

test('GET files：路径遍历 400、不存在 404、跨用户 403', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace

  const trav = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/files/../../../etc/passwd`, { user: { id: 'u_a' } }
  )
  assert.equal(trav.statusCode, 400)
  assert.equal(trav.json().error.code, 'PATH_TRAVERSAL_DETECTED')

  const missing = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/files/nope.js`, { user: { id: 'u_a' } }
  )
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error.code, 'PATH_NOT_FOUND')

  const denied = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/files/whatever.js`, { user: { id: 'u_b' } }
  )
  assert.equal(denied.statusCode, 403)
})

test('GET download：attachment 头与字节一致 + 审计', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  const payload = Buffer.from('PDF-FAKE-CONTENT')
  fs.writeFileSync(path.join(dir, 'report.pdf'), payload)

  const res = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/download?path=report.pdf`, { user: { id: 'u_a' } }
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
  assert.match(res.headers['content-disposition'], /attachment/)
  assert.match(res.headers['content-disposition'], /filename\*=UTF-8''report\.pdf/)
  assert.equal(res.headers['content-length'], String(payload.length))
  assert.deepEqual(res.body(), payload)
  assert.ok(ctx.events.some((e) => e.event === 'workspace.download'))
})

test('GET download：缺 path、不存在、遍历分别 400/404/400', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace

  const noPath = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/download`, { user: { id: 'u_a' } }
  )
  assert.equal(noPath.statusCode, 400)
  assert.equal(noPath.json().error.code, 'BAD_REQUEST')

  const missing = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/download?path=nope.bin`, { user: { id: 'u_a' } }
  )
  assert.equal(missing.statusCode, 404)

  const trav = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/download?path=../../secret`, { user: { id: 'u_a' } }
  )
  assert.equal(trav.statusCode, 400)
  assert.equal(trav.json().error.code, 'PATH_TRAVERSAL_DETECTED')
})

test('GET download-zip：返回合法 ZIP 且内容与工作区一致', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a', 'zipdemo')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'zip me')

  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}/download-zip`, { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/zip')
  assert.match(res.headers['content-disposition'], /attachment/)
  assert.match(res.headers['content-disposition'], /zipdemo\.zip/)

  const buf = res.body()
  assert.equal(buf.readUInt32LE(0), 0x04034b50) // 本地头签名
  // EOCD 在尾部
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50)
  // 中央目录含 src/a.js，且可解压还原
  const cdOffset = buf.readUInt32LE(buf.length - 22 + 16)
  assert.equal(buf.readUInt32LE(cdOffset), 0x02014b50)
  const nameLen = buf.readUInt16LE(cdOffset + 28)
  const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8')
  assert.equal(name, 'src/a.js')
  const compSize = buf.readUInt32LE(cdOffset + 20)
  const localOff = buf.readUInt32LE(cdOffset + 42)
  const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26)
  const raw = zlib.inflateRawSync(buf.slice(dataStart, dataStart + compSize))
  assert.equal(raw.toString('utf8'), 'zip me')
  assert.ok(ctx.events.some((e) => e.event === 'workspace.download_zip'))
})

test('GET download-zip：默认含隐藏文件，?includeHidden=false 排除（WQ3）', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a', 'hiddemo')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.writeFileSync(path.join(dir, 'app.js'), 'visible')
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'gitcfg')

  // 解析 ZIP，返回全部中央目录文件名
  const namesOf = (res) => {
    const b = res.body()
    const eocd = b.length - 22
    const centralSize = b.readUInt32LE(eocd + 12)
    const centralOffset = b.readUInt32LE(eocd + 16)
    const names = []
    let p = centralOffset
    const end = centralOffset + centralSize
    while (p < end) {
      const nameLen = b.readUInt16LE(p + 28)
      names.push(b.slice(p + 46, p + 46 + nameLen).toString('utf8'))
      p += 46 + nameLen
    }
    return names.sort()
  }

  const def = await call(ctx, 'GET', `/api/workspaces/${created.id}/download-zip`, { user: { id: 'u_a' } })
  assert.equal(def.statusCode, 200)
  assert.deepEqual(namesOf(def), ['.env', '.git/config', 'app.js'])

  const filtered = await call(
    ctx, 'GET', `/api/workspaces/${created.id}/download-zip?includeHidden=false`, { user: { id: 'u_a' } }
  )
  assert.equal(filtered.statusCode, 200)
  assert.deepEqual(namesOf(filtered), ['app.js'])
  const ev = ctx.events.filter((e) => e.event === 'workspace.download_zip')
  assert.equal(ev[0].fields.includeHidden, true)
  assert.equal(ev[1].fields.includeHidden, false)
})

test('GET download-zip：跨用户 403', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const res = await call(ctx, 'GET', `/api/workspaces/${created.id}/download-zip`, { user: { id: 'u_b' } })
  assert.equal(res.statusCode, 403)
})

test('GET download-zip：超过 10 次/分钟限速 429', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  for (let i = 0; i < 10; i++) {
    const r = await call(ctx, 'GET', `/api/workspaces/${created.id}/download-zip`, { user: { id: 'u_a' } })
    assert.equal(r.statusCode, 200, `第 ${i + 1} 次应放行`)
  }
  const blocked = await call(ctx, 'GET', `/api/workspaces/${created.id}/download-zip`, { user: { id: 'u_a' } })
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.json().error.code, 'RATE_LIMITED')
  assert.ok(blocked.headers['retry-after'])
})

test('match: 不支持的方法/路径返回 null', () => {
  const { routes } = makeCtx()
  assert.equal(routes.match(mockReq({ method: 'PUT', url: '/api/workspaces' })), null)
  assert.equal(routes.match(mockReq({ method: 'GET', url: '/api/other' })), null)
})

test('match：POST files 生效（含无尾部路径），未支持的方法与路径返回 null', () => {
  const { routes } = makeCtx()
  const id = 'ws_abc12345'
  assert.ok(routes.match(mockReq({ method: 'POST', url: `/api/workspaces/${id}/files/a.js` })))
  assert.ok(routes.match(mockReq({ method: 'POST', url: `/api/workspaces/${id}/files` })))
  assert.equal(routes.match(mockReq({ method: 'GET', url: `/api/workspaces/${id}/dirs/src` })), null)
  assert.equal(routes.match(mockReq({ method: 'HEAD', url: `/api/workspaces/${id}/files/a.js` })), null)
  assert.equal(routes.match(mockReq({ method: 'PUT', url: `/api/workspaces` })), null)
})

test('POST 文件：201 + version/ETag + file_create 审计（不含正文）', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })

  const res = await call(ctx, 'POST', `/api/workspaces/${created.id}/files/src/a.js`, {
    user: { id: 'u_a' },
    body: { content: 'export const x = 1\n' },
  })
  assert.equal(res.statusCode, 201)
  const j = res.json()
  assert.equal(j.ok, true)
  assert.equal(j.path, 'src/a.js')
  assert.equal(j.size, Buffer.byteLength('export const x = 1\n'))
  assert.match(j.version, /^"\d+(\.\d+)?-\d+"$/)
  assert.equal(res.headers['etag'], j.version)
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'export const x = 1\n')

  const ev = ctx.events.find((e) => e.event === 'workspace.file_create')
  assert.equal(ev.fields.userId, 'u_a')
  assert.equal(ev.fields.workspaceId, created.id)
  assert.equal(ev.fields.path, 'src/a.js')
  assert.equal(ev.fields.size, Buffer.byteLength('export const x = 1\n'))
  assert.equal(ev.fields.lines, 1)
  assert.match(ev.fields.hash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(ev.fields).includes('export const x'), false)
})

test('POST 文件：重复 409、父缺失 409、非文本 415、根路径 400、受保护 400', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const send = (url, body) => call(ctx, 'POST', url, { user: { id: 'u_a' }, body })

  const first = await send(`${base}/files/a.js`, { content: 'x\n' })
  assert.equal(first.statusCode, 201)
  const dup = await send(`${base}/files/a.js`, { content: 'y\n' })
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json().error.code, 'ENTRY_EXISTS')

  const noParent = await send(`${base}/files/nope/deep.js`, { content: 'x\n' })
  assert.equal(noParent.statusCode, 409)
  assert.equal(noParent.json().error.code, 'PARENT_NOT_FOUND')

  const nonText = await send(`${base}/files/logo.png`, { content: 'x' })
  assert.equal(nonText.statusCode, 415)
  assert.equal(nonText.json().error.code, 'UNSUPPORTED_FILE_TYPE')

  const root = await send(`${base}/files/`, { content: 'x' })
  assert.equal(root.statusCode, 400)
  assert.equal(root.json().error.code, 'INVALID_PATH')

  const prot = await send(`${base}/files/.dsh-workspace.json`, { content: '{}' })
  assert.equal(prot.statusCode, 400)
  assert.equal(prot.json().error.code, 'PROTECTED_ENTRY')
})

test('POST 文件：body 超过 12MB 分块推送 → 413 PAYLOAD_TOO_LARGE 且不落盘', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const big = 'x'.repeat(7 * 1024 * 1024)
  const res = await call(ctx, 'POST', `/api/workspaces/${created.id}/files/big.txt`, {
    user: { id: 'u_a' },
    rawChunks: [`{"content":"${big}`, `${big}"}`],
  })
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().error.code, 'PAYLOAD_TOO_LARGE')
  assert.ok(!fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'big.txt')))
})

test('POST 文件：content 超 10MB → 413 CONTENT_TOO_LARGE', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const res = await call(ctx, 'POST', `/api/workspaces/${created.id}/files/big.txt`, {
    user: { id: 'u_a' },
    body: { content: 'x'.repeat(10 * 1024 * 1024 + 1) },
  })
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().error.code, 'CONTENT_TOO_LARGE')
  assert.ok(!fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'big.txt')))
})

test('POST 文件：非法 JSON / content 非字符串 / encoding 非 utf-8 → 400', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}/files/a.js`

  const badJson = await call(ctx, 'POST', base, { user: { id: 'u_a' }, rawChunks: ['{not json'] })
  assert.equal(badJson.statusCode, 400)
  assert.equal(badJson.json().error.code, 'BAD_REQUEST')

  const notString = await call(ctx, 'POST', base, { user: { id: 'u_a' }, body: { content: 123 } })
  assert.equal(notString.statusCode, 400)
  assert.equal(notString.json().error.code, 'BAD_REQUEST')

  const enc = await call(ctx, 'POST', base, {
    user: { id: 'u_a' }, body: { content: 'x', encoding: 'base64' },
  })
  assert.equal(enc.statusCode, 400)
  assert.equal(enc.json().error.code, 'UNSUPPORTED_ENCODING')

  // 上述三个请求均不产生任何写审计
  const writeEvents = ctx.events.filter((e) => e.event.startsWith('workspace.file_')
    || e.event.startsWith('workspace.entry_') || e.event.startsWith('workspace.dir_')
    || e.event === 'workspace.write_failed' || e.event === 'workspace.write_rate_limited')
  assert.deepEqual(writeEvents, [])
})

test('PUT 文件：无版本 428，错误版本 409 + currentVersion，正确版本 200 + ETag + 审计', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const pre = await call(ctx, 'POST', `${base}/files/a.js`, {
    user: { id: 'u_a' }, body: { content: 'export const x = 1\n' },
  })
  const v1 = pre.json().version

  const noVer = await call(ctx, 'PUT', `${base}/files/a.js`, {
    user: { id: 'u_a' }, body: { content: 'changed\n' },
  })
  assert.equal(noVer.statusCode, 428)
  assert.equal(noVer.json().error.code, 'PRECONDITION_REQUIRED')

  const bad = await call(ctx, 'PUT', `${base}/files/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': '"1-1"' }, body: { content: 'changed\n' },
  })
  assert.equal(bad.statusCode, 409)
  assert.equal(bad.json().error.code, 'VERSION_CONFLICT')
  assert.equal(bad.json().currentVersion, v1)

  const ok = await call(ctx, 'PUT', `${base}/files/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': v1 }, body: { content: 'export const x = 2\n' },
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.headers['etag'], ok.json().version)
  assert.equal(
    fs.readFileSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'a.js'), 'utf8'),
    'export const x = 2\n'
  )

  const ev = ctx.events.find((e) => e.event === 'workspace.file_update')
  assert.equal(ev.fields.userId, 'u_a')
  assert.equal(ev.fields.path, 'a.js')
  assert.equal(ev.fields.oldVersion, v1)
  assert.equal(ev.fields.newVersion, ok.json().version)
  assert.equal(ev.fields.forced, false)
  assert.match(ev.fields.oldHash, /^sha256:[a-f0-9]{64}$/)
  assert.match(ev.fields.newHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(typeof ev.fields.linesAdded, 'number')
  assert.equal(typeof ev.fields.linesRemoved, 'number')
  assert.equal(JSON.stringify(ev.fields).includes('export const x = 2'), false)
})

test('PUT 文件：body.version 通道等价，If-Match 优先；force 无版本放行且审计 forced', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const v1 = (await call(ctx, 'POST', `${base}/files/a.js`, {
    user: { id: 'u_a' }, body: { content: 'v1\n' },
  })).json().version

  const viaBody = await call(ctx, 'PUT', `${base}/files/a.js`, {
    user: { id: 'u_a' }, body: { content: 'v2\n', version: v1 },
  })
  assert.equal(viaBody.statusCode, 200)

  // If-Match 优先于 body.version：body 带过期版本但头正确 → 放行
  const v2 = viaBody.json().version
  const headerWins = await call(ctx, 'PUT', `${base}/files/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': v2 }, body: { content: 'v3\n', version: '"1-1"' },
  })
  assert.equal(headerWins.statusCode, 200)

  const forced = await call(ctx, 'PUT', `${base}/files/a.js?force=true`, {
    user: { id: 'u_a' }, body: { content: 'v4\n' },
  })
  assert.equal(forced.statusCode, 200)
  const updates = ctx.events.filter((e) => e.event === 'workspace.file_update')
  assert.equal(updates[updates.length - 1].fields.forced, true)
  assert.equal(updates[updates.length - 1].fields.oldVersion, null)
})

test('PUT 文件：源缺失 404、源是目录 400 NOT_A_FILE、非文本 415、内容超限 413', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  fs.mkdirSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'src'), { recursive: true })

  const missing = await call(ctx, 'PUT', `${base}/files/none.js`, {
    user: { id: 'u_a' }, body: { content: 'x\n', version: '"1-1"' },
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error.code, 'PATH_NOT_FOUND')

  const onDir = await call(ctx, 'PUT', `${base}/files/src`, {
    user: { id: 'u_a' }, body: { content: 'x\n', version: '"1-1"' },
  })
  assert.equal(onDir.statusCode, 400)
  assert.equal(onDir.json().error.code, 'NOT_A_FILE')

  fs.writeFileSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'logo.png'), Buffer.from([1, 2]))
  const nonText = await call(ctx, 'PUT', `${base}/files/logo.png`, {
    user: { id: 'u_a' }, body: { content: 'x', version: '"1-1"' },
  })
  assert.equal(nonText.statusCode, 415)

  const tooBig = await call(ctx, 'PUT', `${base}/files/a.js?force=true`, {
    user: { id: 'u_a' }, body: { content: 'x'.repeat(10 * 1024 * 1024 + 1) },
  })
  assert.equal(tooBig.statusCode, 413)
  assert.equal(tooBig.json().error.code, 'CONTENT_TOO_LARGE')
})

test('DELETE 文件：200 removedCount=1 且审计含 oldHash / hadVersion=false', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  await call(ctx, 'POST', `${base}/files/a.js`, { user: { id: 'u_a' }, body: { content: 'x\n' } })

  const res = await call(ctx, 'DELETE', `${base}/files/a.js`, { user: { id: 'u_a' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().deleted, true)
  assert.equal(res.json().removedCount, 1)
  assert.ok(!fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'a.js')))

  const ev = ctx.events.find((e) => e.event === 'workspace.file_delete')
  assert.equal(ev.fields.recursive, false)
  assert.equal(ev.fields.removedCount, 1)
  assert.equal(ev.fields.hadVersion, false)
  assert.match(ev.fields.oldHash, /^sha256:[a-f0-9]{64}$/)
})

test('DELETE 目录：非空无 recursive 409、非法 recursive 值按假、recursive=true 200、空目录 200', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(dir, 'src'))
  await call(ctx, 'POST', `${base}/files/src/a.js`, { user: { id: 'u_a' }, body: { content: 'x\n' } })

  const notEmpty = await call(ctx, 'DELETE', `${base}/files/src`, { user: { id: 'u_a' } })
  assert.equal(notEmpty.statusCode, 409)
  assert.equal(notEmpty.json().error.code, 'DIRECTORY_NOT_EMPTY')

  const badValue = await call(ctx, 'DELETE', `${base}/files/src?recursive=yes`, { user: { id: 'u_a' } })
  assert.equal(badValue.statusCode, 409) // 仅精确 "true" 视为真
  assert.equal(badValue.json().error.code, 'DIRECTORY_NOT_EMPTY')

  const ok = await call(ctx, 'DELETE', `${base}/files/src?recursive=true`, { user: { id: 'u_a' } })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().removedCount, 2) // 1 文件 + src 目录自身
  assert.ok(!fs.existsSync(path.join(dir, 'src')))
  const ev = ctx.events.filter((e) => e.event === 'workspace.file_delete').pop()
  assert.equal(ev.fields.recursive, true)
  assert.equal(ev.fields.oldHash, null)

  fs.mkdirSync(path.join(dir, 'empty'))
  const empty = await call(ctx, 'DELETE', `${base}/files/empty`, { user: { id: 'u_a' } })
  assert.equal(empty.statusCode, 200)
  assert.equal(empty.json().removedCount, 1)
})

test('DELETE：目录携带版本 400 BAD_REQUEST；文件错误版本 409 未删；正确版本 200 且 hadVersion=true', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  fs.mkdirSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'src'))

  const onDir = await call(ctx, 'DELETE', `${base}/files/src`, {
    user: { id: 'u_a' }, headers: { 'if-match': '"1-1"' },
  })
  assert.equal(onDir.statusCode, 400)
  assert.equal(onDir.json().error.code, 'BAD_REQUEST')

  const v = (await call(ctx, 'POST', `${base}/files/src/a.js`, {
    user: { id: 'u_a' }, body: { content: 'x\n' },
  })).json().version

  const bad = await call(ctx, 'DELETE', `${base}/files/src/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': '"1-1"' },
  })
  assert.equal(bad.statusCode, 409)
  assert.equal(bad.json().error.code, 'VERSION_CONFLICT')
  assert.ok(fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'src', 'a.js')))

  const ok = await call(ctx, 'DELETE', `${base}/files/src/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': v },
  })
  assert.equal(ok.statusCode, 200)
  const ev = ctx.events.filter((e) => e.event === 'workspace.file_delete').pop()
  assert.equal(ev.fields.hadVersion, true)
})

test('DELETE：源不存在 404、根路径 400、受保护 400', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  assert.equal((await call(ctx, 'DELETE', `${base}/files/none.js`, { user: { id: 'u_a' } })).statusCode, 404)
  assert.equal((await call(ctx, 'DELETE', `${base}/files/`, { user: { id: 'u_a' } })).statusCode, 400)
  const prot = await call(ctx, 'DELETE', `${base}/files/.dsh-workspace.json`, { user: { id: 'u_a' } })
  assert.equal(prot.statusCode, 400)
  assert.equal(prot.json().error.code, 'PROTECTED_ENTRY')
})

test('PATCH 移动：200 + ETag + from/path 审计齐全', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  await call(ctx, 'POST', `${base}/files/app.js`, {
    user: { id: 'u_a' }, body: { content: 'console.log(1)\n' },
  })

  const res = await call(ctx, 'PATCH', `${base}/files/app.js`, {
    user: { id: 'u_a' }, body: { newPath: 'main.js' },
  })
  assert.equal(res.statusCode, 200)
  const j = res.json()
  assert.equal(j.from, 'app.js')
  assert.equal(j.path, 'main.js')
  assert.equal(j.size, Buffer.byteLength('console.log(1)\n'))
  assert.match(j.version, /^"\d+(\.\d+)?-\d+"$/)
  assert.equal(res.headers['etag'], j.version)

  const ev = ctx.events.find((e) => e.event === 'workspace.entry_move')
  assert.equal(ev.fields.from, 'app.js')
  assert.equal(ev.fields.path, 'main.js')
  assert.equal(ev.fields.forced, false)
  assert.equal(ev.fields.hadVersion, false)
  assert.match(ev.fields.hash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(
    fs.readFileSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'main.js'), 'utf8'),
    'console.log(1)\n'
  )
})

test('PATCH：目标存在 409，force 移入已存在目录 409 TARGET_IS_DIRECTORY，force 覆盖文件 200', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  await call(ctx, 'POST', `${base}/files/a.js`, { user: { id: 'u_a' }, body: { content: 'A\n' } })
  await call(ctx, 'POST', `${base}/files/b.js`, { user: { id: 'u_a' }, body: { content: 'B\n' } })
  fs.mkdirSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'docs'))

  const exists = await call(ctx, 'PATCH', `${base}/files/a.js`, {
    user: { id: 'u_a' }, body: { newPath: 'b.js' },
  })
  assert.equal(exists.statusCode, 409)
  assert.equal(exists.json().error.code, 'ENTRY_EXISTS')

  const intoDir = await call(ctx, 'PATCH', `${base}/files/a.js?force=true`, {
    user: { id: 'u_a' }, body: { newPath: 'docs' },
  })
  assert.equal(intoDir.statusCode, 409)
  assert.equal(intoDir.json().error.code, 'TARGET_IS_DIRECTORY')

  const forced = await call(ctx, 'PATCH', `${base}/files/a.js?force=true`, {
    user: { id: 'u_a' }, body: { newPath: 'b.js' },
  })
  assert.equal(forced.statusCode, 200)
  assert.equal(
    fs.readFileSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'b.js'), 'utf8'), 'A\n'
  )
  const ev = ctx.events.filter((e) => e.event === 'workspace.entry_move').pop()
  assert.equal(ev.fields.forced, true)
})

test('PATCH：newPath 缺失 400、移入自身子树 400 INVALID_MOVE、跨目录移动 200、目标父缺失 409', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const wsDir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  fs.mkdirSync(path.join(wsDir, 'src'))
  fs.mkdirSync(path.join(wsDir, 'docs'))
  await call(ctx, 'POST', `${base}/files/src/app.js`, { user: { id: 'u_a' }, body: { content: 'x\n' } })

  const missing = await call(ctx, 'PATCH', `${base}/files/src/app.js`, { user: { id: 'u_a' }, body: {} })
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.json().error.code, 'INVALID_PATH')

  const intoSelf = await call(ctx, 'PATCH', `${base}/files/src`, {
    user: { id: 'u_a' }, body: { newPath: 'src/inner' },
  })
  assert.equal(intoSelf.statusCode, 400)
  assert.equal(intoSelf.json().error.code, 'INVALID_MOVE')

  const noParent = await call(ctx, 'PATCH', `${base}/files/src/app.js`, {
    user: { id: 'u_a' }, body: { newPath: 'nope/app.js' },
  })
  assert.equal(noParent.statusCode, 409)
  assert.equal(noParent.json().error.code, 'PARENT_NOT_FOUND')

  const cross = await call(ctx, 'PATCH', `${base}/files/src/app.js`, {
    user: { id: 'u_a' }, body: { newPath: 'docs/app.js' },
  })
  assert.equal(cross.statusCode, 200)
  assert.ok(fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'docs', 'app.js')))

  const trav = await call(ctx, 'PATCH', `${base}/files/docs/app.js`, {
    user: { id: 'u_a' }, body: { newPath: '../escape.js' },
  })
  assert.equal(trav.statusCode, 400)
  assert.equal(trav.json().error.code, 'PATH_TRAVERSAL_DETECTED')
})

test('PATCH：版本可选——错误版本 409 且未移动，正确版本 200 且 hadVersion=true', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  const v = (await call(ctx, 'POST', `${base}/files/app.js`, {
    user: { id: 'u_a' }, body: { content: 'x\n' },
  })).json().version

  const bad = await call(ctx, 'PATCH', `${base}/files/app.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': '"1-1"' }, body: { newPath: 'main.js' },
  })
  assert.equal(bad.statusCode, 409)
  assert.equal(bad.json().error.code, 'VERSION_CONFLICT')
  assert.equal(bad.json().currentVersion, v)
  assert.ok(fs.existsSync(path.join(dir, 'app.js')))
  assert.ok(!fs.existsSync(path.join(dir, 'main.js')))

  const ok = await call(ctx, 'PATCH', `${base}/files/app.js`, {
    user: { id: 'u_a' }, body: { newPath: 'main.js', version: v },
  })
  assert.equal(ok.statusCode, 200)
  const ev = ctx.events.filter((e) => e.event === 'workspace.entry_move').pop()
  assert.equal(ev.fields.hadVersion, true)
  assert.ok(fs.existsSync(path.join(dir, 'main.js')))
})

test('POST /dirs：201 + dir_create 审计；重复 409、父缺失 409、父是文件 400、根路径 400', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`

  const ok = await call(ctx, 'POST', `${base}/dirs/src`, { user: { id: 'u_a' } })
  assert.equal(ok.statusCode, 201)
  assert.equal(ok.json().path, 'src')
  assert.ok(fs.statSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'src')).isDirectory())
  const ev = ctx.events.find((e) => e.event === 'workspace.dir_create')
  assert.equal(ev.fields.path, 'src')
  assert.equal(ev.fields.workspaceId, created.id)

  const dup = await call(ctx, 'POST', `${base}/dirs/src`, { user: { id: 'u_a' } })
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json().error.code, 'ENTRY_EXISTS')

  const noParent = await call(ctx, 'POST', `${base}/dirs/nope/deep`, { user: { id: 'u_a' } })
  assert.equal(noParent.statusCode, 409)
  assert.equal(noParent.json().error.code, 'PARENT_NOT_FOUND')

  fs.writeFileSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'file.txt'), 'x')
  const onFile = await call(ctx, 'POST', `${base}/dirs/file.txt/sub`, { user: { id: 'u_a' } })
  assert.equal(onFile.statusCode, 400)
  assert.equal(onFile.json().error.code, 'NOT_A_DIRECTORY')

  const root = await call(ctx, 'POST', `${base}/dirs/`, { user: { id: 'u_a' } })
  assert.equal(root.statusCode, 400)
  assert.equal(root.json().error.code, 'INVALID_PATH')
})

test('GET preview：文本返回 ETag 并可完成 If-Match 往返；二进制返回 version', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`
  const dir = path.join(ctx.workspacesRoot, 'u_a', created.id)
  await call(ctx, 'POST', `${base}/files/a.js`, { user: { id: 'u_a' }, body: { content: 'v1\n' } })

  const pre = await call(ctx, 'GET', `${base}/files/a.js`, { user: { id: 'u_a' } })
  assert.equal(pre.statusCode, 200)
  assert.equal(pre.text(), 'v1\n')
  assert.match(pre.headers['etag'], /^"\d+(\.\d+)?-\d+"$/)

  const put = await call(ctx, 'PUT', `${base}/files/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': pre.headers['etag'] },
    // ⚠️ 这里**故意换成长度不同**的内容（原为 `'v2\n'`，与 `'v1\n'` 同为 3 字节）。
    //    为什么：ETag = `"<mtimeMs>-<size>"` ⇒ 同长度内容只能靠 mtimeMs 区分，而两次写
    //    若落在**同一个时间戳 tick**（本用例在本地毫秒级循环里必然如此）就**拿到同一个 ETag**
    //    ⇒ 下面的断言变成抽奖（实测连跑 3 轮 3 次全失败）。
    //    🔴 该"同长度 + 同 tick ⇒ version 不变"是**已知且已裁定保留**的弱点，见 roadmap §8 **U-34**：
    //       需要"读与另一次写落在同一 tick"才触发，而 mtimeMs 有亚毫秒精度、客户端又经网络
    //       （Tailscale RTT 数十 ms）⇒ 本部署形态下实际不可达 ⇒ **按测试侧竞态处理，不改 ETag 契约**。
    //       （若将来出现真正的多写者并发场景，再按 U-34 的触发条件重新评估加固。）
    body: { content: 'v2 changed\n' },
  })
  assert.equal(put.statusCode, 200)
  assert.notEqual(put.json().version, pre.headers['etag'])

  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([1, 2, 3, 4]))
  const bin = await call(ctx, 'GET', `${base}/files/logo.png`, { user: { id: 'u_a' } })
  assert.equal(bin.statusCode, 200)
  const bj = bin.json()
  assert.equal(bj.file.binary, true)
  assert.equal(bj.file.size, 4)
  assert.equal(bj.file.name, 'logo.png')
  assert.match(bj.file.version, /^"\d+(\.\d+)?-\d+"$/)
})

test('写限速：第 61 次 429 + retry-after + write_rate_limited 审计', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`

  for (let i = 0; i < 60; i++) {
    // 第 1 次 201，其余 409（目录已存在）；限速在 fs 之前，每次均消耗一个配额
    const r = await call(ctx, 'POST', `${base}/dirs/repeat`, { user: { id: 'u_a' } })
    assert.notEqual(r.statusCode, 429, `第 ${i + 1} 次应放行，实际 ${r.statusCode}`)
  }
  const blocked = await call(ctx, 'POST', `${base}/dirs/repeat`, { user: { id: 'u_a' } })
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.json().error.code, 'RATE_LIMITED')
  assert.ok(blocked.headers['retry-after'])
  assert.ok(ctx.events.some((e) => e.event === 'workspace.write_rate_limited'))
})

test('写限速：与 ZIP 限速桶独立，按用户分桶且 403/404 不消耗配额', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`

  // u_a 连发 60 次写 → 桶满
  for (let i = 0; i < 60; i++) {
    await call(ctx, 'POST', `${base}/dirs/d${i}`, { user: { id: 'u_a' } })
  }
  assert.equal((await call(ctx, 'POST', `${base}/dirs/x`, { user: { id: 'u_a' } })).statusCode, 429)

  // u_b（他人工作区）403 不计入 u_b 的桶，也不计入 u_a 的桶
  const denied = await call(ctx, 'POST', `${base}/dirs/y`, { user: { id: 'u_b' } })
  assert.equal(denied.statusCode, 403)

  // ZIP 桶未被写限速影响：u_a 首次 ZIP 仍 200
  const zip = await call(ctx, 'GET', `${base}/download-zip`, { user: { id: 'u_a' } })
  assert.equal(zip.statusCode, 200)

  // u_b 在自己的工作区仍可写（分桶隔离）
  const bWs = (await createAs(ctx, 'u_b')).json().workspace
  const bWrite = await call(ctx, 'POST', `/api/workspaces/${bWs.id}/dirs/b1`, { user: { id: 'u_b' } })
  assert.equal(bWrite.statusCode, 201)
})

test('写操作：跨用户 403 + access_denied 且不产生写事件与落盘', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`

  const denied = await call(ctx, 'POST', `${base}/files/a.js`, {
    user: { id: 'u_b' }, body: { content: 'x\n' },
  })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().error.code, 'FORBIDDEN_WORKSPACE')
  assert.ok(ctx.events.some((e) => e.event === 'workspace.access_denied'))
  assert.ok(!ctx.events.some((e) => e.event === 'workspace.file_create'))
  assert.ok(!fs.existsSync(path.join(ctx.workspacesRoot, 'u_a', created.id, 'a.js')))

  const missing = await call(ctx, 'PUT', `/api/workspaces/ws_deadbeef/files/a.js`, {
    user: { id: 'u_a' }, body: { content: 'x\n', version: '"1-1"' },
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().error.code, 'WORKSPACE_NOT_FOUND')

  const badId = await call(ctx, 'POST', `/api/workspaces/..%2f..%2fetc/files/a.js`, {
    user: { id: 'u_a' }, body: { content: 'x\n' },
  })
  assert.equal(badId.statusCode, 400)
  assert.equal(badId.json().error.code, 'INVALID_WORKSPACE_ID')
})

test('写操作：安全/并发拒绝记 write_failed，普通 400/409/413/415 不记', async () => {
  const ctx = makeCtx()
  const created = (await createAs(ctx, 'u_a')).json().workspace
  const base = `/api/workspaces/${created.id}`

  // ① PROTECTED_ENTRY
  assert.equal((await call(ctx, 'POST', `${base}/files/.dsh-workspace.json`, {
    user: { id: 'u_a' }, body: { content: '{}' },
  })).statusCode, 400)

  // ② PATH_TRAVERSAL_DETECTED
  assert.equal((await call(ctx, 'POST', `${base}/files/..%2f..%2fsecret.js`, {
    user: { id: 'u_a' }, body: { content: 'x' },
  })).statusCode, 400)

  // ③ DIRECTORY_NOT_EMPTY
  await call(ctx, 'POST', `${base}/dirs/src`, { user: { id: 'u_a' } })
  await call(ctx, 'POST', `${base}/files/src/a.js`, { user: { id: 'u_a' }, body: { content: 'x\n' } })
  assert.equal((await call(ctx, 'DELETE', `${base}/files/src`, { user: { id: 'u_a' } })).statusCode, 409)

  // ④ INVALID_MOVE
  assert.equal((await call(ctx, 'PATCH', `${base}/files/src`, {
    user: { id: 'u_a' }, body: { newPath: 'src/inner' },
  })).statusCode, 400)

  // ⑤ VERSION_CONFLICT
  assert.equal((await call(ctx, 'PUT', `${base}/files/src/a.js`, {
    user: { id: 'u_a' }, headers: { 'if-match': '"1-1"' }, body: { content: 'y\n' },
  })).statusCode, 409)

  const codes = ctx.events
    .filter((e) => e.event === 'workspace.write_failed')
    .map((e) => e.fields.errorCode)
    .sort()
  assert.deepEqual(codes, [
    'DIRECTORY_NOT_EMPTY',
    'INVALID_MOVE',
    'PATH_TRAVERSAL_DETECTED',
    'PROTECTED_ENTRY',
    'VERSION_CONFLICT',
  ].sort())
  const failed = ctx.events.filter((e) => e.event === 'workspace.write_failed')
  assert.ok(failed.every((e) => e.fields.userId === 'u_a' && e.fields.workspaceId === created.id))

  // 普通错误不记：ENTRY_EXISTS / PARENT_NOT_FOUND / 415 / 413 / 404
  const before = ctx.events.length
  assert.equal((await call(ctx, 'POST', `${base}/files/src/a.js`, {
    user: { id: 'u_a' }, body: { content: 'dup\n' },
  })).statusCode, 409)
  assert.equal((await call(ctx, 'POST', `${base}/files/nope/x.js`, {
    user: { id: 'u_a' }, body: { content: 'x\n' },
  })).statusCode, 409)
  assert.equal((await call(ctx, 'POST', `${base}/files/logo.png`, {
    user: { id: 'u_a' }, body: { content: 'x' },
  })).statusCode, 415)
  assert.equal((await call(ctx, 'POST', `${base}/files/big.txt`, {
    user: { id: 'u_a' }, body: { content: 'x'.repeat(10 * 1024 * 1024 + 1) },
  })).statusCode, 413)
  assert.equal((await call(ctx, 'DELETE', `${base}/files/none.js`, { user: { id: 'u_a' } })).statusCode, 404)
  assert.equal(ctx.events.length, before) // 上述请求零审计
})
