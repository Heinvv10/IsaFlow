/**
 * Approving one bill through the budget check (budgets P5-2). `start()` previews the bill's
 * budget (POST /api/accounting/budgets/remaining { supplierInvoiceId }); when a line meets a
 * budget the dialog opens, otherwise it approves at once. An approval the server refuses for the
 * budget (400 BUDGET_REASON_REQUIRED, 409 BUDGET_EXCEEDED) opens or keeps the dialog with the
 * server's words, so a stale preview never strands the user.
 */
import { useCallback, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BudgetCheckLine, BudgetPolicy } from '@/modules/accounting/services/budgets/budgetCheckTypes';
import type { BudgetApproveChoice } from './BudgetApproveDialog';

interface Preview { policy: BudgetPolicy; checks: boolean; lines: BudgetCheckLine[] }
interface ErrorBody { error?: { message?: string; details?: { code?: string; lines?: BudgetCheckLine[] } } }

const FALLBACK = 'Could not complete that action - try again';

/** A 400/409 body's text (read from a clone: assertOk reads the response itself); empty or non-JSON is no budget refusal. */
function budgetErrorBody(text: string): ErrorBody {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as ErrorBody;
  } catch (err) {
    log.debug('Approve refusal body is not JSON', { error: err }, 'supplier-invoices');
    return {};
  }
}

/**
 * `onReload`: a 409 that is not the budget's (the R-035 approval gate) reloads the invoice first, so the page offers
 * Submit for approval — as the page's own action handler does — then `onFailed` shows the refusal.
 */
export function useBudgetApprove(
  invoiceId: string, onApproved: (json: unknown) => Promise<void> | void, onFailed: (message: string) => void,
  onReload: () => Promise<void>,
) {
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<BudgetPolicy>('warn');
  const [lines, setLines] = useState<BudgetCheckLine[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (choice: BudgetApproveChoice, inDialog: boolean) => {
    setBusy(true);
    setError('');
    let toPage = !inDialog;
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', invoiceId, ...choice }),
      });
      if (res.status === 400 || res.status === 409) {
        const body = budgetErrorBody(await res.clone().text());
        const code = body.error?.details?.code;
        if (code === 'BUDGET_REASON_REQUIRED' || code === 'BUDGET_EXCEEDED') {
          if (!inDialog && body.error?.details?.lines) { setLines(body.error.details.lines); setPolicy(code === 'BUDGET_EXCEEDED' ? 'block' : 'warn'); }
          setError(body.error?.message ?? FALLBACK);
          setOpen(true);
          return;
        }
        if (res.status === 409) { setOpen(false); toPage = true; await onReload(); }
      }
      await assertOk(res, FALLBACK);
      setOpen(false);
      await onApproved(await res.json());
    } catch (err) {
      const message = apiErrorMessage(err, FALLBACK);
      if (toPage) onFailed(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }, [invoiceId, onApproved, onFailed, onReload]);

  const start = useCallback(async () => {
    let preview: Preview | null = null;
    try {
      const res = await apiFetch('/api/accounting/budgets/remaining', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierInvoiceId: invoiceId }),
      });
      await assertOk(res, 'Could not read the budget for this bill');
      const json = await res.json() as { data?: Preview } & Preview;
      preview = json.data ?? json;
    } catch (err) {
      // No preview is not a refusal: the approval below still runs the check, and a budget refusal opens the dialog.
      log.warn('Budget preview failed; approving without it', { invoiceId, error: err }, 'supplier-invoices');
    }
    if (preview?.checks && preview.lines.some((l) => l.budget !== null)) {
      setPolicy(preview.policy);
      setLines(preview.lines);
      setError('');
      setOpen(true);
      return;
    }
    await submit({}, false);
  }, [invoiceId, submit]);

  return {
    start,
    busy,
    dialog: {
      open, policy, lines, error, busy,
      onCancel: () => { setOpen(false); setError(''); },
      onApprove: (choice: BudgetApproveChoice) => { void submit(choice, true); },
    },
  };
}
