import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";

test("全球指数复用行情端点，缺卡不静默消失，时间来自证据", async () => {
  const original = backend.fetch;
  const calls: unknown[] = [];
  backend.fetch = async (endpoint, opts) => {
    calls.push({ endpoint, opts });
    return { envelope: { status: "partial", fetched_at: "2026-09-06T12:00:00Z", extra: { degraded: "部分报价未覆盖" }, evidence: [
      { record_key: "usDJI", field: "price", value: 100, id: "ev-price", fetched_at: "2026-09-04T20:00:00Z" },
      { record_key: "usDJI", field: "change_pct", value: 0 },
      { record_key: "sh000001", field: "price", value: 999 },
    ] } } as FetchResult;
  };
  try {
    const rows = await api.globalIndices(true);
    assert.deepEqual(calls, [{ endpoint: "tx_quotes_batch", opts: { args: { codes: ["usDJI", "usIXIC", "hkHSI", "hkHSTECH"] }, refresh: true } }]);
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.key, "usDJI");
    assert.equal(rows[0]!.price, 100);
    assert.equal(rows[0]!.change_pct, 0);
    assert.equal(rows[0]!.fetched_at, "2026-09-04T20:00:00Z");
    assert.equal(rows[0]!.evidence_id, "ev-price");
    assert.match(rows[0]!.note ?? "", /未覆盖/);
    assert.equal(rows[1]!.price, null);
    assert.equal(rows[1]!.change_pct, null);
    assert.equal(rows[1]!.fetched_at, null);
    assert.match(rows[1]!.note ?? "", /未取得/);
    const domestic = await api.indices();
    assert.equal(domestic.length, 1);
    assert.equal(domestic[0]!.price, 999);
  } finally { backend.fetch = original; }
});

test("全球指数全空或全为无效点位时明确失败，不生成零值行情", async () => {
  const original = backend.fetch;
  try {
    for (const value of [null, 0, -1, Number.NaN]) {
      backend.fetch = async () => ({ envelope: { evidence: [
        { record_key: "usDJI", field: "price", value },
      ] } }) as FetchResult;
      await assert.rejects(api.globalIndices(), /未取得可用数据/);
    }
  } finally { backend.fetch = original; }
});
