#!/usr/bin/env node
/**
 * 幂等初始化(开发方案 v2.1 §5 / scripts/init):只生成产品自己的用户私有层 `.local/`,**永不读写用户全局 ~/.codex**。
 * 做的事:建目录(codex-home / runs / knowledge / providers / mcp)→ 没有 `.local/config.json` 就写一份骨架(python 自动探测 .venv;provider 默认 openai;不写 auth,让模板自动选)
 *        → 确保 `.gitignore` 含 `.local/` → 打印下一步(登录到产品 CODEX_HOME、跑 doctor)。
 * 已存在的用户配置一律不改(幂等);`--force` 才改,且先备份为 config.json.bak-<时间>。
 * 用法:node orchestrator/src/init.ts [--python P] [--provider <id>] [--force] [--json]
 */
import fs from "node:fs";
import path from "node:path";

import { nowIso, readJsonIfExists, writeJson } from "./fsutil.ts";
import { DEFAULT_PRODUCT_CONFIG, PRODUCT_CONFIG_FILE, USER_CONFIG_FILE } from "./productConfig.ts";
import { PROVIDER_ID_RE } from "./providers.ts";
import { parseArgs } from "./run.ts";
import { repoRootFromHere } from "./service.ts";
import { installSkillsIsolation } from "./skills_isolation.ts";
import { ROOT_MARKER_FILENAME, ensureRootMarker, installProjectRootMarkers } from "./instructions_root.ts";

export const LOCAL_SUBDIRS = ["codex-home", "runs", "knowledge", "providers", "mcp"] as const;

export interface InitStep { id: string; action: "created" | "exists" | "written" | "kept" | "backed_up" | "appended" | "skipped"; detail: string }
export interface InitResult { repoRoot: string; dataRoot: string; steps: InitStep[]; next: string[] }

/** 数据根:产品配置 paths.data_root(默认 .local),相对产品根解析;不走 loadProductConfig(它会因 provider 缺密钥抛错,init 阶段不该被卡) */
export function resolveDataRoot(repoRoot: string): string {
  const pc = readJsonIfExists<{ paths?: { data_root?: string } }>(path.join(repoRoot, PRODUCT_CONFIG_FILE));
  return path.resolve(repoRoot, pc?.paths?.data_root ?? DEFAULT_PRODUCT_CONFIG.paths.data_root);
}

/** lstat:不存在(ENOENT)→ null;存在(含悬空符号链接)→ Stats。existsSync 对悬空符号链接返回 false,不能用来判"是不是符号链接" */
export function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 数据根边界:词法在产品根内 + 最近已存在祖先的 realpath 仍在产品根 realpath 内 + 数据根本身不是符号链接(含悬空;防 .local → 仓库外) */
export function assertDataRootInside(repoRoot: string, dataRoot: string): void {
  const realRepo = fs.realpathSync(repoRoot);
  // ⚠️ init / doctor 面向的是**仓库内布局**(clone 下来自己跑),所以这里仍要求数据根在产品根内。
  //    分离安装(数据根在产品根之外)运行路径已经支持(instructions_root.ts 会把指令资产同步过去),
  //    但那套的初始化归 launcher —— 别以为这条限制说明运行时也不支持。
  if (dataRoot !== repoRoot && !dataRoot.startsWith(repoRoot + path.sep)) throw new Error(`数据根 ${dataRoot} 不在产品根 ${repoRoot} 之内,拒绝(init 面向仓库内布局;分离安装由 launcher 初始化)`);
  if (lstatOrNull(dataRoot)?.isSymbolicLink()) throw new Error(`数据根 ${dataRoot} 是符号链接,拒绝`);
  let probe = dataRoot;
  while (!lstatOrNull(probe)) { const parent = path.dirname(probe); if (parent === probe) break; probe = parent; }
  const real = fs.realpathSync(probe);
  if (real !== realRepo && !real.startsWith(realRepo + path.sep)) throw new Error(`数据根 ${dataRoot} 解析到产品根之外(${real}),拒绝`);
}

/** .gitignore 里是否已有等价于忽略 <rel>/ 的规则(.local/ · /.local/ · .local · /.local · .local/**) */
export function gitignoreCovers(text: string, rel: string): boolean {
  const base = rel.replace(/\/+$/, "");
  const accepted = new Set([base, `${base}/`, `/${base}`, `/${base}/`, `${base}/**`, `/${base}/**`]);
  return text.split(/\r?\n/).some((l) => accepted.has(l.trim()));
}

