import { Link } from "react-router-dom";
import { Flame, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import sectorsData from "@/data/sectors.json";

/**
 * 板块中心 —— **只列已核实环节的板块**。
 *
 * 🔴 数据文件里还有十几个只有名字、没有环节的板块。产品决定**不做逐赛道看板**
 *    (产业维度靠取数层的产业标签,不靠这里画卡片)⇒ 那些不进展示。
 *    摆着一堆写「环节梳理中」的卡片,等于向用户承诺一件不打算做的事 ——
 *    与"把没接上渲染成暂无数据"是同一类问题。
 * ⚠️ **数据文件一行没动**:哪天要放开,把 `verified` 打开即可,这里自动出现。
 */
export function Sectors() {
  const sectors = sectorsData.sectors.filter((s) => s.verified);
  const hotCount = sectors.filter((s) => s.hot).length;

  useAiPage({
    key: "sectors",
    title: "板块中心",
    context:
      `板块中心 · 已核实 ${sectors.length} 条产业链骨架（其中标热门 ${hotCount} 条）。只有环节，不含标的：\n` +
      sectors.map((s) => `- ${s.label}：${s.tagline}｜环节 ${s.nodes.length} 个`).join("\n"),
    suggestions: ["这几条链哪条更值得看", "帮我比较一下它们的环节结构", "还缺哪些环节"],
  });

  return (
    <div>
      <PageHeader
        title="板块中心"
        subtitle={`${sectors.length} 个赛道的产业链骨架 · 只有环节，不含标的`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sectors.map((s) => (
          <Link key={s.key} to={`/sectors/${s.key}`}>
            <GlassCard glow={s.hot} className="flex h-full flex-col justify-between">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <h3 className="text-base font-bold">{s.label}</h3>
                  {s.hot && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      <Flame className="h-3 w-3" /> 热门
                    </span>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{s.tagline}</p>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3 text-xs">
                <span className="text-muted-foreground">
                  {s.verified ? `${s.nodes.length} 个环节` : "环节梳理中"}
                </span>
                <ChevronRight className="h-4 w-4 text-primary" />
              </div>
            </GlassCard>
          </Link>
        ))}
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground/60">
        共 {sectors.length} 个板块，其中 {hotCount} 个热门 · 环节均经实时核实，不靠模型记忆编
      </p>
      <Disclaimer />
    </div>
  );
}
