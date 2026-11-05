/**
 * Budgets P5-2b round 4 (breaker round 3; coordinator's rulings, 2026-11-04), real PostgreSQL as app_user:
 *   - R3-4: the MANUAL provisional attach (`provisionalEvidenceAttach`) makes a draft slip bill's blank lines inherit
 *     the provisional's dimensions (same rule), so block approves it on the provisional's slice instead of refusing it
 *     off-slice; with an approval request bound (pending or approved) nothing is inherited, the digest does not move,
 *     and the attach says why;
 *   - the capture case where the plan read no provisional but the attach links one: the same rule, at the attach;
 *   - R3-2: a supplier default the dimension rules refuse is the capture plan's refusal even when the line would
 *     inherit, so the attach's re-plan never meets it (the wire status: budgets-p5-off-slice-capture-route.int.test.ts).
 * Fixture: opex BB-6100 at CC1 FT 1 000 / HT 0 a month (FY2027). Fixture route: isaflow_schema_fixture. Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../pages/api/accounting/supplier-invoices-action';
import { attachDocumentToProvisional } from '@/modules/accounting/services/capture/provisionalEvidenceAttach';
import { insertCaptureBillLines, planCaptureBillLines } from '@/modules/accounting/services/capture/captureBillLines';
import { attachEvidenceAndSettleApproved } from '@/modules/accounting/services/capture/provisionalAttachSettle';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  billState, callRoute, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture,
} from './helpers/budgetBillFixture';
import { billLineCc1, seedUnevidencedProvisional } from './helpers/budgetSlipFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
const S0 = crypto.randomUUID();
const S3 = crypto.randomUUID();

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice-attach');
  await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'S0 no default', true), ($3, $2, 'S3', true)", [S0, f.co, S3]);
  // S3 defaults a project whose FNO is inactive: the dimension rules refuse it (breaker 10b / R3-2).
  const fno = crypto.randomUUID();
  const proj = crypto.randomUUID();
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'FNO-X', 'Old FNO', 'cc1'),
                      ($2, $3, 'PRJ-X', 'Project X', 'cc2')`, [fno, proj, f.co]);
  await pool.query('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [proj, fno]);
  await pool.query('INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc2_id) VALUES ($1, $2, $3)', [f.co, S3, proj]);
  await pool.query('UPDATE cost_centres SET is_active = false WHERE id = $1', [fno]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::TEXT[])', [[f.owner, f.manager].map((u) => `supplier-invoice-action:${u}`)]);
    await pool.query('DELETE FROM approval_requests WHERE company_id = $1', [f.co]);
    await pool.query('DELETE FROM supplier_coding_rules WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, f, f.owner);
  try { const out = await r.run(fn); await r.commit(); return out; } finally { await r.rollback(); }
}
const approve = (invoiceId: string) =>
  callRoute(actionRoute as never, f, f.manager, '/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId });
const digest = async (bill: string) => String((await pool.query("SELECT approval_document_digest($1, 'supplier_invoice', $2) AS d", [f.co, bill])).rows[0].d);
/** A captured slip and a draft S0 bill raised from it (one blank 800 opex line), not yet attached to anything. */
async function slipDraft(date: string): Promise<{ bill: string; doc: string }> {
  const doc = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800 }], { date });
  await pool.query('UPDATE supplier_invoices SET supplier_id = $2, source_document_id = $3 WHERE id = $1', [bill, S0, doc]);
  return { bill, doc };
}

describe('R3-4: the manual attach inherits on a draft slip bill with no approval request', () => {
  it('blank line takes FT at the attach; block approves it (paid)', async () => {
    await setPolicy(pool, f, 'block');
    const je = await seedUnevidencedProvisional(pool, f, '2026-04-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-04-12');
    const out = await asOwner(() => attachDocumentToProvisional(f.co, je, doc));
    expect(out).toMatchObject({ kind: 'attached', slipInheritance: [{ invoiceId: bill, inheritedLines: 1 }] });
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
    const r = await approve(bill);
    expect({ code: r.statusCode, status: (await billState(pool, bill)).status }).toEqual({ code: 200, status: 'paid' });
  });

  it('an approval request bound (pending): nothing inherited, the digest unchanged, the attach says why', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-05-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-05-12');
    await pool.query(`INSERT INTO approval_requests(company_id,document_type,document_id,status,requested_by,requested_at,document_digest,required_role)
                      VALUES ($1,'supplier_invoice',$2,'pending',$3,now(),approval_document_digest($1,'supplier_invoice',$2),'owner')`, [f.co, bill, f.manager]);
    const before = await digest(bill);
    const out = await asOwner(() => attachDocumentToProvisional(f.co, je, doc));
    expect(out).toMatchObject({ kind: 'attached', slipInheritance: [{ invoiceId: bill, skipped: expect.stringMatching(/approval request/) }] });
    expect(await billLineCc1(pool, bill)).toEqual([null]);
    expect(await digest(bill)).toBe(before);
  });
});

