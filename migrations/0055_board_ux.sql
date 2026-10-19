-- 案件掲示板の使い勝手（w4-board-ux: #243 #250）

-- 1. 既読位置をユーザー単位でも記録する（#250）
--    これまでは企業単位（board_thread_reads）で、画面を開いたままにしておくだけで自社全員の未読が消えていた。
--    未読は「自分の既読位置」と「自社が最後に返信した位置（board_thread_reads。自社の投稿でだけ進める）」の大きい方より後を数える。
--    行のないユーザーは、これまでどおり企業単位の位置で数える（移行直後に未読が増えたり減ったりしない）
CREATE TABLE IF NOT EXISTS board_thread_user_reads (
  thread_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, user_id)
);

-- 2. 同じやり取りで同じスタッフを二重に提案しない（#243）
--    一意制約を付ける前に、これまでに二重に送られた未決の提案（提案中・面談希望）を整理する。
--    同じやり取り・同じスタッフで、採用済みの提案があるもの、または より進んだ（面談希望 > 提案中）・より早い未決の提案があるものを取り下げにする。
--    採用済み・見送り・取り下げの行は変えない
UPDATE board_proposals SET status = 'withdrawn', updated_at = datetime('now', '+9 hours'), decided_at = datetime('now', '+9 hours')
WHERE status IN ('proposed', 'interview') AND EXISTS (
  SELECT 1 FROM board_proposals q
  WHERE q.thread_id = board_proposals.thread_id AND q.staff_id = board_proposals.staff_id AND q.proposal_id != board_proposals.proposal_id
    AND (q.status = 'adopted'
      OR (q.status = 'interview' AND board_proposals.status = 'proposed')
      OR (q.status = board_proposals.status AND q.proposal_id < board_proposals.proposal_id)));
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_proposals_pending ON board_proposals(thread_id, staff_id) WHERE status IN ('proposed', 'interview');
