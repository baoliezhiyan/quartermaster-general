# 训练端输出规范：场面动作与独立牌区 v1.0

日期：2026-10-01。状态：客户端接口已实现；尚无真实训练端文件联调。本规范是训练适配器的新增契约，不替换正式对局的动作回放协议。类型源为 `src/actionReplay/trainingContract.ts`，运行时校验为 `trainingCodec.ts`。

## 1. 基本边界

继续使用 `quartermaster-match-log / formatVersion=3`，但必须标明 `mode=resource_pool`、`recordingModel=scene_actions`、`replayAdapter={id:quartermaster-training-scene,version:1.0.0}`。不能将训练文件冒充正式对局。

本适配器不调用正式出牌命令，不查展示手牌是否含来源牌，不按卡面自行出牌、收费、摸牌、洗牌或移动卡牌。训练端负责展开实际发生的费用、选择、响应及后续子效果，按顺序写入 `operations`。`cardId` 只说明动作来源，绝不隐式移到弃牌堆。

其中场面 `board` 操作调用当前客户端 `boardOptions` 和 `applyBoardEffect`，按当前场面的补给、相邻、库存及已有状态检查建设、征召、攻击和空军动作，重新计算结果；不直接相信训练端发来的“新增/删除任意地图兵模”差分。地图规则不能靠展示牌区、描述或自定义代码修改。`score/remove/supply/status` 是训练端已经裁定的显式效果，不再自动生成一次原卡的触发链。客户端不是训练课程完整裁判：它不能单凭一个卡名验证费用或这些显式效果是否来自那张卡。

四个展示牌区完全独立于上述规则计算。两类输入都必须明确提供；不能把选择藏在中文摘要中。没有发生的分支不得写成成功操作。跳过的动作可以写空 `operations` 和公开摘要。

## 2. 文件及版本

UTF-8、无 BOM、LF、逐行 JSON，末行也必须换行。顺序固定为一个 `header`、一个 `start`、零至多条 `training_action`、一个 `end`。`seq` 从 0 连续增加；动作 ID 全局唯一，不能含 `@`（留给本地子效果定位）。不接受截断文件、未知操作、未知必需能力或多余操作字段。上限 96 MiB、200000 行、单行小于16 MiB。

`gameVersion` 记录训练器参考的游戏版本，只作元数据，不要求等于客户端；`producer` 单独记录生成程序版本。必须提供 `sceneEngineFingerprint`，与发布包公开接口的 `SCENE_ENGINE_FINGERPRINT` 一致，保证实际场面计算的规则一致。不能为通过校验而伪造指纹。训练器版本不同可以通过；场面规则实现不同须另做适配器。

`training` 必含 `courseId/courseVersion/configuration/ruleOverrides`。把完整白名单、各类数量、A/B开放参数、冻结规则版本、随机种子/策略配置等课程元数据放入 `configuration`。这些字段不驱动客户端抽样。第一版 `ruleOverrides` 必须为空：不同于本客户端的场面规则尚未实现，显式拒绝，不静默简化。

`requiredCapabilities` 至少包含 `resources.independent.v1`。使用哪些场面操作，就同时声明对应的 `scene.board.v1`、`scene.score.v1`、`scene.remove.v1`、`scene.supply.v1`、`scene.status.v1`。未知必需能力会明确指出名称。

## 3. 卡表、实例与初始场面

`header.cards` 提供本文件完整实例表，每条为 `{id,definitionId,deckOwner,country,balance?,name,type,text}`。ID 唯一且稳定，多个同名副本用不同 ID；一个实例在四个不同牌区中重复出现仍使用同一个 ID。法国/中国是 `country`；决策座位、`deckOwner` 仍为六国座位。提供真实卡面快照，客户端以文件文字渲染文本卡，不因客户端当前卡面改动而替换它。第一版不接收远程图片地址。

`start.scene` 必含 `units/scores/round/phase/activeSeat/balance`，可含 `activeCards`。兵模字段沿用 `{id,country,type,regionId}`，须给完整开局地图；分数须给六国完整映射。`activeCards` 为六国到状态卡实例 ID 数组的可选映射；持续状态必须映射到客户端支持的实际状态定义。安装状态影响后续地图规则，但不会从任一展示牌区移走该卡。

