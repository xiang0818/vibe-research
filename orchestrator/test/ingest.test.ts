import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts"; // 测试文件也是入口:插件要先注册
import { IngestError, MAX_FILES, ingestFiles } from "../src/ingest.ts";
import { listRecords, upsertRecord } from "../src/ledger.ts";
import { readIngestFile, type IngestReadContext } from "../src/ingest_tools.ts";

// ⚠️ fileURLToPath 而不是 new URL(...).pathname —— 仓库路径含中文时 pathname 是百分号编码的
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Cap {
  config?: Record<string, unknown>;
  names?: string[];
  image?: { data: string; mimeType: string };
  opts?: Record<string, unknown>;
  inputs?: unknown;
  schema?: unknown;
}

/** 假 Codex:记录 startThread 选项与本轮输入,回放预设 JSON */
function fakeCodex(reply: string, cap?: Cap, read = true) {
  return (config: unknown) => {
    if (cap) cap.config = config as Record<string, unknown>;
    return (
    ({
      startThread(opts: Record<string, unknown>) {
        if (cap) cap.opts = opts;
        return {
          id: "t-fake",
          runStreamed(input: unknown, turnOpts?: { outputSchema?: unknown }) {
            if (cap) {
              cap.inputs = input;
              cap.schema = turnOpts?.outputSchema;
            }
            return Promise.resolve({
              events: (async function* () {
                if (read) {
                  const dir = String(opts.workingDirectory);
                  const names = fs.readdirSync(dir).filter(name => !name.startsWith("."));
                  if (cap) cap.names = names;
                  const ctx: IngestReadContext = { dir, files: names.map(name => ({ name,
                    kind: name.endsWith(".png") ? "image" : "text",
                    ...(name.endsWith(".png") ? { mimeType: "image/png" } : {}),
                    sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"),
                  })) };
                  for (const file of ctx.files) {
                    let offset = 0;
                    for (;;) {
                      const result = readIngestFile(ctx, { name: file.name, offset });
                      const chunk = JSON.parse(result.content[0]!.text!);
                      const image = result.content.find(block => block.type === "image");
                      if (cap && image) cap.image = { data: image.data, mimeType: image.mimeType };
                      if (!chunk.has_more) break;
                      offset = chunk.end;
                    }
                  }
                }
                yield { type: "item.completed", item: { type: "agent_message", text: reply } };
              })(),
            });
          },
        };
      },
    }) as never);
  };
}

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-ingest-"));
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64"); // PNG 魔数,够当"一张图"
const OK_REPLY = JSON.stringify({
  drafts: [
    { source_file: "01_a.csv", fields: { symbol: "300308", shares: 100, cost: 846 }, uncertain: ["cost:截图模糊"] },
  ],
  warnings: ["第二张图看不清"],
});

for (const agent of ["claude", "codebuddy"] as const) {
  test(`${agent} 转写只经上传白名单 MCP，保持出处且不自动写台账`, async (t) => {
    const root = tmp();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const out = await ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: `cli-${agent}` },
      localAgentRunner: async (actual, opts) => {
        assert.equal(actual, agent);
        if (agent === "codebuddy") {
          assert.equal(opts.outputSchema, undefined, "WorkBuddy 工具轮不同时启用 CLI schema 模式");
          assert.match(opts.userPrompt, /JSON Schema/);
          assert.match(opts.userPrompt, /source_file/);
        } else assert.ok(opts.outputSchema);
        assert.deepEqual(opts.controlledMcp?.allowedTools, ["mcp__vra_ingest__read_ingest_file"]);
        const env = opts.controlledMcp!.env;
        const ctx: IngestReadContext = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) };
        const result = readIngestFile(ctx, { name: "01_a.csv" });
        assert.match((result.content[0] as { text: string }).text, /300308/);
        return OK_REPLY;
      },
    }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("代码,数量\n300308,100") }] },
    () => { throw new Error("不得暗中切换 Codex"); });
    assert.equal(out.drafts[0]!.source_file, "a.csv");
    assert.deepEqual(listRecords(root, "position"), []);
  });
}

