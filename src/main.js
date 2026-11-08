/* =========================================================
   これ食っていい？
   写真を撮ると、その日の残りカロリーと見比べて食べていいか答えるアプリ
   ========================================================= */

/* 見た目のCSS。index.html の <link> ではなくここから読み込む。
   こうしておくとVite側でまとめてくれるので、公開時のキャッシュ事故が減る。 */
import "./style.css";

/* Firebaseもここから読み込む。以前は index.html で外部サーバー(gstatic.com)から
   読んでいたが、それだと圏外のときに読み込めず、クラウドの記録が1件も出ない状態に
   なっていた。ビルドに同梱すればService Workerがキャッシュするのでオフラインでも動く。
   compat版を使うのは、既存のコード（firebase.initializeApp など）をそのまま使うため。 */
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";

import { loadFoods, searchFoods } from "./foods.js";
import { nextSlot, buildSuggestion, weekTrend, trendText, SLOT_LABEL } from "./suggest.js";
import { sharedGenerate, sharedErrorStatus, sharedAiAvailable } from "./ai.js";
import { EATOUT_KINDS, EATOUT_LEVELS, eatoutRecord } from "./eatout.js";

/* 一覧が取れていないときに使うモデル。
   最新ではなく一世代前を既定にする（理由は resolveModel のコメント） */
const DEFAULT_MODEL = "gemini-3.5-flash";

/* 設定の置き場所。固定にしておくと、続けて操作しても同じものが2つできない */
const PROFILE_ID = "me";

/* 起動時に読み込む日数。記録が何年ぶん貯まっても起動が重くならないようにするための上限。
   これより古い記録も消えてはおらず、クラウド上には残っている。
   1週間のグラフと次の食事の提案は直近7日しか使わないので、写真込みの読み込みを減らすため35日にした（11/6）。 */
const HISTORY_DAYS = 35;

/* 目標ごとの1日の増減(kcal)。プラスの値だけ残りカロリーから引く */
const GOAL_DIFF = { keep: 0, diet: 300, diet500: 500, gain: -300 };
const GOAL_TEXT = {
  keep: "維持",
  diet: "減量 −300",
  diet500: "減量 −500",
  gain: "増量 +300",
};

/* ---------- 日付 ---------- */

/* YYYY-MM-DD を作る。toISOString()だとUTCになって日付がずれるので自前で組む */
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function todayKey() {
  return dateKey(new Date());
}

function shiftKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return dateKey(dt);
}

function labelOf(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const w = ["日", "月", "火", "水", "木", "金", "土"][dt.getDay()];
  if (key === todayKey()) return `今日 ${m}/${d}(${w})`;
  if (key === shiftKey(todayKey(), -1)) return `昨日 ${m}/${d}(${w})`;
  return `${y}/${m}/${d}(${w})`;
}

/* ---------- APIキー（この端末の中だけに置く。同期もバックアップもしない） ---------- */

const API_KEY_STORAGE = "korekutte_apikey";

function getApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE) || "";
  } catch (e) {
    return "";
  }
}

function setApiKey(v) {
  try {
    if (v) localStorage.setItem(API_KEY_STORAGE, v);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch (e) {
    /* プライベートモードなどで保存できない場合は黙って諦める */
  }
}

/* ---------- 同期コード（合言葉）----------
   これを知っている端末だけが自分のデータを読み書きできる。
   Firestore上のデータの置き場所そのものになるので、推測されない長さにする。 */

const SYNC_CODE_STORAGE = "korekutte_synccode";

function makeSyncCode() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // 紛らわしい l,o,0,1 は除く
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

function getSyncCode() {
  try {
    return localStorage.getItem(SYNC_CODE_STORAGE) || "";
  } catch (e) {
    return "";
  }
}

function setSyncCode(v) {
  try {
    localStorage.setItem(SYNC_CODE_STORAGE, v);
  } catch (e) {
    /* 保存できない環境では同期を諦める */
  }
}

/* ---------- 使えるモデルの一覧 ----------
   モデルは新しいものが出たり古いものが消えたりするので、選択肢を決め打ちにせず
   APIから取り直せるようにしておく。「自動」を選んでおけば一番新しいFlashを使う。 */

const MODELS_STORAGE = "korekutte_models";

function getCachedModels() {
  try {
    const v = JSON.parse(localStorage.getItem(MODELS_STORAGE) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function setCachedModels(list) {
  try {
    localStorage.setItem(MODELS_STORAGE, JSON.stringify(list));
  } catch (e) {
    /* 保存できなくても動作に支障はない */
  }
}

/* gemini-3.8-flash のようなIDを比較用の数値にする。
   Flash-Lite や preview 版は安定性と性能の都合で対象外にする（nullを返す）。
   3.8 -> 3008 / 4 -> 4000 と桁を分けるので、将来 gemini-4-flash が出ても正しく新しい方が勝つ。 */
function flashRank(id) {
  const m = /^gemini-(\d+)(?:\.(\d+))?-flash$/.exec(id);
  if (!m) return null;
  return Number(m[1]) * 1000 + Number(m[2] || 0);
}

/* 新しい順に並べたFlashのID一覧 */
function rankedFlashModels() {
  return getCachedModels()
    .map((id) => ({ id: id, rank: flashRank(id) }))
    .filter((x) => x.rank !== null)
    .sort((a, b) => b.rank - a.rank)
    .map((x) => x.id);
}

/* 設定が「自動」のときに実際に使うモデルを決める。

   いちばん新しいものは選ばない。出たばかりのモデルは需要が集中していて、
   無料枠だと503（混み合っています）が返り続けることがある。
   2026年9月、gemini-3.8-flash がまさにその状態で判定がほとんど通らなかった。
   一つ前の世代なら写真の判定精度はほとんど変わらず、返ってくる確率が上がる。 */
function resolveModel() {
  const chosen = state.profile.model || "auto";
  if (chosen !== "auto") return chosen;

  const ranked = rankedFlashModels();
  if (!ranked.length) return DEFAULT_MODEL;
  return ranked[1] || ranked[0];
}

/* 混み合っていたときに逃がす先。本命とは違うものを返す */
function fallbackModel() {
  const primary = resolveModel();
  const other = rankedFlashModels().find((id) => id !== primary);
  return other || primary;
}

/* APIキーで使えるモデルの一覧を取り直す */
async function fetchModels(key) {
  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    { headers: { "x-goog-api-key": key } }
  );
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || "HTTP " + res.status);
  }

  const list = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0)
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter((id) => id.indexOf("gemini-") === 0);

  setCachedModels(list);
  return list;
}

/* 設定画面のモデル選択肢を作り直す */
function buildModelSelect() {
  const sel = document.getElementById("inModel");
  const current = state.profile.model || "auto";
  const models = getCachedModels();

  // 一覧が取れていないときは、今選ばれているものだけは選択肢に残す
  const ids = models.length ? models.slice() : [DEFAULT_MODEL];
  if (current !== "auto" && ids.indexOf(current) < 0) ids.push(current);

  // 新しいFlashを上に、それ以外はその下に並べる
  const flash = ids.filter((id) => flashRank(id) !== null).sort((a, b) => flashRank(b) - flashRank(a));
  const others = ids.filter((id) => flashRank(id) === null).sort();

  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "自動（安定して返るFlashを使う）";
  sel.appendChild(auto);

  flash.concat(others).forEach((id) => {
    const op = document.createElement("option");
    op.value = id;
    op.textContent = id;
    sel.appendChild(op);
  });

  sel.value = current;
  renderModelNow();
}

function renderModelNow() {
  const el = document.getElementById("modelNow");
  if (!el) return;
  const chosen = state.profile.model || "auto";
  el.textContent =
    chosen === "auto"
      ? "いま使うのは " + resolveModel() + "（一覧 " + getCachedModels().length + " 件から選択）"
      : "";
}

/* ---------- 保存先: 端末内(localStorage) ---------- */

function createLocalBackend() {
  const key = (name) => "korekutte_" + name;

  function readAll(name) {
    try {
      return JSON.parse(localStorage.getItem(key(name)) || "[]");
    } catch (e) {
      return [];
    }
  }

  function writeAll(name, arr) {
    try {
      localStorage.setItem(key(name), JSON.stringify(arr));
    } catch (e) {
      alert("端末の保存容量がいっぱいです。古い記録を消してください。");
    }
    if (listeners[name]) listeners[name](arr);
  }

  const listeners = {};

  return {
    kind: "local",
    subscribe(name, cb) {
      listeners[name] = cb;
      cb(readAll(name));
      return () => delete listeners[name];
    },
    async add(name, data) {
      const arr = readAll(name);
      const id = "l" + Date.now() + Math.random().toString(36).slice(2, 7);
      arr.push(Object.assign({ id }, data));
      writeAll(name, arr);
      return id;
    },
    async update(name, id, patch) {
      const arr = readAll(name).map((d) =>
        d.id === id ? Object.assign({}, d, patch) : d
      );
      writeAll(name, arr);
    },

    /* 置き場所を決めて書き込む。すでにあれば上書き、なければ作る。
       これなら続けて操作しても同じものが2つできない。 */
    async setDoc(name, id, data) {
      const arr = readAll(name);
      const i = arr.findIndex((d) => d.id === id);
      if (i >= 0) arr[i] = Object.assign({}, arr[i], data, { id: id });
      else arr.push(Object.assign({ id: id }, data));
      writeAll(name, arr);
    },
    async remove(name, id) {
      writeAll(name, readAll(name).filter((d) => d.id !== id));
    },
  };
}

/* ---------- 保存先: Firestore（スマホとPCで同じデータを見るため） ---------- */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDSGP41IVUjfERDN9-4Nnm6_tAJPVeISgg",
  authDomain: "ouchi-no-kondate.firebaseapp.com",
  projectId: "ouchi-no-kondate",
  storageBucket: "ouchi-no-kondate.firebasestorage.app",
  messagingSenderId: "385279752727",
  appId: "1:385279752727:web:59068d4c3d5cbd000b3a52",
};

function createFirebaseBackend(fsDb, syncCode) {
  // 同期コードごとに置き場所を分ける（healthUsers/<コード>/meals/... という形）
  const root = fsDb.collection("healthUsers").doc(syncCode);
  const cols = {
    profile: root.collection("profile"),
    meals: root.collection("meals"),
    daily: root.collection("daily"),
  };
  return {
    kind: "firebase",
    subscribe(name, cb) {
      // 日付を持つデータは直近ぶんだけ読む。全件読むと記録が増えるほど起動が重くなるため
      let query = cols[name];
      if (name === "meals" || name === "daily") {
        query = query.where("date", ">=", shiftKey(todayKey(), -HISTORY_DAYS));
      }

      return query.onSnapshot(
        (snap) =>
          cb(
            snap.docs.map((d) => Object.assign({ id: d.id }, d.data())),
            snap.metadata.fromCache // まだサーバーに確かめていない仮の結果か
          ),
        (err) => {
          console.error("firestore " + name + " error", err);
          fallbackToLocal(err);
        }
      );
    },
    async add(name, data) {
      const ref = await cols[name].add(data);
      return ref.id;
    },
    async update(name, id, patch) {
      await cols[name].doc(id).update(patch);
    },

    /* 置き場所を決めて書き込む。すでにあれば上書き、なければ作る。 */
    async setDoc(name, id, data) {
      await cols[name].doc(id).set(data, { merge: true });
    },
    async remove(name, id) {
      await cols[name].doc(id).delete();
    },
  };
}

/* ---------- アプリの状態 ---------- */

const state = {
  profile: {
    height: null,
    weight: null,
    age: null,
    sex: "male",
    activity: 1.2,
    goal: "keep",
    burnMode: "total", // 消費カロリーの入れ方。total=合計(Android) / active=動いた分だけ(iPhone)
    model: "auto",
    shareRatio: 0.6, // 大皿のおかずのうち、自分が食べるいつもの割合
  },
  profileId: null,
  meals: [],
  daily: [],
  viewDate: todayKey(),
  pending: null, // 判定はしたがまだ記録していない food
};

let Store = null;
let unsubscribers = [];

/* クラウドに保存できていないときだけ、画面の上に注意を出す。
   スマホ1台で使うので「同期中」のような表示はしない（ふだんは見えないところで
   クラウドにも保存していて、機種変更やキャッシュ消去のときの保険になっている）。 */
