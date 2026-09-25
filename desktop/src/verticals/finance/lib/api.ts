/**
 * 上游 UI 的数据接口 —— **类型原样保留,实现全部改接我们的底座**。
 *
 * 上游打的是开源版 Python 后端(`/api/valuation` 这种语义接口);我们的底座只有一个
 * 通用取数入口 `/fetch`(端点 id + 证据信封)。差异收在这一个文件里,
 * **12 个页面一行不用改**。
 *
 * 🔴 三条纪律:
 *  ① 接不上的一律 `notWired()` **抛错**,不返回空数组 ——
 *     返回空会让页面显示"这里没有数据",而真相是"这条链路还没做"。
 *  ② 取不到的数给 `null` 不给 `0`；接口类型必须如实允许 null。
 *  ③ 鉴权与密钥都不在浏览器:Bearer 由 Vite 代理注入(见 vite.config.ts)。
 */
import {
  ApiError, backend, noteKV, num, round2, rows, scalar, str, throwNotWired,
  type Envelope,
} from "./backend.ts";
import {
  currencyLabel, currencyOfSymbol, marketOfSymbol, normalizeMarketSymbol, quoteQueryOfSymbol, symbolFromQuoteKey,
  type CurrencyCode, type MarketCode,
} from "./marketSymbol.ts";

export { ApiError };

export interface MyReport {
  id: string; name: string; size: number; ext: string; ts: number; uploaded_at: string;
  chars: number; pages: number | null; truncated: boolean; symbols: string[];
}

/**
 * 上游用它存"后端访问密钥"到 localStorage。我们**不需要**:
 * 鉴权由 Vite 代理注入,浏览器侧不持有任何凭据。保留空实现只为让上游页面编译通过。
 */
export const loadAccessKey = (): string => "";
export const saveAccessKey = (_key: string): void => undefined;
export const authHeaders = (): Record<string, string> => ({});

export async function downloadReport(id: string, name: string): Promise<void> {
  let res: Response;
  try { res = await fetch(`/api/reports/${encodeURIComponent(id)}/download`); }
  catch (e) { throw new ApiError(`连接不到编排器 API:${e instanceof Error ? e.message : String(e)}`, 0, "network"); }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code = String(res.status);
    try { const body = await res.json() as { error?: string; message?: string }; message = body.message ?? body.error ?? message; code = body.error ?? code; } catch { /* 下载错误不是 JSON 时保留状态码 */ }
    throw new ApiError(message, res.status, code);
  }
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally { URL.revokeObjectURL(url); }
}

export interface Quote {
  /** 源证据取数时刻，不是浏览器收到回包的时间，也不是逐笔成交时间。 */
  fetched_at?: string | null;
  /**
   * 🔴 **全部可为 null**。原来这些走 `n0` 兜成 0,于是"端点没给这一项"在界面上
   *    变成「0.00 元 / 0.00 倍 / 0.00%」—— 与真实的 0 分不开,而且看着完全正常。
   *    上方那条规则本来就写着"取不到的数给 null 不给 0",只是当时只在新加的两个字段上执行了。
   *    改成可空之后,类型系统会**逼着每一处调用点表态**(实测 12 处)。
   */
  name: string; price: number | null; last_close: number | null; change_pct: number | null;
  market: MarketCode; currency: CurrencyCode;
  pe_ttm: number | null; pb: number | null; mcap_yi: number | null; turnover_pct: number | null;
  limit_up: number | null; limit_down: number | null;
  /**
   * 🔴 **单位写进字段名**。行情端点给的是「亿元 / 万元」，而页面的 `yi()` 吃的是「元」——
   *    两边都叫 `amount` 的话，少乘一次 1e4 就会把 186 亿显示成 0.02 亿，而且不会报错。
   */
  /**
   * 🔴 **可为 null**，不能用 `n0` 兜成 0。`n0` 把"端点没给这一项"变成数字 0，
   *    页面照样渲染成「0.00 亿」—— 那是**把没取到显示成一个具体的数**，比空着更糟。
   */
  float_mcap_yi: number | null;   // 流通市值，亿元
  amount_yuan: number | null;     // 成交额，元（端点给万元，这里已 ×1e4）
}

export interface Valuation {
  name: string; code: string; price: number | null; mcap_yi: number | null;
  pe_ttm: number | null; pb: number | null;
  eps_26e: number | null; eps_27e: number | null; pe_26e: number | null;
  /** 一致预期的**基年**(FY(T))。🔴 界面标签必须由它拼,不许写死 "26E" ——
   *  基年跟着上游走(跨年 / 上游少给一年都会变),写死的标签会出现
   *  「数字是真的、年份是错的」,而这种错没人看得出来。 */
  base_year: number | null;
  /** 行情信封的取数时刻(ISO)。派生数(前向PE / PEG / 消化年数)都以它为准。 */
  quote_at: string | null;
  /**
   * 派生数的**两个输入各自的证据 id**。
   * 🔴 前向PE / PEG / 消化年数都不是取来的、是算出来的 —— 它们自己没有证据 id,
   *    但它们的输入有。不把这两个带出来,界面上就出现"追不回来源的数字"。
   */
  price_evidence_id: string | null;
  eps_evidence_id: string | null;
  cagr_pct: number | null; peg: number | null; digest_years: number | null;
  analyst_count: number | null; forecast_note?: string;
}

export interface Report {
  title: string; publishDate: string; orgSName: string;
  emRatingName?: string; indvInduName?: string; pdfUrl?: string | null;
}

export interface ValMetric {
  current: number; percentile: number; min: number; max: number;
  p20: number; p50: number; p80: number; n: number;
}
export interface ValPercentile {
  period: string; metrics: { pe_ttm?: ValMetric; pb?: ValMetric };
}

export interface Announcement {
  date: string; title: string; type: string; url: string;
}

export interface Financials {
  period: string | null;
  revenue: string | null; revenue_yoy: string | null;
  net_profit: string | null; net_profit_yoy: string | null;
  eps: string | null; bvps: string | null; roe: string | null;
  gross_margin: string | null; net_margin: string | null; op_cf_ps: string | null;
}

export interface NewsItem {
  新闻标题?: string; 发布时间?: string; 文章来源?: string; 新闻链接?: string;
}

export interface IndexQuote {
  name: string; price: number | null; change_pct: number | null; change_amt: number | null;
}

export interface MarketSentiment {
  /**
   * 🔴 与上游的唯一类型差异:这几项**允许为 null**。
   *    上游后端能算出"真实涨停"(剔除一字新股 / ST),我们的取数层给不出这个口径 ——
   *    与其填一个看着像真的数,不如给 null 让那一格**不显示**。
   *    (`flat` 同理:两个源的universe 不同,相减出来的"平盘"是假精确。)
   */
  up: number | null; down: number | null; flat: number | null;
  zt: number | null; zt_real: number | null; dt: number | null; dt_real: number | null;
  active: string; breadth: string; speculation: string; date: string;
}
export interface SectorFlow {
  /**
   * 🔴 与上游的类型差异:`inflow / outflow / firms` **允许 null**。
   *    我们的板块资金端点只给"主力净流入",没有分开的流入 / 流出与家数 ——
   *    填 0 会被读成"今天一分钱没流入",那是假的。
   */
  name: string; pct: number | null; net: number | null;
  inflow: number | null; outflow: number | null; firms: number | null;
}
export interface MarketOverview {
  sentiment: MarketSentiment; sectors: SectorFlow[]; updated: string;
}

// 短线情绪：连板梯队 / 最高连板 / 炸板率 / 封板率 / 晋级率 / 涨跌停家数 + 连板股清单（客观公开榜单）
export interface EmotionTier { boards: number; count: number; plus: boolean }
export interface LianbanStock {
  code: string; name: string; boards: number;
  price: number | null; pct: number | null; amount: number | null; float_cap: number | null; industry: string;
}
export interface ShortTermEmotion {
  date: string;
  zt_count: number; dt_count: number; zb_count: number;
  max_boards: number; lianban_count: number;
  ladder: EmotionTier[];
  lianban_stocks: LianbanStock[];
  seal_rate: number | null; break_rate: number | null; promotion_rate: number | null;
  yzt_count: number;
}

// 全市场成交额榜（客观公开榜单）
export interface TurnoverStock {
  code: string; name: string;
  price: number | null; pct: number | null;
  amount: number | null; mcap: number | null; float_cap: number | null; industry: string;
}
export interface TurnoverTop { stocks: TurnoverStock[]; updated: string }

export interface RadarItem {
  title: string; url: string; time: string; source: string; summary?: string; zh?: string;
}
export interface Industry {
  key: string; name: string; accent: string; total: number; items: RadarItem[];
}
export interface RadarData {
  generated_at: string | null; recent_days: number; industries: Industry[];
  stats: { industries: number; total_sources: number; failed_sources?: number };
}

