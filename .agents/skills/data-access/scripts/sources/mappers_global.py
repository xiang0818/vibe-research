"""映射层(第三文件):美股 / 港股 / 海外官方源(腾讯 / 新浪 / 东财全球 / Yahoo / SEC / CBOE / FINRA / 财政部 / CFTC / Nasdaq)+ 技术指标。约定同 mappers.py。
币种:US → 美元 / HK → 港元(单位字符串本身带币种,ev 自动填 currency);东财三表按行内 CURRENCY 字段。"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import to_float, today_str  # noqa: E402
from sources.mappers import dict_fields, empty, ev, out, rows_fields, series_summary, text_items  # noqa: E402

_MONEY = {"US": "美元", "HK": "港元", "CN": "元", "SH": "元", "SZ": "元", "BJ": "元"}
_CCY_OF_UNIT = {"美元": "USD", "港元": "HKD", "人民币": "CNY", "元": "CNY"}


def _mu(ctx: dict) -> str:
    return _MONEY.get(ctx["market"], "元")


def _num(v) -> Optional[float]:
    if isinstance(v, str):
        v = v.replace(",", "").replace("--", "").strip()
    return to_float(v)


# ---------- 行情 / K 线 / 指标 ----------
def quote_map(result: dict, ctx: dict) -> dict:
    """腾讯 / 新浪 / 东财 美股港股快照统一映射;市值单位由注册表 cap_unit 指定(腾讯为亿美元 / 亿港元)。"""
    if not result or not (result.get("price") or result.get("name")):
        return empty("行情为空(代码无效 / 该源不收录 / 非交易时段不返回)")
    mu, day = _mu(ctx), today_str()
    cap_unit = ctx["ep"].get("cap_unit") or mu
    specs = [("price", "price", mu), ("prev_close", "last_close", mu), ("open", "open", mu), ("high", "high", mu), ("low", "low", mu), ("high_52w", "high_52w", mu), ("low_52w", "low_52w", mu),
             ("change_pct", "change_pct", "%"), ("turnover_rate", "turnover_rate", "%"), ("volume", "volume", "股"), ("amount", "turnover_amount", mu), ("pe", "pe", "倍"), ("pb", "pb", "倍"),
             ("eps", "eps", f"{mu}/股"), ("market_cap", "market_cap", cap_unit), ("float_market_cap", "float_market_cap", cap_unit)]
    note = f"{result.get('name', '')} {result.get('name_en', '') or ''} {result.get('secid', '') or ''} ts={result.get('timestamp', '')}".strip()
    evs, _ = dict_fields(ctx, result, specs, day, note=note)
    evs = [e for e in evs if not (e["field"] in ("pe", "pb", "eps", "market_cap", "float_market_cap", "high_52w", "low_52w") and e["value"] == 0)]  # 源用 0 表示缺失
    if result.get("name"):
        evs.append(ev(ctx, "security_name", str(result["name"]), "text", day, currency="n/a", note=note))
    return out(evs, extra={"currency_field": result.get("currency"), "secid": result.get("secid")})


def kline_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("K 线为空")
    mu = _mu(ctx)
    rows = sorted([r for r in result if r.get("close")], key=lambda r: str(r["date"]))
    if not rows:
        return empty("K 线无有效收盘价")
    evs = series_summary(ctx, rows, field_prefix="kline_close", value_key="close", unit=mu, date_key="date")
    per = f"{str(rows[0]['date'])[:10]}..{str(rows[-1]['date'])[:10]}"
    gaps = []
    for key, fn in (("high", max), ("low", min)):
        values = [_num(r.get(key)) for r in rows]
        # 缺任一条不能把不完整窗口称为全窗口极值。
        if any(v is None for v in values):
            gaps.append(key)
        else:
            evs.append(ev(ctx, f"kline_window_{key}", fn(values), mu, per))
    if rows[-1].get("volume") is not None:
        evs.append(ev(ctx, "kline_volume_latest", rows[-1]["volume"], "股", str(rows[-1]["date"])[:10], currency="n/a"))
    return out(evs, extra={"last5": rows[-5:], "interval": ctx["args"].get("interval", "1d")},
               status="partial" if gaps else None, degraded="窗口最高/最低价缺失，未计算极值" if gaps else None)


def indicators_map(result: dict, ctx: dict) -> dict:
    snap = (result or {}).get("snapshot") or {}
    if not snap:
        return empty("指标快照为空")
    mu = _mu(ctx)
    day = snap["date"]
    note = f"{result.get('klines_source')};窗口 {snap['points']} 根 {snap['window'][0]}..{snap['window'][1]};纯计算"
    evs = [ev(ctx, "ind_close", snap["close"], mu, day, as_of=day, note=note)]
    for k, v in (snap.get("ma") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_{k}", v, mu, day, as_of=day, note=note))
    for k, v in (snap.get("macd") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_macd_{k}" if k != "macd_hist" else "ind_macd_hist", v, mu, day, as_of=day, note=note + ";MACD(12,26,9)"))
    for k, v in (snap.get("rsi") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_{k}", v, "点", day, currency="n/a", as_of=day, note=note))
    for k, v in (snap.get("kdj") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_kdj_{k}", v, "点", day, currency="n/a", as_of=day, note=note + ";KDJ(9,3,3)"))
    for k, v in (snap.get("boll") or {}).items():
        if v is not None:
            evs.append(ev(ctx, f"ind_boll_{k}", v, "%" if k == "bandwidth" else mu, day, currency="n/a" if k == "bandwidth" else None, as_of=day, note=note + ";BOLL(20,2)"))
    return out(evs, extra={"tail": result.get("tail"), "klines_source": result.get("klines_source"),
                           "computation": {"kind": "computed_endpoint", "library": "sources.indicators", "version": result.get("algo_version"), "inputs_raw_ref": ctx.get("raw_ref"),
                                           "params": {"ma": [5, 10, 20, 60], "ema": [12, 26], "macd": [12, 26, 9], "rsi": [6, 12, 24], "kdj": [9, 3, 3], "boll": [20, 2.0], "window": snap.get("window")},
                                           "note": "取数层确定性计算(非 calc DAG);可用同一库 + 同一 raw K 线复算"}})


# ---------- Yahoo ----------
def yahoo_key_statistics_map(result: dict, ctx: dict) -> dict:
    if not result or all(result.get(k) is None for k in ("current_price", "trailing_pe", "market_cap")):
        return empty("Yahoo quoteSummary 为空(标的不存在或模块下线)")
    mu, day = _mu(ctx), today_str()
    fc = result.get("financial_currency") or ""
    note = f"Yahoo quoteSummary {result.get('symbol')};financialCurrency={fc}"
    specs = [("current_price", "price", mu), ("target_high", "analyst_target_high", mu), ("target_low", "analyst_target_low", mu), ("target_mean", "analyst_target_mean", mu), ("num_analyst_opinions", "analyst_count", "人"),
             ("trailing_pe", "pe_ttm", "倍"), ("forward_pe", "pe_forward", "倍"), ("peg_ratio", "peg", "倍"), ("price_to_book", "pb", "倍"), ("enterprise_value", "enterprise_value", mu), ("ev_to_ebitda", "ev_ebitda", "倍"),
             ("ev_to_revenue", "ev_revenue", "倍"), ("profit_margin", "net_margin", "小数"), ("operating_margin", "operating_margin", "小数"), ("gross_margin", "gross_margin", "小数"), ("return_on_equity", "roe", "小数"),
             ("return_on_assets", "roa", "小数"), ("earnings_growth", "earnings_growth", "小数"), ("revenue_growth", "revenue_growth", "小数"), ("beta", "beta", "小数"), ("short_ratio", "short_ratio", "天"),
             ("dividend_yield", "dividend_yield", "小数"), ("payout_ratio", "payout_ratio", "小数"), ("market_cap", "market_cap", mu), ("total_revenue", "revenue_ttm", mu), ("total_cash", "total_cash", mu), ("total_debt", "total_debt", mu)]
    evs, missing = dict_fields(ctx, result, specs, day, note=note)
    fin_unit, fin_ccy = _fin_unit(result, ctx)
    for e in evs:  # financialData 的营收 / 现金 / 负债按 financialCurrency 计价;价格 / 市值 / EV 按上市地币种
        if e["field"] in ("revenue_ttm", "total_cash", "total_debt") and fin_ccy:
            e["unit"], e["currency"] = fin_unit, fin_ccy
    if result.get("recommendation"):
        evs.append(ev(ctx, "analyst_recommendation_key", str(result["recommendation"]), "text", day, currency="n/a", note=note))
    return out(evs, missing=[m for m in missing if m["field"] in ("price", "pe_ttm", "market_cap")])


def yahoo_analyst_map(result: dict, ctx: dict) -> dict:
    mu, day = _mu(ctx), today_str()
    evs = []
    for t in (result or {}).get("eps_trend") or []:
        rk = str(t.get("period"))
        note = f"期间 {t.get('period')} 截止 {t.get('end_date')}"
        e, _ = dict_fields(ctx, t, [("eps_estimate", "eps_estimate_avg", f"{mu}/股"), ("eps_high", "eps_estimate_high", f"{mu}/股"), ("eps_low", "eps_estimate_low", f"{mu}/股"), ("revenue_estimate", "revenue_estimate_avg", mu),
                                    ("num_analysts", "analyst_count", "人"), ("growth", "eps_growth_estimate", "小数")], str(t.get("end_date") or day), record_key=rk, note=note)
        evs += e
    for r in (result or {}).get("rating_trend") or []:
        rk = str(r.get("period"))
        e, _ = dict_fields(ctx, r, [("strong_buy", "rating_strong_buy", "人"), ("buy", "rating_buy", "人"), ("hold", "rating_hold", "人"), ("sell", "rating_sell", "人"), ("strong_sell", "rating_strong_sell", "人")], day, record_key=rk, note=f"评级分布 {r.get('period')}")
        evs += e
    for i, u in enumerate((result or {}).get("upgrade_downgrade") or []):
        if u.get("firm"):
            evs.append(ev(ctx, "analyst_rating_change", f"{u['firm']}: {u.get('from_grade') or '-'} → {u.get('to_grade') or '-'} ({u.get('action')})", "text", u.get("date") or day, currency="n/a", as_of=u.get("date") or day, record_key=f"{u.get('date')}|{u['firm']}|{i}"))
    for h in (result or {}).get("earnings_history") or []:
        if h.get("quarter"):
            e, _ = dict_fields(ctx, h, [("eps_actual", "eps_actual", f"{mu}/股"), ("eps_estimate", "eps_estimate_at_report", f"{mu}/股"), ("surprise_pct", "eps_surprise_pct", "小数")], h["quarter"], record_key=h["quarter"], note="财报季度实际 vs 预期")
            evs += e
    if not evs:
        return empty("Yahoo 分析师模块为空")
    return out(evs)


def yahoo_holders_map(result: dict, ctx: dict) -> dict:
    mu, day = _mu(ctx), today_str()
    ov = (result or {}).get("overview") or {}
    evs, _ = dict_fields(ctx, ov, [("insiders_pct", "insiders_pct_held", "小数"), ("institutions_pct", "institutions_pct_held", "小数"), ("institutions_float_pct", "institutions_float_pct_held", "小数"), ("institutions_count", "institutions_count", "家")], day)
    for h in (result or {}).get("top_holders") or []:
        if not h.get("name"):
            continue
        e, _ = dict_fields(ctx, h, [("shares", "holder_shares", "股"), ("value", "holder_value", mu), ("pct_held", "holder_pct_held", "小数")], h.get("report_date") or day, record_key=str(h["name"])[:60], note=f"机构={h['name']};报告日={h.get('report_date')}")
        evs += e
    if not evs:
        return empty("Yahoo 机构持仓为空")
    return out(evs)


_YF_KEYS = {"income": [("totalRevenue", "revenue"), ("grossProfit", "gross_profit"), ("operatingIncome", "operating_profit"), ("netIncome", "net_profit"), ("ebit", "ebit")],
            "balance": [("totalAssets", "total_assets"), ("totalLiab", "total_liabilities"), ("totalStockholderEquity", "total_equity"), ("cash", "cash"), ("longTermDebt", "long_term_debt")],
            "cashflow": [("totalCashFromOperatingActivities", "cfo"), ("capitalExpenditures", "capex"), ("totalCashflowsFromInvestingActivities", "cfi"), ("totalCashFromFinancingActivities", "cff"), ("changeInCash", "net_cash_change")]}


_CCY_UNIT = {"USD": "美元", "HKD": "港元", "CNY": "人民币", "EUR": "欧元", "JPY": "日元", "GBP": "英镑", "TWD": "新台币", "KRW": "韩元", "SGD": "新加坡元", "CAD": "加元", "AUD": "澳元", "CHF": "瑞士法郎", "INR": "卢比"}

def _report_currency(value: Any) -> tuple[Optional[str], Optional[str]]:
    raw = str(value or "").strip()
    code = _CCY_OF_UNIT.get(raw) or {v: k for k, v in _CCY_UNIT.items()}.get(raw) or raw.upper()
    return (_CCY_UNIT[code], code) if code in _CCY_UNIT else (None, None)


def _fin_unit(result: dict, ctx: dict) -> tuple:
    """Yahoo 财务类金额按 financialCurrency 计价(港股公司常以人民币 / 美元列报),不按上市地币种。返回 (unit, currency_code)。"""
    code = str((result or {}).get("financial_currency") or "").upper()
    if code:
        return _CCY_UNIT.get(code, code), code
    return _mu(ctx), None


def yahoo_financials_map(result: dict, ctx: dict) -> dict:
    mu, ccy = _fin_unit(result, ctx)
    evs = []
    from datetime import datetime, timezone
    for st, rows in ((result or {}).items()):
        if st not in _YF_KEYS:
            continue
        for row in rows or []:
            end = row.get("endDate")
            period = datetime.fromtimestamp(end, timezone.utc).strftime("%Y-%m-%d") if isinstance(end, (int, float)) else str(end or "")[:10]
            if not period:
                continue
            for k, f in _YF_KEYS[st]:
                v = _num(row.get(k))
                if v is not None and v != 0:  # Yahoo 用 0 表示缺失
                    evs.append(ev(ctx, f, v, mu, period, currency=ccy, as_of=period, note=f"Yahoo {st}{'(季度)' if result.get('quarterly') else '(年度)'};币种=financialCurrency {ccy or '未提供,按上市地'}"))
    if not evs:
        return empty("Yahoo 财报模块为空(2024 起多数标的的 quoteSummary 财报模块已下线,改用 em_global_* / sec_xbrl_facts)")
    return out(evs)


def yahoo_options_map(result: dict, ctx: dict) -> dict:
    calls, puts = (result or {}).get("calls") or [], (result or {}).get("puts") or []
    if not calls and not puts:
        return empty("Yahoo 期权链为空(港股不覆盖 / 标的无期权)")
    mu, day = _mu(ctx), today_str()
    exp = (calls or puts)[0].get("expiration") or ""
    evs = [ev(ctx, "option_expiration_count", len(result.get("expiration_dates") or []), "个", day, currency="n/a"), ev(ctx, "option_calls_count", len(calls), "张", day, currency="n/a", note=f"到期 {exp}"),
           ev(ctx, "option_puts_count", len(puts), "张", day, currency="n/a", note=f"到期 {exp}")]
    if result.get("underlying_price"):
        evs.append(ev(ctx, "option_underlying_price", result["underlying_price"], mu, day))
    for side, lst in (("call", calls), ("put", puts)):  # 合计不在取数层算;只按成交量排序取前 10 张合约的源事实
        for o in sorted(lst, key=lambda x: -(_num(x.get("volume")) or 0))[:10]:
            rk = str(o.get("contract_symbol"))
            e, _ = dict_fields(ctx, o, [("strike", "option_strike", mu), ("last_price", "option_last", mu), ("volume", "option_volume", "张"), ("open_interest", "option_open_interest", "张"), ("implied_volatility", "option_iv", "小数")], day, record_key=rk, note=f"{side} 到期 {o.get('expiration')}")
            evs += e
    return out(evs, extra={"expiration_dates": result.get("expiration_dates")})


def yahoo_news_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("Yahoo 新闻为空")
    evs = text_items(ctx, result, field="news_title", title_key="title", date_key="publish_time", key_of=lambda r: str(r.get("link"))[-60:], limit=int(ctx["args"].get("limit", 20)), extra_keys=("publisher", "link"))
    return out(evs)


# ---------- 东财全球 ----------
_EM_EXACT = {"营业收入": "revenue", "营业总收入": "revenue_total", "总收入": "revenue_total", "毛利": "gross_profit", "毛利润": "gross_profit", "营业利润": "operating_profit", "经营溢利": "operating_profit", "净利润": "net_profit",
             "归属于母公司股东的净利润": "net_profit_parent", "股东应占溢利": "net_profit_parent", "基本每股收益": "eps_basic", "稀释每股收益": "eps_diluted", "资产总计": "total_assets", "总资产": "total_assets", "负债合计": "total_liabilities",
             "总负债": "total_liabilities", "股东权益合计": "total_equity", "经营活动产生的现金流量净额": "cfo", "投资活动产生的现金流量净额": "cfi", "筹资活动产生的现金流量净额": "cff", "融资活动产生的现金流量净额": "cff"}
_EM_SUBSTR = {"income": ("收入", "毛利", "利润", "溢利", "每股收益", "研发", "成本", "EBITDA"), "balance": ("资产总计", "总资产", "负债合计", "总负债", "股东权益", "权益总计", "现金及", "存货", "应收", "流动资产", "流动负债", "借款", "长期债务"),
              "cashflow": ("经营活动", "投资活动", "筹资活动", "融资活动", "资本支出", "购建", "现金及现金等价物净增加", "自由现金流", "折旧")}


def em_financials_global_map(result: list, ctx: dict) -> dict:
    st = ctx["args"].get("statement", "income")
    if not result:
        return empty(f"东财全球三表 {st} 为空(标的未收录或 secucode 解析失败)")
    evs = []
    unknown_currency = False
    for r in result:
        name = str(r.get("ITEM_NAME") or "")
        if not name or not any(s in name for s in _EM_SUBSTR.get(st, ())):
            continue
        v = _num(r.get("AMOUNT"))
        if v is None:
            continue
        unit, ccy = _report_currency(r.get("CURRENCY"))
        if unit is None:
            unknown_currency = True
            continue
        period = str(r.get("REPORT_DATE") or "")[:10]
        field = _EM_EXACT.get(name, "fs_item")
        if field == "fs_item" and "摊薄每股收益" in name:
            field = "eps_diluted"
        elif field == "fs_item" and "基本每股收益" in name:
            field = "eps_basic"
        if field in ("eps_basic", "eps_diluted") or "每股" in name:
            unit = f"{unit}/股"
        rep = str(r.get("REPORT") or r.get("REPORT_TYPE") or "")
        note = f"{rep} {r.get('ACCOUNT_STANDARD') or ''} 科目「{name}」".strip()
        # 同一 REPORT_DATE 可同时有单季(2026/Q3)与累计(2026/Q9)两种口径 → record_key 必须带 REPORT,否则同 id 不同值
        rk = f"{rep}|{name}"
        evs.append(ev(ctx, field, v, unit, period, currency=ccy, as_of=period, record_key=rk, note=note))
        y = _num(r.get("YOY_RATIO"))
        if y is not None and field != "fs_item":
            evs.append(ev(ctx, f"{field}_yoy", y, "%", period, currency="n/a", as_of=period, record_key=rk, note=f"「{name}」同比(东财 YOY_RATIO;{rep})"))
        if len(evs) >= 160:
            break
    if not evs:
        return empty(f"东财三表 {st} 列报币种缺失或未识别" if unknown_currency else f"东财三表 {st} 无匹配科目")
    return out(evs, extra={"rows": len(result), "periods": sorted({str(r.get('REPORT_DATE'))[:10] for r in result}, reverse=True)[:8]},
               status="partial" if unknown_currency else None, degraded="部分科目币种未识别，已跳过金额" if unknown_currency else None)


_EM_IND = [("OPERATE_INCOME", "revenue", "money"), ("GROSS_PROFIT", "gross_profit", "money"), ("GROSS_PROFIT_RATIO", "gross_margin", "%"), ("PARENT_HOLDER_NETPROFIT", "net_profit_parent", "money"), ("HOLDER_PROFIT", "net_profit_parent", "money"),
           ("NET_PROFIT_RATIO", "net_margin", "%"), ("BASIC_EPS", "eps_basic", "money/股"), ("DILUTED_EPS", "eps_diluted", "money/股"), ("ROE_AVG", "roe", "%"), ("ROA", "roa", "%"), ("ROIC", "roic", "%"), ("CURRENT_RATIO", "current_ratio", "倍"),
           ("DEBT_ASSET_RATIO", "debt_asset_ratio", "%"), ("OPERATE_INCOME_YOY", "revenue_yoy", "%"), ("BASIC_EPS_YOY", "eps_basic_yoy", "%"), ("BPS", "bvps", "money/股"), ("DPS_HKD", "dps", "港元/股"), ("DIVI_RATIO", "dividend_yield", "%"),
           ("OCF_SALES", "ocf_to_sales", "%"), ("PER_NETCASH_OPERATE", "ocf_per_share", "money/股")]


def em_key_indicators_global_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财 GMAININDICATOR 为空")
    evs = []
    unknown_currency = False
    for r in result:
        period = str(r.get("REPORT_DATE") or "")[:10]
        mu, ccy = _report_currency(r.get("CURRENCY"))
        rep = f"{r.get('REPORT') or ''}|{r.get('REPORT_TYPE') or ''}"
        note = f"{rep.replace('|', ' ')} 东财关键指标".strip()
        for k, f, u in _EM_IND:
            v = _num(r.get(k))
            if v is None:
                continue
            if "money" in u and mu is None:
                unknown_currency = True
                continue
            unit = u.replace("money", mu or "")
            evs.append(ev(ctx, f, v, unit, period, currency="n/a" if unit in ("%", "倍") else ("HKD" if u == "港元/股" else ccy), as_of=period, record_key=rep, note=note))
    return out(evs, status="partial" if unknown_currency else None, degraded="列报币种未识别，已跳过金额，保留比率" if unknown_currency else None) if evs else empty("东财关键指标无可用字段或列报币种未知")


def em_fund_flow_global_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财全球资金流为空")
    mu = _mu(ctx)
    rows = sorted(result, key=lambda r: r["date"])
    evs = series_summary(ctx, rows, field_prefix="main_net_inflow_daily", value_key="main_net", unit=mu, date_key="date")
    pct = _num(rows[-1].get("main_pct"))
    if pct is not None:
        evs.append(ev(ctx, "main_net_inflow_pct_latest", pct, "%", rows[-1]["date"], currency="n/a"))
    return out(evs, status="partial" if len(rows) < 5 else None, degraded=None if len(rows) >= 5 else f"仅 {len(rows)} 条(push2his 不通时回落 push2delay)")


def em_stock_search_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("东财搜索无结果")
    day = today_str()
    evs = [ev(ctx, "search_hit", f"{r.get('code')} {r.get('name')}", "text", day, currency="n/a", record_key=f"{r.get('mkt_num')}.{r.get('code')}", note=f"{r.get('market_name')} {r.get('security_type')} mkt_num={r.get('mkt_num')}") for r in result]
    return out(evs, extra={"count": len(result)})


def em_market_list_map(result: dict, ctx: dict) -> dict:
    stocks = (result or {}).get("stocks") or []
    if not stocks:
        return empty("全市场列表为空")
    day = today_str()
    evs = [ev(ctx, "market_list_total", result.get("total", 0), "只", day, currency="n/a", note=f"market={result.get('market')} 排序 {ctx['args'].get('sort_field', 'f3')}")]
    evs += rows_fields(ctx, stocks, [("change_pct", "list_change_pct", "%"), ("volume", "list_volume", "股"), ("amplitude", "list_amplitude", "%")], period_of=lambda r: day, key_of=lambda r: str(r.get("code")), note_of=lambda r: f"{r.get('code')} {r.get('name')}", limit=100)
    return out(evs)


# ---------- SEC / FINRA / CBOE / 宏观 ----------
def sec_ticker_cik_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("无 CIK")
    day = today_str()
    return out([ev(ctx, "sec_cik", result["cik"], "text", day, currency="n/a", note=f"{result.get('company')}"), ev(ctx, "company_name", str(result.get("company")), "text", day, currency="n/a")])


def sec_filings_map(result: dict, ctx: dict) -> dict:
    fl = (result or {}).get("filings") or []
    if not fl:
        return empty("无申报记录(form_type 过滤后为空?)")
    evs = [ev(ctx, "company_name", str(result.get("company_name")), "text", today_str(), currency="n/a", note=f"CIK {result.get('cik')}")]
    for f in fl:
        evs.append(ev(ctx, "sec_filing", f"{f['form']} {f.get('description') or ''}".strip(), "text", f["date"], currency="n/a", as_of=f["date"], record_key=f["accession_number"], note=f"url={f.get('url')}"))
    return out(evs, extra={"count": len(fl), "cik": result.get("cik")})


_XBRL_UNIT = {"USD": "美元", "USD/shares": "美元/股", "shares": "股", "pure": "小数"}


def sec_xbrl_map(result: dict, ctx: dict) -> dict:
    ms = (result or {}).get("metrics") or {}
    if not ms:
        return empty("companyfacts 无匹配指标")
    evs = []
    for name, m in ms.items():
        unit = _XBRL_UNIT.get(m.get("unit"), m.get("unit") or "n/a")
        for e in m.get("entries") or []:
            if e.get("val") is None or not e.get("end"):
                continue
            per = f"{e['start']}..{e['end']}" if e.get("start") else e["end"]
            evs.append(ev(ctx, f"xbrl_{name}", e["val"], unit, per, currency="USD" if m.get("unit", "").startswith("USD") else "n/a", as_of=e.get("filed") or e["end"], record_key=f"{e.get('form')}|{e.get('fy')}{e.get('fp')}|{e['end']}|{e.get('filed')}",
                          note=f"{m.get('label') or name};{e.get('form')} FY{e.get('fy')} {e.get('fp')} filed {e.get('filed')}"))
    return out(evs, extra={"company": result.get("company"), "cik": result.get("cik"), "available_count": result.get("available_count"), "metrics": list(ms)})


def sec_daily_filings_map(result: dict, ctx: dict) -> dict:
    d = (result or {}).get("date") or ""
    day = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else today_str()
    evs = [ev(ctx, "sec_daily_total", result.get("total", 0), "份", day, currency="n/a")]
    for form, n in list((result.get("by_form") or {}).items())[:30]:
        evs.append(ev(ctx, "sec_daily_by_form", n, "份", day, currency="n/a", record_key=form, note=f"表单 {form}"))
    for i, f in enumerate((result.get("filings") or [])[:int(ctx["args"].get("limit", 150))]):
        evs.append(ev(ctx, "sec_daily_filing", f"{f['form']} {f['company']}", "text", day, currency="n/a", record_key=f"{f.get('cik')}|{f['form']}|{i}", note=f"{f.get('form_label')} url={f.get('url')}"))
    return out(evs, extra={"filtered": len(result.get("filings") or [])})


def sec_fulltext_map(result: dict, ctx: dict) -> dict:
    day = today_str()
    evs = [ev(ctx, "sec_fulltext_total", result.get("total", 0), "份", day, currency="n/a", note=f"query={result.get('query')}")]
    for r in result.get("results") or []:
        evs.append(ev(ctx, "sec_fulltext_hit", f"{r.get('form')} {r.get('company')}", "text", r.get("filed") or day, currency="n/a", record_key=str(r.get("id")), note=f"id={r.get('id')}"))
    return out(evs)


def sec_frame_map(result: dict, ctx: dict) -> dict:
    top = (result or {}).get("top") or []
    if not top:
        return empty("frames 无数据")
    unit = _XBRL_UNIT.get(result.get("unit"), result.get("unit"))
    per = result.get("period")
    evs = [ev(ctx, "frame_company_count", result.get("count", 0), "家", per, currency="n/a", note=f"{result.get('tag')} {per} instant={result.get('instant')}")]
    for r in top:
        if r.get("value") is not None:
            evs.append(ev(ctx, f"frame_{result.get('tag')}", r["value"], unit, per, currency="USD" if str(result.get("unit", "")).startswith("USD") else "n/a", record_key=str(r.get("cik")), note=f"{r.get('entity')} end={r.get('end')}"))
    return out(evs)


def finra_short_map(result: list, ctx: dict) -> dict:
    if not result:
        return out([ev(ctx, "short_volume_points", 0, "天", today_str(), currency="n/a")], status="partial", degraded="FINRA 已取得的日文件内未检出该标的记录，原因未核实；未取得的日期不代表无成交，也不能推断市场覆盖范围")
    rows = sorted(result, key=lambda r: r["date"])
    evs = rows_fields(ctx, rows, [("ratio", "short_volume_ratio", "小数"), ("short", "short_volume", "股"), ("total", "total_volume_finra", "股")], period_of=lambda r: f"{r['date'][:4]}-{r['date'][4:6]}-{r['date'][6:8]}",
                      key_of=lambda r: r["date"], note_of=lambda r: "FINRA Reg SHO 日度空头成交(CNMS)")
    return out(evs)


def finra_ranking_map(result: dict, ctx: dict) -> dict:
    rk = (result or {}).get("ranking") or []
    d = result.get("date") or ""
    day = f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else today_str()
    evs = [ev(ctx, "short_volume_universe", result.get("count", 0), "只", day, currency="n/a", note=f"market={result.get('market')}")]
    evs += rows_fields(ctx, rk, [("ratio", "short_volume_ratio", "小数"), ("total", "total_volume_finra", "股")], period_of=lambda r: day, key_of=lambda r: str(r.get("symbol")), note_of=lambda r: f"{r.get('symbol')} 空头占比排行")
    return out(evs)


def cboe_options_map(result: dict, ctx: dict) -> dict:
    sm = (result or {}).get("selected")  # 筛选后合约数(0 → partial)
    mu, day = _mu(ctx), today_str()
    note = f"CBOE 延时链 {result.get('timestamp')};筛选 {result.get('filter')};{result.get('selected')}/{result.get('all_contracts')} 张"
    evs = [ev(ctx, "option_contracts_total", result.get("all_contracts", 0), "张", day, currency="n/a", note=note), ev(ctx, "option_expiry_count", len(result.get("expiries") or []), "个", day, currency="n/a", note=note)]
    if result.get("spot") is not None:
        evs.append(ev(ctx, "option_underlying_price", result["spot"], mu, day, note=note))
    # 链级聚合 / vol-OI 比等派生量不在取数层计算;证据只留按成交量排序的前 N 张合约的源事实(全链在 raw)
    for c in (result.get("top_by_volume") or [])[:20]:
        e, _ = dict_fields(ctx, c, [("volume", "option_volume", "张"), ("open_interest", "option_open_interest", "张"), ("iv", "option_iv", "小数"), ("delta", "option_delta", "小数"), ("strike", "option_strike", mu), ("last_trade_price", "option_last", mu)],
                           day, record_key=c["symbol"], note=f"{c['type']} 到期 {c['expiry']}(按成交量排序前 20)")
        evs += e
    return out(evs, extra={"expiries": result.get("expiries"), "selected": result.get("selected")}, status=None if sm else "partial", degraded=None if sm else "筛选后无合约")


def cboe_quote_map(result: dict, ctx: dict) -> dict:
    if not result:
        return empty("CBOE 快照为空")
    mu, day = _mu(ctx), today_str()
    evs, _ = dict_fields(ctx, result, [("current_price", "price", mu), ("prev_day_close", "last_close", mu), ("open", "open", mu), ("high", "high", mu), ("low", "low", mu), ("volume", "volume", "股"), ("iv30", "iv30", "小数"), ("iv30_change", "iv30_change", "小数"),
                                       ("iv30_change_percent", "iv30_change_pct", "%"), ("hv30", "hv30", "小数")], day, note="CBOE delayed_quotes")
    return out(evs, extra={"keys": list(result)[:40]}) if evs else empty("CBOE 快照无可用字段")


def treasury_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("美债收益率 CSV 为空")
    rows = sorted(result, key=lambda r: _dt(r.get("Date")))
    last = rows[-1]
    day = _dt(last.get("Date"))
    evs = []
    for k, v in last.items():
        if k == "Date":
            continue
        x = _num(v)
        if x is not None:
            evs.append(ev(ctx, "treasury_yield", x, "%", day, currency="n/a", as_of=day, record_key=k.replace(" ", ""), note=f"期限 {k}(财政部每日收益率曲线)"))
    evs.append(ev(ctx, "treasury_points", len(rows), "天", f"{_dt(rows[0].get('Date'))}..{day}", currency="n/a"))
    return out(evs, extra={"latest": last})  # 利差等派生量由 calc 计算


def _dt(s) -> str:
    """MM/DD/YYYY → YYYY-MM-DD(财政部 CSV 日期)。"""
    s = str(s or "")
    if "/" in s:
        m, d, y = s.split("/")[:3]
        return f"{y}-{int(m):02d}-{int(d):02d}"
    return s[:10]


def cftc_map(result: list, ctx: dict) -> dict:
    if not result:
        return empty("CFTC COT 为空")
    evs = []
    for r in result[:int(ctx["args"].get("limit", 20))]:
        name = str(r.get("contract_market_name") or r.get("market_and_exchange_names") or "")
        day = str(r.get("report_date_as_yyyy_mm_dd") or "")[:10]
        rk = f"{name[:40]}|{day}"
        oi, nl, ns = _num(r.get("open_interest_all")), _num(r.get("noncomm_positions_long_all")), _num(r.get("noncomm_positions_short_all"))
        if oi is not None:
            evs.append(ev(ctx, "cot_open_interest", oi, "张", day, currency="n/a", as_of=day, record_key=rk, note=name))
        if nl is not None:
            evs.append(ev(ctx, "cot_noncomm_long", nl, "张", day, currency="n/a", as_of=day, record_key=rk, note=f"{name} 非商业多头"))
        if ns is not None:
            evs.append(ev(ctx, "cot_noncomm_short", ns, "张", day, currency="n/a", as_of=day, record_key=rk, note=f"{name} 非商业空头(净头寸请用 calc 相减)"))
    return out(evs) if evs else empty("CFTC 行无持仓字段")


def earnings_calendar_map(result: dict, ctx: dict) -> dict:
    rows = (result or {}).get("rows") or []
    day = result.get("date") or today_str()
    evs = [ev(ctx, "earnings_calendar_count", len(rows), "家", day, currency="n/a")]
    for r in rows[:int(ctx["args"].get("limit", 100))]:
        evs.append(ev(ctx, "earnings_calendar_entry", f"{r.get('symbol')} {r.get('name')}", "text", day, currency="n/a", record_key=str(r.get("symbol")), note=f"time={r.get('time')} EPS 预期={r.get('eps_forecast')} 市值={r.get('market_cap')}"))
    return out(evs, status="ok" if rows else "partial", degraded=None if rows else "该日无财报日程")
