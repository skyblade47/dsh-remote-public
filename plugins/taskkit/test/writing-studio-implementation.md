# 全能写作工作台实施记录

- 统一入口：conversation.view id=writing-studio, label=写作工作台, order=0
- 子模块：写作 / 灵感 / 创作资源 / 训练成果 / 任务 / 关联
- 关联 API：/taskkit/api/relations/list、/taskkit/api/relations/update
- 关联数据：D:\DSH工作区\写作训练\草稿\relations.json
- 兼容：保留 inspiration/crelib/taskboard/writing 既有页签与 API
- 验证：sandbox_reload 成功，corrupted=false
