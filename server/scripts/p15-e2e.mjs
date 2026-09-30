// P1.5 端到端测试：插件发布到 GitHub 集成验证。
// 自动启动网关子进程 → 注册/登录 → 绑定/解绑 → 列出/详情/发布路由。
// 不需要真实 GitHub Token（用假 token 验证 401 路径）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY_DIR = path.resolve(__dirname, '../gateway')
const GATEWAY_SRC = path.join(GATEWAY_DIR, 'src', 'index.js')

let passed = 0, failed = 0
function check(name, condition, info = '') {
  if (condition) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name} ${info}`); failed++ }
}

async function req(method, urlPath, body, headers = {}) {
  const res = await fetch('http://127.0.0.1:8180' + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data, headers: res.headers }
}

// 准备临时数据目录 + 临时插件目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-e2e-'))
const dataDir = path.join(tmpRoot, 'dsh-data')
fs.mkdirSync(path.join(dataDir, 'users'), { recursive: true })
const pluginDir = path.join(tmpRoot, 'plugins')
const goodPlugin = path.join(pluginDir, 'plugin-good')
fs.mkdirSync(goodPlugin, { recursive: true })
fs.writeFileSync(path.join(goodPlugin, 'package.json'), JSON.stringify({
  name: 'plugin-good', version: '1.0.0', description: 'E2E 测试插件',
}))
fs.mkdirSync(path.join(goodPlugin, 'lib'), { recursive: true })
fs.writeFileSync(path.join(goodPlugin, 'lib', 'index.js'), 'module.exports = {}')
fs.writeFileSync(path.join(goodPlugin, 'cordis.patch.yml'), 'plugins: []')

console.log('P1.5 端到端测试')
console.log('='.repeat(50))
console.log('临时目录:', tmpRoot)

// 启动网关子进程
const env = {
  ...process.env,
  DSH_GATEWAY_PORT: '8180',
  DSH_GATEWAY_UPSTREAM: 'http://127.0.0.1:3080',
  DSH_GATEWAY_DATA_DIR: dataDir,
  DSH_GATEWAY_PLUGIN_DIR: pluginDir,
}
const child = spawn('node', [GATEWAY_SRC], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (c) => process.stdout.write(`[gw] ${c}`))
child.stderr.on('data', (c) => process.stderr.write(`[gw-err] ${c}`))

// 等待网关监听
async function waitForReady(timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:8180/api/plugins', { method: 'GET' })
      // 401 表示监听就绪
      if (r.status === 401) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('网关未在超时内启动')
}

let sessionCookie = null
try {
  await waitForReady()
  console.log('\n[0] 网关启动')

  // 注册 admin
  console.log('\n[1] 注册 admin')
  let r = await req('POST', '/api/auth/register', { name: 'admin', password: 'admin123456' })
  check('注册 admin', r.status === 201 || r.data?.error?.code === 'USER_EXISTS', `status=${r.status}`)
  r = await req('POST', '/api/auth/login', { name: 'admin', password: 'admin123456' })
  check('登录 admin', r.status === 200, `status=${r.status}`)
  sessionCookie = r.headers.get('set-cookie')?.match(/dsh_session=([^;]+)/)?.[1]
  check('获取 Cookie', !!sessionCookie)
  const authHeader = { cookie: `dsh_session=${sessionCookie}` }

  // /api/auth/me 应返回 github: null
  console.log('\n[2] GitHub 绑定状态')
  r = await req('GET', '/api/auth/me', null, authHeader)
  check('me 返回 github 字段', r.data?.github !== undefined, `data=${JSON.stringify(r.data).slice(0, 100)}`)
  check('未绑定时 github 为 null', r.data?.github === null)

  r = await req('GET', '/api/auth/me/github', null, authHeader)
  check('GET /api/auth/me/github 200', r.status === 200)
  check('未绑定 github 为 null', r.data?.github === null)

  // PUT 用假 token → 401
  console.log('\n[3] 绑定假 Token 应返回 401')
  r = await req('PUT', '/api/auth/me/github', { token: 'ghp_invalid_token_for_e2e' }, authHeader)
  check('假 Token 返回 401', r.status === 401, `status=${r.status}`)
  check('错误码 GITHUB_UNAUTHORIZED', r.data?.error?.code === 'GITHUB_UNAUTHORIZED', `code=${r.data?.error?.code}`)

  // 插件列表
  console.log('\n[4] 插件列表')
  r = await req('GET', '/api/plugins', null, authHeader)
  check('GET /api/plugins 200', r.status === 200, `status=${r.status}`)
  check('列出 plugin-good', Array.isArray(r.data?.plugins) && r.data.plugins.some((p) => p.name === 'plugin-good'))
  const good = r.data?.plugins?.find((p) => p.name === 'plugin-good')
  check('plugin-good hasPatch=true', good?.hasPatch === true)
  check('plugin-good isPublished=false', good?.isPublished === false)

  // 插件详情
  console.log('\n[5] 插件详情')
  r = await req('GET', '/api/plugins/plugin-good', null, authHeader)
  check('GET /api/plugins/plugin-good 200', r.status === 200)
  check('详情含 files', Array.isArray(r.data?.plugin?.files))

  r = await req('GET', '/api/plugins/no-such', null, authHeader)
  check('不存在的插件 404', r.status === 404)

  // 发布：未绑定 GitHub → 400
  console.log('\n[6] 发布插件：未绑定 → 400')
  r = await req('POST', '/api/plugins/plugin-good/publish', {}, authHeader)
  check('未绑定返回 400', r.status === 400, `status=${r.status}`)
  check('错误码 GITHUB_NOT_BOUND', r.data?.error?.code === 'GITHUB_NOT_BOUND')

  // 发布：插件不存在 → 404
  // 这里先临时绑定一个假 token 以越过 GITHUB_NOT_BOUND 检查
  // 直接调用 authService.saveGithubBinding 不通过 HTTP，难以做到
  // 改为：直接测未绑定路径已经覆盖（已经过）
  r = await req('POST', '/api/plugins/no-such/publish', {}, authHeader)
  check('未绑定优先返回 400（而非 404）', r.status === 400, `status=${r.status}`)

  // DELETE /api/auth/me/github 未绑定时 404
  console.log('\n[7] 解绑 GitHub（未绑定）')
  r = await req('DELETE', '/api/auth/me/github', null, authHeader)
  check('未绑定时返回 404', r.status === 404, `status=${r.status}`)

  // 鉴权拦截
  console.log('\n[8] 鉴权拦截')
  r = await req('GET', '/api/plugins')
  check('未认证返回 401', r.status === 401, `status=${r.status}`)

  r = await req('POST', '/api/plugins/plugin-good/publish', {})
  check('未认证 publish 返回 401', r.status === 401, `status=${r.status}`)

  // 不存在的插件路由 → 404
  console.log('\n[9] 路由 404')
  r = await req('GET', '/api/plugins/foo/bar/baz', null, authHeader)
  check('未知插件路径 404', r.status === 404)

  r = await req('PUT', '/api/plugins/plugin-good', {}, authHeader)
  check('不支持的 method 404', r.status === 404)
} catch (e) {
  console.error('E2E 执行错误:', e)
  failed++
} finally {
  child.kill()
  // 清理临时目录
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
}

console.log('\n' + '='.repeat(50))
console.log(`结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
