/**
 * Budgets P3 PR-B review r1, on real PostgreSQL: the Budget vs Actual drill's
 * opt-ins on `getAccountTransactions` (`documents`, `naturalSign`).
 *
 * - One journal per document kind (customer invoice, customer credit note,
 *   customer payment, supplier invoice, supplier credit note, supplier payment):
 *   with `documents` each row carries its own document; under every filter the
 *   drill still runs opening + periodNet = closing.
 * - Two documents on one journal pick deterministically (kind priority, then id).
 * - Without the opt-ins (TB / BS / IS drills) no row carries `journalId` or
 *   `document`: their output is what it was.
 * - A revenue account set debit-normal: with `naturalSign` (revenue credit −
 *   debit, as the BvA Actual reads) the drill's periodNet equals the BvA line.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import type { JournalDocumentKind } from '@/modules/accounting/services/gl/journalDocuments';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const KINDS: JournalDocumentKind[] = ['customer_invoice', 'credit_note', 'customer_payment', 'supplier_invoice', 'supplier_credit_note', 'supplier_payment'];

/** A posted April journal on BT-4000 (tagged FT / P1 / B1) and the bank. */
async function postSale(c: PoolClient, entryNumber: string, credit: number): Promise<string> {
  const eid = crypto.randomUUID();
  await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                 VALUES ($1, $2, $3, '2026-04-10', 'posted', $4, 'doc', 'manual', NOW())`, [eid, f.a, entryNumber, f.userA]);
  await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, cc2_id, bu_id, description)
                 VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8, 'doc'), ($9, $2, $3, $10, $5, 0, NULL, NULL, NULL, 'doc')`,
  [crypto.randomUUID(), eid, f.a, f.acc.sales, credit, f.cc.FT, f.cc.P1, f.bu.B1, crypto.randomUUID(), f.acc.bank]);
  return eid;
}

/** A document of `kind` pointing at journal `je` (company A unless `co`); returns its id. */
async function documentFor(c: PoolClient, kind: JournalDocumentKind, je: string, docId = crypto.randomUUID(), co = f.a): Promise<string> {
  const party = crypto.randomUUID();
  const n = `DOC-${docId.slice(0, 8)}`;
  switch (kind) {
    case 'customer_invoice':
      await c.query(`INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, created_by, gl_journal_entry_id) VALUES ($1, $2, $3, $4, $5, $6)`, [docId, co, n, party, f.userA, je]); break;
    case 'credit_note':
    case 'supplier_credit_note':
      await c.query(`INSERT INTO credit_notes (id, company_id, credit_note_number, type, credit_date, created_by, gl_journal_entry_id) VALUES ($1, $2, $3, $4, '2026-04-10', $5, $6)`,
        [docId, co, n, kind === 'credit_note' ? 'customer' : 'supplier', f.userA, je]); break;
    case 'customer_payment':
      await c.query(`INSERT INTO customer_payments (id, company_id, client_id, payment_date, total_amount, created_by, gl_journal_entry_id) VALUES ($1, $2, $3, '2026-04-10', 1, $4, $5)`, [docId, co, party, f.userA, je]); break;
    case 'supplier_invoice':
      await c.query(`INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, created_by, gl_journal_entry_id) VALUES ($1, $2, $3, $4, '2026-04-10', $5, $6)`, [docId, co, n, party, f.userA, je]); break;
    case 'supplier_payment':
      await c.query(`INSERT INTO supplier_payments (id, company_id, supplier_id, payment_date, total_amount, created_by, gl_journal_entry_id) VALUES ($1, $2, $3, '2026-04-10', 1, $4, $5)`, [docId, co, party, f.userA, je]); break;
  }
  return docId;
}

