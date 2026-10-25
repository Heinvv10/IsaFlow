// Shared fixtures for the picker component tests (uiPickers*.test.tsx): the response shapes of the real routes.
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const fail = (status = 500) => new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status });
export const urls = () => vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));

export const CUSTOMERS = [
  { id: 'c1', name: 'Acme Trading' },
  { id: 'c2', name: 'Bravo Logistics' },
  { id: 'c3', name: 'Acme Holdings' },
];
export const ACCOUNTS = [
  { id: 'a1', accountCode: '1000', accountName: 'Cash at Bank', accountType: 'asset', accountSubtype: 'bank' },
  { id: 'a2', accountCode: '4000', accountName: 'Sales', accountType: 'revenue' },
  { id: 'a3', accountCode: '6000', accountName: 'Rent', accountType: 'expense' },
  { id: 'a4', accountCode: '6100', accountName: 'Repairs', accountType: 'expense' },
];
export const ITEMS = [
  { id: 'i1', code: 'WID-1', description: 'Widget' },
  { id: 'i2', code: 'SVC-1', description: 'Consulting hour' },
];

