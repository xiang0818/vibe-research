#!/usr/bin/env node
/**
 * PreToolUse 钩子(Codex lifecycle hook,agent 每次 shell(Bash)/ apply_patch 调用执行前同步调用;stdin = PreToolUseCommandInput JSON,cwd = 运行目录)。
 * 复用编排器的行为规则 checkAgentTrace:自跑取数脚本 / 读禁区(交接资料、既有研究、../)/ 主目录外路径 / 改写受保护产物 → {"decision":"block","reason":...}。
 * 另拦:联网类命令(curl / wget / pip install / git clone 等——本线程无网络,但显式拦截比等它失败更清楚)。任何异常都放行并记日志。
 */
import path from "node:path";

import fs from "node:fs";

import { appendHookLog, contextMatchesCwd, readHookContext, readStdin } from "../src/hooks.ts";
import { checkAgentTrace } from "../src/validator.ts";


// **composition root**:钩子是独立子进程,也是一个入口 —— 垂类包要在这里注册
import "../src/finance/register.ts";
interface PreToolUseInput { cwd: string; tool_name: string; tool_input: Record<string, unknown>; hook_event_name?: string }

const NETWORK_RE = /(^|[\s;&|(])(curl|wget|pip3?\s+install|python3?\s+-m\s+pip\s+install|git\s+(clone|fetch|pull|push)|nc|ssh|scp|rsync)\b/;
const PROTECTED_DIRS = new Set(["fetch", "raw", ".vibe"]);
const PROTECTED_FILES = new Set(["_ledger.json", "conflicts.json", "manifest.json", "events.jsonl"]);
/** apply_patch 文本里的目标文件(*** Update/Add/Delete File: <path>;Move to: <path>) */
function patchPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*([^\n\\"]+)/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/\*\*\*\s+Move to:\s*([^\n\\"]+)/g)) out.push(m[1].trim());
  return out;
}

async function main(): Promise<void> {
  let input: PreToolUseInput;
  try { input = JSON.parse(await readStdin()) as PreToolUseInput; } catch (e) { process.stderr.write(`[vibe pre_tool_use hook] stdin 不是合法 JSON:${e instanceof Error ? e.message : String(e)}\n`); return; }
  const runDir = input.cwd;
  const ctx = readHookContext(runDir);
  if (!ctx || !contextMatchesCwd(ctx, runDir)) {
    // 不是本编排器的运行目录 → 不干预;是运行目录但上下文缺失 / 被改 → 出声(日志 + stderr),放行交编排器受保护产物校验处理
    if (fs.existsSync(path.join(runDir, "manifest.json"))) { appendHookLog(runDir, { ts: new Date().toISOString(), hook: "pre_tool_use", decision: "error", tool: input.tool_name, reason: !ctx ? "钩子上下文缺失(被删?)" : "钩子上下文与 cwd 不一致(被改?)" }); process.stderr.write("[vibe pre_tool_use hook] 无有效钩子上下文,放行\n"); }
    return;
  }
  const cfg = { forbiddenPathPatterns: ctx.forbidden_path_patterns, allowedPathPrefixes: ctx.allowed_path_prefixes, runDir: ctx.run_dir, scriptsRel: ctx.scripts_rel };
  const reasons: string[] = [];
  let command = "";
  try {
    if (input.tool_name === "Bash") {
      command = String(input.tool_input?.command ?? "");
      const r = checkAgentTrace({ commands: [command], fileChanges: [] }, cfg);
      reasons.push(...r.errors);
      if (NETWORK_RE.test(command)) reasons.push("命令疑似联网(curl / wget / pip / git 远程等):本线程无网络,取数已由编排器完成,不要联网");
    } else if (input.tool_name === "apply_patch") {
      const text = JSON.stringify(input.tool_input ?? {});
      command = text.slice(0, 200);
      const abs = path.resolve(runDir);
      for (const rel of patchPaths(text)) {
        const p = path.resolve(runDir, rel);
        if (!p.startsWith(abs + path.sep)) { reasons.push(`补丁写到运行目录之外:${rel}(仓库代码 / 契约 / skills 只读)`); continue; }
        const inside = path.relative(abs, p).split(path.sep);
        if (PROTECTED_DIRS.has(inside[0]) || PROTECTED_FILES.has(path.basename(p))) reasons.push(`补丁触及受保护产物 ${rel}(fetch/ raw/ .vibe/ 账本 / 冲突集 / manifest / events 由编排器持有):只允许写 RUN/calcs/ RUN/stages/ RUN/report.md`);
      }
    } else {
      return;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendHookLog(runDir, { ts: new Date().toISOString(), hook: "pre_tool_use", stage: ctx.stage, attempt: ctx.attempt, decision: "error", tool: input.tool_name, reason: msg });
    process.stderr.write(`[vibe pre_tool_use hook] 校验异常,放行:${msg}\n`);
    return;
  }
  if (reasons.length) {
    const reason = `【PreToolUse 钩子】该调用违反研究纪律,已拦截:\n- ${reasons.join("\n- ")}`.slice(0, 1500);
    appendHookLog(runDir, { ts: new Date().toISOString(), hook: "pre_tool_use", stage: ctx.stage, attempt: ctx.attempt, decision: "block", tool: input.tool_name, command: command.slice(0, 4000), reason });
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return;
  }
  appendHookLog(runDir, { ts: new Date().toISOString(), hook: "pre_tool_use", stage: ctx.stage, attempt: ctx.attempt, decision: "allow", tool: input.tool_name, command: command.slice(0, 4000) });
}

main().catch((e) => { process.stderr.write(`[vibe pre_tool_use hook] 顶层异常,放行:${e instanceof Error ? e.message : String(e)}\n`); }).finally(() => process.exit(0));
