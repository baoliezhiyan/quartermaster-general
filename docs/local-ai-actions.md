# AI 单行动合并与持续等待（接口 1.2.0）

基线为 74e158a（正式规则仍为 ac94499 的 v1.8.4），独立客户端工作目录 `D:/Codex/QuartermasterGeneral/worktrees/client-v183/战场军需官`，分支 `codex/client-ai-actions`，开工时工作区干净。本次不制作包，不开始用户对局、不加载模型、不训练。保留旧 submit/observe/wait 及其默认输出；不改 src/core、src/data、游戏版本、正式玩家请求和回放协议。

## 支持范围

新 `submit-action` 合并一个基本牌行动、一次状态发动或一次响应/军备触发里的明确选择。正式 Room、控制器及原命令逐步执行，不是原子事务。

- 建设陆/海军：卡牌实例 + 地区；若回收有歧义，须明确 recycleId。
- 陆/海攻：卡牌实例 + 地区 + 守军（空地用 empty）+ 发起部队；需要时选发起部队，唯一方案仍由正式引擎按原逻辑自动选。
- 空中力量部署/夺取：可从 SELECT_AIR_ACTION 开始，明确 cardId、地区；夺取还可给 airId 和 defenderId。
- 空军付费调度：可从 SELECT_AIR_ACTION 的 move 开始，明确费用 cardId、airId、目的地区；已有 MOVE_AIR offer 也支持。
- 状态/响应：明确手牌费用 feeCardIds 与单个目标；其他必须的确认/支付分支用 answers。源响应须在当前 TRIGGER 中选择一个明确选项。

普通事件、额外出牌、军备回收、资源重整、强征第二个独立目标等继续使用单步接口。不能把 TRIGGER 写进 answers，也不支持在攻击后排入闪电战、俯冲轰炸机等另一触发。只自动消费第一个版图子效果的通用目标参数；其他选择缺失、歧义或新的版图子效果会停下来。整个请求上限32个正式步骤，超过停止。

## 请求示例

最近 observe 的 offer.id、gameId、epoch、revision 必须原样填写；以下实例ID均为占位，不能直接提交到真实局。

```json
{
  "requestId":"唯一编号，最长60字符",
  "gameId":"当前gameId",
  "epoch":"当前epoch",
  "revision":123,
  "offerId":"当前PLAY_CARD的offer.id",
  "intent":{"regionId":"eastern_europe"}
}
```

攻击 intent 示例：

```json
{"regionId":"western_europe","defenderId":"当前守军单位ID","attackerId":"当前发起部队ID","airIntercept":true}
```

airIntercept 只是对本方拦截的明确回答；遇到对方 AIR_DEFENSE 必定先返回，不自动等完后续跑。夺取制空权从 air:supremacy offer 开始：

```json
{"cardId":"手中空中力量实例ID","regionId":"western_europe","airId":"本方空军ID","defenderId":"敌方空军ID"}
```

调度从 air:move offer 开始：

```json
{"cardId":"弃置的手牌实例ID","airId":"本方空军ID","regionId":"italy"}
```

响应起点仍须提供 `selections:{"ids":["当前触发选项ID"]}`。状态/响应的 intent 可以包含：

```json
{"feeCardIds":["费用牌实例ID"],"regionId":"eastern_europe","answers":[{"kind":"EFFECT_DECISION","ids":["execute"]}]}
```

answers 仅支持 CARDS/PAY_COST/SELECT/EFFECT_DECISION/AIR_INTERCEPT，须给明确候选ID，可用 effectIndex 限定当前效果。effectIndex 来自 decisions，是正式内部帧中的实际索引，不是卡面第几句话。相同 kind 匹配多个未用答案会因歧义停止。省略不代表同意、跳过或默认选第一项。

预检校验格式、当前身份/版本、费用牌归属和可查询的基本牌目标；无法保证后续条件。原始合法集合仍由引擎产生，执行每一步前重新 observe/匹配并走普通权限路径。不存在真实试执行再回滚。

## 停止与回执

返回 `{receipt,observation}`。receipt 包括 requestId/gameId/epoch、前后修订号、每步编号、实际选择、前后修订号、可见单位/手牌/分数变化、正式 UNIT_PLACED 事实、尚未消费的答案、停止原因及统计。

