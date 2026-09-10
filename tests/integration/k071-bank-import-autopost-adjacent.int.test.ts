/**
 * K-071 adjacent cases for the savepoint around the auto-post sweep.
 *
 * The main test (k071-bank-import-best-effort-savepoint.int.test.ts) proves the
 * import survives a failing sweep. These cover what the fix must ALSO get right:
 *
 *  1. the swallowed failure is reported to the caller instead of only logged,
 *  2. a failing sweep for one company does not take another company's import
 *     down with it — both run in the same request transaction,
 *  3. a sweep that succeeds still reports a clean import (the savepoint is
 *     released, not rolled back),
 *  4. a sweep whose savepoint ROLLBACK itself fails is NOT degraded to a
 *     warning row — that transaction is genuinely aborted, so a clean-looking
 *     result would be the very lie the savepoint was added to remove.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const sweepBehaviour = { fail: true, destroySavepoint: false };

/**
 * The name the sweep's savepoint is actually opened under, captured as it is
 * opened. It carries a per-call sequence (a duplicate SAVEPOINT name SHADOWS
 * the outer one rather than erroring), so a test that has to destroy that exact
 * savepoint cannot hardcode it — and hardcoding it is how this test silently
 * stopped destroying anything.
 */
const liveSavepoint = { name: '', opened: [] as string[] };

vi.mock('@/lib/neon', async (orig) => {
  const actual = await orig<typeof import('@/lib/neon')>();
  return {
    ...actual,
    withSavepoint: (name: string, fn: () => Promise<unknown>) => {
      if (name.startsWith('bank_import_autopost')) {
        liveSavepoint.name = name;
        liveSavepoint.opened.push(name);
      }
      return actual.withSavepoint(name, fn);
    },
  };
});

