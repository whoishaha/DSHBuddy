/**
 * SoundFx — B1-2 host-side tiered event sounds.
 *
 * Why the HOST plays sounds: the browser half can be muted (tab muted, system
 * mixer, headset unplugged) exactly when the user has walked away — the
 * moments you most need "the agent finished / needs your approval". The host
 * process owns OS audio, which no browser mute touches.
 *
 * How: tiny WAV files are SYNTHESIZED in-process (16-bit PCM mono, sine
 * partials + exponential envelopes — zero binary assets), cached per
 * kind+volume, written once to a temp dir and handed to the platform player:
 *   Windows → PowerShell System.Media.SoundPlayer (PlaySync in a detached
 *   process, so a short chime never blocks the host loop)
 *   macOS   → afplay   ·   Linux → paplay, falling back to aplay
 *
 * Tiering (research-backed): only three meaningful events ever beep — task
 * done, needs your input, error worth noticing. Plain chat/running work is
 * silent. Per-kind cooldowns stop rapid tool failures from machine-gunning.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export type SoundKind = "task-done" | "needs-input" | "error";

type TierSpec = {
  /** Per-kind minimum gap between plays (ms). */
  cooldownMs: number;
  /** Base gain 0–1 before the user volume multiplier. */
  gain: number;
  /** Notes as [startFrac, endFrac, freqHz] segments over the total duration. */
  notes: { t0: number; t1: number; f0: number; f1?: number; gain?: number }[];
  durationSec: number;
};

const SAMPLE_RATE = 22050;

const TIERS: Record<SoundKind, TierSpec> = {
  // Warm rising major third: "it's done, come look".
  "task-done": {
    cooldownMs: 2500,
    gain: 0.5,
    durationSec: 0.42,
    notes: [
      { t0: 0.0, t1: 0.55, f0: 1046.5 }, // C6
      { t0: 0.45, t1: 1.0, f0: 1318.5 }, // E6
    ],
  },
  // Bright double ping: "I need you".
  "needs-input": {
    cooldownMs: 1500,
    gain: 0.55,
    durationSec: 0.34,
    notes: [
      { t0: 0.0, t1: 0.32, f0: 1567.98 }, // G6
      { t0: 0.38, t1: 0.72, f0: 1567.98 },
      { t0: 0.78, t1: 1.0, f0: 1975.53 }, // B6 tail
    ],
  },
  // Soft low descending pair: "hmm, that failed" — never harsh.
  error: {
    cooldownMs: 4000,
    gain: 0.45,
    durationSec: 0.36,
    notes: [
      { t0: 0.0, t1: 0.5, f0: 392.0, f1: 349.23 }, // G4→F4
      { t0: 0.52, t1: 1.0, f0: 329.63, f1: 293.66 }, // E4→D4
    ],
  },
};

/** Synthesize one kind's PCM at the given volume (0..1) into a WAV Buffer. */
function synthWav(kind: SoundKind, volume: number): Buffer {
  const spec = TIERS[kind];
  const n = Math.round(spec.durationSec * SAMPLE_RATE);
  const pcm = new Int16Array(n);
  const vol = spec.gain * Math.max(0, Math.min(1, volume));
  for (let i = 0; i < n; i++) {
    const frac = i / n;
    let sample = 0;
    for (const note of spec.notes) {
      if (frac < note.t0 || frac > note.t1) continue;
      const nf = (frac - note.t0) / Math.max(1e-6, note.t1 - note.t0);
      const freq = note.f1 ? note.f0 + (note.f1 - note.f0) * nf : note.f0;
      // Percussive envelope: fast attack, exponential decay within the note.
      const env = Math.min(1, nf * 24) * Math.exp(-3.4 * nf);
      sample += Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * env * (note.gain ?? 1);
      // Faint octave-up shimmer keeps it bell-like instead of beepy.
      sample += Math.sin(4 * Math.PI * freq * i / SAMPLE_RATE) * env * 0.18;
    }
    const v = Math.max(-1, Math.min(1, sample * vol));
    pcm[i] = Math.round(v * 32767);
  }
  return wrapWav(pcm, SAMPLE_RATE);
}

/** Wrap raw mono 16-bit PCM into a minimal RIFF/WAVE container. */
function wrapWav(pcm: Int16Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + pcm.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // channels
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits
  out.write("data", 36, "ascii");
  out.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 44 + i * 2);
  return out;
}

export class SoundFx {
  private lastPlayedAt = new Map<SoundKind, number>();
  private cache = new Map<string, Buffer>();
  private dir = join(tmpdir(), `dshbuddy-sfx-${randomUUID().slice(0, 8)}`);
  private enabled = true;
  private volume = 0.7;
  /** Settable so config changes apply without rebuilding the engine. */
  configure(opts: { enabled?: boolean; volume?: number }): void {
    if (opts.enabled !== undefined) this.enabled = Boolean(opts.enabled);
    if (opts.volume !== undefined) this.volume = Math.max(0, Math.min(1, opts.volume));
  }

  /**
   * Play one tier (fire-and-forget). Returns false when suppressed by the
   * enabled flag or the per-kind cooldown — useful for tests/debug.
   */
  play(kind: SoundKind): boolean {
    if (!this.enabled || !TIERS[kind]) return false;
    const now = Date.now();
    const last = this.lastPlayedAt.get(kind) ?? 0;
    if (now - last < TIERS[kind].cooldownMs) return false;
    this.lastPlayedAt.set(kind, now);

    try {
      const key = `${kind}@${this.volume.toFixed(2)}`;
      let wav = this.cache.get(key);
      if (!wav) {
        wav = synthWav(kind, this.volume);
        this.cache.set(key, wav);
        if (this.cache.size > 12) this.cache.clear(); // volume-slider safety valve
        mkdirSync(this.dir, { recursive: true });
      }
      const file = join(this.dir, `${kind}.wav`);
      if (!existsSync(file)) writeFileSync(file, wav);

      const cmd = pickPlayerCommand();
      if (!cmd) return false;
      const child =
        process.platform === "win32"
          ? spawn(
              "powershell",
              ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
                `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`],
              { detached: true, stdio: "ignore", windowsHide: true },
            )
          : spawn(cmd, [file], { detached: true, stdio: "ignore" });
      void child.unref?.();
      child.on?.("error", () => {
        /* no audio device / player missing — stay silent */
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** Best-effort platform player command (null = nothing we know how to drive). */
function pickPlayerCommand(): string | null {
  if (process.platform === "darwin") return "afplay";
  if (process.platform === "linux") return existsSync("/usr/bin/paplay") ? "paplay" : "aplay";
  if (process.platform === "win32") return "powershell"; // handled specially above
  return null;
}
