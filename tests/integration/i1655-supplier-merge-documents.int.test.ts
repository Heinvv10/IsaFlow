/**
 * #1699 review: what a supplier merge (the service path, mergeEntities) moves besides payments and bills, and what it
 * refuses. Purchase orders move under updatePurchaseOrder's supplier-change controls (an owner / admin for approved ones, an
 * audit row each, approved_by restamped); supplier credit notes move with their approval authors; the intercompany side
 * follows the supplier; open expectations and alerts follow it, history stays. The route path is in
 * supplier-merge-route-drc-flag.int.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SupplierMergeRefusal, mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { APPROVED_EDIT_REFUSAL } from '@/modules/accounting/services/ap/purchaseOrderUpdate';
import { PO_BILL_LINKS_REFUSAL } from '@/modules/accounting/services/core/duplicateMergeService';
import { BOTH_SIDES_REFUSAL, SIDE_GUARD_REFUSAL } from '@/modules/accounting/services/core/supplierMergeOpenWork';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';
import { plantExternal } from './intercompany/intercompany.plant';
import { asOwner } from './intercompany/intercompany.session';
import { autoPostApprovalGuard } from '@/modules/accounting/services/bank/bankRuleAutoPostApproval';
/** #1656: mergeEntities' bank-rule guard (a customer merge's); a supplier merge re-points no bank rule. */
const NO_RULE_GUARD = autoPostApprovalGuard(true);

assertDisposable();
const w = sageMergedWorld('docs');
const { pool, companyId, userId, tag, inRequestTx, insPlain, bill, billSupplier } = w;
const partner = randomUUID();
const partner2 = randomUUID();

const merge = (survivor: string, gone: string, role: string | null = 'admin') =>
  inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId, NO_RULE_GUARD, role), true);
const seedPo = async (supplierId: string, number: string, status = 'approved') => String((await pool.query(
  'INSERT INTO purchase_orders (company_id, po_number, supplier_id, status, approved_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
  [companyId, `${number}-${tag}`, supplierId, status, status === 'draft' ? null : 'original-approver'])).rows[0].id);
const seedCreditNote = async (supplierId: string, status = 'draft') => String((await pool.query(
  "INSERT INTO credit_notes (company_id, type, supplier_id, credit_date, created_by, status) VALUES ($1, 'supplier', $2, '2026-04-03', $3, $4) RETURNING id",
  [companyId, supplierId, userId, status])).rows[0].id);
const ownerOf = async (table: 'purchase_orders' | 'credit_notes', id: string) =>
  String((await pool.query(`SELECT supplier_id FROM ${table} WHERE id = $1`, [id])).rows[0].supplier_id);
const auditRows = async (poId: string) => (await pool.query(
  "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'purchase_order' AND entity_id = $2 AND action = 'update'",
  [companyId, poId])).rows.map((r) => r.changes);

beforeAll(async () => {
  await w.seed();
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [partner, `i1655 partner ${tag}`, partner2, `i1655 partner2 ${tag}`]);
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM intercompany_connection_sides WHERE company_id = $1', [companyId]);
  await pool.query('DELETE FROM intercompany_connections WHERE company_low_id = ANY($1) OR company_high_id = ANY($1)', [[partner, partner2]]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[partner, partner2]]);
  await w.drop();
}, 60000);

