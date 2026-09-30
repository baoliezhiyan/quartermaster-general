# 基础牌 AI 训练场

这是一套无界面的程序接口，复用当前游戏引擎的地图、补给、建设、战斗、计分和终局规则。训练场只保留四种基本牌：建设陆军、发起陆战、建设海军、发起海战。不启用序章和中立规则，启用已实现的平衡补丁。

当前课程采用有限总资源池。每国开局拥有该国四类基本牌的全部数量；打出一张后永久消耗一张。没有起手 12 选 7、手牌上限、抽牌和主动弃牌决策。保留正式游戏的回合、补给、计分、20 轮结束，以及美国回合结束时分差达到 30 分的胜利判断。主动不出牌沿用正式规则扣 1 分。手牌作为核心引擎中的资源容器使用，但观察接口称其为资源池。

意大利平衡补丁后的数量已包含：建设海军 5 张、发起海战 3 张，陆军兵模总上限 5 支。其他国家的基本牌数量取自 `src/core/basic.ts` 中的 `BASIC_COUNTS`。四类之外的空中力量、事件、状态、响应及军备均不会放进训练场资源池。地图上的法国和中国部队、英国与美国对其计分和操控的核心规则保持原引擎行为。

## 程序接口

从 `src/training/basicArena.ts` 导入 `BasicTrainingArena`：

```ts
const arena = new BasicTrainingArena(1940, 'experiment-1', { trace: 'none' });
while (!arena.done) {
  const observation = arena.observe()!;
  const selectedId = policy(observation); // 必须选 observation.candidates 中的 id
  const { observation: next, result, info } = arena.step({ ...observation.decision, actionId: selectedId });
  trainOnTransition(observation, selectedId, info, next);
}
save(arena.result);
```

`observe()` 只在需要决策时返回观察；对局结束后返回 `null`。观察包含当前国家、阵营、轮次、分数、部队、补给、各国剩余四类资源，以及当前合法候选动作。训练场自动执行无需选择的阶段；一次 `step()` 通常推进到下一国家的出牌决策点。候选分为 `play` 和 `pass`；可用同一个策略接口接入随机策略、评分策略或神经网络。

每个候选 `play` 的语义 `id` 由基本牌类型与引擎合法选项构成，包含目标、进攻来源和具体目标部队。当前资源池中同类型牌实例效果完全相同，故只返回每类牌的一份候选。语义 ID 可能跨回合重复，必须连同本次观察的 `decision` 一起提交。观察按决策缓存并冻结，策略应当只读。

`step()` 校验观察中 `decision` 的 episodeId、gameId、decisionId、revision 和动作 ID；过期、重复或跨对局提交会抛错且不改变局面。任何 `trace` 档位都返回固定的轻量 `info`：起止决策、跨过的国家回合数、双方及各国得分变化、终止状态和胜方。`result.termination` 区分自然结束与训练截断；引擎故障仍抛错，不算败局。`playTrainingGame(seed, policy)` 是同步整局辅助函数，到达决策上限会正常截断。

构造选项 `trace` 为 `none`（默认，训练用）、`summary`（紧凑记录）或 `full`（完整行动前后快照与事件）。`keepRecords` 默认关闭；需要整局明细时可设 `{ trace: 'full', keepRecords: true }`。`exportSnapshot()` 保存完整可信本地状态；恢复时必须传当前构建的 SHA-256 指纹，例如 `BasicTrainingArena.fromSnapshot(snapshot, { buildFingerprint: currentBuildFingerprint })`。指纹缺失或与快照不一致即拒绝恢复，不能把旧构建身份当作新构建。正式实验创建时设 `requireBuildFingerprint: true`；命令行已启用它。直接调用类而未指定指纹的开发局标为 `unspecified`，不能用于正式实验存档。

`truncate(reason)` 拒绝空白原因，并在 `result.finalObservation` 保留截断前的最后一次可决策观察。`observe()` 在截断后返回 `null`。`truncated` 与自然终局不同，训练器可按算法决定是否从 `finalObservation` 做价值估计，不应机械地把截断当作零价值终局。奖励塑形仍由训练代码单独决定。

`TRAINING_REGIONS`、`TRAINING_MAP_TOPOLOGY` 和 `TRAINING_COUNTRIES` 提供地区、大本营、固定邻接、海峡及八个国家的静态资料。`effectiveUnitTotal` 是平衡后兵模总上限，观察的 `availableUnitReserve` 是扣除场上兵后的可用数：意大利陆军上限 5，开局已有 1 支，可用 4。海峡是否通行仍受局内控制权影响。接口不传图片、不要求模型解析卡面文字。

## 导出记录

命令示例：

```powershell
node scripts/run-basic-training.mjs --games 10 --seed 1940 --trace full --out outputs/ai-training-records.jsonl
```

也可运行 `pnpm training:basic --games 10 --seed 1940 --out outputs/ai-training-records.jsonl`。默认 `--policy uniform` 从所有合法候选（包括不出牌）中等概率选择；`--policy biased` 按有效攻击、补给点建设和资源余量等简单权重抽样，始终保留全部合法动作的探索概率。两者都不是训练好的 AI。

如需每局资源与性能指标，增加 `--metrics-out outputs/ai-training-metrics.json`。`--trace none` 不生成逐步诊断记录，`summary` 生成紧凑摘要，`full`（命令行默认）生成完整记录。`--max-decisions` 到达后写入截断结果，胜方为 `null`。指标包含资源消耗与剩余、主动不出牌次数、空目标攻击和重复建设次数、局内耗时、进程 CPU 时间、进程内存峰值和整机使用率。局内耗时不含 Vite 打包；整机指标包含其他程序的占用。

输出为 UTF-8 JSONL，每行一个 JSON 对象。**每局的第一行 `recordType` 固定为 `AI训练记录`**，写入训练格式、课程版本、配置哈希、打包后代码的 SHA-256 指纹、策略身份和种子、规则开关、资源池数量及地图版本。`full` 档每次选择写一行 `decision`，记录国家、目标、起止上下文、收益、前后资源与部队、关键事件及公开记录；`summary` 仅写摘要；`none` 只写开头和结果。该局最后一行 `result` 包含自然终局或截断标记。多局按 `episodeId` 分局。

完整记录逐步流式写盘，含自动阶段事件，可用于日后可视化。当前有限资源池全公开：每国资源数量由公开初值和已打出的牌推导。以后若加入隐藏手牌，必须建立按座位的信息权限投影与测试，不能直接复用当前观察。

## 边界与后续扩展

本版只验证四类基本牌课程，没有实现强化学习网络、奖励塑形、连携残局或真实手牌；偏置随机基线仅用于比完全随机更有意义的对照。有限资源池模式会改变牌序和连携可用性，不能把在这个课程上的胜率直接视作正式游戏人机强度。

核心引擎仍管理阶段与结算，因此训练场如遇到意外响应、空军调度或其他不属于四基础牌课程的选择，会明确抛错，方便发现适配遗漏。每次训练应固定代码与规则版本并保存种子、配置和动作日志。将来加入卡牌或改变资源模式时，应提高日志格式版本，避免把不同课程的结果混算。
