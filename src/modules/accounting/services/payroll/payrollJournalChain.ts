/**
 * A pay run's journal and its reversal chain, judged by what is in the LEDGER.
 *
 * reverseJournalEntry never changes a journal's status: it stamps the original
 * `reversed_at` and posts a contra whose `reversal_of_id` points back. A contra
 * can be reversed in turn, and so on — a chain. `reversed_at` on the first
 * journal therefore says only that a chain exists, not whether the run's
 * amounts are in the ledger: journal + reversal nets to nothing, journal +
 * reversal + reversal-of-the-reversal is the journal again.
 *
 * So everything that asks "is this run's journal in force?" asks the chain's
 * NET (W3-01 round 5): approval's gate, the loan guard in calculate, and the
 * guard on the generic reversal. One judgement, three callers.
 *
 * LOCK ORDER, wherever these rows are locked together:
 *   run header → the run's journal (chain root) → each reversal, in chain order.
 * reverseJournalEntry itself locks one row, the entry it reverses, which is
 * always the END of a chain; the payroll guard takes the locks above first, in
 * this order, so approval and a reversal can never hold them crosswise.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';

export interface ChainJournal {
  id: string;
  entryNumber: string;
  /** YYYY-MM-DD. */
  entryDate: string;
  status: string;
  description: string;
}

/**
 * `in_force` — the posted journals of the chain net to the first journal.
 * `out`      — they net to zero: nothing of it is in the ledger.
 * `unclear`  — neither, or one of them is a draft that could still post.
 */
export type ChainState = 'in_force' | 'out' | 'unclear';

export interface JournalChain {
  /** The run's journal first, then each reversal in the order they were made. */
  journals: ChainJournal[];
  state: ChainState;
}

const sameNet = (a: Map<string, number>, b: Map<string, number>): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Null when `rootId` is not a journal of this company. Read-only. */
export async function readJournalChain(companyId: string, rootId: string, db: TxSql = sql): Promise<JournalChain | null> {
  const rows = (await db`
    WITH RECURSIVE chain AS (
      SELECT id, 0 AS depth FROM gl_journal_entries
       WHERE id = ${rootId}::uuid AND company_id = ${companyId}::uuid
      UNION ALL
      SELECT e.id, chain.depth + 1 FROM gl_journal_entries e
        JOIN chain ON e.reversal_of_id = chain.id
       WHERE e.company_id = ${companyId}::uuid
    )
    SELECT e.id, e.entry_number, e.entry_date, e.status, e.description, chain.depth,
           l.gl_account_id, (round(l.debit * 100) - round(l.credit * 100))::float8 AS cents
      FROM chain
      JOIN gl_journal_entries e ON e.id = chain.id
      LEFT JOIN gl_journal_lines l ON l.journal_entry_id = e.id AND l.company_id = e.company_id
     ORDER BY chain.depth, e.id, l.id
  `) as DbRow[];
  if (rows.length === 0) return null;

  const journals: ChainJournal[] = [];
  const net = new Map<string, number>();
  const first = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => {
    const n = (m.get(k) ?? 0) + v;
    if (n === 0) m.delete(k); else m.set(k, n);
  };
  for (const r of rows) {
    const id = String(r.id);
    if (journals[journals.length - 1]?.id !== id) {
      journals.push({
        id,
        entryNumber: String(r.entry_number ?? ''),
        entryDate: r.entry_date instanceof Date ? r.entry_date.toISOString().slice(0, 10) : String(r.entry_date).slice(0, 10),
        status: String(r.status),
        description: String(r.description ?? ''),
      });
    }
    if (r.gl_account_id == null || String(r.status) !== 'posted') continue;
    add(net, String(r.gl_account_id), Number(r.cents));
    if (Number(r.depth) === 0) add(first, String(r.gl_account_id), Number(r.cents));
  }

  // A posted journal nothing has reversed is in force whatever its lines say:
  // only a reversal takes a journal out.
  const draft = journals.some((j) => j.status === 'draft');
  const alone = journals.length === 1 && journals[0]!.status === 'posted';
  const state: ChainState = draft ? 'unclear'
    : alone ? 'in_force'
      : net.size === 0 ? 'out'
        : sameNet(net, first) ? 'in_force' : 'unclear';
  return { journals, state };
}

