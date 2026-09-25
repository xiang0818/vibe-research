# 指令发现链:引擎怎么找到宪法与项目技能

产品的两样东西必须进到每一个 agent 线程里:**宪法** `AGENTS.md`(含产出红线)与**项目技能**
`.agents/skills/`(六个 SOP)。它们不是我们塞进提示词的,是**引擎自己去磁盘上找**的。
找不到时**引擎不报错** —— 只是提示词里没有它们,而报告照样产出。

所以这条链必须显式校验。实现见 [`orchestrator/src/instructions_root.ts`](../orchestrator/src/instructions_root.ts),
体检见 `doctor` 的「指令发现链」项。

## 规则(codex 0.149.0)

两者用**同一条规则**:

1. 从线程 cwd 向上找**第一个含 `project_root_markers` 的祖先** = project root。默认 marker 是 `[".git"]`;
   marker 是文件或目录都算;**找不到就只看 cwd 那一层**;空数组 = 关掉向上遍历。
2. 收集 **project root 到 cwd 之间每一层目录**里的 `AGENTS.md`(按顺序拼接)与 `.agents/skills`。
3. 不越过 project root。

源码:`codex-rs/core/src/agents_md.rs`(宪法)、`codex-rs/ext/skills/src/host_roots.rs`
的 `repo_agents_skill_roots`(项目技能)、`codex-rs/config/src/project_root_markers.rs`(marker)。

⇒ **线程 cwd(= 运行目录)必须是"放宪法与技能那一层"的后代**,我们把那一层叫**指令根**。

## 实测(七个探针)

用 `codex debug prompt-input` 渲染模型可见的提示词并检索金丝雀字符串。
**这个命令不调用模型、不花额度**,所以这类结论可以随时复验,不必靠读代码推断。

| 场景 | 宪法 | 技能 | 说明 |
|---|:--:|:--:|---|
| `git clone` 下来跑(有 `.git`) | ✅ | ✅ | 靠仓库自带的 `.git` 当 marker |
| **下载 zip 解压跑(无 `.git`)** | ❌ | ❌ | **静默全丢**,包括产出红线 |
| 无 `.git` + marker 文件 + `project_root_markers` | ✅ | ✅ | 修法 |
| 宪法放 `app/`、数据放兄弟目录 `data/` | ❌ | ❌ | 不在祖先链上,**怎么配都不行** |
| 同上,只加 marker 不移宪法 | ❌ | ❌ | 同上 |
| 装进用户自己的 git 仓库 + 默认 marker | ✅ | ✅ | ⚠️ **用户仓库的 AGENTS.md 与技能一起被读进来** |
| 装进用户自己的 git 仓库 + 自定义 marker | ✅ | ✅ | 外部内容不进来 |
| 链上任一层放 `AGENTS.override.md` | ❌ | — | **整份替换**该层的 `AGENTS.md` |

⚠️ **上表是 `debug prompt-info` 层的结论,不等于真实运行的结局。** 真实 `codex exec` 在**提示词组装之前**
还有一道门(下一节),所以"无 `.git`"那两行在真跑时表现为**硬失败**而不是静默丢失。
两张表要合起来看 —— 我一开始只看了这一张,把结论说成了"静默丢掉产出红线",**那是错的**。

- **第 6 行不是"发现不到",是反向污染。** 与 `~/.agents/skills` 那次(`skills_isolation.ts`)同一性质,
  只是这次走的是路径链而不是主目录。

## 🔴 提示词组装之前那道门:`exec` 要求 cwd 在 git 仓库里

