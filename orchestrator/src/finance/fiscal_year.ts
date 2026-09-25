/**
 * **金融的"基准期 T"**:语义槽位里 `fy: "T"` / `"T+2"` 指的是哪一年。
 *
 * 取 `fetch_estimates.extra.current_fy`(形如 FY2026);缺失则退回一致预期证据里最早的财年。
 * 换个垂类"基准期"可能是营业年度、季度、甚至一次活动 ⇒ 规则进包(`Plugin.baselinePeriod`)。
 */
import type { RunView } from "../validator.ts";

export function financeBaselinePeriod(run: RunView): number | null {
  const raw = (run.fetch["fetch_estimates"]?.extra as Record<string, unknown> | undefined)?.current_fy;
  const m = /(\d{4})/.exec(String(raw ?? ""));
  if (m) return Number(m[1]);
  const ys = [...run.evidence.values()]
    .filter((e) => e.field === "eps_consensus_mean")
    .map((e) => Number((/(\d{4})/.exec(e.period) ?? [])[1]))
    .filter((n) => !Number.isNaN(n));
  return ys.length ? Math.min(...ys) : null;
}
