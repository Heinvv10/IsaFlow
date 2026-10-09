/**
 * FX PR0 PR-review round (#682): settlement is refused for a foreign document
 * WHATEVER the switch, in the services as in the database, on every path the
 * reviewers named — and a currency change on a draft needs its lines.
 *
 * - A legacy USD draft relabelled ZAR without its lines is refused (it would
 *   post its USD figures as rands); with its lines re-entered it is not. A
 *   rate-only edit recomputes functional_total.
 * - applyCreditNoteToInvoice and the named-document apply (dry run and live)
 *   refuse a foreign note and a foreign invoice with the worded refusal.
 * - Approving a foreign note (switch on) posts it and leaves it unapplied.
 * - Write-off approval refuses a foreign invoice before its claim.
 * - The receipt/payment guards and contra settlement refuse with the switch ON.
 * - The auto-apply back-fill leaves a foreign note out.
 * - The database refuses a foreign note's applied_amount change, and a no-op
 *   NULL → 0 rewrite does not fire. Where a database still has the legacy
 *   customer_invoices.currency column (211), the pre-check, the gate and the
 *   settlement refusal read it — against TEMP shadows, so no shared table locks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, enableFxDocuments } from './r035-approval.helpers';
import { cleanupPr3, noteCompany, plantNote } from './r035-pr3.helpers';
import { plantInvoice } from './r035-pr4.helpers';
import { editDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { approveWriteOff } from '@/modules/accounting/services/ar/writeOffService';
import { invoicesPayable } from '@/modules/accounting/services/ar/invoicesPayable';
import { billsPayable } from '@/modules/accounting/services/ap/billAllocatable';
import { loadContraDocument } from '@/modules/accounting/services/core/contraSettlementService';
import { readBackfillSources } from '@/modules/accounting/services/shared/autoApplyBackfillPopulation';
import {
  applyCreditNoteToDocument, CreditNoteApplyRefusal, planCreditNoteToDocument,
} from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { ForeignCurrencySettlementError } from '@/modules/accounting/services/shared/documentCurrency';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
const SETTLE = /settling a foreign-currency .* is not supported yet/;

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM customer_write_offs WHERE company_id = ANY($1)', [companies]);
  for (const table of ['customer_invoices', 'supplier_invoices', 'credit_notes']) {
    await pool.query(`UPDATE ${table} SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)`, [companies]);
  }
  await cleanupPr3(pool, companies, [owner]);
});

/** A company with its accounts and an open 2026 period; the switch ON so foreign rows can be planted. */
async function company(): Promise<string> {
  const c = await noteCompany(pool, [[owner, 'owner']], companies);
  await enableFxDocuments(pool, c);
  return c;
}
const off = (c: string) => pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [c]);

async function inRequest<T>(c: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: owner, companyId: c, claims: { sub: owner } } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** An approved customer note linked to a ZAR 'sent' invoice of R5 000; `noteCurrency` relabels the note. */
async function appliedPair(c: string, noteCurrency = 'ZAR') {
  const note = await plantNote(pool, c, owner, 'customer', { linked: true });
  await pool.query("UPDATE credit_notes SET status = 'approved', currency = $2 WHERE id = $1", [note.id, noteCurrency]);
  return note;
}
const paidOf = async (id: string) =>
  Number((await pool.query('SELECT amount_paid FROM customer_invoices WHERE id = $1', [id])).rows[0].amount_paid ?? 0);
const allocationsOf = async (noteId: string) =>
  Number((await pool.query('SELECT count(*) FROM credit_note_allocations WHERE credit_note_id = $1', [noteId])).rows[0].count);

describe('a draft invoice edit', () => {
  it('relabelling a legacy USD draft as ZAR without its lines is refused; with them re-entered it saves', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275 });
    await off(c);
    const refused = await inRequest(c, () => editDraftCustomerInvoice(c, owner, { id: inv.id, currencyCode: 'ZAR', exchangeRate: 1 }));
    expect(refused).toMatchObject({ kind: 'currency_refused', message: expect.stringMatching(/re-entered in ZAR/) });
    expect((await pool.query('SELECT currency_code FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].currency_code).toBe('USD');

    const saved = await inRequest(c, () => editDraftCustomerInvoice(c, owner, {
      id: inv.id, currencyCode: 'ZAR', exchangeRate: 1, items: [{ description: 'Re-entered', quantity: 1, unitPrice: 20000 }],
    } as never));
    expect(saved).toEqual({ kind: 'ok' });
    const { rows: [row] } = await pool.query('SELECT currency_code, total_amount, functional_total FROM customer_invoices WHERE id = $1', [inv.id]);
    expect(row).toMatchObject({ currency_code: 'ZAR', total_amount: '23000.00', functional_total: '23000.00' });
  });

  it('a rate-only edit of a foreign draft (switch on) recomputes functional_total', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275 });
    expect(await inRequest(c, () => editDraftCustomerInvoice(c, owner, { id: inv.id, exchangeRate: 20 }))).toEqual({ kind: 'ok' });
    expect((await pool.query('SELECT functional_total FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].functional_total)
      .toBe('23000.00');
  });
});

