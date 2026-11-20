/** Intercompany P3: why a pairing screen offers nothing (in the order the person fixes it), the loan "as at" day, and the sentences for the database's refusals. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userCanWriteCompany: vi.fn() }));

import { blockReason, dayBefore } from '@/modules/accounting/services/intercompany/pairingView';
import { refusalFor } from '@/modules/accounting/services/intercompany/pairingWrite';
import { ConnectionRefusal, type ConnectionView } from '@/modules/accounting/services/intercompany/connectionTypes';
import { connection } from '../../components/intercompanyFixtures';

const ready = (over: Partial<ConnectionView> = {}): ConnectionView => connection({
  settings: { settlementMode: 'cash', cutoverDate: '2026-10-01', interestRatePct: null },
  side: { customerId: 'c', supplierId: 's', loanAccountId: null, defaultExpenseAccountId: null, autoAccept: false, customer: null, supplier: null, loanAccount: null, defaultExpenseAccount: null },
  ...over,
});

describe('blockReason', () => {
  it('is null when the connection is active, the user can write, the cut-over is set and the party is linked', () => {
    expect(blockReason(ready(), 'ar', true)).toBeNull();
    expect(blockReason(ready(), 'ap', true)).toBeNull();
  });

  it('names the first thing to fix: revoked, then no write access, then no cut-over, then no linked party', () => {
    const bare = ready({ status: 'revoked', settings: { settlementMode: 'cash', cutoverDate: null, interestRatePct: null }, side: null });
    expect(blockReason(bare, 'ar', false)).toBe('revoked');
    expect(blockReason({ ...bare, status: 'active' }, 'ar', false)).toBe('no_write_access');
    expect(blockReason({ ...bare, status: 'active' }, 'ar', true)).toBe('no_cutover');
    expect(blockReason({ ...bare, status: 'active', settings: { settlementMode: 'cash', cutoverDate: '2026-10-01', interestRatePct: null } }, 'ar', true)).toBe('no_party');
  });

  it('asks for the customer on the receivable side and the supplier on the payable side', () => {
    const side = { ...ready().side!, customerId: null };
    expect(blockReason(ready({ side }), 'ar', true)).toBe('no_party');
    expect(blockReason(ready({ side }), 'ap', true)).toBeNull();
    const noSupplier = { ...ready().side!, supplierId: null };
    expect(blockReason(ready({ side: noSupplier }), 'ap', true)).toBe('no_party');
  });
});

describe('dayBefore', () => {
  it.each([['2026-10-01', '2026-09-30'], ['2026-03-01', '2026-02-28'], ['2028-03-01', '2028-02-29'], ['2026-01-01', '2025-12-31']])('%s -> %s', (d, e) => {
    expect(dayBefore(d)).toBe(e);
  });
});

describe('refusalFor', () => {
  it.each([
    [{ code: '23514', message: 'a document is in one active or pending link at a time, whatever the connection' }, 409, /already in another pairing/],
    [{ code: '23505', message: 'duplicate key' }, 409, /already in another pairing/],
    [{ code: '23514', message: 'documents are linked only on an active connection' }, 409, /no longer active/],
    [{ code: '23514', message: 'a link is already confirmed on that side' }, 409, /already confirmed/],
    [{ code: '23514', message: "the document is not this company's" }, 409, /no longer in this company/],
    [{ code: '42501', message: 'linking needs a write role in the company' }, 403, /owner, admin or manager/],
  ])('%j is a %i refusal with a plain sentence', (err, status, text) => {
    const r = refusalFor(err);
    expect(r).toBeInstanceOf(ConnectionRefusal);
    expect(r?.status).toBe(status);
    expect(r?.message).toMatch(text);
  });

  it('is null for anything unexpected, so a crash is rethrown rather than dressed as a refusal', () => {
    expect(refusalFor(new Error('boom'))).toBeNull();
    expect(refusalFor({ code: '57014', message: 'canceling statement' })).toBeNull();
    expect(refusalFor({ code: '23514', message: 'something else' })).toBeNull();
  });
});