- completed：本行动已结束或跨到下一阶段；不会消费下一阶段预填答案。
- waiting_other：正式结算仍在运行，己方当前没有决定权。停止原因只写通用状态，不透露他人的菜单。
- partial：已执行部分；缺参数、目标变更、新选择、新信息等需要模型重新决定。
- rejected：没有执行成功的步骤，条件/格式等被拒绝。
- executing/uncertain：正在执行，或进程中断/无法确认某步。uncertain 绝不重新执行。

遇到其他玩家、TRIGGER、新帧、跨阶段、未包含选择、检索/展示、手牌增加、牌库组成变化、世代或绑定变化会停。对方完成后不自动恢复剩余请求；`result` 返回旧回执和最新观察，模型再用单步接口处理当前决定。

actual UNIT_PLACED.repeated=true 是已成功重复建设，不判成错误。单位/手牌差分只说明可见变化；没有版图变化不自动等于失败。当前依法可见的 resolutionFacts 给出 declared/succeeded/cancelled/invalid 等正式事实；若已进入新结算且无法可靠关联，不推断成功/取消。以 gameId/epoch/resolutionSerial/frameId 关联仍在当前结算的事实；resolutionSerial 直接复用引擎 balanceResolutionSerial，不是完整跨行动计划ID。

回执原子替换保存在 local-ai-private/requests 下，文件名为凭据与请求编号的SHA-256。写入待执行标记后才调用正式操作。相同编号同内容返回回执，不再执行；同编号不同内容拒绝。wait等传输选项不属于行动内容。单个身份串行提交，等待不持有这把锁。服务在执行与写回执之间崩溃时标为 uncertain，需要人工/模型核对，不承诺与游戏存档跨文件原子提交。

## CLI

```text
node scripts/local-ai-cli.mjs submit-action --request-file local-ai-private/action.json
node scripts/local-ai-cli.mjs submit-action --request-file local-ai-private/action.json --wait
node scripts/local-ai-cli.mjs submit --request-file local-ai-private/single.json --wait
node scripts/local-ai-cli.mjs result --request-id 原请求编号
node scripts/local-ai-cli.mjs wait-decision --wait-id 本次等待唯一编号
node scripts/local-ai-cli.mjs cancel-wait --wait-id 本次等待唯一编号
```

新命令默认紧凑输出，可加 --full；旧命令保持原默认，可加 --compact。完整观察和静态资料仍用 observe/reference。每次返回记录完整玩家观察缓存；紧凑输出不反复打印地图和静态卡表。合并回执保留本次变化。--wait 默认如果已有己方决定就直接返回，否则内部持续等待。

wait-decision 在服务内按 Room 通知订阅。普通聊天/日志、非己方操作等只唤醒内部检查；没有新己方决定时不向模型输出。当前 offer/选择和依法可见上下文生成摘要游标去重，不以轮次为唯一条件。--fresh 明确重新呈现当前决定；默认使用上次返回的 .decision.json 游标。

服务端采用最长30秒的租约，CLI自动续订，租约到期不是模型输出。默认25秒；测试可用 --lease-ms 1000。网络传输失败内部有限重试，不重放游戏命令。身份被接管、无法恢复的连接/认证错误返回 unavailable；重新连接需显式 connect + observe，不自动踢掉网页玩家。换局/回退/读档/绑定变化返回 resync_required，终局返回 finished，取消返回 cancelled。--wait-id 不应在已取消的新等待中复用。

当前聊天工具：用 exec_command 启动上述 CLI，短 yield 获取进程 session_id，再通过 write_stdin 续等该会话。CLI 不会每25秒输出一次；外层工具本身仍可能需要继续等待调用。也可以在另一工具调用中 cancel-wait。没有实现、也不宣称能够唤醒已结束的聊天；没有改 Codex 内部文件或桌面自动操作。

统计在回执 statistics、CLI statistics 和既有脱敏日志：engineSteps、执行耗时、pauseReason、HTTP请求数、续租次数、忽略事件数、等待时间。建设基准两次单步 submit 合为一次 submit-action，但正式引擎仍两步；不把本机测试耗时宣传为模型整体加速。