// 产业信号 · GPU 租金
export interface GpuSpot {
  gpu: string; median?: number; asof_ts?: number;
  available_gpus?: number | null; total_gpus?: number | null;
  unavailable?: boolean; note?: string; err?: string;
  stale?: boolean; fetch_error?: string; observed_at?: string | null;
}
export interface GpuHistSeries {
  gpu: string; n_points?: number; points?: [number, number][]; latest?: number;
  unavailable?: boolean; note?: string; err?: string;
  stale?: boolean; fetch_error?: string; observed_at?: string | null;
}
export interface ForwardRung { strike: number; p_above: number; open_interest: number | null }
export interface DistBin { label: string; lo: number | null; hi: number | null; p: number }
export interface ImpliedMedian { value: number; bound: "exact" | "above" | "below" }
export interface ForwardMonth {
  month: string; close_date: string; rungs: ForwardRung[];
  lowest_strike: number; p_below_lowest: number;
  implied_median: ImpliedMedian | null;
  distribution: DistBin[]; most_likely: DistBin;
}
export interface SettledMonth { month: string; lo: number | null; hi: number | null }
export interface GpuForward {
  months?: ForwardMonth[]; n_contracts?: number; n_months?: number;
  settled?: SettledMonth[]; settled_error?: string | null;
  unavailable?: boolean; note?: string; err?: string;
  stale?: boolean; fetch_error?: string; observed_at?: string | null;
}
export interface GpuRentData {
  generated_at: string | null;
  how_to_read: string[];
  spot_source: string; history_source: string; forward_source: string;
  spot: { gpus: GpuSpot[] };
  history: { gpus: GpuHistSeries[]; days: number };
  forward: GpuForward | null;
  errors: string[] | null;
}

// 事件概率（全球宏观预期概率 · 预测市场公开定价）
export interface MacroProbItem {
  topic: string;      // 话题（货币政策 / 通胀 …）
  source: string;     // polymarket / kalshi
  title: string;      // 合约问的是什么
  leg: string;        // 结果腿（Yes / No / 某个区间）
  prob: number | null;
  settle: string;     // 结算日
  volume: number | null;
}
export interface MacroProbability {
  items: MacroProbItem[];
  /** 🔴 取数层给的读法护栏，原样带出来与数字同屏显示 */
  how_to_read: string[];
  updated: string;
  partial: boolean;
}

export interface Holding {
  code: string; name: string; shares: number; cost: number;
  market: MarketCode; currency: CurrencyCode;
  /** 🔴 行情派生的四项**可为 null**:拉不到行情时显示「—」,不是 0。
   *  写死成 number 的话,一只取不到行情的持仓会整行显示「现价 0.00 / 市值 0.00 / 浮盈 0.00」,
   *  排版完全正常,看不出是没取到。 */
  price: number | null; market_value: number | null;
  pnl: number | null; pnl_pct: number | null;
}
export interface ClosedPosition {
  id: string; currency: CurrencyCode;
  note: string;
  code: string; name: string; date: string; price: number; shares: number; cost: number;
  pnl: number; pnl_pct: number | null;
}
export interface PortfolioData {
  holdings: Holding[];
  /** 三币种分开汇总：不做汇率换算就绝不可以直接相加。 */
  totals: {
    market: MarketCode; currency: CurrencyCode; label: string;
    market_value: number; cost: number; pnl: number; pnl_pct: number | null;
  }[];
  closed: ClosedPosition[];
  closed_invalid: number;
  realized_totals: { currency: CurrencyCode; pnl: number }[];
  updated: string; last_refresh: string | null;
}

// 资金面 / 筹码 / 信号（v3.3 并入，均为「用户查的那只股」的公开数据）
export interface MarginRow { date: string; rzye: number | null; rzmre: number | null; rzche: number | null; rqye: number | null; rqmcl: number | null; rzrqye: number | null }
export interface BlockTradeRow { date: string; price: number | null; close: number | null; premium_pct: number | null; vol: number | null; amount: number | null; buyer: string; seller: string }
export interface HolderRow { date: string; holder_num: number | null; change_ratio: number | null; avg_shares: number | null }
export interface DividendRow { date: string; bonus_rmb: number | null; transfer_ratio: number | null; bonus_ratio: number | null; plan: string }
export interface FundFlowRow { date: string; main_net: number | null; small_net: number | null; mid_net: number | null; large_net: number | null; super_net: number | null }
export interface DtSeat { name: string; buy_amt: number; sell_amt: number; net: number }
export interface DragonTiger {
  records: { date: string; reason: string; net_buy: number | null; turnover: number | null }[];
  seats: { buy: DtSeat[]; sell: DtSeat[] };
  institution: { buy_amt: number; sell_amt: number; net_amt: number };
}
export interface LockupRow { date: string; type: string; shares: number | null; able_shares: number | null; ratio: number | null }
export interface Lockup { history: LockupRow[]; upcoming: LockupRow[] }
export interface Board { name: string; code: string; change_pct: number | string; lead_stock: string }
export interface Blocks { total: number; boards: Board[]; concept_tags: string[] }
export interface HotConcept { concept: string; bk: string; hit: number }
export interface QaRow { company: string; question: string; answer: string | null; answerer: string; ask_time: string }
export interface IndustryRow { rank: number; name: string; change_pct: number | null; code: string; up_count: number | null; down_count: number | null }
export interface IndustryData { top: IndustryRow[]; bottom: IndustryRow[]; total: number }

// 全球市场：指数复用已注册的腾讯批量快照，不把抓取时间冒充成交时间。
export interface GlobalIndex {
  key: string; name: string; region: string;
  price: number | null; change_pct: number | null;
  fetched_at?: string | null; evidence_id?: string | null; note?: string;
}
export interface GlobalQuote {
  code: string; name: string;
  price: number | null; open: number | null; high: number | null; low: number | null;
  prev_close: number | null; amount: number | null; mcap: number | null; change_pct: number | null;
}
export interface GlobalMetrics {
  report_date: string;
  revenue: number | null; revenue_yoy: number | null; net_profit: number | null;
  eps: number | null; roe: number | null; gross_margin: number | null;
  net_margin: number | null; debt_ratio: number | null;
}
export interface GlobalStock {
  code: string; name: string; market: string;
  quote: GlobalQuote; metrics: GlobalMetrics | null;
}
export interface HkCashflowItem { amount: number | null; yoy: number | null }
export interface HkCashflowPeriod {
  report_date: string; report: string | null;
  currency: string | null; account_standard: string | null;
  items: Record<string, HkCashflowItem>;
}
export interface HkCashflow {
  code: string; name: string; market: string;
  currency: string | null; item_order: string[]; periods: HkCashflowPeriod[];
}


/* ==================== 映射:上游语义接口 → 我们的取数端点 ==================== */

const env = async (endpoint: string, opts: { symbol?: string; args?: Record<string, unknown>; refresh?: boolean } = {}): Promise<Envelope> =>
  (await backend.fetch(endpoint, opts)).envelope;

/** 换算单位。**null 进 null 出** —— 直接写 `x * k` 会把"没有"变成 0，页面就显示成「0.00 亿」 */
const mul = (v: number | null, k: number): number | null => (v === null ? null : v * k);
const subtract = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);
const descNullable = (a: number | null, b: number | null): number => (b ?? Number.NEGATIVE_INFINITY) - (a ?? Number.NEGATIVE_INFINITY);

/* ---------- 行情 / 估值 ---------- */

async function quoteMap(codes: string[], refresh = false): Promise<Record<string, Quote>> {
  const canonical = [...new Set(codes.map(normalizeMarketSymbol).filter((c): c is string => c !== null))];
  const queries = canonical.map(quoteQueryOfSymbol).filter((c): c is string => c !== null);
  if (!queries.length) return {};
  const e = await env("tx_quotes_batch", { args: { codes: queries }, refresh });
  const out: Record<string, Quote> = {};
  for (const r of rows(e)) {
    const symbol = symbolFromQuoteKey(r.key);
    const market = symbol ? marketOfSymbol(symbol) : null;
    const currency = symbol ? currencyOfSymbol(symbol) : null;
    if (!symbol || !market || !currency) continue;
    out[symbol] = {
      fetched_at: r.fields.price?.fetched_at ?? null,
      name: str(r.fields.security_name),
      market,
      currency,
      price: num(r.fields.price),
      last_close: num(r.fields.last_close),
      change_pct: num(r.fields.change_pct),
      pe_ttm: num(r.fields.pe_ttm),
      pb: num(r.fields.pb),
      mcap_yi: num(r.fields.market_cap),
      turnover_pct: num(r.fields.turnover_rate),
      limit_up: num(r.fields.limit_up_price),
      limit_down: num(r.fields.limit_down_price),
      float_mcap_yi: num(r.fields.float_market_cap),                        // 端点单位：亿元
      // 这个旧字段只有 A 股页面在用。美 / 港成交额是各自币种，不冒充人民币。
      amount_yuan: market === "CN" ? mul(num(r.fields.turnover_amount), 1e4) : null,
    };
  }
  return out;
}