function setStoreWarning(msg) {
  const el = document.getElementById("storeWarn");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function subscribeAll() {
  unsubscribers = [
    Store.subscribe("profile", (rows, fromCache) => {
      // 置き場所を固定する前に作られた設定が残っていても読めるようにしておく
      const row = rows.find((r) => r.id === PROFILE_ID) || rows[0];
      if (row) {
        state.profileId = row.id;
        Object.assign(state.profile, row);
        delete state.profile.id;
        fillSettingsForm();
      }
      renderAll();

      // 圏外などで手元に何も無いだけかもしれないときは、少し待ってから決める
      if (row || !fromCache) maybeOpenWelcome();
      else setTimeout(maybeOpenWelcome, 4000);
    }),

    Store.subscribe("meals", (rows) => {
      state.meals = rows;
      renderAll();
    }),

    Store.subscribe("daily", (rows) => {
      // 同じ日の記録が複数あったら、最後に更新された方だけを使う
      const byDate = new Map();
      rows.forEach((r) => {
        const cur = byDate.get(r.date);
        if (!cur || (r.updatedAt || "") >= (cur.updatedAt || "")) byDate.set(r.date, r);
      });
      state.daily = Array.from(byDate.values());

      fillBurnForm();
      renderAll();
    }),
  ];
}

/* 画面の下に一瞬だけ出すお知らせ。保存できたか分からない不安をなくすため。 */
let toastTimer = null;

function showToast(message, isError) {
  const el = document.getElementById("toast");
  if (!el) return;

  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.toggle("bad", !!isError);
  el.classList.remove("leaving");
  el.hidden = false;

  toastTimer = setTimeout(() => {
    el.classList.add("leaving");
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 300);
  }, isError ? 4000 : 2200);
}

/* 保存に失敗したときの知らせ方。
   ここで端末内保存に切り替えてしまうと、それ以降の記録がクラウドに載らなくなり
   行方不明になるので、切り替えはせず知らせるだけにする。 */
function notifySaveFailed(err, what) {
  console.error((what || "保存") + "に失敗しました", err);
  showToast(
    (what || "保存") + "できませんでした。電波を確認してもう一度お試しください。",
    true
  );
}

/* 読み込みそのものができないときだけ、端末内保存に切り替える。
   そうしないと入力しても何も保存されない状態になってしまう。 */
function fallbackToLocal(err) {
  if (!Store || Store.kind !== "firebase") return;

  console.warn("Firestoreが使えないため端末内保存に切り替えます", err);

  unsubscribers.forEach((fn) => {
    try {
      if (typeof fn === "function") fn();
    } catch (e) {
      /* 解除に失敗しても続行する */
    }
  });

  Store = createLocalBackend();
  state.profileId = null; // クラウド側のIDは使えないので捨てる

  setStoreWarning("クラウドに保存できていません。記録はこの端末の中だけにあります。");
  document.getElementById("storeNote").textContent =
    "クラウドに接続できなかったため（" +
    ((err && err.code) || "原因不明") +
    "）、この端末の中だけに保存しています。ファイルを直接開いた場合（file://）は同期が使えません。";

  subscribeAll();
}

async function initStore() {
  let backend = null;
  let initError = null;

  // file:// で開いた場合はFirestoreに接続できないので、最初から端末内保存にする
  const canUseCloud = location.protocol.startsWith("http");

  // 同期コードが無ければこの端末用に作る
  let code = getSyncCode();
  if (!code) {
    code = makeSyncCode();
    setSyncCode(code);
  }
  document.getElementById("inSyncCode").value = code;

  try {
    if (canUseCloud && FIREBASE_CONFIG.apiKey) {
      firebase.initializeApp(FIREBASE_CONFIG);
      const fs = firebase.firestore();

      // 一度読んだ記録を端末内にも持っておく。圏外や機内モードでも過去の記録を見られる。
      // 複数タブで開いていたり非対応ブラウザだと失敗するが、その場合は今まで通り動く。
      fs.enablePersistence({ synchronizeTabs: true }).catch((e) =>
        console.warn("オフライン保存は使えません", e && e.code)
      );

      backend = createFirebaseBackend(fs, code);
    }
  } catch (e) {
    // 失敗を黙って捨てると原因を追えなくなるので、理由を残しておく
    console.error("Firebaseの初期化に失敗しました", e);
    initError = e;
    backend = null;
  }

  Store = backend || createLocalBackend();

  if (Store.kind === "firebase") {
    setStoreWarning("");
    document.getElementById("storeNote").textContent =
      "記録はこの端末とクラウドの両方に保存されています。APIキーだけはこの端末の中だけに置かれます。";
  } else {
    // file:// で開いているのは開発中の確認だけなので、そのときは注意を出さない
    if (initError || canUseCloud) {
      setStoreWarning("クラウドに保存できていません。記録はこの端末の中だけにあります。");
    }
    document.getElementById("storeNote").textContent = initError
      ? "クラウドの準備に失敗したため（" +
        ((initError && initError.message) || "原因不明") +
        "）、この端末の中だけに保存しています。"
      : canUseCloud
      ? "記録はこの端末の中だけに保存されています。"
      : "ファイルを直接開いている（file://）ため、記録はこの端末の中だけに保存されます。複数の端末で同期したい場合は、GitHub Pagesなどに置いて http:// で開いてください。";
  }

  subscribeAll();
}

/* ---------- 計算 ---------- */

/* 基礎代謝（Mifflin-St Jeor式） */
function calcBmr(p) {
  if (!p.height || !p.weight || !p.age) return 0;
  const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
  return Math.round(base + (p.sex === "female" ? -161 : 5));
}

/* ふだんの活動量まで含めた1日の消費の目安 */
function calcTdee(p) {
  return Math.round(calcBmr(p) * (Number(p.activity) || 1.2));
}

function dailyOf(key) {
  return state.daily.find((d) => d.date === key) || { date: key, activeKcal: 0 };
}

function mealsOf(key) {
  return state.meals.filter((m) => m.date === key);
}

/* 読み込み範囲より古い日かどうか。ここに入力させると重複登録になるので編集も止める */
function isTooOld(key) {
  return key < shiftKey(todayKey(), -HISTORY_DAYS);
}

/* その日の消費カロリーを、見込みと実測の大きい方で出す。

   ヘルスアプリの消費カロリーは、あくまで“入力した時点まで”の実績。
   昼に入れた値をそのまま1日の消費として扱うと、
   夜までに増えるぶんが無視されて判定が不当に厳しくなる。
   そこで「1日を終えたときの見込み」と比べ、大きい方を採用する。
   - 日中は実測がまだ小さいので見込みを使う
   - よく動いた日や寝る前は実測が見込みを超えるので実測を使う

   Googleヘルスなどは基礎代謝込みの合計が出るが、iPhoneのヘルスケアは
   「アクティブエネルギー（動いた分）」しか出ない。その入れ方の日は基礎代謝を足す。
   入れ方は日ごとに残しているので、あとで設定を変えても過去の日は変わらない。
   以前あった歩数の入力はやめた（消費カロリーに歩いた分も含まれていて二重になるため）。
   古い記録に歩数が残っていても使わない。 */
function calcBurnDetail(key) {
  const p = state.profile;
  const bmr = calcBmr(p);
  if (!bmr) return { total: 0, estimate: 0, actual: 0, source: "none" };

  const d = dailyOf(key);
  const estimate = calcTdee(p);
  const input = Math.round(Number(d.activeKcal) || 0);
  const actual = input && d.burnMode === "active" ? bmr + input : input;

  return {
    total: Math.max(estimate, actual),
    estimate: estimate,
    actual: actual,
    source: actual > estimate ? "actual" : "estimate",
  };
}

function calcBurn(key) {
  return calcBurnDetail(key).total;
}

function calcIntake(key) {
  return mealsOf(key).reduce((sum, m) => sum + (Number(m.kcal) || 0), 0);
}

/* 「これから行く」で入れた外食の予定。まだ食べていないが、残りカロリーからは先に引いておく */
function plansOf(key) {
  return mealsOf(key).filter((m) => m.plan);
}

function calcPlanned(key) {
  return plansOf(key).reduce((sum, m) => sum + (Number(m.kcal) || 0), 0);
}

function calcRemain(key) {
  return calcBurn(key) - calcIntake(key) - (GOAL_DIFF[state.profile.goal] || 0);
}

/* ---------- 栄養バランス（PFC） ----------
   目標は、その日の目標kcalを次の割合で分けてグラムに直したもの。
   ダイエット中は筋肉を落とさないよう、たんぱく質を多めにしている */
const PFC_RATIO = { protein: 0.2, fat: 0.25, carbs: 0.55 };
const KCAL_PER_G = { protein: 4, fat: 9, carbs: 4 };
const PFC_KEYS = ["protein", "fat", "carbs"];
const PFC_SHORT = { protein: "P", fat: "F", carbs: "C" };

/* 記録のPFC。昔の記録や、わからず空にした記録は null（＝不明）を返す */
function pfcOf(m) {
  if (PFC_KEYS.some((k) => m[k] === null || m[k] === undefined || m[k] === "")) return null;
  return { protein: Number(m.protein), fat: Number(m.fat), carbs: Number(m.carbs) };
}

function calcPfcTarget(key) {
  const t = Math.max(0, calcTarget(key));
  const out = {};
  PFC_KEYS.forEach((k) => (out[k] = Math.round((t * PFC_RATIO[k]) / KCAL_PER_G[k])));
  return out;
}

/* その日に食べたPFCの合計と、PFCが不明な記録の件数 */
function calcPfcIntake(key) {
  const sum = { protein: 0, fat: 0, carbs: 0 };
  let unknown = 0;
  mealsOf(key).forEach((m) => {
    const p = pfcOf(m);
    if (!p) {
      unknown++;
      return;
    }
    PFC_KEYS.forEach((k) => (sum[k] += p[k]));
  });
  return { sum, unknown };
}

/* グラムの値をそろえる。空や数字でないものは null（＝不明）にする */
function gramOf(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
}

/* 「P 12g ・ F 8g ・ C 40g」のような短い表記 */
function pfcText(p, sep) {
  return PFC_KEYS.map((k) => PFC_SHORT[k] + " " + Math.round(p[k]) + "g").join(sep || " ・ ");
}

/* 食べていいかの判定 */
function decide(kcal, remain) {
  if (remain <= 0) return "stop";
  const ratio = kcal / remain;
  if (ratio <= 0.6) return "ok";
  if (ratio <= 1) return "half";
  return "stop";
}

/* 画面の中で使う線のアイコン（下のタブと同じ太さ・角の丸めにそろえる） */
const svgIcon = (d) => '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>";
const ICON = {
  utensils: svgIcon('<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2.2 1-3.5 4-3.5 7.5H17"/>'),
  close: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
};

const VERDICT_TEXT = {
  ok: "食っていい",
  half: "半分にしとけ",
  stop: "やめとけ",
};

/* ---------- 画面の描画 ---------- */

function renderAll() {
  renderHeader();
  renderHero();
  renderPfc();
  renderChips();
  renderShootArea();
  renderSuggest();
  renderMealList();
  renderWeek();
  renderBmrBox();
  renderReminder();
  renderModelNow();
}

/* 「20:28 更新」のような文字列にする。前の日の入力なら日付も添える */
function updatedLabel(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (isNaN(t)) return "";
  const hhmm =
    String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
  if (dateKey(t) === todayKey()) return hhmm + " 更新";
  return t.getMonth() + 1 + "/" + t.getDate() + " " + hhmm + " 更新";
}

/* 寝る前に消費カロリーを入れ直してもらうためのお知らせ。
   21時を過ぎていて、今日の数字がまだ入っていないか21時前の入力のときだけ出す */
function needsReminder() {
  if (!calcBmr(state.profile)) return false;

  const now = new Date();
  if (now.getHours() < 21) return false;

  const d = dailyOf(todayKey());
  if (!d.activeKcal) return true;
  if (!d.updatedAt) return true;

  const t = new Date(d.updatedAt);
  if (isNaN(t)) return true;
  return dateKey(t) !== todayKey() || t.getHours() < 21;
}

function renderReminder() {
  document.getElementById("reminder").hidden = !needsReminder();
}

/* 上の帯：表示している日付。過去の日を見ているときは押すと今日に戻る */
function renderHeader() {
  const key = state.viewDate;
  const label = document.getElementById("dayLabel");
  label.textContent = labelOf(key);
  label.classList.toggle("past", key !== todayKey());

  // 未来の日付には進めないようにする
  document.getElementById("dayNext").disabled = key >= todayKey();
}

/* その日の目標（食べてよい量）。消費から、減量なら差し引き、増量なら上乗せする */
function calcTarget(key) {
  return calcBurn(key) - (GOAL_DIFF[state.profile.goal] || 0);
}

/* リングの周の長さ。style.css の stroke-dasharray と同じ値 */
const RING_LENGTH = 2 * Math.PI * 86;

/* 主役のリングと大きな数字。
   状態は色だけでなく中央の文字（あと／残りわずか／オーバー）でも伝える */
