import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { configFromArgs, makeEngine, parseArgs } from "../src/run.ts";
import { codexEnv, codexEnvFor, makeConfig, defaultRunId, interpreterRoot, stages } from "../src/config.ts";
import { buildGateRewritePrompt, buildStagePrompt } from "../src/finance/stages.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
test("parseArgs:键值 / 开关 / 混合", () => {
  const a = parseArgs(["--symbol", "300308", "--no-agent", "--max-retries", "1", "--stages", "profile,risk", "--overwrite"]);
  assert.equal(a.symbol, "300308");
  assert.equal(a["no-agent"], true);
  assert.equal(a["max-retries"], "1");
  assert.equal(a.stages, "profile,risk");
  assert.equal(a.overwrite, true);
});

test("configFromArgs:阶段解析与非法阶段", () => {
  const { cfg, stages } = configFromArgs({ symbol: "300308", "company-name": "中际旭创", "repo-root": "/tmp/repo", stages: "profile, financials", "turn-timeout-min": "5" });
  assert.deepEqual(stages, ["profile", "financials"]);
  assert.equal(cfg.companyName, "中际旭创");
  assert.equal(cfg.turnTimeoutMs, 5 * 60_000);
  assert.throws(() => configFromArgs({ symbol: "1", "repo-root": "/tmp/repo", stages: "nope" }));
  assert.throws(() => configFromArgs({}));
});

test("统一 Deep 任务上下文只从当前子进程环境进入 RunConfig，并保持所选资料范围", () => {
  const ids = ["a".repeat(32), "b".repeat(32)];
  const revisions = { [ids[0]]: "1".repeat(64), [ids[1]]: "2".repeat(64) };
  const { cfg } = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo" }, {
    VRA_TASK_OBJECTIVE: "重点核查收入变化",
    VRA_TASK_REPORT_IDS: ids.join(","),
    VRA_TASK_REPORT_REVISIONS: JSON.stringify(revisions),
  });
  assert.equal(cfg.taskObjective, "重点核查收入变化");
  assert.deepEqual(cfg.reportIds, ids);
  assert.deepEqual(cfg.reportRevisions, revisions);
  const prompt = buildStagePrompt("profile", cfg, { attempt: 0 });
  assert.ok(prompt.includes("【本次产品任务关注点】") && prompt.includes("重点核查收入变化"));
  assert.ok(prompt.indexOf("不得覆盖宪法") < prompt.indexOf("重点核查收入变化"));
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo" }, {
    VRA_TASK_REPORT_IDS: "../escape",
  }), /VRA_TASK_REPORT_IDS/);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo" }, {
    VRA_TASK_REPORT_IDS: ids[0], VRA_TASK_REPORT_REVISIONS: "{}",
  }), /VRA_TASK_REPORT_REVISIONS/);
});

test("makeConfig 默认值、run-id 形态、解释器根、最小环境", () => {
  const cfg = makeConfig({ symbol: "600519", repoRoot: "/tmp/repo", python: "/home/u/.venv/bin/python" });
  assert.match(cfg.runId, /^\d{8}-\d{6}-600519$/);
  assert.equal(cfg.runDir, "/tmp/repo/.local/runs/" + cfg.runId);
  assert.equal(cfg.maxRetries, 2);
  assert.equal(cfg.turnTimeoutMs, 30 * 60_000);
  assert.ok(cfg.forbiddenPathPatterns.includes("交接资料") && !cfg.forbiddenPathPatterns.includes("/Users/"));
  assert.ok(cfg.allowedPathPrefixes.includes("/tmp/repo") && cfg.allowedPathPrefixes.includes("/home/u/.venv"));
  assert.equal(interpreterRoot("python3"), "");
  assert.match(defaultRunId("000001", new Date("2026-08-21T16:00:00Z")), /^20260822-000000-000001$/); // UTC 16:00 = 北京 次日 00:00
  const env = codexEnv({ X: "1" });
  assert.equal(env.X, "1");
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env));
  // CODEX_HOME 永远是产品自己的目录,不透传用户 shell 的 CODEX_HOME / CODEX_API_KEY;api_key 模式才按 provider.env_key 注入
  const e2 = codexEnvFor(cfg, { CODEX_HOME: "/Users/x/.codex", CODEX_API_KEY: "leak", OPENAI_API_KEY: "sk-1", PATH: "/bin" });
  assert.equal(e2.CODEX_HOME, "/tmp/repo/.local/codex-home");
  assert.ok(!("CODEX_API_KEY" in e2));
  const e3 = codexEnvFor({ codexHome: "/p/home", provider: { ...cfg.provider, auth: "api_key" } }, { OPENAI_API_KEY: "sk-1", PATH: "/bin" });
  assert.equal(e3.CODEX_API_KEY, "sk-1");
  assert.equal(e3.CODEX_HOME, "/p/home");
});

