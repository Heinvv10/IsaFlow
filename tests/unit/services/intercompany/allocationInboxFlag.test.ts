/**
 * Intercompany, the dark flag `intercompany_loan_clearing` on the receiver's allocation inbox (read only): the list and the detail carry
 * `loanClearingEnabled` for the SESSION company (one flag read per request), and with it off the detail carries no Accept preview (the
 * clearing reads are not asked). The list itself is the same either way: a payment from the group is listed, and can be rejected or dismissed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rows: [] as unknown[], enabled: vi.fn(async (_companyId: string) => false) }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('AS open_count')) return [{ total: m.rows.length, open_count: m.rows.length }];
    if (text.includes("set_config('lock_timeout'")) return [{ prev: '0' }];
    if (text.includes('intercompany_allocation_message_live')) return [{ live: true, reason: 'ok' }];
    if (text.includes('FROM intercompany_messages m')) return m.rows;
    return [];
  }),
  withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const clear = vi.hoisted(() => ({ preview: vi.fn(), clearings: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/allocationClearPreview', () => ({ clearingPreview: clear.preview, clearingsOf: clear.clearings }));
vi.mock('@/modules/accounting/services/intercompany/loanClearingGate', () => ({ loanClearingEnabled: m.enabled }));

import { listAllocationInbox, loadAllocationDetail } from '@/modules/accounting/services/intercompany/allocationInbox';

const CO = 'c0000000-0000-4000-8000-000000000001';
const uid = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
const row = {
  id: 'm-1', status: 'pending', connection_id: uid(5), from_company_id: 'c0000000-0000-4000-8000-000000000002', reason: null, error: null, handled_at: null,
  created_at: new Date('2026-11-23T08:00:00Z'), cutover: '2026-01-01', sender_name: 'Blitz Fibre (customer)',
  payload: {
    version: 1, kind: 'allocation', allocationId: uid(1), amount: 1150, currency: 'ZAR',
    payment: { id: uid(2), number: 'SP-1', reference: 'Ref 1', date: '2026-09-01', method: 'eft', cashLegIsLoanAccount: true },
    payerDocument: { type: 'supplier_invoice', id: uid(3), number: 'BILL-1' },
    issuerDocument: { type: 'customer_invoice', id: 'e0000000-0000-4000-8000-000000000001' }, linkId: uid(4), linkOrigin: 'mirror',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [row];
  m.enabled.mockResolvedValue(false);
  clear.preview.mockResolvedValue({ loanAccountId: 'loan-1' });
  clear.clearings.mockResolvedValue(new Map());
});

describe('loanClearingEnabled on the inbox answers', () => {
  it('off: the list says false for the session company and still lists the payment', async () => {
    const page = await listAllocationInbox(CO, 'open', 25, 0);
    expect(page).toMatchObject({ loanClearingEnabled: false, total: 1, items: [{ id: 'm-1' }] });
    expect(m.enabled.mock.calls).toEqual([[CO]]);
  });

  it('off: the detail says false and carries no Accept preview (the clearing reads are not asked)', async () => {
    const d = await loadAllocationDetail(CO, 'm-1');
    expect(d).toMatchObject({ loanClearingEnabled: false, preview: null, item: { id: 'm-1' } });
    expect(clear.preview).not.toHaveBeenCalled();
    expect(m.enabled.mock.calls).toEqual([[CO]]);
  });

  it('on: both say true and the open detail carries its preview', async () => {
    m.enabled.mockResolvedValue(true);
    expect((await listAllocationInbox(CO, 'open', 25, 0)).loanClearingEnabled).toBe(true);
    expect(await loadAllocationDetail(CO, 'm-1')).toMatchObject({ loanClearingEnabled: true, preview: { loanAccountId: 'loan-1' } });
  });

  it('an empty page still says it (the UI words its header by it)', async () => {
    m.rows = [];
    expect(await listAllocationInbox(CO, 'open', 25, 0)).toEqual({ items: [], total: 0, allocationCount: 0, loanClearingEnabled: false });
  });
});
