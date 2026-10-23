/**
 * Migration 923's re-stamp (Hein, 2026-10-23): a stored supplier_payment / payment_batch digest that equals its
 * document's digest under the OLD definition (867's content, 874's digest) moves to the new definition's digest, so an
 * approval of content that has not changed still clears after the deploy; one whose content changed before the deploy
 * keeps its old digest and still needs re-approval. Both stores: approval_requests.document_digest (pending and
 * approved) and supplier_payment_batches.approved_digest (922). The counts are reported by RAISE NOTICE.
 *
 * The old definitions are put back (committed) for the setup, the approvals taken through the real routes, then the
 * migration file is run as the deploy runs it; afterAll runs it again so the new definitions are live whatever failed.
 * Disposable fixture DB only; one file at a time (it replaces two functions database-wide while it runs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const submitEftBatch = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch }));

import { updateSupplier } from '@/modules/accounting/services/core/supplierWriteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr5, enforcePay, inRequest, payCompany, plantBill, plantPayment, plantSupplier } from './r035-pr5.helpers';
import { CHANGED, digestKit } from './ap-batch-approved-digest.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const { r, eft, fixture, approve, changeBank, storedDigest } = digestKit(pool, u, tokens, companies);

const SQL_DIR = 'scripts/migrations/sql';
const MIGRATION = readFileSync(`${SQL_DIR}/923_payment_digest_payee_name_originator.sql`, 'utf8');
/** One CREATE OR REPLACE FUNCTION statement, as a migration file defines it. */
function definition(file: string, fn: string): string {
  const text = readFileSync(`${SQL_DIR}/${file}`, 'utf8');
  const from = text.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  const to = text.indexOf('\n$$;', from);
  if (from < 0 || to < 0) throw new Error(`${fn} not found in ${file}`);
  return text.slice(from, to + 4);
}
const OLD_CONTENT = definition('867_supplier_payment_approval_enforcement.sql', 'approval_supplier_payment_content');
const OLD_DIGEST = definition('874_customer_invoice_line_revenue_coding.sql', 'approval_document_digest');
const OLD_AUTHORS = definition('867_supplier_payment_approval_enforcement.sql', 'approval_supplier_payment_authors');

/** The migration, in one transaction as apply-migrations runs it; returns its notices. */
async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const notices: string[] = [];
  client.on('notice', (n) => notices.push(n.message ?? ''));
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return notices.filter((n) => n.startsWith('migration 923'));
}

/** What the migration should re-stamp: stored digests that equal the live (old) definition's digest now. */
async function matchingNow() {
  const { rows: [row] } = await pool.query(`
    SELECT (SELECT count(*)::INT FROM approval_requests ar
            WHERE ar.document_type IN ('supplier_payment', 'payment_batch') AND ar.status IN ('pending', 'approved')
              AND ar.document_digest = approval_document_digest(ar.company_id, ar.document_type, ar.document_id)) AS req,
           (SELECT count(*)::INT FROM approval_requests ar
            WHERE ar.document_type IN ('supplier_payment', 'payment_batch') AND ar.status IN ('pending', 'approved')) AS req_all,
           (SELECT count(*)::INT FROM supplier_payment_batches b
            WHERE b.approved_digest = approval_document_digest(b.company_id, 'payment_batch', b.id)) AS bat,
           (SELECT count(*)::INT FROM supplier_payment_batches b WHERE b.approved_digest IS NOT NULL) AS bat_all`);
  return row as { req: number; req_all: number; bat: number; bat_all: number };
}

const requestDigest = async (id: string) =>
  (await pool.query('SELECT document_digest FROM approval_requests WHERE id = $1', [id])).rows[0].document_digest as string;

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
beforeEach(() => {
  submitEftBatch.mockReset();
  submitEftBatch.mockResolvedValue({ success: true, batchReference: 'RESTAMP-SPY', mock: true });
});
afterAll(async () => {
  await migrate();
  await cleanupPr5(pool, companies, Object.values(u));
});

