# DSH 服务器版 —— 内网部署手册（P5）

> 目标读者：**你自己**（或未来的运维者），在一台**新买的云主机**上从零把 DSH 服务器版跑起来。
> 按本手册从头执行应能到达"**浏览器打开就能登录进自己的对话**"。
>
> ⚠️ **本手册的状态**：命令与配置项均取自本仓库的真实实现（`deploy/linux/*`、`server/gateway/src/config.js`、
> `server/scripts/*`），**脚本语法与就绪探针已在 WSL 上跑通**；但**没有在真实云主机上端到端执行过**
> （原因：编制时手上没有云主机）。凡未能验证的地方在 **§14** 单独列出 —— **不要把它当成"已验证"**。
>
> 💰 **选型与价格见 §2**：只引用厂商**官方**页面；已按"个人实名 / 企业实名 / 0 元自托管"分三种情况给出建议。

---

## 1. 目标架构（先看懂这张图，后面每一步都为它服务）

```
       你的电脑 / 手机
            │  ① 先加入同一个 Tailscale 网络（WireGuard 加密 + 设备身份）
            ▼
   ┌─────────────────────────── 云主机（阿里云 ECS）───────────────────────────┐
   │                                                                          │
   │   tailscale0 接口（100.x.y.z）                                            │
   │        │                                                                 │
   │        ▼                                                                 │
   │   dsh-remote.service   网关 = 鉴权 + 限速 + 静态客户端 + 反向代理           │
   │        │  DSH_GATEWAY_HOST=0.0.0.0  DSH_GATEWAY_PORT=8080                │
   │        │  ② 这里是**唯一**对外的入口（账号/Token 鉴权在这一层）             │
   │        ▼                                                                 │
   │   dsh-kernel.service   内核 = dsh web --port 3080                        │
   │        ▲  只监听 127.0.0.1（**零入站鉴权，绝不能对外暴露**）                │
   │        └── 会话日志 / 插件 / 工作区都在 /srv 下                            │
   └──────────────────────────────────────────────────────────────────────────┘
```

两条**不可违反**的红线（实现里已如此设计，部署时别破坏它）：

1. **内核只许监听回环**（`dsh-kernel.service` 里写死 `--port 3080 --no-open`，不带 `--host`）。
   它自身**没有任何入站鉴权**，一旦暴露到公网等于把服务器交出去。
2. **对外只暴露网关**。安全组**不要**开放 3080；8080 也不要开给公网（只经 tailnet 访问）。

**为什么用 Tailscale 而不是域名+TLS**：网关自带 `DSH_GATEWAY_TLS` / `DSH_GATEWAY_MTLS` 两条路，
但 **P1 遗留的 mTLS 真机登录至今未验**（见 §12）。Tailscale 直接提供
"传输加密 + 设备级准入"，于是可以**走纯 HTTP、把这套未验证的 TLS/mTLS 绕开**；
应用层鉴权（账号/Token，P1 已实现）照旧生效。少一个未验环节，也少一份证书运维。

---

## 2. 云主机选型与价格（只引**官方**页面）

> ⚠️ **本节只引用厂商官方页面**（产品页 / 活动页 / 帮助中心），不引第三方博客或推广文 ——
> 后者常把"活动价/新用户价"写成常年价，且资格条件（个人 vs 企业实名）经常漏写。
> 但**官方活动也在变**，下单前**必须以下单页当时显示的资格与价格为准**。

### 2.1 结论：三种情况，三条路

| 你的情况 | 建议 | 参考价 |
|---|---|---|
| **想花 0 元** | 跑在**家里已有的机器**上（旧笔记本 / 迷你主机 / NAS，甚至现在跑 WSL 的这台 PC）+ Tailscale | ¥0（电费约 ¥30–60/年） |
| **个人实名（最常见）** | **腾讯云轻量 2核4G5M / 60G**（官方活动页，个人专享） | **约 ¥188/年** |
| **个人实名、要"锁价不涨价"** | **阿里云 99 计划 · 经济型 e 实例 2核2G / 40G**（官方页写"不限人群"） | ¥99/年，续费同价 |
| **有企业实名认证** | **阿里云 99 计划 · 通用算力型 u1 2核4G / 80G**（官方页写"**企业**新老用户同享"） | ¥199/年，续费同价 |

**关键提醒（我曾写错，此处更正）**：阿里云那台 **199 元的 u1（2核4G/80G）需要「企业实名认证」**，
个人实名账号**买不到**（官方活动页原文是"企业新老用户同享"）。个人用户请走腾讯云 188 那档或阿里 99 那档。

**✅ 本项目已选定（2026-09-23）**：**阿里云 99 计划 · 经济型 e 实例 · 2核2G / 40G ESSD Entry**（¥99/年）。
下单页上的实例规格名应是 **`ecs.e-c1m1.large`**（e = 经济型，c1m1 = 1:1 的 CPU/内存比，large = 2 vCPU ⇒ 2 GiB）。
操作系统选 **Ubuntu 24.04 64 位**。
依据与**已知的将来取舍**：

- 当前形态是**单槽**：DSH 常驻 ≈ 350 MB、空闲 CPU <1%、一年磁盘 8–10 GB ⇒ **2G / 40G 够用**（配 §4.3 的 swap）。
- **远期 P6b 蓝绿是"同机双槽"，不是两台机器**（见 §2.5 的更正）：内核 ×2 + 网关 ≈ **634 MB 常驻**，
  磁盘约 **2×**（两份 `DSH_HOME` + dev 快照）⇒ 到那时 **2G / 40G 会不够，需要 4G / 60G**。
  路线图已把 P6b 记为 **🎯 远期目标**，届时按"升配 / 换机"再定 —— 现在不为它付费。
- ⚠️ **未验证**：99 元档是**活动价**，"续费同价"在**升配之后是否仍成立**，我没查证
  ⇒ 下单前请向客服确认，或直接接受"将来可能换机"。
- 该档是**经济型 e 实例（共享型）**，官方原文："非绑定CPU调度模式……高负载时计算性能波动不稳定，
  **有可用性SLA保证，但无性能SLA保证**"。但它**不是**突发性能型（无 CPU 积分），
  且官方给 e 实例列的首个适用场景就是"面向自主任务型智能体的轻载场景，如**智能体网关、编排器**等" ——
  与本项目负载（空闲占绝对主导）吻合；风险只在"跑构建 / 安装时可能被邻居拖慢"。

### 2.2 官方价格对照（同口径：中国大陆地域、2核4G 附近、含系统盘与带宽）

| 厂商 | 官方产品/活动 | 配置 | 官方价 | 备注 |
|---|---|---|---|---|
| **腾讯云** | 轻量云专场特惠（活动页） | 2核 **4G** / 60G SSD / 5M / 500GB月流量 | **¥188 / 1年**（标 2.4 折，个人专享限 1 个） | 另有 `4核4G3M/40G` ¥79/年、`2核4G6M/70G` **3年 ¥528** |
| 腾讯云 | 轻量应用服务器（产品页标准价） | 2核2G / 40G / 3M / 200GB月 | ¥45/月，**¥459/年**（85 折） | |
| 腾讯云 | 轻量应用服务器（产品页标准价） | 2核4G / **100G** / 7M / 1000GB月 | ¥100/月，**¥1020/年**（85 折） | |
| **阿里云** | 99 计划（活动页） | 2核2G / 40G ESSD Entry / 3M | **¥99/年**，续费同价 | 官方页写"不限人群"，限购 1 台 |
| **阿里云** | 99 计划（活动页） | 2核 **4G** / **80G** ESSD Entry / 5M | **¥199/年**，续费同价 | ⚠️ 需**企业实名** |
| **华为云** | Flexus 应用服务器 L 实例（产品页） | 2核2G / 40G / 2M / 100GB月 | **¥329.32/年** | |
| **华为云** | 同上 | 2核4G / 50G / 3M / 400GB月 | **¥623.00/年** | 比腾讯活动价贵约 3 倍 |
| **火山引擎** | 第三代 AMD 实例 g3a（优惠页） | "全系规格降价后 **起**" | ¥723.91 起/年 | ⚠️ "起"价口径可能**不含**带宽与系统盘，不能直接横比 |

**结论**：单看**首年价格**，**腾讯云 188 元/年（2核4G/60G）是最划算的官方选项**；
但那是**活动价**（同配标准价见上表），而阿里 99 元档赢在官方页写明的"**续费同价**"（长期成本确定）。
⇒ **本项目按"长期成本确定 + 当前单槽够用"选了阿里 99 元档**（理由与将来取舍见 §2.1）。
华为云 / 火山引擎的标准价档在我们这个量级上没有优势。

### 2.3 规格依据（**实测数据**，2026-09-22 在 WSL 部署实例上量）

> 口径提醒：**会话语料的时间跨度不用文件 mtime** —— 数据迁移把文件 mtime 刷成了同一时刻，
> 用它会得出"2 天长了 332 MB"这种荒谬结论（那其实是**全部**语料）。
> 下表用的是每个会话**首帧 header 的 `createdAt`**（内容派生时间）做队列分析。

**磁盘（实测）**

| 项 | 实测 |
|---|---|
| 会话语料 | 554 个文件 / **332.7 MB**，创建时间跨 2026-08-17 → 09-20 |
| 单会话大小 | 中位 **90 KB**、90 分位 0.96 MB、**最大 34 MB**（那个文件有 **70,652 个 zstd 帧**）⇒ **极度长尾** |
| 语料增速 | 最近 7 个有会话的日子：8.1 会话/天、**12.2 MB/天**；最近 14 日 14.2 MB/天；整段 9.7 MB/天 |
| 日志/审计 | `resume-audit.jsonl` 6.5 MB（**这是重度测试一天的产物**）、`hotplug-audit` 56 KB、apply log 64 KB |
| systemd journal | 实占 **~720 MB**，但**真实日志内容只有 945 KB / 6375 行** —— 占用 99.9% 来自**文件预分配**（journald 每建新文件先分配 8 MiB 且不随内容缩小；101 个文件全是 8,388,608 字节）。同窗口内 **DSH 两个单元的日志条数 = 0**（那批文件来自 10 小时内 11 次开关机）⇒ **不是"日志疯长"**，但默认上限是盘的 10%（40 GB 盘上 4 GB），仍需封顶（§11，已由 `setup.sh` 落 drop-in） |
| 一次性成本 | 全局内核 305 MB + Node 单版本 536 MB + 仓库 9.4 MB ≈ **0.85 GB** |
| 工作区 | 163 MB（其中"DSH工具"117 MB、"研究"32 MB —— 是**人的产出物**，不是 DSH 产生的） |

**内存与 CPU（实测）**

| 项 | 实测 |
|---|---|
| 常驻内存 | 内核进程树 VmRSS **288 MB** + 网关 **58 MB** = **≈ 350 MB** |
| cgroup 总量 | 内核 412 MB / 网关 45 MB —— 比 RSS 高出的部分主要是它**读过的会话页缓存**（resume 扫描读了 332 MB），**可回收** |
| 启动峰值 | 500–720 MB（含页缓存）；插件加载 + 一轮 resume 扫描是最重动作 |
| **空闲 CPU** | 内核 **0–0.2%**、网关 0–0.1% ⇒ **常驻几乎不吃 CPU** |

**一年推算（不含工作区）**

| 项 | 一年 |
|---|---|
| Ubuntu 24.04 系统 | 2–3 GB |
| Node + 全局内核 + 仓库 | ≈ 0.9 GB |
| 会话语料（12–14 MB/天） | **4.4–5.1 GB** |
| 日志/审计（journal 限 500 MB） | < 0.6 GB |
| **合计** | **≈ 8–10 GB** |

⇒ **结论**：
- **内存**：**单槽下 2 核 2G 能跑，且已实测**（2026-09-23 在 2 GiB 的 cgroup 上限下真跑了一遍
  安装 + 启动，无 OOM）。实测画像见下表；关键结论是 **2G 上常驻约占三分之一，剩下的够跑，
  但构建/安装类命令会顶到上限 ⇒ §4.3 的 swap 是必须项**。

  | 项 | 实测 | 说明 |
  |---|---|---|
  | 内核 | **307 MB**（VmRSS） | cgroup 记账 230 MB（含页缓存口径） |
  | 网关 | **62 MB** | cgroup 14 MB |
  | **DSH 小计** | **≈ 370 MB** | |
  | 系统侧 | **≈ 300 MB** | Ubuntu 24.04 + systemd + journald + snapd + unattended-upgrades |
  | Tailscale | **+30–60 MB** | 云上会装，测试实例未装 |
  | **常驻合计** | **≈ 700 MB** | ⇒ 2 GiB 上还剩 **≈ 1.3 GB** 给尖峰 |
  | agent 子进程尖峰 | **1 GB+** | `npm install` / 构建；会被 swap 兜住（实测不 OOM） |

  ⚠️ **若将来上 P6b 蓝绿（同机双槽）**：内核 ×2 + 网关 ≈ **634 MB 常驻**，再叠启动峰值与构建尖峰
  ⇒ **2G 会 OOM，必须 4G**（§2.1 已记该远期取舍）。
- **CPU**：空闲 <1% ⇒ **2 vCPU 绰绰有余，CPU 不是选型依据**；瓶颈只在构建类命令。
- **磁盘**：**单槽 40 GB 打底足够**（一年用不到 1/4）。有两个放大器要留意：
  ① **工作区**（你的产出物，可能远超语料）；② 若天天都是"重度开发日"（实测单日曾出现 45 MB / 72 MB），
  按 72 MB/天 极端外推是 ~26 GB/年。⇒ **40 GB 起步、60 GB 舒服；云盘可在线扩容，不必一次买大。**
  ⚠️ **双槽（P6b）时数据约 2×**（两份 `DSH_HOME` + dev 快照）⇒ 40 GB 转紧、60 GB 舒服。

### 2.4 ⚠️ 备案：用 Tailscale 就**完全绕开**

- 大陆地域 + **域名**对外提供服务 → 需要 **ICP 备案**（要域名、要时间、要材料）。
- **本方案用 Tailscale + 直连，不绑域名 ⇒ 不需要备案**。这是选 Tailscale 的另一个实际收益。
- 若你将来要给别人用（需要域名/HTTPS 公网访问），再单独走备案与 `DSH_GATEWAY_TLS`（那条路本手册未验，见 §14）。

### 2.5 轻量应用服务器（SAS/Lighthouse）的取舍

优点：套餐打包（算/存/网一体）、**比同配 ECS 便宜**、开箱即用。
要注意的限制（来自厂商官方对比文档）：

- 公网 IP 创建后**不能更换**；带宽是套餐固定的，**不能自定义调整**；
- 一般**只支持厂商提供的镜像**（系统镜像够用，但没有自定义镜像的灵活性）；
- 阿里轻量：**仅支持一块数据盘、不支持 IPv6**；网络用**内置防火墙**（不是安全组）；
- 流量口径两家不同：**阿里轻量通用型为"无固定流量（不收取流量费用）"**，
  **腾讯轻量有月流量包**（200GB / 500GB / 1000GB 等），超出另计 —— 对我们这点用量都够。

⇒ ⚠️ **更正（2026-09-23）**：本手册早先在这里写过"**P6b 蓝绿不停机要跑第二个实例**，
内网互通约束与唯一数据盘会碍事，所以要上 ECS/CVM" —— **那句话是错的**。
P6b 的双实例是**同一台机器上的两个内核进程**（`/opt/dsh-slot-a|b`，端口 `127.0.0.1:3080` / `3180`，
各带独立 `DSH_HOME`），证据见[双槽设计 §2.1–2.2](../../docs/superpowers/specs/2026-09-22-dsh-bluegreen-dev-prod-design.md)；
[不停机更新设计 §2.3](../../docs/superpowers/specs/2026-09-19-zero-downtime-update-design.md) 还专列了"端口 listen 失败会打挂插件初始化"
这种**同机**冲突，并写明"single-instance / pid / 全局锁**不存在**"。因此：
- **不需要跨实例内网互通**（同机走回环）；
- **不需要第二块数据盘**（同一块盘上建两个目录即可）。
⇒ **"为了 P6b 必须上 ECS"不成立。** 真正的代价是**同机双份内存**（≈350 MB → ≈634 MB 常驻），
它影响的是**规格档位（2G 还是 4G）**，不是"轻量还是 ECS"（见 §2.1 与 §2.3 结论）。

轻量真正的长期顾虑是它**自身的固有约束**：公网 IP 创建后不可更换、带宽是套餐固定的不可调、
一般只能用厂商提供的镜像。这些与 P6b 无关，是另一类问题。

### 2.6 不建议的选项

