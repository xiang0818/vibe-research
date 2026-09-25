import assert from "node:assert/strict";
import test from "node:test";
import { saveChat } from "../src/core/ai/useAiChat.ts";

test("浏览器拒绝写入/删除时显式返回失败，不偷偷删除其他聊天腾空间", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let removals = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem() { throw new Error("quota"); },
    removeItem() { removals++; throw new Error("blocked"); },
  } });
  try {
    assert.equal(saveChat("test", [{ role: "user", content: "test" }, { role: "assistant", content: "answer" }]), false);
    assert.equal(removals, 0);
    assert.equal(saveChat("test", []), false);
    assert.equal(removals, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
