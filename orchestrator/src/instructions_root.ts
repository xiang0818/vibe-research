/**
 * 指令根:Codex 发现**宪法**(`AGENTS.md`)与**项目技能**(`.agents/skills`)的那一层目录。
 *
 * 🔴 引擎的真实规则(codex 0.149.0 源码 + 本机 `codex debug prompt-input` 逐个实测,零模型调用):
 *   两者**用同一条规则** —— 收集 **project root 到线程 cwd 之间每一层目录**里的
 *   `AGENTS.md`(codex-rs/core/src/agents_md.rs)与 `.agents/skills`
 *   (codex-rs/ext/skills/src/host_roots.rs `repo_agents_skill_roots`);
 *   project root = 从 cwd 向上**第一个含 `project_root_markers` 的祖先**,默认 `[".git"]`;
 *   找不到 marker 时**只看 cwd 那一层**。marker 是文件或目录都算(`get_metadata` 探到即可)。
 *
 * ⇒ 由此得到三条硬约束,本模块负责保证:
 *   1. 线程 cwd(运行目录)**必须是指令根的后代** —— 否则宪法与技能一条都进不去。
 *   2. 指令根上**必须有 marker**,否则向上遍历到不了它。
 *   3. marker 必须是**产品自己的**,不能靠 `.git`。
 *
 * 实测结果(七个探针,完整表格见 `docs/instructions-root.md`):
 *   - `git clone` 下来跑:能发现(靠仓库自带的 `.git`)。
 *   - **下载 zip 解压跑:宪法与技能全部静默丢失** —— 因为没有 `.git`。开源产品用户多数走这条路,
 *     而丢的东西里包含**产出红线**。这是本模块首先要修的现存缺陷,不是为将来的安装壳做的准备。
 *   - 产品装在用户自己的 git 仓库里 + 默认 marker:**用户仓库的 AGENTS.md 与 skills 会漏进产品线程**
 *     (不只是发现不到,是反向污染)。自定义 marker 同时堵住这一头。
 *   - 宪法放 `app/`、数据放兄弟目录 `data/`:**无论怎么设 marker 都不行**(不在祖先链上)——
 *     所以分离安装时必须把指令资产**同步**到数据根,而不是指望配置能绕过去。
 *   - 指令根到 cwd 之间任何一层放 `AGENTS.override.md`:**整份替换**该层的 `AGENTS.md`(实测),
 *     产出红线会随之消失 ⇒ 必须显式拒绝,不能静默。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RunConfig } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";
import { mergeTopLevelBlock } from "./hooks.ts";
import { findMultilineClose, scanTomlLine, splitKeyValue } from "./tomlscan.ts";

/** 产品自己的 project root marker(空文件)。刻意不用 `.git`:见文件头第 3 条。 */
export const ROOT_MARKER_FILENAME = ".vibe-research-root";

export const CONSTITUTION_FILENAME = "AGENTS.md";
/** 引擎会用它**整份替换**同目录的 AGENTS.md(实测),因此在我们的链路上一律视为错误 */
export const CONSTITUTION_OVERRIDE_FILENAME = "AGENTS.override.md";
export const SKILLS_REL = path.join(".agents", "skills");

const BLOCK_BEGIN = "# >>> vibe-research project root (generated) >>>";
const BLOCK_END = "# <<< vibe-research project root (generated) <<<";

/** TOML 基本字符串:JSON 的转义规则是它的子集 */
const tomlString = (s: string) => JSON.stringify(s);

export interface InstructionsRoot {
  /** 宪法与技能所在目录;必须是运行目录的祖先 */
  root: string;
  /** product = 产品根本身就是运行目录的祖先(仓库内 .local 的现状布局);data = 分离安装,需把指令资产同步过去 */
  mode: "product" | "data";
}

