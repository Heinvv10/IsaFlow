/**
 * #1699 review: what a supplier merge (the service path, mergeEntities) does with the expected-invoice work of the merged-away
 * supplier: its expectation, its open alerts (a chase can send a real message), and its chase opt-out. Where both suppliers
 * have an alert for one date the survivor's row takes the more advanced state, so no chase goes out twice or for an invoice
 * that arrived.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { sageMergedWorld } from './helpers/sageMergedSupplierWorld';

assertDisposable();
const w = sageMergedWorld('alerts');
const { pool, companyId, userId, inRequestTx, insPlain, bill } = w;

const merge = (survivor: string, gone: string) => inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId, 'admin'), true);

beforeAll(() => w.seed(), 60000);
afterAll(() => w.drop(), 60000);

describe('expectations and expected-invoice alerts (#1699 review)', () => {
  const expect_ = async (supplierId: string, day = 5) => String((await pool.query(
    "INSERT INTO supplier_expectations (company_id, supplier_id, cadence, expected_day_of_month) VALUES ($1, $2, 'monthly', $3) RETURNING id",
    [companyId, supplierId, day])).rows[0].id);
  const alert = async (supplierId: string, expectedBy: string, status = 'pending', expectationId: string | null = null) => String((await pool.query(
    'INSERT INTO expected_invoice_alerts (company_id, supplier_id, expectation_id, expected_by, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [companyId, supplierId, expectationId, expectedBy, status])).rows[0].id);
  const alertRow = async (id: string) => (await pool.query('SELECT supplier_id, expectation_id FROM expected_invoice_alerts WHERE id = $1', [id])).rows[0] ?? null;

  it('moves the expectation and every alert of a date the survivor has none for, resolved and dismissed too (Codex finding 1)', async () => {
    const survivor = await insPlain('Exp Survivor');
    const gone = await insPlain('Exp Gone');
    const e = await expect_(gone);
    const open = await alert(gone, '2026-06-05', 'pending', e);
    const chased = await alert(gone, '2026-07-05', 'chased', e);
    const resolved = await alert(gone, '2026-05-05', 'resolved', e);
    const dismissed = await alert(gone, '2026-04-05', 'dismissed', e);
    await merge(survivor, gone);
    expect(String((await pool.query('SELECT supplier_id FROM supplier_expectations WHERE id = $1', [e])).rows[0].supplier_id)).toBe(survivor);
    expect(await alertRow(open)).toEqual({ supplier_id: survivor, expectation_id: e });
    expect(await alertRow(chased)).toEqual({ supplier_id: survivor, expectation_id: e });
    // A resolved or dismissed date stays settled on the survivor: the gap scan keys on (supplier, date).
    expect(await alertRow(resolved)).toEqual({ supplier_id: survivor, expectation_id: e });
    expect(await alertRow(dismissed)).toEqual({ supplier_id: survivor, expectation_id: e });
  });

  it('where the survivor has its own expectation and an alert for the same date, the survivor\'s rows stay and the source\'s duplicates go', async () => {
    const survivor = await insPlain('Exp Clash Survivor');
    const gone = await insPlain('Exp Clash Gone');
    const own = await expect_(survivor, 10);
    const theirs = await expect_(gone, 20);
    const ownAlert = await alert(survivor, '2026-06-05', 'pending', own);
    const clash = await alert(gone, '2026-06-05', 'pending', theirs);
    const other = await alert(gone, '2026-08-05', 'pending', theirs);
    await merge(survivor, gone);
    const exps = (await pool.query('SELECT id, expected_day_of_month FROM supplier_expectations WHERE company_id = $1 AND supplier_id = ANY($2)', [companyId, [survivor, gone]])).rows;
    expect(exps).toEqual([{ id: own, expected_day_of_month: 10 }]);
    expect(await alertRow(clash)).toBeNull();
    expect(await alertRow(ownAlert)).toEqual({ supplier_id: survivor, expectation_id: own });
    expect(await alertRow(other)).toEqual({ supplier_id: survivor, expectation_id: own });
  });

  const alertFull = async (id: string) => (await pool.query(
    'SELECT supplier_id, status, chased_at, chase_to_address, resolved_invoice_id, resolved_at FROM expected_invoice_alerts WHERE id = $1', [id])).rows[0] ?? null;

  it('a chased source alert beats a pending survivor alert of the same date, with its chase facts, so the cron does not chase again', async () => {
    const survivor = await insPlain('Chase Survivor');
    const gone = await insPlain('Chase Gone');
    const kept = await alert(survivor, '2026-06-05', 'pending');
    const chased = await alert(gone, '2026-06-05', 'chased');
    await pool.query("UPDATE expected_invoice_alerts SET chased_at = '2026-06-10T08:00:00Z', chase_to_address = 'ap@gone.test', chase_method = 'email' WHERE id = $1", [chased]);
    await merge(survivor, gone);
    expect(await alertFull(kept)).toMatchObject({ supplier_id: survivor, status: 'chased', chase_to_address: 'ap@gone.test' });
    expect((await alertFull(kept)).chased_at).not.toBeNull();
    expect(await alertFull(chased)).toBeNull();
  });

  it('a resolved source alert (its bill now on the survivor) resolves the survivor\'s pending alert, and stays on the source as history', async () => {
    const survivor = await insPlain('Resolved Survivor');
    const gone = await insPlain('Resolved Gone', 'sage', '972');
    const kept = await alert(survivor, '2026-06-05', 'pending');
    const history = await alert(gone, '2026-06-05', 'resolved');
    await bill('AP-ALERT-1', 'Resolved Gone', 972);
    const billId = String((await pool.query('SELECT id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [companyId, `AP-ALERT-1-${w.tag}`])).rows[0].id);
    await pool.query("UPDATE expected_invoice_alerts SET resolved_invoice_id = $2, resolved_at = '2026-06-06T08:00:00Z' WHERE id = $1", [history, billId]);
    await merge(survivor, gone);
    expect(await alertFull(kept)).toMatchObject({ supplier_id: survivor, status: 'resolved', resolved_invoice_id: billId });
    expect((await alertFull(history)).supplier_id).toBe(gone);
  });

  it('a pending source alert never downgrades a resolved survivor alert', async () => {
    const survivor = await insPlain('Keep Resolved Survivor');
    const gone = await insPlain('Keep Resolved Gone');
    const kept = await alert(survivor, '2026-06-05', 'resolved');
    await alert(gone, '2026-06-05', 'pending');
    await merge(survivor, gone);
    expect(await alertFull(kept)).toMatchObject({ supplier_id: survivor, status: 'resolved' });
  });

  it('two chased alerts of one date: the survivor keeps its row and gains the chase facts it lacks', async () => {
    const survivor = await insPlain('Both Chased Survivor');
    const gone = await insPlain('Both Chased Gone');
    const kept = await alert(survivor, '2026-06-05', 'chased');
    const other = await alert(gone, '2026-06-05', 'chased');
    await pool.query("UPDATE expected_invoice_alerts SET chased_at = '2026-06-10T08:00:00Z', chase_to_address = 'ap@gone.test' WHERE id = $1", [other]);
    await merge(survivor, gone);
    expect(await alertFull(kept)).toMatchObject({ status: 'chased', chase_to_address: 'ap@gone.test' });
  });

  it('the chase opt-out of the source is carried to the survivor, and a muted survivor stays muted', async () => {
    const mutedGone = await insPlain('Muted Gone');
    const survivor = await insPlain('Unmuted Survivor');
    await pool.query('UPDATE suppliers SET chase_opted_out = TRUE WHERE id = $1', [mutedGone]);
    await merge(survivor, mutedGone);
    expect((await pool.query('SELECT chase_opted_out FROM suppliers WHERE id = $1', [survivor])).rows[0].chase_opted_out).toBe(true);
    const audit = (await pool.query("SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'supplier' AND entity_id = $2", [companyId, survivor])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].changes.fields).toEqual([{ field: 'chase_opted_out', old: 'false', new: 'true', label: 'Chase opt-out' }]);
    const mutedSurvivor = await insPlain('Muted Survivor');
    const openGone = await insPlain('Open Gone');
    await pool.query('UPDATE suppliers SET chase_opted_out = TRUE WHERE id = $1', [mutedSurvivor]);
    await merge(mutedSurvivor, openGone);
    expect((await pool.query('SELECT chase_opted_out FROM suppliers WHERE id = $1', [mutedSurvivor])).rows[0].chase_opted_out).toBe(true);
  });

  it('a history alert moves and follows the survivor\'s expectation; one whose date the survivor holds stays, unlinked', async () => {
    const survivor = await insPlain('Hist Survivor');
    const gone = await insPlain('Hist Gone');
    const own = await expect_(survivor, 10);
    const theirs = await expect_(gone, 20);
    const history = await alert(gone, '2026-03-05', 'resolved', theirs);
    const open = await alert(gone, '2026-07-05', 'pending', theirs);
    await alert(survivor, '2026-02-05', 'pending', own);
    const shadowed = await alert(gone, '2026-02-05', 'dismissed', theirs);
    await merge(survivor, gone);
    expect(await alertRow(history)).toEqual({ supplier_id: survivor, expectation_id: own });
    expect(await alertRow(open)).toEqual({ supplier_id: survivor, expectation_id: own });
    // The survivor's 02-05 alert took the dismissal (more advanced state); the source's row stays as history, its expectation gone.
    expect(await alertRow(shadowed)).toEqual({ supplier_id: gone, expectation_id: null });
  });

  it('a resolved source alert never erases the chase a chased survivor alert really sent; the resolution is carried', async () => {
    const survivor = await insPlain('Keep Chase Survivor');
    const gone = await insPlain('Keep Chase Gone', 'sage', '985');
    const kept = await alert(survivor, '2026-06-05', 'chased');
    await pool.query("UPDATE expected_invoice_alerts SET chased_at = '2026-06-10T08:00:00Z', chase_to_address = 'ap@survivor.test', chase_method = 'email' WHERE id = $1", [kept]);
    const history = await alert(gone, '2026-06-05', 'resolved');   // never chased
    await bill('AP-ALERT-2', 'Keep Chase Gone', 985);
    const billId = String((await pool.query('SELECT id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [companyId, `AP-ALERT-2-${w.tag}`])).rows[0].id);
    await pool.query("UPDATE expected_invoice_alerts SET resolved_invoice_id = $2, resolved_at = '2026-06-11T08:00:00Z' WHERE id = $1", [history, billId]);
    await merge(survivor, gone);
    const row = await alertFull(kept);
    expect(row).toMatchObject({ supplier_id: survivor, status: 'resolved', resolved_invoice_id: billId, chase_to_address: 'ap@survivor.test' });
    expect(new Date(row.chased_at).toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });
});
