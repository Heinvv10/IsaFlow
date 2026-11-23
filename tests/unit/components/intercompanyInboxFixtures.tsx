/** Wire shapes and the scripted `apiFetch` of the intercompany inbox component tests. (The test files own their vi.mock calls.) */
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { envelope, failure } from './intercompanyFixtures';
import type { InboxDetail, InboxItem } from '@/modules/accounting/services/intercompany/inboxTypes';
import type { AllocationDetail, AllocationItem } from '@/modules/accounting/services/intercompany/allocationInboxTypes';

export const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'm-1', kind: 'invoice', status: 'pending', connectionId: 'c-1', senderName: 'Blitz Fibre', number: 'INV-100', date: '2026-11-18', dueDate: '2026-12-18',
  currency: 'ZAR', subtotal: 1000, taxAmount: 150, total: 1150, notes: null, creditsInvoiceNumber: null, lineCount: 2, hasPdf: true, blocker: null,
  reason: null, error: null, groupMatch: null, varianceReason: null, sourceCancelled: false, sourceChanged: false, autoExhausted: false, handledAt: null, handledVia: null, targetDocType: null, targetDocId: null, createdAt: '2026-11-18T10:00:00.000Z', ...over,
});
export const detail = (over: Partial<InboxDetail> = {}): InboxDetail => ({
  item: item(),
  lines: [
    { index: 0, description: 'Fibre install', quantity: 2, unitPrice: 300, taxRate: 15, taxAmount: 90, lineTotal: 600, accountId: 'acc-1', accountLabel: '5000 Fees', accountSource: 'default' },
    { index: 1, description: 'Router', quantity: 1, unitPrice: 400, taxRate: 15, taxAmount: 60, lineTotal: 400, accountId: null, accountLabel: null, accountSource: null },
  ],
  supplier: { id: 's-1', name: 'Blitz Fibre (supplier)' }, duplicateOf: null, blockers: [],
  accounts: [{ id: 'acc-1', label: '5000 Fees' }, { id: 'acc-2', label: '5100 Consumables' }], ...over,
});

export interface Serve {
  items?: InboxItem[]; detail?: InboxDetail; post?: (url: string, body: unknown) => Response;
  /** "Payments from your group" (P4-C): none unless a test lists some. */
  allocations?: AllocationItem[]; allocationDetail?: AllocationDetail; allocationsFail?: boolean;
}
const OPEN = ['pending', 'failed'];
export function serve(s: Serve = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = init as RequestInit | undefined;
    if (i?.method === 'POST') return s.post?.(u, i.body ? JSON.parse(String(i.body)) : undefined) ?? envelope({});
    if (u.includes('/allocations?')) {
      if (s.allocationsFail) return failure('Could not load', 500);
      const all = s.allocations ?? [];
      const items = all.filter((x) => (u.includes('filter=handled') ? !OPEN.includes(x.status) : OPEN.includes(x.status)));
      return envelope({ items, total: items.length, allocationCount: all.filter((x) => OPEN.includes(x.status)).length });
    }
    if (/\/allocations\/[^/]+$/.test(u)) {
      const item = s.allocationDetail?.item ?? (s.allocations ?? []).find((x) => u.endsWith(`/${x.id}`));
      return item ? envelope(s.allocationDetail ?? { item, allocationId: null, linkId: null, linkOrigin: null, cutoverDate: null }) : failure('Not found', 404);
    }
    if (u.includes('/inbox?')) {
      const items = (s.items ?? [item()]).filter((x) => (u.includes('filter=handled') ? !['pending', 'failed'].includes(x.status) : ['pending', 'failed'].includes(x.status)));
      return envelope({ items, total: items.length, openCount: (s.items ?? [item()]).filter((x) => ['pending', 'failed'].includes(x.status)).length });
    }
    if (/\/inbox\/[^/]+$/.test(u)) return envelope(s.detail ?? detail());
    return envelope({});
  });
}
/** "Payments from your group" with nothing in it: for a test's own `apiFetch` script (the page asks for it beside the invoice list). */
export const noPayments = () => envelope({ items: [], total: 0, allocationCount: 0 });
export const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');

