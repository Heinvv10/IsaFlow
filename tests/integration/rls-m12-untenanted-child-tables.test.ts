// tests/integration/rls-m12-untenanted-child-tables.test.ts
//
// Pentest M12: the four tables below have no company_id of their own and are
// scoped to a tenant via a PARENT JOIN (migration 497). This test seeds two
// tenants A and B, gives each a parent + child row, then proves that under
// app_user with tenant A's GUCs:
//   * reads see A's child rows and NOT B's (USING),
//   * inserting a child whose parent belongs to B is rejected (WITH CHECK).
//
// Requires a live DB. Not part of the unit gate.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const CA = '0c100000-0000-0000-0000-000000000001';
const CB = '0c200000-0000-0000-0000-000000000002';
const UA = 'ws4b-m12-user-A';
const UB = 'ws4b-m12-user-B';
const GA = 'a1100000-0000-0000-0000-000000000001';
const GB = 'a1200000-0000-0000-0000-000000000002';
const BT_A = 'b7100000-0000-0000-0000-000000000001';
const BT_B = 'b7200000-0000-0000-0000-000000000002';
const ATT_A = 'a7100000-0000-0000-0000-000000000001';
const ATT_B = 'a7200000-0000-0000-0000-000000000002';
const CUST_A = 'c8100000-0000-0000-0000-000000000001';
const CUST_B = 'c8200000-0000-0000-0000-000000000002';
const INV_A = '19100000-0000-0000-0000-000000000001';
const INV_B = '19200000-0000-0000-0000-000000000002';
const PPL_A = 'b9100000-0000-0000-0000-000000000001';
const PPL_B = 'b9200000-0000-0000-0000-000000000002';
const PD_A = 'd2100000-0000-0000-0000-000000000001';
const PD_B = 'd2200000-0000-0000-0000-000000000002';
const PB_A = 'b8100000-0000-0000-0000-000000000001';
const PB_B = 'b8200000-0000-0000-0000-000000000002';
const EMP_A = 'e3100000-0000-0000-0000-000000000001';
const EMP_B = 'e3200000-0000-0000-0000-000000000002';
const PBL_A = 'b9910000-0000-0000-0000-000000000001';
const PBL_B = 'b9920000-0000-0000-0000-000000000002';

