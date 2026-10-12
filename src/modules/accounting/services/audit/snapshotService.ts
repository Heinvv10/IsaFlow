/**
 * Taking an audit snapshot: one REPEATABLE READ transaction on its own
 * connection (auditTx), so the trial balance, the journals, the lines, the
 * totals and the check run are one moment of the books. Size-capped: over
 * MAX_SNAPSHOT_LINES posted lines the snapshot is refused before anything is
 * read. Sealed (canonical hash + HMAC) and written through the definer in one
 * call. A refused automatic attempt is recorded as 'failed' with its reason.
 */
import type { PoolClient } from 'pg';
import { listEntityChanges } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { ENTITY_TYPES, mayReadType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { runAuditTx, transactionNow, type AuditPrincipal } from './auditTx';
import { SNAPSHOT_SEAL_DOMAIN, sign, signingKey } from './seal';
import { SNAPSHOT_CAVEAT, snapshotHash, sumMoney, type SnapshotHeader } from './documents';
import { countPostedLines, fiscalYearStart, journalRows, lineRows, tbRows } from './snapshotRows';
import { snapshotTotals } from './snapshotTotals';
import { recordCheckRun, runAllChecks } from './checks/checkRunService';

export type SnapshotTrigger = 'manual' | 'period_close' | 'vat_lock' | 'year_close';

/** Measured on the fixture (see the design doc): ~N lines/s; the cap keeps a snapshot inside the 60 s statement bound. */
export const MAX_SNAPSHOT_LINES = 150_000;

export class SnapshotTooLargeError extends Error {
  constructor(public readonly lines: number, public readonly max: number) {
    super(`This snapshot would freeze ${lines.toLocaleString('en-ZA')} journal lines; the most a snapshot can hold is ${max.toLocaleString('en-ZA')}. Choose an earlier cutoff.`);
    this.name = 'SnapshotTooLargeError';
  }
}

export interface TakenSnapshot {
  id: string; cutoff: string; takenAt: string; trigger: SnapshotTrigger; canonicalHash: string;
  journals: number; lines: number; accounts: number; checkRunId: string; findings: number; durationMs: number;
}

async function roleOf(client: PoolClient, companyId: string): Promise<string | undefined> {
  const { rows: [r] } = await client.query<{ role: string | null }>('SELECT public.company_member_actor_role($1::uuid) AS role', [companyId]);
  return r?.role ?? undefined;
}

/** The newest change the taker may read — informational; comparisons use taken_at. */
async function highWater(client: PoolClient, companyId: string): Promise<string | null> {
  const role = await roleOf(client, companyId);
  const page = await listEntityChanges(companyId, { types: ENTITY_TYPES.filter((t) => mayReadType(role, t)), limit: 1 });
  const at = page.items[0]?.recordedAt;
  if (!at) return null;
  // Spelled as the column will read back on verification.
  const { rows: [r] } = await client.query<{ t: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`, [at]);
  return r!.t;
}

export async function takeSnapshot(p: AuditPrincipal, input: {
  cutoff: string; trigger: SnapshotTrigger; maxLines?: number;
}): Promise<TakenSnapshot> {
  const key = signingKey();
  const started = Date.now();
  const max = input.maxLines ?? MAX_SNAPSHOT_LINES;
  return runAuditTx(p, 'REPEATABLE READ', async (client) => {
    const lineCount = await countPostedLines(p.companyId, input.cutoff);
    if (lineCount > max) throw new SnapshotTooLargeError(lineCount, max);
    const takenAt = await transactionNow(client);
    const fyStart = await fiscalYearStart(p.companyId, input.cutoff);
    const journals = await journalRows(p.companyId, input.cutoff);
    const lines = await lineRows(p.companyId, input.cutoff);
    const tb = await tbRows(p.companyId, input.cutoff, fyStart);
    const totals = {
      fy_start: fyStart, journal_count: journals.length, line_count: lines.length, account_count: tb.length,
      total_debit: sumMoney(lines.map((l) => l.row.debit)), total_credit: sumMoney(lines.map((l) => l.row.credit)),
      ...await snapshotTotals(p.companyId, input.cutoff),
    };
    const run = await recordCheckRun(client, p, {
      asAt: input.cutoff, periodStart: fyStart, purpose: 'snapshot', key,
      results: await runAllChecks({ companyId: p.companyId, from: fyStart, to: input.cutoff }),
    });
    const header: SnapshotHeader = {
      id: crypto.randomUUID(), companyId: p.companyId, cutoff: input.cutoff, takenAt, takenBy: p.userId,
      trigger: input.trigger, caveat: SNAPSHOT_CAVEAT, masterDataHighWater: await highWater(client, p.companyId), totals,
      checkRun: { id: run.id, canonicalHash: run.canonicalHash },
    };
    const canonicalHash = snapshotHash(header, tb, journals, lines);
    const seal = sign(SNAPSHOT_SEAL_DOMAIN, { companyId: p.companyId, id: header.id, canonicalHash, cutoff: input.cutoff, takenAt }, key);
    await client.query('SELECT public.audit_snapshot_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)', [
      JSON.stringify({
        id: header.id, company_id: p.companyId, cutoff: input.cutoff, taken_at: takenAt, taken_by: p.userId,
        trigger: input.trigger, status: 'sealed', failure_reason: null, canonical_hash: canonicalHash, hmac: seal.hmac,
        key_id: seal.keyId, master_data_high_water: header.masterDataHighWater, totals, caveat: SNAPSHOT_CAVEAT,
        check_run_id: run.id,
      }),
      JSON.stringify(tb.map((t) => ({ account_id: t.accountId, row: t.row }))),
      JSON.stringify(journals.map((j) => ({ journal_id: j.journalId, entry_date: j.entryDate, row: j.row, material_hash: j.materialHash }))),
      JSON.stringify(lines.map((l) => ({ line_id: l.lineId, journal_id: l.journalId, row: l.row, material_hash: l.materialHash }))),
    ]);
    return {
      id: header.id, cutoff: input.cutoff, takenAt, trigger: input.trigger, canonicalHash, journals: journals.length,
      lines: lines.length, accounts: tb.length, checkRunId: run.id,
      findings: run.results.reduce((n, r) => n + r.findingCount, 0), durationMs: Date.now() - started,
    };
  });
}

/** Records an attempt that did not produce a snapshot (automatic triggers only), with why. */
export async function recordFailedSnapshot(p: AuditPrincipal, input: {
  cutoff: string; trigger: Exclude<SnapshotTrigger, 'manual'>; reason: string;
}): Promise<string> {
  return runAuditTx(p, 'READ COMMITTED', async (client) => {
    const id = crypto.randomUUID();
    await client.query('SELECT public.audit_snapshot_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)', [
      JSON.stringify({
        id, company_id: p.companyId, cutoff: input.cutoff, taken_at: await transactionNow(client), taken_by: p.userId,
        trigger: input.trigger, status: 'failed', failure_reason: input.reason.slice(0, 500), canonical_hash: null,
        hmac: null, key_id: null, master_data_high_water: null, totals: {}, caveat: SNAPSHOT_CAVEAT, check_run_id: null,
      }), '[]', '[]', '[]',
    ]);
    return id;
  });
}
