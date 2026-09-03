/**
 * getVATReturn must ignore the journals that vatSubmissionService itself posts.
 *
 * V-05, second half. The clearing entry posts its three lines with
 * `vat_type = NULL` (verified on production JE-2026-00814), and getVATReturn's
 * "unclassified" fallback sweeps NULL-vat_type lines on a vat_output account
 * into box 1 and on a vat_input account into box 15. So the settlement is
 * counted as if it were trade VAT, in whatever period its entry_date lands in —
 * which is why dating it periodEnd flattened all six filed periods on the demo
 * company, and why merely moving the date to periodEnd + 1 day would relocate
 * the same contamination into the FOLLOWING period as a negative box 1.
 *
 * The predicate is `je.source IS DISTINCT FROM 'auto_vat_submission'`. It is
 * narrow by construction: 'auto_vat_submission' is written in exactly one place
 * (vatSubmissionService), and the gl_journal_entries_source_check constraint
 * carries 'auto_vat_adjustment' as a SEPARATE value, so manual and automated VAT
 * adjustments cannot be swallowed by it. The second test is what keeps that
 * true — it fails if the predicate is ever widened.
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
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';

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

/** A company with a vat_output, a vat_input and a non-VAT contra account. */
async function seedCompany(client: PoolClient): Promise<Fixture> {
  const { rows: co } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ('V-05 VAT return fixture') RETURNING id`,
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
    vatInputId:  await account('1140', 'VAT Input',  'asset',     'vat_input',  'debit'),
    // Deliberately NOT a vat/tax subtype: the service's SELECT must not pick it
    // up at all, so it can balance every entry without touching a box.
    contraId:    await account('2130', 'Accrued Expenses', 'liability', 'other_current_liability', 'credit'),
  };
}

interface Line {
  accountId: string;
  debit: number;
  credit: number;
  vatType?: string | null;
}

/** Insert a POSTED journal entry directly — no service, no fiscal period needed. */
async function postEntry(
  client: PoolClient, companyId: string, source: string | null,
  entryDate: string, lines: Line[],
): Promise<void> {
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  // A fixture that does not balance would prove nothing about a ledger service.
  expect(debits).toBeCloseTo(credits, 6);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_date, description, source, status, created_by)
     VALUES ($1, $2::DATE, 'V-05 fixture', $3, 'posted', $4) RETURNING id`,
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
}

/** Trade VAT every case shares: R1,000 output tax and R300 input tax. */
async function seedTradeVat(client: PoolClient, f: Fixture): Promise<void> {
  await postEntry(client, f.companyId, 'auto_invoice', '2026-01-15', [
    { accountId: f.vatOutputId, debit: 0, credit: 1000, vatType: 'standard' },
    { accountId: f.contraId,    debit: 1000, credit: 0 },
  ]);
  await postEntry(client, f.companyId, 'auto_supplier_invoice', '2026-01-20', [
    { accountId: f.vatInputId, debit: 300, credit: 0, vatType: 'standard' },
    { accountId: f.contraId,   debit: 0, credit: 300 },
  ]);
}

/** The clearing entry vatSubmissionService posts — all three lines vat_type NULL. */
async function seedClearingEntry(
  client: PoolClient, f: Fixture, entryDate: string,
): Promise<void> {
  await postEntry(client, f.companyId, 'auto_vat_submission', entryDate, [
    { accountId: f.vatOutputId, debit: 1000, credit: 0, vatType: null },
    { accountId: f.vatInputId,  debit: 0, credit: 300,  vatType: null },
    { accountId: f.contraId,    debit: 0, credit: 700,  vatType: null },
  ]);
}

function box(
  boxes: { box: string; amount: number }[], id: string,
): number {
  const b = boxes.find((x) => x.box === id);
  expect(b, `box ${id} missing`).toBeDefined();
  return b!.amount;
}

/** Run body inside a transaction that is ALWAYS rolled back. */
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