describe('purchase orders (#1699 review)', () => {
  it('an owner / admin merge moves them to the survivor and writes one audit row per PO, restamping the approved one', async () => {
    const survivor = await insPlain('Doc Mover Survivor');
    const gone = await insPlain('Doc Mover');
    const approved = await seedPo(gone, 'PO-A');
    const draft = await seedPo(gone, 'PO-D', 'draft');
    const stays = await seedPo(survivor, 'PO-S');
    await merge(survivor, gone, 'admin');
    for (const id of [approved, draft, stays]) expect(await ownerOf('purchase_orders', id)).toBe(survivor);
    const a = await auditRows(approved);
    expect(a).toHaveLength(1);
    expect(a[0].fields).toEqual([{ field: 'supplier_id', old: gone, new: survivor, label: 'Supplier' }]);
    expect(a[0].metadata).toMatchObject({ source: 'supplier-merge', status: 'approved', prior_approved_by: 'original-approver' });
    expect(await auditRows(draft)).toHaveLength(1);
    expect(await auditRows(stays)).toHaveLength(0);
    const { rows } = await pool.query('SELECT id, approved_by FROM purchase_orders WHERE id = ANY($1)', [[approved, draft]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.approved_by]))).toEqual({ [approved]: userId, [draft]: null });
  });

  it.each([['manager'], [null]])('a merge by role %s is refused while an approved or later PO would move, and moves nothing', async (role) => {
    const survivor = await insPlain(`Refused Survivor ${role}`);
    const gone = await insPlain(`Refused ${role}`);
    const received = await seedPo(gone, `PO-R-${role}`, 'received');
    const cn = await seedCreditNote(gone);
    await expect(merge(survivor, gone, role)).rejects.toThrow(SupplierMergeRefusal);
    await expect(merge(survivor, gone, role)).rejects.toThrow(APPROVED_EDIT_REFUSAL);
    expect(await ownerOf('purchase_orders', received)).toBe(gone);
    expect(await ownerOf('credit_notes', cn)).toBe(gone);
    expect(await auditRows(received)).toHaveLength(0);
  });

  it('a manager may merge a supplier whose POs are all draft or submitted', async () => {
    const survivor = await insPlain('Manager Survivor');
    const gone = await insPlain('Manager Gone');
    const draft = await seedPo(gone, 'PO-MD', 'draft');
    const submitted = await seedPo(gone, 'PO-MS', 'submitted');
    await merge(survivor, gone, 'manager');
    expect(await ownerOf('purchase_orders', draft)).toBe(survivor);
    expect(await ownerOf('purchase_orders', submitted)).toBe(survivor);
  });

  it('a merge refuses, before moving anything, a supplier whose purchase order has a bill linked to it', async () => {
    const survivor = await insPlain('Link Keeper Survivor');
    const gone = await insPlain('Link Keeper', 'sage', '981');
    const po = await seedPo(gone, 'PO-LINK');
    const cn = await seedCreditNote(gone);
    await bill('AP-LINK-1', 'Link Keeper', 981);
    const billId = String((await pool.query('SELECT id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, `AP-LINK-1-${tag}`])).rows[0].id);
    await pool.query("INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source) VALUES ($1, $2, $3, 10, 'app')",
      [companyId, po, billId]);
    await expect(merge(survivor, gone)).rejects.toBeInstanceOf(SupplierMergeRefusal);
    expect(await ownerOf('purchase_orders', po)).toBe(gone);
    expect(await ownerOf('credit_notes', cn)).toBe(gone);
    expect(await billSupplier('AP-LINK-1')).toBe(gone);
  });

  it('a cancelled PO moves for a manager (it commits nothing); a received one needs owner / admin, keeps its approver and records it', async () => {
    const survivor = await insPlain('Status Survivor');
    const gone = await insPlain('Status Gone');
    const cancelled = await seedPo(gone, 'PO-X', 'cancelled');
    await merge(survivor, gone, 'manager');
    expect(await ownerOf('purchase_orders', cancelled)).toBe(survivor);

    const survivor2 = await insPlain('Received Survivor');
    const gone2 = await insPlain('Received Gone');
    const received = await seedPo(gone2, 'PO-RC', 'received');
    await expect(merge(survivor2, gone2, 'manager')).rejects.toThrow(/approved, partly received or received/);
    await merge(survivor2, gone2, 'owner');
    const { rows } = await pool.query('SELECT supplier_id, approved_by FROM purchase_orders WHERE id = $1', [received]);
    expect(rows[0]).toEqual({ supplier_id: survivor2, approved_by: 'original-approver' });
    expect((await auditRows(received))[0].metadata).toMatchObject({ status: 'received', prior_approved_by: 'original-approver' });
  });

  it('reassignedTransactions counts moved transactions only: a bill, a PO and a credit note, not the side, expectation or alerts', async () => {
    const survivor = await insPlain('Count Survivor');
    const gone = await insPlain('Count Gone', 'sage', '983');
    await bill('AP-CNT-1', 'Count Gone', 983);
    await seedPo(gone, 'PO-CNT', 'draft');
    await seedCreditNote(gone);
    const exp = String((await pool.query(
      "INSERT INTO supplier_expectations (company_id, supplier_id, cadence) VALUES ($1, $2, 'monthly') RETURNING id", [companyId, gone])).rows[0].id);
    await pool.query("INSERT INTO expected_invoice_alerts (company_id, supplier_id, expectation_id, expected_by, status) VALUES ($1, $2, $3, '2026-06-05', 'pending')",
      [companyId, gone, exp]);
    expect((await merge(survivor, gone)).reassignedTransactions).toBe(3);
  });
});

describe('supplier credit notes (#1699 review)', () => {
  it('an approved one re-parents with its status and approver kept, and the merging user becomes an author, as for bills', async () => {
    const survivor = await insPlain('CN Survivor');
    const gone = await insPlain('CN Gone');
    const cn = await seedCreditNote(gone, 'approved');
    await pool.query('UPDATE credit_notes SET approved_by = $2 WHERE id = $1', [cn, userId]);
    await merge(survivor, gone);
    const { rows } = await pool.query('SELECT supplier_id, status, approved_by, $2::uuid = ANY(content_authors) AS authored FROM credit_notes WHERE id = $1', [cn, userId]);
    expect(rows[0]).toEqual({ supplier_id: survivor, status: 'approved', approved_by: userId, authored: true });
  });

  it('a customer credit note is untouched by a supplier merge', async () => {
    const survivor = await insPlain('CN Cust Survivor');
    const gone = await insPlain('CN Cust Gone');
    const customer = String((await pool.query("INSERT INTO customers (company_id, name) VALUES ($1, 'CN Customer') RETURNING id", [companyId])).rows[0].id);
    const cn = String((await pool.query(
      "INSERT INTO credit_notes (company_id, type, client_id, credit_date, created_by, status) VALUES ($1, 'customer', $2, '2026-04-03', $3, 'draft') RETURNING id",
      [companyId, customer, userId])).rows[0].id);
    const before = (await pool.query('SELECT * FROM credit_notes WHERE id = $1', [cn])).rows[0];
    await merge(survivor, gone);
    expect((await pool.query('SELECT * FROM credit_notes WHERE id = $1', [cn])).rows[0]).toEqual(before);
    await pool.query('DELETE FROM credit_notes WHERE id = $1', [cn]);
    await pool.query('DELETE FROM customers WHERE id = $1', [customer]);
  });
});

describe('the intercompany side (#1699 review)', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM intercompany_connection_sides WHERE company_id = $1', [companyId]);
    await pool.query('DELETE FROM intercompany_connections WHERE company_low_id = $1 OR company_high_id = $1', [companyId]);
  });

  const plantSide = async (supplierId: string, connection: string, other = partner) => asOwner(pool, userId, companyId, (q) => q.query(
    'INSERT INTO intercompany_connection_sides (connection_id, company_id, partner_company_id, supplier_id) VALUES ($1, $2, $3, $4)',
    [connection, companyId, other, supplierId]), true);
  const sideSupplier = async (connection: string) => (await pool.query(
    'SELECT supplier_id FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [connection, companyId])).rows[0].supplier_id;

  it('follows the supplier to the survivor, so the pairing keeps working', async () => {
    const survivor = await insPlain('IC Survivor');
    const gone = await insPlain('IC Gone');
    const connection = await plantExternal(pool, companyId, partner, 'active', userId);
    await plantSide(gone, connection);
    await merge(survivor, gone);
    expect(await sideSupplier(connection)).toBe(survivor);
    await pool.query('DELETE FROM intercompany_connections WHERE id = $1', [connection]);
  });

  it('a merge of two suppliers that both hold a side is refused, and moves nothing', async () => {
    const survivor = await insPlain('IC Both Survivor');
    const gone = await insPlain('IC Both Gone');
    const first = await plantExternal(pool, companyId, partner, 'active', userId);
    const second = await plantExternal(pool, companyId, partner2, 'active', userId);
    await plantSide(gone, first);
    await plantSide(survivor, second, partner2);
    await expect(merge(survivor, gone)).rejects.toThrow(BOTH_SIDES_REFUSAL);
    expect(await sideSupplier(first)).toBe(gone);
    expect(await sideSupplier(second)).toBe(survivor);
    expect((await pool.query('SELECT deleted_at FROM suppliers WHERE id = $1', [gone])).rows[0].deleted_at).toBeNull();
  });

  it('a session the sides guard refuses (no write role claims) gets a refusal, not a server error, and nothing moved', async () => {
    const survivor = await insPlain('IC Guard Survivor');
    const gone = await insPlain('IC Guard Gone');
    const connection = await plantExternal(pool, companyId, partner, 'active', userId);
    await plantSide(gone, connection);
    const po = await seedPo(gone, 'PO-GUARD', 'draft');
    await expect(inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId, NO_RULE_GUARD, 'admin')))
      .rejects.toThrow(SIDE_GUARD_REFUSAL);
    expect(await sideSupplier(connection)).toBe(gone);
    expect(await ownerOf('purchase_orders', po)).toBe(gone);
    await pool.query('DELETE FROM intercompany_connections WHERE id = $1', [connection]);
  });
});