describe('the manual attach: a line carrying exactly the supplier\'s defaults counts as blank (Codex review of c5a5ded7f)', () => {
  /** A draft slip bill on `supplier` whose one 800 opex line carries CC1 `cc1` (what a capture with no provisional stores). */
  async function slipDraftOn(supplier: string, date: string, cc1: string) {
    const { bill, doc } = await slipDraft(date);
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [bill, supplier]);
    await pool.query('UPDATE supplier_invoice_items SET cc1_id = $2 WHERE supplier_invoice_id = $1', [bill, cc1]);
    return { bill, doc };
  }

  it('supplier default HT on the line: it inherits the provisional\'s FT, so bill and reclass share a slice', async () => {
    const SD = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'SD default HT', true)", [SD, f.co]);
    await pool.query('INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc1_id) VALUES ($1, $2, $3)', [f.co, SD, f.cc.HT]);
    const je = await seedUnevidencedProvisional(pool, f, '2026-03-10', [{ amount: 800, cc1: f.cc.FT }], SD);
    const { bill, doc } = await slipDraftOn(SD, '2026-03-12', f.cc.HT);
    const out = await asOwner(() => attachDocumentToProvisional(f.co, je, doc));
    expect(out).toMatchObject({ kind: 'attached', slipInheritance: [{ invoiceId: bill, inheritedLines: 1 }] });
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
  });

  it('a line naming a dimension that is not the supplier\'s default keeps it', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-01-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraftOn(S0, '2026-01-12', f.cc.HT);
    const out = await asOwner(() => attachDocumentToProvisional(f.co, je, doc));
    expect(out).toMatchObject({ kind: 'attached', slipInheritance: [{ invoiceId: bill, inheritedLines: 0 }] });
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.HT]);
  });
});

describe('R3-4: the manual attach leaves a bill that is not a draft alone', () => {
  it('an approved slip bill (no journal yet): not taken, nothing inherited, the digest unchanged', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-08-10', [{ amount: 800, cc1: f.cc.FT }], S0);
    const { bill, doc } = await slipDraft('2026-08-12');
    await pool.query("UPDATE supplier_invoices SET status = 'approved' WHERE id = $1", [bill]);
    const before = await digest(bill);
    const out = await asOwner(() => attachDocumentToProvisional(f.co, je, doc));
    // Only drafts are taken by the attach (review round 7): an approved bill is neither locked nor listed.
    expect(out).toMatchObject({ kind: 'attached', slipInheritance: [] });
    expect(await billLineCc1(pool, bill)).toEqual([null]);
    expect(await digest(bill)).toBe(before);
  });
});

describe('capture: the plan read no provisional, the attach linked one', () => {
  it('the blank line inherits at the attach (S0, no default)', async () => {
    const doc = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
    const bill = await makeBill(pool, f, [], { date: '2026-06-11' });
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = 800, tax_amount = 120, total_amount = 920, source_document_id = $3 WHERE id = $1', [bill, S0, doc]);
    const slip = await asOwner(async () => {
      const p = await planCaptureBillLines(f.co, { supplierId: S0, invoiceNumber: 'X', invoiceDate: '2026-06-11', totalAmount: 920, taxAmount: 120, taxRate: 15, items: [] } as never, 0, f.acc.opex, null);
      if (!('lines' in p)) throw new Error(JSON.stringify(p));
      expect(p.lines.map((l) => l.cc1Id ?? null)).toEqual([null]);
      return insertCaptureBillLines(bill, p.lines);
    });
    const je = await seedUnevidencedProvisional(pool, f, '2026-06-12', [{ amount: 800, cc1: f.cc.FT }], S0); // appears after the plan
    const out = await asOwner(() => attachEvidenceAndSettleApproved({
      companyId: f.co, userId: f.owner, documentId: doc, invoiceId: bill, invoiceStatus: 'draft',
      supplierId: S0, totalAmount: 920, invoiceDate: '2026-06-11', postUnattached: true, slip,
    }));
    expect(out.attachedJeId).toBe(je);
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
  });
});

