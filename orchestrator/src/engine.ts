/**
 * **引擎契约**(Core)。
 *
 * 一次运行 = 六阶段状态机 + 一个引擎。状态机、取数、校验、gate、归档全部与引擎无关且只有一份;
 * 引擎负责的只有两件事:**准备/拆除它自己需要的环境**(EngineLifecycle)与**跑一个 turn**(见 agent_runner.ts 的 AgentRunner)。
 *
 * 🔴 **为什么要有 capabilities 这一层**:两个引擎产出**相同的产物**,但**执行保障等级不同**。
 *    Codex 有引擎级线程、沙箱、lifecycle hooks;直连只能保证"模型只够得着那几个受控工具"。
 *    validator 挡得住不合格产物,**挡不住**上下文溢出丢阶段、断流重试重复执行工具、产物来自上一轮残留。
 *    ⇒ 差异必须**显式声明**并写进 manifest,让界面把「产物通过校验」与「执行保障等级」分开讲。
 *    把两者混成一个 ✅ 是这套双引擎设计里最危险的失败模式(见 双引擎架构方案_v2 §1)。
 *
 * ⚠️ 划分判据只有一句:**换个引擎这段要不要重写?要重写就进 EngineLifecycle。**
 *    反例:每个 turn 前写的「turn 上下文」(stage/attempt)看着像 hooks 的一部分,其实是**受控工具**
 *    判断当前阶段的依据(run_tools_mcp.ts 的 currentStage 从磁盘读它),两个引擎都需要 ⇒ 留在编排器,不进 lifecycle。
 */
import type { Stage } from "./config.ts";

/** 引擎能力声明:原样写进 manifest.engine.capabilities,并回给界面 */
export interface EngineCapabilities {
  /** 引擎种类 */
  kind: "codex" | "direct" | "local_agent";
  /** 与模型对话的线路协议 */
  protocol: "responses" | "chat_completions" | "cli_subscription";
  /**
   * 宿主隔离方式。
   * - `seatbelt_readonly`:引擎自带的操作系统级沙箱
   * - `model_has_no_host_access`:没有沙箱,模型根本拿不到执行宿主命令的工具(工具白名单即边界)
   * ⚠️ 后者不是前者的等价物,只是**另一种**限制方式,不要在文案里混为一谈。
   */
  sandbox: "seatbelt_readonly" | "model_has_no_host_access";
  /** 是否有引擎级 lifecycle hooks(Stop / PreToolUse) */
  hooks: boolean;
  /** 跨阶段上下文怎么传:引擎线程,还是每阶段独立会话 + 靠已校验的磁盘产物传递 */
  contextStrategy: "thread" | "per_stage_session";
  /** 结构化输出:服务端 JSON Schema 约束,还是只能写进提示词 */
  structuredOutput: "server_schema" | "prompt";
  /**
   * 审计等级。
   * - `engine_events`:事件来自引擎自身的事件流(模型请求与工具执行都由引擎记录)
   * - `host_events`:事件由本产品在宿主侧记录(拿不到引擎内部视角)
   */
  auditLevel: "engine_events" | "host_events";
  /** 方法论来源；Direct 六阶段只有阶段提示，不能冒充已加载产品宪法与专用 skills。 */
  methodology: "constitution_and_skills" | "stage_prompt_only";
}

/** 一次运行实际选中的引擎信息；用于写 manifest，不能再从配置默认值反推。 */
export interface EngineRuntime {
  kind: EngineCapabilities["kind"];
  version: string;
  binary: string | null;
  model: string | null;
  codexPath: string | null;
  codexHome: string | null;
}

/** lifecycle 能碰的编排器内部能力(只给这些,不把整个编排器交出去) */
export interface LifecycleContext {
  log: (stage: Stage | "orchestrator", type: string, payload?: Record<string, unknown>) => void;
  /** 把运行目录下的相对路径登记为受保护文件(篡改会被 validator 抓到) */
  markProtected: (rel: string) => void;
  /** 取消登记(故障注入场景会主动移除某个受保护文件) */
  unmarkProtected: (rel: string) => void;
  /** 往 manifest 上挂本引擎自己的字段;只允许写 lifecycle 自己那几个键 */
  manifest: Record<string, unknown>;
}

/**
 * 引擎生命周期。
 *
 * 调用时序(每次运行一次 prepare,每个 turn 一对 beforeTurn/afterTurn):
 *   prepare → [beforeTurn → (turn) → afterTurn] × N → dispose
 */
export interface EngineLifecycle {
  readonly capabilities: EngineCapabilities;
  /** 运行开始:准备本引擎需要的环境。失败必须抛 —— 这类失效引擎自己不会报错(只是宪法/技能不在提示词里) */
  prepare(ctx: LifecycleContext): void;
  /** 每个 turn 前 */
  beforeTurn(ctx: LifecycleContext, stage: Stage, attempt: number): void;
  /** 每个 turn 后。返回非 null = 该 turn 判失败(理由用于事件与重试决策) */
  afterTurn(ctx: LifecycleContext, stage: Stage, attempt: number): string | null;
  /** 运行结束(正常或异常);实现必须容错,不得因清理失败让整次运行失败 */
  dispose?(ctx: LifecycleContext): void;
}

/** 什么都不做的 lifecycle:`--no-agent` 干跑用(只跑编排与校验,不拉起任何模型) */
export function noopLifecycle(capabilities: EngineCapabilities): EngineLifecycle {
  return {
    capabilities,
    prepare() { /* 干跑不需要任何引擎环境 */ },
    beforeTurn() { /* 同上 */ },
    afterTurn() { return null; },
  };
}
