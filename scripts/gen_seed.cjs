// seed.sql 生成スクリプト（今日の日付基準でデモデータを生成）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PASS = hash('pass1234');

// JST基準の日付
const now = new Date(Date.now() + 9 * 3600 * 1000);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const TODAY = addDays(0);

const esc = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;

let sql = `-- Field OS シードデータ (generated ${TODAY})\n`;

// ============ 企業 ============
sql += `
INSERT OR IGNORE INTO companies (company_id, company_code, company_name, plan, user_limit, active_status, maturity_level, support_memo, settings_json) VALUES
 (1, 'sample', '株式会社サンプルモバイル人材', 'standard', 30, 'active', 3, '日報テンプレート設計支援を実施中。次回月次レビュー7/15予定。', '{"ranking_visible":true,"ranking_anonymous":false}'),
 (2, 'demo2', '株式会社テレコムスタッフ東海', 'basic', 10, 'trial', 1, 'トライアル中。初期設定代行を提案予定。', '{}'),
 (3, 'demo3', '合同会社ネクストコネクト', 'basic', 15, 'active', 2, '', '{}');
`;

// ============ ユーザー ============
const staffNames = [
  '佐藤 健太','鈴木 美咲','高橋 大輔','田中 彩香','伊藤 翔太',
  '渡辺 由衣','山本 拓海','中村 花菜','小林 竜也','加藤 芽衣',
  '吉田 悠人','山田 莉子','佐々木 蓮','山口 心春','松本 陸',
  '井上 結衣','木村 颯太','林 美月','斎藤 大和','清水 陽菜'
];
const skills = [
  'MNP,接客,クロージング','光回線,声かけ','新規,機種変更','催事,イベント運営','MNP,光回線,でんき',
  '接客,クレーム対応','家電量販,声かけ','MNP,新規','光回線,置き型WiFi','機種変更,アップセル',
  'MNP,PI','催事,声かけ','新規,クレカ獲得','光回線,固定回線','MNP,機種変更,でんき',
  '接客','家電量販,MNP','催事,イベント','光回線','新規,機種変更'
];
const areas = ['東京23区','東京・神奈川','埼玉南部','千葉西部','東京多摩','神奈川全域','東京23区','東京・埼玉','東京23区','神奈川東部','東京23区','千葉全域','東京・千葉','埼玉全域','東京23区','神奈川西部','東京多摩','東京23区','埼玉南部','東京・神奈川'];
const ages = ['20代','20代','30代','20代','20代','30代','20代','20代','30代','20代','20代','20代','20代','30代','20代','20代','20代','30代','20代','20代'];

sql += `\nINSERT OR IGNORE INTO users (user_id, company_id, user_code, name, role, password_hash, email, phone, status) VALUES\n`;
const userRows = [
  `(1, 1, 'admin', '出井 代表', 'company_admin', '${PASS}', 'admin@sample-mobile.jp', '03-0000-0001', 'active')`,
  `(2, 1, 'mgr01', '藤田 現場長', 'field_manager', '${PASS}', 'fujita@sample-mobile.jp', '090-0000-0002', 'active')`,
  `(3, 1, 'sales01', '岡本 営業', 'sales_manager', '${PASS}', 'okamoto@sample-mobile.jp', '090-0000-0003', 'active')`,
];
staffNames.forEach((n, i) => {
  userRows.push(`(${i + 4}, 1, 'st${String(i + 1).padStart(3, '0')}', '${n}', 'staff', '${PASS}', 'staff${i + 1}@example.com', '090-1111-${String(1000 + i)}', 'active')`);
});
userRows.push(`(100, 1, 'hq', 'ディセクテラ本部', 'system_admin', '${PASS}', 'hq@dissectra.co.jp', NULL, 'active')`);
sql += userRows.join(',\n') + ';\n';

