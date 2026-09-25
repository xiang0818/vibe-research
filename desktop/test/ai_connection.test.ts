import assert from "node:assert/strict";
import test from "node:test";
import { aiConnectionLabel, subscriptionConfig, testAndSaveAi } from "../src/verticals/finance/lib/aiConnection.ts";

test("接入标签按来源显示，不泄露模型密钥或地址", () => {
  for (const status of ["none", "broken", "unavailable"] as const) assert.equal(aiConnectionLabel({ status, config: null }), "未接入AI，请设置");
  for (const [provider, label] of Object.entries({ "cli-codex": "Codex订阅版", "cli-claude": "Claude订阅", "cli-codebuddy": "WorkBuddy CLI", deepseek: "DeepSeek API", mimo: "MiMo API", "openai-compatible": "自定义 API" })) {
    assert.equal(aiConnectionLabel({ status: "ok", config: { schemaVersion: 2, source: { provider, apiKey: "secret", baseURL: "private", model: "model" }, executionMode: "agent", directSupported: false, directReason: "" } }), `已接入AI：${label}`);
  }
});

test("三个快捷订阅使用现有来源，探针通过前不保存", async () => {
  for (const provider of ["cli-codex", "cli-claude", "cli-codebuddy"]) {
    const cfg = subscriptionConfig(provider);
    let saves = 0;
    await testAndSaveAi(cfg, { read: () => null, probe: async (input) => { assert.deepEqual(input, cfg); assert.equal(saves, 0); return { ok: true, direct_supported: false, direct_reason: "subscription" }; }, save: (input, caps) => { assert.deepEqual(input, cfg); assert.equal(caps.directSupported, false); saves++; } });
    assert.equal(saves, 1);
    assert.equal(cfg.apiKey, "");
  }
  assert.throws(() => subscriptionConfig("unknown"));
});

test("探针失败、取消、配置被另一个页面改动时不保存", async () => {
  const cfg = subscriptionConfig("cli-claude");
  const success = { ok: true as const, direct_supported: false, direct_reason: "" };
  for (const mode of ["failed", "aborted", "changed", "invalid"]) {
    const controller = new AbortController();
    let stored: string | null = null;
    await assert.rejects(testAndSaveAi(cfg, { read: () => stored, probe: async () => {
      if (mode === "failed") throw new Error("failed");
      if (mode === "aborted") controller.abort();
      if (mode === "changed") stored = "another source";
      if (mode === "invalid") return { ...success, ok: false } as unknown as typeof success;
      return success;
    }, save: () => assert.fail("must not save") }, controller.signal));
  }
});

test("无法持久化时不冒充接入成功", async () => {
  await assert.rejects(testAndSaveAi(subscriptionConfig("cli-codex"), { read: () => null, probe: async () => ({ ok: true, direct_supported: false, direct_reason: "" }), save: () => { throw new Error("storage failed"); } }), /storage failed/);
});
