import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EngineLifecycle, LifecycleContext } from "../src/engine.ts";
import { codexCapabilities } from "../src/engines/codex_lifecycle.ts";
import { DirectEngineLifecycle, directCapabilities } from "../src/engines/direct_lifecycle.ts";

/**
 * **引擎边界棘轮**(双引擎方案 v2 第 2 步)。
 *
 * 抽离前,编排器直接调 Codex 专属 API(指令发现根 / skills 隔离 / hooks 安装与汇总),
 * 且条件写的是 `!cfg.noAgent` —— **按有没有 agent 判,不是按用哪个引擎判**。
 * 结果是:换成直连引擎照样会去写产品 CODEX_HOME 的配置,而「编排器与引擎无关」这句话
 * 在代码里根本不成立(这正是 v1 方案被推翻的第一条)。
 *
 * 🔴 这类回退**不会有任何报错**:多写几个 Codex 配置文件,直连一样能跑完,
 *    只是悄悄带上了一堆用不到的假设,并在容器里因为找不到 codex 二进制才炸。
 *    ⇒ 只能用棘轮钉住。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

/** Codex 专属 API:只允许出现在 engines/codex_lifecycle.ts 与它们各自的实现文件里 */
const ENGINE_ONLY_APIS = [
  "ensureInstructionsRoot",
  "installSkillsIsolation",
  "installHooks",
  "uninstallHooks",
  "summarizeHookLog",
  "readHookLog",
  "readStopFailed",
  "clearStopFailed",
];

/** 去掉行注释与块注释,避免把"解释为什么不在这里调"的注释本身判成违规 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("编排器不得直接调用 Codex 专属 API(它们只属于 EngineLifecycle 的实现)", () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, "orchestrate.ts"), "utf8"));
  const hits = ENGINE_ONLY_APIS.filter((api) => new RegExp(`\\b${api}\\s*\\(`).test(code));
  assert.deepEqual(hits, [],
    `orchestrate.ts 又直接调了引擎专属 API:${hits.join(", ")}。\n` +
    "这些属于 engines/<引擎>_lifecycle.ts;编排器只该调 lifecycle.prepare / beforeTurn / afterTurn。");
});

test("turn 上下文的写入必须留在编排器(两个引擎都要,受控工具靠它判当前阶段)", () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, "orchestrate.ts"), "utf8"));
  // 反向断言:这一条是"必须在",不是"不许在"。
  // 它看着属于 hooks,其实是 run_tools_mcp.ts 的 currentStage 从磁盘读的那份上下文 ——
  // 一旦被顺手搬进 CodexEngineLifecycle,直连引擎的受控工具就会全部拿不到当前阶段而抛 turn_context_missing。
  assert.match(code, /\bwriteHookContext\s*\(/,
    "orchestrate.ts 不再写 turn 上下文了 —— 受控工具(list/read/calculate/write_stage)将无法判断当前阶段。");
});

test("编排器必须把引擎能力写进 manifest(漏写不会有任何人发现)", () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, "orchestrate.ts"), "utf8"));
  // manifest schema 里 capabilities 是**可选**的(旧运行的 manifest 没有这段,viewer/知识层仍要读得动),
  // 所以"漏写"过不了任何校验、也不报错,只是界面从此讲不出执行保障等级的差别 —— 只能在这里钉住。
  assert.match(code, /manifest\.engine\.capabilities\s*=/,
    "编排器没有写 manifest.engine.capabilities。schema 里它是可选的,漏写不会报错,但界面将无法区分两个引擎的执行保障等级。");
});

test("引擎实现只许放在 engines/ 下(Core 不得硬接某一个引擎)", () => {
  const enginesDir = path.join(SRC, "engines");
  const files = fs.readdirSync(enginesDir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "engines/ 下一个引擎实现都没有");
  // Core 目录(src/*.ts 直属层)不许再出现引擎构造;
  // 唯一允许的构造点是 orchestrate.ts 的过渡期缺省值与 run.ts 的组装根。
  const coreFiles = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  const offenders: string[] = [];
  for (const f of coreFiles) {
    if (f === "orchestrate.ts" || f === "run.ts") continue;   // 组装根与过渡期缺省
    const code = stripComments(fs.readFileSync(path.join(SRC, f), "utf8"));
    if (/new\s+\w*EngineLifecycle\s*\(/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `这些 Core 文件自己构造了引擎生命周期:${offenders.join(", ")}。引擎该由组装根注入,不该被 Core 模块硬接。`);
});

/** 只给 lifecycle 用的最小上下文:记录日志调用,其余为空实现 */
function probeCtx(): LifecycleContext & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    log: (...a: unknown[]) => { calls.push(a); },
    markProtected: () => { /* 探针不需要 */ },
    unmarkProtected: () => { /* 探针不需要 */ },
    manifest: {},
  };
}