/**
 * 物理路径:存在就 realpath(逐级向上找到最近的存在祖先再把剩余段拼回去),不存在就退回词法解析。
 * 🔴 词法比较会判错两个方向(Codex ir-r1 P2-6):`/links/product -> /real/product` 时物理上是祖先、
 * 词法上不是(错进 data 模式);`repo/link -> /outside` 时词法上是祖先、物理上不是(错进 product 模式)。
 * macOS 默认大小写不敏感,realpath 也一并把大小写归一。
 */
export function physical(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch { /* 往上找 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

function isAncestor(parent: string, child: string): boolean {
  const p = physical(parent), c = physical(child);
  return c === p || c.startsWith(p + path.sep);
}

/** 普通文件(不跟随符号链接) */
function isPlainFile(p: string): boolean { try { return fs.lstatSync(p).isFile(); } catch { return false; } }
/**
 * 从 root 到 root/rel 逐级 lstat,**中间段**是符号链接就抛。
 * 🔴 只检查最后一层不够:`<数据根>/.agents` 若是指向外部目录的链接,`isPlainDir(dst)` 会顺着它返回 true,
 * 然后清理逻辑沿着链接把**外部目录里的文件删掉**(Codex ir-r2 P1-1)。源端同理 —— 会从产品根之外取资产。
 * ⚠️ 最后一层**不在这里管**:它由下面"类型不对就整个删掉"自愈 —— 删一条符号链接只删链接、不动目标,
 * 是安全的;而中间段没法这么自愈(要删掉一整条路径),所以只能抛给人处理。
 */
function assertNoSymlinkOnPath(root: string, rel: string, what: string): void {
  const segs = rel.split(path.sep).filter(Boolean);
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    cur = path.join(cur, seg);
    if (isSymlink(cur)) throw new Error(`${what}的路径中间段是符号链接:${cur} —— 拒绝沿它读写(可能指向产品 / 数据目录之外)`);
  }
}

/** 是符号链接(含悬空链接) */
function isSymlink(p: string): boolean { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** 普通目录(不跟随符号链接) */
function isPlainDir(p: string): boolean { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } }

/** 指令资产的内容指纹:相对路径 → sha256;只认普通文件 */
function treeDigest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of listFiles(root)) {
    out.set(rel.split(path.sep).join("/"), createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex"));
  }
  return out;
}

/**
 * 定指令根:产品根若已是运行目录的祖先就用它(不搬东西);否则用数据根(调用方需先 `syncInstructionAssets`)。
 * ⚠️ 只看路径关系,不看文件在不在 —— 在不在由 `preflightInstructions` 报,免得两处各判一半。
 */
export function resolveInstructionsRoot(cfg: Pick<RunConfig, "repoRoot" | "dataRoot" | "runDir">): InstructionsRoot {
  return isAncestor(cfg.repoRoot, cfg.runDir)
    ? { root: path.resolve(cfg.repoRoot), mode: "product" }
    : { root: path.resolve(cfg.dataRoot), mode: "data" };
}

/** 幂等写 marker;返回是否**本次**创建 */
export function ensureRootMarker(root: string): boolean {
  const p = path.join(root, ROOT_MARKER_FILENAME);
  if (fs.existsSync(p)) return false;
  fs.mkdirSync(root, { recursive: true });
  atomicWrite(p, "此文件是 Vibe Research 的 project root 标记,由编排器生成。\n删掉它会让引擎发现不到宪法与技能(而且是静默的)。\n");
  return true;
}

export function buildProjectRootBlock(markers: readonly string[] = [ROOT_MARKER_FILENAME]): string {
  if (!markers.length) throw new Error("project_root_markers 不能为空:空数组会关掉向上遍历,宪法与技能一条都发现不到");
  for (const m of markers) {
    if (!m.trim()) throw new Error("project_root_markers 不能含空串");
    if (m.includes("/") || m.includes(path.sep)) throw new Error(`project_root_markers 是**文件名**不是路径,不能含分隔符:${m}`);
  }
  return [BLOCK_BEGIN, `project_root_markers = [${markers.map(tomlString).join(", ")}]`, BLOCK_END].join("\n");
}

