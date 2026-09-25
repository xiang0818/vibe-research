"""传输失败不能冒充业务无数据；日期回退仍需拿到有效正文。全部离线。"""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sources import _http, finra, mappers_global, sec

HEADER = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market"
MISSING = (404, "text/html", "<html>Not Found</html>")
DENIED = (403, "application/xml", "<Error><Code>AccessDenied</Code></Error>")


def install_http(monkeypatch, replies):
    calls = []

    def get(url, **kwargs):
        calls.append(url)
        status, content_type, body = replies[len(calls) - 1] if len(calls) <= len(replies) else replies[-1]
        response = requests.Response()
        response.status_code, response.url = status, url
        response.headers["Content-Type"] = content_type
        response._content = body.encode()
        return response

    monkeypatch.setattr(_http, "_session", lambda *a: SimpleNamespace(get=get))
    monkeypatch.setattr(_http, "_limiter_for", lambda *a: SimpleNamespace(wait=lambda: None))
    monkeypatch.setenv("VRA_SEC_CONTACT", "Test fixture@example.invalid")
    return calls


@pytest.mark.parametrize("reply", [MISSING, DENIED, (403, "text/html", "denied"), (429, "text/plain", "slow down")])
def test_http_failure_is_not_business_absence_and_raw_is_kept(tmp_path, monkeypatch, reply):
    install_http(monkeypatch, [reply])
    with _http.capture(str(tmp_path), "fixture", "probe") as capture:
        with pytest.raises(RuntimeError) as error:
            _http.official_get("https://api.example.invalid/data/20260904")
    assert not isinstance(error.value, _http.DataNotAvailable)
    assert str(reply[0]) in str(error.value)
    assert "该日无数据" not in str(error.value)
    assert (tmp_path / capture.last_raw_ref).read_bytes() == reply[2].encode()


@pytest.mark.parametrize("reply", [MISSING, DENIED])
def test_finra_all_files_unreachable_does_not_return_empty_symbol(monkeypatch, reply):
    install_http(monkeypatch, [reply])
    monkeypatch.setattr(finra, "_recent_weekdays", lambda n: ["20260904", "20260903"])
    with pytest.raises(RuntimeError, match="无法确认") as error:
        finra.short_volume_symbol("AAPL", days=1)
    assert not isinstance(error.value, _http.DataNotAvailable)


@pytest.mark.parametrize("reply", [MISSING, DENIED])
def test_finra_missing_daily_file_can_fall_back_to_valid_snapshot(monkeypatch, reply):
    body = HEADER + "\n20260903|AAPL|20|2|100|Q,N\n1\n"
    calls = install_http(monkeypatch, [reply, (200, "text/plain", body)])
    monkeypatch.setattr(finra, "_recent_weekdays", lambda n: ["20260904", "20260903"])
    result = finra.short_volume_symbol("AAPL", days=1)
    assert result[0]["date"] == "20260903" and result[0]["ratio"] == 0.2
    assert len(calls) == 2


@pytest.mark.parametrize("body", [
    "<html>Access denied</html>",
    HEADER + "\n20260904|AAPL|bad|2|100|Q\n1\n",
    HEADER + "\n20260903|AAPL|20|2|100|Q\n1\n",  # 不能把旧日期当新快照
    HEADER + "\n20260904|AAPL|20|2|100|Q\n2\n",  # 丢行不能当无记录
])
def test_finra_bad_success_body_is_not_business_absence(monkeypatch, body):
    install_http(monkeypatch, [(200, "text/plain", body)])
    with pytest.raises(RuntimeError) as error:
        finra.short_volume_all(date="20260904")
    assert not isinstance(error.value, _http.DataNotAvailable)


def test_finra_valid_zero_file_proves_empty_snapshot_not_missing_resource(monkeypatch):
    install_http(monkeypatch, [(200, "text/plain", HEADER + "\n0\n")])
    snapshot = finra.short_volume_all(date="20260904")
    assert snapshot["count"] == 0 and snapshot["data"] == {}


def test_finra_fractional_volumes_from_official_20260903_sample(monkeypatch):
    # 官方 CNMSshvol20260903.txt 的两条记录；旧 2021 布局文档的整数假设已过时。
    body = (HEADER + "\n20260903|A|431541.387127|5022|914877.441540|B,Q,N"
            "\n20260903|AAA|1064|0|2131.349961|Q\n2\n")
    install_http(monkeypatch, [(200, "text/plain", body)])
    snapshot = finra.short_volume_all(date="20260903")
    assert snapshot["count"] == 2
    assert snapshot["data"]["A"] == {"short": 431541.387127, "short_exempt": 5022,
                                     "total": 914877.441540, "ratio": 0.4717}
    assert snapshot["data"]["AAA"]["total"] == 2131.349961


@pytest.mark.parametrize("volume", ["NaN", "inf", "-1", "1_000", "１", "1e5", "9" * 400])
def test_finra_invalid_numeric_volume_is_not_silently_skipped(monkeypatch, volume):
    body = HEADER + f"\n20260904|AAPL|{volume}|0|100|Q\n1\n"
    install_http(monkeypatch, [(200, "text/plain", body)])
    with pytest.raises(RuntimeError, match="无法确认"):
        finra.short_volume_all(date="20260904")


def test_finra_absent_symbol_does_not_invent_reason(monkeypatch):
    body = HEADER + "\n20260904|MSFT|20|2|100|Q\n1\n"
    install_http(monkeypatch, [(200, "text/plain", body)])
    monkeypatch.setattr(finra, "_recent_weekdays", lambda n: ["20260904"])
    rows = finra.short_volume_symbol("AAPL", days=1)
    assert rows == []
    ctx = {"script": "finra", "symbol": "AAPL", "market": "US", "source": "finra", "endpoint": "probe"}
    mapped = mappers_global.finra_short_map(rows, ctx)
    assert mapped["status"] == "partial"
    assert "原因未核实" in mapped["degraded"]
    assert "小票" not in json.dumps(mapped, ensure_ascii=False)


def test_finra_empty_search_with_unread_dates_keeps_uncertainty(monkeypatch):
    body = HEADER + "\n20260904|MSFT|20|2|100|Q\n1\n"
    install_http(monkeypatch, [(200, "text/plain", body), MISSING])
    monkeypatch.setattr(finra, "_recent_weekdays", lambda n: ["20260904", "20260903"])
    with pytest.raises(_http.ResourceUnavailable, match="无法确认"):
        finra.short_volume_symbol("AAPL", days=1)


def test_sec_frames_keeps_alternate_period_fallback(monkeypatch):
    calls = install_http(monkeypatch, [MISSING, (200, "application/json", '{"data":[]}')])
    assert sec.market_frame("Assets", year=2025)["count"] == 0
    assert len(calls) == 2 and calls[0] != calls[1]


def test_sec_all_daily_resources_missing_is_uncertain(monkeypatch):
    install_http(monkeypatch, [MISSING])
    with pytest.raises(RuntimeError) as error:
        sec.daily_filings(date="20260904")
    assert not isinstance(error.value, _http.DataNotAvailable)
