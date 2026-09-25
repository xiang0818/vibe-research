"""离线测试:注册表结构 / 模块与函数可导入 / mapper 存在 / 通用取数器在假模块上的完整链路 / 代表性 mapper 的证据形状。不访问网络。"""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(SCRIPTS, "..", "..", "..", ".."))
REG_PATH = os.path.join(REPO, "datasources", "registry.json")
sys.path.insert(0, SCRIPTS)

REQUIRED_KEYS = {"id", "title", "layer", "market", "source", "compliance", "module", "function", "symbol_kind", "stages", "enabled"}
STAGES = {"profile", "financials", "estimates", "valuation", "risk", "report"}


def load_reg() -> dict:
    with open(REG_PATH, encoding="utf-8") as f:
        return json.load(f)


def test_registry_shape_and_uniqueness():
    reg = load_reg()
    ids = [e["id"] for e in reg["endpoints"]]
    assert len(ids) == len(set(ids)), "端点 id 重复"
    for e in reg["endpoints"]:
        missing = REQUIRED_KEYS - set(e)
        assert not missing, f"{e.get('id')} 缺字段 {missing}"
        assert e["symbol_kind"] in ("cn6", "us", "hk", "global", "raw", "none"), e["id"]
        assert set(e["stages"]) <= STAGES, e["id"]
        assert all(v in ("required", "optional") for v in e["stages"].values()), e["id"]
        assert isinstance(e["market"], list) and e["market"], e["id"]
        if e["module"] != "legacy":
            assert e.get("mapper"), f"{e['id']} 非 legacy 端点必须有 mapper"


def test_all_modules_functions_and_mappers_importable():
    reg = load_reg()
    for e in reg["endpoints"]:
        if e["module"] == "legacy":
            assert os.path.exists(os.path.join(SCRIPTS, e["function"])), e["id"]
            continue
        mod = importlib.import_module(f"sources.{e['module']}")
        assert callable(getattr(mod, e["function"], None)), f"{e['id']}: sources.{e['module']}.{e['function']} 不存在"
        mm = importlib.import_module(f"sources.{e.get('mapper_module', 'mappers')}")
        assert callable(getattr(mm, e["mapper"], None)), f"{e['id']}: mapper {e['mapper']} 不存在"


def test_legacy_stage_plan_matches_phase0():
    """legacy 8 脚本的阶段计划必须与 Phase 0 的 STAGE_SCRIPTS 一致(TS 侧从注册表读取,行为不变)。"""
    reg = load_reg()
    plan: dict = {}
    for e in reg["endpoints"]:
        for st, lvl in e["stages"].items():
            if e["module"] == "legacy":
                plan.setdefault(st, {"required": [], "optional": []})[lvl].append(e["id"])
    assert plan["profile"]["required"] == ["fetch_profile", "fetch_quote", "fetch_trade_calendar"]
    assert plan["financials"]["required"] == ["fetch_financials"]
    assert plan["estimates"]["required"] == ["fetch_estimates"]
    assert plan["valuation"]["optional"] == ["fetch_pe_history"]
    assert plan["risk"]["optional"] == ["fetch_announcements", "fetch_kline"]


def _ctx(**kw):
    base = {"script": "t_ep", "symbol": "300308", "market": "SZ", "source": "test", "endpoint": "ep", "raw_ref": "raw/x.json", "raws": [], "as_of": None, "args": {}, "ep": {"id": "t_ep"}}
    base.update(kw)
    return base


def test_mappers_basic_shapes():
    from sources import mappers, mappers_cn, mappers_global
    r = mappers.em_holder_num([{"date": "2026-06-30", "holder_num": 100, "change_ratio": 1.5, "avg_shares": 200}], _ctx())
    assert r["evidence"] and all(e["symbol"] == "300308" and e["market"] == "SZ" and "id" in e for e in r["evidence"])
    assert mappers.em_reports([], _ctx())["status"] == "failed"
    q = mappers_global.quote_map({"name": "Apple", "price": 1.5, "pe": 0, "market_cap": 3.2}, _ctx(market="US", symbol="AAPL", ep={"id": "q", "cap_unit": "亿美元"}))
    units = {e["field"]: (e["unit"], e["currency"]) for e in q["evidence"]}
    assert units["price"] == ("美元", "USD") and units["market_cap"] == ("亿美元", "USD") and "pe" not in units
    s = mappers_cn.sina_financial_report_map([{"报告期": "2026-06-30", "营业收入": "1,000.5", "营业收入_同比": "1.82", "净利润": "10"}], _ctx(args={"report_type": "lrb"}))
    f = {e["field"]: e for e in s["evidence"]}
    assert f["revenue"]["value"] == 1000.5 and f["revenue_yoy"]["unit"] == "小数" and f["net_profit"]["value"] == 10.0
    m = mappers.em_fund_flow_minute([{"time": "2026-08-21 09:31", "main_net": 1.0, "super_net": 0.5, "large_net": 0.5}, {"time": "2026-08-21 15:00", "main_net": 9.0, "super_net": 4.0, "large_net": 5.0}], _ctx())
    cum = [e for e in m["evidence"] if e["field"] == "main_net_inflow_intraday_cum"][0]
    assert cum["value"] == 9.0 and cum["period"] == "2026-08-21"


