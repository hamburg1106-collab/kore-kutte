/* オフラインでも起動できるようにするための仕組み。
   アプリのファイルを更新したら CACHE_NAME の数字を1つ増やす。

   Vite でビルドすると JS と CSS のファイル名に毎回ちがう文字列が付く
   （例: assets/index-D0vivZie.js）。名前が事前にわからないので、
   ここに直接書くことはできない。かわりに「一度読み込んだものを
   自動でキャッシュに入れる」やり方にしてある。 */

const CACHE_NAME = "korekutte-v9";

/* 名前が変わらないファイルだけ、最初にまとめて保存しておく。
   ここに存在しないファイルを1つでも書くと、まるごと失敗して
   オフライン機能が動かなくなるので注意。 */
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/* 取ってきた結果をキャッシュに入れておく。
   失敗しても画面は動いてほしいので、エラーは握りつぶす。 */
function putInCache(req, res) {
  if (!res || !res.ok) return res;
  const copy = res.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
  return res;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;

  // GET以外と、GeminiやFirebaseへの通信はキャッシュしない
  if (req.method !== "GET") return;
  if (!req.url.startsWith(self.location.origin)) return;

  /* ページそのもの（index.html）は、まずネットを見にいく。
     こうしないとアプリを更新しても古い画面が出続けてしまう。 */
  if (req.mode === "navigate") {
    ev.respondWith(
      fetch(req)
        .then((res) => putInCache(req, res))
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  /* JSやCSSは名前に文字列が付いていて中身が変わらないので、
     キャッシュにあればそれを使う。なければ取ってきて保存する。 */
  ev.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => putInCache(req, res))
        .catch(() => caches.match("./index.html"));
    })
  );
});