## 运行时契约

旧 /submit、/observe、/wait 保留。新增 POST /submit-action、/submit-action-wait、/submit-wait、/result、/wait-decision、/cancel-wait（均为 /api/local-ai/ 下路径）。需要原普通玩家身份，仍限本机，不能提交任意引擎命令。wait-decision body 为 `{waitId,after?,expected?:{gameId,epoch,bindings},leaseMs?}`；直接HTTP客户端必须内部续租 leaseExpired，不把它交给模型。相同 waitId 的最初 scope 由服务保持，防止租约间漏掉世代变化。

## 验收与既有边界

单元/集成场景覆盖建设、陆海战、多个发起部队、空军部署/夺取/调度、显式/缺省回收、重复建设事实、状态及响应支付、对方防御中断、闪电战新窗口、缺失/错误/过期/重复、费用烧牌后新信息、回执中断、普通更新静默、租约续订、换局/绑定变化、终局、身份接管，以及单步与合并的局面/窗口/正式记录输入等价（档案随机actionId除外）。

真实HTTP测试 `node scripts/verify-ai-actions.mjs` 使用隔离19583/19585/19586端口、构造对局、后台进程；模拟一次HTTP断开，确认CLI内部重试，普通更新和续租无输出，回合外/回归及提交等待不占桌面，不训练。

两个未改动的既有问题必须区分：
1. 等待 AIR_INTERCEPT 时删除已选发起部队，并且还存在另一支可攻击部队，正式 refreshSceneResolution 可循环。独立核心子进程复现脚本 `node scripts/probe-ai-core-boundary.mjs` 在2.5秒终止测试。合并请求已在对方防御处返回，不自动恢复；该核心失效路径停止本次验收，建议另行修复“原选择失效而其他方案仍合法”的验证/刷新。
2. 主机 restoreHostSession 的恢复校验使用 JSON.stringify 严格比较；本轮长流程持久化重建状态逐字段一致（diffValue=[]）但键序不同，被原校验拒绝。没有改校验或伪装通过。HTTP测试明确标记 restoreMode=existing_order_check_blocked，并由测试GM通过既有完整历史导入入口恢复后验证回执查询/防重放；直接恢复按钮不计为通过。

尚未逐张覆盖所有卡牌、所有费用/强制插入组合或完整人工长局。没有新增发布包。此前1.8.4-ai增强包仍是接口1.1.0，本轮需源码构建运行1.2.0后再安排试打。

## 本轮最终验证记录（2026-11-03）

- `pnpm build`（含 TypeScript 检查）通过；Vite 仍提示既有大分块警告。
- `pnpm exec vitest run tests/local-ai-actions.test.ts tests/local-ai.test.ts tests/local-ai-completeness.test.ts tests/multiplayer.test.ts tests/room-access.test.ts`：5文件67项通过。
- `node scripts/verify-local-ai.mjs`：原单步 HTTP/独立 CLI、重连、防重复、来源拒绝和日志脱敏通过。
- `node scripts/verify-ai-actions.mjs`：正式主机 HTTP + 独立 CLI 通过；建设由2次提交变1次，正式引擎仍2步；持续等待1次CLI调用内部4次HTTP、2次续租、忽略4次更新，约2318ms后只返回一次。该数字是构造场景测量，不是长局吞吐或模型推理加速。
- `node scripts/probe-ai-core-boundary.mjs`：独立核心失效案例在2.5秒被测试进程终止，确认上述阻塞仍存在，不计为核心通过。
- 规则指纹保持 `6f4cfa732581884ab38ab3a8463e6461a88e30b58825e480bd0938da9d511481`；受测构建身份 `44318da26ff2748fd33b28ab7a962ca63ecbc907a01dd40b29c04cb4af3f99af`。
- 未改正式规则、地图、随机过程、玩家协议、存档/回放契约；对训练执行无变更。AI接口从1.1增为向后兼容1.2，额外增加观察元数据。
- 后台构造测试服务已退出；未进行用户实机长局、未自动开始试打、未更新压缩包。
