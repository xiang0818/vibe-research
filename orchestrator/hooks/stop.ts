#!/usr/bin/env node
/**
 * Stop 钩子(Codex lifecycle hook,agent 每个 turn 想收工时由 Codex 同步调用;stdin = StopCommandInput JSON,cwd = 运行目录)。
 * 语义 = "缺产物 / 阶段校验不过,不许正常收工":
 *   - 不合格 → {"decision":"block","reason":...},agent 在同一 turn 内继续修;
 *   - 连续 MAX_STOP_BLOCKS 次拦截之间都**没有新增合法计算记录**(空转),或本 (stage, attempt) 累计拦截达
 *     MAX_TOTAL_STOP_BLOCKS 次(兜底硬上限,不论有没有推进)→ 写终止标记 .vibe/stop-failed.json 并输出
 *     {"continue":false,"stopReason":...}:本轮到此为止,
 *     编排器看到标记把这轮判为失败并带着校验错误补跑(不会被当成正常完成);
 *   - 合格 → 放行。
 * 上下文 / cwd 不一致、stdin 解析失败、内部异常 → 放行但一定出声(日志 + stderr),绝不让钩子故障卡死 agent。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stages, type Stage } from "../src/config.ts";
import { MAX_STOP_BLOCKS, MAX_TOTAL_STOP_BLOCKS, STOP_FAILED_REL, appendHookLog, contextMatchesCwd, readHookContext, readHookLog, readStdin, type StopFailedMarker } from "../src/hooks.ts";
import { writeJson } from "../src/fsutil.ts";
import { loadRun, validateStage } from "../src/validator.ts";


// **composition root**:钩子是独立子进程,也是一个入口 —— 垂类包要在这里注册
import "../src/finance/register.ts";
interface StopInput { cwd: string; stop_hook_active?: boolean; hook_event_name?: string; last_assistant_message?: string | null }

function expectedArtifacts(stage: Stage, runDir: string): string[] {
  const out = [path.join(runDir, "stages", `${stage}.json`)];
  if (stage === "report") out.unshift(path.join(runDir, "report.md"));
  return out;
}

const isRunDir = (d: string) => fs.existsSync(path.join(d, "manifest.json"));

async function main(): Promise<void> {
  let input: StopInput;
  try { input = JSON.parse(await readStdin()) as StopInput; } catch (e) { process.stderr.write(`[vibe stop hook] stdin 不是合法 JSON:${e instanceof Error ? e.message : String(e)}\n`); return; }
  const runDir = input.cwd;
  const ctx = readHookContext(runDir);
  const ts = () => new Date().toISOString();
  if (!ctx || !stages().includes(ctx.stage) || !contextMatchesCwd(ctx, runDir)) {
    if (isRunDir(runDir)) appendHookLog(runDir, { ts: ts(), hook: "stop", decision: "error", reason: !ctx ? "钩子上下文缺失(被删?)" : "钩子上下文与 cwd 不一致(被改?)" });
    process.stderr.write("[vibe stop hook] 无有效钩子上下文,放行\n");
    return;
  }
  const stage = ctx.stage as Stage;
  const problems: string[] = [];
  try {
    for (const f of expectedArtifacts(stage, runDir)) if (!fs.existsSync(f)) problems.push(`缺产物:${path.relative(runDir, f)}`);
    if (!problems.length) {
      const run = loadRun(runDir); // 账本用磁盘审计副本;最终裁判仍是编排器内存账本
      const r = validateStage(stage, run);
      problems.push(...r.errors.filter((e) => !/账本|编排器取数记录/.test(e)).slice(0, 8));
    }
  } catch (e) {
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "error", reason: e instanceof Error ? e.message : String(e) });
    process.stderr.write(`[vibe stop hook] 校验异常,放行:${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  if (!problems.length) {
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "allow", stop_hook_active: !!input.stop_hook_active });
    return;
  }
  const cur = validCalcs(runDir); // 当前合法计算记录的条数与指纹(推进判据,见下方说明)
  const priorBlocks = readHookLog(runDir).filter((e) => e.hook === "stop" && e.decision === "block" && e.stage === stage && e.attempt === ctx.attempt);
  const last = priorBlocks[priorBlocks.length - 1];
  const blocks = priorBlocks.length;
  // 推进感知(治"收工预算在写 stage 文件前烧尽"的误杀):
  // 合规工作流是"攒 N 轮 calc(quarterize→latest_quarter→ttm_sum→yoy→qoq)→ 最后一步才写 stage 文件",
  // 模型每轮想收工时 stage 文件还没写,旧逻辑每轮都计一次 block,第 3-5 轮还在攒 calc 就被 MAX 次烧尽终止,
  // stage 文件在后续轮才补写 ⇒ 阶段永久 failed(2026-09-05 茅台 600519 run 实测)。
  // 判据(回应 review"仅 mtime 变化不足以证明有效进展"):两次拦截之间**合法计算记录的集合变了且条数没减少**
  // (合法 = JSON 可解析 + calculation_id 为非空 string —— 比 merge.loadCalcs **更严**,见 validCalcs)才算推进;agent 写的
  // args_*/sq_* 参数文件、function 清单(00_list.json)无 calculation_id,不算推进,防止用无意义写盘刷掉预算。
  // 比"有没有出现新 id"多要一条"条数没减少":删掉一条旧记录也会让集合变样,但那不是推进。
  // 重算覆盖同名文件(条数不变、id 变)仍算推进 —— run_tools 允许同一阶段覆盖自己的 output_file。
  // 存指纹不存 id 列表:这份日志每个 turn 都整份读,列表会随计算数一起涨。
  // 连续**无推进**的空转 block 累计到 MAX_STOP_BLOCKS 才终止;一旦有新计算落盘,计数回 1(不是 0:1 = 上一次拦截前刚有新计算)。
  const prevFp = last?.calcFp;
  const prevCount = last?.calcCount;
  const progressed = prevFp === undefined || prevCount === undefined
    ? true
    : cur.fp !== prevFp && cur.count >= prevCount;
  const prevStreak = last && typeof last.idleStreak === "number" ? last.idleStreak : 0;
  const idleStreak = progressed ? 1 : prevStreak + 1;
  if (idleStreak <= MAX_STOP_BLOCKS && blocks < MAX_TOTAL_STOP_BLOCKS) {
    const reason = `【Stop 钩子】本阶段(${stage})还不能收工(无推进空转 ${idleStreak}/${MAX_STOP_BLOCKS},本轮累计拦截 ${blocks + 1}/${MAX_TOTAL_STOP_BLOCKS}),请先修好再结束本轮;有新增计算落盘则空转计数回 1,但累计上限照涨:\n- ${problems.join("\n- ")}`.slice(0, 1800);
    appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "block", reason, stop_hook_active: !!input.stop_hook_active, calcCount: cur.count, calcFp: cur.fp, idleStreak });
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return;
  }
  // 空转拦够次数、或累计拦截到硬上限仍不合格:终止本轮,留标记给编排器(这轮按失败处理并补跑),不算正常收工
  const marker: StopFailedMarker = { stage, attempt: ctx.attempt, problems: problems.slice(0, 8), blocks, idleStreak: prevStreak, ts: ts() };
  writeJson(path.join(runDir, STOP_FAILED_REL), marker);
  const why = blocks >= MAX_TOTAL_STOP_BLOCKS
    ? `本轮累计拦截已达上限 ${blocks}/${MAX_TOTAL_STOP_BLOCKS} 次`
    : `连续 ${prevStreak} 次拦截之间都没有新增计算(本轮累计拦截 ${blocks} 次)`;
  const stopReason = `【Stop 钩子】${why}仍不合格,终止本轮交编排器补跑:${problems.slice(0, 3).join("; ")}`.slice(0, 1000);
  appendHookLog(runDir, { ts: ts(), hook: "stop", stage, attempt: ctx.attempt, decision: "stop", reason: stopReason, stop_hook_active: !!input.stop_hook_active, calcCount: cur.count, calcFp: cur.fp, idleStreak });
  process.stdout.write(JSON.stringify({ continue: false, stopReason, systemMessage: stopReason }));
}

