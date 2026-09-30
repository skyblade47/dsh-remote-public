import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createStore } from '../src/store.js'
import { createAuthService } from '../src/auth-service.js'
import { createPluginRoutes, sanitizeRepoName } from '../src/plugin-routes.js'

function makePluginRoot() {
  // 创建临时插件根目录，含 1 个合法插件 + 1 个无 package.json 插件 + 1 个隐藏目录
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-root-'))
  const goodDir = path.join(root, 'plugin-good')
  fs.mkdirSync(goodDir, { recursive: true })
  fs.writeFileSync(path.join(goodDir, 'package.json'), JSON.stringify({ name: 'plugin-good', version: '1.0.0', description: 'A good plugin' }))
  fs.mkdirSync(path.join(goodDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(goodDir, 'lib', 'index.js'), 'module.exports = {}')
  fs.writeFileSync(path.join(goodDir, 'cordis.patch.yml'), 'plugins: []')
  const badDir = path.join(root, 'plugin-bad')
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'README.md'), 'no package.json here')
  const hiddenDir = path.join(root, '.ignored_hidden')
  fs.mkdirSync(hiddenDir, { recursive: true })
  fs.writeFileSync(path.join(hiddenDir, 'package.json'), '{}')
  return root
}

function makeCtx() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-pr-'))
  const store = createStore(dataDir)
  const audit = { log() {} }
  const authService = createAuthService({ store, audit })
  const pluginRoot = makePluginRoot()
  const env = { DSH_GATEWAY_PLUGIN_DIR: pluginRoot }
  const pluginRoutes = createPluginRoutes({ authService, audit, env })
  const user = authService.registerUser({ name: 'admin', password: 'password123' })
  return { dataDir, store, authService, pluginRoutes, pluginRoot, env, user }
}

function mockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v },
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers) },
    end(body) { this.body = body },
  }
  return r
}

function mockReq({ method = 'GET', url = '/', user = null, body = null } = {}) {
  const r = new EventEmitter()
  r.method = method
  r.url = url
  r.socket = { remoteAddress: '127.0.0.1' }
  r.user = user
  r.headers = {}
  r.params = {}
  r.resume = () => {}
  process.nextTick(() => {
    if (body) r.emit('data', JSON.stringify(body))
    r.emit('end')
  })
  return r
}

function callRoute(pluginRoutes, req) {
  const matched = pluginRoutes.match(req)
  assert.ok(matched, `路由未匹配: ${req.method} ${req.url}`)
  req.params = matched.params
  const res = mockRes()
  return Promise.resolve(matched.handler(req, res)).then(() => res)
}

// ---- sanitizeRepoName ----

test('sanitizeRepoName: 合法名称保留', () => {
  assert.equal(sanitizeRepoName('my-plugin'), 'my-plugin')
  assert.equal(sanitizeRepoName('dsh_plugin.x'), 'dsh_plugin.x')
})

test('sanitizeRepoName: 大写转小写', () => {
  assert.equal(sanitizeRepoName('MyPlugin'), 'myplugin')
})

test('sanitizeRepoName: 非法字符替换为 -', () => {
  assert.equal(sanitizeRepoName('my plugin!'), 'my-plugin')
})

test('sanitizeRepoName: 首尾特殊字符裁剪', () => {
  assert.equal(sanitizeRepoName('.hidden.'), 'hidden')
  assert.equal(sanitizeRepoName('-dash-'), 'dash')
})

test('sanitizeRepoName: 空输入返回空串', () => {
  assert.equal(sanitizeRepoName(''), '')
  assert.equal(sanitizeRepoName(null), '')
})

// ---- isPluginRoute ----

test('isPluginRoute 判断', () => {
  const { pluginRoutes } = makeCtx()
  assert.equal(pluginRoutes.isPluginRoute('/api/plugins'), true)
  assert.equal(pluginRoutes.isPluginRoute('/api/plugins/foo'), true)
  assert.equal(pluginRoutes.isPluginRoute('/api/plugins/foo/publish'), true)
  assert.equal(pluginRoutes.isPluginRoute('/api/auth/me'), false)
  assert.equal(pluginRoutes.isPluginRoute('/some/other'), false)
})

