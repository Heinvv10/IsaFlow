/**
 * The guard `billLineAccountRefusal` gave supplier-bill lines, extended to the
 * three OTHER document-line writers with no such check (gl/.claude.md, "Known
 * limit", 2026-09-24): expense-claim lines (create + add-line), the PATCH
 * route that recodes an existing line, and purchase-order line replacement.
 * Each must refuse an inactive or foreign account before its first write, and
 * a concurrent merge holding `FOR UPDATE` on the account must make the guard
 * wait, then refuse.
 *
 * The two API routes have no separate service layer — the guard call and the
 * write live in the route file itself — so those two are driven through the
 * real `withAuth`/`withCsrf`/`withWriteAccess` stack (a signed GoTrue-shaped
 * JWT plus the active-company cookie), the same recipe
 * `customer-ownership-fence-routes.int.test.ts` uses, because the refusal
 * must be a 4xx that `withAuth` commits, not a 500.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { createClaim, addLine } from '@/modules/accounting/services/expense/expenseClaimService';
import { DocumentLineAccountRefusal, documentLineAccountRefusal } from '@/modules/accounting/services/gl/documentLineAccountGuard';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import expenseClaimLinePatchHandler from '../../pages/api/accounting/expense-claims/[id]/lines/[lineId]';
import purchaseOrderHandler from '../../pages/api/accounting/purchase-orders/[id]';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const describeIfAuth = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let other: Fixture;
let seq = 0;
const acc: Record<string, string> = {};
let employeeId: string;

async function addAccount(code: string, opts: { active?: boolean; companyId?: string } = {}): Promise<string> {
  const companyId = opts.companyId ?? fx.companyId;
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active)
    VALUES (${companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, 'expense', 'operating_expense',
            'debit', ${opts.active ?? true})
    RETURNING id`) as Row[])[0]!.id);
}

function line(glAccountId: string | null) {
  return {
    lineDate: '2026-05-01', description: 'Line', merchant: null,
    amount: 100, vatAmount: 0, vatCode: null, glAccountId,
    costCentreId: null, projectId: null, sourceDocumentId: null,
    kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
  };
}

describeIfDb('document-line account guard — expense-claim service writers', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test creates expense claims and GL accounts.');
    fx = await seedFixture('DLA', DATABASE_URL!);
    other = await seedFixture('DLX', DATABASE_URL!);
    acc.active = await addAccount('7100');
    acc.inactive = await addAccount('7200', { active: false });
    acc.foreign = await addAccount('7100', { companyId: other.companyId });
    employeeId = String(((await sql`
      INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
      VALUES (${fx.companyId}::UUID, ${`E-${++seq}`}, 'Test', 'Employee', '2026-01-01', 'active')
      RETURNING id`) as Row[])[0]!.id);
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM expense_claim_lines WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM expense_claims WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${f.companyId}::UUID`;
      await dropFixture(f);
    }
  }, 120000);

  async function claimLineCount(claimId: string): Promise<number> {
    return Number(((await sql`
      SELECT COUNT(*)::INT AS n FROM expense_claim_lines WHERE claim_id = ${claimId}::UUID`) as Row[])[0]!.n);
  }

  describe('createClaim', () => {
    it('refuses an inactive account, writing nothing', async () => {
      const before = Number(((await sql`
        SELECT COUNT(*)::INT AS n FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
      await expect(inTx(fx, () => createClaim({
        companyId: fx.companyId, employeeId, lines: [line(acc.inactive!)],
      }))).rejects.toThrow(DocumentLineAccountRefusal);
      const after = Number(((await sql`
        SELECT COUNT(*)::INT AS n FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
      expect(after).toBe(before);
    });

    it('refuses another company\'s account', async () => {
      await expect(inTx(fx, () => createClaim({
        companyId: fx.companyId, employeeId, lines: [line(acc.foreign!)],
      }))).rejects.toThrow(/not in your company/);
    });

    it('accepts an active account of this company', async () => {
      const claim = await inTx(fx, () => createClaim({
        companyId: fx.companyId, employeeId, lines: [line(acc.active!)],
      }));
      expect(claim.status).toBe('draft');
    });
  });

  describe('addLine', () => {
    it('refuses an inactive account, leaving the claim\'s lines unchanged', async () => {
      const claim = await inTx(fx, () => createClaim({
        companyId: fx.companyId, employeeId, lines: [line(acc.active!)],
      }));
      await expect(inTx(fx, () => addLine(claim.id, fx.companyId, line(acc.inactive!))))
        .rejects.toThrow(DocumentLineAccountRefusal);
      expect(await claimLineCount(claim.id)).toBe(1);
    });
  });

  describe('concurrency: a FOR UPDATE holder makes the guard wait, then refuse', () => {
    it('waits on the merge lock and then refuses the now-inactive account', async () => {
      const raceAccount = await addAccount('7300');
      const pool = new Pool({ connectionString: DATABASE_URL });
      const holder = await pool.connect();
      let verdict: Promise<string | null>;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM gl_accounts WHERE id = $1 FOR UPDATE', [raceAccount]);

        // B starts while A still holds the row: it must block, not decide.
        verdict = documentLineAccountRefusal(fx.companyId, [raceAccount]);
        const raced = await Promise.race([
          verdict.then(() => 'settled', () => 'settled'),
          new Promise((resolve) => { setTimeout(() => resolve('blocked'), 150); }),
        ]);
        expect(raced).toBe('blocked');

        await holder.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [raceAccount]);
        await holder.query('COMMIT');
      } catch (err) {
        await holder.query('ROLLBACK');
        throw err;
      } finally {
        holder.release();
        await pool.end();
      }

      await expect(verdict!).resolves.toMatch(/inactive/);
    });
  });
});

// ─── Routes: PATCH expense-claim line, PUT purchase-order ──────────────────

describeIfAuth('document-line account guard — driven through the real routes', () => {
  let pool: Pool;
  let token = '';
  const COMPANY = randomUUID();
  const USER = randomUUID();
  const SUPPLIER = randomUUID();
  const EMPLOYEE = randomUUID();
  let claimId: string;
  let claimLineId: string;
  const routeAcc: Record<string, string> = {};

  function request(query: Record<string, string>, method: string, body: unknown) {
    const csrf = 'disposable-doc-line-guard-csrf-0123456789';
    const cookies = { 'sb-access-token': token, active_company_id: COMPANY, isaflow_csrf: csrf };
    return {
      method, url: '/api/accounting/doc-line-guard-fixture', cookies, query, body,
      headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': csrf },
      socket: { remoteAddress: '127.0.0.79' },
    } as unknown as NextApiRequest;
  }

  function response() {
    const headers = new Map<string, unknown>();
    const state = {
      statusCode: 200, body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      json(body: unknown) { this.body = body; return this.end(); },
      end() { return this; },
    };
    return { res: state as unknown as NextApiResponse, state };
  }

  async function call(
    handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
    query: Record<string, string>, method: string, body: unknown,
  ) {
    const req = request(query, method, body);
    const out = response();
    await handler(req, out.res);
    return out.state;
  }

  beforeAll(async () => {
    assertNotProductionDb('This test creates an expense claim, a purchase order and GL accounts.');
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [COMPANY, 'DLG route fixture']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `dlg-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [COMPANY, USER]);
    await pool.query('INSERT INTO suppliers (id, company_id, name) VALUES ($1, $2, $3)', [SUPPLIER, COMPANY, 'DLG Supplier']);
    await pool.query(
      `INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date, status)
       VALUES ($1, $2, 'DLG-EMP', 'DLG', 'Employee', '2026-01-01', 'active')`, [EMPLOYEE, COMPANY]);
    for (const [key, code, active] of [['active', '7100', true], ['inactive', '7200', false]] as const) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
           normal_balance, is_active) VALUES ($1, $2, $3, $4, 'expense', 'operating_expense', 'debit', $5)`,
        [id, COMPANY, code, `${code} DLG`, active]);
      routeAcc[key] = id;
    }
    const foreignCompany = randomUUID();
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [foreignCompany, 'DLG foreign co']);
    routeAcc.foreign = randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
         normal_balance, is_active) VALUES ($1, $2, '7100', '7100 foreign', 'expense', 'operating_expense', 'debit', true)`,
      [routeAcc.foreign, foreignCompany]);

    const claim = (await pool.query(
      `INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, status)
       VALUES ($1, $2, 'CL-DLG-1', CURRENT_DATE, 'draft') RETURNING id`, [COMPANY, EMPLOYEE])).rows[0];
    claimId = claim.id;
    const claimLine = (await pool.query(
      `INSERT INTO expense_claim_lines (claim_id, company_id, line_date, description, amount, gl_account_id)
       VALUES ($1, $2, CURRENT_DATE, 'DLG line', 100, $3) RETURNING id`,
      [claimId, COMPANY, routeAcc.active])).rows[0];
    claimLineId = claimLine.id;

    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM expense_claim_lines WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM expense_claims WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [COMPANY]);
      await pool.query('DELETE FROM purchase_orders WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM payroll_employees WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
      const foreign = (await pool.query('SELECT company_id FROM gl_accounts WHERE id = $1', [routeAcc.foreign])).rows[0]?.company_id;
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
      if (foreign) {
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [foreign]);
        await pool.query('DELETE FROM companies WHERE id = $1', [foreign]);
      }
      await pool.query('DELETE FROM company_users WHERE company_id = $1', [COMPANY]);
      await pool.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  describe('PATCH expense-claim line', () => {
    it('refuses coding a line onto an inactive account, as a 400, leaving the line as it was', async () => {
      const state = await call(
        expenseClaimLinePatchHandler as never,
        { id: claimId, lineId: claimLineId }, 'PATCH', { glAccountId: routeAcc.inactive },
      );
      expect(state.statusCode).toBe(400);
      const stored = (await pool.query('SELECT gl_account_id FROM expense_claim_lines WHERE id = $1', [claimLineId])).rows[0];
      expect(stored.gl_account_id).toBe(routeAcc.active);
    });

    it('refuses another company\'s account', async () => {
      const state = await call(
        expenseClaimLinePatchHandler as never,
        { id: claimId, lineId: claimLineId }, 'PATCH', { glAccountId: routeAcc.foreign },
      );
      expect(state.statusCode).toBe(400);
    });

    it('omitting glAccountId still works on a line whose existing account is inactive', async () => {
      await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [routeAcc.active]);
      const state = await call(
        expenseClaimLinePatchHandler as never,
        { id: claimId, lineId: claimLineId }, 'PATCH', { description: 'Renamed' },
      );
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      await pool.query('UPDATE gl_accounts SET is_active = true WHERE id = $1', [routeAcc.active]);
    });

    it('still accepts an active account', async () => {
      const state = await call(
        expenseClaimLinePatchHandler as never,
        { id: claimId, lineId: claimLineId }, 'PATCH', { glAccountId: routeAcc.active },
      );
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    });
  });

  describe('PUT purchase-orders/[id]', () => {
    async function seedPo(): Promise<string> {
      const row = (await pool.query(
        `INSERT INTO purchase_orders (company_id, po_number, supplier_id, order_date, status)
         VALUES ($1, $2, $3, CURRENT_DATE, 'draft') RETURNING id`,
        [COMPANY, `PO-DLG-${++seq}`, SUPPLIER])).rows[0];
      return row.id;
    }

    it('refuses replacing lines with one on an inactive account, writing nothing', async () => {
      const poId = await seedPo();
      const state = await call(purchaseOrderHandler as never, { id: poId }, 'PUT', {
        supplier_id: SUPPLIER,
        items: [{ description: 'Widget', quantity: 1, unit_price: 100, gl_account_id: routeAcc.inactive }],
      });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
      const items = await pool.query('SELECT id FROM po_items WHERE purchase_order_id = $1', [poId]);
      expect(items.rows).toHaveLength(0);
    });

    it('refuses another company\'s account', async () => {
      const poId = await seedPo();
      const state = await call(purchaseOrderHandler as never, { id: poId }, 'PUT', {
        supplier_id: SUPPLIER,
        items: [{ description: 'Widget', quantity: 1, unit_price: 100, gl_account_id: routeAcc.foreign }],
      });
      expect(state.statusCode).toBe(400);
    });

    // The PUT replaces every line, so it re-sends lines the user never touched.
    // One already on a since-deactivated account must not block the edit.
    it('keeps an untouched line on a since-deactivated account while editing the PO', async () => {
      const poId = await seedPo();
      await pool.query(
        `INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, sort_order)
         VALUES ($1, 'Old line', 1, 50, 15, 50, 7.5, $2, 0)`, [poId, routeAcc.inactive]);
      const state = await call(purchaseOrderHandler as never, { id: poId }, 'PUT', {
        supplier_id: SUPPLIER,
        items: [
          { description: 'Old line', quantity: 2, unit_price: 50, gl_account_id: routeAcc.inactive },
          { description: 'New line', quantity: 1, unit_price: 100, gl_account_id: routeAcc.active },
        ],
      });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      const items = await pool.query(
        'SELECT gl_account_id FROM po_items WHERE purchase_order_id = $1 ORDER BY sort_order', [poId]);
      expect(items.rows.map((r) => r.gl_account_id)).toEqual([routeAcc.inactive, routeAcc.active]);
    });

    // The exemption is per LINE, not per account: a new line reusing the
    // deactivated account the PO already carries is still refused.
    it('refuses a new extra line on the deactivated account an existing line keeps', async () => {
      const poId = await seedPo();
      await pool.query(
        `INSERT INTO po_items (purchase_order_id, description, quantity, unit_price, tax_rate, line_total, tax_amount, gl_account_id, sort_order)
         VALUES ($1, 'Old line', 1, 50, 15, 50, 7.5, $2, 0)`, [poId, routeAcc.inactive]);
      const state = await call(purchaseOrderHandler as never, { id: poId }, 'PUT', {
        supplier_id: SUPPLIER,
        items: [
          { description: 'Old line', quantity: 1, unit_price: 50, gl_account_id: routeAcc.inactive },
          { description: 'Second line', quantity: 3, unit_price: 20, gl_account_id: routeAcc.inactive },
        ],
      });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(400);
      const items = await pool.query('SELECT description FROM po_items WHERE purchase_order_id = $1', [poId]);
      expect(items.rows.map((r) => r.description)).toEqual(['Old line']);
    });

    it('accepts an active account of this company', async () => {
      const poId = await seedPo();
      const state = await call(purchaseOrderHandler as never, { id: poId }, 'PUT', {
        supplier_id: SUPPLIER,
        items: [{ description: 'Widget', quantity: 1, unit_price: 100, gl_account_id: routeAcc.active }],
      });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      const items = await pool.query('SELECT gl_account_id FROM po_items WHERE purchase_order_id = $1', [poId]);
      expect(items.rows[0].gl_account_id).toBe(routeAcc.active);
    });
  });
});
