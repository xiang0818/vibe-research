# 金融 SOP Skills

Codex 项目级 skill 的真实发现路径是 `.agents/skills/<名>/SKILL.md`(源码核实:`codex-rs/skills/src/selection_tests.rs`)。
⛔ 放在仓库根目录 `skills/` 不会被加载。

| skill | 状态 | 内容 |
|---|---|---|
| data-access | 已实现并过审(Phase 0 + Phase 1 M1) | 8 个 legacy 脚本(行情 / 画像 / 财务累计值 / 一致预期 / PE 历史 / 公告 / K 线 / 交易日历)+ `fetch_endpoint.py` 通用取数器 × `datasources/registry.json` 115 端点 / 29 层(`sources/` 28 个源模块 + mapper);内置备源、限流、原始落盘、契约 evidence;取数层零派生计算(SKILL.md §7) |
| company-research | 已实现并过审(Phase 0 + Phase 1 M2) | 个股研究六阶段 SOP:每阶段取数 / calc 函数 / Gate / 产物;report 骨架;§6 扩展数据使用规则(extra_findings / 知识档案裁决 / 指标与筹码经 calc) |
| valuation | 已实现(2026-08-22) | 成长股估值口径:扣非×4 PE / 前瞻 PE / TTM 分位 / PEG(扣非×4 ÷ 前瞻 CAGR)/ 前瞻 vs TTM 交叉验证 / 一致预期分歧 / 四锚消化年数与 30 倍锚三铁律 / 判读与常见错误;数字一律经 calc,不给价格锚 |
| earnings-analysis | 已实现(2026-08-22) | 财报拆解:累计 → 单季 → TTM / 同比 / 环比口径地图,扣非 vs 归母,季节性与报告期对齐,三表交叉,比率经 calc `ratio`(0.3.1),质量检查与判读模板 |
| industry-chain | 已实现(2026-08-22) | 产业链下钻与不可替代性:六步下钻 × 每层四问,物理硬筛子(扩产周期 / 良率 / 认证 / 替代路线),标签 tech_moat / capacity_moat / both / 待补 + 证据,"卡口越硬越贵"与预期差四问校准 |
| catalyst-risk | 已实现(2026-08-22) | 催化剂与风险(反证强制):催化剂四类与验证时点,风险十类与反证数据,裁决点标准写法,知识档案旧结论处理 |

SKILL.md frontmatter:本项目规范要求显式 `name`(≤64 字符)与 `description`;Codex 解析器(`codex-rs/skills/src/parser.rs`)在 name 缺省时会回退目录名,但 description 为空直接拒绝。

各 skill 目录在实现时才创建(空目录不入 git,且无 SKILL.md 的目录对 Codex 无意义);AGENTS.md 对 data-access 的引用随该 skill 落地生效。
