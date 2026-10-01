# 给训练工作线的适配提示词 · 客户端 v1.7.6

以下可整段交给训练开发模型。

请将训练场适配到客户端 v1.7.6 最新规则和回放实现。先阅读 AGENTS.md、README.md、docs/README.md，使用独立训练 worktree，不在整合目录或客户端目录修改，不启动长期训练。

## 源码基线

先 fetch origin 并检查最新 main。2026-10-01 核对时 main 为5157abd，已合入客户端平衡v2.1（351173a）、联机导出（1bf265d）、统一历史存档（58f4526），也含训练导出分支及 trainingScene.ts 的征召 regions 修复。客户端分支 codex/client-balance-v2-1 的 a06804d、c5b3da4 是后续图鉴布局和编号，不应覆盖 main 的训练修改。优先在最新 main 上整合尚未合入的客户端差异。记录实际采用的源码 SHA；合并后重新构建，不复制另一分支的旧构建指纹冒充当前构建。

本说明文件所在提交只增加交接资料，不改变规则。客户端应用版本始终为1.7.6。

## 正式规则与课程同步

1. 按 docs/training/SYNC-LOG.md，从训练端上次冻结的提交开始检查实际差异，不只看版本号或提交标题。依次阅读 docs/rules-v1.7.2.md、docs/rules-v1.7.3.md、docs/balance-v2.1.md，逐项说明课程是否涉及、是否沿用冻结覆盖、实现和测试位置。
2. 特别核对：父子响应窗口关闭、英美调度中法空军、完整检索不洗牌、洗回单牌随机插入、意大利雄心保序、马耳他没有海军时只能弃牌；以及v2.1全部卡表/效果/触发时点/中立变化。文本不能代替代码落实。
3. 新美国事件 special_260（罗斯福成立生产管理部）已加入正式平衡牌库。课程白名单、初始资源数、事件计数和编码若受影响应明确更新并升课程/编码版本；不能在冻结旧实验中静默加牌。新牌及随机调用变化会影响同种子的结果，不能声称新旧轨迹相同。
4. 现有课程的明确冻结差异继续按课程配置执行。与最新正式规则冲突时说明并询问，不擅自覆盖已裁定课程，也不把训练简化反向写进正式引擎。保持费用、真实选择、响应链及观察隐藏信息。训练优化实现以固定输入逐步差分验证。
5. 此次图鉴新编号如 DE-R001、UK-P001 仅为展示索引，按规则模式可能不同。代码、训练动作、卡表定义、存档回放继续使用原 definitionId（如 build_army、special_260、prelude_UK-10），实例ID另行保持唯一。不要用R/P编号替换策略动作索引或文件definitionId。对应表为 docs/cards/balanced-ids.json、standard-ids.json；实现为 src/ui/cardNumbers.ts。图鉴排序不影响真实牌库及PRNG。

## 回放适配

不要因为应用升级自行创建新格式。当前正式对局仍为 quartermaster-match-log / formatVersion=3 / recordingModel=action_replay，契约 src/actionReplay/contract.ts、规范 docs/match-log-spec-v2.0.md。v1.7.4统一历史存档改变了存档入口和记录组封口：换国家关闭上一组，回放按afterHash对应的命令边界停止；没有修改训练场面文件schema。不再使用旧formatVersion=2协议。

训练记录仍用已实现的专用契约：
- docs/training-replay-output-v1.md
- src/actionReplay/trainingContract.ts、trainingCodec.ts、trainingScene.ts
- formatVersion=3，mode=resource_pool，recordingModel=scene_actions
- replayAdapter={id:'quartermaster-training-scene',version:'1.0.0'}

gameVersion是训练参考版本元数据，不要求与客户端一致；producer.version单独保存。sceneEngineFingerprint必须来自真实匹配构建（当前实现由src/actionReplay/state.ts的ENGINE提供，并由trainingCodec校验），不能直接改字符串蒙混通过。公开文档中的SCENE_ENGINE_FINGERPRINT叫法不意味着可以硬编码旧值。以运行时实际接口为准。

卡表由文件提供，使用内部稳定definitionId。费用、选择和所有实际子效果由训练端显式展开；cardId仅表示来源，不自动扣牌或入弃牌。hand/drawPile/discardPile/resourcePool是独立展示库，允许信息缺失、跨库重复实例、set全量以及add/remove/move增量；不得从游戏出牌行为猜资源移动。各库内部不重复，操作和可见性按类型契约验证。

board调用支持的场面规则计算，score/remove/supply/status写实际裁定的显式操作，不重复生成卡牌触发链。seat（决策国）、activeSeat（回合国）、country（部队国）严格区分。顺序、sceneHash、seq、end/contentHash按现有codec生成校验，不解析中文日志还原。

当前训练适配器不支持序章/中立场面、任意规则覆盖或自定义兵模上限；ruleOverrides必须为空，能力按实际声明，未知结构须拒绝。课程与适配器场面规则不同就明确登记不支持或提出版本化扩展，不能假定configuration会自动驱动规则。本次没有新schema要求，优先复用main中已有训练导出器，不另造并行格式。

## 验证与交付

核对最新main已有训练导出实现和真实样例进度。客户端此前交付只验收了构造训练样例；不要把普通局/构造样例测试声称为真实A/B联调完成。请用短测生成A/B真实完整文件，验证开局、回合外响应、费用、额外出牌、多子效果、四牌区独立变动、六国视角及文件校验。真实文件不得随意提交公共仓库，使用无私人数据的明确测试样例。

运行相关规则/训练/回放差分和回归测试，报告源码SHA、规则/场面/牌表指纹、课程/观察/动作版本、已支持和未支持范围。更新SYNC-LOG，提交聚焦PR。交付短测与联调结果；未经另行授权不启动长期PPO训练、不改正在运行实验的依赖、不自动迁移旧检查点。
