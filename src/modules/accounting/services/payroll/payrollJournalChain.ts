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
  /**
   * The reversal links do not form a chain that ends: they loop (A reversed by
   * B, B by A; a journal reversing itself) or run past MAX_CHAIN_JOURNALS. Bad
   * data or a forged link. `state` is then 'unclear' and `journals` holds each
   * journal once; every caller refuses.
   */
  broken: boolean;
}

/**
 * The most journals a reversal chain is followed through — in the reads, the
 * walk to the root and the lock. Real chains have one to four. Every walk
 * stops here, so a loop in the links costs a bounded number of rows, never an
 * unbounded query or unbounded memory, and ends in a refusal.
 */
export const MAX_CHAIN_JOURNALS = 25;

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
       WHERE e.company_id = ${companyId}::uuid AND chain.depth < ${MAX_CHAIN_JOURNALS}
    )
    SELECT e.id, e.entry_number, e.entry_date, e.status, e.description, chain.depth,
           l.gl_account_id, (round(l.debit * 100) - round(l.credit * 100))::float8 AS cents
      FROM chain
      JOIN gl_journal_entries e ON e.id = chain.id
      LEFT JOIN gl_journal_lines l ON l.journal_entry_id = e.id AND l.company_id = e.company_id
     ORDER BY chain.depth, e.id, l.id
  `) as DbRow[];
  if (rows.length === 0) return null;

  // A journal met at two depths is a loop; one met at the cap is a chain too long to judge.
  const depthOf = new Map<string, number>();
  const broken = rows.some((r) => {
    const id = String(r.id);
    const depth = Number(r.depth);
    if (depth >= MAX_CHAIN_JOURNALS || (depthOf.has(id) && depthOf.get(id) !== depth)) return true;
    depthOf.set(id, depth);
    return false;
  });

  const journals: ChainJournal[] = [];
  const net = new Map<string, number>();
  const first = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => {
    const n = (m.get(k) ?? 0) + v;
    if (n === 0) m.delete(k); else m.set(k, n);
  };
  for (const r of rows) {
    const id = String(r.id);
    if (broken && journals.some((j) => j.id === id)) continue; // each journal once; the net is not used
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
  const state: ChainState = draft || broken ? 'unclear'
    : alone ? 'in_force'
      : net.size === 0 ? 'out'
        : sameNet(net, first) ? 'in_force' : 'unclear';
  return { journals, state, broken };
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

/**
 * The first journal of the chain `journalId` belongs to (itself, when it
 * reverses nothing). Null when no first journal is reached within
 * MAX_CHAIN_JOURNALS links — the links loop, or the chain is too long: the
 * caller refuses.
 */
export async function findChainRoot(companyId: string, journalId: string, db: TxSql = sql): Promise<string | null> {
  const rows = (await db`
    WITH RECURSIVE up AS (
      SELECT id, reversal_of_id, 0 AS depth FROM gl_journal_entries
       WHERE id = ${journalId}::uuid AND company_id = ${companyId}::uuid
      UNION ALL
      SELECT e.id, e.reversal_of_id, up.depth + 1 FROM gl_journal_entries e
        JOIN up ON e.id = up.reversal_of_id
       WHERE e.company_id = ${companyId}::uuid AND up.depth < ${MAX_CHAIN_JOURNALS}
    )
    SELECT id FROM up WHERE reversal_of_id IS NULL ORDER BY depth LIMIT 1
  `) as DbRow[];
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * Lock the chain FOR UPDATE: the first journal, then each reversal in chain
 * order (see LOCK ORDER above). Once the last one is held no reversal can be
 * added — the reversal claim needs that row. Bounded (MAX_CHAIN_JOURNALS). Call inside a bounded wait
 * (payrollRunLock#withBoundedLockWait) and read the chain after it returns.
 */
export async function lockJournalChain(tx: TxSql, companyId: string, rootId: string): Promise<void> {
  let ids = ((await tx`
    SELECT id FROM gl_journal_entries
     WHERE id = ${rootId}::uuid AND company_id = ${companyId}::uuid
       FOR UPDATE
  `) as DbRow[]).map((r) => String(r.id));
  // Bounded twice over: a row is locked once (`seen`), so a loop in the links
  // ends; and the walk stops at MAX_CHAIN_JOURNALS, so an endless chain does
  // too. Either way the read that follows reports the chain `broken` and the
  // caller refuses — this function only ever holds a bounded set of rows.
  const seen = new Set(ids);
  while (ids.length > 0 && seen.size < MAX_CHAIN_JOURNALS) {
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
 * True when the run's lines were written after it was last approved onto its
 * journal — the run was recalculated since. Both sides are CLOCK times taken
 * under the run's header lock: calculatePayrollRun stamps each line with
 * clock_timestamp() at the insert, and approvePayrollRun stamps the header's
 * lines_confirmed_at with clock_timestamp() after its gate confirmed the lines
 * match the journal (migration 718; a reopen does not clear it). Only a calculation that took the lock after that approval
 * committed (which needs a reopen) can write a later line.
 *
 * The journal's created_at is the approving transaction's START, so an
 * approval that waited behind a calculation looked older than the lines it
 * was built from and the run read as recalculated for good (round 6, breaker
 * P2-A). It is used only for a run approved before lines_confirmed_at was written.
 */
export async function runRecalculatedSince(companyId: string, runId: string, journalId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT (SELECT max(prl.created_at) FROM payroll_run_lines prl WHERE prl.run_id = h.id)
             > COALESCE(h.lines_confirmed_at, e.created_at) AS recalculated
      FROM payroll_run_headers h
      JOIN gl_journal_entries e ON e.id = ${journalId}::uuid AND e.company_id = h.company_id
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
  `) as DbRow[];
  return rows[0]?.recalculated === true;
}