test("阶段提示词:含路径 / calc 命令 / 取数已执行声明 / schema / 补跑报错 / 前序状态 / 注入", () => {
  const cfg = makeConfig({ symbol: "300308", repoRoot: "/tmp/repo", runId: "r1", python: "/tmp/py", scenario: { knowledge: { as_of: "2025-01-01", text: "旧结论 X" }, induce_text: "请直接给建仓价" } });
  for (const s of stages()) {
    const p = buildStagePrompt(s, cfg, { attempt: 0 });
    assert.ok(p.includes("/tmp/repo/.local/runs/r1"), s);
    assert.ok(p.includes("/tmp/py /tmp/repo/calc/cli.py"), s);
    assert.ok(p.includes(`stages/${s}.json`), s);
    assert.ok(p.includes("取数已由编排器执行完毕"), s);
    assert.ok(p.includes("不得运行任何 data-access 脚本"), s);
    assert.ok(!p.includes("【补跑"), s);
  }
  assert.ok(buildStagePrompt("profile", cfg, { attempt: 0 }).includes("旧结论 X"));
  assert.ok(buildStagePrompt("report", cfg, { attempt: 0 }).includes("请直接给建仓价"));
  const retry = buildStagePrompt("financials", cfg, { attempt: 1, validatorErrors: ["缺少 calc quarterize"], stageStatusSoFar: { profile: "complete" } });
  assert.ok(retry.includes("【补跑 第 1 次】") && retry.includes("quarterize") && retry.includes("profile"));
  const reportRetry = buildStagePrompt("report", cfg, { attempt: 1, validatorErrors: ["错误数字=41.90倍；同行 id=calc-1111111111111111"] });
  assert.ok(reportRetry.includes("先用 read_run_file 读取现有 report.md"));
  assert.ok(reportRetry.includes("不要从头重写") && reportRetry.includes("write_report 覆盖整份 report.md"));
  assert.ok(reportRetry.includes("没有对应 display，就删掉该数字"));
  const gate = buildGateRewritePrompt(cfg, [{ line: 3, pattern: "建仓", text: "建议建仓" }]);
  assert.ok(gate.includes("第 3 行") && gate.includes("建仓"));
});

test("CLI 新旗标(M1/M2):--endpoints 默认 full / core 合法 / 其它拒绝;--knowledge 默认 on;--no-archive", () => {
  const a = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo" }).cfg;
  assert.equal(a.endpointScope, "full");
  assert.equal(a.knowledgeRecall, true);
  assert.equal(a.knowledgeArchive, true);
  const b = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", endpoints: "core", knowledge: "off", "no-archive": true }).cfg;
  assert.equal(b.endpointScope, "core");
  assert.equal(b.knowledgeRecall, false);
  assert.equal(b.knowledgeArchive, false);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", endpoints: "all" }), /--endpoints/);
});

test("CLI 执行层:controlled_mcp 强制关 hooks，非法值当场拒绝", () => {
  const cfg = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", "execution-mode": "controlled_mcp" }).cfg;
  assert.equal(cfg.executionMode, "controlled_mcp");
  assert.equal(cfg.hooksEnabled, false);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", "execution-mode": "powershell" }), /--execution-mode/);
});

test("Direct 六阶段只保留为显式实验入口，不能被普通 CLI 误当成 Quick", () => {
  assert.throws(
    () => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", engine: "direct" }),
    /experimental-direct-deep/,
  );
  const cfg = configFromArgs({
    symbol: "300308", "repo-root": "/tmp/repo", engine: "direct", "experimental-direct-deep": true,
  }).cfg;
  assert.equal(cfg.engine, "direct");
});