async function valuationOf(code: string): Promise<Valuation> {
  const [q, est] = await Promise.all([
    env("tx_quote", { symbol: code }),
    // 一致预期可能没有(小票 / 无覆盖)—— 缺了不影响行情部分,单独降级
    env("fetch_estimates", { symbol: code }).catch(() => undefined),
  ]);
  const f = (name: string) => scalar(q, name);
  const price = num(f("price"));

  /**
   * 🔴 一致预期是**同一个字段 `eps_consensus_mean` 分三个资料期**(FY2026/27/28),
   *    不是三个字段。按 period 升序取前两年 —— 当年 + 次年。
   *    (先前按 `eps_consensus_fy1/fy2` 这种自己编的字段名去取:取不到就回退到"第一条",
   *     当年那个碰巧对了、次年那个是 null ⇒ **PEG 永远算不出来,还看不出是读错了**。)
   */
  const meanByPeriod = (est?.evidence ?? [])
    .filter((x) => x.field === "eps_consensus_mean")
    .sort((a, b) => a.period.localeCompare(b.period));
  /**
   * 🔴 **按年份取,不按数组位置。**
   *    上游少给一年时(只有 FY2026 + FY2028),按位置取会把 **FY2028 当成"次年"** 显示成 27E,
   *    数字是真的、年份是错的 —— 这种错没人看得出来。
   *    ⇒ 以最早那年为基年,只认 base / base+1 / base+2 的**精确年份**,缺哪年哪年为 null。
   */
  const yearOf = (period: string): number | null => {
    const m = /(\d{4})/.exec(period);
    return m ? Number(m[1]) : null;
  };
  /**
   * ⚠️ 基年要从**能解析出年份的那些条目里取最小的**,不能直接拿排序后的第一条 ——
   *    上游若在前面塞一条 `TTM`(排序后排在 `FY2026` 之前),`yearOf` 给 null,
   *    于是 baseYear=null ⇒ **后面所有有效预测被整体丢弃**,EPS / PEG 全空。
   *    (这是本轮修复自己引入的回归,复审抓到的。)
   */
  const dated = meanByPeriod
    .map((x) => ({ ev: x, year: yearOf(x.period) }))
    .filter((x): x is { ev: (typeof meanByPeriod)[number]; year: number } => x.year !== null);
  const baseYear = dated.length ? Math.min(...dated.map((x) => x.year)) : null;
  const atYear = (offset: number) =>
    baseYear === null ? undefined : dated.find((x) => x.year === baseYear + offset)?.ev;
  const eps26 = num(atYear(0));   // FY(T)   当年
  const eps27 = num(atYear(1));   // FY(T+1) 次年
  const eps28 = num(atYear(2));   // FY(T+2) 后年
  const pe26 = price !== null && eps26 && eps26 > 0 ? round2(price / eps26) : null;
  /**
   * 前瞻 CAGR = **两年年化** = (FY(T+2) / FY(T))^(1/2) − 1。
   *
   * 🔴 分母那一年必须是 **T+2**。拿 T+1 开平方等于把一年的增速砍成一半,
   *    算出来的既不是一年增速也不是两年年化 —— 而它长得很像 CAGR,
   *    PEG 会因此系统性偏大(此例 33.8% vs 真实 59.7%,PEG 0.89 vs 0.51)。
   * ⚠️ 三年都要拿得到、且起点为正才算;否则给 null 不给 0。
   */
  // ⚠️ **两端都必须为正**:只查起点的话,后年预测为负时 `sqrt(负数)` 出 NaN,
  //    `round2(NaN)` 还是 NaN,一路送进界面显示 "NaN" —— 而约定是给 null。
  const cagr =
    eps26 !== null && eps28 !== null && eps26 > 0 && eps28 > 0
      ? round2((Math.sqrt(eps28 / eps26) - 1) * 100)
      : null;
  return {
    name: str(f("security_name")),
    code,
    price,
    mcap_yi: num(f("market_cap")),
    pe_ttm: num(f("pe_ttm")),
    pb: num(f("pb")),
    eps_26e: eps26,
    eps_27e: eps27,
    pe_26e: pe26,
    base_year: baseYear,
    quote_at: typeof q.fetched_at === "string" ? q.fetched_at : null,
    price_evidence_id: (q.evidence.find((x) => x.field === "price")?.id as string | undefined) ?? null,
    eps_evidence_id: (atYear(0)?.id as string | undefined) ?? null,
    cagr_pct: cagr,
    peg: pe26 && cagr && cagr > 0 ? round2(pe26 / cagr) : null,
    // 消化到 30 倍要几年:ln(PE/30)/ln(1+g)。⚠️ 已经低于 30 倍或没有增速时不给数
    digest_years:
      pe26 && cagr && cagr > 0 && pe26 > 30 ? round2(Math.log(pe26 / 30) / Math.log(1 + cagr / 100)) : null,
    // 取**当年**那一期的机构数;没有资料期约束的 find() 会拿到证据里的第一条(可能是别的年份)
    analyst_count: num(
      baseYear === null
        ? undefined
        : est?.evidence.find((x) => x.field === "eps_analyst_count" && yearOf(x.period) === baseYear),
    ),
    ...(est ? {} : { forecast_note: "没有取到机构一致预期(小票或无覆盖)——前瞻 PE / PEG 因此为空" }),
  };
}

/** 估值历史分位。用日频 PE/PB 序列现算分位,**不四舍五入成"看着合理"的数** */
async function percentileOf(code: string): Promise<ValPercentile> {
  const e = await env("fetch_pe_history", { symbol: code });
  // 🔴 **先按资料期排序再取"当前"。** 直接取数组最后一个 = 押在上游按时间升序返回;
  //    上游哪天改成"最新优先",`current` 就变成**五年前那一天**,而分位数看着依然合理。
  const periodsUsed: string[] = [];
  const series = (field: string): ValMetric | undefined => {
    const points = e.evidence
      .filter((x) => x.field === field && num(x) !== null)
      .sort((a, b) => a.period.localeCompare(b.period));
    const vs = points.map((x) => num(x)!) as number[];
    if (vs.length < 20) return undefined; // 点太少算不出分位 —— 宁可不给,也不给一个假的
    periodsUsed.push(points[0]!.period, points[points.length - 1]!.period);
    const sorted = [...vs].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
    const cur = vs[vs.length - 1]!;
    const below = sorted.filter((v) => v <= cur).length;
    return {
      current: round2(cur)!,
      percentile: Math.round((below / sorted.length) * 100),
      min: round2(sorted[0]!)!,
      max: round2(sorted[sorted.length - 1]!)!,
      p20: round2(at(0.2))!,
      p50: round2(at(0.5))!,
      p80: round2(at(0.8))!,
      n: vs.length,
    };
  };
  const pe = series("pe_ttm");
  const pb = series("pb");
  if (!pe && !pb) throwNotWired("估值历史分位(取到的点数不足以算分位)");
  // 区间取**真正参与计算的那些期**的首尾。用整封信封的首尾会把 PE / PB 两段不同的覆盖范围
  // 混成一个既不属于 PE 也不属于 PB 的区间。
  const sorted = [...periodsUsed].sort();
  return {
    period: `${sorted[0] ?? ""}..${sorted[sorted.length - 1] ?? ""}`,
    metrics: { ...(pe ? { pe_ttm: pe } : {}), ...(pb ? { pb } : {}) },
  };
}

/* ---------- 财务 / 公告 / 研报 / 新闻 ---------- */

async function financialsOf(code: string): Promise<Financials> {
  const e = await env("fetch_financials", { symbol: code });
  /**
   * 最近一期 = **核心字段**里最大的那一期。
   * 🔴 取"所有字段资料期的并集"会出这种事:某个边角字段先发布了新一期 ⇒ 表头显示新一期,
   *    而营收 / 净利 / EPS 在那一期还没有 ⇒ **整张表空着,却标着一个很新的日期**。
   */
  const CORE = ["revenue_cum", "net_profit_parent_cum", "eps_basic_cum"];
  const periods = [...new Set(e.evidence.filter((x) => CORE.includes(x.field)).map((x) => x.period))].sort();
  const latest = periods[periods.length - 1] ?? null;
  const at = (field: string, period: string | null) =>
    period === null ? undefined : e.evidence.find((x) => x.field === field && x.period === period);
  const yi = (v: number | null) => (v === null ? null : `${round2(v / 1e8)} 亿`);
  /**
   * 去年同期。⚠️ 不做字符串切片拼接 —— period 若不是 `YYYY-...` 形状(`FY2026` / 带时间戳),
   *    切出来会是 `NaN...` 这种查不到的键,同比于是**静默变成"没有"**。
   *    ⇒ 用正则确认前四位是年份,替换掉;不是那个形状就明说算不了。
   */
  const prevYear = latest && /^\d{4}/.test(latest)
    ? String(Number(latest.slice(0, 4)) - 1) + latest.slice(4)
    : null;
  const yoy = (field: string) => {
    const now = num(at(field, latest));
    const before = num(at(field, prevYear));
    // 🔴 去年同期为 0 或负时不算同比 —— 那个百分比没有意义,给 null 比给一个夸张数字诚实
    return now !== null && before !== null && before > 0 ? `${round2(((now - before) / before) * 100)}%` : null;
  };
  return {
    period: latest,
    revenue: yi(num(at("revenue_cum", latest))),
    revenue_yoy: yoy("revenue_cum"),
    net_profit: yi(num(at("net_profit_parent_cum", latest))),
    net_profit_yoy: yoy("net_profit_parent_cum"),
    eps: num(at("eps_basic_cum", latest)) === null ? null : String(num(at("eps_basic_cum", latest))),
    // 下面几项这套端点不出,如实给 null(界面显示"—"),不拿别的数硬凑
    bvps: null, roe: null, gross_margin: null, net_margin: null, op_cf_ps: null,
  };
}

