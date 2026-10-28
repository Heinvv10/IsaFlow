// The SQL the slot provisioner builds to copy a company's setup data. Pure: the catalog facts (columns, keys) are
// passed in, so the rules are pinned without a database. The real catalog is exercised by the provisioner itself
// (and tests/integration/golden-slot-clone.int.test.ts).
import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import { COPIED_TABLES, cloneCompany, planTableClone, type TableFacts } from '../../../scripts/ci/golden/cloneCompany';

const col = (name: string, type = 'text', notNull = false) => ({ name, type, notNull });
const SET = new Set(['gl_accounts', 'pay_scales', 'payroll_employees']);
const SCOPED = new Set(['gl_accounts', 'pay_scales', 'payroll_employees', 'suppliers', 'fiscal_year_end_changes', 'customers']);

const glAccounts: TableFacts = {
  table: 'gl_accounts',
  columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('account_code', 'character varying'), col('parent_account_id', 'uuid'), col('created_by', 'text')],
  primaryKey: ['id'],
  foreignKeys: [
    { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
    { columns: ['parent_account_id'], refTable: 'gl_accounts', refColumns: ['id'] },
    { columns: ['created_by'], refTable: 'users', refColumns: ['id'] },
  ],
};

describe('planTableClone', () => {
  it('re-keys the id, the company, and keys that point inside the copied set; leaves the rest alone', () => {
    const plan = planTableClone(glAccounts, SET, SCOPED);
    expect(plan.mapped).toEqual(['id', 'parent_account_id']);
    expect(plan.nulled).toEqual([]);
    expect(plan.sql).toBe(
      'INSERT INTO "gl_accounts" ("id", "company_id", "account_code", "parent_account_id", "created_by") '
      + "SELECT (md5($1::text || ':' || \"id\"::text)::uuid)::uuid, $1::uuid, \"account_code\", (md5($1::text || ':' || \"parent_account_id\"::text)::uuid)::uuid, "
      + 'CASE WHEN EXISTS (SELECT 1 FROM "users" r WHERE r."id" = "gl_accounts"."created_by") THEN "gl_accounts"."created_by" ELSE NULL END '
      + 'FROM "gl_accounts" WHERE "company_id" = $2::uuid',
    );
  });

  it('re-keys a text column that holds a uuid and keeps its type', () => {
    const plan = planTableClone({
      table: 'payroll_employees',
      columns: [col('id', 'text', true), col('company_id', 'uuid', true), col('pay_scale_id', 'text')],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['pay_scale_id'], refTable: 'pay_scales', refColumns: ['id'] },
      ],
    }, SET, SCOPED);
    expect(plan.sql).toContain("(md5($1::text || ':' || \"pay_scale_id\"::text)::uuid)::text");
  });

  it('re-keys only the id half of a composite (id, company_id) key', () => {
    const plan = planTableClone({
      table: 'payroll_employees',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('gl_account_id', 'uuid')],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['gl_account_id', 'company_id'], refTable: 'gl_accounts', refColumns: ['id', 'company_id'] },
      ],
    }, SET, SCOPED);
    expect(plan.mapped).toEqual(['id', 'gl_account_id']);
  });

  it('nulls a nullable key into a company-scoped table that is not copied (it would point at another tenant)', () => {
    const plan = planTableClone({
      table: 'pay_scales',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('supplier_id', 'uuid')],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['supplier_id', 'company_id'], refTable: 'suppliers', refColumns: ['id', 'company_id'] },
      ],
    }, SET, SCOPED);
    expect(plan.nulled).toEqual(['supplier_id']);
    expect(plan.sql).toContain('$1::uuid, NULL FROM');
  });

  it('refuses a NOT NULL key into a company-scoped table that is not copied', () => {
    expect(() => planTableClone({
      table: 'pay_scales',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('customer_id', 'uuid', true)],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] },
      ],
    }, SET, SCOPED)).toThrow(/pay_scales\.customer_id.*customers/);
  });

  it('keeps a key into a global table (users, reference data) only where the referenced row exists', () => {
    const plan = planTableClone(glAccounts, SET, SCOPED);
    expect(plan.guarded).toEqual(['created_by']);
    expect(plan.nulled).not.toContain('created_by');
    expect(plan.sql).toContain('EXISTS (SELECT 1 FROM "users" r WHERE r."id" = "gl_accounts"."created_by")');
  });

  it('copies a NOT NULL key into a global table as it is (there is nothing safe to substitute)', () => {
    const plan = planTableClone({
      table: 'pay_scales',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('level_id', 'uuid', true)],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['level_id'], refTable: 'occupational_levels', refColumns: ['id'] },
      ],
    }, SET, SCOPED);
    expect(plan.guarded).toEqual([]);
    expect(plan.sql).toContain('"level_id" FROM');
  });

  it('refuses a key into companies from any column but company_id', () => {
    expect(() => planTableClone({
      table: 'pay_scales',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('owner_company_id', 'uuid')],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['owner_company_id'], refTable: 'companies', refColumns: ['id'] },
      ],
    }, SET, SCOPED)).toThrow(/owner_company_id/);
  });

  it('refuses a key into a copied table that is not its primary key (it would not be re-keyed with it)', () => {
    expect(() => planTableClone({
      table: 'payroll_employees',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('scale_code', 'text')],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['company_id'], refTable: 'companies', refColumns: ['id'] },
        { columns: ['scale_code'], refTable: 'pay_scales', refColumns: ['code'] },
      ],
    }, SET, SCOPED)).toThrow(/scale_code/);
  });

  it('applies the per-table overrides for references the catalog cannot see', () => {
    const plan = planTableClone({
      table: 'pay_scales',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), col('client_id', 'uuid')],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['company_id'], refTable: 'companies', refColumns: ['id'] }],
    }, SET, SCOPED, { nulled: ['client_id'] });
    expect(plan.nulled).toEqual(['client_id']);
  });

  it('skips generated columns', () => {
    const plan = planTableClone({
      table: 'pay_scales',
      columns: [col('id', 'uuid', true), col('company_id', 'uuid', true), { ...col('total'), generated: true }],
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['company_id'], refTable: 'companies', refColumns: ['id'] }],
    }, SET, SCOPED);
    expect(plan.sql).not.toContain('total');
  });

  it('a table keyed by company_id alone keeps its key, so a second clone of the same company conflicts instead of duplicating', () => {
    const plan = planTableClone({
      table: 'bank_auto_post_settings',
      columns: [col('company_id', 'uuid', true), col('enabled', 'boolean')],
      primaryKey: ['company_id'],
      foreignKeys: [{ columns: ['company_id'], refTable: 'companies', refColumns: ['id'] }],
    }, SET, SCOPED);
    expect(plan.mapped).toEqual([]);
  });

  it('reaches a table with no company_id of its own through a copied parent, re-keying its keys', () => {
    const plan = planTableClone({
      table: 'payroll_employee_components',
      columns: [col('id', 'uuid', true), col('employee_id', 'uuid', true), col('component_id', 'uuid', true), col('amount', 'numeric')],
      primaryKey: ['id'],
      foreignKeys: [
        { columns: ['employee_id'], refTable: 'payroll_employees', refColumns: ['id'] },
        { columns: ['component_id'], refTable: 'payroll_components', refColumns: ['id'] },
      ],
    }, new Set(['payroll_employees', 'payroll_components']), SCOPED, { scope: '"employee_id" IN (SELECT "id" FROM "payroll_employees" WHERE "company_id" = $2::uuid)' });
    expect(plan.mapped).toEqual(['id', 'employee_id', 'component_id']);
    expect(plan.sql).toMatch(/WHERE "employee_id" IN \(SELECT "id" FROM "payroll_employees" WHERE "company_id" = \$2::uuid\)$/);
    expect(plan.sql).not.toContain('$1::uuid,');
  });
});