// ---- GET /api/plugins ----

test('GET /api/plugins 列出所有插件', async () => {
  const { pluginRoutes, user } = makeCtx()
  const res = await callRoute(pluginRoutes, mockReq({ url: '/api/plugins', user }))
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.exists, true)
  const names = parsed.plugins.map((p) => p.name)
  assert.ok(names.includes('plugin-good'))
  assert.ok(names.includes('plugin-bad'))
  assert.ok(!names.includes('.ignored_hidden'), '隐藏目录应被跳过')
  const good = parsed.plugins.find((p) => p.name === 'plugin-good')
  assert.equal(good.version, '1.0.0')
  assert.equal(good.hasPatch, true)
  assert.equal(good.isPublished, false)
})

test('GET /api/plugins 当目录不存在时返回 exists:false', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pr-nodir-'))
  const store = createStore(dataDir)
  const authService = createAuthService({ store, audit: { log() {} } })
  const pluginRoutes = createPluginRoutes({ authService, audit: { log() {} }, env: { DSH_GATEWAY_PLUGIN_DIR: path.join(os.tmpdir(), 'definitely-not-exist-' + process.pid) } })
  const user = authService.registerUser({ name: 'admin', password: 'password123' })
  const res = await callRoute(pluginRoutes, mockReq({ url: '/api/plugins', user }))
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.exists, false)
  assert.equal(parsed.plugins.length, 0)
})

// ---- GET /api/plugins/:name ----

test('GET /api/plugins/:name 返回详情', async () => {
  const { pluginRoutes, user } = makeCtx()
  const res = await callRoute(pluginRoutes, mockReq({ url: '/api/plugins/plugin-good', user }))
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.plugin.name, 'plugin-good')
  assert.equal(parsed.plugin.version, '1.0.0')
  assert.equal(parsed.plugin.hasPatch, true)
  assert.equal(parsed.plugin.isPublished, false)
  assert.ok(Array.isArray(parsed.plugin.files))
  const fileNames = parsed.plugin.files.map((f) => f.name)
  assert.ok(fileNames.includes('package.json'))
  assert.ok(fileNames.includes('lib'))
})

test('GET /api/plugins/:name 不存在返回 404', async () => {
  const { pluginRoutes, user } = makeCtx()
  const res = await callRoute(pluginRoutes, mockReq({ url: '/api/plugins/no-such', user }))
  assert.equal(res.statusCode, 404)
})

test('GET /api/plugins/:name 缺 package.json 返回 404', async () => {
  const { pluginRoutes, user } = makeCtx()
  const res = await callRoute(pluginRoutes, mockReq({ url: '/api/plugins/plugin-bad', user }))
  assert.equal(res.statusCode, 404)
})

// ---- POST /api/plugins/:name/publish ----

test('POST publish 未绑定 GitHub 返回 400', async () => {
  const { pluginRoutes, user } = makeCtx()
  const res = await callRoute(pluginRoutes, mockReq({ method: 'POST', url: '/api/plugins/plugin-good/publish', user, body: {} }))
  assert.equal(res.statusCode, 400)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.error.code, 'GITHUB_NOT_BOUND')
})

test('POST publish 插件不存在返回 404', async () => {
  const { pluginRoutes, authService, user } = makeCtx()
  authService.saveGithubBinding(user.id, { token: 'ghp_fake', githubUser: { login: 'octo' } })
  const res = await callRoute(pluginRoutes, mockReq({ method: 'POST', url: '/api/plugins/no-such/publish', user, body: {} }))
  assert.equal(res.statusCode, 404)
})

