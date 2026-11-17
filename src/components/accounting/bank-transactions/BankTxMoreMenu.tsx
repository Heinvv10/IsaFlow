/**
 * BankTxMoreMenu - the toolbar's "More" menu (WP4b): the occasional page actions, off the bar so the list starts higher.
 * Import bank statements (a real link: new tab and middle-click work), Export this page (the lines loaded, as a CSV),
 * Export all accounts (every account between the From and To dates; pending bank-feed lines are left out) and the Recon
 * report (needs an account). While rows are ticked the selection bar takes the page actions' place on the bar, so they
 * come in here first (Smart Categorize, New transaction): nothing is out of reach while something is selected.
 */

import { ChevronDown, Download, FileText, Plus, Upload, Zap } from 'lucide-react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';

export const IMPORT_HREF = '/accounting/bank-reconciliation/import';
export const NEW_TX_HREF = '/accounting/bank-transactions/new';

interface Props {
  selectedBank: string;
  onExport: () => void;
  onExportAll: () => void;
  onDownloadReport: () => void;
  /** Set while the selection bar holds the bar's place: the page actions it displaced. */
  pageActions?: { onApplyRules: () => void; applyDisabled: boolean; smartRunning: boolean };
}

const ICON = 'h-3.5 w-3.5';

export function BankTxMoreMenu({ selectedBank, onExport, onExportAll, onDownloadReport, pageActions }: Props) {
  const items: ActionMenuItem[] = [
    ...(pageActions ? [
      { label: pageActions.smartRunning ? 'Categorizing...' : 'Smart Categorize', icon: <Zap className={ICON} />, onClick: pageActions.onApplyRules, disabled: pageActions.applyDisabled },
      { label: 'New transaction', icon: <Plus className={ICON} />, href: NEW_TX_HREF },
    ] : []),
    { label: 'Import bank statements', icon: <Upload className={ICON} />, href: IMPORT_HREF },
    { label: 'Export this page', icon: <Download className={ICON} />, onClick: onExport },
    { label: 'Export all accounts', icon: <Download className={ICON} />, onClick: onExportAll },
    { label: 'Recon report', icon: <FileText className={ICON} />, onClick: onDownloadReport, disabled: !selectedBank },
  ];
  return (
    <ActionMenu items={items} triggerLabel="More"
      trigger={<span className="flex items-center gap-1 text-xs">More <ChevronDown aria-hidden="true" className={ICON} /></span>}
      triggerSizeClassName="min-h-7 px-2.5 max-lg:min-h-11" />
  );
}
