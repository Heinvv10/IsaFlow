/**
 * ADVERSARIAL round 3 — attacks on the round-2 fixes. Red is a finding.
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

describeIfDb('late input VAT claim: adversarial round 3', () => {
  beforeAll(async () => {
    assertNotProductionDb('adversarial late-claim repros round 3');
    fx = await seedLateFixture('VB3', DATABASE_URL!);
    stationery = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '6100', ${`Stationery ${fx.tag}`}, 'expense', 'operating_expense', 'debit', true, false)
      RETURNING id`) as Row[])[0]!.id);
    await lockPeriod(fx, P.start, P.end);
  }, 180000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 180000);

  // The per-journal check is a COARSE early refusal at the VAT201's R1 (gl/vatLateClaimRules); the real
  // control is the claim period's 15% check, which counts the claim's base (late_claim_base).
  it('D0: early-refusal edge — R1.00 over is claimed (and shows in the claim period), R1.01 over is refused', async () => {
    const r0 = await report();
    const a = await settle(post('2026-06-01', bill(16.00)));
    const r1 = await report();
    const b = await settle(post('2026-06-01', bill(16.01)));
    say(`D0 R1.00=${a instanceof Error ? 'REFUSED' : 'SPLIT'} R1.01=${b instanceof Error ? 'REFUSED' : 'SPLIT'}`);
    expect(a).not.toBeInstanceOf(Error);
    expect(r1.rateCheck.inputVariance - r0.rateCheck.inputVariance).toBeCloseTo(1, 2);
    expect(b).toBeInstanceOf(Error);
  });

  it('D1: three late claims each R0.99 over 15% sum to R2.97 the claim period never sees; on time the same three break the check', async () => {
    const r0 = await report();
    const lateResults: unknown[] = [];
    for (let i = 0; i < 3; i++) lateResults.push(await settle(post('2026-06-05', bill(15.99))));
    const r1 = await report();
    for (let i = 0; i < 3; i++) await post('2026-07-05', bill(15.99), false);
    const r2 = await report();
    const late = r1.rateCheck.inputVariance - r0.rateCheck.inputVariance;
    const onTime = r2.rateCheck.inputVariance - r1.rateCheck.inputVariance;
    say(`D1 lateInputDelta=${(r1.totals.inputTax - r0.totals.inputTax).toFixed(2)} lateVar=${late.toFixed(2)} ties=${r1.rateCheck.ties} | onTimeVar=${onTime.toFixed(2)} ties=${r2.rateCheck.ties}`);
    expect(onTime).toBeCloseTo(2.97, 2);
    // Correct: each over-claim is refused (nothing claimed, nothing hidden) — or, if claimed, it shows.
    const claimed = lateResults.filter((r) => !(r instanceof Error)).length;
    say(`D1 lateClaimed=${claimed}`);
    if (claimed === 0) expect(r1.totals.inputTax - r0.totals.inputTax).toBeCloseTo(0, 2);
    else expect(late).toBeCloseTo(onTime, 2);
  });
});