const replica = (c: PoolClient) => c.query('SET LOCAL session_replication_role = replica');
const origin = (c: PoolClient) => c.query('SET LOCAL session_replication_role = origin');
const FILTERS = (): Array<[string, string | undefined, { cc1Id?: string; cc2Id?: string }]> => [
  ['none', undefined, {}], ['cc1', undefined, { cc1Id: f.cc.FT }], ['cc2', undefined, { cc2Id: f.cc.P1 }],
  ['bu', f.bu.B1, {}], ['cc1+bu', f.bu.B1, { cc1Id: f.cc.FT }], ['cc2+bu', f.bu.B1, { cc2Id: f.cc.P1 }],
];

describe('drill documents (opt-in)', () => {
  it('each document kind links its own journal, and every filter still foots opening + periodNet = closing', async () => {
    const seeded = new Map<string, { kind: JournalDocumentKind; id: string }>();
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const res: Array<{ name: string; d: Awaited<ReturnType<typeof getAccountTransactions>> }> = [];
      for (const [name, bu, dims] of FILTERS()) {
        res.push({ name, d: await getAccountTransactions(f.a, 'BT-4000', '2026-04-01', '2026-04-30', undefined, bu, { ...dims, documents: true, naturalSign: true }) });
      }
      return res;
    }, {
      before: async (c) => {
        await replica(c);
        for (const [i, kind] of KINDS.entries()) {
          const je = await postSale(c, `DOC-${i}`, 10 + i);
          seeded.set(je, { kind, id: await documentFor(c, kind, je) });
        }
        await origin(c);
      },
    });
    for (const { name, d } of out) {
      expect(Math.round((d.openingBalance + d.periodNet) * 100), name).toBe(Math.round(d.closingBalance * 100));
      const linked = d.transactions.filter((t) => t.journalId && seeded.has(t.journalId));
      expect(linked.map((t) => t.document?.kind).sort(), name).toEqual([...KINDS].sort());
      for (const t of linked) expect(t.document, name).toEqual(seeded.get(t.journalId!));
      for (const t of d.transactions.filter((x) => !x.derived && !seeded.has(x.journalId!))) expect(t.document, name).toBeNull();
    }
  });

  it('two documents on one journal: the kind priority wins, then the lowest id', async () => {
    const lo = '00000000-0000-4000-8000-000000000001', hi = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    let jeA = '', jeB = '';
    const d = await asRequest(pool, f.a, f.userA,
      () => getAccountTransactions(f.a, 'BT-4000', '2026-04-01', '2026-04-30', undefined, undefined, { documents: true }), {
        before: async (c) => {
          await replica(c);
          jeA = await postSale(c, 'DOC-PRI-A', 1);
          await documentFor(c, 'supplier_payment', jeA);
          await documentFor(c, 'customer_invoice', jeA, hi);
          jeB = await postSale(c, 'DOC-PRI-B', 2);
          await documentFor(c, 'customer_payment', jeB, hi);
          await documentFor(c, 'customer_payment', jeB, lo);
          await origin(c);
        },
      });
    const docOf = (je: string) => d.transactions.find((t) => t.journalId === je)?.document;
    expect(docOf(jeA)).toEqual({ kind: 'customer_invoice', id: hi });
    expect(docOf(jeB)).toEqual({ kind: 'customer_payment', id: lo });
  });

  it("another company's document pointing at the journal is never returned", async () => {
    let je = '';
    const d = await asRequest(pool, f.a, f.userA,
      () => getAccountTransactions(f.a, 'BT-4000', '2026-04-01', '2026-04-30', undefined, undefined, { documents: true }), {
        before: async (c) => {
          await replica(c);
          je = await postSale(c, 'DOC-XCO', 4);
          for (const kind of KINDS) await documentFor(c, kind, je, crypto.randomUUID(), f.b);
          await origin(c);
        },
      });
    expect(d.transactions.find((t) => t.journalId === je)?.document).toBeNull();
  });

  it('without the opt-ins (TB / BS / IS drills) no row carries a journal id or document', async () => {
    const d = await asRequest(pool, f.a, f.userA,
      () => getAccountTransactions(f.a, 'BT-4000', '2026-04-01', '2026-04-30'), {
        before: async (c) => { await replica(c); await documentFor(c, 'customer_invoice', await postSale(c, 'DOC-OFF', 3)); await origin(c); },
      });
    expect(d.transactions.length).toBeGreaterThan(0);
    for (const t of d.transactions) {
      expect(Object.keys(t)).not.toContain('journalId');
      expect(Object.keys(t)).not.toContain('document');
    }
  });
});

