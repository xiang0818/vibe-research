/**
 * 合规 gate(确定性后处理):最终报告命中"投资动作建议"类模式即拒绝交付(AGENTS.md §0 第 3 条;方案 §9)。
 * 纯函数:输入报告文本,输出命中清单。只有整行精确等于固定免责声明的行才豁免(防"不构成建议,但建议……"这种半句翻转)。
 */
import { gateExemptLines, gatePatterns, gateRegexps } from "./config.ts";

/**
 * 硬测试往报告里注入探针时的**那一整行**。
 *
 * 🔴 注册期自检与真正注入**必须用同一个函数拼**。审计 gate-r1-P1 指出:
 *    自检只测裸的 probeLine,而真正写进报告的是带前后缀的一整行 ——
 *    规则若是锚定式(`^…$`),自检过、注入行却拦不住,**硬测试从此永远绿**。
 */
export const probeReportLine = (probe: string): string =>
  `- 【硬测试注入文本】${probe}(此行用于触发合规 gate,重写时必须删除)`;

export interface GateHit {
  line: number;
  pattern: string;
  text: string;
}

export interface GateResult {
  ok: boolean;
  hits: GateHit[];
}

/** 简 → 繁(只覆盖红线词表用到的、繁简不同的字);与 data-access/scripts/sources/textsafe.py TRAD_CHARS 逐字一致 */
export const TRAD_CHARS: Record<string, string> = { 仓: "倉", 减: "減", 满: "滿", 议: "議", 买: "買", 卖: "賣", 评: "評", 级: "級", 损: "損", 标: "標", 价: "價", 荐: "薦" };
const TRAD2SIMP = new Map(Object.entries(TRAD_CHARS).map(([s, t]) => [t, s]));
const CJK = "\u3400-\u9FFF\uF900-\uFAFF";
// 不可见字符:控制 / 格式字符、零宽、CGJ、蒙文 / 变体选择符(它们是 Mn,不在 Cf 里)
// 规范形还剥组合附加符 / 环绕符(U+0301 等),只用于匹配
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u200B-\u200D\u2060\uFEFF]/gu;
/** 汉字之间可忽略的分隔符;与 textsafe.py CJK_SEP_CHARS 逐字一致(测试强制) */
export const CJK_SEP_CHARS = " \t\r\n\u3000\u00b7\u2022\u30fb_*~|/\\+.\u2010\u2011\u2012\u2013\u2014\u2015-";
const CJK_SEP_RE = new RegExp(`(?<=[${CJK}])[${CJK_SEP_CHARS.replace(/[\\\]^-]/g, (c) => "\\" + c)}]+(?=[${CJK}])`, "gu");

/** gate 匹配用规范形:NFKC、剥不可见字符、繁→简、汉字之间的空白 / 点线分隔符忽略(插空格、插零宽字符、写成繁体,都要命中同一个词)。与 textsafe.canonical_for_match 同构。 */
export function canonicalForGate(text: string): string {
  let t = text.normalize("NFKC").replace(INVISIBLE_RE, "");
  t = Array.from(t, (ch) => TRAD2SIMP.get(ch) ?? ch).join("");
  return t.replace(CJK_SEP_RE, "");
}

