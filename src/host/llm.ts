/**
 * Shared LLM helper for DSHBuddy host engines.
 *
 * Every LLM-powered feature (caring bubbles, chat proxy, LLM daily memory
 * summaries, LLM user-portrait generation) goes through askLlm(), which:
 *   1. prefers the user's DeepSeek Harness LLM configuration (llm service +
 *      agent default model),
 *   2. falls back to the legacy chat config (ollama/openai/gemini),
 *   3. finally returns the provided fallback so the feature always works
 *      offline (no LLM, no key, no network).
 */

import { PERSONALITY_PRESETS } from "./store.js";

/** Minimal cordis context shape the host half uses (type-only). */
export type BuddyCtx = {
  get<T = unknown>(name: string): T | undefined;
};

/** Minimal shape of the DSH llm service (see @deepseek-ai/dsh-llm). */
export type LlmService = {
  stream(options: {
    provider: string;
    model: string;
    messages: unknown[];
    system?: string;
    /** Adapter-owned reasoning-effort id (from resolveModelInfo efforts). */
    reasoningEffort?: string;
    signal?: AbortSignal;
  }): AsyncIterable<{
    type: string;
    text?: string;
    block?: { type?: string; text?: string };
    /** FinishReason is an object ({kind:'stop'|'error'|…}) — never a plain string. */
    reason?: unknown;
  }>;
  listProviders?(): { id: string }[];
  /** Optional per-route model metadata (reasoning efforts etc.). */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    reasoning?: { efforts?: readonly { id: string; name: string }[]; defaultEffort?: string };
    /** Provider-owned context capacity when disclosed (dsh-llm LlmModelContext). */
    context?: { contextWindow?: number };
  }>;
};

/** Minimal shape of the DSH default-model service (dsh-agent-default-model). */
export type AgentDefaultModelService = {
  currentSelection(): { provider: string; model: string };
};

export type ChatConfig = {
  provider: "ollama" | "openai" | "gemini" | "off";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Fast-reply mode (see store.ts ChatConfig); undefined = enabled default. */
  disableThinking?: boolean;
};

/** Build the system prompt from the configured personality (preset/custom + tone dials + constraints). */
export function buildPersonalityPrompt(p: {
  preset: string;
  customPrompt: string;
  constraints: string[];
  traits?: { sarcasm: number; enthusiasm: number; chattiness: number; humor: number; gentleness: number };
}): string {
  const preset = PERSONALITY_PRESETS.find((x) => x.id === p.preset);
  const base = (p.customPrompt ?? "").trim() || preset?.prompt || "";
  const parts = [base];
  // B2-4 tone dials → qualitative guidance (raw numbers mean little to a model).
  const t = p.traits;
  if (t) {
    const dial = (v: number, low: string, mid: string, high: string, top: string) =>
      v <= 25 ? low : v <= 50 ? mid : v <= 75 ? high : top;
    const lines = [
      `毒舌程度：${dial(t.sarcasm, "几乎不吐槽，只说好话", "偶尔善意调侃", "经常俏皮吐槽", "毒舌属性拉满但不出恶言")}`,
      `热情程度：${dial(t.enthusiasm, "平静克制", "温和友好", "热情积极", "元气满满，语气高涨")}`,
      `话痨程度：${dial(t.chattiness, "惜字如金，一句话说完", "简洁，一两句为宜", "可以多说两句细节", "喜欢展开聊聊，但仍切题")}`,
      `幽默程度：${dial(t.humor, "严肃认真不搞笑", "偶尔轻松一下", "常带点小幽默", "高频玩梗讲冷笑话")}`,
      `温柔程度：${dial(t.gentleness, "直来直去不安慰", "适度体贴", "语气温和关心情绪", "极度温柔治愈，优先照顾感受")}`,
    ];
    parts.push(lines.join("；") + "。");
  }
  parts.push(...(p.constraints ?? []).map((c) => `约束：${c}`));
  return parts.filter(Boolean).join("\n");
}

/** Result of one chat attempt through the DSH llm service. */
export type DshChatResult = { ok: true; text: string } | { ok: false; error: string };

/** Pick the quietest selectable reasoning effort (off → minimal → low). */
export function pickQuietEffort(efforts: readonly { id: string; name: string }[]): string | undefined {
  if (!efforts.length) return undefined;
  const off = (e: { id: string; name: string }) => /^off$/i.test(e.id) || /^(off|disabled?|none|关闭|禁用思考?)$/i.test(e.name.trim());
  const min = (e: { id: string; name: string }) => /^minimal$|^min$/i.test(e.id) || /minimal|最少|最短/i.test(e.name);
  const low = (e: { id: string; name: string }) => /^low$/i.test(e.id) || /low|低/i.test(e.name);
  for (const match of [off, min, low]) {
    const hit = efforts.find(match);
    if (hit) return hit.id;
  }
  return undefined;
}

/** Resolved quiet-effort per provider|model route (undefined = leave default). */
const quietEffortCache = new Map<string, string | undefined>();

/** Resolve the reasoning-effort override for "don't think" mode (cached). */
async function quietEffortFor(llm: LlmService, provider: string, model: string): Promise<string | undefined> {
  const key = `${provider}|${model}`;
  if (!quietEffortCache.has(key)) {
    let chosen: string | undefined;
    try {
      const info = await llm.resolveModelInfo?.(provider, model);
      chosen = pickQuietEffort(info?.reasoning?.efforts ?? []);
    } catch {
      chosen = undefined; // metadata unavailable → keep provider default
    }
    quietEffortCache.set(key, chosen);
  }
  return quietEffortCache.get(key);
}

