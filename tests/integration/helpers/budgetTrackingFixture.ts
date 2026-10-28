/**
 * Budgets P3 tracking engine, real PostgreSQL: two companies, A the subject and
 * B there to leak. Shared by the budget-tracking-* integration suites.
 *
 * A's registry: FY2026 Mar 2025 - Feb 2026 (12), FY2027 Mar 2026 - Apr 2027
 * (a 14-MONTH transition year), FY2028 May 2027 - Apr 2028 (12).
 *
 * A's ledger, one journal a month from Jan 2026 to Jul 2027 (19 months, so
 * windows cross both FY edges), every line in cents so a rounding slip shows:
 *   - sales tagged CC1 FT + CC2 P1 (derived) + BU B1; sales tagged HT + BU B2;
 *     sales untagged; interest (other income) BU B1 only;
 *   - COS FT + P1; opex HT + P2 + BU B2; finance cost FT + B1;
 *   - opex untagged, dated the LAST day of its month (an inclusive window end);
 *   - a legacy CROSS-TAG: opex with cc2_id = FT, a CC1-type centre, and no
 *     cc1_id, so the explicit CC1 filter and the either-level one differ;
 *   - a DRAFT journal and the YEAR-END close journal (source 'year_end') on
 *     FY2027's last day, both tagged FT so every filter would see them.
 * Inserted with session_replication_role = replica (no journal triggers), as
 * glDimensionFixture does. Disposable databases only.
 *
 * A's budgets (written normally, so 947's grain/kind/lock rules hold):
 *   FY2027 primary 'Original' (approved): sales at CC2 (P1 100, P2 50 a month),
 *   COS at CC1 (FT 40, HT 30), opex at company level (200), interest at BU
 *   (B1 5), finance cost at a chainless CC2 PN (7); FY2028 primary: opex 210;
 *   FY2027 'Reforecast' (draft, not primary): sales at company level 999.
 * B: one FY2027 primary with sales 12 345 a month on B's own centre and unit.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

const id = (): string => crypto.randomUUID();

export const FY2027_MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'];
const LEDGER_MONTHS = ['2026-01', '2026-02', ...FY2027_MONTHS, '2027-05', '2027-06', '2027-07'];
const FY2028_MONTHS = ['2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12',
  '2028-01', '2028-02', '2028-03', '2028-04'];

export interface TrackingFixture {
  a: string; b: string; userA: string; userB: string;
  acc: Record<'sales' | 'interest' | 'cos' | 'opex' | 'fin' | 'bank' | 'bSales', string>;
  cc: Record<'FT' | 'HT' | 'P1' | 'P2' | 'PN' | 'BX', string>;
  bu: Record<'B1' | 'B2' | 'BBX', string>;
  v: Record<'primary27' | 'reforecast27' | 'primary28' | 'b27', string>;
}

const monthEnd = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return `${m}-${String(days)}`;
};

type Line = [acct: string, dr: number, cr: number, tags?: { cc1?: string; cc2?: string; bu?: string }];

export async function seedTrackingFixture(pool: Pool): Promise<TrackingFixture> {
  const f: TrackingFixture = {
    a: id(), b: id(), userA: id(), userB: id(),
    acc: { sales: id(), interest: id(), cos: id(), opex: id(), fin: id(), bank: id(), bSales: id() },
    cc: { FT: id(), HT: id(), P1: id(), P2: id(), PN: id(), BX: id() },
    bu: { B1: id(), B2: id(), BBX: id() },
    v: { primary27: '', reforecast27: '', primary28: '', b27: '' },
  };
  const c = await pool.connect();
  const q = (text: string, params: unknown[] = []) => c.query(text, params);
  try {
    await q('BEGIN');
    await q('SET LOCAL session_replication_role = replica');
    await q('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, 3), ($3, $4, 3)',
      [f.a, 'BT A', f.b, 'BT B SECRET']);
    await q("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true), ($3, $4, 'admin', true)",
      [f.userA, `${f.userA}@test.local`, f.userB, `${f.userB}@test.local`]);
    await q("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
      [f.a, f.userA, f.b, f.userB]);
    for (const [aid, co, code, name, type, sub] of [
      [f.acc.sales, f.a, 'BT-4000', 'Sales', 'revenue', null],
      [f.acc.interest, f.a, 'BT-4900', 'Interest received', 'revenue', 'other_income'],
      [f.acc.cos, f.a, 'BT-5000', 'Cost of sales', 'expense', 'cost_of_sales'],
      [f.acc.opex, f.a, 'BT-6000', 'Opex', 'expense', null],
      [f.acc.fin, f.a, 'BT-7000', 'Finance cost', 'expense', 'finance_cost'],
      [f.acc.bank, f.a, 'BT-1000', 'Bank', 'asset', 'bank'],
      [f.acc.bSales, f.b, 'BT-4000', 'B Sales SECRET', 'revenue', null],
    ] as const) {
      await q(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 3, true)`, [aid, co, code, name, type, sub, ['revenue'].includes(type) ? 'credit' : 'debit']);
    }
    for (const [cid, co, code, name, parent, type] of [
      [f.cc.FT, f.a, 'BT-FT', 'Fibertime', null, 'cc1'], [f.cc.HT, f.a, 'BT-HT', 'Hometech', null, 'cc1'],
      [f.cc.P1, f.a, 'BT-P1', 'Project 1', f.cc.FT, 'cc2'], [f.cc.P2, f.a, 'BT-P2', 'Project 2', f.cc.HT, 'cc2'],
      [f.cc.PN, f.a, 'BT-PN', 'Orphan project', null, 'cc2'], [f.cc.BX, f.b, 'BT-BX', 'B SECRET CC', null, 'cc1'],
    ] as const) {
      await q('INSERT INTO cost_centres (id, company_id, code, name, parent_id, cc_type) VALUES ($1, $2, $3, $4, $5, $6)',
        [cid, co, code, name, parent, type]);
    }
    for (const [bid, co, code, name] of [[f.bu.B1, f.a, 'BT-B1', 'Unit 1'], [f.bu.B2, f.a, 'BT-B2', 'Unit 2'], [f.bu.BBX, f.b, 'BT-BBX', 'B SECRET BU']] as const) {
      await q('INSERT INTO business_units (id, company_id, code, name) VALUES ($1, $2, $3, $4)', [bid, co, code, name]);
    }

    const { acc, cc, bu } = f;
    let n = 0;
    const journal = async (co: string, date: string, status: string, source: string, lines: Line[]) => {
      const eid = id();
      n += 1;
      await q(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
               VALUES ($1, $2, $3, $4::DATE, $5, $6, 'bt', $7, NOW())`, [eid, co, `BT-${String(n).padStart(4, '0')}`, date, status, f.userA, source]);
      for (const [acct, dr, cr, t = {}] of lines) {
        await q(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, cc2_id, bu_id, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'bt')`, [id(), eid, co, acct, dr, cr, t.cc1 ?? null, t.cc2 ?? null, t.bu ?? null]);
      }
    };
    for (const [i, m] of LEDGER_MONTHS.entries()) {
      const sales1 = Math.round((1000 + i * 13.37) * 100) / 100;
      const cos = Math.round((400.5 + i * 1.01) * 100) / 100;
      const lines: Line[] = [
        [acc.sales, 0, sales1, { cc1: cc.FT, cc2: cc.P1, bu: bu.B1 }],
        [acc.sales, 0, 500.01, { cc1: cc.HT, bu: bu.B2 }],
        [acc.sales, 0, 77.77],
        [acc.interest, 0, 12.34, { bu: bu.B1 }],
        [acc.cos, cos, 0, { cc1: cc.FT, cc2: cc.P1 }],
        [acc.opex, 250.25, 0, { cc1: cc.HT, cc2: cc.P2, bu: bu.B2 }],
        [acc.opex, 33.33, 0, { cc2: cc.FT }],
        [acc.fin, 10.1, 0, { cc1: cc.FT, bu: bu.B1 }],
      ];
      const net = lines.reduce((s, [, dr, cr]) => s + cr - dr, 0);
      lines.push([acc.bank, Math.round(net * 100) / 100, 0]);
      await journal(f.a, `${m}-15`, 'posted', 'manual', lines);
      // Last day of the month: the window end is inclusive.
      await journal(f.a, monthEnd(m), 'posted', 'manual', [[acc.opex, 99.99, 0], [acc.bank, 0, 99.99]]);
    }
    await journal(f.a, '2026-05-20', 'draft', 'manual', [[acc.opex, 9999, 0, { cc1: cc.FT, bu: bu.B1 }], [acc.bank, 0, 9999]]);
    await journal(f.a, '2027-04-30', 'posted', 'year_end', [
      [acc.sales, 88888.88, 0, { cc1: cc.FT, cc2: cc.P1, bu: bu.B1 }], [acc.opex, 0, 4444.44, { cc1: cc.FT, bu: bu.B1 }], [acc.bank, 0, 84444.44],
    ]);
    await journal(f.b, '2026-06-15', 'posted', 'manual', [[acc.bSales, 0, 55555, { cc1: cc.BX, bu: bu.BBX }], [acc.bank, 55555, 0]]);
    await q('COMMIT');
  } catch (err) {
    await q('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }

  // Registry and budgets with every trigger on.
  for (const co of [f.a, f.b]) {
    await pool.query(
      `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
       VALUES ($1, 2026, '2025-03-01', '2026-02-28', 'normal'), ($1, 2027, '2026-03-01', '2027-04-30', 'transition'),
              ($1, 2028, '2027-05-01', '2028-04-30', 'normal')`, [co]);
  }
  const version = async (co: string, user: string, fy: number, name: string, kind: string, primary: boolean, approve: boolean) => {
    const vid = String((await pool.query(
      `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [co, fy, name, kind, primary, user])).rows[0].id);
    if (approve) {
      await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`, [vid, user]);
    }
    return vid;
  };
  f.v.primary27 = await version(f.a, f.userA, 2027, 'Original', 'original', true, true);
  f.v.reforecast27 = await version(f.a, f.userA, 2027, 'Reforecast 1', 'reforecast', false, false);
  f.v.primary28 = await version(f.a, f.userA, 2028, 'Original', 'original', true, true);
  f.v.b27 = await version(f.b, f.userB, 2027, 'Original', 'original', true, true);
  const amounts = async (co: string, vid: string, acct: string, months: string[], amount: number, dims: { cc1?: string; cc2?: string; bu?: string } = {}) => {
    await pool.query(
      `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id, cc2_id, bu_id)
       SELECT $1, $2, $3, (m || '-01')::DATE, $4, $5, $6, $7 FROM unnest($8::TEXT[]) AS m`,
      [co, vid, acct, amount, dims.cc1 ?? null, dims.cc2 ?? null, dims.bu ?? null, months]);
  };
  const p = f.v.primary27;
  await amounts(f.a, p, f.acc.sales, FY2027_MONTHS, 100, { cc2: f.cc.P1 });
  await amounts(f.a, p, f.acc.sales, FY2027_MONTHS, 50, { cc2: f.cc.P2 });
  await amounts(f.a, p, f.acc.cos, FY2027_MONTHS, 40, { cc1: f.cc.FT });
  await amounts(f.a, p, f.acc.cos, FY2027_MONTHS, 30, { cc1: f.cc.HT });
  await amounts(f.a, p, f.acc.opex, FY2027_MONTHS, 200);
  await amounts(f.a, p, f.acc.interest, FY2027_MONTHS, 5, { bu: f.bu.B1 });
  await amounts(f.a, p, f.acc.fin, FY2027_MONTHS, 7, { cc2: f.cc.PN });
  await amounts(f.a, f.v.primary28, f.acc.opex, FY2028_MONTHS, 210);
  await amounts(f.a, f.v.reforecast27, f.acc.sales, FY2027_MONTHS, 999);
  await amounts(f.b, f.v.b27, f.acc.bSales, FY2027_MONTHS, 12345, { cc1: f.cc.BX });
  return f;
}

export async function dropTrackingFixture(pool: Pool, f: TrackingFixture | undefined): Promise<void> {
  if (!f) return;
  const cos = [f.a, f.b];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of ['audit_log', 'budget_month_amounts', 'budget_versions', 'gl_journal_lines', 'gl_journal_entries',
      'fiscal_periods', 'fiscal_years', 'cost_centres', 'business_units', 'gl_accounts', 'company_users']) {
      await c.query(`DELETE FROM ${t} WHERE company_id = ANY($1::UUID[])`, [cos]);
    }
    await c.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [cos]);
    await c.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[f.userA, f.userB]]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Runs `fn` on one connection, as withAuth binds a request: the engine's queries
 * must run sequentially on it. `appUser` drops to app_user with company A's (or
 * `company`'s) claims, under forced RLS. Always rolled back.
 */
export async function asRequest<T>(
  pool: Pool, company: string, user: string, fn: () => Promise<T>, opts: { appUser?: boolean } = {},
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.appUser) {
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    }
    return await als.run({ client, companyId: company, userId: user, claims: { sub: user } }, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
