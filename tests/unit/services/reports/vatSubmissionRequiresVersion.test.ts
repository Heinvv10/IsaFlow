/**
 * VR (§0a.12): submitVATReturn settles a VAT period only against a finalised or filed VAT201 version for exactly that
 * period, and records which one. Wiring only (sql mocked): the refusal is the FIRST query and nothing follows it; the
 * row it writes carries the version id. The refusal changing no row on real PG is
 * tests/integration/vat-returns-settlement-version.int.test.ts.
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

import { sql } from '@/lib/neon';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { createJournalEntry, resolveUserUuid } from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';
import { ReturnRefusal } from '@/modules/accounting/services/returns/returnVersionTypes';

const CO = '00000000-0000-0000-0000-000000000001';
const USER = '22222222-2222-2222-2222-222222222222';
const VERSION = '33333333-3333-3333-3333-333333333333';
const P = { periodStart: '2026-01-01', periodEnd: '2026-02-28' };
const text = (i: number) => (vi.mocked(sql).mock.calls[i]![0] as TemplateStringsArray).join('?');

describe('submitVATReturn requires a finalised or filed VAT201 version (VR)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no version for the exact period: 409 VAT201_NOT_FINALISED, and the version read is the only query', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    const err = await submitVATReturn(CO, P, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReturnRefusal);
    expect(err).toMatchObject({ status: 409, refusalCode: 'VAT201_NOT_FINALISED' });
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
    expect(text(0)).toContain('tax_return_versions');
    expect(text(0)).toMatch(/status IN \('finalised', 'filed'\)/);
    expect(vi.mocked(sql).mock.calls[0]!.slice(1)).toEqual([CO, P.periodStart, P.periodEnd]);
    expect(getVATReturn).not.toHaveBeenCalled();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('with a version: the vat_returns row is written with its id', async () => {
    vi.mocked(getVATReturn).mockResolvedValue({ totalOutputTax: 150, totalInputTax: 60 } as never);
    vi.mocked(getSystemAccount).mockImplementation(async (role: string) => ({ id: `acc-${role}` }) as never);
    vi.mocked(resolveUserUuid).mockResolvedValue(USER as never);
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never);
    vi.mocked(sql)
      .mockResolvedValueOnce([{ id: VERSION, version_no: 2, status: 'filed' }] as never) // the version
      .mockResolvedValueOnce([] as never) // idempotency: none submitted
      .mockResolvedValueOnce([{ id: 'acc-2130' }] as never) // 2130
      .mockResolvedValueOnce([{ id: 'vr-1', company_id: CO, period_start: P.periodStart, period_end: P.periodEnd,
        status: 'submitted', total_output_tax: 150, total_input_tax: 60, net_vat: 90, return_version_id: VERSION }] as never);

    const rec = await submitVATReturn(CO, P, USER);

    const insert = vi.mocked(sql).mock.calls.findIndex((c) => /INSERT INTO vat_returns/.test((c[0] as string[]).join('?')));
    expect(text(insert)).toContain('return_version_id');
    expect(vi.mocked(sql).mock.calls[insert]!.at(-1)).toBe(VERSION);
    expect(rec.returnVersionId).toBe(VERSION);
  });
});
