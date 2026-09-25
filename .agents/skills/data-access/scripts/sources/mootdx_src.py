"""通达信(mootdx,TCP 7709,零鉴权)源:K 线(不复权)/ 实时五档 / 逐笔成交 / 财务快照(37 字段)/ F10 文本。移植自 a-stock-data SKILL.md §1.1 / §6.1 / §6.2 / §7.2 + 客户端选服逻辑(规避 0.11.x BESTIP 空串 bug)。
海外网络通常全部超时;结果以 extracted_ 前缀落盘。"""
from __future__ import annotations

import os
import socket
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import norm_ticker, quiet_stdout  # noqa: E402
from sources._http import dump_json_bytes, record_raw  # noqa: E402

_TDX_SERVERS = [("119.97.185.59", 7709), ("124.70.133.119", 7709), ("116.205.183.150", 7709), ("123.60.73.44", 7709), ("116.205.163.254", 7709), ("121.36.225.169", 7709),
                ("123.60.70.228", 7709), ("124.71.9.153", 7709), ("110.41.147.114", 7709), ("124.71.187.122", 7709)]
_CLIENT = None
F10_CATEGORIES = ["最新提示", "公司概况", "财务分析", "股东研究", "股本结构", "资本运作", "业内点评", "行业分析", "公司大事"]


def _probe(ip: str, port: int, timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _validate(client) -> bool:
    try:
        df = client.bars(symbol="000001", frequency=9, offset=1)
        return df is not None and not df.empty
    except Exception:  # noqa: BLE001
        return False


def tdx_client():
    """顺序探测候选服务器并真实取数验活;全部失败回退 bestip / 裸 factory;仍失败抛 RuntimeError。"""
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    from mootdx.quotes import Quotes
    with quiet_stdout():
        for attempt in range(2):  # 服务器偶发 reset,整体再试一轮
            for ip, port in _TDX_SERVERS:
                if not _probe(ip, port):
                    continue
                try:
                    c = Quotes.factory(market="std", server=(ip, port))
                    if _validate(c):
                        _CLIENT = c
                        return c
                except Exception:  # noqa: BLE001
                    continue
        for ip, port in ():
            if not _probe(ip, port):
                continue
            try:
                c = Quotes.factory(market="std", server=(ip, port))
                if _validate(c):
                    _CLIENT = c
                    return c
            except Exception:  # noqa: BLE001
                continue
        for kwargs in ({"bestip": True}, {}):
            try:
                c = Quotes.factory(market="std", **kwargs)
                if _validate(c):
                    _CLIENT = c
                    return c
            except Exception:  # noqa: BLE001
                continue
    raise RuntimeError("所有 mootdx 服务器均无法取到数据(TCP 可达但返回空 / 被 reset);海外网络通常全部超时,请走国内代理")


def _records(df) -> list[dict]:
    if df is None or getattr(df, "empty", True):
        return []
    idx_name = getattr(df.index, "name", None)
    d = df.reset_index(drop=(idx_name in df.columns)) if idx_name else df
    out = []
    for rec in d.to_dict("records"):
        out.append({k: (v.isoformat() if hasattr(v, "isoformat") else (None if (isinstance(v, float) and v != v) else v)) for k, v in rec.items()})
    return out


def tdx_bars(code: str, frequency: int = 9, offset: int = 120) -> list[dict]:
    """K 线(不复权原始价)。frequency: 0=5 分 1=15 分 2=30 分 3=60 分 4=日 5=周 6=月 8=1 分 9=日(默认) 10=季 11=年"""
    digits, _ = norm_ticker(code, stock_only=True)
    with quiet_stdout():
        rows = _records(tdx_client().bars(symbol=digits, frequency=frequency, offset=offset))
    record_raw(dump_json_bytes({"code": digits, "frequency": frequency, "offset": offset, "rows": rows}), "json", f"tdx://bars/{digits}", kind="extracted")
    return rows


def tdx_quotes(codes) -> list[dict]:
    """实时报价(46 字段:price/open/high/low/last_close/bid1~5/ask1~5/bid_vol/ask_vol/vol/amount/servertime)"""
    if isinstance(codes, str):
        codes = [x for x in codes.replace(" ", "").split(",") if x]
    digits = [norm_ticker(c, stock_only=True)[0] for c in codes]
    with quiet_stdout():
        rows = _records(tdx_client().quotes(symbol=digits))
    record_raw(dump_json_bytes(rows), "json", f"tdx://quotes/{','.join(digits)}", kind="extracted")
    return rows


def tdx_transaction(code: str, date: Optional[str] = None) -> list[dict]:
    """逐笔成交(time/price/vol/num/buyorsell 0 买 1 卖 2 中性);date=YYYYMMDD,None=当日;非交易时间为空。"""
    digits, _ = norm_ticker(code, stock_only=True)
    with quiet_stdout():
        c = tdx_client()
        df = c.transaction(symbol=digits, date=date) if date else c.transactions(symbol=digits) if hasattr(c, "transactions") else c.transaction(symbol=digits)
        rows = _records(df)
    record_raw(dump_json_bytes({"code": digits, "date": date, "rows": rows}), "json", f"tdx://transaction/{digits}", kind="extracted")
    return rows


def tdx_finance(code: str) -> dict:
    """财务快照(37 字段季报:liutongguben/zongguben/eps/bvps/roe/profit/income/...)"""
    digits, _ = norm_ticker(code, stock_only=True)
    with quiet_stdout():
        rows = _records(tdx_client().finance(symbol=digits))
    record_raw(dump_json_bytes(rows), "json", f"tdx://finance/{digits}", kind="extracted")
    return rows[0] if rows else {}


def tdx_f10(code: str, categories: Optional[list] = None) -> dict:
    """F10 文本资料:{类别: 文本}(9 大类,默认全取)"""
    digits, _ = norm_ticker(code, stock_only=True)
    out = {}
    with quiet_stdout():
        c = tdx_client()
        for cat in categories or F10_CATEGORIES:
            try:
                out[cat] = c.F10(symbol=digits, name=cat) or ""
            except Exception as e:  # noqa: BLE001
                out[cat] = f"[取数失败] {e}"
    record_raw(dump_json_bytes(out), "json", f"tdx://F10/{digits}", kind="extracted")
    return out
