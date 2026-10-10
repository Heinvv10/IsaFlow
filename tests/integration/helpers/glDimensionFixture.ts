/**
 * Two companies and an April-2025 ledger built to break the dimension P&L and
 * the flat GL-line export (PR #688 review round 1; the adversarial reviewer's
 * seed, extended). Company A is the subject; company B exists to leak.
 *
 * What A's ledger carries, and what each piece is for:
 *   - multi-tag lines (CC1 + CC2 + BU) and a cent-level split across FNOs;
 *   - E04: a LEGACY-only line (cost_center_id = FT, cc1_id NULL) — counts under
 *     FT, in the filter AND the cc1 grouping;
 *   - E14: a RE-TAGGED line (cc1_id = HT, cost_center_id still FT) — counts
 *     under HT only (REPRO 1); E00 the same in the PRIOR financial year, so the
 *     trial balance's retained brought forward is filtered too;
 *   - E05 / E12: B's cost centre, project and BU on A's lines (UNKNOWN members,
 *     blank in the export, never named); E05 also claims to reverse B's EB1;
 *   - E15: a line on B's revenue ACCOUNT (REPRO 3), tagged to A's project P1;
 *   - E06 draft (unbalanced on purpose), E07 reversed + E08 its reversal;
 *   - E10 / E12 / E13 on 30 April, E11 on 1 May (an inclusive period end);
 *   - E12: six lines of one entry, inserted in DESCENDING id order, so a page
 *     boundary inside it proves the keyset's line-id tiebreak;
 *   - E16: A's entry carrying lines whose company_id is B; EB2: B's entry
 *     carrying lines whose company_id is A (both scopes needed);
 *   - jobs (`projects`, the default Project Profitability basis): J1 on E02, J2
 *     on E10 and on E15's foreign-account line, B's JB on E12; J1 and J3 also on
 *     the forged E16 / EB2 lines, so a dropped scope shows; E04's creditors line
 *     carries a CC2 on a balance-sheet account only;
 *   - documents: E02 a supplier invoice (A's supplier); E09 an A invoice naming
 *     B's supplier; E10 two customer invoices; E13 an A invoice naming B's
 *     customer; B's own invoice pointing at E03;
 *   - fiscal periods: A's March closed, A's April open, B's April locked.
 *
 * Inserted with session_replication_role = replica (no triggers, no FK
 * checks), because the forged rows are exactly what the constraints would
 * refuse today and legacy data still carries. Disposable databases only.
 */
import type { Pool } from 'pg';

