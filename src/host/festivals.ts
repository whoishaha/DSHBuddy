/**
 * festivals — festival lookup for proactive greetings.
 *
 * Solar-calendar festivals are exact every year. Lunar festivals depend on
 * year-specific conversions, so only VERIFIED dates ship here (gov holiday
 * notices / almanacs); unknown years gracefully fall back to solar-only and
 * the per-year table is trivial to extend. Better no festival than a wrong
 * one.
 */

export type Festival = {
  name: string;
  emoji: string;
  /** Short warm wish woven into greetings. */
  wish: string;
};

const F = (name: string, emoji: string, wish: string): Festival => ({ name, emoji, wish });

/** Fixed Gregorian-date festivals. */
const SOLAR: Record<string, Festival> = {
  "01-01": F("元旦", "🎊", "新的一年，从一句早安开始"),
  "02-14": F("情人节", "💝", "爱要大声说出来"),
  "03-08": F("妇女节", "🌷", "向每一位了不起的她致敬"),
  "05-01": F("劳动节", "🛠️", "劳动最光荣，也别忘了休息"),
  "05-04": F("青年节", "🔥", "保持热爱，奔赴山海"),
  "06-01": F("儿童节", "🎈", "今天允许自己可爱一点"),
  "09-10": F("教师节", "📚", "谢谢每一位点亮别人的人"),
  "10-01": F("国庆节", "🇨🇳", "祝祖国生日快乐，假期愉快"),
  "10-24": F("程序员节", "💻", "1024，愿你的代码一次编译通过"),
  "12-24": F("平安夜", "🍎", "平安喜乐"),
  "12-25": F("圣诞节", "🎄", "圣诞快乐，记得吃颗糖"),
};

/**
 * Lunar festivals by Gregorian year → MM-DD. Only verified conversions:
 *   2025: 春节 01-29 · 元宵 02-12 · 端午 05-31 · 中秋 10-06
 *   2026: 春节 02-17 · 元宵 03-03 · 端午 06-19 · 中秋 09-25（国务院办公厅通知）
 *   2027: 春节 02-06 · 元宵 02-20
 *   2028: 春节 01-26 · 元宵 02-09
 */
const LUNAR: Record<string, Record<string, Festival>> = {
  "2025": {
    "01-29": F("春节", "🧧", "蛇年大吉，万事如意"),
    "02-12": F("元宵节", "汤圆", "吃碗汤圆，团团圆圆"),
    "05-31": F("端午节", "🎋", "粽子香甜，安康顺遂"),
    "10-06": F("中秋节", "🥮", "月圆人团圆"),
  },
  "2026": {
    "02-17": F("春节", "🧧", "马年吉祥，奔腾向前"),
    "02-16": F("除夕", "🏮", "辞旧岁，迎新春"),
    "03-03": F("元宵节", "汤圆", "灯圆月圆人团圆"),
    "06-19": F("端午节", "🎋", "粽子香甜，安康顺遂"),
    "09-25": F("中秋节", "🥮", "月圆人团圆"),
  },
  "2027": {
    "02-06": F("春节", "🧧", "新年快乐，心想事成"),
    "02-20": F("元宵节", "汤圆", "灯火可亲，团圆有味"),
  },
  "2028": {
    "01-26": F("春节", "🧧", "新年快乐，万事胜意"),
    "02-09": F("元宵节", "汤圆", "一碗汤圆，圆满开年"),
  },
};

/** Festival falling on `now` (local), or null. */
export function festivalOf(now: number): Festival | null {
  const d = new Date(now);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const lunar = LUNAR[String(d.getFullYear())];
  return lunar?.[md] ?? SOLAR[md] ?? null;
}
