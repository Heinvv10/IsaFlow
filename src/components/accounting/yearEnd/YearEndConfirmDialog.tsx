/**
 * Year-end close confirmation (audit P3.2). Names the year and its dates,
 * shows the closing figures and the Retained Earnings account the result goes
 * to (read-only dry run: GET /api/accounting/year-end?preview=<label>), and
 * keeps Confirm disabled until the year label is typed exactly.
 */

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';
import { log } from '@/lib/logger';

export interface YearEndConfirmYear {
  year_label: string;
  start_date: string;
  end_date: string;
  total_revenue: number;
  total_expenses: number;
}

export interface YearEndPreview {
  yearLabel: string;
  refusal?: string;
  alreadyClosed?: boolean;
  netIncome?: number;
  entryDate?: string;
  entryNumber?: string;
  retainedEarnings?: { accountCode: string; accountName: string } | null;
}

interface Props {
  year: YearEndConfirmYear | null;
  busy: boolean;
  onConfirm: (yearLabel: string) => void;
  onCancel: () => void;
}

export function YearEndConfirmDialog({ year, busy, onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<YearEndPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const label = year?.year_label ?? '';

  useEffect(() => {
    setTyped(''); setPreview(null); setPreviewError('');
    if (!label) return;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/year-end?preview=${encodeURIComponent(label)}`);
        await assertOk(res, 'Could not read what the year-end close would do - try again');
        const json = await res.json() as { data?: YearEndPreview };
        if (live) setPreview(json.data ?? null);
      } catch (err) {
        log.error('Year-end preview failed', { error: err, yearLabel: label }, 'accounting-ui');
        if (live) { setPreview(null); setPreviewError(apiErrorMessage(err, 'Could not read what the year-end close would do - try again')); }
      }
    })();
    return () => { live = false; };
  }, [label]);

  if (!year) return null;

  const blockedReason = previewError || preview?.refusal
    || (preview?.alreadyClosed ? `Fiscal year ${label} already has a posted closing journal.` : '');
  const ready = preview !== null && !blockedReason;
  const matches = typed.trim() === label;

  const message = (
    <div className="space-y-3 whitespace-normal">
      <p>
        Close fiscal year <strong>{label}</strong> ({formatDisplayDate(year.start_date)} to {formatDisplayDate(year.end_date)}).
        This posts a closing journal that zeros every revenue and expense account and locks every period in the year.
        It cannot be undone from this page.
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt>Total revenue</dt><dd className="text-right" data-testid="ye-confirm-revenue">{formatCurrency(year.total_revenue)}</dd>
        <dt>Total expenses</dt><dd className="text-right" data-testid="ye-confirm-expenses">{formatCurrency(year.total_expenses)}</dd>
        <dt>Net income</dt>
        <dd className="text-right" data-testid="ye-confirm-net">{preview?.netIncome !== undefined ? formatCurrency(preview.netIncome) : '...'}</dd>
        <dt>Goes to</dt>
        <dd className="text-right" data-testid="ye-confirm-re">
          {preview === null ? '...'
            : preview.retainedEarnings ? `${preview.retainedEarnings.accountCode} ${preview.retainedEarnings.accountName}`
            : blockedReason ? '-' : 'Nothing to transfer (break-even year)'}
        </dd>
      </dl>
      {blockedReason && (
        <p role="alert" className="rounded-md bg-red-50 dark:bg-red-900/20 p-2 text-red-700 dark:text-red-400">{blockedReason}</p>
      )}
      <label className="block text-sm">
        Type <strong>{label}</strong> to confirm
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          disabled={!ready || busy}
          autoComplete="off"
          className="mt-1 w-full rounded-md border border-zinc-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5"
        />
      </label>
    </div>
  );

  return (
    <ConfirmDialog
      open
      title={`Process year-end for ${label}`}
      message={message}
      confirmLabel="Process Year-End"
      confirmTone="danger"
      busy={busy}
      confirmDisabled={!ready || !matches}
      onConfirm={() => onConfirm(label)}
      onCancel={onCancel}
    />
  );
}
