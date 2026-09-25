/**
 * The "Input VAT - late claims" clearing account (migration 701) is written by
 * the late-claim split and nothing else. A hand-made DR VAT Input / CR clearing
 * journal would claim input VAT with no supply behind it; a clearing leg on any
 * other journal would pass through the VAT201 as neither base nor claim.
 *
 * So a new journal may carry a line on it only when it IS a companion (source
 * `auto_vat_late_claim`) or a REVERSAL (which mirrors posted lines, and must be
 * able to undo an original or a companion). The split itself moves lines onto
 * the account by UPDATE, not through here.
 *
 * Its own module so unit tests with positional `sql` mocks can stub it.
 */
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

export class LateClaimClearingAccountError extends Error {
  constructor(accountCode: string) {
    super(`Account ${accountCode} is the "Input VAT - late claims" clearing account. Only a late input-VAT claim `
      + 'posts to it, and it clears itself; post to the expense or VAT Input account instead.');
    this.name = 'LateClaimClearingAccountError';
  }
}

export async function assertNoLateClaimClearingLines(
  companyId: string,
  lines: readonly { glAccountId: string }[],
  source: string | undefined,
  isReversal: boolean,
): Promise<void> {
  if (isReversal || source === 'auto_vat_late_claim') return;
  const ids = [...new Set(lines.map((l) => l.glAccountId))];
  if (ids.length === 0) return;
  const [hit] = (await sql`
    SELECT account_code FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
      AND account_subtype = 'vat_input_late_claim'
    LIMIT 1`) as Row[];
  if (hit) throw new LateClaimClearingAccountError(String(hit.account_code));
}