```
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

**这句话的措辞有误导性**:判据与 `[projects] trust_level` **无关**,就是
`get_git_repo_root(cwd).is_none()`(`codex-rs/exec/src/lib.rs:798`)。实测:

| 场景 | 结果 |
|---|---|
| cwd 在真 git 仓库里 | ✅ 引擎启动 |
| cwd 不在 git 仓库里 | ❌ **exit 1**,不组装提示词、不调模型 |
| 不在 git 仓库 + `skipGitRepoCheck` | ✅ 启动 |

⇒ 产品**必开 `skipGitRepoCheck`**(`orchestrator/src/runner.ts`)。理由:运行目录是**产品自管的数据目录**、
不是用户源码树,agent 只往里写本次运行产物,这道门保护不到任何东西,却会让两种正常安装直接跑不起来:
**下载 zip 解压**(没有 `.git`)、**数据根在产品根之外**(分离安装)。

⇒ 所以真实运行的实际结局是:

| 安装方式 | 修复前 | 修复后 |
|---|---|---|
| `git clone` | ✅ 正常 | ✅ 正常 |
| **zip 解压到非 git 目录** | ❌ **每次运行 exit 1**(报错还看不懂) | ✅ 正常 |
| zip 解压到某个 git 仓库里 | ⚠️ 能跑,但**该仓库的 AGENTS.md 与技能会漏进来** | ✅ 正常,不漏 |
| **分离安装(数据根在产品根外)** | ❌ **exit 1** | ✅ 正常 |

## 产品怎么做

```
<指令根>/                    ← project root
  .vibe-research-root        ← marker,随仓库发行;分离安装时由编排器写
  AGENTS.md                  ← 宪法
  .agents/skills/            ← 六个 SOP 技能
  runs/<run-id>/             ← 线程 cwd
