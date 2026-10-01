# 战场军需官电子游戏版

浏览器客户端、正式规则引擎，以及用于强化学习的训练竞技场。支持本地/联机游戏、可选序章和中立规则、平衡补丁，以及详细对局记录与回放。

当前应用版本以 [package.json](package.json) 为准（首次上传为1.7.0）。这是现有项目的首次源码导入，不代表每个功能都已独立验收。训练基线、游戏版本和回放协议分别管理。

**AI开发者先阅读根目录 [AGENTS.md](AGENTS.md)。客户端和训练场必须在不同检出目录工作，不要共用本目录并行编辑。**

## 快速入口

- [文档与规则导航](docs/README.md)
- [原版牌表](docs/cards/standard.md) / [平衡补丁牌表](docs/cards/balanced.md)
- [贡献、Bug与平衡讨论](CONTRIBUTING.md)
- [回放说明](docs/match-log-guide.md) / [回放规范](docs/match-log-spec-v2.0.md)
- [PPO训练方案](docs/training/战场军需官PPO第一步实施方案-v0.3.md) / [下一步并行优化要求](docs/training/parallel-plan.md)
- [双击启动 PPO 训练](PPO训练/README.md)
- [素材与许可状态](ASSETS.md)

## 从源码启动

需要 Node.js >=22.12、package.json指定的pnpm版本。先安装对应工具，再运行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

开发服务器默认仅监听本机。按终端输出的地址打开浏览器。源码检出不包含游戏发布包，根目录的发布启动器可能依赖本机已有releases目录；新克隆请先使用上面的开发方式。

联机服务先构建再启动：

```sh
pnpm build
pnpm multiplayer
```

互联网访问所需隧道工具、账户配置和运行时不放入源码仓库，相关说明见docs。服务器数据与“对局记录”是本机资料，默认不提交。

## 检查与牌表生成

```sh
pnpm typecheck
pnpm test
pnpm build
node scripts/export-public-card-catalog.mjs
```

训练代码还需Python、PyTorch等环境，具体课程及运行参数见训练文档。模型检查点和训练日志位于本地输出目录，不随Git上传。开始训练前固定Git提交和构建指纹，不在实验途中同步规则。

历史脚本中仍有本机工具路径；发布脚本还依赖本地第三方运行时、隧道工具以及生成的回放样例。`pnpm release`不是新克隆后开箱即用的跨平台发布器，整理这些依赖属于后续任务。发布压缩包应通过Releases分发，不提交源码历史。

## 目录与协作

| 位置 | 用途 |
| --- | --- |
| src/core、src/data | 正式规则、结算、卡表和地图 |
| src/ui、src/controller、src/network | 界面、控制和联机 |
| src/actionReplay（现行）、src/matchLog（历史） | 共享回放协议、校验与展示 |
| src/training、scripts/ppo* | 训练竞技场与PPO |
| tests | 游戏/训练回归测试 |
| docs | 规则、设计、验收、生成牌表及协作资料 |
| public/assets | 运行时美术资源，权利范围见ASSETS.md |

客户端、训练与平衡修改分别使用独立目录和任务分支，通过PR整合到main。共享规则修改必须说明训练影响；训练专用优化允许实现分离，但必须用差分测试证明冻结规则等价。

Bug使用Issues；开放的平衡讨论使用Discussions（由维护者在GitHub设置中启用），明确可实施提案也可使用Issue模板。提案不会自动成为规则，维护者接受后再实施。讨论请注明版本、规则开关及稳定卡牌ID。

旧README和早期设计保存在docs/history与其他历史文档中，只供追溯，不能当当前操作说明。
