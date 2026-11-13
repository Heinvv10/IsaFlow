/**
 * changeCompanyVatProfile: every refusal comes before the write, the write is companyService.updateCompany with only
 * the changed fields on the caller's company, and the dry run takes the identical path inside a rolled-back savepoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as unknown[][], sqlCalls: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    h.sqlCalls.push(strings.join('?'));
    return h.rows.shift() ?? [];
  }),
}));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getCompany: vi.fn(), updateCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }),
}));

import { getCompany, updateCompany } from '@/modules/accounting/services/core/companyService';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { changeCompanyVatProfile } from '@/modules/accounting/services/core/companyVatProfileService';

const CO = '11111111-1111-4111-8111-111111111111';
const NOV_13 = new Date('2026-11-13T09:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  vatNumber: '4123456789', taxNumber: '9123456789', vatPeriod: 'bi-monthly', vatSystemType: 'invoice', vatPeriodAlignment: 'odd', ...over,
});
const FILED = { source: 'vat_period_lock', period_start: '2026-09-01', period_end: '2026-10-31', unlocked: false };
const opts = (over: Record<string, unknown> = {}) => ({ dryRun: false, acknowledgePeriodChange: false, asOf: NOV_13, ...over });

/** Queue the rows the service reads: the FOR UPDATE lock, then the filing footprint. */
function world(company: Record<string, unknown> | null, filed: unknown[] = []) {
  h.rows = [[{ id: CO }], filed];
  vi.mocked(getCompany).mockResolvedValue(company as never);
}

beforeEach(() => {
  h.rows = [];
  h.sqlCalls = [];
  vi.clearAllMocks();
  vi.mocked(updateCompany).mockImplementation(async (_id, patch) => ({ ...row(), ...(patch as object) }) as never);
});

describe('refusals come before any write', () => {
  it.each([
    ['a VAT number not starting with 4', { vatNumber: '3123456789' }, 'VAT number'],
    ['an income tax number with a bad lead digit', { incomeTaxNumber: '5123456789' }, 'income tax'],
    ['a short income tax number', { incomeTaxNumber: '912345' }, 'income tax'],
  ])('%s', async (_n, req, msg) => {
    world(row());
    const r = await changeCompanyVatProfile(CO, req, opts());
    expect(r).toMatchObject({ refused: expect.stringContaining(msg) });
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it('a VAT number or a category for a company that is not VAT registered', async () => {
    world(row({ vatSystemType: 'none' }));
    expect(await changeCompanyVatProfile(CO, { vatNumber: '4123456780' }, opts())).toMatchObject({ refused: expect.stringContaining('not registered') });
    world(row({ vatSystemType: 'none' }));
    expect(await changeCompanyVatProfile(CO, { category: 'C' }, opts())).toMatchObject({ refused: expect.stringContaining('not registered') });
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it('a missing company', async () => {
    h.rows = [[]];
    expect(await changeCompanyVatProfile(CO, { vatNumber: '4123456780' }, opts())).toEqual({ refused: 'Not found' });
  });

  it('a period change over VAT returns, locks or versions without the acknowledgement, naming the periods that move', async () => {
    world(row(), [FILED]);
    const r = await changeCompanyVatProfile(CO, { category: 'B' }, opts());
    expect(r).toMatchObject({ refused: expect.stringContaining('acknowledge_period_change: true') });
    const msg = (r as { refused: string }).refused;
    expect(msg).toContain('vat_period_lock 2026-09-01..2026-10-31');
    expect(msg).toContain('2026-10-01..2026-11-30 -> 2026-11-01..2026-12-31');
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it('the dry run meets the same acknowledgement refusal', async () => {
    world(row(), [FILED]);
    const r = await changeCompanyVatProfile(CO, { category: 'B' }, opts({ dryRun: true }));
    expect(r).toHaveProperty('refused');
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
    expect(updateCompany).not.toHaveBeenCalled();
  });
});

describe('the write', () => {
  it('locks the company row first and writes only the changed fields to the caller\'s company', async () => {
    world(row(), [FILED]);
    const r = await changeCompanyVatProfile(CO, { category: 'B', vatNumber: '4999999999' }, opts({ acknowledgePeriodChange: true }));
    expect(h.sqlCalls[0]).toContain('FOR UPDATE');
    expect(updateCompany).toHaveBeenCalledTimes(1);
    expect(updateCompany).toHaveBeenCalledWith(CO, { vatNumber: '4999999999', vatPeriod: 'bi-monthly', vatPeriodAlignment: 'even' });
    expect(r).toMatchObject({
      nothingChanged: false, changed: ['vat_number', 'vat_category'],
      before: { vat_number: '4123456789', vat_category: 'A', vat_alignment: 'odd' },
      after: { vat_number: '4999999999', vat_category: 'B', vat_alignment: 'even' },
      undoArguments: { vat_number: '4123456789', vat_category: 'A' },
    });
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
  });

  it('A to C writes monthly and leaves the alignment column alone', async () => {
    world(row());
    await changeCompanyVatProfile(CO, { category: 'C' }, opts());
    expect(updateCompany).toHaveBeenCalledWith(CO, { vatPeriod: 'monthly' });
  });

  it('a number-only change needs no acknowledgement even with returns on file', async () => {
    world(row(), [FILED]);
    const r = await changeCompanyVatProfile(CO, { incomeTaxNumber: '9000000001' }, opts());
    expect(updateCompany).toHaveBeenCalledWith(CO, { taxNumber: '9000000001' });
    expect(r).toMatchObject({ changed: ['income_tax_number'], periodImpact: null });
  });

  it('a period change with nothing filed needs no acknowledgement', async () => {
    world(row());
    const r = await changeCompanyVatProfile(CO, { alignment: 'even' }, opts());
    expect(r).toMatchObject({ changed: ['vat_category'], after: { vat_category: 'B' } });
  });

  it('a request that matches the company writes nothing', async () => {
    world(row(), [FILED]);
    const r = await changeCompanyVatProfile(CO, { vatNumber: '4123456789', category: 'A', alignment: 'odd' }, opts());
    expect(r).toMatchObject({ nothingChanged: true, changed: [], undoArguments: {} });
    expect(updateCompany).not.toHaveBeenCalled();
  });

  it('a stored number with spaces is the same number', async () => {
    world(row({ vatNumber: '4123 456 789' }));
    const r = await changeCompanyVatProfile(CO, { vatNumber: '4123456789' }, opts());
    expect(r).toMatchObject({ nothingChanged: true });
  });

  it('the dry run takes the identical write inside the rolled-back savepoint and reports the after values', async () => {
    world(row());
    const r = await changeCompanyVatProfile(CO, { category: 'B' }, opts({ dryRun: true }));
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(updateCompany).toHaveBeenCalledWith(CO, { vatPeriod: 'bi-monthly', vatPeriodAlignment: 'even' });
    expect(r).toMatchObject({ after: { vat_category: 'B' } });
  });

  it('a failing write propagates', async () => {
    world(row());
    vi.mocked(updateCompany).mockRejectedValue(new Error('boom'));
    await expect(changeCompanyVatProfile(CO, { category: 'B' }, opts())).rejects.toThrow('boom');
  });
});