function renderHero() {
  const hero = document.getElementById("hero");
  const fill = document.getElementById("ringFill");
  const label = document.getElementById("ringLabel");
  const value = document.getElementById("remainKcal");
  const sub = document.getElementById("remainSub");

  hero.classList.remove("warn", "bad", "empty");

  if (!calcBmr(state.profile)) {
    hero.classList.add("empty");
    fill.style.strokeDashoffset = RING_LENGTH;
    label.textContent = "はじめに";
    value.textContent = "—";
    sub.textContent = "下の「設定」から身長・体重・年齢を入れてください";
    return;
  }

  const key = state.viewDate;
  const target = calcTarget(key);
  const intake = calcIntake(key);
  const remain = target - intake;
  const ratio = target > 0 ? intake / target : 1;

  fill.style.strokeDashoffset = RING_LENGTH * (1 - Math.min(1, ratio));

  if (remain < 0) {
    hero.classList.add("bad");
    label.textContent = "オーバー";
    value.textContent = "+" + Math.abs(remain).toLocaleString();
  } else if (ratio >= 0.85) {
    hero.classList.add("warn");
    label.textContent = "残りわずか";
    value.textContent = remain.toLocaleString();
  } else {
    label.textContent = key === todayKey() ? "あと" : "残り";
    value.textContent = remain.toLocaleString();
  }

  const goal = state.profile.goal;
  const goalNote = goal && goal !== "keep" ? "（" + GOAL_TEXT[goal] + "）" : "";
  const planned = calcPlanned(key);
  sub.textContent =
    "食べた " + intake.toLocaleString() +
    (planned ? "（予定 " + planned.toLocaleString() + " を含む）" : "") +
    " ／ 目標 " + target.toLocaleString() + goalNote +
    (target > 0 ? " ・ " + Math.round(ratio * 100) + "%" : "");
}

/* リングの下のPFCの棒。たんぱく質は「届いたか」、脂質・炭水化物は「超えていないか」を見る */
function renderPfc() {
  const box = document.getElementById("pfc");
  const key = state.viewDate;
  if (!calcBmr(state.profile)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const target = calcPfcTarget(key);
  const { sum, unknown } = calcPfcIntake(key);

  PFC_KEYS.forEach((k) => {
    const row = box.querySelector('[data-k="' + k + '"]');
    const got = Math.round(sum[k]);
    const goal = target[k];
    const rate = goal > 0 ? got / goal : 0;
    const good = k === "protein" && rate >= 1;
    const over = k !== "protein" && rate > 1;

    row.classList.toggle("good", good);
    row.classList.toggle("over", over);
    row.querySelector(".pfc-bar i").style.width = Math.min(100, rate * 100) + "%";

    const val = row.querySelector(".pfc-val");
    val.textContent = "";
    const b = document.createElement("b");
    b.textContent = got;
    val.appendChild(b);
    val.append(" / " + goal + "g" + (good ? " 達成" : over ? " 多め" : ""));
  });

  const note = document.getElementById("pfcNote");
  note.hidden = unknown === 0;
  note.textContent = "※ PFCがわからない記録が " + unknown + " 件あり、その分は入っていません";
}

/* 消費カロリーのチップ。押すと入力シートが開く */
function renderChips() {
  const key = state.viewDate;
  const d = dailyOf(key);
  const detail = calcBurnDetail(key);
  const hasProfile = !!calcBmr(state.profile);
  const old = isTooOld(key);

  document.getElementById("chipBurnVal").textContent =
    hasProfile ? detail.total.toLocaleString() : "—";

  // その消費がどこから来た数字なのかを示す（見込みか、ヘルスアプリの実測か）
  const burnSub = document.getElementById("chipBurnSub");
  burnSub.classList.toggle("actual", detail.source === "actual");
  if (!hasProfile) {
    burnSub.textContent = "設定が必要";
  } else if (detail.source === "actual") {
    burnSub.textContent = "実測 " + (updatedLabel(d.updatedAt) || "");
  } else if (detail.actual > 0) {
    burnSub.textContent = "見込み（実測は途中）";
  } else {
    burnSub.textContent = "見込み ・ タップで実測を入力";
  }

  // 読み込んでいない古い日は入力させない（重複登録になるため）
  document.getElementById("chipBurn").disabled = old;
}

/* 撮影ボタンは今日を見ているときだけ出す（写真判定は今日の記録にしか入らないため）。
   AIが使えないとき（ファイルを直接開いたときなど）は、写真の代わりに
   カロリーを入れて判定するボタンを出す。
   初めて使うときは、足りない準備をボタンの下で案内する */
function renderShootArea() {
  const isToday = state.viewDate === todayKey();
  document.getElementById("shootArea").hidden = !isToday;

  const ai = canUseAi();
  // 下の撮影ボタン。AIが使えないときはカメラの代わりにペンの絵にして、カロリーを入れて判定する
  const fab = document.getElementById("fab");
  fab.classList.toggle("no-ai", !ai);
  fab.setAttribute("aria-label", ai ? "これ食っていい？ 写真で判定" : "これ食っていい？ カロリーを入れて判定");
  document.getElementById("shootTip").textContent = ai
    ? "食べる前に、下の カメラ で撮って判定。お菓子は栄養成分表示も一緒に写すと正確です。"
    : "食べる前に、下の「判定」でカロリーを入れて判定。";
  // 判定ボタン自体が手入力のときは、記録だけの手入力は出さない
  document.getElementById("btnManualOpen").hidden = !ai;

  const hint = document.getElementById("setupHint");
  if (!calcBmr(state.profile)) {
    hint.textContent = "① まず、はじめの設定をしてください（1分） →";
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

/* ---------- 次の食事のおすすめ ---------- */

/* どの食事のおすすめを出すか。押して選んだらそれ、選んでいなければ時刻から決める。
   選んだものは、食事を記録したときと日付が変わったときに自動に戻す */
let pickedSlot = null;

function currentSlot() {
  if (pickedSlot) return pickedSlot;
  const meals = mealsOf(todayKey());
  const last = meals
    .filter((m) => !m.plan)
    .reduce((t, m) => (m.createdAt && m.createdAt > t ? m.createdAt : t), "");
  const slot = nextSlot(new Date(), last ? new Date(last) : null);
  // 次の食事が外食の予定そのものなら、それまでの間食をすすめる
  const planned = meals.some((m) => m.plan && m.planSlot === slot);
  return planned ? "間食" : slot;
}

document.querySelectorAll("#slotTabs [data-slot]").forEach((btn) => {
  btn.onclick = () => {
    pickedSlot = btn.dataset.slot;
    renderSuggest();
  };
});

/* 今日の記録から、次の食事のおすすめ（AIなし版）を作る */
function currentSuggestion() {
  const key = todayKey();
  return buildSuggestion({
    remain: calcRemain(key),
    dayTarget: calcTarget(key),
    target: calcPfcTarget(key),
    intake: calcPfcIntake(key).sum,
    slot: currentSlot(),
  });
}

/* 直近7日（今日を除く）の、日ごとのPFC合計。PFCのわかる記録が無い日は null */
function calcWeekTrend() {
  const days = [];
  for (let i = 1; i <= 7; i++) {
    const list = mealsOf(shiftKey(todayKey(), -i)).map(pfcOf).filter(Boolean);
    if (!list.length) {
      days.push(null);
      continue;
    }
    const sum = { protein: 0, fat: 0, carbs: 0 };
    list.forEach((p) => PFC_KEYS.forEach((k) => (sum[k] += p[k])));
    days.push(sum);
  }
  return weekTrend(days, PFC_RATIO);
}

function suggestTitle(s) {
  if (s.over) return "このあと食べるなら";
  return s.slot === "間食" ? "間食・夜食のおすすめ" : "次の" + SLOT_LABEL[s.slot] + "のおすすめ";
}

/* 献立1つ分の行。押すと、その数字で「これ食っていい？」を開く */
function menuItem(m) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";

  const place = document.createElement("span");
  place.className = "menu-place";
  place.textContent = m.place;

  const name = document.createElement("span");
  name.className = "menu-name";
  name.textContent = m.name;
  const sub = document.createElement("small");
  sub.textContent = (m.detail ? m.detail + "　" : "") + pfcText(m, " ");
  name.appendChild(sub);

  const kcal = document.createElement("span");
  kcal.className = "menu-kcal";
  kcal.textContent = m.kcal.toLocaleString() + "kcal";

  btn.append(place, name, kcal);
  btn.onclick = () =>
    openJudge({
      name: m.name,
      portion: m.place + "の目安",
      kcal: m.kcal,
      protein: m.protein,
      fat: m.fat,
      carbs: m.carbs,
    });
  li.appendChild(btn);
  return li;
}

function renderSuggest() {
  const box = document.getElementById("suggest");
  const empty = document.getElementById("suggestEmpty");
  const noProfile = !calcBmr(state.profile);
  if (state.viewDate !== todayKey() || noProfile) {
    box.hidden = true;
    // おすすめのタブが空にならないよう、出せない理由と次の一手を出す
    empty.hidden = false;
    document.getElementById("suggestEmptyText").textContent = noProfile
      ? "はじめの設定をすると、残りカロリーに合わせて次の食事をおすすめします。"
      : "おすすめは今日の分だけ出します。";
    const btn = document.getElementById("suggestEmptyBtn");
    btn.textContent = noProfile ? "はじめの設定をする" : "今日に戻る";
    btn.onclick = noProfile
      ? openWelcome
      : () => {
          state.viewDate = todayKey();
          fillBurnForm();
          renderAll();
        };
    return;
  }
  box.hidden = false;
  empty.hidden = true;

  const s = currentSuggestion();
  document.getElementById("suggestTitle").textContent = suggestTitle(s);
  document.querySelectorAll("#slotTabs [data-slot]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.slot === s.slot));
  });

  const advice = document.getElementById("suggestAdvice");
  advice.innerHTML = "";
  s.advice.forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    advice.appendChild(li);
  });
  plansOf(todayKey()).forEach((m) => {
    const li = document.createElement("li");
    li.textContent =
      (m.planSlot === "昼" ? "昼" : "今夜") + "は「" + m.name + "」の予定。" +
      (Number(m.kcal) || 0).toLocaleString() + "kcal を先に取ってあります。";
    advice.insertBefore(li, advice.firstChild);
  });
  const trend = trendText(calcWeekTrend());
  if (trend) {
    const li = document.createElement("li");
    li.className = "trend";
    li.textContent = trend;
    advice.appendChild(li);
  }

  const ul = document.getElementById("suggestMenus");
  ul.innerHTML = "";
  s.menus.forEach((m) => ul.appendChild(menuItem(m)));

  renderAiSuggest();
}

function renderMealList() {
  const ul = document.getElementById("mealList");
  const rows = mealsOf(state.viewDate).sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );

  const key = state.viewDate;
  const old = isTooOld(key);

  document.getElementById("mealsTitle").textContent =
    key === todayKey() ? "今日食べたもの" : weekLabel(key) + " に食べたもの";

  // 読み込んでいない古い日には追加させない（重複登録になるため）
  const addBtn = document.getElementById("btnAddToDay");
  addBtn.disabled = old;
  addBtn.setAttribute("aria-label", labelOf(key) + " に手で追加");

  const empty = document.getElementById("mealEmpty");
  empty.hidden = rows.length > 0;
  empty.textContent = old
    ? "この日の記録は読み込んでいません（消えてはいません）"
    : "まだ記録がありません";

  ul.innerHTML = "";

  // 朝・昼・おやつ・夜・夜食に分けて、まとまりごとに小計を出す。
  // 別の日にあとから足した記録（昨日の入れ忘れなど）は時刻が当てにならないので「時刻なし」にまとめる
  const groupOf = (m) => {
    const t = mealTime(m, key);
    return t ? mealGroup(t.getHours()) : "時刻なし";
  };
  const ordered = [...rows.filter((m) => mealTime(m, key)), ...rows.filter((m) => !mealTime(m, key))];
  let lastGroup = null;

  ordered.forEach((m) => {
    const t = mealTime(m, key);
    const group = groupOf(m);
    if (group !== lastGroup) {
      lastGroup = group;
      const total = ordered
        .filter((x) => groupOf(x) === group)
        .reduce((sum, x) => sum + (Number(x.kcal) || 0), 0);
      const head = document.createElement("li");
      head.className = "meal-group";
      const gname = document.createElement("span");
      gname.textContent = group;
      const gsum = document.createElement("span");
      gsum.className = "meal-group-sum";
      gsum.textContent = total.toLocaleString() + " kcal";
      head.append(gname, gsum);
      ul.appendChild(head);
    }

    const li = document.createElement("li");
    if (m.plan) li.className = "is-plan";

    // 写真のない記録も行の頭を揃える
    if (m.thumb) {
      const img = document.createElement("img");
      img.src = m.thumb;
      img.alt = "";
      li.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "meal-noimg";
      ph.innerHTML = ICON.utensils;
      ph.setAttribute("aria-hidden", "true");
      li.appendChild(ph);
    }

    const body = document.createElement("div");
    body.className = "meal-body";

    const name = document.createElement("div");
    name.className = "meal-name";
    name.textContent = m.name;
    name.title = m.name; // 2行で切れたときに全文を確認できるように
    if (m.plan) {
      const tag = document.createElement("span");
      tag.className = "plan-tag";
      tag.textContent = "予定";
      name.prepend(tag);
    }
    body.appendChild(name);

    // 食べた時刻と量を1行に並べる（予定は時刻ではなく昼・夜）
    const when = m.plan ? (m.planSlot || "夜") + "に行く" : t ? hhmmOf(t) : "";
    const subText = [when, m.portion || ""].filter(Boolean).join("　");
    if (subText) {
      const portion = document.createElement("div");
      portion.className = "meal-portion";
      portion.textContent = subText;
      body.appendChild(portion);
    }

    const pfc = pfcOf(m);
    if (pfc) {
      const line = document.createElement("div");
      line.className = "meal-pfc";
      line.textContent = pfcText(pfc, " ");
      body.appendChild(line);
    }

    // 予定は、行ってきたら実際の量で確定する
    if (m.plan && !old) {
      const done = document.createElement("button");
      done.type = "button";
      done.className = "plan-done";
      done.textContent = "行ってきた → 量を確定";
      done.onclick = () => openEatout(m);
      body.appendChild(done);
    }

    li.appendChild(body);

    const kcal = document.createElement("div");
    kcal.className = "meal-kcal";
    kcal.textContent = (Number(m.kcal) || 0).toLocaleString();
    const unit = document.createElement("small");
    unit.textContent = "kcal";
    kcal.appendChild(unit);
    li.appendChild(kcal);

    const del = document.createElement("button");
    del.className = "meal-del";
    del.innerHTML = ICON.close;
    del.title = "削除";
    del.setAttribute("aria-label", m.name + " を削除");
    del.onclick = () => {
      if (confirm(`「${m.name}」を記録から消しますか？`)) {
        Store.remove("meals", m.id).catch((e) => notifySaveFailed(e, "削除"));
      }
    };
    li.appendChild(del);

    ul.appendChild(li);
  });
}

