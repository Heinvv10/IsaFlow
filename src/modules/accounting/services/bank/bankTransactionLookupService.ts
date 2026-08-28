/**
 * PRD-11 §5 — resolve a bank transaction from the reference printed on the
 * statement.
 *
 * An agent transcribing a bank statement holds the printed reference, not a
 * UUID. Without this it has to list every transaction on the account and match
 * by hand — the "fetch everything first" step PRD-11 exists to remove.
 *
 * TWO COLUMNS carry it, and the one the tool argument is named after is the
 * empty one. Production, 2026-08-28: 9,824 rows have `reference` set and ZERO
 * have `bank_reference`. Every statement importer writes `reference`
 * (`bankImportService`, `bankStatementOcrService`, the classified import,
 * manual capture, the Sage migration commit); only `bankFeedSyncService` and
 * `openBankingSyncService` write `bank_reference`, and they put the provider's
 * external id there rather than the printed reference. Matching
 * `bank_reference` alone therefore answered NOT_FOUND for every reference the
 * MCP pilot could actually read off a statement.
 *
 * PREFERENCE, not union: `reference` wins outright, and `bank_reference` is
 * consulted only for a reference that matched NOTHING in `reference`. The two
 * columns hold different KINDS of value — one printed on a statement, one a
 * provider's opaque external id — so a value that collides across them is a
 * coincidence, and a union would let a feed id shadow the statement reference
 * an agent actually typed. Preference also makes the reported match
 * deterministic.
 *
 * The match is EXACT (after trimming both sides). A prefix/LIKE match would
 * happily resolve "INV-1" onto "INV-10" and post the journal against the wrong
 * row; the reference is also the import dedup key, so exactness is the
 * property the rest of the module already relies on.
 *
 * BATCHED: `bulk_allocate_bank_transactions` resolves up to 500 references in
 * one request that already holds row locks, so one query per line was 500
 * scans of lock hold time. Everything goes through
 * `findBankTransactionsByReferences`, which asks once for the whole set.
 */

import { sql, fmtDate } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Enough for the caller to disambiguate; never the whole row (no leaking
 *  columns the MCP surface does not otherwise expose). */
export interface BankTransactionRefMatch {
  id: string;
  transactionDate: string;
  amount: number;
  description: string | null;
  /**
   * The stored value that matched, trimmed. Never null: it equals the
   * reference the caller supplied (an equality match on a non-blank string
   * cannot come from a NULL column). Carried so an ambiguity reply can show
   * WHICH value each candidate holds.
   */
  matchedReference: string;
  /** Which column matched. `reference` outranks `bank_reference`. */
  matchedColumn: 'reference' | 'bank_reference';
}

/**
 * Candidates per reference, oldest first.
 *
 * Bounded: an ambiguity message is rendered into a tool result, and a
 * pathological statement that repeats one reference hundreds of times must not
 * produce an unbounded payload. Anything past the cap is still ambiguous, which
 * is the only thing the caller acts on. The cap is applied PER REFERENCE
 * (a window function), so one noisy reference in a 500-line batch cannot
 * starve the others out of the result.
 */
const MAX_CANDIDATES = 25;

type RefRows = DbRow[];

/**
 * `.trim()` in JS strips \t \r \n \f and spaces; bare `btrim()` in SQL strips
 * spaces ONLY, so a stored "REF\r" was unreachable from a caller that typed
 * "REF". This character set is exactly ASCII 32, 9, 10, 13, 12 and MUST stay
 * character-for-character identical to migration 519's expression indexes —
 * a different set is a different expression and the planner silently falls
 * back to a full company scan.
 *
 * Deliberately no `\v`: PostgreSQL does not recognise it as an escape, so
 * E'\v' is the literal letter 'v' and would trim the 'v' off every reference.
 * JS `.trim()` does strip \v (and NBSP, and the Unicode space separators);
 * a reference stored with one of those on the end stays unreachable. Not worth
 * a `regexp_replace` that no index can serve.
 *
 * The candidate query, UNRUN. Exported so a DB-gated test can EXPLAIN the
 * REAL statement (`.text` / `.values` off the lazy query) instead of a copy
 * pasted into the test — a copy stays green while the service regresses to a
 * bare `btrim()` the indexes cannot serve.
 */
