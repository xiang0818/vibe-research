/**
 * 一份对话的状态机 —— **两个外壳共用**：右上角那个按页问的抽屉，和从底部推上来的控制台。
 *
 * 抽出来是因为这套逻辑里有一半是"看不出来但会出错"的东西（半截回答、换 key 竞态、
 * 后端 session 归属），复制两份迟早会有一份先坏，而且坏了没人看得出来。
 *
 * 🔴 **对话按 key 分开存**：不同页面 / 不同用途的上下文不同，混在一起比不存更让人困惑。
 * 🔴 **没答完的那一轮不落盘、也不进下一轮**：半截回答会被模型当成自己上一轮的完整发言，
 *    而孤零零的提问会被当成还在等回答 —— 它会去答一道被放弃的题。
 * 🔴 **换 key / 关面板要中止在跑的请求**：迟到的回答会被写进另一份对话里。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const CHAT_KEY = "vr-ai-chat:";
const EPOCH_KEY = "vr-ai-epoch:";
/** localStorage 总配额约 5MB，而一轮长回答可能上万字；不设上限迟早写爆，而且是静默失败 */
const MAX_PERSISTED = 40;

export interface AiMsg {
  role: "user" | "assistant";
  content: string;
  /** 没收完就被中止的回答。**界面照常显示**（用户看得到已经拿到的部分），但不落盘、不进下一轮 */
  partial?: boolean;
}

export type AiSend = (args: { message: string; session: string; signal: AbortSignal }) => Promise<string>;