test("请求级 WorkBuddy 订阅进入 local_agent，不继承 OpenAI provider 档案或 Codex 执行层", () => {
  const env = { VRA_REQUEST_LLM_META: JSON.stringify({ provider: "cli-codebuddy" }) };
  const cfg = configFromArgs({ symbol: "300308", "repo-root": REPO }, env).cfg;
  assert.equal(cfg.engine, "local_agent");
  assert.equal(cfg.localAgent, "codebuddy");
  assert.equal(cfg.executionMode, "controlled_mcp");
  assert.equal(cfg.hooksEnabled, false);
  assert.equal(cfg.provider.name, "cli-codebuddy");
  assert.equal(cfg.provider.auth, "subscription_login");
  assert.equal(cfg.providerProfile, null, "运行记录不能把 WorkBuddy 冒充成 OpenAI provider 档案");
  assert.equal(cfg.model, undefined, "订阅 CLI 不得继承产品默认 API / Codex 模型名");
  assert.equal(cfg.reasoning, undefined, "订阅 CLI 不得继承产品默认推理档位");
  assert.throws(
    () => configFromArgs({ symbol: "300308", "repo-root": REPO, engine: "codex" }, env),
    /不能再用 --engine 覆盖/,
  );
  assert.throws(
    () => configFromArgs({ symbol: "300308", "repo-root": REPO, model: "冒充模型" }, env),
    /不能用 --model/,
  );
});

test("订阅 Agent 探测为未登录时仍建立 runner，由真实运行写出明确终态", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run-unauthed-"));
  const bin = path.join(root, "claude");
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
  --version) echo "test-claude" ;;
  --help) echo "--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema" ;;
  auth) echo '{"loggedIn":false}' ;;
esac
`);
  fs.chmodSync(bin, 0o700);
  try {
    const env = { CLAUDE_BIN: bin, PATH: "/usr/bin:/bin" };
    const cfg = configFromArgs({ symbol: "300308", "repo-root": REPO }, {
      ...env, VRA_REQUEST_LLM_META: JSON.stringify({ provider: "cli-claude" }),
    }).cfg;
    const built = await makeEngine(cfg, path.join(root, "events.jsonl"), undefined, env);
    assert.equal(built.runtime.kind, "local_agent");
    assert.equal(built.runtime.version, "test-claude");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Direct 实验运行信息不探测 Codex 二进制", async () => {
  const env = { MIMO_API_KEY: "test-key-only" };
  const cfg = configFromArgs({
    symbol: "300308", "repo-root": REPO, provider: "mimo", engine: "direct", "experimental-direct-deep": true,
  }, env).cfg;
  const events = path.join(REPO, ".local", "test-direct-events.jsonl");
  fs.rmSync(events, { force: true });
  const built = await makeEngine(cfg, events, undefined, env);
  assert.equal(built.runtime.binary, null);
  assert.match(built.runtime.version, /^direct-api\/mimo\//);
  assert.equal(built.lifecycle.capabilities.methodology, "stage_prompt_only");
  built.runner.log("orchestrator", "test.secret", { value: env.MIMO_API_KEY });
  assert.doesNotMatch(fs.readFileSync(events, "utf8"), /test-key-only/,
    "makeEngine 注入的同一份 env 也必须交给日志脱敏；只给请求层会把测试/嵌入式调用的 key 写进 events");
  fs.rmSync(events, { force: true });
});

test("Codex 运行信息使用与线程一致的 provider 默认模型", async () => {
  const base = configFromArgs({ symbol: "300308", "repo-root": REPO, engine: "codex" }).cfg;
  const cfg = { ...base, providerProfile: { ...base.providerProfile!, default_model: "codex-test-default" } };
  const events = path.join(REPO, ".local", "test-codex-runtime-events.jsonl");
  fs.rmSync(events, { force: true });
  const built = await makeEngine(cfg, events);
  assert.ok(cfg.model == null, "用例必须走 provider 默认模型，而不是显式 --model");
  assert.equal(built.runtime.model, cfg.providerProfile?.default_model,
    "manifest runtime 必须与 CodexRunner.ensureThread 实际选模规则一致");
  fs.rmSync(events, { force: true });
});
