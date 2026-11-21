/**
 * The AI invoice pipeline never matches a soft-deleted (merged-away) supplier (review of b4741393, M2): its candidate list is live
 * suppliers only (deleted_at IS NULL, not only is_active), so a document naming a merged-away supplier goes to manual review
 * instead of writing a bill onto it (which 1021's supplier-live trigger would refuse). Real PG, through the real withAuth route.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { company, pool, today, useR127Fixture, user } from './r127-double-booking.helpers';

useR127Fixture();

let token = '';
const goneName = 'R164 Merged Away Traders';
beforeAll(async () => {
  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  // Merged away by the duplicates merge: deleted, still is_active = true.
  await pool.query("INSERT INTO suppliers(company_id,name,is_active,deleted_at) VALUES($1,$2,true,now())", [company, goneName]);
});
const clientIp = `127.6.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

describe('a document naming a merged-away supplier', () => {
  it('goes to manual review; no bill is written', async () => {
    const id = crypto.randomUUID();
    const extracted = {
      documentType: 'invoice', vendorName: goneName, date: today, referenceNumber: `R164-${id.slice(0, 8)}`, currency: 'ZAR',
      subtotal: 100, vatAmount: 15, vatRate: 15, totalAmount: 115, lineItems: [{ description: 'Widgets', quantity: 1, unitPrice: 100, total: 100 }],
      rawText: 'TAX INVOICE\nSub Total 100\nVAT 15\nTotal 115', confidence: 0.9, warnings: [], extractionMethod: 'vlm',
    };
    await pool.query(
      `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
       VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`, [id, company, `r164-${id}.pdf`, JSON.stringify(extracted)]);
    const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
    (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
    req.url = '/api/accounting/ai-invoice-pipeline';
    req.body = { documentId: id };
    const out = response();
    await pipelineRoute(req as never, out.res as never);
    expect(out.state.statusCode, JSON.stringify(out.state.body)).toBe(200);
    expect((out.state.body as { data: { status: string } }).data.status).toBe('manual_review');
    expect((await pool.query('SELECT count(*)::int AS n FROM supplier_invoices WHERE source_document_id = $1', [id])).rows[0].n).toBe(0);
  });
});
