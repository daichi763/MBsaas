-- 作られていなかった索引と、会社をまたいで既読を消すトリガーを直す（Sprint 22。#9948 #9949。w22-migrations）
-- 索引の追加とトリガーの作り直しだけ（表・列・値は変えない）。

-- 1. 案件掲示板の二重取り込みの確認（#135。board.ts の sameProposedPerson）用の索引（#9948）。
--    0049 は同じ名前の idx_board_proposals_imported（0026 で imported_staff_id に作ったもの）を
--    IF NOT EXISTS で書いていたため、作られていなかった。0049 は書き換えず、別の名前で作る
CREATE INDEX IF NOT EXISTS idx_board_proposals_dup_check ON board_proposals(receiver_company_id, proposer_company_id, staff_id);

-- 2. 企業間チャットの会社単位の既読（roster_comment_reads）を消したときに、利用者単位の既読を消すトリガー（#9949）。
--    0058 のトリガーはスレッドだけで消していたので、解約で会社 A の行を消すと、相手の会社 B の利用者の既読も消え、
--    B の管理者に過去のメッセージがまた未読で出ていた。消した行と同じ会社の利用者の既読だけを消す
DROP TRIGGER IF EXISTS trg_roster_comment_reads_delete;
CREATE TRIGGER IF NOT EXISTS trg_roster_comment_reads_delete AFTER DELETE ON roster_comment_reads
BEGIN
  DELETE FROM roster_comment_user_reads WHERE thread_staff_id = OLD.thread_staff_id AND company_id = OLD.company_id;
END;
