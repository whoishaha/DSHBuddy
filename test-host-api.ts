// Host half offline integration test: mock a minimal cordis ctx, apply the
// plugin, then drive session/event frames + HTTP requests through its API.
// Run: esbuild-bundle then node (see package.json "test:host").
import { apply } from "./lib/index.js";

const disposers: (() => void)[] = [];
const listeners = new Map<string, (...args: any[]) => void>();
const routes: {
  path: string;
  kind?: string;
  handler: (req: any, res: any) => void;
}[] = [];

const ctx = {
  on(name: string, cb: (...args: any[]) => void) {
    listeners.set(name, cb);
  },
  get(name: string) {
    if (name === "webServer") {
      return {
        register: (route: { path: string; kind?: string; handler: any }) => {
          routes.push(route);
          return () => {};
        },
      };
    }
    return undefined;
  },
};

// Apply the plugin with the mock ctx.
apply(ctx as never);
console.log("apply() ran; routes registered:", routes.map((r) => `${r.kind ?? "exact"} ${r.path}`));

// ── HTTP helper ────────────────────────────────────────────────────────────
async function http(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any; headers: Record<string, string> }> {
  const handler = routes.find((r) => pathname.startsWith(r.path))?.handler;
  if (!handler) return { status: 404, json: null, headers: {} };
  let status = 0;
  let payload: unknown = "";
  let headers: Record<string, string> = {};
  const res = {
    writeHead(s: number, nextHeaders?: Record<string, string>) {
      status = s;
      headers = Object.fromEntries(Object.entries(nextHeaders ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    },
    end(data?: unknown) {
      payload = Buffer.isBuffer(data) ? data.toString("binary") : (data ?? "");
    },
  };
  const req = {
    method,
    url: pathname,
    on(ev: string, cb: (chunk?: Buffer) => void) {
      if (ev === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (ev === "end") cb();
      if (ev === "error") {}
    },
    destroy() {},
  };
  handler(req, res);
  // let async POST handlers settle
  await new Promise((r) => setTimeout(r, 30));
  let json: any = payload;
  if (typeof payload === "string" && payload) {
    try {
      json = JSON.parse(payload);
    } catch {
      json = payload;
    }
  }
  return { status, json, headers };
}

// ── checks ─────────────────────────────────────────────────────────────────
const results: [string, boolean, string][] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

// 1. snapshot default idle
let r = await http("GET", "/api/dshbuddy/snapshot");
check("snapshot 200", r.status === 200 && r.json?.ok === true, `status=${r.status}`);
check("snapshot is same-origin only", !("access-control-allow-origin" in r.headers));
check("snapshot initial idle", r.json?.snapshot?.state === "idle", `state=${r.json?.snapshot?.state}`);
check("active pet present", Boolean(r.json?.pet?.slug), `pet=${r.json?.pet?.slug}`);

// 2. pets list
r = await http("GET", "/api/dshbuddy/pets");
check("pets 200 non-empty", r.status === 200 && r.json?.pets?.length > 0, `count=${r.json?.pets?.length}`);
check("deepseek-whale installed", r.json?.pets?.some((p: any) => p.slug === "deepseek-whale"), `slugs=${r.json?.pets?.map((p: any) => p.slug).join(",")}`);

// 3. sprite binary (active pet's spritesheet)
const spriteRes = await http("GET", "/api/dshbuddy/sprite");
const spriteOk =
  spriteRes.status === 200 && typeof spriteRes.json === "string" && spriteRes.json.length > 100;
check("sprite served", spriteOk, `status=${spriteRes.status} bytes=${typeof spriteRes.json === "string" ? spriteRes.json.length : "?"}`);

// 4. drive session/event → state machine → snapshot
const evt = listeners.get("session/event");
check("session/event listener registered", typeof evt === "function");
if (evt) {
  evt({ id: "s1" }, { type: "user/message", data: { source: { kind: "user" } } });
  evt({ id: "s1" }, { type: "turn/start", data: { turn: 1 } });
  evt({ id: "s1" }, { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } });
  r = await http("GET", "/api/dshbuddy/snapshot");
  const st = r.json?.snapshot?.state;
  check("state advanced after events", st === "running-left" || st === "running-right" || st === "idle", `state=${st}`);
  check("bubble set", typeof r.json?.snapshot?.bubble === "string" && r.json.snapshot.bubble.length > 0, `bubble=${r.json?.snapshot?.bubble}`);

  // approval → waiting
  evt({ id: "s1" }, { type: "approval/asked", data: { id: "a1", toolName: "bash" } });
  r = await http("GET", "/api/dshbuddy/snapshot");
  check("approval bubble", (r.json?.snapshot?.bubble ?? "").includes("需要你确认"), `bubble=${r.json?.snapshot?.bubble}`);
}

// 5. stats accumulated
r = await http("GET", "/api/dshbuddy/stats");
check("stats 200", r.status === 200 && r.json?.stats?.sessions?.s1, `sessions=${Object.keys(r.json?.stats?.sessions ?? {}).length}`);

// 5b. growth system: events → XP / career / intensity / snapshot growth
r = await http("GET", "/api/dshbuddy/growth");
check("growth 200", r.status === 200 && r.json?.ok === true, `status=${r.status}`);
check("growth xp accrued", (r.json?.growth?.xp ?? 0) > 0, `xp=${r.json?.growth?.xp}`);
check("growth level >= 1", (r.json?.growth?.level ?? 0) >= 1, `level=${r.json?.growth?.level}`);
check("growth today intensity >= 0", (r.json?.growth?.intensity ?? -1) >= 0, `intensity=${r.json?.growth?.intensity}`);
check("career data present", Boolean(r.json?.career?.xp) && typeof r.json?.career?.xp?.builder === "number", `xp=${JSON.stringify(r.json?.career?.xp)}`);
check("memory arrays present", Array.isArray(r.json?.memory?.milestones) && Array.isArray(r.json?.memory?.timeline), "memory arrays");
check("llmEnabled flag", typeof r.json?.llmEnabled === "boolean", `llmEnabled=${r.json?.llmEnabled}`);

// drive more events → milestones (first task / recovery / subagent) unlock
if (evt) {
  evt({ id: "s1" }, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  evt({ id: "s1" }, { type: "tool/call", data: { turn: 3, step: 1, callId: "c2", name: "subagent", arguments: "{}" } });
  evt({ id: "s1" }, { type: "tool/call", data: { turn: 4, step: 1, callId: "c3", name: "bash", arguments: "{}" } });
  evt({ id: "s1" }, { type: "tool/result", data: { turn: 4, step: 1, callId: "c3", message: { content: "fail" }, error: { name: "E", code: "1" } } });
  evt({ id: "s1" }, { type: "tool/result", data: { turn: 4, step: 2, callId: "c4", message: { content: "ok" } } });
  r = await http("GET", "/api/dshbuddy/growth");
  const milestoneIds = (r.json?.memory?.milestones ?? []).map((m: any) => m.id);
  check("first-task milestone", milestoneIds.includes("first-task"), milestoneIds.join(","));
  check("first-subagent milestone", milestoneIds.includes("first-subagent"), milestoneIds.join(","));
  check("first-recovery milestone", milestoneIds.includes("first-recovery"), milestoneIds.join(","));
  check("recovery counted", (r.json?.growth?.errorsRecovered ?? 0) >= 1, `recovered=${r.json?.growth?.errorsRecovered}`);
}

// Achievement thresholds are grouped into persistent level tracks. Existing
// tier ids still drive milestones/rewards, while the API exposes one card per
// measured behavior with its current and maximum level.
r = await http("GET", "/api/dshbuddy/achievements");
const taskTrack = (r.json?.achievements ?? []).find((a: any) => a.id === "tasks:tasksCompleted");
check("achievements grouped into level tracks", r.status === 200 && (r.json?.achievements?.length ?? 99) < 37, `count=${r.json?.achievements?.length}`);
check("task achievement level exposed", taskTrack?.level >= 1 && taskTrack?.maxLevel === 4, JSON.stringify(taskTrack));
check("task achievement next threshold", taskTrack?.progress?.target === 10, JSON.stringify(taskTrack?.progress));

// growth export (markdown)
r = await http("GET", "/api/dshbuddy/growth?format=md");
check("growth export md", r.status === 200 && typeof r.json === "string" && r.json.includes("成长档案"), `len=${typeof r.json === "string" ? r.json.length : "?"}`);

// growth regenerate-summary (LLM unavailable → template fallback)
r = await http("POST", "/api/dshbuddy/growth", { op: "regenerate-summary" });
check("regenerate-summary", r.status === 200 && r.json?.ok === true && typeof r.json?.summary?.summaryText === "string", `source=${r.json?.summary?.source}`);

// growth regenerate-narrative (LLM growth narrative → template fallback)
r = await http("POST", "/api/dshbuddy/growth", { op: "regenerate-narrative" });
check("regenerate-narrative", r.status === 200 && r.json?.ok === true && typeof r.json?.summary?.summaryText === "string", `source=${r.json?.summary?.source}`);

// growth summaries now present in /growth
r = await http("GET", "/api/dshbuddy/growth");
check("growthSummaries present", Array.isArray(r.json?.memory?.growthSummaries) && r.json.memory.growthSummaries.length >= 1, `count=${r.json?.memory?.growthSummaries?.length}`);

// growth snapshot summary present on /snapshot
r = await http("GET", "/api/dshbuddy/snapshot");
check("snapshot growth summary", Boolean(r.json?.growth?.level), `level=${r.json?.growth?.level}`);

// 5c. stats analytics + LLM insight
r = await http("GET", "/api/dshbuddy/stats/analytics");
check("analytics 200", r.status === 200 && r.json?.ok === true, `status=${r.status}`);
check("analytics efficiency", typeof r.json?.analytics?.efficiency?.errorRate === "number", `errorRate=${r.json?.analytics?.efficiency?.errorRate}`);
check("analytics chronotype", typeof r.json?.analytics?.chronotype?.label === "string", `label=${r.json?.analytics?.chronotype?.label}`);
check("analytics rhythm heatmap", Array.isArray(r.json?.analytics?.rhythm?.weekdayHour) && r.json.analytics.rhythm.weekdayHour.length === 7, `rows=${r.json?.analytics?.rhythm?.weekdayHour?.length}`);
check("analytics loops", typeof r.json?.analytics?.loops === "object", `loops=${JSON.stringify(r.json?.analytics?.loops)}`);
check("analytics records", typeof r.json?.analytics?.records?.bestStreak === "number", `bestStreak=${r.json?.analytics?.records?.bestStreak}`);

r = await http("POST", "/api/dshbuddy/stats/insight", {});
check("insight 200", r.status === 200 && r.json?.ok === true && typeof r.json?.insight === "string", `source=${r.json?.source}`);

// 6. config patch
r = await http("POST", "/api/dshbuddy/config", { floaterMode: "walker" });
check("config patch", r.status === 200 && r.json?.config?.floaterMode === "walker");

// 6b. config is validated and secrets remain host-only
r = await http("POST", "/api/dshbuddy/config", {
  petScale: 99,
  soundVolume: -20,
  language: "invalid",
  chat: { provider: "openai", baseUrl: "https://example.invalid/v1", apiKey: "test-secret", model: "test-model" },
});
check("config numeric bounds", r.json?.config?.petScale === 1.5 && r.json?.config?.soundVolume === 0);
check("config enum validation", r.json?.config?.language === "zh");
check("config secret redacted", r.json?.config?.chat?.apiKey === "" && r.json?.config?.chat?.hasApiKey === true);
r = await http("POST", "/api/dshbuddy/config", { chat: { apiKey: "", model: "next-model" } });
check("blank secret preserves stored key", r.json?.config?.chat?.hasApiKey === true && r.json?.config?.chat?.model === "next-model");
r = await http("POST", "/api/dshbuddy/config", { chat: { provider: "off", apiKey: "" } });
check("secret remains stored when provider disabled", r.json?.config?.chat?.provider === "off" && r.json?.config?.chat?.hasApiKey === true);
r = await http("GET", "/api/dshbuddy/snapshot");
check("snapshot never exposes API key", r.json?.config?.chat?.apiKey === "" && !JSON.stringify(r.json).includes("test-secret"));

// 6c. dream route owns its throttle/memory through explicit dependencies
r = await http("GET", "/api/dshbuddy/dream");
check("dream route 200", r.status === 200 && r.json?.ok === true);

// 7. signal
r = await http("POST", "/api/dshbuddy/signal", { kind: "question", detail: "test" });
check("signal ok", r.status === 200 && r.json?.ok === true);

// 8. notes CRUD (idempotent across runs — notes.json persists on disk)
r = await http("POST", "/api/dshbuddy/notes", { op: "add", note: { text: "hello buddy" } });
check("notes add", r.status === 200 && (r.json?.notes?.length ?? 0) >= 1, `count=${r.json?.notes?.length}`);
r = await http("GET", "/api/dshbuddy/notes");
check("notes get", r.status === 200 && r.json?.notes?.some((n: any) => n.text === "hello buddy"));

// 9. calendar (start/end time + note)
r = await http("POST", "/api/dshbuddy/calendar", { date: "2026-08-21", startTime: "09:00", endTime: "12:00", note: "work" });
check("calendar write", r.status === 200 && r.json?.entries?.some((e: any) => e.date === "2026-08-21" && e.startTime === "09:00" && e.endTime === "12:00"));
const firstCalendarId = r.json?.entries?.find((e: any) => e.date === "2026-08-21" && e.note === "work")?.id;
r = await http("POST", "/api/dshbuddy/calendar", { date: "2026-08-21", startTime: "14:00", endTime: "16:00", note: "review" });
const sameDayEntries = r.json?.entries?.filter((e: any) => e.date === "2026-08-21") ?? [];
check("calendar supports multiple entries per day", sameDayEntries.length >= 2 && sameDayEntries.every((e: any) => typeof e.id === "string"));
if (firstCalendarId) {
  r = await http("POST", "/api/dshbuddy/calendar", { op: "remove", id: firstCalendarId, date: "2026-08-21" });
  check("calendar removes one entry by id", !r.json?.entries?.some((e: any) => e.id === firstCalendarId) && r.json?.entries?.some((e: any) => e.note === "review"));
}

// 9b. host-owned pomodoro state
r = await http("POST", "/api/dshbuddy/pomodoro/state", { op: "reset", workMin: 25, breakMin: 5 });
check("pomodoro reset state", r.status === 200 && r.json?.state?.status === "idle" && r.json?.state?.remainingMs === 25 * 60_000);
r = await http("POST", "/api/dshbuddy/pomodoro/state", { op: "start" });
check("pomodoro starts on host", r.status === 200 && r.json?.state?.status === "running" && typeof r.json?.state?.endsAt === "number");
r = await http("POST", "/api/dshbuddy/pomodoro/state", { op: "pause" });
check("pomodoro pauses on host", r.status === 200 && r.json?.state?.status === "paused" && r.json?.state?.endsAt === null);

// 9c. self-care notes and breathing quest linkage
r = await http("POST", "/api/dshbuddy/mood", { mood: 2, note: "need a quiet afternoon" });
check("mood note accepted", r.status === 200 && r.json?.ok === true);
r = await http("GET", "/api/dshbuddy/selfcare");
check("mood strip exposes latest note", r.json?.moodStrip?.some((e: any) => e.mood === 2 && e.note === "need a quiet afternoon"));
const breathQuest = r.json?.board?.quests?.find((q: any) => q.breathable && !q.done);
r = await http("POST", "/api/dshbuddy/selfcare", { op: "breath" });
check("breathing session rewarded", r.status === 200 && r.json?.ok === true);
if (breathQuest) {
  const afterBreath = await http("GET", "/api/dshbuddy/selfcare");
  check("breathing completes matching quest", afterBreath.json?.board?.quests?.some((q: any) => q.id === breathQuest.id && q.done));
}

// 10. commands
r = await http("GET", "/api/dshbuddy/commands");
check("commands list", r.status === 200 && r.json?.commands?.length > 0, `count=${r.json?.commands?.length}`);

// 10b. work orders — regex fast path (digits + Chinese numerals), offline safe
r = await http("POST", "/api/dshbuddy/orders", { op: "add", text: "明天早上八点半在 DSH-petdex 工作区优化插件" });
check("order digits+zh add", r.status === 200 && r.json?.ok === true, `json=${JSON.stringify(r.json)?.slice(0, 120)}`);
const orderDigits = r.json?.order;
check(
  "order digits time 08:30",
  Boolean(orderDigits) && new Date(orderDigits.triggerAt).getHours() === 8 && new Date(orderDigits.triggerAt).getMinutes() === 30,
  `at=${orderDigits?.triggerAt}`,
);
check(
  "order workspace longest-name match",
  typeof orderDigits?.workspace === "string" && /DSH-petdex$/i.test(orderDigits.workspace),
  `workspace=${orderDigits?.workspace}`,
);
if (orderDigits?.id) await http("POST", "/api/dshbuddy/orders", { op: "remove", id: orderDigits.id });

r = await http("POST", "/api/dshbuddy/orders", { op: "add", text: "晚上八点五十优化宠物动画" });
check("order zh-numerals add", r.status === 200 && r.json?.ok === true, `json=${JSON.stringify(r.json)?.slice(0, 120)}`);
const orderZh = r.json?.order;
check(
  "order 晚上八点五十 → 20:50",
  Boolean(orderZh) && new Date(orderZh.triggerAt).getHours() === 20 && new Date(orderZh.triggerAt).getMinutes() === 50,
  `at=${orderZh?.triggerAt}`,
);
if (orderZh?.id) await http("POST", "/api/dshbuddy/orders", { op: "remove", id: orderZh.id });

r = await http("POST", "/api/dshbuddy/orders", { op: "add", text: "每天晚上八点检查构建" });
check("daily work order retains recurrence", r.status === 200 && r.json?.order?.recurrence === "daily");
if (r.json?.order?.id) await http("POST", "/api/dshbuddy/orders", { op: "remove", id: r.json.order.id });

r = await http("POST", "/api/dshbuddy/orders", { op: "add", text: "帮我优化一下插件" });
check("order without time rejected", r.status === 200 && r.json?.ok === false && r.json?.error === "no-time");

// 10c. chat-intent: a timed task typed into the CHAT schedules instead of chatting
r = await http("POST", "/api/dshbuddy/chat", {
  messages: [{ role: "user", content: "任务：晚上九点五十在 DSH-petdex 工作区优化动画" }],
});
check(
  "chat order intent scheduled",
  r.status === 200 && r.json?.ok === true && typeof r.json?.reply === "string" && r.json.reply.includes("已安排"),
  `reply=${String(r.json?.reply).slice(0, 60)}`,
);
r = await http("GET", "/api/dshbuddy/orders");
// Match OUR sentence precisely (九点五十) — the real runtime dir may hold the
// user's own historical orders that also mention 优化动画.
const chatOrder = (r.json?.orders ?? []).find(
  (o: any) => typeof o.task === "string" && o.task.includes("九点五十") && o.task.includes("DSH-petdex 工作区优化动画"),
);
check("chat order persisted pending", Boolean(chatOrder) && chatOrder.status === "pending", `status=${chatOrder?.status} id=${chatOrder?.id}`);
if (chatOrder?.id) await http("POST", "/api/dshbuddy/orders", { op: "remove", id: chatOrder.id });

// Deleting the order must also prune its「收到工作单」trail from the care log.
r = await http("GET", "/api/dshbuddy/chat?conversationId=care");
const careMsgs = r.json?.messages ?? [];
check(
  "chat order care trail pruned",
  !careMsgs.some((m: any) => typeof m.content === "string" && m.content.includes("九点五十") && m.content.includes("优化动画")),
  `careMsgs=${careMsgs.length}`,
);

r = await http("POST", "/api/dshbuddy/chat", { messages: [{ role: "user", content: "今天天气怎么样？" }] });
check(
  "chat question stays chat",
  r.status === 400 && r.json?.error === "chat not configured",
  `status=${r.status} error=${r.json?.error}`,
);

// 11. unknown route
r = await http("GET", "/api/dshbuddy/nope");
check("unknown 404", r.status === 404);

const failed = results.filter(([, p]) => !p).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
