/**
 * Budgets P5-4 overspend alerts, real PostgreSQL: company A (the subject) and B (there to leak).
 *
 * Both: FY2027 = Mar 2026 - Feb 2027 (normal), an APPROVED primary 'Original'.
 * A's members: owner, admin, manager (and the alert recipients are owner + admin only).
 * A's budgets, every month of FY2027 (written with every trigger on, so 947's rules hold):
 *   - opex (expense) at company grain, R1 000 a month;
 *   - rent (expense) at CC1: FT R500, HT R0 (a deliberate zero budget);
 *   - sales (revenue) at company grain, R1 000 a month (never alerts).
 * B: opex at company grain, R100 a month.
 * No journals: each test posts its own inside a rolled-back request (`journal`, triggers off as the
 * tracking fixture posts), so the suites never share a ledger.
 * Disposable databases only.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

const id = (): string => crypto.randomUUID();

export const FY2027 = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
export const AS_OF = '2026-04-20';

export interface AlertFixture {
  a: string; b: string;
  ownerA: string; adminA: string; managerA: string; ownerB: string;
  acc: Record<'opex' | 'rent' | 'sales' | 'bank' | 'bOpex' | 'bBank', string>;
  cc: Record<'FT' | 'HT', string>;
  vA: string; vB: string;
}

export async function seedAlertFixture(pool: Pool): Promise<AlertFixture> {
  const f: AlertFixture = {
    a: id(), b: id(), ownerA: id(), adminA: id(), managerA: id(), ownerB: id(),
    acc: { opex: id(), rent: id(), sales: id(), bank: id(), bOpex: id(), bBank: id() },
    cc: { FT: id(), HT: id() }, vA: '', vB: '',
  };
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  await q('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, 3), ($3, $4, 3)', [f.a, 'P5A <Alerts> & Co', f.b, 'P5A B SECRET']);
  for (const u of [f.ownerA, f.adminA, f.managerA, f.ownerB]) {
    await q("INSERT INTO users (id, email, first_name, role, is_active) VALUES ($1, $2, 'Tester', 'admin', true)", [u, `${u}@test.local`]);
  }
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'manager'), ($5, $6, 'owner')`,
    [f.a, f.ownerA, f.adminA, f.managerA, f.b, f.ownerB]);
  for (const [aid, co, code, name, type] of [
    [f.acc.opex, f.a, 'P5A-6000', 'Office costs', 'expense'], [f.acc.rent, f.a, 'P5A-6100', 'Rent', 'expense'],
    [f.acc.sales, f.a, 'P5A-4000', 'Sales', 'revenue'], [f.acc.bank, f.a, 'P5A-1000', 'Bank', 'asset'],
    [f.acc.bOpex, f.b, 'P5A-6000', 'B opex SECRET', 'expense'], [f.acc.bBank, f.b, 'P5A-1000', 'B bank', 'asset'],
  ] as const) {
    await q(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, 3, true)`, [aid, co, code, name, type, type === 'revenue' ? 'credit' : 'debit']);
  }
  await q(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'FT', 'Fibertime', 'cc1'), ($2, $3, 'HT', 'Hometech', 'cc1')`,
    [f.cc.FT, f.cc.HT, f.a]);
  for (const co of [f.a, f.b]) {
    await q(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, 2027, '2026-03-01', '2027-02-28', 'normal')`, [co]);
  }
  const version = async (co: string, user: string) => {
    const vid = String((await q(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
                                VALUES ($1, 2027, 'Original', 'original', true, $2) RETURNING id`, [co, user])).rows[0].id);
    await q(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [vid, user]);
    return vid;
  };
  f.vA = await version(f.a, f.ownerA);
  f.vB = await version(f.b, f.ownerB);
  const amounts = (co: string, vid: string, acct: string, amount: number, cc1: string | null = null) => q(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
     SELECT $1, $2, $3, (m || '-01')::DATE, $4, $5 FROM unnest($6::TEXT[]) AS m`, [co, vid, acct, amount, cc1, FY2027]);
  await amounts(f.a, f.vA, f.acc.opex, 1000);
  await amounts(f.a, f.vA, f.acc.rent, 500, f.cc.FT);
  await amounts(f.a, f.vA, f.acc.rent, 0, f.cc.HT);
  await amounts(f.a, f.vA, f.acc.sales, 1000);
  await amounts(f.b, f.vB, f.acc.bOpex, 100);
  return f;
}

export async function dropAlertFixture(pool: Pool, f: AlertFixture | undefined): Promise<void> {
  if (!f) return;
  const cos = [f.a, f.b];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of ['user_notifications', 'budget_alerts', 'budget_alert_thresholds', 'budget_control_settings', 'accounting_settings',
      'audit_log', 'budget_month_amounts', 'budget_versions', 'gl_journal_lines', 'gl_journal_entries', 'fiscal_periods', 'fiscal_years',
      'cost_centres', 'gl_accounts', 'company_users']) {
      await c.query(`DELETE FROM ${t} WHERE company_id = ANY($1::UUID[])`, [cos]);
    }
    await c.query(`DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = ANY($1::UUID[]))`, [cos]);
    await c.query('DELETE FROM purchase_orders WHERE company_id = ANY($1::UUID[])', [cos]);
    await c.query('DELETE FROM suppliers WHERE company_id = ANY($1::UUID[])', [cos]);
    await c.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [cos]);
    await c.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[f.ownerA, f.adminA, f.managerA, f.ownerB]]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

type Tags = { cc1?: string };

/** A posted journal (triggers off, as the tracking fixture posts): `lines` = [account, debit, credit, tags]. */
export async function journal(c: PoolClient, co: string, date: string, user: string, lines: Array<[string, number, number, Tags?]>): Promise<string> {
  const eid = id();
  await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                 VALUES ($1, $2, $3, $4::DATE, 'posted', $5, 'p5a', 'manual', NOW())`, [eid, co, `P5A-${eid.slice(0, 8)}`, date, user]);
  for (const [acct, dr, cr, t = {}] of lines) {
    await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, description)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 'p5a')`, [id(), eid, co, acct, dr, cr, t.cc1 ?? null]);
  }
  await c.query('SET LOCAL session_replication_role = origin');
  return eid;
}

