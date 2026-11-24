/**
 * Intercompany P4-E: every refusal of "Clear against the intercompany loan" is answered BEFORE any write: no journal, no supplier payment, no
 * message, the bill's open amount unchanged, nothing in the receiver's books. Unlinked bill, a cash connection, a bill before the pair's
 * cut-over, a closed period, a payer loan account that is not a loan class or not set, a bank-paid bill, a pending draft payment, a bill not
 * approved, another supplier, a foreign currency, the receiver not ready (its flag off, its loan account unset, its invoice not open or open for
 * less), a stale preview (409), bad dates (400), another tenant (404). A sender failure after the posting rolls the whole clearing back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acct, asAppUser, co, party, U, wipeConnections, withoutTrigger } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { bank, clearPayments, plantPaid } from './allocation.helpers';
import { loan } from './allocation-clear.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearAs, clearBill, clearBody, clearConnect, payer, payerSetup, plantBill, refusedUntouched } from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

describe('the relationship', () => {
  it('an unlinked bill, or a link no longer active: 409, nothing posted', async () => {
    const lone = await plantBill(pool, conn, { link: false });
    await refusedUntouched(pool, lone.bill, () => clearBill(clearBody(lone, { link: crypto.randomUUID() })), 409, /not linked|no active link/i);
    const gone = await plantBill(pool, conn, { link: 'unlinked' });
    await refusedUntouched(pool, gone.bill, () => clearBill(clearBody(gone)), 409, /not linked|no active link/i);
  });

  it('a cash connection: 409', async () => {
    await wipeConnections(pool);
    const cash = await clearConnect(pool, { mode: 'cash' });
    const b = await plantBill(pool, cash);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /loan/i);
  });

  it("a bill dated before the pair's cut-over (both sides mirroring only from 2026-09-15): 409", async () => {
    await wipeConnections(pool);
    const late = await clearConnect(pool, { since: '2026-09-15' });
    const b = await plantBill(pool, late);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { postingDate: '2026-09-20' })), 409, /cut-over/i);
  });

  it('a deleted bill: 404; a revoked connection (the link left active): 409 not active', async () => {
    const gone = await plantBill(pool, conn);
    await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [gone.bill]);
    await refusedUntouched(pool, gone.bill, () => clearBill(clearBody(gone)), 404);
    const b = await plantBill(pool, conn);
    await withoutTrigger(pool, 'intercompany_connections', 'trg_intercompany_connections_guard', (q) => q.query("UPDATE intercompany_connections SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1", [conn, U.ab]));
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /not active/i);
  });

  it('another tenant, the receiver itself, a member of both acting as a third company: 404', async () => {
    const b = await plantBill(pool, conn);
    await refusedUntouched(pool, b.bill, () => clearAs(U.c, co.C, clearBody(b)), 404);
    await refusedUntouched(pool, b.bill, () => clearAs(U.a, co.A, clearBody(b)), 404);
    await refusedUntouched(pool, b.bill, () => clearAs(U.ac, co.C, clearBody(b)), 404);
  });
});

describe("the payer's loan account", () => {
  it('not a loan class (made a system account) or not set: 409', async () => {
    const b = await plantBill(pool, conn);
    await pool.query('UPDATE gl_accounts SET is_system_account = true WHERE id = $1', [acct.bLoan]);
    try {
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /loan account/i);
    } finally {
      await pool.query('UPDATE gl_accounts SET is_system_account = false WHERE id = $1', [acct.bLoan]);
    }
    await asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET loan_account_id = NULL WHERE connection_id = $1 AND company_id = $2', [conn, co.B]), true);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /loan account/i);
  });
});

describe('the bill', () => {
  it('already paid from the bank: refused, nothing more cleared', async () => {
    const b = await plantBill(pool, conn);
    await plantPaid(pool, b.bill, { leg: bank.b });
    await pool.query("UPDATE supplier_invoices SET amount_paid = 1150, status = 'paid' WHERE id = $1", [b.bill]);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { open: 0 })), 409);
  });

  it('part paid from the bank: more than what is open is refused, the rest clears', async () => {
    const b = await plantBill(pool, conn);
    await pool.query("UPDATE supplier_invoices SET amount_paid = 1000, status = 'partially_paid' WHERE id = $1", [b.bill]);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 1150, open: 150 })), 409, /open/i);
    expect((await clearBill(clearBody(b, { amount: 150, open: 150 }))).state.statusCode).toBe(200);
  });

  it('a pending draft payment already claims it: 409', async () => {
    const b = await plantBill(pool, conn);
    await plantPaid(pool, b.bill, { status: 'draft', amount: 1000 });
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 1150 })), 409, /open/i);
  });

  it('not approved, another supplier, another currency: 409', async () => {
    const draft = await plantBill(pool, conn);
    await pool.query("UPDATE supplier_invoices SET status = 'pending_approval' WHERE id = $1", [draft.bill]);
    await refusedUntouched(pool, draft.bill, () => clearBill(clearBody(draft)), 409);
    const other = await plantBill(pool, conn);
    const supplier = crypto.randomUUID();
    await pool.query("INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, 'IC B other supplier')", [supplier, co.B]);
    await pool.query('UPDATE supplier_invoices SET supplier_id = $2 WHERE id = $1', [other.bill, supplier]);
    await refusedUntouched(pool, other.bill, () => clearBill(clearBody(other)), 409, /supplier/i);
    // a foreign bill needs the company's foreign-currency documents on (the FX gate refuses the INSERT otherwise)
    await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [co.B]);
    try {
      const usd = await plantBill(pool, conn, { currency: 'USD' });
      await refusedUntouched(pool, usd.bill, () => clearBill(clearBody(usd)), 409, /rand/i);
    } finally {
      await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [co.B]);
    }
  });
});

describe('the posting date', () => {
  it('before the bill, after today, not a date: 400; a closed period: refused', async () => {
    const b = await plantBill(pool, conn);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { postingDate: '2026-08-31' })), 400);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { postingDate: '2099-01-01' })), 400);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { postingDate: '2026-02-30' })), 400);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1", [co.B]);
    try {
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 400, /period/i);
    } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [co.B]);
    }
  });
});

describe('what is approved is what posts', () => {
  it('another loan account, link, amount or open amount than the books: 409', async () => {
    const b = await plantBill(pool, conn);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { loan: loan.a2 })), 409, /changed/i);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { link: crypto.randomUUID() })), 409, /changed/i);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { open: 1000 })), 409, /changed/i);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 400, expectedAmount: 500 })), 409, /changed/i);
  });

  it('a body that is not the preview (unknown key, an amount in fractions of a cent, zero): 400', async () => {
    const b = await plantBill(pool, conn);
    await refusedUntouched(pool, b.bill, () => clearBill({ ...clearBody(b), extra: 1 }), 400);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 11.505 })), 400);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { amount: 0 })), 400);
  });
});

describe('the receiver must be able to clear it (the preflight)', () => {
  it('the partner does not have the flag: refused with one generic sentence', async () => {
    const b = await plantBill(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    try {
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /partner/i);
    } finally {
      await setLoanClearing(pool, [co.A], true);
    }
  });

  it("the receiver's loan account unset, its invoice not open, or open for less: refused", async () => {
    const b = await plantBill(pool, conn);
    await pool.query("UPDATE customer_invoices SET status = 'paid' WHERE id = $1", [b.invoice]);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /partner/i);
    await pool.query("UPDATE customer_invoices SET status = 'approved' WHERE id = $1", [b.invoice]);
    await pool.query('UPDATE customer_invoices SET amount_paid = 1000 WHERE id = $1', [b.invoice]);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /partner/i);
    await pool.query('UPDATE customer_invoices SET amount_paid = 0 WHERE id = $1', [b.invoice]);
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET loan_account_id = NULL WHERE connection_id = $1 AND company_id = $2', [conn, co.A]), true);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /partner/i);
  });

  it("the receiver's invoice is on another customer than the one linked to the payer: refused", async () => {
    const b = await plantBill(pool, conn);
    const other = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id, company_id, name) VALUES ($1, $2, 'IC A other customer')", [other, co.A]);
    await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [b.invoice, other]);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /partner/i);
    await pool.query('UPDATE customer_invoices SET customer_id = $2, client_id = $2 WHERE id = $1', [b.invoice, party.aCustomer]);
    expect((await clearBill(clearBody(b))).state.statusCode).toBe(200);
  });
});

describe('no blind clearing', () => {
  it('the allocation message cannot be written: the request fails and the clearing does not exist (rolled back)', async () => {
    const b = await plantBill(pool, conn);
    await pool.query(`CREATE OR REPLACE FUNCTION public.ic_p4e_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind = 'allocation' THEN RAISE EXCEPTION 'forced sender failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER ic_p4e_test_refuse BEFORE INSERT ON intercompany_messages FOR EACH ROW EXECUTE FUNCTION public.ic_p4e_test_refuse()');
    try {
      const before = await payer.journals(pool);
      const res = await clearBill(clearBody(b));
      expect(res.state.statusCode).toBe(500);
      expect(await payer.journals(pool)).toBe(before);
      expect(await payer.payments(pool)).toBe(0);
      expect(await payer.open(pool, b.bill)).toBeCloseTo(1150, 2);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ic_p4e_test_refuse ON intercompany_messages');
      await pool.query('DROP FUNCTION IF EXISTS public.ic_p4e_test_refuse()');
    }
    // the trigger gone, the same request clears
    expect((await clearBill(clearBody(b))).state.statusCode).toBe(200);
  });
});