describe('getVATReturn — V-05 excludes the VAT submission clearing journal', () => {
  let dbUp = false;
  beforeAll(async () => {
    dbUp = await isDbReachable();
    if (dbUp) assertNotProductionDb('This test inserts companies, GL accounts and journal entries.');
  });

  it('ignores a clearing journal dated inside the reported period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      // The pre-fix behaviour: dated ON periodEnd, inside the window.
      await seedClearingEntry(client, f, PERIOD_END);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVATReturn(f.companyId, PERIOD_START, PERIOD_END),
      );

      // Without the predicate the clearing lines land in box 1 / box 15 with the
      // opposite sign and both collapse to zero — the production symptom.
      expect(box(r.outputBoxes, '1')).toBeCloseTo(1000, 2);
      expect(box(r.inputBoxes, '15')).toBeCloseTo(300, 2);
      expect(r.totalOutputTax).toBeCloseTo(1000, 2);
      expect(r.totalInputTax).toBeCloseTo(300, 2);
      expect(r.netVAT).toBeCloseTo(700, 2);
    });
  });

  it('ignores a clearing journal dated the first day of the reported period', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      // The post-fix placement, seen from the FOLLOWING period: the previous
      // period's clearing entry falls on day 1 of this one. Without the
      // predicate it would show up here as a negative box 1.
      await seedClearingEntry(client, f, PERIOD_START);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVATReturn(f.companyId, PERIOD_START, PERIOD_END),
      );

      expect(box(r.outputBoxes, '1')).toBeCloseTo(1000, 2);
      expect(box(r.inputBoxes, '15')).toBeCloseTo(300, 2);
    });
  });

  it('leaves no clearing-journal rows in the box 1 / box 15 drill-downs', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      await seedClearingEntry(client, f, PERIOD_END);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVATReturn(f.companyId, PERIOD_START, PERIOD_END),
      );

      // The totals could net to the right number by luck; the drill-down the UI
      // renders must not list the settlement either.
      const b1 = r.outputBoxes.find((b) => b.box === '1')!;
      const b15 = r.inputBoxes.find((b) => b.box === '15')!;
      expect(b1.transactions).toHaveLength(1);
      expect(b15.transactions).toHaveLength(1);
      expect(b1.transactions[0]!.amount).toBeCloseTo(1000, 2);
      expect(b15.transactions[0]!.amount).toBeCloseTo(300, 2);
    });
  });

  it('still counts auto_vat_adjustment, manual and NULL-source journals', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);
      await seedClearingEntry(client, f, PERIOD_END);

      // A VAT adjustment is a DIFFERENT source in gl_journal_entries_source_check.
      // Its lines are shaped exactly like the clearing entry's — same accounts,
      // vat_type NULL — so only the source distinguishes them. This is the
      // regression that fails if the predicate is ever widened.
      await postEntry(client, f.companyId, 'auto_vat_adjustment', '2026-02-10', [
        { accountId: f.vatOutputId, debit: 0, credit: 50, vatType: null },
        { accountId: f.contraId,    debit: 50, credit: 0 },
      ]);
      // A hand-posted correction.
      await postEntry(client, f.companyId, 'manual', '2026-02-11', [
        { accountId: f.vatInputId, debit: 20, credit: 0, vatType: null },
        { accountId: f.contraId,   debit: 0, credit: 20 },
      ]);
      // source is a NULLABLE column — `<>` would silently drop this row, which
      // is why the predicate is IS DISTINCT FROM.
      await postEntry(client, f.companyId, null, '2026-02-12', [
        { accountId: f.vatOutputId, debit: 0, credit: 5, vatType: null },
        { accountId: f.contraId,    debit: 5, credit: 0 },
      ]);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVATReturn(f.companyId, PERIOD_START, PERIOD_END),
      );

      expect(box(r.outputBoxes, '1')).toBeCloseTo(1055, 2);  // 1000 + 50 + 5
      expect(box(r.inputBoxes, '15')).toBeCloseTo(320, 2);    // 300 + 20
      expect(r.totalOutputTax).toBeCloseTo(1055, 2);
      expect(r.totalInputTax).toBeCloseTo(320, 2);
    });
  });

  it('excludes the clearing journal by SOURCE, not by its NULL vat_type', async () => {
    if (!dbUp) return;
    await inRolledBackTx(async (client) => {
      const f = await seedCompany(client);
      await seedTradeVat(client, f);

      // Same source as the clearing entry but classified lines. It must STILL be
      // excluded — otherwise a future change that starts stamping vat_type on
      // the clearing entry would quietly re-open V-05.
      await postEntry(client, f.companyId, 'auto_vat_submission', '2026-02-14', [
        { accountId: f.vatOutputId, debit: 1000, credit: 0, vatType: 'standard' },
        { accountId: f.contraId,    debit: 0, credit: 1000 },
      ]);

      const r = await als.run(ctxFor(client, f.companyId), () =>
        getVATReturn(f.companyId, PERIOD_START, PERIOD_END),
      );

      expect(box(r.outputBoxes, '1')).toBeCloseTo(1000, 2);
    });
  });
});
