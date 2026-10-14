/**
 * Rarity — B2-3 adoption reveal. Every market slug deterministically maps to
 * a rarity (80% common / 15% rare / 5% epic) plus a 1% shiny variant.
 *
 * Pure client-side: the same slug always reveals the same way on every
 * machine (no server state), so collecting stays a surprise at install time
 * but is stable forever afterwards.
 */

export type Rarity = "common" | "rare" | "epic";

/** FNV-1a 32-bit — tiny, dependency-free, well distributed for slugs. */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rarityFor(slug: string): Rarity {
  const roll = hashStr(`rarity:${slug}`) % 100;
  if (roll < 80) return "common";
  if (roll < 95) return "rare";
  return "epic";
}

/** 1/100 slugs are shiny (independent of rarity). */
export function isShiny(slug: string): boolean {
  return hashStr(`shiny:${slug}`) % 100 === 0;
}

export const RARITY_META: Record<Rarity, { zh: string; en: string; color: string }> = {
  common: { zh: "普通", en: "Common", color: "#94a3b8" },
  rare: { zh: "稀有", en: "Rare", color: "#38bdf8" },
  epic: { zh: "史诗", en: "Epic", color: "#c084fc" },
};
