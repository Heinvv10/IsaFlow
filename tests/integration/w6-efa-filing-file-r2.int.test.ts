/**
 * Wave 6 EFa delta round through the real routes on real PostgreSQL:
 *  - N1: a VAT201 finalised before 999v's cut-off (mid-cycle at the release) is marked filed with a PRN and no filing
 *    file, as before; its download stays refused (FILING_FILE_NO_FORM_LAYOUT);
 *  - L2: two concurrent filings of two periods with one PRN: exactly one succeeds; a PRN a legacy submission of another
 *    period carries is refused too;
 *  - L3: a revenue line without a VAT code posted after finalise is drift, and the filing refusal says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { fileV, fin, genFile, PRN, row, useFixture, versionOf } from './helpers/returnFileCalls';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let a: ReturnFixture;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** A VAT201 version finalised BEFORE the cut-off, as the previous release wrote it (boxes, no form), on its own lock. */
async function preCutoffVat(start: string, end: string): Promise<string> {
  const lock = String((await one(sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax,
    net_vat, posted_through, locked_by, actor_type) VALUES (${a.fx.companyId}::UUID, ${start}::DATE, ${end}::DATE, 0, 0, 0, now(),
    ${a.admin.userId}, 'human') RETURNING id`)).id);
  return String((await one(sql`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures,
    posted_through, finalised_by, finalised_at, vat_period_lock_id) VALUES (${a.fx.companyId}::UUID, 'VAT201', ${start}::DATE,
    ${end}::DATE, 1, ${JSON.stringify({ outputTax: 0, inputTax: 0, netVat: 0, sarsFields: [] })}::JSONB, now(), ${a.admin.userId},
    '2026-01-02T00:00:00Z', ${lock}::UUID) RETURNING id`)).id);
}

describeIfDb('EFa delta: pre-cut-off filing, one PRN per period under concurrency, uncoded revenue', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, journals, VAT locks, submissions and return versions.');
    a = await seedReturnFixture('EFR3', DATABASE_URL!);
    useFixture(a);
  }, 240000);
  afterAll(async () => {
    if (a) await dropReturnFixture(a);
  }, 120000);

  it('N1: a VAT201 finalised before the cut-off files with a PRN and no filing file (200, no stamp); its download stays 409', async () => {
    const id = await preCutoffVat('2025-12-01', '2026-01-31');
    const filed = await fileV(id, { reference: PRN('vat201', 31), withoutFile: true });
    expect(filed.status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'filed', filed_reference: PRN('vat201', 31), filing_file_sha256: null, filing_file_content: null });
    const dl = await genFile(id, 'vat201', 'csv');
    expect(dl.status).toBe(409);
    expect(JSON.stringify(dl.body)).toMatch(/FILING_FILE_NO_FORM_LAYOUT/);
  });

  it('L2: two concurrent filings of two periods with one PRN: exactly one succeeds, the other is FILING_REFERENCE_REUSED', async () => {
    const [x, y] = [await preCutoffVat('2025-08-01', '2025-09-30'), await preCutoffVat('2025-10-01', '2025-11-30')];
    const prn = PRN('vat201', 42);
    const results = await Promise.all([x, y].map((id) => fileV(id, { reference: prn, withoutFile: true })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(JSON.stringify(results.find((r) => r.status === 409)!.body)).toMatch(/FILING_REFERENCE_REUSED/);
    const filed = (await sql`SELECT id FROM tax_return_versions WHERE company_id = ${a.fx.companyId}::UUID AND filed_reference = ${prn}`) as Row[];
    expect(filed).toHaveLength(1);
  });

  it('L2: a PRN a legacy submission of another period carries is refused', async () => {
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference)
      VALUES (${a.fx.companyId}::UUID, 'VAT201', '2025-02-01', '2025-03-31', 'submitted', ${PRN('vat201', 55)})`;
    const id = await preCutoffVat('2025-04-01', '2025-05-31');
    const r = await fileV(id, { reference: PRN('vat201', 55), withoutFile: true });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/FILING_REFERENCE_REUSED/);
    expect((await row(id)).status).toBe('finalised');
  });

  it('L3: a revenue line without a VAT code posted after finalise is drift; the filing refusal names it', async () => {
    const p = { periodStart: '2025-06-01', periodEnd: '2025-07-31' };
    const id = String(versionOf(await fin(p)).id);
    expect((await genFile(id, 'vat201', 'csv')).status).toBe(200);
    const ar = String((await one(sql`SELECT id FROM gl_accounts WHERE company_id = ${a.fx.companyId}::UUID AND account_subtype = 'receivable' LIMIT 1`)).id);
    const sales = String((await one(sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, is_active) VALUES (${a.fx.companyId}::UUID, '4090', 'Sales uncoded', 'revenue', 'sales', 'credit', true) RETURNING id`)).id);
    const je = String((await one(sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source,
      created_by) VALUES (${a.fx.companyId}::UUID, 'EFR3-1', '2025-07-10', 'uncoded sale', 'posted', 'manual', ${a.admin.userId}) RETURNING id`)).id);
    await sql`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, vat_type) VALUES
      (${je}::UUID, ${a.fx.companyId}::UUID, ${ar}::UUID, 900, 0, NULL), (${je}::UUID, ${a.fx.companyId}::UUID, ${sales}::UUID, 0, 900, NULL)`;
    // On an invoice that raised no VAT: the form counts its uncoded revenue as zero-rated (field 2).
    await sql`INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date, due_date, subtotal, tax_amount,
      total_amount, amount_paid, status, created_by, gl_journal_entry_id) VALUES (${a.fx.companyId}::UUID, ${a.fx.customerId}::UUID,
      ${`EFR3-INV-${a.fx.tag}`}, '2025-07-10', '2025-07-10', 900, 0, 900, 0, 'sent', ${a.fx.userId}::UUID, ${je}::UUID)`;
    const r = await fileV(id, { reference: PRN('vat201', 66), withoutFile: true });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('a revenue line without a VAT code was posted after finalise; amend');
    expect((await row(id)).status).toBe('finalised');
  });
});
