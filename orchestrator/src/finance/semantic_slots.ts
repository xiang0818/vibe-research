/**
 * **金融语义槽位表**:验证"输入选对了" —— 引用对的证据字段 / 期间、对的上游计算(按口径角色),
 * 且实参值 == 所引用证据值(单位参数 == 证据单位)、下游实参 == 上游计算 output.value。
 *
 * 这张表整体是垂类内容(字段名、财年语义、计算函数全是金融的);
 * **走这张表的机制留在 Core 的 `validator.ts`** —— 换个垂类只换表,不改机制。
 */
import type { Role, Slot } from "../validator.ts";

/** 口径角色:营收 / 归母 / 扣非(累计口径) */
export const FINANCE_ROLES: Role[] = ["revenue_cum", "net_profit_parent_cum", "net_profit_deducted_cum"];

export const FINANCE_SLOTS: Record<string, Slot[]> = {
  financials: [
    { fn: "quarterize", distinctBy: "field", requiredGroups: [...FINANCE_ROLES] },
    { fn: "latest_quarter", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_deducted_cum"] },
    { fn: "ttm_sum", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_parent_cum"] },
    { fn: "ttm_yoy", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_parent_cum"] },
    { fn: "qoq", upstream: [{ fn: "quarterize" }], coverRoles: ["net_profit_deducted_cum"] },
  ],
  estimates: [
    { fn: "forward_cagr", evidenceFields: ["eps_consensus_mean"], constArgs: { years: 2 },
      bind: [{ arg: "eps_t", field: "eps_consensus_mean", fy: "T" }, { arg: "eps_t_plus_n", field: "eps_consensus_mean", fy: "T+years" }] },
    { fn: "consensus_dispersion", evidenceFields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"],
      bind: [{ arg: "low", field: "eps_consensus_min", fy: "T+2" }, { arg: "mean", field: "eps_consensus_mean", fy: "T+2" }, { arg: "high", field: "eps_consensus_max", fy: "T+2" }],
      samePeriod: { fields: ["eps_consensus_min", "eps_consensus_mean", "eps_consensus_max"], fy: "T+2" } },
  ],
  valuation: [
    { fn: "pe_deducted_annualized", evidenceFields: ["total_market_cap"], upstream: [{ fn: "latest_quarter", role: "net_profit_deducted_cum" }],
      bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }],
      bindUpstream: [{ arg: "latest_quarter_deducted_profit", fn: "latest_quarter", role: "net_profit_deducted_cum", unitArg: "profit_unit" }] },
    { fn: "forward_pe", evidenceFields: ["price", "eps_consensus_mean"], bind: [{ arg: "price", field: "price" }, { arg: "eps_forecast", field: "eps_consensus_mean", fy: "T" }] },
    { fn: "pe_ttm_from_parts", evidenceFields: ["total_market_cap"], upstream: [{ fn: "ttm_sum", role: "net_profit_parent_cum" }],
      bind: [{ arg: "total_market_cap", field: "total_market_cap", unitArg: "cap_unit" }],
      bindUpstream: [{ arg: "ttm_profit", fn: "ttm_sum", role: "net_profit_parent_cum", unitArg: "profit_unit" }] },
    { fn: "percentile_rank", evidenceFields: ["pe_ttm_traded_history_points", "pe_ttm"], bind: [{ arg: "current", field: "pe_ttm" }],
      bindSeries: [{ arg: "history", field: "pe_ttm_traded_history_points", column: "peTTM", where: { tradestatus: "1" }, dateColumn: "date" }] },
    { fn: "peg", upstream: [{ fn: "pe_deducted_annualized" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_deducted_annualized" }, { arg: "cagr", fn: "forward_cagr" }] },
    { fn: "pe_digestion_scenarios", upstream: [{ fn: "pe_deducted_annualized" }, { fn: "forward_cagr" }], bindUpstream: [{ arg: "pe", fn: "pe_deducted_annualized" }, { arg: "cagr", fn: "forward_cagr" }] },
    { fn: "forward_vs_ttm_judgement", upstream: [{ fn: "forward_cagr" }, { fn: "ttm_yoy", role: "net_profit_parent_cum" }],
      bindUpstream: [{ arg: "forward_cagr_value", fn: "forward_cagr" }, { arg: "ttm_yoy_value", fn: "ttm_yoy", role: "net_profit_parent_cum" }] },
  ],
};