test("直连引擎跑完整个生命周期不得在磁盘上留下任何东西(容器里没有 codex,这条一破就只在本机能跑)", () => {
  // realpath:macOS 的 /var 是指向 /private/var 的符号链接,不解开会让路径比对莫名其妙地不相等
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vra-direct-"));
  try {
    const cwd0 = process.cwd();
    process.chdir(tmp);   // 万一实现用了相对路径写文件,也会落在这个空目录里被抓到
    try {
      // 标成接口类型:既验证它确实实现了 EngineLifecycle,也让可选的 dispose 可被调用
      const lifecycle: EngineLifecycle = new DirectEngineLifecycle(directCapabilities("prompt"));
      const ctx = probeCtx();
      lifecycle.prepare(ctx);
      lifecycle.beforeTurn(ctx, "profile", 1);
      assert.equal(lifecycle.afterTurn(ctx, "profile", 1), null, "直连没有 Stop 钩子,不该凭空产生失败理由");
      lifecycle.dispose?.(ctx);
      assert.deepEqual(ctx.manifest, {}, "直连往 manifest 上写了 Codex 才有的字段(指令根 / skills 隔离 / hooks)");
    } finally { process.chdir(cwd0); }
    assert.deepEqual(fs.readdirSync(tmp), [],
      "直连的生命周期在磁盘上留下了文件 —— 它应当完全不准备引擎侧环境(尤其不许碰 CODEX_HOME)。");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("直连不得把执行保障往高了报(如实声明是产品承诺,不是文档措辞)", () => {
  const c = directCapabilities("prompt");
  assert.equal(c.kind, "direct");
  assert.equal(c.hooks, false, "直连没有 lifecycle hooks");
  assert.equal(c.sandbox, "model_has_no_host_access", "直连没有操作系统级沙箱,不许报成 seatbelt");
  assert.equal(c.auditLevel, "host_events", "直连拿不到引擎内部视角,不许报成 engine_events");
  assert.equal(c.contextStrategy, "per_stage_session");
  assert.equal(c.methodology, "stage_prompt_only", "Direct Deep 没有加载宪法和行业 skills，不许报成完整方法论");
});

test("两个引擎的能力声明必须真的不同(全都一样 = 这层声明是摆设)", () => {
  const cfgLike = { hooksEnabled: true } as never;
  const codex = codexCapabilities(cfgLike, "server_schema");
  const direct = directCapabilities("server_schema");
  const differing = (Object.keys(codex) as (keyof typeof codex)[]).filter((k) => codex[k] !== direct[k]);
  // 同样的 structuredOutput 下,两者仍应在 kind / protocol / sandbox / hooks / contextStrategy / auditLevel 上有别
  assert.ok(differing.length >= 5,
    `两个引擎的能力声明只有 ${differing.length} 项不同(${differing.join(", ")})。` +
    "若它们几乎一致,说明有一侧没有如实声明 —— 而界面正是靠这份声明告诉用户执行保障的差别。");
});

test("Direct CLI 模块图在 Codex 包被明确禁止时仍能加载", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vra-no-codex-"));
  try {
    const loader = path.join(tmp, "deny-codex.mjs");
    fs.writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@openai/codex")) throw new Error("CODEX_IMPORT_FORBIDDEN:" + specifier + ":from:" + context.parentURL);
  return nextResolve(specifier, context);
}
`);
    const entry = pathToFileURL(path.join(SRC, "run.ts")).href;
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types", "--experimental-loader", loader,
      "--input-type=module", "-e", `await import(${JSON.stringify(entry)});`,
    ], { cwd: tmp, encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0,
      `Direct 入口仍静态加载 Codex 包。stdout=${child.stdout}\nstderr=${child.stderr}`);
    assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /CODEX_IMPORT_FORBIDDEN/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
