/**
 * The sage_connect_pulls row (migration 907) through its life:
 *
 *   startPull (review request) -> 'pulling'
 *   the pull job (sagePullJob)  -> 'ready' with the pull, or 'failed' with a safe message
 *   import / discard / 24 h     -> 'imported' | 'discarded' | 'expired', pull cleared
 *
 * Stores what was READ from Sage — never the Sage login. A 'pulling' row with
 * no heartbeat for PULL_STALE_MINUTES (the process restarted mid-read) is
 * reported as failed on read and marked failed by the next review request; a
 * 'ready' row older than READY_TTL_HOURS is expired (its pull cleared) by every
 * status, poll and review call for the company and by the nightly purge.
 *
 * Request-side functions run inside withAuth (app_user, RLS); the job-side
 * ones (markPull*, touchPull, purgeExpiredPullsEverywhere) run as the pool role
 * outside RLS. Every statement names company_id either way, and every job
 * write is fenced on status = 'pulling', so a row discarded or failed meanwhile
 * is never overwritten by a late result.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { SagePull } from './sageApiTypes';
import type { TakeOnSummary } from './sageTakeOnTypes';

export { summarise, type TakeOnSummary } from './sageTakeOnTypes';
export { readTakeOnContext } from './sageTakeOnContext';

export const PULL_STALE_MINUTES = 15;
export const READY_TTL_HOURS = 24;
export const STALE_PULL_ERROR = 'The read from Sage was interrupted. Start again.';

export type PullStatus = 'pulling' | 'ready' | 'failed' | 'imported' | 'discarded' | 'expired';

/** A refusal decided before anything was written; the route answers it as a 400. */
export class SagePullRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagePullRefused';
  }
}

/** Expire this company's reviews past the TTL, and fail its interrupted reads. */
export async function purgeExpiredPulls(companyId: string): Promise<void> {
  await sql`
    UPDATE sage_connect_pulls SET status = 'expired', pull = NULL
    WHERE company_id = ${companyId}::UUID AND status = 'ready'
      AND ready_at < NOW() - make_interval(hours => ${READY_TTL_HOURS})
  `;
  await sql`
    UPDATE sage_connect_pulls SET status = 'failed', error = ${STALE_PULL_ERROR}, progress = NULL
    WHERE company_id = ${companyId}::UUID AND status = 'pulling'
      AND COALESCE(heartbeat_at, created_at) < NOW() - make_interval(mins => ${PULL_STALE_MINUTES})
  `;
}

/** The nightly sweep across every tenant (pages/api/cron/rate-limit-cleanup). Pool role, no RLS. */
export async function purgeExpiredPullsEverywhere(): Promise<number> {
  const rows = (await sql`
    UPDATE sage_connect_pulls SET status = 'expired', pull = NULL
    WHERE status = 'ready' AND ready_at < NOW() - make_interval(hours => ${READY_TTL_HOURS})
    RETURNING id
  `) as DbRow[];
  return rows.length;
}

/**
 * Insert the 'pulling' row. One read per company at a time: serialised on a
 * per-company advisory lock, then refused when one is under way (the partial
 * unique index is the backstop).
 */
export async function startPull(
  companyId: string, userId: string, sageCompanyId: number, asAtDate: string,
): Promise<string> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${companyId + ':sage-pull'}))`;
  await purgeExpiredPulls(companyId);
  const running = (await sql`
    SELECT id FROM sage_connect_pulls WHERE company_id = ${companyId}::UUID AND status = 'pulling' LIMIT 1
  `) as DbRow[];
  if (running.length > 0) {
    throw new SagePullRefused('IsaFlow is already reading a Sage company for this company. Wait for it to finish, or discard it, then try again.');
  }
  const rows = (await sql`
    INSERT INTO sage_connect_pulls (company_id, created_by, sage_company_id, as_at_date, status, heartbeat_at)
    VALUES (${companyId}::UUID, ${userId}::UUID, ${sageCompanyId}, ${asAtDate}::DATE, 'pulling', NOW())
    RETURNING id
  `) as DbRow[];
  return String(rows[0]!.id);
}

/** Job: a sign of life, with the step under way. */
export async function touchPull(companyId: string, pullId: string, progress?: string): Promise<void> {
  await sql`
    UPDATE sage_connect_pulls SET heartbeat_at = NOW(), progress = COALESCE(${progress ?? null}, progress)
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID AND status = 'pulling'
  `;
}

/** Job: the pull is in. False when the row stopped being 'pulling' meanwhile. */
export async function markPullReady(companyId: string, pullId: string, pull: SagePull, summary: TakeOnSummary): Promise<boolean> {
  const rows = (await sql`
    UPDATE sage_connect_pulls
    SET status = 'ready', pull = ${JSON.stringify(pull)}::JSONB, summary = ${JSON.stringify(summary)}::JSONB,
        sage_company_name = ${pull.company.name}, ready_at = NOW(), heartbeat_at = NOW(), progress = NULL
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID AND status = 'pulling'
    RETURNING id
  `) as DbRow[];
  return rows.length === 1;
}

/** Job: the pull failed; `message` must be safe to show (never the login). */
export async function markPullFailed(companyId: string, pullId: string, message: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE sage_connect_pulls SET status = 'failed', error = ${message}, progress = NULL
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID AND status = 'pulling'
    RETURNING id
  `) as DbRow[];
  return rows.length === 1;
}

