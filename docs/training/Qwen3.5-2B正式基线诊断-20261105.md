# Qwen3.5-2B 正式游戏基线诊断

本页保留首轮数据。现行提示词、规则核对及启动方式见 [规则与动作协议复验](Qwen3.5-2B规则与动作协议复验-20261105.md)。

## 运行入口

在 `D:/Codex/QuartermasterGeneral/worktrees/training-qwen-baseline` 双击 `启动Qwen正式基线诊断.cmd`。该工作树固定使用客户端 v1.8.4、AI 接口 1.2.1，正式基线为 `c13904a0829f310e39f798215882653c21c26d64`。规则指纹为 `994ca2cfa372a35ac8b1fb382aafb158ff3410c357f3ccb33441c5279cd5a8a7`。

| 菜单 | 操作 |
| --- | --- |
| 1 | 只读预览模型、环境、源码及游戏身份 |
| 2 | 加载模型，按实际分词测短、中、长游戏输入，最多 9 分钟 |
| 3 | 跑 30 个固定局面，每个局面检验一个主要决策 |
| 4 | 跑两局正式完整规则自对弈，按当前决策在两个三国身份间切换 |
| 5 | 打开本地结果目录 |
| 0 | 退出 |

也可从工作树执行 `D:/LLMs/environments/qm-qwen35-baseline/runtime/node.exe scripts/qwen-baseline/run.mjs preview`。将 `preview` 换成 `bench`、`fixtures` 或 `games` 执行对应菜单。用 Ctrl+C 停止当前批次。每次运行单开结果子目录，完成的场景和局已经导出的记录保留在其中。

## 环境与观察边界

- Python 3.12.1、PyTorch 2.10.0+cu128、Transformers 5.3.0、Accelerate 1.12.0 和 Node v24.22.1。Python 环境在 `D:/LLMs/environments/qm-qwen35-baseline`，依赖清单见 `scripts/qwen-baseline/requirements.lock.txt`。Node 工作树依赖使用 `pnpm install --frozen-lockfile`。
- 模型使用 `D:/LLMs/models/Qwen3.5-2B`，revision 为 `15852e8c16360a2fea060d615a32b45270f8a8fc`。运行前核对下载清单身份及文件大小。使用官方聊天模板的 `enable_thinking=False`。单模型、单请求、纯文本、贪心，最多生成 128 tokens。每个请求使用自身 KV 缓存。跨请求前缀缓存关闭，两个阵营分别保存最近一次可见行动摘要。
- 诊断进程内建立隔离的正式房间，以两名正式普通玩家各绑定一方三国。模型进程通过 UTF-8 JSONL 管道接收合法观察，不开监听端口。提示每步重建，包含当前动态地图、补给、海峡、计分、相关卡面及正式候选。未知牌面及实际牌序按正式权限过滤。
- 模型返回候选编号和该候选明确列出的类型化参数。适配器编译正式请求并检查局面版本。非法输出最多纠正一次，仍失败停止该局。起手、普通出牌、序章、目标、发动或放弃响应、支付、空军、排序及多选沿用正式接口候选；模型基线默认逐个决策提交。引擎仍处理打断和后续窗口。同名触发附带正式窗口 ID，人工港的两个建海位置可区分。
- 30 个固定局面中 12 个与补给相关，其余覆盖征召与建设、计分、攻击与消灭、费用、同名触发、原地操作、可放弃响应、起手和弃牌。事实分为投影事实读取和机制应用；战略选择不设唯一正确动作。两局自对弈启用平衡、序章、中立，固定种子 20261105 / 20261106。单局最多 3500 次决定或 4 小时，每次请求 180 秒。自然终局、非法输出、循环、未知窗口与预算停止分别记录。
- 本地输出在 `outputs/qwen-baseline/runs`。包括 `run.json`、模型加载及输入性能、实际可见观察和候选、模型原始输出、执行、停止原因、统计及正式 `formatVersion=3` 回放。单局回放按现有 v1.8.4 客户端的「导入回放」入口读取。回放和诊断日志含完整对局或双方私有观察，仅留本地。构建元数据区分基线客户端构建身份和实际诊断 bundle SHA-256。

