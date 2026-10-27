/**
 * Budget workspace (budgets P2 PR-C): the planning grid at /accounting/budgets/workspace.
 * Deliberately NOT in the nav until PR-D makes /accounting/budgets render it (spec §4.4).
 */
import { AppLayout } from '@/components/layout/AppLayout';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';

export default function BudgetWorkspacePage() {
  return (
    <AppLayout>
      <BudgetWorkspace />
    </AppLayout>
  );
}
