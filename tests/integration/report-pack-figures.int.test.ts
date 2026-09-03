// tests/integration/report-pack-figures.int.test.ts
//
// The board / management / monthly PDF pack is what a director reads. Four of
// its figures were literals:
//
//     cash: 0,
//     accountsReceivable: 0,
//     accountsPayable: 0,
//     inventory: 0,
//
// so every liquidity ratio built on them — current ratio, quick ratio, cash
// position — was computed from zero regardless of what the company held. (The
// audit named two of the four.)
//
// Worse, the two figures that WERE computed came from account-code ranges:
//
//     accountCode.startsWith('1') && Number(accountCode) < 1200   → current assets
//     accountCode.startsWith('2') && Number(accountCode) < 2200   → current liabilities
//
// Production charts put assets, liabilities, equity, revenue and expenses all
// under code prefix '4', and Sage-imported charts use alphabetic prefixes, so
// those filters select close to nothing on a real chart. This is the same
// classify-by-account-code defect that was removed across the reporting layer;
// this endpoint was missed.
//
// Every figure now comes from the one financial-figures resolver, which
// classifies on account_type and canonical subtypes. These tests assert the
// numbers, and that they equal the canonical resolver's.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import {
  getFinancialFigures,
  toFinancialData,
} from '@/modules/accounting/services/gl/financialFiguresService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-0000000000b1';
const GL_BANK = '00000000-0000-0000-0000-0000000000b2';
const GL_AR = '00000000-0000-0000-0000-0000000000b3';
const GL_AP = '00000000-0000-0000-0000-0000000000b4';
const GL_STOCK = '00000000-0000-0000-0000-0000000000b5';
const GL_REVENUE = '00000000-0000-0000-0000-0000000000b6';
const GL_EQUITY = '00000000-0000-0000-0000-0000000000b7';

const FROM = '2026-01-01';
const TO = '2026-12-31';

const CASH = 1000;
const RECEIVABLE = 500;
const PAYABLE = 300;
const INVENTORY = 200;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('report pack figures come from the ledger, not from literals', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes journal fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Report Pack Fixture', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );

    // Account codes deliberately in the 4000s and alphabetic — the shapes real
    // production and Sage-imported charts use, and which the old account-code
    // range filters could not see.
    await admin.query(
      `INSERT INTO gl_accounts
         (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES
         ($2, $1, '4100', 'Bank',            'asset',     'bank',        'debit',  true),
         ($3, $1, '4200', 'Trade Debtors',   'asset',     'receivable',  'debit',  true),
         ($4, $1, 'B300', 'Trade Creditors', 'liability', 'payable',     'credit', true),
         ($5, $1, '4400', 'Stock on Hand',   'asset',     'inventory',   'debit',  true),
         ($6, $1, '4500', 'Sales',           'revenue',   'sales',       'credit', true),
         ($7, $1, '4600', 'Share Capital',   'equity',    'equity',      'credit', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY, GL_BANK, GL_AR, GL_AP, GL_STOCK, GL_REVENUE, GL_EQUITY],
    );

    await postEntry(admin, 'rp-1', '2026-03-01', [
      { account: GL_BANK, debit: CASH, credit: 0 },
      { account: GL_EQUITY, debit: 0, credit: CASH },
    ]);
    await postEntry(admin, 'rp-2', '2026-04-01', [
      { account: GL_AR, debit: RECEIVABLE, credit: 0 },
      { account: GL_REVENUE, debit: 0, credit: RECEIVABLE },
    ]);
    await postEntry(admin, 'rp-3', '2026-05-01', [
      { account: GL_STOCK, debit: INVENTORY, credit: 0 },
      { account: GL_AP, debit: 0, credit: INVENTORY },
    ]);
    await postEntry(admin, 'rp-4', '2026-06-01', [
      { account: GL_STOCK, debit: PAYABLE - INVENTORY, credit: 0 },
      { account: GL_AP, debit: 0, credit: PAYABLE - INVENTORY },
    ]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('reports the cash the company actually holds', async () => {
    const input = await getReportPackInput(COMPANY, 'Report Pack Fixture', FROM, TO);
    expect(input.cash).toBeCloseTo(CASH, 2);
  });

  it('reports receivables, payables and inventory rather than zero', async () => {
    const input = await getReportPackInput(COMPANY, 'Report Pack Fixture', FROM, TO);

    expect(input.accountsReceivable).toBeCloseTo(RECEIVABLE, 2);
    expect(input.accountsPayable).toBeCloseTo(PAYABLE, 2);
    expect(input.inventory).toBeCloseTo(PAYABLE, 2); // stock debits total 300
  });

  it('classifies current assets and liabilities without reading account codes', async () => {
    const input = await getReportPackInput(COMPANY, 'Report Pack Fixture', FROM, TO);

    // Every fixture account is coded in the 4000s or alphabetically, so the
    // old `startsWith('1') && < 1200` filter would report 0 here.
    expect(input.currentAssets).toBeGreaterThan(0);
    expect(input.currentLiabilities).toBeGreaterThan(0);
  });

  it('agrees with the canonical financial figures resolver on every figure', async () => {
    const input = await getReportPackInput(COMPANY, 'Report Pack Fixture', FROM, TO);
    const canonical = toFinancialData(await getFinancialFigures(COMPANY, FROM, TO));

    for (const key of [
      'revenue', 'costOfSales', 'operatingExpenses', 'netProfit',
      'totalAssets', 'totalLiabilities', 'totalEquity',
      'currentAssets', 'currentLiabilities',
      'cash', 'accountsReceivable', 'accountsPayable', 'inventory',
    ] as const) {
      expect(`${key}=${input[key].toFixed(2)}`).toBe(`${key}=${canonical[key].toFixed(2)}`);
    }
  });

  it('the accounting equation holds on the figures the pack prints', async () => {
    const input = await getReportPackInput(COMPANY, 'Report Pack Fixture', FROM, TO);
    expect(input.totalAssets).toBeCloseTo(input.totalLiabilities + input.totalEquity, 2);
  });
});

interface Leg { account: string; debit: number; credit: number }

async function postEntry(admin: Pool, entryNumber: string, entryDate: string, legs: Leg[]): Promise<void> {
  const { rows } = await admin.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
     VALUES ($1, $2, $3, 'report pack fixture', 'posted', $1) RETURNING id`,
    [COMPANY, entryNumber, entryDate],
  );
  for (const leg of legs) {
    await admin.query(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5)`,
      [COMPANY, rows[0].id, leg.account, leg.debit, leg.credit],
    );
  }
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
