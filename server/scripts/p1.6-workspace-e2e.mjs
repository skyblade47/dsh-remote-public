// P1.6 端到端测试：服务器端工作区（预览 + 下载）。
// 自动启动网关子进程 → 注册 A/B 两个用户 → 覆盖设计文档 §8.2 的 9 个 E2E 场景。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = path.resolve(__dirname, '../gateway/src/index.js')
const PORT = 8181
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0, failed = 0
function check(name, condition, info = '') {
  if (condition) { console.log(`  ✅ ${name}`); passed++ }
  else { console.log(`  ❌ ${name} ${info}`); failed++ }
}

async function req(method, urlPath, body, headers = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const buf = Buffer.from(await res.arrayBuffer())
  let data
  try { data = JSON.parse(buf.toString('utf8')) } catch { data = buf }
  return { status: res.status, data, headers: res.headers, buf }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-e2e-'))
const dataDir = path.join(tmpRoot, 'dsh-data')
const pluginDir = path.join(tmpRoot, 'plugins')
fs.mkdirSync(pluginDir, { recursive: true })

console.log('P1.6 工作区端到端测试')
console.log('='.repeat(50))
console.log('临时目录:', tmpRoot)

const child = spawn('node', [GATEWAY_SRC], {
  env: {
    ...process.env,
    DSH_GATEWAY_PORT: String(PORT),
    DSH_GATEWAY_UPSTREAM: 'http://127.0.0.1:3080',
    DSH_GATEWAY_DATA_DIR: dataDir,
    DSH_GATEWAY_PLUGIN_DIR: pluginDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (c) => process.stdout.write(`[gw] ${c}`))
child.stderr.on('data', (c) => process.stderr.write(`[gw-err] ${c}`))

async function waitForReady(timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/workspaces`)
      if (r.status === 401) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('网关未在超时内启动')
}

// 首个注册账号自动成为 admin；登录响应含 user.id（UUID，即工作区分桶目录名）
async function registerLogin(name, password) {
  await req('POST', '/api/auth/register', { name, password })
  const r = await req('POST', '/api/auth/login', { name, password })
  if (r.status !== 200) throw new Error(`${name} 登录失败: ${r.status}`)
  const cookie = r.headers.get('set-cookie')?.match(/dsh_session=([^;]+)/)?.[1]
  if (!cookie) throw new Error(`${name} 未取得 cookie`)
  return { cookie: `dsh_session=${cookie}`, userId: r.data?.user?.id }
}

// 后续注册账号为 pending 无法登录，由 admin 直接创建 role=user 账号再登录
async function adminCreateLogin(admin, name, password) {
  const cr = await req('POST', '/api/auth/users', { name, password, role: 'user' }, admin)
  if (cr.status !== 201) throw new Error(`${name} 创建失败: ${cr.status} ${JSON.stringify(cr.data)}`)
  const r = await req('POST', '/api/auth/login', { name, password })
  if (r.status !== 200) throw new Error(`${name} 登录失败: ${r.status}`)
  const cookie = r.headers.get('set-cookie')?.match(/dsh_session=([^;]+)/)?.[1]
  if (!cookie) throw new Error(`${name} 未取得 cookie`)
  return { cookie: `dsh_session=${cookie}`, userId: r.data?.user?.id }
}

// 解析 ZIP 中央目录，返回 Map<zipName, Buffer(原始内容)>
function extractZip(buf) {
  const eocdOffset = buf.length - 22
  if (buf.readUInt32LE(eocdOffset) !== 0x06054b50) throw new Error('EOCD 签名错误')
  const count = buf.readUInt16LE(eocdOffset + 10)
  const centralSize = buf.readUInt32LE(eocdOffset + 12)
  let p = buf.readUInt32LE(eocdOffset + 16)
  const end = p + centralSize
  const files = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录签名错误')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    const dataStart = localOffset + 30 + nameLen + buf.readUInt16LE(localOffset + 28)
    const rawData = buf.slice(dataStart, dataStart + compSize)
    files.set(name, method === 8 ? zlib.inflateRawSync(rawData) : rawData)
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

let wsId = null
let wsDir = null
try {
  await waitForReady()
  console.log('\n[0] 网关启动')

  const alice = await registerLogin('alice_p16', 'alice123456')
  const bob = await adminCreateLogin(alice, 'bob_p16', 'bob123456')
  check('A/B 两用户登录', !!alice.cookie && !!bob.cookie && !!alice.userId)

  // 场景 1：未登录 401
  console.log('\n[1] 未登录访问')
  let r = await req('GET', '/api/workspaces')
  check('未登录列表 401', r.status === 401, `status=${r.status}`)

  // 场景 2：跨用户 403（先让 A 建工作区）
  console.log('\n[2] 创建工作区 + 跨用户隔离')
  r = await req('POST', '/api/workspaces', { name: 'e2e-demo' }, alice)
  check('A 创建工作区 201', r.status === 201, `status=${r.status}`)
  wsId = r.data?.workspace?.id
  check('返回 ws_ ID', typeof wsId === 'string' && /^ws_[a-f0-9]{8}$/.test(wsId), `id=${wsId}`)
  // 分桶目录名是账号 UUID（req.user.id），不是登录名
  wsDir = path.join(dataDir, 'workspaces', alice.userId, wsId)
  check('工作区物理目录存在', fs.existsSync(path.join(wsDir, '.dsh-workspace.json')), wsDir)

  r = await req('GET', `/api/workspaces/${wsId}`, null, bob)
  check('B 访问 A 的详情 403 FORBIDDEN_WORKSPACE',
    r.status === 403 && r.data?.error?.code === 'FORBIDDEN_WORKSPACE', `status=${r.status}`)
  r = await req('GET', `/api/workspaces/${wsId}/tree`, null, bob)
  check('B 访问 A 的 tree 403', r.status === 403)
  r = await req('GET', `/api/workspaces/${wsId}/download-zip`, null, bob)
  check('B 下载 A 的 ZIP 403', r.status === 403)

  r = await req('GET', '/api/workspaces', null, bob)
  check('B 的列表中看不到 A 的工作区',
    Array.isArray(r.data?.workspaces) && r.data.workspaces.length === 0)

  // 场景 3：写文件 + 文件树
  console.log('\n[3] 写文件 + 文件树')
  fs.mkdirSync(path.join(wsDir, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(wsDir, 'src', 'index.js'), "export const x = 1\n")
  fs.writeFileSync(path.join(wsDir, 'src', 'deep', 'notes.txt'), 'deep note')
  fs.writeFileSync(path.join(wsDir, 'readme.md'), '# demo\n')
  fs.writeFileSync(path.join(wsDir, 'logo.png'), crypto.randomBytes(256))
  fs.writeFileSync(path.join(wsDir, '.env'), 'SECRET=e2e\n')
  fs.mkdirSync(path.join(wsDir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(wsDir, '.git', 'config'), '[core]\n')

  r = await req('GET', `/api/workspaces/${wsId}/tree`, null, alice)
  check('tree 200', r.status === 200)
  const topNames = (r.data?.root?.children || []).map((c) => c.name).sort()
  check('树含 .env/.git/readme.md/src/logo.png',
    JSON.stringify(topNames) === JSON.stringify(['.env', '.git', 'logo.png', 'readme.md', 'src']),
    `got=${JSON.stringify(topNames)}`)
  check('树不暴露 .dsh-workspace.json', !topNames.includes('.dsh-workspace.json'))

  // 场景 4：文本预览
  console.log('\n[4] 文本文件预览')
  r = await req('GET', `/api/workspaces/${wsId}/files/src/index.js`, null, alice)
  check('文本预览 200', r.status === 200, `status=${r.status}`)
  check('content-type text/plain', (r.headers.get('content-type') || '').startsWith('text/plain'))
  check('文本内容原样', r.buf.toString('utf8') === "export const x = 1\n")

  // 场景 5：二进制预览仅元信息
  console.log('\n[5] 二进制文件预览')
  r = await req('GET', `/api/workspaces/${wsId}/files/logo.png`, null, alice)
  check('二进制预览 200 JSON', r.status === 200 && !(r.buf instanceof Buffer && r.buf[0] === 0x89))
  check('binary=true 且 size=256', r.data?.file?.binary === true && r.data?.file?.size === 256,
    `data=${JSON.stringify(r.data)}`)

  // 场景 6：单文件下载
  console.log('\n[6] 单文件下载')
  r = await req('GET', `/api/workspaces/${wsId}/download?path=src/index.js`, null, alice)
  check('下载 200', r.status === 200)
  check('Content-Disposition attachment',
    (r.headers.get('content-disposition') || '').includes('attachment'))
  check('下载文件名 index.js',
    (r.headers.get('content-disposition') || '').includes("filename*=UTF-8''index.js"))
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  const localBuf = fs.readFileSync(path.join(wsDir, 'src', 'index.js'))
  check('下载字节级一致（sha256）', sha(r.buf) === sha(localBuf))

  // 场景 7：ZIP 下载并解压比对
  console.log('\n[7] 整工作区 ZIP 下载')
  r = await req('GET', `/api/workspaces/${wsId}/download-zip`, null, alice)
  check('ZIP 200 application/zip',
    r.status === 200 && (r.headers.get('content-type') || '').includes('application/zip'))
  check('ZIP attachment 文件名',
    (r.headers.get('content-disposition') || '').includes('e2e-demo.zip'))
  const files = extractZip(r.buf)
  check('ZIP 默认含 6 个用户文件（含 .env/.git）', files.size === 6, `count=${files.size}`)
  check('ZIP 不含 .dsh-workspace.json', !files.has('.dsh-workspace.json'))
  check('ZIP 默认包含隐藏文件 .env 与 .git/config',
    files.has('.env') && files.has('.git/config'))
  check('ZIP 内 src/index.js 字节一致',
    sha(files.get('src/index.js')) === sha(localBuf))
  check('ZIP 内 readme.md 字节一致',
    sha(files.get('readme.md')) === sha(fs.readFileSync(path.join(wsDir, 'readme.md'))))
  check('ZIP 内 logo.png store 字节一致',
    sha(files.get('logo.png')) === sha(fs.readFileSync(path.join(wsDir, 'logo.png'))))

  // WQ3：?includeHidden=false 排除点开头的文件/目录
  r = await req('GET', `/api/workspaces/${wsId}/download-zip?includeHidden=false`, null, alice)
  const pubFiles = extractZip(r.buf)
  check('includeHidden=false 仅 4 个非隐藏文件', pubFiles.size === 4, `count=${pubFiles.size}`)
  check('过滤后无任何点开头条目',
    ![...pubFiles.keys()].some((n) => n.startsWith('.') || n.includes('/.')))
  check('过滤后保留 src/index.js', pubFiles.has('src/index.js'))

  // 场景 8：路径遍历
  console.log('\n[8] 路径遍历攻击')
  r = await req('GET', `/api/workspaces/${wsId}/files/..%2f..%2f..%2fetc%2fpasswd`, null, alice)
  check('files 遍历 400 PATH_TRAVERSAL_DETECTED',
    r.status === 400 && r.data?.error?.code === 'PATH_TRAVERSAL_DETECTED', `status=${r.status}`)
  r = await req('GET',
    `/api/workspaces/${wsId}/download?path=${encodeURIComponent('../../.credentials.yaml')}`,
    null, alice)
  check('download 遍历 400 PATH_TRAVERSAL_DETECTED',
    r.status === 400 && r.data?.error?.code === 'PATH_TRAVERSAL_DETECTED', `status=${r.status}`)
  r = await req('GET', `/api/workspaces/${wsId}/files/not-exist.js`, null, alice)
  check('不存在文件 404 PATH_NOT_FOUND',
    r.status === 404 && r.data?.error?.code === 'PATH_NOT_FOUND', `status=${r.status}`)

  // 场景 9：在线写操作（P1.7 W2）
  console.log('\n[9] 在线写操作')
  r = await req('POST', `/api/workspaces/${wsId}/files/src/app.js`, { content: 'const v = 1\n' }, alice)
  check('POST 新建文件 201', r.status === 201, `status=${r.status}`)
  check('返回 version 与 ETag 一致',
    typeof r.data?.version === 'string' && r.headers.get('etag') === r.data.version,
    `etag=${r.headers.get('etag')} version=${r.data?.version}`)
  const wv1 = r.data?.version

  r = await req('GET', `/api/workspaces/${wsId}/files/src/app.js`, null, alice)
  check('preview 返回同一 ETag', r.status === 200 && r.headers.get('etag') === wv1,
    `etag=${r.headers.get('etag')}`)

  r = await req('PUT', `/api/workspaces/${wsId}/files/src/app.js`, { content: 'const v = 2\n' }, alice)
  check('无版本 PUT 428 PRECONDITION_REQUIRED',
    r.status === 428 && r.data?.error?.code === 'PRECONDITION_REQUIRED', `status=${r.status}`)

  r = await req('PUT', `/api/workspaces/${wsId}/files/src/app.js`, { content: 'const v = 3\n' },
    { ...alice, 'if-match': '"1-1"' })
  check('错误版本 PUT 409 + currentVersion',
    r.status === 409 && r.data?.error?.code === 'VERSION_CONFLICT' && r.data?.currentVersion === wv1,
    `status=${r.status} cur=${r.data?.currentVersion}`)

  r = await req('PUT', `/api/workspaces/${wsId}/files/src/app.js`, { content: 'const v = 4\n' },
    { ...alice, 'if-match': wv1 })
  check('正确版本 PUT 200', r.status === 200, `status=${r.status}`)
  check('PUT 后 ETag 变化且磁盘内容更新',
    typeof r.data?.version === 'string' && r.data.version !== wv1
      && fs.readFileSync(path.join(wsDir, 'src', 'app.js'), 'utf8') === 'const v = 4\n')

  r = await req('PUT', `/api/workspaces/${wsId}/files/src/app.js?force=true`, { content: 'const v = 5\n' }, alice)
  check('force PUT 无版本 200', r.status === 200, `status=${r.status}`)

  r = await req('POST', `/api/workspaces/${wsId}/files/logo2.png`, { content: 'x' }, alice)
  check('非文本类型 415 UNSUPPORTED_FILE_TYPE',
    r.status === 415 && r.data?.error?.code === 'UNSUPPORTED_FILE_TYPE', `status=${r.status}`)

  r = await req('POST', `/api/workspaces/${wsId}/files/huge.txt`,
    { content: 'x'.repeat(11 * 1024 * 1024) }, alice)
  check('content 超 10MB 413 CONTENT_TOO_LARGE',
    r.status === 413 && r.data?.error?.code === 'CONTENT_TOO_LARGE',
    `status=${r.status} code=${r.data?.error?.code}`)

  r = await req('POST', `/api/workspaces/${wsId}/files/bodyhuge.txt`,
    { content: 'x'.repeat(13 * 1024 * 1024) }, alice)
  check('body 超 12MB 413 PAYLOAD_TOO_LARGE',
    r.status === 413 && r.data?.error?.code === 'PAYLOAD_TOO_LARGE',
    `status=${r.status} code=${r.data?.error?.code}`)

  r = await req('PATCH', `/api/workspaces/${wsId}/files/src/app.js`, { newPath: 'src/main.js' }, alice)
  check('PATCH 重命名 200', r.status === 200 && r.data?.path === 'src/main.js', `status=${r.status}`)
  check('磁盘上旧名消失新名存在',
    !fs.existsSync(path.join(wsDir, 'src', 'app.js')) && fs.existsSync(path.join(wsDir, 'src', 'main.js')))

  r = await req('POST', `/api/workspaces/${wsId}/dirs/src/features`, null, alice)
  check('POST 新建目录 201', r.status === 201 && r.data?.path === 'src/features', `status=${r.status}`)

  r = await req('PATCH', `/api/workspaces/${wsId}/files/src/main.js`,
    { newPath: 'src/features/main.js' }, alice)
  check('跨目录移动 200', r.status === 200, `status=${r.status}`)
  check('文件已在新目录下', fs.existsSync(path.join(wsDir, 'src', 'features', 'main.js')))

  r = await req('DELETE', `/api/workspaces/${wsId}/files/src`, null, alice)
  check('非空目录非递归删除 409 DIRECTORY_NOT_EMPTY',
    r.status === 409 && r.data?.error?.code === 'DIRECTORY_NOT_EMPTY', `status=${r.status}`)

  r = await req('DELETE', `/api/workspaces/${wsId}/files/src/features?recursive=true`, null, alice)
  check('recursive 删除目录 200 且 removedCount=2',
    r.status === 200 && r.data?.removedCount === 2,
    `status=${r.status} count=${r.data?.removedCount}`)
  check('目录及其内容消失', !fs.existsSync(path.join(wsDir, 'src', 'features')))

  r = await req('PATCH', `/api/workspaces/${wsId}/files/src`, { newPath: 'src/inner' }, alice)
  check('移入自身子树 400 INVALID_MOVE',
    r.status === 400 && r.data?.error?.code === 'INVALID_MOVE', `status=${r.status}`)

  r = await req('POST', `/api/workspaces/${wsId}/files/..%2f..%2fsecret.js`, { content: 'x' }, bob)
  check('B 越权写 A 的工作区 403', r.status === 403, `status=${r.status}`)
  r = await req('POST', `/api/workspaces/${wsId}/files/..%2f..%2fsecret.js`, { content: 'x' }, alice)
  check('写操作路径遍历 400 PATH_TRAVERSAL_DETECTED',
    r.status === 400 && r.data?.error?.code === 'PATH_TRAVERSAL_DETECTED', `status=${r.status}`)

  r = await req('GET', `/api/workspaces/${wsId}/download-zip`, null, alice)
  const finalFiles = extractZip(r.buf)
  check('写操作后 ZIP 恢复为 6 个用户文件且结构正确',
    finalFiles.size === 6 && finalFiles.has('src/index.js') && finalFiles.has('src/deep/notes.txt'),
    `count=${finalFiles.size}`)

  // 审计文件：数据根目录（dataDir 即 DSH_HOME）下的 logs/auth-audit.jsonl
  const auditFile = path.join(dataDir, 'logs', 'auth-audit.jsonl')
  const auditText = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : ''
  const auditLines = auditText.split('\n').filter(Boolean).map((l) => JSON.parse(l))

  const createEv = auditLines.find((l) => l.event === 'workspace.file_create')
  check('审计 file_create 含 path/size/hash/lines',
    createEv && createEv.path === 'src/app.js' && createEv.size === 12
      && /^sha256:[a-f0-9]{64}$/.test(createEv.hash) && createEv.lines === 1,
    JSON.stringify(createEv))

  const updateEv = auditLines.find((l) => l.event === 'workspace.file_update')
  check('审计 file_update 含新旧 hash/版本/行规模',
    updateEv && /^sha256:[a-f0-9]{64}$/.test(updateEv.oldHash)
      && /^sha256:[a-f0-9]{64}$/.test(updateEv.newHash)
      && typeof updateEv.linesAdded === 'number' && typeof updateEv.linesRemoved === 'number',
    JSON.stringify(updateEv))
  const forcedEv = auditLines.filter((l) => l.event === 'workspace.file_update' && l.forced === true)
  check('force PUT 审计 forced=true', forcedEv.length === 1, `count=${forcedEv.length}`)

  const moveEv = auditLines.find((l) => l.event === 'workspace.entry_move')
  check('审计 entry_move 含 from/path',
    moveEv && moveEv.from === 'src/app.js' && moveEv.path === 'src/main.js',
    JSON.stringify(moveEv))

  const dirEv = auditLines.find((l) => l.event === 'workspace.dir_create')
  check('审计 dir_create 含 path', dirEv && dirEv.path === 'src/features', JSON.stringify(dirEv))

  const delEv = auditLines.find((l) => l.event === 'workspace.file_delete')
  check('审计 file_delete 含 recursive/removedCount',
    delEv && delEv.recursive === true && delEv.removedCount === 2, JSON.stringify(delEv))

  check('审计含 write_failed（DIRECTORY_NOT_EMPTY）',
    auditLines.some((l) => l.event === 'workspace.write_failed' && l.errorCode === 'DIRECTORY_NOT_EMPTY'))
  check('审计全文件不含写入正文特征串', !auditText.includes('const v = 4') && !auditText.includes('const v = 5'))

  // 场景 10：删除
  console.log('\n[10] 删除工作区')
  r = await req('DELETE', `/api/workspaces/${wsId}`, null, bob)
  check('B 不能删除 A 的工作区', r.status === 403)
  check('目录在 B 尝试删除后仍在', fs.existsSync(wsDir))

  r = await req('DELETE', `/api/workspaces/${wsId}`, null, alice)
  check('A 删除 200', r.status === 200 && r.data?.deleted === true, `status=${r.status}`)
  check('物理目录消失', !fs.existsSync(wsDir))
  r = await req('GET', `/api/workspaces/${wsId}`, null, alice)
  check('删除后访问 404', r.status === 404)
  r = await req('GET', `/api/workspaces/${wsId}`, null, bob)
  check('删除后 B 访问也是 404（而非 403）', r.status === 404)

  // 附加：非法 ID（裸 /../ 会被 fetch 的 URL 解析器折叠，用编码斜杠保留原始攻击形态）
  r = await req('GET', '/api/workspaces/..%2fetc', null, alice)
  check('非法工作区 ID 400', r.status === 400 && r.data?.error?.code === 'INVALID_WORKSPACE_ID',
    `status=${r.status}`)
} catch (e) {
  console.error('E2E 执行错误:', e)
  failed++
} finally {
  child.kill()
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
}

console.log('\n' + '='.repeat(50))
console.log(`结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
