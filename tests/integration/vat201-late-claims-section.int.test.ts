/**
 * Wave 6 LC: the VAT201's late-claims section, against real PostgreSQL. Two tenants, each with a VAT period
 * (Sep-Oct 2026) LOCKED as the product locks one and bills dated in it approved late (s16(3)): tenant A's
 * second claim is then reversed, so its companion and the companion's reversal both sit in the claim period
 * (Nov-Dec 2026). The section lists each, with the original document and the filed period, and its total
 * is the late part of the input-tax box exactly (getVat201Report's lateClaimInputTax). Ten times the
 * fixture's usual amounts, in a later window than the other late-claim suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { getVat201LateClaims } from '@/modules/accounting/services/reports/vat201LateClaims';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;

const FILED = { start: '2026-09-01', end: '2026-10-31' } as const;
const CLAIM = { start: '2026-11-01', end: '2026-12-31' } as const;

let a: LateFixture;
let b: LateFixture;
let n = 0;

async function bill(fx: LateFixture, date: string, unitPrice: number) {
  const number = `LCS-${++n}-${fx.tag}`.slice(0, 50);
  const draft = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: fx.supplierId, invoiceNumber: number, invoiceDate: date,
    items: [{ description: 'Consulting', quantity: 1, unitPrice, taxRate: 15, glAccountId: fx.expenseId }],
  }, fx.userId));
  return { id: draft.id, number };
}

async function lateBill(fx: LateFixture, date: string, unitPrice: number) {
  const d = await bill(fx, date, unitPrice);
  const approved = await inTx(fx, () => approveSupplierInvoice(fx.companyId, d.id, fx.userId, { allowLateInputClaim: true }));
  expect(approved.lateClaim?.claimDate).toBe(CLAIM.start);
  const [r] = (await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${d.id}::UUID`) as Row[];
  return { ...d, originalId: String(r!.gl_journal_entry_id), companionId: approved.lateClaim!.companionEntryId };
}

const section = (fx: LateFixture, p: { start: string; end: string }) => inTx(fx, () => getVat201LateClaims(fx.companyId, p.start, p.end));
const report = (fx: LateFixture, p: { start: string; end: string }) => inTx(fx, () => getVat201Report(fx.companyId, p.start, p.end, { detail: 'summary' }));

let a1: Awaited<ReturnType<typeof lateBill>>;
let a2: Awaited<ReturnType<typeof lateBill>>;
let b1: Awaited<ReturnType<typeof lateBill>>;

describeIfDb('VAT201 late-claims section (wave 6 LC)', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    a = await seedLateFixture('LCA', DATABASE_URL!);
    b = await seedLateFixture('LCB', DATABASE_URL!);
    for (const fx of [a, b]) {
      // On time: one bill filed in the locked period, one in the claim period.
      for (const date of ['2026-09-15', '2026-11-20']) {
        const d = await bill(fx, date, 10000);
        await inTx(fx, () => approveSupplierInvoice(fx.companyId, d.id, fx.userId));
      }
      await lockPeriod(fx, FILED.start, FILED.end);
    }
    a1 = await lateBill(a, '2026-10-12', 10000);
    a2 = await lateBill(a, '2026-10-20', 20000);
    // Reversing the original reverses its companion with it, on the companion's own (open) date.
    await inTx(a, () => reverseJournalEntry(a.companyId, a2.originalId, a.userId));
    b1 = await lateBill(b, '2026-10-05', 40000);
  }, 240000);

  afterAll(async () => {
    for (const fx of [a, b]) if (fx) await dropLateFixture(fx);
  }, 120000);

  it('tenant A: both claims and the reversal are listed, and they net to the box\'s late part', async () => {
    const s = await section(a, CLAIM);
    const byVat = [...s.rows].sort((x, y) => x.vat - y.vat);
    expect(byVat.map((r) => [r.kind, r.vat, r.claimDate])).toEqual([
      ['reversal', -3000, CLAIM.start], ['claim', 1500, CLAIM.start], ['claim', 3000, CLAIM.start],
    ]);
    const [rev] = (await sql`
      SELECT id::TEXT AS id FROM gl_journal_entries
      WHERE company_id = ${a.companyId}::UUID AND reversal_of_id = ${a2.companionId}::UUID AND status = 'posted'`) as Row[];
    expect(byVat[0]!.journalEntryId).toBe(String(rev!.id));
    expect(byVat[2]!.journalEntryId).toBe(a2.companionId);
    expect(s.total).toBe(1500);

    const r = await report(a, CLAIM);
    expect(r.totals.lateClaimInputTax).toBe(1500);
    expect(s.lateClaimInputTax).toBe(r.totals.lateClaimInputTax);
    expect(r.boxes.find((x) => x.box === '15')?.lateClaimTax).toBe(1500);
  });

  it('each row names its original document, the date it was dated and the filed period', async () => {
    const s = await section(a, CLAIM);
    const one = s.rows.find((r) => r.journalEntryId === a1.companionId)!;
    expect(one.original).toMatchObject({ journalEntryId: a1.originalId, entryDate: '2026-10-12' });
    expect(one.document?.invoiceNumber).toBe(a1.number);
    expect(one.filedPeriod).toEqual(FILED);
    expect(one.boxes).toEqual(['15']);
    // The reversal leads back to the same original as the claim it reverses.
    const rev = s.rows.find((r) => r.kind === 'reversal')!;
    expect(rev.original?.journalEntryId).toBe(a2.originalId);
    expect(rev.document?.invoiceNumber).toBe(a2.number);
  });

  it('tenant B sees only its own claim; neither sees the other\'s', async () => {
    const s = await section(b, CLAIM);
    expect(s.rows.map((r) => [r.journalEntryId, r.vat])).toEqual([[b1.companionId, 6000]]);
    expect(s.total).toBe(6000);
    expect((await report(b, CLAIM)).totals.lateClaimInputTax).toBe(6000);
    const aIds = new Set((await section(a, CLAIM)).rows.map((r) => r.journalEntryId));
    expect(aIds.has(b1.companionId)).toBe(false);
  });

  it('the filed period itself has no late claims: the originals are in it, the claims are not', async () => {
    for (const fx of [a, b]) {
      const s = await section(fx, FILED);
      expect(s.rows).toEqual([]);
      expect(s.total).toBe(0);
      expect((await report(fx, FILED)).totals.lateClaimInputTax).toBe(0);
    }
  });
});
