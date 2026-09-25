#!/usr/bin/env node
/**
 * Provider 兼容测试矩阵(Phase 1 M4,开发方案 v2 §6 的 10 项):对某个 provider profile 用 Codex SDK 真跑 10 个小回合,机器判定 pass / partial / fail,
 * 结果写 .local/provider-matrix/<id>/<时间>/results.json + summary.md(不含任何密钥值)。
 * 用法:node orchestrator/src/finance/provider_matrix.ts --provider deepseek [--model deepseek-v4-flash] [--tests 1,2,8] [--timeout-min 5] [--reasoning medium] [--auth api_key|chatgpt_login]
 * 每项定义(可判定口径):
 *  ① 单次文本:回复含约定 token;② 单工具调用:至少 1 条 command 且输出含约定串;③ 连续三轮工具调用:step-A/B/C 三条输出各出自不同的 command 项且按序出现(合并成一条 → partial);
 *  ④ 并行工具调用:两条 command 都执行且事件流里观察到两条 command 同时在途(item.started 后未 completed 又来一条)→ pass;都执行但串行 → partial;
 *  ⑤ 工具失败自修复:先有失败 command 再有成功 command 输出 recovered,且最终回复提到 recovered;⑥ 长流:编号 1–200 一个不缺且收到 turn.completed;
 *  ⑦ reasoning item:事件里出现 reasoning 项(无 → partial,非 fail);⑧ schema 严格输出:outputSchema 下最终回复为合法 JSON 且字段齐;
 *  ⑨ 多轮上下文延续:第二回合能复述第一回合的约定词;⑩ 无 previous_response_id 协议下的延续:wire_api=chat 时 ⑨ 通过即 pass(协议本无此概念);responses 时记录为 n/a(由 Codex 内部处理)。
 * 运行沙箱:临时目录 cwd、workspace-write、无网络、approval never;不加载产品宪法(矩阵只测协议兼容,不测研究纪律)。
 * 落盘前脱敏:provider 密钥 / env_http_headers 引用的环境值精确替换为 ***,再叠加通用 token/签名 URL 脱敏(错误信息可能含请求头或带签名 URL)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Codex, type CodexOptions, type ThreadEvent } from "@openai/codex-sdk";

import { CODEX_SHELL_ENV_POLICY, codexEnv } from "../config.ts";
import { writeJson } from "../fsutil.ts";
import { loadProductConfig } from "../productConfig.ts";
import { assertAuth, codexProviderConfig, loadProviderProfile, providerEnv, type ProviderProfileFile } from "../providers.ts";
import { redact, repoRootFromHere } from "../service.ts";
import { parseArgs } from "../run.ts";


// **composition root**:插件在入口注册,Core 模块一律不 import 它
// (Core 消费者靠副作用 import 硬接某个包,换垂类时靠入口 import 恢复不了 —— ESM 会缓存)。
export interface MatrixCase { no: number; name: string; verdict: "pass" | "partial" | "fail" | "n/a" | "error"; detail: string; duration_ms: number; commands: number; items: number; reasoning_items: number; failed?: string | null }

export interface TurnSummary {
  text: string; commands: { command: string; exit_code: number | null; output: string }[]; items: number; reasoning: number; failed: string | null; error: string | null;
  /** 同时在途的 command 项峰值(item.started 已到、item.completed 未到):≥2 才算观察到并行 */
  max_inflight_commands: number;
  /** 收到 turn.completed(流正常收尾) */
  completed: boolean;
}

/** 脱敏:已知密钥值精确替换 + 通用 token / 签名 URL 模式(service.redact);写入 results / summary / stderr 前必经 */
export function scrubWith(secrets: string[], s: string, max = 600): string {
  let out = String(s ?? "");
  for (const v of secrets) if (v) out = out.split(v).join("***");  // 已知密钥 / 头值不论长短一律抹(短值是用户自己的取值,宁可误伤输出也不落盘)
  return redact(out, max);
}

