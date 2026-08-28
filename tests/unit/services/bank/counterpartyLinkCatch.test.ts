/**
 * allocateTransaction's counterparty auto-link must fail inside a SAVEPOINT.
 *
 * The auto-link is a nicety: if the opposite bank's statement has no matching
 * row, the allocation is still correct, so a failure is logged and swallowed.
 * But EVERY Postgres error aborts the transaction it happens in — not just
 * deadlocks — so swallowing one without a savepoint left the request in the
 * aborted state: every statement after it raised 25P02 and the handler returned
 * a journal id for a journal that could never commit. An error-code whitelist
 * was the first attempt and could only ever cover the codes someone listed.
 *
 * The unit half proves the savepoint wraps the block; the DB-gated half proves
 * the outer transaction is still usable after a real 23503 inside it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

const journalMocks = vi.hoisted(() => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { log } from '@/lib/logger';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { getPoolForTests, sql } from '@/lib/neon';
import { autoLinkCounterpartyTransfer } from '@/modules/accounting/services/bank/bankTransferAutoLink';

type Ctx = Parameters<typeof als.run>[0];
function ctxFor(client: PoolClient): Ctx {
  return { client, userId: 'u', companyId: 'c', claims: {} } as unknown as Ctx;
}

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const BANK_ID = 'cccccccc-0000-0000-0000-cccccccccccc';
const CP_ID = 'dddddddd-0000-0000-0000-dddddddddddd';

const INPUT = {
  companyId: COMPANY_ID, bankTxId: TX_ID, bankAccountId: BANK_ID,
  counterpartyAccountId: CP_ID, journalEntryId: 'je-1', amount: -500,
  txDate: '2026-08-01', allocatedEntityName: 'Bank B',
};

describe('autoLinkCounterpartyTransfer — failure containment (unit)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs inside a savepoint and swallows the failure', async () => {
    // A mocked ALS client records the savepoint traffic; the sql tagged
    // template runs on that same client, so the first query is the one that
    // throws and the rollback must follow it.
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (/FROM bank_transactions/.test(text)) {
          throw Object.assign(new Error('insert or update violates foreign key'), { code: '23503' });
        }
        return { rows: [] };
      }),
    };

    await expect(
      als.run(ctxFor(client as unknown as PoolClient), () => autoLinkCounterpartyTransfer(INPUT)),
    ).resolves.toBeUndefined();

    expect(statements.some((q) => /^SAVEPOINT /.test(q))).toBe(true);
    expect(statements.some((q) => /^ROLLBACK TO SAVEPOINT /.test(q))).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('auto-link'), expect.anything(), expect.anything(),
    );
  });
});

describe('autoLinkCounterpartyTransfer — the outer transaction survives (integration)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('a failed link leaves the outer transaction usable', async () => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await als.run(ctxFor(client), async () => {
        // A real, production-shaped failure inside the link: the counterparty
        // id reaches `::UUID` malformed and pg raises 22P02, which aborts the
        // transaction exactly as a deadlock or an FK violation would.
        await expect(
          autoLinkCounterpartyTransfer({ ...INPUT, counterpartyAccountId: 'not-a-uuid' }),
        ).resolves.toBeUndefined();

        // The statement the caller runs next. Without the savepoint this is
        // 25P02 ("current transaction is aborted") and the allocation that had
        // already posted could never commit.
        const rows = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
        expect(rows[0]?.ok).toBe(1);
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
