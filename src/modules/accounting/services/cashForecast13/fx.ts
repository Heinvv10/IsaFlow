/**
 * Foreign-currency documents in the forecast (review L6). Pure.
 *
 * A document whose currency is not the company's functional currency is converted at its OWN stored exchange
 * rate (`exchange_rate`, set when the document was written; FX programme, shared/documentCurrency.ts). One with
 * no usable rate (NULL or ≤ 0) cannot be converted honestly and is left out; the caller warns
 * `currency_not_converted` with the totals by currency. A document in the functional currency (or with no
 * currency named) passes through unchanged.
 */
export interface DocCurrency { currency: string | null; rate: number | null }

export interface FxDoc { id: string; balanceCents: number; disputedCents: number }

export interface FxResult<T extends FxDoc> {
  docs: T[];
  /** Left out, per currency: count and the document-currency balance in cents. */
  excluded: Map<string, { count: number; cents: number }>;
}

export function convertDocs<T extends FxDoc>(docs: readonly T[], fx: ReadonlyMap<string, DocCurrency>, functional: string): FxResult<T> {
  const out: T[] = [];
  const excluded = new Map<string, { count: number; cents: number }>();
  for (const d of docs) {
    const c = fx.get(d.id);
    if (!c || c.currency === null || c.currency === functional) {
      out.push(d);
      continue;
    }
    if (c.rate === null || !(c.rate > 0)) {
      const e = excluded.get(c.currency) ?? { count: 0, cents: 0 };
      excluded.set(c.currency, { count: e.count + 1, cents: e.cents + d.balanceCents });
      continue;
    }
    out.push({ ...d, balanceCents: Math.round(d.balanceCents * c.rate), disputedCents: Math.round(d.disputedCents * c.rate) });
  }
  return { docs: out, excluded };
}

export function excludedMessage(side: string, excluded: FxResult<FxDoc>['excluded']): string {
  const parts = [...excluded].sort(([a], [b]) => (a < b ? -1 : 1)).map(([cur, e]) => `${e.count} in ${cur} (${(e.cents / 100).toFixed(2)} ${cur})`);
  return `${side} in another currency with no stored exchange rate are left out: ${parts.join('; ')}`;
}