- **抢占式 / 竞价实例**：便宜，但会被随时回收 —— 常驻服务不适合。
- **突发性能实例（t5/t6）**：受 CPU 积分限制，跑构建时会掉到基准性能以下，反而更慢。
- **把"共享型"一概而论**：突发性能实例是共享型的一个子类；**经济型 e 实例也是共享型，但没有积分机制**，
  官方明示"高负载时计算性能波动不稳定、无性能SLA保证"。本项目仍选它（§2.1），
  理由是**负载以空闲为主**（实测空闲 CPU <1%），不是因为它 CPU 独享 —— 这点别读反了。
- **只盯"起价"的横比**：不同厂商"起价"口径（是否含带宽/系统盘）不同，必须按**同配置**比。

---

## 3. 采购步骤（控制台逐步）

1. **地域**：选离你最近的（如华东1-杭州 / 华北2-北京）。地域**一旦选定不能改**，将来迁移要重买。
2. **付费模式**：包年包月（长期跑最划算）。ECS 也可先按量付费试用，验收通过后再转包年。
3. **实例**：按 §2.1 挑一档（个人实名推荐腾讯云轻量 `2核4G5M/60G`；要锁价则阿里云 99 计划 `2核2G/40G`）。
4. **镜像**：**Ubuntu 24.04 LTS 64 位**（不要选"应用镜像"，本手册自己装环境）。
5. **系统盘 / 套餐盘**：**≥ 40 GiB**（60–80 GiB 更稳；云盘可在线扩容，先小后大也行）。
6. **网络**：分配公网 IPv4（**只需要能出站**）。带宽 3–5 Mbps 足够；轻量套餐的月流量包对我们绰绰有余。
   - 注意：公网出站是**必须**的 —— 装 Tailscale、拉 npm 包、访问模型 API、会话内容经 tailnet 都要出网。
7. **安全组 / 防火墙**（ECS 叫安全组，SAS 叫防火墙）—— **按 §5 的表配**，别用"放通全部端口"模板。
8. **登录凭证**：ECS 建议用**密钥对（.pem）**；SAS 会让你设 root 密码。设完务必确认能登。
9. 创建完成后记下**公网 IP**。

## 4. 首次登录与系统初始化

```bash
# 本机（Windows 可开 PowerShell / WSL）：
ssh -i <你的密钥.pem> root@<公网IP>        # ECS 密钥对
# 或
ssh root@<公网IP>                          # SAS 密码登录
```

> **`-i <你的密钥.pem>` 里填什么**：填**你本机**上那个私钥文件的**路径**；`< >` 只是占位符，**不要写进去**。
> 不是服务器上的路径 —— `-i` 是给**你本地 ssh 客户端**读私钥用的。
>
> 🔑 **本节以下所有命令都用「公网 IP + 私钥」，这只在 §5.1 的 22 规则仍然开着时成立。**
> 一旦你按 §5.1 删掉那条规则（本手册推荐这么做），**后续一律改用 tailnet**：
> `ssh ops@<server>`（免私钥）、`ssh -i <你的密钥.pem> root@<tailnet IP>`，
> 或 `root@<server>`。§7.2 的 rsync 命令已按此写好。
>
> ⚠️ **如果在 WSL 里用放在 Windows 侧（`/mnt/c/...`）的 .pem，ssh 会直接拒绝**：
> 报 `UNPROTECTED PRIVATE KEY FILE` / `bad permissions`。原因是 DrvFs 把文件报成 **0777**，
> 而 ssh 要求私钥不能被他人读写。**把私钥拷进 WSL 自己的文件系统再改权限**即可：
>
> ```bash
> mkdir -p ~/.ssh && cp /mnt/c/Users/zhou1/Downloads/<你的密钥>.pem ~/.ssh/ \
>   && chmod 600 ~/.ssh/<你的密钥>.pem
> ssh -i /home/$USER/.ssh/<你的密钥>.pem root@<公网IP>
> ```
>
> ⚠️ 注意上面第三行用的是**绝对路径**而不是 `~/...` —— 在 §7.2 的 rsync 里，
> 私钥路径是写在 `-e "ssh -i ..."` 的**引号内**的，而引号内的 `~` **不会被 shell 展开**，
> ssh 的 `-i` 自己也不展开它 ⇒ 会去找一个字面叫 `~` 的目录然后失败。**一律写绝对路径最省事。**

登录后（以下都在**服务器上**执行）：

```bash
# 4.1 更新系统并装基础工具
# ⚠️ 必须带 DEBIAN_FRONTEND=noninteractive 与 --force-confold：
#    云厂商镜像的 openssh-server 几乎必然是"本地已修改"的，直接 -y upgrade 会弹 conffile 提示
#    （Configuring openssh-server ... A new version of /etc/ssh/sshd_config is available）。
#    手工操作时那只是多问一次；**脚本化/经 ssh 驱动时它会永久卡死等输入**。
#    --force-confold = 保留本地版本（等价于提示里的 "keep the local version currently installed"）。
#    为什么保留本地版本是安全的：本仓库**从不触碰 /etc/ssh/**，sshd_config 的内容对部署无影响，
#    而"现在能登录靠的正是这份配置"，改错了会把自己锁在门外。
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y -o Dpkg::Options::="--force-confold" upgrade
apt-get install -y curl ca-certificates git rsync ufw

# 若之后仍弹出 "Daemons using outdated libraries"（needrestart 自己的交互菜单，与上面无关），
# 选 OK 即可；想让它自动处理则设 NEEDRESTART_MODE=a。
unset DEBIAN_FRONTEND

# 4.2 时区（日志与审计时间对得上，排查时很关键）
timedatectl set-timezone Asia/Shanghai && date

# 4.3 ★★ 加 swap —— **2G 档必做，不是可选**；4G 档强烈建议；8G 以上可跳过
#    为什么必须做：agent 会执行命令（npm install / 构建 / 测试），这些子进程内存尖峰很高。
#    没有 swap 时一次尖峰就是 OOM kill；有 swap 则退化为"慢一下"。代价：swap 用多了会变慢。
#
#    ⚠️ 买 2C2G 的话，**这一步必须在 §8.2 跑 setup.sh 之前做完** ——
#       因为 `npm i -g @deepseek-ai/dsh` 要装 567 个包，是全过程内存尖峰最大的一处。
#    实测依据（2026-09-23，在 2 GiB 的 cgroup 上限 + 4G swap 下真跑了一遍安装）：
#       setup.sh rc=0，20 秒装完，内核 0.1.5-rc.1、依赖树形状自检通过、内核日志无 OOM 记录，
#       之后内核 active / NRestarts=0 / 3080 正常监听。
#       即：**2G + 4G swap 装得动、也跑得起来**（但装的那几分钟会很慢 —— swap 在兜底）。
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
free -h && swapon --show
# 建议顺手把 swappiness 压低一点：DSH 常驻部分不该被换出去，只有尖峰才该用 swap
sysctl -w vm.swappiness=10 && grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

# 4.4 建一个非 root 运维账号（ECS 的 ubuntu 账号已有则跳过；SAS 建议建）
#     本手册后续命令凡标 `sudo` 的都用这个账号执行
adduser --gecos "" ops && usermod -aG sudo ops
#     ↑ 只会问你两遍新密码（--gecos "" 已压掉姓名/单位/电话那几问）。
#       这个密码同时是 ops 的 sudo 密码 ⇒ 用密码管理器生成一个强随机值存好，不要复用其他地方。
#       忘了不要紧：root 用 `passwd ops` 可随时重设。

# 4.4.1 让 ops 也能用密钥登录
#     ⚠️ 不做这一步，`ssh ops@<公网IP>` 会直接 `Permission denied (publickey)` ——
#        新建用户的 ~/.ssh 是空的，而本手册后续命令都假定你以 ops 身份执行。
#        阿里云密钥对会把公钥写进 root 的 authorized_keys，直接复用它最省事（不用来回搬私钥）。
#     若下面第一条有输出（能看到 ssh-rsa/ssh-ed25519 开头的行）就继续；空则改用别的方式给 ops 授权。
cat /root/.ssh/authorized_keys
install -d -m 700 -o ops -g ops /home/<user>/.ssh
install -m 600 -o ops -g ops /root/.ssh/authorized_keys /home/<user>/.ssh/authorized_keys
#     之后即可：ssh -i <你的密钥.pem> ops@<公网IP>，再用 `sudo -i` 或逐条 sudo

# 4.5 确认 systemd 可用（本项目两个服务都是 systemd 单元）
systemctl --version | head -1
```

## 5. 网络准入清单（**这一步做错，前面全白搭**）

### 5.1 安全组 / 内置防火墙（云控制台里配）

| 方向 | 协议 | 端口 | 源 | 说明 |
|---|---|---|---|---|
| 入站 | TCP | **22** | 0.0.0.0/0 | SSH。**不做 IP 白名单**（理由见下） |
| 入站 | UDP | **41641** | 0.0.0.0/0 | Tailscale **直连**（可选；不开则退化为 DERP 中继，能通但更慢） |
| 入站 | TCP | ~~3389~~ | — | **删掉**。云厂商默认规则里的「RDP」，Ubuntu 上没跑任何 RDP 服务，纯攻击面 |
| 入站 | TCP | ~~8080~~ | — | **不要开**。网关只经 tailnet 访问 |
| 入站 | TCP | ~~3080~~ | — | **绝对不要开**。内核零鉴权 |
| 出站 | 全部 | — | — | 默认放通即可（要拉 npm、连 Tailscale 控制面、连模型 API） |

> **为什么 22 不做 IP 白名单（2026-09-23 决定）**：访问地点不固定（出差 / 旅游 / 手机热点），
> 出口 IP 每次都可能变。把 22 收窄到"当前出口 IP/32"= 埋一个"换个地方就连不上"的雷，
> 而它想防的东西不在这里防：
> - **防爆破靠「禁用密码登录」**（见 §5.3）。公网上被扫得最狠的恰恰就是家宽 / 4G 出口 IP 段，
>   IP 白名单对它们是无效的；而"只认密钥"对全世界扫描器都是硬墙。
> - **部署完成后可以删掉这条 22 入站规则**，SSH 只走 tailnet（§6 的 `--ssh`）：从任何地方、
>   任何设备都能进，且公网上 22 端口**直接不存在**，扫描器连门都摸不到。
>   ⚠️ 注意：**图形界面能力不会因此丢掉** —— 需要改宿主机设置时，用 tailnet 隧道把浏览器
>   地址变成 `127.0.0.1` 就行（命令与实测证据见 §9.4）。所以"为了保图形界面而必须留 22"
>   这个前提**不成立**。
>
>   ✅ **本项目已于 2026-09-23 执行并验证**（阿里云控制台删掉入方向 `22/22` 允许规则后实测）：
>   `ssh ops@<server>`（Tailscale SSH 免私钥）**仍通**（rc=0、`uid=1000(ops)`）；
>   公网 `ssh root@<server-ip>` 变为 **`Connection timed out`**（端口对外确实消失）；
>   网关经 MagicDNS 与 tailnet IP 仍应答 `302`。
>   ⇒ 最终入方向只剩 **`41641/udp`（Tailscale 直连）+ ICMP**。
> - **保留 22 的唯一理由是"带外救援"**：万一 tailscaled 挂了，或 Tailscale 账号 / ACL 出问题，
>   Tailscale SSH 和隧道会**同时**失效，那时公网 22 是唯一非 VNC 的通路。
>   若决定保留，建议**换成非标端口**（如 22022）——能滤掉绝大多数自动化扫描；再配合已确认的
>   "只认密钥"（§5.3）与 fail2ban 才算完整。
> - **兜底永远是控制台的 VNC 管理终端**（走内网，不受安全组影响），以上任何选择都不影响它。

### 5.2 主机防火墙（ufw）

```bash
# 先允许 SSH，再开 ufw —— 顺序反了会把自己关在门外
sudo ufw allow 22/tcp
sudo ufw allow 41641/udp
sudo ufw allow in on tailscale0        # ← tailnet 流量从 tailscale0 进来
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw --force enable
sudo ufw status verbose
```

> 注意：`allow in on tailscale0` 这条**要在装完 Tailscale、接口出现之后**才生效。
> 本仓库提供了脚本一次做完（见 §6）：`deploy/linux/tailscale-setup.sh`。

**可选加固（推荐）**：把网关**只绑到 tailnet IP**而不是 `0.0.0.0`，这样即使安全组配错也进不来。
代价是 tailnet IP 变化时要改配置（一般不变）：

```bash
# /etc/dsh-remote.env
DSH_GATEWAY_HOST=100.x.y.z        # 用 `tailscale ip -4` 查
```

### 5.3 ★ 22 对全网开放 ⇒ 必须确认 sshd 只认密钥

**这是 §5.1 放弃 IP 白名单之后，唯一真正挡爆破的东西，不能跳。**

```bash
# sshd -T 打印的是合并所有 Include 之后的**生效值**，不是配置文件字面值
sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin)'
```

期望看到：

```
passwordauthentication no
kbdinteractiveauthentication no
pubkeyauthentication yes
permitrootlogin prohibit-password      # 或 no，两者都可
```

**云镜像（尤其带 cloud-init 的）经常把密码登录打开**，而且写在
`/etc/ssh/sshd_config.d/50-cloud-init.conf` 里 —— 只看 `/etc/ssh/sshd_config` 会漏。
若上面是 `yes`，加一个**排序更靠前**的 drop-in 覆盖它
（sshd 对多数关键字取**先出现**的值，`00-` 排在 `50-cloud-init.conf` 之前）：

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/00-dsh-hardening.conf >/dev/null
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E '^passwordauthentication'     # 复核，应为 no
```

> ⚠️ **改完先在当前会话里复核，再另开一个新终端确认 `ssh ops@<公网IP>` 还能进，
> 确认能进之后才关掉旧会话** —— 写错了你就只剩控制台 VNC 一条路（虽然它一直都在）。

## 6. 接入方式落地：Tailscale

仓库提供脚本（幂等，可在安装 Tailscale 前后重复跑）：

```bash
# 把仓库里的脚本传上去后执行（若还没传仓库，可先 `scp` 这一个文件）
sudo bash deploy/linux/tailscale-setup.sh --hostname <server> --ssh
```

它做五件事：① 装 Tailscale（官方 apt 源）② 起 `tailscaled` ③ `tailscale up`（会打印登录链接，
在浏览器里点一下把**这台机器**加入你的 tailnet）④ 开 Tailscale SSH（`--ssh`）⑤ 打印 tailnet
IPv4、MagicDNS 名，并配好 §5.2 的 ufw 规则。

`tailscale up` 完成后，**记下它打印的 tailnet 名**，例如 `<server>.tailXXXX.ts.net` —— 客户端就用它访问。

**为什么一定要带 `--ssh`（漫游访问的正解）**：开了它之后，你在**任何加入同一 tailnet 的设备**
（桌面、笔记本、手机，甚至借来的电脑）上直接：

```bash
ssh ops@<server>          # 或 ssh ops@100.x.y.z
```

**不需要私钥、不需要固定出口 IP** —— 身份由 Tailscale 账号 + ACL 判定，而不是靠"从哪个 IP 来"。
做到这一步之后，安全组里那条 22 入站规则就可以**整条删掉**：公网上连端口都不存在，
而你在任何地方照样进得来。这正是 §5.1 里"不做 IP 白名单"能成立的前提。

> 若机器已入网、只是当初没带 `--ssh`：脚本第 3 步会跳过 `up`，补跑一次
> `sudo tailscale up --ssh` 即可（已认证状态下不会再弹登录链接）。
> ACL 默认是 `action: check`（每 12 小时要在浏览器点一次确认）；想免掉可在
> Tailscale 控制台 → Access controls 把该条改成 `action: accept`。

### ⚠️ 6.1 必读：Tailscale 会打断阿里云内网 DNS（2026-09-23 真机实测）

**症状**：`tailscale up` 之后，`apt` / `npm` / `curl` 全部报
`Could not resolve host: …` 或 `resolve call failed: Connection timed out`；
**但裸 IP 能通**（`curl http://223.5.5.5/` 有响应），出站完全正常。`tailscale down` 立刻恢复。

**根因不是配置错误，是地址段撞车**：阿里云内网 DNS 是 `100.100.2.136` / `100.100.2.138`，
**落在 `100.64.0.0/10` 里 —— 那正是 Tailscale 的 CGNAT 地址段**。Tailscale 会装一条
防伪造规则：

```
-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
```

⇒ DNS **应答**从 eth0 回来（源地址在 `100.64.0.0/10`、接口不是 `tailscale0`）**被直接丢弃**。
所以现象是"查询发得出去、响应回不来"，`ip route get 100.100.2.136` 显示路由完全正常，
`ufw` 关掉也一样 —— **三个误导性证据**，别顺着它们查。

