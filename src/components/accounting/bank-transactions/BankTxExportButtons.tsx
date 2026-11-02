/** BankTxExportButtons — the toolbar's two CSV exports: the loaded page, and every account. */

import { Download } from 'lucide-react';

const BUTTON_CLASS = 'flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]';

export function BankTxExportButtons({ onExport, onExportAll }: { onExport: () => void; onExportAll: () => void }) {
  return (
    <>
      <button onClick={onExport} className={BUTTON_CLASS}>
        <Download className="h-3.5 w-3.5" /> Export
      </button>
      <button
        onClick={onExportAll}
        title="Every bank account, every posted transaction between the From and To dates, as one CSV (pending bank-feed lines are left out)"
        className={BUTTON_CLASS}
      >
        <Download className="h-3.5 w-3.5" /> Export all accounts
      </button>
    </>
  );
}