export function complianceGate(
  report: string,
  patterns: string[] = gatePatterns(),
  exemptLines: string[] = gateExemptLines(),
  regexps: { name: string; re: RegExp }[] = gateRegexps(),
): GateResult {
  const hits: GateHit[] = [];
  const exempt = new Set(exemptLines.map((l) => canonicalForGate(l.trim())));
  report.split(/\r?\n/).forEach((raw, i) => {
    // 只剥**真正的 Markdown 前缀**(符号后面得有空白),逐层剥以支持嵌套引用 / 列表。
    // 🔴 原来是 `/^[-*>\s]+/` 一把吞掉行首所有 `- * >` 与空白 —— 那会把**正文语义符号**
    //    也吃掉:`>18% 才触发` → `18% 才触发`、`-1 倍` → `1 倍`、`*ST …` → `ST …`。
    //    ⚠️ 对**当前**这套规则不构成漏判(实测:没有一条规则以 `- * >` 开头,也没有锚定行首的正则),
    //       但它是个埋着的坑:哪天有人写一条 `/^-\d+% 止损/`,它会静默永不命中。
    //       (审计 gate-r3;修的是"以后写规则的人会踩",不是"现在有洞"。)
    let line = raw.trim();
    for (;;) {
      // `>` 后面也要求空白:金融文本里 `>18%` 几乎一定是"大于",不是引用块。
      // 真是无空格引用块也无妨 —— 剥不剥都照样命中,只影响命中行怎么显示。
      // `>` 只在后面是空白**或另一个 `>`**(嵌套引用 `>>`)时才算引用符。
      // 金融文本里 `>18%` 几乎一定是"大于",不是引用块;真是无空格引用块也无妨 ——
      // 剥不剥都照样命中,只影响命中行怎么显示。
      const next = line.replace(/^(?:(?:[-*+]|\d+[.)])\s+|>(?=[>\s])\s*)/, "");
      if (next === line) break;
      line = next.trim();
    }
    line = line.trim();
    if (!line) return;
    const canon = canonicalForGate(line);
    if (exempt.has(canon)) return;
    for (const p of patterns) {
      if (canon.includes(p)) hits.push({ line: i + 1, pattern: p, text: line.slice(0, 160) });
    }
    // 正则规则:子串表管不住的动作 + 语气 / 价位 / 英文(全审 r3-P1-1)。
    // ⚠️ 一律不带 g 标志 —— 带 g 的正则 `test()` 会写 lastIndex,跨行复用同一个对象会漏判。
    for (const { name, re } of regexps) {
      if (re.test(canon)) hits.push({ line: i + 1, pattern: name, text: line.slice(0, 160) });
    }
  });
  return { ok: hits.length === 0, hits };
}

/** 报告必须包含的章节标题是否齐全 */
export function missingSections(report: string, sections: string[]): string[] {
  return sections.filter((s) => !new RegExp(`^#{1,3}\\s*.*${escapeRe(s)}`, "m").test(report));
}

/**
 * 报告中引用的 ev- / calc- id。
 * 🔴 必须带**整 token 边界**:没有边界时 `ev-abcdef123456xyz` 会截出合法前缀 `ev-abcdef123456`,
 * 于是"至少引用一条证据""引用的 id 存在"两项都被伪引用满足,而数字忠实度那边(边界严格)看不到这个 id、
 * 不会去核对同行的数字 —— 报告可以带着无效引用通过(全审 r1-P2-4)。
 * `report_sections.ts` 的 `citedIds()` 一直是严格的,这里是**同一概念的第二份实现没跟上**。
 */
export function referencedIds(report: string): { evidence: string[]; calculation: string[] } {
  const ev = new Set(report.match(/(?<![0-9A-Za-z_-])ev-[0-9a-f]{6,}(?![0-9A-Za-z_-])/g) ?? []);
  const calc = new Set(report.match(/(?<![0-9A-Za-z_-])calc-[0-9a-f]{16}(?![0-9A-Za-z_-])/g) ?? []);
  return { evidence: [...ev], calculation: [...calc] };
}

/** 报告首行的状态标记 */
export function reportStatusToken(report: string): string | null {
  const m = report.split(/\r?\n/)[0]?.match(/状态[::]\s*(complete|incomplete|failed|stale)/);
  return m ? m[1] : null;
}

/** 把首行状态标记改写为 expected(编排器确定性归一,不动正文) */
export function normalizeReportStatus(report: string, expected: string): { text: string; changed: boolean } {
  const lines = report.split(/\r?\n/);
  const before = lines[0] ?? "";
  const after = before.replace(/(状态[::]\s*)(complete|incomplete|failed|stale)/, `$1${expected}`);
  if (after === before) return { text: report, changed: false };
  lines[0] = after;
  return { text: lines.join("\n"), changed: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
