# 本机 AI 玩家接口 1.2.1（客户端 v1.8.4）

## 基线与边界

初始稳定基线 ac94499（v1.8.4）；本轮基于3831dec，工作目录 D:/Codex/QuartermasterGeneral/worktrees/client-v183/战场军需官，分支 codex/client-ai-finalize。接口仍通过正式 Room / LocalGameController 执行。1.2.1同时包含用户授权的两处核心缺陷修复，规则指纹正常更新，游戏版本、卡牌、玩家权限及存档/回放协议不变；细节、兼容边界与最终验收见 [local-ai-actions.md](local-ai-actions.md) 和 [核心修复说明](ai-core-fixes-20261104.md)。不安装模型、不训练。

新增 src/localAi/{contract,observation,adapter}.ts；脚本 local-ai-http、local-ai-cli、start-local-ai、verify-local-ai；启动 CMD、接口测试和本文。少量接线位于 Room.ts、multiplayer-server.mjs，私有目录加入 gitignore。未启用 QM_LOCAL_AI=1 时，不监听 AI 端口。

## 启动（源码运行，不是新发布包）

要求现有 Node >=22.12、仓库依赖已安装；首次运行 `pnpm build`。双击根目录“启动本机AI接口.cmd”，或执行 `node scripts/start-local-ai.mjs`。普通客户端 http://127.0.0.1:4183/；本机 AI 接口 http://127.0.0.1:4185/。可通过 QM_PORT / QM_AI_PORT 指定隔离端口。不要同时启动另一个使用同一 data 目录的房间进程。已有房间需要在原进程结束后用可选入口启动；它遵循正式客户端的恢复流程，不自动恢复/创建游戏。

单独端口是为了不让指向正式房间的 Cloudflare/cpolar 隧道顺带开放 AI 接口。AI 端口只监听 127.0.0.1，拒绝浏览器 Origin 和转发来源头；不要给它另开隧道。凭据仍必须是有效普通玩家身份。

1. 用户在普通网页创建一个 AI 用户。用该用户进入一个国家的玩家座位，绑定这个国家，再绑定同阵营其他两个国家。可只绑定其中一部分，最多三个。
2. 复制该用户的个人返回链接，将 #identity= 后的身份值保存到 `local-ai-private/session.json`。内容如下（文件私有，不提交）：

```json
{"url":"http://127.0.0.1:4185","token":"替换为该普通玩家的身份值"}
```

3. 用户另开自己的身份选择座位、担任 GM 并选择正式游戏开关。接口不做这一步。
4. 执行 `node scripts/local-ai-cli.mjs connect`。它接管 AI 身份，原身份页面会按正式机制被替换，绑定不变。不要再用网页打开这个身份，否则网页会反向接管。GM/未绑定身份不会被 AI 接管；混合阵营绑定会被拒绝。

CMD 窗口显示服务地址，并在连接/绑定/等待状态改变时显示 AI 状态；具体信息用 status 查询。身份只放私有文件；普通输出和审计不含令牌。

## 助手命令

以下命令在上述工作目录运行，均为单次调用，JSON 输出，不依赖鼠标：

```text
node scripts/local-ai-cli.mjs status
node scripts/local-ai-cli.mjs observe
node scripts/local-ai-cli.mjs wait --timeout 30000
node scripts/local-ai-cli.mjs submit --request-file local-ai-private/request.json
node scripts/local-ai-cli.mjs disconnect
```

可在任何目录使用脚本绝对路径；默认配置位置相对脚本所在仓库，不依赖工作目录。`--config <绝对路径>` 可使用不同配置。超时单位毫秒，0..60000；wait 默认为从上次观察 sequence 起等待，亦可传 --after N。

observe/submit/wait 返回完整当前玩家观察和 changes。changes 是与该配置上一次可见观察相比的字段更新，不是引擎动作，也不推断攻击一定成功。epoch/gameId 改变时要求 resync。首次使用依赖完整观察即可；缓存丢失再 observe。当前 choice.id 是可靠决策标识；没有宣称它等于一个合并行动的完整边界。

从最近观察取一个 offers 条目，填写 UTF-8 JSON（允许 BOM）：

```json
{"requestId":"本次唯一编号，例如 UUID","gameId":"观察中的gameId","epoch":"观察中的epoch","revision":123,"offerId":"观察中的offer.id","selections":{"cardIds":["观察允许的实例ID"]}}
```

没有 selections 的 offer 可省略；起手/弃牌用 cardIds，结算窗口用 ids，出牌前目标用 targetIds，空军调度费用用 cardId。每个 offer.selections 明确合法集合、min/max、ordered、requirements；单张 cardId 同样传长度为1的数组。ordered 表示按数组顺序提交。完整规则仍由正式控制器校验。

