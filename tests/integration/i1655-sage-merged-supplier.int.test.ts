/**
 * #1655 review M1: a supplier merged away (A into B) must not come back on a Sage
 * re-sync. Before migration 1020 nothing recorded the survivor, and the Sage match
 * (live rows only) re-created A as a new live supplier, so A's new Sage bills
 * landed there and AP split from B. Now mergeSuppliers sets merged_into_id and
 * sagePartyMatch follows a deleted, merged supplier to its live survivor (a bounded,
 * cycle-safe chain). Through the real merge, commit and AP import on a throwaway
 * cluster, each in a committed request transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { commitAPInvoice } from '@/modules/admin/services/sageMigrationCommitService';
import { commitSageMigration } from '@/modules/admin/services/sageMigrationOrchestrator';
import { mergeEntities } from '@/modules/accounting/services/core/duplicateMergeService';
import { restoreRow } from '@/modules/accounting/services/core/softDeleteRowOps';
import { MAX_MERGE_HOPS, resolveSageSupplier } from '@/modules/admin/services/sagePartyMatch';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companyId = randomUUID();
const userId = randomUUID();
const tag = companyId.slice(0, 8);

async function inRequestTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId, companyId, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const party = (sageId: number | undefined, name: string) => ({ name, sageId, email: '', phone: '', vatNumber: '', contactPerson: '' });
const syncSuppliers = (records: ReturnType<typeof party>[]) =>
  inRequestTx(() => commitSageMigration({ companyId, userId, pulled: { suppliers: { records } } }));
const byRef = async (ref: string) => (await pool.query(
  "SELECT id, deleted_at IS NOT NULL AS deleted, merged_into_id FROM suppliers WHERE company_id = $1 AND external_system = 'sage' AND external_ref = $2",
  [companyId, ref])).rows;
const liveNamed = async (name: string) => (await pool.query(
  'SELECT id, external_ref FROM suppliers WHERE company_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2) ORDER BY created_at',
  [companyId, name])).rows;

let a = '';
let b = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, `i1655 merged ${tag}`]);
  await pool.query(`INSERT INTO users (id, email, role, is_active, account_type) VALUES ($1, $2, 'admin', true, 'direct')`,
    [userId, `${userId}@i1655m.test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
     VALUES ($1, '2100', 'AP', 'liability', 'payable', 'credit', true, true),
            ($1, '1140', 'VAT Input', 'asset', 'vat_input', 'debit', true, true),
            ($1, '6000', 'Expense', 'expense', 'default_expense', 'debit', true, true)`, [companyId]);
  await pool.query(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
     VALUES ($1, 'FY26', 1, 2026, '2026-01-01', '2026-12-31', 'open')`, [companyId]);
  clearSystemAccountCache(companyId);
  // Sage holds A and B as two suppliers; IsaFlow imports both, then a user merges A into B.
  await syncSuppliers([party(801, 'Hill Hardware'), party(802, 'Hill Hardware Pty Ltd')]);
  a = String((await byRef('801'))[0].id);
  b = String((await byRef('802'))[0].id);
  await inRequestTx(() => mergeEntities(companyId, 'supplier', b, a, userId));
}, 60000);

afterAll(async () => {
  try {
    clearSystemAccountCache(companyId);
    const c = [companyId];
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = $1', c);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)', c);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', c);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', c);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', c);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', c);
    await pool.query('DELETE FROM suppliers WHERE company_id = $1', c);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM companies WHERE id = $1', c);
  } finally { await pool.end(); }
}, 60000);

describe('a merged-away supplier resolves to its survivor on a Sage re-sync (#1655 M1)', () => {
  it('the merge records its survivor', async () => {
    expect(await byRef('801')).toEqual([{ id: a, deleted: true, merged_into_id: b }]);
  });

  it('re-syncing both Sage suppliers inserts nothing: A matches B, and B keeps its own Sage id', async () => {
    expect((await syncSuppliers([party(801, 'Hill Hardware'), party(802, 'Hill Hardware Pty Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await liveNamed('Hill Hardware')).toEqual([]);
    expect(await liveNamed('Hill Hardware Pty Ltd')).toEqual([{ id: b, external_ref: '802' }]);
  });

  it('a pull without Sage ids still reaches the survivor by the merged-away name', async () => {
    expect((await syncSuppliers([party(undefined, 'hill hardware ')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await liveNamed('Hill Hardware')).toEqual([]);
  });

  it('a survivor reached through a merge is not stamped with the merged-away Sage id', async () => {
    // B2 was keyed in by hand (no Sage id); Sage A2 was imported and then merged into it.
    const b2 = String((await pool.query("INSERT INTO suppliers (company_id, name) VALUES ($1, 'Ivy Paints Ltd') RETURNING id",
      [companyId])).rows[0].id);
    await syncSuppliers([party(811, 'Ivy Paints')]);
    const a2 = String((await byRef('811'))[0].id);
    await inRequestTx(() => mergeEntities(companyId, 'supplier', b2, a2, userId));
    // A2 first: it reaches B2 through the merge and must leave B2 unstamped, so Sage's own B2 (812) still finds it by name.
    expect((await syncSuppliers([party(811, 'Ivy Paints'), party(812, 'Ivy Paints Ltd')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
    expect(await liveNamed('Ivy Paints Ltd')).toEqual([{ id: b2, external_ref: '812' }]);
  });

  it("a new Sage bill for A lands on B", async () => {
    const number = `AP-M1-${tag}`;
    const out = await inRequestTx(() => commitAPInvoice(companyId, userId, {
      invoiceNumber: number, supplierName: 'Hill Hardware', supplierSageId: 801, invoiceDate: '2026-04-02',
      subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
    }));
    expect(out.created).toBe(true);
    const { rows } = await pool.query('SELECT supplier_id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2',
      [companyId, number]);
    expect(rows.map((r) => String(r.supplier_id))).toEqual([b]);
  });

  it('a chain (C into D, D into E) resolves to the end; a cycle of deleted rows ends, and the party is created live', async () => {
    const ins = async (name: string, ref: string) => String((await pool.query(
      "INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, 'sage', $3) RETURNING id",
      [companyId, name, ref])).rows[0].id);
    const [cId, dId, eId] = [await ins('Chain C', '901'), await ins('Chain D', '902'), await ins('Chain E', '903')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [cId, dId]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [dId, eId]);
    expect((await syncSuppliers([party(901, 'Chain C')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await liveNamed('Chain C'))).toEqual([]);

    const [xId, yId] = [await ins('Loop X', '911'), await ins('Loop Y', '912')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [xId, yId]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [yId, xId]);
    expect((await syncSuppliers([party(911, 'Loop X')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Loop X')).map((r) => r.external_ref)).toEqual(['911']);
  });
  it('a chain longer than MAX_MERGE_HOPS does not reach the far survivor: the party is created live', async () => {
    const ins = async (name: string, ref: string | null) => String((await pool.query(
      "INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, $3, $4) RETURNING id",
      [companyId, name, ref ? 'sage' : null, ref])).rows[0].id);
    // MAX_MERGE_HOPS + 1 merged-away rows ending in one live survivor: the survivor is MAX_MERGE_HOPS + 1 hops from the first.
    const live = await ins('Long Chain Survivor', null);
    let next = live;
    const ids: string[] = [];
    for (let i = MAX_MERGE_HOPS; i >= 0; i--) {
      const id = await ins(`Long Chain ${i}`, i === 0 ? '921' : null);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [id, next]);
      ids.push(id);
      next = id;
    }
    expect((await syncSuppliers([party(921, 'Long Chain 0')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Long Chain 0')).map((r) => r.external_ref)).toEqual(['921']);
    // The same chain one hop shorter does resolve (the cap is MAX_MERGE_HOPS hops, inclusive).
    const shortLive = await ins('Short Chain Survivor', null);
    let hop = shortLive;
    let first = '';
    for (let i = MAX_MERGE_HOPS; i > 0; i--) {
      first = await ins(`Short Chain ${i}`, i === 1 ? '922' : null);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [first, hop]);
      hop = first;
    }
    expect((await syncSuppliers([party(922, 'Short Chain 1')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect(await liveNamed('Short Chain 1')).toEqual([]);
  });

  it('a name hit on an unstamped merged-away row stamps it, so a later different Sage party of that name gets its own row', async () => {
    // Imported by hand (no Sage id), merged into a survivor, as before Sage ever knew it.
    const ins = async (name: string) => String((await pool.query(
      'INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name])).rows[0].id);
    const survivor = await ins('Oak Timber Pty Ltd');
    const gone = await ins('Oak Timber');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    expect((await syncSuppliers([party(931, 'Oak Timber')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    // The merged-away row is stamped; the survivor is not.
    expect(await byRef('931')).toEqual([{ id: gone, deleted: true, merged_into_id: survivor }]);
    expect(await liveNamed('Oak Timber Pty Ltd')).toEqual([{ id: survivor, external_ref: null }]);
    // A genuinely different Sage supplier of the same name gets its own live row.
    expect((await syncSuppliers([party(932, 'Oak Timber')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Oak Timber')).map((r) => r.external_ref)).toEqual(['932']);
    // Re-syncing the first still resolves to the survivor and creates nothing.
    expect((await syncSuppliers([party(931, 'Oak Timber')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await liveNamed('Oak Timber')).map((r) => r.external_ref)).toEqual(['932']);
    expect(await liveNamed('Oak Timber Pty Ltd')).toEqual([{ id: survivor, external_ref: null }]);
  });

  it('a pull with no Sage id reaches the survivor and stamps nothing', async () => {
    const ins = async (name: string) => String((await pool.query(
      'INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id', [companyId, name])).rows[0].id);
    const survivor = await ins('Elm Supplies Pty Ltd');
    const gone = await ins('Elm Supplies');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    await syncSuppliers([party(undefined, 'Elm Supplies')]);
    const { rows } = await pool.query('SELECT external_ref FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0].external_ref).toBeNull();
  });

  const insPlain = async (name: string, system: string | null = null, ref: string | null = null) => String((await pool.query(
    'INSERT INTO suppliers (company_id, name, external_system, external_ref) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, name, system, ref])).rows[0].id);
  const bill = (number: string, name: string, sageId: number) => inRequestTx(() => commitAPInvoice(companyId, userId, {
    invoiceNumber: `${number}-${tag}`, supplierName: name, supplierSageId: sageId, invoiceDate: '2026-04-02',
    subtotal: 100, taxAmount: 15, totalAmount: 115, amountPaid: 115,
  }));
  const billSupplier = async (number: string) => String((await pool.query(
    'SELECT supplier_id FROM supplier_invoices WHERE company_id = $1 AND invoice_number = $2', [companyId, `${number}-${tag}`])).rows[0].supplier_id);

  it('merged-away rows of one name leading to different survivors are ambiguous: each Sage party gets its own row', async () => {
    const [s1, s2] = [await insPlain('Pine Co Survivor One'), await insPlain('Pine Co Survivor Two')];
    const [g1, g2] = [await insPlain('Pine Co'), await insPlain('Pine Co')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [g1, s1]);
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [g2, s2]);
    // Creation order does not pick a survivor: neither merged-away row is matched or stamped.
    await expect(bill('AP-PINE-1', 'Pine Co', 941)).rejects.toThrow('Supplier not found: Pine Co');
    expect((await syncSuppliers([party(941, 'Pine Co'), party(942, 'Pine Co')])).suppliers)
      .toEqual({ created: 2, skipped: 0, failed: [] });
    for (const ref of ['941', '942']) {
      expect(await byRef(ref)).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    }
    const { rows } = await pool.query('SELECT external_ref FROM suppliers WHERE id = ANY($1)', [[g1, g2]]);
    expect(rows).toEqual([{ external_ref: null }, { external_ref: null }]);
    // Re-syncing finds each by its own id and creates nothing.
    expect((await syncSuppliers([party(941, 'Pine Co'), party(942, 'Pine Co')])).suppliers)
      .toEqual({ created: 0, skipped: 2, failed: [] });
  });

  it('merged-away rows of one name leading to the SAME survivor are no ambiguity', async () => {
    const survivor = await insPlain('Larch Co Survivor');
    const [g1, g2] = [await insPlain('Larch Co'), await insPlain('Larch Co')];
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = ANY($1)', [[g1, g2], survivor]);
    expect((await bill('AP-LARCH-1', 'Larch Co', 945)).created).toBe(true);
    expect(await billSupplier('AP-LARCH-1')).toBe(survivor);
  });

  it('a claim lost to a concurrent import matches again: two Sage parties never share one row', async () => {
    const live = await insPlain('Birch Co');
    // Import 1 claims the unstamped live row for Sage id 991 and holds its transaction open.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const first = await als.run({ client: holder, userId, companyId, claims: {} } as never,
        () => resolveSageSupplier(companyId, { name: 'Birch Co', sageId: 991 }));
      expect(first?.id).toBe(live);
      // Import 2 (Sage id 992, same name) matched the same row; its claim waits on import 1's lock.
      const second = syncSuppliers([party(992, 'Birch Co')]);
      // Wait until import 2 is blocked on that row lock, so the claim it makes is the one that loses.
      for (let i = 0; i < 100; i++) {
        const { rows } = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE suppliers SET external_system%'");
        if (rows.length) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query('COMMIT');
      expect((await second).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    } finally { holder.release(); }
    expect((await byRef('991')).map((r) => r.id)).toEqual([live]);
    const own = await byRef('992');
    expect(own).toEqual([{ id: expect.any(String), deleted: false, merged_into_id: null }]);
    expect(own[0].id).not.toBe(live);
  });

  it('a merged-away row carrying another system\'s ref is not matched by name, so a Sage party of that name is created', async () => {
    const survivor = await insPlain('Ash Traders Survivor');
    const gone = await insPlain('Ash Traders', 'xero', 'X-1');
    await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
    expect((await syncSuppliers([party(961, 'Ash Traders')])).suppliers).toEqual({ created: 1, skipped: 0, failed: [] });
    expect((await liveNamed('Ash Traders')).map((r) => r.external_ref)).toEqual(['961']);
    // The xero row is untouched; a live row of that name with another system's ref still matches by name.
    const { rows } = await pool.query('SELECT external_system, external_ref FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0]).toEqual({ external_system: 'xero', external_ref: 'X-1' });
    const live = await insPlain('Cedar Works', 'xero', 'X-2');
    expect((await syncSuppliers([party(962, 'Cedar Works')])).suppliers).toEqual({ created: 0, skipped: 1, failed: [] });
    expect((await pool.query('SELECT external_ref FROM suppliers WHERE id = $1', [live])).rows[0].external_ref).toBe('X-2');
  });

  it('a bill for an unstamped merged-away supplier stamps it like the sync does, so the order of bills and suppliers does not matter', async () => {
    const mk = async (base: string) => {
      const survivor = await insPlain(`${base} Survivor`);
      const gone = await insPlain(base);
      await pool.query('UPDATE suppliers SET deleted_at = now(), merged_into_id = $2 WHERE id = $1', [gone, survivor]);
      return { survivor, gone };
    };
    // Bills first, then the suppliers.
    const fir = await mk('Fir Mills');
    expect((await bill('AP-FIR-1', 'Fir Mills', 951)).created).toBe(true);
    expect(await billSupplier('AP-FIR-1')).toBe(fir.survivor);
    expect((await byRef('951')).map((r) => r.id)).toEqual([fir.gone]);
    expect((await syncSuppliers([party(951, 'Fir Mills'), party(952, 'Fir Mills')])).suppliers).toEqual({ created: 1, skipped: 1, failed: [] });
    expect((await liveNamed('Fir Mills')).map((r) => r.external_ref)).toEqual(['952']);
    // Suppliers first, then the bills.
    const yew = await mk('Yew Mills');
    expect((await syncSuppliers([party(971, 'Yew Mills'), party(972, 'Yew Mills')])).suppliers).toEqual({ created: 1, skipped: 1, failed: [] });
    expect((await bill('AP-YEW-1', 'Yew Mills', 971)).created).toBe(true);
    expect((await bill('AP-YEW-2', 'Yew Mills', 972)).created).toBe(true);
    expect(await billSupplier('AP-YEW-1')).toBe(yew.survivor);
    expect(await billSupplier('AP-YEW-2')).toBe(String((await liveNamed('Yew Mills'))[0].id));
  });

  it('restoring a merged-away supplier clears its survivor link', async () => {
    const survivor = await insPlain('Reed Co Survivor');
    const gone = await insPlain('Reed Co');
    await inRequestTx(() => mergeEntities(companyId, 'supplier', survivor, gone, userId));
    const { rows: before } = await pool.query('SELECT deleted_at, merged_into_id FROM suppliers WHERE id = $1', [gone]);
    expect(before[0].deleted_at).not.toBeNull();
    expect(before[0].merged_into_id).toBe(survivor);
    expect(await inRequestTx(() => restoreRow('supplier', gone, companyId))).toBe(true);
    const { rows } = await pool.query('SELECT deleted_at, merged_into_id FROM suppliers WHERE id = $1', [gone]);
    expect(rows[0]).toEqual({ deleted_at: null, merged_into_id: null });
  });
});
