// Shared setup for the supplierForm*.test.tsx suites (PUR-01): module mocks, the
// fake suppliers-list route, and the pick/submit helpers. Split out to keep each
// suite under the 300-line limit; it is imported before any page.
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';

export const router = { isReady: true, query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn() };
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/suppliers/PoGrnSelector', () => ({
  PoGrnSelector: (p: { selectedPoId: string; selectedGrnId: string; copyLines: boolean; onPoChange: (v: string) => void; onGrnChange: (v: string) => void; onCopyLinesChange: (v: boolean) => void }) => (
    <button type="button" onClick={() => { p.onPoChange('po-x'); p.onGrnChange('grn-x'); p.onCopyLinesChange(true); }}>set-po</button>
  ),
}));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <>
      <button type="button" onClick={() => onExtracted(scan('Alpha Traders'))}>scan-alpha</button>
      <button type="button" onClick={() => onExtracted(scan('Beta Supplies'))}>scan-beta</button>
    </>
  ),
}));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';

export const SA = '00000000-0000-4000-8000-00000000000a';
export const SB = '00000000-0000-4000-8000-00000000000b';
export const S26 = '00000000-0000-4000-8000-000000000026';
export const SUPPLIERS = [
  { id: SA, name: 'Alpha Traders', company_name: null },
  { id: SB, name: 'Beta Supplies', company_name: null },
  { id: S26, name: 'Supplier One', company_name: 'Supplier One Holdings' },
];
export function scan(vendorName: string) {
  return { vendorName, referenceNumber: null, date: null, dueDate: null, paymentTerms: null, vatRate: null, totalAmount: null, lineItems: [], confidence: 1, warnings: [] };
}
export const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });

export type Write = { url: string; method: string; body: Record<string, unknown> };
export const writes: Write[] = [];
export const supplierDelay: Record<string, number> = {};
let extra: (url: string) => Response | null = () => null;
export const setExtra = (fn: (url: string) => Response | null) => { extra = fn; };

beforeEach(() => {
  writes.length = 0; for (const k of Object.keys(supplierDelay)) delete supplierDelay[k];
  extra = () => null; router.query = {}; router.push.mockReset();
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) });
      return json(method === 'PUT' ? { id: 'po1', po_number: 'PO-1', status: 'draft', items: [] } : { id: 'new1' });
    }
    const custom = extra(url);
    if (custom) return custom;
    if (url.includes('suppliers-list')) {
      const u = new URL(url, 'http://x');
      const id = u.searchParams.get('id');
      if (id) { const s = SUPPLIERS.find((r) => r.id === id); return s ? json(s) : json({}, 404); }
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      await new Promise((r) => setTimeout(r, supplierDelay[q] ?? 0));
      return json({ suppliers: SUPPLIERS.filter((s) => s.name.toLowerCase().includes(q)), total: 3 });
    }
    if (url.includes('document-numbers')) return json([]);
    return json({});
  });
});
afterEach(() => vi.mocked(apiFetch).mockReset());

export const supplierInput = (c: HTMLElement) => c.querySelector('input[name="supplierIdSearch"]') as HTMLInputElement;
export const supplierId = (c: HTMLElement) => (c.querySelector('input[name="supplierId"]') as HTMLInputElement).value;
export async function pick(c: HTMLElement, name = 'Supplier One') {
  fireEvent.focus(supplierInput(c));
  fireEvent.click(await screen.findByRole('button', { name }, { timeout: 2000 }));
}
export const writesTo = (frag: string) => writes.filter((w) => w.url.includes(frag));
export const submit = (c: HTMLElement) => fireEvent.submit(c.querySelector('form')!);
export const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
export const mockedFetch = vi.mocked(apiFetch);
