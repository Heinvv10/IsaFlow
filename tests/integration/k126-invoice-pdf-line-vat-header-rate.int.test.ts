/**
 * K-126 — the invoice PDF derives every line's VAT from the header rate.
 *
 * invoicePdfBuilder.ts:141-155 computes `lineVat = lineAmount × inv.tax_rate/100`
 * and ignores customer_invoice_items.tax_rate, which both conversion paths
 * (quoteConvertService.ts:122-127, salesOrderWorkflowService.ts:63-72) do populate
 * per line while leaving the invoice header's tax_rate at its column default of
 * 15.00. A part zero-rated invoice therefore prints 15% VAT against a zero-rated
 * line, and the VAT column no longer sums to the VAT in the totals block — an
 * incorrect SARS tax invoice.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateInvoicePdf } from '../../src/modules/accounting/services/ar/invoicePdfBuilder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const invoice = crypto.randomUUID();
const legacyInvoice = crypto.randomUUID();
const zeroHeaderInvoice = crypto.randomUUID();
const uniformZeroInvoice = crypto.randomUUID();

/**
 * jsPDF writes uncompressed content streams: `(text) Tj` in document order.
 * Literal parentheses inside a string are backslash-escaped, so 'VAT (15%)' is
 * written `(VAT \\(15%\\))` — the capture must skip escaped pairs and unescape them.
 */
function pdfText(buf: Buffer): string[] {
  return [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1]!.replace(/\\([()\\])/g, '$1').replace(/\u00a0/g, ' '));
}

/** Each table row is [description, qty, unit price, VAT, amount]. */
function vatCellOf(text: string[], description: string): string | undefined {
  return text[text.indexOf(description) + 3];
}

/**
 * The totals block's VAT label — 'VAT (15%)' on a single-rate invoice, 'VAT' on a
 * mixed one. Searched from 'Subtotal' onwards: the line-items table's own column
 * header is also the bare string 'VAT' and comes first in document order.
 */
function totalsBlockOf(text: string[]): string[] {
  const i = text.lastIndexOf('Subtotal');
  // Without this the slice would start at 0 and the line-table's own 'VAT'
  // column header would answer for the totals label — which is exactly what
  // the mixed-rate test expects, so it would pass vacuously.
  if (i < 0) throw new Error('no totals block: the "Subtotal" token is absent');
  return text.slice(i + 1);
}

