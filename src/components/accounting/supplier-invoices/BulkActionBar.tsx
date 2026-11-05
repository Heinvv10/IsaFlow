/**
 * Floating bar that surfaces bulk actions when one or more rows are selected.
 * Calls /supplier-invoices-bulk-action — single atomic endpoint, no parallel
 * fan-out from the client.
 */

import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';
import { notifyPostingWarnings } from '@/components/accounting/postingWarningsNotice';
import { log } from '@/lib/logger';
import { OFF_SLICE_WARNING_PREFIX, type BudgetPolicy } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import { BulkBudgetModal } from './BulkBudgetModal';
import { notify } from '@/utils/toast';

/** The bulk preview's cap (`@/lib/budgetBillPreview`): a larger selection is approved without the modal; the server still checks every bill. */
const MAX_BUDGET_PREVIEW = 50;

/**
 * Budgets P5-2 (warn): the bills approved over budget, named, so the person sees what they just approved. P5-2b: a
 * warning for a line outside every budgeted slice starts `OFF_SLICE_WARNING_PREFIX` (`decideBudgetOutcome`); the
 * title says which kinds the batch had.
 */
function notifyBudgetWarnings(data: BulkActionResult): void {
  const warned = data.results.filter((r) => r.ok && r.budgetWarnings && r.budgetWarnings.length > 0);
  if (warned.length === 0) return;
  const all = warned.flatMap((r) => r.budgetWarnings ?? []);
  const offSlice = all.some((w) => w.startsWith(OFF_SLICE_WARNING_PREFIX));
  const over = all.some((w) => !w.startsWith(OFF_SLICE_WARNING_PREFIX));
  const what = offSlice ? (over ? 'over budget or outside a budgeted slice' : 'outside a budgeted slice') : 'over budget';
  const names = warned.map((r) => r.invoiceNumber || 'a bill').join(', ');
  notify.warning(`${warned.length === 1 ? '1 bill' : `${warned.length} bills`} approved ${what}`, names);
}

type BulkAction = 'approve' | 'post_gl' | 'cancel';

interface BulkActionResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ invoiceId: string; invoiceNumber?: string | null; ok: boolean; error?: string; budgetWarnings?: string[] }>;
}

interface Props {
  selected: ReadonlySet<string>;
  busy: BulkAction | null;
  onBusyChange: (b: BulkAction | null) => void;
  /** The page's error setter: the refusal is joined to whatever the reload left. */
  onError: Dispatch<SetStateAction<string>>;
  onComplete: () => void | Promise<void>;
  onClear: () => void;
}

const VERB: Record<BulkAction, string> = {
  approve: 'Approve',
  post_gl: 'Post to GL',
  cancel: 'Cancel',
};
const COULD_NOT: Record<BulkAction, string> = {
  approve: 'Could not approve the invoices - try again',
  post_gl: 'Could not post the invoices to the GL - try again',
  cancel: 'Could not cancel the invoices - try again',
};
const PLURAL: Record<BulkAction, string> = { approve: 'approves', post_gl: 'GL postings', cancel: 'cancels' };

/** A reason without one closing full stop (an ellipsis is kept); never empty. */
export function withoutClosingStop(reason: string): string {
  // No regex lookbehind: Safari before 16.4 cannot parse one, and this ships to the browser.
  const t = reason.trim();
  const stripped = t.endsWith('.') && !t.endsWith('..') ? t.slice(0, -1).trim() : t;
  return stripped || t || reason;
}

/** Budgets P5-2: how many of the selected bills are over budget, each judged on its own. Null when it cannot be read. */
async function budgetPreview(ids: string[]): Promise<{ policy: BudgetPolicy; overBills: number } | null> {
  try {
    const res = await apiFetch('/api/accounting/budgets/remaining', { method: 'POST', body: JSON.stringify({ supplierInvoiceIds: ids }) });
    await assertOk(res, 'Could not read the budget for these bills');
    const json = await res.json();
    return (json.data || json) as { policy: BudgetPolicy; overBills: number };
  } catch (err) {
    // Not a refusal: the server checks every bill again when the action runs.
    log.warn('Bulk budget preview failed', { error: err }, 'supplier-invoices');
    return null;
  }
}

