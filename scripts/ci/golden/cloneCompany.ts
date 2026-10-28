/**
 * Copies a company's setup data (chart of accounts, settings, fiscal calendar, payroll reference data)
 * onto another company id, from the catalog's own foreign keys rather than a hand-kept column list, so a column or
 * key added by a later migration is carried without editing this file.
 *
 * Every id of a copied row, and every key that points at another copied row, becomes md5(target || ':' || old)::uuid:
 * deterministic, so a half-finished run cannot leave two generations behind, and unique per target. A key that would
 * point at another company's row (a table that is not copied) is nulled if it can be and refused if it cannot: a slot
 * must never hold a reference into the Demo company. A key into a global table (users, reference data) is kept where
 * the referenced row exists and nulled where it does not: Demo carries ids (created_by 'admin-001') that a NOT VALID
 * foreign key let in and that a new row, which is always checked, would not.
 *
 * Only setup data is copied, never transactions: a slot starts with no invoices, payments, journals or payroll runs,
 * which is what the specs' find-or-create fixtures and the reserved payroll sandbox month assume.
 */
import type { ClientBase } from 'pg';

export interface ColumnFacts { name: string; type: string; notNull: boolean; generated?: boolean }
export interface ForeignKeyFacts { columns: string[]; refTable: string; refColumns: string[] }
export interface TableFacts { table: string; columns: ColumnFacts[]; primaryKey: string[]; foreignKeys: ForeignKeyFacts[] }
/** References the catalog cannot see (a uuid column with no foreign key). */
export interface TableOverrides {
  mapped?: string[];
  nulled?: string[];
  /** WHERE for a table with no company_id of its own: rows reached through a copied parent. $2 is the company. */
  scope?: string;
}
export interface TablePlan { table: string; sql: string; scope: string; mapped: string[]; nulled: string[]; guarded: string[] }

const q = (name: string): string => `"${name}"`;
/** $1 is the target company, $2 the source. */
const rekey = (column: string, type: string): string => `(md5($1::text || ':' || ${q(column)}::text)::uuid)::${type}`;

/**
 * Builds the INSERT ... SELECT that copies one table's rows for the source company ($2) to the target ($1).
 * @param copied tables this run copies; a key into one of them is re-keyed with it
 * @param companyScoped every table with a company_id column; a key into one that is not copied is nulled or refused
 */
export function planTableClone(
  facts: TableFacts, copied: ReadonlySet<string>, companyScoped: ReadonlySet<string>, overrides: TableOverrides = {},
): TablePlan {
  const { table } = facts;
  const mapped = new Set<string>(overrides.mapped ?? []);
  const nulled = new Set<string>(overrides.nulled ?? []);
  const guarded = new Map<string, { refTable: string; refColumn: string }>();
  const nullable = (c: string) => !facts.columns.find((x) => x.name === c)?.notNull;

  if (facts.primaryKey.length === 1 && facts.primaryKey[0] !== 'company_id') mapped.add(facts.primaryKey[0]!);
  for (const fk of facts.foreignKeys) {
    const own = fk.columns.filter((c) => c !== 'company_id');
    if (fk.refTable === 'companies') {
      if (own.length) throw new Error(`${table}.${own.join(',')} references companies: only company_id may, or the copy would point at another company`);
    } else if (copied.has(fk.refTable)) {
      fk.columns.forEach((c, i) => {
        if (c === 'company_id') return;
        if (fk.refColumns[i] !== 'id') throw new Error(`${table}.${c} references ${fk.refTable}.${fk.refColumns[i]}, which is not its id, so the copy would not re-key it`);
        mapped.add(c);
      });
    } else if (companyScoped.has(fk.refTable)) {
      for (const c of own) {
        if (!nullable(c)) throw new Error(`${table}.${c} is NOT NULL and references ${fk.refTable}, which is not copied: add it to the copied tables`);
        nulled.add(c);
      }
    } else if (fk.columns.length === 1 && nullable(fk.columns[0]!)) {
      guarded.set(fk.columns[0]!, { refTable: fk.refTable, refColumn: fk.refColumns[0]! });
    }
  }

  const live = facts.columns.filter((c) => !c.generated);
  const exprs = live.map((c) => {
    if (c.name === 'company_id') return '$1::uuid';
    if (nulled.has(c.name)) return 'NULL';
    if (mapped.has(c.name)) return rekey(c.name, c.type);
    const ref = guarded.get(c.name);
    if (ref) {
      const own = `${q(table)}.${q(c.name)}`;
      return `CASE WHEN EXISTS (SELECT 1 FROM ${q(ref.refTable)} r WHERE r.${q(ref.refColumn)} = ${own}) THEN ${own} ELSE NULL END`;
    }
    return q(c.name);
  });
  const scope = overrides.scope ?? '"company_id" = $2::uuid';
  const sql = `INSERT INTO ${q(table)} (${live.map((c) => q(c.name)).join(', ')}) SELECT ${exprs.join(', ')} FROM ${q(table)} WHERE ${scope}`;
  return { table, sql, scope, mapped: live.map((c) => c.name).filter((n) => mapped.has(n)), nulled: live.map((c) => c.name).filter((n) => nulled.has(n)), guarded: [...guarded.keys()] };
}

