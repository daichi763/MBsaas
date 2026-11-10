// 定期処理（Cron Trigger）の実行と記録（#192 #198）
//
// - 処理の一覧（CronJob の配列。index.tsx の CRON_JOBS）を上から順に実行し、処理ごとの結果を cron_runs に記録する。
//   処理を足すときは、一覧に1行足すだけでよい。
// - 処理は、指定した cron の式で起動したときに実行する（重い処理を別の起動に分け、1回の起動あたりの
//   D1 の問い合わせ数の上限で後ろの処理が止まらないようにする）。一覧にない式で起動したとき（手動の確認など）は全部を実行する。
// - 処理が例外を投げた、または結果に failed（1以上）・error があれば「失敗」として記録する。1つが失敗しても次の処理は続ける。
// - 結果に idle: true を返した（何もしなかった）実行は、同じ処理の直前の記録も idle なら、その行を消してから記録する
//   （15分おきのリマインドなど回数の多い処理で、記録と本部画面の直近の一覧が埋まらないようにする。最後の実行の日時は残る）
// - 本部画面には、処理ごとの最終実行・成否・エラーと、失敗・長く実行されていないときの警告を出す（cronStatus）。
//   長さの目安は処理ごと（cronStaleHours。15分おきの処理は1時間、毎日の処理は25時間）。

export type CronJobResult = Record<string, unknown> & { failed?: number; error?: string | null; idle?: boolean }
export type CronJob<E> = {
  name: string   // 記録に使う処理名（変えると別の処理として扱われる）
  label: string  // 本部画面に出す名前
  cron: string   // この式で起動したときに実行する（wrangler.jsonc の triggers.crons のどれか）
  staleHours?: number // 最後の実行からこの時間を過ぎたら本部画面で警告する。省略時は cron の式から決める（cronStaleHours）
  run: (env: E) => Promise<CronJobResult>
}

const CRON_RUNS_KEEP_DAYS = 180
/** これより長く実行されていない処理は本部画面で警告する（毎日の処理なので、起動時刻のずれを見込んで 25 時間） */
export const CRON_STALE_HOURS = 25
/** 15分おきなど回数の多い処理の警告の目安（#9946。15分おきなら3回続けて動かなかったら警告する） */
export const CRON_FREQUENT_STALE_HOURS = 1

/** 処理の警告の目安（時間）。staleHours があればそれ。分の欄が「*／N」（N は20以下）で時の欄が「*」の式は1時間、それ以外は25時間 */
export function cronStaleHours(job: { cron: string; staleHours?: number }): number {
  if (job.staleHours && job.staleHours > 0) return job.staleHours
  const [min, hour] = job.cron.trim().split(/\s+/)
  const every = /^\*\/(\d+)$/.exec(min || '')
  return hour === '*' && every && Number(every[1]) <= 20 ? CRON_FREQUENT_STALE_HOURS : CRON_STALE_HOURS
}

// 定義された処理の一覧（index.tsx の CRON_JOBS）。本部画面で「一度も実行されていない処理」を見つけるのに使う
// （wrangler.jsonc の triggers.crons から式が抜けると、その式の処理は記録が1行もできず、警告も出ないため）
let definedJobs: { name: string; label: string; cron: string; staleHours: number }[] = []
/** 定期処理の一覧を定義する（index.tsx で1回だけ呼ぶ） */
export function defineCronJobs<E>(jobs: CronJob<E>[]): CronJob<E>[] {
  definedJobs = jobs.map(j => ({ name: j.name, label: j.label, cron: j.cron, staleHours: cronStaleHours(j) }))
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
      if (status === 'ok' && result?.idle === true) {
        await env.DB.prepare(`DELETE FROM cron_runs WHERE run_id = (SELECT MAX(run_id) FROM cron_runs WHERE job = ?) AND status = 'ok'
          AND (CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.idle') END) = 1`).bind(job.name).run()
      }
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
 * その処理の目安（cronStaleHours。15分おきの処理は1時間）を過ぎても実行されていないこと（一覧から外した処理で警告が出続けないよう、
 * 一覧にない処理は25時間を目安にし、最後の実行が7日以内のものに限る）、まだ一度も実行されていないこと（全体と、一覧の処理ごと）。
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
  const allStopped = latest.length > 0 && (now - newest) / 3600000 >= CRON_STALE_HOURS
  if (allStopped) {
    warnings.push({ job: null, label: null, kind: 'stale', message: `定期処理が${Math.floor((now - newest) / 3600000)}時間実行されていません（Cron Trigger の設定とデプロイを確認してください）` })
  }
  const defined = new Map(definedJobs.map(j => [j.name, j]))
  for (const r of latest) {
    const name = r.label || r.job
    if (r.status !== 'ok') warnings.push({ job: r.job, label: r.label, kind: 'failed', message: `「${name}」の最後の実行が失敗しました${r.error_message ? `: ${r.error_message.slice(0, 200)}` : ''}` })
    const def = defined.get(r.job)
    const limit = def ? def.staleHours : CRON_STALE_HOURS
    // 今からの経過で見る。全体が止まっているときは上の警告にまとめ、他の処理より前から止まっていた処理だけを出す
    const gap = ((allStopped ? newest : now) - Date.parse(r.started_at)) / 3600000
    // 一覧にある処理は期間を限らずに警告する。一覧から外した処理は、警告が出続けないよう7日以内に限る
    if (gap >= limit && (def || gap < 24 * 7)) {
      const hint = def && limit < CRON_STALE_HOURS ? `（「${def.cron}」の起動が止まっていないか確認してください）` : ''
      warnings.push({ job: r.job, label: r.label, kind: 'stale', message: `「${name}」が${Math.floor((now - Date.parse(r.started_at)) / 3600000)}時間実行されていません${hint}` })
    }
  }
  // 一覧にあるのに一度も実行されていない処理（cron の式が wrangler.jsonc の triggers.crons に無いなど）。
  // 定期処理全体がまだ一度も動いていないときは上の警告だけを出す
  if (latest.length) {
    const ran = new Set(latest.map(r => r.job))
    for (const j of definedJobs) {
      if (!ran.has(j.name)) warnings.push({ job: j.name, label: j.label, kind: 'never', message: `「${j.label}」がまだ一度も実行されていません（wrangler.jsonc の triggers.crons に「${j.cron}」があるか確認してください。追加したばかりの処理なら次の実行で消えます）` })
    }
  }
  return { latest, recent, warnings, stale_hours: CRON_STALE_HOURS, stale_hours_by_job: Object.fromEntries(definedJobs.map(j => [j.name, j.staleHours])) }
}