def test_tencent_batch_quotes_keep_each_markets_currency_unit():
    """一个批量信封可同时含三市场，金额单位必须逐行跟着市场走，不能全写成人民币「元」。"""
    from sources import mappers_cn
    result = {
        "600519": {"name": "贵州茅台", "query": "sh600519", "price": 100, "amount_wan": 12, "mcap_yi": 3},
        "usAAPL": {"name": "苹果", "query": "usAAPL", "price": 200, "amount_wan": 34, "mcap_yi": 5},
        "hk00700": {"name": "腾讯控股", "query": "hk00700", "price": 300, "amount_wan": 56, "mcap_yi": 7},
    }
    got = mappers_cn.tencent_quotes_map(result, _ctx(market="CN", symbol="MARKET"))
    by = {(e["record_key"], e["field"]): (e["market"], e["unit"], e["currency"]) for e in got["evidence"]}
    assert by[("600519", "price")] == ("CN", "元", "CNY")
    assert by[("600519", "turnover_amount")] == ("CN", "万元", "CNY")
    assert by[("usAAPL", "price")] == ("US", "美元", "USD")
    assert by[("usAAPL", "turnover_amount")] == ("US", "美元", "USD")
    assert by[("usAAPL", "market_cap")] == ("US", "亿美元", "USD")
    assert by[("hk00700", "price")] == ("HK", "港元", "HKD")
    assert by[("hk00700", "turnover_amount")] == ("HK", "港元", "HKD")
    assert by[("hk00700", "market_cap")] == ("HK", "亿港元", "HKD")


def test_fetch_endpoint_generic_chain_with_fake_module(tmp_path):
    """假源包(临时目录 + PYTHONPATH,注册表 module 用带点绝对名)→ fetch_endpoint 产出契约信封(evidence / raw_files / 退出码);ep.args 默认参数合并、None 占位丢弃、--args 覆盖。不触碰真实 sources 包。"""
    pkg = tmp_path / "vra_fake_pkg"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "src.py").write_text("from sources._http import record_raw\n"
                                "def fetch(code, n=1, tag=None):\n    record_raw(b'{\"x\":1}', 'json', 'fake://x')\n    return {'code': code, 'n': n, 'tag': tag}\n")
    (pkg / "map.py").write_text("from sources.mappers import ev, out\n"
                                "def m(result, ctx):\n    return out([ev(ctx, 'fake_n', result['n'], '个', '2026-01-01', currency='n/a', note=str(result['tag']))])\n")
    reg = {"version": "t", "endpoints": [{"id": "fake_ep", "title": "t", "layer": "t", "market": ["CN"], "source": "fake", "compliance": "t", "module": "vra_fake_pkg.src", "function": "fetch", "symbol_kind": "cn6", "stages": {},
                                           "enabled": True, "mapper": "m", "mapper_module": "vra_fake_pkg.map", "args": {"n": 7, "tag": None}}]}
    rp = tmp_path / "registry.json"
    rp.write_text(json.dumps(reg))
    out_dir = tmp_path / "run"
    (out_dir / "fetch").mkdir(parents=True)
    (out_dir / "raw").mkdir()
    env = dict(os.environ, PYTHONPATH=str(tmp_path) + os.pathsep + SCRIPTS)
    p = subprocess.run([sys.executable, os.path.join(SCRIPTS, "fetch_endpoint.py"), "--endpoint", "fake_ep", "--symbol", "sz300308", "--registry", str(rp), "--out-dir", str(out_dir)], capture_output=True, text=True, env=env)
    d = json.loads(p.stdout)
    assert p.returncode == 0 and d["status"] == "ok", (p.returncode, d.get("errors"), p.stderr[-400:])
    assert d["symbol"] == "300308" and d["market"] == "SZ"
    assert d["evidence"][0]["value"] == 7 and d["evidence"][0]["note"] == "None"
    assert d["evidence"][0]["raw_ref"] and d["extra"]["raw_files"] == [d["evidence"][0]["raw_ref"]]
    assert os.path.exists(os.path.join(out_dir, d["extra"]["raw_files"][0]))
    assert d["extra"]["raw_binding"] == "single"
    assert os.path.exists(out_dir / "fetch" / "fake_ep.json")
    p2 = subprocess.run([sys.executable, os.path.join(SCRIPTS, "fetch_endpoint.py"), "--endpoint", "fake_ep", "--symbol", "300308", "--registry", str(rp), "--out-dir", str(out_dir), "--args", '{"n": 3, "tag": "t"}'], capture_output=True, text=True, env=env)
    d2 = json.loads(p2.stdout)
    assert d2["evidence"][0]["value"] == 3 and d2["evidence"][0]["note"] == "t"


