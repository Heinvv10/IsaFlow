// R-169: ai-invoice-pipeline never marked the document's capture_events row
// posted, so the capture inbox kept showing a document the pipeline had
// already turned into a bill as 'extracted'. recordCoding also always stored
// glAccountId: null for a pipeline bill, so a supplier's coding rule never
// learned from one — even when the pipeline's own lines were coded from that
// same rule. Real PG, through the real withAuth route (app_user, GUCs, COMMIT
// on 4xx).
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import { request, response } from './mfa-impersonation-postgres.helpers';
import {
  company, otherCompany, pool, supplier, today, useR127Fixture, user,
} from './r127-double-booking.helpers';

useR127Fixture();

let token = '';
/** The supplier coding rule's default expense account. */
const ruleGl = crypto.randomUUID();
beforeAll(async () => {
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active)
     VALUES($1,$2,'R169RULE','R169 Rule expense','expense','debit',true)`, [ruleGl, company]);
});

// checkAiRateLimit keys on the IP with a persistent counter; one address per run.
const clientIp = `127.9.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

interface LineItem { description: string; quantity: number; unitPrice: number; total: number }

/** An extracted, unclaimed slip the pipeline auto-approves (clean, low value). */
async function seedDocument(opts: {
  total: number; vat: number | null; lineItems?: LineItem[]; companyId?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const net = opts.vat === null ? opts.total : Math.round((opts.total - opts.vat) * 100) / 100;
  const extracted = {
    documentType: 'invoice', vendorName: 'R127 Supplies CC', vendorVatNumber: '4123456789', date: today,
    referenceNumber: `R169-${id.slice(0, 8)}`, currency: 'ZAR', subtotal: net, vatAmount: opts.vat, vatRate: 15,
    totalAmount: opts.total, lineItems: opts.lineItems ?? [],
    rawText: `TAX INVOICE\nSub Total ${net}\nVAT ${opts.vat}\nTotal ${opts.total}`,
    confidence: 0.9, warnings: [], extractionMethod: 'vlm',
  };
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`,
    [id, opts.companyId ?? company, `r169-${id}.pdf`, JSON.stringify(extracted)],
  );
  return id;
}

async function seedEvent(documentId: string, companyId = company, status = 'extracted'): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO capture_events(company_id,channel,status,captured_document_id) VALUES($1,'email',$2,$3) RETURNING id`,
    [companyId, status, documentId],
  );
  return rows[0].id as string;
}

async function eventState(eventId: string) {
  const { rows } = await pool.query('SELECT status, posted_by, posted_at FROM capture_events WHERE id=$1', [eventId]);
  return rows[0] as { status: string; posted_by: string | null; posted_at: Date | null };
}

async function runPipeline(documentId: string, companyId = company): Promise<{ statusCode: number; body: unknown }> {
  const req = request({ 'sb-access-token': token, active_company_id: companyId }, 'POST');
  (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
  req.url = '/api/accounting/ai-invoice-pipeline';
  req.body = { documentId };
  const out = response();
  await pipelineRoute(req as never, out.res as never);
  return out.state;
}

async function billFor(documentId: string): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM supplier_invoices WHERE source_document_id=$1', [documentId]);
  expect(rows).toHaveLength(1);
  return String(rows[0].id);
}

async function latestCoding(invoiceId: string) {
  const { rows } = await pool.query(
    `SELECT gl_account_id, vat_code, cost_centre_id, project_id, posted_by
     FROM supplier_coding_history WHERE supplier_invoice_id=$1`, [invoiceId]);
  expect(rows).toHaveLength(1);
  return rows[0] as {
    gl_account_id: string | null; vat_code: string | null; cost_centre_id: string | null;
    project_id: string | null; posted_by: string;
  };
}

async function withRule<T>(fn: () => Promise<T>): Promise<T> {
  await pool.query(
    'INSERT INTO supplier_coding_rules(company_id,supplier_id,default_gl_account_id) VALUES($1,$2,$3)',
    [company, supplier, ruleGl]);
  try {
    return await fn();
  } finally {
    await pool.query('DELETE FROM supplier_coding_history WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM supplier_coding_rules WHERE company_id=$1', [company]);
  }
}

describe('R-169: ai-invoice-pipeline marks its capture event posted and records real coding', () => {
  it('an auto-approved run marks the tied capture event posted', async () => {
    const documentId = await seedDocument({ total: 402.50, vat: 52.50 });
    const eventId = await seedEvent(documentId);
    const res = await runPipeline(documentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const event = await eventState(eventId);
    expect(event.status).toBe('posted');
    expect(event.posted_by).toBe(user);
    expect(event.posted_at).not.toBeNull();
  });

  it('a 4xx refusal leaves the tied capture event unchanged', async () => {
    const documentId = await seedDocument({
      total: 0, vat: null, lineItems: [{ description: 'Unpriced', quantity: 1, unitPrice: 0, total: 0 }],
    });
    const eventId = await seedEvent(documentId);
    const res = await runPipeline(documentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
    const event = await eventState(eventId);
    expect(event.status).toBe('extracted');
    expect(event.posted_at).toBeNull();
  });

  it('a document with no capture event at all is unaffected — the update is a no-op', async () => {
    const documentId = await seedDocument({ total: 115, vat: 15 });
    const res = await runPipeline(documentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  });

  it('a discarded event is left discarded, not resurrected to posted', async () => {
    const documentId = await seedDocument({ total: 172.50, vat: 22.50 });
    const eventId = await seedEvent(documentId, company, 'discarded');
    const res = await runPipeline(documentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((await eventState(eventId)).status).toBe('discarded');
  });

  it("only the tied event is marked — an unrelated event in the same company, and another company's event, stay untouched", async () => {
    const documentId = await seedDocument({ total: 575, vat: 75 });
    const eventId = await seedEvent(documentId);

    const otherDocumentId = await seedDocument({ total: 103.50, vat: 13.50 });
    const unrelatedEventId = await seedEvent(otherDocumentId);

    const crossTenantDocId = await seedDocument({ total: 103.50, vat: 13.50, companyId: otherCompany });
    const crossTenantEventId = await seedEvent(crossTenantDocId, otherCompany);

    const res = await runPipeline(documentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);

    expect((await eventState(eventId)).status).toBe('posted');
    expect((await eventState(unrelatedEventId)).status).toBe('extracted');
    expect((await eventState(crossTenantEventId)).status).toBe('extracted');
  });

  it("the coding history carries the supplier rule's account, not the pipeline's own guess", async () => {
    await withRule(async () => {
      const documentId = await seedDocument({ total: 299, vat: 39 });
      const res = await runPipeline(documentId);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
      const invoiceId = await billFor(documentId);
      const coding = await latestCoding(invoiceId);
      // The rule carries no VAT code of its own, so this still falls through to
      // the extracted vendor VAT number — same fallback capturePostFollowUps uses.
      expect(coding).toMatchObject({
        gl_account_id: ruleGl, vat_code: '4123456789', cost_centre_id: null, project_id: null,
        posted_by: 'ai:ai-invoice-pipeline:v1',
      });
    });
  });

  it('no rule: the coding history stays uncoded on the GL account, but carries the vendor VAT number, and no rule is seeded', async () => {
    const documentId = await seedDocument({ total: 471.50, vat: 61.50 });
    const res = await runPipeline(documentId);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const invoiceId = await billFor(documentId);
    const coding = await latestCoding(invoiceId);
    expect(coding).toMatchObject({ gl_account_id: null, vat_code: '4123456789' });
    const rule = await pool.query(
      'SELECT id FROM supplier_coding_rules WHERE company_id=$1 AND supplier_id=$2', [company, supplier]);
    expect(rule.rows).toHaveLength(0);
  });
});
