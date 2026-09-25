/**
 * 产品配置(开发方案 v2.1 §5 ③⑤):宪法 / skills / calc / 数据根 / 引擎路径 / CODEX_HOME / provider profile 全部从产品自己的配置读,
 * 不从用户全局 codex config 读。优先级(低 → 高):内置默认 ← <repo>/vibe-research.config.json(产品,入库)← <data_root>/config.json(用户私有,gitignore)← 环境变量 ← CLI。
 * 不含任何密钥:provider 只记 env_key 名,值从环境变量取。
 */
import fs from "node:fs";
import path from "node:path";

import { resolveDataRoot } from "./data_root.ts";
import { assertAuth, loadProviderProfile, type ProviderProfileFile } from "./providers.ts";
import { validateWith } from "./schemas.ts";

export interface ProviderProfile {
  name: string;
  /** 与 Codex model_providers.wire_api 同义 */
  wire_api: "responses" | "chat";
  /** null = 官方默认端点 */
  base_url: string | null;
  /** API key 所在环境变量名(值永不进配置文件) */
  env_key: string;
  /** chatgpt_login = 用 CODEX_HOME 里的登录态;api_key = 用 env_key 的值 */
  auth: "chatgpt_login" | "api_key";
  /** M4:providers/<id>.json 的 id(设置后 name / wire_api / base_url / env_key 由模板决定) */
  profile?: string;
}

export interface ProductConfig {
  engine: { codex_path: string | null; codex_home: string };
  python: string | null;
  provider: ProviderProfile;
  paths: { constitution: string; skills: string; calc_cli: string; data_root: string };
  defaults: { model: string | null; reasoning: string | null; max_retries: number; gate_retries: number; turn_timeout_min: number; fetch_timeout_sec: number };
}

export const PRODUCT_CONFIG_FILE = "vibe-research.config.json";
export const USER_CONFIG_FILE = "config.json"; // 位于 data_root 下

export const DEFAULT_PRODUCT_CONFIG: ProductConfig = {
  engine: { codex_path: null, codex_home: ".local/codex-home" },
  python: null,
  provider: { name: "openai", wire_api: "responses", base_url: null, env_key: "OPENAI_API_KEY", auth: "chatgpt_login" },
  paths: { constitution: "AGENTS.md", skills: ".agents/skills", calc_cli: "calc/cli.py", data_root: ".local" },
  defaults: { model: null, reasoning: null, max_retries: 2, gate_retries: 2, turn_timeout_min: 30, fetch_timeout_sec: 180 },
};

export const productConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    engine: { type: "object", additionalProperties: false, properties: { codex_path: { type: ["string", "null"] }, codex_home: { type: "string", minLength: 1 } } },
    python: { type: ["string", "null"] },
    provider: { type: "object", additionalProperties: false, properties: {
      name: { type: "string", minLength: 1 }, wire_api: { type: "string", enum: ["responses", "chat"] }, base_url: { type: ["string", "null"], pattern: "^https?://[^\\s]+$" },
      env_key: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$", not: { enum: ["PATH", "HOME", "USER", "SHELL", "CODEX_HOME", "TMPDIR", "LANG", "TERM"] } }, auth: { type: "string", enum: ["chatgpt_login", "api_key"] },
      profile: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" } } },
    paths: { type: "object", additionalProperties: false, properties: {
      constitution: { type: "string", minLength: 1 }, skills: { type: "string", minLength: 1 }, calc_cli: { type: "string", minLength: 1 }, data_root: { type: "string", minLength: 1 } } },
    defaults: { type: "object", additionalProperties: false, properties: {
      model: { type: ["string", "null"] }, reasoning: { type: ["string", "null"] }, max_retries: { type: "integer", minimum: 0, maximum: 5 }, gate_retries: { type: "integer", minimum: 0, maximum: 5 },
      turn_timeout_min: { type: "number", exclusiveMinimum: 0 }, fetch_timeout_sec: { type: "number", exclusiveMinimum: 0 } } },
  },
} as const;

type Partialish = { [K in keyof ProductConfig]?: Partial<ProductConfig[K]> };

function readLayer(file: string, label: string): Partialish {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`${label} 不是合法 JSON:${file}(${e instanceof Error ? e.message : String(e)})`); }
  const errs = validateWith("product-config", productConfigSchema, parsed);
  if (errs.length) throw new Error(`${label} 不符合 schema:${file}\n  ${errs.slice(0, 5).join("\n  ")}`);
  return parsed as Partialish;
}

function mergeLayer(base: ProductConfig, layer: Partialish): ProductConfig {
  return {
    engine: { ...base.engine, ...(layer.engine ?? {}) },
    python: layer.python !== undefined ? layer.python : base.python,
    provider: { ...base.provider, ...(layer.provider ?? {}) },
    paths: { ...base.paths, ...(layer.paths ?? {}) },
    defaults: { ...base.defaults, ...(layer.defaults ?? {}) },
  };
}

