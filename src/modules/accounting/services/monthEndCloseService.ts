/**
 * AI Month-End Close Assistant Service
 */

export interface CloseChecklistItem {
  title: string;
  category: string;
  order: number;
  required: boolean;
}

export interface CompletenessResult {
  complete: boolean;
  missing: string[];
  percentComplete: number;
}

export interface CutoffIssue {
  id: string;
  type: 'after_close' | 'before_open';
  date: string;
  amount: number;
  description: string;
}

export interface CloseProgress {
  percentComplete: number;
  period: string;
  status: 'not_started' | 'in_progress' | 'closed';
}

const STANDARD_CHECKLIST: CloseChecklistItem[] = [
  { title: 'Complete bank reconciliation', category: 'Banking', order: 1, required: true },
  { title: 'Post all supplier invoices', category: 'Accounts Payable', order: 2, required: true },
  { title: 'Post all customer invoices', category: 'Accounts Receivable', order: 3, required: true },
  { title: 'Review and post accruals', category: 'Adjustments', order: 4, required: true },
  { title: 'Review and post prepayments', category: 'Adjustments', order: 5, required: false },
  { title: 'Run depreciation', category: 'Fixed Assets', order: 6, required: true },
  { title: 'Reconcile VAT accounts', category: 'Tax', order: 7, required: true },
  { title: 'Review trial balance', category: 'Review', order: 8, required: true },
  { title: 'Post intercompany entries', category: 'Consolidation', order: 9, required: false },
  { title: 'Close fiscal period', category: 'Period End', order: 10, required: true },
];

const PAYROLL_ITEMS: CloseChecklistItem[] = [
  { title: 'Post payroll journal entries', category: 'Payroll', order: 3.5, required: true },
  { title: 'Reconcile payroll control accounts', category: 'Payroll', order: 3.6, required: true },
];

export function generateCloseChecklist(companyType: string): CloseChecklistItem[] {
  const list = [...STANDARD_CHECKLIST];
  if (companyType === 'with_payroll') list.push(...PAYROLL_ITEMS);
  return list.sort((a, b) => a.order - b.order);
}

export function checkCompleteness(input: {
  hasPayrollPosted: boolean; hasDepreciationRun: boolean;
  hasBankRecon: boolean; hasVATRecon: boolean; hasAccruals: boolean;
}): CompletenessResult {
  const checks = [
    { name: 'Payroll posted', done: input.hasPayrollPosted },
    { name: 'Depreciation run', done: input.hasDepreciationRun },
    { name: 'Bank reconciliation', done: input.hasBankRecon },
    { name: 'VAT reconciliation', done: input.hasVATRecon },
    { name: 'Accruals reviewed', done: input.hasAccruals },
  ];
  const done = checks.filter(c => c.done).length;
  const missing = checks.filter(c => !c.done).map(c => c.name);
  return { complete: missing.length === 0, missing, percentComplete: Math.round((done / checks.length) * 100) };
}

export function detectCutoffIssues(input: {
  periodEnd: string;
  transactionsAfterClose: Array<{ id: string; date: string; amount: number; description: string }>;
  transactionsBeforeOpen: Array<{ id: string; date: string; amount: number; description: string }>;
}): CutoffIssue[] {
  const issues: CutoffIssue[] = [];
  for (const tx of input.transactionsAfterClose) {
    issues.push({ id: tx.id, type: 'after_close', date: tx.date, amount: tx.amount, description: tx.description });
  }
  for (const tx of input.transactionsBeforeOpen) {
    issues.push({ id: tx.id, type: 'before_open', date: tx.date, amount: tx.amount, description: tx.description });
  }
  return issues;
}

export function buildCloseProgressSummary(completedSteps: number, totalSteps: number, period: string): CloseProgress {
  const pct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  let status: CloseProgress['status'] = 'in_progress';
  if (pct === 0) status = 'not_started';
  else if (pct >= 100) status = 'closed';
  return { percentComplete: pct, period, status };
}
