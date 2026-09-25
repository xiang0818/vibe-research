import assert from "node:assert/strict";
import { test } from "node:test";

import { isEntryPath, parsePortArg } from "../src/api.ts";
import "../src/finance/register.ts";

test("--port 0 必须被当成 0 —— 0 是 falsy，最容易被 || 悄悄吃掉", () => {
  assert.equal(parsePortArg(["--port", "0"]), 0, "0 被吃掉了：会绑到 8765 而不是系统分配的端口");
  // 前提校验：这个陷阱真的存在
  assert.equal(Number("0") || 8765, 8765, "前提校验：`Number('0') || 8765` 确实等于 8765");
});

test("--port 正常值 / 缺省 / 非法值", () => {
  assert.equal(parsePortArg(["--port", "8765"]), 8765);
  assert.equal(parsePortArg([]), 8765, "没给就用默认");
  assert.equal(parsePortArg(["--port"]), 8765, "给了 flag 没给值");
  assert.equal(parsePortArg(["--port", "abc"]), 8765, "非数字");
  assert.equal(parsePortArg(["--port", "70000"]), 8765, "超出端口范围");
  assert.equal(parsePortArg(["--port", "-1"]), 8765, "负数（正则已挡）");
});

test("入口判定同时识别源码与常见编译产物", () => {
  for (const p of ["/a/b/api.ts", "/a/b/api.js", "C:\\a\\api.js", "/x/api.mjs", "/x/api.cjs"]) {
    assert.ok(isEntryPath(p), `应当认作入口：${p}`);
  }
  for (const p of ["/a/b/other.js", "/a/b/api.json", "/a/bapi.js", undefined]) {
    assert.ok(!isEntryPath(p), `不该认作入口：${p}`);
  }
});
