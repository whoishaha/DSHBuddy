/**
 * Cosmetics — B2-2 shop accessories rendered as a tiny emoji worn above the
 * pet sprite. Kept client-side so the snapshot only carries the equipped id.
 */

export const ACCESSORY_EMOJI: Record<string, string> = {
  bowtie: "🎀",
  hat: "🎩",
  scarf: "🧣",
};

export function accessoryEmoji(id: string | null | undefined): string | null {
  if (!id) return null;
  return ACCESSORY_EMOJI[id] ?? null;
}