```

- `project_root_markers = [".vibe-research-root"]` 写进**产品自己的** `CODEX_HOME/config.toml`
  (生成块,幂等;块外若已有同名键会拒绝,避免两处互相覆盖)。
- **仓库内布局**(clone 下来自己跑):指令根 = 产品根,不搬任何东西。
- **分离安装**(数据根与产品根无路径关系,例如 `/Applications` + `~/Library/Application Support`):
  指令根 = 数据根,编排器把 `AGENTS.md` 与 `.agents/skills` **同步**过去(幂等、内容相同不写、
  删除目标端多余文件)。宪法**母本**始终是产品根那份,manifest 记的也是母本的 sha256,
  副本与母本逐字节相同由 preflight 保证。

## 运行前必须拒绝的六种情况

全都是静默失效,所以一条都不能只警告:

1. 运行目录不是指令根的后代。
2. 指令根缺 `AGENTS.md`。
3. 指令根缺 `.agents/skills`。
4. 指令根缺 `.vibe-research-root`。
5. `CODEX_HOME/config.toml` 没有 `project_root_markers` 生成块。
6. 链上任一层有 `AGENTS.override.md`(整份替换宪法)、或指令根**之外**的层有 `AGENTS.md`
   (会被追加)/ `.agents/skills`(会被当项目技能加载)。

分离安装时另加一条:指令根的宪法副本与产品根母本必须逐字节相同 —— 否则 manifest 记一份、引擎跑另一份。

## Codex 审计四轮挖出来的(都已修,记在这里免得以后改回去)

- 🔴 **`project_root_markers` 曾经完全没生效,而体检报 OK。** 块被追加到文件末尾,而 **TOML 的表头作用域
  会一直延续** —— 这个顶层键落进了 `[hooks.state."…"]`(在真实安装上用 `tomllib` 实测确认)。
  现在顶层键块一律放**文件最前面**,校验也改成"文件必须以预期块开头 + 块内容逐字相同 + 块外没有等价键",
  而不是查"块在不在"。⇒ **校验要盯效果,不能盯自己刚写下的痕迹。**
- **链上更近的 marker** 会把 project root 拉下来,指令根的东西一条都进不去,而其它检查全绿 → 现在拒绝。
- **技能镜像**只查目录在不在挡不住"同步到一半""副本被改""上一版残留" → 改为整棵树 sha256 比对。
- **符号链接**:目标端的链接会被"内容相同"判断当成已同步留下来(之后链接目标一改,引擎就加载外部内容);
  更严重的是**路径中间段**是链接时,清理逻辑会顺着它删掉**数据根之外**的文件 → 中间段一律拒绝,
  最后一层删掉重写(删链接不动目标)。
- **源与目标互相包含**时清理会删到源资产 → 直接拒绝。
- **路径比较**改用 realpath(词法比较在符号链接与 macOS 大小写不敏感下两个方向都会判错)。
- **生成块分隔符**只认独占整行、且不在多行字符串里、闭合检测认转义(`\"""` 不是结束符)——
  否则排查笔记里贴一段配置就会让安装**每次都抛、自己好不了**。
  为此把 `skills_isolation.ts` 里既有的逐行 TOML 扫描件抽成公共模块 `orchestrator/src/tomlscan.ts`。

## 分离安装的真实运行:已验证(四次真跑,2026-08-25)

⭐ **这一节原来是"未验证的残留",真跑之后挖出三个额外阻塞** —— 只靠静态分析与 `prompt-input`
一个都发现不了。

| 跑第几次 | 结果 | 挖出什么 |
|---|---|---|
| 1 | ❌ 阶段 failed,**钩子 0 次调用**,三次尝试相隔 46 毫秒 | `exec` 的 git 仓库门 → 引擎根本没启动(**没烧额度**) |
| 2 | ✅ 阶段 complete,但**钩子 5 次调用 5 次 error** | `contextMatchesCwd` 还要求运行目录在**产品根**之下 → PreToolUse 执行纪律**全程失效**,而阶段照样 complete |
| 3 | ✅ 阶段 complete,钩子 6 次调用 **0 error** | 两条都修好了 |
| 4 | ✅ 同上(数据根建在 `$HOME` 下,贴近真实安装位置) | 顺带发现 `allowedPathPrefixes` 缺 `dataRoot` |

三条修复:

1. **`skipGitRepoCheck: true`**(`runner.ts`)—— 见上一节。
2. **钩子上下文的边界改成数据根**(`hooks.ts` `contextMatchesCwd`)。
   ⚠️ 第 2 次那种失败最阴:**运行成功、报告产出、阶段 complete**,只有 `manifest.hooks.errors` 里
   写着 5。⇒ 执行层"没跑"和"跑了没拦到"在产出上长得一模一样。
3. **`allowedPathPrefixes` 加上 `dataRoot`**(`config.ts`)。⚠️ 这条**临时目录测不出来**:
   `/var/folders` 恰好在默认白名单里,得把数据根放到 `$HOME` 下才暴露。

## Shell 模式约束与 M37 含空格路径支持

执行层的命令扫描器按空白切 token 找绝对路径,路径里带空格会被切断 ——
`~/Library/Application Support/X/runs/…` 只剩 `/Users/…/Library/Application`,与允许前缀永远对不上,
于是 agent **每一条引用运行目录绝对路径的命令都会被拒**(实测)。

⇒ 显式 `shell_hooks` 仍在配置期拒绝含空白的产品根 / 数据根。
⇒ M37 起，未显式指定执行层时，含空白路径自动使用已有 `controlled_mcp`，由受控工具用独立 argv 取数、计算、读写本阶段产物，不经过 Shell 扫描器。Windows 默认也使用该模式；无空白的其他平台默认不变。
⇒ Mac 安装版默认数据根仍为 `~/.vibe-research-desktop`；此调整不迁移数据、不更换登录态、不改变用户 Agent 开关。
⇒ 之所以不去改扫描器的分词:那套规则是用 1,142 条真实命令语料回归过的,动它的风险比这条限制大。

## 已知残留

- **`init` 与 `doctor` 仍要求数据根在产品根内** —— 那是面向仓库内布局的策略,不是运行路径的限制
  (运行路径已实测支持分离安装)。分离安装的初始化归 launcher(未开工)。
- 用户想改宪法时没有官方口子:`AGENTS.override.md` 会**整份**替换掉产出红线,所以我们直接拒绝它。
  要给用户定制能力,得另设一个"追加"而非"替换"的槽位。
