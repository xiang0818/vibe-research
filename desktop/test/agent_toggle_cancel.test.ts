import assert from "node:assert/strict";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { AI_RUNTIME_CHANGED } from "../src/verticals/finance/lib/llmStore.ts";

for (const mode of ["agent", "direct"]) {
  test(`切换模式中止 ${mode === "agent" ? "订阅预检" : "普通聊天请求"}`, async () => {
    const keys = ["localStorage", "addEventListener", "removeEventListener", "fetch"] as const;
    const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    let selected = mode;
    let pendingSignal: AbortSignal | undefined;
    const paths: string[] = [];
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: () => JSON.stringify({ schemaVersion: 2, modePreferenceVersion: 1,
        executionMode: selected, source: { provider: "cli-claude" } }),
    } });
    Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: events.addEventListener.bind(events) });
    Object.defineProperty(globalThis, "removeEventListener", { configurable: true, value: events.removeEventListener.bind(events) });
    globalThis.fetch = (async (input, init) => {
      paths.push(String(input));
      pendingSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        pendingSignal!.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true });
      });
    }) as typeof fetch;
    try {
      const turn = backend.chat("什么是现金流？");
      assert.ok(pendingSignal);
      const rejected = assert.rejects(turn, (error: unknown) => error instanceof Error && error.name === "AbortError");
      selected = mode === "agent" ? "direct" : "agent";
      events.dispatchEvent(new Event(AI_RUNTIME_CHANGED));
      await rejected;
      assert.equal(pendingSignal.aborted, true);
      assert.deepEqual(paths, [mode === "agent" ? "/api/local-agents?provider=cli-claude" : "/api/chat"]);
    } finally {
      keys.forEach((key, index) => {
        if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });
}

test("翻译与引导工具的订阅预检可取消，已取消时不发请求", async () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ schemaVersion: 2, modePreferenceVersion: 1,
      executionMode: "agent", source: { provider: "cli-claude" } }),
  } });
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests++;
    assert.equal(String(input), "/api/local-agents?provider=cli-claude");
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    for (const action of [
      (signal: AbortSignal) => backend.translateHeadlines([{ id: "one", title: "test" }], signal),
      (signal: AbortSignal) => backend.guidedTool("calc", "test", "test", signal),
    ]) {
      const controller = new AbortController();
      const pending = action(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      const before = requests;
      await assert.rejects(action(controller.signal), { name: "AbortError" });
      assert.equal(requests, before);
    }
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
