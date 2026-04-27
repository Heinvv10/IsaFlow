import type { TaggedSql, Customer, Supplier } from './types';

const QA_CUSTOMERS = [
  { code: 'QA-CUST-001', name: 'Acme Property Holdings (Pty) Ltd' },
  { code: 'QA-CUST-002', name: 'Northcliff Trading CC' },
  { code: 'QA-CUST-003', name: 'Sandton Logistics (Pty) Ltd' },
  { code: 'QA-CUST-004', name: 'Highveld Bricks (Pty) Ltd' },
  { code: 'QA-CUST-005', name: 'Brooklyn Coffee Roasters' },
];

const QA_SUPPLIERS = [
  { code: 'QA-SUP-001', name: 'QA Office Supplies SA' },
  { code: 'QA-SUP-002', name: 'QA Telkom Connect' },
  { code: 'QA-SUP-003', name: 'QA Cleaning Co' },
  { code: 'QA-SUP-004', name: 'QA Couriers Direct' },
];

export async function seedCustomers(sql: TaggedSql, companyId: string): Promise<Customer[]> {
  const out: Customer[] = [];
  for (const c of QA_CUSTOMERS) {
    const existing = await sql`SELECT id FROM customers WHERE company_id = ${companyId}::uuid AND notes = ${c.code} LIMIT 1` as Array<{ id: string }>;
    if (existing.length > 0) {
      out.push({ id: existing[0]!.id, name: c.name, code: c.code });
      continue;
    }
    const r = await sql`
      INSERT INTO customers (company_id, name, email, payment_terms, is_active, notes, opening_balance)
      VALUES (${companyId}::uuid, ${c.name}, ${`${c.code.toLowerCase()}@example.com`}, 30, true, ${c.code}, 0)
      RETURNING id
    ` as Array<{ id: string }>;
    out.push({ id: r[0]!.id, name: c.name, code: c.code });
  }
  console.log(`[customers] ${out.length}`);
  return out;
}

export async function seedSuppliers(sql: TaggedSql, companyId: string): Promise<Supplier[]> {
  const out: Supplier[] = [];
  for (const s of QA_SUPPLIERS) {
    const existing = await sql`SELECT id FROM suppliers WHERE company_id = ${companyId}::uuid AND notes = ${s.code} LIMIT 1` as Array<{ id: string }>;
    if (existing.length > 0) {
      out.push({ id: existing[0]!.id, name: s.name, code: s.code });
      continue;
    }
    const r = await sql`
      INSERT INTO suppliers (company_id, name, email, payment_terms, is_active, notes)
      VALUES (${companyId}::uuid, ${s.name}, ${`${s.code.toLowerCase()}@example.com`}, 30, true, ${s.code})
      RETURNING id
    ` as Array<{ id: string }>;
    out.push({ id: r[0]!.id, name: s.name, code: s.code });
  }
  console.log(`[suppliers] ${out.length}`);
  return out;
}
