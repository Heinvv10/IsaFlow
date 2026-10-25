import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/utils/statementPdf', () => ({ generateStatementPdf: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { fetchCompanyMeta, generateStatementsBatch } from '@/modules/accounting/utils/generateStatementsBatch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import type { CustomerBalance } from '@/components/accounting/CustomerStatementTable';

useApiJsonOverMock();
const CUST = { client_id: 'c1', client_name: 'Acme' } as CustomerBalance;
const refused = (message: string, status = 404) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('generateStatementsBatch', () => {
  it('a customer the server refuses is skipped with the server message', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { name: 'Co' } }), { status: 200 }))
      .mockResolvedValueOnce(refused('Customer not found'));
    const r = await generateStatementsBatch(new Set(['c1']), [CUST], '2026-09-30');
    expect(r.generated).toBe(0);
    expect(r.skipped).toEqual([{ name: 'Acme', reason: 'Customer not found' }]);
  });

  it('an empty 500 is skipped with a plain sentence, never an HTTP code or a JSON error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { name: 'Co' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const r = await generateStatementsBatch(new Set(['c1']), [CUST], '2026-09-30');
    expect(r.skipped[0]?.reason).toBe('the statement could not be loaded');
    expect(r.skipped[0]?.reason).not.toMatch(/JSON|Unexpected end|HTTP \d/);
  });

  it('a refused company-details call falls back to default branding, not blank fields from the error body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(refused('Forbidden', 403));
    expect(await fetchCompanyMeta()).toEqual({ accentColor: '#0f766e' });
  });

  it('a 200 company-details call fills the branding', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { name: 'Co', vat_number: '4' } }), { status: 200 }));
    const m = await fetchCompanyMeta();
    expect(m.companyName).toBe('Co');
    expect(m.companyVatNumber).toBe('4');
  });
});
