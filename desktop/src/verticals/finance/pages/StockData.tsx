import { useRef, useState } from "react";
import {
  Search, FileText, Newspaper, Loader2, AlertCircle, LineChart, BarChart3, Megaphone,
  Wallet, Trophy, CalendarClock, Boxes, MessageSquare,
} from "lucide-react";
import { backend } from "@/lib/backend";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAiPage } from "../../../core/ai/pageContext";
import { GlassCard } from "@/components/ui/GlassCard";
import { EarningsSnapshot } from "@/components/ui/EarningsSnapshot";
import { ThesisPanel } from "@/components/ui/ThesisPanel";
import { Disclaimer } from "@/components/ui/Disclaimer";
import {
  api, ApiError, type Valuation, type Report, type NewsItem, type ValPercentile, type ValMetric,
  type Financials, type Announcement, type MarginRow, type BlockTradeRow, type HolderRow,
  type DividendRow, type FundFlowRow, type DragonTiger, type Lockup, type Blocks, type HotConcept, type QaRow,
  type GlobalStock, type HkCashflow,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// 金额格式化（后端资金单位：元 / 万元）
const yi = (v: number | null) => v == null ? "—" : `${(v / 1e8).toFixed(2)} 亿`;

const fmt = (v: number | null | undefined, suffix = "") =>
  v === null || v === undefined ? "—" : `${v}${suffix}`;

// A股红涨绿跌（中国平台看美港股也用此惯例）
const pctColor = (p: number | null | undefined) =>
  p != null && p > 0 ? "text-danger" : p != null && p < 0 ? "text-success" : "text-muted-foreground";
const pctStr = (p: number | null | undefined) => (p == null ? "—" : `${p > 0 ? "+" : ""}${p}%`);
// 美/港股金额（原生币种）
const curOf = (market: string) => (market === "HK" ? "港元" : market === "KR" ? "韩元" : "美元");
const mktName = (m: string) => (m === "HK" ? "港股" : m === "KR" ? "韩股" : "美股");
const bigMoney = (v: number | null, market: string) =>
  v == null ? "—" : v >= 1e12 ? `${(v / 1e12).toFixed(2)} 万亿${curOf(market)}` : `${(v / 1e8).toFixed(0)} 亿${curOf(market)}`;
const round2 = (v: number | null | undefined, suffix = "") =>
  v == null ? "—" : `${Math.round(v * 100) / 100}${suffix}`;

// 百分比：后端偶发给 null/缺字段时显示 —，不出现 "NaN%" / 误导性 "0.00%"
const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toFixed(2)}%`;

// 小指标块（复用于资金面/筹码卡）
function Metric({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="mt-0.5 font-mono text-base font-bold">{v}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// 估值历史分位带（理杏仁式）：绿=低估区 / 灰=合理区 / 红=高估区；只给位置，不划买卖。
function ValBand({ label, m }: { label: string; m: ValMetric }) {
  const span = Math.max(m.max - m.min, 1e-6);
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - m.min) / span) * 100));
  const p20 = pos(m.p20), p80 = pos(m.p80), cur = pos(m.current);
  const zoneColor = m.percentile < 20 ? "text-success" : m.percentile > 80 ? "text-danger" : "text-muted-foreground";
  const zoneLabel = m.percentile < 20 ? "低估区" : m.percentile > 80 ? "高估区" : "合理区";
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-1 text-sm">
        <span className="font-medium">{label} <span className="text-xs text-muted-foreground/60">{m.n} 点</span></span>
        <span className="text-muted-foreground">当前 <b className="font-mono text-foreground">{m.current}</b> · 近5年 <b className={cn("font-mono", zoneColor)}>{m.percentile}%</b> 分位（<span className={zoneColor}>{zoneLabel}</span>）</span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full">
        <div className="absolute inset-0 flex">
          <div className="bg-success/35" style={{ width: `${p20}%` }} />
          <div className="bg-muted" style={{ width: `${p80 - p20}%` }} />
          <div className="flex-1 bg-danger/35" />
        </div>
        <div className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded bg-foreground shadow" style={{ left: `${cur}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground/60">
        <span>低 {m.min}</span><span>20% {m.p20}</span><span>中 {m.p50}</span><span>80% {m.p80}</span><span>高 {m.max}</span>
      </div>
    </div>
  );
}

