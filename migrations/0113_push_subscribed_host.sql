-- プッシュの購読を登録したホスト（Sprint 27 #9981。作業単位 w27-mobital）
-- 本番の URL を workers.dev から app.mobital.jp に移すと、購読はオリジン（ホスト）ごとなので、同じ端末に
-- workers.dev の購読（古い Service Worker）と app.mobital.jp の購読の2つができ、同じ通知が2回届く。
-- push_subscriptions.subscribed_host: 購読を登録した要求のホスト（小文字。ポートがあれば付く。例: app.mobital.jp）。
--   NULL = この列より前に登録した購読（本番・ステージングでは workers.dev、手元では localhost で登録したもの）。
--   APP_BASE_URL のホストで購読を登録したとき、同じ人の、別のホストで登録した購読を消す（src/notifications.ts の /push/subscribe、
--   決め方は src/lib/web-push.ts の pushHostCleanup）。
-- 列の追加のみ（NULL 可。既存の列・値は変えない）。前の版のコードは列を書かないので、そのまま動く
ALTER TABLE push_subscriptions ADD COLUMN subscribed_host TEXT;
