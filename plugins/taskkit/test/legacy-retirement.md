# 遗留插件退役清单与回滚策略

## 退役清单
- 灵感库面板（原 conversation.view id=inspiration）：由写作工作台「💡 灵感」子模块承接
- 创作资源面板（原 conversation.view id=crelib）：由写作工作台「📚 创作资源」子模块承接
- 写作成果面板（原 conversation.view id=writing）：由写作工作台「✍️ 写作」「📊 训练成果」子模块承接
- wrpro 独立写作面板：由写作工作台「✍️ 写作」子模块承接（若 wrpro 仍独立加载，可先保留 API，仅隐藏独立入口）

## 验证项
1. 写作工作台五子模块可切换且数据正确
2. 灵感条目可编辑、关联成果可点击
3. 训练/当日成果页字数/日程/草稿正确
4. 既有灵感库.json、写作记录.json、草稿/ 数据无丢失
5. 任务面板与创作教练会话联动正常

## 退役方式
- 动态卸载：在 client apply 中不再注册 inspiration/crelib/writing 三个 conversation.view（保留 taskboard）
- 静态移除：从 cordis.patch.yml 移除对应独立插件 id（如 wrpro）
- 若需逐步收敛：先隐藏旧入口，保留 API 与数据文件，观察 1-3 天无回归后再移除

## 回滚策略
- 代码回滚：恢复 client.js 中旧 view 注册块
- 插件回滚：从 cordis.patch.yml 重新加入 wrpro/taskkit 旧版本
- 数据安全：所有数据文件均在工作区，退役不删除数据；仅移除 UI 入口
