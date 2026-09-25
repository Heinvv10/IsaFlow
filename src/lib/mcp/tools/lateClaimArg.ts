/**
 * The explicit opt-in an MCP caller passes for a late input-VAT claim
 * (VAT Act s16(3), gl/vatLateClaimPlan). Absent or false, a posting dated in a
 * locked VAT period is refused exactly as before: an agent claims late only
 * when it says so.
 */
import type { LateClaimInfo } from '@/modules/accounting/services/gl/vatLateClaimPlan';

export const ALLOW_LATE_INPUT_CLAIM_PROP = {
  type: 'boolean',
  description:
    'Only when the posting is dated inside a LOCKED (filed) VAT period and its only VAT is INPUT VAT: true claims '
    + 'that VAT late, in the next open VAT period (VAT Act s16(3)) — the journal keeps its date, a companion journal '
    + 'on the first day after the lock claims the VAT, and the result carries late_claim. Output VAT, a reduction of '
    + 'input VAT, a claim over five years late or into a closed period is still refused. Omit it to be refused '
    + 'inside a locked period as usual.',
} as const;

export function allowLateInputClaim(args: Record<string, unknown>): boolean {
  return args.allow_late_input_claim === true;
}

export function lateClaimResult(lc: LateClaimInfo | undefined) {
  if (!lc) return null;
  return {
    claim_date: lc.claimDate,
    locked_period_start: lc.lockPeriod.start,
    locked_period_end: lc.lockPeriod.end,
    companion_entry_id: lc.companionEntryId,
    companion_entry_number: lc.companionEntryNumber,
    input_tax: lc.inputTax,
    message: lc.message,
  };
}