async function announcementsOf(code: string, refresh = false): Promise<Announcement[]> {
  const e = await env("cninfo_announcements", { symbol: code, refresh });
  return rows(e).map((r) => {
    const kv = noteKV(r.note);
    return {
      date: r.fields.announcement_title?.period ?? "",
      title: str(r.fields.announcement_title),
      type: kv.type ?? "",
      url: kv.url ?? kv.link ?? "",
    };
  });
}

async function reportsOf(code: string): Promise<Report[]> {
  const e = await env("em_reports", { symbol: code });
  return rows(e).map((r) => {
    const kv = noteKV(r.note);
    const ev = r.fields.research_report_title;
    return {
      title: str(ev),
      publishDate: ev?.period ?? "",
      orgSName: kv.orgSName ?? "",
      ...(kv.emRatingName ? { emRatingName: kv.emRatingName } : {}),
      ...(kv.indvInduName ? { indvInduName: kv.indvInduName } : {}),
      ...(kv.pdfUrl ? { pdfUrl: kv.pdfUrl } : {}),
    };
  });
}

async function newsOf(code: string, refresh = false): Promise<NewsItem[]> {
  const e = await env("em_stock_news", { symbol: code, refresh });
  return rows(e).map((r) => {
    const kv = noteKV(r.note);
    const ev = r.fields.news_title;
    return {
      新闻标题: str(ev),
      发布时间: ev?.period ?? "",
      文章来源: kv.source ?? "",
      新闻链接: kv.url ?? kv.link ?? "",
    };
  });
}

/* ---------- 资金面 / 筹码 ---------- */

