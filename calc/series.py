"""报告期序列处理(纯函数):累计值 → 单季、最新单季、TTM 求和、TTM 同比、环比。

输入统一为 [{"period": "YYYY-MM-DD", "value": 数值或 null}] 列表(同一字段、同一单位,顺序任意):
- period 必须严格匹配 YYYY-MM-DD 且为季末日(03-31 / 06-30 / 09-30 / 12-31),否则 error;重复 period → error(不静默取舍)。
- value 为 null 表示该期缺失;非数 / 布尔 / 非有限 → error。
- unit 必须非空并原样随结果传递;money=True 时(财务金额序列,SOP 默认)unit 必须是 元 / 万元 / 亿元,非金额序列(如 EPS 元/股)用 money=False;下游金额运算由 formulas 按 unit 归一。
所有函数返回 dict{status, value, unit, reason, details};序列类结果放 details.series。
"""
from __future__ import annotations

import re
from datetime import date
from typing import Optional

from .formulas import UNIT_TO_YUAN, CalcInputError, _err, _num, _res

QUARTER_END = {(3, 31): 1, (6, 30): 2, (9, 30): 3, (12, 31): 4}
_PERIOD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_period(p) -> tuple[date, int]:
    if not isinstance(p, str) or not _PERIOD_RE.match(p):
        raise CalcInputError(f"period {p!r} 不是严格的 YYYY-MM-DD")
    try:
        d = date.fromisoformat(p)
    except ValueError as e:
        raise CalcInputError(f"period {p!r} 不是合法日期") from e
    q = QUARTER_END.get((d.month, d.day))
    if q is None:
        raise CalcInputError(f"period {p!r} 不是季末日(03-31/06-30/09-30/12-31)")
    return d, q


def _prev_quarter_end(d: date) -> date:
    if d.month == 3:
        return date(d.year - 1, 12, 31)
    if d.month == 6:
        return date(d.year, 3, 31)
    if d.month == 9:
        return date(d.year, 6, 30)
    return date(d.year, 9, 30)


def _quarter_ends_back(d: date, n: int) -> list[date]:
    out, cur = [], d
    for _ in range(n):
        out.append(cur)
        cur = _prev_quarter_end(cur)
    return out


def _check_unit(unit, money: bool = False) -> str:
    """unit 必须非空;money=True 时必须是金额单位(元 / 万元 / 亿元),供财务金额序列在进入 PE 之前就被拦截。"""
    if not isinstance(unit, str) or not unit.strip():
        raise CalcInputError("unit 必须是非空字符串")
    if money and unit not in UNIT_TO_YUAN:
        raise CalcInputError(f"金额序列 unit {unit!r} 不支持;只认 元 / 万元 / 亿元")
    return unit


def _series_map(items, name: str) -> dict:
    """[{period, value}] → {date: value|None};校验格式、重复、有限性。"""
    if not isinstance(items, (list, tuple)):
        raise CalcInputError(f"{name} 必须是列表")
    m: dict = {}
    for item in items:
        if not isinstance(item, dict) or "period" not in item:
            raise CalcInputError(f"{name} 元素必须是含 period 的对象:{item!r}")
        d, _ = _parse_period(item["period"])
        if d in m:
            raise CalcInputError(f"{name} 报告期重复:{item['period']}")
        m[d] = _num(item.get("value"), f"{name}[{item['period']}].value", required=False)
    return m


def quarterize(cumulative: list, unit: str = "元", money: bool = False) -> dict:
    """报告期累计值(YTD)→ 单季值。Q1 = YTD;Qn = YTD(n) − YTD(n−1)。
    上一报告期缺失 → 该季 value=null 并记 reason(不猜);输出按 period 升序;value = 可拆出的单季数。"""
    try:
        u = _check_unit(unit, money)
        parsed = _series_map(cumulative, "cumulative")
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    if not parsed:
        return _err("空序列")
    series = []
    for d in sorted(parsed):
        ytd = parsed[d]
        q = QUARTER_END[(d.month, d.day)]
        if ytd is None:
            series.append({"period": d.isoformat(), "quarter": q, "value": None, "reason": "累计值缺失"})
            continue
        if q == 1:
            series.append({"period": d.isoformat(), "quarter": 1, "value": ytd})
            continue
        prev = _prev_quarter_end(d)
        pv = parsed.get(prev)
        if pv is None:
            series.append({"period": d.isoformat(), "quarter": q, "value": None,
                           "reason": f"上一报告期 {prev.isoformat()} 累计值缺失,无法拆单季"})
        else:
            series.append({"period": d.isoformat(), "quarter": q, "value": ytd - pv})
    n_ok = sum(1 for s in series if s["value"] is not None)
    return _res("ok" if n_ok else "not_meaningful", n_ok, "期", reason="" if n_ok else "无任何可拆分单季",
                series=series, value_unit=u)


