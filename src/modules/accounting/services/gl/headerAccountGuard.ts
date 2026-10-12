/**
 * No NEW journal line lands on a balance-sheet header (Hein, D1 2026-10-12).
 *
 * The rule is the balance sheet's own (isReportVisibleLeaf.ts): an asset,
 * liability or equity account below level 3 that has sub-accounts is a header,
 * and `balanceSheetService` / `trendRowsService` select nothing posted on it.
 * A line there vanishes from both while the trial balance still foots. Revenue
 * and expense headers are NOT refused: the income statement has no level filter
 * and carries them. This is deliberately the looser rule — `validateLeafAccount`
 * (any parent, any type) stays on the expense-claim route only.
 *
 * WHO CALLS IT. Every writer of `gl_journal_lines` under src/ and pages/:
 * `createJournalEntryInTransaction` (and through it recurring journals, MCP,
 * imports, bank and document postings), `assetDepreciationPosting`, and
 * `yearEndJournalPoster`. `tests/unit/guards/journalLineWriterCensus.test.ts`
 * goes red when a new writer appears without it. It runs before the writer's
 * first INSERT; whether that is before the REQUEST's first write depends on the
 * route, which is why the paths that answer it 4xx check it up front (both
 * recurring runs, the GL import per row) or are already pre-write (the journal
 * and bank allocation routes, the year-end close), and every other route lets
 * it propagate as a 500, which rolls back. The bank-rule sweep counts it as a
 * skip (`autoPostSkippedHeaderAccount`) and posts the rest.
 *
 * CONTRAS STAY POSSIBLE. A reversal, a reclassification's source leg and a
 * provisional's settled lines mirror lines already posted; refusing them would
 * leave a historic header line with no way out (the reversalLines.ts
 * principle). Those callers name the accounts their contra legs sit on in
 * `contraAccountIds`, and only those accounts are exempt — every other leg of
 * the same journal is still checked.
 *
 * THE RACE with a chart edit. `assertParentUsable` (a new child),
 * `admitReclassification` (a moved account), an account merge, the bank grouping
 * PUT and `assertNoPostedParentHidden` (a move that re-levels a level-3 parent
 * to 2) take FOR UPDATE on the account and then refuse when it has lines. This
 * takes FOR KEY SHARE on every account it judges BEFORE reading children and
 * level, in ascending id order like
 * `lockGlAccountsForUpdate`, so it serialises with those three: whichever
 * commits second sees the other. FOR KEY SHARE is the lock the line INSERT's
 * foreign key takes on the same row anyway, held to commit; this only takes it
 * earlier, and only on the accounts the rule can bite or a move can make it
 * bite (a level 1-2 asset/liability/equity, or any such parent). It does NOT serialise with a chart writer that adds
 * a child without locking the parent FOR UPDATE (the chart-of-accounts import,
 * the Sage migration's chart step): those insert children under the FK's own
 * KEY SHARE, which this lock does not block.
 */
import { sql } from '@/lib/neon';
import type { SqlExec } from './journalVatLockGuard';
import { BALANCE_SHEET_LEAF_LEVEL, LEAF_RULE_ACCOUNT_TYPES } from './isReportVisibleLeaf';

/** A journal line refused because its account is a balance-sheet header. Raised before the writer's first INSERT. */
export class HeaderAccountRefusal extends Error {
  readonly code = 'HEADER_ACCOUNT_REFUSED';
  constructor(message: string, readonly lineIndex: number) {
    super(message);
    this.name = 'HeaderAccountRefusal';
  }
}

export function isHeaderAccountRefusal(err: unknown): err is HeaderAccountRefusal {
  return err instanceof Error && (err as { code?: unknown }).code === 'HEADER_ACCOUNT_REFUSED';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HeaderRow { id: string; account_code: string; account_name: string }

/**
 * @param contraAccountIds accounts whose lines in this journal are contras of lines already posted (see header).
 * @throws HeaderAccountRefusal naming the first refused line.
 */
export async function assertNoHeaderAccountLines(
  companyId: string,
  lines: readonly { glAccountId: string }[],
  opts?: { contraAccountIds?: readonly string[]; q?: SqlExec },
): Promise<void> {
  // Compared lower-case: Postgres returns a uuid lower-case whatever case the caller wrote it in.
  const key = (id: string | undefined): string => (id ?? '').toLowerCase();
  const exempt = new Set((opts?.contraAccountIds ?? []).map(key));
  // A malformed id is left to the writer's own checks; cast here it would abort the transaction (22P02).
  const ids = [...new Set(lines.map((l) => key(l.glAccountId)).filter((id) => UUID.test(id) && !exempt.has(id)))].sort();
  if (ids.length === 0) return;
  const q = opts?.q ?? sql;
  // Lock first (see THE RACE), then ask about children in a fresh statement, which under READ COMMITTED sees a
  // child committed while this waited.
  // Every parent is locked, not only the level 1-2 ones: a move that re-levels a level-3 parent to 2 locks it FOR
  // UPDATE first (accountParentRules.assertNoPostedParentHidden), so this waits and the fresh read below sees level 2.
  const subject = (await q`
    SELECT ga.id FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${ids}::UUID[])
       AND ga.account_type = ANY(${[...LEAF_RULE_ACCOUNT_TYPES]}::TEXT[])
       AND (ga.level IS NULL OR ga.level < ${BALANCE_SHEET_LEAF_LEVEL}
            OR EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ${companyId}::UUID))
     ORDER BY ga.id
       FOR KEY SHARE OF ga
  `) as { id: string }[];
  if (subject.length === 0) return;
  const headers = (await q`
    SELECT ga.id, ga.account_code, ga.account_name FROM gl_accounts ga
     WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${subject.map((r) => r.id)}::UUID[])
       -- NULL level: the balance sheet tests level >= 3, which is NULL too, so it hides such a header; judge it as one.
       AND (ga.level IS NULL OR ga.level < ${BALANCE_SHEET_LEAF_LEVEL})
       AND EXISTS (SELECT 1 FROM gl_accounts ch
                    WHERE ch.parent_account_id = ga.id AND ch.company_id = ${companyId}::UUID)
  `) as HeaderRow[];
  if (headers.length === 0) return;
  const byId = new Map(headers.map((h) => [key(String(h.id)), h]));
  const at = lines.findIndex((l) => byId.has(key(l.glAccountId)));
  const h = byId.get(key(lines[at]!.glAccountId))!;
  throw new HeaderAccountRefusal(
    `Line ${at + 1}: ${h.account_code} ${h.account_name} is a header with sub-accounts; post to one of them. `
      + 'The balance sheet leaves out anything posted to a header.',
    at,
  );
}
