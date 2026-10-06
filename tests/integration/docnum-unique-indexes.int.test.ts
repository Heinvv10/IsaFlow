/**
 * DOCNUM: the unique number indexes of migrations 859-861 and 863, and their guard.
 *
 * credit_notes, customer_payments, supplier_payments and consolidation_adjustments had no unique index on their
 * number, so a duplicate was stored silently. Each migration adds one, on exactly the scope the trigger numbers
 * within. It must never fail a deploy on existing data: a duplicate already in the table turns the build's 23505
 * into a NOTICE and leaves the table without the index.
 *
 * The migration cases run each file's own text, as the runner does (one transaction per file), inside a
 * transaction that first drops the index — and roll it all back, so the shared fixture keeps its index. The DROP
 * holds the table's ACCESS EXCLUSIVE lock for the few milliseconds of that transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'fs';
import path from 'path';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { CASES, dropScope, errText, insertDoc, seedScope, type Scope } from './helpers/docnumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const YEAR = 2034;

const INDEXED = [
  { table: 'credit_notes', index: 'uq_credit_notes_company_number', file: '859_credit_note_number_unique.sql' },
  { table: 'customer_payments', index: 'uq_customer_payments_company_number',
    file: '860_customer_payment_number_unique.sql' },
  { table: 'supplier_payments', index: 'uq_supplier_payments_company_number',
    file: '861_supplier_payment_number_unique.sql' },
  { table: 'consolidation_adjustments', index: 'uq_consol_adj_group_number',
    file: '863_consolidation_adjustment_number_unique.sql' },
] as const;

const migrationText = (file: string): string =>
  readFileSync(path.join(__dirname, '../../scripts/migrations/sql', file), 'utf8');

let admin: Client;
let scope: Scope | undefined;
let n = 0;

describeIfDb('DOCNUM: unique number indexes (859-861, 863)', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    scope = await seedScope(admin, 'DOCNUM-UQ');
  }, 60000);

  afterAll(async () => {
    try {
      if (scope) await dropScope(admin, scope);
    } finally {
      await admin?.end();
    }
  }, 60000);

  /** Runs `body` on its own connection inside a transaction that is always rolled back; collects NOTICEs. */
  async function rolledBack(body: (c: Client, notices: string[]) => Promise<void>): Promise<void> {
    const c = new Client({ connectionString: DATABASE_URL });
    const notices: string[] = [];
    c.on('notice', (m) => { notices.push(m.message ?? ''); });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '5s'");
      await body(c, notices);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  }

  const indexExists = async (c: Client, index: string): Promise<boolean> =>
    (await c.query('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${index}`])).rows[0].e as boolean;

  describe.each(INDEXED)('$table', (t) => {
    const k = CASES.find((x) => x.table === t.table)!;

    it('refuses an explicit duplicate number in the same scope: 23505 on the index', async () => {
      const number = `${k.prefix}-${YEAR}-${String(++n).padStart(5, '0')}`;
      await insertDoc(admin, k, scope!, YEAR, number);
      const err = await insertDoc(admin, k, scope!, YEAR, number).then(() => null, (e: unknown) => e);
      expect(err, 'the second row must be refused').not.toBeNull();
      expect(errText(err)).toContain(`23505 ${t.index}`);
    }, 60000);

    it('migration on a table holding a duplicate: NOTICE, no index, no error', async () => {
      await rolledBack(async (c, notices) => {
        await c.query(`DROP INDEX public.${t.index}`);
        const number = `${k.prefix}-${YEAR}-DUP${++n}`;
        await insertDoc(c, k, scope!, YEAR, number);
        await insertDoc(c, k, scope!, YEAR, number);
        await c.query(migrationText(t.file));
        expect(await indexExists(c, t.index), 'the index must not be built over a duplicate').toBe(false);
        expect(notices.join('\n')).toMatch(new RegExp(`${t.table} holds a duplicate.*${t.index} NOT created`));
      });
    }, 60000);

    it('migration on a clean table: builds the index; run again: a no-op', async () => {
      await rolledBack(async (c) => {
        await c.query(`DROP INDEX public.${t.index}`);
        await c.query(migrationText(t.file));
        expect(await indexExists(c, t.index)).toBe(true);
        await c.query(migrationText(t.file));
        expect(await indexExists(c, t.index)).toBe(true);
      });
    }, 60000);
  });
});
