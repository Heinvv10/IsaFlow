/**
 * R-112/R-113 round 2.
 *  - The batch statement export must not render a customer whose detail call
 *    failed (a soft-deleted customer is a 404) as an empty R0.00 statement; it
 *    names them back to the caller instead.
 *  - The windowed statement's default start is a year before its END, so a
 *    caller sending only an old toDate still gets a window, not a 400.
 * R-116: the batch PDFs print the picked as-at date, so their figures are drawn
 * as at that date; a bad as-at date is refused, none means today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
const generateStatementPdf = vi.fn();
vi.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/modules/accounting/utils/statementPdf', () => ({ generateStatementPdf: (...a: unknown[]) => generateStatementPdf(...a) }));

import { generateStatementsBatch } from '@/modules/accounting/utils/generateStatementsBatch';
import { resolveStatementAsAt, resolveStatementWindow } from '@/modules/accounting/services/ar/customerStatementRules';
import { asAtTodayStr } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import type { CustomerBalance } from '@/components/accounting/CustomerStatementTable';

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

const customers = [
  { client_id: 'gone', client_name: 'Gone Ltd' },
  { client_id: 'live', client_name: 'Live Ltd' },
] as unknown as CustomerBalance[];

describe('generateStatementsBatch', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    generateStatementPdf.mockReset();
    generateStatementPdf.mockResolvedValue(new Blob(['pdf']));
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('company-details')) return reply(200, { data: { name: 'Co' } });
      if (url.includes('client_id=gone')) return reply(404, { success: false, error: { message: 'Client not found' } });
      return reply(200, { data: { client: {}, summary: { totalInvoiced: 100, totalPaid: 0, totalCredits: 0, balance: 100 }, transactions: [] } });
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    vi.stubGlobal('document', { createElement: () => ({ click: () => undefined }) });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names a selected id that is not in the list, instead of dropping it from the count', async () => {
    const result = await generateStatementsBatch(new Set(['live', 'stale']), customers, '2026-09-21');
    expect(result).toEqual({ generated: 1, skipped: [{ name: 'stale', reason: 'not in the current balances list' }] });
  });

  it('skips and names a customer whose statement call fails, instead of rendering R0.00', async () => {
    const result = await generateStatementsBatch(new Set(['gone', 'live']), customers, '2026-09-21');
    expect(result).toEqual({ generated: 1, skipped: [{ name: 'Gone Ltd', reason: 'Client not found' }] });
    expect(generateStatementPdf).toHaveBeenCalledTimes(1);
    expect(generateStatementPdf.mock.calls[0]![0]).toMatchObject({ clientName: 'Live Ltd', balanceOutstanding: 100 });
  });

  it('draws each statement as at the date it prints', async () => {
    await generateStatementsBatch(new Set(['live']), customers, '2026-08-31');
    const detailCall = apiFetch.mock.calls.map(c => String(c[0])).find(u => u.includes('customer-statement-detail'));
    expect(new URL(detailCall!, 'http://x').searchParams.get('as_at_date')).toBe('2026-08-31');
    expect(generateStatementPdf.mock.calls[0]![0]).toMatchObject({ asAtDate: '2026-08-31' });
  });

  it('prints the company address the company-details API composes, falling back to the parts', async () => {
    apiFetch.mockImplementation(async (url: string) => url.includes('company-details')
      ? reply(200, { data: { name: 'Co', address: '1 Main Rd, Unit 2, Cape Town', address_line1: '1 Main Rd', city: 'Cape Town' } })
      : reply(200, { data: { client: {}, summary: { balance: 0 }, transactions: [] } }));
    await generateStatementsBatch(new Set(['live']), customers, '2026-08-31');
    expect(generateStatementPdf.mock.calls[0]![0]).toMatchObject({ companyAddress: '1 Main Rd, Unit 2, Cape Town' });
    apiFetch.mockImplementation(async (url: string) => url.includes('company-details')
      ? reply(200, { data: { name: 'Co', address_line1: '1 Main Rd', city: 'Cape Town' } })
      : reply(200, { data: { client: {}, summary: { balance: 0 }, transactions: [] } }));
    await generateStatementsBatch(new Set(['live']), customers, '2026-08-31');
    expect(generateStatementPdf.mock.calls[1]![0]).toMatchObject({ companyAddress: '1 Main Rd, Cape Town' });
  });
});

describe('resolveStatementAsAt', () => {
  it('takes a real date as given and defaults to today', () => {
    expect(resolveStatementAsAt('2026-08-31')).toEqual({ asAt: '2026-08-31' });
    expect(resolveStatementAsAt(undefined)).toEqual({ asAt: asAtTodayStr() });
    expect(resolveStatementAsAt('')).toEqual({ asAt: asAtTodayStr() });
  });

  it('refuses a non-date, an impossible date or a repeated parameter', () => {
    for (const bad of ['garbage', '2026-02-30', '31/08/2026', ['2026-08-31']]) {
      expect(resolveStatementAsAt(bad), String(bad)).toHaveProperty('error');
    }
  });
});

describe('resolveStatementWindow', () => {
  it('defaults the start to a year before an explicit toDate', () => {
    expect(resolveStatementWindow(undefined, '2024-12-31')).toEqual({ from: '2024-01-01', to: '2024-12-31' });
  });

  it('refuses a non-date or an inverted window', () => {
    expect(resolveStatementWindow('garbage', undefined)).toHaveProperty('error');
    expect(resolveStatementWindow('2024-12-31', '2024-01-01')).toHaveProperty('error');
    expect(resolveStatementWindow(['2024-01-01'], undefined)).toHaveProperty('error');
  });
});
