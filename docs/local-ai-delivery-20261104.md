# 1.8.4-ai增强版交付（2026-11-04）

最终压缩包：`D:\Codex\QuartermasterGeneral\worktrees\client-v183\战场军需官\releases\战场军需官-v1.8.4-ai增强版.zip`

大小：100,023,689 字节。SHA-256：`3db56c1ee70564a7842c34bca60357c075ef421e3f53b70aaf47e75679542fe6`。

游戏 v1.8.4，AI接口1.2.1。包源码提交 `d354ac193e76d69b7c93a15d61ca1d1e1fa0d9a0`（已验收运行实现09ff1bd，增加发布说明及元数据）；规则指纹 `994ca2cfa372a35ac8b1fb382aafb158ff3410c357f3ccb33441c5279cd5a8a7`，构建指纹 `da7f7d50bc35b0620c5d02337316360447a60867e3d2aac6730308f0d6faf688`。后续仅修正解压验收脚本的GM同步修订号读取，不改变包内运行代码或此包身份。

按正式脚本构建；自带Node、ws、隧道工具、普通入口、AI入口、CLI、空凭据模板及中文说明。旧1.1.0包与其干净解压目录保留在 outputs/previous-ai-interface-1.1.0，没有删除用户数据。空“对局记录”目录已进入ZIP。包内只有空token模板，没有data、玩家身份/返回链接、真实或测试记录、观察缓存、模型或训练产物。

在 `outputs/AI交付验证 1.2.1/解压/战场军需官-v1.8.4-ai增强版` 直接运行解压包，使用空PATH、空NODE_PATH、包内Node与ws、隔离端口19483/19485、隔离数据/私有日志/记录目录、后台实际CMD入口。验收通过：普通入口无AI端口；AI入口及网页；重复入口拒绝；connect/status/observe/reference/wait；过期静态缓存刷新；UTF-8单步提交与重复防护；断开重连；正式GM直接恢复；合并建设2步、submit-action --wait、可还原紧凑变化、result和重复幂等；wait-decision返回真正己方决策；日志无令牌。测试服务已关闭。ZIP内静态哈希清单核对通过、CRC检查通过。

原源码1004项验收结果见 local-ai-actions.md；打包本身没有改动正式规则、权限或回放契约，没有重跑训练或启动用户对局。旧指纹动作回放及带旧身份记录的主机档案仍不自动兼容，未提供跨指纹迁移。本次仅本地交付，未发布GitHub Releases。
