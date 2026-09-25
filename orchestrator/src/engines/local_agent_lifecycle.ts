/**
 * Claude Code / WorkBuddy 订阅引擎的能力声明。
 *
 * 它们每个阶段启动一次独立 CLI 会话，不加载 Codex 的宪法 / skills / lifecycle hooks；
 * 模型唯一能触达的宿主能力是产品现有的受控 MCP 工具。
 */
import type { EngineCapabilities, EngineLifecycle } from "../engine.ts";

export function localAgentCapabilities(): EngineCapabilities {
  return Object.freeze({
    kind: "local_agent",
    protocol: "cli_subscription",
    sandbox: "model_has_no_host_access",
    hooks: false,
    contextStrategy: "per_stage_session",
    // 与 Direct 工具循环同一个已实测陷阱：工具与 --json-schema 同轮时，
    // 模型会直接产出汇报 JSON 而不调工具。因此工作轮只用提示格式，产物由 validator 强制。
    structuredOutput: "prompt",
    auditLevel: "host_events",
    methodology: "stage_prompt_only",
  });
}

export class LocalAgentEngineLifecycle implements EngineLifecycle {
  readonly capabilities: EngineCapabilities;

  constructor(capabilities: EngineCapabilities = localAgentCapabilities()) {
    this.capabilities = capabilities;
  }

  prepare(): void { /* CLI 登录与能力已在 composition root 探测 */ }
  beforeTurn(): void { /* turn context 由编排器统一写入 */ }
  afterTurn(): string | null { return null; }
}
