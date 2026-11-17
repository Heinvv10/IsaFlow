/**
 * useBankTxActions — All server-mutating action handlers for the bank transactions page.
 * Keeps the page shell thin by co-locating callAction, saveSelection, saveDimensions,
 * and all derived handler functions.
 */

import type { BankTxOutcome } from './useBankTxOutcome';
import { apiFetch, assertOk, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { log } from '@/lib/logger';
import { extractPattern } from '@/components/accounting/CreateRuleModal';
import type { AllocType, BankTx, SelectOption, RowSelection } from '@/components/accounting/BankTxTable';
import type { RulePrompt } from './BankTxBatchPanel';
import { buildBankTxSelectionActions } from './bankTxSelectionActions';
import { fetchReconReport } from './reconReportFetch';
import { buildSaveActions } from './bankTxSaveActions';
import { buildBulkActions } from './bankTxBulkActions';
import { selectedOnScreen } from './bankTxSelectionView';
import type { BankTxBusy } from './useBankTxBusy';
import { isUndoableAllocation, offerAllocationUndo, offerExcludeUndo } from './bankTxUndo';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';

interface ActionDeps {
  transactions: BankTx[];
  glAccounts: SelectOption[];
  bankAccounts: { id: string }[];
  selectedBank: string;
  selectedIds: Set<string>;
  rowSelections: Record<string, RowSelection>;
  batchType: AllocType;
  excludingTxId: string | null;
  createEntityTxId: string | null;
  setSmartRunning: (v: boolean) => void;
  setRowSelections: (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void;
  setTransactions: (fn: (prev: BankTx[]) => BankTx[]) => void;
  setSelectedIds: (fn: (prev: Set<string>) => Set<string>) => void;
  setShowBatchEdit: (v: boolean) => void;
  setRulePrompt: (v: RulePrompt | null) => void;
  setExcludingTxId: (v: string | null) => void;
  /** Settled by the exclude flow: true when the row was excluded, false on cancel or error. Absent: nobody listens. */
  excludeOutcome?: BankTxOutcome;
  loadTransactions: () => void;
  /** Reloads the bank-account summary (cards, tiles, statement panel; WP1 PR-C) - the list is `loadTransactions`. */
  refreshBankAccounts: () => void;
  /** For saveSelection only (one call per row edit): a trailing-debounced summary refresh. Absent: `refreshBankAccounts`. */
  refreshSummarySoon?: () => void;
  /** In-flight guard and progress of the mutating buttons (useBankTxBusy). Absent: no guard (tests). */
  busy?: BankTxBusy;
  /** For a toast's Undo, which runs long after this render: reloads the view on screen by then. */
  reloadCurrentView: () => void;
  onLlmResidual?: (n: number) => void;
}

export function buildBankTxActions(deps: ActionDeps) {
  const {
    transactions, bankAccounts, selectedBank, rowSelections,
    excludingTxId, excludeOutcome,
    setSmartRunning, setRowSelections, setTransactions, setSelectedIds,
    setRulePrompt, setExcludingTxId, loadTransactions, refreshBankAccounts, reloadCurrentView, onLlmResidual,
  } = deps;

  // Bulk actions touch only rows that are on screen: a selection that outlived a page/filter/reload change is cut here too.
  const selectedIds = selectedOnScreen(deps.selectedIds, transactions);
  const run: BankTxBusy['run'] = deps.busy?.run ?? ((_key, fn) => fn());

  const callAction = async (body: Record<string, string>, fallback = 'Could not complete the action - try again') => {
    // A request about these lines is activity for the operation holding them (and only that one): its silence timer restarts.
    const rows = [body.bankTransactionId, ...(Array.isArray(body.bankTransactionIds) ? body.bankTransactionIds : [])].filter((r): r is string => typeof r === 'string');
    deps.busy?.touch?.({ rows });
    try {
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      await assertOk(res, fallback);
      const json = await res.json();
      if (json.success === false) throw new ApiEnvelopeError(json.error?.message || fallback);
      return json;
    } finally { deps.busy?.touch?.({ rows }); } // and so is one finishing
  };

  const { saveSelection, saveDimensions } = buildSaveActions(deps.refreshSummarySoon ?? refreshBankAccounts);

  /** Posts the allocation. `onPosted` fires as soon as the allocate request succeeded, before the list reloads. */
  const acceptRow = async (txId: string, onPosted: () => void) => {
    const sel = rowSelections[txId];
    if (!sel?.entityId) { notify.error('Select an account/supplier/customer first'); return; }
    const tx = transactions.find(t => t.id === txId);
    try {
      // `autoApply` is stated rather than left to the default: a supplier or
      // customer line allocated here settles that contact's oldest open
      // documents, and the screen that posts it should say so rather than
      // inherit it. Nothing here offers 'none' yet — the REST action takes it.
      const body: Record<string, string> = { action: 'allocate', bankTransactionId: txId, allocationType: sel.type, vatCode: sel.vatCode || 'none', autoApply: 'fifo' };
      if (sel.type === 'account' || sel.type === 'transfer') body.contraAccountId = sel.entityId;
      else body.entityId = sel.entityId;
      // Dimensions belong on the cost line only: a supplier payment, receipt or transfer carries none (the server refuses them).
      if (sel.type === 'account') {
        if (sel.cc1Id) body.cc1Id = sel.cc1Id;
        if (sel.cc2Id) body.cc2Id = sel.cc2Id;
        if (sel.buId) body.buId = sel.buId;
      }
      const allocated = await callAction(body);
      onPosted();
      const journalEntryId: unknown = allocated?.data?.journalEntryId;
      if (typeof journalEntryId === 'string' && isUndoableAllocation(sel, bankAccounts)) {
        offerAllocationUndo(txId, journalEntryId, sel.type === 'account', { callAction, reloadCurrentView });
      } else {
        notify.success(sel.type === 'transfer' ? 'Transfer posted' : 'Transaction allocated');
      }
      notifyLateClaims(allocated); // VAT claimed in a later period (s16(3))
      loadTransactions(); refreshBankAccounts();
      if (sel.type === 'account' && sel.entityId) {
        apiFetch('/api/accounting/smart-categorize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'learn', txId, glAccountId: sel.entityId, category: sel.label, vatCode: sel.vatCode }),
        }).then(r => assertOk(r, 'Could not record the categorisation')).catch(e => log.warn('Smart-categorize learn failed', { error: e }, 'banking'));  // best-effort: the allocation already posted
      }
      if (tx?.description && selectedBank) {
        const pattern = extractPattern(tx.description);
        if (pattern.trim().length >= 3) {
          try {
            const params = new URLSearchParams({ pattern, matchType: 'contains', bankAccountId: selectedBank });
            const res = await apiFetch(`/api/accounting/bank-rules-preview?${params}`);
            await assertOk(res, 'Could not preview the matching rule - try again');
            const json = await res.json();
            const matchCount = json.data?.matchCount ?? 0;
            if (matchCount > 0) setRulePrompt({ tx, matchCount });
          } catch (e) { log.warn('Bank rule prompt check failed', { error: e }, 'banking'); }
        }
      }
    } catch (e) { notify.error(apiErrorMessage(e, 'Could not allocate the transaction - try again')); }
  };

  /** Resolves true once the row was actually posted (the grid's keyboard stream moves on only then), false on any failure. */
  const handleAccept = (txId: string): Promise<boolean> => new Promise((resolve) => {
    // One accept per line at a time: a second click while the first is posting would post the journal twice.
    void run(`accept:${txId}`, () => acceptRow(txId, () => resolve(true)), [txId]).finally(() => resolve(false));
  });

  const handleExclude = (txId: string): Promise<boolean> => { setExcludingTxId(txId); return excludeOutcome?.begin() ?? Promise.resolve(false); };
  const handleExcludeClose = () => { excludeOutcome?.settle(false); setExcludingTxId(null); };
  const handleExcludeConfirm = async (reason: string) => {
    if (!excludingTxId) { excludeOutcome?.settle(false); return; }
    const txId = excludingTxId;
    setExcludingTxId(null);
    const sameKey = deps.busy?.isRunning(`exclude:${txId}`) ?? false;
    const ran = await run(`exclude:${txId}`, async () => {
      try {
        const excluded = await callAction({ action: 'exclude', bankTransactionId: txId, excludeReason: reason });
        excludeOutcome?.settle(true);
        if (excluded?.data?.priorStatus === 'imported') offerExcludeUndo(txId, { callAction, reloadCurrentView });
        else notify.success('Transaction excluded');
        loadTransactions(); refreshBankAccounts();
      } catch (e) { excludeOutcome?.settle(false); notify.error(apiErrorMessage(e, 'Could not exclude - try again')); }
      return true;
    }, [txId]);
    // Refused because another operation holds this LINE (the hook already said why): this exclude will never run, so the
    // keyboard grid waiting on its outcome is released. A refusal by the SAME key leaves the first exclude's outcome alone.
    if (ran === undefined && !sameKey) excludeOutcome?.settle(false);
  };
  const handleUnmatch = async (txId: string) => {
    // A reviewed line has been signed off by a person: undoing it asks first, as the Undo toast and Reverse do.
    if (transactions.find(t => t.id === txId)?.reviewedAt && !window.confirm('This line was marked as reviewed. Undo its allocation anyway?')) return;
    await run(`unmatch:${txId}`, async () => {
      try { await callAction({ action: 'unmatch', bankTransactionId: txId }); notify.success('Allocation undone'); loadTransactions(); refreshBankAccounts(); }
      catch (e) { notify.error(apiErrorMessage(e, 'Could not undo the allocation - try again')); }
    }, [txId]);
  };
  const handleUpdateNotes = async (txId: string, notes: string) => {
    setTransactions(prev => prev.map(tx => tx.id === txId ? { ...tx, notes: notes || undefined } : tx));
    try {
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'update_notes', bankTransactionId: txId, notes }),
      });
      await assertOk(res, 'Could not save the note - try again');
      const json = await res.json();
      if (json.success === false) throw new ApiEnvelopeError(json.error?.message || 'Could not save the note - try again');
    } catch (e) { notify.error(apiErrorMessage(e, 'Could not save the note - try again')); loadTransactions(); }
  };
  const handleApplyRules = () => run('apply-rules', async () => {
    if (!selectedBank) { notify.error('Select a bank account first'); return; }
    setSmartRunning(true);
    notify.success('Running smart categorization...');
    const alive = () => deps.busy?.touch?.({ key: 'apply-rules' }); // each step of a long run is activity for its hold
    try {
      alive();
      const rulesRes = await apiFetch('/api/accounting/bank-rules-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'apply', bankAccountId: selectedBank }),
      });
      alive(); await assertOk(rulesRes, 'Could not apply the rules - try again');
      const rulesApplied = (await rulesRes.json()).data?.applied ?? 0;
      let smartCategorized = 0, totalSkipped = 0, smartFailed = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        alive();
        const smartRes = await apiFetch('/api/accounting/smart-categorize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'categorize', bankAccountId: selectedBank }),
          signal: controller.signal,
        });
        clearTimeout(timeout); alive(); await assertOk(smartRes, 'Smart categorisation could not run - try again');
        const smartJson = await smartRes.json();
        smartCategorized = smartJson.data?.categorized ?? 0;
        totalSkipped = smartJson.data?.skipped ?? 0;
        const residualCount: number = smartJson.data?.residualCount ?? 0;
        if (residualCount > 0) onLlmResidual?.(residualCount);
      } catch (e) { if ((e as { name?: string })?.name !== 'AbortError') { smartFailed = true; notify.error(apiErrorMessage(e, 'Smart categorisation could not run - try again')); } /* else: AI categorization timed out */ }
      if (smartFailed) { if (rulesApplied > 0) notify.success(`${rulesApplied} rules applied`); }
      else notify.success(rulesApplied + smartCategorized > 0
        ? `${rulesApplied} rules applied, ${smartCategorized} smart-categorised, ${totalSkipped} skipped`
        : 'No new categorisations found');
      setRowSelections(() => ({})); loadTransactions(); refreshBankAccounts();   // the rules DID apply
    } catch (e) { notify.error(apiErrorMessage(e, 'Could not apply rules - try again')); }
    finally { setSmartRunning(false); }
  });
  const handleReverse = async (txId: string) => {
    const tx = transactions.find(t => t.id === txId);
    const msg = tx?.status === 'allocated'
      ? 'Undo this allocation? The journal entry will be reversed.'
      : 'Reverse this transaction? The associated journal entry will also be reversed.';
    if (!window.confirm(msg)) return;
    await run(`reverse:${txId}`, async () => {
      try {
        await callAction({ action: 'reverse', bankTransactionId: txId });
        notify.success(tx?.status === 'allocated' ? 'Allocation undone' : 'Transaction reversed');
        loadTransactions(); refreshBankAccounts();
      } catch (e) { notify.error(apiErrorMessage(e, 'Could not reverse the transaction - try again')); }
    }, [txId]);
  };
  const handleDownloadReport = async (bankAccountCode: string | undefined) => {
    if (!selectedBank) return;
    try {
      const report = await fetchReconReport(selectedBank);
      if (report.matchedTotal !== undefined || report.unmatchedTotal !== undefined) {
        notify.warning('The report is very long and lists only its first lines', 'The PDF says how many of how many it lists.');
      }
      const { generateReconReport } = await import('@/modules/accounting/utils/reconReportPdf');
      const blob = await generateReconReport(report);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `recon-report-${bankAccountCode || 'bank'}.pdf`;
      a.click(); URL.revokeObjectURL(url);
      notify.success('Report downloaded');
    } catch (e) { notify.error(apiErrorMessage(e, 'Could not build the reconciliation report - try again')); }
  };
  return {
    saveSelection, saveDimensions,
    handleAccept, handleExclude, handleExcludeClose, handleExcludeConfirm, handleUnmatch, handleUpdateNotes,
    handleApplyRules, handleReverse,
    handleDownloadReport,
    ...buildBulkActions({
      transactions, selected: selectedIds, rowSelections, callAction, run, setProgress: deps.busy?.setProgress ?? (() => undefined),
      setSelectedIds, reload: () => { loadTransactions(); refreshBankAccounts(); },
    }),
    ...buildBankTxSelectionActions({ ...deps, selectedIds }, saveSelection, saveDimensions),
  };
}