export function bankTxRefCandidateQuery(
  companyId: string,
  refs: string[],
  bankAccountId: string | null,
) {
  // One row PER (transaction, matching reference): a row can carry one
  // reference in `reference` and a DIFFERENT one in `bank_reference`, and both
  // may be in the same batch. Labelling the row once — "did its `reference`
  // match ANY ref in the batch?" — dropped it from the second reference's
  // candidates entirely, so a batch resolved fewer transactions than the same
  // references resolved one at a time. The join against unnest($refs) makes the
  // reference part of the row's identity here, not a property inferred later.
  //
  // Two arms rather than one with an OR: each arm is a plain equality against
  // one expression index (migration 519), which is what keeps this off a full
  // company scan. A row matching the SAME reference through both columns
  // appears twice and the preference rule in the caller drops the second.
  //
  // The bank-account narrowing is a nullable parameter, not a second copy of
  // the query — that is how two branches drift apart.
  return sql`
    WITH wanted AS (
      SELECT DISTINCT ref FROM unnest(${refs}::TEXT[]) AS ref
    ),
    candidate AS (
      SELECT
        bt.id, bt.transaction_date, bt.amount, bt.description,
        w.ref AS matched_reference,
        'reference' AS matched_column
      FROM bank_transactions bt
      JOIN wanted w ON btrim(bt.reference, E' \\t\\n\\r\\f') = w.ref
      WHERE bt.company_id = ${companyId}::UUID
        AND (${bankAccountId}::UUID IS NULL OR bt.bank_account_id = ${bankAccountId}::UUID)
      UNION ALL
      SELECT
        bt.id, bt.transaction_date, bt.amount, bt.description,
        w.ref AS matched_reference,
        'bank_reference' AS matched_column
      FROM bank_transactions bt
      JOIN wanted w ON btrim(bt.bank_reference, E' \\t\\n\\r\\f') = w.ref
      WHERE bt.company_id = ${companyId}::UUID
        AND (${bankAccountId}::UUID IS NULL OR bt.bank_account_id = ${bankAccountId}::UUID)
    ),
    ranked AS (
      SELECT
        candidate.*,
        ROW_NUMBER() OVER (
          PARTITION BY matched_reference, matched_column
          ORDER BY transaction_date ASC, id ASC
        ) AS rn
      FROM candidate
    )
    SELECT id, transaction_date, amount, description, matched_column, matched_reference
    FROM ranked
    WHERE rn <= ${MAX_CANDIDATES}
    ORDER BY transaction_date ASC, id ASC
  `;
}

async function queryCandidates(
  companyId: string,
  refs: string[],
  bankAccountId: string | null,
): Promise<RefRows> {
  return (await bankTxRefCandidateQuery(companyId, refs, bankAccountId)) as RefRows;
}

function mapRow(row: DbRow): BankTransactionRefMatch {
  return {
    id: String(row.id),
    // fmtDate, not toISOString(): pg returns the DATE at local midnight and
    // UTC rendering rolls it back a day on the UTC+2 box.
    transactionDate: fmtDate(row.transaction_date),
    amount: Number(row.amount),
    description: row.description === null || row.description === undefined
      ? null
      : String(row.description),
    matchedReference: String(row.matched_reference),
    matchedColumn: String(row.matched_column) === 'reference' ? 'reference' : 'bank_reference',
  };
}

/**
 * Candidates for EVERY supplied reference, in ONE query.
 *
 * Keyed by the trimmed reference; a reference with no match is absent from the
 * map (callers render the shared NOT_FOUND, never a per-reference oracle).
 * Blank references are dropped before the query — a blank would otherwise match
 * every row whose reference is blank, and resolve arbitrarily.
 */