describe('the opening balance under each filter (review r2 N3)', () => {
  // A March posting on BT-4000 tagged to the OTHER FNO (HT), business unit B2, no project: inside FY2027
  // (so in an April window's opening), outside every filter below but "none".
  async function seedMarch(c: PoolClient) {
    const eid = crypto.randomUUID();
    await replica(c);
    await c.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, status, created_by, description, source, created_at)
                   VALUES ($1, $2, 'OPEN-1', '2026-03-20', 'posted', $3, 'open', 'manual', NOW())`, [eid, f.a, f.userA]);
    await c.query(`INSERT INTO gl_journal_lines (id, journal_entry_id, company_id, gl_account_id, debit, credit, cc1_id, cc2_id, bu_id, description)
                   VALUES ($1, $2, $3, $4, 0, 4321.09, $5, NULL, $6, 'open'), ($7, $2, $3, $8, 4321.09, 0, NULL, NULL, NULL, 'open')`,
    [crypto.randomUUID(), eid, f.a, f.acc.sales, f.cc.HT, f.bu.B2, crypto.randomUUID(), f.acc.bank]);
    await origin(c);
  }
  const openings = (seed: boolean) => asRequest(pool, f.a, f.userA, async () => {
    const out: Record<string, number> = {};
    for (const [name, bu, dims] of FILTERS()) {
      out[name] = (await getAccountTransactions(f.a, 'BT-4000', '2026-04-01', '2026-04-30', undefined, bu, { ...dims, naturalSign: true })).openingBalance;
    }
    return out;
  }, seed ? { before: seedMarch } : {});

  it('the posting moves the unfiltered opening by its amount, and no filtered opening it does not match', async () => {
    const [without, withSeed] = [await openings(false), await openings(true)];
    const moved = Object.fromEntries(Object.keys(without).map((k) => [k, Math.round((withSeed[k]! - without[k]!) * 100) / 100]));
    expect(moved).toEqual({ none: 4321.09, cc1: 0, cc2: 0, bu: 0, 'cc1+bu': 0, 'cc2+bu': 0 });
    // The filtered openings are their own figures, not the unfiltered one.
    for (const k of ['cc1', 'cc2', 'bu']) expect(withSeed[k]).not.toBe(withSeed.none);
  });
});

describe('drill sign (opt-in naturalSign)', () => {
  it('a debit-normal revenue account: the BvA drill periodNet equals the line Actual (revenue = credit − debit)', async () => {
    const out = await asRequest(pool, f.a, f.userA, async () => {
      const r = await buildBudgetTrackingReport(f.a, { period: 'fy', fiscalYear: 2027 }, NOW);
      const line = r.lines.find((l) => l.accountCode === 'BT-4000')!;
      const bva = await getAccountTransactions(f.a, 'BT-4000', r.window.startDate, r.window.endDate, undefined, undefined, { naturalSign: true });
      const tb = await getAccountTransactions(f.a, 'BT-4000', r.window.startDate, r.window.endDate);
      return { line: line.actual, bva, tb };
    }, {
      before: (c) => c.query(`UPDATE gl_accounts SET normal_balance = 'debit' WHERE company_id = $1 AND account_code = 'BT-4000'`, [f.a]),
    });
    expect(out.line).toBeGreaterThan(0);
    expect(Math.round(out.bva.periodNet * 100)).toBe(Math.round(out.line * 100));
    expect(Math.round((out.bva.openingBalance + out.bva.periodNet) * 100)).toBe(Math.round(out.bva.closingBalance * 100));
    // The statement drills keep the account's own normal balance (unchanged behaviour).
    expect(Math.round(out.tb.periodNet * 100)).toBe(-Math.round(out.line * 100));
  });
});
