/**
 * Pieces of the new and edit invoice pages, moved out to keep them under 300 lines: the kept-draft offer, the action bar
 * that stays at the bottom of the viewport (sticky: the actions are in reach however long the invoice), and each page's
 * buttons in it. The pages own every state and handler.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
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

const CLEARANCE_GAP_PX = 16;

/** The nearest ancestor that scrolls (the shell's <main>), else the page's own scrolling element. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return document.scrollingElement as HTMLElement | null;
}

/**
 * While the bar is in the page its scroller keeps the bar's height, plus a gap, as its bottom scroll padding, so a field
 * focused near the bottom scrolls clear of the bar instead of under it (focus scrolling honours the scroller's
 * scroll-padding; Chromium ignores a scroll-margin on the field). Measured: the bar wraps taller on a phone.
 */
function useClearOfBar(bar: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const el = bar.current;
    const scroller = el ? scrollerOf(el) : null;
    if (!el || !scroller) return undefined;
    const before = scroller.style.scrollPaddingBottom;
    const fit = () => { scroller.style.scrollPaddingBottom = `${Math.ceil(el.getBoundingClientRect().height) + CLEARANCE_GAP_PX}px`; };
    fit();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    watch?.observe(el);
    return () => { watch?.disconnect(); scroller.style.scrollPaddingBottom = before; };
  }, [bar]);
}

/** The bar at the bottom of the viewport: `status` (autosave, notes) on the left, the buttons on the right. */
export function InvoiceActionBar({ status, children }: { status: ReactNode; children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useClearOfBar(bar);
  return (
    <div ref={bar} role="group" aria-label="Invoice actions" className="sticky bottom-0 z-20 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-4 sm:px-6 xl:px-8 py-3">
      <div className="max-w-screen-2xl mx-auto flex flex-col sm:flex-row sm:items-center gap-x-4 gap-y-2">
        {/* The status takes what the buttons leave and wraps inside it; the buttons never drop under it. */}
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">{status}</div>
        <div className="flex flex-wrap justify-end gap-2 sm:shrink-0">{children}</div>
      </div>
    </div>
  );
}

const primary = 'px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-sm disabled:opacity-50 inline-flex items-center justify-center gap-2 text-sm';
const secondary = 'px-4 py-2 border border-amber-500 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2 text-sm';
const plain = 'px-4 py-2 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold rounded-xl transition-colors text-sm';

interface ActionsProps {
  busy: boolean; submitting: boolean; saveAndNew: boolean; approving: boolean;
  onCreate: () => void; onSaveAndNew: () => void; onApprove: () => void;
}

export function NewInvoiceActions({ busy, submitting, saveAndNew, approving, onCreate, onSaveAndNew, onApprove }: ActionsProps) {
  return (
    <>
      <button onClick={onApprove} disabled={busy} className={secondary}>
        {approving ? <><Loader2 className="h-4 w-4 animate-spin" />Approving…</> : <><Send className="h-4 w-4" />Approve &amp; email</>}
      </button>
      <button onClick={onSaveAndNew} disabled={busy} className={secondary}>
        {submitting && saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Save &amp; New</>}
      </button>
      <button onClick={onCreate} disabled={busy} className={primary}>
        {submitting && !saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Create Invoice</>}
      </button>
    </>
  );
}

export function EditInvoiceActions({ disabled, submitting, approving, cancelHref, onSave, onApprove }: {
  disabled: boolean; submitting: boolean; approving: boolean; cancelHref: string; onSave: () => void; onApprove: () => void;
}) {
  return (
    <>
      <Link href={cancelHref} className={plain}>Cancel</Link>
      <button onClick={onApprove} disabled={disabled} className={secondary}>
        {approving ? <><Loader2 className="h-4 w-4 animate-spin" />Approving…</> : <><Send className="h-4 w-4" />Approve &amp; email</>}
      </button>
      <button onClick={onSave} disabled={disabled} className={primary}>
        {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><FileText className="h-4 w-4" />Save Changes</>}
      </button>
    </>
  );
}
