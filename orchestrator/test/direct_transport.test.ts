import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DirectTransportError, chatCompletion, scrubSecrets } from "../src/engines/direct_transport.ts";
import { directCapabilityOf } from "../src/providers.ts";
import { resolveDirectProvider } from "../src/runtime_provider.ts";

/**
 * **直连传输层**的故障矩阵。
 *
 * 用本地假服务器而不是真实端点:真实 API 造不出"200 却带 error 体""返回半截 JSON""choices 为空"
 * 这些故障,而它们恰恰是兼容网关最常见的毛病 —— 也是最容易被当成"模型没话说"而静默吞掉的那类。
 *
 * 🔴 每条断言都盯着同一件事:**失败必须说得清是什么失败,并且不能把密钥带出来**。
 */

const FAKE_KEY = "sk-test-1234567890abcdefghij";

/** 起一个一次性假端点;返回 baseURL 与关闭函数 */
async function fakeEndpoint(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function ok(body: unknown) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

const baseReq = { apiKey: FAKE_KEY, model: "m", messages: [{ role: "user" as const, content: "hi" }], timeoutMs: 5_000 };

for (const cancel of [false, true]) test(`响应头之后仍可${cancel ? "取消" : "超时"}`, async () => {
  const ac = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  const ep = await fakeEndpoint((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders();
    // 兜底关闭让旧实现失败而不无限挂住。
    timers.push(setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "late" } }] })), 1800));
    if (cancel) timers.push(setTimeout(() => ac.abort(), 50));
  });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL, timeoutMs: 1000, signal: ac.signal }),
      (e: unknown) => e instanceof DirectTransportError && e.code === (cancel ? "cancelled" : "timeout"));
  } finally { timers.forEach(clearTimeout); await ep.close(); }
});

test("本机 HTTP 模型配置通过真实解析后能完成直连请求", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-local-http-"));
  let requested = "";
  const ep = await fakeEndpoint((req, res) => {
    requested = req.url ?? "";
    ok({ choices: [{ message: { role: "assistant", content: "local-ready" }, finish_reason: "stop" }] })(req, res);
  });
  try {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    fs.mkdirSync(path.join(dataRoot, "providers"));
    fs.writeFileSync(path.join(dataRoot, "providers/local-fixture.json"), JSON.stringify({
      id: "local-fixture", name: "Fixture only", wire_api: "responses", base_url: ep.baseURL,
      env_key: "LOCAL_TEST_KEY", auth_modes: ["api_key"], requires_openai_auth: false,
      default_model: "local-model", responses_support: "native",
      direct: { supported: true, base_url: ep.baseURL, structured_output: "prompt" },
    }));
    const config = resolveDirectProvider(repo, dataRoot, {
      provider: "local-fixture", apiKey: FAKE_KEY, model: "local-model",
    });
    const result = await chatCompletion({ ...baseReq, ...config });
    assert.equal(result.message.content, "local-ready");
    assert.equal(requested, "/v1/chat/completions");
  } finally { await ep.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("正常回复:解析出消息、finish_reason 与 usage", async () => {
  const ep = await fakeEndpoint(ok({
    choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { total_tokens: 12 },
  }));
  try {
    const r = await chatCompletion({ ...baseReq, baseURL: ep.baseURL });
    assert.equal(r.message.content, "你好");
    assert.equal(r.finishReason, "stop");
    assert.deepEqual(r.usage, { total_tokens: 12 });
    assert.ok(r.durationMs >= 0);
  } finally { await ep.close(); }
});

test("工具调用:tool_calls 原样带回(id 与 arguments 一个字符都不能丢)", async () => {
  const call = { id: "call_x", type: "function", function: { name: "list_run_files", arguments: '{"a":1}' } };
  const ep = await fakeEndpoint(ok({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] }));
  try {
    const r = await chatCompletion({ ...baseReq, baseURL: ep.baseURL, tools: [{ name: "list_run_files", description: "d", parameters: { type: "object", properties: {} } }] });
    assert.equal(r.finishReason, "tool_calls");
    assert.deepEqual(r.message.tool_calls, [call]);
  } finally { await ep.close(); }
});

test("请求体:声明了工具就必须带 tools 与 tool_choice,没声明就一个都不许出现", async () => {
  let seen: Record<string, unknown> = {};
  const ep = await fakeEndpoint((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  try {
    await chatCompletion({ ...baseReq, baseURL: ep.baseURL, tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] });
    assert.equal((seen.tools as unknown[]).length, 1);
    assert.equal(seen.tool_choice, "auto");
    assert.equal(((seen.tools as { type: string }[])[0]).type, "function", "工具必须包成 {type:'function', function:{...}}");

    await chatCompletion({ ...baseReq, baseURL: ep.baseURL });
    assert.equal(seen.tools, undefined, "没声明工具时不该发 tools");
    assert.equal(seen.tool_choice, undefined, "没声明工具时不该发 tool_choice");

    await chatCompletion({ ...baseReq, baseURL: ep.baseURL, responseFormat: { type: "json_object" } });
    assert.deepEqual(seen.response_format, { type: "json_object" }, "结构化输出约束不能被静默丢掉");
  } finally { await ep.close(); }
});

test("200 却带 error 体:必须报错,不能当成空回复", async () => {
  const ep = await fakeEndpoint(ok({ error: { message: "quota exhausted", type: "insufficient_quota" } }));
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "upstream_error" && /quota exhausted/.test(e.message));
  } finally { await ep.close(); }
});

test("choices 为空:报 empty_choice,不许悄悄返回空字符串", async () => {
  const ep = await fakeEndpoint(ok({ choices: [] }));
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "empty_choice");
  } finally { await ep.close(); }
});