export async function findBankTransactionsByReferences(
  companyId: string,
  references: readonly string[],
  bankAccountId?: string,
): Promise<Map<string, BankTransactionRefMatch[]>> {
  const refs = [...new Set(references.map((r) => r.trim()).filter((r) => r !== ''))];
  const byRef = new Map<string, BankTransactionRefMatch[]>();
  if (refs.length === 0) return byRef;

  const rows = await queryCandidates(companyId, refs, bankAccountId ?? null);

  // Preference applied here rather than in SQL: the query fetches both columns'
  // hits in one pass (one round trip for the whole batch) and the ranking is a
  // per-reference decision that reads plainly in JS.
  const grouped = new Map<string, { reference: BankTransactionRefMatch[]; bank: BankTransactionRefMatch[] }>();
  for (const row of rows) {
    const match = mapRow(row);
    let entry = grouped.get(match.matchedReference);
    if (!entry) {
      entry = { reference: [], bank: [] };
      grouped.set(match.matchedReference, entry);
    }
    (match.matchedColumn === 'reference' ? entry.reference : entry.bank).push(match);
  }
  for (const [ref, entry] of grouped) {
    const chosen = entry.reference.length > 0 ? entry.reference : entry.bank;
    if (chosen.length > 0) byRef.set(ref, chosen);
  }
  return byRef;
}

/** One reference — the single-transaction tools' entry point. */
export async function findBankTransactionsByReference(
  companyId: string,
  bankReference: string,
  bankAccountId?: string,
): Promise<BankTransactionRefMatch[]> {
  const ref = bankReference.trim();
  if (!ref) return [];
  const byRef = await findBankTransactionsByReferences(companyId, [ref], bankAccountId);
  return byRef.get(ref) ?? [];
}

/**
 * The transaction's current status, or `null` when it does not exist in this
 * company (another tenant's row reads identically to a missing one).
 *
 * Exists so the MCP allocate/reverse tools can refuse an unallocatable row
 * BEFORE calling the service. The services raise the same refusals themselves,
 * but by then the tool cannot tell a pre-write refusal from a failure that
 * struck after a journal was already posted — and the two need opposite
 * handling: a refusal is reported, a mid-write failure must be rethrown so the
 * registry's savepoint unwinds it.
 */
export interface BankTransactionAllocationState {
  id: string;
  status: string;
  /** The journal line the row is allocated against — null when unallocated. */
  matchedJournalLineId: string | null;
}

/**
 * Allocation state for a WHOLE set of transactions, in ONE company-scoped
 * query. Rows absent from the map do not exist in this company (another
 * tenant's row is indistinguishable from a missing one, deliberately).
 *
 * `bulk_allocate_bank_transactions` calls this once for up to 500 resolved ids
 * before it posts anything — the alternative was one `getBankTransactionStatus`
 * per line inside a request that already holds every row's lock.
 *
 * Both columns, not just `status`. A row can carry `status='allocated'` with no
 * journal (a half-finished older write) and, more importantly, the journal is
 * what `reverse_bank_allocation_batch` navigates by — a partition that reads
 * only `status` passes a fixture and fails production, which is exactly how the
 * #261 batch got through.
 */
export async function findBankTransactionAllocationStates(
  companyId: string,
  bankTxIds: readonly string[],
): Promise<Map<string, BankTransactionAllocationState>> {
  const ids = [...new Set(bankTxIds)];
  const byId = new Map<string, BankTransactionAllocationState>();
  if (ids.length === 0) return byId;

  const rows = (await sql`
    SELECT id, status, matched_journal_line_id
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];

  for (const row of rows) {
    const id = String(row.id);
    byId.set(id, {
      id,
      status: row.status === null || row.status === undefined ? '' : String(row.status),
      matchedJournalLineId:
        row.matched_journal_line_id === null || row.matched_journal_line_id === undefined
          ? null
          : String(row.matched_journal_line_id),
    });
  }
  return byId;
}

export async function getBankTransactionStatus(
  companyId: string,
  bankTxId: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT status FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const status = rows[0]?.status;
  return status === null || status === undefined ? null : String(status);
}
