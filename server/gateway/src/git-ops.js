// Git 操作：init / add / commit / remote / push。
// 使用 node:child_process.spawnSync 直接调用 git，避免命令行转义问题。
// 禁用交互式提示，token 仅在 push URL 中临时使用，最终回写为干净 URL。
import { spawnSync } from 'node:child_process'

export function gitVersion() {
  try {
    const out = spawnSync('git', ['--version'], { encoding: 'utf8' })
    return out.status === 0 ? out.stdout.trim() : null
  } catch {
    return null
  }
}

function runGit(args, opts = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: opts.env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    const e = new Error(`git ${args.join(' ')} 失败: ${(result.stderr || result.stdout || '').trim()}`)
    e.stderr = result.stderr
    e.stdout = result.stdout
    e.status = result.status
    throw e
  }
  return (result.stdout || '').trim()
}

export function isGitRepo(dir) {
  try {
    const out = runGit(['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    return out === 'true'
  } catch {
    return false
  }
}

export function getCurrentBranch(dir) {
  try {
    return runGit(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return null
  }
}

export function initRepo(dir, branch = 'main') {
  runGit(['-C', dir, 'init', '-b', branch])
}

export function setIdentity(dir, name, email) {
  if (name) runGit(['-C', dir, 'config', 'user.name', name])
  if (email) runGit(['-C', dir, 'config', 'user.email', email])
}

export function addAll(dir) {
  runGit(['-C', dir, 'add', '-A'])
}

export function commit(dir, message) {
  try {
    runGit(['-C', dir, 'commit', '-m', message])
    return true
  } catch (e) {
    // git commit 在无变更时把 "nothing to commit" 输出到 stdout 而非 stderr
    const out = `${e.stderr || ''}\n${e.stdout || ''}`
    if (/nothing to commit|no changes added/.test(out)) return false
    throw e
  }
}

export function addRemote(dir, name, url) {
  try { runGit(['-C', dir, 'remote', 'remove', name]) } catch {}
  runGit(['-C', dir, 'remote', 'add', name, url])
}

export function setRemoteUrl(dir, name, url) {
  runGit(['-C', dir, 'remote', 'set-url', name, url])
}

export function pushUpstream(dir, remoteName, localRef, remoteBranch) {
  runGit(['-C', dir, 'push', '-u', remoteName, `${localRef}:${remoteBranch}`], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'false' },
  })
}

export function buildAuthUrl(owner, repo, token) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
}

export function buildCleanUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`
}
