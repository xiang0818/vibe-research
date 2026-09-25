/**
 * **Codex 引擎的生命周期**:指令发现链 + skills 隔离 + lifecycle hooks。
 *
 * 这三样**只有 Codex 需要**——它们写的都是产品 CODEX_HOME 下的配置,直连引擎一个字节都不该碰。
 * 从 orchestrate.ts 原样搬来(行为逐字保持),搬动的理由见 engine.ts 文件头的划分判据。
 *
 * ⚠️ **没搬 turn 上下文的写入**(`writeHookContext`):它看着属于 hooks,实际是**受控工具**判断
 * 当前阶段的依据(run_tools_mcp.ts:38 的 currentStage 从磁盘读它),两个引擎都要 ⇒ 留在编排器。
 * 这里只保留 hooks 自己的那半:每 turn 前清终止标记、每 turn 后汇总钩子日志。
 */
import type { EngineCapabilities, EngineLifecycle, LifecycleContext } from "../engine.ts";
import type { RunConfig, Stage } from "../config.ts";
import { clearStopFailed, installHooks, readHookLog, readStopFailed, summarizeHookLog, uninstallHooks } from "../hooks.ts";
import { ensureInstructionsRoot } from "../instructions_root.ts";
import { installSkillsIsolation } from "../skills_isolation.ts";

/** Codex 的能力声明。结构化输出模式由调用方按 provider 判定后传入(providers.ts 的 structuredOutputMode)。 */
export function codexCapabilities(cfg: RunConfig, structuredOutput: "server_schema" | "prompt"): EngineCapabilities {
  return {
    kind: "codex",
    protocol: "responses",   // 引擎已彻底移除 chat 协议(providers.ts 有硬拦截与出处)
    sandbox: "seatbelt_readonly",
    hooks: cfg.hooksEnabled,
    contextStrategy: "thread",   // 一次运行 = 一个引擎线程,每阶段一个 turn
    structuredOutput,
    auditLevel: "engine_events",
    methodology: "constitution_and_skills",
  };
}

export class CodexEngineLifecycle implements EngineLifecycle {
  readonly capabilities: EngineCapabilities;
  private readonly cfg: RunConfig;

  constructor(cfg: RunConfig, capabilities: EngineCapabilities) {
    this.cfg = cfg;
    this.capabilities = capabilities;
  }