// ============ スタッフプロフィール ============
sql += `\nINSERT OR IGNORE INTO staff_profiles (staff_id, user_id, company_id, affiliation, career, skills, work_area, age_group, evaluation_score, retention_risk, follow_flag, memo) VALUES\n`;
const careers = [
  '携帯ショップ経験3年。クロージングが得意。','家電量販店イベント経験1年。','ドコモショップ経験5年。店舗リーダー経験あり。','未経験入社6ヶ月。成長中。','光回線催事2年。',
  '携帯ショップ2年。','家電量販店1年半。','MNPイベント経験多数。','光回線訪問営業1年。','機種変更対応が得意。3年目。',
  '携帯ショップ4年。指導経験あり。','催事スタッフ1年。','クレカ獲得キャンペーン経験。','固定回線コールセンター出身。','オールラウンダー。5年目。',
  '未経験入社3ヶ月。','家電量販店2年。','イベント運営経験豊富。','光回線専門2年。','携帯ショップ1年。'
];
const profRows = [];
staffNames.forEach((n, i) => {
  // st004(彩香)=要フォロー高リスク, st009(竜也)=要フォロー, st016(結衣)=リスク中
  const risk = i === 3 ? 'high' : (i === 8 ? 'mid' : (i === 15 ? 'mid' : 'low'));
  const follow = (i === 3 || i === 8 || i === 15) ? 1 : 0;
  const evalScore = i === 3 ? 2.1 : (i === 8 ? 2.8 : (3.0 + ((i * 7) % 20) / 10).toFixed(1));
  const memo = i === 3 ? '日報未提出が続いている。面談要。' : (i === 8 ? '入店報告の遅れが増加傾向。' : '');
  profRows.push(`(${i + 1}, ${i + 4}, 1, '株式会社サンプルモバイル人材', ${esc(careers[i])}, '${skills[i]}', '${areas[i]}', '${ages[i]}', ${evalScore}, '${risk}', ${follow}, ${esc(memo)})`);
});
sql += profRows.join(',\n') + ';\n';

// ============ クライアント ============
sql += `
INSERT OR IGNORE INTO clients (client_id, company_id, client_name, stream_type, contact_name, email, phone, address, contract_type, billing_rule, ng_staff_ids, client_rating, memo) VALUES
 (1, 1, '株式会社モバイルプロモーション東日本', 'upstream', '西村 様', 'nishimura@mp-east.example.jp', '03-1234-5678', '東京都新宿区西新宿1-1-1', '業務委託', '月末締め・翌月末払い', '', 4, '主力クライアント。携帯ショップ・催事案件多数。'),
 (2, 1, 'テレコムセールスパートナーズ株式会社', 'upstream', '大森 様', 'omori@tsp.example.jp', '06-9876-5432', '東京都千代田区丸の内2-2-2', '業務委託', '15日締め・翌月15日払い', '16', 3, '家電量販店案件。品質要求が高い。NGスタッフ1名あり。'),
 (3, 1, '株式会社ブロードバンドエージェンシー', 'upstream', '片山 様', 'katayama@bba.example.jp', '03-5555-1111', '東京都渋谷区道玄坂3-3-3', '請負', '月末締め・翌々月5日払い', '', 4, '光回線イベント。土日中心。');
`;

// 本部の標準日報テンプレート（ID 1〜4）はマイグレーション 0032_mail_env.sql で投入する（ここでは出力しない）

// ============ 案件 ============
sql += `
INSERT OR IGNORE INTO projects (project_id, company_id, client_id, project_name, project_type, location, unit_price_type, unit_price, required_skills, report_template_id, show_performance, requirements, manual_text, status, memo) VALUES
 (1, 1, 1, 'ドコモショップ新宿西口 常駐販売', 'mobile_shop', 'ドコモショップ新宿西口店', 'daily', 18000, 'MNP,接客', 1, 1, 'MNP獲得・新規/機変対応。月間PI目標30件。', '開店30分前入店。制服貸与。店長への朝挨拶必須。', 'active', '長期継続中の主力案件。'),
 (2, 1, 2, 'ヤマダ電機池袋 モバイルコーナー', 'electronics', 'ヤマダ電機 池袋総本店', 'daily', 16000, '家電量販,声かけ', 2, 1, '声かけ→商談→成約の導線。光回線セット提案。', '入店時は従業員入口から。名札着用。', 'active', ''),
 (3, 1, 1, 'イオンモール幕張 MNP獲得催事', 'event', 'イオンモール幕張新都心 催事場', 'daily', 20000, '催事,声かけ,MNP', 3, 1, '土日中心の催事ブース運営。1日成約3件目標。', 'ブース設営は9:00集合。備品チェックリスト確認。', 'active', '土日メイン。'),
 (4, 1, 3, '光回線獲得イベント 首都圏ラウンド', 'fiber', '首都圏各所(週替わり)', 'daily', 17000, '光回線,声かけ', 4, 1, '光回線+置き型Wi-Fi+でんきのクロスセル。', '会場ごとの注意事項は週次お知らせを確認。', 'active', ''),
 (5, 1, 2, 'ビックカメラ有楽町 週末ヘルパー', 'electronics', 'ビックカメラ有楽町店', 'daily', 15000, '家電量販', 2, 0, '週末のみ。新規・機変サポート。', '実績追いなし。接客品質重視。', 'active', '実績非表示案件。');
`;

