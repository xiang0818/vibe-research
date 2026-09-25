"""美国宏观 / 日历(global-stock-data Layer 12):美债收益率曲线(财政部,S)/ CFTC 持仓报告 COT(S)/ Nasdaq 财报日历(B)。经 _http.official_get。"""
from __future__ import annotations

import csv
import io
import os
import sys
from datetime import datetime
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import official_get  # noqa: E402


def treasury_yield_curve(year: Optional[int] = None) -> list[dict]:
    """每日收益率曲线(1M~30Y,百分数):[{Date, '1 Mo', ..., '30 Yr'}],[0] 为最新一日"""
    year = year or datetime.utcnow().year
    url = (f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
    return list(csv.DictReader(io.StringIO(official_get(url))))


def cftc_cot(limit: int = 20, market_contains: Optional[str] = None) -> list[dict]:
    """CFTC COT(Socrata 6dca-aqww,按报告日倒序):原始行(contract_market_name / report_date_as_yyyy_mm_dd / open_interest_all / noncomm_positions_long_all / ...)"""
    q: dict = {"$limit": limit, "$order": "report_date_as_yyyy_mm_dd DESC"}
    if market_contains:
        q["$where"] = f"upper(contract_market_name) like upper('%{market_contains}%')"
    return official_get("https://publicreporting.cftc.gov/resource/6dca-aqww.json", params=q, as_json=True)


def earnings_calendar(date: Optional[str] = None) -> dict:
    """Nasdaq 财报日历:{date, count, rows:[{symbol, name, time, eps_forecast, market_cap}]};date=YYYY-MM-DD 默认今天(UTC)"""
    date = date or datetime.utcnow().strftime("%Y-%m-%d")
    j = official_get("https://api.nasdaq.com/api/calendar/earnings", params={"date": date}, headers={"Accept": "application/json"}, as_json=True)
    rows = ((j.get("data") or {}).get("rows")) or []
    return {"date": date, "count": len(rows), "rows": [{"symbol": r.get("symbol"), "name": r.get("name"), "time": r.get("time"), "eps_forecast": r.get("epsForecast"), "market_cap": r.get("marketCap")} for r in rows]}
