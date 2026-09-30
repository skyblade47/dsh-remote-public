// 插件路由处理器。
// 路径：
//   GET  /api/plugins            → 列出 @local/ 下所有插件（需认证）
//   GET  /api/plugins/:name      → 单插件详情（需认证）
//   POST /api/plugins/:name/publish → 发布到 GitHub（需认证）
//   POST /api/plugins/:name/deploy  → 从用户工作区部署插件到 @local（需认证）
//
// 所有路由都需要认证；index.js 中先走 authMiddleware 再调用 pluginRoutes.match。
import fs from 'node:fs'
import path from 'node:path'

import { createRepo } from './github.js'
import { safeResolve } from './workspace-fs.js'
import {
  createWorkspaceStore,
  resolveWorkspacesRoot,
  isValidWorkspaceId,
} from './workspace-store.js'
import {
  isGitRepo,
  initRepo,
  setIdentity,
  addAll,
  commit,
  addRemote,
  setRemoteUrl,
  pushUpstream,
  buildAuthUrl,
  buildCleanUrl,
} from './git-ops.js'

const GITIGNORE_CONTENT = `# 依赖
node_modules/
# 日志
*.log
*.bak*
*.tmp
*.swp
# 系统
.DS_Store
Thumbs.db
# 环境
.env
.env.local
`

// 请求体上限：插件接口只有少量元数据，1MB 足够，避免超大 body 打满内存。
const MAX_BODY_BYTES = 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        const e = new Error('请求体过大')
        e.code = 'PAYLOAD_TOO_LARGE'
        req.resume()
        reject(e)
        return
      }
      body += c
    })
    req.on('end', () => {
      if (aborted) return
      try { resolve(body ? JSON.parse(body) : {}) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function err(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

function matchPath(pattern, url) {
  const urlPath = url.split('?')[0]
  const patternParts = pattern.split('/')
  const urlParts = urlPath.split('/')
  if (patternParts.length !== urlParts.length) return null
  const params = {}
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      // 解码失败（如 %ZZ）视为不匹配，避免未捕获 URIError 打断进程。
      try {
        params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i])
      } catch {
        return null
      }
    } else if (patternParts[i] !== urlParts[i]) {
      return null
    }
  }
  return params
}

function resolvePluginDir(env = process.env) {
  if (env.DSH_GATEWAY_PLUGIN_DIR) return env.DSH_GATEWAY_PLUGIN_DIR
  const base = env.DSH_HOME || './dsh-data'
  return path.join(base, 'profiles', 'web', 'node_modules', '@local')
}

function readPluginMeta(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description || '',
    }
  } catch {
    return null
  }
}

function listTopLevel(pluginDir) {
  // 列出插件目录下的第一层条目（用于详情视图）
  try {
    return fs.readdirSync(pluginDir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }))
  } catch {
    return []
  }
}

function hasPatchFile(pluginDir) {
  return fs.existsSync(path.join(pluginDir, 'cordis.patch.yml'))
    || fs.existsSync(path.join(pluginDir, 'dsh-bundle-patch.yml'))
}

function sanitizeRepoName(raw) {
  // 仓库命名规则：a-z 0-9 - _，不能以 . - 开头/结尾
  const cleaned = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  const trimmed = cleaned.replace(/^[._-]+/, '').replace(/[._-]+$/, '')
  return trimmed
}

export { sanitizeRepoName }

// 插件目录名白名单：与工作区插件分桶命名一致，禁止路径分隔符注入。
const PLUGIN_NAME_RE = /^[a-z0-9._-]+$/i

function isValidPluginName(name) {
  return typeof name === 'string' && PLUGIN_NAME_RE.test(name)
    && !name.startsWith('.') && !name.endsWith('.')
}

// 解析插件目录：先做名称白名单，再断言结果仍位于 pluginRoot 内。
// 必须用于所有把 URL 参数拼成路径的入口，避免 %2F 解码后越出插件根目录。
function resolvePluginPath(pluginRoot, name) {
  if (!isValidPluginName(name)) return null
  const dir = path.join(pluginRoot, name)
  if (path.dirname(path.resolve(dir)) !== path.resolve(pluginRoot)) return null
  return dir
}

// 递归拷贝目录：全程 lstat，不跟随符号链接——源树内出现 symlink 即拒绝。
// 工作区内部元信息文件不拷贝，避免内部标识泄漏到部署产物中。
function copyPluginTree(src, dst) {
  const stat = fs.lstatSync(src)
  if (stat.isSymbolicLink()) {
    const e = new Error('源路径含符号链接，拒绝部署')
    e.code = 'SYMLINK_NOT_FOLLOWED'
    throw e
  }
  if (stat.isFile()) {
    fs.copyFileSync(src, dst)
    return
  }
  if (!stat.isDirectory()) {
    const e = new Error('不支持的文件类型')
    e.code = 'UNSUPPORTED_FILE_TYPE'
    throw e
  }
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.dsh-workspace.json') continue
    copyPluginTree(path.join(src, entry.name), path.join(dst, entry.name))
  }
}

