// 启动编排：确保 DSH web 内核在线（必要时拉起），再以前置网关暴露统一入口。
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function parseBool(v) {
  return v === '1' || v === 'true' || v === 'yes'
}

function parseArgs(argv) {
  const args = {
    dshHome: path.join(REPO_ROOT, '.runtime', 'dsh-data'),
    gatewayPort: Number(process.env.DSH_GATEWAY_PORT || 8080),
    httpsPort: Number(process.env.DSH_GATEWAY_HTTPS_PORT || 8443),
    tls: parseBool(process.env.DSH_GATEWAY_TLS || ''),
    mtls: parseBool(process.env.DSH_GATEWAY_MTLS || ''),
    tlsSan: process.env.DSH_GATEWAY_TLS_SAN || '',
    host: process.env.DSH_GATEWAY_HOST || '127.0.0.1',
    upstreamPort: 3080,
    dshBin: process.env.DSH_BIN || '',
    // 客户端已拆分为独立仓库；留空则用仓库内 client/web（由 tools/fetch-client.ps1 拉取）
    webDir: process.env.DSH_GATEWAY_WEB_DIR || '',
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dsh-home') args.dshHome = path.resolve(argv[++i])
    else if (a === '--port') args.gatewayPort = Number(argv[++i])
    else if (a === '--https-port') args.httpsPort = Number(argv[++i])
    else if (a === '--tls') args.tls = true
    else if (a === '--mtls') args.mtls = true
    else if (a === '--tls-san') args.tlsSan = argv[++i]
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--upstream-port') args.upstreamPort = Number(argv[++i])
    else if (a === '--dsh-bin') args.dshBin = argv[++i]
    else if (a === '--web-dir') args.webDir = path.resolve(argv[++i])
  }
  return args
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host })
    sock.once('connect', () => { sock.end(); resolve(true) })
    sock.once('error', () => resolve(false))
    setTimeout(() => { sock.destroy(); resolve(false) }, 1000)
  })
}

function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isPortOpen(port)) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`等待端口 ${port} 超时`))
      setTimeout(tick, 300)
    }
    tick()
  })
}

function resolveDshBin(args) {
  if (args.dshBin) return args.dshBin
  const candidates = [
    'E:/DeepSeek-Harness-1.0.0-portable/resources/dsh-runtime/node_modules/.bin/dsh.cmd',
    'E:/DeepSeek-Harness-1.0.0-portable/resources/dsh-runtime/node_modules/.bin/dsh',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return 'dsh'
}

function spawnDshWeb(args) {
  const bin = resolveDshBin(args)
  const useShell = process.platform === 'win32'
  const child = spawn(bin, ['web', '--port', String(args.upstreamPort)], {
    env: { ...process.env, DSH_HOME: args.dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
  })
  child.stdout.on('data', (c) => process.stdout.write(`[dsh] ${c}`))
  child.stderr.on('data', (c) => process.stderr.write(`[dsh-err] ${c}`))
  return child
}

function spawnGateway(args) {
  const child = spawn('node', [path.join(REPO_ROOT, 'server', 'gateway', 'src', 'index.js')], {
    env: {
      ...process.env,
      DSH_HOME: args.dshHome,
      DSH_GATEWAY_PORT: String(args.gatewayPort),
      DSH_GATEWAY_HTTPS_PORT: String(args.httpsPort),
      DSH_GATEWAY_TLS: args.tls ? '1' : '',
      DSH_GATEWAY_MTLS: args.mtls ? '1' : '',
      DSH_GATEWAY_TLS_SAN: args.tlsSan,
      DSH_GATEWAY_HOST: args.host,
      DSH_GATEWAY_WEB_DIR: args.webDir,
      DSH_GATEWAY_UPSTREAM: `http://127.0.0.1:${args.upstreamPort}`,
      DSH_GATEWAY_DATA_DIR: args.dshHome,
      DSH_GATEWAY_PLUGIN_DIR: path.join(args.dshHome, 'profiles', 'web', 'node_modules', '@local'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (c) => process.stdout.write(`[gw] ${c}`))
  child.stderr.on('data', (c) => process.stderr.write(`[gw-err] ${c}`))
  return child
}

async function main() {
  const args = parseArgs(process.argv)
  const children = []

  if (await isPortOpen(args.upstreamPort)) {
    console.log(`检测到 DSH 内核已在 ${args.upstreamPort} 运行，直接复用`)
  } else {
    console.log(`启动 DSH web 内核（端口 ${args.upstreamPort}）...`)
    children.push(spawnDshWeb(args))
    await waitForPort(args.upstreamPort)
    console.log('DSH 内核已就绪')
  }

  console.log('启动网关 ...')
  const gateway = spawnGateway(args)
  children.push(gateway)
  const entryPort = args.tls ? args.httpsPort : args.gatewayPort
  await waitForPort(entryPort)
  if (args.tls) await waitForPort(args.gatewayPort)
  console.log('='.repeat(50))
  const scheme = args.tls ? 'https' : 'http'
  console.log(`本机入口: ${scheme}://127.0.0.1:${entryPort}/app`)
  const loopbackHosts = ['127.0.0.1', 'localhost', '::1', '[::1]']
  if (!loopbackHosts.includes(args.host)) {
    console.log(`监听地址: ${args.host}:${entryPort}（对外入口请用你的固定 IP / 域名）`)
    if (args.tls) {
      const sanList = (args.tlsSan || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (sanList.length === 0) {
        console.log('提示: 未配置 --tls-san，用固定 IP 访问会证书不匹配。')
        console.log('      建议加上：--tls-san <你的公网IP>')
      } else {
        console.log(`证书 SAN 已包含: ${sanList.join(' / ')}`)
      }
    }
  }
  if (args.tls) {
    console.log(`HTTP 自动跳转: http://127.0.0.1:${args.gatewayPort}`)
    console.log('备用链路: ssh -N -L ' + entryPort + ':127.0.0.1:' + entryPort + ' <用户>@<主机>')
    console.log('首次访问需信任自签证书（浏览器“高级 → 继续”，或导入系统受信任根）。')
  }
  console.log('='.repeat(50))

  const shutdown = () => {
    for (const c of children) {
      try { c.kill() } catch { /* ignore */ }
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  for (const c of children) {
    c.on('exit', (code) => {
      console.log('子进程退出 code=', code)
    })
  }
}

main().catch((e) => {
  console.error('启动失败:', e.message)
  process.exit(1)
})
