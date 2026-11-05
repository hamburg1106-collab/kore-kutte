/* =========================================================
   次の食事のおすすめ（AIなしで作る版）

   今日の残りカロリーと、足りない／取りすぎのPFCから、
   用意した献立（tools/build-foods.cjs の MENUS）の中で近いものを選ぶ。
   コンビニ・外食・自炊から1つずつ出す。
   ========================================================= */

import MENUS from "./data/menus.json";

const KEYS = ["protein", "fat", "carbs"];

/* 次がどの食事か。時刻と、今日最後に記録した時刻から決める
   （昼すぎに昼ごはんを記録済みなら、次は夜ごはん） */
export function nextSlot(now, lastMealAt) {
  const h = now.getHours();
  const last = lastMealAt ? lastMealAt.getHours() : -1;
  if (h < 10) return last >= 4 ? "昼" : "朝";
  if (h < 15) return last >= 11 ? "夜" : "昼";
  if (h < 22) return last >= 17 ? "間食" : "夜"; // 夕食が遅い人もいるので22時までは夜ごはん扱い
  return "間食";
}

export const SLOT_LABEL = { 朝: "朝ごはん", 昼: "昼ごはん", 夜: "夜ごはん", 間食: "間食・夜食" };

/* 残りのうち、次の食事に回す割合。夜は残り全部、間食は少しだけ */
const SLOT_SHARE = { 朝: 0.3, 昼: 0.5, 夜: 1 };
/* 1食の上限（1日の目標に対する割合）。何も食べずに夜になった日に
   「夜ごはんは1,600kcal」のようなまとめ食いをすすめないため */
const SLOT_CAP = { 朝: 0.3, 昼: 0.4, 夜: 0.45 };
const SNACK_MAX = 200;
const OVER_MAX = 300; // 目標を超えた日でも、次に食べるならこのくらいまで

export const SLOTS = ["朝", "昼", "夜", "間食"];

/* input:
     remain   … 今日あと何kcal食べられるか    dayTarget … 今日の目標kcal
     target   … 今日のPFC目標(g)    intake … 今日食べたPFC(g)
     slot     … 朝・昼・夜・間食 */
export function buildSuggestion({ remain, dayTarget, target, intake, slot }) {
  const over = remain <= 0;
  const budget = over
    ? OVER_MAX
    : slot === "間食"
    ? Math.min(remain, SNACK_MAX)
    : Math.round(Math.min(remain * SLOT_SHARE[slot], dayTarget * SLOT_CAP[slot]));
  const share = over || slot === "間食" ? 0 : budget / remain;

  // 次の食事で取りたいPFC（足りない分のうち、この食事で取る割合）
  const ideal = {};
  KEYS.forEach((k) => (ideal[k] = Math.max(0, target[k] - intake[k]) * share));

  const candidates = MENUS.map(([name, place, slots, kcal, protein, fat, carbs]) => ({
    name, place, slots, kcal, protein, fat, carbs,
  })).filter((m) => (over || slot === "間食" ? m.kcal <= budget + 50 : m.slots.includes(slot)));

  const scored = candidates.map((m) => ({ m, s: scoreMenu(m, budget, ideal, target, over || slot === "間食") }));
  scored.sort((a, b) => a.s - b.s);

  // コンビニ・外食・自炊から1つずつ。足りなければ残りから順に
  const picked = [];
  ["コンビニ", "外食", "自炊"].forEach((place) => {
    const hit = scored.find((x) => x.m.place === place);
    if (hit) picked.push(hit);
  });
  scored.forEach((x) => picked.length < 3 && !picked.includes(x) && picked.push(x));
  picked.sort((a, b) => a.s - b.s);

  return {
    slot,
    budget,
    over,
    advice: buildAdvice({ remain, target, intake, slot, budget, over }),
    menus: picked.slice(0, 3).map((x) => x.m),
  };
}

/* 小さいほど良い。カロリーが目安を超えるのは強めに減点、
   足りない分は軽めに減点。そのうえでPFCが「次に取りたい量」に近いほど良い */
function scoreMenu(m, budget, ideal, target, light) {
  if (light) {
    // 軽く済ませたいときは、カロリーが低くてたんぱく質が多いものを先に
    return m.kcal / budget - m.protein / 30;
  }
  const kcalGap = m.kcal > budget ? ((m.kcal - budget) / budget) * 2 : ((budget - m.kcal) / budget) * 0.5;
  let pfcGap = 0;
  KEYS.forEach((k) => {
    const unit = Math.max(target[k] * 0.3, 5); // 1食分くらいの量を物差しにする
    pfcGap += Math.abs(m[k] - ideal[k]) / unit;
  });
  return kcalGap + pfcGap * 0.3;
}

function buildAdvice({ remain, target, intake, slot, budget, over }) {
  const lines = [];
  if (over) {
    lines.push(
      "今日は目標を " + Math.abs(remain).toLocaleString() + "kcal 超えています。" +
        "食べるなら " + OVER_MAX + "kcal 以下・たんぱく質中心に。明日で整えれば大丈夫。"
    );
    return lines;
  }

  lines.push(SLOT_LABEL[slot] + "は " + budget.toLocaleString() + "kcal くらいまでが目安です。");

  const needP = Math.round(target.protein - intake.protein);
  if (slot !== "間食" && needP > target.protein * 0.3) {
    lines.push("たんぱく質があと " + needP + "g。肉・魚・卵・大豆のどれかを1品入れましょう。");
  }
  if (intake.fat >= target.fat * 0.9) {
    lines.push("脂質はもう十分です。揚げ物や脂身は控えめに。");
  }
  if (intake.carbs >= target.carbs * 0.9) {
    lines.push("炭水化物は十分です。ごはんや麺は少なめに。");
  }
  return lines;
}

/* 直近7日（今日を除く）のPFCの割合を、目標の割合と比べる。
   PFCがわかる記録のある日が3日未満なら何も言わない */
export function weekTrend(days, ratio) {
  const sum = { protein: 0, fat: 0, carbs: 0 };
  let count = 0;
  days.forEach((d) => {
    if (!d) return;
    count++;
    KEYS.forEach((k) => (sum[k] += d[k]));
  });
  if (count < 3) return null;

  const kcal = { protein: sum.protein * 4, fat: sum.fat * 9, carbs: sum.carbs * 4 };
  const total = kcal.protein + kcal.fat + kcal.carbs;
  if (!total) return null;

  // 目標から一番ずれている栄養素を1つだけ伝える
  let worst = null;
  KEYS.forEach((k) => {
    const pct = Math.round((kcal[k] / total) * 100);
    const goal = Math.round(ratio[k] * 100);
    const diff = pct - goal;
    if (Math.abs(diff) >= 5 && (!worst || Math.abs(diff) > Math.abs(worst.diff))) {
      worst = { key: k, pct, goal, diff };
    }
  });
  return worst;
}

const NAME = { protein: "たんぱく質", fat: "脂質", carbs: "炭水化物" };

export function trendText(t) {
  if (!t) return "";
  return (
    "この1週間は" + NAME[t.key] + "が" + (t.diff > 0 ? "多め" : "少なめ") +
    "（平均 " + t.pct + "%／目標 " + t.goal + "%）"
  );
}
