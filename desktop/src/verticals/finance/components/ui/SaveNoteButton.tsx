import { useState } from "react";
import { Check, BookmarkPlus, AlertCircle } from "lucide-react";
import { addNote } from "@/lib/notes";

/**
 * 把一段 AI 结果存入「研究记录」（沉淀）—— 落**用户自有台账**，不是浏览器缓存。
 *
 * 🔴 写是异步的：**存成功了才显示"已存入"**。
 *    先前是 `addNote(...); setSaved(true)` 一起执行 —— 写失败照样显示成功，
 *    用户以为存下了、关掉页面才发现没有，这种谎比报错难查得多。
 */
export function SaveNoteButton({ kind, title, content }: { kind: string; title: string; content: string }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [err, setErr] = useState("");
  if (!content.trim()) return null;
  const save = async () => {
    setState("saving");
    try {
      await addNote(kind, title, content);
      setState("saved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("failed");
    }
  };
  return (
    <button
      onClick={save}
      disabled={state === "saving" || state === "saved"}
      title={err || undefined}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-60"
    >
      {state === "saved" ? (<><Check className="h-3.5 w-3.5" /> 已存入沉淀</>)
        : state === "failed" ? (<><AlertCircle className="h-3.5 w-3.5 text-destructive" /> 没存上，点这里重试</>)
        : state === "saving" ? (<><BookmarkPlus className="h-3.5 w-3.5" /> 存入中…</>)
        : (<><BookmarkPlus className="h-3.5 w-3.5" /> 存入沉淀</>)}
    </button>
  );
}
