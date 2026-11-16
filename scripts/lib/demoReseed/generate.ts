/**
 * generateDemoData: the whole Demo company as rows, from a date, a seed and the
 * company's resolved accounts. Pure: no database, no clock, no unseeded randomness.
 */

import { windowFor } from './dates';
import { assets, bankChargesAndInterest, expenseClaims, openingCapital, practice, topUpCapital } from './generateExtras';
import { generateBank } from './generateBank';
import { generateCustomers, generateQuotes } from './generateCustomers';
import { generatePayroll } from './generatePayroll';
import { generatePurchases } from './generatePurchases';
import { generateSales } from './generateSales';
import { JournalBuilder } from './journal';
import { makeRng } from './rng';
import { SEED_TABLES, type Ctx, type DemoData, type GenerateInput, type Row, type SeedTable } from './types';

const STEP_CENTS = 50_000_00;

export function generateDemoData(input: GenerateInput): DemoData {
  const win = windowFor(input.today);
  const rng = makeRng(input.seed);
  const rows = Object.fromEntries(SEED_TABLES.map((t) => [t, [] as Row[]])) as Record<SeedTable, Row[]>;
  const ctx: Ctx = {
    input, win, rng, jb: new JournalBuilder(rng, input.today), rows,
    used: { customer_invoice: 0, customer_receipt: 0, supplier_payment: 0, quotation: 0 },
  };
  const opening = openingCapital(ctx);
  generateCustomers(ctx);
  generateSales(ctx);
  generateQuotes(ctx);
  const assetBills = generatePurchases(ctx);
  assets(ctx, assetBills);
  generatePayroll(ctx);
  bankChargesAndInterest(ctx);
  practice(ctx);
  expenseClaims(ctx);
  const min = ctx.jb.minBankBalance(input.accounts.bank);
  if (min < 0) topUpCapital(opening, Math.ceil(-min / STEP_CENTS) * STEP_CENTS);
  generateBank(ctx);
  const journal = ctx.jb.rows(input.companyId, input.actorId);
  rows.gl_journal_entries = journal.entries;
  rows.gl_journal_lines = journal.lines;
  return {
    rows,
    nextNumbers: {
      customer_invoice: ctx.used.customer_invoice + 1, customer_receipt: ctx.used.customer_receipt + 1,
      supplier_payment: ctx.used.supplier_payment + 1, quotation: ctx.used.quotation + 1,
    },
    openingCapitalCents: opening.lines[0]!.debit,
  };
}