vi.mock('@/modules/accounting/services/bank/autoPostGateService', () => ({
  sweep: async () => {
    const { sql } = await import('@/lib/neon');
    if (sweepBehaviour.destroySavepoint) {
      // Releasing the savepoint the caller is standing in makes its own
      // ROLLBACK TO SAVEPOINT fail — the one case a savepoint cannot survive.
      // Raw on the request client: a savepoint name is an identifier, and the
      // `sql` template would send it as a bind parameter.
      const { als } = await import('@/lib/als');
      await als.getStore()!.client.query(`RELEASE SAVEPOINT ${liveSavepoint.name}`);
      throw new Error('sweep exploded with its savepoint already gone');
    }
    if (sweepBehaviour.fail) {
      await sql`SELECT 1 / 0`;
    }
    return { runId: null, posted: 0, skipped: [] };
  },
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const user = crypto.randomUUID();
const bankA = crypto.randomUUID();
const bankB = crypto.randomUUID();

const parsed = (reference: string) => ({
  transactions: [{
    transactionDate: '2026-04-01',
    valueDate: null,
    amount: -125.75,
    description: `K071 adjacent ${reference}`,
    reference,
  }],
  errors: [],
  bankFormat: 'generic',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

async function seedCompany(companyId: string, bankAccountId: string, label: string) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, label]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype)
     VALUES($1,$2,'1110',$3,'asset','debit','bank')`,
    [bankAccountId, companyId, `${label} bank`],
  );
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await seedCompany(companyA, bankA, 'K071 adjacent A');
  await seedCompany(companyB, bankB, 'K071 adjacent B');
});

beforeEach(() => {
  sweepBehaviour.fail = true;
  sweepBehaviour.destroySavepoint = false;
  liveSavepoint.opened.length = 0;
});

afterAll(async () => {
  try {
    for (const companyId of [companyA, companyB]) {
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [companyId]);
      await pool.query('DELETE FROM bank_import_batches WHERE company_id=$1', [companyId]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [companyId]);
      await pool.query('DELETE FROM companies WHERE id=$1', [companyId]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

/** Runs one or more imports inside a single request transaction and commits. */
async function inRequest(fn: (run: typeof importInRequest) => Promise<void>) {
  const { als } = await import('@/lib/als');
  const client = await pool.connect();
  let commitError: string | null = null;
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: user, companyId: companyA, claims: {} }, () => fn(importInRequest));
    try { await client.query('COMMIT'); }
    catch (err) { commitError = err instanceof Error ? err.message : String(err); }
  } finally { client.release(); }
  return commitError;
}

async function importInRequest(companyId: string, bankAccountId: string, reference: string) {
  const { importParsedTransactions } = await import(
    '../../src/modules/accounting/services/bank/bankImportService'
  );
  return importParsedTransactions(companyId, parsed(reference), bankAccountId, '2026-04-30', { importedBy: user });
}

it('reports the swallowed sweep failure in the returned errors', async () => {
  let result: Awaited<ReturnType<typeof importInRequest>> | null = null;
  const commitError = await inRequest(async (run) => {
    result = await run(companyA, bankA, 'K071-ADJ-1');
  });

  expect(commitError).toBeNull();
  expect(result!.transactionCount).toBe(1);
  expect(result!.errors.map((e) => e.error).join(' ')).toMatch(/Auto-posting of imported outflows failed/);

  const { rowCount } = await pool.query(
    "SELECT id FROM bank_transactions WHERE company_id=$1 AND reference='K071-ADJ-1'", [companyA],
  );
  expect(rowCount).toBe(1);
});

it('does not lose a second company imported in the same request transaction', async () => {
  const commitError = await inRequest(async (run) => {
    await run(companyA, bankA, 'K071-ADJ-2A');
    await run(companyB, bankB, 'K071-ADJ-2B');
  });

  expect(commitError).toBeNull();
  for (const [companyId, reference] of [[companyA, 'K071-ADJ-2A'], [companyB, 'K071-ADJ-2B']] as const) {
    const { rows } = await pool.query(
      'SELECT company_id FROM bank_transactions WHERE company_id=$1 AND reference=$2', [companyId, reference],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(companyId);
  }
  // No cross-tenant leakage: company B's line never carries company A's id.
  const { rowCount } = await pool.query(
    'SELECT id FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2', [companyA, bankB],
  );
  expect(rowCount).toBe(0);

  // And the two sweeps did not open the SAME savepoint. `SAVEPOINT x` with a
  // live name shadows the outer one instead of erroring, so a re-entrant call
  // would release its parent's savepoint and lose the enclosing work silently.
  expect(liveSavepoint.opened).toHaveLength(2);
  expect(new Set(liveSavepoint.opened).size).toBe(2);
});

it('reports a clean import when the sweep succeeds', async () => {
  sweepBehaviour.fail = false;
  let result: Awaited<ReturnType<typeof importInRequest>> | null = null;
  const commitError = await inRequest(async (run) => {
    result = await run(companyA, bankA, 'K071-ADJ-3');
  });

  expect(commitError).toBeNull();
  expect(result!.errors).toEqual([]);
  const { rowCount } = await pool.query(
    "SELECT id FROM bank_transactions WHERE company_id=$1 AND reference='K071-ADJ-3'", [companyA],
  );
  expect(rowCount).toBe(1);
});

it('throws rather than reporting a clean import when the savepoint rollback fails', async () => {
  sweepBehaviour.destroySavepoint = true;
  let thrown: unknown = null;
  const commitError = await inRequest(async (run) => {
    try { await run(companyA, bankA, 'K071-ADJ-4'); }
    catch (err) { thrown = err; }
  });

  // withSavepoint marks the context unusable and rethrows; assertTxUsable in
  // the sweep's catch refuses to swallow that, naming the original cause.
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/unusable/i);
  // And the caller is not told otherwise: the transaction really is aborted,
  // so the COMMIT that follows cannot keep the import.
  expect(commitError).toBeNull();
  const { rowCount } = await pool.query(
    "SELECT id FROM bank_transactions WHERE company_id=$1 AND reference='K071-ADJ-4'", [companyA],
  );
  expect(rowCount).toBe(0);
});
