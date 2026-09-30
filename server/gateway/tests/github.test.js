import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getUserInfo,
  createRepo,
  getRepo,
  _setRequesterForTesting,
  _resetRequesterForTesting,
} from '../src/github.js'

function makeRequester(handler) {
  return (opts, payload) => Promise.resolve(handler(opts, payload))
}

test('getUserInfo 成功：返回 login/name', async () => {
  _setRequesterForTesting(makeRequester(() => ({
    status: 200,
    body: { login: 'octocat', id: 1, name: 'Octo Cat', avatar_url: 'https://x', html_url: 'https://github.com/octocat' },
  })))
  try {
    const info = await getUserInfo('ghp_test')
    assert.equal(info.login, 'octocat')
    assert.equal(info.name, 'Octo Cat')
    assert.equal(info.avatarUrl, 'https://x')
    assert.equal(info.htmlUrl, 'https://github.com/octocat')
  } finally {
    _resetRequesterForTesting()
  }
})

test('getUserInfo 401：抛 GITHUB_UNAUTHORIZED', async () => {
  _setRequesterForTesting(makeRequester(() => ({
    status: 401,
    body: { message: 'Bad credentials' },
  })))
  try {
    await assert.rejects(() => getUserInfo('ghp_invalid'), (e) => {
      assert.equal(e.code, 'GITHUB_UNAUTHORIZED')
      assert.equal(e.status, 401)
      return true
    })
  } finally {
    _resetRequesterForTesting()
  }
})

test('createRepo 成功：返回仓库信息', async () => {
  _setRequesterForTesting(makeRequester((opts, payload) => {
    assert.equal(opts.method, 'POST')
    assert.equal(opts.path, '/user/repos')
    const body = JSON.parse(payload)
    assert.equal(body.name, 'dsh-plugin-taskkit')
    assert.equal(body.private, true)
    return {
      status: 201,
      body: {
        id: 42,
        name: 'dsh-plugin-taskkit',
        full_name: 'octocat/dsh-plugin-taskkit',
        owner: { login: 'octocat' },
        clone_url: 'https://github.com/octocat/dsh-plugin-taskkit.git',
        ssh_url: 'git@github.com:octocat/dsh-plugin-taskkit.git',
        html_url: 'https://github.com/octocat/dsh-plugin-taskkit',
        default_branch: 'main',
        private: true,
      },
    }
  }))
  try {
    const repo = await createRepo({ token: 'ghp_x', name: 'dsh-plugin-taskkit', isPrivate: true })
    assert.equal(repo.name, 'dsh-plugin-taskkit')
    assert.equal(repo.owner, 'octocat')
    assert.equal(repo.defaultBranch, 'main')
    assert.equal(repo.private, true)
  } finally {
    _resetRequesterForTesting()
  }
})

test('createRepo 422：抛 REPO_EXISTS_OR_INVALID', async () => {
  _setRequesterForTesting(makeRequester(() => ({
    status: 422,
    body: { message: 'Repository creation failed', errors: [{ code: 'custom', resource: 'Repository' }] },
  })))
  try {
    await assert.rejects(() => createRepo({ token: 'ghp_x', name: 'exists' }), (e) => {
      assert.equal(e.code, 'REPO_EXISTS_OR_INVALID')
      assert.equal(e.status, 422)
      assert.ok(Array.isArray(e.errors))
      return true
    })
  } finally {
    _resetRequesterForTesting()
  }
})

test('createRepo 默认私有 + 默认不 autoInit', async () => {
  _setRequesterForTesting(makeRequester((opts, payload) => {
    const body = JSON.parse(payload)
    assert.equal(body.private, true)
    assert.equal(body.auto_init, false)
    return { status: 201, body: { name: body.name, owner: { login: 'octo' }, default_branch: 'main', private: true } }
  }))
  try {
    await createRepo({ token: 'ghp', name: 'test' })
  } finally {
    _resetRequesterForTesting()
  }
})

test('getRepo 存在：返回对象', async () => {
  _setRequesterForTesting(makeRequester((opts) => {
    assert.equal(opts.method, 'GET')
    assert.equal(opts.path, '/repos/octocat/dsh-plugin-x')
    return { status: 200, body: { name: 'dsh-plugin-x', full_name: 'octocat/dsh-plugin-x', owner: { login: 'octocat' }, default_branch: 'main', private: true } }
  }))
  try {
    const repo = await getRepo({ token: 'ghp', owner: 'octocat', name: 'dsh-plugin-x' })
    assert.equal(repo.name, 'dsh-plugin-x')
    assert.equal(repo.owner, 'octocat')
  } finally {
    _resetRequesterForTesting()
  }
})

test('getRepo 不存在：返回 null', async () => {
  _setRequesterForTesting(makeRequester(() => ({ status: 404, body: { message: 'Not Found' } })))
  try {
    const repo = await getRepo({ token: 'ghp', owner: 'octocat', name: 'no-such' })
    assert.equal(repo, null)
  } finally {
    _resetRequesterForTesting()
  }
})
