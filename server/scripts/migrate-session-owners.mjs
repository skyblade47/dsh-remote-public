// 遗留会话归属迁移：扫描 <DSH_HOME>/sessions 下的全部逻辑会话，
// 把尚无归属的会话统一划归 admin，并输出迁移清单。可重复执行（幂等）。
// 默认目标为仓库内 .runtime/dsh-data；不会改动本地在用的 portable 实例，
// 除非显式以 --dsh-home 指向它。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSessionOwnerStore, scanSessionIds } from '../gateway/src/session-owners.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function parseArgs(argv) {
  const args = {
    dshHome: path.join(REPO_ROOT, '.runtime', 'dsh-data'),
    adminId: null,
    json: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dsh-home') args.dshHome = path.resolve(argv[++i])
    else if (a === '--admin-id') args.adminId = argv[++i]
    else if (a === '--json') args.json = true
  }
  return args
}

function loadAdminId(usersFile, explicit) {
  if (explicit) return explicit
  let data
  try {
    data = JSON.parse(fs.readFileSync(usersFile, 'utf8'))
  } catch {
    throw new Error(`无法读取用户文件 ${usersFile}，请用 --admin-id 显式指定`)
  }
  const admins = (data.users || []).filter((u) => u.role === 'admin' && !u.disabled)
  if (admins.length === 0) {
    throw new Error('系统中没有可用的 admin 用户，请先注册首个账号或以 --admin-id 指定')
  }
  return admins[0].id
}

async function main() {
  const args = parseArgs(process.argv)
  const dataDir = path.join(args.dshHome, 'users')
  const sessionsRoot = path.join(args.dshHome, 'sessions')
  const usersFile = path.join(dataDir, 'users.json')

  const adminId = await loadAdminId(usersFile, args.adminId)
  const allSessionIds = scanSessionIds(sessionsRoot)
  const ownerStore = createSessionOwnerStore(dataDir)
  const result = ownerStore.migrateLegacy(adminId, allSessionIds)

  const report = {
    dshHome: args.dshHome,
    adminId,
    total: allSessionIds.length,
    migratedCount: result.migrated.length,
    skippedCount: result.skipped,
    migrated: result.migrated,
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(`DSH_HOME: ${report.dshHome}\n`)
    process.stdout.write(`归属 admin: ${report.adminId}\n`)
    process.stdout.write(`扫描会话总数: ${report.total}\n`)
    process.stdout.write(`本次迁移: ${report.migratedCount}，已归属跳过: ${report.skippedCount}\n`)
    if (result.migrated.length > 0) {
      process.stdout.write('迁移清单:\n')
      for (const id of result.migrated) process.stdout.write(`  - ${id}\n`)
    }
  }
}

main().catch((err) => {
  process.stderr.write(`迁移失败: ${err.message}\n`)
  process.exit(1)
})
