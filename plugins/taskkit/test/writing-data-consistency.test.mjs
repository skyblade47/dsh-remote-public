// 写作成果可视化面板 —— 数据一致性自测
// 运行：node test/writing-data-consistency.test.mjs
// 验证 host 聚合所依赖的源数据文件字段与预期一致。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../../../../写作训练')

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('PASS: ' + msg)
}

const record = JSON.parse(await readFile(path.join(root, '写作记录.json'), 'utf8'))
const plan = JSON.parse(await readFile(path.join(root, '日程计划.json'), 'utf8'))
const done = JSON.parse(await readFile(path.join(root, '日程完成.json'), 'utf8'))

assert(record && typeof record.totalWords === 'number', '写作记录 totalWords 为数字')
assert(record && record.days && typeof record.days === 'object', '写作记录 days 存在')
assert(record && typeof record.streak === 'number', '写作记录 streak 为数字')

const totalPlanDays = (plan.weeks || []).reduce((acc, w) => acc + (w.days || []).length, 0)
assert(totalPlanDays > 0, '日程计划包含训练日')

const doneKeys = Object.keys(done.done || {}).filter((k) => done.done[k] === true)
assert(doneKeys.length > 0, '日程完成存在已完成项')

const draftsDir = path.join(root, '草稿')
const { readdir } = await import('node:fs/promises')
const draftNames = (await readdir(draftsDir)).filter((n) => n.endsWith('.md'))
assert(draftNames.length > 0, '草稿目录存在 .md 文件')

console.log('\n写作数据一致性自测通过：总字数=' + record.totalWords + '，连续=' + record.streak + '，计划日=' + totalPlanDays + '，完成=' + doneKeys.length + '，草稿=' + draftNames.length)
