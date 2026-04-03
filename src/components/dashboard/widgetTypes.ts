/**
 * Widget type definitions for the Adaptive Widget Dashboard.
 * // WORKING: Full type definitions, no any.
 */

export type WidgetType =
  | 'bank-summary'
  | 'invoices-owed'
  | 'bills-to-pay'
  | 'cash-position'
  | 'pnl-snapshot'
  | 'tasks-reminders'
  | 'recent-activity'
  | 'ai-insights'
  | 'quick-actions'
  | 'vat-summary'
  | 'kpi-cards'
  | 'setup-guide';

export type WidgetSize = 'sm' | 'md' | 'lg';

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  title: string;
  size: WidgetSize;
}

/** Maps WidgetSize to CSS grid column span class */
export const WIDGET_SIZE_CLASS: Record<WidgetSize, string> = {
  sm: 'col-span-1',
  md: 'col-span-1 md:col-span-2',
  lg: 'col-span-1 md:col-span-2 xl:col-span-3',
};

/** Default adaptive widget layout */
export const DEFAULT_WIDGET_LAYOUT: WidgetConfig[] = [
  { id: 'quick-actions-1', type: 'quick-actions', title: 'Quick Actions', size: 'md' },
  { id: 'bank-summary-1', type: 'bank-summary', title: 'Bank Accounts', size: 'md' },
  { id: 'invoices-owed-1', type: 'invoices-owed', title: 'Invoices Owed', size: 'sm' },
  { id: 'bills-to-pay-1', type: 'bills-to-pay', title: 'Bills to Pay', size: 'sm' },
  { id: 'pnl-snapshot-1', type: 'pnl-snapshot', title: 'P&L Snapshot', size: 'md' },
  { id: 'recent-activity-1', type: 'recent-activity', title: 'Recent Activity', size: 'sm' },
];

/** Catalogue of all available widgets (for the Add Widget modal) */
export const WIDGET_CATALOGUE: Array<Pick<WidgetConfig, 'type' | 'title' | 'size'>> = [
  { type: 'bank-summary', title: 'Bank Accounts', size: 'md' },
  { type: 'invoices-owed', title: 'Invoices Owed', size: 'sm' },
  { type: 'bills-to-pay', title: 'Bills to Pay', size: 'sm' },
  { type: 'pnl-snapshot', title: 'P&L Snapshot', size: 'md' },
  { type: 'quick-actions', title: 'Quick Actions', size: 'md' },
  { type: 'recent-activity', title: 'Recent Activity', size: 'sm' },
  { type: 'vat-summary', title: 'VAT Summary', size: 'sm' },
  { type: 'kpi-cards', title: 'KPI Cards', size: 'lg' },
];
