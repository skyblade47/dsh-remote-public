import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createStore } from '../src/store.js'
import { createAuthService } from '../src/auth-service.js'
import { createPluginRoutes } from '../src/plugin-routes.js'
import { createWorkspaceStore, resolveWorkspacesRoot } from '../src/workspace-store.js'

function makeCtx() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deploy-'))
  const pluginRoot = path.join(home, 'profiles', 'web', 'node_modules', '@local')
  fs.mkdirSync(pluginRoot, { recursive: true })
  const env = {
    DSH_GATEWAY_DATA_DIR: home,
    DSH_GATEWAY_PLUGIN_DIR: pluginRoot,
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-dep-'))
  const store = createStore(dataDir)
  const auditEvents = []
  const audit = { log(event, fields) { auditEvents.push({ event, fields }) } }
  const authService = createAuthService({ store, audit })
  const pluginRoutes = createPluginRoutes({ authService, audit, env })

  const user = authService.registerUser({ name: 'dev', password: 'password123' })

  const wsStore = createWorkspaceStore(resolveWorkspacesRoot(env))
  const ws = wsStore.createWorkspace({ userId: user.id, name: '插件工作区' })

  return { home, pluginRoot, env, pluginRoutes, authService, audit, auditEvents, user, wsStore, ws }
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers) },
    end(body) { this.body = body },
  }
}

function mockReq({ method = 'GET', url = '/', user = null, body = null } = {}) {
  const r = new EventEmitter()
  r.method = method
  r.url = url
  r.socket = { remoteAddress: '127.0.0.1' }
  r.user = user
  r.headers = {}
  r.params = {}
  process.nextTick(() => {
    if (body) r.emit('data', JSON.stringify(body))
    r.emit('end')
  })
  return r
}

async function callRoute(pluginRoutes, req) {
  const matched = pluginRoutes.match(req)
  assert.ok(matched, `路由未匹配: ${req.method} ${req.url}`)
  req.params = matched.params
  const res = mockRes()
  await Promise.resolve(matched.handler(req, res))
  return res
}

function seedPluginSource(wsStore, userId, wsId, relPath, pkgVersion = '1.0.0') {
  const base = wsStore.workspaceDir(userId, wsId)
  const dir = relPath ? path.join(base, ...relPath.split('/')) : base
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `@local/${path.basename(dir)}`,
    version: pkgVersion,
    description: 'workspace built plugin',
  }))
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'module.exports = {}')
  return dir
}

test('deploy: 从工作区子路径部署插件到 @local', async () => {
  const ctx = makeCtx()
  seedPluginSource(ctx.wsStore, ctx.user.id, ctx.ws.id, 'build/my-tool')

  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'build/my-tool' },
    })
  )
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.name, 'my-tool')
  assert.equal(parsed.requiresRestart, true)
  assert.ok(typeof parsed.deployedAt === 'string')

  const deployedPkg = JSON.parse(
    fs.readFileSync(path.join(ctx.pluginRoot, 'my-tool', 'package.json'), 'utf8')
  )
  assert.equal(deployedPkg.version, '1.0.0')
  assert.ok(fs.existsSync(path.join(ctx.pluginRoot, 'my-tool', 'lib', 'index.js')))
})

test('deploy: path 缺省为工作区根', async () => {
  const ctx = makeCtx()
  seedPluginSource(ctx.wsStore, ctx.user.id, ctx.ws.id, '')

  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/root-plugin/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id },
    })
  )
  assert.equal(res.statusCode, 200)
  assert.ok(fs.existsSync(path.join(ctx.pluginRoot, 'root-plugin', 'package.json')))
})

test('deploy: 重复部署覆盖旧内容（非 junction 时）', async () => {
  const ctx = makeCtx()
  seedPluginSource(ctx.wsStore, ctx.user.id, ctx.ws.id, 'p')
  const target = path.join(ctx.pluginRoot, 'my-tool')
  fs.mkdirSync(path.join(target, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@local/my-tool', version: '0.0.1' }))
  fs.writeFileSync(path.join(target, 'old.txt'), 'stale')

  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'p' },
    })
  )
  assert.equal(res.statusCode, 200)
  const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.0.0')
  assert.ok(!fs.existsSync(path.join(target, 'old.txt')), '旧文件应被清除')
})

