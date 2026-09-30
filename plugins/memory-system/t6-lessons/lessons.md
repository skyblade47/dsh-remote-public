# T6 经验总结：记忆强调双轨（memory_pin/memory_exclude）全链 lessons

- 执行成员：summarizer（经验总结）
- 依据：t1 设计（行号核实）→ t2 方案检查（verdict=pass）→ t3 实施（27/27）→ t4 成果测试（63/63 + live 冒烟）→ t5 检查测试（63/63 独立复跑 + 重启装配验证）
- 权威源：`E:\DSH工作区\DSH工具\静态化\memory-system\lib\index.js`；部署副本：`E:\DeepSeek-Harness-1.0.0-portable\dsh-data\profiles\web\node_modules\@local\memory-system\lib\index.js`
- 日期：2026-09-01

---

## 〇、交付：分号分隔 lessons（t7 文档更新直接引用）

pinned 置顶依赖 PINNED_BONUS 量级实证：常规候选分上限=关键词100+状态40+memoryScore25≈165，PINNED_BONUS=10000 落在「一切常规候选之上、当前目标任务保底 100000 之下」，量级错位会压过目标任务或与常规分纠缠；pinned 加分必须加在 memoryScore 累加之后、排序之前，语义是排序优先级变化而非扩容，BUDGET 主载5+回溯20 硬上限不变，6 个 pinned 只占 5 个主载位；不衰减实现为 memoryScore decay 判定扩成 (pinned||important)?1:exp，不改函数签名，但 memoryScore 被 buildContext 与 retireScan 共用，共享函数单处修改多路径生效是双刃剑，改前必须枚举全部调用方；「不衰减」≠「不退役」，低内容 pinned（importance=0、raw≈0.03 < minScore 0.15）单靠 decay=1 分数仍低于退役线，分数保护 + retireScan 显式 skip pinned 必须双保险；跨项目 project 过滤须豁免 pinned（人工轨>自动轨），豁免只给 pinned 不给 excluded；excluded 必须覆盖全部枚举路径，主载候选循环之外依赖回溯 backtrackSummaries 原本无排除点（readSummary 后直接 push），漏掉会让 excluded 记忆经依赖链泄漏回上下文；目标任务自身 excluded 仍须入载（F2 保底），排除判定须带 task_id 自身豁免；exclude=不注入≠不删除，memory_search 直读目录不改显式检索仍命中，excluded 不豁免退役，语义边界必须成文防误判为缺陷；pin/exclude 互斥双向（pin 清 excluded、exclude 清 pinned），布尔 false=unpin/unexclude，恢复后重新入载，不存在任务 404 无幻写；additive 零破坏靠可选字段缺省 falsy，存量空库（仅 .gitkeep）实测无标记 L1 天然未强调零迁移，存量兼容必须实测不能只靠推理；标记写回只写 pinned/excluded 键（Object.assign 浅合并）且走 writeJson 自动失效缓存，L1 内容字段快照比对零破坏；写回目标按 readSummary 三级优先级（longterm→drafts→cold）落盘，否则 force-close 后草稿不继承标记；L1「不可修改」教义与 additive 写回有张力，改代码必须同步改文件头教义、工具清单（「10 个」→「13 个」）、actions 列表注释；契约零破坏用双基线交叉：harness BASELINE_PARAMS 13 工具参数集 + 改动前技术文档基线逐项吻合，handleAction 11 原 action 只追加不改，11 原工具逐个 execute 冒烟；静态门槛=双副本 SHA256 一致 + node --check 双过，重启自动加载须验证装配链（package.json file: 依赖 + cordis.patch.yml insert），live HTTP 冒烟（pin 缺 taskId→400 证路由生效）；部署大坑=双副本磁盘文件已是新代码≠进程生效，live pin→404「未知 action: pin」是进程未热更的信号，须 sandbox_reload（方案C bust=true）后路由才生效，重启后 ESM 缓存全新则自动加载新代码；hermetic 测试数据根必须放系统临时目录，TEMP_ROOT 放工作区会导致 fsMock 二次映射种子不可见（复跑 34/63 假失败）；证据链一致性纪律=落盘证据必须与最终断言一致且版本受控，t4 results.json(62/63 旧版产物) 与 README 声称 63/63 自相矛盾、harness.mjs 被改坏不可复跑，复跑结果必须与落盘证据同步归档；双副本同步靠人工拷贝非符号链接，同步流程须文档化（改一处→拷贝→SHA256 校验）防未来漂移。

---

## 一、pinned 置顶与排序公式交互（重点沉淀 1）

1. **量级必须实证，不能想当然**：T2 把 PINNED_BONUS 从「想当然合理」落到实证——scoreEntry 上限 100（L322）+ 状态权重 40（L54×10）+ memoryScore 上限 25（0.5×50）→ 常规 ≤165 < 10000 < taskId 保底 100000（L615）。量级错位两个方向都危险：过小（<165）与常规分纠缠排位不稳定；过大（>100000）会压过当前目标任务保底，造成自噬上下文。
2. **加分位置**：`if (s.pinned) score += PINNED_BONUS` 必须放在 memoryScore 累加（L624-626）之后、排序（L629）之前；与 taskId 保底 100000 天然不冲突。
3. **不衰减的实现点与副作用面**：decay 判定（L532-544）扩为 `decay = (pinned || important) ? 1 : Math.exp(...)`，不改函数签名。但 memoryScore 被 buildContext（load 排序）与 retireScan（退役判定）**共用**——单处修改多路径生效是双刃剑：好处是 pinned 分数天然不降，风险是任何改动同时影响两个语义面，改前必须枚举全部调用方并分别验收。
4. **「不衰减」≠「不退役」（双保险铁律）**：实测低内容 pinned（importance=0、无消息 → raw≈0.03）decay=1 后分数仍只有 0.09 < minScore 0.15，单靠分数保护会被 retireScan 误判退役；必须在看门狗候选判定处**显式 skip pinned**（L1159）。分数保护与显式跳过缺一不可。
5. **人工轨 > 自动轨**：跨项目 project 过滤（L611）须豁免 pinned（`!s.pinned` 时 continue），人工强调优先于自动项目隔离；豁免只给 pinned，excluded 仍受项目过滤约束。

