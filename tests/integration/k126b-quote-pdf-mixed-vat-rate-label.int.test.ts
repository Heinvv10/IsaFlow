/**
 * K-126 LOW-3 — the quote PDF contradicted itself on a mixed-rate quote.
 *
 * quotePdfBuilder's line table already prints each line's own
 * `customer_quote_lines.tax_rate`, but its totals block carried the hardcoded
 * literal `'VAT (15%)'`. A quote with a zero-rated line therefore printed
 * '0%' against that line and claimed 15% on the same page — and the quote is
 * the source document for the very invoice K-126 fixes.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateQuotePdf } from '../../src/modules/accounting/services/ar/quotePdfBuilder';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const mixedQuote = crypto.randomUUID();
const singleQuote = crypto.randomUUID();

/** jsPDF writes uncompressed content streams; literal parens are escaped. */
function pdfText(buf: Buffer): string[] {
  return [...buf.toString('latin1').matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
    .map((m) => m[1]!.replace(/\\([()\\])/g, '$1').replace(/ /g, ' '));
}

function totalsBlockOf(text: string[]): string[] {
  const i = text.lastIndexOf('Subtotal (excl. VAT)');
  if (i < 0) throw new Error('no totals block: the "Subtotal (excl. VAT)" token is absent');
  return text.slice(i + 1);
}

function vatLabelOf(text: string[]): string | undefined {
  return totalsBlockOf(text).find((t) => t === 'VAT' || /^VAT \(/.test(t));
}

/** Each line row is [description, qty, unit price, VAT rate, amount]. */
function rateCellOf(text: string[], description: string): string | undefined {
  return text[text.indexOf(description) + 3];
}

async function seedQuote(id: string, number: string, headerRate: number,
  subtotal: number, taxAmount: number,
  lines: Array<[string, number, number | null]>): Promise<void> {
  await pool.query(
    `INSERT INTO customer_quotes(id,company_id,quote_number,client_id,quote_date,subtotal,tax_rate,tax_amount,total,status,created_by)
     VALUES($1,$2,$3,$4,'2026-01-01',$5,$6,$7,$8,'sent',$9)`,
    [id, company, number, customer, subtotal, headerRate, taxAmount, subtotal + taxAmount, user]);
  let order = 0;
  for (const [description, amount, rate] of lines) {
    await pool.query(
      `INSERT INTO customer_quote_lines(quote_id,description,quantity,unit_price,amount,tax_rate,sort_order)
       VALUES($1,$2,1,$3,$3,$4,$5)`, [id, description, amount, rate, order++]);
  }
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K126b fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K126b customer']);
  await seedQuote(mixedQuote, 'K126B-Q1', 15, 200, 15,
    [['Standard rated item', 100, 15], ['Zero rated export item', 100, 0]]);
  await seedQuote(singleQuote, 'K126B-Q2', 15, 200, 30,
    [['Plain item A', 100, 15], ['Plain item B', 100, 15]]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_quote_lines WHERE quote_id = ANY($1::uuid[])', [[mixedQuote, singleQuote]]);
    await pool.query('DELETE FROM customer_quotes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('does not claim a single VAT rate the lines contradict', async () => {
  const text = pdfText(await generateQuotePdf(company, mixedQuote));

  expect.soft(rateCellOf(text, 'Standard rated item')).toBe('15%');
  expect.soft(rateCellOf(text, 'Zero rated export item')).toBe('0%');
  expect(vatLabelOf(text)).toBe('VAT');
});

it('still states the rate when every line carries the same one', async () => {
  const text = pdfText(await generateQuotePdf(company, singleQuote));
  expect(vatLabelOf(text)).toBe('VAT (15%)');
});

it('will not render another tenant\'s quote', async () => {
  await expect(generateQuotePdf(crypto.randomUUID(), mixedQuote)).rejects.toThrow(/Quote not found/);
});
