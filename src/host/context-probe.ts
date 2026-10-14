/**
 * ContextProbe — B3-3 model capacity awareness, defensively.
 *
 * DSH exposes NO token metering or quota-consumption service (verified against
 * the installed @deepseek-ai typings): the only reliable capacity datum is the
 * current model's context window, disclosed by `llm.resolveModelInfo()` as
 * `info.context.contextWindow`. This probe resolves it once per provider|model
 * route, negative-caches failures behind a cooldown so an unavailable route
 * costs one attempt per cooldown window, and reports null whenever anything is
 * missing — the client auto-hides the whole feature when the field is null.
 */

import type { LlmService, AgentDefaultModelService } from "./llm.js";

/** Capacity facts for one resolved provider|model route. */
export type ContextCapacity = {
  provider: string;
  model: string;
  /** Maximum combined request+response tokens, when the adapter discloses it. */
  contextWindow: number;
};

const DEFAULT_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

export class ContextProbe {
  /** route → resolved capacity; a cached null means "known unavailable". */
  private cache = new Map<string, ContextCapacity | null>();
  private lastFailAt = 0;
  private inflight: Promise<ContextCapacity | null> | null = null;

  constructor(
    private readonly opts: {
      /** Live service lookup (both may be absent on older shells). */
      services: () => { llm?: LlmService; agentDefaultModel?: AgentDefaultModelService };
      failCooldownMs?: number;
    },
  ) {}

  /**
   * Resolved capacity for the current default-model selection, or null when
   * services are missing / the route fails / no contextWindow is disclosed.
   * Never throws; concurrent callers share one in-flight probe.
   */
  current(): Promise<ContextCapacity | null> {
    if (!this.inflight) {
      this.inflight = this.probe().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async probe(): Promise<ContextCapacity | null> {
    const { llm, agentDefaultModel } = this.opts.services();
    if (!llm?.resolveModelInfo || !agentDefaultModel) return null;
    try {
      const sel = agentDefaultModel.currentSelection();
      let provider: string | undefined = sel.provider;
      if (!provider) provider = llm.listProviders?.()[0]?.id;
      if (!provider || !sel.model) return null;
      const key = `${provider}|${sel.model}`;
      if (this.cache.has(key)) return this.cache.get(key) ?? null;
      // A recently thrown attempt stays quiet for the cooldown window.
      if (Date.now() - this.lastFailAt < (this.opts.failCooldownMs ?? DEFAULT_FAIL_COOLDOWN_MS)) {
        return null;
      }
      const info = await llm.resolveModelInfo(provider, sel.model);
      const cw = info?.context?.contextWindow;
      if (typeof cw === "number" && cw > 0) {
        const cap: ContextCapacity = { provider, model: sel.model, contextWindow: cw };
        this.cache.set(key, cap);
        return cap;
      }
      // Route answered but disclosed nothing → remember as unavailable.
      this.cache.set(key, null);
      return null;
    } catch {
      this.lastFailAt = Date.now();
      return null;
    }
  }
}
