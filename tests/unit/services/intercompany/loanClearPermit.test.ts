/**
 * Intercompany P4-E (j).3: the permit "Clear against the intercompany loan" hands the shared payment layer. Only an object the service MINTED
 * passes (a look-alike literal, or one parsed from a request body, does not); it covers exactly one company, one bill and one credited account,
 * and only together with the clearing's author label.
 */
import { describe, expect, it } from 'vitest';
import { IC_LOAN_CLEAR_AGENT, mintLoanClearPermit, permitCovers } from '@/modules/accounting/services/intercompany/loanClearPermit';

const CO = 'c0000000-0000-4000-8000-000000000001';
const BILL = 'b0000000-0000-4000-8000-000000000001';
const LOAN = 'a0000000-0000-4000-8000-000000000001';
const use = (over: Record<string, unknown> = {}) => ({ companyId: CO, billIds: [BILL], creditedAccountIds: [LOAN], postingAgent: IC_LOAN_CLEAR_AGENT, ...over });

describe('permitCovers', () => {
  const permit = mintLoanClearPermit({ companyId: CO, billId: BILL, loanAccountId: LOAN });
  it('the minted permit covers its own company, bill, loan account and author label', () => {
    expect(IC_LOAN_CLEAR_AGENT).toBe('system:ic_loan_clear');
    expect(permitCovers(permit, use())).toBe(true);
    expect(permitCovers(permit, use({ companyId: CO.toUpperCase(), billIds: [BILL.toUpperCase()] }))).toBe(true);
  });
  it('is frozen', () => {
    expect(Object.isFrozen(permit)).toBe(true);
  });
  it.each([
    ['no permit', undefined, use()],
    ['a look-alike literal', { companyId: CO, billId: BILL, loanAccountId: LOAN }, use()],
    ['a permit parsed back from JSON', JSON.parse(JSON.stringify(permit)), use()],
    ['another company', permit, use({ companyId: LOAN })],
    ['another bill', permit, use({ billIds: [LOAN] })],
    ['a second bill', permit, use({ billIds: [BILL, LOAN] })],
    ['no bill', permit, use({ billIds: [] })],
    ['another credited account', permit, use({ creditedAccountIds: [BILL] })],
    ['another author label', permit, use({ postingAgent: 'mcp:settle_by_contra:v1' })],
    ['no author label', permit, use({ postingAgent: undefined })],
  ])('refuses %s', (_name, p, u) => {
    expect(permitCovers(p, u as never)).toBe(false);
  });
});