当前仅支持正式阶段、无序章、无中立的训练场面。`phase` 为 TURN_START_WINDOW/PLAY/AIR/SUPPLY/SCORE/DISCARD/DRAW，轮次1至20。不接收任意引擎快照或可执行脚本。需要序章、中立、暗置响应持久区、特殊课程兵模上限或额外规则标记时，先扩展版本和能力，不要把它们混进 configuration 后假定生效。

## 4. 四个牌区：完全由记录决定

牌区键：`hand`（手牌）、`drawPile`（牌库）、`discardPile`（弃牌堆）、`resourcePool`（资源池）。定位一处牌区使用 `{seat,zone}`，列表按给定顺序显示。

`start.resources` 可省略，也可仅提供部分牌区。每项为 `{seat,zone,ids,visibility}`。省略表示未提供，空数组表示明确为空；UI 对未提供或不可见的牌区标注说明，不伪装为真实空手牌。不因为训练是 A/B 模式就建立7张手牌、起手12选7或自动刷新资源。

同一 ID 可以同时出现在多个牌区，甚至不同座位的牌区；每个单独牌区内 ID 不重复。`deckOwner` 不限制展示区归属。禁止引用卡表没有声明的 ID。

操作均放在 `{kind:resource,change:...}` 中，按 `operations` 数组顺序执行：

| change | 精确语义 |
| --- | --- |
| `{op:set,seat,zone,ids,visibility}` | 完整覆盖此牌区内容与可见性，保持 ids 顺序；也用于初始化一个原本未提供的牌区 |
| `{op:add,seat,zone,id,index?}` | 仅向此牌区加入实例；index为0起的插入位置，省略则追加；不会从其他牌区删除 |
| `{op:remove,seat,zone,id}` | 仅从此牌区删除指定实例；其他牌区不受影响 |
| `{op:move,id,from:{seat,zone},to:{seat,zone},index?}` | 原子地从来源删除并向目标插入；目标index基于移除后列表，省略则追加 |

增量操作要求有关牌区已提供；来源不存在、目标已有该 ID、index越界均报错，不自动忽略。相同牌区的 move 可用于重排。失败的 move 不会先删掉来源。set 与增量可以混用；后面的 set 覆盖它前面的结果。

`visibility=public/owner/omniscient` 分别表示所有视角可见、该座位及全知可见、仅全知可见。可见性由 set 更改。所有初始数据与操作仍存在文件内，文件不保密。公开 summary 不应包含未公开的资源或选择。第一版仅支持牌区级可见性，不支持同一牌区内逐卡不同知识。

例：来源牌 A 同时存在 hand 和 resourcePool；打出 A 并建设部队后，没有资源操作，两处仍保留 A。之后明确把 A 从 drawPile move 到 discardPile，只改变这两处；hand/resourcePool 中的 A 仍存在。要只向弃牌堆加 A，则使用 add。

## 5. 每条动作与场面输入

`training_action` 含 `id/seat/activeSeat/round/phase/operations/sceneHash`，可含 `cardId/summary`。

`seat` 是做决定的国家，`activeSeat` 是当前回合国家，二者可以不同。部队归属放在每个 board 操作的 `country` 中。例如苏联选择征召英国部队：seat=soviet_union，country=united_kingdom。客户端不因回合外响应自动推进国家回合。切换 activeSeat 或 round 时清理上一回合的临时补给标记；必须如实标记这些边界。

`operations` 可以交错放资源操作和场面操作，顺序就是最终执行顺序。回放支持条目前/后及每个操作的前/后。资源支付、暗牌选择由生产者明确展开；当前适配器不再弹出询问。

### board

`{kind:board,country,action,regionId,attackerId?,defenderId?,airId?,recycleId?,mode?,newUnitId?,airDefense?}`。

action 支持 build_army/build_navy/recruit_army/recruit_navy/land_battle/sea_battle/air_deploy/air_move/air_power/destroy。稳定地区ID沿用当前地图，不用中文名。使用与局面匹配的兵模 ID 选择攻击者、防守者、调度空军或回收兵模。筛选现有规则候选后必须恰好得到一个，否则拒绝。不能省略有歧义的选择。

