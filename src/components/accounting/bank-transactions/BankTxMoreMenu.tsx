/**
 * BankTxMoreMenu - the toolbar's "More" menu (WP4b): the occasional page actions, off the bar so the list starts higher.
 * Import bank statements, Export this page (the lines loaded, as a CSV), Export all accounts (every account between the
 * From and To dates; pending bank-feed lines are left out) and the Recon report (needs an account).
 */

import Router from 'next/router';
import { ChevronDown, Download, FileText, Upload } from 'lucide-react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';

export const IMPORT_HREF = '/accounting/bank-reconciliation/import';

interface Props {
  selectedBank: string;
  onExport: () => void;
  onExportAll: () => void;
  onDownloadReport: () => void;
}

const ICON = 'h-3.5 w-3.5';

export function BankTxMoreMenu({ selectedBank, onExport, onExportAll, onDownloadReport }: Props) {
  const items: ActionMenuItem[] = [
    { label: 'Import bank statements', icon: <Upload className={ICON} />, onClick: () => { void Router.push(IMPORT_HREF); } },
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
