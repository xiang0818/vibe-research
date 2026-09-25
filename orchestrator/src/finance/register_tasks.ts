/**
 * 金融产品任务入口的额外注册项。
 *
 * 六阶段 CLI 只需要 `register.ts` 的 Plugin；Deep 任务解析器会依赖服务层与 Codex Deep 适配器，
 * 因而只在真正提供统一任务 API 的 composition root 加载。把两者混在同一个副作用入口里，
 * 会让实验 Direct CLI 即使完全不走 Deep，也在模块加载时拉入 Codex SDK。
 */
import "./register.ts";

import { registerDeepTargetResolver } from "../deep_target_registry.ts";
import { FinanceDeepTargetResolver } from "./deep_target.ts";

registerDeepTargetResolver((dataRoot) => new FinanceDeepTargetResolver(dataRoot));
