/**
 * The engine's VAT period book (P6 spec §5 step 11): each month's net VAT
 * (liability-positive) accrues to its period; a period settles once it has
 * ended — a payable the month after its end, a refund `refundLagMonths` after
 * it — never before the version's first month. The opening VAT control belongs
 * to the period containing the month before the start.
 */
import { monthOrdinal } from './months';
import { checkedAdd } from './ratios';
import type { VatSettlement } from './types';
import { vatPeriodOf, vatSettleMonth, type VatAlignment, type VatCadence } from './vatSchedule';

interface Period { start: string; end: string; net: number; settled: boolean; settleMonth: string | null }

export class VatBook {
  private readonly periods = new Map<string, Period>();

  constructor(
    private readonly cadence: VatCadence,
    private readonly alignment: VatAlignment,
    private readonly refundLagMonths: number,
    private readonly firstMonth: string,
  ) {}

  /** Add `net` (liability-positive cents) to the period `month` belongs to. */
  accrue(month: string, net: number): void {
    const ref = vatPeriodOf(month, this.cadence, this.alignment);
    const p = this.periods.get(ref.end) ?? { ...ref, net: 0, settled: false, settleMonth: null };
    p.net = checkedAdd(p.net, net);
    this.periods.set(ref.end, p);
  }

  /** The nets that settle in `month` (call once per month, after that month's accruals). */
  settle(month: string): number[] {
    const out: number[] = [];
    for (const p of this.periods.values()) {
      if (p.settled || monthOrdinal(p.end) > monthOrdinal(month)) continue;
      const due = vatSettleMonth(p, p.net, this.refundLagMonths);
      const settleMonth = monthOrdinal(due) < monthOrdinal(this.firstMonth) ? this.firstMonth : due;
      p.settleMonth = settleMonth;
      if (settleMonth !== month) continue;
      p.settled = true;
      if (p.net !== 0) out.push(p.net);
    }
    return out;
  }

  /** Every period with a non-zero net, in period order; unsettled ones stay on the balance sheet. */
  settlements(): VatSettlement[] {
    return [...this.periods.values()]
      .filter(p => p.net !== 0)
      .sort((a, b) => monthOrdinal(a.end) - monthOrdinal(b.end))
      .map(p => ({
        periodStart: p.start, periodEnd: p.end, net: p.net,
        settleMonth: p.settleMonth ?? vatSettleMonth(p, p.net, this.refundLagMonths), settled: p.settled,
      }));
  }
}