/* 記録した時刻。その日のうちに記録したものだけ返す（別の日にあとから足したものは null） */
function mealTime(m, key) {
  if (!m.createdAt) return null;
  const t = new Date(m.createdAt);
  if (isNaN(t) || dateKey(t) !== key) return null;
  return t;
}

/* 時刻から、どの食事のまとまりに入れるか。夕食が遅い人もいるので22時までは夜ごはん */
function mealGroup(h) {
  if (h < 4) return "夜食";
  if (h < 10) return "朝ごはん";
  if (h < 15) return "昼ごはん";
  if (h < 17) return "おやつ";
  if (h < 22) return "夜ごはん";
  return "夜食";
}

function hhmmOf(t) {
  return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
}

/* 1週間リスト用の短い日付ラベル。幅が狭いので「9/12(金)」程度に収める */
function weekLabel(key) {
  if (key === todayKey()) return "今日";
  if (key === shiftKey(todayKey(), -1)) return "昨日";
  const [y, m, d] = key.split("-").map(Number);
  const w = ["日", "月", "火", "水", "木", "金", "土"][new Date(y, m - 1, d).getDay()];
  return m + "/" + d + "(" + w + ")";
}

/* 棒の下に出す短い日付。狭いので「27(土)」程度に収める */
function weekShortLabel(key) {
  if (key === todayKey()) return "今日";
  const [y, m, d] = key.split("-").map(Number);
  const w = ["日", "月", "火", "水", "木", "金", "土"][new Date(y, m - 1, d).getDay()];
  return d + "(" + w + ")";
}

/* 棒の高さの上限（%）。これを超えた日は頭打ちにして、数字で示す */
const WEEK_MAX_RATE = 130;
/* 棒を置く箱の高さ(px)。style.css の .week-barbox と合わせる */
const WEEK_BAR_H = 96;

/* 直近7日の「消費に対して食べた割合」を棒で並べる。100%の位置に点線を引く。
   棒を押すとその日の表示に切り替わる（リング・チップ・食べたものが連動する） */
function renderWeek() {
  const box = document.getElementById("weekChart");
  box.innerHTML = "";

  if (!calcBmr(state.profile)) {
    const p = document.createElement("p");
    p.className = "hint";
    p.style.gridColumn = "1 / -1";
    p.style.textAlign = "center";
    p.textContent = "設定を入れると表示されます";
    box.appendChild(p);
    return;
  }

  // 古い日を左、今日を右にする（時間は左から右へ流れるほうが読みやすい）
  for (let i = 6; i >= 0; i--) {
    const key = shiftKey(todayKey(), -i);
    const burn = calcBurn(key);
    const intake = calcIntake(key);
    const rate = burn > 0 ? Math.round((intake / burn) * 100) : 0;
    const over = intake > burn;
    const selected = key === state.viewDate;

    const col = document.createElement("button");
    col.className =
      "week-col" + (over ? " over" : "") + (intake ? "" : " none") + (selected ? " sel" : "");
    col.setAttribute("role", "listitem");
    col.setAttribute(
      "aria-label",
      labelOf(key) +
        (intake
          ? " 食べた " + intake.toLocaleString() + " ／ 消費 " + burn.toLocaleString() + "（" + rate + "%）"
          : " 記録なし")
    );
    col.onclick = () => {
      state.viewDate = key;
      fillBurnForm();
      renderAll();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    // 数字は、選んでいる日とオーバーした日にだけ出す（全部に出すとうるさい）
    const rateEl = document.createElement("div");
    rateEl.className = "week-rate";
    rateEl.textContent = intake && (selected || over) ? rate + "%" : "";
    col.appendChild(rateEl);

    const barBox = document.createElement("div");
    barBox.className = "week-barbox";
    const bar = document.createElement("div");
    bar.className = "week-bar";
    bar.style.height = Math.round((Math.min(rate, WEEK_MAX_RATE) / WEEK_MAX_RATE) * WEEK_BAR_H) + "px";
    barBox.appendChild(bar);
    col.appendChild(barBox);

    const day = document.createElement("div");
    day.className = "week-day";
    day.textContent = weekShortLabel(key);
    col.appendChild(day);

    box.appendChild(col);
  }

  // 100%の目安線。棒の箱の実際の位置を測って引く（文字の高さが端末で違っても合うように）
  const firstBox = box.querySelector(".week-barbox");
  if (firstBox) {
    const line = document.createElement("div");
    line.className = "week-line";
    line.style.top =
      firstBox.offsetTop + firstBox.offsetHeight * (1 - 100 / WEEK_MAX_RATE) + "px";
    box.appendChild(line);
  }
}

function renderBmrBox() {
  const bmr = calcBmr(state.profile);
  document.getElementById("showBmr").textContent = bmr ? bmr.toLocaleString() : "—";
  document.getElementById("showTdee").textContent = bmr
    ? calcTdee(state.profile).toLocaleString()
    : "—";
}

/* ---------- 重なって出る画面（設定・入力シート・ダイアログ） ----------
   開くときにブラウザの履歴を1つ積んでおく。こうするとAndroidの「戻る」で
   アプリごと閉じてしまわず、開いている画面だけが閉じる。 */

function hideOverlay(el) {
  el.hidden = true;
  if (!document.querySelector(".overlay:not([hidden])")) {
    document.body.classList.remove("no-scroll");
  }
}

/* 「戻る」が終わるのを待っている間に開いた画面。
   ダイアログを閉じた直後に判定結果を開くと、閉じるための「戻る」があとから届いて
   判定結果まで消してしまうので、履歴に積むのは「戻る」が終わってからにする */
let backPending = false;
const deferredOverlays = new Set();

function openOverlay(el) {
  if (!el.hidden) return;
  el.hidden = false;
  document.body.classList.add("no-scroll");
  if (backPending) deferredOverlays.add(el.id);
  else history.pushState({ overlay: el.id }, "");
}

function closeOverlay(el) {
  if (el.hidden) return;
  // 自分が積んだ履歴なら「戻る」で閉じる（popstate の中で hideOverlay される）
  if (history.state && history.state.overlay === el.id) {
    backPending = true;
    history.back();
  } else hideOverlay(el);
}

/* 「戻る」で閉じるのは一番上の画面だけ。判定結果の上で「手で直す」を開いて閉じたとき、
   下の判定結果まで消えないよう、戻った先の履歴が指している画面は残す */
window.addEventListener("popstate", () => {
  backPending = false;
  const keep = history.state && history.state.overlay;
  document.querySelectorAll(".overlay:not([hidden])").forEach((el) => {
    if (el.id !== keep && !deferredOverlays.has(el.id)) hideOverlay(el);
  });
  deferredOverlays.forEach((id) => history.pushState({ overlay: id }, ""));
  deferredOverlays.clear();
});

/* 背景の暗いところを押したら閉じる（中身を押したときは閉じない） */
document.querySelectorAll(".sheet, .modal").forEach((el) => {
  el.addEventListener("click", (ev) => {
    if (ev.target === el) closeOverlay(el);
  });
});

/* ---------- 設定 ---------- */

const settingsPanel = document.getElementById("settingsPanel");

function openSettings(focusId) {
  openOverlay(settingsPanel);
  if (focusId) {
    const el = document.getElementById(focusId);
    setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus();
    }, 250);
  }
}

/* ---------- 下のタブ ---------- */
/* 画面を「きょう／おすすめ／きろく」の3つに分けて、押した1つだけを出す。
   起動したときは毎回「きょう」から（いちばんよく使うため） */
const tabButtons = document.querySelectorAll(".tabbar [data-tab]");

function showTab(pageId) {
  tabButtons.forEach((btn) => {
    const on = btn.dataset.tab === pageId;
    btn.setAttribute("aria-selected", String(on));
    document.getElementById(btn.dataset.tab).hidden = !on;
  });
  window.scrollTo({ top: 0 });
}

tabButtons.forEach((btn) => {
  btn.onclick = () => showTab(btn.dataset.tab);
});

document.getElementById("btnSettings").onclick = () => openSettings();
document.getElementById("btnCloseSettings").onclick = () => closeOverlay(settingsPanel);

/* 身長などが未入力のときは、リングを押すと「はじめに」が開く */
document.getElementById("hero").onclick = () => {
  if (!calcBmr(state.profile)) openWelcome();
};

/* 撮影ボタンの下の準備案内。はじめの設定まで直接連れていく */
document.getElementById("setupHint").onclick = openWelcome;

/* ---------- はじめての設定 ----------
   身長などが空のまま開いたときに、1問ずつ聞いていく。
   「次へ」のたびに保存するので、途中で閉じても入れたところまでは残る。 */

const welcomePanel = document.getElementById("welcomePanel");
const WELCOME_STEPS = 3;
let welcomeChecked = false; // 自動で出すのは起動して最初の1回だけ

const welcomeFields = [
  ["wHeight", "height", Number],
  ["wWeight", "weight", Number],
  ["wAge", "age", Number],
  ["wSex", "sex", String],
  ["wActivity", "activity", Number],
  ["wGoal", "goal", String],
];

function showWelcomeStep(n) {
  welcomePanel.querySelectorAll(".welcome-step").forEach((el) => {
    el.hidden = Number(el.dataset.step) !== n;
  });
  document.getElementById("welcomeCount").textContent = n + " / " + WELCOME_STEPS;
  welcomePanel.scrollTop = 0;
}

function openWelcome() {
  welcomeFields.forEach(([id, key]) => {
    const v = state.profile[key];
    if (v !== null && v !== undefined) document.getElementById(id).value = v;
  });
  showWelcomeStep(1);
  openOverlay(welcomePanel);
}

/* 設定の読み込みが終わった時点で、まだ何も入っていなければ出す */
function maybeOpenWelcome() {
  if (welcomeChecked) return;
  welcomeChecked = true;
  if (!calcBmr(state.profile)) openWelcome();
}

/* 1問目の答えがありえない数字なら止める（計算が狂うため） */
function checkWelcomeBody() {
  const h = Number(document.getElementById("wHeight").value);
  const w = Number(document.getElementById("wWeight").value);
  const a = Number(document.getElementById("wAge").value);
  if (!(h >= 100 && h <= 250)) return "身長をcmで入れてください。";
  if (!(w >= 25 && w <= 250)) return "体重をkgで入れてください。";
  if (!(a >= 10 && a <= 100)) return "年齢を入れてください。";
  return "";
}

async function saveWelcome() {
  welcomeFields.forEach(([id, key, cast]) => {
    const raw = document.getElementById(id).value;
    if (raw !== "") state.profile[key] = cast(raw);
  });
  fillSettingsForm();
  await storeProfile();
}

welcomePanel.querySelectorAll("[data-next]").forEach((btn) => {
  btn.onclick = async () => {
    if (btn.dataset.next === "2") {
      const err = checkWelcomeBody();
      if (err) {
        alert(err);
        return;
      }
    }
    showWelcomeStep(Number(btn.dataset.next));
    await saveWelcome();
  };
});

welcomePanel.querySelectorAll("[data-back]").forEach((btn) => {
  btn.onclick = () => showWelcomeStep(Number(btn.dataset.back));
});

/* スマホの種類を選んだら、それで準備は終わり。
   写真判定はみんなで使うAIがあるので、APIキーはここでは聞かない（「設定」から入れられる） */
