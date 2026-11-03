# 本机 AI 观察完整性复核与增强包

基线：正式 ac94499（v1.8.4）及适配层 2b380af。继续使用独立客户端工作区，开工时分支 codex/client-local-ai、HEAD 2b380af，工作区干净。

## 与普通玩家界面对照

| 界面/事实 | 观察字段与正式来源 |
| --- | --- |
| 卡名、正文、类型、归属、稳定身份、平衡配置、紧张度 | privateCountries 及公开卡列表内的 card；specialCard，不改牌面。tension 为 number/null，0保留；sourceIndex 和 persistentHistory 同步正式来源 |
| 手牌/牌库/当前弃牌数量 | public.countries 的 handCount/deckCount/discardCount；正式投影 publicDiscardCounts |
| 可见弃牌历史 | visibleDiscard，独立于当前数量；回收不擦除可见历史 |
| 暗置响应/军备/明置响应 | faceDownCount/responseCount/armamentCount/revealedResponses；与 PublicCountryInfo 使用相同计数字段 |
| 局势/条约 | publicActiveCards + persistentHistory，包含正式仍生效的结算中公开状态 |
| 序章公开数量 | 各国 prelude.handCount/deckCount/discardCount；投影只含数量未知卡 |
| 己方牌区 | 绑定国家各自 player 投影；手牌、无序牌库、暗置、生效、结算中、移除、序章已知顶牌。没有新增私有历史账本 |
| 决策、费用、排序、次数 | decisions、offers、当前已投影效果、requirements、ordered、uses 和 roundUses；沿用原控制器校验 |
| 规则/阶段/序章/中立 | rules、round、phase、activeSeat、decisionSeats、public.prelude、neutrality、neutralityNotices、redistributed |
| 地图与补给、兵模 | reference（静态）与 mapFacts（动态），见下 |

## 资料契约（接口 1.1.0）

观察带 reference={id,version,rulesFingerprint}；新增认证 POST /api/local-ai/reference，body={referenceId}。不匹配明确 REFERENCE_MISMATCH。响应 {data,digest}；digest 为 JSON.stringify(data) 的 UTF-8 SHA-256。

静态 data.map 直接来自正式 MAP（含地区完整属性、baseEdges、straits、版本/来源摘要），countries 和 printedUnitTotals 取正式常量。大本营、补给点印刷属性不等于当前有效值，动态看 mapFacts。

mapFacts 从正式 public 投影构建，逐国调用 adjacentRegions、homeRegion、supplySource、alwaysSupplied、sharedSupply、reserve，部队调用 suppliedUnits，陆地控制调用 landControllers。覆盖六国及法国、中国。记录临时补给 flags，但不复制图算法、计分算法或规则判断。静态海峡规则取正式结构和默认控制，实际当前连接取逐国查询；没有假设同阵营永久拥有相同大本营或补给来源。

CLI 自动校验 session.json.reference.json：规则指纹、资料版本、接口/游戏版本及内容摘要全部匹配才复用。缓存损坏或版本旧会重新请求；服务端给错资料则明确失败。新增 reference 命令打印静态数据。changes 包括 mapFacts/reference，不另建历史知识系统。

## 包与验证

使用 `node scripts/build-multiplayer.mjs --ai`，包目录后缀 ai增强版，内部游戏版本仍1.8.4。常规打包路径保留；普通包也携带服务静态 import 必需的 local-ai-http 文件，未开启时不监听AI端口。增强包带本机AI启动、CLI、资料缓存模块、runtime/node.exe、私有配置空模板和中文说明。增强包不复制回放样例，避免混入任何测试局。

AI接口程序与标准服务同一房间/data锁。普通入口显式清除 QM_LOCAL_AI；AI入口设置1，使用同一运行时。所有应用路径从脚本/包位置解析。精确增强身份在 version/ai-build.json；规则指纹与 ac94499 应一致，构建指纹按生成器正常变化。

自动化覆盖 tension 正/零/null，未知弃牌/可见历史与真实数量差异，海峡占领、special_257/210/211连接、大本营迁都与补给变化（42/48/91），八国储备及意大利平衡修正，静态缓存版本和摘要失效；回归原接口与联机权限。实际HTTP、独立CLI及最终解压包验收结果见交付说明。

边界：不改 src/core、src/data、游戏版本或回放协议，不添加GM权限，不自动跳过。未人工完整对打、未逐张覆盖所有卡牌和全部复杂选择；本轮补齐事实资料，不宣称全局策略正确。正式存档/回放仍执行原相同版本与规则身份检查，接口不放宽旧局兼容。

## 本轮验收结果

- 4 文件、44 项针对性测试通过（观察完整性6项，原接口与正式联机权限38项），类型检查和生产构建通过。
- 实际 HTTP / 多次独立 CLI 验证通过；新增 reference/cache 同时在真实解压包验证。
- 独立中文空格路径解压，从实际CMD入口启动；空 PATH / NODE_PATH、包内 runtime/node.exe 和 ws，普通入口不开AI端口，同数据目录双启动被拒绝。
- connect/status/observe/reference/wait、UTF-8请求文件、合法起手提交与重复不执行、断开重连通过；进程重启后GM使用 restore 恢复，再连接AI读取原对局通过。测试服务均关闭。
- 正式旧 1.8.4 标准及 GM编辑样例在增强包内解析与逐步重演通过。规则身份仍为 6f4cfa732581884ab38ab3a8463e6461a88e30b58825e480bd0938da9d511481；未放宽异版本校验。
- 仍未人工完整长局、未逐张验收全部卡牌组合/平台实机。没有模型或训练验证。

复现命令：`node scripts/verify-ai-portable.mjs --root "已解压的包目录" --area "独立测试资料目录"`。测试驱动使用已有 ws 作为模拟客户端；被测服务与CLI实际使用包内运行时及依赖，PATH/NODE_PATH清空、cwd设在包外；运行服务禁止打开浏览器。测试资料在 --area 和仅被测解压副本内产生，不写入候选发布目录。