async function marginOf(code: string): Promise<MarginRow[]> {
  const e = await env("em_margin_trading", { symbol: code });
  return rows(e)
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key))
    .map((r) => ({
      date: r.key,
      rzye: num(r.fields.margin_financing_balance),
      rzmre: num(r.fields.margin_financing_buy),
      rzche: num(r.fields.margin_financing_repay),
      rqye: num(r.fields.margin_short_balance),
      rqmcl: num(r.fields.margin_short_sell_volume),
      rzrqye: num(r.fields.margin_total_balance),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function blockTradeOf(code: string): Promise<BlockTradeRow[]> {
  const e = await env("em_block_trade", { symbol: code });
  return rows(e).map((r) => ({
    date: r.fields.block_trade_price?.period ?? r.key,
    price: num(r.fields.block_trade_price),
    close: num(r.fields.block_trade_close),
    premium_pct: num(r.fields.block_trade_premium_pct),
    vol: num(r.fields.block_trade_volume),
    amount: num(r.fields.block_trade_amount),
    // 🔴 买卖方在 **note** 里,不是字段(端点只给 price / premium / volume / amount / count)。
    //    原来取不存在的字段 → 空串 → 界面上显示成「买 · 卖」,像是渲染坏了而不是没数据。
    buyer: noteKV(r.note).买方 ?? "",
    seller: noteKV(r.note).卖方 ?? "",
  }));
}

async function holdersOf(code: string): Promise<HolderRow[]> {
  const e = await env("em_holder_num", { symbol: code });
  return rows(e).map((r) => ({
    date: r.key,
    holder_num: num(r.fields.shareholder_count),
    change_ratio: num(r.fields.shareholder_count_change_pct),
    avg_shares: num(r.fields.shareholder_avg_free_shares),
  }));
}

async function dividendOf(code: string): Promise<DividendRow[]> {
  const e = await env("em_dividend_history", { symbol: code });
  return rows(e).map((r) => {
    const kv = noteKV(r.note);
    return {
      date: r.key.split("|")[0] ?? "",
      bonus_rmb: num(r.fields.dividend_pretax_per_share),
      transfer_ratio: num(r.fields.transfer_per_10_shares),
      bonus_ratio: num(r.fields.bonus_per_10_shares),
      plan: kv["进度"] ?? "",
    };
  });
}

async function fundFlowOf(code: string): Promise<FundFlowRow[]> {
  const e = await env("em_fund_flow_120d", { symbol: code });
  return rows(e)
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key))
    .map((r) => ({
      date: r.key,
      main_net: num(r.fields.fund_flow_main_net),
      small_net: num(r.fields.fund_flow_small_net),
      mid_net: num(r.fields.fund_flow_mid_net),
      large_net: num(r.fields.fund_flow_large_net),
      super_net: num(r.fields.fund_flow_super_net),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/* ---------- 上游其余接口 ---------- */

/* ---------- 大盘 / 情绪 / 榜单 ---------- */

/** 打板三池的 note 格式:`002084 海鸥住工 家居用品 3天3板 首封 09:25:00` */
const POOL_NOTE = /^(\d{6})\s+(\S+)\s+(\S+)(?:\s+(\d+)天(\d+)板)?/;
function poolNote(note: string) {
  const m = POOL_NOTE.exec(note.trim());
  return m
    ? { code: m[1]!, name: m[2]!, industry: m[3]!, boards: m[5] ? Number(m[5]) : 1 }
    : null;
}

/**
 * 大盘宽度 / 题材投机 —— **我们自己按公开计数算的派生标签,不是取数层给的原始数据**。
 * 阈值写死在这里,是为了让它可复算、可争论;换阈值就是换定义,不要在页面里另写一套。
 */
function breadthLabel(up: number | null, down: number | null): string {
  if (up === null || down === null || up + down === 0) return "";
  const r = up / (up + down);
  return r < 0.3 ? "冰点" : r < 0.45 ? "偏弱" : r < 0.55 ? "中性" : r < 0.7 ? "偏强" : "普涨";
}
function speculationLabel(zt: number | null, maxBoards: number): string {
  if (zt === null) return "";
  if (zt < 20) return "冰点";
  if (zt < 40) return maxBoards >= 5 ? "活跃" : "普通";
  return zt < 70 ? "活跃" : "亢奋";
}

/**
 * 🔴 `pre` = **这一屏已经取回的信封**(来自 Core 的页面查询 `/page/review`)。
 *    给了就用,不再自己打一遍上游。
 *
 *    为什么必须这样:这三个端点(情绪 / 板块资金 / 涨停梯队)本来页面和 BFF **各取一次** ——
 *    ① 上游被打两遍;② **BFF 注入了业务日、这里没有** ⇒ 同一屏的"状态与业务日"和
 *    "屏幕上的数字"可能来自不同的两天,而页面上完全看不出来;
 *    ③ BFF 说某块 failed,页面却照常显示它的具体数字。
 *    ⇒ 一屏一个数据来源。块取不到就把那个(failed 的)信封照样传进来,解析出 null、
 *      界面显示缺口 —— **不许回退去重新取一遍**,那等于把双源又请回来。
 */
async function marketOverviewOf(pre?: { sentiment?: Envelope; board_flow?: Envelope; zt_pool?: Envelope }): Promise<MarketOverview> {
  const [sent, ind, flow, zt] = await Promise.all([
    pre?.sentiment ? Promise.resolve(pre.sentiment) : env("em_limit_up_sentiment"),
    // 全市场涨跌家数没有单独端点 —— 把行业板块的涨跌家数加总。
    // ⚠️ 口径 = "所有行业板块成分股之和",不等于交易所口径,别拿它跟别处的数硬对
    env("em_industry_comparison").catch(() => undefined),
    // 🔴 **必须取全市场**（约 496 个行业板块）。默认只给 50 个，那 50 个按净额从大到小排，
    //    于是"净流出最多"那一栏拿到的仍是净流入的板块 —— 实测界面上「流出 Top」
    //    第一名是 +8.04 亿，**一个正数排在流出榜里，而页面上看不出这是错的**。
    //    这条与 Core 页面查询的 BOARD_FLOW_ARGS 同口径（page_queries.ts）。
    pre?.board_flow ? Promise.resolve(pre.board_flow) : env("em_board_fund_flow", { args: { board_type: "industry", period: "today", top_n: 500 } }).catch(() => undefined),
    pre?.zt_pool ? Promise.resolve(pre.zt_pool) : env("em_zt_pool").catch(() => undefined),
  ]);

  const sum = (e: Envelope | undefined, field: string): number | null => {
    if (!e) return null;
    const vs = e.evidence.filter((x) => x.field === field && x.record_key).map((x) => num(x));
    return vs.length ? vs.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  };
  const up = sum(ind, "industry_board_up_count");
  const down = sum(ind, "industry_board_down_count");
  const ztCount = num(scalar(sent, "limit_up_count"));
  const dtCount = num(scalar(sent, "limit_down_count"));
  const zbCount = num(scalar(sent, "break_board_count"));
  const maxBoards = zt
    ? Math.max(0, ...rows(zt).map((r) => num(r.fields.pool_limit_days) ?? 0))
    : 0;

  const sectors: SectorFlow[] = (flow ? rows(flow) : [])
    .map((r) => ({
      name: r.note.replace(/\s*排名\s*\d+\s*$/, "").trim() || r.key,
      pct: num(r.fields.board_change_pct_today),
      // 元 → 亿元。上游这几个字段当"亿"用
      net: round2(mul(num(r.fields.board_main_net_today), 1e-8)),
      inflow: null,   // 端点只给净额,拆不出流入 / 流出
      outflow: null,
      firms: null,
    }))
    .sort((a, b) => descNullable(a.net, b.net));

  return {
    sentiment: {
      up,
      down,
      flat: null,      // 见 MarketSentiment 的说明:相减出来的"平盘"是假精确
      zt: ztCount,
      zt_real: null,   // 取数层给不出"剔除一字新股"的口径
      dt: dtCount,
      dt_real: null,
      active: zbCount === null ? "" : `炸板 ${zbCount}`,
      breadth: breadthLabel(up, down),
      speculation: speculationLabel(ztCount, maxBoards),
      date: sent.evidence[0]?.period ?? sent.fetched_at.slice(0, 10),
    },
    sectors,
    updated: sent.fetched_at,
  };
}

async function emotionOf(): Promise<ShortTermEmotion> {
  const [zt, zb, yzt] = await Promise.all([
    env("em_zt_pool"),
    env("em_zb_pool").catch(() => undefined),
    env("em_yzt_pool").catch(() => undefined),
  ]);

  const base = rows(zt)
    .map((r) => {
      const p = poolNote(r.note);
      return {
        code: p?.code ?? r.key,
        name: p?.name ?? "",
        boards: num(r.fields.pool_limit_days) ?? p?.boards ?? 1,
        pct: num(r.fields.pool_change_pct),
        industry: p?.industry ?? "",
      };
    })
    .sort((a, b) => b.boards - a.boards);

  // 涨停池只给涨幅 / 板数 / 封板资金,**没有价格与成交额** —— 价格现拉一次批量行情补上。
  // ⚠️ 只补要展示的那几只,不为看不见的行拖一次大请求。
  const shown = base.filter((x) => x.boards >= 2).slice(0, 40);
  const q = shown.length ? await quoteMap(shown.map((x) => x.code)).catch(() => ({}) as Record<string, Quote>) : {};
  const stocks: LianbanStock[] = base.map((x) => {
    const hit = q[x.code];
    return {
      ...x,
      price: hit?.price ?? null,
      /**
       * 涨停池本身**没有**成交额与流通市值（它只给涨幅 / 板数 / 封板资金 / 换手），
       * 所以从上面那次批量行情里取 —— 这两列以前写死 null，结果是"列在、永远是横杠"。
       * ⚠️ 单位：页面的 `yi()` 吃「元」，而行情给的是「亿元」⇒ 这里 ×1e8。
       * ⚠️ 没取到行情的（超出补行情范围的那些）仍然给 null：**别拿 0 冒充没有**。
       */
      amount: hit?.amount_yuan ?? null,
      float_cap: mul(hit?.float_mcap_yi ?? null, 1e8),
    };
  });

  // 晋级率要用的两组代码（昨日涨停池 / 今日涨停池）
  const yztCodes = new Set(yzt ? rows(yzt).map((r) => r.key).filter((k) => /^\d{6}$/.test(k)) : []);
  const todayCodes = stocks.map((x) => x.code);

  const ztCount = num(scalar(zt, "limit_up_pool_count")) ?? stocks.length;
  const zbCount = zb ? num(scalar(zb, "break_board_pool_count")) : null;
  const yztCount = yzt ? num(scalar(yzt, "yesterday_limit_up_pool_count")) : null;
  const lianban = stocks.filter((x) => x.boards >= 2);
  const maxBoards = stocks.length ? stocks[0]!.boards : 0;

  // 梯队:每个板数一档,>=4 板合并成"4 板+"
  const tierMap = new Map<number, number>();
  for (const x of lianban) {
    const k = Math.min(x.boards, 4);
    tierMap.set(k, (tierMap.get(k) ?? 0) + 1);
  }
  const ladder: EmotionTier[] = [...tierMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([boards, count]) => ({ boards, count, plus: boards === 4 }));

  // 封板率 = 涨停 /(涨停 + 炸板);炸板率 = 炸板 /(涨停 + 炸板)。**炸板数取不到就都给 null**
  const denom = zbCount === null ? null : ztCount + zbCount;
  return {
    date: zt.evidence[0]?.period ?? zt.fetched_at.slice(0, 10),
    zt_count: ztCount,
    dt_count: 0,
    zb_count: zbCount ?? 0,
    max_boards: maxBoards,
    lianban_count: lianban.length,
    ladder,
    lianban_stocks: lianban.slice(0, 40),
    // 🔴 给**比值(0-1)**不是百分数 —— 页面自己 ×100。给百分数会显示成 7101%
    seal_rate: denom ? Math.round((ztCount / denom) * 1e4) / 1e4 : null,
    break_rate: denom && zbCount !== null ? Math.round((zbCount / denom) * 1e4) / 1e4 : null,
    /**
     * 晋级率 = 昨日涨停池 ∩ 今日涨停池 ÷ 昨日涨停池。
     * 🔴 以前写死 null（注释说"两个池给不出这个交集"）—— **那是看错了**：两个池都是按代码分行的，
     *    交集直接算得出来。写死 null 的结果是界面上一个永远显示"—"的指标。
     * ⚠️ 口径就是这块牌子上写的"昨涨停今又停"，不是分层的首板晋级率。
     * ⚠️ 昨日池取不到时给 null（真的没有），不拿 0 冒充。
     */
    promotion_rate: yztCodes.size
      ? Math.round((todayCodes.filter((c) => yztCodes.has(c)).length / yztCodes.size) * 1e4) / 1e4
      : null,
    yzt_count: yztCount ?? 0,
  };
}

async function turnoverTopOf(): Promise<TurnoverTop> {
  const e = await env("em_turnover_rank");
  // note:`中际旭创(300308)·通信设备;成交额榜第 1 名(全市场 5904 只)`
  const NOTE = /^(.+?)\((\d{6})\)·([^;]*)/;
  // 榜单端点只给 价格 / 涨跌 / 成交额 / 名次 —— **总市值要另外取一次批量行情**。
  // 以前这一列写死 null，于是表头有「总市值」而每一行都是横杠。
  const codes = rows(e)
    .map((r) => NOTE.exec(r.note)?.[2] ?? r.key.replace(/^stock\|/, ""))
    .filter((c) => /^\d{6}$/.test(c));
  const q = codes.length ? await quoteMap(codes).catch(() => ({}) as Record<string, Quote>) : {};
  const stocks: TurnoverStock[] = rows(e)
    .map((r) => {
      const m = NOTE.exec(r.note);
      const amt = num(r.fields.turnover_amount);
      return {
        rank: num(r.fields.turnover_rank) ?? 9999,
        code: m?.[2] ?? r.key.replace(/^stock\|/, ""),
        name: m?.[1] ?? "",
        price: num(r.fields.last_price),
        pct: num(r.fields.change_pct),
        // 🔴 给**元**原值 —— 页面自己换算成亿(`yi()`)。这里先除一遍,显示出来就是 0 亿
        amount: amt,
        // ⚠️ 行情给的是亿元，`yi()` 吃元 ⇒ ×1e8；取不到就是 null(显示"—")，不拿 0 冒充
        mcap: mul(m?.[2] ? q[m[2]]?.mcap_yi ?? null : null, 1e8),
        float_cap: mul(m?.[2] ? q[m[2]]?.float_mcap_yi ?? null : null, 1e8),
        industry: m?.[3] ?? "",
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...x }) => x);
  return { stocks, updated: e.fetched_at };
}

/* ---------- 资讯雷达 / 产业信号 ---------- */

const RADAR_ACCENTS = ["#f97316", "#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#facc15", "#60a5fa", "#fb7185"];

/**
 * 资讯雷达。取数层是**按行业一次一个**,页面要的是全部行业 ⇒ 并发取。
 *
 * 🔴 行业清单**由取数层随信封下发**(`extra.industries`),前端不写死一份 ——
 *    写死的那份迟早跟真实源对不上,而对不上的表现是"选了没反应",看不出是配置漂移。
 * ⚠️ 默认读快照(打开页面不重跑上游);点刷新才真去抓。
 */
async function radarOf(refresh = false): Promise<RadarData> {
  const first = (await backend.fetch("rss_news", { args: { industry: "ai", per_source: 6 }, refresh })).envelope;
  const list = ((first.extra?.industries as { key: string; name: string }[] | undefined) ?? [
    { key: "ai", name: "AI / 大模型" },
  ]);

  const build = (e: Envelope, key: string, name: string, i: number): Industry => {
    const items: RadarItem[] = rows(e).map((r) => {
      const kv = noteKV(r.note);
      const t = r.fields.news_title;
      return {
        title: str(t),
        url: kv.link ?? kv.url ?? r.key,
        time: t?.period ?? t?.as_of ?? "",
        source: kv.source ?? "",
        ...(str(r.fields.news_summary) ? { summary: str(r.fields.news_summary) } : {}),
      };
    });
    return { key, name, accent: RADAR_ACCENTS[i % RADAR_ACCENTS.length]!, total: items.length, items };
  };

  const rest = await Promise.all(
    list.slice(1).map((ind) =>
      backend
        .fetch("rss_news", { args: { industry: ind.key, per_source: 6 }, refresh })
        .then((r) => r.envelope)
        // 🔴 单个行业挂掉不废整页,但**它的条数会是 0** —— 页面上要看得出是"这个源没抓到"
        .catch(() => undefined),
    ),
  );

  const industries: Industry[] = [
    build(first, list[0]!.key, list[0]!.name, 0),
    ...rest.map((e, i) => {
      const ind = list[i + 1]!;
      return e ? build(e, ind.key, ind.name, i + 1)
               : { key: ind.key, name: ind.name, accent: RADAR_ACCENTS[(i + 1) % RADAR_ACCENTS.length]!, total: 0, items: [] };
    }),
  ];

  // 🔴 "源数"是源数,不是条数 —— 各行业的 rss_sources_ok 相加。
  //    (拿条数填这一格,界面会写出"462 个公开源"这种一眼假的数。)
  const envs = [first, ...rest.filter((e): e is Envelope => !!e)];
  const sources = envs.reduce((a, e) => a + (num(scalar(e, "rss_sources_ok")) ?? 0), 0);
  const failed = envs.reduce((a, e) => a + ((e.extra?.failures as unknown[] | undefined)?.length ?? 0), 0);
  return {
    generated_at: first.fetched_at,
    recent_days: 3,
    industries,
    stats: { industries: industries.length, total_sources: sources, failed_sources: failed },
  };
}

async function gpuRentOf(refresh = false): Promise<GpuRentData> {
  const e = (await backend.fetch("gpu_rent_thermometer", { refresh })).envelope;
  /**
   * 现货卡 = 曲线的最后一个点（取数层派生，见 industry._spot_from_history）⇒
   * 卡片上的数字与曲线末端**严格一致**。
   * 🔴 **不能只留有中位价的那些行**：某张卡暂时没有序列时它只有 `gpu_available_count`，
   *    过滤掉的话那张卡的卡片会整个消失 —— 用户看到的是"少了一张卡"，而不是"这张卡暂时没数据"。
   */
  const numOrNull = (v: string | undefined) => {
    const n = Number(v);
    return v === undefined || v === "" || v === "None" || !Number.isFinite(n) ? null : n;
  };
  const spot = rows(e)
    // 🔴 三种情况都要出卡片：有中位价 / 只有挂单卡数 / **未覆盖**（status 型证据）。
    //    漏掉最后一种的话，取不到序列的那张卡会**整张消失** —— 用户看到的是"只有两张卡"，
    //    而不是"第三张没覆盖到"，与"把没取到渲染成正常结果"是同一个坑的另一面。
    .filter((r) => r.fields.gpu_spot_median_usd_per_gpu_hr || r.fields.gpu_available_count
                || r.fields.gpu_spot_status)
    .map((r) => {
      const kv = noteKV(r.note);
      const median = num(r.fields.gpu_spot_median_usd_per_gpu_hr);
      return {
        gpu: r.key,
        ...(median === null ? { unavailable: true } : { median }),
        available_gpus: numOrNull(kv.available_gpus),
        total_gpus: numOrNull(kv.total_gpus),
        asof_ts: numOrNull(kv.asof_ts) ?? undefined,
        note: r.note,
      } as GpuSpot;
    });
  /**
   * 近一年逐日曲线 —— **取数层直接给**（500.farm 对 Vast 可租挂单的逐日中位统计，
   * 与开源版同一个源、同一条查询）。
   *
   * 🔴 以前这里画的是**本机温度计历史序列**：那条序列只在完整研究运行时才追加，
   *    新装的机器上就是几个点、跨度不到一天 —— 顶着"近一年走势"的标题画出来，
   *    是让标题替数据打包票。现在曲线有自己的真实来源，序列继续留着做跨运行对账，
   *    但不再拿它冒充一年。
   * ⚠️ 三张卡各自成败：某一张拿不到就只少一条线，并把它自己的原因带出来。
   */
  const rawHist = (e.extra?.history ?? {}) as {
    gpus?: GpuHistSeries[]; days?: number; source?: string; errors?: string[];
  };
  const histGpus = Array.isArray(rawHist.gpus) ? rawHist.gpus : [];
  const usable = histGpus.filter((g) => (g.points?.length ?? 0) > 0);
  const history = usable.length
    ? { gpus: histGpus, days: rawHist.days ?? 0 }
    : {
        // 一条线都没有：**说清楚为什么**，不给一条空曲线冒充"没有波动"
        gpus: [{
          gpu: "B200",
          unavailable: true,
          note: rawHist.errors?.length ? rawHist.errors.join("；") : "统计站这次没有返回可用序列",
        } as GpuHistSeries],
        days: 0,
      };
  const spanDays = Math.max(
    0,
    ...usable.map((g) => {
      const pts = g.points ?? [];
      return pts.length > 1 ? Math.round((pts[pts.length - 1]![0] - pts[0]![0]) / 86400) : 0;
    }),
  );
  const spanNote = usable.length ? `${usable.length} 张卡 · 覆盖 ${spanDays} 天` : "";

  return {
    generated_at: e.fetched_at,
    // 🔴 读法直接照抄取数层的护栏句 —— 不改写、不省略
    how_to_read: [...new Set(e.evidence.map((x) => (x.note ?? "").split("读法:")[1]).filter(Boolean) as string[])],
    spot_source: (e.extra?.spot_source as string | undefined) ?? "现货 = 走势曲线的最新采样点",
    history_source: `${rawHist.source ?? "统计站逐日中位"}${spanNote ? ` · ${spanNote}` : ""}`,
    forward_source: "Kalshi 远期合约",
    spot: { gpus: spot },
    history,
    forward: null,
    errors: e.errors.length ? e.errors.map((x) => String(x)) : null,
  };
}

/* ---------- 个股信号 ---------- */

async function dragonTigerOf(code: string): Promise<DragonTiger> {
  const e = await env("em_dragon_tiger", { symbol: code });
  const records = rows(e).map((r) => ({
    date: r.fields.dt_net_buy?.period ?? r.key,
    reason: noteKV(r.note).reason ?? r.note,
    net_buy: num(r.fields.dt_net_buy),
    turnover: num(r.fields.dt_turnover),
  }));
  return { records, seats: { buy: [], sell: [] }, institution: { buy_amt: 0, sell_amt: 0, net_amt: 0 } };
}

async function lockupOf(code: string): Promise<Lockup> {
  const e = await env("em_lockup_expiry", { symbol: code });
  const today = new Date().toISOString().slice(0, 10);
  const all: LockupRow[] = rows(e).map((r) => ({
    date: r.fields.lockup_shares?.period ?? r.key,
    type: noteKV(r.note).type ?? r.note,
    shares: num(r.fields.lockup_shares),
    able_shares: num(r.fields.lockup_able_shares),
    ratio: num(r.fields.lockup_ratio),
  }));
  return {
    history: all.filter((x) => x.date < today),
    upcoming: all.filter((x) => x.date >= today),
  };
}

async function blocksOf(code: string): Promise<Blocks> {
  const e = await env("em_concept_blocks", { symbol: code });
  const boards: Board[] = rows(e).map((r) => {
    const kv = noteKV(r.note);
    return {
      // 🔴 板块名是**证据的 value**(食品饮料 / 白酒Ⅲ),不在 note 里。
      //    原来找 `name=` 这个根本不存在的键,取不到就回退 `?? r.note` ——
      //    于是界面上显示的是 `板块代码=BK0438;当日涨跌=-0.38%;龙头=五芳斋` 这条内部字符串。
      //    ⚠️ 回退到原始 note 比显示空更糟:它看着像内容,用户不知道那是调试文本。
      name: str(r.fields.board_membership) || r.key,
      code: kv.板块代码 ?? r.key,
      change_pct: kv.当日涨跌 ?? "",
      lead_stock: kv.龙头 ?? "",
    };
  });
  return { total: boards.length, boards, concept_tags: boards.map((b) => b.name).filter(Boolean) };
}

async function hotConceptsOf(code: string): Promise<HotConcept[]> {
  const e = await env("em_hot_concept", { symbol: code });
  return rows(e)
    // 端点里混着一条汇总(hot_concept_count,没有 record_key)—— 它不是一个概念,别当条目渲染
    .filter((r) => r.fields.hot_concept_hit !== undefined)
    .map((r) => ({
      // 同上:概念名在 note 的 `概念=` 里,不是 `name=`
      concept: noteKV(r.note).概念 ?? r.key,
      bk: r.key,
      hit: num(r.fields.hot_concept_hit) ?? 0,
    }));
}

async function investorQaOf(code: string): Promise<QaRow[]> {
  const e = await env("cninfo_irm", { symbol: code });
  return rows(e).map((r) => ({
    company: str(r.fields.irm_company),
    question: str(r.fields.irm_question),
    answer: str(r.fields.irm_answer) || null,
    answerer: str(r.fields.irm_answerer),
    ask_time: r.fields.irm_question?.period ?? "",
  }));
}

/* ---------- 事件概率 ---------- */

/**
 * 全球宏观预期概率 —— 预测市场（Polymarket / Kalshi）的公开定价。
 *
 * 🔴 这是**市场当前定价**，不是预测、更不是我们的判断。取数层的「读法」护栏原样带出，
 *    界面必须与数字同屏显示 —— 只给一个百分比而不给读法，等于替上游打包票。
 */
async function macroProbabilityOf(refresh = false): Promise<MacroProbability> {
  const e = await env("macro_probability", { refresh });
  // note: `[话题] 来源 合约「标题」(腿)的市场定价概率(口径:…);结算日 YYYY-MM-DD(…);24h 成交量 N;读法:…`
  const NOTE = /^\[([^\]]+)\]\s*(\S+)\s*合约「([^」]*)」\(([^)]*)\)/;
  const VOL = /24h\s*成交量\s*([\d.]+)/;
  const items: MacroProbItem[] = rows(e).map((r) => {
    const m = NOTE.exec(r.note);
    const ev = r.fields.macro_probability;
    const [topic = "", source = ""] = r.key.split(":");
    return {
      topic: m?.[1] ?? topic,
      source: m?.[2] ?? source,
      title: m?.[3] ?? "",
      leg: m?.[4] ?? "",
      prob: num(ev),
      settle: ev?.period ?? "",
      volume: VOL.exec(r.note) ? Number(VOL.exec(r.note)![1]) : null,
    };
  });
  return {
    items: items.sort((a, b) => (b.prob ?? -1) - (a.prob ?? -1)),
    how_to_read: [...new Set(e.evidence.map((x) => (x.note ?? "").split("读法:")[1]).filter(Boolean) as string[])],
    updated: e.fetched_at,
    // partial = 有的源没取到。🔴 要说出来 —— 否则用户会以为"就这么几条"
    partial: e.status !== "ok",
  };
}

/* ---------- 持仓:走**用户自有台账**,不另起一套存储 ---------- */

/**
 * 上游把持仓存在它自己的后端文件里;我们已经有台账(`position` 种类),
 * 再存一份就会有两个真相。⇒ 这里读台账 + 现拉行情算市值盈亏。
 *
 * 清仓历史存 closed_position 台账，不在浏览器另建存储；币种分别汇总。
 */
async function portfolioOf(): Promise<PortfolioData> {
  const led = await backend.ledger();
  const held = (led.records.position ?? []).filter((r) => normalizeMarketSymbol(r.symbol));
  const codes = [...new Set(held.map((r) => normalizeMarketSymbol(r.symbol)!).filter(Boolean))];
  const quotes = codes.length ? await quoteMap(codes).catch(() => ({}) as Record<string, Quote>) : {};

  const holdings: Holding[] = held.map((r) => {
    const code = normalizeMarketSymbol(r.symbol)!;
    const market = marketOfSymbol(code)!;
    const currency = currencyOfSymbol(code)!;
    const shares = Number(r.shares ?? 0);
    const cost = Number(r.cost ?? 0);
    const q = quotes[code];
    // 🔴 拉不到行情(整只票缺席,或缺了 price 这一项)时一律 null —— 不拿成本冒充现价,
    //    也不填 0:那会把浮盈显示成"正好不赚不亏",而它其实是没取到。
    const price = q?.price != null && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
    const mv = price === null ? null : price * shares;
    const pnl = price === null ? null : (price - cost) * shares;
    return {
      code,
      name: String(r.name ?? q?.name ?? ""),
      market,
      currency,
      price,
      shares,
      cost,
      market_value: round2(mv),
      pnl: round2(pnl),
      pnl_pct: price !== null && cost > 0 ? round2(((price - cost) / cost) * 100) : null,
    };
  });

  // 合计只累加**拿到行情的那些**，并且必须按币种分组。
  // 人民币 10 万 + 美元 2 万 + 港元 3 万没有一个不经换算就成立的「总数」。
  const totalMap = new Map<CurrencyCode, Holding[]>();
  for (const h of holdings) {
    if (h.market_value === null) continue;
    totalMap.set(h.currency, [...(totalMap.get(h.currency) ?? []), h]);
  }
  const totals = [...totalMap.entries()].map(([currency, items]) => {
    const mv = items.reduce((a, h) => a + (h.market_value ?? 0), 0);
    const costSum = items.reduce((a, h) => a + h.cost * h.shares, 0);
    const market = items[0]!.market;
    return {
      market,
      currency,
      label: currencyLabel(currency),
      market_value: round2(mv)!,
      cost: round2(costSum)!,
      pnl: round2(mv - costSum)!,
      pnl_pct: costSum > 0 ? round2(((mv - costSum) / costSum) * 100)! : null,
    };
  });
  const closedRecords = led.records.closed_position ?? [];
  const closed: ClosedPosition[] = closedRecords.flatMap(r => {
    const code = normalizeMarketSymbol(r.symbol);
    const price = Number(r.price), shares = Number(r.shares), cost = Number(r.cost);
    const day = typeof r.closed_at === "string" ? Date.parse(r.closed_at) : NaN;
    if (!code || ![r.price, r.shares, r.cost].every(v => typeof v === "number" && Number.isFinite(v))
        || price <= 0 || shares <= 0 || !Number.isFinite((price - cost) * shares)
        || typeof r.closed_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.closed_at)
        || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== r.closed_at) return [];
    return [{ id: r.id, code, name: String(r.name || code), note: typeof r.note === "string" ? r.note : "", currency: currencyOfSymbol(code)!,
      date: String(r.closed_at), price, shares, cost, pnl: round2((price - cost) * shares)!,
      pnl_pct: cost > 0 ? round2((price - cost) / cost * 100) : null }];
  });
  const realized = new Map<CurrencyCode, number>();
  for (const r of closed) realized.set(r.currency, (realized.get(r.currency) ?? 0) + r.pnl);
  return {
    holdings,
    totals,
    closed,
    closed_invalid: closedRecords.length - closed.length,
    realized_totals: [...realized].map(([currency, pnl]) => ({ currency, pnl: round2(pnl)! })),
    updated: new Date().toISOString(),
    last_refresh: null,
  };
}

/**
 * 加一笔持仓。**同代码是加仓,不是覆盖** —— 页面上写着"按加权平均成本合并",
 * 实现必须真的合并,否则界面说的和做的两回事(而且第二次录入会静默抹掉第一次的股数)。
 */
async function addHoldingTo(code: string, shares: number, cost: number): Promise<PortfolioData> {
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost)) throw new ApiError("数量须为正数，成本须为有效数字", 400, "bad_input");
  const symbol = normalizeMarketSymbol(code);
  if (!symbol) throw new ApiError("请输入 A 股、港股或美股代码", 400, "bad_symbol");
  const led = await backend.ledger();
  const existing = (led.records.position ?? []).find((r) => normalizeMarketSymbol(r.symbol) === symbol);

  let nextShares = shares;
  let nextCost = cost;
  if (existing) {
    const oldShares = Number(existing.shares ?? 0);
    const oldCost = Number(existing.cost ?? 0);
    nextShares = oldShares + shares;
    // 加权平均。⚠️ 合并后股数为 0(或更少)时算不出均价 —— 那是"清掉了",直接删记录
    nextCost = nextShares > 0 ? Math.round(((oldShares * oldCost + shares * cost) / nextShares) * 1e4) / 1e4 : 0;
    if (nextShares <= 0) {
      await backend.ledgerDelete("position", existing.id);
      return portfolioOf();
    }
  }

  await backend.ledgerSave("position", {
    // 🔴 整条替换,不做字段级合并 —— 台账的更新语义是整条覆盖,
    //    只发变化的字段会把 name / account / note 一起清空且不报错
    ...(existing ?? {}),
    symbol,
    shares: nextShares,
    cost: nextCost,
  });
  return portfolioOf();
}

