/* =========================================================
   食品検索（APIキーなしでも、カロリーとPFCを入れられるようにする）

   データは tools/build-foods.cjs で文部科学省の食品成分表から作ったもの。
   約150KBあるので起動時には読まず、初めて検索したときに読み込む。
   ========================================================= */

let data = null;

export async function loadFoods() {
  if (data) return data;
  const mod = await import("./data/foods.json");
  const raw = mod.default;

  data = {
    source: raw.source,
    // よく食べるもの（1回分の値）。呼び名がふだんの言い方なのでそのまま探せる
    common: raw.common.map(([name, unit, kcal, protein, fat, carbs]) => ({
      kind: "common", name, unit, kcal, protein, fat, carbs, key: norm(name),
    })),
    // 成分表の全食品（100gあたりの値）。名前がかなや分類つきなので、言い換えてから探す
    table: raw.table.map(([name, kcal, protein, fat, carbs]) => ({
      kind: "table", name, kcal, protein, fat, carbs, key: norm(name),
    })),
  };
  return data;
}

/* 比べやすい形にそろえる。全角半角・カタカナひらがな・空白やかっこの違いを無くす */
function norm(s) {
  return String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s()（）［］\[\]・、,]/g, "");
}

/* 成分表は「にわとり むね」「こめ めし」のような書き方なので、
   ふだんの言い方をそちらに寄せてから探す（よく食べるもの の方は言い換えない） */
const ALIASES = [
  ["鶏肉", "にわとり"], ["鶏", "にわとり"], ["とり", "にわとり"],
  ["豚肉", "ぶた"], ["豚", "ぶた"],
  ["牛肉", "うし"],
  ["ご飯", "めし"], ["ごはん", "めし"], ["白米", "精白米"],
  ["鮭", "さけ"], ["サーモン", "さけ"], ["鯖", "さば"], ["鮪", "まぐろ"], ["鰯", "いわし"], ["鯵", "あじ"],
  ["胸", "むね"], ["腿", "もも"],
  ["卵", "鶏卵"], ["たまご", "鶏卵"],
  ["肉", ""],
];

/* 1回でまとめて置き換える。順番に置き換えると「鶏→にわとり」のあとに
   「とり→にわとり」がもう一度かかるような二重の置き換えが起きるため */
const ALIAS_MAP = new Map(ALIASES.map(([from, to]) => [norm(from), norm(to)]));
const ALIAS_RE = new RegExp(
  Array.from(ALIAS_MAP.keys()).sort((a, b) => b.length - a.length).join("|"),
  "g"
);

function aliasQuery(q) {
  return q.replace(ALIAS_RE, (m) => ALIAS_MAP.get(m));
}

/* 2文字ずつに区切って、どれだけ含まれているかで近さを測る。
   「鶏むね肉」→「にわとりむね」のように語順や区切りが違っても拾える */
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function score(q, key) {
  if (!q) return 0;
  if (key.includes(q)) return 1 + 1 / (key.length + 1); // 丸ごと含むものを先に、短い名前ほど先に
  if (q.length < 2) return 0;
  const grams = bigrams(q);
  const hit = grams.filter((g) => key.includes(g)).length;
  return hit / grams.length;
}

/* これより遠いものは出さない。低すぎると「サーモン」で「アーモンド」が出てしまう */
const MIN_SCORE = 0.75;

/* 探した結果。よく食べるもの を先に、そのあとに成分表の食品を並べる */
export function searchFoods(query, limit = 20) {
  if (!data) return [];
  const q = norm(query);
  if (!q) return [];
  const qa = aliasQuery(q);

  const pick = (list, qq) =>
    list
      .map((f) => ({ f, s: Math.max(score(q, f.key), qq === q ? 0 : score(qq, f.key)) }))
      .filter((x) => x.s >= MIN_SCORE)
      .sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length)
      .map((x) => x.f);

  const common = pick(data.common, q);
  const table = pick(data.table, qa);
  return common.concat(table).slice(0, limit);
}

export function foodsSource() {
  return data ? data.source : "";
}