## 验收范围

源码和诊断脚本通过类型检查，AI 联机及接口回归 39 项通过。通过 7 项由正式引擎执行的诊断样本，包括起手、强制弃牌、序章、人工港窗口、空军防御、支付费用和合并建设。样本均由正式客户端使用的回放读取器与校验器通过检查。该项为无界面验证。30 局面完整模型批次及两局自对弈留给用户手动启动。

## 真实模型短测

默认后端为 `efficient-bf16`。它在本机以 Triton 执行 Gated Delta 和预填充卷积，显式展开 KV 后使用 PyTorch 内存高效 SDPA。Windows 本机配置使用独立目录 `D:/LLMs/environments/qm-qwen35-kernels` 中的 Triton Windows 3.6.0.post26、flash-linear-attention 0.4.2、fla-core 0.4.2 和 einops 0.8.2，编译缓存另存于 `D:/LLMs/environments/qm-qwen35-kernel-cache`。可用 `QM_QWEN_BACKEND=reference-bf16` 复查默认 PyTorch 后端，或用 `QM_QWEN_BENCH_SECONDS` 设置 1–540 秒的性能短测总预算。所用模型权重完全相同。未采用 CPU 卸载、量化、输入截断或跨请求前缀缓存。

| 真实输入 | 输入 / 输出 tokens | 首 token | 请求总时间 |
| --- | ---: | ---: | ---: |
| 短，进程内首个生成请求 | 8,089 / 14 | 2.54 秒 | 8.93 秒 |
| 短，模型与内核已预热 | 8,089 / 14 | 1.46 秒 | 2.04 秒 |
| 中，人工港窗口 | 8,702 / 未取得 | 未取得 | 总预算剩余 28.11 秒时中止 |
| 长，序章与中立 | 9,846 / 未运行 | 未测 | 仅完成分词 |

成功的两条请求中，模型生成分别用时 8.91 和 2.02 秒，剩余约 26 和 17 毫秒用于分词、传输到设备前后的同步以及解码等工作。正式引擎的观察和提交耗时另记。两条输出的 `select.fields` 都超出候选契约，未进入结算。本次未验证真实模型能通过纠正重试或完成一次合法操作。

该次冷启动指新的模型进程，Triton 磁盘编译缓存已由前序探针部分预热。默认后端冷进程到就绪 16.90 秒，其中模型和 tokenizer 加载 7.13 秒。BF16 CUDA 参数中，文本占 3.51 GiB，未调用的视觉部分占 0.62 GiB。短请求整卡显存峰值 6.46 GiB，PyTorch 分配峰值 4.81 GiB。中输入中止前，采样到整卡 6.97 GiB、PyTorch 分配 4.72 GiB。该次进程加载期间 Python RSS 峰值约 4.90 GiB，系统内存总使用峰值约 15.00 GiB。整卡和全系统数值含其他应用。

PyTorch 回退、只开 Triton 线性注意力、再加 Triton 卷积但保留默认 SDPA，三次均在 8,089 tokens 的首条请求等待 180 秒后停止。后两种记录到的 PyTorch 显存分配峰值分别约 8.73 和 9.24 GiB，超过 8 GB 物理显存，未返回 OOM 错误。默认高效后端的成功短请求保留了完整输入。中长输入仍待完成测量。累计实际推理短测在 10 分钟上限内，未运行 30 局面模型批次和 2 局完整对局。

原始报告在 `outputs/qwen-baseline/runs/2026-11-05T07-08-52-060Z-bench-f42df383`。对应的 [Qwen 模型卡](https://huggingface.co/Qwen/Qwen3.5-2B)、[Transformers Qwen3.5 文档](https://github.com/huggingface/transformers/blob/main/docs/source/en/model_doc/qwen3_5.md) 和 [Triton Windows 兼容表](https://github.com/triton-lang/triton-windows/blob/readme/README.md) 可用于复核运行依赖。
