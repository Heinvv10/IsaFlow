/**
 * getVatExceptions must ignore the journals that vatSubmissionService posts.
 *
 * V-05, third and fourth copies. The clearing entry posts every line with
 * `vat_type = NULL` on the two VAT control accounts, which contaminated
 * `vatExceptionsService` twice over:
 *
 *  1. The VAT201-vs-GL control recon (query 6) aggregates raw control-account
 *     movement. The clearing entry reverses the whole period's output and input
 *     tax off those accounts, so the GL side collapsed to near-nil and the
 *     recon compared a correct invoice-derived figure against a contaminated
 *     one. On the demo company the GL output figure was R11,363 against a
 *     VAT201 of R292,096 — a variance that told the filer nothing.
 *
 *  2. The "uncoded GL VAT lines" exception (query 1) lists posted control-account
 *     lines with no `vat_type`. The clearing entry's own two VAT legs are
 *     exactly that shape, so every filed period grew two permanent exceptions
 *     that no amount of coding work could ever clear — 12 rows in production.
 *
 * Both are fixed with the same predicate getVATReturn uses:
 * `je.source IS DISTINCT FROM 'auto_vat_submission'`. The tests below assert
 * BEHAVIOUR, not SQL text, so an explanatory comment cannot keep them green
 * once the real predicate is removed.
 *
 * The genuine invoice-vs-GL residual must SURVIVE the fix — it is the posting
 * gap the exceptions report exists to surface. `keeps a genuine invoice-vs-GL
 * residual visible` is the test that pins that down.
 *
 * This test WRITES, so it refuses to run against the production database. Every
 * row goes into a transaction that is always rolled back.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';

const USER_ID = '00000000-0000-0000-0000-0000000000aa';
const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-02-28';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER_ID, companyId, claims: {} } as unknown as Ctx);

interface Fixture {
  companyId: string;
  vatOutputId: string;
  vatInputId: string;
  contraId: string;
}

async function seedCompany(client: PoolClient): Promise<Fixture> {
  const { rows: co } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ('V-05 VAT exceptions fixture') RETURNING id`,
  );
  const companyId = co[0]!.id;

  const account = async (
    code: string, name: string, type: string, subtype: string | null, normal: string,
  ): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts
         (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [companyId, code, name, type, subtype, normal],
    );
    return rows[0]!.id;
  };

  return {
    companyId,
    vatOutputId: await account('2120', 'VAT Output', 'liability', 'vat_output', 'credit'),
    vatInputId: await account('1140', 'VAT Input', 'asset', 'vat_input', 'debit'),
    // Not a VAT subtype: it balances every entry without entering any VAT query.
    contraId: await account('2130', 'Accrued Expenses', 'liability', 'other_current_liability', 'credit'),
  };
}

interface Line {
  accountId: string;
  debit: number;
  credit: number;
  vatType?: string | null;
}

async function postEntry(
  client: PoolClient, companyId: string, source: string | null,
  entryDate: string, lines: Line[],
): Promise<string> {
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  // A fixture that does not balance would prove nothing about a ledger service.
  expect(debits).toBeCloseTo(credits, 6);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_date, description, source, status, created_by)
     VALUES ($1, $2::DATE, 'V-05 exceptions fixture', $3, 'posted', $4) RETURNING id`,
    [companyId, entryDate, source, USER_ID],
  );
  const entryId = rows[0]!.id;

  for (const l of lines) {
    await client.query(
      `INSERT INTO gl_journal_lines
         (journal_entry_id, gl_account_id, company_id, debit, credit, vat_type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entryId, l.accountId, companyId, l.debit, l.credit, l.vatType ?? null],
    );
  }
  return entryId;
}

/** R1,000 output tax and R300 input tax, both properly coded. */
async function seedTradeVat(client: PoolClient, f: Fixture): Promise<string> {
  const outputJe = await postEntry(client, f.companyId, 'auto_invoice', '2026-01-15', [
    { accountId: f.vatOutputId, debit: 0, credit: 1000, vatType: 'standard' },
    { accountId: f.contraId, debit: 1000, credit: 0 },
  ]);
  await postEntry(client, f.companyId, 'auto_supplier_invoice', '2026-01-20', [
    { accountId: f.vatInputId, debit: 300, credit: 0, vatType: 'standard' },
    { accountId: f.contraId, debit: 0, credit: 300 },
  ]);
  return outputJe;
}