/** 统计 calcs/ 下**合法计算记录**:条数 + 整套 calculation_id(排序后)的指纹。
 * 合法 = JSON 可解析且 calculation_id 为非空 string。
 * 🔴 这比 merge.ts 的 loadCalcs **严得多**,别照它对齐:loadCalcs 只要 JSON 能解析就收一条
 * (连 args_*.json 这种参数文件都会进 calculations.json)。按那个口径判推进,PR #46 防"用无意义
 * 写盘刷掉预算"的整条属性当场作废 —— agent 写个参数文件就算一次推进。
 * 取舍是刻意的:这里判的是"有没有真算出东西",不是"合并时收哪些文件"。
 * agent 往 calcs/ 写的临时参数文件(args 前缀、sq 前缀)、function 清单(无 calculation_id)不算,
 * 这正是"仅看 mtime 会误判推进"被排除的原因。
 * 指纹只用于"和上一次拦截比有没有变",不进产物、不参与任何安全判定,sha1 足够。 */
function validCalcs(runDir: string): { count: number; fp: string } {
  const dir = path.join(runDir, "calcs");
  const ids: string[] = [];
  // 目录不存在与目录空着要给出同一个指纹:否则"编排器刚建好空 calcs/"会被当成一次推进,白送一轮预算
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    // 点开头的文件一律不算:合法计算文件名由 run_tools 的 CALC_FILE_RE 限成 NN_name.json,
    // 且 fsutil.listFiles(产物侧读 calcs/ 的唯一入口)也跳过点文件 —— 两边口径要齐
    if (f.startsWith(".") || !f.endsWith(".json")) continue;
    let rec: unknown;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (rec && typeof rec === "object" && typeof (rec as { calculation_id?: unknown }).calculation_id === "string"
      && (rec as { calculation_id: string }).calculation_id.length > 0) ids.push((rec as { calculation_id: string }).calculation_id);
  }
  ids.sort();
  return { count: ids.length, fp: crypto.createHash("sha1").update(ids.join("\n")).digest("hex").slice(0, 16) };
}

main().catch((e) => { process.stderr.write(`[vibe stop hook] 顶层异常,放行:${e instanceof Error ? e.message : String(e)}\n`); }).finally(() => process.exit(0));
