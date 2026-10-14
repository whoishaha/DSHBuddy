/**
 * Bubble templates — ported from Petdex CLI (`packages/petdex-cli/src/hooks/bubble-templates.ts`).
 *
 * DSH session events → short human-readable bubble text. Deterministic
 * templates, no LLM: same event kind renders the same string, split into
 * "running" (while working) / "done" (after it returns).
 */

export type BubblePhase = "running" | "done";

export type BubbleEvent =
  | { kind: "tool"; phase: BubblePhase; toolName: string; toolInput?: unknown }
  | { kind: "session.start" } // user submitted a prompt
  | { kind: "session.end" } // assistant handed the mic back
  | { kind: "session.waiting" }; // approval/question pending

/**
 * Map DSH tool names to a canonical kind so one template covers read/edit/
 * bash/grep/glob/webfetch/task. Unknown tools fall through to the generic
 * "Calling X" / "Called X" templates.
 */
function canonicalToolKind(
  toolName: string,
):
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "grep"
  | "glob"
  | "webfetch"
  | "task"
  | "unknown" {
  const lower = toolName.toLowerCase();
  if (lower === "read") return "read";
  if (lower === "edit" || lower === "multiedit" || lower === "str_replace_editor") return "edit";
  if (lower === "write") return "write";
  if (lower === "bash" || lower === "shell" || lower === "pwsh" || lower === "terminal") return "bash";
  if (lower === "grep" || lower === "rg" || lower === "glob") return "grep";
  if (lower === "web_search" || lower === "websearch" || lower === "webfetch" || lower === "web_fetch") return "webfetch";
  if (lower === "task" || lower === "agent" || lower === "subagent" || lower === "workflow") return "task";
  return "unknown";
}

function fieldFrom(input: unknown, key: string): string | null {
  if (input == null || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function clip(text: string, max = 40): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatBubble(event: BubbleEvent): string {
  if (event.kind === "session.start") return "Thinking…";
  if (event.kind === "session.end") return "Done.";
  if (event.kind === "session.waiting") return "Waiting for you…";

  const { toolName, phase, toolInput } = event;
  const kind = canonicalToolKind(toolName);
  const past = phase === "done";

  switch (kind) {
    case "read": {
      const path = fieldFrom(toolInput, "file_path") ?? fieldFrom(toolInput, "path");
      const name = path ? clip(basename(path)) : null;
      if (name) return past ? `Read ${name}` : `Reading ${name}`;
      return past ? "Read file" : "Reading file";
    }
    case "edit":
    case "write": {
      const path = fieldFrom(toolInput, "file_path") ?? fieldFrom(toolInput, "path");
      const name = path ? clip(basename(path)) : null;
      if (name) return past ? `Edited ${name}` : `Editing ${name}`;
      return past ? "Edited file" : "Editing file";
    }
    case "bash": {
      const cmd = fieldFrom(toolInput, "command");
      if (cmd) {
        const head = clip(cmd.split(/\s+/)[0] ?? cmd, 24);
        return past ? `Ran ${head}` : `Running ${head}`;
      }
      return past ? "Ran command" : "Running command";
    }
    case "grep": {
      const pattern = fieldFrom(toolInput, "pattern") ?? fieldFrom(toolInput, "query");
      if (pattern) {
        return past
          ? `Searched "${clip(pattern, 28)}"`
          : `Searching "${clip(pattern, 28)}"`;
      }
      return past ? "Searched files" : "Searching files";
    }
    case "webfetch": {
      const url = fieldFrom(toolInput, "url");
      if (url) {
        try {
          const host = new URL(url).hostname;
          return past
            ? `Fetched ${clip(host, 28)}`
            : `Fetching ${clip(host, 28)}`;
        } catch {}
      }
      return past ? "Fetched web" : "Searching web";
    }
    case "task": {
      const desc = fieldFrom(toolInput, "description") ?? fieldFrom(toolInput, "subject");
      if (desc) return past ? `Subagent done` : `Spawning ${clip(desc, 28)}`;
      return past ? "Subagent done" : "Spawning subagent";
    }
    default: {
      const name = clip(toolName, 28);
      return past ? `Called ${name}` : `Calling ${name}`;
    }
  }
}

/** Companion bubbles for the "super XiaoAi"-style companionship layer. */
export function companionBubble(
  kind:
    | "approval"
    | "question"
    | "task-done"
    | "rest-reminder"
    | "error-comfort"
    | "idle",
  detail?: string,
): string {
  switch (kind) {
    case "approval":
      return detail ? `需要你确认：${clip(detail, 32)}` : "需要你确认一下";
    case "question":
      return "有个问题想问你";
    case "task-done":
      return "这一轮完成啦 🎉";
    case "rest-reminder":
      return "忙了很久了，休息一下眼睛吧";
    case "error-comfort":
      return "别灰心，我再试试";
    case "idle":
      return "我在这里陪你";
  }
}
