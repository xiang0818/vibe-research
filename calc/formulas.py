"""确定性估值公式库(纯函数)。口径来源:AGENTS.md §3(R6.5);精确契约见 SPEC.md。

约定:
- 所有函数返回 dict:{"status": "ok" | "not_meaningful" | "error", "value": 数值或 None, "unit": 单位,
  "reason": 说明(非 ok 时), "details": 中间量}。绝不抛出业务异常;返回树中任何位置都不会出现 inf / NaN(递归守卫)。
- 金额输入必须带单位,只认 元 / 万元 / 亿元,内部归一到元;未知单位 / 缺失 / 溢出 → error,不猜。
- 比率一律小数(0.25 = 25%);疑似百分数误传(|x| 超出业务合理域)→ error。
- 不做四舍五入;展示层自行格式化。
"""
from __future__ import annotations

import math
from typing import Any, Iterable, Optional

CALC_VERSION = "0.3.2"  # 0.3.2:output 增 display 展示字符串(cli 层附加,公式层不变);0.3.1:ratio;0.3.0:新增 technical_indicators / chip_distribution 与 history_json 序列输入

UNIT_TO_YUAN = {"元": 1.0, "万元": 1e4, "亿元": 1e8}
MAX_ABS_CAGR = 5.0       # 年化增速 |x| > 500% 视为百分数误传
MAX_ABS_YOY = 20.0       # 同比 |x| > 2000% 视为误传(低基数极端情形仍在此内)
MAX_YEARS = 10


class CalcInputError(ValueError):
    """输入非法(缺失 / 单位未知 / 非有限数 / 越界),由各函数转为 status=error。"""


