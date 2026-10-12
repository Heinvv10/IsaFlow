/**
 * Taking an audit snapshot: one REPEATABLE READ transaction on its own
 * connection (auditTx), so the trial balance, the journals, the lines, the
 * totals and the check run are one moment of the books. Size-capped: over
 * MAX_SNAPSHOT_LINES posted lines the snapshot is refused before anything is
 * read. Sealed (canonical hash + HMAC) and written through the definer in one
 * call. A refused automatic attempt is recorded as 'failed' with its reason.
 *
 * Time-bound: before each step (and each check, and each ageing / control total) the time left of
 * SNAPSHOT_TIME_BUDGET_MS is checked and statement_timeout tightened to it; past the deadline a watchdog cancels
 * whatever statement is running, so the budget holds however many statements a step runs.
 */
import type { PoolClient } from 'pg';
import { log } from '@/lib/logger';
import { getPool } from '@/lib/neon';
import { listEntityChanges } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { ENTITY_TYPES, mayReadType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { AUDIT_WAIT_MS, SNAPSHOT_TIME_BUDGET_MS, runAuditTx, tightenStatementTimeout, transactionNow, type AuditPrincipal } from './auditTx';
import { withSnapshotSlot } from './snapshotSlots';
import { SNAPSHOT_SEAL_DOMAIN, checkSeal, sign, signingKey, type SigningKey } from './seal';
import { sealedChain, type ChainLink } from './snapshotRead';
import { DOCUMENT_VERSION, SNAPSHOT_CAVEAT, contentFingerprint, snapshotHash, sumMoney, type SnapshotHeader } from './documents';
import { countPostedLines, fiscalYearStart, journalRows, lineRows, tbRows } from './snapshotRows';
import { snapshotTotals } from './snapshotTotals';
import { recordCheckRun, runAllChecks } from './checks/checkRunService';
import { lockStands, recordAttempt, verifiedTwin } from './snapshotAttempts';

export { SNAPSHOT_TIME_BUDGET_MS };

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

export class SnapshotTimeBudgetError extends Error {
  constructor(public readonly step: string) {
    super(`This snapshot took longer than ${SNAPSHOT_TIME_BUDGET_MS / 1000} s (at ${step}) and was abandoned. Choose an earlier cutoff or try again later.`);
    this.name = 'SnapshotTimeBudgetError';
  }
}

/** An automatic snapshot whose close / lock was undone while it waited for its turn: it freezes nothing. */
export class LockGoneError extends Error {
  constructor(trigger: string, cutoff: string) {
    super(`the ${trigger.replace('_', ' ')} at ${cutoff} no longer stands (undone before its snapshot ran); nothing was frozen`);
    this.name = 'LockGoneError';
  }
}

export interface TakenSnapshot {
  status: 'sealed'; id: string; cutoff: string; takenAt: string; trigger: SnapshotTrigger; canonicalHash: string;
  journals: number; lines: number; accounts: number; checkRunId: string; findings: number; durationMs: number; seq: number;
}

/** An automatic attempt whose books matched a sealed, verifying snapshot at the same cutoff: a reference (no copy) and its own check run. */
export interface UnchangedSnapshot { status: 'unchanged'; id: string; cutoff: string; trigger: SnapshotTrigger; sameAs: string; checkRunId: string }

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

/**
 * The next link: numbered after every sealed row, naming the newest one whose seal verifies. A row written through
 * the writer without the key (forged) is skipped, never chained to — verifyChain lists it as forged.
 */
function nextLink(links: ChainLink[], companyId: string, key: SigningKey): { seq: number; prevHmac: string | null } {
  const genuine = [...links].reverse().find((l) => checkSeal(SNAPSHOT_SEAL_DOMAIN, { companyId, id: l.id, canonicalHash: l.canonicalHash,
    cutoff: l.cutoff, takenAt: l.takenAt, chain: { seq: l.seq, prevHmac: l.prevHmac } }, l.hmac, l.keyId, key) === 'valid');
  return { seq: (links[links.length - 1]?.seq ?? 0) + 1, prevHmac: genuine?.hmac ?? null };
}

/**
 * The budget's hard edge: tightening statement_timeout bounds each statement by what was left when its step began,
 * but a step runs several statements. Past the deadline this cancels whatever the snapshot's connection is running,
 * every half second, until the snapshot stops. Stopped (and its last cancel awaited) before the connection goes back
 * to the pool, so a late cancel can never reach another request's statement.
 */
async function budgetWatchdog(client: PoolClient, deadline: number): Promise<{ stop: () => Promise<void> }> {
  const { rows: [me] } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  let inflight: Promise<unknown> = Promise.resolve();
  let tick: NodeJS.Timeout | undefined;
  const cancel = () => {
    inflight = getPool().query('SELECT pg_cancel_backend($1)', [me!.pid]).catch((err: unknown) =>
      log.warn('audit: could not cancel an over-budget snapshot statement', { error: String(err) }, 'audit'));
  };
  const start = setTimeout(() => { cancel(); tick = setInterval(cancel, 500); }, Math.max(0, deadline - Date.now()));
  return { stop: async () => { clearTimeout(start); clearInterval(tick); await inflight; } };
}

const isStatementTimeout = (err: unknown) => (err as { code?: string } | null)?.code === '57014';

async function snapshot(p: AuditPrincipal, input: { cutoff: string; trigger: SnapshotTrigger; maxLines?: number },
  dedupe: boolean): Promise<TakenSnapshot | UnchangedSnapshot> {
  const key = signingKey();
  const max = input.maxLines ?? MAX_SNAPSHOT_LINES;
  // By hand: refused while busy. Automatic: waits its turn (bounded).
  const wait = input.trigger !== 'manual';
  const taken = await withSnapshotSlot(p.companyId, wait, () => runAuditTx(p, 'REPEATABLE READ', async (client) => {
    let at = 'starting';
    // The budget runs from here, with the slot and the company's lock held: waiting for them is bounded on its own
    // (AUDIT_WAIT_MS) and is not this snapshot's time.
    const started = Date.now();
    const dog = await budgetWatchdog(client, started + SNAPSHOT_TIME_BUDGET_MS);
    /** Before each step: abandon past the budget, and no statement may outrun what is left of it. */
    const step = async (name: string) => {
      at = name;
      const left = SNAPSHOT_TIME_BUDGET_MS - (Date.now() - started);
      if (left <= 0) throw new SnapshotTimeBudgetError(name);
      await tightenStatementTimeout(client, left);
    };
    try {
      // An automatic snapshot may have queued: the books it freezes must be those of a standing close / lock, read in
      // this transaction's own view (REPEATABLE READ), not as checked before the wait.
      if (dedupe && !(await lockStands(client, p.companyId, input.trigger as Exclude<SnapshotTrigger, 'manual'>, input.cutoff))) {
        throw new LockGoneError(input.trigger, input.cutoff);
      }
      await step('counting the lines');
      const lineCount = await countPostedLines(p.companyId, input.cutoff);
      if (lineCount > max) throw new SnapshotTooLargeError(lineCount, max);
      const takenAt = await transactionNow(client);
      const chain = nextLink(await sealedChain(p.companyId), p.companyId, key);
      await step('reading the ledger');
      const fyStart = await fiscalYearStart(p.companyId, input.cutoff);
      const journals = await journalRows(p.companyId, input.cutoff);
      await step('reading the lines');
      const lines = await lineRows(p.companyId, input.cutoff);
      await step('the trial balance');
      const tb = await tbRows(p.companyId, input.cutoff, fyStart);
      const books = await snapshotTotals(p.companyId, input.cutoff, step);
      await step('the check run');
      const results = await runAllChecks({ companyId: p.companyId, from: fyStart, to: input.cutoff }, step);
      await step('sealing');
      const fingerprint = contentFingerprint(tb, journals, lines, books);
      const sameAs = dedupe ? await verifiedTwin(client, p.companyId, input.cutoff, fingerprint, key) : null;
      if (dedupe) await step('sealing');
      const run = await recordCheckRun(client, p, { asAt: input.cutoff, periodStart: fyStart, purpose: 'snapshot', key, results });
      if (sameAs) {
        // The same books as a sealed snapshot: a reference to it, with this attempt's own sealed check run.
        const id = await recordAttempt(client, p, { cutoff: input.cutoff, trigger: input.trigger as Exclude<SnapshotTrigger, 'manual'>,
          status: 'unchanged', sameAs, checkRunId: run.id });
        return { status: 'unchanged' as const, id, cutoff: input.cutoff, trigger: input.trigger, sameAs, checkRunId: run.id };
      }
      const totals = {
        document_version: DOCUMENT_VERSION, fy_start: fyStart, journal_count: journals.length, line_count: lines.length,
        account_count: tb.length, content_fingerprint: fingerprint,
        total_debit: sumMoney(lines.map((l) => l.row.debit)), total_credit: sumMoney(lines.map((l) => l.row.credit)), ...books,
      };
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
        status: 'sealed' as const, id: header.id, cutoff: input.cutoff, takenAt, trigger: input.trigger, canonicalHash,
        journals: journals.length, lines: lines.length, accounts: tb.length, checkRunId: run.id,
        findings: run.results.reduce((n, r) => n + r.findingCount, 0), durationMs: Date.now() - started, seq: chain.seq,
      };
    } catch (err) {
      // A statement cut off by the tightened timeout: the budget ran out inside that step.
      if (isStatementTimeout(err)) throw new SnapshotTimeBudgetError(at);
      throw err;
    } finally {
      await dog.stop();
    }
  }, { chainLock: wait ? { waitMs: AUDIT_WAIT_MS } : 'try' }), p.userId);
  if (taken.status === 'sealed') {
    // The chain head, written outside the database as well (the journal keeps it): a removed latest snapshot shows here.
    log.info('audit: snapshot sealed', { companyId: p.companyId, snapshotId: taken.id, seq: taken.seq, hash: taken.canonicalHash,
      cutoff: taken.cutoff, trigger: taken.trigger, lines: taken.lines, durationMs: taken.durationMs }, 'audit');
  }
  return taken;
}

/** A snapshot by hand (or an agent): always a fresh sealed copy. */
export async function takeSnapshot(p: AuditPrincipal, input: { cutoff: string; trigger: SnapshotTrigger; maxLines?: number }): Promise<TakenSnapshot> {
  return await snapshot(p, input, false) as TakenSnapshot;
}

/** An automatic snapshot: an 'unchanged' reference when a sealed snapshot at the cutoff holds the same content. */
export function takeAutoSnapshot(p: AuditPrincipal, input: { cutoff: string; trigger: Exclude<SnapshotTrigger, 'manual'> }): Promise<TakenSnapshot | UnchangedSnapshot> {
  return snapshot(p, input, true);
}
