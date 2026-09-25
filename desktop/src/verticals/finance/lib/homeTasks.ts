/** 首页任务入口进入已有工作流；普通聊天不承担取数、研报收集或任务执行。 */
export const HOME_TASKS = [
  { label: "今日复盘", to: "/daily-review", detail: "查看盘面与连板数据，再分析" },
  { label: "开始公司研究", to: "/research", detail: "填写 A 股代码，确认后运行六阶段研究" },
  { label: "分析已有研报", to: "/my-reports", detail: "上传并选择资料，由系统安排分析任务" },
] as const;