## 二、excluded 与枚举路径（重点沉淀 2）

6. **枚举路径穷举**：excluded 的「跳过」必须覆盖记忆进入上下文的全部路径——① 主载候选循环（L612 failed 过滤后）；② 依赖回溯 backtrackSummaries（L470-491，原实现 readSummary 后直接 push，**原本无排除点**，是设计缺口）。实测 t-dep→t-excluded-dep 依赖链不泄漏。
7. **目标任务自身豁免（F2 保底）**：排除判定须 `s.task_id !== t` 才跳过，否则当前任务自身被 excluded 后直接失去上下文；此保底与 load 的 taskId 保底 100000 语义一致。
8. **语义边界成文**：exclude=不注入≠不删除——memory_search 直读目录无标记过滤，显式检索仍命中（对齐 mobius session_excluded_memories「排除=不自动注入」）；excluded **不豁免退役**（retireScan 不 skip excluded）。这两条有意决策必须写进文档，防后续被误判为缺陷。
9. **互斥与幂等**：pin/exclude 互斥双向（pin 清 excluded、exclude 清 pinned）；布尔 false=unpin/unexclude，恢复后重新入载；不存在任务 404 无幻写；重复调用幂等。

## 三、additive 字段零破坏（重点沉淀 3）

10. **缺省 falsy 天然兼容**：pinned/excluded 为 L1 摘要文件可选字段，缺省=未强调；存量 longterm/tasks、drafts 实测仅 .gitkeep（空库）——存量兼容必须靠空库/缺字段实测确认，不能只靠推理。零迁移。
11. **只写强调字段**：patchSummaryFlag = `Object.assign({}, l1, patch)`，patch 仅含 pinned/excluded 键，L1 内容字段快照比对零破坏；写路径走 writeJson（L125-131 自动失效缓存），无缓存一致性问题。
12. **写回优先级**：标记写回按 readSummary 三级优先级（L206-214：longterm → drafts → cold）落盘，否则 force-close 后草稿不继承标记。
13. **教义与代码同步**：L1「不可修改」教义与 additive 写回存在张力；工具清单注释「10 个」已过时（现 13 个）、actions 列表（L1410）必须随 T3 同步更新——文档/注释与代码脱节是真实踩过的坑。

## 四、契约零破坏验证方法（重点沉淀 4）

14. **双基线交叉**：a) harness BASELINE_PARAMS（13 工具参数集逐一比对）；b) 改动前技术文档基线（writing-coach_第五批_技术文档.md L212 列出的 11 原工具签名）逐项吻合。两源交叉 + handleAction 11 原 action 只追加不改（不 modify 既有 case）+ 11 原工具逐个 execute 冒烟 = 三层证据。
15. **静态门槛**：双副本 SHA256 一致（实测 7003B318...）+ `node --check` 双过；注册工具数从 11 → 13（新增 memory_pin/memory_exclude 均 taskId 必填）。
16. **重启自动加载验证**：装配链 = profile package.json `file:` 依赖 + 包内 cordis.patch.yml insert；重启后 ESM 缓存全新 → 13 工具自动注册，无需 sandbox_reload。live HTTP 冒烟（pin 缺 taskId → 400「缺少 taskId」而非 404「未知 action」）证路由生效。

## 五、横切踩坑（部署/测试/证据链）

17. **磁盘文件 ≠ 进程生效**（本链最大部署坑）：双副本文件已是新代码但 live 进程仍跑旧代码，pin → 404「未知 action: pin」；必须 `sandbox_reload`（方案C bust=true）后路由才生效。上线排查第一顺序：先确认进程是否热更，再查代码。
18. **hermetic 数据根位置**：测试数据根必须放系统临时目录（自动重置、零真实数据污染）；TEMP_ROOT 误放工作区会导致 fsMock 二次映射（对已解析绝对路径再加前缀）→ 种子文件不可见 → 复跑 34/63 假失败（T4 harness 缺陷，T5 修复后 63/63 三次确定性复跑）。
19. **证据链一致性纪律**：落盘证据必须与最终断言一致且版本受控——t4-verify 的 results.json（62/63 旧版产物）与 README 声称 63/63 自相矛盾、harness.mjs 被改坏不可复跑，暴露「证据工件需重跑归档、复跑结果与落盘同步」纪律；测试后清理（longterm/drafts 仅剩 .gitkeep、stats 复原）也是零污染验收的一部分。
20. **双副本同步流程**：部署副本为真实拷贝非符号链接，同步靠人工拷贝——须文档化「改一处→拷贝→SHA256 校验」流程，防未来漂移（T5 F2 advisory）。

## 六、给 t7 文档更新的提示

- 技术文档需新增：memory_pin/memory_exclude 两工具契约（taskId 必填）、pinned/excluded 语义表（置顶+不衰减+跨项目豁免 / 不注入+可检索+不豁免退役）、PINNED_BONUS 量级依据、双保险退役规则、13 工具清单替换原「10 个」注释基线。
- 建议将本文档「〇、交付」段的分号 lessons 原样纳入文档章节或附录；本文件路径供文档引用：`静态化/memory-system/t6-lessons/lessons.md`。
- 已知遗留 advisory 一并写入：F1（t4 证据重出建议用 harness-run.mjs）、F2（双副本同步流程文档化）。
