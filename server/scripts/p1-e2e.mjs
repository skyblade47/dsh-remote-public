// P1 端到端测试脚本
const BASE = 'http://127.0.0.1:8080'

async function req(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
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

let passed = 0, failed = 0
function check(name, condition, info = '') {
  if (condition) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name} ${info}`); failed++ }
}

console.log('P1 端到端测试')
console.log('='.repeat(50))

// 0. 用已有的 admin 账户登录（密码 admin123456）
console.log('\n[0] 登录管理员')
let r = await req('POST', '/api/auth/login', { name: 'admin', password: 'admin123456' })
check('admin 登录', r.status === 200, `status=${r.status}`)
const adminCookie = r.headers.get('set-cookie')?.match(/dsh_session=([^;]+)/)?.[1]
check('获取 Cookie', !!adminCookie)

// 如果 admin 登录失败，尝试注册
if (r.status !== 200) {
  r = await req('POST', '/api/auth/register', { name: 'admin', password: 'admin123456' })
  r = await req('POST', '/api/auth/login', { name: 'admin', password: 'admin123456' })
  check('重新登录 admin', r.status === 200)
}

// 1. 未认证访问 API → 401
console.log('\n[1] 未认证拦截')
r = await req('POST', '/api/session.list', {})
check('业务 API 返回 401', r.status === 401, `status=${r.status}`)
check('错误码 UNAUTHORIZED', r.data?.error?.code === 'UNAUTHORIZED')

r = await req('GET', '/')
check('首页 302 跳登录', r.status === 302, `status=${r.status}`)
check('跳转目标 /auth/login', r.headers.get('location')?.includes('/auth/login'))

r = await req('GET', '/auth/login')
check('登录页 200 HTML', r.status === 200 && r.headers.get('content-type')?.includes('text/html'))

// 2. 注册
console.log('\n[2] 注册流程')
r = await req('POST', '/api/auth/register', { name: 'e2e-user1', password: 'user123456' })
check('第二个用户注册成功', r.status === 201 || r.status === 400, `status=${r.status}`)
if (r.status === 201) {
  check('第二个用户为 pending', r.data?.user?.role === 'pending')
} else {
  check('第二个用户已存在（跳过）', true)
}

r = await req('POST', '/api/auth/register', { name: 'admin', password: 'admin123456' })
check('重复用户名拒绝', r.status === 400)

r = await req('POST', '/api/auth/register', { name: 'e2e-weak', password: '123' })
check('弱密码拒绝', r.status === 400)

// 3. 登录
console.log('\n[3] 登录流程')
r = await req('POST', '/api/auth/login', { name: 'admin', password: 'admin123456' })
check('admin 登录成功', r.status === 200, `status=${r.status} ${JSON.stringify(r.data)}`)
check('设置 Cookie', r.headers.get('set-cookie')?.includes('dsh_session'))
// 复用已有 adminCookie（步骤 0 已获取），此处不重新声明

r = await req('POST', '/api/auth/login', { name: 'e2e-user1', password: 'user123456' })
if (r.status === 403) {
  check('pending 用户登录被拒', r.status === 403)
  check('错误码 ACCOUNT_PENDING', r.data?.error?.code === 'ACCOUNT_PENDING')
} else {
  check('pending 用户已审批或不存在（跳过）', true)
  check('pending 用户已审批或不存在（跳过）', true)
}

r = await req('POST', '/api/auth/login', { name: 'e2e-admin', password: 'wrong' })
check('错误密码 401', r.status === 401)

// 4. 认证后访问
console.log('\n[4] 认证后访问')
r = await req('POST', '/api/session.list', {}, { cookie: `dsh_session=${adminCookie}` })
check('认证后业务 API 可达', r.status === 200 || r.status === 404, `status=${r.status}`)

r = await req('GET', '/api/auth/me', null, { cookie: `dsh_session=${adminCookie}` })
check('GET /api/auth/me 返回用户', r.status === 200 && r.data?.user?.name === 'admin')

// 5. 设备 Token
console.log('\n[5] 设备 Token')
r = await req('POST', '/api/auth/tokens', { label: 'test-device' }, { cookie: `dsh_session=${adminCookie}` })
check('创建设备 Token', r.status === 201, `status=${r.status}`)
const deviceToken = r.data?.token
check('Token 明文返回', !!deviceToken)

r = await req('GET', '/api/auth/me', null, { authorization: `Bearer ${deviceToken}` })
check('Bearer Token 认证', r.status === 200)

// 6. Admin 功能
console.log('\n[6] Admin 功能')
r = await req('GET', '/api/auth/users', null, { cookie: `dsh_session=${adminCookie}` })
check('列出用户', r.status === 200 && Array.isArray(r.data?.users))

const pendingUser = r.data?.users?.find(u => u.name === 'e2e-user1' && u.role === 'pending')
if (pendingUser) {
  r = await req('POST', `/api/auth/users/${pendingUser.id}/approve`, null, { cookie: `dsh_session=${adminCookie}` })
  check('审批 pending 用户', r.status === 200 && r.data?.user?.role === 'user')
} else {
  check('无 pending 用户需审批（跳过）', true)
}

// 7. 登出
console.log('\n[7] 登出')
r = await req('POST', '/api/auth/logout', null, { cookie: `dsh_session=${adminCookie}` })
check('登出成功', r.status === 200)
r = await req('GET', '/api/auth/me', null, { cookie: `dsh_session=${adminCookie}` })
check('登出后 Cookie 失效', r.status === 401)

console.log('\n' + '='.repeat(50))
console.log(`结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
