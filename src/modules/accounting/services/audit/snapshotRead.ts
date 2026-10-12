/**
 * Reading snapshots and check runs back — in the request's own transaction,
 * so RLS (owner / admin / manager of the company) binds every read. Every
 * value comes back spelled as it was sealed: dates and timestamps formatted
 * by the database, rows as stored.
 */
import { sql } from '@/lib/neon';
import type { CanonicalRow } from './snapshotRows';
import type { CheckResult } from './checks/checkTypes';

type Row = Record<string, unknown>;

export interface SnapshotRecord {
  id: string; companyId: string; cutoff: string; takenAt: string; takenBy: string; takenByName: string | null;
  channel: string; trigger: string; status: 'sealed' | 'failed'; failureReason: string | null;
  canonicalHash: string | null; hmac: string | null; keyId: string | null; masterDataHighWater: string | null;
  totals: Record<string, unknown>; caveat: string; checkRunId: string | null;
}

function mapSnapshot(r: Row): SnapshotRecord {
  return {
    id: String(r.id), companyId: String(r.company_id), cutoff: String(r.cutoff), takenAt: String(r.taken_at),
    takenBy: String(r.taken_by), takenByName: (r.taken_by_name as string | null) ?? null, channel: String(r.channel),
    trigger: String(r.trigger), status: r.status as SnapshotRecord['status'], failureReason: (r.failure_reason as string | null) ?? null,
    canonicalHash: (r.canonical_hash as string | null) ?? null, hmac: (r.hmac as string | null) ?? null,
    keyId: (r.key_id as string | null) ?? null, masterDataHighWater: (r.high_water as string | null) ?? null,
    totals: (r.totals as Record<string, unknown>) ?? {}, caveat: String(r.caveat), checkRunId: (r.check_run_id as string | null) ?? null,
  };
}

async function selectSnapshots(companyId: string, id: string | null, limit: number): Promise<SnapshotRecord[]> {
  const rows = (await sql`
    SELECT s.id::TEXT AS id, s.company_id::TEXT AS company_id, s.cutoff::TEXT AS cutoff,
           to_char(s.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS taken_at, s.taken_by,
           public.approval_company_member_name(s.company_id, s.taken_by) AS taken_by_name,
           s.channel, s.trigger, s.status, s.failure_reason, s.canonical_hash, s.hmac, s.key_id,
           to_char(s.master_data_high_water AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS high_water,
           s.totals, s.caveat, s.check_run_id::TEXT AS check_run_id
    FROM audit_snapshots s
    WHERE s.company_id = ${companyId}::UUID AND (${id}::UUID IS NULL OR s.id = ${id}::UUID)
    ORDER BY s.taken_at DESC, s.id DESC
    LIMIT ${limit}
  `) as Row[];
  return rows.map(mapSnapshot);
}

export const listSnapshots = (companyId: string, limit = 100) => selectSnapshots(companyId, null, Math.min(Math.max(limit, 1), 200));

export async function getSnapshot(companyId: string, id: string): Promise<SnapshotRecord | null> {
  return (await selectSnapshots(companyId, id, 1))[0] ?? null;
}

export async function snapshotTb(companyId: string, id: string): Promise<{ accountId: string; row: CanonicalRow }[]> {
  const rows = (await sql`
    SELECT account_id::TEXT AS id, row FROM audit_snapshot_tb
    WHERE company_id = ${companyId}::UUID AND snapshot_id = ${id}::UUID ORDER BY row->>'account_code', account_id
  `) as { id: string; row: CanonicalRow }[];
  return rows.map((r) => ({ accountId: r.id, row: r.row }));
}

export interface StoredRow { id: string; journalId: string; row: CanonicalRow; materialHash: string }

/**
 * Every stored journal (kind 'journals') or line ('lines'); `page` / `size` for a screen, all of them without;
 * `journalId` narrows lines to one journal.
 */
export async function snapshotRows(companyId: string, id: string, kind: 'journals' | 'lines',
  opts: { page?: number; size?: number; journalId?: string } = {}): Promise<StoredRow[]> {
  const size = opts.size ? Math.min(Math.max(opts.size, 1), 500) : null;
  const offset = size ? Math.max((opts.page ?? 1) - 1, 0) * size : 0;
  const rows = (kind === 'journals'
    ? await sql`
        SELECT journal_id::TEXT AS id, journal_id::TEXT AS j, row, material_hash FROM audit_snapshot_journals
        WHERE company_id = ${companyId}::UUID AND snapshot_id = ${id}::UUID
        ORDER BY entry_date, row->>'entry_number', journal_id LIMIT ${size} OFFSET ${offset}`
    : await sql`
        SELECT line_id::TEXT AS id, journal_id::TEXT AS j, row, material_hash FROM audit_snapshot_lines
        WHERE company_id = ${companyId}::UUID AND snapshot_id = ${id}::UUID
          AND (${opts.journalId ?? null}::UUID IS NULL OR journal_id = ${opts.journalId ?? null}::UUID)
        ORDER BY journal_id, line_id LIMIT ${size} OFFSET ${offset}`) as Row[];
  return rows.map((r) => ({ id: String(r.id), journalId: String(r.j), row: r.row as CanonicalRow, materialHash: String(r.material_hash) }));
}

export interface CheckRunRecord {
  id: string; companyId: string; asAt: string; periodStart: string; takenAt: string; takenBy: string; channel: string;
  purpose: 'standalone' | 'snapshot'; canonicalHash: string; hmac: string; keyId: string; totals: Record<string, unknown>;
  results: CheckResult[];
}

export type CheckRunHeaderRecord = Omit<CheckRunRecord, 'results'>;

async function selectRuns(companyId: string, id: string | null, limit: number): Promise<CheckRunHeaderRecord[]> {
  const rows = (await sql`
    SELECT id::TEXT AS id, company_id::TEXT AS company_id, as_at::TEXT AS as_at, period_start::TEXT AS period_start,
           to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS taken_at, taken_by, channel, purpose,
           canonical_hash, hmac, key_id, totals
    FROM audit_check_runs WHERE company_id = ${companyId}::UUID AND (${id}::UUID IS NULL OR id = ${id}::UUID)
    ORDER BY taken_at DESC, id DESC LIMIT ${limit}
  `) as Row[];
  return rows.map((r) => ({
    id: String(r.id), companyId: String(r.company_id), asAt: String(r.as_at), periodStart: String(r.period_start),
    takenAt: String(r.taken_at), takenBy: String(r.taken_by), channel: String(r.channel), purpose: r.purpose as CheckRunRecord['purpose'],
    canonicalHash: String(r.canonical_hash), hmac: String(r.hmac), keyId: String(r.key_id), totals: r.totals as Record<string, unknown>,
  }));
}

export const listCheckRuns = (companyId: string, limit = 50) => selectRuns(companyId, null, Math.min(Math.max(limit, 1), 200));

export async function getCheckRun(companyId: string, id: string): Promise<CheckRunRecord | null> {
  const [run] = await selectRuns(companyId, id, 1);
  if (!run) return null;
  const results = (await sql`
    SELECT check_id, check_version, family, status, population, finding_count, findings FROM audit_check_results
    WHERE company_id = ${companyId}::UUID AND run_id = ${id}::UUID ORDER BY check_id
  `) as Row[];
  return {
    ...run,
    results: results.map((x) => ({
      checkId: String(x.check_id), version: Number(x.check_version), family: x.family as CheckResult['family'],
      status: x.status as CheckResult['status'], population: x.population === null ? null : Number(x.population),
      findingCount: Number(x.finding_count), findings: x.findings as CheckResult['findings'],
    })),
  };
}
