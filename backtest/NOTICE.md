# 第三方代码归属

本目录下的**回测引擎**移植自 [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)，
MIT 协议，`Copyright (c) 2026 Vibe-Trading Contributors`。协议全文见 `LICENSE.upstream`。

移植基线：上游 `main @ 002373ef32800d4f7d70b418eb4e3bf9d030a5bc`（2026-08-26）的 `agent/backtest/`。

## 原样搬来的（逻辑未改）

| 文件 | 内容 |
|---|---|
| `models.py` | 持仓 / 成交 / 交易 / 权益的不可变数据类 |
| `constraints.py` | 组合约束 |
| `metrics.py` | 指标（夏普 / 卡玛 / 索提诺 / 最大回撤 / 胜率 / 盈亏比 / 换手 / 相对基准） |
| `validation.py` `rebalance_notes.py` `risk_xray.py` `run_card.py` | 校验、调仓说明、风险 X 光、run card |
| `engines/base.py` | 逐 bar 撮合内核 |
| `engines/china_a.py` | A股规则：T+1 / 涨跌停 / 100 股整手 / 印花税 |
| `engines/global_equity.py` | 美股 · 港股 · 加拿大规则 |
| `engines/_market_hooks.py` | 代码 → 市场分类、币种 |

## 相对上游的改动（仅两处，均为**移除依赖**，不动算法）

1. **`engines/base.py`** — 事件（RSSHub）与基本面（Tushare）两路增强改成**惰性 import**。
   这两路没有随本产品发行（前者要自建服务、后者要付费 key，而本产品的数据一律走自己的取数层）。
   `config` 没点名就永远不 import；点名了就报清楚的错，**不静默跳过**。
2. **`benchmark.py`** — 删掉 yfinance 兜底（同上），并让原本静默的取数失败出声。

## 本产品新写的（不属于上游）

| 文件 | 内容 |
|---|---|
| `loader.py` | 把本产品的取数端点接到引擎上 —— 整个移植里唯一的新数据代码 |
| `gate.py` | 回测闸口：判要回测什么 → 需要什么 → 限制是什么 |
| `run.py` | 接线 + 运行期守卫 + 结果呈现 |
| `strategies.py` | 内置策略（也是"策略长什么样"的模板） |
| `tests/` | 137 条测试 |

## 没有搬的

`loaders/`（25+ 数据源）· `optimizers/`（组合优化）· 期货 / 外汇 / 加密 / 印度 / 韩国 / 越南 /
期权 / composite 引擎 · `regime.py` `correlation.py` `factor_costs.py` 等。
数据一律走本产品自己的取数层；其余引擎等对应市场接进来时再说。
