import assert from "node:assert/strict";
import test from "node:test";

import { judge, scrubWith, type TurnSummary } from "../src/finance/provider_matrix.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const T = (p: Partial<TurnSummary> = {}): TurnSummary => ({ text: "", commands: [], items: 0, reasoning: 0, failed: null, error: null, max_inflight_commands: 0, completed: true, ...p });
const cmd = (output: string, exit_code: number | null = 0) => ({ command: "x", exit_code, output });
const W = { wire: "chat" } as const;

test("matrix judge ①②:约定 token / 命令输出命中;error/failed 一律 error", () => {
  assert.equal(judge(1, T({ text: "vra-ok-7731" }), W).verdict, "pass");
  assert.equal(judge(1, T({ text: "nope" }), W).verdict, "fail");
  assert.equal(judge(2, T({ commands: [cmd("hello-tool-4412\n")] }), W).verdict, "pass");
  assert.equal(judge(2, T({ commands: [cmd("other")] }), W).verdict, "fail");
  assert.equal(judge(1, T({ text: "vra-ok-7731", failed: "boom" }), W).verdict, "error");
});

test("matrix judge ③:三条输出须出自不同命令项且按序;合并成一条 → partial;缺失 → partial/fail", () => {
  assert.equal(judge(3, T({ commands: [cmd("step-A"), cmd("step-B"), cmd("step-C")] }), W).verdict, "pass");
  assert.equal(judge(3, T({ commands: [cmd("step-A\nstep-B\nstep-C")] }), W).verdict, "partial", "一条命令合并输出不算连续三轮");
  assert.equal(judge(3, T({ commands: [cmd("step-C"), cmd("step-B"), cmd("step-A")] }), W).verdict, "partial", "乱序");
  assert.equal(judge(3, T({ commands: [cmd("a"), cmd("b"), cmd("c")] }), W).verdict, "fail");
  assert.equal(judge(3, T({ commands: [cmd("step-A"), cmd("step-B", 1), cmd("step-C")] }), W).verdict, "partial", "失败命令不计");
});

test("matrix judge ④:两条都执行且观察到同时在途 → pass;串行 → partial;缺一 → fail", () => {
  const both = [cmd("par-1"), cmd("par-2")];
  assert.equal(judge(4, T({ commands: both, max_inflight_commands: 2 }), W).verdict, "pass");
  assert.equal(judge(4, T({ commands: both, max_inflight_commands: 1 }), W).verdict, "partial");
  assert.equal(judge(4, T({ commands: [cmd("par-1")], max_inflight_commands: 2 }), W).verdict, "fail");
});

test("matrix judge ⑤:失败 → 修复命令 → 最终回复提到 recovered 三者齐全才 pass", () => {
  const ok = T({ commands: [cmd("No such file", 1), cmd("recovered")], text: "recovered 已成功打印" });
  assert.equal(judge(5, ok, W).verdict, "pass");
  assert.equal(judge(5, T({ commands: [cmd("No such file", 1), cmd("recovered")], text: "done" }), W).verdict, "partial", "回复未说明");
  assert.equal(judge(5, T({ commands: [cmd("recovered")], text: "recovered" }), W).verdict, "fail", "没有失败命令");
  assert.equal(judge(5, T({ commands: [cmd("x", 1)], text: "recovered" }), W).verdict, "partial", "没有修复命令");
});

test("matrix judge ⑥:1..200 一个不缺且 turn.completed → pass;缺号 / 未收尾 → partial", () => {
  const full = Array.from({ length: 200 }, (_, i) => `${i + 1}. line`).join("\n");
  assert.equal(judge(6, T({ text: full }), W).verdict, "pass");
  assert.equal(judge(6, T({ text: full, completed: false }), W).verdict, "partial");
  const gap = full.replace("\n150. line", "");
  const r = judge(6, T({ text: gap }), W); assert.equal(r.verdict, "partial"); assert.match(r.detail, /缺 1 个.*150/);
  assert.equal(judge(6, T({ text: Array.from({ length: 160 }, (_, i) => `${i + 1}. line`).join("\n") }), W).verdict, "partial", "160 行不再算 pass");
});

test("matrix judge ⑦⑧⑨⑩:reasoning 项 / schema 字段 / 约定词复述 / 协议差异", () => {
  assert.equal(judge(7, T({ reasoning: 1 }), W).verdict, "pass"); assert.equal(judge(7, T(), W).verdict, "partial");
  assert.equal(judge(8, T({ text: '{"answer":"vra","n":42}' }), W).verdict, "pass");
  assert.equal(judge(8, T({ text: '{"answer":"vra","n":"42"}' }), W).verdict, "partial");
  assert.equal(judge(8, T({ text: "not json" }), W).verdict, "fail");
  assert.equal(judge(9, T({ text: "cobalt-lantern-5519" }), { ...W, token: "cobalt-lantern-5519" }).verdict, "pass");
  assert.equal(judge(10, T({ text: "cobalt-lantern-5519" }), { wire: "chat", token: "cobalt-lantern-5519" }).verdict, "pass");
  assert.equal(judge(10, T({ text: "x" }), { wire: "chat", token: "cobalt-lantern-5519" }).verdict, "fail");
  assert.equal(judge(10, T({ text: "x" }), { wire: "responses", token: "cobalt-lantern-5519" }).verdict, "n/a");
});

test("matrix scrubWith:已知密钥值精确抹掉 + 通用 Bearer / query token / 签名 URL 脱敏", () => {
  const key = "sk-live-ABCDEF0123456789";
  const msg = `401 from https://api.example.com/v1/chat?api_key=${key}&sig=zzz  Authorization: Bearer ${key}  raw ${key} tail`;
  const out = scrubWith([key], msg);
  assert.ok(!out.includes(key), out);
  assert.ok(out.includes("***"));
  assert.ok(!/sig=zzz/.test(out), "带签名 URL 的 query 被抹掉");
  assert.equal(scrubWith(["short"], "short is gone"), "*** is gone", "短值也抹(已知密钥不论长短)");
  assert.equal(scrubWith([""], "empty keeps"), "empty keeps");
});