describe('RLS M12 — parent-join isolation for untenanted child tables', () => {
  let admin: Pool;
  const q = (text: string, params: unknown[] = []) => admin.query(text, params);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await q(`INSERT INTO companies (id, name, is_active) VALUES ($1,'M12-A',true),($2,'M12-B',true) ON CONFLICT (id) DO NOTHING`, [CA, CB]);
    await q(`INSERT INTO users (id, email, is_active) VALUES ($1,'m12a@iso.test',true),($2,'m12b@iso.test',true) ON CONFLICT (id) DO NOTHING`, [UA, UB]);
    await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$3,'admin'),($2,$4,'admin') ON CONFLICT DO NOTHING`, [CA, CB, UA, UB]);

    // gl_accounts (bank_transactions.bank_account_id parent)
    await q(`INSERT INTO gl_accounts (id, account_code, account_name, account_type, normal_balance, company_id)
             VALUES ($1,'1110','Bank','asset','debit',$3),($2,'1110','Bank','asset','debit',$4) ON CONFLICT (id) DO NOTHING`, [GA, GB, CA, CB]);
    await q(`INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, company_id)
             VALUES ($1,$3,'2026-01-01',100,$5),($2,$4,'2026-01-01',100,$6) ON CONFLICT (id) DO NOTHING`, [BT_A, BT_B, GA, GB, CA, CB]);
    await q(`INSERT INTO bank_transaction_attachments (id, bank_transaction_id, file_name)
             VALUES ($1,$3,'a.pdf'),($2,$4,'b.pdf') ON CONFLICT (id) DO NOTHING`, [ATT_A, ATT_B, BT_A, BT_B]);

    // customers -> customer_invoices -> portal_payment_links + procurement_documents
    await q(`INSERT INTO customers (id, name, company_id) VALUES ($1,'CustA',$3),($2,'CustB',$4) ON CONFLICT (id) DO NOTHING`, [CUST_A, CUST_B, CA, CB]);
    await q(`INSERT INTO customer_invoices (id, invoice_number, customer_id, created_by, company_id)
             VALUES ($1,'INV-A',$3,$5,$6),($2,'INV-B',$4,$7,$8) ON CONFLICT (id) DO NOTHING`, [INV_A, INV_B, CUST_A, CUST_B, UA, CA, UB, CB]);
    await q(`INSERT INTO portal_payment_links (id, invoice_id, client_id, amount, token)
             VALUES ($1,$3,$5,10,'m12-token-a'),($2,$4,$6,10,'m12-token-b') ON CONFLICT (id) DO NOTHING`, [PPL_A, PPL_B, INV_A, INV_B, CUST_A, CUST_B]);
    await q(`INSERT INTO procurement_documents (id, entity_type, entity_id, document_type)
             VALUES ($1,'customer_invoice',$3,'invoice'),($2,'customer_invoice',$4,'invoice') ON CONFLICT (id) DO NOTHING`, [PD_A, PD_B, INV_A, INV_B]);

    // payroll_batches + payroll_employees -> payroll_batch_lines
    await q(`INSERT INTO payroll_batches (id, company_id, batch_type, description, period_year, period_month, created_by)
             VALUES ($1,$3,'reimbursive_travel','M12 A',2026,1,$5),($2,$4,'reimbursive_travel','M12 B',2026,1,$6) ON CONFLICT (id) DO NOTHING`, [PB_A, PB_B, CA, CB, UA, UB]);
    await q(`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date)
             VALUES ($1,$3,'E-A','A','A','2026-01-01'),($2,$4,'E-B','B','B','2026-01-01') ON CONFLICT (id) DO NOTHING`, [EMP_A, EMP_B, CA, CB]);
    await q(`INSERT INTO payroll_batch_lines (id, batch_id, employee_id, value, effective_from)
             VALUES ($1,$3,$5,5,'2026-01-01'),($2,$4,$6,5,'2026-01-01') ON CONFLICT (id) DO NOTHING`, [PBL_A, PBL_B, PB_A, PB_B, EMP_A, EMP_B]);
  });

  afterAll(async () => {
    await q(`DELETE FROM payroll_batch_lines WHERE id IN ($1,$2)`, [PBL_A, PBL_B]);
    await q(`DELETE FROM payroll_employees WHERE id IN ($1,$2)`, [EMP_A, EMP_B]);
    await q(`DELETE FROM payroll_batches WHERE id IN ($1,$2)`, [PB_A, PB_B]);
    await q(`DELETE FROM procurement_documents WHERE id IN ($1,$2)`, [PD_A, PD_B]);
    await q(`DELETE FROM portal_payment_links WHERE id IN ($1,$2)`, [PPL_A, PPL_B]);
    await q(`DELETE FROM customer_invoices WHERE id IN ($1,$2)`, [INV_A, INV_B]);
    await q(`DELETE FROM customers WHERE id IN ($1,$2)`, [CUST_A, CUST_B]);
    await q(`DELETE FROM bank_transaction_attachments WHERE id IN ($1,$2)`, [ATT_A, ATT_B]);
    await q(`DELETE FROM bank_transactions WHERE id IN ($1,$2)`, [BT_A, BT_B]);
    await q(`DELETE FROM gl_accounts WHERE id IN ($1,$2)`, [GA, GB]);
    await q(`DELETE FROM company_users WHERE user_id IN ($1,$2)`, [UA, UB]);
    await q(`DELETE FROM users WHERE id IN ($1,$2)`, [UA, UB]);
    await q(`DELETE FROM companies WHERE id IN ($1,$2)`, [CA, CB]);
    await admin.end();
  });

  async function asTenantA<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UA })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [CA]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  const cases: Array<{ table: string; aId: string; bId: string }> = [
    { table: 'bank_transaction_attachments', aId: ATT_A, bId: ATT_B },
    { table: 'portal_payment_links', aId: PPL_A, bId: PPL_B },
    { table: 'procurement_documents', aId: PD_A, bId: PD_B },
    { table: 'payroll_batch_lines', aId: PBL_A, bId: PBL_B },
  ];

  for (const { table, aId, bId } of cases) {
    it(`${table}: tenant A sees its own row but NOT tenant B's`, async () => {
      await asTenantA(async (c) => {
        const a = await c.query<{ n: number }>(`SELECT COUNT(*)::int n FROM public."${table}" WHERE id = $1`, [aId]);
        const b = await c.query<{ n: number }>(`SELECT COUNT(*)::int n FROM public."${table}" WHERE id = $1`, [bId]);
        expect(a.rows[0]!.n, `A should see its own ${table} row`).toBe(1);
        expect(b.rows[0]!.n, `A must NOT see tenant B's ${table} row`).toBe(0);
      });
    });
  }

  it('WITH CHECK: tenant A cannot insert an attachment for tenant B’s transaction', async () => {
    await expect(asTenantA(async (c) => {
      await c.query(
        `INSERT INTO bank_transaction_attachments (bank_transaction_id, file_name) VALUES ($1, 'evil.pdf')`,
        [BT_B]
      );
    })).rejects.toThrow();
  });

  // Regression for the blind-review finding: payroll_batches has no RLS, so a
  // payroll_batch_lines WITH CHECK that trusted only app.current_company_id()
  // (a GUC) would let a NON-member who forged the active-company GUC write a
  // line onto another tenant's batch. The WITH CHECK now also requires
  // membership, so this must be rejected.
  it('WITH CHECK: a non-member who forges the active-company GUC cannot write a payroll_batch_line', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      // Caller is user B (member of company B ONLY)…
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: UB })]);
      // …but forges the active company to A.
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [CA]);
      await expect(
        client.query(
          `INSERT INTO payroll_batch_lines (batch_id, employee_id, value, effective_from)
           VALUES ($1, $2, 9999, '2026-01-01')`,
          [PB_A, EMP_A]
        )
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
