# 参与开发和规则讨论

开发（包括AI）先读 [AGENTS.md](AGENTS.md)。仓库首次上传为源码基线，后续以独立目录、任务分支和PR协作。

## 讨论入口

- Bug：用Issue填写版本、规则开关、国家、卡牌ID、复现步骤、预期/实际行为。附文件前检查是否含全知手牌、用户信息或访问令牌。
- 平衡：在Discussion（启用后）讨论打法和数据；明确可执行的调整用“规则/平衡提案”Issue。没有Discussion时也可直接用该Issue模板。
- 提案经维护者接受后，再由PR实施。Issue关闭时链接实际提交与验证结果。

建议标签：client、training、rules、balance、replay、bug、needs-training-sync。标签需仓库维护者在GitHub设置中建立；模板不依赖其已存在。

## 第一次接手

```sh
git clone git@github.com:baoliezhiyan/quartermaster-general.git quartermaster-client
cd quartermaster-client
git switch -c codex/client-your-task
pnpm install --frozen-lockfile
```

训练开发另clone到 `quartermaster-training` 并创建 `codex/training-your-task`，或在支持的平台使用独立worktree。不要两人共用当前目录。

完成后检查diff，按文件暂存，提交并push自己的分支，在GitHub对main创建PR。共享规则变更填写PR中的训练影响与兼容性栏目。直接在main编辑不属于推荐工作流。

## 版本说明

package.json为游戏应用版本；规则版本、训练课程/编码版本和回放协议各自独立。训练冻结基线不是“当前最新版本”，应记录精确提交与指纹。详见 [文档导航](docs/README.md)。
