/**
 * TOML 的**逐行**扫描件(不是解析器):判断某一行是否处在多行字符串里、取出去掉注释的正文、拆键值、还原引号键。
 *
 * 抽成公共模块是因为三处都要用同一套判断,而 `hooks.ts` 不能反向 import `skills_isolation.ts`(会成环):
 * - `skills_isolation.ts`:块外是否已有 skills 配置
 * - `hooks.ts`:生成块的分隔符必须**独占整行且不在多行字符串里**
 * - `instructions_root.ts`:块外是否已有顶层 `project_root_markers`
 *
 * ⚠️ 只做到"逐行扫描"这一层:够用来判断标记与顶层键,**不要拿它当 TOML 解析器**。
 */

/**
 * 扫一行 TOML:返回去掉行尾注释的文本,以及本行是否**开启了未闭合的多行字符串**(`"""` / `'''` 出现在单行字符串之外且本行没有对应闭合)。
 * 单行字符串内的 `"""`(如 `x = 'Use """ here'`)不算多行分隔符(Codex 审查 r4)。
 */

/**
 * 在一行里找多行字符串的闭合位置(找不到返回 -1)。
 * 🔴 不能用 `indexOf` —— basic 多行串里 `\"""` 是"转义引号 + 两个普通引号",**不是**结束符;
 * 直接找子串会提前判定闭合,接着把字符串内容当成真配置(Codex ir-r4)。字面量串 `'''` 里没有转义。
 * ⚠️ 每行从头扫:跨行的行尾续行反斜杠不在处理范围内(那属于 TOML 解析器的活,这里只做逐行扫描)。
 */
export function findMultilineClose(line: string, quote: '"""' | "'''", from = 0): number {
  if (quote === "'''") return line.indexOf(quote, from);
  for (let i = from; i <= line.length - 3; i += 1) {
    if (line[i] === "\\") { i += 1; continue; }   // 反斜杠转义掉下一个字符
    if (line.startsWith(quote, i)) return i;
  }
  return -1;
}

export function scanTomlLine(line: string): { text: string; opensMultiline: '"""' | "'''" | null } {
  let q: string | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (q) { if (ch === "\\" && q === '"') i++; else if (ch === q) q = null; i++; continue; }
    if (ch === "#") return { text: line.slice(0, i), opensMultiline: null };
    if (ch === '"' || ch === "'") {
      const triple = line.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const close = findMultilineClose(line, triple as '"""' | "'''", i + 3);
        if (close < 0) return { text: line.slice(0, i), opensMultiline: triple as '"""' | "'''" };
        i = close + 3; continue;  // 同行开合的多行字符串,当普通值跳过
      }
      q = ch; i++; continue;
    }
    i++;
  }
  return { text: line, opensMultiline: null };
}

/** TOML 基本字符串键的转义还原(\uXXXX / \UXXXXXXXX / \" / \\ / \b \t \n \f \r);字面量键('…')原样;裸键原样 */
export function unquoteTomlKey(k: string): string {
  const t = k.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|["\\bfnrt])/g, (_, g: string) => {
      if (g[0] === "u" || g[0] === "U") return String.fromCodePoint(parseInt(g.slice(1), 16));
      return { '"': '"', "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[g] ?? g;
    });
  }
  return t;
}

/** 取一行的"键 = 值":键支持裸键 / 引号键(含转义);不是键值行返回 null */
export function splitKeyValue(line: string): { key: string; value: string } | null {
  const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
  return m ? { key: unquoteTomlKey(m[1]), value: m[2].trim() } : null;
}

