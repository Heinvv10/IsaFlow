/**
 * Blind review #684 (LOW): deleting a supplier or GL account a bank rule names.
 * The FK clears that column on the rule. 489's composite FK said plain SET
 * NULL, which also nulled company_id, so the delete always failed; 877 narrows
 * it to the one column. Under `bank_rule`, clearing where a money-posting rule
 * posts re-points it (a supplier rule becomes an account rule), so it needs
 * approval and the table refuses it. The deleting paths therefore DISABLE such
 * rules first — a safe change, applied and recorded — in the same savepoint as
 * the delete, and never leave the transaction aborted:
 *  - the soft-delete purge (purgeExpiredDeletes, supplier entry);
 *  - the migration rollback (rollbackMigration, gl_accounts).
 * A rule that posts nothing, or any rule with the switch off, simply loses the column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { purgeExpiredDeletes } from '../../src/modules/accounting/services/core/softDeleteService';
import { rollbackMigration } from '../../src/modules/accounting/services/core/migrationRollbackService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';
import { journalCompany, type JournalCompany } from './r035-pr6.helpers';
import { cleanupRuleChanges, enforceRules, historyOf, plantBankRule, ruleOf, ruleRoutes } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const r = ruleRoutes(tokens);

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(() => cleanupRuleChanges(pool, companies, [a]));

async function fixture(enforced: boolean): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[a, 'admin']], companies);
  if (enforced) await enforceRules(pool, f.c, a);
  return f;
}
/** A supplier soft-deleted long enough ago to be purged, and a rule naming it. */
async function supplierRule(f: JournalCompany, autoPost: boolean): Promise<{ supplier: string; rule: string }> {
  const supplier = (await pool.query(
    "INSERT INTO suppliers(company_id,name,deleted_at) VALUES($1,'BRC gone',now() - interval '1 hour') RETURNING id", [f.c])).rows[0].id;
  return { supplier, rule: await plantBankRule(pool, f.c, f.expA, { autoPost, supplierId: supplier }) };
}
/** Runs `fn` in one request transaction and proves the transaction is still usable after it. */
const inUsableTx = <T>(c: string, fn: () => Promise<T>) => inRequest(pool, a, c, async (client) => {
  const out = await fn();
  expect((await client.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  return out;
});
const supplierExists = async (id: string) => (await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id])).rowCount === 1;

describe('purging a supplier a rule names', () => {
  it('under bank_rule: an auto-posting rule is disabled first, then loses the supplier; the purge completes', async () => {
    const f = await fixture(true);
    const { supplier, rule } = await supplierRule(f, true);
    expect(await inUsableTx(f.c, () => purgeExpiredDeletes(f.c))).toBe(1);
    expect(await supplierExists(supplier)).toBe(false);
    expect(await ruleOf(pool, rule)).toMatchObject({ company_id: f.c, supplier_id: null, is_active: false, auto_create_entry: true });
    expect((await historyOf(pool, f.c, rule)).map((h) => h.kind)).toEqual(['create', 'toggle', 'update']);
    // Turning it back on is now a change that makes it post money: held.
    const res = await r.action(a, f.c, { action: 'toggle', id: rule, isActive: true });
    expect((res.state.body as { data: { status: string } }).data.status).toBe('pending_approval');
  });

  it('a rule that posts nothing, or any rule with the switch off, keeps running and only loses the supplier', async () => {
    const on = await fixture(true);
    const suggest = await supplierRule(on, false);
    const off = await fixture(false);
    const posting = await supplierRule(off, true);
    for (const [f, x] of [[on, suggest], [off, posting]] as const) {
      expect(await inUsableTx(f.c, () => purgeExpiredDeletes(f.c))).toBe(1);
      expect(await supplierExists(x.supplier)).toBe(false);
      expect(await ruleOf(pool, x.rule)).toMatchObject({ company_id: f.c, supplier_id: null, is_active: true });
    }
  });
  it('a table that cannot be purged is skipped in its own savepoint; the rest of the purge runs on a live transaction', async () => {
    const f = await fixture(true);
    // A soft-deleted customer a quote still names: its DELETE fails (23503).
    const customer = (await pool.query(
      "INSERT INTO customers(company_id,name,deleted_at) VALUES($1,'BRC kept',now() - interval '1 hour') RETURNING id", [f.c])).rows[0].id;
    await pool.query('INSERT INTO customer_quotes(company_id,quote_number,client_id) VALUES($1,$2,$3)', [f.c, `Q-${f.c.slice(0, 8)}`, customer]);
    const { supplier, rule } = await supplierRule(f, true);
    expect(await inUsableTx(f.c, () => purgeExpiredDeletes(f.c))).toBe(1);
    expect(await supplierExists(supplier)).toBe(false);
    expect((await ruleOf(pool, rule))!.is_active).toBe(false);
    expect((await pool.query('SELECT 1 FROM customers WHERE id = $1', [customer])).rowCount).toBe(1);
    await pool.query('DELETE FROM customer_quotes WHERE company_id = $1', [f.c]);
  });
});

describe('rolling back a migration that imported an account a rule posts to', () => {
  it('under bank_rule: the rule is disabled and loses the account; the account is deleted', async () => {
    const f = await fixture(true);
    const acct = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,imported_from)
       VALUES($1,$2,'BRC imported','expense','debit',true,'xero') RETURNING id`, [f.c, `XI${f.c.slice(0, 6)}`])).rows[0].id as string;
    const rule = await plantBankRule(pool, f.c, acct, { autoPost: true });
    const result = await inUsableTx(f.c, () => rollbackMigration(f.c, 'xero'));
    expect(result).toMatchObject({ deleted: 1, retained: 0 });
    expect(await ruleOf(pool, rule)).toMatchObject({ company_id: f.c, gl_account_id: null, is_active: false });
  });
});