welcomePanel.querySelectorAll("[data-burn-mode]").forEach((btn) => {
  btn.onclick = () => {
    state.profile.burnMode = btn.dataset.burnMode;
    finishWelcome();
  };
});

/* 保存の完了は待たずに閉じる。クラウドへの書き込みは圏外だと電波が戻るまで終わらず、
   待っていると「はじめに」が閉じなくなるため（画面にはすぐ反映される） */
function finishWelcome() {
  saveWelcome();
  closeOverlay(welcomePanel);
  showToast("準備できました");
}

document.getElementById("welcomeClose").onclick = () => closeOverlay(welcomePanel);

/* 機種変更の人は「はじめに」を閉じて、引き継ぎコードの欄へ。
   history.back() で閉じると、あとから来る popstate が設定まで閉じてしまうので、
   積んである履歴を設定画面のものに差し替える */
document.getElementById("welcomeTransfer").onclick = () => {
  hideOverlay(welcomePanel);
  syncInput.closest("details").open = true;
  settingsPanel.hidden = false;
  document.body.classList.add("no-scroll");
  history.replaceState({ overlay: settingsPanel.id }, "");
  setTimeout(() => {
    syncInput.scrollIntoView({ behavior: "smooth", block: "center" });
    syncInput.focus();
  }, 250);
};

/* ---------- 消費カロリーの入力シート ---------- */

const burnSheet = document.getElementById("burnSheet");

/* 入れ方（合計か、動いた分だけか）に合わせて、どの数字を入れるかの説明を変える */
const BURN_HOWTO = {
  total: {
    label: "消費カロリーの合計(kcal)",
    howTo: "Googleヘルス・Fitbitなどの「消費カロリー（消費エネルギー）」をそのまま入れてください。",
  },
  active: {
    label: "アクティブエネルギー(kcal)",
    howTo: "iPhoneのヘルスケア →「アクティブエネルギー」の今日の数字を入れてください。基礎代謝の分はアプリが足します。",
  },
};

function openBurnSheet() {
  fillBurnForm();
  const key = state.viewDate;
  const how = BURN_HOWTO[state.profile.burnMode] || BURN_HOWTO.total;
  document.getElementById("burnSheetTitle").textContent =
    key === todayKey() ? "今日の消費カロリー" : labelOf(key) + " の消費カロリー";
  document.getElementById("inActiveLabel").textContent = how.label;
  document.getElementById("burnHowTo").textContent = how.howTo;
  openOverlay(burnSheet);
  setTimeout(() => document.getElementById("inActive").focus(), 250);
}

document.getElementById("chipBurn").onclick = openBurnSheet;
document.getElementById("burnCancel").onclick = () => closeOverlay(burnSheet);

document.getElementById("burnSave").onclick = async () => {
  closeOverlay(burnSheet);
  if (await saveDaily()) showToast("保存しました");
};

/* キーボードの「決定」でも保存できるようにする */
document.getElementById("inActive").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    document.getElementById("burnSave").click();
  }
});

/* 寝る前のお知らせを押したら、今日の消費カロリーの入力をすぐ出す */
document.getElementById("reminder").onclick = () => {
  state.viewDate = todayKey();
  renderAll();
  openBurnSheet();
};

/* 日付を押したら今日に戻る */
document.getElementById("dayLabel").onclick = () => {
  if (state.viewDate === todayKey()) return;
  state.viewDate = todayKey();
  fillBurnForm();
  renderAll();
};

/* ---------- 設定フォーム ---------- */

const settingFields = [
  ["inHeight", "height", Number],
  ["inWeight", "weight", Number],
  ["inAge", "age", Number],
  ["inSex", "sex", String],
  ["inActivity", "activity", Number],
  ["inGoal", "goal", String],
  ["inBurnMode", "burnMode", String],
  ["inModel", "model", String],
  ["inShareRatio", "shareRatio", Number],
];

function fillSettingsForm() {
  buildModelSelect(); // モデルの選択肢は動的に作るので、値を入れる前に組み立てる

  settingFields.forEach(([id, key]) => {
    const el = document.getElementById(id);
    const v = state.profile[key];
    if (v !== null && v !== undefined && document.activeElement !== el) {
      el.value = v;
    }
  });
}

async function saveProfile() {
  settingFields.forEach(([id, key, cast]) => {
    const raw = document.getElementById(id).value;
    state.profile[key] = raw === "" ? null : cast(raw);
  });
  await storeProfile();
}

/* いまの state.profile を保存する（設定画面と「はじめに」の両方から使う） */
async function storeProfile() {
  // APIキーはプロフィールに混ぜない（クラウドに送らないため）
  const payload = {};
  settingFields.forEach(([, key]) => (payload[key] = state.profile[key]));

  /* 置き場所を "me" に固定する。以前は「無ければ新規作成」にしていたため、
     設定を続けて触ると作成が二重に走り、片方の設定が永久に反映されないことがあった。 */
  try {
    await Store.setDoc("profile", PROFILE_ID, payload);
    state.profileId = PROFILE_ID;
  } catch (e) {
    notifySaveFailed(e, "設定の保存");
  }
  renderAll();
}

settingFields.forEach(([id, key, cast]) => {
  const el = document.getElementById(id);

  // 入力している最中は画面の数字だけ先に追従させる
  el.addEventListener("input", () => {
    const raw = el.value;
    state.profile[key] = raw === "" ? null : cast(raw);
    renderAll();
  });

  // 入力を確定したタイミングで保存する
  el.addEventListener("change", saveProfile);
});

/* APIキーの入出力 */
const apiKeyInput = document.getElementById("inApiKey");
apiKeyInput.value = getApiKey();
apiKeyInput.addEventListener("change", () => {
  setApiKey(apiKeyInput.value.trim());
  renderAll(); // 撮影ボタンの下の準備案内を消すため
});

/* ---------- 同期コードの操作 ---------- */

const syncInput = document.getElementById("inSyncCode");

syncInput.addEventListener("change", () => {
  const v = syncInput.value.trim();

  if (v === getSyncCode()) return;

  if (v.length < 16) {
    alert("引き継ぎコードは16文字以上にしてください。");
    syncInput.value = getSyncCode();
    return;
  }

  setSyncCode(v);
  alert("引き継ぎコードを変えました。読み込み直します。");
  location.reload();
});

document.getElementById("btnCopyCode").onclick = async () => {
  try {
    await navigator.clipboard.writeText(syncInput.value);
    alert("引き継ぎコードをコピーしました。新しいスマホの「設定」→「機種変更・バックアップ」に貼り付けてください。");
  } catch (e) {
    // https以外ではクリップボードが使えないので、選択状態にして手でコピーしてもらう
    syncInput.focus();
    syncInput.select();
    alert("自動でコピーできませんでした。選択されている文字をコピーしてください。");
  }
};

document.getElementById("btnNewCode").onclick = () => {
  const ok = confirm(
    "引き継ぎコードを作り直すと、今までの記録は見えなくなります。よろしいですか？"
  );
  if (!ok) return;
  setSyncCode(makeSyncCode());
  location.reload();
};

/* ---------- 日付の移動と運動の入力 ---------- */

document.getElementById("dayPrev").onclick = () => {
  state.viewDate = shiftKey(state.viewDate, -1);
  fillBurnForm();
  renderAll();
};

document.getElementById("dayNext").onclick = () => {
  if (state.viewDate >= todayKey()) return;
  state.viewDate = shiftKey(state.viewDate, 1);
  fillBurnForm();
  renderAll();
};

function fillBurnForm() {
  const d = dailyOf(state.viewDate);
  const active = document.getElementById("inActive");
  if (document.activeElement !== active) active.value = d.activeKcal || "";
  document.getElementById("activeUpdated").textContent = updatedLabel(d.updatedAt);
}

/* 入力シートの「保存」で呼ぶ。保存できたら true を返す */
async function saveDaily() {
  const key = state.viewDate;
  const patch = {
    date: key,
    activeKcal: Number(document.getElementById("inActive").value) || 0,
    burnMode: state.profile.burnMode || "total", // 合計か動いた分だけか（calcBurnDetail 参照）
    updatedAt: new Date().toISOString(), // いつの時点の数字かを残す
  };
  /* 日付そのものを置き場所にする。続けて入力したときに
     同じ日の記録が2つできてしまうのを防ぐ。 */
  try {
    await Store.setDoc("daily", key, patch);
  } catch (e) {
    notifySaveFailed(e, "運動の記録");
    return false;
  }
  renderAll();
  return true;
}

/* ---------- 写真の読み込みと縮小 ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした。"));
    };
    img.src = url;
  });
}

/* 長辺を maxSide まで縮めてJPEGのdataURLにする */
function shrink(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/* ---------- Gemini に判定してもらう ---------- */

const JUDGE_PROMPT = `この写真に写っている食べ物・飲み物を判定してください。日本語で答えてください。

- パッケージの栄養成分表示が読み取れる場合は、その数値を最優先で使ってください。
- calories には「写真に写っている量ぜんぶ」の合計カロリーを入れてください。100gあたりの値ではありません。
- name は25文字以内で簡潔に。おかずが何品もある食事は品名を並べず「鶏ソテー定食」のようにまとめて呼んでください。
- portion には「1袋 60g」「茶碗1杯 150g」のように、写っている量を書いてください。品数が多い食事は、ここに中身を書いてください。
- protein_g・fat_g・carbs_g には、写っている量ぜんぶの たんぱく質・脂質・炭水化物 をグラムで入れてください。栄養成分表示があればその値を使ってください。
- 食べ物でも飲み物でもない写真なら is_food を false にしてください。
- note には、どうやってカロリーを見積もったかを1文で簡潔に書いてください。`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_food: { type: "BOOLEAN" },
    name: { type: "STRING" },
    portion: { type: "STRING" },
    calories: { type: "INTEGER" },
    protein_g: { type: "NUMBER" },
    fat_g: { type: "NUMBER" },
    carbs_g: { type: "NUMBER" },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    note: { type: "STRING" },
  },
  required: ["is_food", "name", "portion", "calories", "protein_g", "fat_g", "carbs_g", "confidence", "note"],
};

/* 混雑・一時障害。待てば直るので投げ返さずに試し直す */
const RETRYABLE_STATUS = [500, 502, 503, 504];
/* 何ミリ秒待ってから次を試すか。長すぎると撮り直したほうが早くなる */
const BACKOFF_MS = [1500, 4000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* 成功したレスポンスから判定結果を取り出す */
function parseJudgement(data) {
  if (data && data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error("この写真は安全フィルタにかかって判定できませんでした。別の写真で試してください。");
  }

  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    throw new Error("判定結果が返ってきませんでした。もう一度試してください。");
  }
  if (cand.finishReason && cand.finishReason !== "STOP") {
    throw new Error("判定が途中で止まりました（" + cand.finishReason + "）。もう一度試してください。");
  }

  // 思考パート(thought)が混ざることがあるので除いてから連結する
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("");

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("判定結果を読み取れませんでした。もう一度試してください。");
  }
}

/* 写真を判定する。

   混み合っている（503）だけで撮り直させるのは無駄なので、写真を持ったまま
   間を空けて試し直し、最後の1回は別のモデルへ逃がす。
   キーの誤りと使いすぎは待っても直らないので、その場で理由を出して止める。 */
async function askGemini(base64) {
  const judgingText = document.getElementById("judgingText");
  judgingText.textContent = "判定中…";

  return callGemini(
    [
      { inline_data: { mime_type: "image/jpeg", data: base64 } },
      { text: JUDGE_PROMPT },
    ],
    RESPONSE_SCHEMA,
    (n, total, why) => {
      // 黙って数秒止まると壊れたように見えるので、試し直していることを出す
      judgingText.textContent =
        why === "quota"
          ? "今日の通常版の枠を使い切ったので、簡易版で判定しています…"
          : "混み合っています。もう一度試しています（" + n + "/" + total + "）";
    }
  );
}

/* みんなで使うAI（Firebase AI Logic）で使うモデル。
   写真判定は Flash、提案は軽い Flash-Lite（無料枠はモデルごとに別なので、提案が判定の枠を食わない）。
   ただ Flash-Lite は混雑で 500 が続く日があったので、だめなら Flash に逃がす */
const LITE_MODEL = "gemini-3.5-flash-lite";
const SHARED_JUDGE = { models: [DEFAULT_MODEL, DEFAULT_MODEL, LITE_MODEL], timeoutMs: 45000 };
const SHARED_SUGGEST = { models: [LITE_MODEL, DEFAULT_MODEL], timeoutMs: 30000 };

/* 使いすぎ（429）のとき、Flash-Lite に切り替えられるなら残りの候補を Lite だけにして true を返す。
   無料枠は1日あたり Flash 20回・Lite 500回（2026-11-06実測）で、枠はモデルごとに別。
   Flash を使い切っても Lite はまだ残っていることが多いので、止めずに簡易版で判定を続ける。
   同じモデルで試し直すと枠を余計に食うだけなので、それはしない */
