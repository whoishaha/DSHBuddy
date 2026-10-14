/**
 * ProfileEngine — 用户画像（user-type portrait based on habits）。
 *
 * Aggregates structured habit data (tool usage, error/recovery rates,
 * approvals/questions, intensity, career direction, pomodoro/notes/calendar
 * usage) and asks the LLM to classify the USER into one of the predefined
 * work-style types (or a custom one), with traits / strengths / growth tips.
 *
 * The portrait is always regenerated from real aggregate data — never from
 * prompt/code/output text. When the LLM is unavailable a rule-based classifier
 * produces the same shape, so the portrait works offline.
 *
 * Persists to ~/.petdex/runtime/profile.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";
import { CAREER_LABELS, type Career, type CareerData } from "./career.js";
import type { LlmAsk } from "./memory.js";

export type UserProfile = {
  userType: string;
  typeLabel: string;
  summary: string;
  traits: string[];
  strengths: string[];
  growthTips: string[];
  habits: {
    topTools: [string, number][];
    totalTurns: number;
    totalTools: number;
    errorRate: number; // 0..1
    recoveryRate: number; // 0..1
    approvals: number;
    questions: number;
    subagents: number;
    avgIntensity: number;
    career: Career | null;
  };
  source: "llm" | "rule";
  updatedAt: number;
};

export const USER_TYPES: Record<string, { label: string; en: string; desc: string }> = {
  "fast-mover": { label: "高效交付型", en: "Fast Mover", desc: "行动力强、迭代快，习惯快速完成任务并交付。" },
  "deep-researcher": { label: "深度研究型", en: "Deep Researcher", desc: "先调研、后动手，注重依据与细节。" },
  architect: { label: "架构规划型", en: "Architect", desc: "习惯先规划、拆解任务，再逐步实现。" },
  orchestrator: { label: "调度协作型", en: "Orchestrator", desc: "善于拆分工作流，并行调度子任务与工具。" },
  debugger: { label: "调试攻坚型", en: "Problem Solver", desc: "直面错误，擅长定位、修复与排障。" },
  reviewer: { label: "审慎决策型", en: "Gatekeeper", desc: "做事谨慎，重视确认、审批与风险控制。" },
  explorer: { label: "全栈探索型", en: "Explorer", desc: "涉猎广泛，能力均衡，敢于尝试新工具。" },
};

const PROFILE_PATH = join(RUNTIME_DIR, "profile.json");

/** Habits aggregated from growth + stats + career (+ notes/calendar counts). */
export type HabitFacts = {
  topTools: [string, number][];
  totalTurns: number;
  totalTools: number;
  errors: number;
  recovered: number;
  approvals: number;
  questions: number;
  subagents: number;
  intensitySum: number;
  intensityDays: number;
  career: Career | null;
  tasksCompleted: number;
  streakDays: number;
  notesCount: number;
  calendarCount: number;
  chatCount: number;
};