export interface PullState {
  id: string;
  status: PullStatus;
  progress: string | null;
  error: string | null;
  pull: SagePull | null;
}

const parsePull = (v: unknown): SagePull | null => (typeof v === 'string' ? (JSON.parse(v) as SagePull) : (v as SagePull | null));

/** The row as a reader should see it: a 'pulling' row gone quiet reads as failed. */
function toState(r: DbRow): PullState {
  const stale = r.status === 'pulling' && r.stale === true;
  return {
    id: String(r.id),
    status: stale ? 'failed' : (String(r.status) as PullStatus),
    progress: stale ? null : (r.progress == null ? null : String(r.progress)),
    error: stale ? STALE_PULL_ERROR : (r.error == null ? null : String(r.error)),
    pull: parsePull(r.pull),
  };
}

export async function loadPullState(companyId: string, pullId: string): Promise<PullState | null> {
  const rows = (await sql`
    SELECT id, status, progress, error, pull,
      (COALESCE(heartbeat_at, created_at) < NOW() - make_interval(mins => ${PULL_STALE_MINUTES})) AS stale
    FROM sage_connect_pulls
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0] ? toState(rows[0]) : null;
}

/** The company's review in progress or waiting for import, if any: the page resumes it. */
export async function latestOpenPull(companyId: string): Promise<{ pullId: string; status: PullStatus } | null> {
  const rows = (await sql`
    SELECT id, status, progress, error, NULL AS pull,
      (COALESCE(heartbeat_at, created_at) < NOW() - make_interval(mins => ${PULL_STALE_MINUTES})) AS stale
    FROM sage_connect_pulls
    WHERE company_id = ${companyId}::UUID AND status IN ('pulling', 'ready')
    ORDER BY created_at DESC LIMIT 1
  `) as DbRow[];
  const s = rows[0] ? toState(rows[0]) : null;
  return s && (s.status === 'pulling' || s.status === 'ready') ? { pullId: s.id, status: s.status } : null;
}

export interface StoredPull { id: string; status: PullStatus; pull: SagePull | null; expired: boolean }

/** Locks the row for the rest of the request so two Import clicks cannot both run. */
export async function loadPullForImport(companyId: string, pullId: string): Promise<StoredPull | null> {
  const rows = (await sql`
    SELECT id, status, pull,
      (ready_at < NOW() - make_interval(hours => ${READY_TTL_HOURS})) AS expired
    FROM sage_connect_pulls
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  return { id: String(r.id), status: String(r.status) as PullStatus, pull: parsePull(r.pull), expired: r.expired === true };
}

export async function markImported(companyId: string, pullId: string, sessionId: string, summary: TakeOnSummary): Promise<void> {
  await sql`
    UPDATE sage_connect_pulls
    SET status = 'imported', pull = NULL, migration_session_id = ${sessionId}::UUID,
        summary = ${JSON.stringify(summary)}::JSONB, imported_at = NOW()
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID
  `;
}

/** A review, a read still under way, or a failed read; the pull (if any) is cleared at once. */
export async function discardPull(companyId: string, pullId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE sage_connect_pulls SET status = 'discarded', pull = NULL, progress = NULL
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID AND status IN ('pulling', 'ready', 'failed')
    RETURNING id
  `) as DbRow[];
  return rows.length > 0;
}