def latest_quarter(single_quarters: list, unit: str = "元", money: bool = False) -> dict:
    """取最新一季单季值(value 非空者中 period 最大);unit 原样返回供下游金额运算使用。"""
    try:
        u = _check_unit(unit, money)
        m = _series_map(single_quarters, "single_quarters")
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    avail = [(d, v) for d, v in m.items() if v is not None]
    if not avail:
        return _res("not_meaningful", unit=u, reason="无可用单季值")
    d, v = max(avail)
    return _res("ok", v, u, period=d.isoformat(), quarter=QUARTER_END[(d.month, d.day)])


def ttm_sum(single_quarters: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """以 end_period 为最后一季的近 4 季单季和。4 季任一缺失 → not_meaningful(不拿 3 季冒充)。"""
    try:
        u = _check_unit(unit, money)
        m = _series_map(single_quarters, "single_quarters")
        end, _ = _parse_period(end_period)
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    periods = _quarter_ends_back(end, 4)
    vals = [m.get(p) for p in periods]
    if any(v is None for v in vals):
        missing = [p.isoformat() for p, v in zip(periods, vals) if v is None]
        return _res("not_meaningful", unit=u, reason=f"近 4 季缺失 {missing}", periods=[p.isoformat() for p in periods])
    return _res("ok", sum(vals), u, periods=[p.isoformat() for p in periods], values=vals)


def ttm_yoy(single_quarters: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """TTM 同比 = TTM(end) ÷ TTM(end − 4 季) − 1(小数)。需 8 季连续;基期 TTM ≤ 0 → not_meaningful。"""
    cur = ttm_sum(single_quarters, end_period, unit, money)
    if cur["status"] != "ok":
        return _res(cur["status"], unit="小数", reason=f"当期 TTM:{cur['reason']}", current=cur)
    end, _ = _parse_period(end_period)
    base_end = _quarter_ends_back(end, 5)[-1]
    base = ttm_sum(single_quarters, base_end.isoformat(), unit, money)
    if base["status"] != "ok":
        return _res(base["status"], unit="小数", reason=f"基期 TTM:{base['reason']}", current=cur, base=base)
    if base["value"] <= 0:
        return _res("not_meaningful", unit="小数", reason="基期 TTM ≤ 0,同比无意义", current=cur, base=base)
    return _res("ok", cur["value"] / base["value"] - 1.0, "小数", current=cur, base=base)


def qoq(single_quarters: list, end_period: str, unit: str = "元", money: bool = False) -> dict:
    """环比 = Q(end) ÷ Q(end−1) − 1(小数)。只作拐点 / 动量信号,禁止当增速分母。前一季 ≤ 0 → not_meaningful。"""
    try:
        _check_unit(unit, money)
        m = _series_map(single_quarters, "single_quarters")
        end, _ = _parse_period(end_period)
    except CalcInputError as e:
        return _err(f"输入无效:{e}")
    prev = _prev_quarter_end(end)
    c, p = m.get(end), m.get(prev)
    if c is None or p is None:
        return _res("not_meaningful", unit="小数", reason="当季或前季缺失", end=end.isoformat(), prev=prev.isoformat())
    if p <= 0:
        return _res("not_meaningful", unit="小数", reason="前季 ≤ 0,环比无意义", current=c, prev=p)
    return _res("ok", c / p - 1.0, "小数", current=c, prev=p, note="拐点/动量信号,不作增速分母")
