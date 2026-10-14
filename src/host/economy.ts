/**
 * Economy — B2-2 coin loop: earn from real work → spend in a tiny shop.
 *
 * Red lines:
 *  - NO-GUILT: coins never expire, nothing rots, consumables never decay.
 *    A snack's mood/energy cheer is time-limited because it is an effect,
 *    not because we punish not showing up.
 *  - Earning mirrors the achievement sources (completed turns, finished work
 *    orders, focus minutes, level-ups, badges) — activity itself pays nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "./paths.js";

export type ShopItem = {
  id: string;
  icon: string;
  name: { zh: string; en: string };
  desc: { zh: string; en: string };
  price: number;
  kind: "consumable" | "accessory";
};

/** The whole shop. Consumables stack; accessories are own-once, equippable. */
export const SHOP: ShopItem[] = [
  {
    id: "snack", icon: "🍪", price: 10, kind: "consumable",
    name: { zh: "小鱼干", en: "Fish Snack" },
    desc: { zh: "吃掉后 30 分钟内心情变好、精力 +15", en: "Cheer up + 15 energy for 30 minutes" },
  },
  {
    id: "toy", icon: "🧸", price: 25, kind: "consumable",
    name: { zh: "小玩具", en: "Little Toy" },
    desc: { zh: "玩要后 20 分钟内心情变好", en: "Cheer up for 20 minutes" },
  },
  {
    id: "bowtie", icon: "🎀", price: 60, kind: "accessory",
    name: { zh: "蝴蝶结", en: "Bowtie" },
    desc: { zh: "戴在头上的永久装饰", en: "Permanent cosmetic worn on the head" },
  },
  {
    id: "hat", icon: "🎩", price: 80, kind: "accessory",
    name: { zh: "礼帽", en: "Top Hat" },
    desc: { zh: "绅士鲸的体面", en: "A gentleman whale's dignity" },
  },
  {
    id: "scarf", icon: "🧣", price: 120, kind: "accessory",
    name: { zh: "围巾", en: "Scarf" },
    desc: { zh: "深海也要保暖", en: "Stay warm even in the deep" },
  },
];

export type EconData = {
  coins: number;
  earnedTotal: number;
  spentTotal: number;
  /** Owned consumable stacks. */
  snacks: number;
  toys: number;
  /** Owned accessory ids. */
  accessories: string[];
  /** Currently worn accessory (null = none). */
  equipped: string | null;
  updatedAt: number;
};

const ECON_PATH = join(RUNTIME_DIR, "economy.json");

function emptyData(): EconData {
  return { coins: 0, earnedTotal: 0, spentTotal: 0, snacks: 0, toys: 0, accessories: [], equipped: null, updatedAt: 0 };
}

export class EconomyEngine {
  private data: EconData;

  constructor() {
    this.data = this.load();
  }

  private load(): EconData {
    try {
      if (existsSync(ECON_PATH)) {
        const raw = JSON.parse(readFileSync(ECON_PATH, "utf8")) as Partial<EconData>;
        return {
          coins: Number(raw.coins) || 0,
          earnedTotal: Number(raw.earnedTotal) || 0,
          spentTotal: Number(raw.spentTotal) || 0,
          snacks: Math.max(0, Number(raw.snacks) || 0),
          toys: Math.max(0, Number(raw.toys) || 0),
          accessories: Array.isArray(raw.accessories) ? raw.accessories.filter((x) => typeof x === "string") : [],
          equipped: typeof raw.equipped === "string" ? raw.equipped : null,
          updatedAt: raw.updatedAt ?? 0,
        };
      }
    } catch {
      // corrupt file → fresh wallet (coins are cosmetic, never gate features)
    }
    return emptyData();
  }

  private save() {
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
      this.data.updatedAt = Date.now();
      writeFileSync(ECON_PATH, JSON.stringify(this.data));
    } catch {
      // best-effort
    }
  }

  getData(): EconData {
    return this.data;
  }

  /** Award coins for real outcomes. */
  earn(amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.data.coins += Math.round(amount);
    this.data.earnedTotal += Math.round(amount);
    this.save();
  }

  /** Buy a shop item. Returns null on success or a failure reason code. */
  buy(id: string): "ok" | "unknown" | "owned" | "poor" {
    const item = SHOP.find((s) => s.id === id);
    if (!item) return "unknown";
    if (item.kind === "accessory" && this.data.accessories.includes(id)) return "owned";
    if (this.data.coins < item.price) return "poor";
    this.data.coins -= item.price;
    this.data.spentTotal += item.price;
    if (item.kind === "consumable") {
      if (id === "snack") this.data.snacks += 1;
      else if (id === "toy") this.data.toys += 1;
    } else {
      this.data.accessories.push(id);
    }
    this.save();
    return "ok";
  }

  /** Consume a snack/toy. Returns false when the stack is empty. */
  consume(id: "snack" | "toy"): boolean {
    if (id === "snack") {
      if (this.data.snacks <= 0) return false;
      this.data.snacks -= 1;
    } else {
      if (this.data.toys <= 0) return false;
      this.data.toys -= 1;
    }
    this.save();
    return true;
  }

  /** Equip / unequip a worn accessory (must be owned; null = take off). */
  equip(id: string | null): boolean {
    if (id === null) {
      this.data.equipped = null;
      this.save();
      return true;
    }
    if (!this.data.accessories.includes(id)) return false;
    this.data.equipped = id;
    this.save();
    return true;
  }
}
