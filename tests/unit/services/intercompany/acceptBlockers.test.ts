/** Intercompany P2: everything that stops an inbox message being accepted, as sentences (pure). */
import { describe, expect, it } from 'vitest';
import { acceptBlockers } from '@/modules/accounting/services/intercompany/acceptBlockers';
import type { AcceptSide } from '@/modules/accounting/services/intercompany/acceptContext';
import type { MirrorPayload } from '@/modules/accounting/services/intercompany/mirrorPayload';

const side = (over: Partial<AcceptSide> = {}): AcceptSide => ({
  connectionId: 'c', kind: 'group', status: 'active', companyLowId: 'l', companyHighId: 'h', supplierId: 's', supplierName: 'Supplier',
  defaultExpenseAccountId: null, defaultCc1Id: null, defaultCc2Id: null, defaultBuId: null, autoAccept: false, ...over,
});
const item = (over: Partial<{ status: 'pending' | 'accepted' | 'rejected' | 'dismissed' | 'failed'; blocker: string | null }> = {}) =>
  ({ status: 'pending' as const, blocker: null, kind: 'invoice' as const, ...over });
const payload = { kind: 'invoice' } as MirrorPayload;

describe('acceptBlockers', () => {
  it('nothing stops a pending message on an active connection with a supplier', () => {
    expect(acceptBlockers(item(), payload, side(), null)).toEqual([]);
  });
  it('a failed message can be retried', () => {
    expect(acceptBlockers(item({ status: 'failed' }), payload, side(), null)).toEqual([]);
  });
  it.each([['accepted', /already accepted/], ['rejected', /already rejected/], ['dismissed', /Restore it first/]] as const)('a %s message', (status, re) => {
    expect(acceptBlockers(item({ status }), payload, side(), null).join(' ')).toMatch(re);
  });
  it('carries the payload\'s own blocker (foreign currency, unreadable)', () => {
    expect(acceptBlockers(item({ blocker: 'ZAR only' }), payload, side(), null)).toContain('ZAR only');
  });
  it('no side, an inactive connection, no supplier, and a duplicate each say so', () => {
    expect(acceptBlockers(item(), payload, null, null).join(' ')).toMatch(/no setup/);
    expect(acceptBlockers(item(), payload, side({ status: 'revoked' }), null).join(' ')).toMatch(/not active/);
    expect(acceptBlockers(item(), payload, side({ supplierId: null }), null).join(' ')).toMatch(/Link the supplier/);
    expect(acceptBlockers(item(), payload, side(), { number: 'INV-9' }).join(' ')).toMatch(/A bill numbered INV-9 already exists/);
    expect(acceptBlockers(item(), { kind: 'credit_note' } as MirrorPayload, side(), { number: 'CN-9' }).join(' ')).toMatch(/A credit note numbered CN-9/);
  });
  it('automatic acceptance needs the side\'s flag', () => {
    expect(acceptBlockers(item(), payload, side({ autoAccept: false }), null, true).join(' ')).toMatch(/Automatic acceptance is off/);
    expect(acceptBlockers(item(), payload, side({ autoAccept: true }), null, true)).toEqual([]);
  });
});