async function removeHoldingFrom(code: string): Promise<PortfolioData> {
  const symbol = normalizeMarketSymbol(code);
  if (!symbol) return portfolioOf();
  const led = await backend.ledger();
  const hit = (led.records.position ?? []).find((r) => normalizeMarketSymbol(r.symbol) === symbol);
  if (hit) await backend.ledgerDelete("position", hit.id);
  return portfolioOf();
}

/* ---------- 美股 / 港股 ---------- */

/** 代码带 `.HK` / 5 位数字当港股,其余当美股。取数层自己也会再判一次,这里只用来填 market 字段 */
const guessMarket = (code: string): string =>
  /\.HK$/i.test(code) || /^\d{4,5}$/.test(code.trim()) ? "HK" : "US";

async function globalStockOf(code: string): Promise<GlobalStock> {
  const [q, k] = await Promise.all([
    env("em_global_quote", { symbol: code }),
    // 关键指标可能没有(ETF / 冷门票)—— 缺了不影响行情部分
    env("em_global_key_indicators", { symbol: code }).catch(() => undefined),
  ]);
  const f = (name: string) => scalar(q, name);

  let metrics: GlobalMetrics | null = null;
  if (k) {
    // 最近一期 = period 最大的那一期
    const periods = [...new Set(k.evidence.map((x) => x.period))].sort();
    const latest = periods[periods.length - 1];
    const at = (name: string) => k.evidence.find((x) => x.field === name && x.period === latest);
    if (latest) {
      metrics = {
        report_date: latest,
        revenue: num(at("revenue")),
        revenue_yoy: num(at("revenue_yoy")),
        net_profit: num(at("net_profit_parent")),
        eps: num(at("eps_diluted")) ?? num(at("eps_basic")),
        roe: num(at("roe")),
        gross_margin: num(at("gross_margin")),
        net_margin: num(at("net_margin")),
        debt_ratio: num(at("debt_asset_ratio")),
      };
    }
  }

  return {
    code,
    name: str(f("security_name")),
    market: guessMarket(code),
    quote: {
      code,
      name: str(f("security_name")),
      price: num(f("price")),
      open: num(f("open")),
      high: num(f("high")),
      low: num(f("low")),
      prev_close: num(f("last_close")),
      amount: num(f("turnover_amount")),
      mcap: num(f("market_cap")),   // 端点不一定给,给不出就是 null(页面显示"—")
      change_pct: num(f("change_pct")),
    },
    metrics,
  };
}