顺带说明：`tailscale set --accept-dns=false` **解决不了**（它只停止接管 DNS 配置，不动 iptables）。
真正要绕开的是**地址段**，不是 DNS 配置。

**修法：改用 AliDNS 公共解析，并写进 netplan 以存活重启**（`50-cloud-init.yaml` 会被
cloud-init 重写，**不能改它**）：

```bash
printf 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n      dhcp4-overrides:\n        use-dns: false\n      nameservers:\n        addresses: [223.5.5.5, 223.6.6.6]\n' \
  | sudo tee /etc/netplan/99-dsh-dns.yaml >/dev/null
sudo chmod 600 /etc/netplan/99-dsh-dns.yaml
sudo netplan generate && sudo netplan apply
sudo systemctl restart systemd-networkd      # ← 关键：netplan apply 后 networkd 仍需重启才换 DNS
sudo resolvectl flush-caches
resolvectl dns eth0                          # 期望：223.5.5.5 223.6.6.6
resolvectl query registry.npmmirror.com      # 期望：有 A 记录
```

> **为什么必须用公共 DNS**：本方案只需要公网域名（npm 镜像 / Tailscale / 模型 API），
> 不需要 VPC 内部名字，所以换公共解析没有副作用。反过来，只要还依赖
> `100.100.2.x`，Tailscale 在线期间就一定不通。
>
> **服务端不需要 MagicDNS**（需要 MagicDNS 的是客户端），所以这里让
> `CorpDNS=false` + 公共 DNS 是最省心的组合。

**无人值守（可选，推荐）**：想避免每次重装都要点登录链接，可在 Tailscale 控制台生成 auth key，
然后 `sudo tailscale up --authkey tskey-xxxx --hostname <server>`。

**ACL 建议（Tailscale 控制台 → Access controls）**：只允许你自己的设备访问这台机器的 8080，
其余一律 deny。这样即使 tailnet 里加了别的设备也不会误开。

## 7. 上传交付物

### 7.1 ★ 先在本机备好 Web 客户端（**最容易漏、漏了会一路绿灯到浏览器 404**）

**`client/` 被 `.gitignore` 忽略**（客户端已拆分为独立仓库 `skyblade47/dsh-remote-client`），
所以 **`git clone` / 任意一次干净检出都不会带它**。而网关的静态路由默认就是从
`<仓库>/client/web` 取页面 —— 缺了它：

- 内核与网关**都照常 active**
- `check-ready.sh` 除第 9 项外**全部 PASS**
- 但浏览器打开**只有 404**

在本机（Windows）仓库根执行一次：

```powershell
# 若你已经用过便携版、client/ 已存在，可跳过；先确认一下：
Test-Path client\web\index.html          # True 就说明已有

# 没有就拉取（脚本会克隆独立仓库到 client/）
powershell -ExecutionPolicy Bypass -File tools\fetch-client.ps1
Test-Path client\web\index.html          # 必须为 True
Test-Path client\web\auth\login.html     # 未登录时 302 的落点，也要在
```

> 现在 `setup.sh` 与 `check-ready.sh` 都会检查它（分别在前置体检与第 9 项），
> 缺了会明确报出来 —— 但**最省事的做法是在上传前就备好**。

### 7.2 上传

在**本机**执行（把仓库传到服务器 `/opt/dsh-remote`）：

```bash
# 在仓库根目录（本机）
#
# ⚠️ 目标地址用 **tailnet**，不要用公网 IP：
#    按 §5.1 删掉公网 22 入方向规则之后，`root@<公网IP>` 会直接
#    `ssh: connect to host <公网IP> port 22: Connection timed out`，rsync 随之 rc=255。
#    （这是实测踩到的：手册自己建议删 22，却没把后续命令改成 tailnet 地址。）
#    经 Tailscale SSH 连 root 走的是 tailnet 身份授权，**不需要 `-i` 私钥**，也不需要 `-e`。
rsync -av --delete \
  --chmod=D755,F644 \
  --exclude 'node_modules' --exclude '.git' --exclude '.runtime' \
  --exclude '.trae' \
  --exclude 'dsh-data' --exclude 'dsh-data-*' \
  --exclude 'client.legacy-*' \
  --exclude '*/sessions' --exclude '_*backup*' \
  ./ root@<server>:/opt/dsh-remote/
```

> **若 tailnet 还没就绪**（例如你想在 §6 之前就先传一次），退回公网形式 —— 但**仅当 §5.1 的 22 规则仍然开着**：
>
> ```bash
> rsync -av --delete --chmod=D755,F644 <同样的排除项> \
>   -e "ssh -i <你的密钥.pem>" \
>   ./ root@<公网IP>:/opt/dsh-remote/
> ```
>
> 注意 `-e` 是引号内的字符串，里面的 `~` **不会被 shell 展开**、ssh 的 `-i` 自己也不展开 ⇒ 私钥路径**一律写绝对路径**（见 §3 的注解）。

**三条排除项各有原因，别随手删掉**：

| 排除项 | 为什么 |
|---|---|
| `--chmod=D755,F644` | ⚠️ **这一条是安全项，不是整洁项**。从 Windows（DrvFs/NTFS）上传时，所有文件会带上 **0777**；而手册后面让你 `sudo bash /opt/dsh-remote/deploy/linux/setup.sh`、`sudo bash …/restart-kernel.sh`。§4.4 又建了 `ops` 用户 ⇒ **任何本地用户都能改写将以 root 执行的脚本**。（实测：上传后仓库里有 **526 个 others-可写条目**，四个 `deploy/linux/*.sh` 全是 `-rwxrwxrwx`。）脚本一律用 `bash <路径>` 调用，所以去掉可执行位不影响使用 |
| `dsh-data` / `dsh-data-*` | 开发态默认数据目录（`resolveDataDir()` 的兜底）。`.gitignore` 忽略了它，**但 rsync 不读 gitignore** —— 本地跑过 dev 后它里面会有会话与凭据，一起传上去就是把本机数据泄露到服务器 |
| `.trae` / `client.legacy-*` | 前者是 IDE 目录、后者是 `fetch-client.ps1` 的留档备份（内容量级 65K）。都不该上服务器 |
| `node_modules` / `.git` / `*/sessions` | 体积与体积无关的往返数据 |

> ⚠️ **不要把 `client/` 加进排除列表** —— 它被 gitignore 忽略，是唯一"不在版本控制里、又必须传"的目录（见 §7.1）。
>
> ⚠️ 别把本机的 `.credentials.yaml`（含模型 API key）顺手同步上去又忘了删 —— **凭据在 §9 单独处理**。

传完在**服务器上**确认两件事（各 1 秒，省掉 10 分钟排查）：

```bash
# ① 客户端就位（缺了浏览器只会 404，而服务本身一切正常）
ls -l /opt/dsh-remote/client/web/index.html /opt/dsh-remote/client/web/auth/login.html

# ② 没有"人人可写"的条目（期望：无输出）
find /opt/dsh-remote -path '*/node_modules' -prune -o -perm -o+w -print
```

> 若 ② 有输出：`sudo chmod -R go-w /opt/dsh-remote` 补一下（说明 `--chmod` 那条没生效，多半是 rsync 版本低于 3.1 或用了别的工具上传）。
> `setup.sh` 启动时也会检查这一项，并在结尾再提醒一次。

#### ⚠️ 覆盖旧副本时的两个 rsync 坑（2026-09-23 实测）

**首次**上传到空目录时，上面的排除项与 `--chmod` 都完全生效。但**覆盖一个已存在的旧副本**时有两件事要注意：

| 现象 | 原因 | 处理 |
|---|---|---|
| 排除项**没清掉**上次已传上去的杂物（`dsh-data` / `.trae` / `client.legacy-*` 仍在目标端） | `--exclude` 只阻止**新**上传；目标端被排除的文件对 rsync 是"不可见"的，所以 `--delete` 也**不会**删它们 | 手动删一次：<br>`sudo rm -rf /opt/dsh-remote/{dsh-data,.trae,client.legacy-*}`<br>`sudo rm -rf /opt/dsh-remote/server/gateway/dsh-data` |
| ② 有输出，且残留的全是**旧目录** | 同理：`--chmod` 对"本次已存在、内容未变"的旧目录不改权限 | 清掉旧杂物后再看 ②，即为 0 |

**实测数据**（在旧副本上重传）：others-可写条目 **472 → 25**，而**剩下的 25 个全部是 09-21 那次旧上传的杂物**；
把这几个目录删掉后 → **0**。所以不是 `--chmod` 没生效，是旧残留没被清。

> `setup.sh` 的**前置体检**会直接点名这两类问题（"仓库里有 N 个 others-可写条目" / "仓库里有不该上传的目录"），
> 并在结尾再喊一次 —— 所以即使没看这一节，它也会告诉你。

## 8. 安装与启动

### 8.0 ★ 先决定：服务器上要装**哪些**插件