/** Extract the kind from a FinishReason value (object form; string tolerated defensively). */
function finishKind(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object") {
    const kind = (reason as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return undefined;
}

/** Render a FinishReason's carried LlmFailure as `code: message`. */
function finishFailure(reason: unknown): string | undefined {
  if (reason && typeof reason === "object") {
    const f = (reason as { failure?: unknown }).failure;
    if (f && typeof f === "object") {
      const code = (f as { code?: unknown }).code;
      const message = (f as { message?: unknown }).message;
      const codeStr = typeof code === "string" ? code : "error";
      return typeof message === "string" && message ? `${codeStr}: ${message}` : codeStr;
    }
  }
  return undefined;
}

/**
 * Chat through the user's DeepSeek Harness LLM configuration.
 *
 * The harness takes the system prompt via GenerateOptions.system (never as a
 * message) and hand-built messages need stable ids plus producer sources.
 * Adapter failures surface as a terminal finish chunk whose reason is an
 * OBJECT `{kind:'error'|'aborted', failure:{code,message}}` — comparing it to
 * the string "error" never matches, which is exactly how failures used to be
 * swallowed and misreported as "chat not configured".
 */
export async function chatViaDsh(
  llm: LlmService,
  agentDefaultModel: AgentDefaultModelService,
  messages: { role: string; content: string }[],
  opts: { disableThinking?: boolean } = {},
): Promise<DshChatResult> {
  try {
    const sel = agentDefaultModel.currentSelection();
    let provider = sel.provider;
    const model = sel.model;
    if (!provider) {
      const provs = llm.listProviders?.() ?? [];
      provider = provs[0]?.id;
    }
    if (!provider || !model) {
      return { ok: false, error: "no default model selected in DSH settings" };
    }
    // "Fast reply" mode: when the route exposes selectable efforts, request the
    // quietest one (off/minimal/low) so casual pet replies skip long thinking.
    const reasoningEffort = opts.disableThinking ? await quietEffortFor(llm, provider, model) : undefined;

    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const stamp = Date.now().toString(36);
    const chatMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m, i) => ({
        id: `dshbuddy-${stamp}-${i}`,
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: [{ type: "text", text: m.content }],
        source:
          m.role === "assistant"
            ? { kind: "model", provider, model }
            : { kind: "user" },
      }));

    let text = "";
    let sawDelta = false;
    let lastBlockText = "";
    let failure: string | undefined;
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: chatMsgs,
      system: system || undefined,
      reasoningEffort,
      signal: AbortSignal.timeout(120_000),
    })) {
      // Accumulate deltas only — block-end repeats the assembled text and
      // appending both would double every reply.
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
        sawDelta = true;
      } else if (chunk.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
        lastBlockText = chunk.block.text;
      } else if (chunk.type === "finish") {
        const kind = finishKind(chunk.reason);
        if (kind === "error" || kind === "aborted") {
          failure = finishFailure(chunk.reason) ?? kind;
        }
      }
    }
    if (failure) return { ok: false, error: failure };
    const reply = (sawDelta ? text : lastBlockText).trim();
    return reply ? { ok: true, text: reply } : { ok: false, error: "empty response from model" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function proxyChat(
  provider: ChatConfig["provider"],
  chat: ChatConfig,
  messages: { role: string; content: string }[],
  modelOverride?: string,
): Promise<string | null> {
  const model = modelOverride || chat.model || undefined;
  try {
    if (provider === "ollama") {
      const base = chat.baseUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model ?? "llama3.2", messages, stream: false }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { message?: { content?: string } };
      return json.message?.content ?? null;
    }
    if (provider === "openai") {
      const res = await fetch(`${chat.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${chat.apiKey}`,
        },
        body: JSON.stringify({ model: model ?? "gpt-4o-mini", messages }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? null;
    }
    if (provider === "gemini") {
      const base = chat.baseUrl.replace(/\/+$/, "") || "https://generativelanguage.googleapis.com/v1beta";
      const key = chat.apiKey;
      const url = `${base}/models/${model ?? "gemini-2.0-flash"}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return json.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the DSH llm services out of the context (may be absent on older shells). */
export function llmServices(ctx: BuddyCtx): {
  llm?: LlmService;
  agentDefaultModel?: AgentDefaultModelService;
} {
  return {
    llm: ctx.get<LlmService>("llm"),
    agentDefaultModel: ctx.get<AgentDefaultModelService>("agentDefaultModel"),
  };
}

export type AskLlmOptions = {
  system?: string;
  maxLength?: number;
  temperature?: number;
};

/**
 * Ask the LLM with a user prompt; returns null when no LLM backend answers
 * (callers then use their template/rule fallback). Never throws.
 */
export async function askLlm(
  ctx: BuddyCtx,
  chat: ChatConfig,
  prompt: string,
  opts: AskLlmOptions = {},
): Promise<string | null> {
  const { llm, agentDefaultModel } = llmServices(ctx);
  const system = opts.system ?? "你是 DSHBuddy，一只陪伴用户在 DeepSeek Harness 中工作的宠物鲸鱼。回答简洁、真诚、中文。";
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: prompt },
  ];
  if (llm && agentDefaultModel) {
    const result = await chatViaDsh(llm, agentDefaultModel, messages, { disableThinking: chat.disableThinking });
    if (result.ok) return opts.maxLength ? result.text.slice(0, opts.maxLength) : result.text;
  }
  if (chat.provider !== "off" && chat.baseUrl) {
    const reply = await proxyChat(chat.provider, chat, messages, undefined);
    if (reply) return opts.maxLength ? reply.slice(0, opts.maxLength) : reply;
  }
  return null;
}
