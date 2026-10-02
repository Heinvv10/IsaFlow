/**
 * D8 round 4 (from the adversarial round brk-d8 R, finding B1): the R-127 claim of a RE-REVERSED bank-first provisional
 * (X <- R <- R2) races a GL reversal of its head R2.
 *
 * D8 makes the claim read X's chain parity (journalStandsFragment) and lock X
 * (FOR UPDATE OF je), and refuseReversingSettlementJournal walk UP from R2.
 * Neither locks R2, and the refusal reads supplier_payments unlocked — so a
 * reversal of R2 interleaved with the bill's approval is neither blocked nor
 * refused. Two interleavings, two connections, no hooks.
 */
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import {
  bankGl, company, expenseGl, inTx, payableGl, pool, seedDoc, seedInvoice, seedProvisional,
  useR127Fixture, user, vatGl,
} from './r127-double-booking.helpers';

useR127Fixture();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ledger() {
  const { rows } = await pool.query(
    `SELECT l.gl_account_id, SUM(l.debit - l.credit)::float AS net
     FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = $1 AND e.status = 'posted' GROUP BY l.gl_account_id`, [company]);
  const n = (a: string) => Math.round(Number(rows.find((r) => r.gl_account_id === a)?.net ?? 0) * 100) / 100;
  return { expense: n(expenseGl), vat: n(vatGl), ap: n(payableGl), bank: n(bankGl) };
}

async function openTx<T>(fn: () => Promise<T>) {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    const value = await als.run({ client: c, userId: user, companyId: company, claims: {} } as never, fn);
    return { value, commit: async () => { await c.query('COMMIT'); c.release(); } };
  } catch (err) {
    await c.query('ROLLBACK');
    c.release();
    throw err;
  }
}

async function settle<T>(p: Promise<T>) {
  try { return { ok: true as const, value: await p }; } catch (e) { return { ok: false as const, error: `${(e as Error).name}: ${(e as Error).message}` }; }
}

/** Posted reversals in X's chain: even = X stands in the GL, odd = X is out. */
async function chainReversals(x: string): Promise<number> {
  const { rows } = await pool.query(
    `WITH RECURSIVE ch AS (
       SELECT id, 0 AS d FROM gl_journal_entries WHERE id = $1
       UNION ALL SELECT j.id, ch.d + 1 FROM gl_journal_entries j JOIN ch ON j.reversal_of_id = ch.id
       WHERE j.status = 'posted' AND ch.d < 20)
     SELECT max(d)::int AS n FROM ch`, [x]);
  return Number(rows[0].n);
}

/** Invariant: a live settlement of X requires X standing in the GL (else the bill reads paid with no cash). */
async function assertConsistent(name: string, x: string, bt: string, invoiceId: string, before: Record<string, number>) {
  const after = await ledger();
  const delta = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, Math.round((v - before[k]!) * 100) / 100]));
  const settling = (await pool.query(
    "SELECT count(*)::int AS n FROM supplier_payments WHERE settles_provisional_je_id = $1 AND status <> 'cancelled'", [x])).rows[0].n;
  const reversals = await chainReversals(x);
  const inv = (await pool.query('SELECT status, amount_paid::float AS paid FROM supplier_invoices WHERE id = $1', [invoiceId])).rows[0];
  if (settling > 0) expect(reversals % 2, `${name}: X settles the bill but is out of the GL (delta ${JSON.stringify(delta)})`).toBe(0);
}

describe('D8 round 4: re-reversed provisional claim vs reversal of its head (B1)', () => {
  it('R1: the head R2 is reversed (and committed) between the approval\'s claim and its writes', async () => {
    const doc = await seedDoc();
    const { je: x, bt } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const r = await inTx(() => reverseJournalEntry(company, x, user));
    const r2 = (await inTx(() => reverseJournalEntry(company, r.id, user))).id;
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    const before: Record<string, number> = await ledger();

    // A second request, run by hand: it lands right after the claim's locking SELECT returns.
    const c: PoolClient = await pool.connect();
    const orig = c.query.bind(c) as (...q: unknown[]) => Promise<unknown>;
    let fired = false;
    let rb: unknown = null;
    (c as unknown as { query: unknown }).query = async (...q: unknown[]) => {
      const out = await orig(...q);
      if (!fired && typeof q[0] === 'string' && q[0].includes('FOR UPDATE OF je') && q[0].includes('provisional_je_id')) {
        fired = true;
        rb = await settle(inTx(() => reverseJournalEntry(company, r2, user)));
      }
      return out;
    };
    await orig('BEGIN');
    const ra = await settle(als.run({ client: c, userId: user, companyId: company, claims: {} } as never,
      () => approveSupplierInvoice(company, invoiceId, user)));
    await orig(ra.ok ? 'COMMIT' : 'ROLLBACK');
    (c as unknown as { query: unknown }).query = orig;
    c.release();
    expect(fired).toBe(true);
    await assertConsistent('R1', x, bt, invoiceId, before);
  });

  it('R2: bill approved (uncommitted) first, then the head R2 is reversed from the GL', async () => {
    const doc = await seedDoc();
    const { je: x, bt } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const r = await inTx(() => reverseJournalEntry(company, x, user));
    const r2 = (await inTx(() => reverseJournalEntry(company, r.id, user))).id;
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    const before: Record<string, number> = await ledger();

    const a = await openTx(() => approveSupplierInvoice(company, invoiceId, user));
    const b = settle(inTx(() => reverseJournalEntry(company, r2, user)));
    await sleep(1500);
    await a.commit();
    const rb = await b;
    await assertConsistent('R2', x, bt, invoiceId, before);
  });

  it('R3 (control, not D8): un-reversed X — bill approved (uncommitted), then X itself reversed', async () => {
    const doc = await seedDoc();
    const { je: x, bt } = await seedProvisional({ totalAmount: 115, evidencedBy: doc });
    const invoiceId = await seedInvoice({ documentId: doc, totalAmount: 115 });
    const before: Record<string, number> = await ledger();

    const a = await openTx(() => approveSupplierInvoice(company, invoiceId, user));
    const b = settle(inTx(() => reverseJournalEntry(company, x, user)));
    await sleep(1500);
    await a.commit();
    const rb = await b;
    await assertConsistent('R3', x, bt, invoiceId, before);
  });
});
