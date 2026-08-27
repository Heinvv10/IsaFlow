/**
 * PRD-11 §3 — forged cursors, tool → service → decode, with NOTHING between the
 * tool and the real service but a mocked database driver.
 *
 * Why this file exists separately from tools-read.test.ts: that suite mocks
 * `getBankTransactions`, so a forged cursor never reaches the decoder there.
 * The failure being guarded is what a bad cursor does if it slips through to
 * SQL. `$N::DATE` and `$N::UUID` throw 22008 / 22P02, and a read tool runs with
 * no savepoint (registry.ts) — so that aborts the whole request transaction,
 * the registry's refund and audit writes then fail with 25P02, and the caller
 * gets a 500 with the Flow debit unrefunded. Hence the assertion that matters
 * is not just the error text: it is that NO query was issued at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/neon')>();
  const sqlMock = Object.assign(
    vi.fn(() => Promise.resolve([])),
    { unsafe: vi.fn((s: string) => s) },
  );
  return { sql: sqlMock, fmtDate: actual.fmtDate };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { listBankTransactionsTool } from '@/lib/mcp/tools/bank';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const ctx = (): McpToolContext => ({
  userId: 'user-1', companyId: COMPANY_ID, scopes: ['read:bank-tx'],
  tokenJti: 'jti-1', oauthAppId: null,
});

const b64 = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');
const GOOD_ID = '11111111-1111-4111-8111-111111111111';

describe('list_bank_transactions — a forged cursor never reaches a SQL cast', () => {
  beforeEach(() => vi.clearAllMocks());

  const FORGED: Array<[string, string]> = [
    ['not base64 at all', 'not a cursor!!'],
    ['month 13', b64({ d: '2026-13-05', a: 1, id: GOOD_ID })],
    ['day 45', b64({ d: '2026-01-45', a: 1, id: GOOD_ID })],
    ['31 February', b64({ d: '2026-02-31', a: 1, id: GOOD_ID })],
    ['id is not a uuid', b64({ d: '2026-01-01', a: 1, id: 'abc' })],
    ['id carries sql', b64({ d: '2026-01-01', a: 1, id: "1' OR '1'='1" })],
    ['amount is a string', b64({ d: '2026-01-01', a: '1', id: GOOD_ID })],
  ];

  for (const [label, cursor] of FORGED) {
    it(`returns toolError('invalid cursor') and issues no query — ${label}`, async () => {
      const r = await listBankTransactionsTool.handler({ cursor }, ctx());

      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe('invalid cursor');
      // The whole point: nothing was sent to the database.
      expect(vi.mocked(sql)).not.toHaveBeenCalled();
      // And no internals leak in the reply.
      expect(r.content[0]!.text).not.toMatch(/DATE|UUID|22P02|22008|bank_transactions/);
    });
  }

  it('a well-formed cursor DOES reach the query', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ cnt: '0' }] as never);

    const r = await listBankTransactionsTool.handler(
      { cursor: b64({ d: '2026-01-01', a: 1, id: GOOD_ID }) }, ctx(),
    );

    expect(r.isError).toBeUndefined();
    expect(vi.mocked(sql)).toHaveBeenCalled();
  });
});