  prepare(ctx: LifecycleContext): void {
    const cfg = this.cfg;
    // skills 隔离(执行层,常开):把用户主目录 ~/.agents/skills 与捆绑系统 skills 从产品 CODEX_HOME 的 catalog 里禁掉,只留产品 .agents/skills(skills_isolation.ts)
    // 指令发现链:写 project root marker + project_root_markers 配置(分离安装时先把宪法与技能同步到数据根),
    // 再逐条校验链路。不通过直接抛 —— 这类失效引擎全程不报错,只是宪法与技能不在提示词里(instructions_root.ts)。
    const ins = ensureInstructionsRoot(cfg);
    ctx.manifest.instructions_root = { root: ins.root, mode: ins.mode, marker_created: ins.markerCreated, synced_files: ins.sync ? ins.sync.copied.length + ins.sync.removed.length : 0 };
    ctx.log("orchestrator", "instructions.root", { root: ins.root, mode: ins.mode, marker_created: ins.markerCreated, config_changed: ins.configChanged, synced: ins.sync ? { copied: ins.sync.copied.length, removed: ins.sync.removed.length, unchanged: ins.sync.unchanged } : null });
    const iso = installSkillsIsolation(cfg);  // cfg 含 repoRoot(产品 skill 不写入)与 python(写前 tomllib 校验)
    ctx.manifest.skills_isolation = { installed: true, config_toml: iso.configTomlPath, disabled_user_skills: iso.disabledPaths.length, bundled_disabled: iso.bundledDisabled, max_context_tokens: iso.maxContextTokens, truncated: iso.truncated };
    // 事件只记数量 + 清单哈希:events.jsonl 会经 service 层(API / MCP research_status.last_events)回给调用方,不带用户主目录下的路径清单
    ctx.log("orchestrator", "skills.isolated", { config_toml: iso.configTomlPath, disabled_user_skills: iso.disabledPaths.length, disabled_sha256: iso.disabledSha256, bundled_disabled: iso.bundledDisabled, max_context_tokens: iso.maxContextTokens, excluded_in_repo: iso.excludedInRepo, truncated: iso.truncated, toml_validated: iso.tomlValidated, changed: iso.changed });
    // 触及 Codex 截断边界(2,000 目录 / 20,000 条目)= 清单可能不完整,出声但不中断(Codex 自己也在同一边界截断、继续运行)
    if (iso.truncated) ctx.log("orchestrator", "skills.isolation_truncated", { disabled_user_skills: iso.disabledPaths.length, note: "用户级 skill 根超过 Codex 截断边界,未枚举到的 skill 也不会被 Codex 看到;如需完整隔离请清理 ~/.agents/skills 下的大目录(如 node_modules)" });

    // hooks v0(执行层):安装到产品 CODEX_HOME(hooks.json + trusted_hash),每个 turn 前写钩子上下文(受保护)
    const hooksManifest = ctx.manifest.hooks as { installed: boolean; hooks_json: string | null };
    if (!cfg.hooksEnabled) { uninstallHooks(cfg); ctx.log("orchestrator", "hooks.uninstalled", { codex_home: cfg.codexHome }); return; }
    const fault = cfg.scenario?.hook_fault;
    const inst = installHooks(cfg, process.execPath, fault === "timeout" || fault === "crash" ? fault : undefined);
    if (fault) ctx.log("orchestrator", "scenario.hook_fault", { fault });
    hooksManifest.installed = true;
    hooksManifest.hooks_json = inst.hooksJsonPath;
    ctx.log("orchestrator", "hooks.installed", { hooks_json: inst.hooksJsonPath, config_toml: inst.configTomlPath, states: inst.states });
  }

  beforeTurn(_ctx: LifecycleContext, _stage: Stage, _attempt: number): void {
    // 清掉上一轮的 Stop 终止标记;turn 上下文本身由编排器写(两引擎共用)
    if (this.cfg.hooksEnabled) clearStopFailed(this.cfg.runDir);
  }

  /** turn 后汇总钩子日志(诊断,不可信);Stop 钩子留下终止标记 → 该 turn 视为失败(缺产物不许正常收工) */
  afterTurn(ctx: LifecycleContext, stage: Stage, attempt: number): string | null {
    const cfg = this.cfg;
    if (!cfg.hooksEnabled) return null;
    const sum = summarizeHookLog(readHookLog(cfg.runDir));
    Object.assign(ctx.manifest.hooks as Record<string, unknown>, sum);
    ctx.log(stage, "hooks.summary", { attempt, ...sum });
    const marker = readStopFailed(cfg.runDir);
    if (marker && marker.stage === stage && marker.attempt === attempt) {
      ctx.log(stage, "hooks.stop_terminated", { attempt, blocks: marker.blocks, idle_streak: marker.idleStreak, problems: marker.problems.slice(0, 6) });
      // blocks = 累计拦截次数,idleStreak = 最后连续多少次拦截之间没有新增计算。
      // 只报 blocks 分不出"一直空转"和"一直在算却写不出产物",两种的补跑价值不一样。
      // 🔴 idleStreak=1 的编码含义是"上一次拦截前刚有新计算落盘"(推进即归 1),不是"有 1 次空转"——
      //    照字面印出来会把一个全程在算的 turn 说成空转,正好把要区分的两种情况说反。
      //    0 = 日志来自没有这个字段的旧版本 ⇒ **不知道**,只能不说;当成"有新计算"是在替它下结论。
      const idle = typeof marker.idleStreak !== "number" || marker.idleStreak <= 0 ? ""
        : marker.idleStreak > 1 ? `,最后连续 ${marker.idleStreak} 次无新增计算`
        : ",最后一次拦截前仍有新计算落盘";
      return `Stop 钩子终止本轮(累计拦截 ${marker.blocks} 次${idle},仍不合格):${marker.problems.slice(0, 3).join("; ")}`;
    }
    return null;
  }
}
