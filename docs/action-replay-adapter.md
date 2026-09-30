# 标准动作回放适配器 v2.0.0

应用 v1.7.1；协议 formatVersion=3。实现入口为 src/actionReplay。只允许 codec.ts 白名单中的命令，输入不接受任意代码；恢复由同版本本地规则引擎执行，不从中文日志推断。

Snapshot.ruleState 是现行 GameState 的可恢复规则子集：revision/观看座位归一化；只保留影响规则的 UNIT_PLACED 历史，重映射军备安装位置；不保留 publicLog、trace、累计通知、Session 或旧回放。单位稳定创建计数 unitSerial 与 randomState 保留。待取消的 guided 操作通过 rollbackPatches 保存相对当前规则状态的结构差异，不能嵌套整局历史快照；pendingRevealNotices 仅保留当前翻牌屏障所需通知，非累计历史。

resourcePool 固定为六个 SeatId 到 CardInstance[] 的映射，标准对局全程为空。只读恢复将该字段交给 MapPanels.replayPoolCards，显示方式与牌库相同；未来训练适配器还须定义其私有知识过滤，当前不得向此标准适配器输入非空资源池。

选择锚点使用卡实例、父效果路径、时点和出现次数，不依赖临时窗口 ID。可选 TRIGGER 空选择按默认跳过，其余选择均显式保留。响应/额外打牌为嵌套 action。shuffle 提供洗后完整实例顺序及 randomStreamAfter.randomState；重演检查实例集合、锚点、顺序及恰好消费一次。

文件只保留 start、formal_start 和 round_end 完整检查点。回放引擎短暂停在核心钩子处，再用 CONTINUE_BOUNDARY 恢复；界面子效果通过重演时的结构化事实边界临时定位，不逐效果存盘。播放器最多缓存三个已完成动作组，当前选中节点单独显示。

GM 编辑当前采用新 snapshot 会话；未实现任意 GM 修改的通用编辑增量。导入拒绝旧协议、未知适配器、训练模式、错误版本/指纹和损坏摘要。原 src/matchLog 只供历史测试及资料参考。