describe('applying a credit note to a named invoice', () => {
  it('applyCreditNoteToInvoice refuses a USD note on a ZAR invoice; nothing is written', async () => {
    const c = await company();
    const note = await appliedPair(c, 'USD');
    await expect(inRequest(c, () => applyCreditNoteToInvoice(c, note.id, note.invoiceId!, owner)))
      .rejects.toThrow(ForeignCurrencySettlementError);
    expect(await paidOf(note.invoiceId!)).toBe(0);
    expect(await allocationsOf(note.id)).toBe(0);
  });

  it('applyCreditNoteToInvoice refuses a ZAR note on a USD invoice with the worded refusal, not the database text', async () => {
    const c = await company();
    const note = await appliedPair(c);
    await pool.query("UPDATE customer_invoices SET currency_code = 'USD', exchange_rate = 18.5 WHERE id = $1", [note.invoiceId]);
    await expect(inRequest(c, () => applyCreditNoteToInvoice(c, note.id, note.invoiceId!, owner)))
      .rejects.toThrow(ForeignCurrencySettlementError);
    expect(await paidOf(note.invoiceId!)).toBe(0);
  });

  it('the named-document apply refuses a USD note in the dry run and the live call alike', async () => {
    const c = await company();
    const note = await appliedPair(c, 'USD');
    const input = { creditNoteId: note.id, invoiceId: note.invoiceId! };
    await expect(inRequest(c, () => planCreditNoteToDocument(c, input))).rejects.toThrow(CreditNoteApplyRefusal);
    await expect(inRequest(c, () => applyCreditNoteToDocument(c, input, owner))).rejects.toThrow(CreditNoteApplyRefusal);
    expect(await paidOf(note.invoiceId!)).toBe(0);
  });

  it('a ZAR note on a ZAR invoice still applies', async () => {
    const c = await company();
    const note = await appliedPair(c);
    await inRequest(c, () => applyCreditNoteToInvoice(c, note.id, note.invoiceId!, owner));
    expect(await paidOf(note.invoiceId!)).toBe(1150);
  });
});

describe('approving a foreign credit note (switch on)', () => {
  it('posts it and leaves it unapplied — its linked ZAR invoice is not settled', async () => {
    const c = await company();
    const note = await plantNote(pool, c, owner, 'customer', { linked: true });
    await pool.query("UPDATE credit_notes SET currency = 'USD' WHERE id = $1", [note.id]);
    await inRequest(c, () => approveCreditNote(c, note.id, owner));
    const { rows: [cn] } = await pool.query('SELECT status, applied_amount, gl_journal_entry_id FROM credit_notes WHERE id = $1', [note.id]);
    expect(cn.status).toBe('approved');
    expect(Number(cn.applied_amount ?? 0)).toBe(0);
    expect(cn.gl_journal_entry_id).not.toBeNull();
    expect(await paidOf(note.invoiceId!)).toBe(0);
  });
});

describe('write-off approval', () => {
  it('refuses a USD invoice before its claim: the write-off stays draft and nothing posts', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275, status: 'sent' });
    const { rows: [wo] } = await pool.query(
      `INSERT INTO customer_write_offs(company_id, write_off_number, client_id, invoice_id, amount, reason, created_by)
       VALUES($1, $2, $3, $4, 100, 'fx round 5', $5) RETURNING id`, [c, `WO-${inv.id.slice(0, 8)}`, inv.customerId, inv.id, owner]);
    await expect(inRequest(c, () => approveWriteOff(c, wo.id, owner))).rejects.toThrow(ForeignCurrencySettlementError);
    const { rows: [after] } = await pool.query('SELECT status, gl_journal_entry_id FROM customer_write_offs WHERE id = $1', [wo.id]);
    expect(after).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });
});

describe('settlement with the switch ON', () => {
  it('the receipt and payment guards refuse a foreign row', async () => {
    const c = await company();
    await expect(invoicesPayable(c, [{ invoice_number: 'CI-1', currency_code: 'USD' }])).rejects.toThrow(SETTLE);
    await expect(billsPayable(c, [{ invoice_number: 'B-1', currency_code: 'ZAR', currency: 'EUR' }])).rejects.toThrow(SETTLE);
    await expect(invoicesPayable(c, [{ invoice_number: 'CI-2', currency_code: 'ZAR' }])).resolves.toHaveLength(1);
  });

  it('contra settlement refuses a USD invoice from reads alone (its dry run too)', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275, status: 'sent' });
    await expect(loadContraDocument(c, 'ar', inv.id, 10)).rejects.toThrow(SETTLE);
  });

  it('the auto-apply back-fill leaves a USD note out and keeps a ZAR one', async () => {
    const c = await company();
    const usd = await appliedPair(c, 'USD');
    const zar = await appliedPair(c);
    const ids = (await readBackfillSources(c, 'ar', null, 100)).map((s) => s.paymentId);
    expect(ids).toContain(zar.id);
    expect(ids).not.toContain(usd.id);
  });
});