test("返回半截 JSON:报 bad_json 且可重试", async () => {
  const ep = await fakeEndpoint((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"choices":[{'); });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "bad_json" && e.retryable);
  } finally { await ep.close(); }
});

test("HTTP 错误:429 / 5xx 判可重试,4xx 判不可重试(重试 4xx 只是重复烧钱)", async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false], [401, false]] as [number, boolean][]) {
    const ep = await fakeEndpoint((_req, res) => { res.writeHead(status); res.end(JSON.stringify({ error: "nope" })); });
    try {
      await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL }),
        (e: unknown) => e instanceof DirectTransportError && e.code === "http_error" && e.status === status && e.retryable === retryable,
        `${status} 的可重试判定不对`);
    } finally { await ep.close(); }
  }
});

test("超时:报 timeout 而不是卡死,且判可重试", async () => {
  const ep = await fakeEndpoint(() => { /* 故意不回应 */ });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL, timeoutMs: 1_000 }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "timeout" && e.retryable);
  } finally { await ep.close(); }
});

test("外部取消:与超时区分开,且**不**判可重试(用户叫停就是叫停)", async () => {
  const ep = await fakeEndpoint(() => { /* 故意不回应 */ });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: ep.baseURL, timeoutMs: 30_000, signal: ac.signal }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "cancelled" && !e.retryable);
  } finally { await ep.close(); }
});

test("🔴 密钥绝不进错误消息(错误会写进事件流、日志和界面)", async () => {
  // 上游把 Authorization 回显到错误体里 —— 兼容网关真的会这么干
  const ep = await fakeEndpoint((_req, res) => {
    res.writeHead(401);
    res.end(JSON.stringify({ error: `invalid key: ${FAKE_KEY}; header was Bearer ${FAKE_KEY}` }));
  });
  try {
    await chatCompletion({ ...baseReq, baseURL: ep.baseURL });
    assert.fail("应当抛错");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes(FAKE_KEY), `密钥泄漏进了错误消息:${msg}`);
    assert.match(msg, /\*\*\*/, "应当留下被抹掉的痕迹,而不是整段删掉(否则看不出这里原本有东西)");
  } finally { await ep.close(); }
});

test("scrubSecrets:已知值与通用形态都要抹(只抹一种都会漏)", () => {
  assert.ok(!scrubSecrets(`key=${FAKE_KEY}`, FAKE_KEY).includes(FAKE_KEY));
  // 不长成 sk- 的密钥,靠"已知值"这条抹掉
  assert.equal(scrubSecrets("token=abcdefghijklmnop", "abcdefghijklmnop"), "token=***");
  // 不知道具体值时,靠形态抹掉
  assert.ok(!scrubSecrets("leak sk-abcdefghijklmnopqrstuvwx here").includes("abcdefghijklmnopqrstuvwx"));
  assert.equal(scrubSecrets("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer ***");
});

// ───────────── provider 的直连能力声明 ─────────────

const baseProfile = {
  id: "x", name: "X", wire_api: "responses" as const, base_url: "https://api.example.com/v1",
  env_key: "X_API_KEY", auth_modes: ["api_key" as const], requires_openai_auth: false,
  default_model: "x-1", responses_support: "native" as const,
};

test("没有 direct 段 = **没测过**,而不是「已验证的保守选择」", () => {
  const cap = directCapabilityOf({ ...baseProfile, structured_output: "json_schema" });
  assert.equal(cap.supported, false);
  assert.equal(cap.unverified, true, "必须标成未验证 —— 否则界面会把'我们不知道'显示成'产品的结论'");
  assert.equal(cap.structuredOutput, "prompt", "没测过就按最保守的走");
  assert.match(cap.reason, /还没实测过/);
});

test("模板声明不支持:同样走 prompt,但**不是** unverified(两者外观一样、含义不同)", () => {
  const cap = directCapabilityOf({ ...baseProfile, direct: { supported: false, structured_output: "prompt", verified_at: "2026-09-04" } });
  assert.equal(cap.supported, false);
  assert.equal(cap.unverified, false, "实测过就是实测过,不能和'没测过'混为一谈");
  assert.match(cap.reason, /2026-09-04/);
});

test("🔴 直连能力不得退回去读顶层 structured_output(那是 Responses 端点的口径)", () => {
  // 这正是 MiMo 的真实情况:Responses 只能 prompt,Chat Completions 支持 server_schema
  const cap = directCapabilityOf({
    ...baseProfile,
    structured_output: "prompt",                                   // ← Responses 的口径
    direct: { supported: true, structured_output: "server_schema", verified_at: "2026-09-04" },
  });
  assert.equal(cap.structuredOutput, "server_schema",
    "读成了顶层那个字段 —— 直连会白白降级成提示词模式,而这家其实支持服务端 schema");
  assert.equal(cap.supported, true);
  assert.equal(cap.unverified, false);
});

test("真实的 mimo 模板能被正确解读(实测结论要真的生效,不能只躺在 JSON 里)", () => {
  const raw = JSON.parse(fs.readFileSync(
    path.join(fileURLToPath(new URL("../../providers/mimo.json", import.meta.url))), "utf8"));
  const cap = directCapabilityOf(raw);
  assert.equal(cap.supported, true, "mimo 已于 2026-09-04 实测直连可用");
  assert.equal(cap.structuredOutput, "server_schema");
  assert.equal(cap.baseURL, "https://token-plan-cn.xiaomimimo.com/v1");
  assert.equal(cap.model, "mimo-v2.5", "direct.default_model 应当覆盖顶层的默认模型");
  assert.equal(raw.structured_output, "prompt", "顶层仍是 Responses 的口径 —— 两者不同才是这条测试的意义");
});