test('POST publish 缺 package.json 返回 400', async () => {
  const { pluginRoutes, authService, user } = makeCtx()
  authService.saveGithubBinding(user.id, { token: 'ghp_fake', githubUser: { login: 'octo' } })
  const res = await callRoute(pluginRoutes, mockReq({ method: 'POST', url: '/api/plugins/plugin-bad/publish', user, body: {} }))
  assert.equal(res.statusCode, 400)
})

test('POST publish 仓库名无效返回 400', async () => {
  // 传入全是非法字符的 repoName，sanitize 后变空
  const { pluginRoutes, authService, user } = makeCtx()
  authService.saveGithubBinding(user.id, { token: 'ghp_fake', githubUser: { login: 'octo' } })
  const res = await callRoute(pluginRoutes, mockReq({ method: 'POST', url: '/api/plugins/plugin-good/publish', user, body: { repoName: '   ' } }))
  assert.equal(res.statusCode, 400)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.error.code, 'BAD_REQUEST')
})

// ---- 插件名路径穿越防护（%2F 解码后不得越出插件根目录）----

function makeOutsideDir() {
  // 与插件根目录同级的“外部目录”，含 package.json，用于验证穿越被拦截
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-plugin-'))
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'outside', version: '9.9.9' }))
  return outside
}

test('GET /api/plugins/:name 拒绝 %2F 路径穿越', async () => {
  const { pluginRoutes, pluginRoot, user } = makeCtx()
  const outside = makeOutsideDir()
  const name = path.basename(outside)
  const req = mockReq({ url: `/api/plugins/..%2F${encodeURIComponent(name)}`, user })
  const res = await callRoute(pluginRoutes, req)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error.code, 'BAD_REQUEST')
  // 也不应把外部目录的路径泄漏出去
  assert.ok(!res.body.includes(outside), '响应不应泄漏插件根之外的绝对路径')
  assert.ok(fs.existsSync(path.join(pluginRoot, 'plugin-good')))
})

test('POST /api/plugins/:name/publish 拒绝 %2F 路径穿越', async () => {
  const { pluginRoutes, authService, user } = makeCtx()
  authService.saveGithubBinding(user.id, { token: 'ghp_fake', githubUser: { login: 'octo' } })
  const outside = makeOutsideDir()
  const name = path.basename(outside)
  const res = await callRoute(
    pluginRoutes,
    mockReq({ method: 'POST', url: `/api/plugins/..%2F${encodeURIComponent(name)}/publish`, user, body: {} }),
  )
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error.code, 'BAD_REQUEST')
  // 未在外部目录初始化 git 仓库
  assert.ok(!fs.existsSync(path.join(outside, '.git')), '不应在插件根之外的目录执行 git 初始化')
})

test('插件名含非法字符（. 开头 / 空格）返回 400', async () => {
  const { pluginRoutes, user } = makeCtx()
  for (const bad of ['%2Ehidden', 'has%20space']) {
    const res = await callRoute(pluginRoutes, mockReq({ url: `/api/plugins/${bad}`, user }))
    assert.equal(res.statusCode, 400, `${bad} 应被拒绝`)
  }
})

test('路径参数含非法百分号编码时不抛异常且视为无匹配', () => {
  const { pluginRoutes } = makeCtx()
  const matched = pluginRoutes.match(mockReq({ url: '/api/plugins/%ZZ', user: null }))
  assert.equal(matched, null)
})

test('请求体超过 1MB 时返回 413', async () => {
  const { pluginRoutes, authService, user } = makeCtx()
  authService.saveGithubBinding(user.id, { token: 'ghp_fake', githubUser: { login: 'octo' } })
  const req = mockReq({ method: 'POST', url: '/api/plugins/plugin-good/publish', user })
  const matched = pluginRoutes.match(req)
  req.params = matched.params
  const res = mockRes()
  const pending = Promise.resolve(matched.handler(req, res))
  req.emit('data', Buffer.alloc(1024 * 1024 + 1, 0x20))
  await pending
  assert.equal(res.statusCode, 413)
})