describe('migration 923 re-stamps what is provably unchanged since approval', () => {
  it('unchanged approvals still clear after it; ones whose content changed before it do not', async () => {
    await pool.query(OLD_CONTENT);
    await pool.query(OLD_DIGEST);

    // Enforcement off: the stored batch digest (922).
    const kept = await fixture();
    await approve(kept.c, kept.b.id);
    const moved = await fixture();
    await approve(moved.c, moved.b.id);
    await changeBank(moved.c, moved.supplierId);
    // Enforcement on: approved batch requests.
    const keptOn = await fixture(true);
    await r.approvedBy(pool, u.a, u.b, keptOn.c, 'payment_batch', keptOn.b.id);
    await approve(keptOn.c, keptOn.b.id);
    const movedOn = await fixture(true);
    await r.approvedBy(pool, u.a, u.b, movedOn.c, 'payment_batch', movedOn.b.id);
    await approve(movedOn.c, movedOn.b.id);
    await changeBank(movedOn.c, movedOn.supplierId);
    // Enforcement on: a single payment's approved request, and one's pending request.
    const { company: c, bank } = await payCompany(pool, [[u.a, 'admin'], [u.b, 'owner']], companies);
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await enforcePay(pool, c, 'supplier_payment', u.b);
    const single = await plantPayment(pool, c, u.a, bank);
    await r.approvedBy(pool, u.a, u.b, c, 'supplier_payment', single.id);
    const pending = await plantPayment(pool, c, u.a, bank);
    const raised = await r.raise(u.a, c, 'supplier_payment', pending.id);
    expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
    const pendingId = dataOf<{ id: string }>(raised).id;

    const oldDigests = { kept: await storedDigest(kept.b.id), moved: await storedDigest(moved.b.id), pending: await requestDigest(pendingId) };
    const expected = await matchingNow();
    const notices = await migrate();
    expect(notices).toEqual([
      `migration 923: approval_requests re-stamped ${expected.req}, left stale ${expected.req_all - expected.req}`,
      `migration 923: supplier_payment_batches re-stamped ${expected.bat}, left stale ${expected.bat_all - expected.bat}`,
    ]);
    expect(expected.req_all - expected.req).toBeGreaterThanOrEqual(1); // movedOn's request at least
    expect(expected.bat_all - expected.bat).toBeGreaterThanOrEqual(2); // moved and movedOn at least

    // The new definition is live, and the re-stamped digests are its digests.
    expect(await storedDigest(kept.b.id)).not.toBe(oldDigests.kept);
    expect(await storedDigest(moved.b.id)).toBe(oldDigests.moved);
    expect(await requestDigest(pendingId)).not.toBe(oldDigests.pending);

    const keptFile = await eft(kept.c, kept.b.id);
    expect(keptFile.state.statusCode, JSON.stringify(keptFile.state.body)).toBe(200);
    expect(reasonOf(await eft(moved.c, moved.b.id))).toBe(CHANGED);
    const keptOnFile = await eft(keptOn.c, keptOn.b.id);
    expect(keptOnFile.state.statusCode, JSON.stringify(keptOnFile.state.body)).toBe(200);
    const movedOnFile = await eft(movedOn.c, movedOn.b.id);
    expect(movedOnFile.state.statusCode).toBe(409);
    expect(reasonOf(movedOnFile)).toBe('APPROVAL_STALE');

    const approved = await r.payment(u.a, c, 'approve', single.id);
    expect(approved.state.statusCode, JSON.stringify(approved.state.body)).toBe(200);
    expect((await r.payment(u.a, c, 'process', single.id)).state.statusCode).toBe(200);
    const decided = await r.decide(pool, u.b, c, pendingId);
    expect(decided.state.statusCode, JSON.stringify(decided.state.body)).toBe(200);
    expect((await r.payment(u.a, c, 'approve', pending.id)).state.statusCode).toBe(200);

    // And it covers the name from here on: a rename after the deploy stales the re-stamped approval.
    await inRequest(pool, u.a, keptOn.c, () => updateSupplier(keptOn.c, keptOn.supplierId, { name: 'MALLORY HOLDINGS' }, u.a));
    expect(reasonOf(await eft(keptOn.c, keptOn.b.id))).toBe('APPROVAL_STALE');
  });

  it('refuses to run under a role RLS binds (it would re-stamp from an empty snapshot)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await expect(client.query(MIGRATION)).rejects.toThrow(/run as a role that bypasses RLS/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses to run before 922 (it re-stamps approved_digest)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE supplier_payment_batches DROP COLUMN approved_digest');
      await expect(client.query(MIGRATION)).rejects.toThrow(/apply migration 922 first/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses when its definition would move another document type\'s digest', async () => {
    const { company } = await payCompany(pool, [[u.a, 'admin']], companies);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bill = await plantBill(client, company, await plantSupplier(client, company), u.a);
      await client.query("UPDATE supplier_invoices SET status = 'draft' WHERE id = $1", [bill]); // in the snapshot
      const arm = 'si.supplier_id, si.invoice_number, si.invoice_date,';
      expect(MIGRATION.split(arm)).toHaveLength(2);
      await expect(client.query(MIGRATION.replace(arm, 'si.supplier_id, si.invoice_date,')))
        .rejects.toThrow(/approval_document_digest changed for \d+ non-payment document/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses when an existing payment\'s authors would move (an account already carrying setters)', async () => {
    const { company, bank } = await payCompany(pool, [[u.a, 'admin']], companies);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(OLD_AUTHORS);
      await plantPayment(client, company, u.a, bank); // a draft single payment from `bank`: in the snapshot
      await client.query('UPDATE gl_accounts SET bank_details_setters = ARRAY[$2::UUID] WHERE id = $1', [bank, u.b]);
      await expect(client.query(MIGRATION)).rejects.toThrow(/approval_document_authors changed for \d+ payment document/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses to run before 874 (its digest is what the snapshot reads), changing nothing', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(OLD_DIGEST.replace(/cii\.gl_account_id, cii\.project_id, cii\.currency_code/g,
        'cii.gl_account_id, cii.currency_code'));
      await expect(client.query(MIGRATION)).rejects.toThrow(/apply migration 874 first/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
