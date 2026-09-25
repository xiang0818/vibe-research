import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HOME_FEATURE_GROUPS } from "../src/verticals/finance/lib/homeFeatures.ts";

const financeAgent = readFileSync(
  new URL("../src/verticals/finance/components/ui/FinanceAiDock.tsx", import.meta.url),
  "utf8",
);
const coreMessages = readFileSync(
  new URL("../src/core/ai/AiMessages.tsx", import.meta.url),
  "utf8",
);

test("首页保留工作流入口，聊天已开放实际联网与取数能力", () => {
  assert.doesNotMatch(financeAgent, /notice="直接问市场、公司、行业或研究方法。"/);
  assert.match(financeAgent, /placeholder="说说要查什么、研究什么…（Shift\+Enter 换行）"/);
  assert.match(financeAgent, /suggestionStyle="tasks"/);
  assert.match(financeAgent, /onPick=\{\(text\) => \{ setDraft\(text\)/);
  assert.doesNotMatch(financeAgent, /onPick=\{\(x\) => void chat\.submit\(x\)\}/);
  assert.match(financeAgent, /<AiComposer[\s\S]*?highlighted[\s\S]*?\/>/);

  const router = readFileSync(new URL("../src/verticals/finance/router.tsx", import.meta.url), "utf8");
  const features = HOME_FEATURE_GROUPS.flatMap((group) => [...group.features]);
  assert.equal(features.length, 12);
  assert.equal(new Set(features.map((entry) => entry.to)).size, 12);
  const layout = readFileSync(new URL("../src/verticals/finance/components/layout/Layout.tsx", import.meta.url), "utf8");
  const primaryNav = layout.slice(layout.indexOf("const NAV = ["), layout.indexOf("];", layout.indexOf("const NAV = [")));
  const primaryRoutes = [...primaryNav.matchAll(/to: "([^"]+)"/g)].map((match) => match[1]).filter((route) => route !== "/");
  assert.deepEqual(features.map((entry) => entry.to).sort(), primaryRoutes.sort(), "首页只列全部一级栏目，不展示二级入口");
  for (const feature of features) {
    assert.ok(layout.includes(`to: "${feature.to}"`), feature.to);
    assert.ok(router.includes(`path: "${feature.to}"`), feature.to);
  }
  const home = readFileSync(new URL("../src/verticals/finance/pages/Home.tsx", import.meta.url), "utf8");
  assert.ok(home.indexOf("<FinanceHomeAgent") < home.indexOf("<section"));
  assert.match(home, /HOME_FEATURE_GROUPS\.map/);
  assert.match(home, /data-feature-grid[^>]*sm:grid-cols-2[^>]*lg:grid-cols-3[^>]*xl:grid-cols-5/, "分类大框须横向并排，不能一类占整行");
  assert.match(home, /data-feature-category[^>]*border-primary\/20/, "每个分类与其入口共用独立大框");
  assert.doesNotMatch(home, /group\.detail|\{detail\}<\/span>/, "紧凑目录不展开分类和每个入口的长描述");
  assert.match(home, /to=\{to\}/);
  assert.doesNotMatch(layout, /<Navigate/);
  assert.match(financeAgent, /<QuickAiConnect/);
  assert.match(financeAgent, /disabled=\{chat.loading \|\| !configured\}/);
  assert.match(financeAgent, /今天市场有哪些值得关注的变化/);
  assert.match(financeAgent, /Agent 可以联网搜索、取数、计算并跟进研究任务/);
  assert.doesNotMatch(financeAgent, /不会自动取数或收集全网研报|不自动取数、不调用工具/);
  assert.match(financeAgent, /pending_research/);
  assert.match(financeAgent, /window.confirm/);
  assert.doesNotMatch(financeAgent, /200份研报|所有研报/);
});

test("Core 只在有说明时渲染提醒框，长任务使用统一卡片样式", () => {
  assert.match(coreMessages, /msgs\.length === 0 && notice &&/);
  assert.match(coreMessages, /suggestionStyle === "tasks" \? "grid gap-2 sm:grid-cols-2"/);
  assert.match(coreMessages, /highlighted \? "border-warning\/30 bg-warning\/\[0\.035\]"/);
  assert.match(coreMessages, /const v = value \?\? ref\.current\?\.value \?\? ""/);
  assert.match(coreMessages, /onValueChange\?\.\(""\)/);
});
