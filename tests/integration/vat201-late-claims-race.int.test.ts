/**
 * Wave 6 LC, from the round-1 ledger-breaker repro (PR 1481): a late claim committed by another session right after
 * getVatPeriodLines read the box snapshot. Under READ COMMITTED each statement has its own snapshot, so rows read by
 * a second query once included the new claim and the box did not, and the section threw on a correct ledger. The
 * rows now come from the same snapshot as the box; the metadata query is keyed by the snapshot's journal ids.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hook: { fn: null | (() => Promise<void>) } = { fn: null };
vi.mock('@/modules/accounting/services/reports/vatBoxBasisQuery', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/reports/vatBoxBasisQuery')>();
  return {
    ...real,
    getVatPeriodLines: async (...args: Parameters<typeof real.getVatPeriodLines>) => {
      const out = await real.getVatPeriodLines(...args);
      const f = hook.fn; hook.fn = null;
      if (f) await f(); // another session commits here
      return out;
    },
  };
});

import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { getVat201LateClaims } from '@/modules/accounting/services/reports/vat201LateClaims';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let a: LateFixture;
let n = 0;

async function lateBill(fx: LateFixture, date: string, unitPrice: number) {
  const number = `LCR-${++n}-${fx.tag}`.slice(0, 50);
  const draft = await inTx(fx, () => createSupplierInvoice(fx.companyId, {
    supplierId: fx.supplierId, invoiceNumber: number, invoiceDate: date,
    items: [{ description: 'Consulting', quantity: 1, unitPrice, taxRate: 15, glAccountId: fx.expenseId }],
  }, fx.userId));
  return inTx(fx, () => approveSupplierInvoice(fx.companyId, draft.id, fx.userId, { allowLateInputClaim: true }));
}

describeIfDb('VAT201 late claims: one snapshot for the box and the rows', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    a = await seedLateFixture('LCR', DATABASE_URL!);
    await lockPeriod(a, '2026-09-01', '2026-10-31');
    await lateBill(a, '2026-10-12', 10000);
  }, 240000);
  afterAll(async () => { if (a) await dropLateFixture(a); }, 120000);

  it('a late claim committed mid-request does not make a valid ledger throw', async () => {
    hook.fn = async () => { await lateBill(a, '2026-10-20', 20000); };
    const s = await inTx(a, () => getVat201LateClaims(a.companyId, '2026-11-01', '2026-12-31'));
    expect(s.total).toBe(s.lateClaimInputTax);
    // The request saw the ledger as it was when the box was read: the first claim only.
    expect(s.rows.map((r) => r.vat)).toEqual([1500]);
    // Read again, both claims are in both.
    const again = await inTx(a, () => getVat201LateClaims(a.companyId, '2026-11-01', '2026-12-31'));
    expect([again.total, again.lateClaimInputTax, again.rows.length]).toEqual([4500, 4500, 2]);
    const [c] = (await sql`SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id=${a.companyId}::UUID AND source='auto_vat_late_claim'`) as Record<string, unknown>[];
    expect(Number(c!.n)).toBe(2);
  });
});