def _has_nonfinite(obj: Any) -> bool:
    """递归检查返回树中是否有 inf / NaN。"""
    if isinstance(obj, bool):
        return False
    if isinstance(obj, float):
        return not math.isfinite(obj)
    if isinstance(obj, dict):
        return any(_has_nonfinite(v) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return any(_has_nonfinite(v) for v in obj)
    return False


def _res(status: str, value: Optional[float] = None, unit: str = "", reason: str = "", **details) -> dict:
    """统一返回结构。value 或 details 任何位置出现 inf / NaN 一律转为 error,绝不伪装成结果。"""
    out = {"status": status, "value": value, "unit": unit, "reason": reason, "details": details}
    if _has_nonfinite(out):
        return {"status": "error", "value": None, "unit": unit,
                "reason": "结果或中间量出现非有限数(溢出 / NaN),输入量级或内容不合理", "details": {}}
    return out


def _err(reason: str, **details) -> dict:
    return _res("error", reason=reason, **details)


def _num(x: Any, name: str, required: bool = True) -> Optional[float]:
    """数值校验:None(required 时)/ 布尔 / 非数 / 非有限 → CalcInputError。"""
    if x is None:
        if required:
            raise CalcInputError(f"{name} 缺失")
        return None
    if isinstance(x, bool):
        raise CalcInputError(f"{name} 不能是布尔值")
    try:
        v = float(x)
    except (TypeError, ValueError) as e:
        raise CalcInputError(f"{name} 不是数值:{x!r}") from e
    if not math.isfinite(v):
        raise CalcInputError(f"{name} 不是有限数")
    return v


def _ratio(x: Any, name: str, max_abs: float) -> float:
    """比率(小数)校验;|x| > max_abs 视为百分数误传。"""
    v = _num(x, name)
    if abs(v) > max_abs:
        raise CalcInputError(f"{name}={v} 超出合理域(|x| ≤ {max_abs}),疑似把百分数当小数传入")
    return v


def _int_years(x: Any, name: str = "years") -> int:
    if isinstance(x, bool) or not isinstance(x, int):
        raise CalcInputError(f"{name} 必须是正整数")
    if x < 1 or x > MAX_YEARS:
        raise CalcInputError(f"{name} 必须在 1..{MAX_YEARS}")
    return x


def to_yuan(value: Any, unit: str, name: str = "金额") -> float:
    """金额归一到 元;缺失 / 非数 / 未知单位 / 溢出 → CalcInputError。"""
    v = _num(value, name)
    if unit not in UNIT_TO_YUAN:
        raise CalcInputError(f"{name} 单位 {unit!r} 不支持;只认 元 / 万元 / 亿元")
    y = v * UNIT_TO_YUAN[unit]
    if not math.isfinite(y):
        raise CalcInputError(f"{name} 换算为元后溢出")
    return y


def _finite(x: float, what: str) -> float:
    if not math.isfinite(x):
        raise CalcInputError(f"{what} 溢出")
    return x


def _pe(mcap_value, cap_unit, denom_value, denom_unit, denom_label: str, scale: float = 1.0) -> dict:
    """PE 公共实现:总市值(元)÷(分母金额(元)× scale)。市值 ≤ 0 或分母 ≤ 0 → not_meaningful;任何溢出 → error。"""
    try:
        mcap = to_yuan(mcap_value, cap_unit, "total_market_cap")
        d = to_yuan(denom_value, denom_unit, denom_label)
        annual = _finite(d * scale, f"{denom_label}×{scale}")
    except CalcInputError as e:
        return _err(str(e))
    if mcap <= 0:
        return _res("not_meaningful", unit="倍", reason="总市值 ≤ 0", mcap_yuan=mcap)
    if annual <= 0:
        return _res("not_meaningful", unit="倍", reason=f"{denom_label} ≤ 0,PE 无意义", mcap_yuan=mcap,
                    denominator_yuan=annual)
    try:
        v = _finite(mcap / annual, "PE")
    except CalcInputError as e:
        return _err(str(e))
    return _res("ok", v, "倍", mcap_yuan=mcap, denominator_yuan=annual, denominator_label=denom_label)


# ---------------------------------------------------------------- PE 类
def pe_deducted_annualized(total_market_cap, cap_unit: str, latest_quarter_deducted_profit, profit_unit: str) -> dict:
    """扣非×4 年化 PE = 总市值 ÷ (最新单季扣非净利润 × 4)。单季扣非 ≤ 0 或市值 ≤ 0 → not_meaningful。"""
    out = _pe(total_market_cap, cap_unit, latest_quarter_deducted_profit, profit_unit, "最新单季扣非净利润", 4.0)
    if out["status"] == "ok":
        out["details"]["quarter_profit_yuan"] = out["details"]["denominator_yuan"] / 4.0
        out["details"]["annualized_profit_yuan"] = out["details"]["denominator_yuan"]
    return out


def pe_ttm_from_parts(total_market_cap, cap_unit: str, ttm_profit, profit_unit: str) -> dict:
    """TTM PE = 总市值 ÷ 近 4 季净利和(与数据源 PE_TTM 交叉验证)。TTM ≤ 0 或市值 ≤ 0 → not_meaningful。"""
    out = _pe(total_market_cap, cap_unit, ttm_profit, profit_unit, "TTM 净利润", 1.0)
    if out["status"] == "ok":
        out["details"]["ttm_yuan"] = out["details"]["denominator_yuan"]
    return out


def forward_pe(price, eps_forecast) -> dict:
    """前瞻 PE = 现价 ÷ 一致预期 EPS(FY T 均值)。价格 ≤ 0 或 EPS ≤ 0 → not_meaningful。"""
    try:
        p, e = _num(price, "price"), _num(eps_forecast, "eps_forecast")
    except CalcInputError as ex:
        return _err(str(ex))
    if p <= 0:
        return _res("not_meaningful", unit="倍", reason="价格 ≤ 0", price=p)
    if e <= 0:
        return _res("not_meaningful", unit="倍", reason="一致预期 EPS ≤ 0,前瞻 PE 无意义", eps=e)
    return _res("ok", p / e, "倍", price=p, eps=e)


# ---------------------------------------------------------------- 增速类
def forward_cagr(eps_t, eps_t_plus_n, years: int = 2) -> dict:
    """前瞻 CAGR = (EPS[T+n] ÷ EPS[T])^(1/n) − 1(默认 n=2,n 为 1..10 的整数)。任一 EPS ≤ 0(跨零)→ not_meaningful。结果为小数。"""
    try:
        a, b = _num(eps_t, "eps_t"), _num(eps_t_plus_n, "eps_t_plus_n")
        n = _int_years(years)
    except CalcInputError as ex:
        return _err(str(ex))
    if a <= 0 or b <= 0:
        return _res("not_meaningful", unit="小数", reason="起点或终点 EPS ≤ 0(跨零),年化增速无意义", eps_t=a, eps_t_plus_n=b)
    return _res("ok", (b / a) ** (1.0 / n) - 1.0, "小数", eps_t=a, eps_t_plus_n=b, years=n)


def growth_rate(current, base, label: str = "growth") -> dict:
    """通用增速 = current ÷ base − 1(小数)。base ≤ 0 → not_meaningful(负基数下的比率无意义);current 可为负。"""
    try:
        c, b = _num(current, "current"), _num(base, "base")
    except CalcInputError as ex:
        return _err(str(ex))
    if b <= 0:
        return _res("not_meaningful", unit="小数", reason=f"{label}:基期值 ≤ 0,增速无意义", current=c, base=b)
    return _res("ok", c / b - 1.0, "小数", current=c, base=b, label=label)


def ratio(numerator, denominator, label: str = "ratio", unit_in: str = "") -> dict:
    """通用比率 = numerator ÷ denominator(小数)。用于毛利率 / 费用率 / 负债率 / 占比等"同单位两数之比"。
    分母 ≤ 0 → not_meaningful(负或零分母下的比率无意义);分子可为负(亏损毛利为负照实)。
    unit_in 只作记录(两数必须同单位,由调用方保证并在 details 留痕);不做任何单位换算。"""
    try:
        n, d = _num(numerator, "numerator"), _num(denominator, "denominator")
    except CalcInputError as ex:
        return _err(str(ex))
    if d <= 0:
        return _res("not_meaningful", unit="小数", reason=f"{label}:分母 ≤ 0,比率无意义", numerator=n, denominator=d, unit_in=unit_in)
    return _res("ok", n / d, "小数", numerator=n, denominator=d, label=label, unit_in=unit_in)


# ---------------------------------------------------------------- 估值合成
def peg(pe, cagr) -> dict:
    """PEG = PE ÷ (CAGR × 100)。PE ≤ 0 或 CAGR ≤ 0 → not_meaningful;|CAGR| > 5 视为百分数误传 → error。"""
    try:
        p, g = _num(pe, "pe"), _ratio(cagr, "cagr", MAX_ABS_CAGR)
    except CalcInputError as ex:
        return _err(str(ex))
    if p <= 0:
        return _res("not_meaningful", unit="倍", reason="PE ≤ 0", pe=p, cagr=g)
    if g <= 0:
        return _res("not_meaningful", unit="倍", reason="CAGR ≤ 0,PEG 无意义", pe=p, cagr=g)
    return _res("ok", p / (g * 100.0), "倍", pe=p, cagr=g)


def pe_digestion_years(pe, cagr, anchor) -> dict:
    """PE 消化年数 = ln(PE ÷ 锚) ÷ ln(1 + CAGR)。
    PE ≤ 锚 → 0 年(已在锚下,details.below_anchor=True);PE ≤ 0 或 CAGR ≤ 0(且 PE > 锚)→ not_meaningful;
    锚 ≤ 0 → error;|CAGR| > 5 → error。"""
    try:
        p, g, a = _num(pe, "pe"), _ratio(cagr, "cagr", MAX_ABS_CAGR), _num(anchor, "anchor")
    except CalcInputError as ex:
        return _err(str(ex))
    if a <= 0:
        return _err("锚必须 > 0", anchor=a)
    if p <= 0:
        return _res("not_meaningful", unit="年", reason="PE ≤ 0", pe=p, anchor=a)
    if p <= a:
        return _res("ok", 0.0, "年", pe=p, cagr=g, anchor=a, below_anchor=True)
    if g <= 0:
        return _res("not_meaningful", unit="年", reason="CAGR ≤ 0,PE 永远消化不到锚", pe=p, cagr=g, anchor=a)
    return _res("ok", math.log(p / a) / math.log(1.0 + g), "年", pe=p, cagr=g, anchor=a, below_anchor=False)


ANCHOR_SCENARIOS = {"景气延续": 30.0, "中性减速": 25.0, "周期重定级_上沿": 22.0, "周期重定级_下沿": 18.0}


def pe_digestion_scenarios(pe, cagr) -> dict:
    """四锚(30 / 25 / 22 / 18)下的消化年数。返回 details.scenarios = {情景: 结果};任一情景 error 则整体 error。"""
    scen = {name: pe_digestion_years(pe, cagr, a) for name, a in ANCHOR_SCENARIOS.items()}
    if any(r["status"] == "error" for r in scen.values()):
        first = next(r for r in scen.values() if r["status"] == "error")
        return _err(first["reason"], scenarios=scen)
    ok_any = any(r["status"] == "ok" for r in scen.values())
    return _res("ok" if ok_any else "not_meaningful", None, "年",
                reason="" if ok_any else "所有情景均无意义(见 scenarios)", scenarios=scen, anchors=ANCHOR_SCENARIOS)


# ---------------------------------------------------------------- 分位与分歧
def percentile_rank(history: Iterable, current, exclude_nonpositive: bool = True) -> dict:
    """当前值在历史序列中的分位(0–100,百分比;= 历史中 ≤ 当前值的占比)。
    历史中非数 / 非有限值跳过并计数;默认剔除 ≤ 0 的历史值(亏损期 PE 无意义);有效样本 < 20 → not_meaningful。"""
    try:
        cur = _num(current, "current")
        if not isinstance(history, (list, tuple)):
            raise CalcInputError(f"history 必须是数值列表,收到 {type(history).__name__}")
    except CalcInputError as ex:
        return _err(str(ex))
    vals, skipped = [], 0
    for v in history:
        if isinstance(v, bool):
            skipped += 1
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not math.isfinite(fv) or (exclude_nonpositive and fv <= 0):
            skipped += 1
            continue
        vals.append(fv)
    n = len(vals)
    if n < 20:
        return _res("not_meaningful", unit="%", reason=f"有效历史样本 {n} < 20", n=n, skipped=skipped)
    if exclude_nonpositive and cur <= 0:
        return _res("not_meaningful", unit="%", reason="当前值 ≤ 0", n=n, skipped=skipped)
    le = sum(1 for v in vals if v <= cur)
    s = sorted(vals)
    med = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
    return _res("ok", 100.0 * le / n, "%", n=n, skipped=skipped, min=s[0], median=med, max=s[-1], current=cur)


def consensus_dispersion(low, mean, high) -> dict:
    """一致预期分歧:max ÷ min 与 (max − min) ÷ mean。要求 low ≤ mean ≤ high(否则 error);min ≤ 0 或 mean ≤ 0 → not_meaningful。"""
    try:
        lo, m, hi = _num(low, "low"), _num(mean, "mean"), _num(high, "high")
    except CalcInputError as ex:
        return _err(str(ex))
    if not (lo <= m <= hi):
        return _err("必须满足 low ≤ mean ≤ high", low=lo, mean=m, high=hi)
    if lo <= 0 or m <= 0:
        return _res("not_meaningful", reason="min 或 mean ≤ 0", low=lo, mean=m, high=hi)
    return _res("ok", hi / lo, "倍", low=lo, mean=m, high=hi, range_over_mean=(hi - lo) / m)


def forward_vs_ttm_judgement(forward_cagr_value, ttm_yoy_value, tolerance_pp=10.0) -> dict:
    """前瞻 CAGR 与 TTM 同比对照(AGENTS.md §3 三档)。输入为小数;tolerance_pp 为百分点阈值(默认 10pp,可配置,≥ 0)。
    |差| ≤ 阈值 → approx;前瞻低于 TTM 超阈值 → forward_below;高于 → forward_above。value = 差值(百分点)。"""
    try:
        f = _ratio(forward_cagr_value, "forward_cagr_value", MAX_ABS_CAGR)
        t = _ratio(ttm_yoy_value, "ttm_yoy_value", MAX_ABS_YOY)
        tol = _num(tolerance_pp, "tolerance_pp")
    except CalcInputError as ex:
        return _err(str(ex))
    if tol < 0:
        return _err("tolerance_pp 必须 ≥ 0", tolerance_pp=tol)
    diff_pp = (f - t) * 100.0
    cat = "approx" if abs(diff_pp) <= tol else ("forward_below" if diff_pp < 0 else "forward_above")
    label = {"approx": "前瞻 ≈ TTM:增长已兑现,可信度高", "forward_below": "前瞻远低于 TTM:隐含大幅减速,需说明依据",
             "forward_above": "前瞻远高于 TTM:预期偏高风险,需在手订单/产能/业绩预告等额外证据"}[cat]
    return _res("ok", diff_pp, "百分点", category=cat, label=label, forward_cagr=f, ttm_yoy=t, tolerance_pp=tol)
