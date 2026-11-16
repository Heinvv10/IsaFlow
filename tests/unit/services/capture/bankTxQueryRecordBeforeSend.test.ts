/**
 * WP7: createAndSendQuery records the query BEFORE the message goes out. Transport mocked: nothing is ever sent.
 *  - the INSERT precedes the send (an insert that fails sends nothing);
 *  - a refused send takes the row back out (a 4xx commits the request, so it would otherwise stay);
 *  - a send that throws keeps the row (it may have left) and says so;
 *  - after a good send, a failure saving the sid / default number is logged, never thrown (a throw is a 500 that rolls
 *    the record back).
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

beforeEach(() => {
  order.length = 0;
  sqlMock.mockReset().mockImplementation(async (strings: string[]) => {
    const t = strings.join('?');
    if (t.includes('FROM bank_transactions')) { order.push('select'); return [{ id: TX, transaction_date: '2026-01-01', description: 'd', amount: 1, reference: null, company_name: 'Co' }]; }
    if (t.includes('INSERT INTO bank_tx_queries')) { order.push('insert'); return [{ id: 'q1' }]; }
    if (t.includes('DELETE FROM bank_tx_queries')) { order.push('delete'); return []; }
    return [];
  });
  send.mockReset().mockImplementation(async () => { order.push('send'); return { sent: true, sid: 'SM1' }; });
  savepoint.mockReset().mockImplementation(async (_n: string, fn: () => Promise<unknown>) => { order.push('after-send'); return fn(); });
});

describe('createAndSendQuery', () => {
  it('records the row first, then sends, then saves the sid (a sent message ends with its row kept)', async () => {
    const r = await createAndSendQuery('co', input);
    expect(r.ok).toBe(true);
    expect(order).toEqual(['select', 'insert', 'send', 'after-send']);
    expect(order).not.toContain('delete');
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

  it('a refused send deletes the row it recorded, scoped to the company, and reports the reason', async () => {
    send.mockResolvedValue({ sent: false, reason: 'twilio not configured' });
    const r = await createAndSendQuery('co', input);
    expect(r).toEqual({ ok: false, reason: 'twilio not configured' });
    expect(order).toEqual(['select', 'insert', 'delete']);
    const del = sqlMock.mock.calls.find((c) => text(c).includes('DELETE FROM bank_tx_queries'))!;
    expect(text(del)).toMatch(/company_id = \?::uuid/);
    expect(del.slice(1)).toContain('q1');
  });

  it('a send that throws keeps the row and says the send could not be confirmed', async () => {
    send.mockRejectedValue(new Error('socket hang up'));
    const r = await createAndSendQuery('co', input);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/could not be confirmed/);
    expect(order).not.toContain('delete');
  });

  it('a failure saving the sid after a good send is logged, not thrown: the record stands', async () => {
    savepoint.mockRejectedValue(new Error('update failed'));
    const r = await createAndSendQuery('co', input);
    expect(r.ok).toBe(true);
    expect(order).not.toContain('delete');
  });

  it('saveAsDefault is written after the send, inside the same guarded step', async () => {
    await createAndSendQuery('co', { ...input, saveAsDefault: true });
    expect(sqlMock.mock.calls.some((c) => text(c).includes('UPDATE companies SET client_query_whatsapp'))).toBe(true);
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('after-send'));
  });

  it('a bad number is refused before anything is read or sent', async () => {
    const r = await createAndSendQuery('co', { ...input, toNumber: 'abc' });
    expect(r.ok).toBe(false);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