async function runTurn(thread: ReturnType<Codex["startThread"]>, prompt: string, timeoutMs: number, outputSchema?: unknown, secrets: string[] = []): Promise<TurnSummary> {
  const sum: TurnSummary = { text: "", commands: [], items: 0, reasoning: 0, failed: null, error: null, max_inflight_commands: 0, completed: false };
  const scrub = (x: string, max?: number) => scrubWith(secrets, x, max);
  const inflight = new Set<string>();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { events } = await thread.runStreamed(prompt, { ...(outputSchema ? { outputSchema } : {}), signal: ac.signal });
    for await (const ev of events as AsyncIterable<ThreadEvent>) {
      if (ev.type === "item.started") {
        const it = ev.item as { id?: string; type: string };
        if (it.type === "command_execution") { inflight.add(it.id ?? String(sum.items)); sum.max_inflight_commands = Math.max(sum.max_inflight_commands, inflight.size); }
      } else if (ev.type === "item.completed") {
        sum.items += 1;
        const it = ev.item as { id?: string; type: string; text?: string; command?: string; exit_code?: number | null; aggregated_output?: string };
        if (it.type === "agent_message") sum.text += scrub(it.text ?? "", 20000);
        if (it.type === "command_execution") { inflight.delete(it.id ?? ""); sum.commands.push({ command: scrub(it.command ?? "", 300), exit_code: it.exit_code ?? null, output: scrub((it.aggregated_output ?? "").slice(0, 400), 400) }); }
        if (it.type === "reasoning") sum.reasoning += 1;
      } else if (ev.type === "turn.completed") { sum.completed = true; }
      else if (ev.type === "turn.failed") { sum.failed = scrub((ev as { error?: { message?: string } }).error?.message ?? "turn.failed"); break; }
      else if (ev.type === "error") { sum.error = scrub((ev as { message?: string }).message ?? "error"); break; }
    }
  } catch (e) {
    sum.error = ac.signal.aborted ? `超时 ${timeoutMs} ms` : scrub(e instanceof Error ? e.message : String(e));
  } finally { clearTimeout(timer); }
  return sum;
}

const LONG_STREAM_LINES = 200;

