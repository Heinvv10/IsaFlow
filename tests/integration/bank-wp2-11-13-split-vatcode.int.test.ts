/**
 * Bank Transactions audit, WP2 rows 11 and 13 — against a real ledger.
 *
 * Row 11: a split's lines are compared with the line's amount in INTEGER CENTS, exactly. The old float tolerance
 * (`> 0.01`) let R5.01 of lines through for an R5.00 line (5.01 - 5.00 is 0.00999… in IEEE-754); the refusal names
 * both totals in rands and nothing is written.
 *
 * Row 13: a VAT code outside none / standard / zero_rated / exempt is refused — on a single allocation (every arm),
 * on a split line, and in the bank-rule sweep (a counted skip). It used to post the gross with no VAT and no vat_type.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  allocateTransaction, splitAllocateTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import type { SplitLine } from '@/modules/accounting/services/bank/bankAllocationTypes';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function accountByCode(code: string): Promise<string> {
  const [r] = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${code}`) as Record<string, unknown>[];
  return String(r!.id);
}
async function journalCount(): Promise<number> {
  const [r] = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(r!.n);
}
async function lineStatus(tx: string): Promise<string> {
  const [r] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return String(r!.status);
}
async function journalLines(entryId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT a.account_code, jl.debit::float8 AS dr, jl.credit::float8 AS cr, jl.vat_type
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.journal_entry_id = ${entryId}::UUID AND jl.company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return rows.map((r) => `${String(r.account_code)}:${Number(r.dr).toFixed(2)}/${Number(r.cr).toFixed(2)}:${String(r.vat_type ?? '-')}`).sort();
}

describeIfDb('WP2 rows 11 + 13: exact split totals, known VAT codes only', () => {
  beforeAll(async () => { fx = await seedFixture('WP2R1113', DATABASE_URL!); }, 60000);
  afterAll(async () => { await dropFixture(fx); }, 60000);

  // ── Row 11 ──────────────────────────────────────────────────────────────────
  it('refuses split lines of R5.01 on an R5.00 line, naming both totals, before anything is written', async () => {
    const expense = await accountByCode('6000');
    const tx = await seedBankTx(fx, { date: '2026-10-05', amount: -5, description: 'split off by a cent' });
    const before = await journalCount();
    const lines: SplitLine[] = [
      { contraAccountId: expense, amount: 2.51 }, { contraAccountId: expense, amount: 2.5 },
    ];
    await expect(inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, lines, fx.userId)))
      .rejects.toThrow(/^Split lines total R\s5\.01 does not equal the transaction amount R\s5\.00/);
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a split whose line is not whole cents', async () => {
    const expense = await accountByCode('6000');
    const tx = await seedBankTx(fx, { date: '2026-10-05', amount: -5, description: 'split sub-cent' });
    const lines: SplitLine[] = [{ contraAccountId: expense, amount: 2.505 }, { contraAccountId: expense, amount: 2.495 }];
    await expect(inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, lines, fx.userId)))
      .rejects.toThrow(/whole cents/);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('posts a split whose lines sum to the line exactly, float noise and all (0.10 + 0.20 = 0.30)', async () => {
    const expense = await accountByCode('6000');
    const tx = await seedBankTx(fx, { date: '2026-10-05', amount: -0.3, description: 'split float noise' });
    const out = await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx,
      [{ contraAccountId: expense, amount: 0.1 }, { contraAccountId: expense, amount: 0.2 }], fx.userId));
    expect(await lineStatus(tx)).toBe('allocated');
    expect(await journalLines(out.journalEntryId)).toEqual(['1000:0.00/0.30:-', '6000:0.10/0.00:-', '6000:0.20/0.00:-']);
  }, 60000);

  // Round 2 (breaker, LOW): a zero or negative part reached the journal validator, whose generic Error is a 500.
  it.each([
    ['a zero line', [0, 5], 1], ['a negative line', [-1, 6], 1],
  ] as const)('refuses %s as a typed allocation refusal, before anything is written', async (_what, amounts, bad) => {
    const expense = await accountByCode('6000');
    const tx = await seedBankTx(fx, { date: '2026-10-05', amount: -5, description: `split ${amounts.join('/')}` });
    const before = await journalCount();
    const err = await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx,
      amounts.map((amount) => ({ contraAccountId: expense, amount })), fx.userId)).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err), String(err)).toBe(true);
    expect((err as Error).message).toBe(`Split line ${bad}: the amount must be more than zero. Nothing was posted.`);
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses an empty split as a typed allocation refusal (400), before anything is written', async () => {
    const tx = await seedBankTx(fx, { date: '2026-10-05', amount: -5, description: 'split no lines' });
    const before = await journalCount();
    const err = await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, [], fx.userId)).catch((e: unknown) => e);
    expect(isBankAllocationRefusal(err), String(err)).toBe(true);
    expect((err as Error).message).toBe('At least one split line is required');
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  // ── Row 13 ──────────────────────────────────────────────────────────────────
  it.each([
    ['account', 'STANDARD'], ['account', 'std'], ['account', ''], ['supplier', 'standrd'], ['customer', 'vat15'],
  ] as const)('refuses a %s allocation with VAT code "%s" before anything is written', async (allocType, code) => {
    const amount = allocType === 'customer' ? 115 : -115;
    const tx = await seedBankTx(fx, { date: '2026-10-06', amount, description: `vat ${allocType} ${code}` });
    const before = await journalCount();
    const contra = allocType === 'account' ? await accountByCode('6000') : null;
    const entity = allocType === 'supplier' ? fx.supplierId : allocType === 'customer' ? fx.customerId : undefined;
    await expect(inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId, undefined, allocType, entity, code)))
      .rejects.toThrow(new RegExp(`unknown VAT code "${code}" — use one of none, standard, zero_rated, exempt`));
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a split line with an unknown VAT code before anything is written', async () => {
    const expense = await accountByCode('6000');
    const tx = await seedBankTx(fx, { date: '2026-10-07', amount: -230, description: 'split bad vat' });
    const before = await journalCount();
    const lines: SplitLine[] = [
      { contraAccountId: expense, amount: 115, vatCode: 'standard' }, { contraAccountId: expense, amount: 115, vatCode: 'Standard' },
    ];
    await expect(inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, lines, fx.userId)))
      .rejects.toThrow(/unknown VAT code "Standard"/);
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('still posts every known code, and no code at all', async () => {
    const expense = await accountByCode('6000');
    const std = await seedBankTx(fx, { date: '2026-10-08', amount: -115, description: 'known standard' });
    const r1 = await inTx(fx, () => allocateTransaction(fx.companyId, std, expense, fx.userId, undefined, 'account', undefined, 'standard'));
    expect(await journalLines(r1.journalEntryId)).toEqual(['1000:0.00/115.00:-', '1140:15.00/0.00:standard', '6000:100.00/0.00:standard']);
    for (const code of ['zero_rated', 'exempt', 'none', undefined]) {
      const tx = await seedBankTx(fx, { date: '2026-10-08', amount: -50, description: `known ${String(code)}` });
      await inTx(fx, () => allocateTransaction(fx.companyId, tx, expense, fx.userId, undefined, 'account', undefined, code));
      expect(await lineStatus(tx), String(code)).toBe('allocated');
    }
  }, 60000);

  it('the rule sweep skips (counts) a rule carrying an unknown VAT code, and posts nothing for it', async () => {
    const expense = await accountByCode('6000');
    // A row no route would write now (bank-rules validates the code): straight INSERT, as a legacy row.
    await sql`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern, gl_account_id, auto_create_entry, vat_code, created_by)
              VALUES (${fx.companyId}::UUID, 'legacy bad-vat rule', 'description', 'contains', 'BADVATRULE', ${expense}::UUID, true, 'STD', ${fx.userId}::UUID)`;
    const tx = await seedBankTx(fx, { date: '2026-10-09', amount: -80, description: 'BADVATRULE debit' });
    const before = await journalCount();
    const result = await inTx(fx, () => applyRules(fx.companyId, fx.bankAccountId, fx.userId));
    expect(result).toMatchObject({ autoPostSkippedUnknownVatCode: 1 });
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${fx.companyId}::UUID`;
  }, 60000);
});
