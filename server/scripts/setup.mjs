// 一次性/幂等环境装配：把仓库 plugins/ 链接进目标 DSH_HOME 的 @local，
// 重写 profile package.json 为相对路径，放置脱敏配置，并执行 pnpm install。
// 默认目标为仓库内 .runtime/dsh-data，不触碰在用的 portable 本地实例。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeProfilePackage } from './lib/profile-package.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
// 🔴 release 所有权迁移（H5 / R2）：`link:` 依赖的**唯一**来源就是这里的 pluginsDir
//   （profile-package.mjs::deriveDependencies 用它算相对路径）。默认仍是仓库 plugins/（行为不变）；
//    release 模式下由 setup.sh 注入 DSH_PLUGINS_DIR=<release>/current/plugins，
//    否则每次 setup 都会把 @local/dsh-adapter 的 link: 打回 /opt，且 pnpm install 会照它重建链接。
const PLUGINS_DIR = process.env.DSH_PLUGINS_DIR
  ? path.resolve(process.env.DSH_PLUGINS_DIR)
  : path.join(REPO_ROOT, 'plugins')
const TEMPLATES_DIR = path.join(REPO_ROOT, 'server', 'data', 'templates')

function parseArgs(argv) {
  const args = {
    dshHome: path.join(REPO_ROOT, '.runtime', 'dsh-data'),
    skipInstall: false,
    // profile 模板文件名（相对 server/data/templates/）：
    //   profile-web.package.json         全量（本机开发：13 个 @local 插件）
    //   profile-web-minimal.package.json 最小集（Linux 首版：base + web-app + adapter + memory-system）
    profileTemplate: 'profile-web.package.json',
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dsh-home') args.dshHome = path.resolve(argv[++i])
    else if (a === '--skip-install') args.skipInstall = true
    else if (a === '--profile-template') args.profileTemplate = argv[++i]
  }
  return args
}

function linkPlugin(target, linkPath) {
  if (fs.existsSync(linkPath)) {
    try {
      const st = fs.lstatSync(linkPath)
      if (st.isSymbolicLink() || st.isDirectory()) return 'exists'
    } catch { /* fall through to replace */ }
    fs.rmSync(linkPath, { recursive: true, force: true })
  }
  if (process.platform === 'win32') {
    fs.symlinkSync(target, linkPath, 'junction')
  } else {
    fs.symlinkSync(target, linkPath, 'dir')
  }
  return 'linked'
}

// 定位"含 @deepseek-ai/dsh-tools 的 node_modules 根"：
// 1) DSH_RUNTIME_ROOT 显式指定（推荐，云上/CI 都用这个）
// 2) 本地便携版的默认位置
// 3) npm 全局安装（npm i -g @deepseek-ai/dsh@<版本>）—— 云上从网络拉取的路径
// 插件经 pnpm link 以 junction 形式挂进 profile，ESM 用 realpath 向上解析，
// realpath 会回到仓库 plugins/ 源码真实路径，逃逸出 DSH_HOME 树。
// 因此在 plugins/node_modules 下放置指向宿主 dsh-tools 的 junction，
// 让真实路径向上解析时仍能命中宿主包。
//
// dsh-tools 的落点随安装方式不同，两种都要认：
//   - 便携版         ：<root>/@deepseek-ai/dsh-tools（顶层）
//   - npm 全局安装   ：<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools
//     （dsh-tools 不是 dsh 的直接依赖，是被传递依赖带进来的，npm 不会扁平化到顶层）
const TOOLS_REL = path.join('@deepseek-ai', 'dsh-tools', 'package.json')

function findToolsRoot(base) {
  const candidates = [base, path.join(base, '@deepseek-ai', 'dsh', 'node_modules')]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, TOOLS_REL))) return path.resolve(c)
  }
  return null
}

function resolveDshRuntimeRoot() {
  const candidates = [];
  if (process.env.DSH_RUNTIME_ROOT) candidates.push(path.resolve(process.env.DSH_RUNTIME_ROOT))
  candidates.push(
    'E:/DeepSeek-Harness-1.0.0-portable/resources/dsh-runtime/node_modules',
  )
  const npmRoot = npmGlobalRoot()
  if (npmRoot) candidates.push(npmRoot)

  for (const c of candidates) {
    const found = findToolsRoot(c)
    if (found) return found
  }
  return null
}

function npmGlobalRoot() {
  const r = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (r.status !== 0 || !r.stdout) return null
  const dir = r.stdout.trim()
  return dir && fs.existsSync(dir) ? dir : null
}

