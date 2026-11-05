/**
 * Budgets P5-2b review round 5 (MEDIUM; breaker R3-2 / R4-3): the wire status, through the REAL ai-invoice-pipeline route
 * (withAuth: app_user, GUCs, COMMIT on a 4xx, ROLLBACK on a 5xx). A supplier whose default dimension the rules refuse
 * (a project under an inactive FNO), capturing a slip a bank-first provisional on FT will evidence: the line plan
 * resolves the supplier's defaults for every line, the inheriting one too, so the refusal is the plan's 400 BEFORE any
 * write (no bill, the slip unclaimed). Before, the plan inherited FT and never judged the default, and the attach's
 * re-plan could meet it later (a 500, or a rollback-only answer withAuth turns into a 500).
 * Fixture: `budgetBillFixture.ts`. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { dropBillFixture, openRequest, seedBillFixture, type BillFixture } from './helpers/budgetBillFixture';
import { planCaptureBillLines } from '@/modules/accounting/services/capture/captureBillLines';
import { seedUnevidencedProvisional } from './helpers/budgetSlipFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: BillFixture;
let token = '';
const S3 = crypto.randomUUID();
const S3_NAME = 'Refusedco Holdings';
// checkAiRateLimit keys on the IP with a persistent counter: one address per run.
const clientIp = `127.6.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

beforeAll(async () => {
  f = await seedBillFixture(pool, 'off-slice-capture-route');
  token = await new SignJWT({ sub: f.owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query('INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, $3, true)', [S3, f.co, S3_NAME]);
  const fno = crypto.randomUUID();
  const proj = crypto.randomUUID();
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'FNO-Y', 'Old FNO', 'cc1'),
                      ($2, $3, 'PRJ-Y', 'Project Y', 'cc2')`, [fno, proj, f.co]);
  await pool.query('UPDATE cost_centres SET parent_id = $2 WHERE id = $1', [proj, fno]);
  // The rule codes the slip to opex, the provisional's account, so the line WOULD inherit FT from it.
  await pool.query('INSERT INTO supplier_coding_rules (company_id, supplier_id, default_cc2_id, default_gl_account_id) VALUES ($1, $2, $3, $4)',
    [f.co, S3, proj, f.acc.opex]);
  await pool.query('UPDATE cost_centres SET is_active = false WHERE id = $1', [fno]);
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM supplier_coding_rules WHERE company_id = $1', [f.co]);
    await dropBillFixture(pool, f);
  } finally { await pool.end(); }
}, 60_000);

/** An extracted, unclaimed slip of S3 for 920 (VAT 120) dated `date`. */
async function slip(date: string): Promise<string> {
  const id = crypto.randomUUID();
  const extracted = {
    documentType: 'invoice', vendorName: S3_NAME, date, referenceNumber: `P52B-${id.slice(0, 8)}`, currency: 'ZAR',
    subtotal: 800, vatAmount: 120, vatRate: 15, totalAmount: 920, lineItems: [],
    rawText: 'TAX INVOICE\nSub Total 800\nVAT 120\nTotal 920', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
  };
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type, document_type, extracted_data, status)
                    VALUES ($1, $2, $3, 'application/pdf', 'invoice', $4::jsonb, 'pending')`, [id, f.co, `p52b-${id}.pdf`, JSON.stringify(extracted)]);
  return id;
}
async function runPipeline(documentId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: f.co }, 'POST');
  (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
  req.url = '/api/accounting/ai-invoice-pipeline';
  req.body = { documentId };
  const out = response();
  await pipelineRoute(req as never, out.res as never);
  return out.state as { statusCode: number; body: { error?: { message?: string } } };
}

describe('R3-2 on the wire: a refused supplier default with a provisional to inherit from', () => {
  it('400 with the dimension refusal; no bill written, the slip unclaimed, the provisional still unevidenced', async () => {
    const je = await seedUnevidencedProvisional(pool, f, '2026-07-10', [{ amount: 800, cc1: f.cc.FT }], S3);
    const doc = await slip('2026-07-11');
    const r = await runPipeline(doc);
    // The plan's own message: what planCaptureBillLines answers for S3 (breaker R4-3: a 400, never a masked 500).
    const t = await openRequest(pool, f, f.owner);
    let planned: unknown;
    try {
      planned = await t.run(() => planCaptureBillLines(f.co, { supplierId: S3, invoiceNumber: 'X', invoiceDate: '2026-02-01', totalAmount: 920, taxAmount: 120, taxRate: 15, items: [] } as never, 0, null, null));
    } finally { await t.rollback(); }
    expect(planned).toEqual({ refusal: expect.stringMatching(/CC1|cost centre/i) });
    expect({ code: r.statusCode, message: r.body.error?.message ?? null }, JSON.stringify(r.body))
      .toEqual({ code: 400, message: (planned as { refusal: string }).refusal });
    expect((await pool.query('SELECT 1 FROM supplier_invoices WHERE source_document_id = $1', [doc])).rowCount).toBe(0);
    expect((await pool.query('SELECT posted_at FROM captured_documents WHERE id = $1', [doc])).rows[0].posted_at).toBeNull();
    expect((await pool.query('SELECT needs_evidence FROM gl_journal_entries WHERE id = $1', [je])).rows[0].needs_evidence).toBe(true);
  });
});