async function hkCashflowOf(code: string): Promise<HkCashflow> {
  const e = await env("em_global_cashflow", { symbol: code });
  // 🔴 record_key 实际是 `<报告期>|<科目>` —— 注释和解构原来都写反了。
  //    于是 `byPeriod` 按**科目**分组、`order` 收的是**报告期**,整张表两个轴对调:
  //    表头那句 `report_date.slice(0,7)`(为日期写的)套在科目名上,
  //    把「投资活动产生的现金流量净额」截成「投资活动产生的」——
  //    数值因为转置一致所以还对得上,**只有表头是错的**,最难看出来。
  const order: string[] = [];
  const byPeriod = new Map<string, HkCashflowPeriod>();
  for (const r of rows(e)) {
    const [periodKey = "", item = ""] = r.key.split("|");
    const amountEv0 = Object.values(r.fields)[0];
    // ⚠️ 展示用**证据自己的资料期**(真实日期 2026-06-27),不用 record_key 里的标签:
    //    上游那个标签会出现 `2026/Q9` 这种不存在的季度,直接摆到界面上就是编出来的期间。
    const period = amountEv0?.period || periodKey;
    if (!byPeriod.has(period)) {
      byPeriod.set(period, {
        report_date: period,
        report: null,
        currency: null,
        account_standard: null,
        items: {},
      });
    }
    const p = byPeriod.get(period)!;
    const amountEv = Object.values(r.fields)[0];
    if (!order.includes(item)) order.push(item);
    p.items[item] = { amount: num(amountEv), yoy: num(r.fields.yoy) };
    p.currency ??= amountEv?.currency || null;
  }
  const periods = [...byPeriod.values()].sort((a, b) => b.report_date.localeCompare(a.report_date));
  return {
    code,
    name: "",
    market: guessMarket(code),
    currency: periods[0]?.currency ?? null,
    item_order: order,
    periods,
  };
}

