/**
 * Ctrl+K actions: things to do, not places to read. Pure data, so the palette, its tests and the
 * shortcut overlay agree on the list. A `nav` action opens a page; `theme` and `shortcuts` run code
 * the palette owns.
 *
 * No action advertises a key hint: the old "Ctrl+Shift+I" / "Ctrl+Shift+J" hints were never registered
 * anywhere, so they promised a shortcut that did nothing.
 */

export type PaletteActionKind = 'nav' | 'theme' | 'shortcuts';

export interface PaletteAction {
  id: string;
  label: string;
  kind: PaletteActionKind;
  /** Destination for a `nav` action. */
  url?: string;
  icon: string;
  /** Extra words that find the action ("bill" finds "New supplier invoice" and vice versa). */
  keywords: string[];
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  { id: 'new-invoice', label: 'New invoice', kind: 'nav', url: '/accounting/customer-invoices/new', icon: 'file-plus', keywords: ['sales', 'customer invoice', 'tax invoice'] },
  { id: 'new-bill', label: 'New bill', kind: 'nav', url: '/accounting/supplier-invoices/new', icon: 'receipt', keywords: ['purchases', 'supplier invoice'] },
  { id: 'new-employee', label: 'New employee', kind: 'nav', url: '/payroll/employees/new', icon: 'user-plus', keywords: ['payroll', 'hire'] },
  { id: 'new-pay-run', label: 'New pay run', kind: 'nav', url: '/payroll/runs/new', icon: 'banknote', keywords: ['payroll', 'salaries', 'wages'] },
  { id: 'import-bank', label: 'Import bank statement', kind: 'nav', url: '/accounting/bank-reconciliation/import', icon: 'landmark', keywords: ['banking', 'upload', 'csv'] },
  { id: 'switch-theme', label: 'Switch theme', kind: 'theme', icon: 'sun-moon', keywords: ['dark mode', 'light mode', 'appearance'] },
  { id: 'shortcuts', label: 'Keyboard shortcuts', kind: 'shortcuts', icon: 'keyboard', keywords: ['help', 'keys', 'hotkeys'] },
];

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Actions whose label, or a keyword, contains the query. Label matches first, then keyword matches. */
export function filterActions(query: string): PaletteAction[] {
  const q = norm(query);
  if (!q) return [...PALETTE_ACTIONS];
  const byLabel = PALETTE_ACTIONS.filter((a) => norm(a.label).includes(q));
  const byKeyword = PALETTE_ACTIONS.filter(
    (a) => !byLabel.includes(a) && a.keywords.some((k) => norm(k).includes(q)),
  );
  return [...byLabel, ...byKeyword];
}