function vatLabelOf(text: string[]): string | undefined {
  return totalsBlockOf(text).find((t) => t === 'VAT' || /^VAT \(/.test(t));
}

/** The rand figure printed beside the totals block's VAT label. */
function totalsVatOf(text: string[]): string | undefined {
  const block = totalsBlockOf(text);
  const i = block.findIndex((t) => t === 'VAT' || /^VAT \(/.test(t));
  return i < 0 ? undefined : block[i + 1];
}

async function seedInvoice(id: string, number: string, taxRate: number | null,
  subtotal: number, taxAmount: number,
  items: Array<[string, number, number | null]>): Promise<void> {
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,status,created_by)
     VALUES($1,$2,$3,$4,$4,'2026-01-01','2026-01-31',$5,COALESCE($6,15.00),$7,$8,'approved',$9)`,
    [id, company, number, customer, subtotal, taxRate, taxAmount, subtotal + taxAmount, user]);
  for (const [description, amount, rate] of items) {
    await pool.query(
      `INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,tax_rate,amount)
       VALUES($1,$2,1,$3,$4,$3)`, [id, description, amount, rate]);
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K126 fixture', otherCompany, 'K126 other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K126 customer']);
  // One 15% line and one zero-rated line. tax_amount/total are the correct
  // per-line figures: R100 × 15% + R100 × 0% = R15.
  await seedInvoice(invoice, 'K126-INV-1', null, 200, 15,
    [['Standard rated', 100, 15], ['Zero rated export', 100, 0]]);
  // Legacy shape: the lines carry no rate of their own, so the header rate is
  // the only rate there is.
  await seedInvoice(legacyInvoice, 'K126-INV-2', 15, 200, 30,
    [['Legacy line A', 100, null], ['Legacy line B', 100, null]]);
  // A genuinely zero-rated invoice: header rate 0, no per-line rates. This one
  // characterises rather than reproduces: pg returns numeric(5,2) as the string
  // '0.00', which is truthy, so the pre-fix `|| 15` already yielded 0 here. The
  // test pins that so a future numeric type-parser cannot turn 0 into 15.
  await seedInvoice(zeroHeaderInvoice, 'K126-INV-3', 0, 100, 0,
    [['Exempt supply', 100, null]]);
  // Every line zero-rated, header still holding the 15.00 column default. The
  // lines agree with each other, so `mixedRates` alone never fired and the
  // label fell back to the header rate that both lines contradict.
  await seedInvoice(uniformZeroInvoice, 'K126-INV-4', null, 200, 0,
    [['Export line A', 100, 0], ['Export line B', 100, 0]]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id = ANY($1::uuid[])',
      [[invoice, legacyInvoice, zeroHeaderInvoice, uniformZeroInvoice]]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, otherCompany]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('prints each line\'s own VAT rate, and the VAT column foots to the totals block', async () => {
  const text = pdfText(await generateInvoicePdf(company, invoice));
  const vatCell = (description: string) => vatCellOf(text, description);

  expect.soft(vatCell('Standard rated')).toBe('R 15.00');
  expect.soft(vatCell('Zero rated export')).toBe('R 0.00');

  const rands = (v: string | undefined) => Number(String(v).replace(/[^0-9.]/g, ''));
  const columnVat = [vatCell('Standard rated'), vatCell('Zero rated export')]
    .reduce((sum, v) => sum + rands(v), 0);
  // Read the totals block rather than a literal, so a change to how the totals
  // VAT is rendered cannot leave this assertion silently agreeing with itself.
  expect(totalsVatOf(text)).toBe('R 15.00');
  expect(columnVat).toBe(rands(totalsVatOf(text)));
});

it('drops the percentage from the totals label when the lines carry more than one rate', async () => {
  const text = pdfText(await generateInvoicePdf(company, invoice));
  // 'VAT (15%)' would be a false statement about a part zero-rated invoice.
  expect(vatLabelOf(text)).toBe('VAT');
});

it('falls back to the header rate for lines that carry no rate of their own', async () => {
  const text = pdfText(await generateInvoicePdf(company, legacyInvoice));

  expect.soft(vatCellOf(text, 'Legacy line A')).toBe('R 15.00');
  expect.soft(vatCellOf(text, 'Legacy line B')).toBe('R 15.00');
  expect(vatLabelOf(text)).toBe('VAT (15%)');
});

it('treats a header rate of zero as zero, not as absent', async () => {
  const text = pdfText(await generateInvoicePdf(company, zeroHeaderInvoice));

  expect.soft(vatCellOf(text, 'Exempt supply')).toBe('R 0.00');
  expect(vatLabelOf(text)).toBe('VAT (0%)');
});

it('states the rate the lines carry, not the header default they contradict', async () => {
  const text = pdfText(await generateInvoicePdf(company, uniformZeroInvoice));

  expect.soft(vatCellOf(text, 'Export line A')).toBe('R 0.00');
  expect.soft(vatCellOf(text, 'Export line B')).toBe('R 0.00');
  // A fully zero-rated export invoice must not claim 15% in its totals block.
  expect(vatLabelOf(text)).toBe('VAT (0%)');
  expect(totalsVatOf(text)).toBe('R 0.00');
});

it('will not render another tenant\'s invoice', async () => {
  await expect(generateInvoicePdf(otherCompany, invoice)).rejects.toThrow(/Invoice not found/);
});