拒绝后先 observe，勿猜测或自动跳过。网络超时重试必须使用原文件及原 requestId；同编号不同内容拒绝。服务内缓存回执，断开重连后仍可取回；服务重启会有新 epoch，旧请求拒绝，需观察状态重新决定。请求已执行但审计失败会明确返回 AUDIT_FAILED，不能因此另起编号重复动作。

退出码：0 成功，2 输入/选择无效，3 过期或跨对局，4 断开/认证/普通房间拒绝，5 传输/配置/审计/其他异常。服务端返回 code 和 message。原引擎 `{ok:false,error}` 是执行拒绝，服务回执中保留，不得当作动作成功。

## 观察与保密

主机逐国调用正式 projectState(player)，只汇总绑定国家的合法私有信息；公共区域单独调用 public 投影。无序牌库组成、己方手牌/暗置/弃牌、依法可见的序章顶牌、公开场面和提示均可读。公开信息六国可见。牌库候选按稳定 ID 排列，不能用于推断未知牌序。敌方菜单、暗牌、回滚树、种子、随机状态和内部完整帧不进入接口；费用上下文只抽取当前己方已投影效果的必要字段。依法公开的牌名本来就可能与敌方暗牌同名，不能因此认为泄密。

不输出整份 GameState，不提供 GM 操作。每次提交重新读取有效绑定、局面版本及候选，再通过普通 seat 请求切换已绑定国家，然后普通 dispatch 请求执行。保存、正式记录仍由原控制器处理。GM 场景锁定、旧连接接管和绑定权限均生效。

## 节点覆盖与验证边界

代码接入：起手、序章弃顶/出牌、标准出牌（含巴巴罗萨目标的既有集合）、状态、额外出牌、响应、空军行动及免费调度、主动与被迫弃牌、费用、检索、排序、正式允许跳过与阶段推进。资源重整通过正式回合开始结算窗口出现，不另写训练规则。独立效果使用正式 guided 交互询问。未知 choice.kind、训练课程或非 FULL 模式明确 unsupported 并不给可执行候选；不能据此宣称未来版本自动兼容。

自动化：tests/local-ai.test.ts 覆盖三国汇总、敌方私有信息、无序牌库、冻结读取/超时、跨席起手、重复/过期/越权、断开恢复、普通陆攻及人类插入空军防御、AI 英国回合外防御、支付/检索/排序；构造场景由测试 GM 提供，不是 AI 场景编辑权限。原 tests/multiplayer.test.ts 回归默认权限与正常联机行为。

`scripts/verify-local-ai.mjs` 以后台服务和多次独立 CLI 调用验证 connect/status/observe/wait/UTF-8 submit/重复请求/重连、浏览器来源拒绝及令牌不入审计；使用 19383/19385 和 outputs 隔离数据，无全屏。它会创建构造测试对局，不是用户试打入口。

尚未人工试打完整六国长局；未逐张验证所有卡牌、全部费用组合和所有十九种 choice。现有未被场景覆盖的节点通过相同通用选择入口执行，遇到正式拒绝必须停止检查。尚未接入 Qwen，未加载权重、付费 API 或训练。不保证旧版本正式回放被新构建放宽接受。

## 暂停、恢复与数据

助手暂停时无需提交任何内容，房间停在正式决策处；其他人仍可按规则行动。重连执行 connect + observe，不重放上次决策。disconnect 标记普通身份离线，保留绑定；Ctrl+C 关闭服务。房间按正式保存/导入功能恢复后，重新观察；旧请求可能因 epoch 改变失效。

主机审计 `local-ai-private/audit/interface.jsonl` 记录时间、耗时、接口结果、规则配置、观察/候选和提交。CLI 缓存为配置文件旁 `.observation.json`，桥接摘要在 `local-ai-private/bridge.jsonl`。这些可含己方私有牌面，属于本地资料，全目录忽略提交；不要将自己的配置移到会提交的目录。日志不会自动截断，长期使用可在停机后自行归档。不记录模型链式思考，模型适配将来只需消费该协议，不改正式引擎。

## 最初接口验收历史（2026-11-03，非本轮最终构建）

针对性测试 4 文件 43 项通过；类型检查和源码生产构建通过。实际后台 HTTP + 多次独立 CLI 调用通过；关闭开关时原服务可访问且 AI 端口不监听。规则指纹与 ac94499 相同，游戏版本仍为 1.8.4；构建指纹正常更新。未打发布包，测试服务已关闭，未创建用户真实试打局。


增强包与本轮补齐字段见 [local-ai-enhanced.md](local-ai-enhanced.md)。便携包无需开发依赖，直接使用包内 runtime/node.exe。


单行动合并和持续等待的新增契约、CLI及限制见 [local-ai-actions.md](local-ai-actions.md)。旧 wait 仍是有界单次等待；新 wait-decision 才在CLI内部持续续订。
