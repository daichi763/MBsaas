-- 単価の設定を精算画面へ移す（利用者の要望 Sprint 9。w9-pricing）
-- 列の追加のみ（新しい表はない）。既存の値は変えない。単価の計算には使わない列だけを足す。

-- 1. 案件の備考（9201・9202）。案件詳細で表示・編集する（管理画面のみ。スタッフには出さない）
ALTER TABLE projects ADD COLUMN remarks TEXT;

-- 2. スタッフの支払の参考単価（9204）。単位は daily（日給）/ hourly（時給）。計算には使わず、
--    精算画面の「単価の設定」でスタッフ別の単価を決めるときの目安として出す。他社連携の行（linked_external）では使わない
ALTER TABLE staff_profiles ADD COLUMN reference_pay_unit TEXT;
ALTER TABLE staff_profiles ADD COLUMN reference_pay_amount INTEGER;

-- 3. 単価ルールのインセンティブ（加算額。9203）。記録と表示のためだけの列で、計算には使わない
--    （支払単価 pay_rate に加算後の金額を入れる。pay_rate − pay_incentive が基本の支払単価）
ALTER TABLE rate_rules ADD COLUMN pay_incentive INTEGER;