test('deploy: 缺 workspaceId 返回 400', async () => {
  const ctx = makeCtx()
  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { path: 'p' },
    })
  )
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error.code, 'BAD_REQUEST')
})

test('deploy: 非法 workspaceId 返回 400', async () => {
  const ctx = makeCtx()
  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: 'ws_../evil', path: 'p' },
    })
  )
  assert.equal(res.statusCode, 400)
})

test('deploy: 工作区不存在返回 404', async () => {
  const ctx = makeCtx()
  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: 'ws_deadbeef', path: 'p' },
    })
  )
  assert.equal(res.statusCode, 404)
  assert.equal(JSON.parse(res.body).error.code, 'WORKSPACE_NOT_FOUND')
})

test('deploy: 工作区属于他人返回 403', async () => {
  const ctx = makeCtx()
  const other = ctx.authService.registerUser({ name: 'intruder', password: 'password123' })
  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: other,
      body: { workspaceId: ctx.ws.id, path: 'p' },
    })
  )
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).error.code, 'FORBIDDEN_WORKSPACE')
})

test('deploy: path 路径遍历返回 400', async () => {
  const ctx = makeCtx()
  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: '../../escape' },
    })
  )
  assert.equal(res.statusCode, 400)
})

test('deploy: 源路径不存在返回 404', async () => {
  const ctx = makeCtx()
  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'nope/missing' },
    })
  )
  assert.equal(res.statusCode, 404)
  assert.equal(JSON.parse(res.body).error.code, 'PATH_NOT_FOUND')
})

test('deploy: 源缺少 package.json 返回 400', async () => {
  const ctx = makeCtx()
  const base = ctx.wsStore.workspaceDir(ctx.user.id, ctx.ws.id)
  fs.mkdirSync(path.join(base, 'plain'), { recursive: true })
  fs.writeFileSync(path.join(base, 'plain', 'readme.txt'), 'no package json')

  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'plain' },
    })
  )
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error.code, 'BAD_REQUEST')
})

test('deploy: 目标为 junction/symlink 时拒绝，防止写穿插件仓库', async () => {
  const ctx = makeCtx()
  seedPluginSource(ctx.wsStore, ctx.user.id, ctx.ws.id, 'p')
  const linkTarget = path.join(ctx.home, 'elsewhere')
  fs.mkdirSync(linkTarget, { recursive: true })
  try {
    fs.symlinkSync(linkTarget, path.join(ctx.pluginRoot, 'my-tool'), 'junction')
  } catch {
    fs.symlinkSync(linkTarget, path.join(ctx.pluginRoot, 'my-tool'), 'dir')
  }

  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'p' },
    })
  )
  assert.equal(res.statusCode, 409)
  assert.equal(JSON.parse(res.body).error.code, 'TARGET_IS_LINK')
})

test('deploy: 源目录内含符号链接返回 400，防止拷贝越界', async () => {
  const ctx = makeCtx()
  const base = ctx.wsStore.workspaceDir(ctx.user.id, ctx.ws.id)
  const dir = path.join(base, 'p')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@local/my-tool', version: '1.0.0' }))
  fs.symlinkSync(ctx.home, path.join(dir, 'lib', 'escape'), 'junction')

  const res = await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'p' },
    })
  )
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error.code, 'SYMLINK_NOT_FOLLOWED')
})

test('deploy: 审计 workspace.plugin_deploy', async () => {
  const ctx = makeCtx()
  seedPluginSource(ctx.wsStore, ctx.user.id, ctx.ws.id, 'p')
  await callRoute(
    ctx.pluginRoutes,
    mockReq({
      method: 'POST',
      url: '/api/plugins/my-tool/deploy',
      user: ctx.user,
      body: { workspaceId: ctx.ws.id, path: 'p' },
    })
  )
  const ev = ctx.auditEvents.find((e) => e.event === 'workspace.plugin_deploy')
  assert.ok(ev, '应记录 workspace.plugin_deploy')
  assert.equal(ev.fields.userId, ctx.user.id)
  assert.equal(ev.fields.plugin, 'my-tool')
  assert.equal(ev.fields.workspaceId, ctx.ws.id)
  assert.equal(ev.fields.path, 'p')
})
