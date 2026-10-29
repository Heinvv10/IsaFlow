/**
 * The driver editor drawer (P4 spec §1.1, §7): one row's driver (an account at one grain). Kind,
 * months (inside the version), rounding unit (R1 / R100 / R1000), the kind's fields, a live
 * preview of every version month (12, or 14 in a transition year) computed in the browser with
 * the pure engine, and the loop error inline with its path, from the preview or a 400
 * DRIVER_CYCLE. Save PUTs the line, Delete removes it (its cells keep their values as manual).
 * Focus is trapped while open; Escape and the backdrop close it.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { formatCents, formatMoney } from '@/lib/money/formatMoney';
import { ROUNDING_UNITS } from '@/modules/accounting/services/budgets/grid/cents';
import type { DriverGrain, DriverLine, StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { DriverKind, RowKey } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { checkDraft, draftFrom, KIND_LABEL, type DriverDraft } from './driverDraft';
import { DriverKindFields, Field, INPUT, type RowOption, type ScopeOption } from './DriverKindFields';
import type { PreviewResult } from './driverPreview';

export interface EditorFailure { message: string; path?: string[] }

export interface DriverEditorProps {
  /** The driven row and its label ("5000 Cost of sales (Alpha)"). */
  grain: DriverGrain;
  label: string;
  existing: StoredDriverLine | null;
  months: readonly string[];
  rows: readonly RowOption[];
  costCentres: readonly ScopeOption[];
  /** Read-only (a reader, a locked version): the form shows, nothing saves. */
  readOnly: boolean;
  /** The pure engine over the grid's cells with this line in place of the row's driver. */
  preview(line: DriverLine): PreviewResult;
  /** A per_head draft reads this scope's headcount: load it (the preview reruns when `headcountTick` moves). */
  onNeedHeadcount(scope: string | null): void;
  headcountTick: number;
  /** Why the scope's headcount could not be read; null while it loads or once it has. */
  headcountError(scope: string | null): string | null;
  /** "4000 Sales → 5000 Cost of sales → 4000 Sales" for a loop's row keys. */
  pathLabel(path: readonly RowKey[]): string;
  /** Resolves null when saved (the parent closes the drawer), else what went wrong. */
  onSave(line: DriverLine): Promise<EditorFailure | null>;
  onDelete(): Promise<EditorFailure | null>;
  onClose(): void;
}

const KINDS: readonly DriverKind[] = ['fixed', 'pct_of_line', 'pct_of_section', 'growth', 'per_head'];
const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';