function switchToLiteOnQuota(models, i) {
  if (models.slice(0, i + 1).indexOf(LITE_MODEL) >= 0) return false;
  models.splice(i + 1, models.length, LITE_MODEL);
  return true;
}

/* Geminiに頼んで、決めた形（schema）のJSONで答えをもらう。
   写真判定と「次の食事のおすすめ」の両方から使う。
   自分のAPIキーを入れている人はそのキーで、入れていない人はみんなで使うAIで呼ぶ */
async function callGemini(parts, schema, onRetry, shared) {
  const key = getApiKey();
  if (!key) {
    if (!sharedAiAvailable()) {
      throw new Error("この開き方ではAIを使えません。公開サイトから開いてください。");
    }
    return callSharedGemini(parts, schema, onRetry, shared || SHARED_JUDGE);
  }

  const body = {
    contents: [{ parts: parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  const models = [resolveModel(), resolveModel(), fallbackModel()];
  let lastError = null;
  let quotaSwitch = false;

  for (let i = 0; i < models.length; i++) {
    if (quotaSwitch) {
      if (onRetry) onRetry(i + 1, models.length, "quota");
      quotaSwitch = false;
    } else if (i > 0) {
      if (onRetry) onRetry(i + 1, models.length);
      await sleep(BACKOFF_MS[i - 1]);
    }

    const model = models[i];
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent";

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = new Error("通信できませんでした。ネットワークの状態を確認してください。");
      continue;
    }

    const data = await res.json().catch(() => null);
    if (res.ok) return parseJudgement(data);

    const msg = (data && data.error && data.error.message) || "HTTP " + res.status;

    // キーの誤りはモデルを変えても直らない
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error("APIキーが正しくないようです。下の「設定」を見直してください。\n\n" + msg);
    }
    // 使いすぎは待っても直らない。同じモデルで試し直すと枠を余計に食うだけなので、枠が別の Lite に切り替える
    if (res.status === 429) {
      if (switchToLiteOnQuota(models, i)) {
        quotaSwitch = true;
        lastError = new Error("無料枠の上限に達しました。\n\n" + model + " / HTTP 429 / " + msg);
        continue;
      }
      throw new Error("無料枠の上限に達しました。しばらく待ってからもう一度試してください。\n\n" + model + " / HTTP 429 / " + msg);
    }
    // モデル名が古い場合。一覧を取り直せば直るので、まず別のモデルを試す
    if (res.status === 404) {
      lastError = new Error(
        "モデル「" + model + "」が使えませんでした。下の「設定」でモデル一覧を取り直してください。\n\n" + msg
      );
      continue;
    }
    if (RETRYABLE_STATUS.indexOf(res.status) >= 0) {
      lastError = new Error(
        "混み合っていて判定できませんでした。少し待ってからもう一度試してください。\n\n" +
          model + " / HTTP " + res.status + " / " + msg
      );
      continue;
    }
    throw new Error("判定に失敗しました。\n\n" + msg);
  }

  throw lastError || new Error("判定に失敗しました。もう一度試してください。");
}

/* みんなで使うAIで呼ぶ。試し直しの考え方は自分のキーのときと同じ
   （混雑は待って試し直す、使いすぎは待っても直らないのですぐ止める） */
async function callSharedGemini(parts, schema, onRetry, shared) {
  const models = shared.models.slice(); // 429で書き換えるので元の設定は触らない
  let lastError = null;
  let quotaSwitch = false;

  for (let i = 0; i < models.length; i++) {
    if (quotaSwitch) {
      if (onRetry) onRetry(i + 1, models.length, "quota");
      quotaSwitch = false;
    } else if (i > 0) {
      if (onRetry) onRetry(i + 1, models.length);
      await sleep(BACKOFF_MS[i - 1] || BACKOFF_MS[BACKOFF_MS.length - 1]);
    }

    let text;
    try {
      text = await sharedGenerate(models[i], parts, schema, shared.timeoutMs);
    } catch (e) {
      const status = sharedErrorStatus(e);
      console.warn("shared AI error", status, e && e.message);

      if (status === 429) {
        // Flash を使い切っても、枠が別の Lite が残っていればそちらで続ける
        if (switchToLiteOnQuota(models, i)) {
          quotaSwitch = true;
          lastError = new Error("今日のAIの無料枠（みんなで共有）を使い切りました。夕方に戻ります。");
          continue;
        }
        // 無料枠の1日分は日本時間の16〜17時ごろ（米国太平洋時間の0時）に戻る
        throw new Error(
          "今日のAIの無料枠（みんなで共有）を使い切りました。夕方に戻ります。\n" +
            "それまでは「写真なしで入力する」から、カロリーを入れて判定してください。"
        );
      }
      if (status === 401 || status === 403) {
        throw new Error("AIにつながりませんでした（アプリの確認に失敗）。開き直してもう一度試してください。");
      }
      if (status === 404) {
        lastError = new Error("AIのモデル「" + models[i] + "」が使えませんでした。");
        continue;
      }
      if (!status || RETRYABLE_STATUS.indexOf(status) >= 0) {
        lastError = new Error(
          status
            ? "混み合っていて判定できませんでした。少し待ってからもう一度試してください。"
            : "AIから返事がありませんでした。電波の状態を確認するか、少し待ってからもう一度試してください。"
        );
        continue;
      }
      throw new Error("AIの呼び出しに失敗しました。\n\n" + ((e && e.message) || ""));
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      lastError = new Error("AIの答えを読み取れませんでした。もう一度試してください。");
    }
  }

  throw lastError || new Error("AIの呼び出しに失敗しました。もう一度試してください。");
}

/* ---------- 次の食事のおすすめ（AI版） ----------
   AIが使えるときだけ出す。無料枠を使いすぎないよう、
   食事を記録した直後に1回だけ作って端末に取っておき、画面を開くたびには呼ばない。
   作り直すのは「別の案」を押したときだけ */

const AI_SUGGEST_STORAGE = "korekutte_ai_suggest";
let aiSuggestBusy = false;

const SUGGEST_SCHEMA = {
  type: "OBJECT",
  properties: {
    advice: { type: "STRING" },
    menus: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          place: { type: "STRING", enum: ["コンビニ", "外食", "自炊"] },
          name: { type: "STRING" },
          detail: { type: "STRING" },
          kcal: { type: "INTEGER" },
          protein_g: { type: "NUMBER" },
          fat_g: { type: "NUMBER" },
          carbs_g: { type: "NUMBER" },
        },
        required: ["place", "name", "detail", "kcal", "protein_g", "fat_g", "carbs_g"],
      },
    },
  },
  required: ["advice", "menus"],
};

/* 自分のキーが無くても、みんなで使うAIがあるので基本は使える */
function canUseAi() {
  return !!getApiKey() || sharedAiAvailable();
}

/* 今日の記録の「指紋」。記録が増えたり消えたりしたら、取っておいた提案は古い */
function aiSuggestSig(slot) {
  const ids = mealsOf(todayKey()).map((m) => m.id + ":" + m.kcal + (m.plan ? "p" : "")).sort().join(",");
  return todayKey() + "|" + slot + "|" + ids;
}

function readAiSuggest() {
  try {
    return JSON.parse(localStorage.getItem(AI_SUGGEST_STORAGE) || "null");
  } catch (e) {
    return null;
  }
}

function writeAiSuggest(v) {
  try {
    localStorage.setItem(AI_SUGGEST_STORAGE, JSON.stringify(v));
  } catch (e) {
    // 保存できなくても、その場の表示はできるので何もしない
  }
}

function renderAiSuggest(statusText) {
  const box = document.getElementById("suggestAi");
  box.hidden = !canUseAi();
  if (box.hidden) return;

  const s = currentSuggestion();
  const saved = readAiSuggest();
  const fresh = saved && saved.sig === aiSuggestSig(s.slot);

  const btn = document.getElementById("btnAiSuggest");
  btn.disabled = aiSuggestBusy;
  btn.textContent = aiSuggestBusy ? "考え中…" : fresh ? "別の案" : "AIに提案してもらう";

  const status = document.getElementById("aiStatus");
  status.hidden = !statusText;
  status.textContent = statusText || "";

  const advice = document.getElementById("aiAdvice");
  const ul = document.getElementById("aiMenus");
  ul.innerHTML = "";
  advice.hidden = !fresh;
  if (!fresh) return;

  advice.textContent = saved.advice;
  saved.menus.forEach((m) => ul.appendChild(menuItem(m)));
}

/* AIに渡す、今日の状況のまとめ */
function aiSuggestPrompt(s) {
  const key = todayKey();
  const target = calcTarget(key);
  const pt = calcPfcTarget(key);
  const intake = calcPfcIntake(key).sum;
  const meals = mealsOf(key).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

  const mealLines = meals.length
    ? meals
        .map((m) => {
          const t = m.createdAt ? new Date(m.createdAt) : null;
          const time = t ? t.getHours() + ":" + String(t.getMinutes()).padStart(2, "0") + " " : "";
          const p = pfcOf(m);
          if (m.plan) {
            return "  - 予定（まだ食べていない・" + (m.planSlot || "夜") + "）: " + m.name +
              "（" + m.portion + "）" + m.kcal + "kcal " + (p ? pfcText(p, " ") : "");
          }
          return "  - " + time + m.name + (m.portion ? "（" + m.portion + "）" : "") + " " + m.kcal + "kcal " +
            (p ? pfcText(p, " ") : "PFC不明");
        })
        .join("\n")
    : "  - まだ何も食べていない";

  const trend = trendText(calcWeekTrend());
  const remain = calcRemain(key);

  return [
    "あなたはダイエット中の人を応援する食事アドバイザーです。今日の記録を見て、" +
      (s.over ? "このあと食べるならのおすすめ" : "次の" + SLOT_LABEL[s.slot] + "のおすすめ") +
      "を日本語で提案してください。",
    "",
    "- 目標: " + (GOAL_TEXT[state.profile.goal] || "維持"),
    "- 今日の目標: " + target + "kcal（P " + pt.protein + "g・F " + pt.fat + "g・C " + pt.carbs + "g）",
    "- 今日食べたもの:",
    mealLines,
    "- 食べた合計: " + calcIntake(key) + "kcal（" + pfcText(intake, "・") + "）" +
      (calcPlanned(key) ? "。このうち " + calcPlanned(key) + "kcal は外食の予定の目安" : ""),
    s.over
      ? "- 今日は目標を " + Math.abs(remain) + "kcal 超えている。食べるなら " + s.budget + "kcal 以下"
      : "- 残り: " + remain + "kcal。次の" + SLOT_LABEL[s.slot] + "の目安は " + s.budget + "kcal",
    trend ? "- " + trend : "",
    "",
    "ルール:",
    "- コンビニ・外食・自炊から1つずつ、合計3案。日本で手に入りやすい具体的なメニューにする",
    "- 店名・チェーン名・商品名は出さず、「焼き魚定食」「サラダチキン」のような一般的な名前にする",
    "- kcal と PFC は1人前の目安。目安のkcalを大きく超えない",
    "- 足りない栄養素を補い、取りすぎている栄養素は控えめにする",
    "- name は20文字以内。detail は量や選び方のコツを20文字程度で",
    "- advice は今日の食事を踏まえた一言を2文以内で。責める言い方はしない",
    plansOf(key).length ? "- 外食の予定がある。その分は残りから引いてあるので、予定の前の食事として軽めにする" : "",
  ].join("\n");
}

async function requestAiSuggest() {
  if (aiSuggestBusy || !canUseAi()) return;
  const s = currentSuggestion();
  aiSuggestBusy = true;
  renderAiSuggest();

  let status = "";
  try {
    const res = await callGemini([{ text: aiSuggestPrompt(s) }], SUGGEST_SCHEMA, null, SHARED_SUGGEST);
    writeAiSuggest({
      sig: aiSuggestSig(s.slot),
      advice: String(res.advice || ""),
      menus: (res.menus || []).slice(0, 3).map((m) => ({
        place: m.place,
        name: m.name,
        detail: m.detail,
        kcal: Math.max(0, Math.round(Number(m.kcal) || 0)),
        protein: gramOf(m.protein_g) || 0,
        fat: gramOf(m.fat_g) || 0,
        carbs: gramOf(m.carbs_g) || 0,
      })),
    });
  } catch (e) {
    status = "AIの提案を作れませんでした。上のおすすめを参考にしてください。\n" + ((e && e.message) || "");
  } finally {
    aiSuggestBusy = false;
  }
  renderAiSuggest(status);
}

document.getElementById("btnAiSuggest").onclick = requestAiSuggest;

/* 今日の食事を記録したあとに呼ぶ。AIが使えるなら、次の提案を1回だけ作っておく */
function afterMealRecorded(dateKeyRecorded) {
  if (dateKeyRecorded !== todayKey()) return;
  pickedSlot = null; // 食べたので、次の食事は時刻から決め直す
  renderSuggest();
  if (canUseAi()) requestAiSuggest();
}

/* ---------- 判定の流れ ---------- */