const id = (): string => crypto.randomUUID();
/** Ids that sort in a known order (for the keyset tiebreak arm). */
const ordered = (n: number): string => `ffffffff-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface GlDimFixture {
  a: string;
  b: string;
  aName: string;
  user: string;
  acc: Record<'sales' | 'interest' | 'cos' | 'opex' | 'dep' | 'fin' | 'bank' | 'cred' | 'bSales' | 'bBank', string>;
  cc: Record<'FT' | 'HT' | 'P1' | 'P2' | 'BX' | 'BP', string>;
  bu: Record<'B1' | 'B2' | 'BBX', string>;
  job: Record<'J1' | 'J2' | 'J3' | 'JB', string>;
  sup: Record<'sA' | 'sB', string>;
  cus: Record<'cA' | 'cB', string>;
  e: Record<string, string>;
  aprilPeriod: string;
}

type Line = [acct: string, dr: number, cr: number, tags?: { cc1?: string; cc2?: string; bu?: string; lcc?: string; job?: string; desc?: string; id?: string; co?: string }];

export async function seedGlDimensionFixture(pool: Pool, tag: string): Promise<GlDimFixture> {
  const f: GlDimFixture = {
    a: id(), b: id(), aName: `GLX A ${tag}`, user: id(),
    acc: { sales: id(), interest: id(), cos: id(), opex: id(), dep: id(), fin: id(), bank: id(), cred: id(), bSales: id(), bBank: id() },
    cc: { FT: id(), HT: id(), P1: id(), P2: id(), BX: id(), BP: id() },
    bu: { B1: id(), B2: id(), BBX: id() },
    job: { J1: id(), J2: id(), J3: id(), JB: id() },
    sup: { sA: id(), sB: id() },
    cus: { cA: id(), cB: id() },
    e: {},
    aprilPeriod: id(),
  };
  const client = await pool.connect();
  const q = (text: string, params: unknown[] = []) => client.query(text, params);
  try {
    await q('BEGIN');
    await q('SET LOCAL session_replication_role = replica');
    await q('INSERT INTO companies(id, name, financial_year_start) VALUES ($1,$2,3), ($3,$4,3)',
      [f.a, f.aName, f.b, `GLX B SECRET ${tag}`]);
    const accounts: Array<[string, string, string, string, string, string | null]> = [
      [f.acc.sales, f.a, '4000', 'Sales', 'revenue', null],
      [f.acc.interest, f.a, '4900', 'Interest received', 'revenue', 'other_income'],
      [f.acc.cos, f.a, '5000', 'COS', 'expense', 'cost_of_sales'],
      [f.acc.opex, f.a, '6000', 'Opex', 'expense', null],
      [f.acc.dep, f.a, '6100', 'Depreciation', 'expense', 'depreciation'],
      [f.acc.fin, f.a, '7000', 'Finance cost', 'expense', 'finance_cost'],
      [f.acc.bank, f.a, '1000', 'Bank', 'asset', 'bank'],
      [f.acc.cred, f.a, '2000', 'Creditors', 'liability', 'payable'],
      [f.acc.bSales, f.b, '4000', 'B Sales SECRET', 'revenue', null],
      [f.acc.bBank, f.b, '1000', 'B Bank SECRET', 'asset', 'bank'],
    ];
    for (const [aid, co, code, name, type, sub] of accounts) {
      await q(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`, [aid, co, code, name, type, sub, ['revenue', 'liability'].includes(type) ? 'credit' : 'debit']);
    }
    for (const [cid, co, code, name, parent, type] of [
      [f.cc.FT, f.a, 'FT', 'Fibertime', null, 'cc1'], [f.cc.HT, f.a, 'HT', 'Hometech', null, 'cc1'],
      [f.cc.P1, f.a, 'P1', 'Project 1', f.cc.FT, 'cc2'], [f.cc.P2, f.a, 'P2', 'Project 2', f.cc.HT, 'cc2'],
      [f.cc.BX, f.b, 'BX', 'B SECRET CC', null, 'cc1'], [f.cc.BP, f.b, 'BP', 'B SECRET PROJECT', null, 'cc2'],
    ] as const) {
      await q('INSERT INTO cost_centres(id, company_id, code, name, parent_id, cc_type) VALUES ($1,$2,$3,$4,$5,$6)',
        [cid, co, code, name, parent, type]);
    }
    for (const [bid, co, code, name] of [
      [f.bu.B1, f.a, 'B1', 'Unit 1'], [f.bu.B2, f.a, 'B2', 'Unit 2'], [f.bu.BBX, f.b, 'BBX', 'B SECRET BU'],
    ] as const) {
      await q('INSERT INTO business_units(id, company_id, code, name) VALUES ($1,$2,$3,$4)', [bid, co, code, name]);
    }
    for (const [jid, co, num, name] of [
      [f.job.J1, f.a, 'J-1', 'Job One'], [f.job.J2, f.a, 'J-2', 'Job Two'], [f.job.J3, f.a, 'J-3', 'Job Three'],
      [f.job.JB, f.b, 'J-B', 'B SECRET JOB'],
    ] as const) {
      await q('INSERT INTO projects(id, company_id, project_number, name) VALUES ($1,$2,$3,$4)', [jid, co, num, name]);
    }
    await q(`INSERT INTO suppliers(id, company_id, name, vat_number) VALUES ($1,$2,'Acme Supplies','4999999999'),
             ($3,$4,'B SECRET SUPPLIER','4000000001')`, [f.sup.sA, f.a, f.sup.sB, f.b]);
    await q(`INSERT INTO customers(id, company_id, name, vat_number) VALUES ($1,$2,'Jane Private','4123456789'),
             ($3,$4,'B SECRET CUSTOMER','4000000002')`, [f.cus.cA, f.a, f.cus.cB, f.b]);
    await q(`INSERT INTO fiscal_periods(company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
             VALUES ($1,'Mar 2025',1,2026,'2025-03-01','2025-03-31','closed'),
                    ($2,'B Apr 2025',2,2026,'2025-04-01','2025-04-30','locked')`, [f.a, f.b]);
    await q(`INSERT INTO fiscal_periods(id, company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
             VALUES ($1,$2,'Apr 2025',2,2026,'2025-04-01','2025-04-30','open')`, [f.aprilPeriod, f.a]);

    const { acc, cc, bu, job } = f;
    const entries: Array<[key: string, co: string, date: string, status: string, lines: Line[], reversalOf?: string]> = [
      ['EB1', f.b, '2025-04-15', 'posted', [[acc.bBank, 5000, 0], [acc.bSales, 0, 5000, { cc1: cc.BX, desc: 'B SECRET LINE' }]]],
      ['E00', f.a, '2025-02-15', 'posted', [[acc.opex, 50, 0, { cc1: cc.HT, lcc: cc.FT }], [acc.bank, 0, 50]]],
      ['E01', f.a, '2025-03-31', 'posted', [[acc.bank, 1000, 0], [acc.sales, 0, 1000, { cc1: cc.FT, cc2: cc.P1, bu: bu.B1, desc: '=HYPERLINK("http://x","y")' }]]],
      ['E02', f.a, '2025-04-01', 'posted', [[acc.opex, 300, 0, { cc1: cc.HT, cc2: cc.P2, bu: bu.B2, job: job.J1, desc: '+cmd' }], [acc.cos, 200, 0, { cc1: cc.FT }], [acc.cred, 0, 500]]],
      ['E03', f.a, '2025-04-15', 'posted', [[acc.bank, 50, 0, { desc: '|cmd' }], [acc.interest, 0, 50, { desc: '@SUM(A1)' }]]],
      ['E04', f.a, '2025-04-20', 'posted', [[acc.dep, 70, 0, { lcc: cc.FT }], [acc.cred, 0, 70, { cc2: cc.HT }]]],
      ['E05', f.a, '2025-04-25', 'posted', [[acc.fin, 30, 0, { cc1: cc.BX, bu: bu.BBX }], [acc.bank, 0, 30]], 'EB1'],
      ['E06', f.a, '2025-04-26', 'draft', [[acc.opex, 999, 0, { cc1: cc.FT }], [acc.bank, 0, 990]]],
      ['E07', f.a, '2025-04-27', 'reversed', [[acc.opex, 111, 0, { cc1: cc.FT }], [acc.bank, 0, 111]]],
      ['E08', f.a, '2025-04-28', 'posted', [[acc.bank, 111, 0], [acc.opex, 0, 111, { cc1: cc.FT }]], 'E07'],
      ['E09', f.a, '2025-04-29', 'posted', [[acc.opex, 40, 0, { cc1: cc.FT, cc2: cc.P2 }], [acc.bank, 0, 40, { cc2: cc.P2 }]]],
      ['E10', f.a, '2025-04-30', 'posted', [[acc.sales, 100, 0, { cc2: cc.P1, job: job.J2 }], [acc.bank, 0, 100]]],
      ['E11', f.a, '2025-05-01', 'posted', [[acc.bank, 7.77, 0], [acc.sales, 0, 7.77, { cc1: cc.FT }]]],
      ['E12', f.a, '2025-04-30', 'posted', [
        [acc.opex, 5, 0, { id: ordered(6) }], [acc.opex, 4, 0, { id: ordered(5) }], [acc.opex, 3, 0, { id: ordered(4) }],
        [acc.opex, 2, 0, { id: ordered(3) }], [acc.opex, 1, 0, { cc2: cc.BP, job: job.JB, id: ordered(2) }], [acc.bank, 0, 15, { id: ordered(1) }]]],
      ['E13', f.a, '2025-04-30', 'posted', [[acc.opex, 0.01, 0, { cc1: cc.FT }], [acc.opex, 0.01, 0, { cc1: cc.HT }], [acc.opex, 0.01, 0], [acc.bank, 0, 0.03]]],
      ['E14', f.a, '2025-04-10', 'posted', [[acc.opex, 500, 0, { cc1: cc.HT, lcc: cc.FT, desc: 'retagged FT->HT' }], [acc.bank, 0, 500]]],
      ['E15', f.a, '2025-04-16', 'posted', [[acc.bSales, 0, 9, { cc2: cc.P1, job: job.J2 }], [acc.bank, 9, 0]]],
      ['E16', f.a, '2025-04-12', 'posted', [[acc.opex, 1000, 0, { cc1: cc.FT, cc2: cc.P1, bu: bu.B1, job: job.J1, co: f.b }], [acc.bank, 0, 1000, { job: job.J3, co: f.b }]]],
      ['EB2', f.b, '2025-04-12', 'posted', [[acc.opex, 2000, 0, { cc1: cc.FT, cc2: cc.P1, bu: bu.B1, job: job.J1, co: f.a }], [acc.bank, 0, 2000, { job: job.J3, co: f.a }]]],
    ];
    let n = 0;
    for (const [key, co, date, status, lines, reversalOf] of entries) {
      const eid = id();
      f.e[key] = eid;
      n += 1;
      await q(`INSERT INTO gl_journal_entries(id, company_id, entry_number, entry_date, status, reversal_of_id, created_by,
                 description, source, reference, created_at)
               VALUES ($1,$2,$3,$4::DATE,$5,$6,$7,$8,'manual',$9, NOW())`,
        [eid, co, `GLX-${tag}-${String(n).padStart(3, '0')}`, date, status, reversalOf ? f.e[reversalOf] : null,
          f.user, `glx ${key}`, `REF-${key}`]);
      for (const [acct, dr, cr, t = {}] of lines) {
        await q(`INSERT INTO gl_journal_lines(id, journal_entry_id, company_id, gl_account_id, debit, credit,
                   cc1_id, cc2_id, bu_id, cost_center_id, project_id, description)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [t.id ?? id(), eid, t.co ?? co, acct, dr, cr, t.cc1 ?? null, t.cc2 ?? null, t.bu ?? null, t.lcc ?? null,
            t.job ?? null, t.desc ?? key]);
      }
    }
    await q(`INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, created_by, gl_journal_entry_id)
             VALUES ($1,'SI-0002',$2,'2025-04-01',$3,$4), ($1,'SI-0009',$5,'2025-04-29',$3,$6),
                    ($7,'B-SECRET-INV',$5,'2025-04-15',$3,$8)`,
      [f.a, f.sup.sA, f.user, f.e.E02, f.sup.sB, f.e.E09, f.b, f.e.E03]);
    await q(`INSERT INTO customer_invoices(company_id, invoice_number, customer_id, client_id, created_by, gl_journal_entry_id)
             VALUES ($1,'INV-0010B',$2,$2,$3,$4), ($1,'INV-0010A',$2,$2,$3,$4), ($1,'INV-0013',$5,$5,$3,$6)`,
      [f.a, f.cus.cA, f.user, f.e.E10, f.cus.cB, f.e.E13]);
    await q('COMMIT');
  } catch (err) {
    await q('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return f;
}

export async function dropGlDimensionFixture(pool: Pool, f: GlDimFixture | undefined): Promise<void> {
  if (!f) return;
  const client = await pool.connect();
  const cos = [f.a, f.b];
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    for (const t of ['gl_journal_lines', 'gl_journal_entries', 'supplier_invoices', 'customer_invoices', 'suppliers',
      'customers', 'projects', 'fiscal_periods', 'cost_centres', 'business_units', 'gl_accounts']) {
      await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::UUID[])`, [cos]);
    }
    await client.query('DELETE FROM companies WHERE id = ANY($1::UUID[])', [cos]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
