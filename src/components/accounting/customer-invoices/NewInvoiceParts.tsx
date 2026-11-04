/**
 * Pieces of the new-invoice page (pages/accounting/customer-invoices/new.tsx), moved out to keep it under 300 lines:
 * the kept-draft offer and the three submit buttons. The page owns every state and handler.
 */
import { FileText, Info, Loader2, Send } from 'lucide-react';
import { formatSavedAgo } from '@/components/ui/AutosaveStatus';

export function KeptDraftOffer({ savedAt, disabled, onRestore, onDiscard }: { savedAt: number; disabled: boolean; onRestore: () => void; onDiscard: () => void }) {
  return (
    <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm flex flex-wrap items-center gap-2">
      <Info className="h-4 w-4 flex-shrink-0" />An invoice you started {formatSavedAgo(Date.now() - savedAt)} was kept on this device. What you type here is not kept until you Restore or Discard it.
      <span className="ml-auto flex gap-2">
        <button type="button" onClick={onRestore} disabled={disabled} className="px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold">Restore</button>
        <button type="button" onClick={onDiscard} disabled={disabled} className="px-3 py-1 rounded-lg border border-amber-400 text-xs font-semibold">Discard</button>
      </span>
    </div>
  );
}

interface ActionsProps {
  busy: boolean; submitting: boolean; saveAndNew: boolean; approving: boolean;
  onCreate: () => void; onSaveAndNew: () => void; onApprove: () => void;
}

export function NewInvoiceActions({ busy, submitting, saveAndNew, approving, onCreate, onSaveAndNew, onApprove }: ActionsProps) {
  return (
    <>
      <button onClick={onCreate} disabled={busy} className="w-full mt-6 py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
        {submitting && !saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Create Invoice</>}
      </button>
      <button onClick={onSaveAndNew} disabled={busy} className="w-full mt-2 py-2.5 border border-amber-500 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
        {submitting && saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Save &amp; New</>}
      </button>
      <button onClick={onApprove} disabled={busy} className="w-full mt-2 py-2.5 border border-amber-500 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
        {approving ? <><Loader2 className="h-4 w-4 animate-spin" />Approving…</> : <><Send className="h-4 w-4" />Approve &amp; email</>}
      </button>
    </>
  );
}
