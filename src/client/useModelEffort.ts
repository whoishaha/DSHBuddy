/**
 * useModelEffort — read/write the current DSH session's model reasoning effort
 * (off / low / high / max for DeepSeek) through the harness session wire face.
 *
 * The services are captured at apply() time via setModelEffortServices(); when
 * either is unavailable (older shell, non-routable session) the hook degrades to
 * { supported: [], ready: true } so the slider hides itself.
 */

import { useCallback, useEffect, useState } from "react";

type SessionsService = {
  list?: {
    getSnapshot?: () => { current?: string };
  };
  get?: (sessionId: string) => { command?: (line: string) => Promise<unknown> } | undefined;
};

type ConnectionService = {
  api?: {
    sessions?: {
      models?: (p: { sessionId: string }) => Promise<unknown>;
      selectModel?: (p: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort: string;
      }) => Promise<unknown>;
    };
  };
};

let sessionsSvc: SessionsService | undefined;
let connectionSvc: ConnectionService | undefined;

/** Capture the shell services (called from the plugin apply()). */
export function setModelEffortServices(sessions: unknown, connection: unknown) {
  sessionsSvc = sessions as SessionsService | undefined;
  connectionSvc = connection as ConnectionService | undefined;
}

/** Canonical ordering for the effort slider (DeepSeek: off < low < high < max). */
export const EFFORT_ORDER: Record<string, number> = { off: 0, low: 1, high: 2, max: 3 };

/**
 * Execute a slash-command against the current DSH session (e.g. "/compact"),
 * so quick commands actually run instead of just copying text. A short timeout
 * prevents the UI from hanging when the session can't admit the command.
 */
export async function runBuddyCommand(line: string): Promise<boolean> {
  const sid = sessionsSvc?.list?.getSnapshot?.().current;
  if (!sid) return false;
  try {
    const session = sessionsSvc?.get?.(sid);
    if (typeof session?.command !== "function") return false;
    await Promise.race([
      session.command(line),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback: type the command into the visible DSH composer textarea and try to
 * submit it with a synthetic Enter keydown. Skips any textarea inside our own
 * overlay ([data-dshbuddy]). Returns false when no composer is on screen.
 */
export function insertIntoDshComposer(text: string): boolean {
  if (typeof document === "undefined") return false;
  const candidates = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea")).filter(
    (t) =>
      !t.closest("[data-dshbuddy]") &&
      !t.disabled &&
      t.offsetParent !== null && // visible
      t.getBoundingClientRect().height > 20,
  );
  const ta = candidates[candidates.length - 1]; // the main composer is the last one on the page
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }),
  );
  return true;
}

type ModelMeta = {
  id?: string;
  reasoning?: { efforts?: { id: string }[]; defaultEffort?: string };
};

type ModelsResult = {
  ok?: boolean;
  value?: {
    current?: { provider?: string; model?: string; reasoningEffort?: string };
    groups?: { id?: string; models?: ModelMeta[] }[];
  };
  error?: { code?: string; message?: string };
};

type SelectResult = { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };

function sessionId(): string | null {
  const current = sessionsSvc?.list?.getSnapshot?.().current;
  return typeof current === "string" && current ? current : null;
}

export function useModelEffort(): {
  supported: string[];
  current: string | null;
  ready: boolean;
  select: (effortId: string) => Promise<boolean>;
} {
  const [supported, setSupported] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const api = connectionSvc?.api?.sessions;
    const sid = sessionId();
    if (!api?.models || !sid) {
      setReady(true);
      return;
    }
    try {
      const out = (await api.models({ sessionId: sid })) as { result?: ModelsResult };
      const result = out?.result;
      if (!result?.ok) {
        setReady(true);
        return;
      }
      const cur = result.value?.current;
      let efforts: string[] = [];
      let defaultEffort: string | undefined;
      if (cur?.provider && cur.model) {
        const group = (result.value?.groups ?? []).find((g) => g.id === cur.provider);
        const meta: ModelMeta | undefined = group?.models?.find((m) => m.id === cur.model);
        efforts = (meta?.reasoning?.efforts ?? []).map((e) => e.id).filter(Boolean);
        defaultEffort = meta?.reasoning?.defaultEffort;
      }
      efforts.sort((a, b) => (EFFORT_ORDER[a] ?? 99) - (EFFORT_ORDER[b] ?? 99));
      setSupported(efforts);
      setCurrent(cur?.reasoningEffort ?? defaultEffort ?? null);
    } catch {
      // shell unavailable — slider hides
    }
    setReady(true);
  }, []);

  // The slider mounts fresh each time the pet menu opens, so loading here keeps
  // the value current without subscribing to the session store.
  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback(async (effortId: string): Promise<boolean> => {
    const api = connectionSvc?.api?.sessions;
    const sid = sessionId();
    if (!api?.models || !api?.selectModel || !sid) return false;
    try {
      const out = (await api.models({ sessionId: sid })) as { result?: ModelsResult };
      const cur = out?.result?.value?.current;
      if (!out?.result?.ok || !cur?.provider || !cur?.model) return false;
      const r = (await api.selectModel({
        sessionId: sid,
        provider: cur.provider,
        model: cur.model,
        reasoningEffort: effortId,
      })) as { result?: SelectResult };
      if (!r?.result?.ok) return false;
      setCurrent(effortId);
      return true;
    } catch {
      return false;
    }
  }, []);

  return { supported, current, ready, select };
}
