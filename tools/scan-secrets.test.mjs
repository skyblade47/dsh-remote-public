// tools/scan-secrets.mjs 的自测。
//
// 重点不在"能扫出密钥"，而在两条**容易做不到**的性质：
//   ① 🔴 **输出绝不泄漏值** —— 连前 12 个字符都不许出现；
//   ② 有命中时**退出码必须非零**（否则闸门形同虚设）。
// 外加一条真实处境的回归：**文件已从工作树删掉、但密钥仍在历史里**（= `email-bridge` 的处境）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(new URL('./scan-secrets.mjs', import.meta.url))

function mkRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scan-secrets-'))
  execFileSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' })
  return dir
}

function plant(dir, rel, content, { commit = false } = {}) {
  const p = path.join(dir, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, content)
  execFileSync('git', ['-C', dir, 'add', '--', rel], { encoding: 'utf8' })
  if (commit) {
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'plant'],
      { encoding: 'utf8' }
    )
  }
}

function removeAndCommit(dir, rel) {
  execFileSync('git', ['-C', dir, 'rm', '-q', '--', rel], { encoding: 'utf8' })
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'remove'],
    { encoding: 'utf8' }
  )
}

function runTool(dir, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, `--root=${dir}`, ...extra], { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// 断言"值本身、以及它的前 12 个字符"都没出现在输出里
function assertNoLeak(out, secret) {
  assert.ok(!out.includes(secret), '输出泄漏了完整的值')
  assert.ok(!out.includes(secret.slice(0, 12)), '输出泄漏了值的前 12 个字符')
}

test('干净仓库 → 退出码 0', () => {
  const dir = mkRepo()
  try {
    plant(dir, 'src/a.js', 'export const hello = 1\n')
    const { code, out } = runTool(dir)
    assert.equal(code, 0, out)
    assert.match(out, /PASS 无命中/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('植入凭据 → 退出码 1，且输出不泄漏', () => {
  const dir = mkRepo()
  const secret = 'Sup3rS3cretAuthCode16'
  try {
    plant(dir, 'src/conf.js', `const cfg = { pass: '${secret}' }\nexport default cfg\n`)
    const { code, out } = runTool(dir)
    assert.equal(code, 1, '有命中必须非零退出；否则闸门失效')
    assert.match(out, /S7/, '应命中 S7 规则')
    assertNoLeak(out, secret)
    assert.match(out, /len=21/, '应给出值的长度指纹，替代回显')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('占位符与合成串 → 不算命中（避免闸门永远红）', () => {
  const dir = mkRepo()
  try {
    plant(dir, 'src/a.js', "const pass = 'your_password_here'\n")
    plant(dir, 'src/b.js', "const token = 'xxxxxxxxxxxxxxxxxxxx'\n")
    plant(dir, 'src/c.js', "const secret = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL'\n")
    const { code, out } = runTool(dir)
    assert.equal(code, 0, out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('前缀形态密钥（sk- / ghp_ / AKIA）→ 命中且不泄漏', () => {
  const dir = mkRepo()
  const sk = 'sk-' + 'A'.repeat(24)
  try {
    plant(dir, 'src/a.js', `export const k = '${sk}'\n`)
    plant(dir, 'src/b.js', `export const g = 'ghp_${'b'.repeat(24)}'\n`)
    plant(dir, 'src/c.js', 'export const a = "AKIAIOSFODNN7EXAMPLE"\n')
    const { code, out } = runTool(dir)
    assert.equal(code, 1, out)
    assertNoLeak(out, sk)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('🔴 回归：值已从工作树删除、但仍在历史里 —— 工作树干净、--history 报出（email-bridge 的处境）', () => {
  const dir = mkRepo()
  const secret = 'Hist0ryOnlyAuthCode'
  try {
    plant(dir, 'plugins/x/lib/index.js', `const pass = '${secret}'\n`, { commit: true })
    removeAndCommit(dir, 'plugins/x/lib/index.js')

    const tree = runTool(dir)
    assert.equal(tree.code, 0, '工作树此时应当干净')

    const hist = runTool(dir, ['--history'])
    assert.equal(hist.code, 1, '历史里应当扫得出来')
    assert.match(hist.out, /plugins\/x\/lib\/index\.js/, '应点名文件')
    assertNoLeak(hist.out, secret)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--json：可解析，且同样不泄漏', () => {
  const dir = mkRepo()
  const secret = 'JsonLeakCheckAuthCode'
  try {
    plant(dir, 'src/a.js', `const password = '${secret}'\n`)
    const { code, out } = runTool(dir, ['--json'])
    assert.equal(code, 1)
    assertNoLeak(out, secret)
    const j = JSON.parse(out)
    assert.equal(j.hits.length, 1)
    assert.equal(j.hits[0].rule, 'S7')
    assert.equal(j.hits[0].key, 'password')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未知选项 → 退出码 2（用法错误与"有命中"必须区分）', () => {
  const dir = mkRepo()
  try {
    const { code, out } = runTool(dir, ['--bogus'])
    assert.equal(code, 2, out)
    assert.match(out, /用法/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 以下四条钉住"分层判据"（否则闸门会永远红，等于失效）----

test('测试/文档路径里的「键=长字面量」→ 只提示、不计失败', () => {
  const dir = mkRepo()
  try {
    plant(dir, 'server/gateway/tests/auth.test.js', "const password = 'TestFixturePass123'\n")
    plant(dir, 'docs/notes.md', "示例：token = 'SomeDocExampleValue'\n")
    const { code, out } = runTool(dir)
    assert.equal(code, 0, out)
    assert.match(out, /测试\/文档路径，不计失败/)
    assert.match(out, /提示 \d+ 处/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('🔴 A 层形态在测试路径里**仍然失败**（分层不得把不可误认的密钥一并放过）', () => {
  const dir = mkRepo()
  try {
    plant(dir, 'server/gateway/tests/auth.test.js', `const k = 'sk-${'Z'.repeat(20)}Xq7'\n`)
    const { code } = runTool(dir)
    assert.equal(code, 1, 'sk- 形态即便在测试文件里也应失败')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('代码片段而非字面量 → 不算命中（模板串 / shell 取值）', () => {
  const dir = mkRepo()
  try {
    plant(dir, 'server/gateway/src/github.js', 'Authorization: `Bearer ${token}`,\n')
    plant(dir, 'deploy/x.sh', 'TOKEN="$(grep -o x "$F" | head -1 | cut -d= -f2)"\n')
    const { code, out } = runTool(dir)
    assert.equal(code, 0, out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('含空白的值 → 不算命中；secret-scan-exempt 标记 → 跳过并单独计数', () => {
  const dir = mkRepo()
  try {
    plant(dir, 'src/a.js', "const password = 'two words here'\n")
    plant(dir, 'src/b.js', "const password = 'RealLookingPassword1' // secret-scan-exempt: 公开演示账号\n")
    const { code, out } = runTool(dir)
    assert.equal(code, 0, out)
    assert.match(out, /人工豁免 1 处/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
