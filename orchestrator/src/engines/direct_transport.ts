/**
 * **直连传输层**:OpenAI 兼容的 Chat Completions 客户端。
 *
 * 为什么是 Chat Completions 而不是 Responses:Codex 引擎已彻底移除 chat 协议
 * (providers.ts 里有硬拦截与出处),而绝大多数第三方网关、本地模型(Ollama / vLLM / LM Studio)
 * 只提供这一条线。⇒ 两条路是**互补**的:Codex 覆盖 Responses/订阅那侧,直连覆盖它够不着的那侧。
 *
 * 🔴 **本层只管"把一轮对话发出去、把回复解析回来"**,不含工具循环、不含阶段语义 ——
 *    那些在 StageAgent 里。这样传输层可以被单独用假服务器测,不必牵动整条研究链。
 *
 * ⚠️ **第一版不做流式**。研究阶段的产出是结构化 JSON,不需要逐字显示;进度显示走阶段级
 *    (ProgressReporter 已有)。流式会带来 SSE 分帧、断流重试、tool_calls 跨 delta 拼接三类复杂度,
 *    而它们只有在"要让用户看到字一个个出来"时才值得。要加流式时,第一版 backend/chat.py 里
 *    那三处实战处理(按完整字节行解 UTF-8、跨 delta 拼 arguments、兼容不带 index 的网关)必须照搬。
 */

/** 一条对话消息。`tool` 角色用于把工具执行结果喂回模型。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** function calling 的工具声明(由 run_tools.ts 的 registry 生成,不在这里另写一份) */
export interface ChatFunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatFunctionSpec[];
  /** 服务端结构化输出约束;provider 不支持时由调用方改走提示词,**不要在这里静默丢掉** */
  responseFormat?: Record<string, unknown>;
  timeoutMs: number;
  /** 外部取消(编排器的 turn 超时 / 用户中止) */
  signal?: AbortSignal;
}

export interface ChatReply {
  message: ChatMessage;
  finishReason: string | null;
  usage: Record<string, number> | null;
  /** 本次请求耗时,进事件流 */
  durationMs: number;
}

export class DirectTransportError extends Error {
  readonly code: string;
  /** HTTP 状态码;网络层失败时为 null */
  readonly status: number | null;
  /** 是否值得重试:网络抖动、429、5xx 值得;4xx 参数错不值得 */
  readonly retryable: boolean;
  constructor(code: string, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "DirectTransportError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** 上游返回体只取有限长度进错误消息:整包塞进去会把日志和事件流冲垮,也更容易把敏感内容带出去 */
const ERROR_BODY_CAP = 600;

/**
 * 把可能含密钥的文本抹掉。
 * 🔴 错误消息会进事件流、日志和界面 —— key 只要出现一次就等于落盘了。
 * 这里同时抹**已知的那一个**(精确值)和**通用形态**:只抹形态会漏掉不长这样的密钥,
 * 只抹已知值会漏掉上游回显的其它凭据。
 */
export function scrubSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-***");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1***");
  return out;
}

function joinUrl(baseURL: string, pathname: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

/**
 * 发一轮 Chat Completions。
 *
 * 失败一律抛 `DirectTransportError`,并带上**能不能重试**的判断 ——
 * 让调用方决定退避策略,而不是在这里偷偷重试(偷偷重试会让一次超时变成三次计费,
 * 而且工具调用可能已经在服务端执行过了)。
 */
export async function chatCompletion(req: ChatRequest): Promise<ChatReply> {
  const url = joinUrl(req.baseURL, "chat/completions");
  const body: Record<string, unknown> = { model: req.model, messages: req.messages };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: t }));
    body.tool_choice = "auto";
  }
  if (req.responseFormat) body.response_format = req.responseFormat;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(1_000, req.timeoutMs));
  // 外部取消与超时取消合并:任一触发都要停
  const onExternalAbort = () => timeout.abort();
  req.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (req.signal?.aborted) timeout.abort();

  const startedAt = Date.now();
  let res: Response;
  let raw: string;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
    // Headers alone are not completion: keep timeout and cancellation attached
    // until the entire response body has been consumed.
    raw = await res.text();
  } catch (e) {
    const aborted = timeout.signal.aborted;
    const detail = scrubSecrets(e instanceof Error ? e.message : String(e), req.apiKey);
    throw new DirectTransportError(
      aborted ? (req.signal?.aborted ? "cancelled" : "timeout") : "network_error",
      aborted
        ? (req.signal?.aborted ? "请求已被取消" : `请求超时(${req.timeoutMs} 毫秒):${detail}`)
        : `无法连接模型端点:${detail}`,
      null,
      !req.signal?.aborted,   // 用户主动取消不重试;超时与网络错误可以
    );
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onExternalAbort);
  }

  const durationMs = Date.now() - startedAt;
  if (!res.ok) {
    // 429 与 5xx 值得退避重试;4xx 多是参数 / 密钥问题,重试只会重复烧钱
    const retryable = res.status === 429 || res.status >= 500;
    throw new DirectTransportError("http_error",
      `模型端点返回 ${res.status}:${scrubSecrets(raw.slice(0, ERROR_BODY_CAP), req.apiKey)}`,
      res.status, retryable);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    throw new DirectTransportError("bad_json",
      `模型端点返回的不是合法 JSON:${scrubSecrets(raw.slice(0, ERROR_BODY_CAP), req.apiKey)}`, res.status, true);
  }

  const doc = parsed as { choices?: { message?: ChatMessage; finish_reason?: string }[]; usage?: Record<string, number>; error?: unknown };
  // 有些兼容端点用 200 + error 体表示失败 —— 不认这一层就会把错误当成空回复
  if (doc.error) {
    throw new DirectTransportError("upstream_error",
      `模型端点报错:${scrubSecrets(JSON.stringify(doc.error).slice(0, ERROR_BODY_CAP), req.apiKey)}`, res.status, false);
  }
  const choice = doc.choices?.[0];
  if (!choice?.message) {
    throw new DirectTransportError("empty_choice",
      `模型端点没有返回任何回复(choices 为空):${scrubSecrets(raw.slice(0, 200), req.apiKey)}`, res.status, true);
  }
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? null,
    usage: doc.usage ?? null,
    durationMs,
  };
}