// ============ シフト・勤怠・日報 ============
// スタッフ→案件の割当 (staff_id 1-20)
const assign = {1:[1,2,3,4,5], 2:[6,7,8,9], 3:[10,11,12,13], 4:[14,15,16,17], 5:[18,19,20]};
const projLoc = {1:'ドコモショップ新宿西口店',2:'ヤマダ電機 池袋総本店',3:'イオンモール幕張新都心 催事場',4:'首都圏各所(週替わり)',5:'ビックカメラ有楽町店'};
const projPrice = {1:18000,2:16000,3:20000,4:17000,5:15000};
const projLatLng = {1:[35.6896,139.6983],2:[35.7295,139.7109],3:[35.6479,140.0341],4:[35.6812,139.7671],5:[35.6746,139.7632]};

let shiftId = 1, attId = 1, drId = 1;
const shiftRows = [], attRows = [], drRows = [];

function goodCase(i){
  const cases = ['家族連れに学割+光セットで3回線成約','他社比較表を使った提案が刺さった','高齢のお客様に丁寧な説明で機変+でんき獲得','ポイント還元訴求で即決いただけた',''];
  return cases[i % 5];
}

// 過去14日分 (今日含む)
for (let d = -13; d <= 0; d++) {
  const date = addDays(d);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay(); // 0=日
  for (const [pid, staffIds] of Object.entries(assign)) {
    const p = Number(pid);
    // 案件3,5は土日のみ、他は平日+土曜
    const isWeekend = dow === 0 || dow === 6;
    if ((p === 3 || p === 5) && !isWeekend) continue;
    if ((p === 1 || p === 2 || p === 4) && dow === 0) continue;
    for (const sid of staffIds) {
      // 各スタッフ週4-5日程度 → 日によって間引き
      if ((sid + d + p) % 7 === 0) continue;
      const isToday = d === 0;
      const isAbsent = !isToday && sid === 16 && (d === -2 || d === -6); // 結衣は欠勤2回
      const status = isAbsent ? 'absent' : 'confirmed';
      shiftRows.push(`(${shiftId}, 1, ${sid}, ${p}, '${date}', '09:30', '19:00', ${esc(projLoc[p])}, '販売スタッフ', ${projPrice[p]}, 1200, '${status}', 2, NULL)`);

      if (!isAbsent) {
        const [lat, lng] = projLatLng[p];
        if (isToday) {
          // 今日: 一部未報告のデモ状態を作る
          // staff 4 → 全未報告(要フォロー) / staff 9 → 起床のみ / staff 16 → 起床・出発のみ / 他は入店済み
          const done = sid === 4 ? [] : sid === 9 ? ['wake_up'] : sid === 16 ? ['wake_up','departure'] : ['wake_up','departure','check_in'];
          const times = {wake_up:'07:00', departure:'08:20', check_in:'09:12'};
          for (const rt of done) {
            const withLoc = rt === 'check_in';
            attRows.push(`(${attId++}, 1, ${sid}, ${shiftId}, '${rt}', '${date} ${times[rt]}:00', ${withLoc ? lat + (sid%10)*0.0001 : 'NULL'}, ${withLoc ? lng + (sid%10)*0.0001 : 'NULL'}, ${withLoc ? esc(projLoc[p]) : 'NULL'}, 'iPhone', 'normal')`);
          }
        } else {
          // 過去日: フル報告 (staff 9 は入店遅延あり)
          const lateCheckIn = sid === 9 && (d === -1 || d === -4 || d === -8);
          const times = {wake_up:'07:00', departure:'08:20', check_in: lateCheckIn ? '09:48' : '09:12', check_out:'19:05'};
          for (const rt of ['wake_up','departure','check_in','check_out']) {
            const withLoc = rt === 'check_in';
            attRows.push(`(${attId++}, 1, ${sid}, ${shiftId}, '${rt}', '${date} ${times[rt]}:00', ${withLoc ? lat : 'NULL'}, ${withLoc ? lng : 'NULL'}, ${withLoc ? esc(projLoc[p]) : 'NULL'}, 'iPhone', '${rt==='check_in'&&lateCheckIn?'late':'normal'}')`);
          }
          // 日報: staff 4 は最近3回未提出 / 昨日稼働の staff 11 も未提出(デモ用)
          const skipDr = (sid === 4 && d >= -5) || (sid === 11 && d === -1);
          if (!skipDr) {
            const base = (sid * 3 + Math.abs(d) * 2 + p) % 5;
            const v = {
              mnp: p===4?0:(base%3)+(p===3?2:0), pi: p===1?(base%4)+1:0, shinki: (base+1)%3, kishuhen: p===1?(base%3):0,
              hikari: (p===4?base%3+1:base%2), wifi: p===4?base%2:0, denki: (base%2), card: p===1?base%2:0,
              koekake: 25+base*8, shodan: 6+base*2, seiyaku: 1+base%3,
              good_case: goodCase(sid+d), store_share: d===-3&&sid===6?'店頭在庫が少なくなっています。共有お願いします。':'',
              other_result: '', free: '本日もありがとうございました。'
            };
            const incident = (sid === 13 && d === -2) ? 1 : 0;
            const complaint = (sid === 7 && d === -5) ? 1 : 0;
            if (incident) v.free = 'お客様の申込書記入漏れがあり再来店対応となりました。申し訳ありません。';
            if (complaint) v.free = '説明不足との指摘をお客様から受けました。店長へ報告・謝罪済みです。';
            drRows.push(`(${drId++}, 1, ${sid}, ${p}, ${shiftId}, '${date}', '${JSON.stringify(v).replace(/'/g,"''")}', ${incident}, ${complaint}, ${d===-3&&sid===1?"'PI好調です。この調子で！'":'NULL'}, ${d<-2?1:0}, '${date} 19:30:00')`);
          }
        }
      }
      shiftId++;
    }
  }
}