/** Setup tables copied from the source company, parents before children. */
export const COPIED_TABLES = [
  'business_units', 'cost_centres', 'gl_accounts', 'cost_centre_gl_mappings', 'account_reporting_groups', 'customers', 'suppliers',
  'accounting_settings', 'currencies', 'company_document_numbers', 'fiscal_years', 'fiscal_periods',
  'payroll_leave_types', 'pay_scales', 'payroll_components', 'payroll_employees', 'payroll_leave_balances',
  'payroll_employee_components', 'dunning_templates',
] as const;

/**
 * Not copied on purpose: bank_categorisation_rules and bank_auto_post_settings are forensic controls (a rule that posts
 * money unattended needs a recorded approval, and the write triggers read tables the provisioner's role cannot), so a
 * copy would also be a way round them. The golden specs create their own statement lines and need no rules.
 * References the catalog cannot see (a uuid column with no foreign key) go here, per table.
 */
const OVERRIDES: Record<string, TableOverrides> = {
  // What each employee is paid (basic salary, allowances, deductions): without it a run calculates to zero.
  payroll_employee_components: { scope: '"employee_id" IN (SELECT "id" FROM "payroll_employees" WHERE "company_id" = $2::uuid)' },
};

async function readFacts(db: ClientBase, table: string): Promise<TableFacts> {
  const cols = await db.query<{ name: string; type: string; not_null: boolean; generated: boolean }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
            (a.attgenerated <> '' OR a.attidentity = 'a') AS generated
       FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [`public.${table}`]);
  if (cols.rows.length === 0) throw new Error(`table ${table} does not exist`);
  const pk = await db.query<{ name: string }>(
    `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = to_regclass($1) AND i.indisprimary`, [`public.${table}`]);
  const fks = await db.query<{ ref_table: string; cols: string[]; ref_cols: string[] }>(
    `SELECT regexp_replace(c.confrelid::regclass::text, '^public\\.', '') AS ref_table,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) AS ref_cols
       FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = to_regclass($1)`, [`public.${table}`]);
  return {
    table,
    columns: cols.rows.map((r) => ({ name: r.name, type: r.type, notNull: r.not_null, generated: r.generated })),
    primaryKey: pk.rows.map((r) => r.name),
    foreignKeys: fks.rows.map((r) => ({ columns: r.cols, refTable: r.ref_table, refColumns: r.ref_cols })),
  };
}

export interface CloneOptions {
  sourceId: string;
  targetId: string;
  /** companies columns to set on the new row (name, is_demo, ...); everything else is the source's. */
  company: Record<string, string | boolean | null>;
}

export interface CloneResult {
  /** The target company did not exist and this call created it. */
  created: boolean;
  /** Rows copied per table; a table the target already holds rows in is left alone and absent. */
  copied: Record<string, number>;
  /** Tables left alone because a parent they key into already existed (their keys would not match that parent's ids). */
  skippedChildren: string[];
}

const scopeFor = (plan: TablePlan): string => plan.scope.replaceAll('$2', '$1');
const REFERENCE_TYPES = /^(uuid|text|character varying(\(\d+\))?)$/;

/**
 * Fails when a row of the target holds the id of a source row, in ANY uuid or text column, foreign key or not: a copy
 * that still points at Demo would let a slot read or write Demo's books. The catalog's keys are re-keyed by the plan;
 * this is the check for the references the catalog cannot see. Not covered: ids buried in json columns.
 * @param tables the copied tables with the facts their plans were built from
 */