const photoInput = document.getElementById("photoInput");
const judgingEl = document.getElementById("judging");
const errorEl = document.getElementById("judgeError");
const verdictEl = document.getElementById("verdict");

photoInput.addEventListener("change", async () => {
  const file = photoInput.files && photoInput.files[0];
  photoInput.value = ""; // 同じ写真をもう一度選べるようにする
  if (!file) return;

  if (!calcBmr(state.profile)) {
    showError("先に下の「設定」で、身長・体重・年齢を入れてください。");
    return;
  }

  errorEl.hidden = true;
  verdictEl.hidden = true;
  judgingEl.hidden = false;

  try {
    const img = await loadImage(file);
    const big = shrink(img, 1024, 0.85); // AIに送る用
    const thumb = shrink(img, 160, 0.6); // 記録に残す小さい画像
    const base64 = big.split(",")[1];

    const food = await askGemini(base64);

    if (!food.is_food) {
      throw new Error("食べ物が写っていないようです。もう一度撮ってみてください。");
    }

    state.pending = {
      name: food.name,
      portion: food.portion,
      kcal: Math.max(0, Math.round(Number(food.calories) || 0)),
      protein: gramOf(food.protein_g),
      fat: gramOf(food.fat_g),
      carbs: gramOf(food.carbs_g),
      note: food.note,
      confidence: food.confidence,
      thumb: thumb,
      photo: big,
    };
    showVerdict();
  } catch (e) {
    showError(e.message);
  } finally {
    judgingEl.hidden = true;
  }
});

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  verdictEl.hidden = true;
}

/* ---------- 大皿の取り分け ----------
   AIは「写っている量ぜんぶ」で見積もるので、大皿だと家族全員の分になる。
   分ける前の数字（base）を残しておき、選んだ割合を掛けて自分の分にする */

function shareChoices() {
  const mine = Number(state.profile.shareRatio) || 0.6;
  const list = [
    [1, "ぜんぶ"],
    [mine, Math.round(mine * 10) + "割"],
    [1 / 2, "半分"],
    [1 / 3, "1/3"],
    [1 / 4, "1/4"],
  ];
  // いつもの割合が5割のときは「半分」と重なるので1つにする
  return list.filter(([v], i) => list.findIndex(([w]) => Math.abs(w - v) < 0.01) === i);
}

function shareLabel(r) {
  const hit = shareChoices().find(([v]) => Math.abs(v - r) < 0.01);
  return hit ? hit[1] : Math.round(r * 100) + "%";
}

/* 判定待ちの食べ物に割合を当てる。PFCが不明（null）のものは不明のまま */
function applyShare(f, r) {
  if (!f.base) {
    f.base = { kcal: f.kcal, portion: f.portion || "" };
    PFC_KEYS.forEach((k) => (f.base[k] = f[k]));
  }
  f.share = r;
  f.kcal = Math.round(f.base.kcal * r);
  PFC_KEYS.forEach((k) => (f[k] = f.base[k] === null || f.base[k] === undefined ? null : gramOf(f.base[k] * r)));
  f.portion = r < 1 ? "大皿の" + shareLabel(r) + (f.base.portion ? "（全体 " + f.base.portion + "）" : "") : f.base.portion;
}

function renderShareTabs() {
  const f = state.pending;
  const box = document.getElementById("shareTabs");
  box.innerHTML = "";
  box.style.gridTemplateColumns = "repeat(" + shareChoices().length + ", 1fr)";
  shareChoices().forEach(([v, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(Math.abs((f.share || 1) - v) < 0.01));
    btn.onclick = () => {
      applyShare(state.pending, v);
      renderVerdict();
    };
    box.appendChild(btn);
  });
}

/* 判定結果を全画面で出す。開き直すたびにハンコの動きをもう一度見せる */
function showVerdict() {
  renderVerdict();
  // おすすめのタブから判定したときも、結果は「きょう」のタブに出す
  if (document.getElementById("pageToday").hidden) showTab("pageToday");
  errorEl.hidden = true;
  verdictEl.scrollTop = 0;
  openOverlay(verdictEl);
}

/* 判定結果の中身だけ描き直す（取り分けを選び直したとき） */
function renderVerdict() {
  const f = state.pending;
  const remain = calcRemain(todayKey());
  const mark = decide(f.kcal, remain);

  verdictEl.className = "overlay verdict-screen " + mark;
  renderVerdictRing(f.kcal);
  // キーなしで手入力から判定したときは写真が無い
  const photo = document.getElementById("verdictPhoto");
  photo.hidden = !f.photo;
  if (f.photo) photo.src = f.photo;
  document.getElementById("verdictHeadline").textContent = VERDICT_TEXT[mark];
  document.getElementById("verdictName").textContent = f.name;
  document.getElementById("verdictPortion").textContent = f.portion || "";
  document.getElementById("verdictKcal").textContent = f.kcal.toLocaleString();
  const pfc = pfcOf(f);
  document.getElementById("verdictPfc").textContent = pfc ? pfcText(pfc) : "";

  let note = f.note || "";
  if (f.confidence === "low") note += "（推定の確からしさは低めです）";
  // 食べたあとに残る量はリングで見せるので、ここには書かない。今すでにオーバーしているときだけ添える
  if (mark === "stop" && remain <= 0) note += "　今日はもう目標を超えています。";
  document.getElementById("verdictNote").textContent = note;
  renderShareTabs();
}

/* 判定結果のリング。今日すでに食べた分（灰）の先に、これを食べた分（結果の色）を足して描く */
function renderVerdictRing(kcal) {
  const key = todayKey();
  const target = calcTarget(key);
  const intake = calcIntake(key);
  const after = target - intake - kcal;
  // オーバーするときは「食べた合計」を一周にして、灰と色の両方が見えるようにする
  const full = Math.max(target, intake + kcal);
  const part = (v) => (full > 0 ? Math.max(0, Math.min(1, v / full)) : 1);

  document.getElementById("vringNow").style.strokeDashoffset = RING_LENGTH * (1 - part(intake));
  document.getElementById("vringAdd").style.strokeDashoffset = RING_LENGTH * (1 - part(intake + kcal));

  document.getElementById("vringLabel").textContent = after < 0 ? "食べたら" : "食べても";
  document.getElementById("vringValue").textContent =
    (after < 0 ? "+" : "") + Math.abs(after).toLocaleString();
  document.getElementById("vringUnit").textContent = after < 0 ? "kcal オーバー" : "kcal 残る";
}

const btnEat = document.getElementById("btnEat");

btnEat.onclick = async () => {
  const f = state.pending;
  if (!f) return;

  // 保存が終わるまで押せなくする。反応が無いと二度押しされ、同じ食事が2件入るため
  btnEat.disabled = true;
  const label = btnEat.textContent;
  btnEat.textContent = "記録中…";

  try {
    await Store.add("meals", {
      date: todayKey(),
      name: f.name,
      portion: f.portion || "",
      kcal: f.kcal,
      protein: gramOf(f.protein),
      fat: gramOf(f.fat),
      carbs: gramOf(f.carbs),
      thumb: f.thumb || "",
      share: f.share && f.share < 1 ? Math.round(f.share * 1000) / 1000 : 1,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // 保存できなかったときは判定結果を消さずに残しておく
    notifySaveFailed(e, "記録");
    return;
  } finally {
    btnEat.disabled = false;
    btnEat.textContent = label;
  }

  state.pending = null;
  closeOverlay(verdictEl);

  const remain = calcRemain(todayKey());
  showToast(
    remain > 0
      ? "記録しました　残り " + remain.toLocaleString() + " kcal"
      : "記録しました　今日はオーバーしています"
  );
  afterMealRecorded(todayKey());
};

document.getElementById("btnSkip").onclick = () => {
  state.pending = null;
  closeOverlay(verdictEl);
};

/* 判定結果のカロリーを手で直す */
document.getElementById("btnFixKcal").onclick = () => {
  const f = state.pending;
  if (!f) return;
  // 取り分けているときは、分ける前（お皿ぜんぶ）の数字を直してもらい、同じ割合を掛け直す
  const shared = f.base && f.share < 1;
  const initial = shared ? Object.assign({ name: f.name }, f.base) : f;
  openModal(shared ? "お皿ぜんぶの量を直す" : "カロリー・PFCを直す", initial, (edited) => {
    const r = f.share || 1;
    Object.assign(state.pending, edited);
    state.pending.base = null;
    applyShare(state.pending, r);
    showVerdict();
  });
};

/* ---------- 手入力のダイアログ ---------- */

const modal = document.getElementById("modal");
let modalCallback = null;

const PFC_INPUTS = { protein: "mProtein", fat: "mFat", carbs: "mCarbs" };

function openModal(title, initial, onOk, okLabel) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("mOk").textContent = okLabel || "決定";
  document.getElementById("mName").value = (initial && initial.name) || "";
  document.getElementById("mPortion").value = (initial && initial.portion) || "";
  document.getElementById("mKcal").value = (initial && initial.kcal) || "";
  PFC_KEYS.forEach((k) => {
    const v = initial ? initial[k] : null;
    document.getElementById(PFC_INPUTS[k]).value = v === null || v === undefined ? "" : v;
  });
  resetFoodSearch();
  modalCallback = onOk;
  openOverlay(modal);
  // 新しく入れるときは食品検索から、直すときはカロリーから
  setTimeout(() => document.getElementById(initial ? "mKcal" : "mSearch").focus(), 100);
}

/* ---------- 食品検索（ダイアログの中） ----------
   選ぶと、名前・量・カロリー・PFCがまとめて入る。量を変えると数字も追従する。
   入ったあとに手で直すのも自由 */

const searchInput = document.getElementById("mSearch");
const resultsEl = document.getElementById("mResults");
const amountRow = document.getElementById("mAmountRow");
const amountInput = document.getElementById("mAmount");
let pickedFood = null;
let searchTimer = null;

function resetFoodSearch() {
  searchInput.value = "";
  resultsEl.hidden = true;
  resultsEl.innerHTML = "";
  amountRow.hidden = true;
  pickedFood = null;
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runFoodSearch, 150);
});

async function runFoodSearch() {
  const q = searchInput.value.trim();
  if (!q) {
    resultsEl.hidden = true;
    return;
  }
  try {
    await loadFoods();
  } catch (e) {
    resultsEl.innerHTML = '<li class="food-none">食品データを読み込めませんでした。電波の良いところで開き直してください。</li>';
    resultsEl.hidden = false;
    return;
  }
  if (searchInput.value.trim() !== q) return; // 読み込み中に打ち変えられた

  const hits = searchFoods(q);
  resultsEl.innerHTML = "";
  if (!hits.length) {
    const li = document.createElement("li");
    li.className = "food-none";
    li.textContent = "見つかりませんでした。別の言い方で探すか、下に手で入れてください。";
    resultsEl.appendChild(li);
  }
  hits.forEach((f) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";

    const label = document.createElement("span");
    label.textContent = f.name;
    const sub = document.createElement("small");
    sub.textContent = f.kind === "common" ? f.unit : "成分表（100gあたり）";
    label.appendChild(sub);

    const kcal = document.createElement("span");
    kcal.className = "food-kcal";
    kcal.textContent = f.kcal + "kcal";

    btn.append(label, kcal);
    btn.onclick = () => pickFood(f);
    li.appendChild(btn);
    resultsEl.appendChild(li);
  });
  resultsEl.hidden = false;
}

function pickFood(f) {
  pickedFood = f;
  resultsEl.hidden = true;
  searchInput.value = f.name;

  // よく食べるものは「1回分 × 何回分」、成分表の食品は「何グラム」で量を決める
  const common = f.kind === "common";
  document.getElementById("mAmountUnit").textContent = common ? f.unit : "";
  document.getElementById("mAmountTimes").hidden = !common;
  document.getElementById("mAmountSuffix").textContent = common ? "人前・個" : "g";
  amountInput.value = common ? 1 : 100;
  amountRow.hidden = false;
  applyFoodAmount();
}

function applyFoodAmount() {
  const f = pickedFood;
  if (!f) return;
  const amount = Number(amountInput.value) || 0;
  const common = f.kind === "common";
  const factor = common ? amount : amount / 100;

  document.getElementById("mName").value = f.name;
  // 「100g」のようにグラムだけの1回分は、×1.5 ではなく 150g と書く
  const unitGram = common && /^(\d+)g$/.exec(f.unit);
  document.getElementById("mPortion").value = !common
    ? amount + "g"
    : unitGram
    ? Math.round(Number(unitGram[1]) * amount) + "g"
    : f.unit + (amount === 1 ? "" : " ×" + amount);
  document.getElementById("mKcal").value = Math.round(f.kcal * factor);
  PFC_KEYS.forEach((k) => {
    document.getElementById(PFC_INPUTS[k]).value = Math.round(f[k] * factor * 10) / 10;
  });
}

amountInput.addEventListener("input", applyFoodAmount);

document.getElementById("mCancel").onclick = () => {
  closeOverlay(modal);
  modalCallback = null;
};

