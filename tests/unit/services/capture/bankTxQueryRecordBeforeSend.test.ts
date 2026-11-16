/**
 * WP7: createAndSendQuery records the query BEFORE the message goes out, as 'unconfirmed'. Transport mocked: nothing
 * is ever sent. The send results are the REAL shapes sendWhatsAppMessage returns (it never throws for a provider error).
 *  - the INSERT precedes the send (an insert that fails sends nothing);
 *  - a DEFINITE refusal ({ sent: false } without ambiguous) deletes the row;
 *  - an AMBIGUOUS failure ({ sent: false, ambiguous: true }) or a throw keeps the row 'unconfirmed' and reports it;
 *  - a confirmed send promotes the row to 'sent' with its sid, in a savepoint of its own; the default number is in
 *    another, so neither can lose the other or throw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const sqlMock = vi.fn();
const send = vi.fn();
const savepoint = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a), withSavepoint: (...a: unknown[]) => savepoint(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({ sendWhatsAppMessage: (...a: unknown[]) => send(...a) }));

import { createAndSendQuery } from '@/modules/accounting/services/capture/bankTxQueryService';

const TX = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const input = { bankTransactionId: TX, toNumber: '+27821234567', message: 'Hi', userId: null };
const text = (c: unknown[]) => (c[0] as string[]).join('?');
const statements = (kind: string) => sqlMock.mock.calls.filter((c) => text(c).includes(kind));

beforeEach(() => {
  order.length = 0;
  sqlMock.mockReset().mockImplementation(async (strings: string[]) => {
    const t = strings.join('?');
    if (t.includes('FROM bank_transactions')) { order.push('select'); return [{ id: TX, transaction_date: '2026-01-01', description: 'd', amount: 1, reference: null, company_name: 'Co' }]; }
    if (t.includes('INSERT INTO bank_tx_queries')) { order.push('insert'); return [{ id: 'q1', status: 'unconfirmed' }]; }
    if (t.includes("SET status = 'sent'")) { order.push('confirm'); return [{ id: 'q1', status: 'sent', message_sid: 'SM1' }]; }
    if (t.includes('DELETE FROM bank_tx_queries')) { order.push('delete'); return []; }
    return [];
  });
  send.mockReset().mockImplementation(async () => { order.push('send'); return { sent: true, sid: 'SM1' }; });
  savepoint.mockReset().mockImplementation(async (name: string, fn: () => Promise<unknown>) => { order.push(`savepoint:${name}`); return fn(); });
});

describe('createAndSendQuery', () => {
  it('records the row first (unconfirmed), then sends, then confirms it with the sid', async () => {
    const r = await createAndSendQuery('co', input);
    expect(r.ok).toBe(true);
    expect(order).toEqual(['select', 'insert', 'send', 'savepoint:bank_tx_query_confirm', 'confirm']);
    expect(text(statements('INSERT INTO bank_tx_queries')[0]!)).toMatch(/'unconfirmed'/);
    const confirm = statements("SET status = 'sent'")[0]!;
    expect(confirm.slice(1)).toContain('SM1');
    expect(confirm.slice(1)).toContain('q1');
  });

  it("a confirmed send's result is the row AFTER the confirm: status 'sent' with the sid, not the stale 'unconfirmed' insert", async () => {
    const r = await createAndSendQuery('co', input);
    expect(r).toMatchObject({ ok: true, query: { id: 'q1', status: 'sent', message_sid: 'SM1' } });
    expect(text(statements("SET status = 'sent'")[0]!)).toMatch(/RETURNING \*/);
  });

  it('when the confirm returns no row the result is still merged to sent + sid', async () => {
    sqlMock.mockImplementation(async (strings: string[]) => {
      const t = strings.join('?');
      if (t.includes('FROM bank_transactions')) return [{ id: TX, company_name: 'Co', transaction_date: '2026-01-01', description: '', amount: 1 }];
      if (t.includes('INSERT INTO bank_tx_queries')) return [{ id: 'q1', status: 'unconfirmed' }];
      return [];
    });
    const r = await createAndSendQuery('co', input);
    expect(r).toMatchObject({ ok: true, query: { status: 'sent', message_sid: 'SM1' } });
  });

  it('an insert that fails sends nothing', async () => {
    sqlMock.mockImplementation(async (strings: string[]) => {
      const t = strings.join('?');
      if (t.includes('FROM bank_transactions')) return [{ id: TX, company_name: 'Co', transaction_date: '2026-01-01', description: '', amount: 1 }];
      if (t.includes('INSERT INTO bank_tx_queries')) throw new Error('db down');
      return [];
    });
    await expect(createAndSendQuery('co', input)).rejects.toThrow('db down');
    expect(send).not.toHaveBeenCalled();
  });

  it('a DEFINITE refusal (Twilio not configured / a 4xx validation error) deletes the row, scoped to the company', async () => {
    send.mockResolvedValue({ sent: false, reason: 'twilio not configured' });
    const r = await createAndSendQuery('co', input);
    expect(r).toEqual({ ok: false, reason: 'twilio not configured' });
    expect(order).toEqual(['select', 'insert', 'delete']);
    const del = statements('DELETE FROM bank_tx_queries')[0]!;
    expect(text(del)).toMatch(/company_id = \?::uuid/);
    expect(del.slice(1)).toContain('q1');
  });

  it.each([
    ['a timeout', { sent: false, reason: 'timeout of 10000ms exceeded', ambiguous: true }],
    ['a connection reset', { sent: false, reason: 'read ECONNRESET', ambiguous: true }],
    ['a 5xx from the provider', { sent: false, reason: 'Service Unavailable', ambiguous: true }],
  ])('%s keeps the row UNCONFIRMED (the message may have gone out) and says so', async (_n, result) => {
    send.mockResolvedValue(result);
    const r = await createAndSendQuery('co', input);
    expect(r).toMatchObject({ ok: false, unconfirmed: true });
    expect((r as { reason: string }).reason).toMatch(/could not be confirmed/);
    expect(order).not.toContain('delete');
    expect(statements("SET status = 'sent'")).toHaveLength(0); // never promoted to 'sent'
  });

  it('a send that THROWS also keeps the row unconfirmed', async () => {
    send.mockRejectedValue(new Error('socket hang up'));
    const r = await createAndSendQuery('co', input);
    expect(r).toMatchObject({ ok: false, unconfirmed: true });
    expect(order).not.toContain('delete');
  });

  it('a failure confirming the sid is logged, not thrown: the row stays (unconfirmed) and the default number is still saved', async () => {
    savepoint.mockImplementation(async (name: string, fn: () => Promise<unknown>) => {
      order.push(`savepoint:${name}`);
      if (name === 'bank_tx_query_confirm') throw new Error('update failed');
      return fn();
    });
    const r = await createAndSendQuery('co', { ...input, saveAsDefault: true });
    expect(r.ok).toBe(true);
    expect(order).not.toContain('delete');
    expect(order).toContain('savepoint:bank_tx_query_default_number'); // a separate savepoint: the sid failing did not skip it
    expect(statements('UPDATE companies SET client_query_whatsapp')).toHaveLength(1);
  });

  it('a failure saving the default number never loses the sid', async () => {
    savepoint.mockImplementation(async (name: string, fn: () => Promise<unknown>) => {
      if (name === 'bank_tx_query_default_number') throw new Error('companies locked');
      return fn();
    });
    const r = await createAndSendQuery('co', { ...input, saveAsDefault: true });
    expect(r.ok).toBe(true);
    expect(statements("SET status = 'sent'")).toHaveLength(1);
  });

  it('a bad number is refused before anything is read or sent', async () => {
    const r = await createAndSendQuery('co', { ...input, toNumber: 'abc' });
    expect(r.ok).toBe(false);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
