/** 金融 Plugin 的 Deep 对象解析：只在 composition root 注入通用任务层。 */
import { createHash } from "node:crypto";

import { DeepExecutionError, type DeepResearchTarget, type DeepTargetResolver } from "../engines/codex_deep_engine.ts";
import { reportText } from "../report_library.ts";
import type { RouteDecision } from "../task_router.ts";

const A_SHARE_RE = /^(?:0|3|4|6|8|9)\d{5}$/;
const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex");
const marketOf = (symbol: string): string => symbol.startsWith("6") ? "SH" :
  (symbol.startsWith("0") || symbol.startsWith("3")) ? "SZ" : "BJ";

export class FinanceDeepTargetResolver implements DeepTargetResolver {
  readonly #dataRoot: string;
  constructor(dataRoot: string) { this.#dataRoot = dataRoot; }

  resolveDeepTarget(route: RouteDecision): DeepResearchTarget {
    const explicit = route.materials.inputs
      .filter((item) => item.kind === "entity" && item.status === "ready")
      .map((item) => item.id);
    const reportIds: string[] = [];
    const reportRevisions: Record<string, string> = {};
    const reportSymbols = new Set<string>();
    for (const item of route.materials.inputs) {
      if (item.kind !== "report" && item.kind !== "document") continue;
      // 圈选范围里只要有一份缺失/不可读就整次拒绝。跳过它再继续会把空 reportIds
      // 解释成“未限定资料”，进而回退到同标的整库召回，越过用户明确圈选的边界。
      if (item.status !== "ready") {
        throw new DeepExecutionError("deep_start_failed", "所选资料已缺失或尚未解析完成，请刷新资料列表后重新发起任务");
      }
      const found = reportText(this.#dataRoot, item.id);
      if (!found || revisionOf(found.text) !== item.revision) {
        throw new DeepExecutionError("deep_start_failed", "资料在路由后发生变化，请重新发起任务");
      }
      reportIds.push(item.id);
      reportRevisions[item.id] = item.revision!;
      for (const symbol of found.record.symbols) reportSymbols.add(symbol);
    }
    if ([...reportSymbols].some((symbol) => !A_SHARE_RE.test(symbol))) {
      throw new DeepExecutionError("deep_unsupported_entity", "当前六阶段 Deep 研究只支持 A 股；所选材料含其它市场标的");
    }
    const candidates = new Set([...explicit, ...reportSymbols].filter((symbol) => A_SHARE_RE.test(symbol)));
    if (candidates.size === 0) {
      throw new DeepExecutionError("deep_entity_required", "Deep 六阶段研究需要一个可确认的 A 股代码；请只选择同一标的资料");
    }
    if (candidates.size !== 1) {
      throw new DeepExecutionError("deep_multiple_entities", "所选材料包含多个 A 股代码，Deep 不会猜选哪一个；请一次只选一个标的");
    }
    const symbol = [...candidates][0]!;
    return Object.freeze({ symbol, market: marketOf(symbol), reportIds: Object.freeze(reportIds),
      reportRevisions: Object.freeze(reportRevisions) });
  }
}
