/**
 * A 0% credit note (a mirror_bill note on a zero-rated bill, review round 1 A9) prints "VAT (0%)", not the 15%
 * `tax_rate || 15` falls back to on a numeric zero. node-postgres returns NUMERIC as the string '0.00' today (no
 * type parser is set), which is truthy, so the old code printed 0% too; this pins the numeric case.
 */
import { describe, expect, it, vi } from 'vitest';

const { totals, row } = vi.hoisted(() => ({ totals: vi.fn(), row: { current: {} as Record<string, unknown> } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => [{ id: 'n1', type: 'supplier', credit_note_number: 'CN-1', credit_date: '2026-06-20',
    subtotal: '500.00', tax_rate: 0, tax_amount: '0.00', total_amount: '500.00', status: 'draft', ...row.current }]),
}));
vi.mock('@/modules/accounting/services/core/pdfShared', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/core/pdfShared')>('@/modules/accounting/services/core/pdfShared');
  return {
    ...actual,
    getCompanyDetailsFromCompany: vi.fn(async () => ({ name: 'Co', primaryColor: '#0f766e' })),
    renderTotalsBlock: totals.mockImplementation((_d: unknown, y: number) => y),
  };
});

import { generateCreditNotePdf } from '@/modules/accounting/services/ar/creditNotePdfBuilder';

describe('credit note PDF VAT label', () => {
  it('prints VAT (0%) for a 0% note', async () => {
    await generateCreditNotePdf('co', 'n1').catch(() => undefined);
    const labels = (totals.mock.calls[0]![5] as { label: string }[]).map((r) => r.label);
    expect(labels).toContain('VAT (0%)');
  });

  it('prints plain VAT for a note mixing rated and unrated lines (its one header rate is not its VAT)', async () => {
    totals.mockClear();
    row.current = { subtotal: '1750.00', tax_rate: '15.00', tax_amount: '150.00', total_amount: '1900.00' };
    await generateCreditNotePdf('co', 'n1').catch(() => undefined);
    const labels = (totals.mock.calls[0]![5] as { label: string }[]).map((r) => r.label);
    expect(labels).toContain('VAT');
    expect(labels).not.toContain('VAT (15%)');
  });

  it('still prints the rate for a note that is all at one rate', async () => {
    totals.mockClear();
    row.current = { subtotal: '1000.00', tax_rate: '15.00', tax_amount: '150.00', total_amount: '1150.00' };
    await generateCreditNotePdf('co', 'n1').catch(() => undefined);
    expect((totals.mock.calls[0]![5] as { label: string }[]).map((r) => r.label)).toContain('VAT (15%)');
  });
});
