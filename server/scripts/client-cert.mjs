// 客户端证书（mTLS 白名单）管理命令。
//
//   node server/scripts/client-cert.mjs init
//   node server/scripts/client-cert.mjs issue <设备名> [--days 3650]
//   node server/scripts/client-cert.mjs list
//   node server/scripts/client-cert.mjs revoke <设备名>
//   node server/scripts/client-cert.mjs pfx <设备名> [--password <口令>]
//
// 数据目录与网关一致：优先 --data-dir，其次 DSH_GATEWAY_DATA_DIR / DSH_HOME。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveDataDir } from '../gateway/src/store.js'
import {
  clientCaPaths,
  clientsDir,
  issueClientCert,
  listClientCerts,
  loadOrCreateClientCa,
  revokeClientCert,
} from '../gateway/src/client-certs.js'

function parseArgs(argv) {
  const args = { command: argv[2] || 'help', name: argv[3] || '', days: 3650, password: '', dataDir: '' }
  // 从 argv[3] 起扫描：issue/pfx 的 argv[3] 是设备名，init/list 的 argv[3] 就可能是选项
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i])
    else if (argv[i] === '--password') args.password = argv[++i]
    else if (argv[i] === '--data-dir') args.dataDir = path.resolve(argv[++i])
  }
  return args
}

function requireName(args) {
  if (!args.name) throw new Error('缺少设备名，例如: issue iphone')
  return args.name
}

const args = parseArgs(process.argv)
const dataDir = args.dataDir || resolveDataDir()

switch (args.command) {
  case 'init': {
    const ca = loadOrCreateClientCa({ dataDir, log: (m) => console.log(m) })
    console.log(`客户端 CA 就绪: ${ca.certFile}`)
    console.log('接下来为每台设备签发证书: node server/scripts/client-cert.mjs issue <设备名>')
    break
  }

  case 'issue': {
    const name = requireName(args)
    const r = issueClientCert({ dataDir, name, daysValid: args.days })
    console.log(`已签发并加入白名单: ${name}`)
    console.log(`  证书: ${r.certFile}`)
    console.log(`  私钥: ${r.keyFile}`)
    console.log(`  指纹: ${r.fingerprint256}`)
    console.log(`  到期: ${r.notAfter}`)
    console.log('')
    console.log('要在 Windows 上安装，先生成 pfx：')
    console.log(`  node server/scripts/client-cert.mjs pfx ${name} --password <设定一个口令>`)
    console.log('然后双击 pfx 导入（当前用户 → 个人），浏览器首次访问会提示选择证书。')
    break
  }

  case 'list': {
    const caFile = clientCaPaths(dataDir).certFile
    console.log(`数据目录: ${dataDir}`)
    console.log(`客户端 CA: ${fs.existsSync(caFile) ? caFile : '（尚未创建）'}`)
    const list = listClientCerts(dataDir)
    if (list.length === 0) {
      console.log('尚无已签发的设备证书。')
      break
    }
    console.log('')
    for (const c of list) {
      console.log(`${c.allowed ? '[已授权]' : '[已吊销]'} ${c.name}`)
      console.log(`    ${c.subject} · 到期 ${c.notAfter}`)
      console.log(`    ${c.fingerprint256}`)
    }
    break
  }

  case 'revoke': {
    const name = requireName(args)
    if (revokeClientCert({ dataDir, name })) {
      console.log(`已吊销 ${name}（立即生效，无需重启网关）`)
    } else {
      console.log(`白名单中未找到 ${name}（可能名称不对或已吊销）`)
    }
    break
  }

  case 'pfx': {
    const name = requireName(args)
    const dir = clientsDir(dataDir)
    const certFile = path.join(dir, `${name}.cert.pem`)
    const keyFile = path.join(dir, `${name}.key.pem`)
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      throw new Error(`未找到 ${name} 的证书，请先执行 issue ${name}`)
    }
    const password = args.password
    if (!password) throw new Error('请用 --password <口令> 指定 pfx 导出密码（导入时要用）')
    const outFile = path.join(dir, `${name}.pfx`)
    // Windows 自带 certutil 可直接把 PEM 证书 + 私钥合并为 pfx（零额外依赖）
    const r = spawnSync('certutil', ['-MergePFX', '-p', password, certFile, outFile], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    })
    if (r.status !== 0 && !fs.existsSync(outFile)) {
      console.error(r.stdout || '', r.stderr || '')
      throw new Error('certutil -MergePFX 失败；可在装有 openssl 的机器上执行：'
        + `openssl pkcs12 -export -out ${name}.pfx -inkey ${keyFile} -in ${certFile}`)
    }
    console.log(`已生成: ${outFile}`)
    console.log('导入方式：双击 → 当前用户 → 个人 → 输入导出时的口令。')
    break
  }

  default:
    console.log('用法:')
    console.log('  client-cert.mjs init                          创建客户端 CA')
    console.log('  client-cert.mjs issue <设备名> [--days N]      签发设备证书并加入白名单')
    console.log('  client-cert.mjs list                          查看已签发设备与授权状态')
    console.log('  client-cert.mjs revoke <设备名>                吊销（立即生效）')
    console.log('  client-cert.mjs pfx <设备名> --password <口令>  导出 pfx 供 Windows/手机安装')
    console.log('')
    console.log(`当前数据目录: ${dataDir}`)
    console.log('（可用 --data-dir <网关数据目录> 指定，或设 DSH_GATEWAY_DATA_DIR / DSH_HOME）')
}
