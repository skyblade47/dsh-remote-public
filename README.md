# dsh-remote（服务端 / 网关）

把本地 **DeepSeek Harness（DSH）** 内核改造成「服务端常驻 + 多终端接入」：
DSH 内核跑在一台常开的机器上，网关在其前面提供认证、多用户隔离、工作区读写、
TLS/mTLS 与审计，用户从浏览器（后续含安卓端）随时随地接入自己的环境。

纯 Node.js、**零运行时依赖**、**零数据库**（全部落文件）。

## 关联仓库

本项目是**服务端**。终端客户端已拆分为独立仓库，各自独立发版：

| 角色 | 仓库 | 说明 |
|---|---|---|
| **服务端（网关）** | `https://github.com/skyblade47/dsh-remote-public.git` | 本仓库。DSH 内核前置网关 + 部署脚本 + 服务端测试 |
| **终端客户端（Web）** | `https://github.com/skyblade47/dsh-remote-client.git` | Web 客户端（`web/`）。网关以静态资源方式托管在 `/app`、`/auth/login`。**本仓库不保存其源码副本**，用 `tools/fetch-client.ps1` 拉取 |
| 安卓客户端（规划中） | `skyblade47/dsh-remote-android`（待建） | 计划独立建仓：WebView 壳 + `onReceivedClientCertRequest` 回调提供客户端证书，绕开浏览器对客户端证书支持不稳的问题 |
| 桌面外壳（本地版，独立线） | `https://github.com/skyblade47/deepseek-harness-shell.git` | 本地 DSH 外壳工程（`dsh-desktop`、插件沙箱、运维工具链）。**与本项目互不混淆**，不参与服务端部署 |

三条线的接合方式：

```
dsh-remote-client (Web / 安卓)  ──HTTPS + Cookie +（可选）客户端证书──▶  dsh-remote（网关） ──▶ 本机 DSH 内核 :3080
        deepseek-harness-shell  是本地桌面外壳，与本链条并列，不接入上面这条链路
```

## 目录结构

```
client/               客户端静态资源目录（.gitignore，由 tools/fetch-client.ps1 拉取）
server/
  gateway/src/        网关源码（认证、代理、工作区、插件、TLS/mTLS、审计、会话归属）
  gateway/tests/      node:test 单测
  scripts/            setup.mjs / start.mjs / client-cert.mjs / session-migrate.mjs / 服务化脚本
  data/templates/     脱敏配置模板（settings.yaml、.credentials.yaml、agent presets）
plugins/              DSH 插件（@local/*），经 setup.mjs 链接进 profile
tools/                Windows 侧运维脚本（fetch-client / migrate-workspace / setup-wsl2）
```

## 快速开始（Windows）

```powershell
# 0) 前置：Node >= 22.19、pnpm、Git；DSH 内核可用（版本以 deploy/linux/setup.sh 的 DSH_VERSION 为准，现为 0.1.5-rc.3）

# 1) 拉取终端客户端（克隆到 <仓库根>\client，网关默认即在此读取）
.\tools\fetch-client.ps1

# 2) 装配运行时（链接插件、放置脱敏配置、pnpm install；幂等）
node server\scripts\setup.mjs --dsh-home <你的 DSH_HOME>

# 3) 启动（TLS + 固定 IP 直连；不加 --tls 则为明文 HTTP）
node server\scripts\start.mjs --dsh-home <你的 DSH_HOME> --tls --host 0.0.0.0 --tls-san <你的公网IP>
```

启动后入口为 `https://<主机>:8443/app`（TLS 时 8080 只做 301 跳转）。
自签证书首次访问需信任；**管理员的第一个账号**在系统内无任何账号时允许注册，
创建后注册口即按后台开关（默认关闭）执行。

### 客户端目录约定

