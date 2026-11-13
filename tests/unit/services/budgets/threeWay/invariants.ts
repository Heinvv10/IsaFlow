/**
 * Invariants I1–I4 (spec §10), checked independently of the engine's own
 * arithmetic: the ledger is replayed from the opening and the postings.
 */
import { expect } from 'vitest';
import { BUCKET_KEYS, PNL_BANDS, type BucketKey, type EngineInput, type EngineOutput } from '@/modules/accounting/services/budgets/threeWay/types';

const OPERATING = ['cash_received_from_customers', 'cash_paid_to_suppliers', 'cash_paid_to_employees', 'other_operating'] as const;

export function assertInvariants(inp: EngineInput, out: EngineOutput, label = ''): void {
  // I4: every posting balances.
  for (const p of out.postings) {
    const sum = p.lines.reduce((s, l) => s + l.amount, 0);
    if (sum !== 0) expect.fail(`${label} I4 ${p.step} ${p.month} unbalanced by ${sum}`);
  }
  // Replay: closing buckets = opening + Σ postings (P&L lines close to retained earnings).
  const replay: Record<BucketKey, number> = { ...out.opening.buckets };
  let cash = out.opening.buckets.cash;
  out.months.forEach((m, i) => {
    for (const p of out.postings.filter(x => x.month === m.month)) {
      for (const l of p.lines) {
        const k = (l.account.startsWith('pnl.') ? 'retainedEarnings' : l.account) as BucketKey;
        replay[k] += l.amount;
      }
    }
    for (const k of BUCKET_KEYS) if (replay[k] !== m.closing[k]) expect.fail(`${label} replay ${m.month} ${k}: ${replay[k]} ≠ ${m.closing[k]}`);
    // I1: the balance sheet balances, to the cent.
    const sum = BUCKET_KEYS.reduce((s, k) => s + m.closing[k], 0);
    if (sum !== 0 || m.balanceSheet.check !== 0) expect.fail(`${label} I1 ${m.month} check ${m.balanceSheet.check} / Σ ${sum}`);
    const bs = m.balanceSheet;
    if (bs.totalAssets - bs.totalLiabilities - bs.equity !== 0) expect.fail(`${label} I1 sections ${m.month}`);
    // I2: opening cash + Σ net cash flow = closing cash.
    const direct = Object.values(m.cashFlow.direct).reduce((s, v) => s + v, 0);
    cash += m.cashFlow.net;
    if (direct !== m.cashFlow.net || cash !== m.closing.cash || m.cashFlow.closingCash !== m.closing.cash) {
      expect.fail(`${label} I2 ${m.month}: ${cash} vs ${m.closing.cash}`);
    }
    // I3: direct operating = indirect operating.
    const directOp = OPERATING.reduce((s, g) => s + m.cashFlow.direct[g], 0);
    const ind = m.cashFlow.indirect;
    const indSum = ind.netProfit + ind.depreciation + ind.receivables + ind.inventory + ind.payables
      + ind.payrollLiabilities + ind.vat + ind.incomeTax;
    if (directOp !== m.cashFlow.operating || indSum !== ind.operating || ind.operating !== directOp) {
      expect.fail(`${label} I3 ${m.month}: direct ${directOp} indirect ${ind.operating} (Σ ${indSum})`);
    }
    // NP is the P&L input's.
    const p = inp.pnl[i];
    if (p) {
      const np = p.turnover + p.otherIncome - PNL_BANDS.filter(b => b !== 'turnover' && b !== 'otherIncome').reduce((s, b) => s + p[b], 0);
      if (np !== m.pnl.netProfit || np !== ind.netProfit) expect.fail(`${label} NP ${m.month}`);
    }
  });
}