export function createPluginRoutes({ authService, audit, env = process.env }) {
  const workspaceStore = createWorkspaceStore(resolveWorkspacesRoot(env))
  const pluginRoot = resolvePluginDir(env)
  const routes = []

  function authRoute(method, pattern, handler) {
    routes.push({ method, pattern, handler, auth: true })
  }

  authRoute('GET', '/api/plugins', (req, res) => {
    if (!fs.existsSync(pluginRoot)) {
      return json(res, 200, { ok: true, plugins: [], pluginDir: pluginRoot, exists: false })
    }
    const entries = fs.readdirSync(pluginRoot, { withFileTypes: true })
    const plugins = []
    for (const e of entries) {
      // @local 下插件多以 junction/symlink 形式装配：Dirent.isDirectory() 对链接返回 false，
      // 必须同时接受 isSymbolicLink()；node_modules 是宿主包链接目录，不是插件。
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      if (e.name === 'node_modules') continue
      if (e.name.startsWith('.')) continue // 跳过隐藏目录（.ignored_* 等）
      const dir = path.join(pluginRoot, e.name)
      const meta = readPluginMeta(dir)
      plugins.push({
        name: e.name,
        dirName: e.name,
        version: meta ? meta.version : null,
        description: meta ? meta.description : '',
        hasPatch: hasPatchFile(dir),
        isPublished: isGitRepo(dir),
      })
    }
    json(res, 200, { ok: true, plugins, pluginDir: pluginRoot, exists: true })
  })

  authRoute('GET', '/api/plugins/:name', (req, res) => {
    const pluginDir = resolvePluginPath(pluginRoot, req.params.name)
    if (!pluginDir) {
      return err(res, 400, 'BAD_REQUEST', '非法插件名称')
    }
    if (!fs.existsSync(pluginDir)) {
      return err(res, 404, 'NOT_FOUND', `插件 ${req.params.name} 不存在`)
    }
    const meta = readPluginMeta(pluginDir)
    if (!meta) {
      return err(res, 404, 'NOT_FOUND', `插件 ${req.params.name} 缺少 package.json`)
    }
    json(res, 200, {
      ok: true,
      plugin: {
        name: req.params.name,
        version: meta.version,
        description: meta.description,
        hasPatch: hasPatchFile(pluginDir),
        isPublished: isGitRepo(pluginDir),
        files: listTopLevel(pluginDir),
      },
      pluginDir,
    })
  })

  authRoute('POST', '/api/plugins/:name/publish', async (req, res) => {
    const log = (event, fields) => audit.log(`plugin.${event}`, { userId: req.user.id, plugin: req.params.name, ...fields })
    try {
      // 1. 校验绑定
      const binding = authService.getGithubBinding(req.user.id)
      if (!binding) {
        return err(res, 400, 'GITHUB_NOT_BOUND', '请先绑定 GitHub Token（PUT /api/auth/me/github）')
      }
      // 2. 校验插件目录
      const pluginDir = resolvePluginPath(pluginRoot, req.params.name)
      if (!pluginDir) {
        return err(res, 400, 'BAD_REQUEST', '非法插件名称')
      }
      if (!fs.existsSync(pluginDir)) {
        return err(res, 404, 'NOT_FOUND', `插件 ${req.params.name} 不存在`)
      }
      const meta = readPluginMeta(pluginDir)
      if (!meta) {
        return err(res, 400, 'BAD_REQUEST', `插件 ${req.params.name} 缺少 package.json`)
      }
      // 3. 解析请求参数
      const body = await readBody(req)
      const repoName = sanitizeRepoName(body.repoName || `dsh-plugin-${req.params.name}`)
      if (!repoName) {
        return err(res, 400, 'BAD_REQUEST', '仓库名称无效')
      }
      const description = body.description || `DSH 插件: ${meta.description || req.params.name}`
      const isPrivate = body.isPrivate !== false // 默认私有
      const commitMessage = body.commitMessage || `Initial commit: ${req.params.name} plugin`
      // 4. 创建远程仓库
      let repo
      try {
        repo = await createRepo({ token: binding.token, name: repoName, description, isPrivate })
      } catch (e) {
        log('publish.repo-failed', { repoName, error: e.message })
        return err(res, e.status === 422 ? 409 : 502, e.code || 'GITHUB_API_ERROR', e.message)
      }
      // 5. 本地 git 操作
      try {
        if (!isGitRepo(pluginDir)) initRepo(pluginDir, repo.defaultBranch)
        setIdentity(pluginDir, binding.login, `${binding.login}@users.noreply.github.com`)
        // 写 .gitignore（已存在则覆盖，确保规则一致）
        fs.writeFileSync(path.join(pluginDir, '.gitignore'), GITIGNORE_CONTENT, 'utf8')
        addAll(pluginDir)
        commit(pluginDir, commitMessage)
        // 临时使用带 token 的 URL 进行 push
        const authUrl = buildAuthUrl(repo.owner, repo.name, binding.token)
        const cleanUrl = buildCleanUrl(repo.owner, repo.name)
        addRemote(pluginDir, 'origin', authUrl)
        pushUpstream(pluginDir, 'origin', 'HEAD', repo.defaultBranch)
        // 推送成功后把 remote 改回干净 URL（避免 token 泄漏到 .git/config）
        setRemoteUrl(pluginDir, 'origin', cleanUrl)
      } catch (e) {
        log('publish.git-failed', { repoName, error: e.message, stderr: (e.stderr || '').slice(0, 500) })
        return err(res, 500, 'GIT_OPERATION_FAILED', `Git 操作失败: ${e.message}`)
      }
      log('publish.success', { repoName, htmlUrl: repo.htmlUrl })
      json(res, 201, {
        ok: true,
        plugin: req.params.name,
        repo: {
          name: repo.name,
          fullName: repo.fullName,
          owner: repo.owner,
          htmlUrl: repo.htmlUrl,
          cloneUrl: repo.cloneUrl,
          defaultBranch: repo.defaultBranch,
          private: repo.private,
        },
      })
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        return err(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大')
      }
      log('publish.error', { error: e.message })
      err(res, 500, 'INTERNAL_ERROR', e.message)
    }
  })

  authRoute('POST', '/api/plugins/:name/deploy', async (req, res) => {
    try {
      const name = req.params.name
      if (!isValidPluginName(name)) {
        return err(res, 400, 'BAD_REQUEST', '非法插件名称')
      }
      const body = await readBody(req)
      const workspaceId = body.workspaceId
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return err(res, 400, 'BAD_REQUEST', 'workspaceId 必填')
      }
      if (!isValidWorkspaceId(workspaceId)) {
        return err(res, 400, 'INVALID_WORKSPACE_ID', '非法工作区 ID')
      }
      const found = workspaceStore.findWorkspaceOwner(workspaceId)
      if (!found) {
        return err(res, 404, 'WORKSPACE_NOT_FOUND', '工作区不存在')
      }
      if (found.userId !== req.user.id) {
        audit.log('workspace.access_denied', {
          userId: req.user.id, workspaceId, ownerId: found.userId,
        })
        return err(res, 403, 'FORBIDDEN_WORKSPACE', '无权访问该工作区')
      }

      let srcDir
      try {
        srcDir = safeResolve(
          workspaceStore.workspaceDir(req.user.id, workspaceId),
          typeof body.path === 'string' ? body.path : ''
        )
      } catch (e) {
        if (e.code === 'PATH_TRAVERSAL_DETECTED') {
          return err(res, 400, 'PATH_TRAVERSAL_DETECTED', '检测到路径遍历尝试')
        }
        throw e
      }

      let srcStat
      try {
        srcStat = fs.lstatSync(srcDir)
      } catch {
        return err(res, 404, 'PATH_NOT_FOUND', '源路径不存在')
      }
      if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
        return err(res, 404, 'PATH_NOT_FOUND', '源路径不是有效目录')
      }
      if (!fs.existsSync(path.join(srcDir, 'package.json'))) {
        return err(res, 400, 'BAD_REQUEST', '源目录缺少 package.json，不是可部署插件')
      }

      const targetDir = path.join(pluginRoot, name)
      const targetExisting = fs.lstatSync(targetDir, { throwIfNoEntry: false })
      if (targetExisting && targetExisting.isSymbolicLink()) {
        return err(res, 409, 'TARGET_IS_LINK', '目标已被符号链接/junction 占用，拒绝写穿；请先在服务器解除该链接')
      }

      try {
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true })
        copyPluginTree(srcDir, targetDir)
      } catch (e) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch {}
        if (e.code === 'SYMLINK_NOT_FOLLOWED') {
          return err(res, 400, 'SYMLINK_NOT_FOLLOWED', '源目录含符号链接，拒绝部署')
        }
        return err(res, 500, 'DEPLOY_FAILED', `插件部署失败: ${e.message}`)
      }

      audit.log('workspace.plugin_deploy', {
        userId: req.user.id, plugin: name, workspaceId,
        path: typeof body.path === 'string' ? body.path : '',
      })
      json(res, 200, {
        ok: true,
        name,
        deployedAt: new Date().toISOString(),
        requiresRestart: true,
      })
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        return err(res, 413, 'PAYLOAD_TOO_LARGE', '请求体过大')
      }
      err(res, 500, 'INTERNAL_ERROR', e.message)
    }
  })

  function match(req) {
    const method = req.method
    const url = req.url
    for (const r of routes) {
      if (r.method !== method) continue
      const params = matchPath(r.pattern, url)
      if (params) return { ...r, params }
    }
    return null
  }

  return {
    match,
    isPluginRoute(url) {
      const urlPath = url.split('?')[0]
      return urlPath === '/api/plugins' || urlPath.startsWith('/api/plugins/')
    },
  }
}
