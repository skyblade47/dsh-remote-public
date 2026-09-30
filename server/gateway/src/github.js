// GitHub REST API 客户端（零依赖，基于 node:https）。
// 提供两个核心能力：
//   1) getUserInfo(token) - 验证 token 并返回当前用户信息
//   2) createRepo({ token, name, description, isPrivate }) - 创建新仓库
import https from 'node:https'

const API_HOST = 'api.github.com'
const API_VERSION = '2022-11-28'

function ghHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'dsh-remote-gateway',
    'Content-Type': 'application/json',
    ...extra,
  }
}

function defaultRequester(opts, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let parsed = null
        if (data) {
          try { parsed = JSON.parse(data) } catch {}
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// 测试时可通过 _setRequesterForTesting 注入 mock requester
let _requester = null

export function _setRequesterForTesting(fn) {
  _requester = fn
}

export function _resetRequesterForTesting() {
  _requester = null
}

function request(method, path, token, body) {
  const payload = body ? JSON.stringify(body) : null
  const headers = ghHeaders(token, payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
  const opts = { method, host: API_HOST, path, headers }
  const requester = _requester || defaultRequester
  return requester(opts, payload)
}

export async function getUserInfo(token) {
  const res = await request('GET', '/user', token)
  if (res.status === 200 && res.body) {
    return {
      login: res.body.login,
      id: res.body.id,
      name: res.body.name,
      avatarUrl: res.body.avatar_url,
      htmlUrl: res.body.html_url,
    }
  }
  const msg = (res.body && res.body.message) || `HTTP ${res.status}`
  const code = res.status === 401 ? 'GITHUB_UNAUTHORIZED' : 'GITHUB_API_ERROR'
  throw Object.assign(new Error(`GitHub 鉴权失败: ${msg}`), { code, status: res.status })
}

export async function getRepo({ token, owner, name }) {
  // 查询仓库是否存在。存在返回 { ... }, 不存在返回 null。
  const res = await request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token)
  if (res.status === 200 && res.body) {
    return {
      id: res.body.id,
      name: res.body.name,
      fullName: res.body.full_name,
      owner: res.body.owner && res.body.owner.login,
      cloneUrl: res.body.clone_url,
      sshUrl: res.body.ssh_url,
      htmlUrl: res.body.html_url,
      defaultBranch: res.body.default_branch || 'main',
      private: res.body.private,
    }
  }
  if (res.status === 404) return null
  const msg = (res.body && res.body.message) || `HTTP ${res.status}`
  throw Object.assign(new Error(`GitHub 查询仓库失败: ${msg}`), { code: 'GITHUB_API_ERROR', status: res.status })
}

export async function createRepo({ token, name, description, isPrivate = true, autoInit = false }) {
  const res = await request('POST', '/user/repos', token, {
    name,
    description,
    private: isPrivate,
    auto_init: autoInit,
  })
  if (res.status === 201 && res.body) {
    return {
      id: res.body.id,
      name: res.body.name,
      fullName: res.body.full_name,
      owner: res.body.owner && res.body.owner.login,
      cloneUrl: res.body.clone_url,
      sshUrl: res.body.ssh_url,
      htmlUrl: res.body.html_url,
      defaultBranch: res.body.default_branch || 'main',
      private: res.body.private,
    }
  }
  if (res.status === 422) {
    const msg = (res.body && res.body.message) || '仓库已存在或名称非法'
    const errors = res.body && res.body.errors
    throw Object.assign(new Error(`GitHub 创建失败: ${msg}`), {
      code: 'REPO_EXISTS_OR_INVALID',
      status: 422,
      errors,
    })
  }
  const msg = (res.body && res.body.message) || `HTTP ${res.status}`
  throw Object.assign(new Error(`GitHub 创建仓库失败: ${msg}`), {
    code: 'GITHUB_API_ERROR',
    status: res.status,
  })
}
