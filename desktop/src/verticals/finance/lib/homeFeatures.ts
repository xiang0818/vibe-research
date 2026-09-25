/** Primary routes only; subpages stay in their existing sections, not this home directory. */
export const HOME_FEATURE_GROUPS = [
  { title: "市场与资讯", detail: "先了解市场正在发生什么", features: [
    { to: "/daily-review", title: "每日复盘", detail: "盘面表现、资金与连板数据" },
    { to: "/intel", title: "资讯雷达", detail: "聚合新闻、公告与事件线索" },
  ] },
  { title: "行业与赛道", detail: "沿产业链寻找证据", features: [
    { to: "/signals", title: "产业信号", detail: "跟踪上下游的变化线索" },
    { to: "/sectors", title: "板块中心", detail: "按板块梳理产业链环节" },
  ] },
  { title: "公司研究与验证", detail: "从观点走到可核对的结论", features: [
    { to: "/research", title: "个股研究", detail: "公司数据、六阶段研究与证据" },
    { to: "/debate", title: "多空辩论", detail: "对照正反观点，寻找盲点" },
    { to: "/backtest", title: "回测", detail: "验证历史表现与策略假设" },
  ] },
  { title: "资料与投资记录", detail: "把研究积累留在自己手里", features: [
    { to: "/watchlist", title: "自选股", detail: "集中跟踪正在关注的公司" },
    { to: "/portfolio", title: "我的持仓", detail: "管理持仓与个人台账" },
    { to: "/my-reports", title: "我的研报", detail: "导入、查阅和分析研究资料" },
    { to: "/notes", title: "研究记录", detail: "沉淀观点、问题与研究笔记" },
  ] },
  { title: "工作台设置", detail: "按自己的习惯使用 AI", features: [
    { to: "/settings", title: "接入 AI", detail: "管理订阅、模型 API 与 Agent 开关" },
  ] },
] as const;
