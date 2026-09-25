"""新浪源:复权因子 / 财报三表 / 个股资金流(备源)/ ETF 期权链(合约清单 + T 型报价 + 希腊字母)。移植自 a-stock-data SKILL.md §1.4 / §6.4 / §9.1 / 备用源。零鉴权。"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA, norm_ticker  # noqa: E402
from sources._http import DataNotAvailable, http_get, http_json  # noqa: E402

_HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}
SINA_OPT_HDR = {"Referer": "https://stock.finance.sina.com.cn/", "User-Agent": UA}


def _sina_symbol(code: str) -> str:
    digits, market = norm_ticker(code, stock_only=False)
    return f"{market.lower()}{digits}"


# ---------- 1.4 复权因子 ----------
def sina_adjust_factor(code: str, kind: str = "qfq") -> list[dict]:
    """复权因子序列(最新在前):[{date, factor}];kind=qfq 前复权(因子为除数)| hfq 后复权(乘数)。"""
    if kind not in ("qfq", "hfq"):
        raise ValueError(f"kind 只能是 'qfq' 或 'hfq',收到 {kind!r}")
    symbol = _sina_symbol(code)
    text = http_get(f"https://finance.sina.com.cn/realstock/company/{symbol}/{kind}.js", headers=_HDR, timeout=10, ext="js").text
    brace = text.find("{")
    if brace < 0:
        raise RuntimeError(f"新浪复权因子响应无 JSON({symbol}/{kind}): {text[:120]}")
    data, _ = json.JSONDecoder().raw_decode(text[brace:])
    return [{"date": it["d"], "factor": float(it["f"])} for it in data.get("data", [])]


def apply_adjust(bars: list[dict], factors: list[dict], kind: str = "qfq", price_keys=("open", "high", "low", "close")) -> list[dict]:
    """把复权因子套到不复权 K 线(list[dict],含 date)。qfq: 价 ÷ factor;hfq: 价 × factor。因子为空 / 未覆盖 → 显式失败,绝不原样放行。"""
    if kind not in ("qfq", "hfq"):
        raise ValueError(f"kind 只能是 'qfq' 或 'hfq',收到 {kind!r}")
    if not factors:
        raise ValueError("复权因子列表为空,无法复权(新浪对不支持的标的返回空 data),不要用未复权价继续计算")
    if hasattr(bars, "to_dict"):
        bars = bars.to_dict("records")
    rows = []
    for b in bars:
        r = dict(b)
        dk = "date" if "date" in r else ("datetime" if "datetime" in r else None)
        if dk is None:
            raise ValueError(f"每根 K 线需含 date/datetime 键,实际键={sorted(r)}")
        r["date"] = str(r[dk])[:10]
        rows.append(r)
    fac = sorted(factors, key=lambda x: x["date"])
    out, i, cur = [], 0, None
    for bar in sorted(rows, key=lambda b: b["date"]):
        while i < len(fac) and fac[i]["date"] <= bar["date"]:
            cur = fac[i]["factor"]
            i += 1
        if cur is None:
            raise RuntimeError(f"K 线日期 {bar['date']} 早于因子序列最早日 {fac[0]['date']},无法复权")
        if cur == 0:
            raise RuntimeError(f"复权因子为 0({bar['date']}),无法换算")
        nb = dict(bar)
        for k in price_keys:
            if k in nb and nb[k] is not None:
                nb[k] = round(float(nb[k]) / cur if kind == "qfq" else float(nb[k]) * cur, 4)
        nb["adj_factor"] = cur
        out.append(nb)
    return out


# ---------- 6.4 财报三表 ----------
def sina_financial_report(code: str, report_type: str = "lrb", num: int = 8) -> list[dict]:
    """report_type: fzb 资产负债表 / lrb 利润表 / llb 现金流量表;返回按报告期倒序 [{报告期, <科目>: 原始字符串, <科目>_同比: ...}]"""
    if report_type not in ("fzb", "lrb", "llb"):
        raise ValueError("report_type 只能是 fzb / lrb / llb")
    digits, market = norm_ticker(code, stock_only=True)
    params = {"paperCode": f"{market.lower()}{digits}", "source": report_type, "type": "0", "page": "1", "num": str(num)}
    j = http_json("https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022", params=params, headers={"User-Agent": UA}, timeout=15) or {}
    report_list = ((j.get("result") or {}).get("data") or {}).get("report_list") or {}
    rows = []
    for period in sorted(report_list.keys(), reverse=True)[:num]:
        obj = report_list[period] or {}
        rec = {"报告期": f"{period[:4]}-{period[4:6]}-{period[6:8]}"}
        for it in obj.get("data", []) or []:
            title = it.get("item_title", "")
            if not title or it.get("item_value") is None:
                continue
            rec[title] = it.get("item_value")
            tb = it.get("item_tongbi")
            if tb not in (None, ""):
                rec[title + "_同比"] = tb
        rows.append(rec)
    return rows


# ---------- 备源:个股资金流(日度) ----------
def sina_fund_flow(code: str, days: int = 60) -> list[dict]:
    """新浪个股资金流(日度):[{date, close, net_amount, turnover}](东财 push2his 不通时的备源)"""
    digits, market = norm_ticker(code, stock_only=True)
    url = f"https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num={days}&sort=opendate&asc=0&daima={market.lower()}{digits}"
    t = http_get(url, headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}, timeout=15, ext="json").text
    if "[" not in t:
        raise RuntimeError(f"新浪资金流响应异常: {t[:120]}")
    arr = json.loads(t[t.index("["): t.rindex("]") + 1])
    return [{"date": x.get("opendate"), "close": x.get("trade"), "net_amount": x.get("netamount"), "turnover": x.get("turnover")} for x in arr]


# ---------- 9.1 ETF 期权 ----------
def _opt_f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return x


def _sina_hq_multi(params: list[str]) -> dict[str, list]:
    """hq.sinajs.cn 批量取值:{参数名: 逗号分隔的值列表}(GBK);键 "_raw" = 本次响应的 raw_ref。"""
    if not params:
        return {}
    r = http_get(f"https://hq.sinajs.cn/list={','.join(params)}", headers=SINA_OPT_HDR, timeout=10, encoding="gbk", ext="txt")
    out: dict[str, list] = {"_raw": getattr(r, "_vra_raw_ref", None)}
    for line in r.text.split(";"):
        m = re.search(r"hq_str_([^=]+)=\"([^\"]*)\"", line)
        if m:
            out[m.group(1)] = m.group(2).split(",") if m.group(2) else []
    return out


def sina_option_codes(underlying: str = "510050", call: bool = True) -> dict:
    """ETF 期权合约清单 {月份 YYMM: [合约代码]},首个 key 为近月。underlying: 510050/510300/588000/510500"""
    cate = {"510050": "50ETF", "510300": "300ETF", "588000": "科创50ETF", "510500": "500ETF"}.get(underlying, "50ETF")
    d = http_json(f"https://stock.finance.sina.com.cn/futures/api/openapi.php/StockOptionService.getStockName?exchange=null&cate={cate}", headers=SINA_OPT_HDR, timeout=10)
    months = (((d or {}).get("result") or {}).get("data") or {}).get("contractMonth") or []
    months = [m.replace("-", "")[2:] for m in months[1:]]
    flag = "OP_UP_" if call else "OP_DOWN_"
    lists = _sina_hq_multi([f"{flag}{underlying}{m}" for m in months])
    out = {}
    for m in months:
        codes = [c.replace("CON_OP_", "") for c in lists.get(f"{flag}{underlying}{m}", []) if c.startswith("CON_OP_")]
        if codes:
            out[m] = codes
    return out


def _parse_tquote(v: list) -> dict:
    if len(v) < 43:
        return {}
    return {"bid_vol": _opt_f(v[0]), "bid": _opt_f(v[1]), "last": _opt_f(v[2]), "ask": _opt_f(v[3]), "ask_vol": _opt_f(v[4]), "open_interest": _opt_f(v[5]), "pct": _opt_f(v[6]), "strike": _opt_f(v[7]),
            "prev_close": _opt_f(v[8]), "open": _opt_f(v[9]), "limit_up": _opt_f(v[10]), "limit_down": _opt_f(v[11]), "name": v[37], "amplitude": _opt_f(v[38]), "high": _opt_f(v[39]), "low": _opt_f(v[40]),
            "volume": _opt_f(v[41]), "amount": _opt_f(v[42])}


def _parse_greeks(raw: list) -> dict:
    if len(raw) < 16:
        return {}
    v = [raw[0]] + raw[4:]
    return {"name": v[0], "volume": _opt_f(v[1]), "delta": _opt_f(v[2]), "gamma": _opt_f(v[3]), "theta": _opt_f(v[4]), "vega": _opt_f(v[5]), "iv": _opt_f(v[6]), "high": _opt_f(v[7]), "low": _opt_f(v[8]),
            "trade_code": v[9], "strike": _opt_f(v[10]), "last": _opt_f(v[11]), "theory": _opt_f(v[12])}


def sina_option_chain(underlying: str = "510050", side: str = "call", month: Optional[str] = None, max_contracts: int = 40) -> dict:
    """某月(默认近月)全部合约的 T 型报价 + 希腊字母:{underlying, side, month, months, contracts:[{code, tquote, greeks}]}"""
    by_month = sina_option_codes(underlying, call=(side == "call"))
    if not by_month:
        raise DataNotAvailable(f"{underlying} 无期权合约清单(非 ETF 期权标的或源变更)")
    month = month or next(iter(by_month))
    if month not in by_month:
        raise ValueError(f"月份 {month} 无合约,可选 {list(by_month)}")
    codes = by_month[month][:max_contracts]
    tq = _sina_hq_multi([f"CON_OP_{c}" for c in codes])
    gk = _sina_hq_multi([f"CON_SO_{c}" for c in codes])
    contracts = [{"code": c, "tquote": _parse_tquote(tq.get(f"CON_OP_{c}", [])), "greeks": _parse_greeks(gk.get(f"CON_SO_{c}", [])), "_raw_tq": tq.get("_raw"), "_raw_gk": gk.get("_raw")} for c in codes]
    return {"underlying": underlying, "side": side, "month": month, "months": list(by_month), "contracts": contracts}


# ---------- 美股 / 港股(global-stock-data §1.1 / §1.2 / §2.1) ----------
def _hq_fields(param: str, sep: str = ",") -> list:
    r = http_get(f"https://hq.sinajs.cn/list={param}", headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    m = re.search(r'"(.+)"', r.text)
    return m.group(1).split(sep) if m else []


def _ff(f: list, i: int):
    try:
        return float(f[i]) if f[i] not in ("", None) else 0.0
    except (ValueError, IndexError):
        return 0.0


def us_stock_quote_sina(ticker: str) -> dict:
    """新浪美股行情(36 字段):name/price/change_pct/timestamp/prev_close/open/high/low/volume/high_52w/low_52w/market_cap(新浪原值)/eps/pe"""
    from sources._http import assert_us_ticker
    f = _hq_fields(f"gb_{assert_us_ticker(ticker).lower()}")
    if len(f) < 30:
        return {}
    return {"name": f[0], "price": _ff(f, 1), "change_pct": _ff(f, 2), "timestamp": f[3], "prev_close": _ff(f, 26), "open": _ff(f, 5), "high": _ff(f, 6), "low": _ff(f, 7), "volume": _ff(f, 10),
            "high_52w": _ff(f, 8), "low_52w": _ff(f, 9), "market_cap": _ff(f, 12), "eps": _ff(f, 13), "pe": _ff(f, 14)}


def hk_stock_quote_sina(code: str) -> dict:
    """新浪港股行情(25 字段):name_en/name/open/prev_close/high/low/price/change/change_pct/volume/amount"""
    from sources._http import norm_hk
    f = _hq_fields(f"rt_hk{norm_hk(code)}")
    if len(f) < 15:
        return {}
    return {"name_en": f[0], "name": f[1], "open": _ff(f, 2), "prev_close": _ff(f, 3), "high": _ff(f, 4), "low": _ff(f, 5), "price": _ff(f, 6), "change": _ff(f, 7), "change_pct": _ff(f, 8),
            "volume": _ff(f, 12), "amount": _ff(f, 11)}


def us_stock_kline_sina(ticker: str, num: int = 120) -> list[dict]:
    """新浪美股日 K(可回溯到 1984):[{date, open, high, low, close, volume}]"""
    from sources._http import assert_us_ticker
    t = http_get("https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var/US_MinKService.getDailyK", params={"symbol": assert_us_ticker(ticker), "num": num},
                 headers={"Referer": "https://finance.sina.com.cn/", "User-Agent": UA}, timeout=15, ext="js").text
    m = re.search(r"\((\[.+\])\)", t, re.S)
    if not m:
        return []
    return [{"date": it.get("d"), "open": float(it.get("o", 0)), "high": float(it.get("h", 0)), "low": float(it.get("l", 0)), "close": float(it.get("c", 0)), "volume": int(float(it.get("v", 0) or 0))}
            for it in json.loads(m.group(1))]