/** python 探测顺序:显式参数 → <repo>/.venv/bin/python(或 Scripts/python.exe)→ null(留给用户填) */
export function detectPython(repoRoot: string, explicit?: string): string | null {
  if (explicit) return explicit;
  for (const rel of [path.join(".venv", "bin", "python"), path.join(".venv", "Scripts", "python.exe")]) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function runInit(opts: { repoRoot?: string; python?: string; provider?: string; force?: boolean } = {}): InitResult {
  const repoRoot = path.resolve(opts.repoRoot ?? repoRootFromHere());
  const dataRoot = resolveDataRoot(repoRoot);
  assertDataRootInside(repoRoot, dataRoot);
  if (opts.provider !== undefined && !PROVIDER_ID_RE.test(opts.provider)) throw new Error(`非法 provider id ${JSON.stringify(opts.provider)}`);
  const steps: InitStep[] = [];
  // 1) 目录
  for (const sub of LOCAL_SUBDIRS) {
    const d = path.join(dataRoot, sub);
    const st = lstatOrNull(d);
    if (st) { if (!st.isDirectory()) throw new Error(`${d} 已存在但不是目录(符号链接也不行)`); steps.push({ id: `dir:${sub}`, action: "exists", detail: d }); }
    else { fs.mkdirSync(d, { recursive: true }); steps.push({ id: `dir:${sub}`, action: "created", detail: d }); }
  }
  // 2) 用户配置骨架(只在不存在或 --force 时写)
  const cfgFile = path.join(dataRoot, USER_CONFIG_FILE);
  // 骨架**不写 auth**:写了就算"用户显式指定",之后 --provider 切第三方会因 chatgpt_login 不被支持而报错;不写则按模板自动选(openai=chatgpt_login,第三方=api_key)
  const skeleton = {
    python: detectPython(repoRoot, opts.python),
    provider: { profile: opts.provider ?? "openai" },
    defaults: { model: null, reasoning: null },
  };
  if (fs.existsSync(cfgFile) && !opts.force) {
    steps.push({ id: "config", action: "kept", detail: `${cfgFile} 已存在,未改动(要重写请加 --force,会先备份)` });
  } else {
    if (fs.existsSync(cfgFile)) {
      const stamp = nowIso().replace(/[-:]/g, "").slice(0, 15);
      let bak = `${cfgFile}.bak-${stamp}`;
      for (let n = 1; fs.existsSync(bak); n++) bak = `${cfgFile}.bak-${stamp}-${n}`;  // 同秒重复执行不覆盖旧备份
      fs.copyFileSync(cfgFile, bak);
      steps.push({ id: "config:backup", action: "backed_up", detail: bak });
    }
    writeJson(cfgFile, skeleton);
    steps.push({ id: "config", action: "written", detail: `${cfgFile}(python=${skeleton.python ?? "null,请填"};provider=${skeleton.provider.profile},auth 按模板自动选)` });
  }
  // 3) .gitignore 必含 .local/(产品 / 用户数据分离的最后一道)
  const gi = path.join(repoRoot, ".gitignore");
  const giSt = lstatOrNull(gi);
  if (giSt?.isSymbolicLink()) throw new Error(`${gi} 是符号链接(含悬空),拒绝改写`);
  const giText = giSt ? fs.readFileSync(gi, "utf8") : "";
  const relLocal = path.relative(repoRoot, dataRoot).split(path.sep).join("/") + "/";
  if (gitignoreCovers(giText, relLocal)) steps.push({ id: "gitignore", action: "exists", detail: `${relLocal} 已在 .gitignore(或等价规则)` });
  else { fs.appendFileSync(gi, `${giText.endsWith("\n") || !giText ? "" : "\n"}# 用户私有层(init 追加)\n${relLocal}\n`); steps.push({ id: "gitignore", action: "appended", detail: `已追加 ${relLocal} 到 .gitignore` }); }
  // 4) skills 隔离块(产品 CODEX_HOME/config.toml):首装就把用户级 / 捆绑 skills 禁掉,doctor 才能在首次运行前就绿;每次研究运行开始时也会刷新
  const codexHome = path.join(dataRoot, "codex-home");
  const iso = installSkillsIsolation({ codexHome, repoRoot, python: skeleton.python ?? null });
  // 4b) 指令发现链:project root marker + project_root_markers 配置。首装就写,否则**下载 zip 解压的用户**
  //     (没有 .git)在首次运行前一直处于"引擎发现不到宪法与技能、而且不报错"的状态(instructions_root.ts)。
  const markerCreated = ensureRootMarker(repoRoot);
  const prm = installProjectRootMarkers({ codexHome });
  steps.push({ id: "instructions_root", action: markerCreated || prm.changed ? "written" : "exists", detail: `${path.join(repoRoot, ROOT_MARKER_FILENAME)} + ${prm.configTomlPath} 的 project_root_markers(引擎靠它才能发现 AGENTS.md 与 .agents/skills)` });
  steps.push({ id: "skills_isolation", action: iso.changed ? "written" : "exists", detail: `${path.join(codexHome, "config.toml")}(禁用用户级 skill ${iso.disabledPaths.length} 个;捆绑 skills 已关;max_context_tokens=${iso.maxContextTokens})` });
  const next = [
    "运行 scripts/start（Windows: scripts\\start.cmd）打开产品",
    "在‘接入 AI’里选择订阅或模型 API，测试成功后即可使用",
    "排查环境:运行 scripts/doctor（Windows: scripts\\doctor.ps1）",
  ];
  return { repoRoot, dataRoot, steps, next };
}

if (process.argv[1] && (process.argv[1].endsWith("/init.ts") || process.argv[1].endsWith("\\init.ts"))) {
  const a = parseArgs(process.argv.slice(2));
  const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  try {
    const r = runInit({ python: str(a.python), provider: str(a.provider), force: a.force === true });
    if (a.json === true) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`[init] 产品根 ${r.repoRoot}\n[init] 数据根 ${r.dataRoot}`);
      for (const s of r.steps) console.log(`  ${s.action.padEnd(9)} ${s.id}: ${s.detail}`);
      console.log("[init] 下一步:"); for (const n of r.next) console.log(`  - ${n}`);
    }
  } catch (e) { console.error(`[init] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
}
