# 确定性估值计算库

状态:已实现(Phase 0)。纯函数 + fixture 测试;agent 只选输入、解释输出,计算由代码完成,可复算可审计。

| 文件 | 作用 |
|---|---|
| `formulas.py` | 扣非×4 PE / 前瞻 PE / TTM PE 拼装 / 前瞻 CAGR / 通用增速 / PEG / PE 消化年数(单锚 + 四锚情景)/ 历史分位 / 一致预期分歧 / 前瞻 vs TTM 判读 |
| `series.py` | 报告期累计值 → 单季(quarterize)/ 最新单季 / TTM 求和 / TTM 同比 / 环比 |
| `cli.py` | 唯一调用入口:`python3 calc/cli.py <function> --args '<JSON>' [--evidence ev-…] [--calc calc-…] [--run-dir DIR]`;输出带确定性 `calculation_id`(含实参、引用 DAG、序列文件 sha256)、`inputs_refs`、`inputs_resolved`;严格 JSON(无 NaN);退出码 0 / 2 / 3,错误分类 bad_args / bad_refs / bad_input / internal_error |
| `SPEC.md` | 函数契约:输入单位、无意义域、error 域、口径约定 |
| `tests/` | pytest;`python -m pytest calc/tests -q --cov=calc` |

原则:金额必须带单位(元 / 万元 / 亿元)由库归一;比率一律小数;绝不返回 inf / NaN;无意义域返回 `not_meaningful` 而不是伪装成数。

## 0.3.2(2026-08-22):展示层 `display`

`cli.py` 在记录落盘前给 `output` 附 `display` 字符串(`calc/display.py`,确定性、无 locale):|x|≥1 留 2 位小数、|x|<1 留 4 位有效数字(0.6328580 → "0.6329",小数不只留 2 位免得丢信息;舍入误差都在编排器数字绑定容差内);`小数` → 百分比("200.42%");金额按量级换算("204.53 亿元" / "3.25 万元" / "943.00 元");`期` 取整;status ≠ ok 时为 `null`。报告正文照抄 `display`,不让 agent 对 15 位浮点做心算;`value` 仍是复算 / 绑定校验的真理源,公式层依旧不四舍五入。

## 0.3.0(2026-08-22):技术指标与筹码分布进 calc

`technical_indicators` / `chip_distribution`(`calc/indicators.py`)+ CLI 序列输入 `history_json`(读 raw 的 JSON / JSONP K 线表,含数组行 / 对象行 / where 过滤,路径安全与身份规则同 `history_csv`)。取数层不再计算派生量;这两类数值从此经 calc 记 DAG。测试:`calc/tests/test_indicators.py`。
