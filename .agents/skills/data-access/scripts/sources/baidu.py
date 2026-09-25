"""百度股市通源:日 K 线自带 MA5 / MA10 / MA20。移植自 a-stock-data SKILL.md §1.3。零鉴权。"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import norm_ticker  # noqa: E402
from sources._http import http_json  # noqa: E402


def baidu_kline_with_ma(code: str, start_time: str = "", ktype: str = "1") -> dict:
    """返回 {keys:[...], rows:[{key: 原始字符串}]};keys 含 time/open/close/high/low/volume/amount/ma5avgprice/ma10avgprice/ma20avgprice 等。"""
    digits, _ = norm_ticker(code, stock_only=True)
    params = {"all": "1", "isIndex": "false", "isBk": "false", "isBlock": "false", "isFutures": "false", "isStock": "true", "newFormat": "1", "group": "quotation_kline_ab",
              "finClientType": "pc", "code": digits, "start_time": start_time, "ktype": ktype}
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/vnd.finance-web.v1+json", "Origin": "https://gushitong.baidu.com", "Referer": "https://gushitong.baidu.com/"}
    d = http_json("https://finance.pae.baidu.com/selfselect/getstockquotation", params=params, headers=headers, timeout=10)
    if str(d.get("ResultCode", "0")) != "0":
        raise RuntimeError(f"百度股市通拒绝:ResultCode={d.get('ResultCode')}(2026-08 起该接口在部分网络需要 Cookie / 反爬收紧,属源侧限制)")
    md = ((d.get("Result") or {}).get("newMarketData") or {})
    keys = md.get("keys") or []
    rows = []
    for line in (md.get("marketData") or "").split(";"):
        if not line.strip():
            continue
        rows.append(dict(zip(keys, line.split(","))))
    return {"keys": keys, "rows": rows}
