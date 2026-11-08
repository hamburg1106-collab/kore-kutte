/* =========================================================
   撮れない外食（食べ放題・飲み会など）の目安

   その場で何度も注文する店は、1品ずつ撮っていられない。
   お店の種類と「控えめ・ふつう・がっつり」で、まとめて1件にする。

   - 数字は食品成分表（八訂）の値から、下の「中身」の量で足し上げた目安
     （焼肉の肉1切れ≒25g、寿司1皿＝2貫、焼き鳥1本≒30g など）
   - お酒は店によって杯数の差が大きいので、料理とは別に杯数で足す
   - 料理の kcal は PFC から出る値（P×4＋F×9＋C×4）とほぼ同じにしてある。
     お酒を足すと kcal のほうが多くなるが、それはアルコールの分
   ========================================================= */

export const EATOUT_LEVELS = ["控えめ", "ふつう", "がっつり"];

/* [kcal, P(g), F(g), C(g), 中身] を 控えめ・ふつう・がっつり の順に */
export const EATOUT_KINDS = [
  {
    id: "yakiniku",
    name: "焼肉食べ放題",
    drinks: 0,
    levels: [
      [1000, 45, 70, 55, "肉8切れほど・ごはん小"],
      [1600, 65, 110, 100, "肉15切れほど・ごはん1杯・サイド・デザート"],
      [2400, 95, 160, 160, "肉25切れ以上・ごはんおかわり・デザート"],
    ],
  },
  {
    id: "izakaya",
    name: "居酒屋・飲み会",
    drinks: 3,
    levels: [
      [500, 25, 30, 30, "つまみ2〜3品"],
      [1000, 45, 60, 70, "揚げ物を含むつまみ5品ほど"],
      [1600, 65, 90, 140, "つまみたくさん・締めまで"],
    ],
  },
  {
    id: "yakitori",
    name: "焼き鳥屋",
    drinks: 3,
    levels: [
      [450, 35, 25, 20, "串5本ほど"],
      [900, 60, 50, 50, "串10本ほど・つまみ1品"],
      [1500, 85, 75, 120, "串15本以上・締めまで"],
    ],
  },
  {
    id: "sushi",
    name: "回転寿司",
    drinks: 0,
    levels: [
      [700, 35, 15, 105, "6皿・汁物"],
      [1200, 55, 30, 185, "10皿・汁物かサイド"],
      [1900, 80, 50, 290, "15皿以上・サイド・デザート"],
    ],
  },
  {
    id: "shabu",
    name: "しゃぶしゃぶ・すき焼き食べ放題",
    drinks: 0,
    levels: [
      [900, 40, 55, 60, "肉150gほど・野菜・ごはん小"],
      [1500, 65, 90, 110, "肉300gほど・締めかごはん・デザート"],
      [2300, 100, 140, 170, "肉500g以上・締めまで"],
    ],
  },
  {
    id: "buffet",
    name: "ビュッフェ・バイキング",
    drinks: 0,
    levels: [
      [1000, 40, 45, 110, "2皿・デザート少し"],
      [1500, 55, 65, 175, "3〜4皿・デザート"],
      [2300, 80, 100, 270, "5皿以上・デザートいろいろ"],
    ],
  },
];

/* お酒1杯の目安。ビール中ジョッキ（約350ml）・サワー・ハイボールのならし。
   kcal の多くはアルコール由来で、PFCには入らない */
export const DRINK = { kcal: 150, protein: 1, fat: 0, carbs: 8 };

/* 選んだ内容を、記録に入れる形（名前・量・kcal・PFC）にする */
export function eatoutRecord(kindId, level, drinks) {
  const kind = EATOUT_KINDS.find((k) => k.id === kindId) || EATOUT_KINDS[0];
  const i = Math.max(0, EATOUT_LEVELS.indexOf(level));
  const [kcal, protein, fat, carbs, detail] = kind.levels[i];
  const n = Math.max(0, Math.round(Number(drinks) || 0));
  return {
    name: kind.name,
    portion: EATOUT_LEVELS[i] + "（" + detail + "）" + (n ? "・お酒" + n + "杯" : "") + "の目安",
    kcal: kcal + DRINK.kcal * n,
    protein: protein + DRINK.protein * n,
    fat: fat + DRINK.fat * n,
    carbs: carbs + DRINK.carbs * n,
    eatout: { kind: kind.id, level: EATOUT_LEVELS[i], drinks: n },
  };
}
