import { describe, it, expect } from 'vitest';
import { enforceTenantScope } from '@/modules/accounting/services/core/nlQueryScopeGuard';

const CID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('enforceTenantScope — rejects cross-tenant bypasses', () => {
  it('rejects the OR-smuggling bypass (the pentest CRITICAL)', () => {
    const sql = `SELECT name FROM customers WHERE company_id = '${CID}' OR company_id <> '${CID}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('rejects a self cross-join to an unscoped alias', () => {
    const sql = `SELECT c2.email FROM customers c1 JOIN customers c2 ON 1=1 WHERE c1.company_id = '${CID}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('rejects a child table cross-joined (ON 1=1) to a scoped parent', () => {
    const sql = `SELECT p.net_pay FROM employees e JOIN payslips p ON 1=1 WHERE e.company_id = '${CID}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('rejects an unscoped scalar subquery leak', () => {
    const sql = `SELECT (SELECT string_agg(email, ',') FROM customers) AS x FROM currencies`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('rejects an unscoped derived table', () => {
    const sql = `SELECT * FROM (SELECT email FROM customers) sub`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it("rejects a query scoped to a DIFFERENT company's id", () => {
    const sql = `SELECT name FROM customers WHERE company_id = '${OTHER}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('rejects a query with no company scope at all', () => {
    const sql = `SELECT name FROM customers`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('rejects when scope is only in an OR branch', () => {
    const sql = `SELECT name FROM customers WHERE status = 'active' OR company_id = '${CID}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });

  it('fails closed on unparseable SQL', () => {
    expect(enforceTenantScope('SELECT FROM WHERE lol', CID).ok).toBe(false);
  });

  it('rejects a company_id IN (...) list (only equality to caller id is a seed)', () => {
    const sql = `SELECT name FROM customers WHERE company_id IN ('${CID}', '${OTHER}')`;
    expect(enforceTenantScope(sql, CID).ok).toBe(false);
  });
});

describe('enforceTenantScope — allows correctly-scoped queries', () => {
  it('allows a simple scoped select', () => {
    const sql = `SELECT name FROM customers WHERE company_id = '${CID}' LIMIT 100`;
    expect(enforceTenantScope(sql, CID).ok).toBe(true);
  });

  it('allows a parent-child join scoped via equijoin to a scoped parent', () => {
    const sql = `SELECT p.net_pay FROM employees e JOIN payslips p ON p.employee_id = e.id WHERE e.company_id = '${CID}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(true);
  });

  it('allows an aggregate with extra AND filters', () => {
    const sql = `SELECT SUM(total_amount) FROM customer_invoices WHERE company_id = '${CID}' AND status = 'paid'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(true);
  });

  it('allows a two-table join where the child reaches the scoped parent', () => {
    const sql = `SELECT i.invoice_number, c.name FROM customer_invoices i JOIN customers c ON c.id = i.customer_id WHERE i.company_id = '${CID}'`;
    expect(enforceTenantScope(sql, CID).ok).toBe(true);
  });

  it('allows a scoped CTE consumed by the outer select', () => {
    const sql = `WITH t AS (SELECT id, total_amount FROM customer_invoices WHERE company_id = '${CID}') SELECT SUM(total_amount) FROM t`;
    expect(enforceTenantScope(sql, CID).ok).toBe(true);
  });
});
