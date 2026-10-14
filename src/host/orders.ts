/**
 * orders — the JingLing (鲸灵) work-order scheduler.
 *
 * The user tells the pet things like "晚上八点五十在 petdex 工作区优化 DSHBuddy
 * 插件" and the host schedules a headless DeepSeek Harness run:
 *
 *   dsh --profile headless <task>    (cwd = workspace)
 *
 * Extraction is two-stage:
 *   1. dependency-free regex (digits + common Chinese-numeral phrases) —
 *      instant and works fully offline;
 *   2. when the regex finds nothing, ask the LLM once to pull the absolute
 *      trigger time + clean task text out of the sentence (JSON contract),
 *      so natural phrasing like「晚上八点五十」still schedules.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RUNTIME_DIR } from "./paths.js";
import type { LlmAsk } from "./memory.js";

export type OrderStatus = "pending" | "running" | "done" | "failed" | "canceled";

export type WorkOrder = {
  id: string;
  text: string;
  task: string;
  triggerAt: number;
  workspace?: string;
  status: OrderStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  recurrence?: "daily";
};

export type ParsedOrder = {
  triggerAt: number;
  timeText: string;
  workspace?: string;
  task: string;
  recurrence?: "daily";
};

const MAX_ORDERS = 50;

function runtimeDir(): string {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
  return RUNTIME_DIR;
}

function ordersPath(): string {
  return join(runtimeDir(), "orders.json");
}

function readOrders(): WorkOrder[] {
  try {
    const raw = JSON.parse(readFileSync(ordersPath(), "utf8")) as WorkOrder[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeOrders(list: WorkOrder[]): void {
  writeFileSync(ordersPath(), JSON.stringify(list.slice(-MAX_ORDERS), null, 2), "utf8");
}

/** Resolve a captured workspace mention to a concrete directory. */
function matchWorkspace(captured: string): string | undefined {
  const value = captured.trim().replace(/^["']|["']$/g, "");
  const lower = value.toLowerCase();
  if (!lower) return undefined;
  if (isAbsolute(value) && existsSync(value)) return resolve(value);
  const cwd = process.cwd();
  const cwdName = basename(cwd).toLowerCase();
  if (lower.includes(cwdName) || cwdName.includes(lower)) return cwd;
  return [resolve(dirname(cwd), value), resolve(cwd, value), resolve(value)]
    .find((candidate) => existsSync(candidate));
}

/** Chinese numeral → number for hour/minute phrases (十/十五/二十/四十五…). */
function zhToInt(s: string): number | null {
  const D: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[0-9]{1,2}$/.test(s)) return Number(s);
  const ti = s.indexOf("十");
  if (ti >= 0) {
    const tens = ti === 0 ? 1 : D[s.slice(0, ti)];
    const rest = s.slice(ti + 1);
    const ones = rest ? D[rest] : 0;
    if (tens === undefined || ones === undefined || rest.length > 1) return null;
    return tens * 10 + ones;
  }
  return s.length === 1 && D[s] !== undefined ? D[s] : null;
}

/** Apply period (下午/晚上…) + day word (明天…) to a raw hour and anchor it to the next occurrence. */
function resolveTime(
  now: number,
  rawHour: number,
  minute: number,
  period: string,
  day: string,
): { at: number; label: string } | null {
  let hour = rawHour;
  if (/下午|傍晚|晚上|夜里/.test(period) && hour < 12) hour += 12;
  if (/中午/.test(period) && hour < 11) hour += 12;
  if (/凌晨/.test(period) && hour >= 12) hour -= 12;
  if (!period && hour > 12) hour = hour; // bare "十八点" style already 24h — keep
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const nextDay = /明天|明早|后天/.test(day);
  return makeTime(now, hour, minute, nextDay || isPast(now, hour, minute));
}

/** Parse a natural-language trigger time out of the text; null when absent. */
export function parseTriggerTime(text: string, now = Date.now()): { at: number; label: string } | null {
  // digits form: 晚上八点 → "晚上8点", 明早8点半, 18点05分…
  const m =
    /(今天|今晚|明早|明天|后天|每日|每天)?\s*(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2})\s*[点时:：]\s*(半|[0-5]?\d)?\s*分?/.exec(
      text,
    );
  if (m) {
    const minute = m[4] === "半" ? 30 : m[4] ? Number(m[4]) : 0;
    return resolveTime(now, Number(m[3]), minute, m[2] ?? "", m[1] ?? "");
  }
  // bare HH:mm fallback like "18:00 开始…"
  const hm = /(\d{1,2}):([0-5]\d)/.exec(text);
  if (hm) {
    const nextDay = /明天/.test(text) || isPast(now, Number(hm[1]), Number(hm[2]));
    return makeTime(now, Number(hm[1]), Number(hm[2]), nextDay);
  }
  // Chinese numerals: 晚上八点五十 / 明早八点半 / 中午十二点…
  const zm =
    /(今天|今晚|明早|明天|后天|每日|每天)?\s*(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*([零一二两三四五六七八九十]{1,3})\s*[点时]\s*(半|[零一二两三四五六七八九十]{1,3})?\s*分?/.exec(
      text,
    );
  if (zm) {
    const hour = zhToInt(zm[3]);
    if (hour === null) return null;
    const minute = zm[4] === "半" ? 30 : zm[4] ? zhToInt(zm[4]) : 0;
    if (minute === null) return null;
    return resolveTime(now, hour, minute, zm[2] ?? "", zm[1] ?? "");
  }
  return null;
}

function isPast(now: number, hour: number, minute: number): boolean {
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  return target.getTime() <= now;
}

function makeTime(now: number, hour: number, minute: number, nextDay: boolean): { at: number; label: string } {
  const d = new Date(now);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (nextDay ? 1 : 0), hour, minute, 0, 0).getTime();
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return { at, label: `${nextDay ? "明天 " : "今天 "}${hh}:${mm}` };
}

