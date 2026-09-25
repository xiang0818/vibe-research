import pytest
from test_registry_sources import _ctx
from sources import mappers_global as m

@pytest.mark.parametrize("currency,expected", [("CNY", "CNY"), ("人民币", "CNY"), ("USD", "USD"), ("HKD", "HKD")])
def test_report_currency_not_listing_currency(currency, expected):
    ctx = _ctx(market="HK", symbol="00700", ep={"id": "financials"}, args={"statement": "income"})
    out = m.em_financials_global_map([{"ITEM_NAME": "营业收入", "AMOUNT": 100, "CURRENCY": currency, "REPORT_DATE": "2026-06-30"}], ctx)
    assert out["evidence"][0]["currency"] == expected

def test_unknown_currency_does_not_invent_money():
    ctx = _ctx(market="HK", symbol="00700", ep={"id": "ind"})
    out = m.em_key_indicators_global_map([{"OPERATE_INCOME": 100, "ROE_AVG": 5, "CURRENCY": "UNKNOWN", "REPORT_DATE": "2026-06-30"}], ctx)
    assert not any(e["field"] == "revenue" for e in out["evidence"])
    assert any(e["field"] == "roe" for e in out["evidence"])
    assert out["status"] == "partial"

def test_kline_missing_extremes_preserves_close():
    ctx = _ctx(market="US", symbol="AAPL", ep={"id": "kline"})
    out = m.kline_map([{"date": "2026-09-01", "close": 10, "high": None, "low": None}], ctx)
    assert out["evidence"]
    assert out["status"] == "partial"

def test_missing_flow_pct_is_not_null_numeric_evidence():
    ctx = _ctx(market="HK", symbol="00700", ep={"id": "flow"})
    out = m.em_fund_flow_global_map([{"date": "2026-09-01", "main_net": 10, "main_pct": None}], ctx)
    assert not any(e["field"] == "main_net_inflow_pct_latest" for e in out["evidence"])
