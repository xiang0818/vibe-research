import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const api = readFileSync(new URL("../src/verticals/finance/lib/api.ts", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src/verticals/finance/lib/backend.ts", import.meta.url), "utf8");
const dailyReview = readFileSync(new URL("../src/verticals/finance/pages/DailyReview.tsx", import.meta.url), "utf8");
const stockData = readFileSync(new URL("../src/verticals/finance/pages/StockData.tsx", import.meta.url), "utf8");
const website = readFileSync(new URL("../../website/index.html", import.meta.url), "utf8");

test("取数映射不再用 num0 把缺失字段伪装成数字零", () => {
  assert.doesNotMatch(api, /\bnum0\b|\bn0\s*\(/);
  assert.doesNotMatch(backend, /export const num0/);
});

test("官网 Star 在 API 不可用时显示未知，不保留会过期的硬编码数字", () => {
  assert.match(website, /data-stars[^>]*>—<\/strong>/);
  assert.doesNotMatch(website, /data-stars[^>]*>2\.1k<\/strong>/);
});

test("页面不把缺失值伪装成零或不完整的二十日合计", () => {
  assert.doesNotMatch(dailyReview, /change_pct\s*\?\?\s*0/);
  assert.match(stockData, /fundFlow\.slice\(0, 20\)/);
  assert.doesNotMatch(stockData, /fundFlow\.slice\(-20\)/);
  assert.match(stockData, /window\.length === 20 && known\.length === 20/);
  assert.match(stockData, /未合计/);
});
