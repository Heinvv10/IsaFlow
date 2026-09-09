import { beforeEach, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/neon')>(), sql: query }));
import { closePeriod, lockPeriod, reopenPeriod, closeYear } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { updateCompany } from '@/modules/accounting/services/core/companyService';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
const company = 'b1111111-1111-4111-8111-111111111111', period = 'b2222222-2222-4222-8222-222222222222';
beforeEach(() => {
  query.mockReset().mockResolvedValue([{ id: period, company_id: company, status: 'open', fiscal_year: 2026, period_number: 1,
    period_name: 'Synthetic', start_date: '2026-01-01', end_date: '2026-01-31', cnt: '0' }]);
});
it.each([
  ['close', () => closePeriod(company, period, 'u1')],
  ['lock', () => lockPeriod(company, period)],
  ['reopen', () => reopenPeriod(company, period)],
  ['year close', () => closeYear(company, 2026, 'u1')],
  ['company lockdown', () => updateCompany(company, { lockdownEnabled: true, lockdownDate: '2026-01-31' })],
  ['VAT lock', () => lockVatPeriod(company, '2026-01-01', '2026-02-28',
    { outputTax: 0, inputTax: 0, netVat: 0, postedThrough: '2026-03-01T00:00:00Z' }, { userId: 'u1', actorType: 'human' })],
] as const)('%s requires the active control transaction before any mutation query', async (_name, execute) => {
  await expect(execute()).rejects.toThrow(/control transaction/i);
  expect(query).not.toHaveBeenCalled();
});