建设/征召由核心区分补给和合法位置。攻击由核心移除实际目标；不要再为同一被消灭兵模补一个 remove。新建兵模可给 newUnitId 固定后续引用；如果该动作没有真的新建兵模（如重复建设），不得给 newUnitId。省略时由核心生成稳定ID；生产者可通过公共场面接口取得。空军防御默认按核心处理；airDefense=false 表示训练记录已经明确裁定绕过此次空军防御，不能随意用于跳过合法防御。

### 其他场面操作

- `{kind:remove,unitId,reason:cost|supply|retreat}`：费用、断补移除或撤回库存。supply 会检查当前确实没有补给。战斗消灭使用 board，撤往另一区域须另给合法后续部署效果。
- `{kind:score,seat,amount}`：已经结算的分数增减，不自动执行另一次计分阶段。整数绝对值不超过10000。
- `{kind:supply,unitIds}`：指定现有部队本回合获得补给；不从资源池猜测。
- `{kind:status,seat,cardId,operation:install|remove}`：安装/移除客户端已知的持续状态，用于地图被动修正；不会动四个牌区。触发式效果仍由训练端展开成后续 operations，不在本适配器中自动再次触发。

不支持的效果应增加新能力和明确语义。禁止把未知效果当作成功空操作，也不能用 score/任意文本冒充部队效果。

## 6. 校验与接口

每步 `sceneHash` 是执行完成后的场面摘要，与资源列表解耦。使用公共 `trainingSceneHash(state)` 生成；当前摘要包括 units（保留顺序）、scores、round、phase、activeSeat、unitSerial、六国active状态实例ID顺序、turnFlags。排序JSON键后 UTF-8 SHA-256，与正常契约的 canonical 算法相同。不要加入四个展示牌区。

末尾 `end={type:end,seq,contentHash}`。contentHash 是 end 之前全部原始 JSONL 字节（包括各行 LF）的 SHA-256，校验文件整体及资源操作。用 `sealTraining(lines)` 可生成；导出原始 key 顺序不影响 sceneHash，但 contentHash 必须按实际文件字节计算。

发布包 `dist-server/Room.mjs` 导出：

- `parseTrainingReplay(text)`：格式、卡表/能力/引用、文件完整性检查。
- `TrainingController`：`checkReplay()` 逐步验证场面和资源；`seek(id, after)` 查看指定动作，`getSnapshot()` 获取展示状态；不支持写入对局。
- `createTrainingScene(scene, gameId, cardMap)`、`applyScene(state,effect,cardMap)`、`trainingSceneHash(state)`：训练端可复用的场面参考实现。
- `applyResource(resources,change,knownIds)`：四牌区纯函数，输入Map不会被修改。
- `sealTraining(lines)`、`TRAINING_CAPABILITIES`、`SCENE_ENGINE_FINGERPRINT`。

运行 `runtime/node.exe scripts/validate-match-log.mjs 文件.jsonl --replay`，检查结构、文件哈希、所有牌区变更、每条场面动作及结果摘要。不带 --replay 只检查结构和文件完整性，不等于场面验证通过。

## 7. A/B 训练端实施要求

客户端不重新抽样、不根据资源数量猜可用集合，不硬编码A/B的K、概率、58事件白名单。训练端应把实际开放/刷新结果写成 resourcePool 的 set（或等价增量），把实际弃置、消耗、恢复写入相应牌区。A/B算法、数量、课程规则和策略配置完整记入 configuration，相关自定义场面覆盖必须另获适配器支持。

未提供 hand/drawPile/discardPile 完全允许；只提供 resourcePool 也允许。多个库同时保留同一ID完全允许。每一步 source card 不在任何展示库也允许。这些都不构成正式出牌合法性错误。

`回放样例/constructed-training-resources.jsonl` 是客户端构造样例，测试跨库重复、显式移动、全量覆盖、独立建设和分数，**不是训练端真实A/B输出**。训练端接入后须另交 A、B 完整文件，覆盖回合外决策、费用、额外出牌、资源刷新、最后一步及所有实际课程事件，再进行真实跨端验收。