/** The clearing entry vatSubmissionService posts — all three lines vat_type NULL. */
async function seedClearingEntry(
  client: PoolClient, f: Fixture, entryDate: string,
): Promise<void> {
  await postEntry(client, f.companyId, 'auto_vat_submission', entryDate, [
    { accountId: f.vatOutputId, debit: 1000, credit: 0, vatType: null },
    { accountId: f.vatInputId, debit: 0, credit: 300, vatType: null },
    { accountId: f.contraId, debit: 0, credit: 700, vatType: null },
  ]);
}

/**
 * A customer invoice carrying MORE VAT than the GL received, linked to the
 * output journal. The R250 difference is the invoice-vs-GL posting gap the
 * recon exists to surface: it must survive the V-05 fix.
 */
async function seedInvoiceWithResidual(
  client: PoolClient, f: Fixture, journalEntryId: string, taxAmount: number,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO customers (company_id, name) VALUES ($1, 'V-05 Customer') RETURNING id`,
    [f.companyId],
  );
  await client.query(
    `INSERT INTO customer_invoices
       (company_id, customer_id, invoice_number, invoice_date, subtotal, tax_rate,
        tax_amount, total_amount, status, created_by, gl_journal_entry_id)
     VALUES ($1,$2,'INV-V05','2026-01-15'::DATE, 8333.33, 15, $3, $4, 'sent', $5, $6)`,
    [f.companyId, rows[0]!.id, taxAmount, 8333.33 + taxAmount, USER_ID, journalEntryId],
  );
}

async function inRolledBackTx(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const run = (client: PoolClient, f: Fixture) =>
  als.run(ctxFor(client, f.companyId), () =>
    getVatExceptions(f.companyId, PERIOD_START, PERIOD_END));

describe('getVatExceptions — V-05 excludes the VAT submission clearing journal', () => {
  let dbUp = false;
  beforeAll(async () => {
    dbUp = await isDbReachable();
    if (dbUp) assertNotProductionDb('This test inserts companies, GL accounts and journal entries.');
  });

  it('keeps the GL control movement intact when a clearing journal sits in the period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      // The production placement: dated ON periodEnd, inside the window.
      await seedClearingEntry(client, f, PERIOD_END);

      const r = await run(client, f);

      // Without the predicate the clearing legs reverse the trade VAT and both
      // figures collapse to zero — the production symptom.
      expect(r.controlRecon.outputGl).toBeCloseTo(1000, 2);
      expect(r.controlRecon.inputGl).toBeCloseTo(300, 2);
      expect(r.controlRecon.netGl).toBeCloseTo(700, 2);
    });
  });

  it('keeps the GL control movement intact for a clearing journal dated day 1', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      // The post-fix placement seen from the FOLLOWING period: the previous
      // period's clearing entry lands on day 1 of this one.
      await seedClearingEntry(client, f, PERIOD_START);

      const r = await run(client, f);

      expect(r.controlRecon.outputGl).toBeCloseTo(1000, 2);
      expect(r.controlRecon.inputGl).toBeCloseTo(300, 2);
    });
  });

  // DO NOT DELETE AS REDUNDANT. This looks like a variation on the two recon
  // tests above, but it is the only test covering query 1 of the service — the
  // "uncoded GL VAT lines" exception — and the only one that goes red if that
  // query's source predicate is removed. Verified by mutation: dropping the
  // predicate from query 1 alone reddens exactly this test and the
  // 'still counts auto_vat_adjustment' one below, and nothing else. Without it,
  // 2 permanent uncodeable exceptions per filed period come back unnoticed.
  it('does not list the clearing journal legs as uncoded GL VAT lines', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      await seedClearingEntry(client, f, PERIOD_END);

      const r = await run(client, f);

      // The clearing entry's two VAT legs are the only NULL-vat_type lines on a
      // control account here. Before the fix they were 2 permanent exceptions
      // per filed period that no coding work could clear.
      expect(r.uncodedGlLineCount).toBe(0);
      expect(r.uncodedGlLines).toHaveLength(0);
    });
  });

  // The only test asserting the fix did not OVER-correct. Every other test here
  // would still pass if the recon were "fixed" into always agreeing with the
  // VAT201; this one fails, because a clean recon means the invoice-vs-GL
  // posting gap — the thing the whole report exists to surface — has been
  // hidden rather than measured. On the demo company that gap is R41k–R157k
  // per period and it is REAL.
  it('keeps a genuine invoice-vs-GL residual visible', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      const outputJe = await seedTradeVat(client, f);
      await seedClearingEntry(client, f, PERIOD_END);
      // Invoice carries R1,250 of VAT; only R1,000 reached the GL.
      await seedInvoiceWithResidual(client, f, outputJe, 1250);

      const r = await run(client, f);

      expect(r.controlRecon.outputVat201).toBeCloseTo(1250, 2);
      expect(r.controlRecon.outputGl).toBeCloseTo(1000, 2);
      // The posting gap is the point of the report. A fix that made this come
      // out clean would have over-corrected.
      expect(r.controlRecon.outputVariance).toBeCloseTo(250, 2);
    });
  });

  // DO NOT DELETE AS REDUNDANT — this is the load-bearing test in this file.
  // It reads like a duplicate of the recon tests above, but it is the ONLY
  // thing standing between the predicate and two specific regressions, both
  // confirmed by mutation, each of which nothing else in this suite catches:
  //
  //   1. NULLABILITY. Rewrite IS DISTINCT FROM as a plain inequality and every
  //      NULL-source journal silently vanishes from both the recon and the
  //      uncoded list, because an inequality against NULL yields NULL, not
  //      true. Only the NULL-source journal seeded below detects it — 5 of the
  //      6 tests here stay green.
  //   2. WIDENING. Broaden the match (a LIKE on 'auto_vat%' is the obvious
  //      way someone does this) and auto_vat_adjustment — a SEPARATE value in
  //      gl_journal_entries_source_check, i.e. real VAT adjustments — gets
  //      swallowed along with the clearing journal. Again only this test fails.
  //
  // Deleting it as redundant removes the guard for both at once. If it feels
  // duplicative, the fixture is what makes it different: the three journals
  // below are shaped EXACTLY like the clearing entry (same accounts, vat_type
  // NULL) so that source is the only thing distinguishing them.
  it('still counts auto_vat_adjustment, manual and NULL-source journals', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      await seedClearingEntry(client, f, PERIOD_END);

      // 'auto_vat_adjustment' is a SEPARATE value in gl_journal_entries_source_check.
      // Its lines are shaped exactly like the clearing entry's, so only the
      // source distinguishes them: this fails if the predicate is widened.
      await postEntry(client, f.companyId, 'auto_vat_adjustment', '2026-02-10', [
        { accountId: f.vatOutputId, debit: 0, credit: 50, vatType: null },
        { accountId: f.contraId, debit: 50, credit: 0 },
      ]);
      await postEntry(client, f.companyId, 'manual', '2026-02-11', [
        { accountId: f.vatInputId, debit: 20, credit: 0, vatType: null },
        { accountId: f.contraId, debit: 0, credit: 20 },
      ]);
      // source is NULLABLE — a plain inequality would silently drop this row,
      // which is why the predicate is IS DISTINCT FROM.
      await postEntry(client, f.companyId, null, '2026-02-12', [
        { accountId: f.vatOutputId, debit: 0, credit: 5, vatType: null },
        { accountId: f.contraId, debit: 5, credit: 0 },
      ]);

      const r = await run(client, f);

      expect(r.controlRecon.outputGl).toBeCloseTo(1055, 2);   // 1000 + 50 + 5
      expect(r.controlRecon.inputGl).toBeCloseTo(320, 2);     // 300 + 20
      // Those three journals ARE uncoded VAT lines and must still be reported.
      expect(r.uncodedGlLineCount).toBe(3);
    });
  });

  // The only test that pins the exclusion to `je.source`. Swap the predicate
  // for anything keyed off the clearing journal's NULL vat_type instead and
  // every other test here still passes — this one fails, because its clearing
  // entry carries CLASSIFIED lines. That keeps V-05 shut if someone later
  // starts stamping vat_type on the submission journal.
  it('excludes the clearing journal by SOURCE, not by its NULL vat_type', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      // Same source, but classified lines. It must STILL be excluded, so a
      // future change that starts stamping vat_type on the clearing entry
      // cannot quietly re-open V-05.
      await postEntry(client, f.companyId, 'auto_vat_submission', '2026-02-14', [
        { accountId: f.vatOutputId, debit: 1000, credit: 0, vatType: 'standard' },
        { accountId: f.contraId, debit: 0, credit: 1000 },
      ]);

      const r = await run(client, f);

      expect(r.controlRecon.outputGl).toBeCloseTo(1000, 2);
    });
  });
});