// 插件运行时唯一的裸导入是宿主 @deepseek-ai/dsh-tools，其余均为 node: 内置模块。
function linkHostPackages() {
  const runtimeRoot = resolveDshRuntimeRoot()
  if (!runtimeRoot) return ['未找到含 @deepseek-ai/dsh-tools 的 node_modules 根（设 DSH_RUNTIME_ROOT 跳过此步）']
  const scopeDst = path.join(PLUGINS_DIR, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(scopeDst, { recursive: true })
  const notes = []
  for (const name of ['dsh-tools']) {
    const target = path.join(runtimeRoot, '@deepseek-ai', name)
    const result = linkPlugin(target, path.join(scopeDst, name))
    notes.push(`@deepseek-ai/${name}(${result})`)
  }
  return [`根=${runtimeRoot}`, ...notes]
}

// profile 目录嵌套在仓库 workspace 内：放置本地 workspace 声明（packages 为空，
// 阻止 pnpm 继续向上找仓库根），并钉住仅发布 alpha 的传递依赖版本。
function placeProfileWorkspace(profileDir) {
  const dst = path.join(profileDir, 'pnpm-workspace.yaml')
  const tplPath = path.join(TEMPLATES_DIR, 'profile-web.pnpm-workspace.yaml')
  if (!fs.existsSync(dst)) {
    fs.copyFileSync(tplPath, dst)
    return 'pnpm-workspace.yaml'
  }
  // 幂等补齐旧模板缺失的 onlyBuiltDependencies 声明（零依赖手写 YAML，避免引解析库）。
  const cur = fs.readFileSync(dst, 'utf8')
  if (!/^onlyBuiltDependencies:/m.test(cur)) {
    const tpl = fs.readFileSync(tplPath, 'utf8')
    const line = tpl.match(/^onlyBuiltDependencies:.*$/m)[0]
    fs.writeFileSync(dst, `${cur.replace(/\s*$/, '\n')}${line}\n`, 'utf8')
    return 'pnpm-workspace.yaml(补齐 onlyBuiltDependencies)'
  }
  return null
}

// 与 dsh-client-connection 的校验保持一致：secret 必须是解码后恰为 32 字节的 base64url。
// 模板占位符（<BROWSER_SESSION_SECRET>）会被内核拒绝，且内核见到既有记录不会自行重生成。
function isValidBrowserSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === 32
}

function repairCredentialSecret(credDst) {
  const text = fs.readFileSync(credDst, 'utf8')
  const m = text.match(/^( {6}secret: )(.+)$/m)
  if (!m) return false
  const current = m[2].trim()
  if (isValidBrowserSecret(current)) return false
  const secret = crypto.randomBytes(32).toString('base64url')
  fs.writeFileSync(credDst, text.replace(m[0], `${m[1]}${secret}`), 'utf8')
  return true
}

function placeIfAbsent(dshHome) {
  const notes = []
  const settingsDst = path.join(dshHome, 'settings.yaml')
  if (!fs.existsSync(settingsDst)) {
    fs.copyFileSync(path.join(TEMPLATES_DIR, 'settings.yaml'), settingsDst)
    notes.push('settings.yaml')
  }
  const presetsDst = path.join(dshHome, '.agent-presets')
  if (!fs.existsSync(presetsDst)) {
    fs.cpSync(path.join(TEMPLATES_DIR, '.agent-presets'), presetsDst, { recursive: true })
    notes.push('.agent-presets/')
  }
  const credDst = path.join(dshHome, '.credentials.yaml')
  if (!fs.existsSync(credDst)) {
    fs.copyFileSync(path.join(TEMPLATES_DIR, '.credentials.yaml.template'), credDst)
    notes.push('.credentials.yaml')
  }
  if (repairCredentialSecret(credDst)) notes.push('.credentials.yaml(secret 已重生成)')
  return notes
}

// 依赖是否全为本地引用（link:/file:），即没有需要从 registry 下载的包。
// 全为本地引用时 pnpm 做的事只是建符号链接——直接建即可，结果等价，
// 且不再依赖 pnpm 可执行文件与网络。最小集（Linux 首版：仅 adapter + memory-system）
// 就属于这种情况，因此在纯净/离线环境也能装配。
function isLinkOnly(pkg) {
  const deps = Object.entries(pkg.dependencies || {})
  if (deps.length === 0) return true
  return deps.every(([, spec]) => typeof spec === 'string' && /^(link|file):/.test(spec))
}

