// profile 的 package.json 装配：
//   - profile 不存在    → 按模板创建（逐字节复制模板）
//   - profile 已存在    → 应用模板：按模板替换 dsh.profile.bundles 与 dependencies，
//                        并由 bundles 推导出 @local/* 的 link: 依赖
// templatesDir / pluginsDir 由调用方注入，避免模块内再算一遍目录造成"两个真相"。
import fs from 'node:fs'
import path from 'node:path'

const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

// 直接链接仓库 plugins 源码，不经 node_modules/@local 中间 junction
//（否则 link 目标与预置 junction 同一路径会自指冲突）；分隔符统一为 "/"。
function localLink(profileDir, pluginsDir, short) {
  return `link:${path.relative(profileDir, path.join(pluginsDir, short)).split(path.sep).join('/')}`
}

// @local/* 依赖只能从 bundles 推导：模板的 dependencies 里不含 @local/*，
// 若只照搬模板依赖，bundles 引用的 @local/dsh-adapter 会消失，内核解析不到 adapter。
function deriveDependencies(profileDir, pluginsDir, bundles) {
  const deps = {}
  for (const name of bundles) {
    if (typeof name === 'string' && name.startsWith('@local/')) {
      deps[name] = localLink(profileDir, pluginsDir, name.slice('@local/'.length))
    }
  }
  return deps
}

// 门禁：写入前检查，不通过就 throw，绝不改动任何文件。
function assertBundlesSafe(bundles) {
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error(`profile 模板的 dsh.profile.bundles 为空，写入会让内核起不来：${JSON.stringify(bundles)}`)
  }
  const missing = REQUIRED_BUNDLES.filter((n) => !bundles.includes(n))
  if (missing.length) {
    throw new Error(`profile 模板的 bundles 缺内核底座（${missing.join(', ')}），写入会让内核起不来：${JSON.stringify(bundles)}`)
  }
}

// 原子写：先写同目录 .tmp 再 rename 覆盖；任何失败路径都不得残留 .tmp。
function writeFileAtomic(filePath, text) {
  const tmpPath = `${filePath}.tmp`
  try {
    fs.writeFileSync(tmpPath, text, 'utf8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }) } catch { /* 清理失败不掩盖原始错误 */ }
    throw err
  }
}

export function writeProfilePackage(profileDir, templateName, { templatesDir, pluginsDir }) {
  const pkgPath = path.join(profileDir, 'package.json')
  const tplPath = path.join(templatesDir, templateName)
  if (!fs.existsSync(tplPath)) {
    throw new Error(`profile 模板不存在: ${tplPath}（可用：${fs.readdirSync(templatesDir).filter((f) => f.endsWith('.package.json')).join(', ')}）`)
  }
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'))
  const bundles = tpl?.dsh?.profile?.bundles

  assertBundlesSafe(bundles)

  if (!fs.existsSync(pkgPath)) {
    writeFileAtomic(pkgPath, fs.readFileSync(tplPath, 'utf8'))
    return `created(by ${templateName})`
  }

  const cur = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const curText = fs.readFileSync(pkgPath, 'utf8')

  // 顶层键保留现有 profile 的值（模板未声明的键不能丢），
  // 只替换 bundles 与 dependencies；dsh.profile 下其它键同样保留。
  const merged = {
    ...cur,
    dependencies: {
      ...(tpl.dependencies || {}),
      ...deriveDependencies(profileDir, pluginsDir, bundles),
    },
    dsh: {
      ...(cur.dsh || {}),
      profile: { ...(cur.dsh?.profile || {}), bundles },
    },
  }

  const nextText = JSON.stringify(merged, null, 2) + '\n'
  if (nextText === curText) return 'unchanged'

  fs.copyFileSync(pkgPath, `${pkgPath}.bak-apply-${Date.now()}`)
  writeFileAtomic(pkgPath, nextText)
  return 'applied-template'
}
