/**
 * Intercompany P4-E (j).3, the shared payment guard's flag read (fix round 1 D): with the flag cleanly OFF the guard is inert (no row read);
 * when the flag CANNOT be read it fails CLOSED for a linked bill paid from the side's loan account (a plain sentence, the payment refused),
 * and stays out of the way for anything else; the clearing's own permit passes (E read the flag on first). `loanClearingEnabled` keeps its
 * own answer for the senders (false on a failed read).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hasFeature: vi.fn(async (_c: string, _f: string) => true as unknown),
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: m.hasFeature }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import {
  LOAN_ACCOUNT_PAYMENT_REFUSED, LOAN_FLAG_UNREADABLE, loanAccountPaymentRefusal, refuseLoanAccountPayment,
} from '@/modules/accounting/services/intercompany/loanAccountPaymentGuard';
import { loanClearingEnabled, loanClearingState } from '@/modules/accounting/services/intercompany/loanClearingGate';
import { IC_LOAN_CLEAR_AGENT, mintLoanClearPermit } from '@/modules/accounting/services/intercompany/loanClearPermit';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

const CO = 'c0000000-0000-4000-8000-000000000001';
const BILL = 'b0000000-0000-4000-8000-000000000001';
const LOAN = 'a0000000-0000-4000-8000-000000000001';
const use = { billIds: [BILL], creditedAccountIds: [LOAN] };
const unreadable = () => m.hasFeature.mockRejectedValue(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
const linked = () => m.sql.mockResolvedValue([{ hit: 1 }]);

beforeEach(() => {
  vi.clearAllMocks();
  m.hasFeature.mockResolvedValue(true);
  m.sql.mockResolvedValue([]);
});

describe('the flag read', () => {
  it("loanClearingState tells on, off and unknown apart; loanClearingEnabled is true only for 'on'", async () => {
    expect(await loanClearingState(CO)).toBe('on');
    m.hasFeature.mockResolvedValue(false);
    expect(await loanClearingState(CO)).toBe('off');
    expect(await loanClearingEnabled(CO)).toBe(false);
    unreadable();
    expect(await loanClearingState(CO)).toBe('unknown');
    expect(await loanClearingEnabled(CO)).toBe(false);
  });
});

describe('loanAccountPaymentRefusal', () => {
  it('flag cleanly off: inert, no row read', async () => {
    m.hasFeature.mockResolvedValue(false);
    linked();
    expect(await loanAccountPaymentRefusal(CO, use)).toBeNull();
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('flag unreadable, a linked bill paid from the loan account: refused (fail closed), and thrown as the AP refusal', async () => {
    unreadable();
    linked();
    expect(await loanAccountPaymentRefusal(CO, use)).toBe(LOAN_FLAG_UNREADABLE);
    await expect(refuseLoanAccountPayment(CO, use)).rejects.toThrow(SupplierPaymentRefusal);
    expect(LOAN_FLAG_UNREADABLE).toMatch(/Nothing was posted\.$/);
  });

  it('flag unreadable, nothing linked on a side naming that account: not refused', async () => {
    unreadable();
    expect(await loanAccountPaymentRefusal(CO, use)).toBeNull();
  });

  it("flag unreadable, the clearing's own permit: passes (E read the flag on before minting it)", async () => {
    unreadable();
    linked();
    const permit = mintLoanClearPermit({ companyId: CO, billId: BILL, loanAccountId: LOAN });
    expect(await loanAccountPaymentRefusal(CO, { ...use, permit, postingAgent: IC_LOAN_CLEAR_AGENT })).toBeNull();
  });

  it('flag on, linked: the usual refusal', async () => {
    linked();
    expect(await loanAccountPaymentRefusal(CO, use)).toBe(LOAN_ACCOUNT_PAYMENT_REFUSED);
  });

  it('only an active link on an active LOAN connection counts (F): the query says so', async () => {
    linked();
    await loanAccountPaymentRefusal(CO, use);
    const text = (m.sql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/c\.status = 'active' AND c\.settlement_mode = 'loan'/);
    expect(text).toMatch(/k\.status = 'active'/);
  });
});