export function parseOrder(text: string, now = Date.now()): ParsedOrder | null {
  const time = parseTriggerTime(text, now);
  if (!time) return null;
  let workspace: string | undefined;
  const wm = /在\s*([\w\u4e00-\u9fff][\w\u4e00-\u9fff\-. ]{0,30}?)\s*(?:工作区|目录|项目)/.exec(text);
  if (wm) workspace = matchWorkspace(wm[1]) ?? wm[1];
  return {
    triggerAt: time.at,
    timeText: time.label,
    workspace,
    task: text.trim(),
    ...(/每天|每日/.test(text) ? { recurrence: "daily" as const } : {}),
  };
}

/** Ask the LLM once to pull an absolute trigger time + clean task out of
 *  free-form text (handles any natural phrasing the regex misses, e.g.
 *  「晚上八点五十」「后天上午十点一刻」). Returns null when offline / timed out /
 *  no usable time — callers then keep their own error message. */
export async function extractOrderWithLlm(
  text: string,
  llmAsk: LlmAsk,
  now = Date.now(),
): Promise<ParsedOrder | null> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(now);
  const nowStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const system = [
    "You convert a one-sentence work order into schedule data.",
    'Reply with ONLY minified JSON (no markdown fence): {"found":true,"date":"YYYY-MM-DD","time":"HH:MM","task":"...","workspace":"..."}',
    "Rules:",
    "- Resolve relative day words (今天/今晚/明天/明早/后天/每天/每日…) against NOW; 每天/每日 means its NEXT occurrence.",
    "- Chinese numerals are times too: 晚上八点五十 = 20:50, 八点半 = 08:30, 十点一刻 = 10:15.",
    '- No usable trigger time → reply {"found":false}',
    "- task = the actionable instruction with the time phrase removed, same language as input.",
    "- workspace = a folder/workspace name only if explicitly mentioned, else empty string.",
    `- NOW = ${nowStr}`,
  ].join("\n");

  const TIMEOUT_MS = 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reply: string | null = null;
  try {
    reply = await Promise.race([
      llmAsk(text, { system, maxLength: 400 }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      }),
    ]);
  } catch {
    reply = null;
  } finally {
    clearTimeout(timer);
  }
  if (!reply) return null;

  const jsonSlice = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  try {
    const j = JSON.parse(jsonSlice) as { found?: boolean; date?: string; time?: string; task?: string; workspace?: string };
    if (!j.found || !j.date || !j.time) return null;
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(j.date.trim());
    const tm = /^(\d{1,2}):(\d{2})$/.exec(j.time.trim());
    if (!dm || !tm) return null;
    const at = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), 0, 0).getTime();
    if (!Number.isFinite(at)) return null;
    // A past moment is useless for scheduling — treat like "not found".
    if (at <= now - 60_000) return null;

    const t0 = new Date(at);
    const today = new Date(now);
    const dayDiff = Math.round(
      (new Date(t0.getFullYear(), t0.getMonth(), t0.getDate()).getTime() -
        new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000,
    );
    const dayLabel = dayDiff === 0 ? "今天" : dayDiff === 1 ? "明天" : `${t0.getMonth() + 1}/${t0.getDate()}`;
    const label = `${dayLabel} ${pad(t0.getHours())}:${pad(t0.getMinutes())}`;
    const wsName = j.workspace?.trim();
    return {
      triggerAt: at,
      timeText: label,
      workspace: wsName ? (matchWorkspace(wsName) ?? wsName) : undefined,
      task: j.task?.trim() || text.trim(),
      ...(/每天|每日/.test(text) ? { recurrence: "daily" as const } : {}),
    };
  } catch {
    return null;
  }
}

