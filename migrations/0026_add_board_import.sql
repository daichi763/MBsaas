-- 案件掲示板 第4段階: 採用した提案人材を受け手のスタッフマスタへ取り込む（docs/spec_board.md 6章）
-- 取り込んだ行は partner_manual（取引先所属）、所属会社名 = 提案企業名。取り込み元の提案IDだけを記録し、経路は board_proposals.upstream_chain に残す
ALTER TABLE staff_profiles ADD COLUMN board_proposal_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_staff_profiles_board_proposal ON staff_profiles(board_proposal_id);
CREATE INDEX IF NOT EXISTS idx_board_proposals_imported ON board_proposals(imported_staff_id);