/** True when this journal's amounts are (or may be) in the ledger: anything but a chain that nets to zero. */
export async function payrollJournalInForce(companyId: string, journalId: string, db: TxSql = sql): Promise<boolean> {
  const chain = await readJournalChain(companyId, journalId, db);
  return chain != null && chain.state !== 'out';
}

/** The linked journal's id while it is in force, else null — what the loan guard in calculate must be told. */
export async function journalInForceOrNull(companyId: string, journalId: unknown): Promise<string | null> {
  if (journalId == null) return null;
  return await payrollJournalInForce(companyId, String(journalId)) ? String(journalId) : null;
}

/** The first journal of the chain `journalId` belongs to (itself, when it reverses nothing). */
export async function findChainRoot(companyId: string, journalId: string, db: TxSql = sql): Promise<string> {
  const rows = (await db`
    WITH RECURSIVE up AS (
      SELECT id, reversal_of_id FROM gl_journal_entries
       WHERE id = ${journalId}::uuid AND company_id = ${companyId}::uuid
      UNION ALL
      SELECT e.id, e.reversal_of_id FROM gl_journal_entries e
        JOIN up ON e.id = up.reversal_of_id
       WHERE e.company_id = ${companyId}::uuid
    )
    SELECT id FROM up WHERE reversal_of_id IS NULL
  `) as DbRow[];
  return rows[0] ? String(rows[0].id) : journalId;
}

/**
 * Lock the chain FOR UPDATE: the first journal, then each reversal in chain
 * order (see LOCK ORDER above). Once the last one is held no reversal can be
 * added — the reversal claim needs that row. Call inside a bounded wait
 * (payrollRunLock#withBoundedLockWait) and read the chain after it returns.
 */
export async function lockJournalChain(tx: TxSql, companyId: string, rootId: string): Promise<void> {
  let ids = ((await tx`
    SELECT id FROM gl_journal_entries
     WHERE id = ${rootId}::uuid AND company_id = ${companyId}::uuid
       FOR UPDATE
  `) as DbRow[]).map((r) => String(r.id));
  // `seen` ends the walk even if the rows ever formed a loop: a row is locked once.
  const seen = new Set(ids);
  while (ids.length > 0) {
    ids = ((await tx`
      SELECT id FROM gl_journal_entries
       WHERE reversal_of_id = ANY(${ids}::uuid[]) AND company_id = ${companyId}::uuid
       ORDER BY id
         FOR UPDATE
    `) as DbRow[]).map((r) => String(r.id)).filter((id) => !seen.has(id));
    for (const id of ids) seen.add(id);
  }
}

/**
 * True when the run's lines were written after its journal was posted — the
 * run was recalculated since. calculatePayrollRun deletes and re-inserts the
 * lines, stamping them with the clock at the insert, which is after it holds
 * the run's header lock; the journal carries its approval's transaction start.
 * A calculation can therefore only ever look LATER than it was, which errs
 * toward the stricter comparison.
 */
export async function runRecalculatedSince(companyId: string, runId: string, journalId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT (SELECT max(prl.created_at) FROM payroll_run_lines prl
              JOIN payroll_run_headers h ON h.id = prl.run_id
             WHERE prl.run_id = ${runId}::uuid AND h.company_id = ${companyId}::uuid) > e.created_at AS recalculated
      FROM gl_journal_entries e
     WHERE e.id = ${journalId}::uuid AND e.company_id = ${companyId}::uuid
  `) as DbRow[];
  return rows[0]?.recalculated === true;
}
