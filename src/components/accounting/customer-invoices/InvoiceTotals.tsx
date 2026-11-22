/**
 * InvoiceTotals — the compact totals under the line grid on the new and edit invoice pages (it replaced the right-hand
 * Invoice Summary card): subtotal, the VAT (one row per VAT type when the lines mix types, each on its own net), the
 * total, and for a foreign-currency invoice the ZAR preview. The figures are the page's (formVat: the shared per-line
 * pricing, what create and the draft edit store). A company not registered for VAT shows no VAT row.
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { VatByType } from './formVat';
import { lineVatTypeLabel } from './InvoiceLineVatSelect';

interface Props {
  subtotal: number;
  tax: number;
  total: number;
  currencyCode: string;
  /** The VAT per type (formVat.formVatByType); empty for a company not registered for VAT. */
  byType: readonly VatByType[];
  /** The invoice date: the rate shown beside a type is the one on it. */
  date: string;
  /** Foreign-currency invoices only: the ZAR preview and the rate it used. */
  fx?: { zarTotal: number; rate: number };
  /** Inclusive mode only: the gross the shown prices add up to. Shown beside `total` whenever the two differ; the stored total is the invoice (taxMode.ts). */
  typedTotal?: number;
}

const row = 'flex justify-between gap-6 text-sm';
const figure = 'tabular-nums text-slate-900 dark:text-slate-100';

/** "VAT (15%)" for an all-standard invoice; "VAT (zero-rated)" / "VAT (exempt)" for one of a single other type. */
function singleLabel(t: VatByType, date: string): string {
  if (t.type === 'standard') return isRatedDate(date) ? `VAT (${standardVatRatePctOn(date)}%)` : 'VAT';
  return t.type === 'exempt' ? 'VAT (exempt)' : 'VAT (zero-rated)';
}

export function InvoiceTotals({ subtotal, tax, total, currencyCode, byType, date, fx, typedTotal }: Props) {
  const money = (n: number) => formatCurrencyAmount(n, currencyCode);
  return (
    <section aria-label="Invoice totals" className="px-5 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end">
      <div className="w-full sm:w-96 space-y-2">
        <div className={row}><span className="text-ink-muted">Subtotal</span><span className={figure}>{money(subtotal)}</span></div>
        {byType.length === 1 && <div className={row}><span className="text-ink-muted">{singleLabel(byType[0]!, date)}</span><span className={figure}>{money(tax)}</span></div>}
        {byType.length > 1 && byType.map((t) => (
          <div key={t.type} className={row}>
            <span className="text-ink-muted">VAT {lineVatTypeLabel(t.type, date)} <span className="text-xs">on {money(t.net)}</span></span>
            <span className={figure}>{money(t.vat)}</span>
          </div>
        ))}
        <div className="h-px bg-slate-100 dark:bg-slate-800" />
        <div className="flex justify-between gap-6">
          <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
          <span className="tabular-nums font-bold text-lg text-amber-500">{money(total)}</span>
        </div>
        {/* Always mounted: a status region announces a change only if it was in the page before the change. */}
        <div role="status">
          {typedTotal !== undefined && typedTotal !== total && (
            <p className="text-xs text-amber-700 dark:text-amber-300">These prices come to {money(typedTotal)} incl. VAT; the invoice total is {money(total)}.</p>
          )}
        </div>
        {fx && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
            <p className="text-xs text-ink-muted flex justify-between">
              <span>ZAR equivalent</span>
              <span className="tabular-nums text-amber-600 dark:text-amber-400 font-semibold">{formatCurrencyAmount(fx.zarTotal, 'ZAR')}</span>
            </p>
            <p className="text-xs text-ink-muted mt-0.5">@ {fx.rate} {currencyCode}/ZAR</p>
          </div>
        )}
      </div>
    </section>
  );
}
