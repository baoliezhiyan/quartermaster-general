# AI 单行动合并与持续等待（接口 1.2.1）

本轮基线为3831dec，沿用独立客户端工作目录 `D:/Codex/QuartermasterGeneral/worktrees/client-v183/战场军需官`，分支 `codex/client-ai-finalize`，开工工作区干净。游戏版本仍为1.8.4，AI接口1.2.1，保留旧单步接口。本轮额外获准修复已选行动失效循环与恢复键序依赖，详见 [核心修复及训练影响](ai-core-fixes-20261104.md)。不修改卡牌、玩法、优先级、存档/回放协议或玩家权限，不制作包、不开始用户对局、不训练。

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

新命令默认紧凑输出，可加 --full；旧命令保持原默认，可加 --compact。完整观察和静态资料仍用 observe/reference。每次返回仍缓存完整合法观察；紧凑输出传送必要动态变化，静态地图和卡表用 reference 缓存。合并回执保留本次变化。--wait 默认如果已有己方决定就直接返回，否则内部持续等待。

wait-decision 在服务内按 Room 通知订阅。普通聊天/日志、非己方操作等只唤醒内部检查；没有新己方决定时不向模型输出。当前 offer/选择和依法可见上下文生成摘要游标去重，不以轮次为唯一条件。--fresh 明确重新呈现当前决定；默认使用上次返回的 .decision.json 游标。

服务端采用最长30秒的租约，CLI自动续订，租约到期不是模型输出。默认25秒；测试可用 --lease-ms 1000。网络传输失败内部有限重试，不重放游戏命令。身份被接管、无法恢复的连接/认证错误返回 unavailable；重新连接需显式 connect + observe，不自动踢掉网页玩家。换局/回退/读档/绑定变化返回 resync_required，终局返回 finished，取消返回 cancelled。--wait-id 不应在已取消的新等待中复用。

当前聊天工具：用 exec_command 启动上述 CLI，短 yield 获取进程 session_id，再通过 write_stdin 续等该会话。CLI 不会每25秒输出一次；外层工具本身仍可能需要继续等待调用。也可以在另一工具调用中 cancel-wait。没有实现、也不宣称能够唤醒已结束的聊天；没有改 Codex 内部文件或桌面自动操作。

统计在回执 statistics、CLI statistics 和既有脱敏日志：engineSteps、执行耗时、pauseReason、HTTP请求数、续租次数、忽略事件数、等待时间。建设基准两次单步 submit 合为一次 submit-action，但正式引擎仍两步；不把本机测试耗时宣传为模型整体加速。

## 运行时契约

旧 /submit、/observe、/wait 保留。新增 POST /submit-action、/submit-action-wait、/submit-wait、/result、/wait-decision、/cancel-wait（均为 /api/local-ai/ 下路径）。需要原普通玩家身份，仍限本机，不能提交任意引擎命令。wait-decision body 为 `{waitId,after?,expected?:{gameId,epoch,bindings},leaseMs?}`；直接HTTP客户端必须内部续租 leaseExpired，不把它交给模型。相同 waitId 的最初 scope 由服务保持，防止租约间漏掉世代变化。

## 紧凑变化契约（CLI）

`wait-decision`、`submit-action` 和 `submit --wait`/`submit-action --wait` 默认紧凑输出；`--full` 仍给完整观察。普通 submit/observe/connect 的默认输出保持原样，`--compact` 可显式启用。原HTTP接口仍返回完整合法观察，新增压缩只在桥接端基于两次合法投影计算，不接触主机真值。

`changes.format=local-ai-observation-change`、`version=1`。有两种显式模式：

- `mode=snapshot`：`changes.snapshot` 以及 result 中的观察包含全部必要动态信息（仅省略 reference 已有的静态 regions）。首次连接、没有已交付基线、基线不完整、身份/世代/规则资料变化、修订号倒退、日志不是原日志的完整前缀等，采用此模式，并返回 reason。不是残缺增量。
- `mode=delta`：`updates` 是 set/remove/append 结构更新，附 fromHash/toHash 与序列。必须应用到匹配基线。`newPublicLog` 给出新增公开行动；`units` 给出新增/移除/移动/更新；`scores` 给出最新六国分数及差值；`privateAreas` 给出有变化的己方牌区和合法上下文当前值。result.observation 为带 `representation=decision_summary, changesRequired=true` 的当前决策摘要，不能当全局快照。合并回执、实际执行步骤及停止原因仍完整保留。

接收方可直接读取这些变化作决定；需要构建完整状态时，使用公共无副作用帮助函数：