test("本机 Agent 未读取全部资料时不能返回看似完整的草稿，失败清理原件", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-claude" },
    localAgentRunner: async () => OK_REPLY,
  }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }), /完整读取/);
  assert.deepEqual(fs.readdirSync(path.join(root, "import")), []);
});

test("WorkBuddy 图片走原生附件，混合文本仍须读完白名单工具", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const mixed of [false, true]) {
    const out = await ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-codebuddy" },
      localAgentRunner: async (agent, opts) => {
        assert.equal(agent, "codebuddy");
        assert.equal(opts.userImages?.[0]?.data, PNG);
        assert.equal(opts.userImages?.[0]?.name, "01_表格.png");
        assert.match(opts.systemPrompt, /原生附件/);
        if (mixed) {
          const env = opts.controlledMcp!.env;
          const ctx = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) } as IngestReadContext;
          assert.equal(ctx.files.length, 1);
          assert.equal(ctx.files[0]?.kind, "text");
          readIngestFile(ctx, { name: ctx.files[0]!.name });
        } else assert.equal(opts.controlledMcp, undefined, "纯图片不启动 MCP 或开放工具");
        return JSON.stringify({ drafts: [{ source_file: "01_表格.png", fields: { symbol: "600519", shares: 300, cost: 123.45 }, uncertain: [] }], warnings: [] });
      },
    }, { kind: "position", files: [{ name: "表格.png", content_base64: PNG }, ...(mixed ? [{ name: "notes.txt", content_base64: b64("说明") }] : [])] });
    assert.equal(out.drafts[0]?.source_file, "表格.png");
    assert.deepEqual(listRecords(root, "position"), []);
  }
});

test("本机 Agent 首轮漏读资料时只补跑一次同源受控读取，再校验草稿", async (t) => {
  const dataRoot = tmp();
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  let calls = 0;
  const result = await ingestFiles({ repoRoot: REPO, dataRoot, llm: { provider: "cli-codebuddy" },
    localAgentRunner: async (agent, opts) => {
      assert.equal(agent, "codebuddy");
      calls++;
      if (calls === 2) {
        assert.match(opts.userPrompt, /尚未完整读取/);
        const ctx = { dir: opts.controlledMcp!.env.VRA_INGEST_DIR,
          files: JSON.parse(opts.controlledMcp!.env.VRA_INGEST_FILES) } as IngestReadContext;
        for (const file of ctx.files) readIngestFile(ctx, { name: file.name });
      }
      return JSON.stringify({ drafts: [], summary: "空测试表", warnings: [] });
    },
  }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("symbol,shares,cost") }] });
  assert.equal(calls, 2);
  assert.equal(result.drafts.length, 0);
});

test("两次新调用不能各读一半资料后拼成完整回执", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(() => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-codebuddy" },
    localAgentRunner: async (_agent, opts) => {
      const env = opts.controlledMcp!.env;
      const ctx = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) } as IngestReadContext;
      readIngestFile(ctx, { name: ctx.files[calls++]!.name });
      return JSON.stringify({ drafts: [], warnings: [] });
    },
  }, { kind: "position", files: ["a.txt", "b.txt"].map(name => ({ name, content_base64: b64("text") })) }), /完整读取/);
  assert.equal(calls, 2);
});

for (const damage of ["original", "receipt"]) test(`资料完整性损坏立即失败不重试：${damage}`, async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(() => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-codebuddy" },
    localAgentRunner: async (_agent, opts) => {
      calls++;
      const env = opts.controlledMcp!.env;
      const files = JSON.parse(env.VRA_INGEST_FILES!);
      // Leave the first file unread; damage in the later file must win over retry.
      fs.writeFileSync(path.join(env.VRA_INGEST_DIR!, damage === "original" ? files[1].name : ".read-receipts.json"), "corrupt");
      return JSON.stringify({ drafts: [], warnings: [] });
    },
  }, { kind: "position", files: ["a.txt", "b.txt"].map(name => ({ name, content_base64: b64("text") })) }));
  assert.equal(calls, 1);
});

