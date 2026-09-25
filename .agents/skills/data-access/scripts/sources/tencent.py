"""腾讯财经源:批量实时行情(个股 / 指数 / ETF / 北交所),含僵尸报价判定。移植自 a-stock-data SKILL.md §1.2。零鉴权。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import http_get  # noqa: E402

SH_INDEX = {"000300", "000905", "000016", "000688", "000852", "000010"}  # 沪指数白名单(裸码会被当成深市)
_HDR = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}


def tencent_prefix(code: str) -> str:
    """与 a-stock-data get_prefix 一致的前缀路由;显式 sh/sz/bj 前缀透传(解决 000001 歧义)。"""
    c = str(code).strip()
    low = c.lower()
    # 🔴 美股 / 港股代码**原样透传,不转小写**:腾讯对它们大小写敏感 ——
    #    `usDJI` 有数据、`usdji` 返回 `v_usdji="1";`(空壳,20 字节)。
    #    转了小写不会报错,只是那一条**静默地没有了** —— 界面上表现为"少一张卡片"。
    if low.startswith(("us", "hk")):
        return c
    if low.startswith(("sh", "sz", "bj")):
        return low
    if c.startswith("92"):
        return f"bj{c}"
    if c in SH_INDEX or c.startswith(("5", "6", "9")):
        return f"sh{c}"
    if c.startswith(("4", "8")):
        return f"bj{c}"
    return f"sz{c}"


def _f(vals: list, i: int) -> float:
    try:
        return float(vals[i]) if vals[i] not in ("", None) else 0.0
    except (ValueError, IndexError):
        return 0.0


def tencent_quotes(codes) -> dict:
    """批量行情:{入参写法: {name, price, last_close, open, change_pct, high, low, amount_wan, turnover_pct, pe_ttm, pb, mcap_yi, float_mcap_yi, limit_up, limit_down, vol_ratio, pe_static, is_stale, stale_reason?}}"""
    if isinstance(codes, str):
        codes = [x for x in codes.replace(" ", "").split(",") if x]
    prefixed, key_of = [], {}
    for c in codes:
        p = tencent_prefix(c)
        prefixed.append(p)
        key_of[p] = c
    r = http_get("https://qt.gtimg.cn/q=" + ",".join(prefixed), headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    r.raise_for_status()
    result: dict = {}
    for line in r.text.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key_of.get(key, key[2:])
        q = {"name": vals[1], "price": _f(vals, 3), "last_close": _f(vals, 4), "open": _f(vals, 5), "change_amt": _f(vals, 31), "change_pct": _f(vals, 32), "high": _f(vals, 33), "low": _f(vals, 34),
             "amount_wan": _f(vals, 37), "turnover_pct": _f(vals, 38), "pe_ttm": _f(vals, 39), "amplitude_pct": _f(vals, 43), "float_mcap_yi": _f(vals, 44), "mcap_yi": _f(vals, 45), "pb": _f(vals, 46),
             "limit_up": _f(vals, 47), "limit_down": _f(vals, 48), "vol_ratio": _f(vals, 49), "pe_static": _f(vals, 52), "query": key}
        q["is_stale"] = bool(q["amount_wan"] == 0 and q["price"] == q["last_close"] and q["price"] > 0)
        if q["is_stale"] and key[2:4] in ("43", "83", "87"):
            q["stale_reason"] = "北交所老号段,多数已迁至 920xxx,请按名称反查现行代码"
        elif q["is_stale"]:
            q["stale_reason"] = "成交量为 0(停牌 / 未开盘 / 废码),报价非当日真实成交"
        result[code] = q
    return result


def tencent_quote(code: str) -> dict:
    """单标的(个股 / 指数 / ETF 皆可,可带 sh/sz/bj 前缀)。"""
    return tencent_quotes([code])


# ---------- 美股 / 港股(global-stock-data §1.1 / §1.2;字段下标以实测为准,两市布局不同) ----------
def _gbk_fields(url: str, sep: str) -> list:
    import re
    r = http_get(url, headers=_HDR, timeout=10, encoding="gbk", ext="txt")
    m = re.search(r'"(.+)"', r.text)
    return m.group(1).split(sep) if m else []


def us_stock_quote_tencent(ticker: str) -> dict:
    """腾讯美股行情(71 字段):price/prev_close/open/high/low/volume/change_pct/market_cap(亿美元)/float_market_cap(亿美元)/eps/pe/pb/high_52w/low_52w/name/name_en/currency"""
    from sources._http import assert_us_ticker
    f = _gbk_fields(f"https://qt.gtimg.cn/q=us{assert_us_ticker(ticker)}", "~")
    if len(f) < 52:
        return {}
    g = lambda i: _f(f, i)  # noqa: E731
    return {"name": f[1], "name_en": f[46] if len(f) > 46 else "", "price": g(3), "prev_close": g(4), "open": g(5), "volume": int(g(6)), "high": g(33), "low": g(34), "high_52w": g(48), "low_52w": g(49),
            "change_pct": g(32), "float_market_cap": g(44), "market_cap": g(45), "eps": g(47), "pe": g(39), "pb": g(51), "currency": f[35], "timestamp": f[30]}


def hk_stock_quote_tencent(code: str) -> dict:
    """腾讯港股行情(78 字段):price/prev_close/open/high/low/volume(股)/amount/change_pct/pe/pb/high_52w/low_52w/market_cap(亿港元)/float_market_cap(亿港元)/currency"""
    from sources._http import norm_hk
    f = _gbk_fields(f"https://qt.gtimg.cn/q=r_hk{norm_hk(code)}", "~")
    if len(f) < 76:
        return {}
    g = lambda i: _f(f, i)  # noqa: E731
    return {"name": f[1], "code": f[2], "name_en": f[46], "price": g(3), "prev_close": g(4), "open": g(5), "high": g(33), "low": g(34), "volume": int(g(6)), "amount": g(37), "change_pct": g(32),
            "pe": g(39), "pb": g(58), "high_52w": g(48), "low_52w": g(49), "float_market_cap": g(44), "market_cap": g(45), "currency": f[75], "timestamp": f[30]}