/** Explicit order phrasing: 「任务：…」「工作单…」「提醒我…」at line start. */
const ORDER_HINT_RE = /(^|\n)\s*(任务|工作单|安排(?:个|一下)?(?:任务|工作)?|定时|提醒我|到点了?|到时候)[:：，,!\s]/;
/** Action verbs that make a sentence an instruction rather than small talk. */
const ACTION_VERB_RE =
  /(优化|执行|处理|完成|修复|修好|修改|添加|增加|删除|清理|重构|美化|部署|发布|提交|检查|审查|测试|运行|启动|关闭|停止|备份|还原|同步|合并|抓取|爬取|生成|编写|写一?[个篇份行]|翻译|总结|归纳|搜索|下载|上传|安装|卸载|更新|升级|提醒|叫我|唤醒|optimize|execute|implement|refactor|deploy|release|commit|review|test|run|start|stop|build|clean|fix|update|upgrade|install|remind|write|create|add|remove|delete)/i;
/** Questions about time/facts must stay in chat, never become orders. */
const QUESTION_TAIL_RE = /([?？]\s*)$|([吗嘛][\s!！。~]*$)|^(什么|怎么|为什[么麼]|为啥|哪|几[点号月日]|多少|是否|能不能|可不可以|要不要|啥时候|什么时候|何时|星期几|周[一二三四五六日末])/;

/**
 * Heuristic chat-intent gate: true when a message reads like a timed work
 * order — an explicit「任务：」-style hint, or a concrete trigger time combined
 * with an action verb and no question tail. Cheap and offline; the real
 * extraction still goes through parseOrder/addSmart.
 */
export function looksLikeWorkOrder(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 800) return false;
  if (QUESTION_TAIL_RE.test(t)) return false;
  if (ORDER_HINT_RE.test(t)) return true;
  return Boolean(parseTriggerTime(t)) && ACTION_VERB_RE.test(t);
}

export class OrdersEngine {
  constructor() {
    const list = readOrders();
    let dirty = false;
    for (const order of list) {
      if (order.status !== "running") continue;
      order.status = "failed";
      order.finishedAt = Date.now();
      order.error = "Host restarted before the work order completed";
      dirty = true;
    }
    if (dirty) writeOrders(list);
  }

  /** Due-order sweep; call on a short interval from apply(). */
  tick(): void {
    const list = readOrders();
    let dirty = false;
    for (const o of list) {
      if (o.status === "pending" && o.triggerAt <= Date.now()) {
        void this.launch(o);
        dirty = true;
      }
    }
    if (dirty) writeOrders(list);
  }

  add(text: string): WorkOrder | null {
    const parsed = parseOrder(text);
    if (!parsed) return null;
    return this.createFromParsed(text, parsed);
  }

  /** Two-stage parse: instant regex first; when it finds no time, one LLM
   *  extraction pass (offline-safe — silently degrades to null). */
  async addSmart(text: string, llmAsk: LlmAsk): Promise<WorkOrder | null> {
    const parsed = parseOrder(text) ?? (await extractOrderWithLlm(text, llmAsk));
    if (!parsed) return null;
    return this.createFromParsed(text, parsed);
  }

