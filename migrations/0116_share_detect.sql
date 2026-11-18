-- アカウントの使い回しの疑い（Sprint 31 #9989。作業単位 w31-share-detect）
-- 払い出したアカウントの数で課金するため、1つのアカウントを複数の人で使い回している会社に本部が気づけるようにする。
-- 見つけて本部の画面に出すだけで、ログインを止めたり締め出したりはしない（利用者の決定 11/18: 同時にログインできる端末の数に上限は付けない）。
-- 会社の画面には出さない（/api/hq/* だけで返す）。集計の仕組みは src/lib/share-detect.ts、画面は public/static/hq.js の「使い回しの疑い」。
-- 列・表の追加のみ（既存の列・値は変えない）。前の版のコードは新しい列を書かないので、デプロイの前に当ててよい。

-- 1. ログインの履歴に、接続元のおおよその場所（Cloudflare の request.cf）と、ログインの時点で別の端末で使っていたかを足す。
--    country: 国（ISO 3166-1 の2文字。例 JP）。region_code: 都道府県のコード（ISO 3166-2 の後ろ。例 13 = 東京都）。
--    region・city: Cloudflare が返す名前（英字。例 Tokyo / Shinjuku）。IP の生の値は今までどおり ip に残す。
--    concurrent_device: ログインの成功の時点で、同じアカウントの別の種類の端末（OS・ブラウザ）のセッションが使われていたとき、その端末の表示（例 Windows / Chrome）。
--    concurrent_minutes: その端末のセッションが最後に使われてからの分（多めに見積もった値。セッションの延長の間隔の分だけずれる）
ALTER TABLE login_events ADD COLUMN country TEXT;
ALTER TABLE login_events ADD COLUMN region_code TEXT;
ALTER TABLE login_events ADD COLUMN region TEXT;
ALTER TABLE login_events ADD COLUMN city TEXT;
ALTER TABLE login_events ADD COLUMN concurrent_device TEXT;
ALTER TABLE login_events ADD COLUMN concurrent_minutes INTEGER;

-- 2. 集計の実行（週に1回の定期処理と、本部の画面の「今すぐ集計する」）。会社・利用者の情報は持たない。1年で消す（src/services/retention.ts）
--    period_from・period_to: 集計した期間（日本時間の日付）。rows_read: 集計の問い合わせで D1 が読んだ行数の合計（読み取りの枠の確認用）
CREATE TABLE IF NOT EXISTS share_detect_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL,       -- cron / manual
  status TEXT NOT NULL,             -- ok / failed
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER,
  settings_json TEXT,
  error_message TEXT,
  triggered_by INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_detect_runs_created ON share_detect_runs(created_at);

-- 3. 疑いのあるアカウント（集計1回につき、決まりの点数を超えたアカウントごとに1行）。
--    reasons_json: 理由の配列（[{ "code": concurrent / many_devices / far_apart / punch_far / punch_devices, "count": 回数, "points": 点, "detail": 説明 }]）。
--    first_at・last_at: 手がかりが見つかった最初と最後の日時（日本時間）。
--    review_status: open（未確認）/ ok（確認して問題なし）/ contacted（会社に連絡した）。本部の確認のメモを review_note に残す。
--    解約した会社の削除の対象（OFFBOARDING_TABLES。書き出さない）。1年で消す
CREATE TABLE IF NOT EXISTS share_suspicions (
  suspicion_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  first_at TEXT,
  last_at TEXT,
  review_status TEXT NOT NULL DEFAULT 'open',
  review_note TEXT,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_suspicions_run ON share_suspicions(run_id, score);
CREATE INDEX IF NOT EXISTS idx_share_suspicions_company ON share_suspicions(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_share_suspicions_user ON share_suspicions(user_id, created_at);

-- 4. 判定の決まりの値（本部の画面で変えられる。行がない項目は src/lib/share-detect.ts の既定値）
CREATE TABLE IF NOT EXISTS share_detect_settings (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);
