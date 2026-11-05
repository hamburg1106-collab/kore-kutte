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

/* 一覧が取れていないときに使うモデル。
   最新ではなく一世代前を既定にする（理由は resolveModel のコメント） */
const DEFAULT_MODEL = "gemini-3.5-flash";

/* 設定の置き場所。固定にしておくと、続けて操作しても同じものが2つできない */
const PROFILE_ID = "me";

/* 起動時に読み込む日数。記録が何年ぶん貯まっても起動が重くならないようにするための上限。
   これより古い記録も消えてはおらず、クラウド上には残っている。 */
const HISTORY_DAYS = 120;

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

function calcRemain(key) {
  return calcBurn(key) - calcIntake(key) - (GOAL_DIFF[state.profile.goal] || 0);
}

/* 食べていいかの判定 */
function decide(kcal, remain) {
  if (remain <= 0) return "stop";
  const ratio = kcal / remain;
  if (ratio <= 0.6) return "ok";
  if (ratio <= 1) return "half";
  return "stop";
}

const VERDICT_TEXT = {
  ok: "食っていい",
  half: "半分にしとけ",
  stop: "やめとけ",
};

/* ---------- 画面の描画 ---------- */

function renderAll() {
  renderHeader();
  renderHero();
  renderChips();
  renderShootArea();
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
    sub.textContent = "右上の ⚙ から身長・体重・年齢を入れてください";
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
  sub.textContent =
    "食べた " + intake.toLocaleString() +
    " ／ 目標 " + target.toLocaleString() + goalNote +
    (target > 0 ? " ・ " + Math.round(ratio * 100) + "%" : "");
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
   APIキーが無い人には、写真の代わりにカロリーを入れて判定するボタンを出す。
   初めて使うときは、足りない準備をボタンの下で案内する */
function renderShootArea() {
  const isToday = state.viewDate === todayKey();
  document.getElementById("shootArea").hidden = !isToday;

  const hasKey = !!getApiKey();
  document.getElementById("shootBtn").hidden = !hasKey;
  document.getElementById("askBtn").hidden = hasKey;
  // キーなしだと判定ボタン自体が手入力なので、記録だけの手入力は出さない
  document.getElementById("btnManualOpen").hidden = !hasKey;

  const hint = document.getElementById("setupHint");
  if (!calcBmr(state.profile)) {
    hint.textContent = "① まず、はじめの設定をしてください（1分） →";
    hint.hidden = false;
  } else if (!hasKey) {
    hint.textContent = "📷 写真で判定したいときは（APIキーの設定） →";
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
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

  rows.forEach((m) => {
    const li = document.createElement("li");

    // 写真のない記録も行の頭を揃える
    if (m.thumb) {
      const img = document.createElement("img");
      img.src = m.thumb;
      img.alt = "";
      li.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "meal-noimg";
      ph.textContent = "🍽";
      ph.setAttribute("aria-hidden", "true");
      li.appendChild(ph);
    }

    const body = document.createElement("div");
    body.className = "meal-body";

    const name = document.createElement("div");
    name.className = "meal-name";
    name.textContent = m.name;
    name.title = m.name; // 2行で切れたときに全文を確認できるように
    body.appendChild(name);

    if (m.portion) {
      const portion = document.createElement("div");
      portion.className = "meal-portion";
      portion.textContent = m.portion;
      body.appendChild(portion);
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
    del.textContent = "×";
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

function openOverlay(el) {
  if (!el.hidden) return;
  el.hidden = false;
  document.body.classList.add("no-scroll");
  history.pushState({ overlay: el.id }, "");
}

function closeOverlay(el) {
  if (el.hidden) return;
  // 自分が積んだ履歴なら「戻る」で閉じる（popstate の中で hideOverlay される）
  if (history.state && history.state.overlay === el.id) history.back();
  else hideOverlay(el);
}

window.addEventListener("popstate", () => {
  document.querySelectorAll(".overlay:not([hidden])").forEach(hideOverlay);
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

document.getElementById("btnSettings").onclick = () => openSettings();
document.getElementById("btnCloseSettings").onclick = () => closeOverlay(settingsPanel);

/* 身長などが未入力のときは、リングを押すと「はじめに」が開く */
document.getElementById("hero").onclick = () => {
  if (!calcBmr(state.profile)) openWelcome();
};

/* APIキーの欄まで連れていく。取り方の手順も開いておく */
function openKeySettings() {
  document.querySelector(".key-guide").open = true;
  openSettings("inApiKey");
}

/* 撮影ボタンの下の準備案内。足りないものの入力欄まで直接連れていく */
document.getElementById("setupHint").onclick = () => {
  if (calcBmr(state.profile)) openKeySettings();
  else openWelcome();
};

/* ---------- はじめての設定 ----------
   身長などが空のまま開いたときに、1問ずつ聞いていく。
   「次へ」のたびに保存するので、途中で閉じても入れたところまでは残る。 */

const welcomePanel = document.getElementById("welcomePanel");
const WELCOME_STEPS = 4;
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
  document.getElementById("wApiKey").value = getApiKey();
  document.getElementById("wKeyResult").hidden = true;
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

/* スマホの種類を選んだら、そのまま次へ */
welcomePanel.querySelectorAll("[data-burn-mode]").forEach((btn) => {
  btn.onclick = async () => {
    state.profile.burnMode = btn.dataset.burnMode;
    showWelcomeStep(4);
    await saveWelcome();
  };
});

/* 保存の完了は待たずに閉じる。クラウドへの書き込みは圏外だと電波が戻るまで終わらず、
   待っていると「はじめに」が閉じなくなるため（画面にはすぐ反映される） */
function finishWelcome() {
  saveWelcome();
  closeOverlay(welcomePanel);
  showToast("準備できました");
}

document.getElementById("welcomeNoKey").onclick = finishWelcome;
document.getElementById("welcomeClose").onclick = () => closeOverlay(welcomePanel);

document.getElementById("welcomeWithKey").onclick = async () => {
  const key = document.getElementById("wApiKey").value.trim();
  const box = document.getElementById("wKeyResult");
  box.hidden = false;
  box.className = "error-box";

  if (!key) {
    box.textContent = "キーを貼り付けてください。キーなしで使う場合は「キーなしではじめる」を押してください。";
    return;
  }

  box.textContent = "確認中…";
  const result = await checkApiKey(key);
  if (!result.ok) {
    box.textContent = result.message;
    return;
  }

  setApiKey(key);
  apiKeyInput.value = key;
  finishWelcome();
};

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
    alert("引き継ぎコードをコピーしました。新しいスマホの ⚙ 設定 →「機種変更・バックアップ」に貼り付けてください。");
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
- 食べ物でも飲み物でもない写真なら is_food を false にしてください。
- note には、どうやってカロリーを見積もったかを1文で簡潔に書いてください。`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_food: { type: "BOOLEAN" },
    name: { type: "STRING" },
    portion: { type: "STRING" },
    calories: { type: "INTEGER" },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    note: { type: "STRING" },
  },
  required: ["is_food", "name", "portion", "calories", "confidence", "note"],
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
  const key = getApiKey();
  if (!key) {
    throw new Error("右上の ⚙ 設定で Gemini APIキーを入れてください。");
  }

  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "image/jpeg", data: base64 } },
          { text: JUDGE_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const models = [resolveModel(), resolveModel(), fallbackModel()];
  let lastError = null;

  const judgingText = document.getElementById("judgingText");
  judgingText.textContent = "判定中…";

  for (let i = 0; i < models.length; i++) {
    if (i > 0) {
      // 黙って数秒止まると壊れたように見えるので、試し直していることを出す
      judgingText.textContent = "混み合っています。もう一度試しています（" + (i + 1) + "/" + models.length + "）";
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
      throw new Error("APIキーが正しくないようです。右上の ⚙ 設定を見直してください。\n\n" + msg);
    }
    // 使いすぎは待っても直らない。試し直すと枠を余計に食うだけ
    if (res.status === 429) {
      throw new Error("無料枠の上限に達しました。しばらく待ってからもう一度試してください。\n\n" + msg);
    }
    // モデル名が古い場合。一覧を取り直せば直るので、まず別のモデルを試す
    if (res.status === 404) {
      lastError = new Error(
        "モデル「" + model + "」が使えませんでした。⚙ 設定でモデル一覧を取り直してください。\n\n" + msg
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
    showError("先に右上の ⚙ 設定で、身長・体重・年齢を入れてください。");
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

function showVerdict() {
  const f = state.pending;
  const remain = calcRemain(todayKey());
  const mark = decide(f.kcal, remain);

  verdictEl.className = "verdict " + mark;
  // キーなしで手入力から判定したときは写真が無い
  const photo = document.getElementById("verdictPhoto");
  photo.hidden = !f.photo;
  if (f.photo) photo.src = f.photo;
  document.getElementById("verdictHeadline").textContent = VERDICT_TEXT[mark];
  document.getElementById("verdictName").textContent = f.name;
  document.getElementById("verdictPortion").textContent = f.portion || "";
  document.getElementById("verdictKcal").textContent = f.kcal.toLocaleString();

  let note = f.note || "";
  if (f.confidence === "low") note += "（推定の確からしさは低めです）";
  if (mark === "ok") note += `　食べても ${(remain - f.kcal).toLocaleString()}kcal 残ります。`;
  if (mark === "half") note += `　食べると残り ${(remain - f.kcal).toLocaleString()}kcal です。`;
  if (mark === "stop" && remain > 0)
    note += `　残り ${remain.toLocaleString()}kcal なので ${(f.kcal - remain).toLocaleString()}kcal オーバーします。`;
  document.getElementById("verdictNote").textContent = note;

  verdictEl.hidden = false;
  errorEl.hidden = true;

  // 結果は撮影ボタンの下に出るので、見落とさないよう結果の位置まで動かす
  verdictEl.scrollIntoView({ behavior: "smooth", block: "start" });
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
      thumb: f.thumb || "",
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
  verdictEl.hidden = true;

  const remain = calcRemain(todayKey());
  showToast(
    remain > 0
      ? "記録しました　残り " + remain.toLocaleString() + " kcal"
      : "記録しました　今日はオーバーしています"
  );
};

document.getElementById("btnSkip").onclick = () => {
  state.pending = null;
  verdictEl.hidden = true;
};

/* 判定結果のカロリーを手で直す */
document.getElementById("btnFixKcal").onclick = () => {
  const f = state.pending;
  if (!f) return;
  openModal("カロリーを直す", f, (edited) => {
    Object.assign(state.pending, edited);
    showVerdict();
  });
};

/* ---------- 手入力のダイアログ ---------- */

const modal = document.getElementById("modal");
let modalCallback = null;

function openModal(title, initial, onOk, okLabel) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("mOk").textContent = okLabel || "決定";
  document.getElementById("mName").value = (initial && initial.name) || "";
  document.getElementById("mPortion").value = (initial && initial.portion) || "";
  document.getElementById("mKcal").value = (initial && initial.kcal) || "";
  modalCallback = onOk;
  openOverlay(modal);
  setTimeout(() => document.getElementById("mName").focus(), 100);
}

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
    cb({
      name: name,
      portion: document.getElementById("mPortion").value.trim(),
      kcal: Math.round(kcal),
    });
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
  });
}

document.getElementById("btnManualOpen").onclick = () => {
  openManualAdd(todayKey(), "写真なしで追加");
};

/* APIキーが無い人用の判定ボタン。カロリーを入れてもらい、写真のときと同じ判定を出す */
document.getElementById("askBtn").onclick = () => {
  if (!calcBmr(state.profile)) {
    openWelcome();
    return;
  }
  openModal(
    "これ食っていい？",
    null,
    (edited) => {
      state.pending = Object.assign({ note: "", thumb: "", photo: "" }, edited);
      showVerdict();
    },
    "判定する"
  );
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
    fillBurnForm();
    renderAll();
  } else {
    renderReminder();
  }
}, 60000);

/* オフラインでも開けるようにする。file:// で開いたときは登録できないので黙って飛ばす */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
