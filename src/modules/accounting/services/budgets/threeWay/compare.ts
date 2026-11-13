/**
 * Compare 1–3 engine outputs of the same company and fiscal year (P6 spec §7
 * compare route, §13.22). Pure.
 *
 * Per version: closing cash per month and its Δ vs the first version, and KPIs
 * (closing cash, minimum cash, FY net profit, closing receivables, closing
 * payables, net debt = loans − cash at the year end). Δ = version − first
 * (the movement, contract variance sign); Δ% = Δ / |first| × 100, null ("—")
 * when the first is 0; `favourable` is separate and only colours (via
 * `ibcs.varianceColor`; null when Δ = 0): cash, minimum cash and NP higher = favourable;
 * receivables, payables and net debt lower = favourable.
 */
import { CompareInputError } from './errors';
import { netProfit } from './cashFlow';
import type { EngineOutput } from './types';

export const MAX_COMPARE_VERSIONS = 3;

export interface CompareEntry {
  versionId: string;
  name: string;
  output: EngineOutput;
}

export interface KpiDelta {
  value: number;
  delta: number;
  deltaPct: number | null;
  /** null when Δ = 0 (nothing to colour). */
  favourable: boolean | null;
}

export const KPI_NAMES = ['closingCash', 'minCash', 'netProfit', 'closingReceivables', 'closingPayables', 'netDebt'] as const;
export type KpiName = typeof KPI_NAMES[number];

/** Which direction is good news per KPI. */
const HIGHER_IS_FAVOURABLE: Record<KpiName, boolean> = {
  closingCash: true, minCash: true, netProfit: true,
  closingReceivables: false, closingPayables: false, netDebt: false,
};

export interface CompareVersion {
  versionId: string;
  name: string;
  cashSeries: number[];
  cashDelta: number[];
  minCashMonth: string;
  kpis: Record<KpiName, KpiDelta>;
}

export interface CompareResult {
  months: string[];
  versions: CompareVersion[];
}

function kpiValues(o: EngineOutput): Record<KpiName, number> {
  const last = o.months[o.months.length - 1];
  const close = last?.closing;
  return {
    closingCash: close?.cash ?? 0,
    minCash: o.runway.minCash,
    netProfit: o.months.reduce((s, m) => s + netProfit(m.pnl), 0),
    closingReceivables: close?.receivables ?? 0,
    closingPayables: close ? -close.payables : 0,
    netDebt: close ? -close.loans - close.cash : 0,
  };
}

function delta(name: KpiName, value: number, first: number): KpiDelta {
  const d = value - first;
  return {
    value,
    delta: d,
    deltaPct: first === 0 ? null : (d / Math.abs(first)) * 100,
    favourable: d === 0 ? null : HIGHER_IS_FAVOURABLE[name] ? d > 0 : d < 0,
  };
}

export function compareVersions(entries: readonly CompareEntry[]): CompareResult {
  if (entries.length < 1 || entries.length > MAX_COMPARE_VERSIONS) {
    throw new CompareInputError('COUNT', `Compare takes 1..${MAX_COMPARE_VERSIONS} versions, got ${entries.length}`);
  }
  const months = (entries[0] as CompareEntry).output.months.map(m => m.month);
  for (const e of entries) {
    const ms = e.output.months.map(m => m.month);
    if (ms.length !== months.length || ms.some((m, i) => m !== months[i])) {
      throw new CompareInputError('MONTHS', `Version ${e.versionId} covers different months`);
    }
  }
  const firstSeries = (entries[0] as CompareEntry).output.months.map(m => m.closing.cash);
  const firstKpis = kpiValues((entries[0] as CompareEntry).output);
  return {
    months,
    versions: entries.map(e => {
      const cashSeries = e.output.months.map(m => m.closing.cash);
      const values = kpiValues(e.output);
      return {
        versionId: e.versionId,
        name: e.name,
        cashSeries,
        cashDelta: cashSeries.map((c, i) => c - (firstSeries[i] as number)),
        minCashMonth: e.output.runway.minCashMonth,
        kpis: Object.fromEntries(KPI_NAMES.map(k => [k, delta(k, values[k], firstKpis[k])])) as Record<KpiName, KpiDelta>,
      };
    }),
  };
}