export function BulkActionBar({
  selected, busy, onBusyChange, onError, onComplete, onClear,
}: Props) {
  const [budgetAsk, setBudgetAsk] = useState<{ action: BulkAction; overBills: number; policy: BudgetPolicy } | null>(null);
  if (selected.size === 0) return null;

  async function run(action: BulkAction) {
    const ids = Array.from(selected);
    if (action !== 'cancel' && ids.length <= MAX_BUDGET_PREVIEW) {
      // Busy while the preview reads, so a second click cannot start a second preview (or a second modal).
      onBusyChange(action);
      let preview: Awaited<ReturnType<typeof budgetPreview>>;
      try {
        preview = await budgetPreview(ids);
      } finally {
        onBusyChange(null);
      }
      if (preview && preview.policy !== 'off' && preview.overBills > 0) {
        setBudgetAsk({ action, overBills: preview.overBills, policy: preview.policy });
        return;
      }
    }
    if (!window.confirm(`${VERB[action]} ${selected.size} invoice(s)?`)) return;
    await execute(action);
  }

  async function execute(action: BulkAction, budgetReason?: string) {
    onBusyChange(action);
    onError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-bulk-action', {
        method: 'POST',
        body: JSON.stringify({ action, invoiceIds: Array.from(selected), ...(budgetReason ? { budgetReason } : {}) }),
      });
      await assertOk(res, COULD_NOT[action]);
      const json = await res.json();
      const data = (json.data || json) as BulkActionResult;
      let failure = '';
      if (data.failed > 0) {
        // Group by message rather than showing only the first: a mixed
        // selection typically fails for ONE reason (a status the action
        // refuses), and the operator needs to know which reason and how many,
        // not the first id's message alone.
        // Keyed by the reason without its closing full stop, so "x." and "x" group.
        const byReason = new Map<string, { count: number; shown: string }>();
        for (const r of data.results) {
          if (r.ok) continue;
          const shown = r.error?.trim() || 'no reason was given';
          const key = withoutClosingStop(shown);
          const seen = byReason.get(key);
          byReason.set(key, { count: (seen?.count ?? 0) + 1, shown: seen?.shown ?? shown });
        }
        // One reason is shown as the server gave it. Several are joined by '; ' into
        // one sentence: each loses its closing stop (no ".;") and the list ends with one.
        const groups = Array.from(byReason.entries());
        const detail = groups.length > 1
          ? `${groups.map(([key, g]) => `${g.count}× ${key}`).join('; ')}.`
          : groups[0]?.[1].shown ?? '';
        failure = `${data.failed} of ${data.total} ${PLURAL[action]} failed${detail ? `: ${detail}` : ''}`;
      }
      // Reload first: the page's reload clears its error, so a failure set
      // before it would vanish as soon as it appeared. Join rather than
      // replace, so a failed reload still says the list is stale.
      await onComplete();
      notifyLateClaims(json); // bills whose VAT was claimed in a later period (s16(3))
      notifyPostingWarnings(json); // bills posted without a cost centre that could not be applied
      notifyBudgetWarnings(data); // P5-2 (warn): bills approved over budget
      if (failure) onError((prev) => (prev ? `${prev} — ${failure}` : failure));
    } catch (err) {
      log.warn('Bulk action failed', { action, error: err }, 'supplier-invoices');
      onError(apiErrorMessage(err, COULD_NOT[action]));
    } finally {
      onBusyChange(null);
    }
  }

  return (
    <>
    {budgetAsk && (
      <BulkBudgetModal
        open total={selected.size} overBills={budgetAsk.overBills} policy={budgetAsk.policy} verb={VERB[budgetAsk.action]}
        onCancel={() => setBudgetAsk(null)}
        onConfirm={(reason) => { const { action } = budgetAsk; setBudgetAsk(null); void execute(action, reason); }}
      />
    )}
    <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl px-4 py-2.5">
      <span className="text-sm text-amber-700 dark:text-amber-300 font-medium">
        {selected.size} selected
      </span>
      <div className="flex gap-2 ml-auto">
        <BulkButton onClick={() => run('approve')} disabled={busy !== null} busy={busy === 'approve'} tone="emerald">
          Approve
        </BulkButton>
        <BulkButton onClick={() => run('post_gl')} disabled={busy !== null} busy={busy === 'post_gl'} tone="blue">
          Post to GL
        </BulkButton>
        <BulkButton onClick={() => run('cancel')} disabled={busy !== null} busy={busy === 'cancel'} tone="red">
          Cancel
        </BulkButton>
        <button
          type="button"
          onClick={onClear}
          className="px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-md"
        >
          Clear
        </button>
      </div>
    </div>
    </>
  );
}

const TONE_CLASSES = {
  emerald: 'bg-success-700 hover:bg-success-800',
  blue: 'bg-blue-600 hover:bg-blue-700',
  red: 'bg-red-600 hover:bg-red-700',
} as const;

function BulkButton({
  onClick, disabled, busy, tone, children,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  tone: keyof typeof TONE_CLASSES;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-xs font-semibold rounded-md text-white transition-colors disabled:opacity-50 ${TONE_CLASSES[tone]}`}
    >
      {busy ? '…' : children}
    </button>
  );
}