```javascript
import {applyObservationChange,decisionObservation} from './scripts/local-ai-compact.mjs';
let view = decisionObservation(fullObserveResult);
view = applyObservationChange(view, cliResult.changes);
// snapshot 可用 null 为基线；delta 基线/哈希不匹配时明确抛出 FULL_SYNC_REQUIRED。
```

恢复全量：`node scripts/local-ai-cli.mjs observe --full`。新增 `.delivered.json` 保存最后真正输出给调用者的必要观察，status/reference 等没有输出观察的命令不更新它；不能把只写进内部 `.observation.json` 而未交付的数据当模型基线。CLI同会话同时调用可能导致观察返回顺序变化，接收方须校验 fromHash；不匹配就全量同步，不猜测。静态资料变更会使基线失效。

首次公开日志原本不存在、随后出现，支持显式设置；回退、日志截短或替换会发快照，保留日志变化，不只比较长度。对手未知手牌、暗置内容、未知牌序和随机状态始终不进入变化。模块与观察接口分离，不依赖模型或新的引擎副本。

测试可设置 `QM_AI_PRIVATE_DIR` 和 `QM_MATCH_LOG_DIR` 隔离私有审计/回执、记录目录；默认仍在程序目录 local-ai-private 与对局记录。配置文件、日志、缓存及真实记录不提交。构建脚本已补入新的桥接模块，但本轮未制作压缩包，旧AI增强包仍是原接口。

## 当前验收范围

`special_236` 通过真实牌效、Room、正式确认命令和两个阵营适配器测试：轴心确认被唤醒，同盟始终 waiting_other；部分确认、全部确认、后续 Germany/Japan 决策和结算结束均按实际归属处理；真正无 choice、无有效 revealGroup 的运行态仍 unsupported。未输出他人翻牌或私有菜单。

原单行动范围继续覆盖建设、陆海战、发起部队、空军部署/夺取/调度、回收、重复建设、状态/响应支付、新信息和新触发中断、权限与重试。紧凑接收方基线加变化还原测试覆盖公开记录、单位、分数、己方手牌/状态/暗置、日志首次出现、回退/日志缩短、缺失或错误基线；实际 HTTP/独立 CLI 也校验还原。

两处原核心阻塞已修复，详见 ai-core-fixes-20261104.md；不再以超时或完整历史导入替代通过。多轮正式持久化测试只调用恢复主机对局入口，随后核对局面、查询旧回执、防重放、重新观察并继续行动。一般卡牌与全部强制插入组合未逐张穷尽，尚无用户人工长局验收。

游戏/协议 schema 不变；规则指纹正常更新。旧 JSON 状态须满足原结构及重演一致性；旧指纹动作回放、带旧指纹记录的主机档案仍按原身份校验拒绝，不提供跨指纹迁移、不伪装兼容。训练端需按训练同步记录重新冻结/验收。本轮没有模型、真实玩家对局、训练或发布包。

## 最终构建与测试记录

2026-11-04 最终验收：

- 核心修复单独提交 `49a9108`；接口收尾另行提交，最终源码 SHA 见本分支提交记录。
- `pnpm build`（包含 TypeScript 检查）通过。Vite 仍有既有大分块提示，本轮未做无关打包优化。
- `pnpm exec vitest run --maxWorkers 2 --testTimeout 20000`：99文件、1004项全部通过（37.50秒）。覆盖接口、房间/权限、完整规则、结算、存档、回放及相关训练单元回归；没有运行模型训练。
- `node scripts/probe-ai-core-boundary.mjs`：timedOut=false；原结算明确结束、记录invalid、原守军保留。
- `node scripts/verify-local-ai.mjs`：原单步实际HTTP/独立CLI、身份连接、防重复、来源限制及脱敏通过。
- `node scripts/verify-ai-actions.mjs`：direct_restore_passed；构造第5轮、修订号100持久化后关闭并重启服务，通过正式 restore 入口成功；局面字段一致，旧回执查询和重试不重放，新观察后新行动完成。没有使用完整历史导入替代。
- 同一HTTP验收校验 submit-action、wait-decision、submit-action --wait 的紧凑结果加基线可还原必要观察。建设2次提交变1次，引擎仍2步；持续等待内部经历3次HTTP、1次续租、4次普通更新，约1979ms后只输出一次。
- 规则指纹：`994ca2cfa372a35ac8b1fb382aafb158ff3410c357f3ccb33441c5279cd5a8a7`。
- 构建指纹：`6b4c9df4383b99849d710ffc2eb29210ec602d8b4d77598d8381a4c9bea12c38`。
- 测试使用隔离端口/数据/私有回执日志/记录目录及后台进程，测试服务已退出；没有操作真实用户存档或旧发布包，没有用户人工长局验收。
