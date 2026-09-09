/**
 * The s17(2)(a) advisory for an expense claim, on the paths a person uses.
 *
 * The capture route resolves the denial once, when the claim is created, and
 * reports it. After that the claim is an ordinary editable record: an approver
 * can put the R150 back on a line coded to a flagged Entertainment account
 * through `PATCH .../lines/[lineId]` and then approve it, and neither route
 * said anything — so the denial was advisory in name and invisible in practice.
 *
 * ADVISORY, deliberately. s17(2)(a)(i) lets a vendor who continuously supplies
 * entertainment for a charge claim that input tax, and only the user knows
 * whether that is them — so these paths warn and the user's choice stands.
 * Coercion belongs to the unattended paths only (`applyVatDenial`).
 *
 * The predicate is the AMOUNT as well as the code, because `postClaim` debits
 * VAT Input with the sum of the line `vatAmount`s regardless of `vat_code`:
 * a line left at `'none'` with R150 on it still produces the claim.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { INPUT_VAT_DENIED_ADVICE, shouldWarnOnVatCode, VAT_CODE_NONE } from '@/modules/accounting/services/gl/inputVatDenial';
import type { VatType } from '@/modules/accounting/types/gl.types';

/**
 * How a claim line's expense leg is classified in the ledger.
 *
 * `postClaim` pushed its expense legs with no `vatType` at all, so a claim the
 * capture route had DENIED under s17(2)(a) — gross on the line, `vat_amount`
 * zeroed, `vat_code = 'none'` — reached `gl_journal_lines` with
 * `vat_type = NULL`: indistinguishable from a line nobody classified, with the
 * only trace of the decision a description string an exception report cannot
 * read. The petty-cash branch already records `'no_vat'`; this is the same fact
 * arriving through the claim table.
 *
 * Only the denial is mapped, deliberately. `'none'` is the claim's `vat_code`
 * vocabulary and `'no_vat'` is what `gl_journal_lines.vat_type` spells for the
 * same fact; the CLAIMABLE codes are left undefined, because tagging a claim's
 * expense leg `'standard'` would declare the supply on a leg no VAT201 box
 * reads today — a different change, and not one this defect asks for.
 */
export function deniedVatTypeForLine(
  vatCode: string | null | undefined,
  vatAmount: number,
): VatType | undefined {
  return (vatCode ?? VAT_CODE_NONE) === VAT_CODE_NONE && vatAmount === 0 ? 'no_vat' : undefined;
}

/**
 * Does any line on this claim claim input tax on an account flagged
 * `vat_input_denied`? Returns the advice to hand back to the caller, or none.
 */
export async function claimInputVatWarnings(
  claimId: string,
  companyId: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT ecl.vat_code, ecl.vat_amount, ga.vat_input_denied
    FROM expense_claim_lines ecl
    JOIN gl_accounts ga
      ON ga.id = ecl.gl_account_id AND ga.company_id = ecl.company_id
    WHERE ecl.claim_id = ${claimId}::uuid
      AND ecl.company_id = ${companyId}::uuid
  `) as DbRow[];

  const claiming = rows.some((r) => {
    const denied = Boolean(r.vat_input_denied);
    if (!denied) return false;
    return shouldWarnOnVatCode(denied, r.vat_code as string | null)
      || Number(r.vat_amount ?? 0) !== 0;
  });

  return claiming ? [INPUT_VAT_DENIED_ADVICE] : [];
}
