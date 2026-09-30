// @local/writing-coach —— 平台相关路径推导（2026-09-22 Linux 化）
//
// 单独成文件的原因（不只是整洁）：
//   `lib/index.js` 顶部 `import { defineTool } from '@deepseek-ai/dsh-tools'`，
//   而该包只在**宿主环境**里可解析（仓库内没有 node_modules）⇒ 仓内自检无法 import index.js。
//   把路径推导隔离到这里（只依赖 node:path / node:fs），自检才能**真断言**两平台的推导结果，
//   而不是"看代码觉得对"。见 tools/check-linux-ready.mjs。
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * 凭据文件（.credentials.yaml）的绝对路径。
 *
 * 背景：原实现写死 `E:/DeepSeek-Harness-1.0.0-portable/dsh-data/.credentials.yaml`，
 * 在 Linux 上**必然读不到**，后果是 AI 深审层静默退化成两层——功能看着正常，只是少了最强的一层。
 * 这是"静默失效"的典型：没有报错，只是结果变差，很难被发现。
 *
 * 优先级：DSH_CREDENTIALS_FILE 显式覆盖 → <DSH_HOME>/.credentials.yaml
 * 回退链与 adapter 的 resolveDshHome 同口径：DSH_HOME → <cwd>/dsh-data（存在时）→ <APPDATA>/dsh/dsh-data。
 *
 * @param {object} env      环境变量（默认 process.env；可注入以便自检）
 * @param {string} cwdPath  工作目录（默认 process.cwd()；可注入以便自检）
 * @param {Function} existsFn 存在性判定（默认 node:fs 的 existsSync；可注入以便自检）
 */
export function resolveCredentialsPath(env, cwdPath, existsFn) {
  const e = env || process.env
  const exists = typeof existsFn === 'function' ? existsFn : existsSync
  const base = cwdPath || process.cwd()
  const explicit = String(e.DSH_CREDENTIALS_FILE || '').trim()
  if (explicit) return explicit
  let home = String(e.DSH_HOME || '').trim()
  if (!home) {
    try {
      const p = join(base, 'dsh-data')
      if (exists(p)) home = p
    } catch (_) { /* 取 cwd 失败则继续往下推 */ }
  }
  if (!home) {
    const appdata = String(e.APPDATA || '').trim()
    home = appdata ? join(appdata, 'dsh', 'dsh-data') : join(base, 'dsh-data')
  }
  return join(home, '.credentials.yaml')
}
