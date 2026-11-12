/** What is behind one VAT201 field: its source lines (paged, linked to their journals), or the fields it adds up, or why there is no source. */
import { useEffect, useRef } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/lib/money/formatMoney';
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';
import { DrillLinesTable } from './DrillLinesTable';
import { useVat201Drill, type DrillFailure } from './useVat201Drill';

interface Props {
  field: string | null; from: string; to: string;
  onClose: () => void; onField: (field: string) => void;
  /** Set when this drawer was reached from another field: the field to go back to. */
  backTo?: string; onBack?: () => void;
}

/** Fields 1 and 1A are the supply value including VAT; the tax on them is on 4 and 4A. */
const TAX_FIELD_OF: Record<string, string> = { '1': '4', '1A': '4A' };

function Components({ result, onField }: { result: Extract<Vat201DrillResult, { source: 'components' }>; onField: (f: string) => void }) {
  return (
    <ul className="space-y-1 text-sm" data-testid="return-drill-components">
      {result.components.map((c) => (
        <li key={c.field} className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => onField(c.field)} className="min-h-[24px] text-left text-teal-700 underline dark:text-teal-400">
            {c.field} {c.label}
          </button>
          <span className="tabular-nums">{c.amount === null ? '—' : formatMoney(c.sign * c.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

function Tie({ lines }: { lines: Extract<Vat201DrillResult, { source: 'tax-lines' | 'nil-rated' }> }) {
  const column = lines.source === 'tax-lines' ? 'The VAT column' : 'The Amount column';
  const taxField = TAX_FIELD_OF[lines.field];
  return (
    <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="return-drill-total">
      {column} adds up to {formatMoney(lines.rowsTotal)}
      {lines.ties === true && ' — matches the field.'}
      {lines.ties === false && ' — does not match the field.'}
      {lines.ties === null && `. Field ${lines.field} is the value of supplies including VAT, so these VAT legs do not add up to it${taxField ? `; they tie to field ${taxField}` : ''}.`}
    </p>
  );
}

function Failure({ failure, onRetry }: { failure: DrillFailure; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {failure.message}{failure.retryAfterSecs ? ` Try again in ${failure.retryAfterSecs} seconds.` : ''}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function Vat201DrillDrawer({ field, from, to, onClose, onField, backTo, onBack }: Props) {
  const drill = useVat201Drill(field, from, to);
  const { result, failure, loading, page, paged } = drill;
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { if (result) top.current?.scrollIntoView?.({ block: 'start' }); }, [result]);
  const lines = result && (result.source === 'tax-lines' || result.source === 'nil-rated') ? result : null;
  const pager = lines !== null || failure !== null || (loading && paged);
  const size = lines?.pageSize ?? 0;
  return (
    <Drawer open={field !== null} onClose={onClose} title={`Field ${field ?? ''}${result ? `: ${result.label}` : ''}`} width="lg">
      <div ref={top} />
      <div className="space-y-3" data-testid="return-drill-drawer" aria-busy={loading}>
        {onBack && backTo && (
          <Button variant="ghost" size="sm" onClick={onBack}>Back to field {backTo}</Button>
        )}
        {failure && <Failure failure={failure} onRetry={drill.retry} />}
        {loading && <p role="status" className="text-sm text-[var(--ff-text-secondary)]">Loading…</p>}
        {result && (
          <>
            {result.amount !== null && <p className="text-sm text-[var(--ff-text-secondary)]">Field amount <strong className="text-[var(--ff-text-primary)]">{formatMoney(result.amount)}</strong></p>}
            {lines?.note && <p className="text-xs text-[var(--ff-text-secondary)]">{lines.note}</p>}
            {result.source === 'none' && <p className="text-sm text-[var(--ff-text-primary)]" data-testid="return-drill-note">{result.note}</p>}
            {result.source === 'components' && <Components result={result} onField={onField} />}
            {lines && <Tie lines={lines} />}
            {lines && <DrillLinesTable result={lines} />}
          </>
        )}
        {pager && (
          <div className="flex items-center justify-between gap-2">
            <Button variant="secondary" size="sm" disabled={loading || page <= 1} onClick={() => drill.setPage(page - 1)}>Previous</Button>
            <span className="text-center text-xs text-[var(--ff-text-secondary)]" data-testid="return-drill-range">
              {lines ? `Showing ${lines.rowCount === 0 ? 0 : (page - 1) * size + 1}–${Math.min(page * size, lines.rowCount)} of ${lines.rowCount}` : `Page ${page}`}
            </span>
            <Button variant="secondary" size="sm" disabled={loading || failure !== null || (lines !== null && !lines.hasMore)} onClick={() => drill.setPage(page + 1)}>Next</Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
