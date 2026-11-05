/**
 * Budgets P5-2b: a slip bill's blank draft lines inherit the bank-first provisional's dimensions WHEN THE DRAFT IS
 * WRITTEN (here MCP update_supplier_invoice, `supplierInvoiceDraftUpdateGuards.planLines`), never at approve or Post
 * to GL (coordinator's ruling on breaker round 2, 2026-11-04: migration 873 hashes the lines' dimensions into the
 * R-035 digest, so a write at approve broke an approved request, breaker test A). Ports of breaker tests A (with its
 * Post to GL variant), B, C and D. Real PostgreSQL as app_user. Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0 a
 * month (FY2027). Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import bulkRoute from '../../pages/api/accounting/supplier-invoices-bulk-action';
import { updateSupplierInvoiceTool } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { billLineCc1, makeSlipBill, postedOpexBySlice, seedSlipProvisional } from './helpers/budgetSlipFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;

beforeAll(async () => { f = await seedBillFixture(pool, 'off-slice-prov'); }, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])',
      [[f.owner, f.manager].flatMap((u) => [`supplier-invoice-action:${u}`, `supplier-invoice-bulk:${u}`])]);
    await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

const approve = (invoiceId: string, extra: Record<string, unknown> = {}, user = f.manager) =>
  callRoute(actionRoute as never, f, user, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId, ...extra });
const digest = async (bill: string) => String((await pool.query(
  "SELECT approval_document_digest($1, 'supplier_invoice', $2) AS d", [f.co, bill])).rows[0].d);
/** The draft write: MCP update_supplier_invoice replacing the lines with blank opex lines of these nets, as the manager. */
async function rewriteLines(bill: string, nets: number[]): Promise<Record<string, unknown>> {
  const r = await openRequest(pool, f, f.manager);
  try {
    const ctx = { companyId: f.co, userId: f.manager, companyRole: 'manager', scopes: ['write:invoices'], tokenJti: 'p52b', oauthAppId: null };
    const res = await r.run(() => updateSupplierInvoiceTool.handler({
      invoice_id: bill, idempotency_key: `p52b-${crypto.randomUUID()}`,
      lines: nets.map((n, i) => ({ description: `line ${i + 1}`, quantity: 1, unit_price: n, gl_account_id: f.acc.opex })),
    }, ctx as never));
    if (res.isError) throw new Error(res.content[0]!.text);
    await r.commit();
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  } finally { await r.rollback(); }
}
/** A slip bill raised from a fresh provisional (`opex` lines), its lines then rewritten blank at `nets`. */
async function draft(date: string, opex: Array<{ amount: number; cc1: string | null }>, nets: number[]): Promise<string> {
  const doc = await seedSlipProvisional(pool, f, date, opex);
  const bill = await makeSlipBill(pool, f, doc, date.slice(0, 8) + '12');
  await rewriteLines(bill, nets);
  return bill;
}
/** R-035 enforcement on bills, with an APPROVED request bound to the bill's current digest. */
async function enforceAndApproveRequest(bill: string): Promise<void> {
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
                    VALUES (gen_random_uuid(),$1,'p52b any','supplier_invoice','amount','any',0,'owner',true)`, [f.co]);
  await pool.query(`INSERT INTO approval_enforcement (company_id, document_type, enabled_by) VALUES ($1, 'supplier_invoice', 'p52b')`, [f.co]);
  await pool.query(`INSERT INTO approval_requests(company_id,document_type,document_id,status,requested_by,requested_at,decided_by,decided_at,document_digest,required_role)
                    VALUES ($1,'supplier_invoice',$2,'approved',$3,now(),$4,now(),approval_document_digest($1,'supplier_invoice',$2),'owner')`,
  [f.co, bill, f.manager, f.owner]);
}
const unenforce = async () => {
  await pool.query("DELETE FROM approval_enforcement WHERE document_type <> 'pay_run' AND company_id = $1", [f.co]);
  await pool.query("DELETE FROM approval_rules WHERE document_type <> 'pay_run' AND company_id = $1", [f.co]);
};

describe('the draft write inherits; approve reads the stored lines', () => {
  it('blank 800 against FT 800: the draft line stores FT; approve (block) posts FT, settles, and the month nets 800 on FT', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await draft('2026-04-10', [{ amount: 800, cc1: f.cc.FT }], [800]);
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
    const r = await approve(bill);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect((await billState(pool, bill)).status).toBe('paid');
    expect(await postedOpexBySlice(pool, f, '2026-04')).toEqual({ [f.cc.FT]: 800 });
  });

  it('breaker A: an approved request bound to the draft\'s digest clears approve (200, paid); the digest never moves', async () => {
    await setPolicy(pool, f, 'off');
    const bill = await draft('2026-05-10', [{ amount: 800, cc1: f.cc.FT }], [800]);
    await enforceAndApproveRequest(bill);
    const before = await digest(bill);
    try {
      const r = await approve(bill, {}, f.owner);
      expect({ code: r.statusCode, err: r.body.error?.message ?? null, status: (await billState(pool, bill)).status })
        .toEqual({ code: 200, err: null, status: 'paid' });
    } finally { await unenforce(); }
    expect(await digest(bill)).toBe(before);
    expect(await postedOpexBySlice(pool, f, '2026-05')).toEqual({ [f.cc.FT]: 800 });
  });

  it('breaker A, Post to GL: an approved slip bill whose line names nothing is posted as stored; its approved content is unchanged', async () => {
    await setPolicy(pool, f, 'warn');
    const doc = await seedSlipProvisional(pool, f, '2026-06-10', [{ amount: 800, cc1: f.cc.FT }]);
    const bill = await makeSlipBill(pool, f, doc, '2026-06-12', null, 'approved');
    const before = await digest(bill);
    const r = await callRoute(bulkRoute as never, f, f.manager, '/api/accounting/supplier-invoices-bulk-action', { action: 'post_gl', invoiceIds: [bill] });
    expect((r.body.data as { results: Array<{ ok: boolean }> }).results, JSON.stringify(r.body)).toEqual([expect.objectContaining({ ok: true })]);
    expect(await digest(bill)).toBe(before);
    expect(await billLineCc1(pool, bill)).toEqual([null]);
  });

  it('breaker B: a provisional CC1+CC2 whose project was re-parented since: nothing inherited; approve 200 (warn, reason)', async () => {
    await setPolicy(pool, f, 'warn');
    const P = crypto.randomUUID();
    await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type, parent_id, is_active) VALUES ($1,$2,'PRJ','Project','cc2',$3,true)`, [P, f.co, f.cc.FT]);
    const doc = await seedSlipProvisional(pool, f, '2026-07-10', [{ amount: 800, cc1: f.cc.FT, cc2: P }]);
    await pool.query('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [P, f.cc.HT]); // the project moved to HT
    const bill = await makeSlipBill(pool, f, doc, '2026-07-12');
    await rewriteLines(bill, [800]);
    expect(await billLineCc1(pool, bill)).toEqual([null]);
    const r = await approve(bill, { budgetReason: 'r' });
    expect({ code: r.statusCode, err: r.body.error?.message ?? null }).toEqual({ code: 200, err: null });
  });

  it('a provisional project with no CC1 (derivation would add the FNO): nothing inherited', async () => {
    await setPolicy(pool, f, 'warn');
    const P = crypto.randomUUID();
    await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type, parent_id, is_active) VALUES ($1,$2,'PRJ2','Project 2','cc2',$3,true)`, [P, f.co, f.cc.FT]);
    const doc = await seedSlipProvisional(pool, f, '2027-01-10', [{ amount: 800, cc1: null, cc2: P }]);
    const bill = await makeSlipBill(pool, f, doc, '2027-01-12');
    await rewriteLines(bill, [800]);
    expect(await billLineCc1(pool, bill)).toEqual([null]);
  });

  it('breaker C: one FT 100 provisional line against blank lines of 800 and 50: nothing inherited, at the draft write or at approve', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await draft('2026-08-10', [{ amount: 100, cc1: f.cc.FT }], [800, 50]);
    expect(await billLineCc1(pool, bill)).toEqual([null, null]);
    const r = await approve(bill, { budgetReason: 'r' });
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await billLineCc1(pool, bill)).toEqual([null, null]); // approve inherits nothing either
  });

  it('breaker D: FT 400 + FT 400 against a blank 800: FT inherited; approve 200 in block', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await draft('2026-09-10', [{ amount: 400, cc1: f.cc.FT }, { amount: 400, cc1: f.cc.FT }], [800]);
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
    const r = await approve(bill);
    expect({ code: r.statusCode, err: r.body.error?.message ?? null }).toEqual({ code: 200, err: null });
  });

  it('the MCP result lists the inherited lines and the provisional they came from (round 4, LOW 5)', async () => {
    const doc = await seedSlipProvisional(pool, f, '2027-02-10', [{ amount: 500, cc1: f.cc.FT }, { amount: 300, cc1: null }]);
    const je = String((await pool.query('SELECT id FROM gl_journal_entries WHERE source_document_id = $1', [doc])).rows[0].id);
    const bill = await makeSlipBill(pool, f, doc, '2027-02-12');
    const out = await rewriteLines(bill, [300, 500]);
    expect(out.inherited_dimensions).toEqual([{ line: 2, cc1_id: f.cc.FT, cc2_id: null, bu_id: null, provisional_id: je }]);
    const other = await makeSlipBill(pool, f, doc, '2027-02-12');
    expect((await rewriteLines(other, [400, 400])).inherited_dimensions).toBeUndefined(); // nothing matches: nothing listed
  });

  it('FT 500 + HT 300 against blank 500 + 300: each line its own (300 HT, 500 FT)', async () => {
    await setPolicy(pool, f, 'warn');
    const bill = await draft('2026-10-10', [{ amount: 500, cc1: f.cc.FT }, { amount: 300, cc1: f.cc.HT }], [500, 300]);
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.HT, f.cc.FT]); // ordered by line_total
  });

  it('a provisional centre since deactivated is not inherited', async () => {
    await setPolicy(pool, f, 'warn');
    const old = crypto.randomUUID();
    await pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $2, 'OLD', 'Retired', 'cc1')", [old, f.co]);
    const doc = await seedSlipProvisional(pool, f, '2026-11-10', [{ amount: 800, cc1: old }]);
    await pool.query('UPDATE cost_centres SET is_active = false WHERE id = $1', [old]);
    const bill = await makeSlipBill(pool, f, doc, '2026-11-12');
    await rewriteLines(bill, [800]);
    expect(await billLineCc1(pool, bill)).toEqual([null]);
  });
});
