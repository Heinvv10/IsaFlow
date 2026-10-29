/**
 * Budget Management Page: the budget workspace (budgets P2). Versions, the planning grid with
 * live GP / OP / NP, the create wizard and the Excel round-trip are all BudgetWorkspace; this page
 * only frames it. PR-C's preview URL /accounting/budgets/workspace redirects here (next.config.js).
 */
import { AppLayout } from '@/components/layout/AppLayout';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';

export default function BudgetManagementPage() {
  return (
    <AppLayout>
      <BudgetWorkspace />
    </AppLayout>
  );
}
