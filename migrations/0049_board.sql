-- 案件掲示板の不具合（w3-board: #124 #135 #502）

-- 1. 相手企業の未読に数えるシステムメッセージ（#124）
--    提案の状態変更（面談希望・採用・見送り・取り下げ）、やり取りの終了・再開、取り込み、掲載の変更・締切は notify = 1 で記録する。
--    「問い合わせが開始されました」のように、直後に本文が続くものは 0 のまま（未読に数えない）
ALTER TABLE board_messages ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
--    既存の記録も同じ扱いにする。既読位置より前のものは未読にならず、相手がまだ開いていない分だけが未読になる
UPDATE board_messages SET notify = 1
WHERE kind = 'system' AND (proposal_id IS NOT NULL
  OR body LIKE '%がやり取りを終了しました' OR body LIKE '%がやり取りを再開しました'
  OR body LIKE '%が採用した人材をスタッフマスタに登録しました');

-- 2. 人材提案の本人同意と所属元（取引先）の承諾の記録（#502）
--    consent_method: written（書面）/ electronic（メール・チャット等の記録）/ verbal（口頭。記録を残している）
--    upstream_consent_*: 他社連携・取引先所属の人材を提案するときの、所属元（取引先）の承諾
--    既存の提案は NULL（記録なし）のまま残す
ALTER TABLE board_proposals ADD COLUMN consent_method TEXT;
ALTER TABLE board_proposals ADD COLUMN consent_obtained_on DATE;
ALTER TABLE board_proposals ADD COLUMN consent_note TEXT;
ALTER TABLE board_proposals ADD COLUMN upstream_consent_on DATE;
ALTER TABLE board_proposals ADD COLUMN upstream_consent_note TEXT;

-- 3. 同じ人の二重取り込みの確認（#135）
CREATE INDEX IF NOT EXISTS idx_board_proposals_imported ON board_proposals(receiver_company_id, proposer_company_id, staff_id);

--    これまでに同じ提案元の同じスタッフを2回以上取り込んでできた行は、2行目以降を仮登録にして、
--    スタッフ詳細の「既存のスタッフに統合」で1行目にまとめられるようにする（行・シフトは変えない）。
--    取り込んだ後にログインを発行した行（role が roster_only でなくなったもの）は対象にしない
UPDATE staff_profiles SET is_provisional = 1
WHERE board_proposal_id IS NOT NULL AND merged_into_staff_id IS NULL AND COALESCE(is_provisional, 0) = 0
  AND EXISTS (SELECT 1 FROM users us WHERE us.user_id = staff_profiles.user_id AND us.role = 'roster_only')
  AND EXISTS (SELECT 1 FROM board_proposals p
    WHERE p.proposal_id = staff_profiles.board_proposal_id AND p.imported_staff_id = staff_profiles.staff_id
      AND EXISTS (SELECT 1 FROM board_proposals q JOIN staff_profiles o ON o.staff_id = q.imported_staff_id AND o.company_id = q.receiver_company_id
        WHERE q.receiver_company_id = p.receiver_company_id AND q.proposer_company_id = p.proposer_company_id AND q.staff_id = p.staff_id
          AND o.merged_into_staff_id IS NULL AND q.imported_staff_id < p.imported_staff_id));