/** 块外若已有 project_root_markers,与本块冲突(顺序难判、互相覆盖)—— 与 skills 隔离块同一策略 */
export function findForeignProjectRootMarkers(existing: string): boolean {
  // 只看**顶层区**(第一个表头之前)且在生成块之外的定义:表里的同名键是嵌套键,与顶层无关。
  // ⚠️ TOML 里 `"project_root_markers"` / `'project_root_markers'` 与裸键等价 —— 只认裸键会被绕过,
  //    而那种文件要么被严格解析器判重复键、要么后值覆盖成 .git,两种都不是"体检 OK"(Codex ir-r2 P1-2)。
  //    引号键的转义还原与注释剥离交给 tomlscan(与 skills 隔离块同一套判断);多行字符串里的内容一律跳过
  //    (排查笔记里贴一段配置不该被当成真的键,Codex ir-r3 P2)。
  let inBlock = false;
  let multiline: ReturnType<typeof scanTomlLine>["opensMultiline"] = null;
  for (const raw of existing.split("\n")) {
    if (multiline) { if (findMultilineClose(raw, multiline) >= 0) multiline = null; continue; }
    if (raw.trimEnd() === BLOCK_BEGIN) { inBlock = true; continue; }
    if (raw.trimEnd() === BLOCK_END) { inBlock = false; continue; }
    const scanned = scanTomlLine(raw);
    const line = scanned.text.trim();
    multiline = scanned.opensMultiline;
    if (inBlock || !line) continue;
    if (line.startsWith("[")) return false;  // 进了表头,后面的都是嵌套键
    const kv = splitKeyValue(line);
    if (kv && kv.key === "project_root_markers") return true;
  }
  return false;
}

export interface InstalledProjectRoot { configTomlPath: string; markers: string[]; changed: boolean }

/** 把 `project_root_markers` 写进**产品 CODEX_HOME** 的 config.toml(标记块内,幂等) */
export function installProjectRootMarkers(cfg: Pick<RunConfig, "codexHome">, markers: readonly string[] = [ROOT_MARKER_FILENAME]): InstalledProjectRoot {
  const block = buildProjectRootBlock(markers);
  fs.mkdirSync(cfg.codexHome, { recursive: true });
  const configTomlPath = path.join(cfg.codexHome, "config.toml");
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, "utf8") : "";
  if (findForeignProjectRootMarkers(existing)) {
    throw new Error(`${configTomlPath} 标记块之外已有 project_root_markers,与生成块冲突;请删除或并入块内(块由编排器生成)`);
  }
  const next = mergeTopLevelBlock(existing, block, BLOCK_BEGIN, BLOCK_END);
  const changed = next !== existing;
  if (changed) atomicWrite(configTomlPath, next);
  return { configTomlPath, markers: [...markers], changed };
}

/**
 * 校验 config.toml 里的块**真的生效**,不是"块在不在"。
 * 🔴 这条检查上一版写成了 `toml.includes(BLOCK_BEGIN)`,于是:块被追加到末尾、`project_root_markers`
 *    落进了最后那张表 `[hooks.state."…"]`(实测),引擎照旧用 `.git`,**而体检报 OK**。
 *    ⇒ 校验必须盯**效果**,不能盯自己刚写下的痕迹。
 * 这里要求文件**以生成块开头** —— 它前面没有任何表头,所以键必然在顶层;块内容必须与预期逐字相同
 * (顺带挡住"值被改成 .git""缺结束标记""注释里的假标记""重复块")。
 */