网关按 `DSH_GATEWAY_WEB_DIR` 读取客户端静态资源；**留空则用仓库内 `client/web`**。
`client/` 已加入 `.gitignore`，不放源码副本，避免与服务端仓库出现两份不同步的客户端。

- 默认位置（推荐）：`tools/fetch-client.ps1` → `<仓库根>\client`，零配置可用；
- 放到别处：`tools/fetch-client.ps1 -Dest E:\web-client`，然后
  `node server\scripts\start.mjs --web-dir E:\web-client\web`（或设 `DSH_GATEWAY_WEB_DIR`）。

## 网关配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_GATEWAY_PORT` | `8080` | HTTP 端口；启用 TLS 后退化为 301 跳转口 |
| `DSH_GATEWAY_HTTPS_PORT` | `8443` | HTTPS 端口（`DSH_GATEWAY_TLS=1` 时生效） |
| `DSH_GATEWAY_TLS` | 关 | 启用 HTTPS；自签证书落在数据目录 `tls/`，SAN 变更会自动重签 |
| `DSH_GATEWAY_MTLS` | 关 | 启用客户端证书白名单（需同时开 TLS）；替代 IP 锁，适配家庭/出差 |
| `DSH_GATEWAY_TLS_SAN` | 空 | 追加到证书 SAN 的 IP/域名，逗号分隔（固定 IP 直连必填） |
| `DSH_GATEWAY_HOST` | `127.0.0.1` | 监听地址；云上对外直连置 `0.0.0.0` |
| `DSH_GATEWAY_WEB_DIR` | 空 | 客户端静态资源目录（`web/`）；留空用仓库内 `client/web` |
| `DSH_GATEWAY_UPSTREAM` | `http://127.0.0.1:3080` | 上游 DSH 内核地址，必须为回环 |

客户端证书管理：`node server\scripts\client-cert.mjs init|issue|list|revoke|pfx`。
白名单按证书指纹校验，并**每请求复核**（keep-alive 复用连接下吊销立即生效）。

## 与 DSH 内核的边界（硬约束）

**不改 DSH 原生主体。** 不 patch / sed / 覆盖内核安装目录（`<npmRoot>/@deepseek-ai/dsh/**`）下的任何文件，
也不改 `node_modules` 里的原生包。理由：DSH 一旦破坏性更新，所有改动都要重写，且升级即失效。
只走官方扩展位：`DSH_HOME/profiles/*`、`dsh.profile.bundles`、`dsh.bundle.patch`、
`ctx.provide/ctx.inject/ctx.get`、插件与 profile 配置。

**同一条约束适用于「依赖内核内部形状」**——只读消费不等于安全，升级一样要重写。
因此每个内核依赖（服务名、方法名、事件名、事件字段、日志事件类型、header 字段）都要先分级：

| 级别 | 判据 | 要求 |
|---|---|---|
| **发布面** | ① **包级/子路径**：出现在包 `exports` 里；② **实例成员**：该类是**主入口（`.`）类型声明里正式导出的类**，成员在其 `.d.ts` 中声明（如 `dsh-session` 的 `export declare class Session` 带 `snapshotEvents()`/`eventAt()`）；③ 或类型声明明说是给插件/宿主消费的（如 `dsh-subagent/lifecycle.d.ts` 把 `SubagentRunInfo`/`RunEndInfo` 标为 consumer-facing，同时明说 `ActivationObserver` "not something a plugin may depend on"） | 可直接用 |
| **内部形状** | 只能深路径摸到（如 `loader.store`——它连 cordis 服务都不是）、或类型声明归入 `./internal` / package-private | **必须收敛到一个可探测的适配层**，不允许散落在业务代码里；探不到时要有明确行为（降级到替代来源，或 **fail-closed**——报"未知"，绝不报"安全/可用"） |
| **未判定** | 拿不到正反证据（**服务被注册 ≠ 有稳定承诺**） | **按内部形状处理**，直到证明为发布面 |