export interface LoadedProductConfig extends ProductConfig {
  /** 已解析为绝对路径 */
  resolved: { codexHome: string; dataRoot: string; constitution: string; skills: string; calcCli: string; scriptsRel: string; codexPath: string | null };
  sources: string[];
  /** M4:选中的 provider profile(openai 默认也有模板);矩阵状态随之进 manifest */
  providerProfile: ProviderProfileFile | null;
  /**
   * 缺密钥的说明。严格模式(默认)下拿不到这个字段 —— 那时它已经抛错了;
   * 宽松模式(`requireAuth: false`)下配置照常返回,问题记在这里由调用方自己报。
   */
  authError: string | null;
}

/** 读取并合并各层;相对路径一律相对产品根(repoRoot)解析(v2.1 §5 ⑥) */
export function loadProductConfig(repoRoot: string, opts: {
    userConfigPath?: string;
    /**
     * 覆盖数据根。**一次决定三样东西**:用户配置在哪、provider 用户覆盖模板在哪、产物落在哪。
     * 🔴 不提供这个口子时,调用方只能单独塞 `userConfigPath` —— 那会让"用户配置"按调用方给的根找、
     *    而"provider 覆盖模板"仍按 repoRoot 推的根找:同一个用户的两份设置被从两个地方读,
     *    表现是"我明明放了自己的模板,它却用了仓库自带的那份",且不报错(Codex 审计 mimo-r1 P2)。
     */
    dataRootOverride?: string;
    env?: NodeJS.ProcessEnv;
    providerOverride?: string;
    authOverride?: string;
    /**
     * 缺密钥时是否抛错。默认 `true`(要跑起来就必须有 key)。
     *
     * 🔴 传 `false` 给**只想读路径的调用方**(体检、找 Python 解释器)。
     *    原来不给这个口子:密钥没导 → 整个配置加载抛错 → 调用方连 `python` 都拿不到,
     *    于是体检报出 **"未找到 Python(配置 python 为空且无 .venv)"** ——
     *    **这是句假话**,Python 明明配着、venv 也在。一个不相干的问题
     *    (还没导模型 key)让产品对用户说了错误的诊断,而这恰恰是第一次配国产模型的常态。
     *    ⇒ 宽松模式下把这个问题记进 `authError` 如实报出来,别牵连别的检查项。
     */
    requireAuth?: boolean;
  } = {}): LoadedProductConfig {
  const env = opts.env ?? process.env;
  const sources: string[] = ["builtin"];
  let cfg = DEFAULT_PRODUCT_CONFIG;
  const productFile = path.join(repoRoot, PRODUCT_CONFIG_FILE);
  // auth 是否被用户显式写过(用户配置 / VRA_PROVIDER_AUTH / CLI --auth;产品配置 vibe-research.config.json 是产品默认,不算显式):
  // 没写过时切换 profile 按模板唯一支持的模式自动选;写过的永不覆盖
  let authExplicit = false;
  if (fs.existsSync(productFile)) { cfg = mergeLayer(cfg, readLayer(productFile, "产品配置")); sources.push(productFile); }
  /**
   * 数据根。**只在这里算一次,后面所有地方都用它。**
   *
   * 优先级:调用方显式 override > `VRA_DATA_ROOT` > 产品配置里的 `paths.data_root`(相对产品根)。
   *
   * `VRA_DATA_ROOT` 让源码目录与用户数据目录可以分离，换代码副本或升级代码时不迁移用户资料。
   * 🔴 原先这里算了两遍(`dataRootTmp` / `dataRootAbs`),而 `resolved.dataRoot` **压根没看 override** ——
   *    传了 override 时,"用户配置从 A 读、产物往 B 写",两个根不一致且不报错。改成一处算、处处用。
   */
  const dataRoot = resolveDataRoot(repoRoot, cfg.paths.data_root, env, opts.dataRootOverride);
  const userFile = opts.userConfigPath ?? path.join(dataRoot, USER_CONFIG_FILE);
  if (fs.existsSync(userFile)) {
    const layer = readLayer(userFile, "用户配置");
    if (layer.paths && "data_root" in layer.paths) throw new Error(`用户配置不得修改 paths.data_root(它决定了用户配置自身的位置):${userFile}`);
    if (layer.provider?.auth) authExplicit = true;
    cfg = mergeLayer(cfg, layer); sources.push(userFile);
  }
  const envLayer: Partialish = {};
  if (env.VRA_CODEX_PATH) envLayer.engine = { ...(envLayer.engine ?? {}), codex_path: env.VRA_CODEX_PATH };
  if (env.VRA_CODEX_HOME) envLayer.engine = { ...(envLayer.engine ?? {}), codex_home: env.VRA_CODEX_HOME };
  if (env.VRA_PYTHON) envLayer.python = env.VRA_PYTHON;
  // 环境变量层整体合并(VRA_PROVIDER / VRA_PROVIDER_AUTH 与 VRA_CODEX_* / VRA_PYTHON 可同时生效)
  if (env.VRA_PROVIDER) envLayer.provider = { ...(envLayer.provider ?? {}), profile: env.VRA_PROVIDER };
  if (env.VRA_PROVIDER_AUTH) { envLayer.provider = { ...(envLayer.provider ?? {}), auth: assertAuth(env.VRA_PROVIDER_AUTH, "VRA_PROVIDER_AUTH") }; authExplicit = true; }
  if (Object.keys(envLayer).length) { cfg = mergeLayer(cfg, envLayer); sources.push("env"); }
  if (opts.providerOverride || opts.authOverride) {
    const cli: Partial<ProviderProfile> = { ...(opts.providerOverride ? { profile: opts.providerOverride } : {}), ...(opts.authOverride ? { auth: assertAuth(opts.authOverride, "--auth") } : {}) };
    if (opts.authOverride) authExplicit = true;
    cfg = mergeLayer(cfg, { provider: cli }); sources.push("cli");
  }
  // (数据根在上面算过了 —— 与 userFile 必然同一个根)
  const dataRootAbs = dataRoot;
  // M4:provider 要么是 openai 原生默认,要么是 providers/<id>.json 里的已知模板(字段由模板决定;非 openai 只能 api_key)
  let providerProfile: ProviderProfileFile | null = null;
  const profileId = cfg.provider.profile ?? (cfg.provider.name === "openai" ? "openai" : null);
  if (!profileId) throw new Error(`provider 必须指定 profile(providers/<id>.json 的 id)或为 openai 原生默认;当前 ${JSON.stringify(cfg.provider)}`);
  const loaded = loadProviderProfile(repoRoot, dataRootAbs, profileId);
  providerProfile = loaded.profile;
  cfg = { ...cfg, provider: { ...cfg.provider, profile: profileId, name: providerProfile.id === "openai" ? "openai" : providerProfile.id, wire_api: providerProfile.wire_api, base_url: providerProfile.base_url, env_key: providerProfile.env_key } };
  if (!authExplicit && !providerProfile.auth_modes.includes(cfg.provider.auth) && providerProfile.auth_modes.length === 1)
    cfg = { ...cfg, provider: { ...cfg.provider, auth: providerProfile.auth_modes[0] } };  // 未显式指定 auth → 用模板唯一支持的模式(如第三方只有 api_key)
  if (!providerProfile.auth_modes.includes(cfg.provider.auth))
    throw new Error(`provider ${profileId} 不支持 auth=${cfg.provider.auth}(支持:${providerProfile.auth_modes.join("/")});请改配置里的 provider.auth、环境变量 VRA_PROVIDER_AUTH 或 CLI --auth`);
  if (cfg.paths.constitution !== "AGENTS.md")
    throw new Error(`paths.constitution 必须是 "AGENTS.md"(Codex 从产品根自动加载的文件名);当前 ${cfg.paths.constitution}`);
  let authError: string | null = null;
  if (cfg.provider.auth === "api_key" && !env[cfg.provider.env_key]) {
    authError = `provider.auth=api_key 但环境变量 ${cfg.provider.env_key} 未设置(密钥只从环境变量读,不进配置文件)`;
    if (opts.requireAuth !== false) throw new Error(authError);
  }
  const abs = (p: string) => path.resolve(repoRoot, p);
  const skills = abs(cfg.paths.skills);
  /**
   * 引擎 home。默认值 `.local/codex-home` 写的是"数据根下面那一格" ——
   * 所以数据根被改到别处时它必须跟着走，否则引擎状态会留在旧代码目录。
   * 显式配过(配置文件 / `VRA_CODEX_HOME`)的一律不动。
   */
  const codexHomeIsDefault = cfg.engine.codex_home === DEFAULT_PRODUCT_CONFIG.engine.codex_home;
  const codexHome = codexHomeIsDefault
    ? path.join(dataRoot, path.basename(DEFAULT_PRODUCT_CONFIG.engine.codex_home))
    : abs(cfg.engine.codex_home);
  return {
    ...cfg,
    authError,
    resolved: {
      codexHome,
      dataRoot,
      constitution: abs(cfg.paths.constitution),
      skills,
      calcCli: abs(cfg.paths.calc_cli),
      scriptsRel: path.join(cfg.paths.skills, "data-access", "scripts"),
      codexPath: cfg.engine.codex_path ? abs(cfg.engine.codex_path) : null,
    },
    sources,
    providerProfile,
  };
}