describe('cloneCompany', () => {
  /** A database that knows two tables' shape and which tables the target already holds rows in. */
  function fakeDb(opts: { targetExists: boolean; heldTables: string[]; sourceExists?: boolean }) {
    const inserts: string[] = [];
    const db = {
      query: async (text: string, params: unknown[] = []) => {
        if (text.startsWith('SELECT 1 FROM companies WHERE id = $1::uuid')) {
          const exists = params[0] === 'target' ? opts.targetExists : (opts.sourceExists ?? true);
          return { rowCount: exists ? 1 : 0, rows: [] };
        }
        if (text.includes('FROM pg_attribute a WHERE a.attrelid')) {
          return { rowCount: 2, rows: [{ name: 'id', type: 'uuid', not_null: true, generated: false }, { name: 'company_id', type: 'uuid', not_null: true, generated: false }] };
        }
        if (text.includes('i.indisprimary')) return { rowCount: 1, rows: [{ name: 'id' }] };
        if (text.includes('pg_constraint')) return { rowCount: 1, rows: [{ ref_table: 'companies', cols: ['company_id'], ref_cols: ['id'] }] };
        if (text.includes('information_schema.columns')) return { rowCount: 0, rows: [] };
        const held = /^SELECT 1 FROM "(\w+)" WHERE/.exec(text);
        if (held) return { rowCount: opts.heldTables.includes(held[1]!) ? 1 : 0, rows: [] };
        if (text.startsWith('INSERT INTO companies')) { inserts.push('companies'); return { rowCount: 1, rows: [] }; }
        const ins = /^INSERT INTO "(\w+)"/.exec(text);
        if (ins) { inserts.push(ins[1]!); return { rowCount: 3, rows: [] }; }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    return { db: db as unknown as ClientBase, inserts };
  }
  const opts = { sourceId: 'source', targetId: 'target', company: { name: 'Slot' } };

  it('creates the company and copies every table when the target does not exist', async () => {
    const { db, inserts } = fakeDb({ targetExists: false, heldTables: [] });
    const result = await cloneCompany(db, opts);
    expect(result.created).toBe(true);
    expect(inserts).toEqual(['companies', ...COPIED_TABLES]);
  });

  it('on a company that exists copies only the tables it holds nothing in (a top-up, never a second copy)', async () => {
    const held = COPIED_TABLES.filter((t) => t !== 'payroll_employee_components');
    const { db, inserts } = fakeDb({ targetExists: true, heldTables: [...held] });
    const result = await cloneCompany(db, opts);
    expect(result.created).toBe(false);
    expect(inserts).toEqual(['payroll_employee_components']);
    expect(Object.keys(result.copied)).toEqual(['payroll_employee_components']);
  });

  it('does nothing at all when the target already holds everything', async () => {
    const { db, inserts } = fakeDb({ targetExists: true, heldTables: [...COPIED_TABLES] });
    expect((await cloneCompany(db, opts)).copied).toEqual({});
    expect(inserts).toEqual([]);
  });

  it('refuses a source that does not exist, before writing anything', async () => {
    const { db, inserts } = fakeDb({ targetExists: false, heldTables: [], sourceExists: false });
    await expect(cloneCompany(db, opts)).rejects.toThrow(/source company source does not exist/);
    expect(inserts).toEqual([]);
  });
});
