import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { api } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";
import { quoteSnapshotTime } from "../src/verticals/finance/lib/quoteSnapshot.ts";

test("自动取数要求 fresh，时间跟随价格证据，不把缓存收到时间冒充源时间", async () => {
  const original = backend.fetch;
  const seen: unknown[] = [];
  const stamp = "2026-09-04T01:30:00Z";
  backend.fetch = async (endpoint, opts) => {
    seen.push({ endpoint, opts });
    return { cached: true, fetched_at: "2026-09-05T01:30:00Z", envelope: {
      fetched_at: "2026-09-05T01:30:00Z", evidence: [
        { record_key: "sh600519", field: "price", value: 100, period: "2026-09-04", fetched_at: stamp },
      ],
    } } as FetchResult;
  };
  try {
    const quotes = await api.quote("600519", true);
    assert.equal(quotes["600519"]?.price, 100);
    assert.equal(quotes["600519"]?.fetched_at, stamp);
    assert.equal(quoteSnapshotTime(quotes), Date.parse(stamp));
    assert.deepEqual(seen, [{ endpoint: "tx_quotes_batch", opts: { args: { codes: ["600519"] }, refresh: true } }]);
    const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
    assert.match(hook, /api\.quote\(requested, true\)/);
    assert.doesNotMatch(hook, /setUpdatedAt\(Date\.now\(\)\)/);
  } finally { backend.fetch = original; }
});

test("混合市场显示最早快照；空值与缺时间不伪造新时间", () => {
  const old = { price: 10, fetched_at: "2026-09-03T12:00:00Z" };
  const fresh = { price: 20, fetched_at: "2026-09-04T12:00:00Z" };
  assert.equal(quoteSnapshotTime({ old, fresh }), Date.parse(old.fetched_at));
  assert.equal(quoteSnapshotTime({}), null);
  assert.equal(quoteSnapshotTime({ empty: { price: null, fetched_at: fresh.fetched_at } }), null);
  assert.equal(quoteSnapshotTime({ old, unknown: { price: 30 } }), null);
  assert.equal(quoteSnapshotTime({ bad: { price: 30, fetched_at: "bad" } }), null);
});
