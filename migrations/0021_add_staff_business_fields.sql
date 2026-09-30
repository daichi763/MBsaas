-- スタッフマスタ（業務側情報）の拡充
-- career_rows: 経歴テーブル（JSON配列 [{from:'YYYY-MM', to:'YYYY-MM', company:'勤務', work:'業務内容', note:'備考'}]）
--   ※ 従来の career（テキスト）は経歴テーブルから自動生成した要約を保存し、既存画面・スキルシート等の表示に使う
-- pr_points: 経験・スキル・人柄・PRポイント等（自社内の行ごとに保持。他社連携先には共有しない）
-- remarks: 備考（自社内の行ごとに保持。他社連携先には共有しない）
ALTER TABLE staff_profiles ADD COLUMN career_rows TEXT;
ALTER TABLE staff_profiles ADD COLUMN pr_points TEXT;
ALTER TABLE staff_profiles ADD COLUMN remarks TEXT;
