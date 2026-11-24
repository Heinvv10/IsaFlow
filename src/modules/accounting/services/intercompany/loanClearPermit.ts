/**
 * The permit of "Clear against the intercompany loan" (intercompany P4-E, plan (j).3). With the dark flag on, the shared payment layer
 * (`loanAccountPaymentGuard.ts`) refuses to credit the payer side's LOAN account for a bill slotted in an ACTIVE link unless the posting carries
 * a permit `payerLoanClearService` minted for exactly that company, bill and loan account, AND the clearing's author label. A permit is known by
 * IDENTITY (a WeakSet of the objects this module minted): a look-alike object, one parsed from a request body or an MCP argument, never passes.
 * No database import.
 */

/** The author label of the clearing's journal (never a person, never an approver). */
export const IC_LOAN_CLEAR_AGENT = 'system:ic_loan_clear';

export interface LoanClearPermit {
  readonly companyId: string;
  readonly billId: string;
  readonly loanAccountId: string;
}

const minted = new WeakSet<object>();

/** Only `payerLoanClearService` calls this, for the one bill and loan account it checked under its locks. */
export function mintLoanClearPermit(p: { companyId: string; billId: string; loanAccountId: string }): LoanClearPermit {
  const permit = Object.freeze({ companyId: p.companyId.toLowerCase(), billId: p.billId.toLowerCase(), loanAccountId: p.loanAccountId.toLowerCase() });
  minted.add(permit);
  return permit;
}

export interface PermitUse {
  companyId: string;
  /** The bills the posting settles: exactly the permit's one. */
  billIds: readonly string[];
  /** The accounts the posting credits: exactly the permit's loan account. */
  creditedAccountIds: readonly string[];
  postingAgent: string | undefined;
}

/** True only for a permit this module minted that covers exactly this posting, stamped with the clearing's author label. */
export function permitCovers(permit: unknown, use: PermitUse): boolean {
  if (typeof permit !== 'object' || permit === null || !minted.has(permit)) return false;
  const p = permit as LoanClearPermit;
  return use.postingAgent === IC_LOAN_CLEAR_AGENT
    && use.companyId.toLowerCase() === p.companyId
    && use.billIds.length === 1 && use.billIds[0]!.toLowerCase() === p.billId
    && use.creditedAccountIds.length === 1 && use.creditedAccountIds[0]!.toLowerCase() === p.loanAccountId;
}