> ⚠️ **2026-09-23 起默认集已变**：种子 `bundles` **3 条** + 白名单 **15 条**（**自研 11 + 第三方 4**；2026-09-25 下线 `lanr` 后由 16 条减为 15 条，**同日稍后下线 `email-bridge` 后减为 14 条**，**2026-09-26 新增自研 `version-radar` 后回到 15 条**）。
> 本节下面若仍出现"默认只有 4 个"之类描述，**以 [§8.5](#85-插件挂载策略与能力边界2026-09-23-定稿) 为准** —— 插件已改走 adapter 热插拔白名单，不再列在 `bundles` 里。

`setup.sh` 默认用**最小插件集**，装完只有：

```
@deepseek-ai/dsh-base        @deepseek-ai/dsh-web-app
@local/dsh-adapter           （热拔插 + P3 重启自恢复 + 重启门闸）
@local/memory-system         （跨会话记忆）
```

仓库 `plugins/` 下的**其余自研插件**（`email-bridge` `knowledge-base` `lanr` `memory-system`
`miyoushe` `prompt-router` `session-janitor` `skill-center` `taskkit` `writing-coach`
`writing-studio` `wrpro` —— **该轮共 12 个，含当时尚未下线的 `lanr`**）
**都不在 `bundles` 里**。这不是 bug，是刻意的：最小集**不需要 pnpm、不需要访问 npm registry**，
首装最稳；而全量集要多拉 4 个第三方包。

> ⚠️ **2026-09-24 更新**：上面这段描述的是**历史上**的"最小集"（当时 `bundles` 里含 `memory-system`）。
> **当前实际**是：`bundles` **只留 3 个种子**（`dsh-base` / `dsh-web-app` / `@local/dsh-adapter`），
> **其余 11 个自研 + 4 个第三方全部走 hotplug 白名单**（共 **15 条** —— 自研 11 + 第三方 4；`email-bridge` 已于 2026-09-25 下线，源码保留但不再加载；`version-radar` 于 2026-09-26 新增并为白名单第 15 条）。**以 [§8.5](#85-插件挂载策略与能力边界2026-09-23-定稿) 为准。**（沿革：16 → 2026-09-25 下线 `lanr` 后 15 → 同日稍后下线 `email-bridge` 后 14 → **2026-09-26 新增 `version-radar` 后 15**。）

两个 profile 模板都在 `server/data/templates/`：

| 模板 | bundles | 额外前置 |
|---|---|---|
| `profile-web-minimal.package.json`（**默认**） | base + web-app + adapter + memory-system（4 个） | 无 |
| `profile-web.package.json`（全量） | `dependencies` **15 条**（11 个 `@local/*` + 4 个第三方：`dsh-better-sidebar` `dshmarket` `@nanmicoder/dsh-agent-teams` `@huanlin/dsh-plugin-better-locale`）；`dsh.profile.bundles` **15 条** | **需要 pnpm** + **能访问 npm registry**（脚本会从 `registry.npmmirror.com` 装） |

```bash
# 全量集这样装（其余步骤与 8.2 相同）
sudo bash deploy/linux/setup.sh --install-node --node-version 22.19.0 \
  --profile-template profile-web.package.json
```

> ⚠️ **选错了不会报错** —— 服务照常起来，只是那些插件不在。装完用
> `check-ready.sh` 的**第 10 项**核对实际挂载了什么，它会直接列出"仓库里有、但没挂载"的插件。

### 8.1 只做静态检查，不改机器（先看一眼要做什么）

```bash
cd /opt/dsh-remote
sudo bash deploy/linux/setup.sh --help
```

### 8.2 正式部署

```bash
# 会自动装 Node 22.19.0 + 全局装内核 + 建目录/服务用户 + 落插件集 + 装 systemd 单元 + journald 上限
sudo bash deploy/linux/setup.sh --install-node --node-version 22.19.0
```

> `setup.sh` 开头会做**前置体检**：若 `client/web` 不在（见 §7.1），它会立刻警告
> —— 因为那种情况下服务全都会"看起来正常"，只有浏览器打不开。

`setup.sh` **故意不做**的三件事（它会在结尾打印命令让你自己做）：
不 enable/start 服务、不改防火墙/安全组、不碰指纹外的配置文件。**它也不碰已有配置文件**（幂等）。

**8.3 让网关对外（关键一步）** —— 编辑 `/etc/dsh-remote.env`，取消这一行的注释：

```bash
sudoedit /etc/dsh-remote.env
# 找到并改成（其余保持默认）：
DSH_GATEWAY_HOST=0.0.0.0
#DSH_GATEWAY_PORT=8080          # 默认就是 8080，不用改
#DSH_GATEWAY_UPSTREAM=http://127.0.0.1:3080   # 默认值，不用改
```

> **不要**打开 `DSH_GATEWAY_TLS` / `DSH_GATEWAY_MTLS`：走 Tailscale 已经把"只有你的设备能进"
> 解决了；而 mTLS **必须先开 TLS**（`config.js` 里 `mtls = tls && …`），那条路本身还没在云上验过（见 §14）。

**8.4 启动**

```bash
sudo systemctl enable --now dsh-kernel.service dsh-remote.service
sudo systemctl status dsh-kernel.service dsh-remote.service --no-pager
```

### 8.5 插件挂载策略与能力边界（2026-09-23 定稿）

**种子层 vs 白名单**

`dsh.profile.bundles` 只留 **3 条种子**：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@local/dsh-adapter`。
其余插件**一律**进 `<DSH_HOME>/hotplug-manifest.yml`，由 adapter 在开机后自动加载。

**为什么**：`bundles` 的条目挂在复合层里、dispose 链与 `bundles` 共享 ⇒ 热替档位最低、且**加载失败会连累整核**。白名单条目在独立子树（真机实测 `tier=free`、`tierReason="loader 顶层独立条目"`）⇒ 档位更高、失败可控、状态可观测。依据：`docs/superpowers/specs/2026-09-22-adapter-hot-plug-design.md` §1.3 缺陷① / §1.4。

**`path` 契约（硬性）**

必须是**能从 profile 解析到的包名**：

- 自研：`@local/<name>`
- 第三方：**裸包名**（如 `dshmarket`、`@nanmicoder/dsh-agent-teams`）—— 实测它们都被 pnpm 装进 `<profile>/node_modules`，所以裸包名可解析
- 也接受 `file:` URL

**不能用绝对目录路径**：loader 会直接 `import('<目录>')`，而 **ESM 不支持目录导入**（实测报 `Directory import … is not supported`）。现已改为**明确报错**，不再静默放行；并且 `setup.sh` 会用 `server/scripts/check-hotplug-paths.mjs` 在装配期自检 **15 条** path 是否都能解析（沿革：16 → 2026-09-25 下线 `lanr` 后 15 → 同日晚些时候下线 `email-bridge` 后 14 → **2026-09-26 新增 `version-radar` 后 15**），**不通过即中止装配**。

**前提**：该包已被链接进 `<profile>/node_modules`。自研插件由 `setup.sh` 的 `link_local_plugins()` 建 symlink（**13 个：12 自研 + adapter**）；第三方由 pnpm 安装。

**增删一个插件**

改 `<DSH_HOME>/hotplug-manifest.yml` → **重启内核**（自动加载只在开机时跑一次）。
运行期也可用 `POST /adapter/api/hotplug {"op":"add"|"remove"|"enable"|"disable", …}`（这些操作会被审计记录）。

> ⚠️ `setup.sh` 的 `install_hotplug_seed()` **只在该文件不存在、或存在但 0 条条目时**落种子；已有条目就原样保留（避免冲掉运行期增删）。这条规则是 2026-09-23 补的 —— 之前只判"文件在不在"，导致一个残留的**空白名单**让种子永远落不下来，而日志只说"保留不动"，看起来一切正常、实际一个插件都没挂。

**能力边界**

| 插件类型 | 可挂载 | 可热替（reload / swap） |
|---|---|---|
| 自研（真实路径在 `node_modules` **之外**） | ✅ | ✅ |
| 第三方（npm 安装，路径在 `node_modules` **之内**） | ✅ | ❌ |

第三方**不可热替是设计**：buster 规则 2 明令 `node_modules` 内一律不 bust（否则同一依赖会被复制 N 份、破坏单例）。对它点 reload 会"**报成功但代码不变**"，属预期行为，不是故障。

**真机实测（2026-09-23 白名单 15 条；**2026-09-24 增至 16 条**；**2026-09-25 下线 `lanr` 后为 15 条**；**同日稍后下线 `email-bridge` 后为 14 条 —— 自研 10 + 第三方 4**）**

> ⚠️ **三个"15 条"构成不同，勿混**：2026-09-23 的 15 = 11 自研（**含 `lanr`、不含 `session-janitor`**）+ 4 第三方；
> 2026-09-25 下线 `lanr` 后的 15 = 11 自研（**不含 `lanr`、含 `session-janitor`**）+ 4 第三方；
> 同日稍后下线 `email-bridge` 后的 **14 = 10 自研 + 4 第三方**。
> 🔴 **2026-09-26（15 条 = 11 自研 + 4 第三方）**：新增自研 `@local/version-radar`（版本雷达）⇒ 白名单
> **14 → 15 条**（运行期 `POST /adapter/api/hotplug {"op":"add",…}` + `{"op":"load",…}`，**内核未重启**）。
> ⚠️ 本次的 15 条**不含** `lanr` / `email-bridge`，**含** `session-janitor` 与 `version-radar`。

- **2026-09-24（当时 16 条；该数含 `lanr`）**：新增 `@local/session-janitor`（会话治理插件）后白名单 **16 条**，`hotplug.autoload.done loaded=16 failed=0`、`check-ready` **PASS 20 / WARN 0 / FAIL 0**；该轮 `sessions/` 一字未动（`prescan.total` 仍 404）
- **2026-09-25（15 条）**：运行期热操作 `POST /adapter/api/hotplug {"op":"remove","id":"lanr"}` 下线自研「局域网访问」插件 `@local/lanr`（返回 200 `{"status":"removed","wasLoaded":true}`）⇒ 白名单 **16 → 15 条**（自研 11 + 第三方 4），运行态 `entries=15` 且**全部 `loaded=true`**、`inFlight=null`、`unstable=false`；**内核未重启**（`NRestarts=0`）。⚠️ 与上面 2026-09-23 的"15 条"**构成不同**：那次的 15 = 11 自研（含 `lanr`、**不含** `session-janitor`）+ 4 第三方；本次的 15 = 11 自研（**不含** `lanr`、含 `session-janitor`）+ 4 第三方。
- **2026-09-25（同日稍后，14 条）**：运行期热操作 `POST /adapter/api/hotplug {"op":"remove","id":"email-bridge"}` 下线自研「邮件桥」插件 `@local/email-bridge`（返回 200 `{"id":"email-bridge","status":"removed","wasLoaded":true}`；审计 `hotplug.unload.ok` + `hotplug.whitelist.remove`）⇒ 白名单 **15 → 14 条**（自研 10 + 第三方 4），运行态 `entries=14` 且**全部 `loaded=true`**、`inFlight=null`、`unstable=false`；**内核未重启**（`NRestarts=0`）。⚠️ **与 `lanr` 不同：源码保留在 `plugins/email-bridge/`（只下线、不删源码）**；数据文件 `/srv/dsh-workspace/写作训练/邮件桥/` 亦保留未删。
- 重启后自动加载（15 条时）：`hotplug.autoload.done loaded=15 failed=0 skipped=0`，**全程无任何人工 POST**
- 热替：改磁盘代码 → `reload` → 200 `reloaded`，journal 实测输出新码的探针行；`NRestarts` **0→0**、`ExecMainStartTimestamp` **不变** ⇒ **零重启**
- 失败可控：故意写语法错误 → `422 HOTPLUG_LINK_INVALID`（`stage:"import"`）；内核与网关仍 active、`NRestarts` 不变、**当时 15 条无一掉线**、**坏插件的旧实例仍在树上**（`gen`/`moduleRev` 未变）、审计留有明确 `code`+`stage`
- 逐个冒烟（15 条时）：13 个确认工作 / 1 个数据面降级（`miyoushe` 缺数据目录 ⇒ `status`/`logs` 返 `503 FS_PARENT_MISSING`）/ 1 个仅确认加载（`better-locale` 是纯客户端插件，服务端无观测面）

### 8.6 内核堆上限 drop-in（2026-09-24 部署变更，**当前生产依赖**）

**为什么需要**：本项目云主机是 **1740 MB / 2 vCPU**（§2），而服务端会话集是 **404 版**（404 目录 / 423 文件，`resume.prescan.total = 404`）。这个规模的内核**启动峰值**约 **1333 MiB**（cgroup `memory.peak`）、**稳态**约 **888 MiB** —— 默认 V8 老生代上限不够安全度过启动那几十秒。给内核加一条 `--max-old-space-size` 即可。

**怎么加**（systemd drop-in，**不改部署单元文件本体**）：

> 🔴 **2026-09-26 变更**：堆上限 **1000 → 1200**，并**新增 cgroup 护栏**。原因、依据与实测见下面「§8.6.1 2026-09-26 变更记录（B′）」；改前内容为 `--max-old-space-size=1000` 单文件 61 字节。

```bash
sudo mkdir -p /etc/systemd/system/dsh-kernel.service.d

# ① 堆上限（2026-09-26 起 = 1200）
printf '[Service]\nEnvironment=NODE_OPTIONS=--max-old-space-size=1200\n' \
  | sudo tee /etc/systemd/system/dsh-kernel.service.d/zz-heapsize.conf >/dev/null

# ② cgroup 护栏（2026-09-26 新增）
#    MemoryHigh 软限：到这儿触发回收/限速，**不杀进程**（高于实测峰 1248–1333 MiB）
#    MemoryMax  硬限：只杀**内核服务自己**（systemd 随即拉起），**不牵连网关/sshd**
printf '[Service]\nMemoryAccounting=yes\nMemoryHigh=1350M\nMemoryMax=1500M\n' \
  | sudo tee /etc/systemd/system/dsh-kernel.service.d/zz-cgroup-memory.conf >/dev/null

sudo systemctl daemon-reload
sudo systemctl restart dsh-kernel
```

> ⚠️ 命令名是 **`systemctl daemon-reload`**（**不是** `daemonctl`）。**无需"合并既有 `NODE_OPTIONS`"** —— 实测该机器既有环境里**没有**其它 `NODE_OPTIONS`，所以这一条就是全集。将来若再叠加，注意同名变量以**后加载的 drop-in** 为准（要合并须写进同一个 `Environment=`）。

**怎么验**：

```bash
# 1) 两个 drop-in 都在、内容对
cat /etc/systemd/system/dsh-kernel.service.d/zz-heapsize.conf        # 期望 --max-old-space-size=1200
cat /etc/systemd/system/dsh-kernel.service.d/zz-cgroup-memory.conf   # 期望 MemoryHigh=1350M + MemoryMax=1500M
# 2) 已被单元加载 + 生效值
systemctl show dsh-kernel -p Environment | tr ' ' '\n' | grep NODE_OPTIONS   # 期望 …=1200
systemctl show dsh-kernel -p MemoryHigh -p MemoryMax                          # 期望 1415577600 / 1572864000
# 3) 进程层面确实带上了（权威）
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value dsh-kernel)/environ | grep NODE_OPTIONS
# 4) 🔴 V8 **真正认**的上限（注意：heap_size_limit ≈ flag + 24 MB；⚠️ 不要用 `nsenter -m`
#    去量 —— 它只进 mount namespace、**不带环境变量**，量到的是"无 flag 的自动值 895 MB"）
node --max-old-space-size=1200 -e 'console.log(Math.round(require("v8").getHeapStatistics().heap_size_limit/1048576)+" MB")'   # 期望 1224 MB
# 5) cgroup 护栏已落到内核 cgroup
cat /sys/fs/cgroup/system.slice/dsh-kernel.service/memory.high   # 1415577600
cat /sys/fs/cgroup/system.slice/dsh-kernel.service/memory.max    # 1572864000
# 6) 跨过启动窗口仍不 OOM（重启后 ≥90 s）
systemctl show dsh-kernel -p NRestarts --value                                    # 期望 0
journalctl -u dsh-kernel --since "$(systemctl show -p ActiveEnterTimestamp --value dsh-kernel)" --no-pager | grep -c 'Reached heap limit'   # 期望 0
```

真机实测（2026-09-24，flag=1000）：该文件 **61 字节**、内容为 `[Service]` + `Environment=NODE_OPTIONS=--max-old-space-size=1000`；配它之后 404 版内核 `NRestarts=0`、启动峰值 `memory.peak` ≈ 1306–1333 MiB、稳态 ≈ 888 MiB（详见 [迁移计划 Task 4 执行记录 ⑥](../../docs/superpowers/plans/2026-09-23-workdata-migration-to-server.md)）。

真机实测（2026-09-26，改为 B′ 后）：两个 drop-in 就位、`systemctl show` 解析值 `1415577600 / 1572864000`、`environ` 含 `=1200`、**`heap_size_limit = 1224 MB`**（改前 1024 MB）、`NRestarts=0`、**就绪 30 s**、本生命周期 cgroup `memory.peak = 1088.1 MiB`（远低于 `MemoryHigh`）、heap OOM 行数 0、白名单 15 条全挂。详见 [诊断 §8 决策记录](../../docs/spikes/2026-09-26-内核内存上限与真实使用形态诊断.md)。

**§8.6.1 2026-09-26 变更记录（B′：抬上限 + cgroup 护栏）**

| 项 | 改前 | 改后 |
|---|---|---|
| `--max-old-space-size` | `1000`（V8 实算 `1024 MB`） | **`1200`（V8 实算 `1224 MB`）** |
| cgroup `memory.high` | `max` | **`1350M`** |
| cgroup `memory.max` | `max` | **`1500M`** |
| 触发原因 | — | 2026-09-26 19:03 内核 **OOM 崩过一次**（`Reached heap limit`，堆 998.8 MB 正好顶到 1024 上限） |

**为什么这次可以抬（即 §4.0 那条"不抬"纪律为何被修订）**：原禁令的**前提**是"**cgroup 上限 = `max`（无限）⇒ 没有任何东西挡住内核继续长**"，所以抬上限会把"V8 干净崩 + systemd 拉起"换成"宿主 OOM-killer 随机杀（可能杀网关/sshd，且不留 V8 栈）"。本次**同时**给内核 cgroup 设了 `MemoryHigh`/`MemoryMax` ⇒ **故障域被锁在内核服务自身**，越界仍然表现为"内核被杀 → systemd 5 s 拉起"，**与改前是同一种干净失败**。⇒ 前提消失，禁令随之有条件解除。

**怎样回滚**（两个文件都要还原）：

```bash
sudo rm /etc/systemd/system/dsh-kernel.service.d/zz-cgroup-memory.conf
printf '[Service]\nEnvironment=NODE_OPTIONS=--max-old-space-size=1000\n' \
  | sudo tee /etc/systemd/system/dsh-kernel.service.d/zz-heapsize.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart dsh-kernel
```

或直接用备份（改前配置已备份）：

```bash
BK=$(ls -1d /root/dsh-backups/heapsize-b-prime-* | tail -1)
cp -a "$BK/." /etc/systemd/system/dsh-kernel.service.d/
rm -f /etc/systemd/system/dsh-kernel.service.d/zz-cgroup-memory.conf
sudo systemctl daemon-reload && sudo systemctl restart dsh-kernel
```

> 回滚后须重新评估：**全量/大会话集下 1000 的上限会重新落回"贴着实测峰"的紧状态**（实测峰 958.6 MiB / 上限 1024 MB ⇒ 余量仅约 4%），间歇性 OOM 会回来（这正是本次抬它的原因）。

---

### 8.7 内存连续观测采样器（`mem-observe.sh`，2026-09-26 上线）

**为什么**：内存的结论此前都来自**短窗口**（几十秒～几十分钟）。要判断"这台 1740 MB 机器能否再撑约 1 年"，必须把观测拉长到**连续一个月**，用**过程变化率**外推 —— 见 [观测计划 §2](../../docs/superpowers/plans/2026-09-26-memory-observation-one-month-plan.md)（起点已固化在该文档 **§1.3**）。

**装在哪**：

| 项 | 位置 |
|---|---|
| 脚本（仓库源） | `deploy/linux/mem-observe.sh`（sha256 `881a5e5a…`，14634 B，纯 LF） |
| 脚本（部署副本） | `/opt/dsh-remote/deploy/linux/mem-observe.sh`（`0755 root:root`） |
| 数据 | `/srv/dsh-home/logs/mem-observe.jsonl`（JSONL，**33 字段**，一行一次采样） |
| 单元 | `/etc/systemd/system/dsh-mem-observe.{service,timer}` |

**怎么装 / 卸 / 看**：

```bash
# 装（写 unit/timer + enable --now；每 2 min 一次）
bash /opt/dsh-remote/deploy/linux/mem-observe.sh install
# 卸（停用并删单元；**保留数据文件**）
bash /opt/dsh-remote/deploy/linux/mem-observe.sh uninstall
# 看
bash /opt/dsh-remote/deploy/linux/mem-observe.sh status
bash /opt/dsh-remote/deploy/linux/mem-observe.sh analyze 30      # 概览 / 极值 / 每日表 / 趋势外推 / 异常计数
bash /opt/dsh-remote/deploy/linux/mem-observe.sh sample         # 手动采一行（调试用）
```

**怎么验**：

```bash
systemctl list-timers dsh-mem-observe.timer --no-pager | head -3    # 期望 NEXT 有值、每 2 min
systemctl is-enabled dsh-mem-observe.timer; systemctl is-active dsh-mem-observe.timer   # enabled / active
wc -l /srv/dsh-home/logs/mem-observe.jsonl                           # 每 2 min +1
```

真机实测（2026-09-26 21:22–21:25）：两端 `sha256` 一致 · `bash -n` OK · 纯 LF · timer `enabled/active` · **等一个周期后行数 2 → 3（确认真的会跑）** · `analyze` 报采样间隔中位 **120 s**。

**纪律**：

- 采样器**全只读**（除写自己那一行 JSONL）—— **不碰内核、不碰会话、不重启任何东西**、不联网、不依赖 dsh 原生包。
- 每 2 min ≈ **21,600 行/月 ≈ 5 MB** ⇒ **不做轮转**（若要改，见脚本头注释）。
- 输出字段**只增不改**（`analyze` 依赖字段名稳定）。
- ⚠️ 起点快照在观测计划 §1.3；**此后任何部署 / 重启 / 配置变更都可能使起点失效**（按该文档 §1.1 的"失效条件"处理）。

---

### 8.8 本地 WSL2 装配产物 → Spec①「夹具 B」的交付契约

**背景**：Spec①（`docs/superpowers/specs/2026-09-26-release-ownership-migration-design.md`）的**夹具 B（heal 零写入）**
要求"**只读 release + 非 root 用户**"。本机 WSL2 装出来的 release 树可以**直接**当这个夹具用，
不必再等完整装配器 —— 因为它与服务器**同布局**：`<release>` 根、`<ver>/` 下 `kernel/` + `plugins/`(13) + `profile/`。

| 项 | 值 |
|---|---|
| **release 绝对路径** | `/usr/local/dsh-release/<ver>`（例：`/usr/local/dsh-release/0.1.5-rc.1`） |
| 内核入口 | `/usr/local/dsh-release/<ver>/kernel/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| 内核模块树 | `/usr/local/dsh-release/<ver>/kernel/lib/node_modules/@deepseek-ai/dsh/node_modules/` |
| 自研插件（13） | `/usr/local/dsh-release/<ver>/plugins/`（含 `version-radar`） |
| 第三方（P-A） | `/usr/local/dsh-release/<ver>/profile/node_modules/`（`.pnpm` **服务器 225 条** / **本机 release 实测 223 条**；体积两侧同为 **367 MiB**） |
| 生产前自检 | `bash deploy/linux/check-tree-shape.sh --version <ver> --emit-fixture` |

> ⚠️ **上面"两个数都对、来源不同"（F2，2026-09-26 实测）**：**225** = **服务器现役口径**；**223** = **本机 release 实测**
> （Task 4 装配）。差 **2** 条的原因是 release 的 `profile/pnpm-lock.yaml` 是**装配时现场生成**的
> （89,332 B / `824cbb20…`），**不是**入库的服务器那份（85,755 B / `7c30a7ba…`）⇒ 解析版本漂移
> （`cordis 4.0.4` vs 服务器 `4.0.3`、`cosmokit` 1.8.5 vs 1.8.4 等）。
> ⇒ 判据 **T-7** 的阈值**按口径取**：对"服务器树"用 225，对"本机 release"用 223（或 `--accept-diff T-7` 人工裁定）。
> 把真 lockfile 就位后**重新装配**即可对齐（已登记为 **F2**，用户定：跑完 Task 6–9 再修）。

**权限：切到"只读形态"（夹具 B 的默认前提）**

```bash
VER=0.1.5-rc.1
REL=/usr/local/dsh-release/$VER
sudo chown -R root:root "$REL"
sudo chmod -R u=rwX,go=rX "$REL"
# 校验①：非 root 用户**可读**（读不到时内核只会报 cannot resolve profile bundle，不提示权限问题）
sudo -u "$USER" test -r "$REL/kernel/lib/node_modules/@deepseek-ai/dsh/package.json" && echo readable
# 校验②：release 内**没有**该用户可写的路径（期望：无输出）
sudo -u "$USER" find "$REL" -writable -print -quit
```

**权限：切回"可写对照"**（夹具 B 的 B-5：区分"没写"与"没跑"）

```bash
sudo chown -R $(id -u):$(id -g) "$REL"
```

**用途**：Spec① 阶段 B 用它跑**真 boot**，把 A9/A10 从"夹具证明机制"升级为"真 boot 实测"。
🔴 **前置（F1，未修前本行不成立）**：本 release **缺宿主包接线** `<ver>/plugins/node_modules/@deepseek-ai/dsh-tools`
（只有 `kernel/lib/…` 与 `profile/node_modules/.pnpm/…` 两处）⇒ **切到纯 release 后 13 个自研插件会集体加载失败**
（实测 `hotplug.autoload.done loaded=1 failed=14`，全是 `Cannot find package '@deepseek-ai/dsh-tools'`）。
⇒ 在 **F1 修好**（装配侧补该接线并加断言，或冒烟时以非只读方式落链接）**之前，这条"跑真 boot"的用途不可用**；
当前 release 只能当"**只读性 / 形状 / 权限**"的夹具，**不能**当"插件能起来的真 boot"证据。详见
`docs/superpowers/plans/2026-09-26-local-wsl2-assembly.md` 的「已知未修问题（F1 / F2 / F3）」。
**注意**：本机树的 `profile/node_modules` 由 pnpm 装成**软链 + `.pnpm` 实体**形态；若 Spec① 的夹具需要"`profiles/web/node_modules` 是软链"这一形态，请把
`$DSH_HOME/profiles/web/node_modules` 指向 `<release>/<ver>/profile/node_modules`（**只改 DSH_HOME，不动 release**）。

---

### 8.9 WSL2 本地装配：pnpm 取法 · `--ignore-scripts` · 环境纪律（S1 / S2 / S4 / S5 / S6）

> 面向 `assemble-release.sh` / `smoke-local-wsl2.sh` / `kernel-release.sh install` 在 **WSL2** 里跑的场景。
> 与 §8.8 配套：§8.8 讲"装出来的树怎么给 Spec① 当夹具"，本节讲"在这台机上怎么把它装出来、有哪些坑"。

#### 8.9.1 pnpm 怎么取（S1）：**首选"独立前缀装钉版"**，`npm prefix -g` 只作兜底

**首选做法**（本机实测可用）——把**钉版 pnpm** 装到一个**可写的独立前缀**，再用 `--pnpm-bin` 显式指定：

```bash
npm i -g --prefix "$HOME/pnpm1251" pnpm@12.5.1        # 装到可写前缀（例如 $HOME/pnpm1251）
bash deploy/linux/assemble-release.sh --version 0.1.5-rc.1 --pnpm-bin "$HOME/pnpm1251/bin/pnpm"
```

**兜底**（不足为凭）——`"$(npm prefix -g)/bin/pnpm"`：本机实测**一执行就段错误**（rc 139，见 §12 排障），
只有确认它健康时才可用。

#### 8.9.2 为什么装配器默认带 `--ignore-scripts`（S2）

`assemble-release.sh` 的第三方装配**固定带 `--ignore-scripts`**（代码里有注释，见 `install_third_party()`）。原因：
pnpm 12 对本仓库的 **`node-pty`** 会报 `ERR_PNPM_IGNORED_BUILDS` 并**退出码 1** —— 而**树其实已经装好**（实测）。
**不带它会怎样**：装配器把"非 0 退出"当失败 ⇒ **在 `install_third_party` 一步中止**（Spec② Task 9 的 V1 FAIL，就是这条）。
该 flag 只表示"跳过 build script、不因忽略而失败"，与本仓库"预编译产物随包分发"的形态相容，故设为**默认**。

#### 8.9.3 环境纪律（S4 / S5 / S6）

- **S4 · `/tmp` 不跨命令存活**：`/tmp` **不跨 `wsl bash -c` 调用**（distro 关闭即清空）⇒ 凡"需要跨命令留存的中间产物"一律放
  **仓库外的固定目录**，约定 `E:\项目\_wsl2-plan-check\`（WSL 侧 `/mnt/e/项目/_wsl2-plan-check`）；**不要放 `/tmp`**。
- **S5 · WSL 内 git 无身份**：WSL 内 git **没有 `user.name`**（`git commit` rc=128）⇒ **提交固定从 PowerShell 侧做**；
  **禁止**在 WSL 里跑 `git config` 改身份。
- **S6 · 本地测试残留（裁定：保留，勿混）**：WSL2 里存在本地测试残留：`/srv/dsh-home`（约 **351 MB**）、
  `/usr/local/dsh-release/0.1.5-rc.1`（约 **685 MB**）。这是**本地夹具**（`/usr/local/dsh-release/<ver>` 就是 §8.8 / Spec①
  「夹具 B（heal 零写入）」的接口），**保留**；**不要与服务器上的同名路径混淆** —— 路径相同只是巧合，两者不是同一台机器，
  服务器那两份是生产环境。

---

## 9. 凭据（`.credentials.yaml`）—— 唯一必须手填的东西

内核与网关**必须共用同一份** `$DSH_HOME/.credentials.yaml`（默认 `/srv/dsh-home/.credentials.yaml`）。
网关要用里面 `client-connection/browser-session` 的 secret 给浏览器签 `dsh-auth` cookie；
两者 secret 不一致会表现为**上游 401**。

### 9.1 文件已经由 §8.2 的 `setup.sh` 生成好了 —— **你只需要填模型 API key**

**不要**再 `cp` 模板覆盖它。`setup.sh` → `server/scripts/setup.mjs` 已经做了两件事：

1. **文件不存在时**从 `server/data/templates/.credentials.yaml.template` 拷一份过去
2. **每次都校验并修复 browser-session secret**：读第 6 个缩进处的 `secret:` 值，
   用 base64url 解码后**必须是 32 字节**；不是（例如模板里的 `<BROWSER_SESSION_SECRET>` 占位符）
   就**自动换成 `crypto.randomBytes(32).toString('base64url')`**

⇒ 所以**手写 secret 反而容易出错**：`dsh-auth.js` 会把它 base64url 解码后再用，
你写一个普通字符串进去，语义上就不是它期望的东西了（而且下次跑 `setup.sh` 会被当作非法值重生成，
届时内核与网关若读取时机错开，就会看到"上游 401"）。

**唯一的动作**是填 key：

```bash
sudo -u dsh vi /srv/dsh-home/.credentials.yaml
```

模板结构如下，**只改 `refs:` 下的两行**，`records:` 整段（含 secret）**保持原样**：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: <DEEPSEEK_API_KEY>     # ← 换成真实 key
  OPENAI_API_KEY: <OPENAI_API_KEY>         # ← 换成真实 key（用不到可留占位符）
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: <BROWSER_SESSION_SECRET>     # ← 不要动，setup.sh 已自动填好
```

改完确认权限：

```bash
sudo chmod 600 /srv/dsh-home/.credentials.yaml
sudo chown dsh:dsh /srv/dsh-home/.credentials.yaml
```

> ⚠️ **权限必须是 0600**。内核在 Linux 上**强制**要求属主专属，否则**直接拒绝启动**并报
> `credentials-local: <path> is readable beyond its owner` —— 这是本项目踩过的坑，别以为是别的错。
> `setup.sh` 有一个"归一化权限"步骤（`fix_config_modes`）会兜底，但**手动改过文件后仍要自己检查**。
>
> 📌 **实测补充（2026-09-23）：凭据是按需读取的，不是启动时快照。** 观察到：内核 17:27 启动、
> 17:37 才写入 key，**未重启即对话成功**。所以"填完必须重启"并非硬性要求。
> 但**保守做法仍然是重启一次** —— 这样"生效"是确定的，而不是依赖某个实现细节；
> 而且重启不会踢掉你的隧道会话（§9.4 的 cookie 跨重启有效）。

> ✅ **重跑安全**：`setup.sh` 的处置是"文件缺失才补、secret 非法才重生成"，
> 所以填好 key 之后再跑一次 `setup.sh` **不会**把你的 key 冲掉。
> （这也正是**不要**照旧版手册用 `cp 模板` 的原因 —— `cp` 是无条件覆盖。）

### 9.2 从已有部署迁移

用 `tools/export-for-linux.mjs`，它**默认不带凭据**，需要显式 `--include-credentials`（见该脚本 `--help`）。

### 9.3 ★ 首个管理员怎么来（**没有预设账户，这是刻意的**）

**本系统没有、也不应该有"预设 admin 账户"** —— 预设就意味着默认用户名 + 口令写死在代码或仓库里，
那是比"没有引导"严重得多的问题（谁都能试）。引导方式是 **首个注册的账号自动成为管理员**：

```js
// server/gateway/src/auth-service.js —— registerUser()
const isFirst = store.listUsers().length === 0
const user = createUser({ name, password, role: isFirst ? 'admin' : 'pending' })
if (isFirst) audit.log('user.first-admin', { userId: user.id })
```

注意 `isFirst` 分支给的是 **`admin`**，**不是 `pending`** ⇒ 第一个注册的人**注册完立刻能登录、立刻能审批**。

还有一道兜底，防止"开关默认关闭 ⇒ 后台永远进不去"这个死锁：

```js
// server/gateway/src/auth-routes.js —— registrationAllowed()
// 是否允许自助注册。除管理员开关外，全新环境（尚无任何账号）必须放行，
// 否则第一个管理员无法创建，后台将永远进不去。
if (settingsStore && settingsStore.isPublicRegistrationAllowed()) return true
return !settingsStore || authService.listUsers().length === 0
```

⇒ 即使 `settings.json` 里 `allowPublicRegistration` 默认是 `false`，**空库时注册照样开放**
（`GET /api/auth/registration-status` 会返回 `true`，登录页的「注册」标签照常出现）。

**首次接入的正确动作（顺序重要）**：

1. 浏览器打开 `http://<tailnet 名>:8080/`
2. 登录页切到 **「注册」** 标签，填用户名 + 密码（**≥ 8 位**）
3. 看到 **"注册成功，已成为管理员，请登录"** ⇒ 你就是 admin
4. 登录 → 进后台

之后（库非空 + 开关仍为 `false`）**注册入口自动关闭**、登录页的「注册」标签消失；
再加人只能由 admin 用 `POST /api/auth/users` 创建，或临时打开 `allowPublicRegistration`。

> ⚠️ **这段"空库"窗口有安全含义：谁先注册谁就是 admin。**
> 但网关只对 tailnet 开放 ⇒ 能抢的只有**已经在同一 tailnet 里的人/设备**。
> 所以**务必在把任何其他人、其他设备加进 tailnet 之前完成第 3 步**。
>
> 现状自查：`cat /srv/dsh-home/users/users.json`（空库时是 `{"version":1,"users":[]}`）；
> 看开关：`curl -s http://127.0.0.1:8080/api/auth/registration-status`。

> **忘了 admin 密码**：没有"找回"流程（单用户自托管刻意不做邮件找回），
> 且 `users.json` 里存的是**哈希**，不能直接手改成明文。
> **未验**：可行的恢复路径（用 `crypto.js` 的 `hashPassword` 生成新哈希后替换，或清掉账号重来）
> —— 真要恢复时先与我们确认，别凭猜测改。

### 9.4 ⚠️ 远端浏览器**改不了**模型设置（DSH 的刻意边界，2026-09-23 定位）

**症状**：浏览器里进「模型」页，报 `加载提供方目录失败: settings are unavailable in this browser`。

**这不是部署故障。** 判定链在 `@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-connection`：

```js
// dsh-client-ui-settings —— apply()
const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"

// dsh-client-connection —— ctx.connection 的 isLoopback
isLoopback: transport?.ownsHost === true || pageLocation === void 0
            || isLoopbackHostname(pageLocation.hostname)

// 只认三类：localhost、[::1]、127.0.0.0/8
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true
  const parts = hostname.split(".")
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}
```

`persistence !== "host"` ⇒ 该 scope 的 store 状态**在构造函数里就写死为 `"unavailable"`**，
mirror 根本不会被订阅，所以模型页必然取不到视图。源码注释也明说：*"non-loopback pages may
remain process-local"*。

⇒ **DSH 不允许"非 loopback 的页面"改宿主设置文档**，而模型提供方正是宿主设置文档的一部分。
这是安全边界，不是 bug。注意它和 `/api` 的 Host 围栏**不是同一道门**：围栏有 `trustedHosts`
可以放行非 loopback 权威（我们的网关就是靠 Host 改写过的），但 `isLoopback` **没有任何配置项可以翻转**
—— 它读的是**浏览器地址栏的 hostname**，跟网关怎么改写请求头无关。

**所以远端加模型只能走文件**：`$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers`（提供方 + 模型清单）
配合 `.credentials.yaml` 里对应的 `apiKeyEnv` 引用（见 §9.1）。改完重启两个单元。

真想用图形界面改，唯一的路是让浏览器的 hostname **真的是 loopback**：开 SSH 隧道后用
`http://127.0.0.1:3080/?token=<内核启动日志里那个>`。

> ✅ **隧道走 tailnet 就行，不需要公网 22**（2026-09-23 实测 —— 推翻了"Tailscale SSH 不支持端口转发"这个说法）：
>
> ```bash
> # 本机（Windows PowerShell）；免私钥，走 Tailscale SSH
> ssh -N -L 3080:127.0.0.1:3080 ops@<server>
> ```
>
> 实测证据：本机起监听（`Get-NetTCPConnection -LocalPort 13081 -State Listen` → 2 条），
> `curl http://127.0.0.1:13081/` 得到 `401 dsh web authentication required; reopen the URL
> printed by dsh web.` —— **这是内核本体的应答**（网关对根路径是 302，可据此区分）；
> 对照组用未建转发的端口则 `curl: (7) Failed to connect`。
>
> 然后浏览器开 `http://127.0.0.1:3080/?token=<token>`：地址栏 hostname 是 `127.0.0.1`
> ⇒ `isLoopback = true` ⇒ **模型 / 常规等设置页全部可用**。token 取法（在服务器上）：
>
> ```bash
> journalctl -u dsh-kernel --no-pager | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1
> ```
>
> 注意 token 在**每次内核重启后会变**，重启后重取即可。**但 token 只需要粘一次** ——
> 它是"进程级启动令牌"，用来**兑换**一张 30 天有效的签名 cookie；之后靠 cookie 就够，
> 内核重启也不用重新粘。机制与实测见下方。
>
> #### token ≠ 长期凭证：为什么它必然每次都变，而你不必每次都用它
>
> ```js
> // dsh-client-connection
> const TOKEN_QUERY = "token";  const COOKIE_PREFIX = "dsh-auth-";  const SECRET_BYTES = 32
> const PROCESS_LAUNCH_TOKENS = new WeakMap()
> function processLaunchToken(owner) {
>   const existing = PROCESS_LAUNCH_TOKENS.get(owner)
>   if (existing !== undefined) return existing
>   const created = encodeBase64Url(randomBytes(SECRET_BYTES))   // ← 纯内存、随机、无配置项
>   PROCESS_LAUNCH_TOKENS.set(owner, created); return created
> }
> ```
>
> ⇒ **token 在架构上就不可能固定**（`randomBytes(32)` + 按进程缓存 + 没有开关）。
> 这是刻意的：固定的长期密钥会落在命令行、日志和进程列表里，正是它要避免的。
>
> 实测 token 每次重启都变（同一天两次启动）：
> `8RV_Geq0P3Fzl0xxxL8SJ_M_86AfKcYChssdltT0jGc` →（重启于 17:27:32）→
> `QggvcLgCLMIiqGLSciEJNikqOKmLXSAzVe84iy6WoP4`。
>
> **真正持久的是 cookie。** 用 token 访问会拿到：
>
> ```
> HTTP/1.1 303 See Other
> location: /
> set-cookie: dsh-auth-<authority 的 HMAC>=v1.<payload>.<签名>; Max-Age=2592000; HttpOnly; SameSite=Strict
> ```
>
> payload 解出来是 `{"version":1,"authority":"127.0.0.1:13080","issuedAt":…,"expiresAt":…}`
> —— **有效期 30 天**（`Max-Age=2592000`），签名密钥来自 `.credentials.yaml` 里
> `client-connection/browser-session` 的 secret（持久，`setup.sh` 只在**校验失败**时才重生成）。
>
> **✅ 实测：cookie 跨内核重启继续有效。** 做法是重启内核（token 已变）后用**不带 token** 的
> `http://127.0.0.1:13080/` 访问 —— 界面照常完整加载，说明旧 cookie 仍被接受。
> ⇒ **一次粘 token，管 30 天，期间内核重启无感。**
>
> ⚠️ **但 cookie 绑 authority**（payload 里就是 `127.0.0.1:13080`，cookie 名也是它的 HMAC）。
> 所以**隧道端口别随意改** —— 换端口＝换 authority＝旧 cookie 作废，要重新粘一次 token。
> 建议固定用一个端口（如 `3080` 或 `13080`）并写进你的常用命令里。
>
> 另一个佐证"为什么必须走隧道"：`dsh web` 明确**拒绝** `--host 0.0.0.0`
> （报 `it would expose remote code execution to the network; use 127.0.0.1 instead`）。
> 内核本身就只允许绑回环 —— 远端要拿到完整图形界面，隧道是**官方设计里唯一的路**，
> 而不是我们绕出来的偏方。
>
> **✅ 图形界面确实完整可用（2026-09-23 实测，用内置浏览器逐屏验证）**：
> 经隧道打开后，设置对话框的 5 个页签（通用设置 / 模型 / 插件 / Agent 预设 / 插件热拔插）全部出现；
> 「模型」页正常渲染出提供方目录 —— `DeepSeek`、`openai` 两条 + 「添加提供方」「添加自定义提供方」按钮，
> **没有** `settings are unavailable in this browser`。即：`isLoopback=true` 生效，宿主设置可编辑。
>
> ⚠️ **但注意「API 密钥已配置」这个标记会误报**：实测两个 key 都还是模板占位符
> （`.credentials.yaml` 仍是 241 字节、16:41 那份未改），界面照样显示"已配置"。
> 看起来它只判 `apiKeyEnv` 指向的 ref **是否为非空值**，而 `<DEEPSEEK_API_KEY>` 也是非空字符串。
> ⇒ **别拿这个标记当"密钥填好了"的证据**，按 §9.1 亲自确认。
>
> 结论：**"远端 UI 看会话、需要改设置时临时开隧道"** 是这套架构下最舒服的组合 ——
> 图形界面能力一点没少，而且公网一个端口都不用开（见 §5.1）。

### 9.5 为什么**不能**让网关路径也具备设置页能力（2026-09-23 裁决，附内核原文）

需求（用户提出）：*"能不能让服务端自动加载 token，这样我用 `http://<tailnet 名>:8080/` 登录后设置页也能用？"*

**先澄清两件事，避免走错方向：**

1. **"服务端自动加载 token"这件事网关已经做完了**，而且它从来不是瓶颈。网关每次转发都注入内核的
   `dsh-auth` cookie（`server/gateway/src/proxy.js` 的 `injectDshAuth` + `dsh-auth.js`），
   所以你能登录、能开会话 —— 全程没碰过内核 token。**设置页失败与 token 无关。**
2. **设置页的门是 hostname，不是鉴权。** 而 **HTTP 的 host 由浏览器地址栏决定，服务端无法伪造**。
   所以"服务端让网关域名具备设置能力"在物理上就不成立，除非内核自己开口子。

**那个口子确实存在，但内核明文禁止我们在这种场景用它：**

```js
// dsh-client-connection/lib/client.js
const transport = globalThis.__DSH_TRANSPORT__
const handle = {
  isLoopback: transport?.ownsHost === true || pageLocation === void 0
              || isLoopbackHostname(pageLocation.hostname),
```

```ts
// dsh-client-connection/lib/types/client/index.d.ts —— ownsHost 的契约
/**
 * The transport owner declares the page owns the Host outright: the Host
 * runs inside a worker this page spawned, so no other party can reach it and
 * the loopback stand-in for "the operator's own machine" is vacuous.
 * `ctx.connection.isLoopback` then reports the privileged surface reachable
 * regardless of the page authority.
 * ⚠️ Only a shell that assembles its own transport can set this;
 *    served pages never carry the global at all.
 */
ownsHost?: boolean;
```

⇒ **不能做，也不该做**，三条理由：

- **语义上是伪造**：`ownsHost` 的前提是"Host 跑在**本页自己 spawn 的 worker** 里"。
  我们的 Host 跑在远端服务器上、由网关转发 —— 断言 `ownsHost:true` 是在**谎报状态**，
  而内核正是用这个状态来决定要不要放开特权面。
- **契约明文禁止**：*"served pages never carry the global at all."* 我们服务的就是 served page。
- **它是内部形状，不是服务端扩展点**：`globalThis.__DSH_TRANSPORT__` 只在
  `dsh-client-connection` 的客户端包里被消费（全树仅 2 处出现，且没有内核自带的赋值点），
  属于"升级即失效"的依赖 —— 也违反本仓"不改 DSH 原生主体"的纪律。

**结论：网关路径的图形界面只能到"设置只读"为止。** 完整设置能力只有两条合法路径：

| 路径 | 能力 | 代价 |
|---|---|---|
| **隧道**（§9.4） | 完整图形界面，含模型等宿主设置 | 客户端侧要起一次隧道；**token 30 天只需粘一次** |
| **P4 桌面客户端**（未开工） | 完整图形界面，且把"隧道"这件事**收进客户端内部**、用户无感 | 需开发。做法是**客户端在本地监听回环并转发到服务器**（壳内页面 hostname 真的是 `127.0.0.1`）。⚠️ **不要**改用 `ownsHost` —— 它要求 Host 跑在"本页自己 spawn 的 worker"里，本项目 Host 在远端，用它就是**伪造状态** |

> 换句话说：**"像本地 App 一样用远端 DSH"这个体验的归属是 P4** —— 由客户端在本地监听回环并转发，
> 让壳内页面的 hostname 真的是 `127.0.0.1`。注意这**不是**"把浏览器伪装成 loopback"、更不是用
> `ownsHost` 谎报状态：它只是把"手动隧道"搬进客户端、并固定绑回环，语义上完全诚实。
> 在 P4 之前，手动隧道是唯一的正路。

## 10. 验收（部署完必做）

仓库提供就绪探针，**逐项打印 PASS/FAIL**：

```bash
sudo bash deploy/linux/check-ready.sh
```

它会检查：Node 版本是否 ≥22.15、内核是否在 127.0.0.1:3080 上应答、网关是否在监听 8080、
Tailscale 是否已入网、两个 systemd 单元是否 active**（并隔 15 秒复核一次稳定性）**、
数据目录与 `0600` 权限、从日志里取出**带 token 的访问 URL**、磁盘与 journal 占用、
**Web 客户端静态资源是否就位**、**实际挂载了哪些插件**。

> ⚠️ **判就绪要"等够时间"再跑：从内核重启算起 ≥ 90 秒。** 实测内核约 **50 s** 才监听 3080、约 **60 s** 才加载完插件 ⇒ "重启后 32 秒内"那一段它**必报 `FAIL 2`**（3080 未监听 / curl `000`）—— 那是**预热期，不是故障**。第 10 项还会在 API 不可达时**等 10 秒重试一次**，正是为了把"预热中"与"真不一致"分开。

> ⚠️ **第 5 项的 15 秒稳定性复核不是多余的**：`Restart=always` 的服务在崩溃重启的间隙里，
> `is-active` 一样会返回 `active`。2026-09-23 的真机事故就是这样 —— 探针报 PASS 15/FAIL 0、
> 退出码 0，十几秒后内核其实已经崩了。现在它还会看 `NRestarts`，**非零即判 FAIL**。

**本机（WSL）实测输出**（两个单元都在跑时）：

```
✅ PASS  node v22.19.0
✅ PASS  只监听回环：127.0.0.1:3080
✅ PASS  内核应答 HTTP 401
✅ PASS  监听：127.0.0.1:8080
⚠️ WARN  只绑了回环 ⇒ 客户端经 tailnet 连不上（WSL 本地无 tailnet，属预期）
✅ PASS  网关应答 HTTP 302
✅ PASS  dsh-kernel：active     ✅ PASS  dsh-remote：active
✅ PASS  /srv/dsh-home/.credentials.yaml 权限 0600
✅ PASS  内核直连 URL：http://127.0.0.1:3080/?token=…
✅ PASS  journal 实占 494 MB
✅ PASS  journald 上限已生效（SystemMaxUse=500M）
汇总：PASS 14 / WARN 2 / FAIL 0
```

（末两条是 2026-09-23 补测第 8 项时新增的；该次两个单元是停机状态，其余各项沿用上文记录。）

**独立复核**（不依赖探针自己的判断）：`ss` 显示 3080/8080 各 1 条监听；`curl :8080/` 得 **302**（跳登录页）；
`curl :8080/api/sessions` 得 **401** —— 这同时实证了 P1 的"未登录一律 401"在真实栈上成立。

在**本机**（已加入 tailnet）验证：

```bash
# 取 tailnet 名（在服务器上跑）：tailscale status | head -2
curl -sS -o /dev/null -w '%{http_code}\n' http://<tailnet名>:8080/     # 期望 200（登录页），未登录访问 API 应 401
```

然后浏览器打开 `http://<tailnet名>:8080/`，用 P1 的账号登录，应能看到自己的会话列表。

## 11. 日常运维

```bash
# 看日志（内核 / 网关）
sudo journalctl -u dsh-kernel -f
sudo journalctl -u dsh-remote -f

# 取本次启动的访问 URL（token 在启动日志里打印）
sudo journalctl -u dsh-kernel --since '2 min ago' --no-pager | grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+'

# 改插件/数据后重启内核 —— **请用带门闸的脚本**，别直接 systemctl restart：
#   它会先问内核"现在能不能安全重启"（在飞子代理 / 热拔插 / 未闭合 turn），不安全就拒绝
sudo bash /opt/dsh-remote/deploy/linux/restart-kernel.sh --check   # 只看能不能重启
sudo bash /opt/dsh-remote/deploy/linux/restart-kernel.sh           # 轮询到安全再重启
sudo bash /opt/dsh-remote/deploy/linux/restart-kernel.sh --force   # 明知不安全也要重启（留审计）
```

- ⚠️ **`journalctl --since` 的时区坑**：用 `date -u` 生成的 **UTC 串**喂给它，journalctl 会**按本地时区（Asia/Shanghai）解释** ⇒ 时间窗被**放大近 8 小时**，会把更早的崩溃误算进窗口（曾导致 `FATAL=2` 假警报）。**要用本地时间串**（如 `date +'%Y-%m-%d %H:%M:%S'` 得到的值），或显式带上时区。
- 插件热拔插的审计在 `$DSH_HOME/logs/resume-audit.jsonl`；adapter 的 apply 日志在 `$DSH_HOME/dsh-adapter-apply.log`
  （排查"插件为什么没加载"先看这两个）。
- **重启自恢复（P3）默认开启**：`scope: tasks-only`（只唤醒"明确有活没干完"的会话），见
  `plugins/dsh-adapter/dsh-bundle-patch.yml` 里的 `resume:` 段说明。
- ⚠️ **journal 容量上限**（`setup.sh` 已落 drop-in；这里说明依据与存量处理）：
  ```bash
  cat /etc/systemd/journald.conf.d/50-dsh.conf   # SystemMaxUse=500M / SystemMaxFileSize=50M
  sudo systemctl restart systemd-journald        # 装了没重启 = 没生效
  sudo journalctl --vacuum-size=500M             # 只在存量很大时做一次
  du -sh /var/log/journal                        # 看实占（口径以 du 为准，见下）
  ```
  **为什么要设**：journald 默认 `SystemMaxUse` = 文件系统的 10%（封顶 4 GiB）⇒ 40 GB 盘上就是 4 GB。
  而实测 journal 的磁盘占用**主要不是日志内容，而是文件预分配** —— journald 每建一个新文件先分配
  8 MiB，且不随内容缩小。2026-09-23 在 WSL 上实测：目录里 **101 个文件，大小全部是 8,388,608 字节**
  （表观 808 MB / `du` 实占 719 MB），而**真实日志内容只有 945,173 字节、6375 行** —— 99.9% 是空壳；
  同一窗口内 `dsh-kernel` / `dsh-remote` 的日志条数是 **0**（那批文件来自 10 小时内的 11 次开关机，
  与 DSH 无关）。设成 500 MB 后总量被压到盘的 1.25%。
  **别把 journal 关掉** —— `check-ready.sh` 要从它里面取带 token 的访问 URL，故障排查也全靠它。
  **口径提醒**：`journalctl --disk-usage` 与 `du` 会差近一倍（实测 349.6M vs 719M，原因未查清，
  疑与未封印的 `.journal~` 文件有关）；判断"占了多少盘"以 `du` 为准。
- **备份**：至少要备 `$DSH_HOME`（会话、`.credentials.yaml`、`settings.yaml`、`.agent-presets`）与
  `/srv/dsh-workspace`。云主机可用快照/镜像做整机备份。

## 12. 故障排查

| 现象 | 先查这里 | 常见原因 |
|---|---|---|
| 内核单元反复重启 | `journalctl -u dsh-kernel -n 50` | `.credentials.yaml` 权限不是 0600（**最常见**）；Node < 22.15；profile 的 `bundles` 写错（会 crash-loop 到 systemd start-limit，需 `systemctl reset-failed`） |
| 单元起不来、报 `Start request repeated too quickly` | `sudo systemctl reset-failed dsh-kernel` | 上面那个 crash-loop 把 systemd 的启动限流触发了 |
| 浏览器打不开（超时） | 服务器上 `sudo ufw status`；`ss -ltnp \| grep 8080`；云控制台安全组 | ufw 没放行 `tailscale0`；`DSH_GATEWAY_HOST` 没设成 `0.0.0.0`；客户端不在同一 tailnet |
| 打开是登录页但登录后 401 / 上游 401 | 两份 `.credentials.yaml` 是否同一份、`browser-session` secret 是否一致 | 网关与内核凭据不一致（§9） |
| Tailscale 连上但很慢 | `tailscale status` 看是否 `relay` | UDP 41641 没放通 ⇒ 走了 DERP 中继；按 §5 放通 |
| **`apt`/`npm` 报 `Could not resolve host`，但裸 IP 能通** | `resolvectl dns eth0` 是否还在 `100.100.2.136/138` | **Tailscale 与阿里云内网 DNS 的地址段撞车**（`100.100.2.x` ⊂ Tailscale 的 `100.64.0.0/10`）⇒ §6.1 |
| 会话列表为空 | `ls /srv/dsh-home/sessions` | 全新部署本来就没有数据；要迁移见 §13 |
| 磁盘满 | `df -h /srv`；`du -sh /var/log/journal` | 会话日志增长；**journal 预分配堆积**（见 §11 —— 101 个空壳文件就是 808 MB）；ESSD 在线扩容后 `growpart` + `resize2fs` |
| **`pnpm` 一执行就段错误**（rc 139） | `ls -l "$(npm prefix -g)/bin/pnpm"`，**比对文件体积** | 全局 pnpm 的**二进制被截断**（本机实测 **35 MB vs 正常 52 MB**）⇒ **别用它**；改用**独立前缀装的钉版**（§8.9.1，`--pnpm-bin "$HOME/pnpm1251/bin/pnpm"`） |

## 13. 把已有数据搬到云上（可选）

如果你在便携版/WSL 上已有对话要带过去：

```bash
# 1) 在源机器导出（默认不含凭据；需要连凭据一起要显式打开）
node tools/export-for-linux.mjs --help

# 2) 传到目标机后，用迁移脚本导入（脚本内带 SHA256 校验与 MANIFEST 对账）
node server/scripts/session-migrate.mjs --help
```

⚠️ 两个已踩过的坑，导入前先看：
- **多帧 zstd**：会话日志是 append-only 多帧压缩，只解第一帧会**静默丢数据**（脚本已修，但别用别的工具手工解）。
- **旧格式会话**：当前内核**读不动**旧代次命名（`session.jsonl.zstd`，无版本号）的会话，
  报 `subagent/descriptor … unsupported descriptor version 2` 并**拒绝迁移**。
  **我们的服务端不受影响**（自己直读 zstd + JSONL），详见
  [P3 计划 §会话格式调查](../../docs/superpowers/plans/2026-09-22-dsh-remote-p3-resume-on-boot.md)。

---

## 14. 尚未验证的部分（**别当成已验证**）

| 项 | 状态 | 说明 |
|---|---|---|
| 本手册在**真实云主机**上的端到端执行 | ✅ **已验到登录页**（2026-09-23，阿里云 ECS `ecs.e-c1m1.large` / Ubuntu 24.04 / 2C2G / 40G） | §3 → §10 全流程在真机上跑通：`check-ready.sh` **PASS 19 / WARN 0 / FAIL 0**、退出码 0（含第 5 项 15 秒稳定性复核、`NRestarts=0`）。过程中新发现并修掉一个真实缺陷：**Tailscale 打断阿里云内网 DNS**（见 §6.1，`setup.sh` 装 Node 时首次失败的就是它）。**仍未验**的唯一一环：浏览器里**真正登录并新建会话**（见本表末行） |
| 客户端（Windows）入网后的真实链路 | ✅ **已验**（2026-09-23） | 客户端装 1.102.4（`winget`）、登录同一 tailnet；`tailscale status` 显示 **`active; direct <server-ip>:41641`** —— **直连而非 DERP 中继**，顺带实证 §5.1 的 41641/UDP 放行有效；`curl http://<tailnet-host>:8080/` → **302**、`/api/sessions` → **401**（MagicDNS 与 tailnet IP 两条路都通）；**`ssh ops@<server>` 免私钥直接进**（rc=0，`uid=1000(ops)`，未触发浏览器二次确认）；带私钥走 tailnet IP 也通 |
| **从零装配（`setup.sh` 的产物）能否跑起来** | ✅ **已修并已验**（2026-09-23） | 曾**跑不起来**：内核 crash-loop（`plugin(s) failed to load: @deepseek-ai/dsh-sandbox-local; Cordis startup failed because these plugin(s) could not be resolved`）。**根因**：内核的传递依赖用 `^` 范围声明，上游持续发版 ⇒ 全新安装解析到更新的传递版本（实测当天已是 `dsh-base@0.1.5-rc.3`）⇒ **npm 依赖树形状从「顶层扁平」变「嵌套」**，而内核的插件加载器要求扁平 ⇒ 启动即崩。**修法**：`setup.sh` 把传递依赖钉到 `2026-09-10T12:00:00Z`（`--npm-before`，落在 rc.1 与 rc.2 的发布时间之间），并**在装配后做依赖树形状自检**（形状不对直接报错退出）。实测恢复：整棵树 `0.1.5-rc.1`、扁平、`active`、`NRestarts=0`、3080 正常监听。详见[部署前审计](../../docs/superpowers/plans/2026-09-23-dsh-p5-deploy-audit.md) |
| **插件侧版本兼容（上线前要重算）** | ⚠️ **有 1 项无上游依据** | 用 `node plugins/dsh-adapter/tools/compat-intersect.mjs` 求交（**退出码可作门禁**）。当前结论：自研 12/12 支持 `0.1.5-rc.1`；第三方里 `agent-teams 0.1.20` / `better-sidebar 0.19.1` 可升到最新，`better-locale` **必须停在 0.4.1**（最新版 0.4.3 的 peer 要 `^0.1.5-rc.2`，不含 rc.1），`dshmarket` **没有任何版本声明支持 0.1.5 线**（属声明不匹配的实测可用，风险最高，迁移后必须冒烟） |
| "内核 + 网关"在**手工装配过**的实例上能同时跑 | ✅ **已验**（WSL） | 双单元同时 active；网关日志 `dsh-auth cookie 生成器就绪` + `listening 127.0.0.1:8080 -> 127.0.0.1:3080`；探针 **PASS 14 / WARN 2 / FAIL 0**；未登录访问 `/api/sessions` 实测 **401**。**⚠️ 但这台是手工装配过的**（profiles 里留着 `package.json.bak-tsprobe-*` 等探针痕迹），其内核树布局与 `setup.sh` 的全新产物**不同** —— 所以它**不能**用来证明"从零部署可行" |
| 手册 §4 → §10 在干净实例上的全流程 | ⚠️ **除内核外全通；内核问题已修**（2026-09-23） | §4 全流程 ✓、§5.2 ufw ✓（**实测**：`allow in on tailscale0` 在接口不存在时也 rc=0 且生效，手册的顺序**不是**问题）、§7 rsync ✓、§8.2 `setup.sh` rc=0（43 秒）✓、幂等复跑 ✓、网关侧 302/401/200 全对 ✓、journald 上限生效 ✓。当时唯一的失败是内核起不来（见上一行，**已修并已验**）。全过程与缺口清单见[部署前审计](../../docs/superpowers/plans/2026-09-23-dsh-p5-deploy-audit.md) |
| **§7.2 的上传流程** | ✅ **两侧都验过了**（2026-09-23） | **首次上传到空目录**（真机，`/opt/dsh-remote` 事先不存在）：429 个文件 / 8.2 MB、`others-可写 = 0`、`client/web/index.html` 与 `auth/login.html` 都到位、排除项生效（无 `dsh-data`/`.trae`/`.runtime`）、权限位确为 `D755/F644`。旧副本覆盖场景更早已验（`--chmod` 让 others-可写条目 472→25，余下 25 全是旧残留，清掉后 0）。**已知局限**：`--chmod` 对"本次已存在、内容未变"的旧目录**不生效**，改过权限策略后要手动清一次旧目录 |
| `check-ready.sh` 的判据正确性 | ✅ **已验**（两侧） | 单元停止时报 FAIL 4（退出码 1）、运行时报 FAIL 0（退出码 0）；期间还抓出并修掉一个自身 bug（curl 失败会把 `000` 拼成 `000000`，把"没在监听"误报成 PASS） |
| journald 上限 drop-in 在真机上生效 | ✅ **已验**（WSL 2026-09-23） | 装 drop-in + 重启 journald 后 `systemd-analyze cat-config` 显示 `SystemMaxUse=500M`、`SystemMaxFileSize=50M`；**101 个文件 → 74 个、`du` 710M → 494M**（journald 按新上限**自行回收**，随后 `--vacuum-size=500M` 报 `freed 0B` 即已无必要）；探针第 8 项 2 条 PASS |
| 云主机长期运行下的 journal 日增量 | ❌ **未验** | WSL 上 10 小时开关机 11 次，不是正常负载形态。**500 MB 是防御性取值**（默认上限是盘的 10% = 4 GB），**不是**按实测日增量算出来的 |
| `tailscale-setup.sh` 的真实入网 | ✅ **已验**（2026-09-23 真机） | 装 1.102.4 ✓、`tailscaled` active ✓、`tailscale up --ssh` 入网成功（tailnet `<tailnet-host>` / `<tailnet-ip>`）、`RunSSH=true` ✓、脚本重跑 ufw 幂等 ✓。**注意**：`tailscale up` 一旦要改参数就必须**列全所有非默认项**（否则报 `requires mentioning all non-default flags` 并**不生效**，容易误以为改了），例如 `tailscale up --accept-dns=false --ssh --hostname=<server>` |
| 阿里云内网 DNS 与 Tailscale 共存 | ✅ **已定位、已修、且已验重启存活**（2026-09-23） | `100.100.2.136/138` ⊂ Tailscale 的 `100.64.0.0/10`，`-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP` 丢弃 DNS 应答 ⇒ `setup.sh` 装 Node 首次失败。改为 netplan 静态 AliDNS 后正常（§6.1）。**重启验证**：真机重启后 `resolvectl dns eth0` 仍是 `223.5.5.5 223.6.6.6`、公网域名秒解析；`50-cloud-init.yaml` 如它所声明被 cloud-init 重写（时间戳更新），而我们的 `99-dsh-dns.yaml` 完好保留 —— 印证"别动 cloud-init 管的文件、另加 99- 文件"这个做法正确 |
| 域名 + TLS（`DSH_GATEWAY_TLS`） | ❌ **未验** | 本手册选了 Tailscale 路线，绕开了它 |
| mTLS **协议层**（`DSH_GATEWAY_MTLS`） | ✅ **已验**（2026-09-23） | `server/scripts/p1-verify-v8-v9.mjs` 28/28：带已授权证书可进、**不带证书被拒**、吊销后**立即**生效（含 keep-alive 复用连接那条路径） |
| mTLS **真实客户端**（浏览器/手机导入 pfx） | ❌ **未验** | 脚本用的是 Node 客户端 + PEM，验的是协议逻辑；**证书导入与浏览器握手**还没走过。另注意 `config.js` 里 `mtls = tls && …` ⇒ **mTLS 要求先开 TLS**，而 TLS 路线（上面一行）也仍未在云上验过 |
| 工具审批回程（R1） | ❌ **未验** | 默认权限模式下工具自动批准，审批流程未被触发 |
| 账号审批回程（P1 V9） | ✅ **已验**（2026-09-23） | 同上脚本：pending 账号登录 403 `ACCOUNT_PENDING` → admin 审批 → 同一账号登录 200。**未验**的是审批后能否**真正新建会话**（需内核与网关同时在跑） |
| 设备 Token 到期失效（P1 V10） | ✅ **已修并已验**（2026-09-23） | 签发即写 30 天 `expiresAt`；历史凭据按「签发时 + TTL」补写 |
| **浏览器端到端**：注册 → 登录 → 新建会话 → 发一条消息 | ✅ **已验**（2026-09-23 真机） | 首个注册者即 admin：`auth-audit.jsonl` 里 `user.created` → `user.first-admin` → `auth.login.success`，来源 IP `100.99.248.68`（客户端 tailnet 地址）；网关签发的 P1 token 带 30 天 `expiresAt`。填好 `DEEPSEEK_API_KEY` 后 **新建会话 + 对话成功**，服务端落盘 `sessions/--home-dsh--/session-a0b4758c-…/session.v3.jsonl.zstd`（**27537 字节**）。附带证实 P3 插件健康：`descAvailable=true`、依赖 `sessionQuery/sessionProjectionCache/subagents/adapterWake` 全为 true。**注意**：可编辑的设置页只在**隧道 + loopback 地址**下成立（§9.4 / §9.5） |
| `/#hotplug` 斜杠命令 | ❌ **最小集下不可用（符合预期）** | `hotplug-audit.jsonl` 记 `hotplug.cmd.skipped: agents 服务不可用，/#hotplug 未安装` —— 该命令依赖 `@nanmicoder/dsh-agent-teams`，而它不在最小插件集里。热拔插**本身的工具面正常**（同日志 `hotplug.tools.ready ok=10 fail=0`） |
| **Tailscale SSH 的 `-L` 端口转发 + 图形界面可用性** | ✅ **已验**（2026-09-23，实测推翻了"Tailscale SSH 不支持端口转发"的说法） | 隧道：`ssh -N -L 3080:127.0.0.1:3080 ops@<server>`（免私钥）。**路径证明**：隧道进程的 TCP 连接是 `100.99.248.68:52902 → <tailnet-ip>:22`，**完全走 tailnet、从不经过公网 `<server-ip>`** ⇒ 删公网 22 物理上不影响它。**界面证明**：经隧道 `http://127.0.0.1:13080/?token=…` → **200 / `DeepSeek Harness`（28 KB）**，用内置浏览器逐屏确认设置对话框 5 个页签齐全、「模型」页正常列出 `DeepSeek` / `openai` + 「添加提供方」按钮，**不再报 `settings are unavailable`** |
| **公网 22 收口（安全组）** | ✅ **已执行并验证**（2026-09-23） | 删除入方向 `22/22` 允许规则后实测：`ssh ops@<server>`（Tailscale SSH 免私钥）**仍通**（rc=0）；公网 `ssh root@<server-ip>` 变为 **`Connection timed out`**；网关经 MagicDNS / tailnet IP 仍 `302`。⇒ 入方向最终只剩 `41641/udp` + ICMP。**代价**：这条路依赖 Tailscale 可用（tailscaled 挂掉或账号/ACL 出问题则同时失效），带外救援只剩控制台 VNC 或**临时从控制台加回**一条 22 规则 |
| **云主机真实重启后自恢复（P3 的核心命题）** | ✅ **已验**（2026-09-23，真机 `systemctl reboot`） | 重启后：三个单元（`dsh-kernel` / `dsh-remote` / `tailscaled`）全部自动 active；tailnet 重新入网（`<tailnet-ip>`）；网关本地应答 302、内核 401；**`check-ready.sh` PASS 19 / WARN 0 / FAIL 0**（含第 5 项的 15 秒稳定性复核）；数据目录、凭据 0600、会话文件、journald 上限全部保留；DNS 未回退（见上一行）。**未验**：重启时"正在飞的一轮对话"能否续上（需要一个 in-flight 的会话做样本，本次重启时没有） |
| 桌面客户端（P4） | ❌ **未开工** | 所以本手册只覆盖**浏览器**接入 |

## 15. 相关文档

- **升级 dsh 内核：见本文 §16 与 [dsh 升级 Runbook](../../docs/superpowers/plans/2026-09-25-dsh-upgrade-runbook.md)（装配层次 + 升级后"可重复施加我们的改动"）**
- 服务器版总设计：[2026-09-19-dsh-server-client-split-design.md](../../docs/superpowers/specs/2026-09-19-dsh-server-client-split-design.md)
- 路线图（P5 定义与状态）：[2026-09-19-dsh-remote-roadmap.md](../../docs/superpowers/plans/2026-09-19-dsh-remote-roadmap.md)
- Linux 迁移（含两个已修阻塞缺陷、数据迁移对账）：[2026-09-21-dsh-remote-linux-migration.md](../../docs/superpowers/plans/2026-09-21-dsh-remote-linux-migration.md)
- 重启自恢复（P3）：[2026-09-22-dsh-remote-p3-resume-on-boot.md](../../docs/superpowers/plans/2026-09-22-dsh-remote-p3-resume-on-boot.md)
- 不停机更新（P6a/P6b）：[2026-09-19-server-update-mechanism-design.md](../../docs/superpowers/specs/2026-09-19-server-update-mechanism-design.md)

---

## 16. 升级 dsh 内核（版本升级）

> 📖 **完整 Runbook（含装配层次的全部依据、逐项"会不会丢"、离线可复核的证据索引）在
> [docs/superpowers/plans/2026-09-25-dsh-upgrade-runbook.md](../../docs/superpowers/plans/2026-09-25-dsh-upgrade-runbook.md)。**
> 本节只给"要动手时照着念"的部分。

### 16.1 升级方式：**就一条路 —— 重跑 `setup.sh`**

**上游 `dsh` CLI 没有 `upgrade` / `self-update` 子命令**（`dsh --help` 只有 `web` 与 `plugin`），
所以内核升级 = **换全局 npm 包**，而本项目的落实者就是 `deploy/linux/setup.sh`（幂等）。

```bash
# 本机：改 deploy/linux/setup.sh 的两个常量
#   DSH_VERSION="<新版本>"          （setup.sh:27）
#   NPM_BEFORE_DEFAULT="<新钉点>"   （setup.sh:57，取"该版本发布后、下一版发布前"的中间点）
#   ⚠️ 不改进程依赖钉点 ⇒ 全新安装可能解析到更新的传递版本 ⇒ 依赖树由"扁平"变"嵌套" ⇒ 内核启动即 crash-loop，
#      且探针会误报全绿（见 §14 的实测记录与 setup.sh 脚本头原话）
#   ⚠️ 不要用 @latest：上游 latest 是 0.1.5-rc.2，会让 agent-teams 落回不兼容线
#      （见 plugins/dsh-adapter/compat-matrix.json 的 evidence.note）

# 本机：上传（§7.2 的 rsync；⚠️ 前端 client/ 必须先备好，否则 --delete 会把服务器上的前端删掉 → 404）
# 服务器：升级
sudo bash /opt/dsh-remote/deploy/linux/setup.sh --install-node --node-version 22.19.0

# 服务器：带门闸重启（别直接 systemctl restart）
sudo bash /opt/dsh-remote/deploy/linux/restart-kernel.sh --check   # 先看能不能安全重启
sudo bash /opt/dsh-remote/deploy/linux/restart-kernel.sh
```

> 🟢 **2026-09-27 更正：release 机制已投产**（原写"已入库 / 从未在任何服务器执行过"与"还没落地"**均已过期**）
> `deploy/linux/kernel-release.sh` 提供 `install` / `status` / `baseline` / `switch` / `verify` / `rollback`：
> 把内核装到 `/usr/local/dsh-release/<ver>/kernel`、用 `current` 软链**原子切换**、**旧版本原地存档**
> ⇒ **回滚 = 翻链接 + 重启**（秒级，不复制、不解包）。
> **实测现状**：`current = 0.1.5-rc.3`（`from = 0.1.5-rc.1`，`rollbackCount = 1`）；自研插件已随 release 快照，
> `@local/*` 解析到 release 内那份；`DSH_RUNTIME_ROOT` 指向的稳定 runtime 软链由脚本维护（`ensure_runtime_symlink`）。
> ⇒ 原文"`setup.sh ensure_kernel()` 仍装到 `npm root -g`；unit 的 `PATH` 与 `DSH_RUNTIME_ROOT` 也未按它改"
> **只在"未启用 release 模式"时成立**；启用后（`--release-root`）由本脚本接管（脚本内已含 unit/环境接线）。
> ⚠️ **仍未定项**：第三方插件（pnpm store 形态）与 `profiles/web/node_modules` 的归属（P-A/P-B/P-C）。
> 🔴 **另一条教训**：仓库这份与服务器 `/opt` 镜像**曾长期不一致** —— 实测**服务器那份才是旧的**
> （内容 = 固化 rc.3 钉点那次提交的**父提交**）；统一口径与对账工具见
> [`tools/mirror-audit.mjs`](../../tools/mirror-audit.mjs) 与 [部署窗口手册 W9](./2026-09-27-deploy-window-runbook.md)。
> 详见 [整包式设计 §②-8 / §②-10](../../docs/superpowers/plans/2026-09-26-manual-whole-package-kernel-upgrade-design.md)
> 与 [P6a 计划](../../docs/superpowers/plans/2026-09-26-p6a-versioned-kernel-and-auto-rollback.md)。
> 🔴 **实施它之前必须先 rsync**（服务器 `/opt/dsh-remote/deploy/linux/*` 是 **Sep-23 旧版**，见 P6a ⑦-4）。

### 16.2 ⚠️ 升级"不会丢"什么 / "会丢"什么（结论）

`setup.sh` **不碰** DSH_HOME 里的数据与配置（`settings.yaml` / `.credentials.yaml` / `.agent-presets/` /
`hotplug-manifest.yml` / `profiles/web/package.json` 的**非** `bundles`·`dependencies` 键 /
`profiles/web/cordis.patch.yml`），**也不碰** §8.6 的堆上限 drop-in（`setup.sh` 里没有 drop-in 步骤）。

✅ **"会丢的改动"已归零（2026-09-25）**：**`/opt/dsh-remote/plugins/dsh-adapter/dsh-bundle-patch.yml` 的 `resume.enabled: false` 已纳入版本控制**
—— 主仓 `plugins/dsh-adapter/dsh-bundle-patch.yml` 已改为 `false`（commit `866c1b3`）⇒ **rsync 现在推的就是同一语义值，不再回退**。
⚠️ 主仓与服务器副本的**整文件 `sha256` 仍不同**（服务器那份没有随本次新增的注释）；**语义一致**。
⇒ §16.3 的第 6 项从"每次重施加"变成"幂等核对"（详见
[Runbook §10](../../docs/superpowers/plans/2026-09-25-dsh-upgrade-runbook.md)）。

### 16.3 升级后必查（最小集；完整清单见 Runbook §5.4）

```bash
# 1) 版本与依赖树形状（形状不对 ⇒ 内核会 crash-loop，而探针可能全绿）
node -e 'console.log(require("/usr/local/node-v22.19.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/package.json").version)'
ls /usr/local/node-v22.19.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai 2>/dev/null | wc -l   # 期望 0

# 2) 堆上限 + cgroup 护栏 drop-in 仍在且生效
systemctl show dsh-kernel -p Environment | tr ' ' '\n' | grep NODE_OPTIONS   # 期望 …--max-old-space-size=1200
systemctl show dsh-kernel -p MemoryHigh -p MemoryMax                         # 期望 1415577600 / 1572864000

# 3) 综合探针（从内核重启算起 ≥90 s 再跑）
sudo bash /opt/dsh-remote/deploy/linux/check-ready.sh

# 4) 白名单 15 条全挂上（自研 11 + 第三方 4）
node /opt/dsh-remote/server/scripts/report-hotplug-mounts.mjs /srv/dsh-home

# 5) 🔴 我们的 patch 层"匹配上了"吗（row id 被上游改名会**静默失效**）
journalctl -u dsh-kernel --since '-30 min' --no-pager | grep -E "patch: (entry|insert|name)"   # 期望：无输出
#    依据：loader 的补丁语义对"匹配不到"只 warn + 跳过（不是报错）⇒ 不查这条 = 我们的"下线"可能早失效了

# 6) resume 开关（盘上 + 运行期都要看：盘上对了 ≠ 已生效）
grep -n -A2 '^\s*resume:' /opt/dsh-remote/plugins/dsh-adapter/dsh-bundle-patch.yml    # 期望 enabled: false
tail -5 /srv/dsh-home/dsh-adapter-apply.log | grep -i RESUME                          # 期望不再出现 enabled=true

# 7) 前端就位（缺了只有浏览器 404，其余探针全绿）
ls -l /opt/dsh-remote/client/web/index.html /opt/dsh-remote/client/web/auth/login.html

# 8) 跨过一个启动窗口仍不 OOM（内核重启 + 150 s 之后再看）
systemctl show dsh-kernel -p NRestarts --value                                          # 期望 0
journalctl -u dsh-kernel --since '-10 min' --no-pager | grep -c 'Reached heap limit'    # 期望 0
```

### 16.4 升级前必做（3 条闸门 + 1 份台账）

0. 🔴 **逐行过"本地改动台账"**：[docs/superpowers/plans/2026-09-25-local-change-ledger.md](../../docs/superpowers/plans/2026-09-25-local-change-ledger.md)
   —— 它登记了**每条改动的元信息**（元功能 / 配置载体 / 目的 / **升级失效风险** / **升级后重新评估要点** / 回滚）。
   ⚠️ **升级时对台账每一行"个别分析"**（问：元功能还在吗、语义变了吗、我的值还有效吗、目的还成立吗），
   **不要照抄旧值** —— "已入库 + 升级后校验"只对**当前升级方式**有效，上游**破坏性更新**会让这套前提失效。
1. **兼容性门禁**：`cd /opt/dsh-remote && node plugins/dsh-adapter/tools/compat-intersect.mjs`（**退出码 0 才继续**；离线加 `--offline`）。
2. **前端门禁**：本机 `Test-Path client\web\index.html` 必须为 `True`（否则 rsync 会删掉服务器前端）。
3. **安全重启门禁**：`restart-kernel.sh --check` 退出码为 `0`（`2`=有在飞工作；`3`=取不到判定，两者都**不放行**）。
4. **sha256 台账 + 备份**：Runbook §5.1 有可直接粘贴的脚本（`/etc`、`DSH_HOME` 的 4 个配置文件、`hotplug-manifest.yml`、
   `profiles/web/{package.json,cordis.patch.yml}`、`唤醒配置.json`、`dsh-bundle-patch.yml`、`/opt/dsh-remote/{server,client}`）。

### 16.5 关于"下线原生插件"（如果要走这条路）

- **落点**：`<DSH_HOME>/profiles/web/cordis.patch.yml`（**当前不存在**）。它在 `DSH_HOME` 内、由内核**只在缺失时创建**、
  `setup.sh` **完全不碰** ⇒ **升级与 rsync 都不会动它**，是"升级免疫"的载体。
  写法 = 官方补丁行：`- id: <rowId>` + `disabled: true`（**不是**改 config —— 上游明文 *"config cannot disable a row"*）。
- **能关 / 不能关**：先按 Runbook §2.2 的判据分类。**不要关**核心行（`session` / `storage*` / `llm` / `agent` /
  `session-persistence-jsonl` / `session-query-sqlite` / `hmr` / `timer` / `webserver` …）；
  **可以关**的典型是"上游自己就关过"的行（`skill-badge`、`ui-schedule`），以及**有官方 env 开关**的行
  （遥测：`/etc/dsh-remote.env` 里写 `DSH_TELEMETRY_DISABLED=1`）。
- ⚠️ **改任何 row 前先起影子 profile 验证**（Runbook §5.5；影子实例只做只读，**严禁** `load`/`resume` 活跃会话）。
- ⚠️ **升级后必须复验"补丁行还匹配得上"**（即上面的第 5 项）—— 这是"升级后问题复现"最可能的路径。

### 16.6 回滚

| 回滚对象 | 动作 |
|---|---|
| 内核版本（**现状：原地覆盖式**，当前唯一可用） | 改回 `DSH_VERSION`/`NPM_BEFORE_DEFAULT` → 重跑 `setup.sh` → `restart-kernel.sh`。⚠️ `setup.sh` 只换 `node_modules`，**DSH_HOME 不动 ⇒ 会话不丢**；但**跨版本回读旧会话的兼容性至今未验**（本文 §14）⇒ 回滚后**必须抽样打开几个旧会话** |
| 内核版本（🟡 **将来：翻链式**，见 §16.1 的插入块；**尚未落地**） | `deploy/linux/kernel-release.sh rollback`（或 `switch <旧版本>`）。🔴 **若新版本根本起不来 ⇒ 必须用 `restart-kernel.sh --force`**：门闸端点 `/adapter/api/resume/gate` 住在**内核进程里**（`@local/dsh-adapter`），新包起不来时它**也不可用**，正常路径会 **`exit 3` 拒绝重启**（⚠️ **本条此前本 §16.6 与 Runbook §5.6 都缺**，由 P6a 计划 ⑦-1 新指出；`kernel-release.sh rollback` 已把它固化）。⚠️ 回滚**只翻符号链接 + 重启**：绝不动 `DSH_HOME`、绝不迁移数据、绝不删版本目录；**且回滚前必须先判"数据是否已被新版写过"**（有 ⇒ 停下交人，见 §16.1 插入块的设计指针） |
| 我们的 patch 层 | 改/删 `cordis.patch.yml`（`patchReload: live` ⇒ 通常**热生效**，不必重启） |
| 网关 / 前端 | 从升级前备份还原（`/opt/dsh-remote/{server,client}`），前端还原后刷新浏览器 |
| `resume.enabled` | 改回 `true` → 重启（会把内存命中最重的那一轮放回来，慎用） |
| 整机 | 云主机快照回滚 |

> ⚠️ **2026-09-26 补记（三条）**：① **`--force` 这一条**是现有文档的缺口（P6a 计划 ⑦-1 指出）；② **版本化目录尚未落地** ⇒ 上表**第一行仍是当前唯一可用**的回滚路径；③ 走翻链式回滚时，**白名单 `hotplug-manifest.yml` 不随包回**（用户已定"不进包、不切"）⇒ 若新 release 曾**加过**插件，回滚后要用 **hotplug API** 把多余条目 `enabled:false` / remove，**不要手改文件**（文件头注写明 `do not edit while dsh running`）。

## 17. release 所有权一次性迁移（**🔴 尚未在任何真机上执行**）

> **性质**：本节是**手册**，不是记录 —— 迁移**一次都没执行过**。
> 依据：[release 所有权迁移设计](../../docs/superpowers/specs/2026-09-26-release-ownership-migration-design.md)（§7 / §8）；
> 影子验证证据：`deploy/linux/tests/rel-own/`（夹具 A/B/C + 源码扫描，**每次升级都要重跑**）。
> **执行前置（三条，任一不满足就不许开工）**：
> 1. `bash deploy/linux/tests/rel-own/run-all.sh` **全绿**（= A-1…A-5 / B-1…B-6 / C-1…C-5 / S-1…S-2 全过）；
> 2. `deploy/linux/setup.sh` 与 `server/scripts/setup.mjs` 已在服务器上更新（含「删除陈旧 `@local` 链接」与 `DSH_PLUGINS_DIR` 两处，**必须先 rsync**）；
> 3. 选一个**没人用**的窗口（步骤 3+4+5 ≈ 8 s 停机 + 约 90 s 就绪；367 MiB 拷贝可在停机前完成）。

### 17.1 一次性迁移要做的两件事

| 事项 | 改前 | 改后 |
|---|---|---|
| **事项 1** `@local/*` | `/srv/dsh-home/profiles/web/node_modules/@local/<n>` → `/opt/dsh-remote/plugins/<n>`（**staging**） | → `/usr/local/dsh-release/current/plugins/<n>`（**release**） |
| **事项 2** P-A | `DSH_HOME/profiles/web/node_modules` = **实体目录**（367 MiB） | → **软链** → `/usr/local/dsh-release/current/profile/node_modules` |

⇒ 两件合起来：**翻 `current` 一个链接 = 内核 + 自研插件 + 4 个第三方同时切换（真原子）**。

### 17.2 执行顺序（**写死，不许调换**）

```bash
# 0) 门闸（exit 0 才继续；2 = 有在飞不切；3 = 取不到判定 fail-closed）
sudo bash /opt/dsh-remote/deploy/linux/restart-kernel.sh --check

# 1..6) 一条命令走完（**默认 dry-run**：只打印将要执行的全部动作）
#        确认打印内容无误后，加 --apply --accept-data-risk 才动手
sudo bash /opt/dsh-remote/deploy/linux/release-ownership-migrate.sh --version 0.1.5-rc.1                 # 先看
sudo bash /opt/dsh-remote/deploy/linux/release-ownership-migrate.sh --version 0.1.5-rc.1 --apply --accept-data-risk
```

脚本内部即 §7 的 0..6：**先放目录 ⇒ 再核对 ⇒ 再迁移 ⇒ 再翻链 ⇒ 再重启 ⇒ 再验**。
🔴 **绝不「先重启再翻链」**（那会造成"新内核进程配旧插件解析"的最坏组合）。

### 17.3 判据（迁移后 T+150 s 起跑）

| 栏 | 判据 | 通过标准 |
|---|---|---|
| **A 栏** | `bash /opt/dsh-remote/deploy/linux/kernel-release.sh verify --window 150` | H1…H5 + R 全过；其中 **A9**（涉及 release 路径的 fallback/权限错误）**0 条**、**A10**（`profiles/web/node_modules` 仍是软链且指向目标 release）必须 **✓**（P-A 已应用后不再 N/A） |
| **B/C 栏** | 整包式设计 §②-4(b) 的 B 栏 + C 栏（C1 12 条 `@local` 的 `readlink -f` == 目标 release；C3 `loaded=15 failed=0`；C5 无新增 `missing=[…]`） | 全过 |
| **夹具复跑** | `bash /opt/dsh-remote/deploy/linux/tests/rel-own/run-all.sh` | 全绿 |

🔴 **A9 + A10 任一不过 ⇒ 按"不通过"处理（走回滚），不许"接着用"** —— 那说明"只读快照"这条前提已不成立。

### 17.4 回滚

| 场景 | 动作 |
|---|---|
| 步骤 4 之后、重启之前发现问题 | 把 `current` 翻回旧版本（**未重启** ⇒ 影响面 = 只在跑的内核仍用旧解析） |
| 重启后 A9/A10 不过 | 🔴 **必须 `restart-kernel.sh --force`**：新版起不来时门闸端点 `/adapter/api/resume/gate` **也住在内核进程里** ⇒ 正常路径会 `exit 3` 拒绝重启 ⇒ **回滚在它最该生效的场景下卡住**。动作：翻回旧 `current` → `--force` 重启 |
| **迁移本身要撤**（回到"`@local` → `/opt`"旧形态） | 按 §17.2 的 3b **反向**重建链接（**遍历 `/opt/dsh-remote/plugins/*`**，不写死名字）+ 把 `profiles/web/node_modules` 改回**实体目录**（⚠️ 需从 release 拷回 367 MiB；`pre-PA-<时间戳>` 那份备份可直接 `mv` 回来） |
| 白名单 | **不随包回** ⇒ 回滚后若出现多余条目（`failed≠0` 或新增 `missing=[…]`），用 **hotplug API** 改（**不要手改文件**，文件头注写明 `do not edit while dsh running`） |
| 数据 | 🔴 **回滚绝不动数据**（`sessions/` / `storages/` / `settings.yaml` / `.credentials.yaml` 一律不碰） |

**审计**：迁移全程写 `<DSH_HOME>/logs/` 下的一次性记录（谁、何时、切了哪个版本、A9/A10 结果）。
