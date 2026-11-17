/**
 * VR: submitVATReturn against its basis (settlementBasis mocked), wiring only. It refuses before any write when the
 * version is already settled or the ledger has drifted from the version, and after an amend it posts and records only
 * the difference from what the period already settled, linked to the new version. On real PG:
 * tests/integration/vat-returns-settlement-topup.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/vatReturnService', () => ({ getVATReturn: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(), postJournalEntry: vi.fn(), resolveUserUuid: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ getSystemAccount: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
}));
vi.mock('@/modules/accounting/services/returns/vatSettlementVersion', () => ({ settlementBasis: vi.fn() }));

import { sql } from '@/lib/neon';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { createJournalEntry, resolveUserUuid } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { settlementBasis } from '@/modules/accounting/services/returns/vatSettlementVersion';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';

const CO = '00000000-0000-0000-0000-000000000001';
const USER = '22222222-2222-2222-2222-222222222222';
const V2 = '33333333-3333-3333-3333-333333333333';
const P = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
type Line = { glAccountId: string; debit: number; credit: number };

function arrange(ledger: [number, number], versionNet: number, prior: [number, number, number], versionSettled = false) {
  vi.mocked(settlementBasis).mockResolvedValue({
    version: { id: V2, versionNo: 2, status: 'finalised', outputTax: ledger[0], inputTax: ledger[1], netVat: versionNet },
    prior: { outputTax: prior[0], inputTax: prior[1], netVat: prior[0] - prior[1], count: prior[2] },
    versionSettled,
  });
  vi.mocked(getVATReturn).mockResolvedValue({ totalOutputTax: ledger[0], totalInputTax: ledger[1] } as never);
  vi.mocked(getSystemAccount).mockImplementation(async (role: string) => ({ id: `acc-${role}` }) as never);
  vi.mocked(resolveUserUuid).mockResolvedValue(USER as never);
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never);
  vi.mocked(sql).mockResolvedValueOnce([{ id: 'acc-2130' }] as never)
    .mockImplementationOnce((async (_t: TemplateStringsArray, ...v: unknown[]) => [{
      id: 'vr-2', company_id: CO, period_start: P.periodStart, period_end: P.periodEnd, status: 'submitted',
      total_output_tax: v[3], total_input_tax: v[4], net_vat: v[5], return_version_id: v.at(-1),
    }]) as never);
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { status?: number; refusalCode?: string });

describe('submitVATReturn: settled-once, drift and the top-up (VR)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a version that already has its settlement: 409 VAT_ALREADY_SETTLED before the ledger is read', async () => {
    arrange([3000, 0], 3000, [3000, 0, 1], true);
    expect(await refusal(submitVATReturn(CO, P, USER))).toMatchObject({ status: 409, refusalCode: 'VAT_ALREADY_SETTLED' });
    expect(getVATReturn).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('the ledger net differs from the version net by more than 1c: 409 VAT_SETTLEMENT_DRIFT, nothing written', async () => {
    arrange([3150, 0], 3000, [0, 0, 0]);
    expect(await refusal(submitVATReturn(CO, P, USER))).toMatchObject({ status: 409, refusalCode: 'VAT_SETTLEMENT_DRIFT' });
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('1c of rounding is not drift', async () => {
    arrange([3000.01, 0], 3000, [0, 0, 0]);
    expect((await submitVATReturn(CO, P, USER)).netVat).toBe(3000.01);
  });

  it('after an amend: posts and records only the difference, linked to the new version', async () => {
    arrange([3000, 400], 2600, [1500, 400, 1]);
    const rec = await submitVATReturn(CO, P, USER);
    const lines = (vi.mocked(createJournalEntry).mock.calls[0]![1] as { lines: Line[]; description: string });
    expect(lines.lines.map((l) => [l.glAccountId, l.debit, l.credit])).toEqual([
      ['acc-vat_output', 1500, 0], ['acc-2130', 0, 1500],
    ]);
    expect(lines.description).toContain('top-up for v2');
    expect(rec).toMatchObject({ totalOutputTax: 1500, totalInputTax: 0, netVat: 1500, returnVersionId: V2 });
  });

  it('nothing left to settle after an amend: 409 VAT_ALREADY_SETTLED, no journal', async () => {
    arrange([1500, 0], 1500, [1500, 0, 1]);
    expect(await refusal(submitVATReturn(CO, P, USER))).toMatchObject({ status: 409, refusalCode: 'VAT_ALREADY_SETTLED' });
    expect(createJournalEntry).not.toHaveBeenCalled();
  });
});