export function StockData() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [val, setVal] = useState<Valuation | null>(null);
  /**
   * 消化年数的**四情景**。
   * 🔴 不在前端算 —— 调 Core 的确定性计算库（`/tool/calc`）。
   *    此前界面自己写死 30 倍锚出一个数，而 `calc/` 的正式口径是四档（30/25/22/18）；
   *    于是最乐观那一档被当成了既定事实（实测 0.05 年，而 18 倍锚下是 1.14 年）。
   *    在这儿再抄一份公式，就是把"两套计算链路"这个病又种一次。
   */
  const [digest, setDigest] = useState<{ name: string; anchor: number | null; years: number | null; status: string }[] | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [pctl, setPctl] = useState<ValPercentile | null>(null);
  const [fin, setFin] = useState<Financials | null>(null);
  const [anns, setAnns] = useState<Announcement[]>([]);
  const [depNote, setDepNote] = useState<string | null>(null);
  // 资金面 / 筹码 / 信号（v3.3 并入）
  const [margin, setMargin] = useState<MarginRow[]>([]);
  const [blockT, setBlockT] = useState<BlockTradeRow[]>([]);
  const [holders, setHolders] = useState<HolderRow[]>([]);
  const [dividend, setDividend] = useState<DividendRow[]>([]);
  const [fundFlow, setFundFlow] = useState<FundFlowRow[]>([]);
  const [dt, setDt] = useState<DragonTiger | null>(null);
  const [lockup, setLockup] = useState<Lockup | null>(null);
  const [blocks, setBlocks] = useState<Blocks | null>(null);
  const [hotCon, setHotCon] = useState<HotConcept[]>([]);
  const [qa, setQa] = useState<QaRow[]>([]);
  const [gstock, setGStock] = useState<GlobalStock | null>(null);  // 美股 / 港股
  const [cashflow, setCashflow] = useState<HkCashflow | null>(null);  // 港股现金流量表（仅港股）
  const runIdRef = useRef(0);

  const run = async () => {
    const c = code.trim().toUpperCase();
    if (!c) { setErr("请输入代码"); return; }
    const rid = ++runIdRef.current;
    setLoading(true); setErr(null); setDepNote(null); setVal(null); setDigest(null); setReports([]); setNews([]); setPctl(null); setFin(null); setAnns([]);
    setMargin([]); setBlockT([]); setHolders([]); setDividend([]); setFundFlow([]); setDt(null); setLockup(null); setBlocks(null); setHotCon([]); setQa([]);
    setGStock(null); setCashflow(null);

    // 6 位纯数字 = A 股；否则（字母 / 港股短代码）走美股 / 港股（global-stock-data）
    if (!/^\d{6}$/.test(c)) {
      // 港股现金流独立回填（美股返回 404 → 静默留空，卡片不渲染）
      api.hkCashflow(c).then((cf) => { if (rid === runIdRef.current) setCashflow(cf); }).catch(() => { if (rid === runIdRef.current) setCashflow(null); });
      try {
        const g = await api.globalStock(c);
        if (rid === runIdRef.current) setGStock(g);
      } catch (e) {
        if (rid === runIdRef.current) setErr(e instanceof ApiError ? e.message : "查询失败");
      } finally {
        if (rid === runIdRef.current) setLoading(false);
      }
      return;
    }

    // A 股：竞态守卫（快速换代码时只让最新一次回填）+ 资金面/筹码独立回填、不阻塞主数据
    const ok = <T,>(set: (v: T) => void) => (v: T) => { if (rid === runIdRef.current) set(v); };
    api.margin(c).then(ok(setMargin)).catch(() => {});
    api.blockTrade(c).then(ok(setBlockT)).catch(() => {});
    api.holders(c).then(ok(setHolders)).catch(() => {});
    api.dividend(c).then(ok(setDividend)).catch(() => {});
    api.fundFlow(c).then(ok(setFundFlow)).catch(() => {});
    api.dragonTiger(c).then(ok(setDt)).catch(() => {});
    api.lockup(c).then(ok(setLockup)).catch(() => {});
    api.blocks(c).then(ok(setBlocks)).catch(() => {});
    api.hotConcepts(c).then(ok(setHotCon)).catch(() => {});
    api.investorQa(c).then(ok(setQa)).catch(() => {});
    try {
      // 行情+估值+研报+历史分位+财务+公告（新闻单独降级）
      const [v, r, p, f, a] = await Promise.all([
        api.valuation(c),
        api.reports(c).catch(() => []),
        api.percentile(c).catch(() => null),
        api.financials(c).catch(() => null),
        api.announcements(c).catch(() => []),
      ]);
      if (rid !== runIdRef.current) return;
      setVal(v);
      // ⚠️ calc 收的 cagr 是**小数**不是百分数（`|CAGR| > 5` 会直接报错）——
      //    界面的 cagr_pct 是百分数，这里必须除以 100。第一次就是漏了这步，四情景全 error。
      if (v?.pe_26e != null && v.cagr_pct != null && v.cagr_pct > 0) {
        backend
          .runTool<{ ok: boolean; result?: { details?: { scenarios?: Record<string, { value: number | null; status: string; details?: { anchor?: number } }> } } }>(
            "calc",
            { fn: "pe_digestion_scenarios", args: { pe: v.pe_26e, cagr: v.cagr_pct / 100 } },
          )
          .then((r: { ok: boolean; result?: { details?: { scenarios?: Record<string, { value: number | null; status: string; details?: { anchor?: number } }> } } }) => {
            // 🔴 慢请求回来时若已经查了别的主体,不许覆盖 —— 否则 A 的四情景会显示在 B 的名字下面
            if (rid !== runIdRef.current) return;
            const sc = r?.result?.details?.scenarios;
            if (!r?.ok || !sc) { setDigest(null); return; }
            setDigest(Object.entries(sc).map(([name, x]: [string, { value: number | null; status: string; details?: { anchor?: number } }]) => ({
              name: name.replace(/_/g, "·"),
              // 🔴 拿不到锚值就是 null,**不许写 0** —— "0 倍锚"是个看着像真的的数字
              anchor: typeof x.details?.anchor === "number" ? x.details.anchor : null,
              years: x.status === "ok" ? x.value : null,
              status: x.status,
            })));
          })
          .catch(() => { if (rid === runIdRef.current) setDigest(null); });   // 算不出就不显示这一块,不退回单点数字
      }
      setReports(r);
      setPctl(p);
      setFin(f);
      setAnns(a);
      try {
        const n = await api.news(c);
        if (rid === runIdRef.current) setNews(n);
      } catch (e) {
        if (rid === runIdRef.current && e instanceof ApiError && e.status === 501) setDepNote(e.message);
      }
    } catch (e) {
      if (rid !== runIdRef.current) return;
      setErr(e instanceof ApiError ? e.message : "查询失败");
    } finally {
      if (rid === runIdRef.current) setLoading(false);
    }
  };

  const metrics = val ? [
    { k: "现价", v: fmt(val.price) },
    { k: "PE(TTM)", v: fmt(val.pe_ttm) },
    { k: "PB", v: fmt(val.pb) },
    { k: "总市值", v: fmt(val.mcap_yi, " 亿") },
    // 🔴 标签由 base_year 拼,不写死 —— 写死会出现「数字是真的、年份是错的」
    { k: val.base_year ? `${String(val.base_year).slice(2)}E EPS` : "一致预期 EPS(基年未知)", v: fmt(val.eps_26e) },
    { k: "前向PE", v: fmt(val.pe_26e) },
    { k: "PEG", v: fmt(val.peg) },
    // 🔴 消化年数**不放在这排单点指标里** —— 它依赖"合理 PE 锚"这个假设，
    //    单独给一个数会读成事实。四情景在下面单独一块展示（见 digest）。

  ] : [];

  const aiContext = val
    ? `个股：${val.name}（${val.code}）\n现价 ${fmt(val.price)} · PE(TTM) ${fmt(val.pe_ttm)} · PB ${fmt(val.pb)} · 市值 ${fmt(val.mcap_yi, " 亿")}\n` +
      `${val.base_year ? `FY${val.base_year}` : "基年未知"} 一致预期 EPS ${val.eps_26e ?? "—"} · 前向PE ${val.pe_26e ?? "—"} · PEG ${val.peg ?? "—"} · 机构覆盖 ${val.analyst_count ?? "—"} 家\n` +
      // 🔴 消化年数按**四情景**给模型，不给单点 —— 给一个数它会当事实用，
      //    而这个数依赖"合理 PE 锚在多少倍"这个假设（30 倍 0.05 年 vs 18 倍 1.14 年）。
      (digest?.length
        ? `估值消化年数(情景,非事实;取决于合理PE锚与一致预期是否兑现)：${digest.map((d) => `${d.name}(${d.anchor === null ? "锚值未覆盖" : `${d.anchor}倍`}) ${d.years === null ? d.status : d.years.toFixed(2) + "年"}`).join("；")}\n`
        : "") +
      `⚠️ PEG 与消化年数的分母是**一致预期增速**,是整条计算里最软的假设;别把它们当确定性结论\n` +
      // 🔴 派生数(前向PE / PEG / 消化年数)自己没有证据 id,引用它们时要能指回**输入**的证据
      `派生数的输入来源：现价 ${val.price_evidence_id ?? "证据id未覆盖"}${val.quote_at ? `（${val.quote_at.slice(0, 16).replace("T", " ")}）` : ""}` +
      ` · ${val.base_year ? `FY${val.base_year}` : "基年未知"} 一致预期 EPS ${val.eps_evidence_id ?? "证据id未覆盖"}\n` +
      (pctl?.metrics.pe_ttm ? `估值历史分位(近5年)：PE-TTM 处于 ${pctl.metrics.pe_ttm.percentile}% 分位、PB 处于 ${pctl.metrics.pb?.percentile ?? "—"}% 分位\n` : "") +
      (fin?.revenue ? `财务(${fin.period ?? "—"})：营收 ${fin.revenue}(同比${fin.revenue_yoy ?? "—"})、净利 ${fin.net_profit ?? "—"}(同比${fin.net_profit_yoy ?? "—"})、ROE ${fin.roe ?? "—"}、毛利率 ${fin.gross_margin ?? "—"}\n` : "") +
      (anns.length ? `近期公告：${anns.slice(0, 5).map((a) => a.title.replace(/^[^:：]*[:：]/, "")).join("；")}\n` : "") +
      `近期研报：${reports.slice(0, 5).map((r) => r.title).join("；") || "无"}`
    : "还没查询个股。输入 6 位代码后可让 Agent 基于客观数据帮你分析。";

  const gAiContext = gstock
    ? `个股（${mktName(gstock.market)}）：${gstock.name}（${gstock.code}）\n` +
      `现价 ${gstock.quote.price ?? "—"} · 涨跌 ${pctStr(gstock.quote.change_pct)} · 总市值 ${bigMoney(gstock.quote.mcap, gstock.market)}\n` +
      (gstock.metrics
        ? `财务(${gstock.metrics.report_date})：营收 ${bigMoney(gstock.metrics.revenue, gstock.market)}(同比${round2(gstock.metrics.revenue_yoy, "%")})、归母净利 ${bigMoney(gstock.metrics.net_profit, gstock.market)}、EPS ${gstock.metrics.eps ?? "—"}、ROE ${round2(gstock.metrics.roe, "%")}、毛利率 ${round2(gstock.metrics.gross_margin, "%")}、净利率 ${round2(gstock.metrics.net_margin, "%")}、资产负债率 ${round2(gstock.metrics.debt_ratio, "%")}`
        : "")
    : "";

  // 本页不换路由就能换标的，所以 key 里要带代码，否则两只票的对话会串台。
  // ⚠️ 用**已解析结果**的代码，不是输入框里的 code —— 后者一边打字一边变，
  //    而上下文仍描述上一只票，会把旧对话存到新代码名下。
  const resolved = gstock ? `g:${gstock.code}` : val?.code ?? "";
  useAiPage(val || gstock ? {
    key: `stock:${resolved}`,
    title: `个股研究 · ${resolved}`,
    context: gstock ? gAiContext : aiContext,
    suggestions: gstock
      ? ["这家公司基本面怎么样", "盈利能力如何", "有什么风险"]
      : ["这个估值贵不贵", "机构一致预期怎么看", "近期研报的分歧点", "有什么风险"],
  } : null);

  return (
    <div>
      <PageHeader
        title="个股研究"
        subtitle="行情 · 估值 · 研报 · 新闻 —— 客观数据配齐，交给本地 Agent 组织与研判"
      />

      {/* 查询框 */}
      <div className="mb-5 flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^a-zA-Z0-9.]/g, "").toUpperCase().slice(0, 12))}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="A 股 6 位代码，或美股/港股/韩股（AAPL / 00700 / 005930.KS）"
          className="w-80 rounded-lg border border-border bg-black/20 px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
        <button
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary shadow-glow hover:bg-primary/25 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          查询
        </button>
      </div>

      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </div>
      )}

      {/* 美股 / 港股视图（global-stock-data，东财域内源） */}
      {gstock && (
        <>
          <GlassCard glow className="mb-4">
            <div className="mb-4 flex items-baseline gap-2">
              <h2 className="text-xl font-bold">{gstock.name}</h2>
              <span className="font-mono text-sm text-muted-foreground">{gstock.code}</span>
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{gstock.market}</span>
              <span className="ml-auto text-xs text-muted-foreground">{mktName(gstock.market)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { k: "现价", v: fmt(gstock.quote.price), cls: pctColor(gstock.quote.change_pct) },
                { k: "涨跌幅", v: pctStr(gstock.quote.change_pct), cls: pctColor(gstock.quote.change_pct) },
                { k: "总市值", v: bigMoney(gstock.quote.mcap, gstock.market), cls: "" },
                { k: "成交额", v: bigMoney(gstock.quote.amount, gstock.market), cls: "" },
                { k: "开盘", v: fmt(gstock.quote.open), cls: "" },
                { k: "最高", v: fmt(gstock.quote.high), cls: "" },
                { k: "最低", v: fmt(gstock.quote.low), cls: "" },
                { k: "昨收", v: fmt(gstock.quote.prev_close), cls: "" },
              ].map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className={cn("mt-0.5 font-mono text-base font-bold", m.cls)}>{m.v}</p>
                </div>
              ))}
            </div>
          </GlassCard>

          {gstock.metrics && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <BarChart3 className="h-4 w-4 text-primary" /> 关键财务指标
                <span className="text-xs font-normal text-muted-foreground/60">· {gstock.metrics.report_date}</span>
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">东财 GMAININDICATOR，最新报告期。金额为原生币种。</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "营业收入", v: bigMoney(gstock.metrics.revenue, gstock.market), yoy: gstock.metrics.revenue_yoy != null ? round2(gstock.metrics.revenue_yoy, "%") : "" },
                  { k: "归母净利", v: bigMoney(gstock.metrics.net_profit, gstock.market), yoy: "" },
                  { k: "每股收益 EPS", v: round2(gstock.metrics.eps), yoy: "" },
                  { k: "ROE", v: round2(gstock.metrics.roe, "%"), yoy: "" },
                  { k: "毛利率", v: round2(gstock.metrics.gross_margin, "%"), yoy: "" },
                  { k: "净利率", v: round2(gstock.metrics.net_margin, "%"), yoy: "" },
                  { k: "资产负债率", v: round2(gstock.metrics.debt_ratio, "%"), yoy: "" },
                ].map((m) => (
                  <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{m.k}</p>
                    <p className="mt-0.5 font-mono text-base font-bold">{m.v}</p>
                    {m.yoy && <p className="text-[11px] text-muted-foreground">同比 {m.yoy}</p>}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {cashflow && cashflow.periods.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <BarChart3 className="h-4 w-4 text-primary" /> 现金流量表
                <span className="text-xs font-normal text-muted-foreground/60">· 单位：亿{cashflow.currency ?? ""}</span>
              </h3>
              <p className="mb-3 text-[11px] text-muted-foreground/60">东财 RPT_HKSK_FN_CASHFLOW · 季度为年初至今累计 · 负数（现金流出）标绿。</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 pr-3 text-left font-normal">科目</th>
                      {cashflow.periods.slice(0, 5).map((p) => (
                        <th key={p.report_date} className="px-2 py-1 text-right font-normal">{p.report_date.slice(0, 7)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cashflow.item_order.map((it) => (
                      <tr key={it} className="border-t border-border/40">
                        <td className="py-1.5 pr-3 text-muted-foreground">{it}</td>
                        {cashflow.periods.slice(0, 5).map((p) => {
                          const amt = p.items[it]?.amount ?? null;
                          return (
                            <td key={p.report_date} className={cn("px-2 py-1.5 text-right font-mono", amt != null && amt < 0 ? "text-success" : "")}>
                              {amt == null ? "—" : (amt / 1e8).toFixed(1)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          )}

          <p className="text-xs text-muted-foreground/60">
            美股 / 港股数据来自 <a href="https://github.com/simonlin1212/global-stock-data" target="_blank" rel="noreferrer" className="hover:text-primary">global-stock-data</a>（东财域内源）· 金额为原生币种 · 仅客观数据，不含买卖建议。
          </p>
        </>
      )}

      {val && (
        <>
          <GlassCard glow className="mb-4">
            <div className="mb-4 flex items-baseline gap-2">
              <h2 className="text-xl font-bold">{val.name}</h2>
              <span className="font-mono text-sm text-muted-foreground">{val.code}</span>
              {/* 🔴 渲染纪律:每个数字常驻显示资料期。前向PE / PEG / 消化年数都由
                  「基年一致预期 + 行情现价」派生 —— 两者的口径与时刻都写在这里。 */}
              <span className="ml-auto text-xs text-muted-foreground">
                {val.base_year ? `一致预期 FY${val.base_year}–FY${val.base_year + 2}` : "一致预期基年未知"}
                {val.analyst_count != null && val.analyst_count > 0 ? ` · 机构覆盖 ${val.analyst_count} 家` : ""}
                {val.quote_at ? ` · 行情 ${val.quote_at.slice(0, 16).replace("T", " ")}` : ""}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {metrics.map((m) => (
                <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">{m.k}</p>
                  <p className="mt-0.5 font-mono text-lg font-bold">{m.v}</p>
                </div>
              ))}
            </div>
            {val.forecast_note && (
              <p className="mt-3 text-xs text-warning">{val.forecast_note}</p>
            )}

            {/*
              🔴 **消化年数是情景，不是事实**。它同时依赖两个软假设：
                 ① 一致预期的两年 CAGR 真的兑现；② "合理 PE"锚定在多少倍。
                 只给一个数（此前写死 30 倍 → 0.05 年）会读成既定事实 ——
                 而同一份输入在 18 倍锚下是 1.14 年，差二十多倍。
              这四档来自 Core 的确定性计算库，不是界面自己算的。
            */}
            {digest && digest.length > 0 && (
              <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 p-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  估值消化年数 · <span className="text-foreground">四种情景</span>
                  <span className="ml-1 text-muted-foreground/70">（取决于把"合理 PE"锚在多少倍，以及一致预期是否兑现）</span>
                  {/* 🔴 消化年数是**算出来的**,它自己没有证据 id —— 但它的两个输入有。
                      把输入的证据 id 挂上去,这条数字才追得回来源。 */}
                  <span className="ml-1 cursor-help underline decoration-dotted underline-offset-2 text-muted-foreground/70"
                        title={`输入：现价${val.price_evidence_id ? `（证据 ${val.price_evidence_id}${val.quote_at ? ` · ${val.quote_at.slice(0, 16).replace("T", " ")}` : ""}）` : "（证据 id 未覆盖）"}` +
                               ` ÷ ${val.base_year ? `FY${val.base_year}` : "基年未知"} 一致预期 EPS${val.eps_evidence_id ? `（证据 ${val.eps_evidence_id}）` : "（证据 id 未覆盖）"}`}>
                    输入来源
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {digest.map((d) => (
                    <div key={d.name} className="rounded-md bg-background/40 px-2.5 py-2">
                      <p className="text-[11px] text-muted-foreground">{d.name} · {d.anchor === null ? "锚值未覆盖" : `${d.anchor} 倍锚`}</p>
                      <p className="mt-0.5 font-mono text-base font-semibold">
                        {d.years === null ? <span className="text-sm text-muted-foreground">{d.status === "not_meaningful" ? "无意义" : "—"}</span> : `${d.years.toFixed(2)} 年`}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>

          {/* 🔴 论点放在资料**之后、结论之前**：先看清事实，再对照自己当初写下的判断。
              这块把台账里的 thesis / criterion 组成工作流 —— 产品此前只帮用户"看资料"，
              没帮他"记住自己当时为什么买、什么情况下认错"。 */}
          <ThesisPanel symbol={val.code} name={val.name} />

          {/* 财报速览（结论先行摘要，借鉴 equity-research 的结构纪律，剔除评级/目标价） */}
          <EarningsSnapshot val={val} fin={fin} pctl={pctl} />

          {pctl && (pctl.metrics.pe_ttm || pctl.metrics.pb) && (
            <GlassCard glow className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><LineChart className="h-4 w-4 text-primary" /> 估值历史分位 · {pctl.period}</h3>
              <p className="mb-4 text-[11px] text-muted-foreground/60">绿=低估区 / 灰=合理区 / 红=高估区。只显示当前处于历史什么位置，不构成买卖建议。</p>
              <div className="space-y-4">
                {pctl.metrics.pe_ttm && <ValBand label="PE-TTM" m={pctl.metrics.pe_ttm} />}
                {pctl.metrics.pb && <ValBand label="市净率 PB" m={pctl.metrics.pb} />}
              </div>
            </GlassCard>
          )}

          {fin && (fin.revenue || fin.roe) && (
            <GlassCard className="mb-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><BarChart3 className="h-4 w-4 text-primary" /> 财务关键指标{fin.period && <span className="text-xs font-normal text-muted-foreground/60">· {fin.period}</span>}</h3>
              {/* 🔴 来源要写对:这条链走的是**新浪财务摘要**(akshare stock_financial_abstract),
                  不是同花顺 —— 落盘 raw 的文件名就是 `extracted_sina_abstract_...`。
                  一个卖溯源的产品把来源标错,比不标更糟。 */}
              <p className="mb-3 text-[11px] text-muted-foreground/60">新浪财务摘要（akshare），最新报告期。</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { k: "营业总收入", v: fin.revenue, yoy: fin.revenue_yoy },
                  { k: "归母净利润", v: fin.net_profit, yoy: fin.net_profit_yoy },
                  { k: "每股收益", v: fin.eps },
                ].map((m) => (
                  <div key={m.k} className="rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">{m.k}</p>
                    <p className="mt-0.5 font-mono text-base font-bold">{m.v ?? "—"}</p>
                    {m.yoy && <p className="text-[11px] text-muted-foreground">同比 {m.yoy}</p>}
                  </div>
                ))}
              </div>
              {/* 🔴 原来这里还摆着 ROE / 毛利率 / 净利率 / 每股净资产 / 每股经营现金流 五个格子,
                  全是写死的「—」。用户分不清是**这只票没有**还是**这个源不提供** ——
                  而实际是后者(该端点只给营收 / 归母 / 扣非 / EPS 四项)。⇒ 与其摆五个空格子,
                  不如把这句说出来。 */}
              <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
                这个源只提供营收 / 归母净利 / 扣非 / 每股收益。ROE、毛利率、净利率、每股净资产、
                每股经营现金流<b className="text-foreground/70">不在这条链路里</b>（不是这只票没有）——要看得另接端点。
              </div>
            </GlassCard>
          )}

          {reports.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><FileText className="h-4 w-4 text-primary" /> 近期研报（{reports.length}）</h3>
              <div className="space-y-2">
                {reports.slice(0, 12).map((r, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{(r.publishDate || "").slice(0, 10)}</span>
                    <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{r.orgSName}</span>
                    {r.pdfUrl ? (
                      <a href={r.pdfUrl} target="_blank" rel="noreferrer" className="flex-1 truncate hover:text-primary">{r.title}</a>
                    ) : (
                      <span className="flex-1 truncate">{r.title}</span>
                    )}
                    {r.emRatingName && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{r.emRatingName}</span>}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {anns.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Megaphone className="h-4 w-4 text-primary" /> 近期公告（{anns.length}）</h3>
              <div className="space-y-2">
                {anns.slice(0, 12).map((a, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{a.date}</span>
                    {a.type && <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">{a.type}</span>}
                    {a.url ? (
                      <a href={a.url} target="_blank" rel="noreferrer" className="flex-1 truncate hover:text-primary">{a.title.replace(/^[^:：]*[:：]/, "")}</a>
                    ) : (
                      <span className="flex-1 truncate">{a.title}</span>
                    )}
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          <GlassCard>
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Newspaper className="h-4 w-4 text-primary" /> 个股新闻</h3>
            {depNote ? (
              <p className="text-xs text-warning">{depNote}（安装后新闻/公告即可用）</p>
            ) : news.length === 0 ? (
              <p className="text-xs text-muted-foreground/60">暂无新闻</p>
            ) : (
              <div className="space-y-2">
                {news.slice(0, 10).map((n, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{(n.发布时间 || "").slice(0, 16)}</span>
                    {n.新闻链接 ? (
                      <a href={n.新闻链接} target="_blank" rel="noreferrer" className="flex-1 truncate hover:text-primary">{n.新闻标题}</a>
                    ) : (
                      <span className="flex-1 truncate">{n.新闻标题}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </GlassCard>

          {/* 资金面 · 筹码（融资融券 / 股东户数 / 主力资金流 / 分红 / 大宗交易） */}
          {(margin.length > 0 || holders.length > 0 || fundFlow.length > 0 || dividend.length > 0) && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Wallet className="h-4 w-4 text-primary" /> 资金面 · 筹码</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {margin[0] && <Metric k="融资余额" v={yi(margin[0].rzye)} sub={margin[0].date} />}
                {margin[0] && <Metric k="融券余额" v={yi(margin[0].rqye)} />}
                {holders[0] && <Metric k="股东户数" v={holders[0].holder_num == null ? "—" : holders[0].holder_num.toLocaleString()} sub={`环比 ${pct(holders[0].change_ratio)}`} />}
                {fundFlow.length > 0 && (() => {
                  // fundFlowOf 已按日期倒序；只在最近 20 个交易日全部有值时才合计。
                  // 缺失值不能静默少算后继续挂“近20日”的标签。
                  const window = fundFlow.slice(0, 20);
                  const known = window.map((r) => r.main_net).filter((v): v is number => v !== null);
                  const complete = window.length === 20 && known.length === 20;
                  return <Metric
                    k="近20日主力净流入"
                    v={complete ? yi(known.reduce((s, v) => s + v, 0)) : "—"}
                    sub={complete ? undefined : `仅 ${known.length}/20 日有效，未合计`}
                  />;
                })()}
                {dividend[0] && <Metric k="最近派息(每10股)" v={dividend[0].bonus_rmb == null ? "—" : `${dividend[0].bonus_rmb} 元`} sub={dividend[0].date} />}
              </div>
              {blockT.length > 0 && (
                <div className="mt-3 border-t border-border/40 pt-3">
                  <p className="mb-2 text-xs text-muted-foreground">近期大宗交易（{blockT.length}）</p>
                  <div className="space-y-1.5">
                    {blockT.slice(0, 5).map((b, i) => (
                      <div key={i} className="flex items-center gap-3 text-xs">
                        <span className="w-20 shrink-0 font-mono text-muted-foreground">{b.date}</span>
                        <span className="w-14 shrink-0">{b.price ?? "—"} 元</span>
                        <span className={cn("w-20 shrink-0", pctColor(b.premium_pct))}>折溢 {pct(b.premium_pct)}</span>
                        <span className="flex-1 truncate text-muted-foreground">买 {b.buyer} · 卖 {b.seller}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground/60">资金/筹码为公开客观数据，仅供了解该股当前状态，不构成任何买卖建议。</p>
            </GlassCard>
          )}

          {/* 龙虎榜 */}
          {dt && dt.records.length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Trophy className="h-4 w-4 text-primary" /> 龙虎榜（近30日 {dt.records.length} 次）</h3>
              <div className="space-y-2">
                {dt.records.slice(0, 6).map((r, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border/40 pb-2 text-sm last:border-0">
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{r.date}</span>
                    <span className="flex-1 truncate">{r.reason}</span>
                    <span className={cn("shrink-0 font-mono text-xs", pctColor(r.net_buy))}>净买 {r.net_buy ?? "—"} 万</span>
                  </div>
                ))}
              </div>
              {(dt.seats.buy.length > 0 || dt.seats.sell.length > 0) && (
                <div className="mt-3 grid gap-4 border-t border-border/40 pt-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-danger">买入席位 TOP</p>
                    {dt.seats.buy.map((s, i) => (
                      <div key={i} className="flex justify-between gap-2 text-xs text-muted-foreground"><span className="truncate">{s.name}</span><span className="shrink-0 font-mono">净{s.net}万</span></div>
                    ))}
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-success">卖出席位 TOP</p>
                    {dt.seats.sell.map((s, i) => (
                      <div key={i} className="flex justify-between gap-2 text-xs text-muted-foreground"><span className="truncate">{s.name}</span><span className="shrink-0 font-mono">净{s.net}万</span></div>
                    ))}
                  </div>
                </div>
              )}
            </GlassCard>
          )}

          {/* 限售解禁 */}
          {lockup && (lockup.upcoming.length > 0 || lockup.history.length > 0) && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-primary" /> 限售解禁</h3>
              {lockup.upcoming.length > 0 ? (
                <div className="mb-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <p className="mb-1.5 text-xs font-medium text-warning">未来 90 天待解禁（{lockup.upcoming.length}）</p>
                  {lockup.upcoming.slice(0, 4).map((h, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs"><span className="w-20 shrink-0 font-mono text-muted-foreground">{h.date}</span><span className="flex-1 truncate">{h.type}</span><span className="shrink-0 text-muted-foreground">占比 {pct(h.ratio)}</span></div>
                  ))}
                </div>
              ) : (
                <p className="mb-2 text-xs text-muted-foreground/70">未来 90 天无待解禁。</p>
              )}
              {lockup.history.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs text-muted-foreground">历史解禁（近 {Math.min(lockup.history.length, 5)}）</p>
                  {lockup.history.slice(0, 5).map((h, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs"><span className="w-20 shrink-0 font-mono text-muted-foreground">{h.date}</span><span className="flex-1 truncate text-muted-foreground">{h.type}</span></div>
                  ))}
                </div>
              )}
            </GlassCard>
          )}

          {/* 板块归属 · 概念 */}
          {((blocks && blocks.concept_tags.length > 0) || hotCon.length > 0) && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Boxes className="h-4 w-4 text-primary" /> 板块归属 · 概念</h3>
              {blocks && blocks.concept_tags.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {blocks.concept_tags.slice(0, 24).map((t, i) => (
                    <span key={i} className="rounded-full border border-border/70 px-2 py-0.5 text-xs text-muted-foreground">{t}</span>
                  ))}
                </div>
              )}
              {hotCon.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs text-muted-foreground">当下热门概念命中</p>
                  <div className="flex flex-wrap gap-1.5">
                    {hotCon.slice(0, 12).map((h, i) => (
                      <span key={i} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{h.concept}</span>
                    ))}
                  </div>
                </div>
              )}
            </GlassCard>
          )}

          {/* 投资者互动（互动易） */}
          {qa.filter((q) => q.answer).length > 0 && (
            <GlassCard className="mb-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-primary" /> 投资者互动（互动易）</h3>
              <div className="space-y-3">
                {qa.filter((q) => q.answer).slice(0, 5).map((q, i) => (
                  <div key={i} className="border-b border-border/40 pb-3 text-sm last:border-0">
                    <p className="text-muted-foreground"><span className="mr-1.5 rounded bg-muted/50 px-1.5 py-0.5 text-[10px]">问</span>{q.question}</p>
                    <p className="mt-1"><span className="mr-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">答</span>{q.answer}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/60">{q.ask_time}</p>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}
        </>
      )}

      {!val && !err && !loading && (
        <GlassCard>
          <div className="py-10 text-center text-sm text-muted-foreground">
            输入 A 股 6 位代码，或美股 / 港股 / 韩股代码（AAPL · 00700 · 005930.KS），拉取它的行情、估值、研报与新闻。<br />
            <span className="text-xs text-muted-foreground/60">数据来自公开源（腾讯行情 / 东财研报 / akshare）；Vibe-Research 不预置任何标的、不做推荐。</span>
          </div>
        </GlassCard>
      )}

      <Disclaimer />
    </div>
  );
}
