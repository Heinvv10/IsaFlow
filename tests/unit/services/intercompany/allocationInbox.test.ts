/**
 * Intercompany P4-C: the receiver's allocation inbox service (read only). One row becomes one item: the payload's facts (display text only),
 * the receiver's OWN issuer invoice (looked up under the session company), the definer's liveness answer (one call per item, each in its own
 * savepoint; a failure is `check_failed`, never a throw) and a derived, unstored mismatch. A malformed payload lists with its blocker and no figure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  inSavepoint: false,
  calls: [] as Array<{ text: string; values: unknown[]; inSavepoint: boolean }>,
  answer: (_text: string, _values: unknown[]): unknown[] | Promise<unknown[]> => [],
  savepoint: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    m.calls.push({ text, values, inSavepoint: m.inSavepoint });
    return m.answer(text, values);
  }),
  withSavepoint: m.savepoint,
}));
vi.mock('@/lib/logger', () => ({ log: m.log }));
// P4-D's clearing reads (their own unit / integration tests): here only what the inbox asks of them
const clear = vi.hoisted(() => ({ preview: vi.fn(), clearings: vi.fn() }));
vi.mock('@/modules/accounting/services/intercompany/allocationClearPreview', () => ({ clearingPreview: clear.preview, clearingsOf: clear.clearings }));
// the dark flag on (its off answer: allocationInboxFlag.test.ts)
vi.mock('@/modules/accounting/services/intercompany/loanClearingGate', () => ({ loanClearingEnabled: async () => true }));

import { allocationMismatch, listAllocationInbox, loadAllocationDetail } from '@/modules/accounting/services/intercompany/allocationInbox';
import type { AllocationPayload } from '@/modules/accounting/services/intercompany/mirrorPayload';

const CO = 'c0000000-0000-4000-8000-000000000001';
const SENDER = 'c0000000-0000-4000-8000-000000000002';
const INV = 'e0000000-0000-4000-8000-000000000001';
const uid = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;

const payload = (over: Record<string, unknown> = {}) => ({
  version: 1, kind: 'allocation', allocationId: uid(1), amount: 1150, currency: 'ZAR',
  payment: { id: uid(2), number: 'SP-1', reference: 'Ref 1', date: '2026-09-01', method: 'eft', cashLegIsLoanAccount: true },
  payerDocument: { type: 'supplier_invoice', id: uid(3), number: 'BILL-1' },
  issuerDocument: { type: 'customer_invoice', id: INV }, linkId: uid(4), linkOrigin: 'mirror', ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'pending', connection_id: uid(5), from_company_id: SENDER, payload: payload(), reason: null, error: null, handled_at: null,
  created_at: new Date('2026-11-23T08:00:00Z'), cutover: '2026-01-01', sender_name: 'Blitz Fibre (customer)', ...over,
});
const invoice = { id: INV, invoice_number: 'INV-9', open: 1150, status: 'approved', currency: 'ZAR', date: '2026-09-01' };

interface World { rows: unknown[]; invoices: unknown[]; live: (id: string) => unknown[] | Promise<unknown[]>; count: number; total?: number }
let world: World;
const serve = (w: Partial<World> = {}) => {
  world = { rows: [row('m-1')], invoices: [invoice], live: () => [{ live: true, reason: 'ok' }], count: 1, ...w };
  m.answer = (text, values) => {
    if (text.includes('intercompany_allocation_message_live')) return world.live(String(values[0]));
    if (text.includes('FROM customer_invoices')) return world.invoices;
    if (text.includes('AS open_count')) return [{ total: world.total ?? world.rows.length, open_count: world.count }];
    if (text.includes("set_config('lock_timeout'")) return [{ prev: '0' }];
    if (text.includes('FROM intercompany_messages m')) return world.rows;
    return [];
  };
};
const callsTo = (needle: string) => m.calls.filter((c) => c.text.includes(needle));

beforeEach(() => {
  vi.clearAllMocks();
  m.calls = [];
  m.inSavepoint = false;
  m.savepoint.mockImplementation(async (_name: string, fn: () => Promise<unknown>) => {
    m.inSavepoint = true;
    try { return await fn(); } finally { m.inSavepoint = false; }
  });
  serve();
  clear.preview.mockResolvedValue({ loanAccountId: 'loan-1' });
  clear.clearings.mockResolvedValue(new Map());
});

describe('listAllocationInbox', () => {
  it('maps a row: payload facts, the receiver\'s own invoice, live, no mismatch, and the open count', async () => {
    const page = await listAllocationInbox(CO, 'open', 25, 0);
    expect(page).toMatchObject({ total: 1, allocationCount: 1 });
    expect(page.items[0]).toEqual({
      id: 'm-1', status: 'pending', connectionId: uid(5), senderName: 'Blitz Fibre (customer)',
      paymentNumber: 'SP-1', paymentDate: '2026-09-01', paymentMethod: 'eft', paymentReference: 'Ref 1',
      amount: 1150, currency: 'ZAR', payerDocumentNumber: 'BILL-1', cashLegIsLoanAccount: true,
      issuerInvoice: { id: INV, number: 'INV-9', openAmount: 1150, status: 'approved', currency: 'ZAR', date: '2026-09-01' },
      live: true, liveReason: 'ok', mismatch: null, blocker: null, reason: null, error: null, handledAt: null, createdAt: '2026-11-23T08:00:00.000Z',
      clearedBy: null,
    });
  });

  it("P4-D: an accepted message carries its clearing receipt (asked by its target, this company's only); any other carries none", async () => {
    const P = 'f0000000-0000-4000-8000-000000000001';
    const cleared = { paymentId: P, paymentNumber: 'CP-1', journalEntryId: 'je-1', voided: true };
    clear.clearings.mockResolvedValue(new Map([['m-1', cleared]]));
    serve({ rows: [row('m-1', { status: 'accepted', target_doc_type: 'customer_payment', target_doc_id: P.toUpperCase() }), row('m-2', { status: 'rejected' })], count: 0 });
    const page = await listAllocationInbox(CO, 'handled', 25, 0);
    expect(clear.clearings).toHaveBeenCalledWith(CO, new Map([['m-1', P.toUpperCase()]]));   // by message (the definer judges its receipt)
    expect(page.items.map((i) => i.clearedBy)).toEqual([cleared, null]);
  });

  it('a page is capped at 100 and an offset is never negative', async () => {
    await listAllocationInbox(CO, 'handled', 5000, -3);
    const list = callsTo('FROM intercompany_messages m')[0]!;
    expect(list.values).toEqual(expect.arrayContaining([100, 0, ['accepted', 'rejected', 'dismissed', 'withdrawn']]));
  });

  it('the total comes from its own count, so a page past the end still says how many there are', async () => {
    serve({ rows: [], total: 7, count: 3 });
    expect(await listAllocationInbox(CO, 'open', 25, 50)).toEqual({ items: [], total: 7, allocationCount: 3, loanClearingEnabled: true });
  });

  it('a handled row is not_pending without asking the database; only the open rows are checked', async () => {
    serve({ rows: [row('m-1', { status: 'rejected', reason: 'no' }), row('m-2'), row('m-3', { status: 'dismissed' }), row('m-4', { status: 'failed' })] });
    const items = (await listAllocationInbox(CO, 'handled', 25, 0)).items;
    expect(items.map((i) => [i.id, i.live, i.liveReason])).toEqual([['m-1', false, 'not_pending'], ['m-2', true, 'ok'], ['m-3', false, 'not_pending'], ['m-4', true, 'ok']]);
    expect(callsTo('intercompany_allocation_message_live').map((c) => c.values[0])).toEqual(['m-2', 'm-4']);
  });

  it('the page\'s lock wait is bounded once (tighten-only, 2 s) around the checks and put back after them, outside every savepoint', async () => {
    serve({ rows: [row('m-1'), row('m-2')] });
    await listAllocationInbox(CO, 'open', 25, 0);
    const order = m.calls.map((c) => (c.text.includes("set_config('lock_timeout'") ? `lock:${c.inSavepoint}` : c.text.includes('message_live') ? 'live' : null)).filter(Boolean);
    expect(order).toEqual(['lock:false', 'live', 'live', 'lock:false']);
    const [tighten, restore] = callsTo("set_config('lock_timeout'");
    expect(tighten!.text).toMatch(/2s/);
    expect(restore!.values).toContain('0');                                  // the value it found
  });

  it('no open row: no lock bound and no definer call', async () => {
    serve({ rows: [row('m-1', { status: 'accepted' })] });
    await listAllocationInbox(CO, 'handled', 25, 0);
    expect(callsTo("set_config('lock_timeout'")).toHaveLength(0);
    expect(callsTo('intercompany_allocation_message_live')).toHaveLength(0);
  });

  it('one definer call per item, each inside its own savepoint', async () => {
    serve({ rows: [row('m-1'), row('m-2'), row('m-3')] });
    await listAllocationInbox(CO, 'open', 25, 0);
    const live = callsTo('intercompany_allocation_message_live');
    expect(live.map((c) => c.values[0])).toEqual(['m-1', 'm-2', 'm-3']);
    expect(live.every((c) => c.inSavepoint)).toBe(true);
    expect(m.savepoint).toHaveBeenCalledTimes(3);
  });

  it('a failed check is check_failed (logged by SQLSTATE only, never thrown), and the rest of the page is check_failed WITHOUT another call (one wait per page)', async () => {
    serve({
      rows: [row('m-1'), row('m-2'), row('m-3', { status: 'rejected' })],
      live: (id) => (id === 'm-1' ? Promise.reject(Object.assign(new Error('lock on "payment_allocations" names ids'), { code: '55P03' })) : [{ live: true, reason: 'ok' }]),
    });
    const page = await listAllocationInbox(CO, 'open', 25, 0);
    expect(page.items.map((i) => [i.id, i.live, i.liveReason])).toEqual([['m-1', false, 'check_failed'], ['m-2', false, 'check_failed'], ['m-3', false, 'not_pending']]);
    expect(callsTo('intercompany_allocation_message_live').map((c) => c.values[0])).toEqual(['m-1']);
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/allocation/i), { companyId: CO, messageId: 'm-1', code: '55P03' }, 'intercompany');
    expect(JSON.stringify(m.log.warn.mock.calls)).not.toMatch(/names ids/);
  });

  it('the lock setting is put back after a FAILING call too (outside every savepoint)', async () => {
    serve({ rows: [row('m-1'), row('m-2')], live: () => Promise.reject(Object.assign(new Error('x'), { code: '57014' })) });
    await listAllocationInbox(CO, 'open', 25, 0);
    const order = m.calls.map((c) => (c.text.includes("set_config('lock_timeout'") ? `lock:${c.inSavepoint}` : c.text.includes('message_live') ? 'live' : null)).filter(Boolean);
    expect(order).toEqual(['lock:false', 'live', 'lock:false']);
    expect(callsTo("set_config('lock_timeout'")[1]!.values).toContain('0');
  });

  it.each(['55P03', '57014'])('a %s (a lock wait or a timeout) stops the page', async (code) => {
    serve({ rows: [row('m-1'), row('m-2')], live: (id) => (id === 'm-1' ? Promise.reject(Object.assign(new Error('x'), { code })) : [{ live: true, reason: 'ok' }]) });
    const items = (await listAllocationInbox(CO, 'open', 25, 0)).items;
    expect(items.map((i) => i.liveReason)).toEqual(['check_failed', 'check_failed']);
    expect(callsTo('intercompany_allocation_message_live')).toHaveLength(1);
  });

  it.each(['42501', '22P02', null])('any other failure (%s) marks only its row check_failed and the next row is still asked', async (code) => {
    serve({ rows: [row('m-1'), row('m-2')], live: (id) => (id === 'm-1' ? Promise.reject(Object.assign(new Error('x'), code ? { code } : {})) : [{ live: true, reason: 'ok' }]) });
    const items = (await listAllocationInbox(CO, 'open', 25, 0)).items;
    expect(items.map((i) => i.liveReason)).toEqual(['check_failed', 'ok']);
    expect(callsTo('intercompany_allocation_message_live')).toHaveLength(2);
  });

  it('an unreadable answer (no exception) is check_failed for that row only: the next row is still asked', async () => {
    serve({ rows: [row('m-1'), row('m-2')], live: (id) => (id === 'm-1' ? [] : [{ live: true, reason: 'ok' }]) });
    const items = (await listAllocationInbox(CO, 'open', 25, 0)).items;
    expect(items.map((i) => i.liveReason)).toEqual(['check_failed', 'ok']);
  });

  it.each<[string, unknown[]]>([
    ['no row', []],
    ['an unknown reason', [{ live: true, reason: 'maybe' }]],
    ['live but a reason other than ok', [{ live: true, reason: 'changed' }]],
  ])('a definer answer of %s is check_failed', async (_n, answer) => {
    serve({ live: () => answer });
    expect((await listAllocationInbox(CO, 'open', 25, 0)).items[0]).toMatchObject({ live: false, liveReason: 'check_failed' });
  });

  it('a stale answer is passed through', async () => {
    serve({ live: () => [{ live: false, reason: 'journal_reversed' }] });
    expect((await listAllocationInbox(CO, 'open', 25, 0)).items[0]).toMatchObject({ live: false, liveReason: 'journal_reversed' });
  });

  it('a malformed payload lists with its blocker and never a figure; no invoice is looked up for it', async () => {
    serve({ rows: [row('m-1', { payload: payload({ amount: '1150', issuerDocument: { type: 'customer_invoice', id: INV } }) })] });
    const item = (await listAllocationInbox(CO, 'open', 25, 0)).items[0]!;
    expect(item.blocker).toEqual(expect.any(String));
    expect(item).toMatchObject({ amount: null, currency: null, issuerInvoice: null, mismatch: null, paymentNumber: null, cashLegIsLoanAccount: null });
    expect(callsTo('FROM customer_invoices')).toHaveLength(0);
  });

  it('an invoice the lookup does not return is null and invoice_gone; a sender with no customer linked is "Another company"', async () => {
    serve({ invoices: [], rows: [row('m-1', { sender_name: null })] });
    expect((await listAllocationInbox(CO, 'open', 25, 0)).items[0]).toMatchObject({ issuerInvoice: null, mismatch: 'invoice_gone', senderName: 'Another company' });
  });

  it('nothing to list makes no definer call and no invoice lookup', async () => {
    serve({ rows: [], count: 0 });
    expect(await listAllocationInbox(CO, 'open', 25, 0)).toEqual({ items: [], total: 0, allocationCount: 0, loanClearingEnabled: true });
    expect(callsTo('intercompany_allocation_message_live')).toHaveLength(0);
    expect(callsTo('FROM customer_invoices')).toHaveLength(0);
  });
});

describe('the invoice\'s open amount follows the shared AR open statuses', () => {
  it.each(['approved', 'sent', 'partially_paid', 'overdue'])('a %s invoice is open: its open amount shows and nothing is a mismatch', async (status) => {
    serve({ invoices: [{ ...invoice, status, open: 1150 }] });
    expect((await listAllocationInbox(CO, 'open', 25, 0)).items[0]).toMatchObject({ issuerInvoice: { status, openAmount: 1150 }, mismatch: null });
  });

  it.each(['draft', 'pending_approval', 'paid'])('a %s invoice is not open: no open amount, invoice_not_open', async (status) => {
    serve({ invoices: [{ ...invoice, status, open: 1150 }] });
    expect((await listAllocationInbox(CO, 'open', 25, 0)).items[0]).toMatchObject({ issuerInvoice: { status, openAmount: null }, mismatch: 'invoice_not_open' });
  });
});

describe('loadAllocationDetail', () => {
  it('the item and the payload facts', async () => {
    const d = await loadAllocationDetail(CO, 'm-1');
    expect(d).toMatchObject({ item: { id: 'm-1', liveReason: 'ok' }, allocationId: uid(1), linkId: uid(4), linkOrigin: 'mirror', cutoverDate: '2026-01-01', preview: { loanAccountId: 'loan-1' } });
    expect(clear.preview).toHaveBeenCalledWith(CO, uid(5), expect.objectContaining({ amount: 1150 }), expect.objectContaining({ id: INV }));
    expect(callsTo('FROM intercompany_messages m')[0]!.values).toEqual(expect.arrayContaining(['m-1', CO]));
  });

  it('P4-D: a handled message has no Accept preview (the clearing reads are not asked)', async () => {
    serve({ rows: [row('m-1', { status: 'rejected' })] });
    expect((await loadAllocationDetail(CO, 'm-1')).preview).toBeNull();
    expect(clear.preview).not.toHaveBeenCalled();
  });

  it('a message that is not this company\'s allocation is a 404 refusal', async () => {
    serve({ rows: [] });
    await expect(loadAllocationDetail(CO, 'm-x')).rejects.toMatchObject({ status: 404 });
  });
});

describe('allocationMismatch (derived, never stored)', () => {
  const p = (over: Partial<AllocationPayload> = {}): AllocationPayload => ({ ...(payload() as unknown as AllocationPayload), ...over });
  const inv = (over: Record<string, unknown> = {}) => ({ id: INV, number: 'INV-9', openAmount: 1150 as number | null, status: 'approved', currency: 'ZAR', date: '2026-09-01', ...over });
  it.each<[string, AllocationPayload | null, ReturnType<typeof inv> | null, string | null, string | null]>([
    ['all in order', p(), inv(), '2026-01-01', null],
    ['the amount equal to the open amount', p({ amount: 1150 }), inv({ openAmount: 1150 }), '2026-01-01', null],
    ['the amount above the open amount by a cent', p({ amount: 1150.01 }), inv(), '2026-01-01', 'amount_exceeds_open'],
    ['a foreign-currency allocation', p({ currency: 'USD' }), inv({ currency: 'USD' }), '2026-01-01', 'currency'],
    ['a ZAR allocation against a foreign invoice', p(), inv({ currency: 'EUR' }), '2026-01-01', 'currency'],
    ['no invoice', p(), null, '2026-01-01', 'invoice_gone'],
    ['a cancelled invoice', p(), inv({ status: 'cancelled' }), '2026-01-01', 'invoice_gone'],
    ['an invoice dated before the cut-over', p(), inv({ date: '2025-12-31' }), '2026-01-01', 'pre_cutover_invoice'],
    ['a payment dated before the cut-over', p({ payment: { ...p().payment, date: '2025-12-31' } }), inv(), '2026-01-01', 'pre_cutover_payment'],
    ['a payment dated ON the cut-over', p({ payment: { ...p().payment, date: '2026-01-01' } }), inv(), '2026-01-01', null],
    ['a draft invoice', p(), inv({ status: 'draft', openAmount: null }), '2026-01-01', 'invoice_not_open'],
    ['an invoice awaiting approval', p(), inv({ status: 'pending_approval', openAmount: null }), '2026-01-01', 'invoice_not_open'],
    ['a paid invoice', p(), inv({ status: 'paid', openAmount: null }), '2026-01-01', 'invoice_not_open'],
    ['not open wins over the currency', p({ currency: 'USD' }), inv({ status: 'draft', openAmount: null }), '2026-01-01', 'invoice_not_open'],
    ['a pre-cut-over payment wins over a pre-cut-over invoice', p({ payment: { ...p().payment, date: '2025-12-31' } }), inv({ date: '2025-01-01' }), '2026-01-01', 'pre_cutover_payment'],
    ['an invoice dated ON the cut-over', p(), inv({ date: '2026-01-01' }), '2026-01-01', null],
    ['no cut-over known', p(), inv({ date: '2025-12-31' }), null, null],
    ['an unreadable payload', null, inv(), '2026-01-01', null],
    ['gone wins over everything', p({ currency: 'USD', amount: 9999 }), null, '2026-01-01', 'invoice_gone'],
    ['currency wins over pre-cut-over and the amount', p({ currency: 'USD', amount: 9999, payment: { ...p().payment, date: '2025-12-31' } }), inv({ date: '2025-01-01' }), '2026-01-01', 'currency'],
    ['pre-cut-over wins over the amount', p({ amount: 9999 }), inv({ date: '2025-01-01' }), '2026-01-01', 'pre_cutover_invoice'],
  ])('%s', (_n, payloadIn, invoiceIn, cutover, expected) => {
    expect(allocationMismatch(payloadIn, invoiceIn, cutover)).toBe(expected);
  });
});