test("转写线程与对话同样的硬约束:只读沙箱 / 不联网 / 不联网搜索", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("代码,数量\n300308,100") }] },
    fakeCodex(OK_REPLY, cap),
  );
  const o = cap.opts!;
  // 🔴 转写要是能写文件 / 能联网,它就能"自己去补数据" —— 那正是取数纪律要挡的
  assert.equal(o.sandboxMode, "read-only");
  assert.equal(o.networkAccessEnabled, false);
  assert.equal(o.webSearchMode, "disabled");
  assert.equal(o.approvalPolicy, "never");
  const config = cap.config!;
  const features = (config.config as { features: Record<string, boolean> }).features;
  for (const key of ["shell_tool", "unified_exec", "view_image", "multi_agent", "multi_agent_v2", "apps", "enable_mcp_apps", "plugins", "tool_suggest", "standalone_web_search", "code_mode"]) assert.equal(features[key], false, key);
  const overrides = JSON.stringify(config.configOverrides);
  assert.match(overrides, /read_ingest_file/);
  assert.doesNotMatch(overrides, /list_run_files|run_calc|write_stage/);
});

test("Codex 不读上传文件不能伪造完成，且转写失败后清理暂存件", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(ingestFiles({ repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }, fakeCodex(OK_REPLY, undefined, false)), /完整读取/);
  assert.deepEqual(fs.readdirSync(path.join(root, "import")), []);
});

for (const scenario of ["cancel", "error"] as const) test(`真实 SDK 转写 ${scenario} 先停止进程树再清理上传批次`, { skip: process.platform === "win32" }, async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "codex-fixture");
  const state = path.join(root, "child.json");
  const lateRead = path.join(root, "late-read");
  const childSource = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(lateRead)},require('fs').readFileSync('01_a.csv')),1500);setInterval(()=>{},100);`;
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);
if(a.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}
if(a.includes('mcp')){console.log('[]');process.exit(0)}
process.on('SIGTERM',()=>{});
const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({pid:c.pid,dir:process.cwd()}));
${scenario === "error" ? "console.log(JSON.stringify({type:'error',message:'fixture failure'}));" : ""}
setInterval(()=>{},100);`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ engine: { codex_path: bin, codex_home: path.join(root, "home") } }));
  const ac = new AbortController();
  const turn = ingestFiles({ repoRoot: REPO, dataRoot: root, signal: ac.signal },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("public-fixture") }] });
  const rejected = assert.rejects(turn, (e: unknown) => e instanceof IngestError && e.code === (scenario === "cancel" ? "cancelled" : "turn_failed"));
  for (let i = 0; i < 500 && !fs.existsSync(state); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(state), "真实 SDK 子进程应已启动");
  const info = JSON.parse(fs.readFileSync(state, "utf8"));
  if (scenario === "cancel") ac.abort(new Error("cancel fixture"));
  await rejected;
  for (let i = 0; i < 100; i++) {
    try { process.kill(info.pid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(info.pid, 0), /ESRCH/);
  assert.equal(fs.existsSync(info.dir), false);
  assert.equal(fs.existsSync(lateRead), false, "延迟文件读取不得发生");
});

test("🔴 只产草稿,绝不写台账 —— 转写认错一个数字,落库后没人分得清是机器填的", async () => {
  const root = tmp();
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
    fakeCodex(OK_REPLY),
  );
  assert.equal(r.drafts.length, 1);
  assert.equal(listRecords(root, "position").length, 0, "台账必须一条都没多");
  // 草稿不带信封字段:id/kind/created_at 只有真正落库时才由 Core 给
  for (const k of ["id", "kind", "created_at", "updated_at"]) {
    assert.ok(!(k in r.drafts[0]!.fields), `草稿不该自带 ${k}`);
  }
});

