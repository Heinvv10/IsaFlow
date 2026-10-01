/**
 * Item 8: `exportVat201`'s `blockingExceptions` field had no test at all.
 *
 * It carries `getVatExceptions`' blocking counts through the export so a
 * filer sees them beside the figures — WARNING ONLY, per its own doc-comment:
 * unlike ISV filing and lock/mark-submitted, the export itself never refuses
 * on their account. This pins:
 *   - the right PERIOD is read (a period with no exceptions exports zero
 *     counts even though another period on the same company has some);
 *   - the COUNTS match a direct `getVatExceptions` call for the same period
 *     (no drift between the two call sites);
 *   - the export never refuses/throws even with blocking exceptions present.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportVat201 } from '@/modules/accounting/services/reports/vat201ExportService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { vatGateExceptionCounts } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: LateFixture;

const CLEAN = { start: '2029-01-01', end: '2029-02-28' } as const;
const DIRTY = { start: '2029-03-01', end: '2029-04-30' } as const;

describeIfDb('exportVat201.blockingExceptions', () => {
  beforeAll(async () => {
    assertNotProductionDb('r-vatgaps-8');
    fx = await seedLateFixture('RVG8', DATABASE_URL!);

    // An unsupported input-VAT claim (no document, no bill, no bank line) in
    // the DIRTY period — a plain manual journal debiting VAT Input. Listed,
    // but NOT blocking on its own (Hein, 2026-09-26).
    const je = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2029-03-15', description: 'r-vatgaps-8 unsupported claim', source: 'manual',
      lines: [
        { glAccountId: fx.vatInputId, debit: 200, credit: 0, description: 'unsupported', vatType: 'standard' as const },
        { glAccountId: fx.expenseId, debit: 0, credit: 200, description: 'unsupported' },
      ],
    }, fx.userId));
    await inTx(fx, () => postJournalEntry(fx.companyId, je.id, fx.userId));

    // A genuinely blocking exception in the same DIRTY period — an uncoded
    // VAT-input GL line — so this test still exercises a non-zero
    // totalExceptions after the above stopped counting toward it.
    const uncodedJe = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2029-03-16', description: 'r-vatgaps-8 uncoded line', source: 'manual',
      lines: [
        { glAccountId: fx.vatInputId, debit: 50, credit: 0, description: 'uncoded' },
        { glAccountId: fx.expenseId, debit: 0, credit: 50, description: 'uncoded' },
      ],
    }, fx.userId));
    await inTx(fx, () => postJournalEntry(fx.companyId, uncodedJe.id, fx.userId));
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await dropLateFixture(fx);
  }, 120000);

  it('a clean period exports zero blocking exceptions', async () => {
    const out = await inTx(fx, () => exportVat201(fx.companyId, CLEAN.start, CLEAN.end));
    expect(out.blockingExceptions.totalExceptions).toBe(0);
    expect(out.blockingExceptions.unsupportedInputVatCount).toBe(0);
  });

  it('the DIRTY period carries the same counts exportVat201 and getVatExceptions agree on, and still exports', async () => {
    const direct = await inTx(fx, () => getVatExceptions(fx.companyId, DIRTY.start, DIRTY.end));
    const expected = vatGateExceptionCounts(direct);
    // The uncoded GL line still blocks. The bare (no_document) unsupported
    // claim is listed under inputVatWithoutTaxInvoice, not unsupportedInputVat
    // — it means only a record is missing, not that the figures are wrong
    // (Hein, 2026-09-26), so it does not contribute to totalExceptions.
    expect(expected.uncodedGlLineCount).toBeGreaterThan(0);
    expect(expected.totalExceptions).toBeGreaterThan(0);
    expect(direct.inputVatWithoutTaxInvoiceCount).toBeGreaterThan(0);

    const out = await inTx(fx, () => exportVat201(fx.companyId, DIRTY.start, DIRTY.end));

    expect(out.blockingExceptions).toEqual(expected);
    // WARNING ONLY — the export must still produce a payload, never refuse.
    expect(out.payload).toBeTruthy();
  });

  it('csv format also carries the same blockingExceptions, never refusing', async () => {
    const out = await inTx(fx, () => exportVat201(fx.companyId, DIRTY.start, DIRTY.end, 'csv'));
    expect(out.blockingExceptions.totalExceptions).toBeGreaterThan(0);
    expect(out.csv).toBeTruthy();
  });
});
