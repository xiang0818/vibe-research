"""SEC EDGAR 源(S 级:官方,需在 User-Agent 声明联系方式 → 环境变量 VRA_SEC_CONTACT):ticker→CIK / 申报列表 / XBRL companyfacts / 每日申报索引 / 全文检索 / frames 全市场横截面。
移植自 global-stock-data §7.1 / §7.2 / §8.3 / §10.1 / §10.2 / Layer 11;全部经 _http.official_get(限流 8/s + UA)。"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import DataNotAvailable, ResourceUnavailable, assert_us_ticker, official_get  # noqa: E402

_CIK_CACHE: dict = {}
_FORM_LABEL = {"4": "内部人交易", "8-K": "重大事件", "13F-HR": "机构持仓", "144": "限售股拟出售", "10-K": "年报", "10-Q": "季报", "SC 13D": "举牌(主动)", "SC 13G": "举牌(被动)", "S-1": "IPO注册"}
DEFAULT_METRICS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "NetIncomeLoss", "EarningsPerShareDiluted", "Assets", "Liabilities", "StockholdersEquity",
                   "NetCashProvidedByUsedInOperatingActivities", "PaymentsToAcquirePropertyPlantAndEquipment", "ResearchAndDevelopmentExpense"]
XBRL_TAGS = {"营业收入": "Revenues", "营业收入(合同)": "RevenueFromContractWithCustomerExcludingAssessedTax", "净利润": "NetIncomeLoss", "研发费用": "ResearchAndDevelopmentExpense", "毛利": "GrossProfit",
             "经营利润": "OperatingIncomeLoss", "总资产": "Assets", "股东权益": "StockholdersEquity", "现金及等价物": "CashAndCashEquivalentsAtCarryingValue", "经营现金流": "NetCashProvidedByUsedInOperatingActivities",
             "资本开支": "PaymentsToAcquirePropertyPlantAndEquipment", "长期负债": "LongTermDebtNoncurrent", "稀释EPS": "EarningsPerShareDiluted"}
_INSTANT_TAGS = {"Assets", "StockholdersEquity", "CashAndCashEquivalentsAtCarryingValue", "LongTermDebtNoncurrent", "Liabilities"}


def _recent_weekdays(days_back: int = 7) -> list[str]:
    d, out = datetime.utcnow(), []
    while len(out) < days_back:
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
        d -= timedelta(days=1)
    return out


def ticker_to_cik(ticker: str) -> dict:
    """{ticker, cik(10 位), company};映射表 company_tickers.json 进程内缓存。"""
    global _CIK_CACHE
    t = assert_us_ticker(ticker)
    if not _CIK_CACHE:
        _CIK_CACHE = official_get("https://www.sec.gov/files/company_tickers.json", as_json=True)
    for _, v in _CIK_CACHE.items():
        if str(v.get("ticker", "")).upper() == t:
            return {"ticker": t, "cik": str(v["cik_str"]).zfill(10), "company": v.get("title")}
    raise DataNotAvailable(f"SEC company_tickers 无 {t}(非美股上市公司或 ticker 已变更)")


def _cik_of(ticker_or_cik: str) -> str:
    s = str(ticker_or_cik).strip()
    return s.zfill(10) if s.isdigit() else ticker_to_cik(s)["cik"]


def sec_filings(ticker: str, form_type: Optional[str] = None, limit: int = 50) -> dict:
    """EDGAR submissions:{company_name, cik, ticker, filings:[{form, date, accession_number, primary_document, description, url}]}"""
    cik = _cik_of(ticker)
    data = official_get(f"https://data.sec.gov/submissions/CIK{cik}.json", as_json=True)
    rec = (data.get("filings") or {}).get("recent") or {}
    forms, dates, accs = rec.get("form", []), rec.get("filingDate", []), rec.get("accessionNumber", [])
    docs, descs = rec.get("primaryDocument", []), rec.get("primaryDocDescription", [])
    out = []
    for i in range(len(forms)):
        if form_type and forms[i] != form_type:
            continue
        doc = docs[i] if i < len(docs) else ""
        out.append({"form": forms[i], "date": dates[i], "accession_number": accs[i], "primary_document": doc, "description": descs[i] if i < len(descs) else "",
                    "url": f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accs[i].replace('-', '')}/{doc}" if doc else ""})
        if len(out) >= limit:
            break
    return {"company_name": data.get("name"), "cik": cik, "ticker": (data.get("tickers") or [""])[0], "filings": out}


def sec_xbrl_facts(ticker: str, metrics: Optional[list] = None, last_n: int = 12) -> dict:
    """companyfacts:{company, cik, metrics:{name:{unit, entries:[{end, val, form, filed, fy, fp}]}}, available_count};metrics 默认 DEFAULT_METRICS(只取 10-K / 10-Q)。"""
    cik = _cik_of(ticker)
    facts = official_get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json", as_json=True)
    gaap = (facts.get("facts") or {}).get("us-gaap") or {}
    res = {}
    for name in metrics or DEFAULT_METRICS:
        m = gaap.get(XBRL_TAGS.get(name, name)) or {}
        units = m.get("units") or {}
        uk = "USD" if "USD" in units else (next(iter(units)) if units else None)
        if not uk:
            continue
        ents = [e for e in units[uk] if e.get("form") in ("10-K", "10-Q")]
        res[XBRL_TAGS.get(name, name)] = {"unit": uk, "label": m.get("label"), "entries": [{"end": e.get("end"), "start": e.get("start"), "val": e.get("val"), "form": e.get("form"), "filed": e.get("filed"), "fy": e.get("fy"), "fp": e.get("fp")} for e in ents[-last_n:]]}
    return {"company": facts.get("entityName"), "cik": cik, "metrics": res, "available_count": len(gaap)}


def daily_filings(date: Optional[str] = None, forms: Optional[list] = None) -> dict:
    """每日申报索引:{date, total, by_form, filings:[{form, form_label, company, cik, date, url}]};date=YYYYMMDD,缺省回退最近有数据的工作日。"""
    last_error = None
    for d in ([date] if date else _recent_weekdays(7)):
        dt = datetime.strptime(d, "%Y%m%d")
        try:
            raw = official_get(f"https://www.sec.gov/Archives/edgar/daily-index/{dt.year}/QTR{(dt.month - 1) // 3 + 1}/form.{d}.idx")
        except ResourceUnavailable as exc:
            last_error = exc
            continue
        lines = raw.splitlines()
        start = next((i + 1 for i, ln in enumerate(lines) if ln.startswith("---")), 11)
        filings, by_form = [], {}
        for ln in lines[start:]:
            if len(ln) < 98:
                continue
            form, company, cik, filed, path = ln[:12].strip(), ln[12:74].strip(), ln[74:86].strip(), ln[86:98].strip(), ln[98:].strip()
            if not form:
                continue
            by_form[form] = by_form.get(form, 0) + 1
            if forms and form not in forms:
                continue
            filings.append({"form": form, "form_label": _FORM_LABEL.get(form, ""), "company": company, "cik": cik, "date": filed, "url": f"https://www.sec.gov/Archives/{path}" if path else None})
        if by_form:
            return {"date": d, "total": sum(by_form.values()), "by_form": dict(sorted(by_form.items(), key=lambda x: -x[1])), "filings": filings}
    raise ResourceUnavailable("未取得有效 EDGAR 每日索引，无法确认是否有申报数据") from last_error


def fulltext_search(query: str, forms: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None, limit: int = 20) -> dict:
    p: dict = {"q": query, "from": 0, "size": limit}
    if forms:
        p["forms"] = forms
    if date_from:
        p["dateRange"], p["startdt"] = "custom", date_from
    if date_to:
        p["dateRange"], p["enddt"] = "custom", date_to
    j = official_get("https://efts.sec.gov/LATEST/search-index", params=p, as_json=True)
    hits = (j.get("hits") or {}).get("hits") or []
    return {"query": query, "total": ((j.get("hits") or {}).get("total") or {}).get("value", 0),
            "results": [{"form": (h.get("_source") or {}).get("root_form"), "company": ((h.get("_source") or {}).get("display_names") or [None])[0], "filed": (h.get("_source") or {}).get("file_date"), "id": h.get("_id")} for h in hits]}


def _frame_period(year: int, quarter, instant: bool) -> str:
    if instant:
        return f"CY{year}Q{quarter}I" if quarter else f"CY{year}Q4I"
    return f"CY{year}Q{quarter}" if quarter else f"CY{year}"


def market_frame(tag: str, year: Optional[int] = None, quarter: Optional[int] = None, unit: str = "USD", instant: Optional[bool] = None, top: int = 50) -> dict:
    """frames 全市场横截面:{tag, period, unit, instant, count, top:[{cik, entity, value, end}]}(时点概念自动带 I 后缀,404 换另一形式重试)。"""
    tag = XBRL_TAGS.get(tag, tag)
    year = year or (datetime.utcnow().year - 1)
    guess = (tag in _INSTANT_TAGS) if instant is None else instant
    last = None
    for is_inst in ([guess] if instant is not None else [guess, not guess]):
        period = _frame_period(year, quarter, is_inst)
        try:
            j = official_get(f"https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/{unit}/{period}.json", timeout=45, as_json=True)
        except ResourceUnavailable as e:
            last = e
            continue
        rows = [{"cik": d.get("cik"), "entity": d.get("entityName"), "value": d.get("val"), "end": d.get("end")} for d in j.get("data", [])]
        rows.sort(key=lambda x: (x["value"] is None, -(x["value"] or 0)))
        return {"tag": tag, "period": period, "unit": unit, "instant": is_inst, "count": len(rows), "top": rows[:top]}
    raise last if last else DataNotAvailable("frames 无数据")