test("Codex 图片与文本只走上传白名单 MCP，关闭本机图片路径工具", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    {
      kind: "position",
      files: [
        { name: "shot.png", content_base64: PNG },
        { name: "rows.csv", content_base64: b64("a,b") },
      ],
    },
    fakeCodex(OK_REPLY.replace("01_a.csv", "01_shot.png"), cap),
  );
  const inputs = cap.inputs as { type: string; text?: string; path?: string }[];
  assert.ok(Array.isArray(inputs));
  const imgs = inputs.filter((i) => i.type === "local_image");
  assert.equal(imgs.length, 0, "不得授予任意本机图片路径读取能力");
  assert.deepEqual(cap.image, { data: PNG, mimeType: "image/png" });
  assert.equal(fs.existsSync(String(cap.opts!.workingDirectory)), false, "转写结束清理暂存件");
  const text = inputs.find((i) => i.type === "text")!.text!;
  assert.ok(text.includes("rows.csv"), "文本文件名要写进提示词");
  assert.ok(text.includes("01_shot.png"), "关闭 local_image 后仍须向模型列出安全图片文件名");
  assert.ok(cap.schema, "必须强制结构化产出,否则解析全靠运气");
});

test("字段说明来自契约而不是写死 —— 垂类改字段,提示词自动跟着变", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    { kind: "criterion", files: [{ name: "a.txt", content_base64: b64("x") }] },
    fakeCodex(JSON.stringify({ drafts: [], warnings: [] }), cap),
  );
  const text = (cap.inputs as { type: string; text?: string }[]).find((i) => i.type === "text")!.text!;
  // criterion 的枚举字段:提示词里要出现它的取值,否则模型只能瞎填
  assert.ok(text.includes("decision_point") && text.includes("falsifier"), "枚举取值要出现在提示词里");
  assert.ok(text.includes("statement"), "必填字段要点名");
});

test("文件名是不可信输入:路径穿越要被净化,原名只作为出处留在草稿里", async () => {
  const root = tmp();
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "../../../../etc/passwd.txt", content_base64: b64("x") }] },
    fakeCodex(
      JSON.stringify({ drafts: [{ source_file: "01_passwd.txt", fields: {}, uncertain: [] }], warnings: [] }),
      cap,
    ),
  );
  const dir = String(cap.opts!.workingDirectory);
  assert.ok(dir.startsWith(path.resolve(root) + path.sep), "暂存目录必须在数据根内");
  const files = cap.names!;
  assert.equal(files.length, 1);
  assert.ok(!files[0]!.includes(".."), `落盘名不许含 ..:${files[0]}`);
  assert.ok(!fs.existsSync(path.join(root, "..", "passwd.txt")), "不许写到数据根之外");
});

test("类型白名单:pdf / xlsx 明确拒绝,并说清为什么(半成品比不支持更糟)", async () => {
  const root = tmp();
  for (const name of ["a.pdf", "b.xlsx", "c.exe", "d"]) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root },
          { kind: "position", files: [{ name, content_base64: b64("x") }] },
          fakeCodex(OK_REPLY),
        ),
      (e: unknown) => e instanceof IngestError && e.code === "unsupported_type",
      `应拒绝 ${name}`,
    );
  }
});

test("体积与数量上限;空文件与非法种类当场拒绝", async () => {
  const root = tmp();
  const one = { name: "a.txt", content_base64: b64("x") };
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "no_files",
  );
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root },
        { kind: "position", files: Array.from({ length: MAX_FILES + 1 }, () => one) },
        fakeCodex(OK_REPLY),
      ),
    (e: unknown) => e instanceof IngestError && e.code === "too_many_files",
  );
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root },
        { kind: "position", files: [{ name: "a.txt", content_base64: "" }] },
        fakeCodex(OK_REPLY),
      ),
    (e: unknown) => e instanceof IngestError && e.code === "bad_content",
  );
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "nosuch", files: [one] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "unknown_kind",
  );
});