// 未来7日分のシフト(確定)
for (let d = 1; d <= 7; d++) {
  const date = addDays(d);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  for (const [pid, staffIds] of Object.entries(assign)) {
    const p = Number(pid);
    const isWeekend = dow === 0 || dow === 6;
    if ((p === 3 || p === 5) && !isWeekend) continue;
    if ((p === 1 || p === 2 || p === 4) && dow === 0) continue;
    for (const sid of staffIds) {
      if ((sid + d + p) % 7 === 0) continue;
      shiftRows.push(`(${shiftId++}, 1, ${sid}, ${p}, '${date}', '09:30', '19:00', ${esc(projLoc[p])}, '販売スタッフ', ${projPrice[p]}, 1200, 'confirmed', 2, NULL)`);
    }
  }
}

sql += `\nINSERT OR IGNORE INTO shifts (shift_id, company_id, staff_id, project_id, work_date, start_time, end_time, location, role, unit_price, transportation_fee, status, registered_by, memo) VALUES\n` + shiftRows.join(',\n') + ';\n';
sql += `\nINSERT OR IGNORE INTO attendance_reports (attendance_id, company_id, staff_id, shift_id, report_type, reported_at, latitude, longitude, address, device_info, status) VALUES\n` + attRows.join(',\n') + ';\n';
sql += `\nINSERT OR IGNORE INTO daily_reports (daily_report_id, company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, manager_comment, manager_checked, submitted_at) VALUES\n` + drRows.join(',\n') + ';\n';

// ============ お知らせ ============
sql += `
INSERT OR IGNORE INTO notices (notice_id, company_id, title, body, target_type, target_ids, importance, read_required, published_at, created_by) VALUES
 (1, 1, '【重要】7月キャンペーン施策について', '7月度は光回線+でんきセットのキャンペーンが開始されます。訴求ポイント資料を必ず確認の上、稼働してください。', 'all', '', 'important', 1, '${addDays(-2)} 10:00:00', 2),
 (2, 1, '猛暑対策のお願い', '連日猛暑が続いています。移動時の水分補給・体調管理をお願いします。体調不良時は無理せず早めに連絡してください。', 'all', '', 'normal', 0, '${addDays(-4)} 09:00:00', 2),
 (3, 1, '幕張催事：週末ブースレイアウト変更', '今週末より催事ブースのレイアウトが変更になります。設営手順書を添付しますので確認してください。', 'project', '3', 'important', 1, '${addDays(-1)} 18:00:00', 2),
 (4, 1, '交通費申請の締切について', '今月分の交通費申請は月末最終稼働日までに日報備考欄へ記載をお願いします。', 'all', '', 'normal', 0, '${addDays(-6)} 12:00:00', 3);
`;

