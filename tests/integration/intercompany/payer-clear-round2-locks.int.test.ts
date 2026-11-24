/**
 * Intercompany P4-E, fix round 2. LOW-1: a GL journal reversal takes the payer's journal advisory key (1027's cap-lock key) BEFORE its claim
 * row lock, the order a payer void takes them (keys, then the journal row), so the two cannot deadlock (40P01 -> 500): while a receiver's
 * clearing holds the key, the reversal waits on the key with the journal row still free. LOW-2: the shared-layer guard's sentence does not
 * promise that Clear against the intercompany loan will work (a bill dated before the pair's cut-over cannot be cleared either). LOW-5:
 * migration 1029 is deploy-safe: a role that can still EXECUTE the INVOKER helper (a grant from another grantor, a membership) is revoked or
 * WARNED about, never a halt; it halts only on the owner, the registry hash or the search_path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import actionRoute from '../../../pages/api/accounting/supplier-payments-action';
import journalActionRoute from '../../../pages/api/accounting/journal-entries-action';
import { createSupplierPayment } from '../../../src/modules/accounting/services/ap/supplierPaymentService';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { callRoute } from '../r035-approval.helpers';
import { acct, co, party, tokens, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { holdCapLock } from './allocation-clear-round1.helpers';
import { lockWaiter } from './ledger.helpers';
import { clearBill, clearBody, clearConnect, clearedOf, errorText, payerSetup, plantBill } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';
const MIGRATION = readFileSync(path.join(process.cwd(), 'scripts/migrations/sql/1029_intercompany_p4e_receiver_readiness.sql'), 'utf8');
const HELPER = 'public.intercompany_allocation_payer_standing(uuid)';

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

/** Is the row free right now (another session can lock it without waiting)? */
async function rowFree(table: string, id: string): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await c.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]).then(() => true, (e: { code?: string }) => {
      if (e.code === '55P03') return false;
      throw e;
    });
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('LOW-1: the journal reversal takes the payer key before its claim row', () => {
  it("while a receiver's clearing holds the key, the reversal waits on the key and has not locked the journal row", async () => {
    const b = await plantBill(pool, conn);
    const out = clearedOf(await clearBill(clearBody(b)));
    const held = await holdCapLock(pool, out.messageId);
    let settled = false;
    const reversing = callRoute(journalActionRoute, tokens[U.b]!, co.B, 'POST', { action: 'reverse', id: out.journalEntryId }, '/api/accounting/journal-entries-action')
      .finally(() => { settled = true; });
    try {
      expect(await lockWaiter(pool, 'advisory')).toBe(true);
      expect(settled).toBe(false);
      expect(await rowFree('gl_journal_entries', out.journalEntryId)).toBe(true);
    } finally {
      await held.release();
    }
    expect((await reversing).state.statusCode).toBeLessThan(500);
  }, 30000);
});

describe('LOW-2: the guard sentence is accurate', () => {
  it('a linked bill dated before the cut-over, paid from the loan account: refused, pointing to another account too', async () => {
    const b = await plantBill(pool, conn);
    await pool.query("UPDATE supplier_invoices SET invoice_date = DATE '2025-12-01' WHERE id = $1", [b.bill]);
    const action = (body: Record<string, unknown>) => callRoute(actionRoute, tokens[U.b]!, co.B, 'POST', body, '/api/accounting/supplier-payments-action');
    const p = await asService(pool, U.b, co.B, () => createSupplierPayment(co.B, {
      supplierId: party.bSupplier, paymentDate: '2026-09-10', totalAmount: 1150, paymentMethod: 'eft', bankAccountId: acct.bLoan,
      allocations: [{ invoiceId: b.bill, amount: 1150 }],
    }, U.b));
    expect((await action({ action: 'approve', paymentId: p.id })).state.statusCode).toBe(200);
    const res = await action({ action: 'process', paymentId: p.id });
    expect(res.state.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/use Clear against the intercompany loan/);
    expect(errorText(res)).toMatch(/dated before the pair's cut-over[^"]*pay the bill from another account/);
  });
});

/** Migration 1029 applied again in a transaction rolled back after, with `setup` run first; its notices and its error (null when it applied). */
async function applyAgain(setup: string[]): Promise<{ error: string | null; warnings: string[]; appUserCan: boolean }> {
  const c = await pool.connect();
  const warnings: string[] = [];
  c.on('notice', (n) => { if (n.severity === 'WARNING') warnings.push(n.message ?? ''); });
  try {
    await c.query('BEGIN');
    for (const s of setup) await c.query(s);
    const error = await c.query(MIGRATION).then(() => null, (e: Error) => e.message);
    const appUserCan = error ? false : (await c.query(`SELECT has_function_privilege('app_user', '${HELPER}', 'EXECUTE') AS c`)).rows[0].c as boolean;
    return { error, warnings, appUserCan };
  } finally {
    await c.query('ROLLBACK');
    c.removeAllListeners('notice');
    c.release();
  }
}

describe('LOW-5: migration 1029 never halts on a grant it cannot take back', () => {
  it('app_user granted the helper by ANOTHER grantor (holding the grant option): revoked with it, no halt', async () => {
    const role = `ic_r2_grantor_${crypto.randomUUID().slice(0, 8)}`;
    const out = await applyAgain([
      `CREATE ROLE ${role} NOLOGIN`, `GRANT EXECUTE ON FUNCTION ${HELPER} TO ${role} WITH GRANT OPTION`,
      `SET LOCAL ROLE ${role}`, `GRANT EXECUTE ON FUNCTION ${HELPER} TO app_user`, 'RESET ROLE',
    ]);
    expect(out.error).toBeNull();
    expect(out.appUserCan).toBe(false);
  });

  it('app_user still able to execute it (a member of migration_admin): a WARNING naming it, no halt', async () => {
    const out = await applyAgain(['GRANT migration_admin TO app_user']);
    expect(out.error).toBeNull();
    expect(out.appUserCan).toBe(true);
    expect(out.warnings.join('\n')).toMatch(/app_user[^\n]*intercompany_allocation_payer_standing/);
  });

  it('applied as it is: no warning, no halt', async () => {
    expect(await applyAgain([])).toEqual({ error: null, warnings: [], appUserCan: false });
  });
});
