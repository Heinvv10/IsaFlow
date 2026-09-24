/**
 * Changing WHICH account a posted line sits on, or WHAT that account is, can
 * move a filed VAT figure without posting anything: the VAT201 snapshot the
 * lock recorded classifies every line by its account's type and subtype
 * (reports/vatBoxBasis classifyVatJournalLine). Two paths do that:
 *
 *   - reclassifyAccount changes an account's subtype;
 *   - mergeAccounts repoints the source's lines onto the target.
 *
 * Each is refused, naming the period, only when a POSTED line dated inside an
 * ACTIVE lock would classify differently afterwards — judged by the snapshot's
 * own classifier. A change that moves no filed figure (two plain expense
 * accounts, untagged lines) is allowed inside the lock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { reclassifyAccount, ReclassifyError } from '@/modules/accounting/services/gl/accountReclassifyService';
import { mergeAccounts, AccountMergeError } from '@/modules/accounting/services/gl/accountMergeService';
import { previewAccountMerge } from '@/modules/accounting/services/gl/accountMergePreview';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;

async function addAccount(type: string, subtype: string | null, normal = 'debit'): Promise<string> {
  const code = `9${String(++seq).padStart(3, '0')}`;
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${code} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true)
    RETURNING id`) as Row[])[0]!.id);
}

/** A posted journal on `date`: DR `accountId` 40 (tagged or not), CR bank. */
async function postedLine(accountId: string, date: string, vatType: string | null = null): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`VLC-${++seq}-${fx.tag}`}, ${date}::DATE, 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${accountId}::UUID, 40, 0, 'dr', ${vatType}),
           (${fx.companyId}::UUID, ${je}::UUID, ${fx.bankAccountId}::UUID, 0, 40, 'bank', NULL)`;
  return je;
}

const subtypeOf = async (id: string) => ((await sql`
  SELECT account_subtype FROM gl_accounts WHERE id = ${id}::UUID`) as Row[])[0]!.account_subtype;

async function refused(p: Promise<unknown>, cls: new (...a: never[]) => Error): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  return (err as Error).message;
}

describeIfDb('reclassification and merge against a locked VAT period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test reclassifies and merges accounts.');
    fx = await seedFixture('VLC', DATABASE_URL!);
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-05-01', '2026-06-30', 0, 0, 0, '2026-06-30', ${fx.userId})`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM gl_account_merges WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  describe('reclassifyAccount', () => {
    it('refuses turning a VAT input account into an ordinary asset while it holds a locked line, naming the period', async () => {
      const vat = await addAccount('asset', 'vat_input');
      await postedLine(vat, '2026-06-10');
      const msg = await refused(inTx(fx, () => reclassifyAccount(fx.companyId, vat, { accountSubtype: 'other' as never })), ReclassifyError);
      expect(msg).toContain('2026-05-01 to 2026-06-30');
      expect(await subtypeOf(vat)).toBe('vat_input');
    });

    it('refuses moving a VAT-coded asset line off a capital-goods subtype (base → unmapped)', async () => {
      const acct = await addAccount('asset', 'fixed_asset');
      await postedLine(acct, '2026-06-11', 'capital_goods');
      await refused(inTx(fx, () => reclassifyAccount(fx.companyId, acct, { accountSubtype: 'other' as never })), ReclassifyError);
      expect(await subtypeOf(acct)).toBe('fixed_asset');
    });

    it('allows the same change when the lines are outside every lock', async () => {
      const acct = await addAccount('asset', 'fixed_asset');
      await postedLine(acct, '2026-07-11', 'capital_goods');
      await inTx(fx, () => reclassifyAccount(fx.companyId, acct, { accountSubtype: 'other' as never }));
      expect(await subtypeOf(acct)).toBe('other');
    });

    it('allows a change that moves no filed figure (untagged asset line) inside the lock', async () => {
      const acct = await addAccount('asset', 'fixed_asset');
      await postedLine(acct, '2026-06-12');
      await inTx(fx, () => reclassifyAccount(fx.companyId, acct, { accountSubtype: 'other' as never }));
      expect(await subtypeOf(acct)).toBe('other');
    });
  });

  /** M1: only journals the snapshot folds in can refuse. The Velocity paycards:
   *  an asset account with a NULL subtype, reclassified to `bank` so statements
   *  can be imported onto it. */
  describe('the paycard case (asset NULL subtype → bank)', () => {
    it('ALLOWS it when the only locked journal is an untagged salary payment (VAT-bearing under neither)', async () => {
      const card = await addAccount('asset', null as never);
      const salaries = await addAccount('expense', 'operating_expense');
      await postedLine(salaries, '2026-06-20');
      // The salary journal: DR salaries / CR bank, then a second one CR the card.
      const je = await postedLine(salaries, '2026-06-21');
      await sql`UPDATE gl_journal_lines SET gl_account_id = ${card}::UUID WHERE journal_entry_id = ${je}::UUID AND credit > 0`;
      await inTx(fx, () => reclassifyAccount(fx.companyId, card, { accountSubtype: 'bank' as never }));
      expect(await subtypeOf(card)).toBe('bank');
    });

    it('refuses it when a VAT-coded line sits on the card inside the lock', async () => {
      const card = await addAccount('asset', null as never);
      await postedLine(card, '2026-06-22', 'standard');
      const msg = await refused(inTx(fx, () => reclassifyAccount(fx.companyId, card, { accountSubtype: 'bank' as never })), ReclassifyError);
      expect(msg).toContain('2026-05-01 to 2026-06-30');
      expect(await subtypeOf(card)).toBeNull();
    });
  });

  describe('mergeAccounts', () => {
    it('ALLOWS merging two plain expense accounts with untagged lines inside the lock', async () => {
      const source = await addAccount('expense', 'operating_expense');
      const target = await addAccount('expense', 'operating_expense');
      await postedLine(source, '2026-06-10');
      const done = await inTx(fx, () => mergeAccounts(fx.companyId, source, target, fx.userId));
      expect(done.linesRepointed).toBe(1);
    });

    it('refuses a merge that moves a VAT-coded line from a capital-goods asset onto an ordinary one, preview and live', async () => {
      const source = await addAccount('asset', 'fixed_asset');
      const target = await addAccount('asset', 'other');
      const je = await postedLine(source, '2026-06-13', 'capital_goods');
      const pre = await inTx(fx, () => previewAccountMerge(fx.companyId, source, target)).then(() => null, (e: unknown) => e);
      expect(pre).toMatchObject({ code: 'source_lines_in_locked_vat_period' });
      expect((pre as Error).message).toContain('2026-05-01 to 2026-06-30');
      await refused(inTx(fx, () => mergeAccounts(fx.companyId, source, target, fx.userId)), AccountMergeError);
      const line = ((await sql`
        SELECT gl_account_id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID AND debit > 0`) as Row[])[0]!;
      expect(line.gl_account_id).toBe(source);
    });

    it('refuses a merge that would move a vat_input line (any guard — the reporting-class guard gets there first)', async () => {
      const source = await addAccount('asset', 'vat_input');
      const target = await addAccount('asset', 'other');
      await postedLine(source, '2026-06-14');
      await refused(inTx(fx, () => mergeAccounts(fx.companyId, source, target, fx.userId)), AccountMergeError);
    });
  });
});
