/**
 * D11 round 3 (brk-d11 G1): a deadlock victim INSIDE the automatic evidence attach (ai-invoice-pipeline). The holder holds
 * the provisional's bank line, the route locks the slip, creates the bill and blocks on the bank line in the auto-attach
 * savepoint, then the holder asks for the slip: the route is the 40P01 victim. It answered 200 and COMMITTED the bill with
 * its own journal beside the provisional (the slip booked twice); it must answer 503 + Retry-After with nothing committed,
 * like the same held line timing out.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import pipelineRoute from '../../pages/api/accounting/ai-invoice-pipeline';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { company, pool, seedProvisional, supplier, today, useR127Fixture, user, btState, jeState } from './r127-double-booking.helpers';

useR127Fixture();
let token = '';
beforeAll(async () => {
  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
const clientIp = `127.3.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedExtractedDoc(total: number): Promise<string> {
  const id = crypto.randomUUID();
  const net = Math.round((total / 1.15) * 100) / 100;
  const vat = Math.round((total - net) * 100) / 100;
  const extracted = {
    documentType: 'invoice', vendorName: 'R127 Supplies CC', date: today,
    referenceNumber: `D11R3-${id.slice(0, 8)}`, currency: 'ZAR', subtotal: net, vatAmount: vat, vatRate: 15,
    totalAmount: total, lineItems: [{ description: 'Stationery', quantity: 1, unitPrice: net, total: net }],
    rawText: `TAX INVOICE\nSub Total ${net.toFixed(2)}\nVAT ${vat.toFixed(2)}\nTotal ${total.toFixed(2)}`,
    confidence: 0.9, warnings: [], extractionMethod: 'vlm',
  };
  await pool.query(
    `INSERT INTO captured_documents(id,company_id,file_name,file_type,document_type,extracted_data,status)
     VALUES($1,$2,$3,'application/pdf','invoice',$4::jsonb,'pending')`,
    [id, company, `d11r3-${id}.pdf`, JSON.stringify(extracted)]);
  return id;
}

async function runPipeline(documentId: string) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST');
  (req.socket as { remoteAddress: string }).remoteAddress = clientIp;
  req.url = '/api/accounting/ai-invoice-pipeline';
  req.body = { documentId };
  const out = response();
  const t0 = Date.now();
  await pipelineRoute(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: out.headers.get('retry-after') ?? null,
    body: JSON.stringify(out.state.body).slice(0, 700) };
}

describe('D11 round 3: deadlock victim inside the auto-attach', () => {
  it('control: the same shape with nothing held settles and answers 200', async () => {
    await seedProvisional({ totalAmount: 402.5, supplierId: supplier });
    const doc = await seedExtractedDoc(402.5);
    const out = await runPipeline(doc);
    const inv = (await pool.query('SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE source_document_id=$1', [doc])).rows;
    expect(out.status).toBe(200);
  }, 60000);

  it('a 40P01 victim INSIDE the auto-attach (bank line): answered 503, nothing committed, no double booking', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 433.6, supplierId: supplier });
    const doc = await seedExtractedDoc(433.6);
    const h = await pool.connect();
    await h.query('BEGIN');
    await h.query("SET LOCAL deadlock_timeout = '20s'");
    await h.query('SELECT id FROM bank_transactions WHERE id = $1::UUID FOR UPDATE', [bt]);
    const holderPid = (await h.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
    const pending = runPipeline(doc);
    let waited = false;
    for (let i = 0; i < 300 && !waited; i++) {
      await sleep(30);
      const r = await h.query(`SELECT 1 FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`, [holderPid]);
      waited = (r.rowCount ?? 0) > 0;
    }
    let holderErr: string | null = null;
    const holderWants = h.query('SELECT id FROM captured_documents WHERE id = $1::UUID FOR UPDATE', [doc])
      .catch((e: Error & { code?: string }) => { holderErr = `${e.code} ${e.message}`; });
    const out = await pending;
    await holderWants;
    await h.query('ROLLBACK');
    h.release();
    const invoices = (await pool.query(
      'SELECT id, status, gl_journal_entry_id FROM supplier_invoices WHERE source_document_id=$1', [doc])).rows;
    const docRow = (await pool.query('SELECT status, posted_at FROM captured_documents WHERE id=$1', [doc])).rows[0];
    expect(waited).toBe(true);
    expect(out.status, JSON.stringify(out)).toBe(503);
    expect(invoices, 'no bill committed beside the unevidenced provisional').toHaveLength(0);
    expect(out.retryAfter).toBe('2');
    expect(docRow.posted_at, 'the slip is not claimed, so a retry works').toBeNull();
    expect((await jeState(je)).needs_evidence).toBe(true);
    expect(await btState(bt)).toMatchObject({ status: 'provisional' });
  }, 60000);
  it('contrast: the same bank line held past the budget (no cycle) answers 503 with nothing committed', async () => {
    const { je, bt } = await seedProvisional({ totalAmount: 437.1, supplierId: supplier });
    const doc = await seedExtractedDoc(437.1);
    const h = await pool.connect();
    await h.query('BEGIN');
    await h.query('SELECT id FROM bank_transactions WHERE id = $1::UUID FOR UPDATE', [bt]);
    const out = await runPipeline(doc);
    await h.query('ROLLBACK');
    h.release();
    const invoices = (await pool.query('SELECT id, status FROM supplier_invoices WHERE source_document_id=$1', [doc])).rows;
    expect(out.status).toBe(503);
    expect(invoices).toHaveLength(0);
  }, 60000);
});
