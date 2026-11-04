/**
 * Budgets P5-2b round 7: 9ae68871a split `buildExpenseLines` into the pure `expenseLineNets` (shared with the
 * slip-dimension matcher) and the line builder. This pins that the refactor is behaviour-identical for every existing
 * caller: the ORACLE below is the pre-refactor `buildExpenseLines` (56405f167) verbatim, and the new one must give the
 * same journal lines (account, debit, dims, order; the per-line rounding, the residual on the last line, the
 * rounding-overshoot fold into the largest line, R0.00 lines dropped) on awkward splits and on 2 000 seeded random bills.
 */
import { describe, expect, it } from 'vitest';
import { buildExpenseLines } from '@/modules/accounting/services/ap/supplierInvoiceExpenseLines';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

/** The pre-refactor implementation (56405f167), verbatim. */
function oracle(invoice: SupplierInvoice, defaultGlAccountId: string): JournalLineInput[] {
  const items = invoice.items ?? [];
  const sumLineTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const lineTotalsAreGross = invoice.taxRate > 0 && Math.abs(sumLineTotal - invoice.totalAmount) < 0.02;
  const netTotal = invoice.subtotal;
  const lines: JournalLineInput[] = [];
  let allocatedNet = 0;
  const itemCount = items.length;
  items.forEach((item, idx) => {
    const glAccountId = item.glAccountId || defaultGlAccountId;
    let debit: number;
    if (idx === itemCount - 1) debit = Math.round((netTotal - allocatedNet) * 100) / 100;
    else if (lineTotalsAreGross && sumLineTotal > 0) debit = Math.round(item.lineTotal * (netTotal / sumLineTotal) * 100) / 100;
    else debit = Math.round(item.lineTotal * 100) / 100;
    allocatedNet += debit;
    lines.push({
      glAccountId, debit, credit: 0, description: item.description,
      projectId: item.projectId || invoice.projectId,
      costCenterId: item.costCenterId || invoice.costCenterId,
      ...(item.cc1Id ? { cc1Id: item.cc1Id } : {}), ...(item.cc2Id ? { cc2Id: item.cc2Id } : {}), ...(item.buId ? { buId: item.buId } : {}),
    });
  });
  const lastItem = items[itemCount - 1];
  const residualIsRounding = lineTotalsAreGross && lastItem !== undefined && lastItem.lineTotal >= 0;
  const last = lines[lines.length - 1];
  const roundingTolerance = lines.length * 0.01;
  if (residualIsRounding && last && last.debit < 0 && -last.debit <= roundingTolerance + 1e-9) {
    let largest = -1;
    for (let i = 0; i < lines.length - 1; i++) if (largest === -1 || lines[i]!.debit >= lines[largest]!.debit) largest = i;
    if (largest !== -1) {
      const target = lines[largest]!;
      target.debit = Math.round((target.debit + last.debit) * 100) / 100;
      last.debit = 0;
    }
  }
  return lines.filter((l) => l.debit !== 0);
}

const item = (lineTotal: number, i: number, o: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem => ({
  id: `i${i}`, supplierInvoiceId: 'b', description: `line ${i}`, quantity: 1, unitPrice: lineTotal, taxRate: 15, taxAmount: 0,
  lineTotal, glAccountId: i % 3 === 0 ? undefined : `acc${i % 4}`, createdAt: '', ...(i % 2 ? { cc1Id: `cc${i}` } : {}), ...o,
});
const bill = (totals: number[], header: Partial<SupplierInvoice>): SupplierInvoice => ({
  id: 'b', taxRate: 15, items: totals.map((t, i) => item(t, i)), projectId: 'proj', costCenterId: undefined, ...header,
} as SupplierInvoice);
const same = (b: SupplierInvoice) => expect(buildExpenseLines(b, 'defexp')).toEqual(oracle(b, 'defexp'));

describe('buildExpenseLines after the expenseLineNets refactor = before', () => {
  it('awkward splits: gross thirds, a negative overshoot folded, a R0 last line, a discount line, net storage', () => {
    same(bill([100, 100, 100], { subtotal: 260.87, totalAmount: 300 })); // gross: 86.96 ×2, residual 86.95
    same(bill([33.33, 33.33, 33.34], { subtotal: 86.96, totalAmount: 100 })); // gross, rounding overshoot on the last
    same(bill([0.01, 0.01, 0.01, 0], { subtotal: 0.03, totalAmount: 0.03, taxRate: 0 })); // a R0.00 last line dropped
    same(bill([500, -50], { subtotal: 450, totalAmount: 517.5 })); // a real discount line, net storage
    same(bill([345, 257.3], { subtotal: 523.74, totalAmount: 602.3 })); // gross, nets 300.00 / 223.74
    same(bill([800], { subtotal: 800, totalAmount: 920 })); // net, one line
    // gross with a R0 last item: its residual is -0.01, folded into the LARGEST line (37.82 → 37.81), the R0 line dropped
    const folded = bill([43.49, 27.46, 1.49, 0], { subtotal: 62.99, totalAmount: 72.44 });
    same(folded);
    expect(buildExpenseLines(folded, 'defexp').map((l) => l.debit)).toEqual([37.81, 23.88, 1.3]);
    same(bill([], { subtotal: 0, totalAmount: 0 })); // no items
  });
  it('2 000 seeded random bills (gross and net storage, 1-7 lines)', () => {
    let seed = 20261104;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 2000; n += 1) {
      const count = 1 + Math.floor(rnd() * 7);
      const totals = Array.from({ length: count }, () => Math.round((rnd() * 2000 - (rnd() < 0.1 ? 1000 : 0)) * 100) / 100);
      const sum = totals.reduce((s, t) => s + t, 0);
      const gross = rnd() < 0.5;
      const subtotal = Math.round((gross ? sum / 1.15 : sum) * 100) / 100;
      same(bill(totals, { subtotal, totalAmount: Math.round((gross ? sum : sum * 1.15) * 100) / 100, taxRate: rnd() < 0.1 ? 0 : 15 }));
    }
  });
});
