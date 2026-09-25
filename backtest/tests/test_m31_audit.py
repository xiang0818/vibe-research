"""Regressions for independently reported M31 edge cases; no live sources."""
from types import SimpleNamespace

import pandas as pd
import pytest

from backtest.cli import _public_error
from backtest import validation
from datasources.health import endpoint_env


def test_health_only_passes_endpoint_credentials(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-private")
    monkeypatch.setenv("CODEX_HOME", "/test/private")
    monkeypatch.setenv("IWENCAI_API_KEY", "test-endpoint")
    assert "OPENAI_API_KEY" not in endpoint_env({})
    assert "CODEX_HOME" not in endpoint_env({})
    assert "IWENCAI_API_KEY" not in endpoint_env({})
    assert endpoint_env({"auth_env": "IWENCAI_API_KEY"})["IWENCAI_API_KEY"] == "test-endpoint"


def test_actionable_error_without_local_path_or_token():
    result = _public_error(ValueError("端点超时 /Users/test/private/file.json token=test-secret"))
    assert "端点超时" in result
    assert "/Users" not in result and "test-secret" not in result


def test_zero_pnl_trade_retains_entry_and_intraday_time(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    pd.DataFrame([
        dict(timestamp="2026-01-02 10:00:00", code="AAPL", side="buy", price=10, qty=2, pnl=0, holding_bars=0),
        dict(timestamp="2026-01-02 11:00:00", code="AAPL", side="sell", price=10, qty=2, pnl=0, holding_bars=4),
    ]).to_csv(artifacts / "trades.csv", index=False)
    trade, = validation._load_trades(tmp_path)
    assert trade.pnl == 0 and trade.entry_price == 10
    assert trade.exit_time - trade.entry_time == pd.Timedelta(hours=1)
    assert trade.holding_bars == 4


def test_permutation_p_value_cannot_be_zero(monkeypatch):
    calls = 0
    def metrics(*args):
        nonlocal calls
        calls += 1
        return {"sharpe": 100 if calls == 1 else 0, "max_dd": 0 if calls == 1 else -1}
    monkeypatch.setattr(validation, "_path_metrics", metrics)
    result = validation.monte_carlo_test([SimpleNamespace(pnl=x) for x in [1, -1, 2]], 100, n_simulations=9)
    assert result["p_value_sharpe"] == pytest.approx(0.1)
    assert result["p_value_max_dd"] == pytest.approx(0.1)