export const api = {
  health: () => backend.health().then((h) => ({ ok: h.ok })),

  quote: (codes: string, refresh = false) => quoteMap(codes.split(",").map((c) => c.trim()).filter(Boolean), refresh),
  valuation: valuationOf,
  percentile: percentileOf,
  financials: financialsOf,
  announcements: announcementsOf,
  reports: reportsOf,
  news: newsOf,
  margin: marginOf,
  blockTrade: blockTradeOf,
  holders: holdersOf,
  dividend: dividendOf,
  fundFlow: fundFlowOf,

  indices: async (refresh = false): Promise<IndexQuote[]> => {
    const codes = ["sh000001", "sh000300", "sz399001", "sz399006"];
    const e = await env("tx_quotes_batch", { args: { codes }, refresh });
    return rows(e).filter((r) => codes.includes(r.key)).map((r) => ({
      name: str(r.fields.security_name),
      price: num(r.fields.price),
      change_pct: num(r.fields.change_pct),
      change_amt: subtract(num(r.fields.price), num(r.fields.last_close)),
    }));
  },

  industry: async (top = 20): Promise<IndustryData> => {
    const e = await env("em_industry_comparison");
    const all = rows(e)
      .map((r, i) => ({
        rank: i + 1,
        name: r.note.replace(/^\S+\s/, "") || r.key,
        change_pct: num(r.fields.industry_board_change_pct),
        code: r.key,
        up_count: num(r.fields.industry_board_up_count),
        down_count: num(r.fields.industry_board_down_count),
      }))
      .sort((a, b) => descNullable(a.change_pct, b.change_pct))
      .map((x, i) => ({ ...x, rank: i + 1 }));
    return { top: all.slice(0, top), bottom: all.slice(-top).reverse(), total: all.length };
  },

  // 下面这些底座还没接:如实抛错,**不返回空**(空会被读成"今天没有数据")
  marketOverview: marketOverviewOf,
  emotion: emotionOf,
  turnoverTop: turnoverTopOf,
  macroProbability: macroProbabilityOf,
  globalIndices: async (refresh = false): Promise<GlobalIndex[]> => {
    const specs = [
      ["usDJI", "道琼斯", "美股"], ["usIXIC", "纳斯达克综合", "美股"],
      ["hkHSI", "恒生指数", "港股"], ["hkHSTECH", "恒生科技", "港股"],
    ] as const;
    const e = await env("tx_quotes_batch", { args: { codes: specs.map(([key]) => key) }, refresh });
    const byKey = new Map(rows(e).map((r) => [r.key, r]));
    const result = specs.map(([key, name, region]): GlobalIndex => {
      const row = byKey.get(key);
      const value = num(row?.fields.price);
      const price = value !== null && value > 0 ? value : null;
      return {
        key, name, region, price,
        change_pct: price === null ? null : num(row?.fields.change_pct),
        fetched_at: price === null ? null : row?.fields.price?.fetched_at ?? null,
        evidence_id: price === null ? null : row?.fields.price?.id ?? null,
        note: price === null ? "本次未取得该指数报价" :
          [typeof e.extra?.degraded === "string" ? e.extra.degraded : "", row?.note.includes("僵尸报价") ? "非交易时段或报价陈旧" : ""].filter(Boolean).join("；"),
      };
    });
    if (!result.some((r) => r.price !== null)) throw new Error("全球指数未取得可用数据，请稍后刷新；不代表市场没有变化。");
    return result;
  },
  globalStock: globalStockOf,
  hkCashflow: hkCashflowOf,
  radar: () => radarOf(false),
  radarRefresh: () => radarOf(true),
  gpuRent: () => gpuRentOf(false),
  gpuRentRefresh: () => gpuRentOf(true),
  portfolio: portfolioOf,
  addHolding: addHoldingTo,
  removeHolding: removeHoldingFrom,
  refreshPortfolio: portfolioOf,
  closePosition: async (code: string, date: string, price: number, shares: number, cost: number, details: { name?: string; note?: string } = {}): Promise<PortfolioData> => {
    const symbol = normalizeMarketSymbol(code);
    if (!symbol || ![price, shares, cost].every(Number.isFinite) || price <= 0 || shares <= 0) throw new ApiError("请检查代码、数量及清仓价格", 400, "bad_input");
    await backend.ledgerSave("closed_position", { symbol, closed_at: date, price, shares, cost, name: details.name?.trim() || "", note: details.note?.trim() || "" });
    return portfolioOf();
  },
  removeClosed: async (id: string): Promise<PortfolioData> => {
    await backend.ledgerDelete("closed_position", id);
    return portfolioOf();
  },
  dragonTiger: dragonTigerOf,
  lockup: lockupOf,
  blocks: blocksOf,
  hotConcepts: hotConceptsOf,
  investorQa: investorQaOf,
  myReports: (): Promise<MyReport[]> => backend.reports(),
  uploadReport: (name: string, content: string): Promise<MyReport> => backend.reportUpload(name, content),
  deleteReport: async (id: string): Promise<{ ok: boolean }> => ({ ok: (await backend.reportDelete(id)).removed }),
};