function PreviewTable({ months, result }: { months: readonly string[]; result: Extract<PreviewResult, { ok: true }> }) {
  return (
    <table className="w-full text-xs" data-testid="driver-preview">
      <caption className="sr-only">Preview of the driver&apos;s months</caption>
      <thead><tr className="text-[var(--ff-text-tertiary)]"><th scope="col" className="text-left font-medium">Month</th><th scope="col" className="text-right font-medium">Amount</th></tr></thead>
      <tbody>
        {months.map((m, i) => {
          const v = result.values[i] ?? null;
          const src = result.sources[i] ?? null;
          const note = src === 'actual' ? ' (actual)' : src === 'override' ? ' (override kept)' : src === 'driver' ? '' : src === 'manual' ? ' (typed)' : '';
          return (
            <tr key={m} data-source={src ?? undefined} className={src === 'driver' ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-tertiary)]'}>
              <th scope="row" className="py-0.5 text-left font-normal">{monthLabel(m)}</th>
              <td className="py-0.5 text-right tabular-nums">{v === null ? '—' : formatCents(v)}{note}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DriverEditor(props: DriverEditorProps) {
  const { grain, label, existing, months, rows, costCentres, readOnly, preview, onNeedHeadcount, headcountTick, headcountError, pathLabel, onSave, onDelete, onClose } = props;
  const [draft, setDraft] = useState<DriverDraft>(() => draftFrom(existing, months));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<EditorFailure | null>(null);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panel, true, onClose);
  const patch = (p: Partial<DriverDraft>) => { setDraft((d) => ({ ...d, ...p })); setFailure(null); };

  const check = useMemo(() => checkDraft(draft, grain, months), [draft, grain, months]);
  const scope = draft.kind === 'per_head' ? (draft.headcountScope === '' ? null : draft.headcountScope) : undefined;
  useEffect(() => { if (scope !== undefined) onNeedHeadcount(scope); }, [scope, onNeedHeadcount]);
  // headcountTick: a headcount read arrived, so the same draft previews again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => (check.ok ? preview(check.line) : null), [check, preview, headcountTick]);
  const errors = tried && !check.ok ? check.errors : {};
  const loop = result && !result.ok && result.kind === 'cycle' ? pathLabel(result.path) : null;

  const save = async () => {
    setTried(true);
    if (readOnly) return;
    if (!check.ok) { setFailure({ message: 'Fix the fields marked above before saving.' }); return; }
    setBusy(true);
    try {
      setFailure(await onSave(check.line));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      setFailure(await onDelete());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <div aria-hidden="true" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="driver-editor"
        className="relative flex h-full w-full max-w-md flex-col border-l border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] shadow-2xl">
        <div className="flex items-start justify-between gap-2 border-b border-[var(--ff-border-light)] px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-[var(--ff-text-primary)]">{existing ? 'Edit driver' : 'Set a driver'}</h2>
            <p className="truncate text-sm text-[var(--ff-text-secondary)]">{label}</p>
          </div>
          <button type="button" aria-label="Close the driver editor" onClick={onClose} className="rounded p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
          <Field label="Driver">
            {(id) => (
              <select id={id} className={INPUT} value={draft.kind} disabled={readOnly} onChange={(e) => patch({ kind: e.target.value as DriverKind })}>
                {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From" error={errors.range}>
              {(id, d) => (
                <select id={id} aria-describedby={d} className={INPUT} value={draft.fromMonth} disabled={readOnly} onChange={(e) => patch({ fromMonth: e.target.value })}>
                  {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
              )}
            </Field>
            <Field label="To">
              {(id) => (
                <select id={id} className={INPUT} value={draft.toMonth} disabled={readOnly} onChange={(e) => patch({ toMonth: e.target.value })}>
                  {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
              )}
            </Field>
          </div>
          <Field label="Round each month to">
            {(id) => (
              <select id={id} className={INPUT} value={draft.rounding} disabled={readOnly}
                onChange={(e) => patch({ rounding: Number(e.target.value) as DriverDraft['rounding'] })}>
                {ROUNDING_UNITS.map((u) => <option key={u} value={u}>{formatMoney(u, { decimals: 0 })}</option>)}
              </select>
            )}
          </Field>
          <DriverKindFields draft={draft} errors={errors} onChange={patch} months={months} rows={rows} costCentres={costCentres} disabled={readOnly} />
          <section aria-labelledby={`${titleId}-preview`} className="rounded-lg border border-[var(--ff-border-light)] p-3">
            <h3 id={`${titleId}-preview`} className="mb-2 text-xs font-semibold text-[var(--ff-text-secondary)]">Preview</h3>
            {loop && <p role="alert" data-testid="driver-cycle" className="text-xs text-error-700 dark:text-error-400">This driver makes a loop: {loop}</p>}
            {result && !result.ok && result.kind === 'invalid' && <p className="text-xs text-error-700 dark:text-error-400">{result.message}</p>}
            {!check.ok && <p className="text-xs text-[var(--ff-text-tertiary)]">Fill in the driver to see its months.</p>}
            {result?.ok && (
              <>
                {result.headcountMissing && (headcountError(scope ?? null)
                  ? <p role="alert" className="mb-1 text-xs text-error-700 dark:text-error-400">The headcount could not be read: {headcountError(scope ?? null)} The months below count 0 heads.</p>
                  : <p className="mb-1 text-xs text-[var(--ff-text-tertiary)]">Reading the headcount…</p>)}
                {result.warnings.map((w) => <p key={w} className="mb-1 text-xs text-[var(--ff-unfav)]">{w}</p>)}
                <PreviewTable months={months} result={result} />
              </>
            )}
          </section>
          {failure && (
            <p role="alert" data-testid="driver-editor-error" className="text-sm text-error-700 dark:text-error-400">
              {failure.path ? `This driver makes a loop: ${pathLabel(failure.path)}` : failure.message}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--ff-border-light)] px-5 py-3">
          {existing && !readOnly && !confirming && (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={`${BTN} mr-auto bg-error-600 text-white hover:bg-error-700`}>Delete driver</button>
          )}
          {confirming && (
            <span role="group" aria-label="Confirm delete" className="mr-auto flex flex-wrap items-center gap-2" data-testid="driver-delete-confirm">
              <span className="text-xs text-[var(--ff-text-secondary)]">Delete this driver? Its cells keep their amounts.</span>
              <button type="button" onClick={() => { void remove(); }} disabled={busy} className={`${BTN} bg-error-600 text-white hover:bg-error-700`}>Delete</button>
              <button type="button" onClick={() => setConfirming(false)} className={`${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]`}>Keep</button>
            </span>
          )}
          <button type="button" onClick={onClose} className={`${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]`}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && (
            <button type="button" onClick={() => { void save(); }} disabled={busy || loop !== null} data-testid="driver-editor-save"
              className={`${BTN} bg-brand-600 text-white hover:bg-brand-700`}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Save driver
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
