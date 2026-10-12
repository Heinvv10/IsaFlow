/**
 * Taking an audit snapshot: one REPEATABLE READ transaction on its own
 * connection (auditTx), so the trial balance, the journals, the lines, the
 * totals and the check run are one moment of the books. Size-capped: over
 * MAX_SNAPSHOT_LINES posted lines the snapshot is refused before anything is
 * read. Sealed (canonical hash + HMAC) and written through the definer in one
 * call. A refused automatic attempt is recorded as 'failed' with its reason.
 */
import type { PoolClient } from 'pg';
import { log } from '@/lib/logger';
import { listEntityChanges } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { ENTITY_TYPES, mayReadType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { runAuditTx, transactionNow, type AuditPrincipal } from './auditTx';
import { withSnapshotSlot } from './snapshotSlots';
import { SNAPSHOT_SEAL_DOMAIN, sign, signingKey } from './seal';
import { SNAPSHOT_CAVEAT, ledgerFingerprint, snapshotHash, sumMoney, type SnapshotHeader } from './documents';
import { countPostedLines, fiscalYearStart, journalRows, lineRows, tbRows } from './snapshotRows';
import { snapshotTotals } from './snapshotTotals';
import { recordCheckRun, runAllChecks } from './checks/checkRunService';

export type SnapshotTrigger = 'manual' | 'period_close' | 'vat_lock' | 'year_close';

/**
 * Measured on a fixture (docs/evidence/audit-snapshots/size-cap-measurement.txt): 50 000 lines took 11 s, 150 000
 * took 33 s end to end (verify 18 s, compare 19 s; ~77 MB of frozen lines). Over the cap a snapshot is refused.
 */
export const MAX_SNAPSHOT_LINES = 150_000;

export class SnapshotTooLargeError extends Error {
  constructor(public readonly lines: number, public readonly max: number) {
    super(`This snapshot would freeze ${lines.toLocaleString('en-ZA')} journal lines; the most a snapshot can hold is ${max.toLocaleString('en-ZA')}. Choose an earlier cutoff.`);
    this.name = 'SnapshotTooLargeError';
  }
}

/** A whole snapshot may take this long; past it, it is abandoned (statements are capped at 60 s each besides). */
export const SNAPSHOT_TIME_BUDGET_MS = 120_000;

export class SnapshotTimeBudgetError extends Error {
  constructor(public readonly step: string) {
    super(`This snapshot took longer than ${SNAPSHOT_TIME_BUDGET_MS / 1000} s (at ${step}) and was abandoned. Choose an earlier cutoff or try again later.`);
    this.name = 'SnapshotTimeBudgetError';
  }
}

export interface TakenSnapshot {
  id: string; cutoff: string; takenAt: string; trigger: SnapshotTrigger; canonicalHash: string;
  journals: number; lines: number; accounts: number; checkRunId: string; findings: number; durationMs: number; seq: number;
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
  const budget = (step: string) => { if (Date.now() - started > SNAPSHOT_TIME_BUDGET_MS) throw new SnapshotTimeBudgetError(step); };
  // By hand: refused while busy. Automatic: waits its turn.
  const wait = input.trigger !== 'manual';
  const taken = await withSnapshotSlot(p.companyId, wait, () => runAuditTx(p, 'REPEATABLE READ', async (client) => {
    const lineCount = await countPostedLines(p.companyId, input.cutoff);
    if (lineCount > max) throw new SnapshotTooLargeError(lineCount, max);
    const takenAt = await transactionNow(client);
    const { rows: [prev] } = await client.query<{ seq: number; hmac: string }>(
      `SELECT seq, hmac FROM audit_snapshots WHERE company_id = $1::uuid AND status = 'sealed' ORDER BY seq DESC LIMIT 1`, [p.companyId]);
    const chain = { seq: (prev?.seq ?? 0) + 1, prevHmac: prev?.hmac ?? null };
    const fyStart = await fiscalYearStart(p.companyId, input.cutoff);
    const journals = await journalRows(p.companyId, input.cutoff);
    const lines = await lineRows(p.companyId, input.cutoff);
    const tb = await tbRows(p.companyId, input.cutoff, fyStart);
    budget('reading the ledger');
    const totals = {
      fy_start: fyStart, journal_count: journals.length, line_count: lines.length, account_count: tb.length,
      ledger_fingerprint: ledgerFingerprint(tb, journals, lines),
      total_debit: sumMoney(lines.map((l) => l.row.debit)), total_credit: sumMoney(lines.map((l) => l.row.credit)),
      ...await snapshotTotals(p.companyId, input.cutoff),
    };
    const run = await recordCheckRun(client, p, {
      asAt: input.cutoff, periodStart: fyStart, purpose: 'snapshot', key,
      results: await runAllChecks({ companyId: p.companyId, from: fyStart, to: input.cutoff }),
    });
    budget('the check run');
    const header: SnapshotHeader = {
      id: crypto.randomUUID(), companyId: p.companyId, cutoff: input.cutoff, takenAt, takenBy: p.userId,
      trigger: input.trigger, caveat: SNAPSHOT_CAVEAT, masterDataHighWater: await highWater(client, p.companyId), totals,
      checkRun: { id: run.id, canonicalHash: run.canonicalHash },
    };
    const canonicalHash = snapshotHash(header, tb, journals, lines);
    const seal = sign(SNAPSHOT_SEAL_DOMAIN, { companyId: p.companyId, id: header.id, canonicalHash, cutoff: input.cutoff, takenAt, chain }, key);
    await client.query('SELECT public.audit_snapshot_record($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)', [
      JSON.stringify({
        id: header.id, company_id: p.companyId, cutoff: input.cutoff, taken_at: takenAt, taken_by: p.userId,
        trigger: input.trigger, status: 'sealed', failure_reason: null, canonical_hash: canonicalHash, hmac: seal.hmac,
        key_id: seal.keyId, master_data_high_water: header.masterDataHighWater, totals, caveat: SNAPSHOT_CAVEAT,
        check_run_id: run.id, seq: chain.seq, prev_hmac: chain.prevHmac,
      }),
      JSON.stringify(tb.map((t) => ({ account_id: t.accountId, row: t.row }))),
      JSON.stringify(journals.map((j) => ({ journal_id: j.journalId, entry_date: j.entryDate, row: j.row, material_hash: j.materialHash }))),
      JSON.stringify(lines.map((l) => ({ line_id: l.lineId, journal_id: l.journalId, row: l.row, material_hash: l.materialHash }))),
    ]);
    return {
      id: header.id, cutoff: input.cutoff, takenAt, trigger: input.trigger, canonicalHash, journals: journals.length,
      lines: lines.length, accounts: tb.length, checkRunId: run.id,
      findings: run.results.reduce((n, r) => n + r.findingCount, 0), durationMs: Date.now() - started, seq: chain.seq,
    };
  }, { chainLock: wait ? 'wait' : 'try' }));
  // The chain head, written outside the database as well (the journal keeps it): a removed latest snapshot shows here.
  log.info('audit: snapshot sealed', { companyId: p.companyId, snapshotId: taken.id, seq: taken.seq, hash: taken.canonicalHash,
    cutoff: taken.cutoff, trigger: taken.trigger, lines: taken.lines, durationMs: taken.durationMs }, 'audit');
  return taken;
}
