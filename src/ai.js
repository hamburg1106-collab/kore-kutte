/* =========================================================
   みんなで使うAI（Firebase AI Logic 経由のGemini）

   APIキーを持っていない人も写真判定とAIの提案を使えるようにする。
   記録の保存先（ouchi-no-kondate）とは別の、AI専用のFirebaseプロジェクト
   （korekutte-ai）を使う。保存先のプロジェクトは他のアプリとAIの無料枠を
   取り合っていて、429・503が多かったため。

   他人が勝手にこの枠を使えないよう、App Check（reCAPTCHA Enterprise）で
   「このアプリからの呼び出しか」を確かめている。
   ========================================================= */

/* 公開サイトに書く前提の値（秘密ではない） */
const AI_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCs3A2U09DaPMLrzlQBUk3LV4I_tgUDQ6U",
  authDomain: "korekutte-ai.firebaseapp.com",
  projectId: "korekutte-ai",
  storageBucket: "korekutte-ai.firebasestorage.app",
  messagingSenderId: "37181905790",
  appId: "1:37181905790:web:7dd6cfec78d8f46de3b12f",
};

/* App Check 用の reCAPTCHA Enterprise のキーID（公開してよい値） */
const RECAPTCHA_KEY = "6LcEdxEuAAAAALYCaqXdHduLZOg7NTNCTVF_b2Rd";

/* AIの部品は使うときに読み込む。起動を重くしないため */
let loading = null;

function load() {
  if (loading) return loading;
  loading = (async () => {
    const [appMod, aiMod, checkMod] = await Promise.all([
      import("firebase/app"),
      import("firebase/ai"),
      import("firebase/app-check"),
    ]);
    // 記録用のFirebase（compat版・既定のアプリ）とぶつからないよう、名前を付けて別に作る
    const app = appMod.initializeApp(AI_FIREBASE_CONFIG, "korekutte-ai");

    /* 手元のPC（localhost）で動かすときだけ、デバッグ用の合言葉で App Check を通す。
       合言葉はブラウザの開発者ツールに出るので、Firebaseの App Check に登録して使う。
       公開サイトでは使われない */
    if (location.hostname === "localhost") self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;

    checkMod.initializeAppCheck(app, {
      provider: new checkMod.ReCaptchaEnterpriseProvider(RECAPTCHA_KEY),
      // 自動更新は切る。開きっぱなしでも確認の回数（無料枠は月1万回）を使わないため。
      // 必要なときに、期限が切れていれば取り直してくれる
      isTokenAutoRefreshEnabled: false,
    });

    return {
      ai: aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() }),
      getGenerativeModel: aiMod.getGenerativeModel,
    };
  })();
  // 読み込みに失敗したら、次に呼ばれたときにやり直せるようにする
  loading.catch(() => (loading = null));
  return loading;
}

/* ブラウザから直接呼ぶ版（REST）と同じ形で書いた schema を、この部品の形に直す。
   違いは型名が小文字なことだけ（"OBJECT" → "object"） */
function toSdkSchema(s) {
  if (Array.isArray(s)) return s.map(toSdkSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  Object.keys(s).forEach((k) => {
    out[k] = k === "type" ? String(s[k]).toLowerCase() : toSdkSchema(s[k]);
  });
  return out;
}

/* 写真の渡し方も、REST版（inline_data / mime_type）からこの部品の形に直す */
function toSdkParts(parts) {
  return parts.map((p) =>
    p.inline_data ? { inlineData: { mimeType: p.inline_data.mime_type, data: p.inline_data.data } } : p
  );
}

/* AIに頼んで、schema の形のJSON文字列をもらう。

   Flash は答える前に考える時間が長く、写真判定に40秒かかった（2026-11-05 実測）。
   写真の食べ物を見積もるだけなら深く考えなくてよいので、思考を最小にする。
   思考の指定に対応していないモデルは 400 を返すので、そのときは指定を外して頼み直す */
export async function sharedGenerate(model, parts, schema, timeoutMs) {
  try {
    return await generate(model, parts, schema, timeoutMs, true);
  } catch (e) {
    if (sharedErrorStatus(e) !== 400) throw e;
    return generate(model, parts, schema, timeoutMs, false);
  }
}

async function generate(model, parts, schema, timeoutMs, thinkLess) {
  const { ai, getGenerativeModel } = await load();
  const generationConfig = {
    responseMimeType: "application/json",
    responseSchema: toSdkSchema(schema),
  };
  if (thinkLess) generationConfig.thinkingConfig = { thinkingLevel: "MINIMAL" };

  /* 無料枠は混むと後回しにされ、1分以上待たされてから失敗することがある（2026-11-05 実測）。
     待ち時間に上限を付けて、超えたら次のモデルで試す */
  const m = getGenerativeModel(
    ai,
    { model: model, generationConfig: generationConfig },
    timeoutMs ? { timeout: timeoutMs } : undefined
  );
  const res = await m.generateContent({ contents: [{ role: "user", parts: toSdkParts(parts) }] });
  return res.response.text();
}

/* 失敗したときのHTTPの番号（429＝使いすぎ、503＝混雑 など）。わからなければ 0 */
export function sharedErrorStatus(e) {
  return (e && e.customErrorData && e.customErrorData.status) || 0;
}

/* みんなのAIが使える場所か。ファイルを直接開いたとき（file://）は使えない */
export function sharedAiAvailable() {
  return location.protocol.startsWith("http");
}
