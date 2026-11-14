---
name: workspace-inventory-audit
description: 在未知或可疑工作区中系统盘点目录、文件、版本控制状态与目标板，识别临时/异常文件并记录证据。
---

## 流程
1. 用 list_dir 列出工作区根目录，记录所有目录 [D] 与文件 [F]，重点标记隐藏目录（如 .github、.ppx）和临时/异常文件（如 .tmp-*、tmp-*.js、tmp-write-check.txt、audit-hmac-key）。
2. 对每个子目录递归调用 list_dir，建立完整文件清单；对可疑目录（如 .ppxtest）同样展开。
3. 用 git_status 检查是否处于 git 仓库；若报错“未找到 .git”，记录为非 git 工作区。
4. 用 git_log 获取提交历史；若无提交则记录空历史。
5. 用 replay_session 检查是否有可回放的历史会话，记录有无。
6. 用 goal_board 读取目标板，记录目标数量与内容。
7. 用 memory_search 检索相关记忆，记录匹配结果。
8. 用 plan_files 写入任务计划与发现（task_plan、findings、progress），汇总盘点结果。
9. 将临时/异常文件与正常项目文件分类，形成审计结论。

## 验证
- 提供根目录及所有子目录的 list_dir 输出清单。
- 提供 git_status、git_log 的原始返回（含错误信息）。
- 提供 goal_board 与 memory_search 的结果。
- 提供 plan_files 中写入的 findings 摘要，明确列出临时/异常文件及非 git 工作区结论。