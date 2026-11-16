/**
 * Wave 6 LC, from the round-1 ledger-breaker probe (PR 1481): a late claim whose reversal is ROLLED into a later VAT
 * period because the claim period was locked (filed) too. The claim period keeps the claim; the later period lists
 * the reversal, and that row names the claim it reverses, the claim's date and the return the claim was filed in, so
 * the reviewer can tell which return the reversed claim sat in. Both periods tie to their boxes' late part.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { getVat201LateClaims } from '@/modules/accounting/services/reports/vat201LateClaims';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const FILED = { start: '2026-05-01', end: '2026-06-30' } as const;
const CLAIM = { start: '2026-07-01', end: '2026-08-31' } as const;
const LATER = { start: '2026-09-01', end: '2026-10-31' } as const;
let a: LateFixture;
let companionId = '';
let companionNumber = '';
let originalId = '';

describeIfDb('VAT201 late claims: a reversal rolled past a filed claim period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    a = await seedLateFixture('LCX', DATABASE_URL!);
    await lockPeriod(a, FILED.start, FILED.end);
    const d = await inTx(a, () => createSupplierInvoice(a.companyId, {
      supplierId: a.supplierId, invoiceNumber: `LCX-${a.tag}`.slice(0, 50), invoiceDate: '2026-06-12',
      items: [{ description: 'x', quantity: 1, unitPrice: 10000, taxRate: 15, glAccountId: a.expenseId }],
    }, a.userId));
    const approved = await inTx(a, () => approveSupplierInvoice(a.companyId, d.id, a.userId, { allowLateInputClaim: true }));
    companionId = approved.lateClaim!.companionEntryId;
    companionNumber = approved.lateClaim!.companionEntryNumber;
    await lockPeriod(a, CLAIM.start, CLAIM.end);
    const [r] = (await sql`SELECT gl_journal_entry_id::TEXT AS g FROM supplier_invoices WHERE id = ${d.id}::UUID`) as Record<string, unknown>[];
    originalId = String(r!.g);
    await inTx(a, () => reverseJournalEntry(a.companyId, originalId, a.userId));
  }, 240000);
  afterAll(async () => { if (a) await dropLateFixture(a); }, 120000);

  it('the claim period keeps the claim; the later period has the reversal; both tie', async () => {
    const claim = await inTx(a, () => getVat201LateClaims(a.companyId, CLAIM.start, CLAIM.end));
    const later = await inTx(a, () => getVat201LateClaims(a.companyId, LATER.start, LATER.end));
    const rep = await inTx(a, () => getVat201Report(a.companyId, LATER.start, LATER.end, { detail: 'summary' }));
    expect(claim.rows.map((x) => [x.kind, x.vat, x.claimDate])).toEqual([['claim', 1500, CLAIM.start]]);
    expect(claim.rows[0]!.reverses).toBeNull();
    expect(claim.total).toBe(1500);
    expect(later.total).toBe(-1500);
    expect(rep.totals.lateClaimInputTax).toBe(-1500);
  });

  it('the reversal row names the reversed claim, its date and the return it was filed in', async () => {
    const later = await inTx(a, () => getVat201LateClaims(a.companyId, LATER.start, LATER.end));
    expect(later.rows).toHaveLength(1);
    const rev = later.rows[0]!;
    expect(rev.kind).toBe('reversal');
    expect(rev.claimDate >= LATER.start && rev.claimDate <= LATER.end).toBe(true);
    expect(rev.reverses).toEqual({ journalEntryId: companionId, entryNumber: companionNumber, claimDate: CLAIM.start, filedIn: CLAIM });
    // The document's own filed period is still the bill's.
    expect(rev.filedPeriod).toEqual(FILED);
    expect(rev.original).toMatchObject({ journalEntryId: originalId, entryDate: '2026-06-12' });
  });
});