const readText = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // 隐私模式 / 配额满时会**抛异常**，不是返回 null
  }
};
const writeText = (k: string, v: string): boolean => {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
};
const dropText = (k: string): boolean => {
  try {
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
};

function loadChat(key: string): AiMsg[] {
  const raw = readText(CHAT_KEY + key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return []; // 旧版本 / 被手工改坏：当没有，别让页面崩
    return parsed.filter(
      (m): m is AiMsg =>
        !!m && typeof m === "object" && typeof (m as AiMsg).content === "string" &&
        ((m as AiMsg).role === "user" || (m as AiMsg).role === "assistant"),
    );
  } catch {
    return [];
  }
}

/**
 * 只保留**完整的轮次**。partial 的回答要连同它前面那条提问一起丢 ——
 * 只丢回答会留下一个孤立的提问，模型在 history 里看到连续两条用户发言，
 * 会把那个被放弃的问题当成还在等答案。
 */
export function completeTurns(msgs: AiMsg[]): AiMsg[] {
  const out: AiMsg[] = [];
  for (const m of msgs) {
    if (m.partial) {
      if (out.length && out[out.length - 1]?.role === "user") out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * 删掉一份对话的全部痕迹。
 * 🔴 由这里导出、而不是让调用方自己拼 `"vr-ai-chat:" + id` —— 键的前缀只有一处定义，
 *    否则删的时候少删一个（比如 epoch），下次新建同名对话会**继承上一条的后端线程**。
 */
export function dropChat(key: string): void {
  dropText(CHAT_KEY + key);
  dropText(EPOCH_KEY + key);
}

export function saveChat(key: string, msgs: AiMsg[]): boolean {
  const keep = completeTurns(msgs);
  if (!keep.length) {
    return dropText(CHAT_KEY + key);
  }
  return writeText(CHAT_KEY + key, JSON.stringify(keep.slice(-MAX_PERSISTED)));
}

/**
 * 对话 key → 后端 session id。后端只收 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，
 * 而 key 里有 `/`、中文、各种代码。
 * 🔴 **带哈希**，不是单纯替换非法字符：`/a/b` 与 `/a-b` 替换后会撞成同一个 session，
 *    那就是两份对话共用后端一条线程 —— 而界面上看不出来。
 * `epoch` 让「清空对话」在后端也真的换一条线程（否则清了界面，模型还记着）。
 */
export function sessionId(key: string, epoch: number): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const slug = key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40);
  return `p${h.toString(36)}-${slug || "x"}-${epoch}`.slice(0, 64);
}

export interface AiChat {
  msgs: AiMsg[];
  /**
   * `msgs` 现在属于哪个 key。
   * 🔴 换 key 之后有**一帧** `msgs` 还是上一份的（state 下一帧才生效）。调用方拿 msgs 去做
   *    「记进目录」「生成标题」这类事之前，必须先用它对一下 ——
   *    真踩过：点「新对话」之后，新的那条被写上了**上一条的标题**。
   */
  key: string;
  loading: boolean;
  err: string | null;
  info: string | null;
  /** 发一条；`decorate` 让调用方在真正发出去之前给消息加上下文（界面上仍显示原话） */
  submit: (text: string, decorate?: (q: string) => string) => Promise<void>;
  clear: () => void;
  /** 中止在跑的请求（关面板时调）*/
  abort: () => void;
}

export function useAiChat(key: string, send: AiSend): AiChat {
  const [epoch, setEpoch] = useState(0);
  /**
   * key 与消息**放在同一个 state 里原子更新**。分成 msgs + 一个记录归属的 ref 的话，
   * 换 key 那一帧 ref 已指向新 key 而 msgs 还是旧的（setState 下一帧才生效），
   * 落盘守卫会误放行，把上一份对话写进这一份的键、覆盖掉它本来存着的。
   */
  const [chat, setChat] = useState<{ key: string; msgs: AiMsg[] }>(() => ({ key, msgs: key ? loadChat(key) : [] }));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 提交权的**同步**锁。
   * 🔴 不能只靠 `loading`：它是 state，同一事件里连点两次两个闭包看到的都是 false，
   *    第二次会中止第一次，而第一次的 catch 判定为"被接管"不做清理 ——
   *    界面上就留下一轮永远转圈的空气泡。ref 是同步的，抢得住。
   */
  /** 存**持有者**而不是布尔：布尔的话旧请求的 finally 会把新请求刚拿到的锁清掉。 */
  const submittingRef = useRef<AbortController | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const sendRef = useRef(send);
  sendRef.current = send;

  const setMsgs = useCallback(
    (updater: AiMsg[] | ((prev: AiMsg[]) => AiMsg[])) =>
      setChat((c) => ({ key: c.key, msgs: typeof updater === "function" ? updater(c.msgs) : updater })),
    [],
  );

  // 换 key = 换一份对话：把这一份存着的读进来，并**中止在跑的请求**
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    submittingRef.current = null;
    setLoading(false);
    setErr(null);
    setInfo(null);
    setEpoch(Number(readText(EPOCH_KEY + key) ?? 0) || 0);
    setChat({ key, msgs: key ? loadChat(key) : [] });
  }, [key]);

  // 落盘。守卫见上面 chat state 的注释：换 key 那一帧 chat.key 仍是旧值，与 key 不等
  useEffect(() => {
    if (!key || chat.key !== key) return;
    const saved = saveChat(key, chat.msgs);
    setStorageWarning(!saved
      ? "浏览器存储空间不足或不可用，本次聊天未能保存。请先复制重要内容，再刷新或关闭页面。"
      : completeTurns(chat.msgs).length > MAX_PERSISTED
        ? "此对话仅在浏览器保留最近 20 轮。重要结论请及时存入沉淀或复制备份。"
        : null);
  }, [key, chat]);

  useEffect(() => () => abortRef.current?.abort(), []); // 卸载兜底

  const abort = useCallback(() => {
    const hadRequest = !!abortRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    submittingRef.current = null;    // 不放锁的话，切走再切回来会永远发不出去
    setLoading(false);
    if (hadRequest) {
      setMsgs((m) => completeTurns(m));
      setErr(null);
      setInfo("已停止等待，并已请求中止本轮。已启动的后台研究需在研究页单独取消。");
    }
  }, [setMsgs]);

  const clear = useCallback(() => {
    abort();
    setErr(null);
    setInfo(null);
    setMsgs([]); // saveChat 见空数组会删键，不留空壳
    // 后端也换一条线程：只清界面的话，模型还记着刚才聊过什么
    setEpoch((e) => {
      const next = e + 1;
      writeText(EPOCH_KEY + keyRef.current, String(next));
      return next;
    });
  }, [abort, setMsgs]);

  const session = useMemo(() => sessionId(key, epoch), [key, epoch]);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const submit = useCallback(
    async (text: string, decorate?: (q: string) => string) => {
      const q = text.trim();
      if (!q || loading || submittingRef.current) return;
      const ac = new AbortController();
      submittingRef.current = ac;      // 抢到提交权的是这一次
      setErr(null);
      setInfo(null);
      setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "", partial: true }]);
      setLoading(true);

      const patchLast = (fn: (m: AiMsg) => AiMsg) =>
        setMsgs((m) => m.map((msg, i) => (i === m.length - 1 && msg.role === "assistant" ? fn(msg) : msg)));

      abortRef.current?.abort();
      abortRef.current = ac;
      const startedKey = keyRef.current;
      const alive = () => abortRef.current === ac && !ac.signal.aborted;

      try {
        const reply = await sendRef.current({
          message: decorate ? decorate(q) : q,
          session: sessionRef.current,
          signal: ac.signal,
        });
        if (alive()) {
          // 🔴 **空回答不算回答**。后端解析失败 / 空响应 / 降级都可能返回 ""，
          //    照原样收下就会在界面上出现一个"正常结束的空气泡"，还会落盘、
          //    并作为完整历史进入下一轮 —— 典型的把「没取到」渲染成正常结果。
          if (!reply.trim()) throw new Error("模型没有返回内容（空回答）");
          patchLast((m) => {
            const { partial: _drop, ...rest } = m;
            return { ...rest, content: reply };
          });
        }
      } catch (e) {
        // 三种"不该清理"要分开判：被更新的请求接管了（别删人家的气泡）、对话已经换掉了（别动新对话）、
        // 面板被关闭（abortRef 被置 null 但对话没变 → **仍要清理**，否则空气泡会被持久化）
        const superseded = abortRef.current !== null && abortRef.current !== ac;
        if (!superseded && keyRef.current === startedKey) {
          setMsgs((m) => {
            const last = m[m.length - 1];
            if (!last || last.role !== "assistant" || last.content) return m;
            // 只删空气泡会留下一个孤立的提问，下一轮就是连续两条用户发言
            return m.slice(0, m[m.length - 2]?.role === "user" ? -2 : -1);
          });
          if (!ac.signal.aborted && !(e instanceof Error && e.name === "AbortError")) {
            setErr(e instanceof Error ? e.message : "对话失败");
          }
        }
      } finally {
        // 🔴 只放**自己**那把锁。无条件放的话：A 被 abort → 锁已放 → B 上锁 →
        //    A 的 finally 迟到，把 B 的锁也清了 → 又能重复提交，竞态原样回来。
        //    （与 useArchiveThenRefresh 的 busyRun 是同一条规矩。）
        if (submittingRef.current === ac) submittingRef.current = null;
        if (abortRef.current === ac) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [loading, setMsgs],
  );

  return { msgs: chat.msgs, key: chat.key, loading, err, info: [storageWarning, info].filter(Boolean).join(" ") || null, submit, clear, abort };
}
