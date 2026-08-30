/**
 * When ROLLBACK TO SAVEPOINT itself fails, the connection is dead — say so.
 *
 * `withSavepoint` rolls back and releases before rethrowing, which is what lets
 * a caller catch the error and carry on using the same transaction. Its own
 * docstring teaches that idiom (`.catch(() => null)`), and plenty of callers use
 * it: disclosureNoteService skips a note, sageMigrationCommitService logs and
 * continues, pdfShared falls back, bulkAllocationPost catches per line.
 *
 * But if the ROLLBACK itself fails — a dropped socket, a dead backend — the
 * rollback error was swallowed and only the original rethrown. The comment said
 * "the outer tx is already doomed", which is true, and correct ONLY if the
 * caller lets it bubble. A catch-and-continue caller instead issues its next
 * query on an aborted connection and gets a bare
 * `25P02 current transaction is aborted` — the real cause gone, replaced by the
 * least informative error Postgres has.
 *
 * That is not hypothetical here. archiveExecutionSavepoint.test.ts exists
 * because this codebase already hit it once: "the UPDATE itself threw ('current
 * transaction is aborted'), masking the original error".
 *
 * So a failed rollback now POISONS the request context, and the next query
 * through it fails with the ORIGINAL cause named. Same shape as the existing
 * `criticalAuditFailed` flag on RequestContext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeCtx {
  client: { query: ReturnType<typeof vi.fn> };
  userId: string;
  claims: Record<string, unknown>;
  txUnusable?: string;
}

let store: FakeCtx | undefined;

vi.mock('@/lib/als', () => ({
  als: { getStore: () => store },
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withSavepoint, assertTxUsable, sql } from '@/lib/neon';

function makeCtx(queryImpl: (text: string) => Promise<unknown>): FakeCtx {
  return {
    client: { query: vi.fn(async (text: string) => queryImpl(text)) },
    userId: 'u1',
    claims: {},
  };
}

const ORIGINAL = 'insert or update on table "x" violates foreign key constraint';

beforeEach(() => {
  store = undefined;
  vi.clearAllMocks();
});

describe('withSavepoint — a clean rollback leaves the tx usable', () => {
  it('does not poison the context when the rollback succeeds', async () => {
    store = makeCtx(async () => ({ rows: [] }));

    await expect(
      withSavepoint('sp_ok', async () => { throw new Error(ORIGINAL); }),
    ).rejects.toThrow(ORIGINAL);

    // The whole point of the savepoint: the caller may carry on.
    expect(store!.txUnusable).toBeUndefined();
    expect(() => assertTxUsable()).not.toThrow();
    const issued = store!.client.query.mock.calls.map((c) => String(c[0]));
    expect(issued).toContain('ROLLBACK TO SAVEPOINT sp_ok');
    expect(issued).toContain('RELEASE SAVEPOINT sp_ok');
  });
});

describe('withSavepoint — a FAILED rollback poisons the context', () => {
  beforeEach(() => {
    store = makeCtx(async (text: string) => {
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
      }
      return { rows: [] };
    });
  });

  it('still rethrows the ORIGINAL error, not the rollback failure', async () => {
    // Unchanged behaviour, and deliberately so — the original cause is the one
    // worth surfacing.
    await expect(
      withSavepoint('sp_bad', async () => { throw new Error(ORIGINAL); }),
    ).rejects.toThrow(ORIGINAL);
  });

  it('marks the context unusable, naming the original cause', async () => {
    await withSavepoint('sp_bad', async () => { throw new Error(ORIGINAL); })
      .catch(() => undefined);
    expect(store!.txUnusable).toContain(ORIGINAL);
  });

  it('makes the NEXT query fail with the original cause instead of a bare 25P02', async () => {
    // This is the whole point. A catch-and-continue caller previously got
    // "current transaction is aborted" here and lost the diagnosis.
    await withSavepoint('sp_bad', async () => { throw new Error(ORIGINAL); })
      .catch(() => undefined);

    expect(() => assertTxUsable()).toThrow(/unusable/i);
    expect(() => assertTxUsable()).toThrow(new RegExp(ORIGINAL.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('is inert outside a request transaction', async () => {
    // Cron and script code runs with no ALS store; each query opens its own
    // connection, so there is no shared transaction to poison.
    store = undefined;
    expect(() => assertTxUsable()).not.toThrow();
    await expect(
      withSavepoint('sp_none', async () => { throw new Error(ORIGINAL); }),
    ).rejects.toThrow(ORIGINAL);
  });
});

describe('withSavepoint — a failed RELEASE is not a failed ROLLBACK', () => {
  it('does NOT poison when the rollback succeeded and only the release failed', async () => {
    // After a successful ROLLBACK TO SAVEPOINT the transaction state is
    // restored, so the tx is structurally fine. Poisoning here would refuse
    // later queries that would have worked, and label the cause "ROLLBACK TO
    // SAVEPOINT then failed" when the rollback did no such thing.
    store = makeCtx(async (text: string) => {
      if (text.startsWith('RELEASE SAVEPOINT')) {
        throw Object.assign(new Error('release blew up'), { code: '08006' });
      }
      return { rows: [] };
    });

    await expect(
      withSavepoint('sp_rel', async () => { throw new Error(ORIGINAL); }),
    ).rejects.toThrow(ORIGINAL);

    expect(store!.txUnusable).toBeUndefined();
    expect(() => assertTxUsable()).not.toThrow();
  });
});

/**
 * `sql.transaction()` reaches the SAME request-scoped client by a fourth route.
 *
 * Missed on the first pass, and it is the path that most needed it: its own
 * comment names sageImportService's per-item catch-and-continue loops as the
 * reason it savepoints at all. A caller looping over messy data, catching each
 * batch failure and carrying on, is exactly who gets handed the opaque 25P02.
 */
describe('sql.transaction — the fourth path to the request client', () => {
  it('refuses to start a batch on an already-poisoned transaction', async () => {
    store = makeCtx(async (text: string) => {
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
      }
      return { rows: [] };
    });
    await withSavepoint('sp_bad', async () => { throw new Error(ORIGINAL); })
      .catch(() => undefined);

    // Without the guard this would issue SAVEPOINT sp_sqltx_N into the dark.
    await expect(sql.transaction([])).rejects.toThrow(/unusable/i);
  });

  it('poisons the context when its OWN rollback fails', async () => {
    let sawSavepoint = false;
    store = makeCtx(async (text: string) => {
      if (text.startsWith('SAVEPOINT')) { sawSavepoint = true; return { rows: [] }; }
      if (text.startsWith('ROLLBACK TO SAVEPOINT')) {
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
      }
      if (text === 'boom') throw new Error(ORIGINAL);
      return { rows: [] };
    });

    await expect(
      sql.transaction([{ text: 'boom', values: [] }] as never),
    ).rejects.toThrow(ORIGINAL);

    expect(sawSavepoint).toBe(true);
    expect(store!.txUnusable).toContain(ORIGINAL);
    expect(() => assertTxUsable()).toThrow(/unusable/i);
  });

  it('leaves the context clean when its rollback succeeds', async () => {
    store = makeCtx(async (text: string) => {
      if (text === 'boom') throw new Error(ORIGINAL);
      return { rows: [] };
    });

    await expect(
      sql.transaction([{ text: 'boom', values: [] }] as never),
    ).rejects.toThrow(ORIGINAL);

    // The whole point of the savepoint: the per-item loop carries on.
    expect(store!.txUnusable).toBeUndefined();
  });
});
