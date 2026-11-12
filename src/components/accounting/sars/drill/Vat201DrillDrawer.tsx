/** What is behind one VAT201 field: its source lines (paged, linked to their journals), or the fields it adds up, or why there is no source. */
import { useEffect, useState } from 'react';
import { Drawer } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/lib/money/formatMoney';
import { apiErrorMessage } from '@/lib/apiFetch';
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';
import { DrillLinesTable } from './DrillLinesTable';
import { fetchVat201Drill } from './returnDrillClient';

interface Props { field: string | null; from: string; to: string; onClose: () => void; onField: (field: string) => void }

function Body({ result, onField }: { result: Vat201DrillResult; onField: (f: string) => void }) {
  if (result.source === 'none') return <p className="text-sm text-[var(--ff-text-primary)]" data-testid="return-drill-note">{result.note}</p>;
  if (result.source === 'components') {
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
  return null;
}

export function Vat201DrillDrawer({ field, from, to, onClose, onField }: Props) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Vat201DrillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPage(1); }, [field, from, to]);
  useEffect(() => {
    if (!field) return undefined;
    const ctl = new AbortController();
    setError(null);
    fetchVat201Drill(field, from, to, page, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setResult(r); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) { setResult(null); setError(apiErrorMessage(e, 'The lines behind this field could not be loaded.')); } });
    return () => ctl.abort();
  }, [field, from, to, page]);
  const current = result && result.field === field ? result : null;
  const lines = current && (current.source === 'tax-lines' || current.source === 'nil-rated') ? current : null;
  return (
    <Drawer open={field !== null} onClose={onClose} title={`Field ${field ?? ''}${current ? `: ${current.label}` : ''}`} width="lg">
      <div className="space-y-3 p-4" data-testid="return-drill-drawer" aria-busy={!current && !error}>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        {!current && !error && <p role="status" className="text-sm text-[var(--ff-text-secondary)]">Loading…</p>}
        {current && (
          <>
            {current.amount !== null && <p className="text-sm text-[var(--ff-text-secondary)]">Field amount <strong className="text-[var(--ff-text-primary)]">{formatMoney(current.amount)}</strong></p>}
            {current.source !== 'none' && current.source !== 'components' && current.note && <p className="text-xs text-[var(--ff-text-secondary)]">{current.note}</p>}
            <Body result={current} onField={onField} />
            {lines && (
              <>
                <p className="text-xs text-[var(--ff-text-secondary)]" data-testid="return-drill-total">
                  Lines add up to {formatMoney(lines.rowsTotal)}{lines.ties === true ? ' — matches the field.' : lines.ties === false ? ' — does not match the field.' : '.'}
                </p>
                <DrillLinesTable result={lines} />
                <div className="flex items-center justify-between">
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <span className="text-xs text-[var(--ff-text-secondary)]">Page {lines.page}</span>
                  <Button variant="secondary" size="sm" disabled={!lines.hasMore} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
