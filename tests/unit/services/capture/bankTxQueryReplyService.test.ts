import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import {
  findOpenQuery,
  attachReplyMedia,
  markQueryReplied,
} from '@/modules/accounting/services/capture/bankTxQueryReplyService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const QUERY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function routeMock(routes: Array<{ match: string; rows: unknown[] }>) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('findOpenQuery', () => {
  it('matches by company + normalized number, preferring sent, newest first', async () => {
    routeMock([{ match: 'FROM bank_tx_queries', rows: [{ id: QUERY_ID, bank_transaction_id: TX_ID, status: 'sent' }] }]);
    const q = await findOpenQuery(COMPANY_ID, '+27821234567');
    expect(q).toEqual({ id: QUERY_ID, bankTransactionId: TX_ID, status: 'sent' });
    const call = sqlCalls[0]!;
    expect(call.values).toContain(COMPANY_ID);
    expect(call.values).toContain('+27821234567');
    expect(call.sql).toMatch(/status IN \('sent',\s*'replied'\)/);
    expect(call.sql).toContain('ORDER BY');
  });

  it('returns null when nothing is open', async () => {
    routeMock([{ match: 'FROM bank_tx_queries', rows: [] }]);
    expect(await findOpenQuery(COMPANY_ID, '+27000000000')).toBeNull();
  });

  it('returns null for an unnormalizable number without querying', async () => {
    expect(await findOpenQuery(COMPANY_ID, 'garbage')).toBeNull();
    expect(sqlCalls.length).toBe(0);
  });
});

describe('attachReplyMedia', () => {
  const query = { id: QUERY_ID, bankTransactionId: TX_ID, status: 'sent' as const };

  it('inserts a data-URL attachment for the queried bank tx', async () => {
    routeMock([
      { match: 'SELECT id FROM bank_transactions', rows: [{ id: TX_ID }] },
      { match: 'SELECT id FROM bank_transaction_attachments', rows: [] },
      { match: 'INSERT INTO bank_transaction_attachments', rows: [{ id: 'x' }] },
    ]);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: Buffer.from('fakeimg'),
      mimeType: 'image/jpeg',
      fileName: 'whatsapp_SM123_0.jpeg',
    });
    expect(ok).toBe(true);
    const ins = sqlCalls.find((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))!;
    expect(ins.values).toContain(TX_ID);
    const dataUrl = ins.values.find((v) => typeof v === 'string' && v.startsWith('data:image/jpeg;base64,'));
    expect(dataUrl).toBeDefined();
  });

  it('skips media over 2MB without inserting', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: big, mimeType: 'image/jpeg', fileName: 'big.jpeg',
    });
    expect(ok).toBe(false);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });

  it('attaches exactly-2MB buffer (boundary — should succeed)', async () => {
    routeMock([
      { match: 'SELECT id FROM bank_transactions', rows: [{ id: TX_ID }] },
      { match: 'SELECT id FROM bank_transaction_attachments', rows: [] },
      { match: 'INSERT INTO bank_transaction_attachments', rows: [{ id: 'x' }] },
    ]);
    const exactly2mb = Buffer.alloc(2 * 1024 * 1024);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: exactly2mb, mimeType: 'image/jpeg', fileName: 'whatsapp_SM_boundary_0.jpeg',
    });
    expect(ok).toBe(true);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(true);
  });

  it('returns false and skips INSERT when bank tx does not belong to company', async () => {
    routeMock([
      { match: 'SELECT id FROM bank_transactions', rows: [] }, // ownership check fails
    ]);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: Buffer.from('fakeimg'),
      mimeType: 'image/jpeg',
      fileName: 'whatsapp_SM123_0.jpeg',
    });
    expect(ok).toBe(false);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });

  it('returns false for mimeType with parameters (image/jpeg; charset=utf-8)', async () => {
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: Buffer.from('fakeimg'),
      mimeType: 'image/jpeg; charset=utf-8',
      fileName: 'whatsapp_SM123_0.jpeg',
    });
    expect(ok).toBe(false);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });

  it('returns false for disallowed mimeType (text/html)', async () => {
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: Buffer.from('<html>'),
      mimeType: 'text/html',
      fileName: 'evil.html',
    });
    expect(ok).toBe(false);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });

  it('returns true (no INSERT) when attachment already exists — webhook retry dedupe', async () => {
    routeMock([
      { match: 'SELECT id FROM bank_transactions', rows: [{ id: TX_ID }] },
      { match: 'SELECT id FROM bank_transaction_attachments', rows: [{ id: 'existing-attach' }] },
    ]);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: Buffer.from('fakeimg'),
      mimeType: 'image/jpeg',
      fileName: 'whatsapp_SM123_0.jpeg',
    });
    expect(ok).toBe(true);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });
});

describe('markQueryReplied', () => {
  it('flips to replied, appends text, keeps the first capture event', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [{ id: QUERY_ID }] }]);
    await markQueryReplied(COMPANY_ID, QUERY_ID, 'it was the printer repair', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toContain("status = 'replied'");
    expect(upd.sql).toContain('COALESCE');
    expect(upd.values).toContain(COMPANY_ID);
    expect(upd.values).toContain('it was the printer repair');
  });

  it('does not touch resolved or cancelled queries', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [] }]);
    await markQueryReplied(COMPANY_ID, QUERY_ID, 'late reply', null);
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toMatch(/status IN \('sent',\s*'replied'\)/);
  });

  it('caps reply_text growth with LEFT(..., 10000)', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [{ id: QUERY_ID }] }]);
    await markQueryReplied(COMPANY_ID, QUERY_ID, 'some reply', null);
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toContain('LEFT(');
  });
});
