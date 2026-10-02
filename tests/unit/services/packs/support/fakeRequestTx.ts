/**
 * A REQUEST TRANSACTION THAT BEHAVES LIKE POSTGRES WHERE IT MATTERS.
 *
 * Under `withAuth` every query in a request runs on ONE pg client inside ONE
 * transaction. When a statement fails, Postgres aborts that transaction: every
 * later statement is refused with SQLSTATE 25P02 until the transaction rolls
 * back to a savepoint taken before the failure. A `try`/`catch` in application
 * code does not undo that — which is the defect the pack's degrading reads
 * carried, and no mock of a service function can show it.
 *
 * This stands in for the client. It records every statement, fails the ones a
 * test asks it to, and then refuses everything until a `ROLLBACK TO SAVEPOINT`
 * naming a savepoint that is actually open. Run code inside it with `run`, and
 * the real `sql` and `withSavepoint` from `@/lib/neon` route through it.
 */
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';

/** An error shaped like node-postgres's: a message and a SQLSTATE on `code`. */
export function pgError(code: string, message = 'relation "x" does not exist'): Error {
  return Object.assign(new Error(message), { code });
}

export interface FakeRequestTx {
  /** Every statement the client was sent, in order, whitespace collapsed. */
  statements: string[];
  /** Whether the transaction is currently refusing statements. */
  isAborted(): boolean;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * @param failOn Returns the error a statement should fail with, or null. A
 *   statement that fails aborts the transaction, as it does in Postgres.
 */
export function fakeRequestTx(failOn: (statement: string) => Error | null = () => null): FakeRequestTx {
  const statements: string[] = [];
  const savepoints: string[] = [];
  let aborted = false;

  const query = async (text: string): Promise<{ rows: unknown[] }> => {
    const statement = text.replace(/\s+/g, ' ').trim();
    statements.push(statement);

    const rollback = /^ROLLBACK TO SAVEPOINT (\w+)$/.exec(statement);
    if (rollback) {
      const at = savepoints.lastIndexOf(rollback[1]!);
      if (at < 0) throw pgError('3B001', `savepoint "${rollback[1]!}" does not exist`);
      // Rolling back to a savepoint destroys the ones taken after it and
      // leaves it open.
      savepoints.length = at + 1;
      aborted = false;
      return { rows: [] };
    }
    if (aborted) {
      throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    }
    const savepoint = /^SAVEPOINT (\w+)$/.exec(statement);
    if (savepoint) {
      savepoints.push(savepoint[1]!);
      return { rows: [] };
    }
    const release = /^RELEASE SAVEPOINT (\w+)$/.exec(statement);
    if (release) {
      const at = savepoints.lastIndexOf(release[1]!);
      if (at < 0) {
        aborted = true;
        throw pgError('3B001', `savepoint "${release[1]!}" does not exist`);
      }
      savepoints.length = at;
      return { rows: [] };
    }
    const failure = failOn(statement);
    if (failure) {
      aborted = true;
      throw failure;
    }
    return { rows: [] };
  };

  return {
    statements,
    isAborted: () => aborted,
    run: (fn) => als.run(
      { client: { query } as unknown as PoolClient, userId: 'u1', companyId: 'c1', claims: {} },
      fn,
    ),
  };
}

/**
 * One statement on the request's client, tagged so a test can find it in
 * `statements` and so `failOn` can pick it out. What a mocked service calls in
 * place of the queries the real one would issue.
 */
export async function touchLedger(tag: string): Promise<void> {
  if (!/^\w+$/.test(tag)) throw new Error(`touchLedger: tag must be a word, got ${tag}`);
  await sql.unsafe(`/* ${tag} */ SELECT 1`);
}
