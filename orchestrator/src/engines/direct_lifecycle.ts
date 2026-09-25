/**
 * **直连引擎的生命周期**:什么都不准备。
 *
 * 这个"空"不是占位,而是**本引擎的定义本身** —— 直连不经 Codex 二进制,
 * 因此指令发现根、skills 隔离、lifecycle hooks、CODEX_HOME 配置**一个都不该碰**。
 * 有探针测试盯着:调完 prepare 之后 CODEX_HOME 必须仍然不存在(engine_boundary.test.ts)。
 *
 * 🔴 **能力差异必须如实声明,不许往高了报**:
 * - `sandbox: model_has_no_host_access` —— 没有操作系统级沙箱。模型够不着宿主命令,
 *   靠的是**它只拿到那几个受控工具**,而不是被沙箱关住。这两者不是一回事,文案里不能混。
 * - `auditLevel: host_events` —— 事件由本产品在宿主侧记录,拿不到引擎内部视角。
 * - `contextStrategy: per_stage_session` —— 每阶段独立会话,状态靠**已校验的磁盘产物**传递。
 *   不是省事:providers/deepseek.json 自己就写着无状态、忽略 previous_response_id、超上下文直接 400,
 *   长线程在这类 provider 上根本不成立;而磁盘产物本来就是真理源(validator 校验的就是它)。
 */
import type { EngineCapabilities, EngineLifecycle, LifecycleContext } from "../engine.ts";
import type { Stage } from "../config.ts";

/**
 * 直连的能力声明。
 * @param structuredOutput 由 provider 模板决定:多数国产模板只能把 schema 写进提示词("prompt")。
 *   ⚠️ 降级只损**命中率**不损正确性(产物仍由 validator 校验),但**不能顺手把校验也省掉**。
 */
export function directCapabilities(structuredOutput: "server_schema" | "prompt"): EngineCapabilities {
  return {
    kind: "direct",
    protocol: "chat_completions",   // Codex 引擎已移除 chat 协议,而绝大多数兼容网关只有这条线
    sandbox: "model_has_no_host_access",
    hooks: false,
    contextStrategy: "per_stage_session",
    structuredOutput,
    auditLevel: "host_events",
    methodology: "stage_prompt_only",
  };
}

export class DirectEngineLifecycle implements EngineLifecycle {
  readonly capabilities: EngineCapabilities;

  constructor(capabilities: EngineCapabilities) {
    this.capabilities = capabilities;
  }

  prepare(_ctx: LifecycleContext): void {
    // 刻意为空:直连不需要任何引擎侧环境准备。
    // ⚠️ 将来若有人想在这里"顺手"复用 Codex 的指令发现根或 skills 隔离 —— 那意味着直连又依赖上了
    //    CODEX_HOME,容器部署会因为找不到 codex 二进制而炸,而本机跑起来一切正常(最难查的那类)。
  }

  beforeTurn(_ctx: LifecycleContext, _stage: Stage, _attempt: number): void {
    // 无 lifecycle hooks:没有需要在 turn 前清理的引擎侧状态。
    // turn 上下文(stage/attempt)由编排器写,两个引擎共用 —— 不在这里。
  }

  afterTurn(_ctx: LifecycleContext, _stage: Stage, _attempt: number): string | null {
    // 无 Stop 钩子。turn 成败由 StageAgent 的返回与 validator 判定,这里没有额外的失败来源。
    return null;
  }
}