export function judge(no: number, t: TurnSummary, ctx: { prev?: TurnSummary; wire: string; token?: string }): { verdict: MatrixCase["verdict"]; detail: string } {
  if (t.error || t.failed) return { verdict: "error", detail: t.error ?? t.failed ?? "" };
  const okCmds = t.commands.filter((c) => c.exit_code === 0);
  const txt = t.text.toLowerCase();
  switch (no) {
    case 1: return txt.includes("vra-ok-7731") ? { verdict: "pass", detail: "回复含约定 token" } : { verdict: "fail", detail: `回复未含约定 token:${t.text.slice(0, 80)}` };
    case 2: return t.commands.length >= 1 && t.commands.some((c) => c.output.includes("hello-tool-4412")) ? { verdict: "pass", detail: `${t.commands.length} 条命令,输出命中` } : { verdict: "fail", detail: `命令 ${t.commands.length} 条,输出未命中` };
    case 3: {  // 三条输出必须出自不同的 command 项且按序(同一条命令里合并输出 → 索引相同 → partial)
      const outs = okCmds.map((c) => c.output.toLowerCase());
      const idx = ["step-a", "step-b", "step-c"].map((k) => outs.findIndex((o) => o.includes(k)));
      const ordered = idx.every((i) => i >= 0) && idx[0] < idx[1] && idx[1] < idx[2];
      if (ordered) return { verdict: "pass", detail: `3 条命令依次执行(命令项索引 ${idx.join(",")})` };
      return { verdict: idx.some((i) => i >= 0) ? "partial" : "fail", detail: `step-A/B/C 命令项索引 ${idx.join(",")}(需三项各异且递增;-1 = 未出现)` }; }
    case 4: {  // 两条都执行 + 观察到同时在途 → pass;都执行但串行 → partial(SDK 事件能证明并行,不能证明"不可能并行")
      const both = ["par-1", "par-2"].every((k) => okCmds.some((c) => c.output.includes(k)));
      if (!both) return { verdict: "fail", detail: `par-1/par-2 未都执行成功(成功命令 ${okCmds.length} 条)` };
      return t.max_inflight_commands >= 2 ? { verdict: "pass", detail: `两条命令同时在途(峰值 ${t.max_inflight_commands})` } : { verdict: "partial", detail: "两条命令都执行但事件流显示串行(未观察到并发)" }; }
    case 5: { const failedFirst = t.commands.findIndex((c) => c.exit_code !== null && c.exit_code !== 0); const recovered = t.commands.some((c, i) => i > failedFirst && c.exit_code === 0 && c.output.includes("recovered"));
      const told = txt.includes("recovered");
      return failedFirst >= 0 && recovered && told ? { verdict: "pass", detail: "先失败后自修复,最终回复已说明" } : { verdict: failedFirst >= 0 ? "partial" : "fail", detail: `失败命令${failedFirst >= 0 ? "有" : "无"},修复命令${recovered ? "有" : "无"},最终回复${told ? "提到" : "未提到"} recovered` }; }
    case 6: {  // 1..200 一个不缺(允许乱序重复但集合必须完整)+ 流正常收尾
      const nums = t.text.split("\n").map((l) => /^\s*(\d+)[.、)]/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
      const have = new Set(nums); const missing = Array.from({ length: LONG_STREAM_LINES }, (_, i) => i + 1).filter((n) => !have.has(n));
      if (!missing.length && t.completed) return { verdict: "pass", detail: `${LONG_STREAM_LINES} 行编号齐全,turn.completed 收到` };
      return { verdict: "partial", detail: `编号行 ${nums.length},缺 ${missing.length} 个${missing.length ? `(如 ${missing.slice(0, 5).join(",")})` : ""}${t.completed ? "" : ";未收到 turn.completed"}` }; }
    case 7: return t.reasoning > 0 ? { verdict: "pass", detail: `${t.reasoning} 个 reasoning 项` } : { verdict: "partial", detail: "无 reasoning 项(该 provider/模型不回传或 Codex 不展示)" };
    case 8: { try { const o = JSON.parse(t.text); return o && typeof o.answer === "string" && Number.isInteger(o.n) && o.n === 42 ? { verdict: "pass", detail: "JSON 合法且字段齐" } : { verdict: "partial", detail: `JSON 合法但字段不符:${t.text.slice(0, 80)}` }; } catch { return { verdict: "fail", detail: `最终回复不是 JSON:${t.text.slice(0, 80)}` }; } }
    case 9: return txt.includes(ctx.token ?? "") ? { verdict: "pass", detail: "第二回合复述了第一回合约定词" } : { verdict: "fail", detail: `未复述:${t.text.slice(0, 80)}` };
    case 10: return ctx.wire === "chat" ? (txt.includes(ctx.token ?? "") ? { verdict: "pass", detail: "chat 协议(无 previous_response_id)下多轮延续正常" } : { verdict: "fail", detail: "chat 协议下多轮延续失败" }) : { verdict: "n/a", detail: "responses 协议:previous_response_id 由 Codex 内部处理,此项不适用" };
    default: return { verdict: "error", detail: "unknown" };
  }
}

