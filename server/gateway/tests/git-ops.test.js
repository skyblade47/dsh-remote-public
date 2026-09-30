import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  gitVersion,
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
} from '../src/git-ops.js'

const hasGit = gitVersion() !== null

test('gitVersion 返回字符串', () => {
  // 在测试机器上应已安装 git
  assert.equal(typeof gitVersion(), 'string')
})

test('isGitRepo 在非 git 目录返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-nogit-'))
  assert.equal(isGitRepo(dir), false)
})

test('isGitRepo 在 git init 后返回 true', { skip: !hasGit }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-init-'))
  initRepo(dir, 'main')
  assert.equal(isGitRepo(dir), true)
})

test('init + add + commit 完成首次提交', { skip: !hasGit }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-commit-'))
  initRepo(dir, 'main')
  setIdentity(dir, 'tester', 'tester@example.com')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  addAll(dir)
  const committed = commit(dir, 'initial')
  assert.equal(committed, true)
})

test('commit 无变更返回 false', { skip: !hasGit }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-empty-'))
  initRepo(dir, 'main')
  setIdentity(dir, 'tester', 'tester@example.com')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  addAll(dir)
  commit(dir, 'first')
  // 再次提交无变更
  addAll(dir)
  const result = commit(dir, 'no-change')
  assert.equal(result, false)
})

test('addRemote + setRemoteUrl + pushUpstream 可调用', { skip: !hasGit }, () => {
  // 仅验证函数可调用且不抛错（不真正 push）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitops-remote-'))
  initRepo(dir, 'main')
  setIdentity(dir, 'tester', 'tester@example.com')
  addRemote(dir, 'origin', 'https://github.com/example/repo.git')
  // 修改为干净 URL 不应报错
  setRemoteUrl(dir, 'origin', 'https://github.com/example/repo.git')
  // pushUpstream 不实际执行（没有真实 token），只验证函数签名存在
  assert.equal(typeof pushUpstream, 'function')
})

test('buildAuthUrl 包含 token', () => {
  const url = buildAuthUrl('octocat', 'my-plugin', 'ghp_secret')
  assert.match(url, /x-access-token:ghp_secret@github\.com\/octocat\/my-plugin\.git/)
})

test('buildCleanUrl 不含 token', () => {
  const url = buildCleanUrl('octocat', 'my-plugin')
  assert.equal(url, 'https://github.com/octocat/my-plugin.git')
  assert.doesNotMatch(url, /token|ghp_/)
})
