// K-110 review round 2: the delete guard must also cover the cost-centre columns
// that carry no foreign key (MEDIUM-1), the parent/child hierarchy whose FK is
// ON DELETE SET NULL (MEDIUM-2), and a cross-tenant reference that the
// tenant-scoped guard cannot see and the FK rejects instead (LOW-3).
// Round 3 adds bank_transactions.cc1_id/cc2_id, which live code writes and no
// FK protects (r2 MEDIUM-1), a cross-tenant child now held by migration 660
// (r2 LOW-3), and the not-found rejection a scoped no-op used to hide (r2 MEDIUM-3).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { deleteCostCentre } from '../../src/modules/accounting/services/core/costCentreService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const supplier = crypto.randomUUID();
const invoiceCentre = crypto.randomUUID();
const parentCentre = crypto.randomUUID();
const childCentre = crypto.randomUUID();
const foreignCentre = crypto.randomUUID();
const freeCentre = crypto.randomUUID();
const bankCentre = crypto.randomUUID();
const foreignParent = crypto.randomUUID();
const foreignChild = crypto.randomUUID();
const bankAccount = crypto.randomUUID();
const bankTx = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [company, 'K110 guard fixture', other, 'K110 guard second tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query(
    `INSERT INTO cost_centres(id,company_id,code,name,cc_type) VALUES
      ($1,$2,'CC-INV','Invoiced','cc1'),($3,$2,'CC-PARENT','Parent','cc1'),
      ($4,$2,'CC-FREE','Spare','cc1'),($5,$6,'CC-FOREIGN','Foreign','cc1'),
      ($7,$2,'CC-BANK','Bank coded','cc1'),($8,$2,'CC-XPARENT','Cross parent','cc1')`,
    [invoiceCentre, company, parentCentre, freeCentre, foreignCentre, other, bankCentre, foreignParent]);
  await pool.query(
    "INSERT INTO cost_centres(id,company_id,code,name,cc_type,parent_id) VALUES($1,$2,'CC-CHILD','Child','cc1',$3)",
    [childCentre, company, parentCentre]);
  // A child in the OTHER tenant pointing at this tenant's parent: the guard's
  // children subquery is company-scoped and cannot see it, so only the FK can.
  await pool.query(
    "INSERT INTO cost_centres(id,company_id,code,name,cc_type,parent_id) VALUES($1,$2,'CC-XCHILD','Cross child','cc1',$3)",
    [foreignChild, other, foreignParent]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$2,'1100','Current account','asset','debit')`, [bankAccount, company]);
  // An unallocated bank transaction carrying a pending analysis-code selection.
  await pool.query(
    `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,cc1_id)
     VALUES($1,$2,$3,'2026-08-01',100,'Coded but unallocated','imported',$4)`,
    [bankTx, company, bankAccount, bankCentre]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, company, 'Guard Supplies']);
  await pool.query(
    `INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,created_by,total_amount,cost_center_id)
     VALUES($1,$2,'SI-GUARD-1',$3,'2026-08-01',$4,250,$5)`,
    [crypto.randomUUID(), company, supplier, user, invoiceCentre]);
  // A row in the other tenant pointing at this tenant's centre. It should not
  // exist in practice; the point is which layer refuses the delete when it does.
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,cost_centre_id)
     VALUES($1,$2,'E-GUARD','Thandi','Mokoena','2026-01-01',$3)`,
    [crypto.randomUUID(), other, freeCentre]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('UPDATE cost_centres SET parent_id=NULL WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses a centre referenced only by a supplier invoice, which carries no FK', async () => {
  await expect(deleteCostCentre(company, invoiceCentre)).rejects.toThrow('1 document(s)');
  const kept = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [invoiceCentre]);
  expect(kept.rows.length).toBe(1);
});

it('refuses a parent centre instead of silently reparenting its children', async () => {
  await expect(deleteCostCentre(company, parentCentre)).rejects.toThrow('1 child cost centre(s)');
  const child = await pool.query('SELECT parent_id FROM cost_centres WHERE id=$1', [childCentre]);
  expect(child.rows[0].parent_id).toBe(parentCentre);
});

it('maps a cross-tenant FK violation onto the same refusal, not a 500', async () => {
  // The guard counts nothing: the referencing employee belongs to the other
  // company, so only the RESTRICT FK sees it.
  await expect(deleteCostCentre(company, freeCentre))
    .rejects.toThrow('Cannot delete cost centre that is used by other records. Deactivate instead.');
  const kept = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [freeCentre]);
  expect(kept.rows.length).toBe(1);
});

it('reports not found for another tenant\'s centre rather than claiming a delete', async () => {
  // The scoped DELETE matches no row; RETURNING id makes that visible instead
  // of returning { deleted: true } for a row this tenant never owned.
  await expect(deleteCostCentre(company, foreignCentre)).rejects.toThrow(`Cost centre not found: ${foreignCentre}`);
  const kept = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [foreignCentre]);
  expect(kept.rows.length).toBe(1);
});

it('reports not found for an id that does not exist at all', async () => {
  const ghost = crypto.randomUUID();
  await expect(deleteCostCentre(company, ghost)).rejects.toThrow(`Cost centre not found: ${ghost}`);
});

it('refuses a centre held only by an unallocated bank transaction\'s analysis code', async () => {
  // bankAllocationService copies cc1_id onto the journal line at allocation
  // time, so a dangling id here becomes a dangling id in the ledger.
  await expect(deleteCostCentre(company, bankCentre)).rejects.toThrow('1 bank transaction(s)');
  const stranded = await pool.query('SELECT cc1_id FROM bank_transactions WHERE id=$1', [bankTx]);
  expect(stranded.rows[0].cc1_id).toBe(bankCentre);
});

it('refuses a parent whose only child belongs to another tenant', async () => {
  // Migration 660: the company-scoped children count sees nothing, so the
  // RESTRICT FK is what stops the child being silently reparented to NULL.
  await expect(deleteCostCentre(company, foreignParent))
    .rejects.toThrow('Cannot delete cost centre that is used by other records. Deactivate instead.');
  const child = await pool.query('SELECT parent_id FROM cost_centres WHERE id=$1', [foreignChild]);
  expect(child.rows[0].parent_id).toBe(foreignParent);
});
