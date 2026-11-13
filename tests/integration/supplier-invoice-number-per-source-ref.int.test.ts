/**
 * Migration 986: (supplier, invoice_number) stays unique among live bills WITHOUT a source ref
 * (K-107), and allows a reused number when the bills carry different source refs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `M986-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let supplier: string;

async function bill(number: string, ref: string | null, system: string | null = ref ? 'sage' : null): Promise<string> {
  const rows = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, status, total_amount, created_by, external_system, external_ref)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${number}, '2026-10-01', 'draft', 100, ${USER}::UUID, ${system}, ${ref})
    RETURNING id`) as { id: string }[];
  return rows[0]!.id;
}

const violation = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '23505', constraint: 'uq_supplier_invoices_supplier_number' });

describeIfDb('migration 986 — supplier invoice number unique per source ref', () => {
  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name, registration_number, created_at) VALUES (${COMPANY}::UUID, ${TAG}, ${TAG}, NOW())`;
    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${`${TAG} supp`}) RETURNING id`) as { id: string }[])[0]!.id;
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 60000);

  it('keeps the index name the recurring runner matches on', async () => {
    const rows = (await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_supplier_invoices_supplier_number'`) as { indexdef: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/external_ref/);
  });

  it('still refuses a repeated number between two bills with no source ref (K-107)', async () => {
    await bill(`${TAG}-A`, null);
    await violation(bill(`${TAG}-A`, null));
  });

  it('allows a reused number on two different source documents', async () => {
    await bill(`${TAG}-B`, '5490');
    await expect(bill(`${TAG}-B`, '5612')).resolves.toBeTruthy();
  });

  it('refuses the same source ref twice for the same number', async () => {
    await bill(`${TAG}-C`, '7001');
    await violation(bill(`${TAG}-C`, '7001'));
  });

  it('a soft-deleted bill does not hold its number', async () => {
    const id = await bill(`${TAG}-D`, null);
    await sql`UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = ${id}::UUID`;
    await expect(bill(`${TAG}-D`, null)).resolves.toBeTruthy();
  });
});
