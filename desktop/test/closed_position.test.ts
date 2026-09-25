import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/verticals/finance/lib/api.ts";
import { backend } from "../src/verticals/finance/lib/backend.ts";

test("清仓台账保存、刷新、按稳定 id 删除；不同币种不混合汇总", async () => {
  const original = { ledger: backend.ledger, save: backend.ledgerSave, del: backend.ledgerDelete };
  const records: Record<string, unknown>[] = [];
  backend.ledger = async () => ({ records: { position: [], closed_position: records } }) as never;
  backend.ledgerSave = async (kind, record) => {
    assert.equal(kind, "closed_position");
    const saved = { ...record, id: `test-${records.length}`, kind };
    records.push(saved);
    return saved as never;
  };
  backend.ledgerDelete = async (kind, id) => {
    assert.equal(kind, "closed_position");
    records.splice(records.findIndex(r => r.id === id), 1);
    return { removed: true } as never;
  };
  try {
    await api.closePosition("600519", "2026-09-01", 1200, 1, 1000, { name: " 贵州茅台 ", note: " 核对中报后复盘 " });
    const result = await api.closePosition("AAPL", "2026-09-01", 200, 1, 0);
    assert.equal(result.closed.length, 2);
    assert.equal(result.closed[0].pnl, 200);
    assert.equal(result.closed[1].pnl_pct, null);
    assert.deepEqual(result.realized_totals.map(t => [t.currency, t.pnl]), [["CNY", 200], ["USD", 200]]);
    const fresh = await api.portfolio();
    assert.equal(fresh.closed[0].name, "贵州茅台");
    assert.equal(fresh.closed[0].note, "核对中报后复盘");
    assert.equal(fresh.closed[1].note, "");
    assert.equal(fresh.closed[0].id, result.closed[0].id);
    const after = await api.removeClosed(result.closed[0].id);
    assert.deepEqual(after.closed.map(r => r.code), ["AAPL"]);
    records.push({ id: "damaged", symbol: "600519", price: null, shares: 1, cost: 0, closed_at: "2026-09-01" });
    const damaged = await api.portfolio();
    assert.equal(damaged.closed_invalid, 1);
    assert.equal(damaged.closed.length, 1);
    assert.equal(records.length, 2, "损坏记录不能被自动删除");
    await assert.rejects(api.closePosition("AAPL", "2026-09-01", 1, Infinity, 1));
  } finally {
    backend.ledger = original.ledger;
    backend.ledgerSave = original.save;
    backend.ledgerDelete = original.del;
  }
});
