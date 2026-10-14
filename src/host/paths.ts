/**
 * DSHBuddy data locations.
 *
 * All persistent state lives under one local data root. The default is the
 * user's home directory (~/.petdex) — user data stays on this machine and out
 * of the plugin's development folder; set DSHBUDDY_DATA_DIR to redirect the
 * whole tree (e.g. a portable setup). When an override points somewhere new,
 * an existing ~/.petdex tree migrates over once so history is preserved.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default local data root in the OS home directory. */
export const DEFAULT_ROOT = join(homedir(), ".petdex");

/** Active data root: env override wins, else the default home location. */
export const DATA_ROOT = process.env.DSHBUDDY_DATA_DIR ?? DEFAULT_ROOT;

/** Runtime JSON files (config, stats, growth, chats…). */
export const RUNTIME_DIR = join(DATA_ROOT, "runtime");
/** Installed pet resources (<slug>/pet.json + spritesheet). */
export const PETS_DIR = join(DATA_ROOT, "pets");
/** Currently active pet slug. */
export const ACTIVE_PATH = join(DATA_ROOT, "active.json");

function copyLegacy(name: string): void {
  const from = join(DEFAULT_ROOT, name);
  const to = join(DATA_ROOT, name);
  if (!existsSync(from) || existsSync(to)) return;
  try {
    cpSync(from, to, { recursive: true });
  } catch {
    // best-effort migration — a fresh data folder is always acceptable
  }
}

// When DSHBUDDY_DATA_DIR redirects the tree, migrate the existing home-dir
// data once before any consumer module opens a file (ESM evaluates this
// module before its importers' bodies run). With the default root this is a
// no-op.
try {
  if (
    DEFAULT_ROOT !== DATA_ROOT &&
    existsSync(join(DEFAULT_ROOT, "runtime")) &&
    !existsSync(RUNTIME_DIR)
  ) {
    mkdirSync(DATA_ROOT, { recursive: true });
    copyLegacy("runtime");
    copyLegacy("pets");
    copyLegacy("active.json");
  }
} catch {
  // never block boot on migration problems
}