> ⚠️ **判据②容易被漏掉，别把①当全部**：实例成员永远不会有自己的 `exports` 键，
> 所以"没在 exports 里 ⇒ 内部"是**错的**。2026-09-22 就因此一度把 `ctx.sessions` +
> 活会话对象误判为最高风险项，直到在主入口类型里查到 `export declare class Session` 才翻案。
>
> ⚠️ **两类依赖无法用存在性探针覆盖**（别假装能）：① 宿主**事件**（cordis 没有"枚举已注册事件名"
> 的接口）——缓解是事件名集中一处常量 + 运行期观察边沿是否真的到达；② `ctx` 上的**非服务属性**
> （如 `ctx.loader`）——缓解是多路兜底。详见 `compat.js` 顶部注释。
>
> ⚠️ 能力探针是**快照**：apply 期跑的那次可能因服务尚未挂载而报假缺口
> （实测 `route=lazy-pending(registry.inject(webServer))` 即此类）；`adapter.compat()` /
> `/adapter/api/status` 可**重跑**拿运行时真值。判缺口前先确认是不是启动时序假象。

登记处是唯一一处：`plugins/dsh-adapter/lib/compat.js` 的 `CAPABILITIES`
（存在性探针 + `severity` + `usedBy` + 缺失时的 `remedy`）。启动时会打一行摘要，升级前后一眼可比。

## 与第三方插件的边界（同一条理由）

**也不改第三方插件。** 需要什么功能，**宁可新增/修改自研插件（`@local/*`）**，
也不动 DSH 原生，也不动第三方 npm 插件。理由与上面完全相同：改了就会被上游更新冲掉。

本仓的第三方插件共 4 个（不入库，由 setup 脚本 npm 安装）：
`@nanmicoder/dsh-agent-teams`、`@huanlin/dsh-plugin-better-locale`、`dsh-better-sidebar`、`dshmarket`。
与它们打交道只有两种正规方式：

- **版本配套**：`plugins/dsh-adapter/compat-matrix.json` 记录"宿主版本 → 各第三方插件可用版本"，
  升级宿主时按表联动，不改它们的源码。
- **挂载方式**：经 `@local/dsh-adapter` 的 hotplug 白名单挂载（manifest 驱动、失败可控、状态可观测），
  而不是直接进 profile `bundles` —— 历史上 `agent-teams` 曾直接进 bundles 导致宿主启动失败。
  现状记录在 compat-matrix 的 `mountPolicy`。

本仓 `plugins/` 下的 13 个插件**全部是自研**（`@local/*`），可以自由改。

### 🔎 第三方"声明支持"的版本 ≠ 实际可用范围（2026-09-27 实测，**别记成 rc.1**）

**宿主内核现役 = `0.1.5-rc.3`**（唯一真源：`deploy/linux/setup.sh` 的 `DSH_VERSION`；服务器 `release.json` 记 `from = 0.1.5-rc.1`、`rollbackCount = 1`）。

⚠️ 但**第三方插件的声明上限仍停在 rc.1**：`@nanmicoder/dsh-agent-teams@0.1.20` 的 peer **精确枚举 `0.1.5-rc.1`**，
其 `compatibility.json` 亦写 `recommendedHost = 0.1.5-rc.1` ⇒ `version-radar` 会输出 `supported=false` / `verdict="需人工判定"`
（**这是它的设计预期，不是故障**）。

**实测结论：声明不满足 ≠ 挂不上。** 2026-09-27 首次真升级的**决定性判据** = 冒烟 A-5 **`loaded=15 failed=0`**，
即 **4 个第三方全部挂上**（`better-locale 0.4.1` / `agent-teams 0.1.20` / `better-sidebar 0.19.1` / `dshmarket 1.47.0`，版本未变）
⇒ 当时据此判定"**继续升 rc.3**"（与 `dshmarket` 早先"声明不匹配但实测可用"是**同一先例**）。
证据：首次真升级 SUMMARY §2。

