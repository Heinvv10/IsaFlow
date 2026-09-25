/**
 * ADVERSARIAL round 4 — attacks on the R0.01-per-line tolerance. Red is a finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { NEXT, P, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
type L = { glAccountId: string; debit: number; credit: number; vatType?: string };
let fx: LateFixture;
let stationery = '';
const say = (s: string) => process.stdout.write(`${s}\n`);
const post = (date: string, lines: L[], optIn = true) => inTx(fx, async () => {
  const je = await createJournalEntry(fx.companyId,
    { entryDate: date, description: 'BREAK3', lines: lines.map((l) => ({ ...l, vatType: l.vatType as never })) },
    fx.userId, undefined, optIn ? { allowLateInputClaim: true } : undefined);
  return postJournalEntry(fx.companyId, je.id, fx.userId, optIn ? { allowLateInputClaim: true } : undefined);
});
const settle = <T>(p: Promise<T>) => p.then((r) => r, (e: unknown) => e as Error);
const report = () => inTx(fx, () => getVat201Report(fx.companyId, NEXT.start, NEXT.end, { detail: 'summary' }));
const bill = (tax: number): L[] => [
  { glAccountId: stationery, debit: 100, credit: 0, vatType: 'standard' },
  { glAccountId: fx.vatInputId, debit: tax, credit: 0, vatType: 'standard' },
  { glAccountId: fx.bankAccountId, debit: 0, credit: 100 + tax },
];

describeIfDb('late input VAT claim: adversarial round 4', () => {
  beforeAll(async () => {
    assertNotProductionDb('adversarial late-claim repros round 4');
    fx = await seedLateFixture('VB4', DATABASE_URL!);
    stationery = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '6100', ${`Stationery ${fx.tag}`}, 'expense', 'operating_expense', 'debit', true, false)
      RETURNING id`) as Row[])[0]!.id);
    await lockPeriod(fx, P.start, P.end);
  }, 180000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 180000);

  /** R100 base + `pairs` offsetting DR/CR R1 coded base lines (net base still R100) + VAT `tax`. */
  const padded = (pairs: number, tax: number): L[] => [
    { glAccountId: stationery, debit: 100, credit: 0, vatType: 'standard' },
    ...Array.from({ length: pairs }, (): L[] => [
      { glAccountId: stationery, debit: 1, credit: 0, vatType: 'standard' },
      { glAccountId: stationery, debit: 0, credit: 1, vatType: 'standard' },
    ]).flat(),
    { glAccountId: fx.vatInputId, debit: tax, credit: 0, vatType: 'standard' },
    { glAccountId: fx.bankAccountId, debit: 0, credit: 100 + tax },
  ];

  it('D2: offsetting base-line pairs inflate the allowance — R4 over-claimed on a R100 base, hidden late, visible on time', async () => {
    const r0 = await report();
    const late = await settle(post('2026-06-05', padded(200, 19)));
    const r1 = await report();
    await post('2026-07-05', padded(200, 19), false);
    const r2 = await report();
    const lateVar = r1.rateCheck.inputVariance - r0.rateCheck.inputVariance;
    const onTime = r2.rateCheck.inputVariance - r1.rateCheck.inputVariance;
    say(`D2 late=${late instanceof Error ? 'REFUSED' : 'SPLIT'} lateInputDelta=${(r1.totals.inputTax - r0.totals.inputTax).toFixed(2)} lateVar=${lateVar.toFixed(2)} ties=${r1.rateCheck.ties} | onTimeVar=${onTime.toFixed(2)} ties=${r2.rateCheck.ties}`);
    // R4 raw over-claim, less the R0.01 rounding allowance — ONE taxed
    // input-VAT line, never the 400 offsetting BASE-role padding lines
    // (item 3: only role 'tax' lines count toward the allowance).
    expect(onTime).toBeCloseTo(3.99, 2);
    if (late instanceof Error) expect(r1.totals.inputTax - r0.totals.inputTax).toBeCloseTo(0, 2);
    else expect(lateVar).toBeCloseTo(onTime, 2);
  });
});
