-- 報告用URLのトークンをハッシュで持つ（#9969 authz-04・feat-other-12）
-- shift_report_tokens: token_hash 列（SHA-256 の16進）を足す。ほかのトークン（staff_schedule_tokens など）と同じく、照合はハッシュで行う。
--   新しく発行する行は token 列（主キー）にも同じハッシュを入れ、平文を残さない。
--   今ある行（平文）のハッシュは SQL では計算できないため、アプリ（src/staff-lifecycle.ts の hashLegacyReportTokens）が
--   開いたとき・報告用URLを扱う API で最初に、token をハッシュに置き換えて token_hash を入れる。配ったURLはそのまま使える。
--   列を足すだけなので、今のコード（token = 平文で照合）もこのまま動く。token 列の作り直しは次の Sprint で行う
ALTER TABLE shift_report_tokens ADD COLUMN token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_tokens_hash ON shift_report_tokens(token_hash);