⇒ **不要用"第三方共同支持的最高版本"当升级上限**（那会永远停在 rc.1）；判据用**冒烟实测**。两条硬规矩：

1. **版本 ⇄ 钉点成对**：改 `DSH_VERSION` 必须**同步**改 `NPM_BEFORE_DEFAULT`（rc.1 → `2026-09-10T12:00:00Z`；rc.3 → `2026-09-22T16:00:00Z`）。
   只改一个 ⇒ 要么 `ETARGET` 直接装不出来，要么装出"新内核 + 旧期传递依赖"的**混搭树**（⚠️ 探针还会全绿）。
2. **绝不用 `@latest`**：上游 `latest` = **rc.2**，而 rc.2 会让 `agent-teams` **落回不兼容线** ⇒ rc.3 是特意挑的那一版。

## 测试

```powershell
npm test        # node --test server/gateway/tests/*.test.js
```

## 部署

数据全部落文件（账号、会话归属、审计、TLS/客户端证书、日志），**无需数据库**。

### Linux（首版路径，最小插件集）

> 📖 **首次在新机器上部署（含云主机选型、Tailscale 接入、安全组/防火墙清单、故障排查）请看
> [deploy/linux/DEPLOY-MANUAL.md](deploy/linux/DEPLOY-MANUAL.md)** —— 下面是速览版。
>
> 两个配套脚本：`deploy/linux/tailscale-setup.sh`（接入落地）、`deploy/linux/check-ready.sh`（就绪探针，
> 部署完先跑它）。

```bash
# 0) 前置：Node >= 22.15、git、curl；仓库 clone 到 /opt/dsh-remote
sudo git clone <本仓库> /opt/dsh-remote

# 1) 一键装配（幂等，可反复重跑）
sudo bash /opt/dsh-remote/deploy/linux/setup.sh

# 2) 按需编辑 /etc/dsh-remote.env 放开网关项（TLS / 固定 IP / mTLS），然后
sudo systemctl enable --now dsh-kernel dsh-remote
```

`setup.sh` 会：校验/安装 Node 与内核 → 建服务用户与目录 → 落最小插件集
（`dsh-base` + `dsh-web-app` + `dsh-adapter` + `memory-system`）→ 生成 `/etc/dsh-remote.env`
→ 安装两个 systemd 单元（内核、网关各一，`Restart=always`）。它**不动** apt 源、防火墙与安全组，
也不自动 enable/start——先手动验证再开公网，步骤会打印在结尾。

> **别 clone 到 `/root` 等私有目录**：profile 里的 `@local/*` 是指向仓库的符号链接，
> 服务用户穿不过 `/root` 就读不到，内核只会报 `cannot resolve profile bundle`（完全不提权限）。
> 建议 `/opt/dsh-remote`。`setup.sh` 会提前检查并给出具体修法。

### Windows

`server/scripts/install-service.ps1`（NSSM 注册为服务，开机自启）。

### 其他

- 迁移与上云细节、Linux 专有的坑：见 Linux 迁移计划
- 其余 11 个自研插件仍依赖 Windows（`pwsh`、`taskkill`、`E:\DSH工作区` 等），要用它们需先做插件跨平台化。

## 文档

- 设计：服务端/客户端拆分、工作区服务端、更新机制、存储与 RAG 预留
- 计划：路线图、P2 客户端、Linux 迁移

## 与本地外壳的区别

`deepseek-harness-shell` 是**本地桌面外壳**（本机进程内跑 DSH），本项目是**服务端网关**
（把 DSH 变成可远程接入的服务）。**服务端现役内核 = `@deepseek-ai/dsh@0.1.5-rc.3`**
（唯一真源：`deploy/linux/setup.sh` 的 `DSH_VERSION`；本地外壳自带的内核随其安装包，**不要求两者一致**），
但代码与部署互不依赖，请勿混淆。
