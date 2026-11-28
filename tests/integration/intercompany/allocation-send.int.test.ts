/**
 * Intercompany P4-B: the PAYER's allocation message (migration 1025, `intercompany_send_for_allocation`). When the payer's cash is applied to
 * a bill that is in an ACTIVE link with the issuer's customer invoice, on a LOAN connection past its cut-over, the database writes ONE
 * `allocation` message for the issuer, built from the payer's own rows, and nothing else changes in anyone's books. Every other case answers
 * with a named reason and writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, count } from './intercompany.helpers';
import { acc, co, mirrorCleanup, U, wipeConnections } from './mirror.helpers';
import { acct } from './intercompany.fixture';
import {
  allocSetup, allocationMessages, bank, clearPayments, linkBill, loanConnect, plantBatchRow, plantBill, plantPaid, plantPaymentJournal, sendFor,
} from './allocation.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});

const journals = async () => count(pool, 'SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = ANY($1)', [[co.A, co.B]]);

describe('a posted payment applied to a linked bill on a loan connection', () => {
  it('writes one message for the issuer, the payload equal to the payer\'s own rows, and changes nothing else', async () => {
    const { bill, invoice, link } = await plantBill(pool, conn);
    const { payment, allocation, journal } = await plantPaid(pool, bill);
    const before = await journals();
    const out = await sendFor(pool, allocation);
    expect(out).toMatchObject({ reason: null, detail: null });
    const rows = await allocationMessages(pool);
    expect(rows).toHaveLength(1);
    const m = rows[0];
    expect(out.message_id).toBe(m.id);
    expect(m).toMatchObject({
      kind: 'allocation', status: 'pending', from_company_id: co.B, to_company_id: co.A, connection_id: conn, source_doc_type: 'payment_allocation',
      source_doc_id: allocation, source_journal_entry_id: journal, group_transaction_id: null, target_doc_type: null, target_doc_id: null,
    });
    const p = (await pool.query('SELECT payment_number, payment_date::text AS d FROM supplier_payments WHERE id = $1', [payment])).rows[0];
    const b = (await pool.query('SELECT invoice_number FROM supplier_invoices WHERE id = $1', [bill])).rows[0];
    expect(m.payload).toEqual({
      version: 1, kind: 'allocation', allocationId: allocation, amount: 1150, currency: 'ZAR',
      payment: { id: payment, number: p.payment_number, reference: 'IC alloc ref', date: p.d, method: 'eft', cashLegIsLoanAccount: false },
      payerDocument: { type: 'supplier_invoice', id: bill, number: b.invoice_number },
      issuerDocument: { type: 'customer_invoice', id: invoice },
      linkId: link, linkOrigin: 'manual_pairing',
    });
    expect(await journals()).toBe(before);                                              // no ledger write, on either side
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_messages WHERE kind <> $1', ['allocation'])).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1 AND status <> 'approved'", [co.A])).toBe(0);
  });

  it('says whether the cash leg is the payer\'s loan account', async () => {
    const { bill } = await plantBill(pool, conn);
    const { allocation } = await plantPaid(pool, bill, { leg: acct.bLoan });
    await sendFor(pool, allocation);
    expect((await allocationMessages(pool, allocation))[0].payload.payment.cashLegIsLoanAccount).toBe(true);
  });

  it('a retry, a second hook call and a re-process write no second message (already_sent)', async () => {
    const { bill } = await plantBill(pool, conn);
    const { allocation } = await plantPaid(pool, bill);
    const first = await sendFor(pool, allocation);
    expect(first.message_id).toBeTruthy();
    for (let i = 0; i < 2; i += 1) expect(await sendFor(pool, allocation)).toEqual({ message_id: null, reason: 'already_sent', detail: null });
    expect(await allocationMessages(pool)).toHaveLength(1);
  });

  it('one payment over two bills leaves two messages, one per allocation row', async () => {
    const one = await plantBill(pool, conn);
    const two = await plantBill(pool, conn);
    const first = await plantPaid(pool, one.bill, { amount: 600 });
    const second = await plantPaid(pool, two.bill, { amount: 550, payment: first.payment });
    await sendFor(pool, first.allocation);
    await sendFor(pool, second.allocation);
    const rows = await allocationMessages(pool);
    expect(rows.map((r) => r.source_doc_id).sort()).toEqual([first.allocation, second.allocation].sort());
    expect(rows.map((r) => r.payload.amount).sort()).toEqual([550, 600]);
  });

  it('a reconciled payment and a payment dated ON the cut-over are sent; a foreign-currency bill is sent in its currency (the receiver refuses it)', async () => {
    const one = await plantPaid(pool, (await plantBill(pool, conn)).bill, { status: 'reconciled', date: '2026-01-01' });
    expect((await sendFor(pool, one.allocation)).reason).toBeNull();
    await enableFxDocuments(pool, co.B);
    const usd = await plantBill(pool, conn, { currency: 'USD' });
    const two = await plantPaid(pool, usd.bill);
    expect((await sendFor(pool, two.allocation)).reason).toBeNull();
    expect((await allocationMessages(pool, two.allocation))[0].payload.currency).toBe('USD');
  });

  it('records the link\'s origin (a mirror link says so)', async () => {
    const { bill, invoice } = await plantBill(pool, conn, { link: false });
    await linkBill(pool, conn, invoice, bill, 'active', 'mirror');
    const { allocation } = await plantPaid(pool, bill);
    await sendFor(pool, allocation);
    expect((await allocationMessages(pool, allocation))[0].payload.linkOrigin).toBe('mirror');
  });
});

describe('everything else answers with its reason and writes nothing', () => {
  type Case = [string, string, () => Promise<{ allocation: string }>, (() => Promise<unknown>)?];
  const bill = (over: Parameters<typeof plantBill>[2] = {}) => plantBill(pool, conn, over);
  const cases: Case[] = [
    ['an unknown allocation row', 'not_found', async () => ({ allocation: crypto.randomUUID() })],
    ['a deleted bill', 'not_found', async () => {
      const b = await bill();
      const p = await plantPaid(pool, b.bill);
      await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE id = $1', [b.bill]);
      return p;
    }],
    ['a bill with no link', 'no_link', async () => plantPaid(pool, (await bill({ link: false })).bill)],
    ['a link still pending confirmation', 'no_link', async () => plantPaid(pool, (await bill({ link: 'pending_confirmation' })).bill)],
    ['an unlinked link', 'no_link', async () => plantPaid(pool, (await bill({ link: 'unlinked' })).bill)],
    ['a revoked connection', 'no_connection', async () => {
      const p = await plantPaid(pool, (await bill()).bill);
      await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [conn]), true);
      return p;
    }],
    ['a cash connection', 'not_loan', async () => {
      const p = await plantPaid(pool, (await bill()).bill);
      await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'cash' WHERE id = $1", [conn]), true);
      return p;
    }],
    ['a connection with no cut-over', 'no_cutover', async () => {
      const p = await plantPaid(pool, (await bill()).bill);
      await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = NULL WHERE id = $1', [conn]), true);
      return p;
    }],
    ['a payment dated before the cut-over', 'before_cutover', async () => plantPaid(pool, (await bill()).bill, { date: '2025-12-31' })],
    ['a payment with a NULL status', 'not_posted', async () => {
      const p = await plantPaid(pool, (await bill()).bill);
      await pool.query('UPDATE supplier_payments SET status = NULL WHERE id = $1', [p.payment]);
      return p;
    }],
    ['a draft payment', 'not_posted', async () => plantPaid(pool, (await bill()).bill, { status: 'draft' })],
    ['an approved payment', 'not_posted', async () => plantPaid(pool, (await bill()).bill, { status: 'approved' })],
    ['a processed payment with no journal', 'no_journal', async () => plantPaid(pool, (await bill()).bill, { journal: false })],
    ['a payment whose journal was reversed', 'no_journal', async () => plantPaid(pool, (await bill()).bill, { reversed: true })],
    ['a payment whose journal was never posted', 'no_journal', async () => plantPaid(pool, (await bill()).bill, { journal: await plantPaymentJournal(pool, 1150, { status: 'draft' }) })],
  ];
  it.each(cases)('%s: %s', async (_name, reason, plant) => {
    const { allocation } = await plant();
    expect(await sendFor(pool, allocation)).toEqual({ message_id: null, reason, detail: null });
    expect(await allocationMessages(pool)).toHaveLength(0);
  });

  it('a viewer of the payer (an owner of the issuer), and a member of nothing, are forbidden', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    expect(await sendFor(pool, allocation, U.avb)).toEqual({ message_id: null, reason: 'forbidden', detail: null });
    expect(await sendFor(pool, allocation, U.x)).toEqual({ message_id: null, reason: 'forbidden', detail: null });   // a member of nothing, naming B in the GUC
    expect(await allocationMessages(pool)).toHaveLength(0);
  });

  it('a payment whose journal is a journal of ANOTHER company is no journal', async () => {
    const foreign = await plantPaymentJournal(pool, 1150, { company: co.A, leg: acct.aLoan });
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill, { journal: foreign });
    expect((await sendFor(pool, allocation)).reason).toBe('no_journal');
  });

  it('a session acting as another company (the GUC is any session\'s to set): forbidden for a user who is no writer there, not_found for one who is', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const as = (user: string) => asAppUser(pool, user, co.C, async (q) => (await q.query('SELECT * FROM public.intercompany_send_for_allocation($1)', [allocation])).rows[0]);
    expect(await as(U.b)).toMatchObject({ message_id: null, reason: 'forbidden' });
    expect(await as(U.ac)).toMatchObject({ message_id: null, reason: 'not_found' });          // a writer of C (and of A): the row is B's
  });

  it('forbidden comes FIRST: a user who may not send learns nothing about the row, the link or the connection', async () => {
    const unlinked = (await plantPaid(pool, (await plantBill(pool, conn, { link: false })).bill)).allocation;
    const linked = (await plantPaid(pool, (await plantBill(pool, conn)).bill)).allocation;
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET settlement_mode = 'cash' WHERE id = $1", [conn]), true);
    for (const id of [unlinked, linked, crypto.randomUUID()]) {
      for (const user of [U.avb, U.x]) expect(await sendFor(pool, id, user)).toEqual({ message_id: null, reason: 'forbidden', detail: null });
    }
  });
});

describe('cashLegIsLoanAccount is read from the journal the message stands on', () => {
  const leg = async (over: Parameters<typeof plantPaid>[2]) => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill, over);
    expect((await sendFor(pool, allocation)).reason).toBeNull();
    return (await allocationMessages(pool, allocation))[0].payload.payment.cashLegIsLoanAccount as boolean;
  };
  const journal = (credits: string) => plantPaymentJournal(pool, 1150, { leg: credits });

  it('a payment whose journal credits the loan account is true, whatever its bank_account_id says; the reverse is false', async () => {
    expect(await leg({ leg: bank.b, journal: await journal(acct.bLoan) })).toBe(true);
    expect(await leg({ leg: acct.bLoan, journal: await journal(bank.b) })).toBe(false);
  });

  it('a batch member is judged by the BATCH\'s journal, not by its own bank_account_id or the batch\'s', async () => {
    const credits = await plantBatchRow(pool, { journal: await journal(acct.bLoan), bank: bank.b });
    expect(await leg({ batch: credits, memberBank: bank.b })).toBe(true);                      // the member names a bank, the journal credits the loan account
    const bankBatch = await plantBatchRow(pool, { journal: await journal(bank.b), bank: acct.bLoan });
    expect(await leg({ batch: bankBatch, memberBank: acct.bLoan })).toBe(false);                // the member and the batch name the loan account, the journal credits the bank
  });

  it('a provisional settlement\'s reclass journal credits no bank leg: false even where its bank_account_id is the loan account', async () => {
    const provisional = await journal(bank.b);
    expect(await leg({ leg: acct.bLoan, provisional, journal: await plantPaymentJournal(pool, 1150, { leg: acc.bExp1 }) })).toBe(false);
  });
});

describe('a batch member needs a batch journal that is the payer\'s', () => {
  it('a batch with no journal, and a batch of ANOTHER company whose journal is a valid journal of the payer, are no_journal', async () => {
    const noJournal = await plantBatchRow(pool, { journal: null });
    const one = await plantPaid(pool, (await plantBill(pool, conn)).bill, { batch: noJournal });
    expect((await sendFor(pool, one.allocation)).reason).toBe('no_journal');
    const foreign = await plantBatchRow(pool, { company: co.C, journal: await plantPaymentJournal(pool, 1150) });
    const two = await plantPaid(pool, (await plantBill(pool, conn)).bill, { batch: foreign });
    expect((await sendFor(pool, two.allocation)).reason).toBe('no_journal');
    expect(await allocationMessages(pool)).toHaveLength(0);
  });
});
