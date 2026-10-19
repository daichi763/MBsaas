// 定期処理（Cron Trigger）の実行と記録（#192 #198）
//
// - 処理の一覧（CronJob の配列。index.tsx の CRON_JOBS）を上から順に実行し、処理ごとの結果を cron_runs に記録する。
//   処理を足すときは、一覧に1行足すだけでよい。
// - 処理は、指定した cron の式で起動したときに実行する（重い処理を別の起動に分け、1回の起動あたりの
//   D1 の問い合わせ数の上限で後ろの処理が止まらないようにする）。一覧にない式で起動したとき（手動の確認など）は全部を実行する。
// - 処理が例外を投げた、または結果に failed（1以上）・error があれば「失敗」として記録する。1つが失敗しても次の処理は続ける。
// - 本部画面には、処理ごとの最終実行・成否・エラーと、失敗・24時間以上実行されていないときの警告を出す（cronStatus）。

export type CronJobResult = Record<string, unknown> & { failed?: number; error?: string | null }
export type CronJob<E> = {
  name: string   // 記録に使う処理名（変えると別の処理として扱われる）
  label: string  // 本部画面に出す名前
  cron: string   // この式で起動したときに実行する（wrangler.jsonc の triggers.crons のどれか）
  run: (env: E) => Promise<CronJobResult>
}

const CRON_RUNS_KEEP_DAYS = 180
/** これより長く実行されていない処理は本部画面で警告する（毎日の処理なので、起動時刻のずれを見込んで 25 時間） */
export const CRON_STALE_HOURS = 25

// 定義された処理の一覧（index.tsx の CRON_JOBS）。本部画面で「一度も実行されていない処理」を見つけるのに使う
// （wrangler.jsonc の triggers.crons から式が抜けると、その式の処理は記録が1行もできず、警告も出ないため）
let definedJobs: { name: string; label: string; cron: string }[] = []
/** 定期処理の一覧を定義する（index.tsx で1回だけ呼ぶ） */
export function defineCronJobs<E>(jobs: CronJob<E>[]): CronJob<E>[] {
  definedJobs = jobs.map(j => ({ name: j.name, label: j.label, cron: j.cron }))
  return jobs
}

/** 起動した cron の式で実行する処理を選ぶ */
export function selectCronJobs<E>(jobs: CronJob<E>[], cron: string | undefined): CronJob<E>[] {
  const matched = jobs.filter(j => j.cron === cron)
  return matched.length ? matched : jobs
}

export async function runCronJobs<E extends { DB: D1Database }>(env: E, jobs: CronJob<E>[], cron: string | undefined): Promise<void> {
  for (const job of selectCronJobs(jobs, cron)) {
    const started = Date.now()
    let status = 'ok', result: CronJobResult | null = null, error: string | null = null
    try {
      result = await job.run(env)
      if ((Number(result?.failed) || 0) > 0 || result?.error) {
        status = 'failed'
        error = result?.error ? String(result.error) : null
      }
    } catch (e) {
      status = 'failed'
      error = String(e)
    }
    const finished = Date.now()
    console.log(`cron ${job.name}: ${status}${result ? ' ' + JSON.stringify(result) : ''}${error ? ' error=' + error : ''}`)
    try {
      await env.DB.prepare(`INSERT INTO cron_runs (cron, job, label, status, result_json, error_message, duration_ms, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        cron || null, job.name, job.label, status, result ? JSON.stringify(result).slice(0, 2000) : null,
        error ? error.slice(0, 1000) : null, finished - started, new Date(started).toISOString(), new Date(finished).toISOString()
      ).run()
    } catch (e) {
      console.log(`cron_runs insert failed: ${job.name}: ${e}`)
    }
  }
  try {
    const cutoff = new Date(Date.now() - CRON_RUNS_KEEP_DAYS * 24 * 3600 * 1000).toISOString()
    await env.DB.prepare('DELETE FROM cron_runs WHERE started_at < ?').bind(cutoff).run()
  } catch (e) {
    console.log(`cron_runs purge failed: ${e}`)
  }
}

export type CronRunRow = {
  run_id: number; cron: string | null; job: string; label: string | null; status: string
  result_json: string | null; error_message: string | null; duration_ms: number | null; started_at: string; finished_at: string | null
}

/**
 * 本部画面用: 処理ごとの最終実行と、直近の実行記録、警告。
 * 警告: 最後の実行が失敗した処理、定期処理全体が CRON_STALE_HOURS 時間以上実行されていないこと、
 * 他の処理は動いているのにその処理だけ CRON_STALE_HOURS 時間以上実行されていないこと（一覧から外した処理で警告が出続けないよう、
 * 一覧にない処理は最後の実行が7日以内のものに限る）、まだ一度も実行されていないこと（全体と、一覧の処理ごと）。
 */
export async function cronStatus(db: D1Database, opts: { limit?: number } = {}) {
  const latest = (await db.prepare(`SELECT r.* FROM cron_runs r
    JOIN (SELECT job, MAX(run_id) AS run_id FROM cron_runs GROUP BY job) m ON m.run_id = r.run_id
    ORDER BY r.job`).all()).results as CronRunRow[]
  const recent = (await db.prepare('SELECT * FROM cron_runs ORDER BY run_id DESC LIMIT ?').bind(opts.limit || 50).all()).results as CronRunRow[]
  const now = Date.now()
  const warnings: { job: string | null; label: string | null; kind: 'failed' | 'stale' | 'never'; message: string }[] = []
  if (!latest.length) warnings.push({ job: null, label: null, kind: 'never', message: '定期処理がまだ一度も実行されていません（Cron Trigger の設定とデプロイを確認してください）' })
  const newest = latest.reduce((m, r) => Math.max(m, Date.parse(r.started_at) || 0), 0)
  if (latest.length && (now - newest) / 3600000 >= CRON_STALE_HOURS) {
    warnings.push({ job: null, label: null, kind: 'stale', message: `定期処理が${Math.floor((now - newest) / 3600000)}時間実行されていません（Cron Trigger の設定とデプロイを確認してください）` })
  }
  const defined = new Set(definedJobs.map(j => j.name))
  for (const r of latest) {
    const name = r.label || r.job
    if (r.status !== 'ok') warnings.push({ job: r.job, label: r.label, kind: 'failed', message: `「${name}」の最後の実行が失敗しました${r.error_message ? `: ${r.error_message.slice(0, 200)}` : ''}` })
    const gap = (newest - Date.parse(r.started_at)) / 3600000
    // 一覧にある処理は期間を限らずに警告する。一覧から外した処理は、警告が出続けないよう7日以内に限る
    if (gap >= CRON_STALE_HOURS && (defined.has(r.job) || gap < 24 * 7)) warnings.push({ job: r.job, label: r.label, kind: 'stale', message: `「${name}」が${Math.floor((now - Date.parse(r.started_at)) / 3600000)}時間実行されていません` })
  }
  // 一覧にあるのに一度も実行されていない処理（cron の式が wrangler.jsonc の triggers.crons に無いなど）。
  // 定期処理全体がまだ一度も動いていないときは上の警告だけを出す
  if (latest.length) {
    const ran = new Set(latest.map(r => r.job))
    for (const j of definedJobs) {
      if (!ran.has(j.name)) warnings.push({ job: j.name, label: j.label, kind: 'never', message: `「${j.label}」がまだ一度も実行されていません（wrangler.jsonc の triggers.crons に「${j.cron}」があるか確認してください。追加したばかりの処理なら次の実行で消えます）` })
    }
  }
  return { latest, recent, warnings, stale_hours: CRON_STALE_HOURS }
}
