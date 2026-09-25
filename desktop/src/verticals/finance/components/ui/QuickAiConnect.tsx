import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, LoaderCircle, Sparkles, Terminal, X } from "lucide-react";
import { ApiError, backend, friendlyAgentError } from "@/lib/backend";
import { LLM_KEY, saveUserLlm } from "@/lib/llmStore";
import { subscriptionConfig, testAndSaveAi } from "@/lib/aiConnection";

const OPTIONS = [
  { provider: "cli-codex", label: "Codex订阅版", detail: "使用产品专用的 Codex 登录", badge: "推荐" },
  { provider: "cli-claude", label: "Claude订阅", detail: "使用本机 Claude Code 登录" },
  { provider: "cli-codebuddy", label: "WorkBuddy CLI", detail: "使用本机 WorkBuddy / CodeBuddy 登录" },
];

export function QuickAiConnect({ onDismiss, storageStatus }: { onDismiss: () => void; storageStatus: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [needsCodexLogin, setNeedsCodexLogin] = useState(false);
  const [loginHint, setLoginHint] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { inFlight.current?.abort(); node?.close(); };
  }, []);
  const dismiss = () => { inFlight.current?.abort(); onDismiss(); };
  const connect = async (provider: string) => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(provider); setError(""); setNeedsCodexLogin(false); setLoginHint("");
    try {
      await testAndSaveAi(subscriptionConfig(provider), {
        read: () => localStorage.getItem(LLM_KEY), probe: backend.llmProbe, save: saveUserLlm,
      }, controller.signal);
      onDismiss();
    } catch (e) {
      if (!controller.signal.aborted) {
        const label = OPTIONS.find((option) => option.provider === provider)!.label;
        const requiresLogin = provider === "cli-codex" && e instanceof ApiError
          && (e.code === "agent_not_ready" || e.code === "agent_not_authenticated");
        setNeedsCodexLogin(requiresLogin);
        setError(requiresLogin
          ? "Codex订阅版：此工作台尚未完成有效登录。它使用独立的产品登录，不会自动读取 Codex App 的账号。"
          : `${label}：${friendlyAgentError(e)}`);
      }
    } finally {
      if (!controller.signal.aborted) { inFlight.current = null; setBusy(""); }
    }
  };
  const loginCodex = async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy("codex-login"); setError(""); setLoginHint("");
    try {
      await backend.startCodexLogin(controller.signal);
      if (!controller.signal.aborted) setLoginHint("请在浏览器中完成 Codex 登录，然后返回这里点击「登录后重新测试」。测试成功后才会保存接入方式。");
    } catch (e) {
      if (!controller.signal.aborted) setError(`Codex订阅版：${friendlyAgentError(e)}`);
    } finally {
      if (!controller.signal.aborted) { inFlight.current = null; setBusy(""); }
    }
  };
  return (
    <dialog ref={dialog} aria-labelledby="quick-ai-title" aria-describedby="quick-ai-description"
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-primary/30 bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm">
      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-3">
          <span className="rounded-xl border border-primary/20 bg-primary/10 p-3 text-primary"><Sparkles className="h-6 w-6" /></span>
          <button type="button" onClick={dismiss} aria-label="暂不接入，先浏览" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>
        <h2 id="quick-ai-title" className="mt-5 text-2xl font-semibold">请接入AI</h2>
        <p id="quick-ai-description" className="mt-2 text-sm leading-6 text-muted-foreground">选择已有订阅，点击即可测试接入。连接成功后，直接开始研究。</p>
        {storageStatus === "broken" && <p role="alert" className="mt-3 text-xs text-destructive">原有配置无法读取，请重新接入；测试失败不会覆盖原配置。</p>}
        {storageStatus === "unavailable" && <p role="alert" className="mt-3 text-xs text-destructive">浏览器阻止了本地存储。请允许此页面保存配置后再连接。</p>}
        <div className="mt-6 space-y-2">
          {OPTIONS.map(({ provider, label, detail, badge }) => (
            <button key={provider} type="button" data-connect-provider={provider} disabled={Boolean(busy) || storageStatus === "unavailable"}
              onClick={() => void connect(provider)} className="group flex w-full items-center gap-3 rounded-xl border border-border bg-muted/20 p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-wait disabled:opacity-60">
              {busy === provider ? <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-primary" /> : <Terminal className="h-5 w-5 shrink-0 text-primary" />}
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{label}{badge && <span className="ml-2 text-[10px] font-normal text-primary">{badge}</span>}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{busy === provider ? "正在检测并测试连接…" : detail}</span></span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
            </button>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-5 text-muted-foreground">测试会发送一条简短探针，使用所选订阅额度，不读取私人研究资料。</p>
        {busy && <p role="status" className="mt-3 text-sm text-primary">{busy === "codex-login" ? "正在打开 Codex 登录…" : "正在实测连接，请稍候…"}</p>}
        {error && <p role="alert" className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm leading-6 text-destructive">{error}{!needsCodexLogin && " 可到其他接入方式查看登录与安装说明。"}</p>}
        {loginHint && <p role="status" className="mt-3 text-sm leading-6 text-primary">{loginHint}</p>}
        {needsCodexLogin && <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={Boolean(busy)} onClick={() => void loginCodex()} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60">登录 Codex</button>
          <button type="button" disabled={Boolean(busy)} onClick={() => void connect("cli-codex")} className="rounded-lg border border-primary/40 px-4 py-2 text-sm text-primary disabled:opacity-60">登录后重新测试</button>
        </div>}
        <Link to="/settings" onClick={dismiss} className="mt-5 flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm hover:bg-muted/50">
          <span>其他接入方式<span className="mt-1 block text-xs text-muted-foreground">DeepSeek、MiMo 等 API · 登录与安装帮助</span></span><ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </dialog>
  );
}
