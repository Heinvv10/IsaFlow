/** Wire shapes and the scripted `apiFetch` of the intercompany inbox component tests. (The test files own their vi.mock calls.) */
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { envelope } from './intercompanyFixtures';
import type { InboxDetail, InboxItem } from '@/modules/accounting/services/intercompany/inboxTypes';

export const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'm-1', kind: 'invoice', status: 'pending', connectionId: 'c-1', senderName: 'Blitz Fibre', number: 'INV-100', date: '2026-11-18', dueDate: '2026-12-18',
  currency: 'ZAR', subtotal: 1000, taxAmount: 150, total: 1150, notes: null, creditsInvoiceNumber: null, lineCount: 2, hasPdf: true, blocker: null,
  reason: null, error: null, sourceCancelled: false, sourceChanged: false, autoExhausted: false, handledAt: null, handledVia: null, targetDocType: null, targetDocId: null, createdAt: '2026-11-18T10:00:00.000Z', ...over,
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

export interface Serve { items?: InboxItem[]; detail?: InboxDetail; post?: (url: string, body: unknown) => Response }
export function serve(s: Serve = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = init as RequestInit | undefined;
    if (i?.method === 'POST') return s.post?.(u, i.body ? JSON.parse(String(i.body)) : undefined) ?? envelope({});
    if (u.includes('/inbox?')) {
      const items = (s.items ?? [item()]).filter((x) => (u.includes('filter=handled') ? !['pending', 'failed'].includes(x.status) : ['pending', 'failed'].includes(x.status)));
      return envelope({ items, total: items.length, openCount: (s.items ?? [item()]).filter((x) => ['pending', 'failed'].includes(x.status)).length });
    }
    if (/\/inbox\/[^/]+$/.test(u)) return envelope(s.detail ?? detail());
    return envelope({});
  });
}
export const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');

