/**
 * What the generic journal reversal must refuse about a PAY RUN's journal.
 *
 * reverseJournalEntry (journal-entries-action, MCP reverse_journal_entry, any
 * service) knew nothing about pay runs, so it could (W3-01 round 5):
 *   · reverse the journal of an APPROVED run — the run stayed approved with
 *     nothing of it in the ledger;
 *   · reverse the REVERSAL of a run's journal — re-booking the old amounts
 *     beside the fresh journal an approval had since posted, the month twice.
 *
 * The rule, by what is in the ledger (payrollJournalChain):
 *   · the chain nets to zero → reversing its last journal would put the run's
 *     amounts back. Refused: to re-book a run, approve it again.
 *   · the chain is in force and the run that links it is approved or paid →
 *     refused: reopen the pay run first (a paid run cannot be reopened).
 *   · otherwise allowed — taking a reopened run's journal out, or taking out
 *     amounts that an older un-reversal put back.
 *
 * Under the run-header lock, then the chain's locks, in approval's order, so
 * the two cannot interleave: a reversal either finished before approval
 * judged the chain or waits until approval has committed and is judged here
 * against what approval left.
 *
 * Scope: journals posted by a pay run only. UIF-declaration and tax-directive
 * payments also carry source 'auto_payroll'; they are not a run's journal.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { MAX_CHAIN_JOURNALS, findChainRoot, lockJournalChain, readJournalChain } from './payrollJournalChain';
import { lockPayrollRunHeader, withBoundedLockWait } from './payrollRunLock';
import { PayrollLoanLockTimeoutError } from './payrollRunLoanApplication';

/** Raised before the reversal writes anything; its message is for the caller. */
export class PayrollJournalReversalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollJournalReversalRefusedError';
  }
}

/**
 * The guard's 5s wait for the run header or the journal's reversal chain ran
 * out: another request (an approve, a reopen, a calculation, another reversal)
 * is changing the run. Raised before anything is written; retryable. Its own
 * class — the loan-lock error it replaced said "being calculated" whoever held
 * the run (W3-01 round 6).
 */
export class PayrollRunBusyError extends Error {
  readonly code = 'PAYROLL_RUN_LOCK_TIMEOUT';
  constructor(runId: string) {
    super(`Payroll run ${runId} is being changed by another request — retry in a moment.`);
    this.name = 'PayrollRunBusyError';
  }
}

/** The description postPayrollRunJournal gives a run's journal (payrollJournalBuilder). */
const RUN_JOURNAL = /^Payroll run (\d{4})-(\d{2})$/;

interface RunRef { id: string; status: string; linksRoot: boolean }

/** The run this journal belongs to: the one linking it, else the one for the period it names. */
async function payRunOf(companyId: string, rootId: string, description: string, db: TxSql): Promise<RunRef | null> {
  const period = RUN_JOURNAL.exec(description);
  const rows = (await db`
    SELECT id, status, (journal_entry_id = ${rootId}::uuid) AS links_root
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND (journal_entry_id = ${rootId}::uuid
            OR (period_year = ${period ? Number(period[1]) : -1} AND period_month = ${period ? Number(period[2]) : -1}))
     ORDER BY (journal_entry_id = ${rootId}::uuid) DESC NULLS LAST
     LIMIT 1
  `) as DbRow[];
  return rows[0] ? { id: String(rows[0].id), status: String(rows[0].status), linksRoot: rows[0].links_root === true } : null;
}

async function judge(companyId: string, rootId: string, db: TxSql): Promise<string | null> {
  const chain = await readJournalChain(companyId, rootId, db);
  const root = chain?.journals[0];
  if (!chain || !root) return null;
  const run = await payRunOf(companyId, rootId, root.description, db);
  if (!run) return null; // 'auto_payroll', but not a pay run's journal
  const numbers = chain.journals.map((j) => j.entryNumber).join(', ');
  if (chain.broken) return brokenChain(numbers);

  if (chain.state === 'out') {
    return `Journal ${root.entryNumber} is a pay run's journal that has been reversed (${numbers} net to zero). `
      + 'Reversing its reversal would put the run\'s amounts back in the ledger beside any journal the run has posted since. '
      + 'To book the run again, approve the pay run — approval posts a fresh journal.';
  }
  if (chain.state === 'in_force' && run.linksRoot && (run.status === 'approved' || run.status === 'paid')) {
    return run.status === 'paid'
      ? `Journal ${root.entryNumber} is the journal of a PAID pay run, which cannot be reopened — its journal cannot be reversed here.`
      : `Journal ${root.entryNumber} is the journal of an approved pay run. Reopen the pay run first, then reverse its journal — `
        + 'otherwise the run stays approved with nothing in the ledger.';
  }
  return null;
}

const brokenChain = (numbers: string): string =>
  `This payroll journal's reversal links do not form a chain that ends (${numbers}): they loop, or run past ${MAX_CHAIN_JOURNALS} journals. `
  + 'It cannot be reversed here — the links need correcting first.';

/**
 * The refusal for reversing `entry`, or null. Read-only (no locks) — for a dry
 * run. The live path is refuseReversalAgainstPayRun, which asks the same
 * question under the locks.
 */
export async function payrollReversalRefusal(companyId: string, entry: { id: string; source?: string }): Promise<string | null> {
  if (entry.source !== 'auto_payroll') return null;
  const rootId = await findChainRoot(companyId, entry.id);
  return rootId ? judge(companyId, rootId, sql) : brokenChain(entry.id);
}

/**
 * Called by reverseJournalEntry before it claims the entry. Takes the run
 * header, then the chain (LOCK ORDER: payrollJournalChain), with a 5s wait,
 * and judges inside them. Throws PayrollJournalReversalRefusedError, or
 * PayrollRunBusyError when the wait runs out.
 */
export async function refuseReversalAgainstPayRun(companyId: string, entry: { id: string; source?: string }): Promise<void> {
  if (entry.source !== 'auto_payroll') return;
  const rootId = await findChainRoot(companyId, entry.id);
  if (!rootId) throw new PayrollJournalReversalRefusedError(brokenChain(entry.id));
  const chain = await readJournalChain(companyId, rootId);
  const root = chain?.journals[0];
  if (!root) return;
  const run = await payRunOf(companyId, rootId, root.description, sql);
  if (!run) return;

  try {
    await lockPayrollRunHeader(run.id, companyId);
    await withBoundedLockWait(run.id, (tx) => lockJournalChain(tx, companyId, rootId));
  } catch (err) {
    if (err instanceof PayrollLoanLockTimeoutError) throw new PayrollRunBusyError(run.id);
    throw err;
  }
  const refusal = await judge(companyId, rootId, sql);
  if (refusal) throw new PayrollJournalReversalRefusedError(refusal);
}
