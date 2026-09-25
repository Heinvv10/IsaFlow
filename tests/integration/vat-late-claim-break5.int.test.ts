/**
 * ADVERSARIAL round 5 — the stored late_claim_base: late must equal on time. Red is a finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
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

type Rep = Awaited<ReturnType<typeof report>>;
const boxDelta = (a: Rep, b: Rep) => {
  const keys = new Set([...a.boxes, ...b.boxes].map((x) => `${x.direction}:${x.vatType}`));
  const out: Record<string, { base: number; tax: number }> = {};
  for (const k of keys) {
    const x = a.boxes.find((y) => `${y.direction}:${y.vatType}` === k);
    const y = b.boxes.find((z) => `${z.direction}:${z.vatType}` === k);
    const d = { base: Math.round(((y?.base ?? 0) - (x?.base ?? 0)) * 100) / 100, tax: Math.round(((y?.tax ?? 0) - (x?.tax ?? 0)) * 100) / 100 };
    if (d.base !== 0 || d.tax !== 0) out[k] = d;
  }
  return out;
};
let equipment = '';

describeIfDb('late input VAT claim: adversarial round 5', () => {
  beforeAll(async () => {
    assertNotProductionDb('adversarial late-claim repros round 5');
    fx = await seedLateFixture('VB5', DATABASE_URL!);
    const mk = async (code: string, name: string) => String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, 'expense', 'operating_expense', 'debit', true, false)
      RETURNING id`) as Row[])[0]!.id);
    stationery = await mk('6100', 'Stationery');
    equipment = await mk('6200', 'Small equipment');
    await lockPeriod(fx, P.start, P.end);
  }, 180000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 180000);

  const shapes: Record<string, () => L[]> = {
    billUncoded: () => [
      { glAccountId: stationery, debit: 1000, credit: 0 },
      { glAccountId: fx.vatInputId, debit: 150, credit: 0, vatType: 'standard' },
      { glAccountId: fx.apId, debit: 0, credit: 1150 },
    ],
    twoCodes: () => [
      { glAccountId: stationery, debit: 1000, credit: 0, vatType: 'standard' },
      { glAccountId: equipment, debit: 2000, credit: 0, vatType: 'capital_goods' },
      { glAccountId: fx.vatInputId, debit: 150, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 300, credit: 0, vatType: 'capital_goods' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 3450 },
    ],
    twinTaxLinesOddBase: () => [
      { glAccountId: stationery, debit: 333.33, credit: 0, vatType: 'standard' },
      { glAccountId: stationery, debit: 0.01, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 25, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 25, credit: 0, vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 383.34 },
    ],
    overClaim99: () => [
      { glAccountId: stationery, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15.99, credit: 0, vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 115.99 },
    ],
    bigUntaggedBase: () => [
      { glAccountId: stationery, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: equipment, debit: 5000, credit: 0 },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 5115 },
    ],
  };

  for (const [name, lines] of Object.entries(shapes)) {
    it(`E-parity ${name}: the claim period sees the late claim exactly as it sees the on-time twin`, async () => {
      const r0 = await report();
      const late = await settle(post('2026-06-15', lines()));
      const r1 = await report();
      await post('2026-07-15', lines(), false);
      const r2 = await report();
      const dl = boxDelta(r0, r1); const dt = boxDelta(r1, r2);
      say(`E ${name} late=${late instanceof Error ? 'REFUSED' : 'SPLIT'} lateDelta=${JSON.stringify(dl)} onTimeDelta=${JSON.stringify(dt)} lateVar=${(r1.rateCheck.inputVariance - r0.rateCheck.inputVariance).toFixed(2)} onTimeVar=${(r2.rateCheck.inputVariance - r1.rateCheck.inputVariance).toFixed(2)} wob=${r1.rateCheck.entriesWithoutBaseTotal - r0.rateCheck.entriesWithoutBaseTotal}/${r2.rateCheck.entriesWithoutBaseTotal - r1.rateCheck.entriesWithoutBaseTotal}`);
      if (late instanceof Error) expect(r1.totals.inputTax).toBe(r0.totals.inputTax);
      else {
        expect(dl).toEqual(dt);
        expect(r1.rateCheck.entriesWithoutBaseTotal).toBe(r0.rateCheck.entriesWithoutBaseTotal);
      }
    });
  }

  it('E-rev: reversing a late original (companion reversed in a later filed-past period) nets base and tax to zero everywhere', async () => {
    const r0 = await report();
    const out = await post('2026-06-16', shapes.twoCodes!()) as { id: string };
    await lockPeriod(fx, NEXT.start, NEXT.end);
    const after = { start: '2026-09-01', end: '2026-10-31' };
    const rep3 = () => inTx(fx, () => getVat201Report(fx.companyId, after.start, after.end, { detail: 'summary' }));
    const a0 = await rep3();
    try {
      await inTx(fx, () => reverseJournalEntry(fx.companyId, out.id, fx.userId));
      const a1 = await rep3();
      const r1 = await report();
      say(`E-rev claimPeriodDelta(NEXT, locked)=${JSON.stringify(boxDelta(r0, r1))} reversalPeriodDelta=${JSON.stringify(boxDelta(a0, a1))} revVar=${(a1.rateCheck.inputVariance - a0.rateCheck.inputVariance).toFixed(2)} wob=${a1.rateCheck.entriesWithoutBaseTotal - a0.rateCheck.entriesWithoutBaseTotal}`);
      expect(boxDelta(a0, a1)).toEqual({
        'input:capital_goods': { base: -2000, tax: -300 }, 'input:standard': { base: -1000, tax: -150 },
      });
      expect(a1.rateCheck.entriesWithoutBaseTotal).toBe(a0.rateCheck.entriesWithoutBaseTotal);
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID AND period_start = ${NEXT.start}::DATE`;
    }
  });

  it('E-col: late_claim_base cannot be supplied through createJournalEntry (a line field is ignored)', async () => {
    const out = await post('2026-07-20', [
      { glAccountId: stationery, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard', lateClaimBase: 99999 } as never,
      { glAccountId: fx.bankAccountId, debit: 0, credit: 115 },
    ], false) as { id: string };
    const [r] = (await sql`SELECT COUNT(*)::INT AS n FROM gl_journal_lines WHERE journal_entry_id = ${out.id}::UUID AND late_claim_base IS NOT NULL`) as Row[];
    say(`E-col linesWithBase=${r!.n}`);
    expect(r!.n).toBe(0);
  });
});
