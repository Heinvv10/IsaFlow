/** Intercompany P2: the request shapes of the inbox routes are checked before anything reaches SQL (400, never a 500 from a ::UUID cast). */
import { describe, expect, it } from 'vitest';
import { parseAcceptBody, parseInboxQuery, parseRejectBody } from '@/modules/accounting/services/intercompany/inboxValidation';

const A = 'a0000000-0000-4000-8000-00000000000b';

describe('parseInboxQuery', () => {
  it('defaults to the open filter, 25 a page from 0', () => {
    expect(parseInboxQuery({})).toEqual({ ok: true, value: { filter: 'open', limit: 25, offset: 0 } });
  });
  it('caps the page at 100 and reads handled', () => {
    expect(parseInboxQuery({ filter: 'handled', limit: '5000', offset: '30' })).toEqual({ ok: true, value: { filter: 'handled', limit: 100, offset: 30 } });
  });
  it.each([[{ filter: 'all' }], [{ limit: 'x' }], [{ offset: '-1' }], [{ limit: '1e3' }]])('refuses %j', (q) => {
    expect(parseInboxQuery(q)).toMatchObject({ ok: false });
  });
});

describe('parseAcceptBody', () => {
  it('no body, an empty body: nothing chosen', () => {
    expect(parseAcceptBody(undefined)).toEqual({ ok: true, value: {} });
    expect(parseAcceptBody({})).toEqual({ ok: true, value: {} });
  });
  it('takes line accounts and a credit note account, lowercased', () => {
    expect(parseAcceptBody({ lineAccounts: { 0: A.toUpperCase(), 3: A }, accountId: A })).toEqual({ ok: true, value: { lineAccounts: { 0: A, 3: A }, accountId: A } });
  });
  it.each([[{ x: 1 }], ['text'], [[]], [{ accountId: 'no' }], [{ lineAccounts: [] }], [{ lineAccounts: { a: A } }], [{ lineAccounts: { 1000: A } }], [{ lineAccounts: { 0: 'no' } }]])('refuses %j', (b) => {
    expect(parseAcceptBody(b)).toMatchObject({ ok: false });
  });
});

describe('parseRejectBody', () => {
  it('needs a non-blank reason and trims it', () => {
    expect(parseRejectBody({ reason: '  not ours ' })).toEqual({ ok: true, value: { reason: 'not ours' } });
  });
  it.each([[{}], [{ reason: '' }], [{ reason: '  ' }], [{ reason: 3 }], [{ reason: 'x'.repeat(2001) }], [{ reason: 'a', other: 1 }], [null]])('refuses %j', (b) => {
    expect(parseRejectBody(b)).toMatchObject({ ok: false });
  });
});