export function verifyProjectRootBlock(tomlText: string, markers: readonly string[] = [ROOT_MARKER_FILENAME]): string | null {
  const expected = buildProjectRootBlock(markers);
  if (!tomlText.startsWith(expected + "\n") && tomlText.trimEnd() !== expected) {
    if (!tomlText.includes(BLOCK_BEGIN)) return "没有 project_root_markers 生成块";
    if (tomlText.indexOf(BLOCK_BEGIN) > 0) return "project_root_markers 生成块不在文件开头:TOML 表头作用域会一直延续,它会变成上一张表的键而不是顶层键(引擎照旧用 .git)";
    return "project_root_markers 生成块内容与预期不符(被改过 / 缺结束标记 / 重复)";
  }
  const rest = tomlText.slice(tomlText.indexOf(expected) + expected.length);
  if (rest.includes(BLOCK_BEGIN) || rest.includes(BLOCK_END)) return "project_root_markers 生成块出现多次";
  if (findForeignProjectRootMarkers(tomlText)) return "生成块之外还有一个顶层 project_root_markers 定义(含引号形式);重复键会让配置解析失败或被后值覆盖";
  return null;
}

export interface SyncResult { copied: string[]; removed: string[]; unchanged: number }

/** 递归收集相对路径(只收普通文件);目录不存在返回空 */
function listFiles(root: string, rel = ""): string[] {
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return []; }
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) return [];  // ⛔ 符号链接一律不搬:指令资产必须是产品自己的普通文件
  return fs.readdirSync(abs).flatMap((name) => listFiles(root, path.join(rel, name)));
}

/**
 * 把产品的指令资产(宪法 + 项目技能)同步到指令根。**只在分离安装时用**。
 * - 幂等:内容相同不写(免得每次运行都动 mtime)。
 * - 目标端多出来的文件会被删 —— 目标是产品拥有的镜像,不是用户可编辑区(用户定制走用户配置)。
 */
export function syncInstructionAssets(fromRoot: string, toRoot: string): SyncResult {
  const from = physical(fromRoot), to = physical(toRoot);
  if (from === to) return { copied: [], removed: [], unchanged: 0 };
  // 一方是另一方的后代时,"删除目标端多余文件"会删到源资产上(Codex ir-r1 P1-5)
  if (isAncestor(from, to) || isAncestor(to, from)) {
    throw new Error(`指令资产的源与目标不得互相包含:源 ${from} / 目标 ${to}`);
  }
  const copied: string[] = [], removed: string[] = [];
  let unchanged = 0;
  for (const asset of [CONSTITUTION_FILENAME, SKILLS_REL]) {
    assertNoSymlinkOnPath(from, asset, "产品指令资产");
    assertNoSymlinkOnPath(to, asset, "指令根");
    const src = path.join(from, asset), dst = path.join(to, asset);
    const srcFiles = new Set(listFiles(src));
    if (!srcFiles.size) throw new Error(`产品指令资产缺失或为空,无法同步:${src}(宪法与项目技能是产品必需件)`);
    // 🔴 目标端**这一层本身**不是普通文件 / 普通目录时先整个删掉。
    //    `.agents/skills` 若是一条指向外部目录的符号链接,下面的复制会**顺着它写到外面去**,
    //    而逐条清理看不见它(lstat 到链接就停了)。宪法那一层是 atomicWrite 的 rename 顶掉的,
    //    但不能指望这个副作用 —— 显式删更清楚。
    const wantDir = asset === SKILLS_REL;
    if (fs.existsSync(dst) || isSymlink(dst)) {
      const okType = wantDir ? isPlainDir(dst) : isPlainFile(dst);
      if (!okType) { fs.rmSync(dst, { recursive: true, force: true }); removed.push(asset); }
    }
    // 先清理目标端:多余的、以及**任何非普通文件**(符号链接 / FIFO / socket)。
    // 🔴 符号链接必须删掉重写:`readFileSync` 会跟随它,"内容相同"的判断会把一条指向仓库外的链接当成已同步,
    //    之后链接目标被改,引擎加载的就是外部内容(Codex ir-r1 P1-4)。
    for (const { rel, plain } of listEntries(dst)) {
      if (plain && srcFiles.has(rel)) continue;
      fs.rmSync(path.join(dst, rel), { force: true, recursive: true });
      removed.push(path.join(asset, rel));
    }
    for (const rel of srcFiles) {
      const sBuf = fs.readFileSync(path.join(src, rel)), d = path.join(dst, rel);
      if (isPlainFile(d)) {
        try { if (fs.readFileSync(d).equals(sBuf)) { unchanged += 1; continue; } } catch { /* 读不了就重写 */ }
      }
      fs.mkdirSync(path.dirname(d), { recursive: true });
      atomicWrite(d, sBuf);
      copied.push(path.join(asset, rel));
    }
  }
  return { copied, removed, unchanged };
}

