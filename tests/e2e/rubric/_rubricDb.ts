/**
 * The rubric harness's two direct reads and one write on the dev database (master plan wave 4, MW). pg only, no
 * Playwright, so the SQL is exercised against a real schema (tests/integration/rubric-add-approver.int.test.ts).
 *
 * Every connection is judged twice: the URL before connecting (_rubricDatabaseGuard.ts), and the server after
 * (`current_database()`, `inet_server_port()`).
 */
import { Client } from 'pg';
import { assertConnectedDev, assertDevDatabase } from './_rubricDatabaseGuard';
import { APPROVER_EMAIL, DEMO_COMPANY_ID, REQUESTER_EMAIL, RubricGuardError } from './_rubricGuard';

export type Queryable = Pick<Client, 'query'>;

/** A connection to dev's isaflow_dev, judged before and after it opens. */
export async function withDevDb<T>(databaseUrl: string, use: (db: Client) => Promise<T>): Promise<T> {
  assertDevDatabase(databaseUrl);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ database: string; port: number }>('SELECT current_database() AS database, inet_server_port() AS port');
    assertConnectedDev(rows[0]!);
    return await use(db);
  } finally {
    await db.end();
  }
}

/**
 * The company the requester's one login opens in: the sandbox named `sandboxName` once it exists, else their default
 * company. Read here so each run logs in once per user (login allows 10 attempts per email per 15 minutes).
 */
export async function startingCompany(db: Queryable, sandboxName: string): Promise<string> {
  const { rows } = await db.query<{ company_id: string }>(
    `SELECT cu.company_id FROM company_users cu
     JOIN users u ON u.id::text = cu.user_id JOIN companies c ON c.id = cu.company_id
     WHERE lower(u.email) = $1 AND c.is_active IS NOT FALSE AND c.status = 'active'
     ORDER BY (c.name = $2) DESC, cu.is_default DESC NULLS LAST, cu.created_at LIMIT 1`,
    [REQUESTER_EMAIL, sandboxName]);
  const id = rows[0]?.company_id;
  if (!id) throw new RubricGuardError(`${REQUESTER_EMAIL} has no company to open`);
  return id;
}

/**
 * Makes `email` an admin of the sandbox (admin ranks at the 'admin' a pay_run request demands when no rule binds it).
 * The INSERT names the sandbox by id AND name and excludes Demo, so it cannot land anywhere else. `is_default` is false:
 * the sandbox must never become the user's default company.
 */
export async function insertApprover(db: Queryable, sandbox: { id: string; name: string }, email = APPROVER_EMAIL):
  Promise<{ role: string; added: boolean }> {
  const inserted = await db.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default)
     SELECT c.id, u.id::text, 'admin', false
     FROM companies c JOIN users u ON lower(u.email) = $3
     WHERE c.id = $1::uuid AND c.name = $2 AND c.id <> $4::uuid
     ON CONFLICT (company_id, user_id) DO NOTHING`,
    [sandbox.id, sandbox.name, email, DEMO_COMPANY_ID]);
  const { rows } = await db.query<{ role: string }>(
    `SELECT cu.role FROM company_users cu JOIN users u ON u.id::text = cu.user_id
     WHERE cu.company_id = $1::uuid AND lower(u.email) = $2`, [sandbox.id, email]);
  const role = rows[0]?.role;
  if (role !== 'admin' && role !== 'owner') throw new RubricGuardError(`${email} is not an owner/admin of the sandbox`);
  return { role, added: (inserted.rowCount ?? 0) > 0 };
}
