/**
 * vatSubmissionService — V-05: the VAT clearing journal was dated INSIDE the
 * period it clears.
 *
 * `getVATReturn` computes the period's output/input tax as the movement on the
 * vat_output / vat_input control accounts between periodStart and periodEnd.
 * Dating the clearing entry on periodEnd puts it inside that window, where it
 * reverses the very movement it settles: the demo company filed R200,974.70 of
 * output tax for 2026-01/02 and the GL movement for that period subsequently
 * read R11,363.16. All six filed periods collapsed the same way.
 *
 * The clearing journal belongs to the FIRST DAY OF THE FOLLOWING PERIOD — the
 * date the liability to SARS crystallises, outside the period being reported.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/reports/vatReturnService', () => ({
  getVATReturn: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  resolveUserUuid: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));
// P2-11: submitVATReturn now asserts the clearing date HAS a fiscal period
// before posting. This suite mocks `sql` wholesale, so the real lookup would
// read from a mock that returns undefined. Resolving to a period keeps these
// cases on the path they are about — the DATE of the entry. The guard itself is
// covered by vatSubmissionClearingPeriodGuardDb.test.ts against a real database.
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodIdForDate: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
}));

import { sql } from '@/lib/neon';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import {
  createJournalEntry,
  postJournalEntry,
  resolveUserUuid,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { submitVATReturn } from '@/modules/accounting/services/reports/vatSubmissionService';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '22222222-2222-2222-2222-222222222222';

interface JeInput {
  entryDate: string;
  description: string;
  source: string;
  lines: { glAccountId: string; debit: number; credit: number; description: string }[];
}

function arrange(outputTax: number, inputTax: number) {
  vi.mocked(getVATReturn).mockResolvedValue({
    totalOutputTax: outputTax,
    totalInputTax: inputTax,
  } as never);

  vi.mocked(getSystemAccount).mockImplementation(
    async (role: string) => ({ id: `acc-${role}` }) as never,
  );
  vi.mocked(resolveUserUuid).mockResolvedValue(USER_ID as never);
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never);
  vi.mocked(postJournalEntry).mockResolvedValue(undefined as never);

  vi.mocked(sql)
    // 1. idempotency guard — no existing submission
    .mockResolvedValueOnce([] as never)
    // 2. resolveNetVatAccount — 2130 found
    .mockResolvedValueOnce([{ id: 'acc-2130' }] as never)
    // 3. INSERT INTO vat_returns
    .mockResolvedValueOnce([
      {
        id: 'vr-1', company_id: COMPANY_ID, period_start: '2026-01-01',
        period_end: '2026-02-28', status: 'submitted',
        total_output_tax: outputTax, total_input_tax: inputTax,
        net_vat: outputTax - inputTax, submitted_at: '2026-03-01',
        created_at: '2026-03-01', updated_at: '2026-03-01',
      },
    ] as never);
}

function jeArg(): JeInput {
  expect(vi.mocked(createJournalEntry)).toHaveBeenCalledTimes(1);
  return vi.mocked(createJournalEntry).mock.calls[0]![1] as unknown as JeInput;
}

describe('vatSubmissionService — V-05 clearing journal date', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dates the clearing journal the day AFTER the period end, not on it', async () => {
    arrange(200974.70, 75554.93);

    await submitVATReturn(
      COMPANY_ID,
      { periodStart: '2026-01-01', periodEnd: '2026-02-28' },
      USER_ID,
    );

    const je = jeArg();
    expect(je.entryDate).toBe('2026-03-01');
    expect(je.entryDate).not.toBe('2026-02-28');
  });

  it('rolls over a month end, a leap-year February and a year end', async () => {
    const cases: [string, string, string][] = [
      ['2026-01-01', '2026-01-31', '2026-02-01'],
      ['2024-02-01', '2024-02-29', '2024-03-01'], // leap year
      ['2026-11-01', '2026-12-31', '2027-01-01'], // year end
      ['2026-03-01', '2026-04-30', '2026-05-01'],
    ];

    for (const [start, end, expected] of cases) {
      vi.clearAllMocks();
      arrange(1000, 400);
      await submitVATReturn(COMPANY_ID, { periodStart: start, periodEnd: end }, USER_ID);
      expect(jeArg().entryDate).toBe(expected);
    }
  });

  it('accepts a timestamp-shaped periodEnd and still returns a bare next-day date', async () => {
    arrange(1000, 400);
    await submitVATReturn(
      COMPANY_ID,
      { periodStart: '2026-01-01', periodEnd: '2026-02-28T00:00:00.000Z' },
      USER_ID,
    );
    expect(jeArg().entryDate).toBe('2026-03-01');
  });

  it('leaves the amounts, accounts and balance of the entry untouched', async () => {
    arrange(200974.70, 75554.93);

    await submitVATReturn(
      COMPANY_ID,
      { periodStart: '2026-01-01', periodEnd: '2026-02-28' },
      USER_ID,
    );

    const je = jeArg();
    expect(je.source).toBe('auto_vat_submission');

    const debits = je.lines.reduce((s, l) => s + l.debit, 0);
    const credits = je.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 6);
    expect(debits).toBeCloseTo(200974.70, 2);

    const byAccount = Object.fromEntries(
      je.lines.map((l) => [l.glAccountId, { debit: l.debit, credit: l.credit }]),
    );
    expect(byAccount['acc-vat_output']).toEqual({ debit: 200974.70, credit: 0 });
    expect(byAccount['acc-vat_input']).toEqual({ debit: 0, credit: 75554.93 });
    // netVat is not rounded in the service (float artefact: …77000000002); the
    // numeric(14,2) column rounds on insert. Amounts are out of scope for V-05 —
    // assert to the cent, not to the bit.
    expect(byAccount['acc-2130']!.debit).toBe(0);
    expect(byAccount['acc-2130']!.credit).toBeCloseTo(125419.77, 2);
  });

  it('still posts a balanced refund-case entry on the following-period date', async () => {
    arrange(20000, 50000);

    await submitVATReturn(
      COMPANY_ID,
      { periodStart: '2026-05-01', periodEnd: '2026-06-30' },
      USER_ID,
    );

    const je = jeArg();
    expect(je.entryDate).toBe('2026-07-01');
    const byAccount = Object.fromEntries(
      je.lines.map((l) => [l.glAccountId, { debit: l.debit, credit: l.credit }]),
    );
    expect(byAccount['acc-2130']).toEqual({ debit: 30000, credit: 0 });
    const debits = je.lines.reduce((s, l) => s + l.debit, 0);
    const credits = je.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 6);
  });

  it('posts no journal at all for a nil return', async () => {
    arrange(0, 0);
    await submitVATReturn(
      COMPANY_ID,
      { periodStart: '2026-01-01', periodEnd: '2026-02-28' },
      USER_ID,
    );
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
    expect(vi.mocked(postJournalEntry)).not.toHaveBeenCalled();
  });

  it('rejects a periodEnd that is not a parseable date rather than posting an invalid entry', async () => {
    arrange(1000, 400);
    await expect(
      submitVATReturn(COMPANY_ID, { periodStart: '2026-01-01', periodEnd: 'not-a-date' }, USER_ID),
    ).rejects.toThrow(/periodEnd/i);
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
  });
});
