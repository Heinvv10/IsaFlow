/**
 * The refusals `postJournalEntry` raises before it posts: a closed fiscal
 * period and a deactivated GL account.
 *
 * Split out of `journalEntryPostingService.ts` (K-072 round 18), which had
 * grown past the 300-line cap. That module re-exports all three, and every
 * caller keeps importing them from there — which also keeps the many tests
 * that `vi.mock` that module in charge of what they stub.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

/**
 * Thrown when a journal entry cannot be posted because its target fiscal
 * period is not open. Lets callers (e.g. bank-rules auto-post) match on
 * `instanceof` instead of regexing the message, so future wording tweaks
 * don't silently change the swallow/re-throw boundary.
 */
export class ClosedFiscalPeriodError extends Error {
  readonly periodStatus: string;
  constructor(periodStatus: string) {
    super(`Cannot post to ${periodStatus} fiscal period`);
    this.name = 'ClosedFiscalPeriodError';
    this.periodStatus = periodStatus;
  }
}

/**
 * Thrown when an entry targets a GL account that has been deactivated.
 * Carries the offending account codes so a caller can act on them, and is
 * `instanceof`-matchable for the same reason ClosedFiscalPeriodError is:
 * automated posters decide swallow-vs-re-throw on the class, not the wording.
 */
export class InactiveAccountError extends Error {
  readonly accounts: string[];
  constructor(accounts: { code: string; name: string }[]) {
    const listed = accounts.map((a) => `${a.code} ${a.name}`).join(', ');
    super(
      `Cannot post to deactivated GL account${accounts.length === 1 ? '' : 's'}: ${listed}. ` +
        `Reactivate the account, or recode the line to an active one.`,
    );
    this.name = 'InactiveAccountError';
    this.accounts = accounts.map((a) => a.code);
  }
}

/**
 * Refuse if any line of `entryId` targets a deactivated GL account.
 *
 * Exported because two paths post with a direct UPDATE instead of calling
 * postJournalEntry, and both must still enforce this. postJournalEntry is the
 * canonical posting path; anything calling this directly is diverging from it
 * and should say why.
 */
export async function assertNoInactiveAccountLines(companyId: string, entryId: string): Promise<void> {
  const inactiveRows = (await sql`
    SELECT DISTINCT ga.account_code, ga.account_name
    FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${entryId}
      AND jl.company_id = ${companyId}::UUID
      AND ga.is_active = false
    ORDER BY ga.account_code
  `) as Row[];
  if (inactiveRows.length > 0) {
    throw new InactiveAccountError(
      inactiveRows.map((r) => ({ code: String(r.account_code), name: String(r.account_name) })),
    );
  }
}