// 按 package.json 的 @local 依赖在 profile 内建链接（只处理 @local，其余交给 pnpm）
function linkLocalDeps(profileDir, pkg) {
  const notes = []
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (!name.startsWith('@local/')) continue
    const short = name.slice('@local/'.length)
    const src = path.join(PLUGINS_DIR, short)
    if (!fs.existsSync(src)) throw new Error(`依赖指向不存在的插件源码：${name} → ${src}`)
    const dst = path.join(profileDir, 'node_modules', ...name.split('/'))
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    notes.push(`${name}(${linkPlugin(src, dst)})`)
  }
  return notes
}

function runPnpmInstall(profileDir) {
  // profile 目录内已放置 pnpm-workspace.yaml（packages 为空 + overrides），
  // pnpm 在此执行时不会继续向上找仓库根，依赖会正确落到 profile 本地 node_modules。
  // 不能加 --ignore-workspace，否则连本地的 overrides 也会被一并忽略。
  // PNPM_BIN：显式指定 pnpm 可执行文件。必要场景是 WSL——PATH 里混入 Windows 的
  // PATH，`pnpm` 会命中 /mnt/c/... 的 Windows 垫片，在 Linux 上执行必然失败。
  const r = spawnSync(process.env.PNPM_BIN || 'pnpm', ['install'], {
    cwd: profileDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    const combined = `${r.stdout || ''}${r.stderr || ''}`
    // pnpm v10+ 对未批准的安装脚本（node-pty 等）以 exit 1 退出；
    // 纯 Web 内核不需要这些原生模块，node_modules 已正常落盘，容忍此提示。
    const onlyIgnoredBuilds = combined.includes('ERR_PNPM_IGNORED_BUILDS')
      && fs.existsSync(path.join(profileDir, 'node_modules'))
    if (!onlyIgnoredBuilds) {
      // status=null 说明进程根本没起来（如 PNPM_BIN 指向不可执行文件），
      // 此时 r.error 才是真正的原因，必须一起报出来，否则只剩"exit=null"没法查。
      const detail = r.error ? `：${r.error.message}` : ''
      throw new Error(`pnpm install 失败（exit=${r.status} signal=${r.signal || '-'}）${detail}`)
    }
    console.log('（忽略未批准构建脚本的提示，不影响 Web 内核运行）')
  }
}

function main() {
  const args = parseArgs(process.argv)
  const dshHome = path.resolve(args.dshHome)
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const localDir = path.join(profileDir, 'node_modules', '@local')

  console.log('目标 DSH_HOME:', dshHome)

  // 仅 --skip-install 时才预置 @local junction：正常安装时 pnpm 会按
  // package.json 的 link: 依赖自行创建链接，预置反而同路径冲突。
  if (args.skipInstall) {
    fs.mkdirSync(localDir, { recursive: true })
    const plugins = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => name !== 'node_modules' && !name.startsWith('.'))
    for (const name of plugins) {
      const target = path.join(PLUGINS_DIR, name)
      const result = linkPlugin(target, path.join(localDir, name))
      console.log(`  ${result === 'linked' ? '🔗' : '✔'} @local/${name} (${result})`)
    }
  }

  const hostNotes = linkHostPackages()
  console.log('宿主包链接:', hostNotes.join(', '))

  const pkgResult = writeProfilePackage(profileDir, args.profileTemplate, {
    templatesDir: TEMPLATES_DIR,
    pluginsDir: PLUGINS_DIR,
  })
  console.log('profile package.json:', pkgResult)

  const wsNote = placeProfileWorkspace(profileDir)
  if (wsNote) console.log('已放置 profile', wsNote)

  const placed = placeIfAbsent(dshHome)
  if (placed.length) console.log('已放置配置:', placed.join(', '))
  else console.log('配置已存在，跳过')

  if (!args.skipInstall) {
    const profilePkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    if (isLinkOnly(profilePkg)) {
      console.log('依赖全为 link:/file:（无 registry 依赖）→ 跳过 pnpm，直接建立 @local 链接')
      for (const note of linkLocalDeps(profileDir, profilePkg)) console.log('  🔗', note)
    } else {
      console.log('运行 pnpm install ...')
      runPnpmInstall(profileDir)
      console.log('依赖安装完成')
    }
  } else {
    console.log('已跳过 pnpm install（--skip-install）')
  }
  console.log('setup 完成')
}

main()
