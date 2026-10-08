/**
 * Scripted API for the approvals page's Rules tab (R-035 follow-up, PR A).
 * Every GET the page makes is answered; a write is answered by `writes[method]`
 * (default 200), and every write is recorded with its parsed body so a test can
 * assert exactly what the UI sent.
 */
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export interface ServedRule {
  id: string; name: string; documentType: string; conditionField: string; conditionOperator: string;
  conditionValue: number; approverRole: string; isActive: boolean;
}

export const rule = (over: Partial<ServedRule> = {}): ServedRule => ({
  id: 'r-1', name: 'Big bills', documentType: 'supplier_invoice', conditionField: 'total',
  conditionOperator: 'greater_than', conditionValue: 50000, approverRole: 'manager', isActive: true, ...over,
});

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
export const refusal = (status: number, message: string) => json({ success: false, error: { message } }, status);

export interface Served {
  rules: ServedRule[];
  actorRole?: string;
  enforceable?: string[];
  writes?: Partial<Record<'POST' | 'PUT' | 'DELETE', (body: unknown) => Response>>;
}

export function serve(state: Served): { method: string; body: unknown }[] {
  const sent: { method: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/accounting/approval-rules') && method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : { query: path };
      sent.push({ method, body });
      return state.writes?.[method as 'POST']?.(body) ?? json({ success: true, data: {} });
    }
    if (path.startsWith('/api/accounting/approval-rules')) {
      return json({ success: true, data: { items: state.rules, ...(state.actorRole ? { actorRole: state.actorRole } : {}) } });
    }
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      const enforceable = state.enforceable ?? ['supplier_invoice'];
      return json({ success: true, data: {
        items: [], enforceable, legacyCreditNoteRules: 0, legacyPaymentRules: 0, legacyJournalRules: 0,
        preview: Object.fromEntries(enforceable.map((t) => [t, 0])),
      } });
    }
    return json({ success: true, data: { items: [] } });
  });
  return sent;
}