// 既読 (一部スタッフが既読)
const nrRows = [];
for (let uid = 5; uid <= 18; uid++) { nrRows.push(`(1, ${uid}, '${addDays(-1)} 20:00:00')`); nrRows.push(`(2, ${uid}, '${addDays(-3)} 20:00:00')`); }
sql += `\nINSERT OR IGNORE INTO notice_reads (notice_id, user_id, read_at) VALUES\n` + nrRows.join(',\n') + ';\n';

// ============ フォロー履歴 ============
sql += `
INSERT OR IGNORE INTO follow_logs (follow_id, company_id, staff_id, manager_id, follow_type, content, next_action, status, related_project_id, created_at) VALUES
 (1, 1, 4, 2, 'interview', '日報未提出が続いている件で面談。業務量とモチベーション低下を確認。シフト調整を検討。', '1週間後に再面談。シフトを週3に調整して様子を見る。', 'open', 1, '${addDays(-3)} 15:00:00'),
 (2, 1, 9, 2, 'phone', '入店報告の遅れについて電話確認。前日夜の準備を促した。', '今週の入店報告を毎日チェック。', 'open', 2, '${addDays(-2)} 20:00:00'),
 (3, 1, 1, 2, 'praise', 'PI実績が2ヶ月連続で目標超過。称賛の連絡。', NULL, 'done', 1, '${addDays(-5)} 11:00:00'),
 (4, 1, 16, 2, 'health', '欠勤が続いたため体調確認の連絡。回復傾向とのこと。', '次回稼働日に対面で様子確認。', 'open', 4, '${addDays(-1)} 10:00:00'),
 (5, 1, 13, 2, 'claim', '申込書記入漏れインシデントについてヒアリング。チェックリスト運用を指導。', 'チェックリスト運用1週間後に確認。', 'open', 3, '${addDays(-1)} 16:00:00');
`;

// ============ 相談 ============
sql += `
INSERT OR IGNORE INTO consultations (consultation_id, company_id, staff_id, category, body, urgency, target_project_id, target_date, manager_reply, status, created_at) VALUES
 (1, 1, 16, 'health', '先週から体調が優れず、今週のシフトについて相談させてください。', 'high', 4, '${addDays(1)}', '無理しないでください。明日のシフトは代打を手配します。回復したら連絡ください。', 'in_progress', '${addDays(-1)} 09:30:00'),
 (2, 1, 7, 'store_trouble', '店舗の担当社員の方との連携がうまくいっていません。声かけ位置の指示が日によって変わり困っています。', 'normal', 2, NULL, NULL, 'open', '${TODAY} 08:00:00'),
 (3, 1, 12, 'shift', '来週の土曜日、家庭の事情でシフトを変更していただきたいです。', 'normal', 3, '${addDays(6)}', '了解です。代わりのスタッフを調整します。', 'done', '${addDays(-2)} 19:00:00');
`;

// ============ 評価 ============
const evalRows = [];
for (let sid = 1; sid <= 20; sid++) {
  const b = (sid * 7) % 3;
  const low = sid === 4 || sid === 9;
  evalRows.push(`(${sid}, 1, ${sid}, 2, '2026-06', ${low?2:3+b%2}, ${low?2:3+(b+1)%2}, ${sid===4?2:3+b%3===0?1:0+3}, ${3+b%2}, ${low?2:4}, ${sid===4?1:sid===16?2:4}, ${sid===4?"'日報提出と報告の安定化が課題。'":'NULL'})`);
}
sql += `\nINSERT OR IGNORE INTO evaluations (evaluation_id, company_id, staff_id, evaluator_id, evaluation_period, attendance_score, report_score, performance_score, client_score, growth_score, retention_score, comment) VALUES\n` + evalRows.join(',\n') + ';\n';

fs.writeFileSync(path.join(__dirname, '..', 'seed.sql'), sql);
console.log('seed.sql generated:', sql.length, 'chars,', shiftRows.length, 'shifts,', attRows.length, 'attendance,', drRows.length, 'daily reports');
