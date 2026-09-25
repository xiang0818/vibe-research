/** Per-turn capability bridge. Credentials and service context stay in the API process. */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restrictPrivateFileAsync } from "./fsutil.ts";
import { z } from "zod";

export interface AssistantTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never, signal: AbortSignal) => unknown | Promise<unknown>;
}
export interface ToolReceipt { name: string; ok: boolean; duration_ms: number }
export async function openAssistantBridge(tools: AssistantTool[], signal: AbortSignal) {
  const token = crypto.randomBytes(32).toString("hex");
  const receipts: ToolReceipt[] = [];
  let calls = 0;
  let active = false;
  const server = http.createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      req.resume(); send(403, { error: "forbidden" }); return;
    }
    if (signal.aborted) { req.resume(); send(410, { error: "turn_finished" }); return; }
    if (req.method === "GET" && req.url === "/tools") {
      send(200, tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema) })));
      return;
    }
    if (req.method !== "POST" || req.url !== "/call" || req.headers["content-type"] !== "application/json") {
      req.resume(); send(400, { error: "invalid_request" }); return;
    }
    const start = Date.now();
    let name = "unknown";
    let acquired = false;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64_000) { send(413, { error: "input_too_large" }); return; }
        chunks.push(chunk);
      }
      const body = z.object({ name: z.string(), arguments: z.unknown() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const tool = tools.find((t) => t.name === body.name);
      if (!tool) throw new Error("unknown_tool");
      name = tool.name;
      const args = tool.schema.parse(body.arguments);
      if (signal.aborted) throw new Error("turn_finished");
      if (active) { send(409, { error: "tool_busy_retry_sequentially" }); return; }
      if (++calls > 30) { send(429, { error: "turn_tool_budget_reached" }); return; }
      active = acquired = true;
      const result = await tool.run(args as never, signal);
      if (signal.aborted) throw new Error("turn_finished");
      const text = JSON.stringify(result);
      if (text.length > 120_000) {
        send(200, { isError: true, content: [{ type: "text", text: "结果过大，请缩小查询范围或减少条数后重试；本次未向模型提供完整结果。" }] });
        receipts.push({ name, ok: false, duration_ms: Date.now() - start });
        return;
      }
      const value = result as { ok?: unknown; status?: unknown; result?: { status?: unknown }; envelope?: { status?: unknown } } | null;
      const failed = value?.ok === false || [value?.status, value?.result?.status, value?.envelope?.status]
        .some((status) => status === "error" || status === "failed");
      receipts.push({ name, ok: !failed, duration_ms: Date.now() - start });
      send(200, { ...(failed ? { isError: true } : {}), content: [{ type: "text", text }] });
    } catch (error) {
      receipts.push({ name, ok: false, duration_ms: Date.now() - start });
      // Never return raw exceptions: they can contain provider keys or local paths.
      const detail = error instanceof z.ZodError
        ? " 参数字段：" + error.issues.map(i => i.path.filter(p => typeof p === "number" || /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(String(p))).join(".") + " (" + i.code + ")").join("; ").slice(0, 400)
        : "";
      send(200, { isError: true, content: [{ type: "text", text: "工具执行失败或参数不合法，请核对输入后重试；不得将失败当作没有数据。" + detail }] });
    } finally { if (acquired) active = false; }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bridge_unavailable");
  // CLI 把 MCP env 配置序列化到 argv；这里只传私有文件路径，不传 bearer 值。
  let tokenDir: string | undefined;
  let tokenFile: string;
  try {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-bridge-"));
    tokenFile = path.join(tokenDir, "token");
    // 先收紧空文件权限，再写令牌（Windows 也不能先写后收紧）。
    fs.writeFileSync(tokenFile, "", { flag: "wx", mode: 0o600 });
    await restrictPrivateFileAsync(tokenFile);
    fs.writeFileSync(tokenFile, token, { flag: "r+" });
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (tokenDir) fs.rmSync(tokenDir, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `http://127.0.0.1:${address.port}`, token, tokenFile, receipts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tokenDir!, { recursive: true, force: true });
    },
  };
}