describe('capture, auto-approved, the plan read no provisional, the attach linked one (Codex review of 56405f167)', () => {
  it('approved but not yet posted: its blank line inherits FT, so the posting and the reclass land on the same slice (block)', async () => {
    await setPolicy(pool, f, 'block');
    const doc = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
    const bill = await makeBill(pool, f, [], { date: '2026-09-11', status: 'approved' });
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = 800, tax_amount = 120, total_amount = 920, source_document_id = $3 WHERE id = $1', [bill, S0, doc]);
    const slip = await asOwner(async () => {
      const p = await planCaptureBillLines(f.co, { supplierId: S0, invoiceNumber: 'X', invoiceDate: '2026-09-11', totalAmount: 920, taxAmount: 120, taxRate: 15, items: [] } as never, 0, f.acc.opex, null);
      if (!('lines' in p)) throw new Error(JSON.stringify(p));
      return insertCaptureBillLines(bill, p.lines);
    });
    const je = await seedUnevidencedProvisional(pool, f, '2026-09-12', [{ amount: 800, cc1: f.cc.FT }], S0); // after the plan
    const out = await asOwner(() => attachEvidenceAndSettleApproved({
      companyId: f.co, userId: f.owner, documentId: doc, invoiceId: bill, invoiceStatus: 'approved',
      supplierId: S0, totalAmount: 920, invoiceDate: '2026-09-11', postUnattached: true, slip,
    }));
    expect(out.attachedJeId).toBe(je);
    expect(await billLineCc1(pool, bill)).toEqual([f.cc.FT]);
    expect({ refused: out.settlementRefused ?? null, status: (await billState(pool, bill)).status }).toEqual({ refused: null, status: 'paid' });
  });
});

describe('R-035 guard on the capture re-plan (round 7): the bill must be unposted with no approval request bound', () => {
  /** A capture bill on S0 (no default) whose plan read no provisional; `prepare` runs before the attach links one. */
  async function capture(date: string, prepare: (bill: string) => Promise<void>) {
    const doc = crypto.randomUUID();
    await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
    const bill = await makeBill(pool, f, [], { date });
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2, subtotal = 800, tax_amount = 120, total_amount = 920, source_document_id = $3 WHERE id = $1', [bill, S0, doc]);
    const slip = await asOwner(async () => {
      const p = await planCaptureBillLines(f.co, { supplierId: S0, invoiceNumber: 'X', invoiceDate: date, totalAmount: 920, taxAmount: 120, taxRate: 15, items: [] } as never, 0, f.acc.opex, null);
      if (!('lines' in p)) throw new Error(JSON.stringify(p));
      return insertCaptureBillLines(bill, p.lines);
    });
    await seedUnevidencedProvisional(pool, f, date, [{ amount: 800, cc1: f.cc.FT }], S0);
    await prepare(bill);
    const before = await digest(bill);
    const out = await asOwner(() => attachEvidenceAndSettleApproved({
      companyId: f.co, userId: f.owner, documentId: doc, invoiceId: bill, invoiceStatus: 'draft',
      supplierId: S0, totalAmount: 920, invoiceDate: date, postUnattached: true, slip,
    }));
    return { bill, out, before };
  }

  it('an approval request bound (pending): the attach links the provisional but no line moves, the digest unchanged', async () => {
    const { bill, out, before } = await capture('2026-10-11', async (b) => {
      await pool.query(`INSERT INTO approval_requests(company_id,document_type,document_id,status,requested_by,requested_at,document_digest,required_role)
                        VALUES ($1,'supplier_invoice',$2,'pending',$3,now(),approval_document_digest($1,'supplier_invoice',$2),'owner')`, [f.co, b, f.manager]);
    });
    expect(out.attachedJeId).not.toBeNull();
    expect(await billLineCc1(pool, bill)).toEqual([null]);
    expect(await digest(bill)).toBe(before);
  });

  it('a bill that has already posted: no line moves', async () => {
    const { bill, out } = await capture('2026-11-11', async (b) => {
      const je = crypto.randomUUID();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source)
                       VALUES ($1, $2, $3, '2026-11-11', 'posted', $4, 'posted bill', 'auto_supplier_invoice')`, [je, f.co, `R7-${je.slice(0, 6)}`, f.owner]);
        await c.query('UPDATE supplier_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [b, je]);
        await c.query('COMMIT');
      } finally { c.release(); }
    });
    expect(out.attachedJeId).not.toBeNull();
    expect(await billLineCc1(pool, bill)).toEqual([null]);
  });
});

describe('R3-2: a supplier default the dimension rules refuse is the plan\'s refusal, even when the line would inherit', () => {
  it('S3 with a provisional to inherit from: the same refusal as without one, before any write (the re-plan cannot meet it)', async () => {
    const plan = (date: string) => asOwner(() => planCaptureBillLines(f.co, { supplierId: S3, invoiceNumber: 'X', invoiceDate: date, totalAmount: 920, taxAmount: 120, taxRate: 15, items: [] } as never, 0, f.acc.opex, null));
    const without = await plan('2026-02-01');
    await seedUnevidencedProvisional(pool, f, '2026-07-10', [{ amount: 800, cc1: f.cc.FT }], S3);
    const withProvisional = await plan('2026-07-11');
    expect(without).toEqual({ refusal: expect.stringMatching(/CC1|cost centre/i) });
    expect(withProvisional).toEqual(without);
  });
});