/** 目标端全部条目(含符号链接等非普通文件),用于清理;plain=普通文件 */
function listEntries(root: string, rel = ""): { rel: string; plain: boolean }[] {
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return []; }
  if (st.isDirectory()) return fs.readdirSync(abs).flatMap((n) => listEntries(root, path.join(rel, n)));
  if (!rel) return [];  // 根本身是文件 / 链接:交给上层处理
  return [{ rel, plain: st.isFile() }];
}

/** 指令根(含)到运行目录(含)之间的每一层 */
export function dirsBetween(root: string, runDir: string): string[] {
  const r = path.resolve(root), d = path.resolve(runDir);
  if (!isAncestor(r, d)) return [];
  const out = [r];
  let cur = r;
  for (const seg of path.relative(r, d).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    out.push(cur);
  }
  return out;
}

export interface InstructionsPreflight { root: string; mode: "product" | "data"; chain: string[]; problems: string[] }

/**
 * 运行前校验发现链。**任何一条不满足都必须拒绝运行** —— 这些失败全都是静默的:
 * 引擎不报错,只是宪法 / 技能不在提示词里,而报告照样产出。
 */
export function preflightInstructions(cfg: Pick<RunConfig, "repoRoot" | "dataRoot" | "runDir" | "codexHome">): InstructionsPreflight {
  const { root, mode } = resolveInstructionsRoot(cfg);
  const problems: string[] = [];
  const runDir = path.resolve(cfg.runDir);

  if (!isAncestor(root, runDir)) {
    problems.push(`运行目录 ${runDir} 不是指令根 ${root} 的后代:引擎只收集"project root 到 cwd 之间"的 AGENTS.md 与 .agents/skills,宪法与技能会全部丢失`);
    return { root, mode, chain: [], problems };
  }
  const chain = dirsBetween(root, runDir);

  const rootConstitution = path.join(root, CONSTITUTION_FILENAME);
  // ⚠️ 只查"存在"是不够的:目录也能通过 existsSync,而引擎不会把目录当宪法(Codex ir-r1 P2-7);
  //    符号链接同理 —— 它指向哪里我们管不住。
  if (!isPlainFile(rootConstitution)) problems.push(`指令根的宪法不是普通文件(缺失 / 是目录 / 是符号链接):${rootConstitution}`);
  else if (mode === "data") {
    // 分离安装时指令根上那份是副本;母本在产品根。两者必须逐字节相同,否则 manifest 记的宪法 sha256
    // 与引擎实际加载的不是同一份(记一份、跑另一份 = 最难发现的那类不一致)。
    const master = path.join(path.resolve(cfg.repoRoot), CONSTITUTION_FILENAME);
    try {
      if (!fs.readFileSync(master).equals(fs.readFileSync(rootConstitution))) {
        problems.push(`指令根的宪法副本与产品根母本不一致:${rootConstitution} ≠ ${master};manifest 记的是母本 sha256,引擎加载的是副本`);
      }
    } catch (e) { problems.push(`无法比对宪法母本与副本(${master} / ${rootConstitution}):${(e as Error).message}`); }
  }
  const rootSkills = path.join(root, SKILLS_REL);
  if (!isPlainDir(rootSkills)) problems.push(`指令根的项目技能不是普通目录(缺失 / 是文件 / 是符号链接):${rootSkills}`);
  else if (mode === "data") {
    // 🔴 只查目录在不在,挡不住"同步到一半被中断""副本被改""上一版技能残留"——
    //    引擎加载的技能与产品母本不一致,正是宪法那条注释说的"记一份、跑另一份"(Codex ir-r1 P1-3)。
    const master = treeDigest(path.join(physical(cfg.repoRoot), SKILLS_REL));
    const copy = treeDigest(rootSkills);
    const diff = [...new Set([...master.keys(), ...copy.keys()])].filter((k) => master.get(k) !== copy.get(k));
    if (diff.length) problems.push(`指令根的项目技能镜像与产品根母本不一致(${diff.length} 个文件:${diff.slice(0, 3).join(" / ")}${diff.length > 3 ? " …" : ""});引擎加载的是镜像`);
  }
  if (!isPlainFile(path.join(root, ROOT_MARKER_FILENAME))) problems.push(`指令根缺 project root 标记 ${ROOT_MARKER_FILENAME}(或它不是普通文件);没有它引擎会一路向上找 .git,找不到就只看运行目录那一层(zip 解压场景就是这样静默失效的)`);

  const cp = path.join(cfg.codexHome, "config.toml");
  const tomlErr = verifyProjectRootBlock(fs.existsSync(cp) ? fs.readFileSync(cp, "utf8") : "");
  if (tomlErr) problems.push(`${cp}:${tomlErr}。引擎会用默认的 .git —— 无 .git 时发现不到,有外层 .git 时会把用户自己仓库的 AGENTS.md 与技能一起读进来`);

  // 链上多余的宪法 / 技能:引擎会**追加**它们(override 则**整份替换**),等于产出红线可被链路上任意一层改写
  for (const dir of chain) {
    if (fs.existsSync(path.join(dir, CONSTITUTION_OVERRIDE_FILENAME))) {
      problems.push(`${path.join(dir, CONSTITUTION_OVERRIDE_FILENAME)} 会**整份替换**同目录的 AGENTS.md(实测),产出红线会随之消失;请删除`);
    }
    if (dir !== root) {
      // 🔴 引擎取的是**离 cwd 最近**的那个 marker:链上任何一层有同名 marker,project root 就被拉到那一层,
      //    指令根上的宪法与技能一条都进不去 —— 而上面四项检查全绿(Codex ir-r1 P1-2)。
      if (fs.existsSync(path.join(dir, ROOT_MARKER_FILENAME))) problems.push(`${path.join(dir, ROOT_MARKER_FILENAME)} 会把 project root 拉到这一层,指令根 ${root} 的宪法与技能将全部发现不到;请删除`);
      if (fs.existsSync(path.join(dir, CONSTITUTION_FILENAME))) problems.push(`${path.join(dir, CONSTITUTION_FILENAME)} 会被追加进宪法(只应有指令根那一份);请删除`);
      if (fs.existsSync(path.join(dir, SKILLS_REL))) problems.push(`${path.join(dir, SKILLS_REL)} 会被当作项目技能加载(只应有指令根那一份);请删除`);
    }
  }
  return { root, mode, chain, problems };
}

export interface EnsuredInstructions { root: string; mode: "product" | "data"; markerCreated: boolean; sync: SyncResult | null; configChanged: boolean }

/** 装配 + 校验:分离安装时先同步资产,再写 marker 与配置,最后校验;不通过直接抛。 */
export function ensureInstructionsRoot(cfg: Pick<RunConfig, "repoRoot" | "dataRoot" | "runDir" | "codexHome">): EnsuredInstructions {
  const { root, mode } = resolveInstructionsRoot(cfg);
  const sync = mode === "data" ? syncInstructionAssets(cfg.repoRoot, root) : null;
  const markerCreated = ensureRootMarker(root);
  const { changed } = installProjectRootMarkers(cfg);
  const pre = preflightInstructions(cfg);
  if (pre.problems.length) {
    throw new Error(`指令发现链不成立(引擎不会报错,只会静默丢掉宪法与技能):\n- ${pre.problems.join("\n- ")}`);
  }
  return { root, mode, markerCreated, sync, configChanged: changed };
}