  private createFromParsed(originalText: string, parsed: ParsedOrder): WorkOrder {
    const order: WorkOrder = {
      id: `wo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      text: originalText.trim(),
      task: parsed.task,
      triggerAt: parsed.triggerAt,
      workspace: parsed.workspace,
      status: "pending",
      createdAt: Date.now(),
      recurrence: parsed.recurrence,
    };
    const list = readOrders();
    list.push(order);
    writeOrders(list);
    return order;
  }

  list(): WorkOrder[] {
    return readOrders().slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  cancel(id: string): boolean {
    const list = readOrders();
    const o = list.find((x) => x.id === id);
    if (!o || o.status !== "pending") return false;
    o.status = "canceled";
    writeOrders(list);
    return true;
  }

  retry(id: string): boolean {
    const list = readOrders();
    const order = list.find((x) => x.id === id);
    if (!order || order.status !== "failed") return false;
    order.status = "pending";
    order.triggerAt = Date.now();
    order.startedAt = undefined;
    order.finishedAt = undefined;
    order.error = undefined;
    writeOrders(list);
    return true;
  }

  remove(id: string): boolean {
    const list = readOrders();
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) return false;
    writeOrders(next);
    return true;
  }

  /** In-process launcher (set from index.ts when host services exist): creates
   *  a real web session inside the requested workspace and drives one task.
   *  When unset, launch falls back to a detached `dsh --profile headless` CLI
   *  process (works anywhere, but the session lands outside workspace groups). */
  setLauncher(fn: OrderLauncher): void {
    this.launcher = fn;
  }

  private async launch(o: WorkOrder): Promise<void> {
    // Synchronous prefix: flip status before any await so the tick's dirty
    // write captures it and due orders never fire twice.
    o.status = "running";
    o.startedAt = Date.now();
    this.onLaunch?.(o);
    if (this.launching.has(o.id)) return;
    this.launching.add(o.id);
    const launcher = this.launcher;
    if (launcher) {
      try {
        await launcher(o);
        this.launching.delete(o.id);
        this.finish(o.id, "done");
      } catch (err) {
        this.launching.delete(o.id);
        this.finish(o.id, "failed", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    this.spawnLaunch(o);
  }

  /** Legacy fallback: detached headless CLI run, cwd = resolved workspace. */
  private spawnLaunch(o: WorkOrder): void {
    try {
      const cwd = o.workspace && existsSync(o.workspace) ? o.workspace : undefined;
      const task = buildOrderPrompt(o);
      // Pass the prompt as one argv item. Avoiding a shell keeps user-authored
      // task text from being interpreted as commands or redirections.
      const child = spawn("dsh", ["--profile", "headless", task], {
        shell: false,
        detached: true,
        stdio: "ignore",
        cwd,
      });
      child.on("error", (err) => {
        this.finish(o.id, "failed", String(err));
      });
      child.on("exit", (code) => {
        this.launching.delete(o.id);
        this.finish(o.id, code === 0 ? "done" : "failed", code === 0 ? undefined : `exit ${code}`);
      });
      child.unref?.();
    } catch (err) {
      this.launching.delete(o.id);
      this.finish(o.id, "failed", String(err));
    }
  }

  private finish(id: string, status: "done" | "failed", error?: string): void {
    const list = readOrders();
    const o = list.find((x) => x.id === id);
    if (!o) return;
    o.status = status;
    o.finishedAt = Date.now();
    o.error = error;
    if (status === "done" && o.recurrence === "daily") {
      const nextAt = new Date(o.triggerAt);
      nextAt.setDate(nextAt.getDate() + 1);
      list.push({
        ...o,
        id: `wo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        triggerAt: nextAt.getTime(),
        status: "pending",
        createdAt: Date.now(),
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
      });
    }
    writeOrders(list);
    this.onFinish?.(o);
  }

  /** Hooks for bubbles/logging (wired in index.ts). */
  onLaunch?: (o: WorkOrder) => void;
  onFinish?: (o: WorkOrder) => void;
  private launcher?: OrderLauncher;
  private launching = new Set<string>();
}

export type OrderLauncher = (order: WorkOrder) => Promise<void>;

/** The prompt actually handed to the executing session: the clean task plus an
 *  explicit plan-first requirement, so the agent decomposes before acting. */
export function buildOrderPrompt(o: WorkOrder): string {
  const lines = [`任务：${o.task}`];
  if (o.workspace) lines.push(`工作区：${o.workspace}`);
  lines.push(
    "",
    "要求：先用 3-6 条要点列出简短的执行计划（做什么、按什么顺序），然后立即按计划开始执行；执行过程中简要汇报关键进展；完成后总结改动内容。",
  );
  return lines.join("\n");
}