test("产出解析不了就报错,不许'尽力还原' —— 半份草稿会被当成全部", async () => {
  const root = tmp();
  for (const bad of ["不是 JSON", '{"warnings":[]}', '{"drafts":{"not":"array"},"warnings":[]}']) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root },
          { kind: "position", files: [{ name: "a.txt", content_base64: b64("x") }] },
          fakeCodex(bad),
        ),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output:${bad.slice(0, 30)}`,
    );
  }
});

test("草稿里的出处换回用户原来的文件名(他认得的是那个)", async () => {
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp() },
    { kind: "position", files: [{ name: "我的持仓截图.png", content_base64: PNG }] },
    fakeCodex(
      JSON.stringify({ drafts: [{ source_file: "01_我的持仓截图.png", fields: {}, uncertain: [] }], warnings: [] }),
    ),
  );
  assert.equal(r.drafts[0]!.source_file, "我的持仓截图.png");
});

test("🔴 产出解析必须严格:非法结构不许被'修'成草稿(半份草稿会被当成全部)", async () => {
  const root = tmp();
  const cases: [string, string][] = [
    ['{"drafts":[null],"warnings":[]}', "草稿不是对象"],
    ['{"drafts":[{"fields":{}, "uncertain":[]}],"warnings":[]}', "缺 source_file"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":"x","uncertain":[]}],"warnings":[]}', "fields 不是对象"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{},"uncertain":"x"}],"warnings":[]}', "uncertain 不是数组"],
    // 🔴 最要命的一条:模型自己说"这几处没看清",非法结构被抹平后**这条信息整个消失**
    ['{"drafts":[{"source_file":"01_a.csv","fields":{},"uncertain":[1]}],"warnings":[]}', "uncertain 有非字符串"],
    ['{"drafts":[],"warnings":"failed"}', "warnings 不是数组"],
    ['[]', "顶层不是对象"],
  ];
  for (const [reply, why] of cases) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root },
          { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
          fakeCodex(reply),
        ),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
});

test("🔴 扩展名是用户给的,内容也得对得上 —— 否则 PDF 改名叫 .txt 就绕开了'不收 PDF'", async () => {
  const root = tmp();
  const PDF = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1").toString("base64");
  const bad: [string, string][] = [
    ["shot.png", b64("这根本不是 PNG")],              // 二进制伪装成图片
    ["shot.webp", PNG],                                // 图片格式对不上扩展名
    ["notes.txt", Buffer.from([0x00, 0x01, 0x02]).toString("base64")], // NUL = 二进制
    ["notes.txt", PDF],                                // 正是"改个名混进来"那一类
    ["notes.md", Buffer.from([0xff, 0xfe, 0x41]).toString("base64")],  // 非法 UTF-8
  ];
  for (const [name, content] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name, content_base64: content }] }, fakeCodex(OK_REPLY)),
      (e: unknown) => e instanceof IngestError && e.code === "content_mismatch",
      `应拒绝 ${name}`,
    );
  }
  // 真图片 / 真文本照过(不是把门一律关死)
  await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "ok.png", content_base64: PNG }] }, fakeCodex(OK_REPLY.replace("01_a.csv", "01_ok.png")));
  await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "ok.csv", content_base64: b64("代码,数量\n300308,100") }] }, fakeCodex(OK_REPLY.replace("01_a.csv", "01_ok.csv")));
});

test("超大 base64 在**解码之前**就被拒(解码本身要扫一遍、要分配内存)", async () => {
  const root = tmp();
  // 🔴 这里的输入是刻意挑的:30 MB 全是非 base64 字符。
  //    Node 的解码器会跳过非法字符 ⇒ **解码后是 0 字节**。
  //    - 有前置长度校验:先看编码长度 30 MB > 上限 → file_too_large
  //    - 没有前置校验  :解码完得到 0 字节 → bad_content
  //    两条路给出**不同的错误码**,这条断言才真的在测"检查发生在解码之前"。
  //    ⚠️ 换成 "A".repeat(30MB) 是测不出来的:它解码后 22.5 MB,两条路都会报 file_too_large
  //       —— 断言看着对,其实把变异放过去了(第一版就是这么写的)。
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.txt", content_base64: "!".repeat(30 * 1024 * 1024) }] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "file_too_large",
  );
  // 正常的超大文件也照样拒(这条走的是解码后的那道)
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.txt", content_base64: Buffer.alloc(9 * 1024 * 1024, 0x41).toString("base64") }] }, fakeCodex(OK_REPLY)),
    (e: unknown) => e instanceof IngestError && e.code === "file_too_large",
  );
});

test("🔴 失败时暂存目录要清掉 —— 里面是用户的私密截图,而调用方拿不到 batch 路径", async () => {
  const root = tmp();
  const importDir = path.join(root, "import");
  // 第一个文件合法、第二个类型不对:第一个已经落盘了
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root },
        { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }, { name: "b.pdf", content_base64: b64("x") }] },
        fakeCodex(OK_REPLY),
      ),
    (e: unknown) => e instanceof IngestError && e.code === "unsupported_type",
  );
  assert.deepEqual(fs.existsSync(importDir) ? fs.readdirSync(importDir) : [], [], "失败后不许有残留批次");

  // 转写阶段失败同样要清
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }] }, fakeCodex("不是 JSON")),
    (e: unknown) => e instanceof IngestError && e.code === "bad_output",
  );
  assert.deepEqual(fs.existsSync(importDir) ? fs.readdirSync(importDir) : [], [], "转写失败后同样不许有残留");

  // 成功也清理本次暂存件，用户在产品外选择的原文件不受影响。
  const r = await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }, fakeCodex(OK_REPLY));
  assert.equal(fs.existsSync(path.join(root, r.dir)), false, "成功的批次不残留上传原件");
});

test("🔴 导入要认用户配的 provider —— 直接 makeConfig 会恒定落到内置默认,用户配了等于没配", async () => {
  const cap: Cap = {};
  const root = tmp();
  // .local/config.json 里配 mimo(它声明了 structured_output=prompt)
  fs.mkdirSync(path.join(root), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo", auth: "api_key" } }));
  process.env.MIMO_API_KEY = "k-for-test-0123456789";
  try {
    await ingestFiles(
      { repoRoot: REPO, dataRoot: root },
      { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
      fakeCodex(OK_REPLY, cap),
    );
  } finally {
    delete process.env.MIMO_API_KEY;
  }
  // ① provider 真的被认了(不认的话这里会是 openai 的默认模型 / undefined)
  assert.equal(cap.opts!.model, "mimo-v2.5", "模型应来自用户配的 provider 模板");
  // ② 而且能力也跟着生效:这家不认服务端 schema ⇒ 不许硬传,schema 要进提示词
  assert.equal(cap.schema, undefined, "硬传会被这家整轮拒掉(实测 MiMo)");
  const text = (cap.inputs as { type: string; text?: string }[]).find((i) => i.type === "text")!.text!;
  assert.ok(text.includes("JSON Schema"), "schema 要写进提示词");
});

test("🔴 草稿的 fields 一律按契约校验 —— 降级到提示词后没人拒非法字段,那就是在放松要求", async () => {
  const root = tmp();
  const bad: [string, string][] = [
    // 拼错字段名 / 模型自己加的字段:硬传 schema 时平台会拒,降级后必须由我们拒
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"symbol":"300308","confidence":0.9},"uncertain":[]}],"warnings":[]}', "多了未声明字段"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"shares":"很多"},"uncertain":[]}],"warnings":[]}', "类型不对"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"smybol":"300308"},"uncertain":[]}],"warnings":[]}', "字段名拼错"],
  ];
  for (const [reply, why] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }, fakeCodex(reply)),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
  // 只给读到的那几个字段(键不齐)是**允许**的:"没给这个键"和"给了 null"本来就同义
  const ok = await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
    fakeCodex('{"drafts":[{"source_file":"01_a.csv","fields":{"symbol":"300308","shares":100,"cost":8.46},"uncertain":[]}],"warnings":[]}'),
  );
  assert.deepEqual(ok.drafts[0]!.fields, { symbol: "300308", shares: 100, cost: 8.46 });
});

test("🔴 用户放在自己数据根下的 provider 覆盖模板要生效 —— 配置与模板必须同一个根", async () => {
  const cap: Cap = {};
  const root = tmp();
  // 用户配置选 mimo,并在**同一个根**下放一份自己的覆盖模板(改了默认模型)
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo", auth: "api_key" } }));
  fs.mkdirSync(path.join(root, "providers"), { recursive: true });
  const tpl = JSON.parse(fs.readFileSync(path.join(REPO, "providers", "mimo.json"), "utf8")) as Record<string, unknown>;
  tpl.default_model = "mimo-v2.5-pro"; // 与仓库模板(mimo-v2.5)不同 —— 用来区分到底读了哪一份
  fs.writeFileSync(path.join(root, "providers", "mimo.json"), JSON.stringify(tpl));

  process.env.MIMO_API_KEY = "k-for-test-0123456789";
  try {
    await ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }, fakeCodex(OK_REPLY, cap));
  } finally {
    delete process.env.MIMO_API_KEY;
  }
  assert.equal(cap.opts!.model, "mimo-v2.5-pro", "读的必须是用户那份覆盖模板,不是仓库自带的");
});

test("🔴 草稿校验用**完整契约**:值越界也要当场拒,不能等落库才被拒", async () => {
  const root = tmp();
  const bad: [string, string][] = [
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"symbol":"AAPL!"},"uncertain":[]}],"warnings":[]}', "symbol 不是三市场规范代码(pattern)"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"shares":-1},"uncertain":[]}],"warnings":[]}', "数量为负(minimum)"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"opened_at":"2026-99-99"},"uncertain":[]}],"warnings":[]}', "不是真日历日(format)"],
  ];
  for (const [reply, why] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }, fakeCodex(reply)),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
});

test("🔴 读不到的字段给 null 是**设计里的正常路径**,不能因此把整批判成坏产出", async () => {
  const root = tmp();
  // 提示词就是要求"读不到的给 null 而不是省略键";契约里的类型不含 null,
  // 所以校验必须发生在 dropNulls **之后**,否则最常见的合法草稿全被拒
  const reply = JSON.stringify({
    drafts: [{
      source_file: "01_a.csv",
      fields: { symbol: "300308", name: null, account: null, shares: 100, cost: 8.46, opened_at: null, note: null },
      uncertain: ["name:截图里没有"],
    }],
    warnings: [],
  });
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
    fakeCodex(reply),
  );
  assert.deepEqual(r.drafts[0]!.fields, { symbol: "300308", shares: 100, cost: 8.46 }, "null 全部剥掉,剩下的原样保留");
  assert.deepEqual(r.drafts[0]!.uncertain, ["name:截图里没有"], "模型说不确定的地方要留着");
});

test("🔴 必填字段没读到的草稿要**标出来**,而不是让人点一个注定失败的按钮", async () => {
  const root = tmp();
  const reply = JSON.stringify({
    drafts: [
      { source_file: "01_a.csv", fields: { symbol: null, shares: 100, cost: 8.46 }, uncertain: ["symbol:截图糊了"] },
      { source_file: "01_a.csv", fields: { symbol: "300308", shares: 100, cost: 8.46 }, uncertain: [] },
    ],
    warnings: [],
  });
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
    fakeCodex(reply),
  );
  // 整批不许因此被毙掉 —— 截图里一个字段没拍清是常态
  assert.equal(r.drafts.length, 2);
  assert.deepEqual(r.drafts[0]!.missing_required, ["symbol"], "缺的必填要点名");
  assert.deepEqual(r.drafts[1]!.missing_required, [], "好的那条不受连累");
  // 口径要对得上落库:标了缺必填的,落库确实会被拒
  await assert.rejects(
    async () => { upsertRecord(root, "position", r.drafts[0]!.fields); },
    (e: unknown) => e instanceof Error && /symbol/.test(e.message),
    "标出来的那条,落库路径也确实拒",
  );
  assert.ok(upsertRecord(root, "position", r.drafts[1]!.fields).id, "没标的那条要能真存进去");
});