export class ProfileEngine {
  private data: UserProfile | null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): UserProfile | null {
    try {
      if (existsSync(PROFILE_PATH)) {
        const raw = JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as UserProfile;
        if (raw && typeof raw === "object" && raw.userType) return raw;
      }
    } catch {
      // corrupt file: start fresh
    }
    return null;
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        mkdirSync(RUNTIME_DIR, { recursive: true });
        writeFileSync(PROFILE_PATH, JSON.stringify(this.data));
      } catch {
        // best-effort
      }
    }, 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.saveTimer = timer;
  }

  getProfile(): UserProfile | null {
    return this.data;
  }

  clear() {
    this.data = null;
    this.dirty = true;
    this.scheduleSave();
  }

  /** Rule-based fallback classification (offline portrait). */
  private rulePortrait(facts: HabitFacts, careerData: CareerData): UserProfile {
    let type = "explorer";
    if (facts.subagents >= 5) type = "orchestrator";
    else if (facts.career === "architect") type = "architect";
    else if (facts.career === "researcher") type = "deep-researcher";
    else if (facts.career === "reviewer") type = "reviewer";
    else if (facts.career === "debugger") type = "debugger";
    else if (facts.career === "builder" && facts.totalTurns >= 10) type = "fast-mover";
    const meta = USER_TYPES[type] ?? USER_TYPES.explorer;
    const tools = facts.topTools.slice(0, 5).map(([n, c]) => `${n}(${c})`).join("、") || "—";
    const days = Math.max(1, facts.intensityDays);
    const recoveryRate = facts.errors > 0 ? Math.min(1, facts.recovered / facts.errors) : 1;
    const errorRate = facts.totalTools > 0 ? Math.min(1, facts.errors / facts.totalTools) : 0;
    const avgIntensity = Math.round(facts.intensitySum / days);
    return {
      userType: type,
      typeLabel: meta.label,
      summary: `${meta.desc} 近一周完成 ${facts.tasksCompleted} 个任务，主要工具：${tools}。`,
      traits: [
        `日均工具调用约 ${Math.round(facts.totalTools / days)} 次`,
        `错误恢复率 ${Math.round(recoveryRate * 100)}%`,
        `工作强度均值 ${avgIntensity}`,
      ],
      strengths: [meta.desc],
      growthTips: ["保持节奏，适时总结与复盘。"],
      habits: {
        topTools: facts.topTools.slice(0, 6),
        totalTurns: facts.totalTurns,
        totalTools: facts.totalTools,
        errorRate,
        recoveryRate,
        approvals: facts.approvals,
        questions: facts.questions,
        subagents: facts.subagents,
        avgIntensity,
        career: facts.career,
      },
      source: "rule",
      updatedAt: Date.now(),
    };
  }

  /**
   * (Re)generate the user portrait. LLM-preferred; rule fallback. Returns the
   * new profile (or null when there isn't enough data yet).
   */
  async regenerate(
    facts: HabitFacts,
    careerData: CareerData,
    llmAsk: LlmAsk | null,
    llmEnabled: boolean,
  ): Promise<UserProfile | null> {
    if (facts.totalTools < 3) return this.data; // not enough signal yet
    const errorRate = facts.totalTools > 0 ? Math.min(1, facts.errors / facts.totalTools) : 0;
    const recoveryRate = facts.errors > 0 ? Math.min(1, facts.recovered / facts.errors) : 1;
    const avgIntensity = Math.round(facts.intensitySum / Math.max(1, facts.intensityDays));
    const career = facts.career ? CAREER_LABELS[facts.career] : "综合";
    const tools = facts.topTools.slice(0, 8).map(([n, c]) => `${n}×${c}`).join("、") || "—";
    const typeList = Object.entries(USER_TYPES)
      .map(([id, m]) => `- ${id}（${m.label}/${m.en}）：${m.desc}`)
      .join("\n");

    const prompt =
      `请根据用户的真实工作习惯统计数据，判断用户属于哪种工作风格类型（可从下面候选中选择，也可以给出更贴切的自定义类型），` +
      `并用 JSON 输出用户画像。只输出 JSON，不要 markdown 代码块，不要其他内容。\n\n` +
      `候选类型：\n${typeList}\n\n` +
      `真实工作习惯数据（近一周为主）：\n` +
      `- 任务完成：${facts.tasksCompleted} 个；连续使用 ${facts.streakDays} 天\n` +
      `- 总轮次 ${facts.totalTurns}、总工具调用 ${facts.totalTools}（常用：${tools}）\n` +
      `- 错误 ${facts.errors} 次，恢复 ${facts.recovered} 次（恢复率 ${Math.round(recoveryRate * 100)}%）\n` +
      `- 审批 ${facts.approvals} 次、提问 ${facts.questions} 次、子代理/工作流 ${facts.subagents} 次\n` +
      `- 日均工作强度约 ${avgIntensity}（近 ${facts.intensityDays} 天）\n` +
      `- 主导职业方向：${career}\n` +
      `- 其它使用：待办 ${facts.notesCount} 条、日历 ${facts.calendarCount} 条、聊天 ${facts.chatCount} 条\n\n` +
      `JSON 格式：\n` +
      `{"userType":"类型id","typeLabel":"中文类型名","summary":"一段中文总结（2-3句）","traits":["习惯特征1","..."],"strengths":["优点1","..."],"growthTips":["成长建议1","..."]}`;

    if (llmEnabled && llmAsk) {
      const reply = await llmAsk(prompt, { maxLength: 1200 });
      const parsed = parseProfileJson(reply);
      if (parsed) {
        const profile: UserProfile = {
          ...parsed,
          habits: {
            topTools: facts.topTools.slice(0, 6),
            totalTurns: facts.totalTurns,
            totalTools: facts.totalTools,
            errorRate,
            recoveryRate,
            approvals: facts.approvals,
            questions: facts.questions,
            subagents: facts.subagents,
            avgIntensity,
            career: facts.career,
          },
          source: "llm",
          updatedAt: Date.now(),
        };
        this.data = profile;
        this.scheduleSave();
        return profile;
      }
    }
    const profile = this.rulePortrait(facts, careerData);
    this.data = profile;
    this.scheduleSave();
    return profile;
  }
}

function parseProfileJson(reply: string | null): Omit<UserProfile, "habits" | "source" | "updatedAt"> | null {
  if (!reply) return null;
  let text = reply.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      userType?: unknown;
      typeLabel?: unknown;
      summary?: unknown;
      traits?: unknown;
      strengths?: unknown;
      growthTips?: unknown;
    };
    if (typeof obj.userType !== "string" || !obj.userType) return null;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
    return {
      userType: obj.userType,
      typeLabel: typeof obj.typeLabel === "string" && obj.typeLabel ? obj.typeLabel : USER_TYPES[obj.userType]?.label ?? obj.userType,
      summary: typeof obj.summary === "string" ? obj.summary.slice(0, 400) : "",
      traits: arr(obj.traits),
      strengths: arr(obj.strengths),
      growthTips: arr(obj.growthTips),
    };
  } catch {
    return null;
  }
}