/** An approved purchase order in `date`'s month: one line on `acct`, `amount` ex-VAT (committed spend). */
export async function approvedPo(c: PoolClient, co: string, date: string, acct: string, amount: number): Promise<void> {
  const sup = id(), po = id();
  await c.query('SET LOCAL session_replication_role = replica');
  await c.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3)', [sup, co, `P5A supplier ${sup.slice(0, 6)}`]);
  await c.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status) VALUES ($1, $2, $3, $4, $5, 'approved')`,
    [po, co, `P5A-${po.slice(0, 6)}`, sup, date]);
  await c.query(`INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, line_total, gl_account_id) VALUES ($1, 'x', 1, $2, $2, $3)`,
    [po, amount, acct]);
  await c.query('SET LOCAL session_replication_role = origin');
}

/**
 * One request transaction, always rolled back: `seed` runs as the fixture's superuser first, then
 * `fn` runs as app_user with `user`'s claims in `company` (withAuth's binding). `asSuper` inside `fn`
 * steps back to the superuser for a change mid-request (a reversal, a budget raised).
 */
export async function inRequest<T>(
  pool: Pool, company: string, user: string,
  fn: (h: { client: PoolClient; asSuper: <R>(g: (c: PoolClient) => Promise<R>) => Promise<R> }) => Promise<T>,
  seed?: (c: PoolClient) => Promise<unknown>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  const appUser = async () => {
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  };
  try {
    await client.query('BEGIN');
    if (seed) await seed(client);
    await appUser();
    const asSuper = async <R>(g: (c: PoolClient) => Promise<R>): Promise<R> => {
      await client.query('RESET ROLE');
      try { return await g(client); } finally { await appUser(); }
    };
    return await als.run({ client, companyId: company, userId: user, claims: { sub: user } }, () => fn({ client, asSuper }));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