export async function runMatrix(opts: { provider: string; model?: string; tests?: number[]; timeoutMs?: number; repoRoot?: string; auth?: string; reasoning?: string }): Promise<{ dir: string; cases: MatrixCase[]; profile: ProviderProfileFile }> {
  const repoRoot = opts.repoRoot ?? repoRootFromHere();
  const pc = loadProductConfig(repoRoot, { env: process.env });
  const { profile } = loadProviderProfile(repoRoot, pc.resolved.dataRoot, opts.provider);
  const auth = opts.auth !== undefined ? assertAuth(opts.auth, "--auth") : (profile.id === "openai" ? pc.provider.auth : "api_key");
  if (!profile.auth_modes.includes(auth)) throw new Error(`provider ${profile.id} 不支持 auth=${auth}(支持:${profile.auth_modes.join("/")})`);
  const pEnv = providerEnv(profile, auth, process.env);
  const secrets = Object.values(pEnv);  // 落盘前精确脱敏用
  const env = codexEnv({ CODEX_HOME: pc.resolved.codexHome, ...pEnv });
  const reasoning = opts.reasoning ?? "medium";  // 第 7 项需要模型回传 reasoning 摘要:effort 默认 medium + summary=detailed(Codex 只在摘要非空时才产出 reasoning 项);provider 不支持时 Codex 会忽略或报错(记入结果)
  const codexOpts: CodexOptions = { env, config: { ...(CODEX_SHELL_ENV_POLICY as unknown as Record<string, unknown>), model_reasoning_summary: "detailed", ...codexProviderConfig(profile) } as never, ...(pc.resolved.codexPath ? { codexPathOverride: pc.resolved.codexPath } : {}) };
  const codex = new Codex(codexOpts);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vra-matrix-"));
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const model = opts.model ?? profile.default_model ?? undefined;
  const want = new Set(opts.tests ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = path.join(pc.resolved.dataRoot, "provider-matrix", profile.id, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const cases: MatrixCase[] = [];
  const mk = () => codex.startThread({ workingDirectory: cwd, sandboxMode: "workspace-write", networkAccessEnabled: false, approvalPolicy: "never", webSearchMode: "disabled", ...(model ? { model } : {}), modelReasoningEffort: reasoning, skipGitRepoCheck: true } as never);
  const rec = (no: number, name: string, t: TurnSummary, v: { verdict: MatrixCase["verdict"]; detail: string }, ms: number) => {
    cases.push({ no, name, verdict: v.verdict, detail: scrubWith(secrets, v.detail, 300), duration_ms: ms, commands: t.commands.length, items: t.items, reasoning_items: t.reasoning, failed: t.failed ?? t.error ?? null });
    console.error(`[matrix] ${no}. ${name}: ${v.verdict} — ${scrubWith(secrets, v.detail, 300)} (${Math.round(ms / 1000)}s)`);
    writeJson(path.join(dir, "results.json"), { provider: profile.id, model: model ?? "(引擎默认)", auth, wire_api: profile.wire_api, cases });
  };
  const run1 = async (no: number, name: string, prompt: string, schema?: unknown, ctx: { prev?: TurnSummary; token?: string } = {}, thread = mk()) => {
    if (!want.has(no)) return;
    const t0 = Date.now();
    const t = await runTurn(thread, prompt, timeoutMs, schema, secrets);
    rec(no, name, t, judge(no, t, { ...ctx, wire: profile.wire_api }), Date.now() - t0);
    return t;
  };
  await run1(1, "单次文本", "请只回复这个字符串,不要其它内容:vra-ok-7731");
  await run1(2, "单工具调用", "请在当前目录运行命令 `echo hello-tool-4412`,然后把命令输出原样回复给我。");
  await run1(3, "连续三轮工具调用", "请依次运行三条命令,每条都等上一条返回后再发下一条(不要合并成一条):`echo step-A`、`echo step-B`、`echo step-C`。最后用一行列出三条输出。");
  await run1(4, "并行工具调用", "请同时(并行发起,不要一条接一条等待)运行两条互不相关的命令:`sleep 2; echo par-1` 与 `sleep 2; echo par-2`,然后回复两者输出。");
  await run1(5, "工具失败自修复", "请运行 `ls /definitely/not/exist-7731`;如果它失败了,请改运行 `echo recovered`,并在最终回复里告诉我 recovered 是否成功打印。");
  await run1(6, "长流", "请输出 200 行,每行格式为 `<序号>. line`,序号从 1 到 200,不要省略、不要解释。");
  await run1(7, "reasoning item", "一道需要逐步推理的题:甲、乙、丙三人中恰有一人说真话。甲说\"乙在说谎\",乙说\"丙在说谎\",丙说\"甲和乙都在说谎\"。谁说的是真话?请先推理再只回复那个人的名字。");
  await run1(8, "schema 严格输出", "请回答:answer 填写 'vra',n 填写 42。", { type: "object", additionalProperties: false, required: ["answer", "n"], properties: { answer: { type: "string" }, n: { type: "integer" } } });
  if (want.has(9) || want.has(10)) {
    const thread = mk();
    const token = "cobalt-lantern-5519";
    const t0 = Date.now();
    const first = await runTurn(thread, `请记住这个约定词并只回复"已记住":${token}`, timeoutMs, undefined, secrets);
    if (first.error || first.failed) {
      const v = { verdict: "error" as const, detail: `第一回合失败:${first.error ?? first.failed}` };
      if (want.has(9)) rec(9, "多轮上下文延续", first, v, Date.now() - t0);
      if (want.has(10)) rec(10, "无 previous_response_id 协议下的延续", first, v, Date.now() - t0);
    } else {
      const t1 = Date.now();
      const second = await runTurn(thread, "我刚才让你记住的约定词是什么?只回复那个词。", timeoutMs, undefined, secrets);
      if (want.has(9)) rec(9, "多轮上下文延续", second, judge(9, second, { prev: first, wire: profile.wire_api, token }), Date.now() - t1);
      if (want.has(10)) rec(10, "无 previous_response_id 协议下的延续", second, judge(10, second, { prev: first, wire: profile.wire_api, token }), Date.now() - t1);
    }
  }
  const tally: Record<string, number> = {};
  for (const c of cases) tally[c.verdict] = (tally[c.verdict] ?? 0) + 1;
  const md = [`# Provider 兼容矩阵 · ${profile.id} · 模型 ${model ?? "(引擎默认)"} · ${stamp}`, "", `> 机器判定口径见 provider_matrix.ts 头注释;结果只反映该时刻该模型;不含任何密钥。wire_api=${profile.wire_api},auth=${auth},reasoning=${reasoning}。`, "",
    `- 合计:${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "", "| # | 项目 | 判定 | 说明 | 命令数 | items | reasoning | 耗时 s |", "|---|---|---|---|---|---|---|---|",
    ...cases.map((c) => `| ${c.no} | ${c.name} | ${c.verdict} | ${c.detail.replace(/\|/g, "/")} | ${c.commands} | ${c.items} | ${c.reasoning_items} | ${Math.round(c.duration_ms / 1000)} |`)].join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "summary.md"), md);
  writeJson(path.join(dir, "results.json"), { provider: profile.id, model: model ?? "(引擎默认)", auth, wire_api: profile.wire_api, reasoning, tally, cases });
  return { dir, cases, profile };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (!str(a.provider)) { console.error("用法:node orchestrator/src/finance/provider_matrix.ts --provider <id> [--model M] [--tests 1,2,8] [--timeout-min 5] [--auth api_key|chatgpt_login]"); process.exit(2); }
  const tests = str(a.tests)?.split(",").map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 10);
  const r = await runMatrix({ provider: str(a.provider)!, model: str(a.model), tests: tests?.length ? tests : undefined, timeoutMs: str(a["timeout-min"]) ? Number(a["timeout-min"]) * 60_000 : undefined, auth: str(a.auth), reasoning: str(a.reasoning) });
  console.error(`[matrix] done → ${r.dir}/summary.md`);
  process.exit(r.cases.some((c) => c.verdict === "fail" || c.verdict === "error") ? 2 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("provider_matrix.ts")) main().catch((e) => { console.error(`[matrix] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