document.getElementById("mOk").onclick = () => {
  const name = document.getElementById("mName").value.trim();
  const kcal = Number(document.getElementById("mKcal").value);
  if (!name) {
    alert("食べたものの名前を入れてください。");
    return;
  }
  if (!kcal || kcal < 0) {
    alert("カロリーを数字で入れてください。");
    return;
  }
  const cb = modalCallback;
  closeOverlay(modal);
  modalCallback = null;
  if (cb) {
    const edited = {
      name: name,
      portion: document.getElementById("mPortion").value.trim(),
      kcal: Math.round(kcal),
    };
    PFC_KEYS.forEach((k) => (edited[k] = gramOf(document.getElementById(PFC_INPUTS[k]).value)));
    cb(edited);
  }
};

/* 手入力で1件足す。dateKey を渡すと、その日に記録できる（昨日の入れ忘れなど） */
function openManualAdd(dateKeyToUse, title) {
  openModal(title, null, async (edited) => {
    try {
      await Store.add("meals", {
        date: dateKeyToUse,
        name: edited.name,
        portion: edited.portion,
        kcal: edited.kcal,
        protein: edited.protein,
        fat: edited.fat,
        carbs: edited.carbs,
        thumb: "",
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      notifySaveFailed(e, "記録");
      return;
    }

    showToast(
      dateKeyToUse === todayKey()
        ? "記録しました　残り " + calcRemain(todayKey()).toLocaleString() + " kcal"
        : labelOf(dateKeyToUse) + " に記録しました"
    );
    afterMealRecorded(dateKeyToUse);
  });
}

document.getElementById("btnManualOpen").onclick = () => {
  openManualAdd(todayKey(), "写真なしで追加");
};

/* 写真なしで判定する。カロリーを入れてもらい、写真のときと同じ判定を出す。
   initial を渡すと、その数字が入った状態で開く（おすすめの献立から開くとき） */
function openJudge(initial) {
  if (!calcBmr(state.profile)) {
    openWelcome();
    return;
  }
  openModal(
    "これ食っていい？",
    initial || null,
    (edited) => {
      state.pending = Object.assign({ note: "", thumb: "", photo: "" }, edited);
      showVerdict();
    },
    "判定する"
  );
}

/* ---------- 撮れない外食 ----------
   お店の種類・量・お酒の杯数で、まとめて1件にする。
   「これから行く」は予定として入れ、残りカロリーから先に引いておく。
   行ってきたら、その予定を実際の量で確定する（editing にその記録が入る） */

const eatoutSheet = document.getElementById("eatoutSheet");
const eatout = { kind: EATOUT_KINDS[0].id, level: "ふつう", drinks: 0, when: "夜", editing: null };

function openEatout(meal) {
  if (!calcBmr(state.profile)) {
    openWelcome();
    return;
  }
  const from = meal && meal.eatout;
  const kind = EATOUT_KINDS.find((k) => from && k.id === from.kind) || EATOUT_KINDS[0];
  eatout.kind = kind.id;
  eatout.level = (from && from.level) || "ふつう";
  eatout.drinks = from ? from.drinks : kind.drinks;
  eatout.when = (meal && meal.planSlot) || "夜";
  eatout.editing = meal || null;

  const editing = !!meal;
  document.getElementById("eatoutTitle").textContent = editing ? "行ってきた：量を確定" : "撮れない外食";
  document.getElementById("eatoutPlan").hidden = editing;
  document.getElementById("eatoutWhenRow").hidden = editing;
  document.getElementById("eatoutSave").textContent = editing ? "この量で確定" : "食べた！記録する";
  document.getElementById("eatoutHint").textContent = editing
    ? "実際に食べた量に近いものを選んでください。"
    : "目安の数字です。行く前に「予定」で入れておくと、残りカロリーから先に取っておけます。";
  renderEatout();
  openOverlay(eatoutSheet);
}

function eatoutButtons(boxId, items, current, onPick) {
  const box = document.getElementById(boxId);
  box.innerHTML = "";
  items.forEach(([value, label]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(value === current));
    btn.onclick = () => {
      onPick(value);
      renderEatout();
    };
    box.appendChild(btn);
  });
}

function renderEatout() {
  eatoutButtons("eatoutKinds", EATOUT_KINDS.map((k) => [k.id, k.name]), eatout.kind, (id) => {
    eatout.kind = id;
    // 飲む店かどうかで、お酒の杯数のはじめの値を変える
    eatout.drinks = EATOUT_KINDS.find((k) => k.id === id).drinks;
  });
  eatoutButtons("eatoutLevels", EATOUT_LEVELS.map((l) => [l, l]), eatout.level, (l) => (eatout.level = l));
  document.querySelectorAll("#eatoutWhen [data-when]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.when === eatout.when));
  });

  const kind = EATOUT_KINDS.find((k) => k.id === eatout.kind);
  document.getElementById("eatoutDetail").textContent = kind.levels[EATOUT_LEVELS.indexOf(eatout.level)][4];
  document.getElementById("eatoutDrinks").textContent = eatout.drinks;
  document.getElementById("eatoutDrinkMinus").disabled = eatout.drinks <= 0;

  const rec = eatoutRecord(eatout.kind, eatout.level, eatout.drinks);
  document.getElementById("eatoutKcal").textContent = rec.kcal.toLocaleString();
  document.getElementById("eatoutPfc").textContent = pfcText(rec, " ");
}

document.querySelectorAll("#eatoutWhen [data-when]").forEach((btn) => {
  btn.onclick = () => {
    eatout.when = btn.dataset.when;
    renderEatout();
  };
});
document.getElementById("eatoutDrinkMinus").onclick = () => {
  eatout.drinks = Math.max(0, eatout.drinks - 1);
  renderEatout();
};
document.getElementById("eatoutDrinkPlus").onclick = () => {
  eatout.drinks = Math.min(20, eatout.drinks + 1);
  renderEatout();
};
document.getElementById("eatoutCancel").onclick = () => closeOverlay(eatoutSheet);
document.getElementById("btnEatoutOpen").onclick = () => openEatout(null);

/* 予定の時刻。昼・夜のまとまりに入るよう、その日の12時か19時にしておく */
function planTime(slot) {
  const d = new Date();
  d.setHours(slot === "昼" ? 12 : 19, 0, 0, 0);
  return d.toISOString();
}

async function saveEatout(asPlan) {
  const rec = eatoutRecord(eatout.kind, eatout.level, eatout.drinks);
  const fields = {
    name: rec.name,
    portion: rec.portion,
    kcal: rec.kcal,
    protein: rec.protein,
    fat: rec.fat,
    carbs: rec.carbs,
    eatout: rec.eatout,
  };
  const editing = eatout.editing;
  const buttons = [document.getElementById("eatoutPlan"), document.getElementById("eatoutSave")];
  buttons.forEach((b) => (b.disabled = true)); // 二度押しで2件入らないように

  try {
    if (editing) {
      await Store.update("meals", editing.id, Object.assign(fields, { plan: false }));
    } else {
      await Store.add(
        "meals",
        Object.assign(fields, {
          date: todayKey(),
          thumb: "",
          share: 1,
          plan: asPlan,
          planSlot: asPlan ? eatout.when : "",
          createdAt: asPlan ? planTime(eatout.when) : new Date().toISOString(),
        })
      );
    }
  } catch (e) {
    notifySaveFailed(e, "記録");
    return;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }

  closeOverlay(eatoutSheet);
  const dayKey = editing ? editing.date : todayKey();
  const remain = calcRemain(dayKey);
  const head = asPlan ? "予定に入れました" : editing ? "確定しました" : "記録しました";
  showToast(
    dayKey !== todayKey()
      ? labelOf(dayKey) + " の予定を確定しました"
      : remain > 0
      ? head + "　残り " + remain.toLocaleString() + " kcal"
      : head + "　今日はオーバーしています"
  );
  afterMealRecorded(dayKey);
}

document.getElementById("eatoutPlan").onclick = () => saveEatout(true);
document.getElementById("eatoutSave").onclick = () => saveEatout(false);

/* 下のタブの真ん中の判定ボタン。どのタブ・どの日を見ていても、今日の「きょう」に戻ってから判定する。
   AIが使えるときは写真を選ぶ画面、使えないときはカロリーを入れる画面を開く */
document.getElementById("fab").onclick = () => {
  if (state.viewDate !== todayKey()) {
    state.viewDate = todayKey();
    fillBurnForm();
    renderAll();
  }
  showTab("pageToday");
  if (!calcBmr(state.profile)) {
    openWelcome();
    return;
  }
  if (canUseAi()) photoInput.click();
  else openJudge();
};

/* 「食べたもの」の＋から、表示中の日に追加する（昨日の入れ忘れなど） */
document.getElementById("btnAddToDay").onclick = () => {
  const key = state.viewDate;
  openManualAdd(key, key === todayKey() ? "手で追加" : labelOf(key) + " に手で追加");
};

/* ---------- APIキーの動作確認 ---------- */

document.getElementById("btnTestKey").onclick = async () => {
  const box = document.getElementById("keyTestResult");
  const key = document.getElementById("inApiKey").value.trim();
  setApiKey(key);

  box.hidden = false;
  box.className = "error-box";
  box.textContent = "確認中…";
  renderAll(); // キーの有無で撮影ボタンが切り替わるため

  if (!key) {
    box.textContent = "APIキーが空です。";
    return;
  }

  const result = await checkApiKey(key);
  if (result.ok) box.className = "error-box good";
  box.textContent = result.message;
};

/* キーが使えるかを確かめる（設定画面と「はじめに」の両方から使う） */
async function checkApiKey(key) {
  const model = resolveModel();

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model),
      { headers: { "x-goog-api-key": key } }
    );
    const data = await res.json().catch(() => null);

    if (res.ok) return { ok: true, message: "OK。モデル「" + model + "」が使えます。" };
    return {
      ok: false,
      message:
        "使えませんでした。キーを貼り間違えていないか確認してください。\n\n" +
        ((data && data.error && data.error.message) || "HTTP " + res.status),
    };
  } catch (e) {
    return { ok: false, message: "通信できませんでした。ネットワークの状態を確認してください。" };
  }
}

/* ---------- モデル一覧の取り直し ---------- */

document.getElementById("btnRefreshModels").onclick = async () => {
  const box = document.getElementById("keyTestResult");
  const key = document.getElementById("inApiKey").value.trim();
  setApiKey(key);

  box.hidden = false;
  box.className = "error-box";

  if (!key) {
    box.textContent = "先にAPIキーを入れてください。";
    return;
  }

  box.textContent = "一覧を取得中…";

  try {
    const list = await fetchModels(key);
    buildModelSelect();
    box.className = "error-box good";
    box.textContent =
      "使えるモデルを " + list.length + " 件見つけました。\nいま使うのは " + resolveModel() + " です。";
  } catch (e) {
    box.textContent = "一覧を取得できませんでした。\n\n" + ((e && e.message) || "");
  }
};

/* ---------- バックアップの書き出し ---------- */

document.getElementById("btnExport").onclick = () => {
  // APIキーは意図的に含めない
  const dump = {
    exportedAt: new Date().toISOString(),
    profile: state.profile,
    meals: state.meals,
    daily: state.daily,
  };
  const blob = new Blob([JSON.stringify(dump, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "これ食っていい_バックアップ_" + todayKey() + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---------- 起動 ---------- */

/* パスワードマネージャーがカロリーなどの欄にまで反応してしまうのを抑える。
   HTMLの autocomplete="off" と合わせ、主要なマネージャーの無効化属性も付けておく。 */
document.querySelectorAll("input:not([type=file]), select").forEach((el) => {
  el.setAttribute("autocomplete", "off");
  el.setAttribute("data-1p-ignore", "");
  el.setAttribute("data-lpignore", "true");
  el.setAttribute("data-bwignore", "");
  el.setAttribute("data-form-type", "other");
});

initStore();
fillSettingsForm();
renderAll();

/* 起動のたびに裏でモデル一覧を取り直す。新しいモデルが出れば「自動」設定なら次から使われる。
   失敗しても前回の一覧か既定のモデルで動くので、ここでは何も知らせない。 */
(async function refreshModelsQuietly() {
  const key = getApiKey();
  if (!key) return;
  try {
    await fetchModels(key);
    buildModelSelect();
  } catch (e) {
    console.warn("モデル一覧を取得できませんでした", e && e.message);
  }
})();

/* 開きっぱなしでも、21時になったらお知らせが出て、日付が変われば今日に切り替わるようにする */
let lastSeenDay = todayKey();
setInterval(() => {
  if (todayKey() !== lastSeenDay) {
    lastSeenDay = todayKey();
    state.viewDate = lastSeenDay;
    pickedSlot = null;
    fillBurnForm();
    renderAll();
  } else {
    renderReminder();
    renderSuggest(); // 時間が進むと「次の食事」が昼→夜のように変わるため
  }
}, 60000);

/* オフラインでも開けるようにする。file:// で開いたときは登録できないので黙って飛ばす */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
