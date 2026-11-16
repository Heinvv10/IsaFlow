/**
 * allocateTransaction's posting plan, decided from READS ONLY before the first write: the contra
 * account row (with the bank account's card defaults), the AP/AR-control refusal, the settlement
 * VAT drop, the dimensions and the VAT-inclusive split. Moved verbatim out of
 * bankAllocationService.ts (its line cap); allocateTransaction calls it at the same point.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isControlAccountSettlement } from '../gl/settlementVat';
import { assertNotContactControl, contactControlRefusal } from './contactControlGuard';
import { vatInclusiveSplit } from './bankVatInclusive';
import { isControlSubtype, planAllocationDimensions } from './bankAllocationDimensions';
import type { AllocationType } from './bankAllocationTypes';

type Row = DbRow;

export interface AllocationPlanInput {
  companyId: string; bankTxId: string; allocType: AllocationType; contraAccountId: string | null;
  entityId?: string; vatCode?: string; cc1Id?: string; cc2Id?: string; buId?: string;
  bankAccountId: string; totalAmount: number; isSpent: boolean;
}

export type AllocationPlan = Awaited<ReturnType<typeof planAllocationPosting>>;

export async function planAllocationPosting(input: AllocationPlanInput) {
  const {
    companyId, bankTxId, allocType, contraAccountId, entityId, vatCode, cc1Id, cc2Id, buId,
    bankAccountId, totalAmount, isSpent,
  } = input;
  // This is the ATTENDED path: the screen (and the MCP tools behind it) warned
  // whoever chose this vat code — that an entertainment account normally denies
  // input tax (s17(2)(a)(i) means only they know whether the proviso applies to
  // their business), and that no supply can arise at all on a salary, tax,
  // distribution, depreciation, donation or exempt-financial account. So the
  // caller's choice stands here — nothing is coerced.
  //
  // THE UNATTENDED CALLERS GUARD BEFORE THEY CALL THIS, and there are THREE
  // of them — each found separately, which is the point of counting them here:
  //   1. `autoPostRuleLine` — the bank-rule sweep, takes the rule's vat_code.
  //   2. `autoPostGateService.sweep` — the confidence gate, LLM and
  //      categorisation tiers, posts `suggested_vat_code`.
  //   3. `provisionalPostingService.postProvisional` — the gate's import
  //      branch, which PREDICTS its own code from the most frequent one on
  //      that supplier's history, so a ledger already carrying a bad claim
  //      teaches it to repeat.
  // All three route through `gl/ruleVatResolution`. A fourth guards itself the
  // same way — do NOT move the coercion in here, or the attended path starts
  // silently overriding a user who was shown a warning and chose anyway.
  //
  // The account row is still read up front because the branch below needs it.
  // The same read also brings the contra's subtype and the bank account's (card's) default dimensions.
  const contraRows = (allocType === 'account' && contraAccountId)
    ? (await sql`
        SELECT a.account_code, a.account_name, a.account_subtype,
               b.default_cc1_id::TEXT AS bank_cc1_id, b.default_cc2_id::TEXT AS bank_cc2_id,
               b.default_bu_id::TEXT AS bank_bu_id
        FROM gl_accounts a
        LEFT JOIN gl_accounts b ON b.id = ${bankAccountId}::UUID AND b.company_id = ${companyId}::UUID
        WHERE a.id = ${contraAccountId}::UUID AND a.company_id = ${companyId}::UUID
      `) as Row[]
    : [];
  // A line onto AP/AR control as an ACCOUNT moves the control with no document (contactControlGuard): refused,
  // before the first write. That is the account arm, and a supplier/customer call naming no contact, which falls
  // through to it.
  if (allocType === 'account') {
    const refusal = contactControlRefusal(contraRows[0]?.account_subtype, 'This allocation');
    if (refusal) throw refusal;
  } else if (allocType !== 'transfer' && !entityId) {
    await assertNotContactControl(companyId, contraAccountId, 'This allocation');
  }
  const effectiveVatCode = vatCode;

  // K-016: the supplier and customer arms SETTLE a document that already
  // carried its VAT, so no split may happen on them however the caller asked —
  // see `isControlAccountSettlement`. This is not the coercion the block above
  // forbids: nothing here overrides which ACCOUNT the user chose, and the
  // `account` arm (including a supplier/customer call with no entity, which
  // falls through to it) keeps the caller's code untouched.
  const isSettlement = isControlAccountSettlement(allocType) && Boolean(entityId);
  // Say so when a code actually goes away. The screen already renders N/A for
  // these types, so this is for the MCP tools and anyone reading the log after
  // the fact — a value the caller sent and the ledger did not use.
  if (isSettlement && effectiveVatCode && effectiveVatCode !== 'none') {
    log.info(
      'VAT code dropped: allocation settles a control account, not a supply',
      { companyId, bankTxId, allocType, requestedVatCode: effectiveVatCode },
      'accounting',
    );
  }

  // Brief §5.3: settlements and control-account lines carry no dimensions; card defaults fill the rest.
  // Decided here, from reads only, before the first write (bankAllocationDimensions.ts).
  const contraRow = contraRows[0];
  const allocationDims = planAllocationDimensions({
    settlement: isSettlement || allocType === 'transfer',
    contraIsControl: contraRow ? isControlSubtype(contraRow.account_subtype == null ? null : String(contraRow.account_subtype)) : false,
    explicit: { cc1Id, cc2Id, buId },
    bankDefaults: {
      cc1Id: contraRow?.bank_cc1_id ? String(contraRow.bank_cc1_id) : undefined,
      cc2Id: contraRow?.bank_cc2_id ? String(contraRow.bank_cc2_id) : undefined,
      buId: contraRow?.bank_bu_id ? String(contraRow.bank_bu_id) : undefined,
    },
  });

  const hasVat = effectiveVatCode === 'standard' && !isSettlement;
  const { vatRate, netAmount, vatAmount } = vatInclusiveSplit(totalAmount, hasVat);
  // Only the `account` branch can reach a VAT line now (K-016), and it has no
  // entity, so the direction IS the only signal: money out is a purchase (input
  // tax), money in is a supply (output tax).
  //
  // The supplier/customer arms used to pick the side from the alloc type rather
  // than the sign, because a supplier REFUND reverses INPUT tax however the
  // cash moved. That distinction has no line to land on any more — a settlement
  // posts no VAT at all — so the two arms no longer reach this.
  const vatAccountKey: 'vat_input' | 'vat_output' = isSpent ? 'vat_input' : 'vat_output';
  // A settlement leg must not carry a vat_type either: VAT201 reads that column,
  // so tagging the AP/AR leg 'standard' would declare the supply a second time
  // even with the VAT line gone.
  const mapVatType = isSettlement ? undefined
    : effectiveVatCode === 'standard' ? 'standard' as const
    : effectiveVatCode === 'zero_rated' ? 'zero_rated' as const
    : effectiveVatCode === 'exempt' ? 'exempt' as const : undefined;

  return { contraRows, allocationDims, hasVat, vatRate, netAmount, vatAmount, vatAccountKey, mapVatType };
}
