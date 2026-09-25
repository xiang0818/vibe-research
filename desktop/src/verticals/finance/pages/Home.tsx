import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { FinanceHomeAgent } from "@/components/ui/FinanceAiDock";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { useAiPage } from "../../../core/ai/pageContext";
import { HOME_FEATURE_GROUPS } from "@/lib/homeFeatures";

export function Home() {
  useAiPage({
    key: "home", title: "首页",
    context: "这是 Vibe Research 首页，可以直接与本地 Agent 交流，联网查证，或进入各项研究功能。",
    suggestions: ["今天市场有哪些变化", "帮我研究一家公司的基本面", "哪些风险需要重点核对"],
  });
  return (
    <div>
      <h1 className="sr-only">Vibe Research 研究工作台</h1>
      <FinanceHomeAgent />
      <section id="home-features" className="mt-5" aria-labelledby="feature-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Workbench</p><h2 id="feature-heading" className="mt-1 text-lg font-bold">研究工具，一站直达</h2></div>
          <span className="text-xs text-muted-foreground">常用功能</span>
        </div>
        <div data-feature-grid className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {HOME_FEATURE_GROUPS.map((group, index) => (
            <div key={group.title} data-feature-category className="glass min-w-0 rounded-xl border border-primary/20 p-3">
              <div className="mb-2 flex items-center gap-2 border-b border-primary/15 pb-2">
                <span className="text-[10px] font-medium text-primary">0{index + 1}</span>
                <h3 className="text-[13px] font-semibold">{group.title}</h3>
              </div>
              <div className="grid gap-1.5">
                {group.features.map(({ to, title, detail }) => (
                  <Link key={to} to={to} title={detail} className="group flex min-h-10 items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 transition-colors hover:border-primary/40 hover:bg-primary/[0.06]">
                    <span className="min-w-0 flex-1 text-xs font-medium group-hover:text-primary">{title}</span>
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <Disclaimer />
    </div>
  );
}