async function assertNoSourceReferences(
  db: ClientBase, opts: CloneOptions, tables: ReadonlyArray<{ facts: TableFacts; plan: TablePlan }>,
): Promise<void> {
  const ids = new Set<string>([opts.sourceId]);
  for (const { facts, plan } of tables) {
    const pk = facts.primaryKey.length === 1 ? facts.primaryKey[0] : undefined;
    if (!pk) continue;
    const rows = await db.query<{ v: string }>(`SELECT ${q(pk)}::text AS v FROM ${q(facts.table)} WHERE ${scopeFor(plan)}`, [opts.sourceId]);
    for (const r of rows.rows) ids.add(r.v);
  }
  const list = [...ids];
  const found: string[] = [];
  for (const { facts, plan } of tables) {
    const columns = facts.columns.filter((c) => !c.generated && REFERENCE_TYPES.test(c.type)).map((c) => c.name);
    for (const column of columns) {
      const hit = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${q(facts.table)} WHERE ${scopeFor(plan)} AND ${q(column)}::text = ANY($2::text[])`, [opts.targetId, list]);
      if (Number(hit.rows[0]?.n ?? 0) > 0) found.push(`${facts.table}.${column} (${hit.rows[0]!.n} rows)`);
    }
  }
  if (found.length) throw new Error(`the copy still references the source company's rows: ${found.join(', ')}; add the column to OVERRIDES (mapped or nulled)`);
}

async function insertCompanyRow(db: ClientBase, opts: CloneOptions): Promise<void> {
  const company = await readFacts(db, 'companies');
  const live = company.columns.filter((c) => !c.generated);
  const overrides = Object.entries(opts.company);
  const exprs = live.map((c) => {
    if (c.name === 'id') return '$1::uuid';
    const at = overrides.findIndex(([k]) => k === c.name);
    return at >= 0 ? `$${at + 3}::${c.type}` : q(c.name);
  });
  await db.query(
    `INSERT INTO companies (${live.map((c) => q(c.name)).join(', ')}) SELECT ${exprs.join(', ')} FROM companies WHERE id = $2::uuid`,
    [opts.targetId, opts.sourceId, ...overrides.map(([, v]) => v)]);
}

/**
 * Makes the target a copy of the source's row and setup data, and tops up a target that exists: a copied table in
 * which the target already has rows is left alone (the suite grows them), one it has none in is copied. So adding a
 * table to COPIED_TABLES reaches the slots that exist on the next run. Run it inside a transaction.
 * @throws when the source is missing or a table cannot be copied
 */
export async function cloneCompany(db: ClientBase, opts: CloneOptions): Promise<CloneResult> {
  const { sourceId, targetId } = opts;
  const src = await db.query('SELECT 1 FROM companies WHERE id = $1::uuid', [sourceId]);
  if (src.rowCount === 0) throw new Error(`source company ${sourceId} does not exist`);
  const exists = await db.query('SELECT 1 FROM companies WHERE id = $1::uuid', [targetId]);
  const created = exists.rowCount === 0;
  if (created) await insertCompanyRow(db, opts);

  const scoped = await db.query<{ table_name: string }>(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id'`);
  const companyScoped = new Set(scoped.rows.map((r) => r.table_name));
  const copied = new Set<string>(COPIED_TABLES);

  const result: Record<string, number> = {};
  const skipped = new Set<string>();
  const skippedChildren: string[] = [];
  const planned: Array<{ facts: TableFacts; plan: TablePlan }> = [];
  for (const table of COPIED_TABLES) {
    const facts = await readFacts(db, table);
    const plan = planTableClone(facts, copied, companyScoped, OVERRIDES[table]);
    planned.push({ facts, plan });
    const held = await db.query(`SELECT 1 FROM ${q(table)} WHERE ${scopeFor(plan)} LIMIT 1`, [targetId]);
    if (held.rowCount) { skipped.add(table); continue; }
    // A parent that already existed keeps its own ids; a child copied now would key into ids this run never made.
    if (facts.foreignKeys.some((fk) => skipped.has(fk.refTable))) { skipped.add(table); skippedChildren.push(table); continue; }
    result[table] = (await db.query(plan.sql, [targetId, sourceId])).rowCount ?? 0;
  }
  await assertNoSourceReferences(db, opts, planned);
  return { created, copied: result, skippedChildren };
}
