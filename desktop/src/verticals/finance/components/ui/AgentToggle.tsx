import { useState } from "react";
import { useAiRuntime } from "@/hooks/useAiRuntime";
import { saveExecutionMode } from "@/lib/llmStore";

/** One persisted preference shared by the sidebar and settings; connection identity is unchanged. */
export function AgentToggle({ compact = false, showHint = false }: { compact?: boolean; showHint?: boolean }) {
  const runtime = useAiRuntime();
  const enabled = runtime.config?.executionMode === "agent";
  const [error, setError] = useState("");
  return <div className="shrink-0">
    <button type="button" role="switch" aria-label="开启Agent" aria-checked={enabled}
      aria-description="开启后可使用联网、工具和多步研究，通常耗时更长、消耗更多 Token，不保证答案一定更准确。"
      disabled={runtime.status !== "ok"}
      title={runtime.status !== "ok" ? "请先接入 AI" : "关闭：普通对话；开启：联网、工具与多步研究，通常更慢、更耗 Token，不保证一定更准确。切换会停止进行中的普通聊天，不影响已启动的研究任务。"}
      onClick={() => {
        try { saveExecutionMode(enabled ? "direct" : "agent"); setError(""); }
        catch (e) { setError(e instanceof Error ? e.message : "无法保存开关，请重试"); }
      }}
      className="inline-flex min-h-6 items-center justify-center gap-2 rounded-md text-[10px] leading-4 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
      {!compact && <span className="whitespace-nowrap">开启Agent</span>}
      <span aria-hidden="true" className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors ${enabled ? "border-primary bg-primary" : "border-muted-foreground/40 bg-muted"}`}>
        <span className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-[14px]" : "translate-x-[3px]"}`} />
      </span>
      {!compact && showHint && <span className="text-[9px] whitespace-nowrap">（更深入·较慢·费Token）</span>}
    </button>
    {error && <p role="alert" className="max-w-40 text-[10px] text-destructive">{error}</p>}
  </div>;
}
