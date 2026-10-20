-- プッシュ通知（Web Push。#178）と、通知の受け取り設定（#284）（作業単位 w6-push）
--
-- 1. user_notification_prefs: ユーザーごと・通知のまとまり（pref_key。src/notifications.ts の NOTIFY_PREF_GROUPS）ごとの受け取り設定。
--      email / push: 1 = 受け取る、0 = 受け取らない、NULL = 既定（ロールとまとまりで決まる。承認依頼のメールは会社管理者・現場管理者だけ、処理の控えのメールは送らない など）
--      digest: 1 = メールをすぐに送らず、1日1回まとめて送る（打刻修正の承認依頼のみ。digest_sent_on に送った日（JST）を残す）
--      スタッフは同じ人のすべての会社のユーザーに同じ設定を保存する（通知の一覧と同じく、人の単位で受け取りを決めるため）
-- 2. push_subscriptions: 端末（ブラウザ）ごとのプッシュの購読。endpoint は端末ごとに1つ。
--      person_id: 同じ人のほかの会社のユーザーあての通知も、この端末に届ける（スタッフの通知の一覧と同じ）
--      p256dh・auth は本文を暗号化して送るときの鍵（今は本文を送らないので使わない。端末が開いて最新の未読を取りに来る）
--      test_requested_at: 「テスト通知を送る」を押した日時（端末が取りに来たときにテストの文面を返す）
-- 3. push_queue: 送る前のプッシュ。アプリ内の通知（未読）が登録されたら、購読のある人の分だけトリガーで積む。
--      API の書き込みの応答の後と15分おきの cron で送り、送ったら消す（claimed_at: 送る処理が取った日時。二重に送らないため）
-- 4. push_vapid_keys: VAPID の鍵（アプリで1組）。Secret の VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY があればそちらを使い、なければ初回に作ってここに保存する
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  pref_key TEXT NOT NULL,
  email INTEGER,
  push INTEGER,
  digest INTEGER NOT NULL DEFAULT 0,
  digest_sent_on TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pref_key)
);
CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_company ON user_notification_prefs(company_id);
CREATE INDEX IF NOT EXISTS idx_user_notification_prefs_digest ON user_notification_prefs(pref_key, digest);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  person_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT,
  auth TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  test_requested_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_person ON push_subscriptions(person_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_company ON push_subscriptions(company_id);

CREATE TABLE IF NOT EXISTS push_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  notification_id INTEGER,
  kind TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_queue_claimed ON push_queue(claimed_at, queue_id);
CREATE INDEX IF NOT EXISTS idx_push_queue_company ON push_queue(company_id);

CREATE TABLE IF NOT EXISTS push_vapid_keys (
  key_id INTEGER PRIMARY KEY CHECK (key_id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- アプリ内の通知（未読）が入ったら、その人（同じ人のほかの会社のユーザーを含む）に購読があればプッシュを積む。
-- 既読で入る控え（自分の操作の控えなど）は送らない。どこで通知を作っても、同じように届く
CREATE TRIGGER IF NOT EXISTS trg_user_notifications_push AFTER INSERT ON user_notifications
WHEN NEW.read_at IS NULL AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = NEW.user_id
  OR s.person_id = (SELECT u.person_id FROM users u WHERE u.user_id = NEW.user_id))
BEGIN
  INSERT INTO push_queue (company_id, user_id, notification_id, kind, created_at)
  VALUES (NEW.company_id, NEW.user_id, NEW.notification_id, NEW.kind, strftime('%Y-%m-%d %H:%M:%S', 'now', '+9 hours'));
END;