def test_fetch_endpoint_guards(tmp_path):
    out_dir = tmp_path / "run"
    (out_dir / "fetch").mkdir(parents=True)
    p = subprocess.run([sys.executable, os.path.join(SCRIPTS, "fetch_endpoint.py"), "--endpoint", "no_such_ep", "--out-dir", str(out_dir)], capture_output=True, text=True)
    d = json.loads(p.stdout)
    assert p.returncode == 3 and d["status"] == "failed" and "注册表无端点" in d["errors"][0]["error"]
    env = {k: v for k, v in os.environ.items() if k != "VRA_SEC_CONTACT"}
    p = subprocess.run([sys.executable, os.path.join(SCRIPTS, "fetch_endpoint.py"), "--endpoint", "sec_filings", "--symbol", "AAPL", "--out-dir", str(out_dir)], capture_output=True, text=True, env=env)
    d = json.loads(p.stdout)
    assert p.returncode == 3 and "VRA_SEC_CONTACT" in d["errors"][0]["error"]


def test_registry_args_match_function_signatures():
    """每个非 legacy 端点:函数必需参数必须能由 symbol_param(symbol_kind≠none)+ args 默认值(非 None)+ pass_market/pass_timeout 满足;args 的键必须是函数形参(或函数接受 **kwargs)。"""
    import inspect
    reg = load_reg()
    problems = []
    for e in reg["endpoints"]:
        if e["module"] == "legacy":
            continue
        fn = getattr(importlib.import_module(f"sources.{e['module']}"), e["function"])
        params = inspect.signature(fn).parameters
        accepts_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
        provided = set(k for k, v in (e.get("args") or {}).items() if v is not None)
        if e.get("symbol_kind", "cn6") != "none":
            provided.add(e.get("symbol_param", "code"))
        if e.get("pass_market"):
            provided.add("market")
        if e.get("pass_timeout"):
            provided.add("timeout")
        for name, p in params.items():
            if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
                continue
            if p.default is inspect.Parameter.empty and name not in provided:
                problems.append(f"{e['id']}: 必需参数 {name} 无来源(symbol_param/args/pass_*)")
        for k in set(provided) | set(e.get("args") or {}):
            if k not in params and not accepts_kw:
                problems.append(f"{e['id']}: 参数 {k} 不是 {e['function']} 的形参")
    assert not problems, "\n".join(problems)


def test_mapper_declared_units_are_consistent():
    """金额单位与币种联动:unit 带币种字样时 currency 对应;比率 / 计数类 currency 必须为 n/a;Yahoo 财报按 financialCurrency 计价。"""
    from sources import mappers_global
    q = mappers_global.quote_map({"name": "T", "price": 1.0, "pe": 12.0, "change_pct": 1.1, "volume": 3}, _ctx(market="HK", symbol="00700", ep={"id": "q"}))
    for e in q["evidence"]:
        if e["unit"] == "港元":
            assert e["currency"] == "HKD", e
        if e["unit"] in ("%", "倍", "股"):
            assert e["currency"] == "n/a", e
    y = mappers_global.yahoo_financials_map({"income": [{"endDate": 1735603200, "totalRevenue": 100}], "balance": [], "cashflow": [], "financial_currency": "CNY"}, _ctx(market="HK", symbol="00700", ep={"id": "y"}))
    assert y["evidence"][0]["unit"] == "人民币" and y["evidence"][0]["currency"] == "CNY"
