/**
 * Pet management: list installed pets, ensure the starter pet (DeepSeek whale),
 * read the active pet, and serve spritesheet bytes (base64) to the client.
 *
 * The primary pets root lives inside the plugin data folder (<data>/pets).
 * Official petdex CLI locations (~/.petdex/pets, ~/.codex/pets) are still
 * scanned read-only so pets installed via `petdex install <slug>` are
 * detected and switchable; installs through this plugin only touch the
 * plugin-local root.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE_PATH, DATA_ROOT, DEFAULT_ROOT, PETS_DIR } from "./paths.js";

export const CODEX_PETS_DIR = join(homedir(), ".codex", "pets");
/** Compatibility roots are scanned but never written by this plugin. */
const SCAN_ONLY_ROOTS = [join(DEFAULT_ROOT, "pets"), CODEX_PETS_DIR].filter(
  (root) => root !== PETS_DIR,
);

export type PetMeta = {
  id: string;
  displayName: string;
  description?: string;
  spritesheetPath?: string;
};

export type PetInfo = {
  slug: string;
  displayName: string;
  description: string;
  hasSpritesheet: boolean;
};

// Built-in starter pet assets (packaged with the plugin). lib/../assets/whale
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_WHALE = join(__dirname, "..", "assets", "whale");

/** Ensure the starter whale is present in the plugin pets root (idempotent). */
function ensureStarterInRoot(root: string): void {
  const target = join(root, "deepseek-whale");
  if (existsSync(BUILTIN_WHALE) && (!existsSync(target) || !pickSpritesheet(target))) {
    mkdirSync(target, { recursive: true });
    try {
      copyFileSync(join(BUILTIN_WHALE, "pet.json"), join(target, "pet.json"));
      const sheet = pickSpritesheet(BUILTIN_WHALE);
      if (sheet) copyFileSync(sheet, join(target, sheet.split(/[\\/]/).pop()!));
    } catch (err) {
      // starter pet is best-effort; if it fails the picker still works
    }
  }
}

export function ensureStarterPet(): string {
  for (const root of [PETS_DIR]) {
    mkdirSync(root, { recursive: true });
    ensureStarterInRoot(root);
  }
  // Ensure an active pet is recorded (prefer the whale on first run).
  const active = readActive();
  if (!active || !findPetDir(active)) {
    const first = findPetDir("deepseek-whale") ? "deepseek-whale" : (listPets()[0]?.slug ?? "deepseek-whale");
    writeActive(first);
    return first;
  }
  return active;
}

/** Find the directory holding a pet's files across all roots. */
export function findPetDir(slug: string): string | null {
  for (const root of [PETS_DIR, ...SCAN_ONLY_ROOTS]) {
    const dir = join(root, slug);
    if (existsSync(join(dir, "pet.json"))) return dir;
  }
  return null;
}

export function listPets(): PetInfo[] {
  // Merge all roots; when the same slug exists twice prefer <data>/pets.
  const bySlug = new Map<string, PetInfo>();
  for (const root of [PETS_DIR, ...[...SCAN_ONLY_ROOTS].reverse()]) {
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      const dir = join(root, slug);
      const petJson = join(dir, "pet.json");
      if (!existsSync(petJson)) continue;
      try {
        const meta = JSON.parse(readFileSync(petJson, "utf8")) as PetMeta;
        bySlug.set(slug, {
          slug,
          displayName: meta.displayName || slug,
          description: meta.description ?? "",
          hasSpritesheet: pickSpritesheet(dir) !== null,
        });
      } catch {
        // skip unreadable pet
      }
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readActive(): string | null {
  try {
    if (!existsSync(ACTIVE_PATH)) return null;
    const raw = JSON.parse(readFileSync(ACTIVE_PATH, "utf8")) as { slug?: string };
    return typeof raw.slug === "string" ? raw.slug : null;
  } catch {
    return null;
  }
}

export function writeActive(slug: string): void {
  mkdirSync(DATA_ROOT, { recursive: true });
  writeFileSync(ACTIVE_PATH, JSON.stringify({ slug }, null, 2));
}

export function getActivePet(): PetInfo | null {
  ensureStarterPet();
  const slug = readActive();
  const pets = listPets();
  if (!slug) return pets[0] ?? null;
  return pets.find((p) => p.slug === slug) ?? pets[0] ?? null;
}

export function pickSpritesheet(dir: string): string | null {
  for (const name of ["spritesheet.webp", "spritesheet.png"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Write one pet's files into the plugin-local pets root. */
export function installPetToRoots(slug: string, petJson: Buffer, sprite: Buffer, ext: "png" | "webp"): boolean {
  try {
    for (const root of [PETS_DIR]) {
      const dir = join(root, slug);
      // Never overwrite an existing pet dir in either root.
      if (existsSync(dir)) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pet.json"), petJson);
      writeFileSync(join(dir, `spritesheet.${ext}`), sprite);
    }
    return findPetDir(slug) !== null;
  } catch {
    return false;
  }
}

const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024;

/**
 * Read the active pet's spritesheet as a base64 data URL for the browser.
 * Returns null when the pet or its sheet is missing.
 */
export function activePetSpriteDataUrl(): { slug: string; dataUrl: string } | null {
  const pet = getActivePet();
  if (!pet) return null;
  const dir = findPetDir(pet.slug);
  const sheet = dir ? pickSpritesheet(dir) : null;
  if (!sheet) return null;
  try {
    const buf = readFileSync(sheet);
    if (buf.length > MAX_SPRITESHEET_BYTES) return null;
    const ext = sheet.endsWith(".png") ? "image/png" : "image/webp";
    return { slug: pet.slug, dataUrl: `data:${ext};base64,${buf.toString("base64")}` };
  } catch {
    return null;
  }
}