describe('the database', () => {
  it("refuses a foreign note's applied_amount change; a NULL → 0 rewrite does not fire", async () => {
    const c = await company();
    const note = await appliedPair(c, 'USD');
    await expect(pool.query('UPDATE credit_notes SET applied_amount = 10 WHERE id = $1', [note.id])).rejects.toThrow(/FX_SETTLEMENT_REFUSED/);
    await pool.query('UPDATE credit_notes SET applied_amount = 0 WHERE id = $1', [note.id]);
    // amount_paid is nullable: a writer normalising NULL to 0 on a foreign invoice settles nothing.
    const inv = await plantInvoice(pool, c, owner, { currencyCode: 'USD', exchangeRate: 18.5, functionalTotal: 21275 });
    await pool.query('UPDATE customer_invoices SET amount_paid = NULL WHERE id = $1', [inv.id]);
    await pool.query('UPDATE customer_invoices SET amount_paid = 0 WHERE id = $1', [inv.id]);
  });
});

describe('the legacy customer_invoices.currency column, where a database has it', () => {
  const MIGRATION = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/871_fx_pr0_refuse_foreign_currency.sql'), 'utf8');
  const SECTION_1 = MIGRATION.slice(MIGRATION.indexOf('-- ── 1.'), MIGRATION.indexOf('-- ── 2.'));
  const LEGACY_TRIGGER = MIGRATION.slice(MIGRATION.indexOf('-- Where the legacy `currency` column exists'),
    MIGRATION.indexOf('DROP TRIGGER IF EXISTS trg_supplier_invoice_fx_gate ON'));
  async function shadowed(fn: (db: PoolClient) => Promise<void>): Promise<void> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL search_path = pg_temp, public');
      await db.query('CREATE TEMP TABLE companies (id UUID, functional_currency TEXT) ON COMMIT DROP');
      await db.query('CREATE TEMP TABLE bank_accounts (id UUID, currency TEXT) ON COMMIT DROP');
      await db.query(`CREATE TEMP TABLE customer_invoices (id UUID DEFAULT gen_random_uuid(), company_id UUID, currency_code TEXT,
        currency TEXT, status TEXT, gl_journal_entry_id UUID, amount_paid NUMERIC) ON COMMIT DROP`);
      await fn(db);
    } finally { await db.query('ROLLBACK'); db.release(); }
  }

  it('the pre-check names a row whose legacy currency is foreign; ZAR, blank and NULL pass', async () => {
    await shadowed(async (db) => {
      await db.query("INSERT INTO customer_invoices(currency) VALUES ('ZAR'), (' zar '), (''), (NULL)");
      await db.query(SECTION_1);
      const { rows: [r] } = await db.query("INSERT INTO customer_invoices(currency) VALUES ('USD') RETURNING id");
      await expect(db.query(SECTION_1)).rejects.toThrow(new RegExp(`customer_invoices.currency not ZAR .*${r.id}=USD`));
    });
  });

  it('a change of the legacy column fires the gate, and settling a row it marks foreign is refused', async () => {
    const c = await company();
    await off(c);
    await shadowed(async (db) => {
      await db.query(LEGACY_TRIGGER);
      const { rows: [r] } = await db.query(
        "INSERT INTO customer_invoices(company_id, currency_code, currency, status) VALUES ($1, 'ZAR', 'ZAR', 'draft') RETURNING id", [c]);
      await db.query('SAVEPOINT s');
      await expect(db.query("UPDATE customer_invoices SET currency = 'USD' WHERE id = $1", [r.id])).rejects.toThrow(/FX_DOCUMENTS_DISABLED/);
      await db.query('ROLLBACK TO s');
      await db.query(`CREATE TRIGGER t BEFORE UPDATE OF amount_paid ON customer_invoices
        FOR EACH ROW EXECUTE FUNCTION public.fx_settlement_refusal()`);
      await db.query("INSERT INTO customer_invoices(company_id, currency_code, currency) VALUES ($1, 'ZAR', 'USD')", [c]);
      await expect(db.query("UPDATE customer_invoices SET amount_paid = 5 WHERE currency = 'USD'")).rejects.toThrow(/FX_SETTLEMENT_REFUSED/);
    });
  });
});
