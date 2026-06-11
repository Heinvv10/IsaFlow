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

const sendMock = vi.fn(async (_to: string, _body: string): Promise<{ sent: boolean; reason?: string; sid?: string }> => ({ sent: true }));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({
  sendWhatsAppMessage: (to: string, body: string) => sendMock(to, body),
}));

import {
  createAndSendQuery,
  listQueries,
  setQueryStatus,
  getQuerySettings,
  saveQuerySettings,
} from '@/modules/accounting/services/capture/bankTxQueryService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const QUERY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const TX_ROW = {
  id: TX_ID, transaction_date: new Date('2026-05-14T00:00:00Z'),
  description: 'POS PURCHASE MAKRO', amount: '-1234.56', reference: null,
  company_name: 'Acme Trading',
};

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
  sendMock.mockClear();
  sendMock.mockResolvedValue({ sent: true });
});

describe('createAndSendQuery', () => {
  const input = { bankTransactionId: TX_ID, toNumber: '082 123 4567', message: null, saveAsDefault: false, userId: null };

  it('rejects an unnormalizable number without touching the DB', async () => {
    const res = await createAndSendQuery(COMPANY_ID, { ...input, toNumber: 'nonsense' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/number/i);
    expect(sqlCalls.length).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails when the bank tx does not belong to the company', async () => {
    routeMock([{ match: 'FROM bank_transactions', rows: [] }]);
    const res = await createAndSendQuery(COMPANY_ID, input);
    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT insert a row when the Twilio send fails', async () => {
    routeMock([{ match: 'FROM bank_transactions', rows: [TX_ROW] }]);
    sendMock.mockResolvedValue({ sent: false, reason: 'twilio env vars not configured' });
    const res = await createAndSendQuery(COMPANY_ID, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/twilio/i);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_tx_queries'))).toBe(false);
  });

  it('sends a composed message to the normalized number and inserts the row', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [{ id: QUERY_ID, status: 'sent' }] },
    ]);
    sendMock.mockResolvedValue({ sent: true, sid: 'SM_TEST_SID' });
    const res = await createAndSendQuery(COMPANY_ID, input);
    expect(res.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledWith('whatsapp:+27821234567', expect.stringContaining('Acme Trading'));
    const insert = sqlCalls.find((c) => c.sql.includes('INSERT INTO bank_tx_queries'));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain(COMPANY_ID);
    expect(insert!.values).toContain('+27821234567');
    expect(insert!.sql).toContain('message_sid');
    expect(insert!.values).toContain('SM_TEST_SID');
  });

  it('fails (and skips UPDATE companies) when the INSERT returns no row', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [] },
    ]);
    const res = await createAndSendQuery(COMPANY_ID, { ...input, saveAsDefault: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/internal/i);
    expect(sqlCalls.some((c) => c.sql.includes('UPDATE companies'))).toBe(false);
  });

  it('uses a caller-supplied message verbatim', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [{ id: QUERY_ID, status: 'sent' }] },
    ]);
    await createAndSendQuery(COMPANY_ID, { ...input, message: 'What was this payment for?' });
    expect(sendMock).toHaveBeenCalledWith('whatsapp:+27821234567', 'What was this payment for?');
  });

  it('persists the default number when saveAsDefault is set', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [{ id: QUERY_ID, status: 'sent' }] },
      { match: 'UPDATE companies', rows: [] },
    ]);
    await createAndSendQuery(COMPANY_ID, { ...input, saveAsDefault: true });
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE companies'));
    expect(upd).toBeDefined();
    expect(upd!.values).toContain('+27821234567');
  });
});

describe('listQueries', () => {
  it('scopes by company and joins tx context', async () => {
    routeMock([{ match: 'FROM bank_tx_queries', rows: [] }]);
    await listQueries(COMPANY_ID, { status: 'replied' });
    const q = sqlCalls[0]!;
    expect(q.sql).toContain('q.company_id');
    expect(q.sql).toContain('JOIN bank_transactions');
    expect(q.values).toContain(COMPANY_ID);
    expect(q.values).toContain('replied');
  });
});

describe('setQueryStatus', () => {
  it('resolves from sent or replied', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [{ id: QUERY_ID }] }]);
    const res = await setQueryStatus(COMPANY_ID, QUERY_ID, 'resolve');
    expect(res.ok).toBe(true);
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toContain("'sent'");
    expect(upd.sql).toContain("'replied'");
  });

  it('cancel only allowed from sent; reports invalid state', async () => {
    routeMock([
      { match: 'UPDATE bank_tx_queries', rows: [] },
      { match: 'SELECT status FROM bank_tx_queries', rows: [{ status: 'replied' }] },
    ]);
    const res = await setQueryStatus(COMPANY_ID, QUERY_ID, 'cancel');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/invalid state/);
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toContain("'cancelled'");
    expect(upd.sql).not.toContain("'resolved'");
  });

  it('reports not found when the query does not exist for the company', async () => {
    routeMock([
      { match: 'UPDATE bank_tx_queries', rows: [] },
      { match: 'SELECT status FROM bank_tx_queries', rows: [] },
    ]);
    const res = await setQueryStatus(COMPANY_ID, QUERY_ID, 'cancel');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not found');
  });
});

describe('query settings', () => {
  it('reads the company default + name', async () => {
    routeMock([{ match: 'FROM companies', rows: [{ client_query_whatsapp: '+27821234567', name: 'Acme Trading' }] }]);
    const s = await getQuerySettings(COMPANY_ID);
    expect(s).toEqual({ clientQueryWhatsapp: '+27821234567', companyName: 'Acme Trading' });
  });

  it('saves a normalized default and rejects junk', async () => {
    routeMock([{ match: 'UPDATE companies', rows: [] }]);
    expect((await saveQuerySettings(COMPANY_ID, '082 123 4567')).ok).toBe(true);
    expect((await saveQuerySettings(COMPANY_ID, 'junk')).ok).toBe(false);
    expect((await saveQuerySettings(COMPANY_ID, null)).ok).toBe(true); // clearing is allowed
  });
});
