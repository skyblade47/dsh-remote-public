// ⚠️ **这是契约锁，不是行为测试。**
// lib/index.js 必须 import '@deepseek-ai/dsh-tools'，而该包**只存在于宿主机** ⇒ index.js 本机无法被
// import（import 即 MODULE_NOT_FOUND）。因此这里**只能**对源码做静态契约断言。
// index.js 的运行时行为（工具注册、路由挂载、审计/报告链路）**只能在第二阶段装载后冒烟验证**。
// 用法（仓库根目录）：node --test plugins/version-radar/test/wiring.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_PREFIX } from '../lib/routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

test('① 必须从 @deepseek-ai/dsh-tools 取 defineTool（宿主专有依赖）', () => {
  assert.match(SRC, /import\s*\{\s*defineTool\s*\}\s*from\s*'@deepseek-ai\/dsh-tools'/)
})

test('② inject 必须恰好是 tools / webServer / fs（最小集）', () => {
  const m = SRC.match(/const\s+inject\s*=\s*\[([^\]]*)\]/)
  assert.ok(m, 'index.js 必须显式声明 inject 数组')
  const items = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
  assert.deepEqual(items.slice().sort(), ['fs', 'tools', 'webServer'])
})

test('③ 注册的工具名是 version_probe，且参数含 targetVersion / report', () => {
  assert.match(SRC, /TOOL_NAME\s*=\s*'version_probe'/)
  assert.match(SRC, /name:\s*TOOL_NAME/)
  assert.match(SRC, /targetVersion:/)
  assert.match(SRC, /report:/)
})

test('④ 引用 HTTP 前缀 /version-radar/api（值与 routes.js 一致）并挂到 webServer', () => {
  assert.match(SRC, /'\/version-radar\/api'/)
  assert.equal(API_PREFIX, '/version-radar/api')
  assert.match(SRC, /path:\s*HTTP_PREFIX/)
  assert.match(SRC, /webServer\.register\(/)
  assert.match(SRC, /kind:\s*'prefix'/)
})

test('⑤ 禁启动期首触：index.js 不得出现 setInterval / setTimeout', () => {
  assert.doesNotMatch(SRC, /\bsetInterval\b/)
  assert.doesNotMatch(SRC, /\bsetTimeout\b/)
})

test('⑥ 纪律：不见子进程 API / 不读会话目录 / 不递归扫盘（readdir）', () => {
  assert.doesNotMatch(SRC, /child_process|execFileSync|spawnSync|\bspawn\s*\(/)
  assert.doesNotMatch(SRC, /\bsessions\b/)
  assert.doesNotMatch(SRC, /\breaddirSync\b/)
})

test('⑦ 落审计 + 按需出报告：走 audit.js / report.js，index.js 自己**不直接写文件**', () => {
  assert.match(SRC, /from\s*'\.\/audit\.js'/)
  assert.match(SRC, /from\s*'\.\/report\.js'/)
  assert.match(SRC, /EVENTS\.TRIGGER/)
  assert.match(SRC, /EVENTS\.DONE/)
  assert.match(SRC, /EVENTS\.ERROR/)
  assert.doesNotMatch(SRC, /writeFileSync|appendFileSync/)
})

test('⑧ 🔴 工具定义必须带 output.schema + output.render（defineTool 的硬要求）', () => {
  // 依据：宿主 dsh-tools 的 defineTool **直接读** options.output.render（`const userRender = options.output.render;`）
  //   与 options.output.schema（`valueSchemaSpecToJsonSchema(options.output.schema)`）。
  //   ⇒ 只传 name/description/parameters/execute 会抛
  //      "Cannot read properties of undefined (reading 'render')"。
  //   🔴 2026-09-26 真机实测踩到：hotplug 审计 `loaded=true`（模块加载成功），
  //      但内核日志记 `version_probe register failed: Cannot read properties of undefined (reading 'render')`
  //      ⇒ **工具没注册上**。可用参考 = 本仓 session-janitor 的 register()（它显式拼了 output）。
  assert.match(SRC, /output:\s*\{/, 'defineTool 参数必须含 output 对象')
  assert.match(SRC, /output:\s*\{[\s\S]*?\brender:\s*\(/, 'output.render 必须提供（函数）')
  assert.match(SRC, /output:\s*\{[\s\S]*?\bschema:\s*\{\s*type:\s*'object'/, "output.schema 必须提供（形如 { type: 'object', … }）")
})

test('⑨ 工具渲染必须把**完整 JSON**交给模型（不能只给一行摘要）', () => {
  // 🔴 2026-09-26 真机实测教训：`render` 只回 "verdict｜reasons[0]" 一行时，
  //   对话里的模型**看不到**完整结果（8 个冻结字段全隐），只能绕道 /version-radar/api/status 才拿得到
  //   ⇒ 工具等于"半可用"。修法 = 一行摘要 + 完整 pretty JSON。
  assert.match(SRC, /render:[\s\S]{0,400}?JSON\.stringify\(value,\s*null,\s*2\)/, 'render 必须把完整 JSON.stringify(value, null, 2) 放进返回文本')
})
